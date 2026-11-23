// Shared test setup. The tests never touch the real project folder, the real
// Google or the real OpenAI: files go to a temp folder and the network is faked.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const home = mkdtempSync(join(tmpdir(), "my-agent-test-"));
process.env.MY_AGENT_HOME = home;
process.env.OPENAI_API_KEY = "test-key";
process.env.OPENAI_MODEL = "test-model";

mkdirSync(join(home, "secrets"), { recursive: true });
writeFileSync(
  join(home, "secrets", "google-oauth-client.json"),
  JSON.stringify({
    installed: {
      client_id: "client-id",
      client_secret: "client-secret",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    },
  }),
);

/** Writes connected accounts straight into the token file. */
export function connect(accounts: Record<string, string[]>): void {
  const tokens = Object.fromEntries(
    Object.entries(accounts).map(([email, scopes]) => [
      email,
      { refreshToken: "refresh-" + email, accessToken: "access-" + email, expiresAt: Date.now() + 3_600_000, scopes: scopes.join(" ") },
    ]),
  );
  writeFileSync(join(home, "secrets", "google-tokens.json"), JSON.stringify(tokens));
}

export type Call = { url: string; method: string; headers: Record<string, string>; body: string };
type Handler = (call: Call) => unknown;

const realFetch = globalThis.fetch;

/**
 * Replaces the network. `routes` maps a piece of a URL to the JSON it returns.
 * Requests to this computer (127.0.0.1) still go through for real.
 * Returns the list of calls that were made.
 */
export function fakeNetwork(routes: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? String(init.body) : "",
    };
    calls.push(call);
    for (const [piece, handler] of Object.entries(routes)) {
      if (!url.includes(piece)) continue;
      const result = handler(call);
      return result instanceof Response ? result : Response.json(result);
    }
    throw new Error("Unexpected request in test: " + url);
  }) as typeof fetch;
  return calls;
}

export { realFetch };

/** A stand-in for OpenAI: returns the scripted outputs one after another. */
export function fakeModel(script: unknown[][]) {
  const requests: { input: unknown[]; tools: { name: string }[] }[] = [];
  let turn = 0;
  const client = {
    responses: {
      create: async (request: { input: unknown[]; tools: { name: string }[] }) => {
        requests.push(JSON.parse(JSON.stringify(request)));
        const output = script[Math.min(turn++, script.length - 1)] ?? [];
        const text = output
          .filter((item): item is { type: "message"; text: string } => (item as { type: string }).type === "message")
          .map((item) => item.text)
          .join("");
        return { output, output_text: text };
      },
    },
  };
  return { client: client as never, requests };
}

export const toolRequest = (name: string, args: unknown, id = "call-1") => ({
  type: "function_call",
  call_id: id,
  name,
  arguments: JSON.stringify(args),
});
export const say = (text: string) => ({ type: "message", text });
