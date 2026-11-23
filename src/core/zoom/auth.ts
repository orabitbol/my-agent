// Zoom sign-in. Same idea as the Google one: the user approves in the browser,
// we receive a one-time code on this computer and trade it for tokens.
//
// Needs secrets/zoom-oauth-client.json, from an app the user creates in the
// Zoom App Marketplace (type: General app, User-managed):
//   { "client_id": "...", "client_secret": "..." }
// The app's OAuth redirect URL must be exactly REDIRECT_URI below.

import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { SECRETS_DIR } from "../paths.js";
import { listenForRedirect } from "../oauth-redirect.js";

const CLIENT_FILE = new URL("zoom-oauth-client.json", SECRETS_DIR);
const TOKENS_FILE = new URL("zoom-tokens.json", SECRETS_DIR);

// Zoom only accepts a redirect address that was registered in the app in advance,
// so unlike Google the port is fixed.
const REDIRECT_PORT = 53682;
const REDIRECT_PATH = "/zoom/callback";
export const ZOOM_REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}${REDIRECT_PATH}`;

type Client = { client_id: string; client_secret: string };
type Tokens = { refreshToken: string; accessToken: string; expiresAt: number; email: string | null };

async function loadClient(): Promise<Client | null> {
  try {
    const client = JSON.parse(await readFile(CLIENT_FILE, "utf8")) as Partial<Client>;
    return client.client_id && client.client_secret ? (client as Client) : null;
  } catch {
    return null;
  }
}

async function loadTokens(): Promise<Tokens | null> {
  try {
    return JSON.parse(await readFile(TOKENS_FILE, "utf8")) as Tokens;
  } catch {
    return null;
  }
}

async function saveTokens(tokens: Tokens): Promise<void> {
  await mkdir(SECRETS_DIR, { recursive: true });
  await writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function requestTokens(client: Client, params: Record<string, string>) {
  const response = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // Zoom identifies the app with its id and secret in this header.
      Authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}`,
    },
    body: new URLSearchParams(params),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Zoom refused the request: ${body.reason ?? body.error ?? response.status}`);
  return body as { access_token: string; refresh_token: string; expires_in: number };
}

/** Where Zoom stands: is the app file in place, and is an account connected. Safe to show in the GUI. */
export async function zoomStatus(): Promise<{ configured: boolean; connected: boolean; email: string | null }> {
  const tokens = await loadTokens();
  return { configured: (await loadClient()) !== null, connected: tokens !== null, email: tokens?.email ?? null };
}

/** Connects the user's Zoom account. Opens the browser and waits for the approval. */
export async function connectZoom(openBrowser: (url: string) => void, cancel?: AbortSignal): Promise<string> {
  const client = await loadClient();
  if (!client) throw new Error("secrets/zoom-oauth-client.json is missing or incomplete.");

  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const listener = await listenForRedirect({ port: REDIRECT_PORT, path: REDIRECT_PATH, state, ...(cancel ? { cancel } : {}) });

  const consent = new URL("https://zoom.us/oauth/authorize");
  consent.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: listener.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  openBrowser(consent.toString());

  const granted = await requestTokens(client, {
    grant_type: "authorization_code",
    code: await listener.code,
    redirect_uri: listener.redirectUri,
    code_verifier: verifier,
  });

  // Ask Zoom whose account this is, only to show it in the app. Not essential.
  let email: string | null = null;
  try {
    const me = await fetch("https://api.zoom.us/v2/users/me", { headers: { Authorization: `Bearer ${granted.access_token}` } });
    if (me.ok) email = ((await me.json()) as { email?: string }).email ?? null;
  } catch {
    // leave the email unknown
  }

  await saveTokens({
    refreshToken: granted.refresh_token,
    accessToken: granted.access_token,
    expiresAt: Date.now() + granted.expires_in * 1000,
    email,
  });
  return email ?? "Zoom";
}

/** A valid Zoom access token. Refreshes it when it is about to expire. */
export async function getZoomToken(): Promise<string> {
  const tokens = await loadTokens();
  if (!tokens) throw new Error("Zoom is not connected. Ask the user to connect Zoom from the app's sidebar.");
  if (tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken;

  const client = await loadClient();
  if (!client) throw new Error("secrets/zoom-oauth-client.json is missing.");
  const fresh = await requestTokens(client, { grant_type: "refresh_token", refresh_token: tokens.refreshToken });
  // Zoom replaces the refresh token on every refresh: the old one stops working,
  // so the new one must be saved right away.
  await saveTokens({
    ...tokens,
    refreshToken: fresh.refresh_token,
    accessToken: fresh.access_token,
    expiresAt: Date.now() + fresh.expires_in * 1000,
  });
  return fresh.access_token;
}
