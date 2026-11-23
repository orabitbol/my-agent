import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connect, fakeModel, fakeNetwork, home, realFetch, say } from "./helpers.js";

const zoomAuth = await import("../src/core/zoom/auth.js");
const { SCOPE } = await import("../src/core/google/auth.js");
const calendar = await import("../src/core/tools/calendar.js");
const { Agent } = await import("../src/core/agent.js");
const { startServer } = await import("../src/entries/server.js");

const clientFile = join(home, "secrets", "zoom-oauth-client.json");
const tokensFile = join(home, "secrets", "zoom-tokens.json");
const zoomConnected = (expiresInMs = 3_600_000) =>
  writeFileSync(tokensFile, JSON.stringify({ refreshToken: "zr1", accessToken: "za1", expiresAt: Date.now() + expiresInMs, email: "me@work.com" }));
const event = {
  title: "פגישה עם טל", start: "2026-11-24T09:00:00+02:00", end: "2026-11-24T09:45:00+02:00",
  location: null, notes: "נושא: figma", attendees: [], room_email: null, account: null,
};
const rooms = { items: [{ resourceEmail: "vision@resource.calendar.google.com", generatedResourceName: "TLV-1-Vision (4)", capacity: 4 }] };

test("status: not configured, then configured, then connected", async () => {
  assert.deepEqual(await zoomAuth.zoomStatus(), { configured: false, connected: false, email: null });
  writeFileSync(clientFile, JSON.stringify({ client_id: "zid", client_secret: "zsecret" }));
  assert.deepEqual(await zoomAuth.zoomStatus(), { configured: true, connected: false, email: null });
});

test("connect: uses the registered redirect address, identifies the app, saves the tokens", async () => {
  const calls = fakeNetwork({
    "zoom.us/oauth/token": () => ({ access_token: "za1", refresh_token: "zr1", expires_in: 3600 }),
    "api.zoom.us/v2/users/me": () => ({ email: "me@work.com" }),
  });
  let consent = new URLSearchParams();
  const email = await zoomAuth.connectZoom((url) => {
    assert.ok(url.startsWith("https://zoom.us/oauth/authorize?"));
    consent = new URL(url).searchParams;
    void realFetch(`${consent.get("redirect_uri")}?code=ZCODE&state=${consent.get("state")}`);
  });

  assert.equal(email, "me@work.com");
  assert.equal(consent.get("redirect_uri"), "http://127.0.0.1:53682/zoom/callback");
  assert.equal(calls[0]?.headers.Authorization, "Basic " + Buffer.from("zid:zsecret").toString("base64"));
  const exchange = new URLSearchParams(calls[0]?.body);
  assert.deepEqual([exchange.get("code"), exchange.get("redirect_uri"), !!exchange.get("code_verifier")], ["ZCODE", "http://127.0.0.1:53682/zoom/callback", true]);
  assert.deepEqual(await zoomAuth.zoomStatus(), { configured: true, connected: true, email: "me@work.com" });
});

test("refresh: Zoom replaces the refresh token every time, and the new one is saved", async () => {
  zoomConnected(-1000);
  const calls = fakeNetwork({ "zoom.us/oauth/token": () => ({ access_token: "za2", refresh_token: "zr2", expires_in: 3600 }) });
  assert.equal(await zoomAuth.getZoomToken(), "za2");
  assert.equal(new URLSearchParams(calls[0]?.body).get("refresh_token"), "zr1");
  const saved = JSON.parse(readFileSync(tokensFile, "utf8"));
  assert.deepEqual([saved.refreshToken, saved.accessToken, saved.email], ["zr2", "za2", "me@work.com"]);
  assert.equal(await zoomAuth.getZoomToken(), "za2");
  assert.equal(calls.length, 1);
});

test("event with Zoom: a new meeting is created and its link is in the event", async () => {
  connect({ "work@example.com": [SCOPE.calendarEvents] });
  zoomConnected();
  const calls = fakeNetwork({
    "api.zoom.us/v2/users/me/meetings": () => ({ id: 987654321, join_url: "https://zoom.us/j/987654321?pwd=abc", password: "1234" }),
    "calendars/primary/events": () => ({ htmlLink: "l" }),
  });
  const prepared = (await calendar.createCalendarEvent.prepare?.({ ...event, zoom: true })) ?? {};
  assert.match(calendar.createCalendarEvent.describe?.(prepared) ?? "", /ליצור פגישת Zoom חדשה/);
  assert.equal(calls.length, 0, "no Zoom meeting exists before approval");

  const result = (await calendar.createCalendarEvent.run(prepared)) as { zoomLink: string };
  const zoomCall = JSON.parse(calls[0]?.body ?? "{}");
  assert.deepEqual([zoomCall.topic, zoomCall.type, zoomCall.start_time, zoomCall.timezone, zoomCall.duration], ["פגישה עם טל", 2, "2026-11-24T07:00:00Z", "UTC", 45]);
  assert.equal(calls[0]?.headers.Authorization, "Bearer za1");

  const calendarCall = JSON.parse(calls[1]?.body ?? "{}");
  assert.equal(calendarCall.location, "https://zoom.us/j/987654321?pwd=abc");
  assert.equal(calendarCall.description, "נושא: figma\n\nZoom: https://zoom.us/j/987654321?pwd=abc\nPasscode: 1234");
  assert.equal(result.zoomLink, "https://zoom.us/j/987654321?pwd=abc");
});

