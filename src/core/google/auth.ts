// Google sign-in for the agent, written by hand (no Google library) so the
// whole flow is visible. Supports several accounts: each connected account
// gets its own entry in secrets/google-tokens.json.
//
// The flow ("OAuth for desktop apps"):
//   1. We open Google's consent page in the browser.
//   2. After the user approves, Google redirects the browser to a tiny server
//      we run on this computer, with a one-time code.
//   3. We trade the code for tokens. The refresh token is saved; with it we
//      can get a fresh access token whenever we need one, without asking again.

import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SECRETS_DIR } from "../paths.js";
import { listenForRedirect } from "../oauth-redirect.js";
import { loadSettings, saveSettings } from "../settings.js";

const CLIENT_FILE = new URL("google-oauth-client.json", SECRETS_DIR);
const TOKENS_FILE = new URL("google-tokens.json", SECRETS_DIR);

// What the agent may do in a Google account. Keep this list as short as possible.
// Adding a scope later means connecting the account again.
export const SCOPE = {
  calendarRead: "https://www.googleapis.com/auth/calendar.readonly",
  calendarEvents: "https://www.googleapis.com/auth/calendar.events", // read and create events
  // Know when calendars (people, rooms) are busy, without seeing what the events are.
  calendarFreeBusy: "https://www.googleapis.com/auth/calendar.freebusy",
  // Look people up by name, read-only: the organization's directory, the user's
  // contacts, and people the user has exchanged mail with.
  directory: "https://www.googleapis.com/auth/directory.readonly",
  contacts: "https://www.googleapis.com/auth/contacts.readonly",
  otherContacts: "https://www.googleapis.com/auth/contacts.other.readonly",
  // The organization's list of meeting rooms, read-only.
  rooms: "https://www.googleapis.com/auth/admin.directory.resource.calendar.readonly",
  mailRead: "https://www.googleapis.com/auth/gmail.readonly",
  // Google has no "drafts only" permission: this one also allows sending.
  // Our code only ever creates drafts with it.
  mailCompose: "https://www.googleapis.com/auth/gmail.compose",
} as const;

const SCOPES = [
  "openid",
  "email", // only to know which account was connected
  SCOPE.calendarEvents,
  SCOPE.calendarFreeBusy,
  SCOPE.directory,
  SCOPE.contacts,
  SCOPE.otherContacts,
  SCOPE.rooms,
  SCOPE.mailRead,
  SCOPE.mailCompose,
];

type Client = { client_id: string; client_secret: string; auth_uri: string; token_uri: string };
type Account = { refreshToken: string; accessToken: string; expiresAt: number; scopes: string };
type Tokens = Record<string, Account>; // key: the account's email address

async function loadClient(): Promise<Client> {
  try {
    const file = JSON.parse(await readFile(CLIENT_FILE, "utf8")) as { installed?: Client };
    if (!file.installed) throw new Error("not a Desktop app client file");
    return file.installed;
  } catch (error) {
    throw new Error(
      `Cannot read ${fileURLToPath(CLIENT_FILE)} (${error instanceof Error ? error.message : error})`,
    );
  }
}

async function loadTokens(): Promise<Tokens> {
  try {
    return JSON.parse(await readFile(TOKENS_FILE, "utf8")) as Tokens;
  } catch {
    return {}; // no account connected yet
  }
}

