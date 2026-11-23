// Shared helpers for calling Google APIs: choosing the account, checking the
// permission, adding the access token, and turning failures into clear errors.

import { getAccessToken, grantedScopes, listAccounts } from "./auth.js";
import { loadSettings } from "../settings.js";

const RECONNECT = "Ask the user to run `npm run connect-google` in the project folder and approve all the permissions.";

/**
 * Decides which account a tool should act on, in this order:
 * the account that was named, else the only connected account, else the
 * user's default account. If none of these settles it, we stop and ask.
 */
export async function resolveAccount(requested: unknown): Promise<string> {
  const accounts = await listAccounts();
  if (accounts.length === 0) throw new Error(`No Google account is connected. ${RECONNECT}`);

  if (typeof requested === "string" && requested.trim() !== "") {
    const email = requested.trim().toLowerCase();
    if (!accounts.includes(email)) {
      throw new Error(`The account ${email} is not connected. Connected accounts: ${accounts.join(", ")}`);
    }
    return email;
  }
  const only = accounts[0];
  if (accounts.length === 1 && only) return only;

  const { defaultAccount } = await loadSettings();
  if (defaultAccount && accounts.includes(defaultAccount)) return defaultAccount;
  throw new Error(`Several accounts are connected (${accounts.join(", ")}) and no default is set. Ask the user which one to use.`);
}

/** True when the account granted at least one of the given permissions. */
export async function hasScope(email: string, ...anyOf: string[]): Promise<boolean> {
  const granted = await grantedScopes(email);
  return anyOf.some((scope) => granted.includes(scope));
}

/**
 * Calls a Google API as one account. `anyOf` lists the permissions that allow
 * the call; if the account granted none of them we fail before calling Google.
 */
export async function googleFetch<T>(
  email: string,
  anyOf: string[],
  url: string | URL,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  if (!(await hasScope(email, ...anyOf))) {
    throw new Error(`The account ${email} has not granted the permission this action needs. ${RECONNECT}`);
  }

  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${await getAccessToken(email)}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  if (!response.ok) {
    const text = await response.text();
    let reason = text.slice(0, 200);
    try {
      reason = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? reason;
    } catch {
      // not JSON: keep the raw text
    }
    throw new Error(`Google returned ${response.status} for ${email}: ${reason}`);
  }
  return (await response.json()) as T;
}