test("event with Zoom and a room: the room stays the place, the link goes in the notes", async () => {
  connect({ "work@example.com": [SCOPE.calendarEvents, SCOPE.rooms] });
  zoomConnected();
  const calls = fakeNetwork({
    "resources/calendars": () => rooms,
    "api.zoom.us/v2/users/me/meetings": () => ({ id: 1, join_url: "https://zoom.us/j/1" }),
    "calendars/primary/events": () => ({}),
  });
  const prepared = (await calendar.createCalendarEvent.prepare?.({ ...event, zoom: true, room_email: "vision@resource.calendar.google.com" })) ?? {};
  await calendar.createCalendarEvent.run(prepared);
  const calendarCall = JSON.parse(calls.at(-1)?.body ?? "{}");
  assert.equal(calendarCall.location, undefined);
  assert.match(calendarCall.description, /Zoom: https:\/\/zoom\.us\/j\/1$/);
  assert.deepEqual(calendarCall.attendees, [
    { email: "work@example.com", responseStatus: "accepted" },
    { email: "vision@resource.calendar.google.com", resource: true },
  ]);
});

test("if the calendar event fails, the Zoom meeting that was just made is removed", async () => {
  connect({ "work@example.com": [SCOPE.calendarEvents] });
  zoomConnected();
  const calls = fakeNetwork({
    "api.zoom.us/v2/users/me/meetings": () => ({ id: 555, join_url: "https://zoom.us/j/555" }),
    "api.zoom.us/v2/meetings/555": () => new Response(null, { status: 204 }),
    "calendars/primary/events": () => Response.json({ error: { message: "Calendar is down" } }, { status: 500 }),
  });
  const prepared = (await calendar.createCalendarEvent.prepare?.({ ...event, zoom: true })) ?? {};
  await assert.rejects(calendar.createCalendarEvent.run(prepared), /Calendar is down/);
  assert.deepEqual(calls.at(-1) && [calls.at(-1)?.method, calls.at(-1)?.url], ["DELETE", "https://api.zoom.us/v2/meetings/555"]);
});

test("asking for Zoom when it is not connected is refused before approval; without Zoom nothing touches Zoom", async () => {
  connect({ "work@example.com": [SCOPE.calendarEvents] });
  rmSync(tokensFile);
  const calls = fakeNetwork({ "calendars/primary/events": () => ({}) });
  await assert.rejects(calendar.createCalendarEvent.prepare?.({ ...event, zoom: true }) ?? Promise.resolve(), /Zoom is not connected/);

  const plain = (await calendar.createCalendarEvent.prepare?.({ ...event, zoom: false })) ?? {};
  await calendar.createCalendarEvent.run(plain);
  assert.ok(calls.every((call) => !call.url.includes("zoom")));
  assert.ok(!existsSync(tokensFile));
});

test("the app can start a Zoom connection, and it lands in the Zoom flow, not the Google one", async () => {
  fakeNetwork({
    "zoom.us/oauth/token": () => ({ access_token: "za9", refresh_token: "zr9", expires_in: 3600 }),
    "api.zoom.us/v2/users/me": () => ({ email: "me@work.com" }),
  });
  const opened: string[] = [];
  const base = await startServer(0, { agent: new Agent({ client: fakeModel([[say("x")]]).client, tools: [] }), openBrowser: (url) => opened.push(url) });
  const started = (await (await fetch(base + "/api/accounts/connect", { method: "POST", body: JSON.stringify({ service: "zoom" }) })).json()) as { state: string };
  assert.equal(started.state, "waiting");
  assert.ok(opened[0]?.startsWith("https://zoom.us/oauth/authorize?"));

  const query = new URL(opened[0] ?? "").searchParams;
  await realFetch(`${query.get("redirect_uri")}?code=C&state=${query.get("state")}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await (await fetch(base + "/api/accounts/connect")).json(), { state: "done", email: "me@work.com" });
  const accounts = (await (await fetch(base + "/api/accounts")).json()) as { zoom: { connected: boolean } };
  assert.equal(accounts.zoom.connected, true);
});
