import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { connect, fakeNetwork, home, realFetch } from "./helpers.js";

const auth = await import("../src/core/google/auth.js");
const api = await import("../src/core/google/api.js");

const idToken = (email: string) => "x." + Buffer.from(JSON.stringify({ email })).toString("base64url") + ".y";
const tokensFile = join(home, "secrets", "google-tokens.json");

// Plays the part of the browser: follows the consent address back to our local server.
const approveInBrowser = (extra = "") => (consentUrl: string) => {
  const query = new URL(consentUrl).searchParams;
  void realFetch(`${query.get("redirect_uri")}/?code=THE-CODE&state=${query.get("state")}${extra}`);
};

test("connecting an account saves its tokens and returns its email", async () => {
  let consent = new URLSearchParams();
  const calls = fakeNetwork({
    "oauth2.googleapis.com/token": () => ({
      access_token: "a1", expires_in: 3600, refresh_token: "r1", id_token: idToken("Me@Example.com"),
      scope: `${auth.SCOPE.calendarEvents} ${auth.SCOPE.mailRead}`,
    }),
  });

  const email = await auth.connectAccount((url) => {
    consent = new URL(url).searchParams;
    approveInBrowser()(url);
  });

  assert.equal(email, "me@example.com");
  assert.deepEqual(await auth.listAccounts(), ["me@example.com"]);
  assert.equal(consent.get("access_type"), "offline");
  assert.equal(consent.get("code_challenge_method"), "S256");
  assert.match(consent.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);

  const exchange = new URLSearchParams(calls[0]?.body);
  assert.equal(exchange.get("code"), "THE-CODE");
  assert.ok(exchange.get("code_verifier"));
  assert.equal(statSync(tokensFile).mode & 0o777, 0o600, "token file is readable only by its owner");
});

test("a second account is added next to the first", async () => {
  fakeNetwork({
    "oauth2.googleapis.com/token": () => ({ access_token: "a2", expires_in: 3600, refresh_token: "r2", id_token: idToken("work@example.com") }),
  });
  await auth.connectAccount(approveInBrowser());
  assert.deepEqual(await auth.listAccounts(), ["me@example.com", "work@example.com"]);
});

test("a redirect with the wrong state is rejected and nothing is saved", async () => {
  const before = readFileSync(tokensFile, "utf8");
  const calls = fakeNetwork({});
  await assert.rejects(
    auth.connectAccount((url) => {
      const query = new URL(url).searchParams;
      void realFetch(`${query.get("redirect_uri")}/?code=EVIL&state=wrong`);
    }),
    /not valid/,
  );
  assert.equal(calls.length, 0, "no code was traded");
  assert.equal(readFileSync(tokensFile, "utf8"), before);
});

test("declining in the browser fails cleanly", async () => {
  fakeNetwork({});
  await assert.rejects(
    auth.connectAccount((url) => {
      const query = new URL(url).searchParams;
      void realFetch(`${query.get("redirect_uri")}/?error=access_denied&state=${query.get("state")}`);
    }),
    /access_denied/,
  );
});

test("an expired access token is refreshed and saved; a valid one is reused", async () => {
  connect({ "me@example.com": [auth.SCOPE.calendarRead] });
  const tokens = JSON.parse(readFileSync(tokensFile, "utf8"));
  tokens["me@example.com"].expiresAt = Date.now() - 1000;
  (await import("node:fs")).writeFileSync(tokensFile, JSON.stringify(tokens));

  const calls = fakeNetwork({ "oauth2.googleapis.com/token": () => ({ access_token: "fresh", expires_in: 3600 }) });
  assert.equal(await auth.getAccessToken("me@example.com"), "fresh");
  assert.equal(new URLSearchParams(calls[0]?.body).get("grant_type"), "refresh_token");
  assert.equal(await auth.getAccessToken("me@example.com"), "fresh");
  assert.equal(calls.length, 1, "second call used the saved token");
});

test("choosing the account: one is automatic, several must be named", async () => {
  connect({ "me@example.com": [] });
  assert.equal(await api.resolveAccount(null), "me@example.com");

  connect({ "me@example.com": [], "work@example.com": [] });
  await assert.rejects(api.resolveAccount(null), /Several accounts/);
  assert.equal(await api.resolveAccount(" Work@Example.com "), "work@example.com");
  await assert.rejects(api.resolveAccount("other@example.com"), /not connected/);
});

test("an action without its permission is refused before Google is called", async () => {
  connect({ "me@example.com": [auth.SCOPE.calendarRead] });
  const calls = fakeNetwork({});
  await assert.rejects(api.googleFetch("me@example.com", [auth.SCOPE.mailRead], "https://gmail.googleapis.com/x"), /permission/);
  assert.equal(calls.length, 0);
});

test("a Google error is reported with its reason", async () => {
  connect({ "me@example.com": [auth.SCOPE.mailRead] });
  fakeNetwork({ "gmail.googleapis.com": () => Response.json({ error: { message: "Gmail API has not been used" } }, { status: 403 }) });
  await assert.rejects(api.googleFetch("me@example.com", [auth.SCOPE.mailRead], "https://gmail.googleapis.com/x"), /403.*Gmail API has not been used/);
});