async function saveTokens(tokens: Tokens): Promise<void> {
  await mkdir(SECRETS_DIR, { recursive: true });
  // mode 0o600: only this user can read the file.
  await writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

// Calls Google's token endpoint. Used both for the first exchange and for refreshing.
async function requestTokens(client: Client, params: Record<string, string>) {
  const response = await fetch(client.token_uri, {
    signal: AbortSignal.timeout(20_000), // never wait forever for Google
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, ...params }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Google refused the request: ${body.error ?? response.status} ${body.error_description ?? ""}`);
  }
  return body as { access_token: string; expires_in: number; refresh_token?: string; scope?: string; id_token?: string };
}

// The id_token is a signed note from Google saying who signed in. We received it
// directly from Google over HTTPS, so reading the email from it is safe.
function emailFromIdToken(idToken: string | undefined): string {
  const payload = idToken?.split(".")[1];
  if (!payload) throw new Error("Google did not say which account was connected.");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string };
  if (!claims.email) throw new Error("Google did not return the account's email.");
  return claims.email.toLowerCase();
}

/** The email addresses of all connected accounts. */
export async function listAccounts(): Promise<string[]> {
  return Object.keys(await loadTokens());
}

/**
 * Connects one Google account. Opens the browser, waits for the user to
 * approve, saves the tokens, and returns the account's email.
 */
export async function connectAccount(openBrowser: (url: string) => void, cancel?: AbortSignal): Promise<string> {
  const client = await loadClient();

  // Two random values that protect the flow:
  // "state" proves the redirect belongs to the request we started, and the
  // "verifier" proves that whoever trades the code is whoever asked for it (PKCE).
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  // Step 2 first: start the tiny server that will receive the redirect.
  const listener = await listenForRedirect({ port: 0, path: "/", state, ...(cancel ? { cancel } : {}) });

  // Step 1: send the user to Google's consent page.
  const consent = new URL(client.auth_uri);
  consent.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: listener.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline", // ask for a refresh token
    prompt: "consent select_account", // let the user pick which account
  }).toString();
  openBrowser(consent.toString());
  const code = { code: await listener.code, redirectUri: listener.redirectUri };

  // Step 3: trade the one-time code for tokens.
  const granted = await requestTokens(client, {
    grant_type: "authorization_code",
    code: code.code,
    code_verifier: verifier,
    redirect_uri: code.redirectUri,
  });
  if (!granted.refresh_token) throw new Error("Google did not return a refresh token.");

  const email = emailFromIdToken(granted.id_token);
  const tokens = await loadTokens();
  tokens[email] = {
    refreshToken: granted.refresh_token,
    accessToken: granted.access_token,
    expiresAt: Date.now() + granted.expires_in * 1000,
    scopes: granted.scope ?? SCOPES.join(" "),
  };
  await saveTokens(tokens);
  return email;
}

/** The permissions the user actually granted to one account. */
export async function grantedScopes(email: string): Promise<string[]> {
  const account = (await loadTokens())[email];
  return account ? account.scopes.split(" ") : [];
}

/** The default account when it is still connected, otherwise none. */
async function currentDefault(tokens: Tokens): Promise<string | null> {
  const { defaultAccount } = await loadSettings();
  return defaultAccount && tokens[defaultAccount] ? defaultAccount : null;
}

/** Makes one connected account the default for new events and drafts. */
export async function setDefaultAccount(email: string): Promise<void> {
  if (!(await loadTokens())[email]) throw new Error(`The account ${email} is not connected.`);
  await saveSettings({ ...(await loadSettings()), defaultAccount: email });
}

/** Each connected account with what it allowed the agent to do. Safe to show in the GUI: no tokens. */
export async function describeAccounts() {
  const tokens = await loadTokens();
  const defaultAccount = await currentDefault(tokens);
  return Object.entries(tokens).map(([email, account]) => {
    const granted = account.scopes.split(" ");
    return {
      email,
      isDefault: email === defaultAccount,
      calendarRead: granted.includes(SCOPE.calendarRead) || granted.includes(SCOPE.calendarEvents),
      calendarCreate: granted.includes(SCOPE.calendarEvents),
      people: [SCOPE.directory, SCOPE.contacts, SCOPE.otherContacts].some((scope) => granted.includes(scope)),
      mailRead: granted.includes(SCOPE.mailRead),
      mailDrafts: granted.includes(SCOPE.mailCompose),
    };
  });
}

/** A valid access token for one account. Refreshes it when it is about to expire. */
export async function getAccessToken(email: string): Promise<string> {
  const tokens = await loadTokens();
  const account = tokens[email];
  if (!account) throw new Error(`The account ${email} is not connected.`);

  const stillValid = account.expiresAt - Date.now() > 60_000;
  if (stillValid) return account.accessToken;

  const client = await loadClient();
  const fresh = await requestTokens(client, { grant_type: "refresh_token", refresh_token: account.refreshToken });
  account.accessToken = fresh.access_token;
  account.expiresAt = Date.now() + fresh.expires_in * 1000;
  await saveTokens(tokens);
  return account.accessToken;
}
