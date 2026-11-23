import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, fakeModel, fakeNetwork, realFetch, say, toolRequest } from "./helpers.js";

const { Agent } = await import("../src/core/agent.js");
const { startServer } = await import("../src/entries/server.js");
type Tool = import("../src/core/tools/types.js").Tool;

const runs: unknown[] = [];
const sensitive: Tool = {
  name: "do_sensitive", description: "test", parameters: {}, needsApproval: true,
  describe: () => "לעשות פעולה רגישה",
  run: async (args) => { runs.push(args); return { done: true }; },
};

// Reads the chat stream event by event, like the page does.
async function chat(base: string, text: string, onEvent: (event: Record<string, unknown>) => Promise<void> | void) {
  const response = await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ text }) });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: Record<string, unknown>[] = [];
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line) as Record<string, unknown>;
      events.push(event);
      await onEvent(event);
    }
  }
  return events;
}

test("serves only the page files, on this computer only", async () => {
  const base = await startServer(0, { agent: new Agent({ client: fakeModel([[say("x")]]).client, tools: [] }) });
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(await (await fetch(base + "/")).text(), /<html lang="he" dir="rtl">/);
  assert.match(await (await fetch(base + "/tokens.css")).text(), /--accent/);
  for (const path of ["/package.json", "/.env", "/secrets/google-tokens.json", "/tokens.css/../../../.env"]) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});

test("chat stream: approval is asked, and only an explicit yes runs the tool", async () => {
  for (const [answer, expectedRuns] of [[true, 1], [false, 0], ["yes", 0]] as const) {
    runs.length = 0;
    const { client } = fakeModel([[toolRequest("do_sensitive", { n: 1 })], [say("סיימתי")]]);
    const base = await startServer(0, { agent: new Agent({ client, tools: [sensitive] }) });

    const events = await chat(base, "עשה", async (event) => {
      if (event.type !== "approval") return;
      assert.equal(event.summary, "לעשות פעולה רגישה");
      const response = await fetch(`${base}/api/approve`, { method: "POST", body: JSON.stringify({ id: event.id, approved: answer }) });
      assert.equal(response.status, 204);
    });

    assert.deepEqual(events.map((e) => e.type), ["approval", "tool", "reply"]);
    assert.equal(runs.length, expectedRuns, `answer ${JSON.stringify(answer)}`);
    assert.equal(events.at(-1)?.text, "סיימתי");
  }
});

test("an approval id that does not exist is refused", async () => {
  const base = await startServer(0, { agent: new Agent({ client: fakeModel([[say("x")]]).client, tools: [] }) });
  const response = await fetch(`${base}/api/approve`, { method: "POST", body: JSON.stringify({ id: "made-up", approved: true }) });
  assert.equal(response.status, 404);
});

test("a model failure reaches the page as an error, not a hung request", async () => {
  const broken = { responses: { create: async () => { throw new Error("model is down"); } } } as never;
  const base = await startServer(0, { agent: new Agent({ client: broken, tools: [] }) });
  const events = await chat(base, "היי", () => {});
  assert.deepEqual(events, [{ type: "error", message: "model is down" }]);
});

test("requests from another website are refused", async () => {
  const base = await startServer(0, { agent: new Agent({ client: fakeModel([[say("x")]]).client, tools: [] }) });
  for (const path of ["/api/chat", "/api/approve", "/api/reset", "/api/accounts/connect"]) {
    const response = await fetch(base + path, { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" });
    assert.equal(response.status, 403, path);
  }
  assert.equal((await fetch(base + "/api/accounts", { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(base + "/api/accounts", { headers: { Origin: base } })).status, 200, "the app's own page is allowed");
});

test("accounts: lists what each account allows, without any token", async () => {
  const { SCOPE } = await import("../src/core/google/auth.js");
  connect({ "me@example.com": [SCOPE.calendarRead], "work@example.com": [SCOPE.calendarEvents, SCOPE.mailRead, SCOPE.mailCompose] });
  const base = await startServer(0, { agent: new Agent({ client: fakeModel([[say("x")]]).client, tools: [] }) });
  const text = await (await fetch(base + "/api/accounts")).text();
  const { zoom, ...rest } = JSON.parse(text);
  assert.deepEqual(zoom, { configured: false, connected: false, email: null, redirectUri: "http://127.0.0.1:53682/zoom/callback" });
  assert.deepEqual(rest, {
    canConnect: false,
    accounts: [
      { email: "me@example.com", isDefault: false, calendarRead: true, calendarCreate: false, people: false, mailRead: false, mailDrafts: false },
      { email: "work@example.com", isDefault: false, calendarRead: true, calendarCreate: true, people: false, mailRead: true, mailDrafts: true },
    ],
  });
  assert.ok(!/refresh-|access-/.test(text), "no token leaves the server");
});

const idTokenFor = (email: string) => "x." + Buffer.from(JSON.stringify({ email })).toString("base64url") + ".y";
const quietAgent = () => new Agent({ client: fakeModel([[say("x")]]).client, tools: [] });
const json = async (response: Promise<Response>) => (await response).json() as Promise<Record<string, unknown>>;

test("connect from the app: opens the browser, waits, then reports the new account once", async () => {
  connect({});
  fakeNetwork({ "oauth2.googleapis.com/token": () => ({ access_token: "a", expires_in: 3600, refresh_token: "r", id_token: idTokenFor("new@example.com") }) });
  const opened: string[] = [];
  const base = await startServer(0, { agent: quietAgent(), openBrowser: (url) => opened.push(url) });

  const started = await json(fetch(base + "/api/accounts/connect", { method: "POST" }));
  assert.equal(started.state, "waiting");
  assert.equal(started.url, opened[0], "the page gets the same address, so it can be copied to another browser");

  // The user approves in the browser.
  const query = new URL(opened[0] ?? "").searchParams;
  await realFetch(`${query.get("redirect_uri")}/?code=C&state=${query.get("state")}`);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(await json(fetch(base + "/api/accounts/connect")), { state: "done", email: "new@example.com" });
  assert.deepEqual(await json(fetch(base + "/api/accounts/connect")), { state: "idle" }, "reported once");
  const list = (await json(fetch(base + "/api/accounts"))) as { accounts: { email: string }[] };
  assert.deepEqual(list.accounts.map((a) => a.email), ["new@example.com"]);
});

test("connect from the app: a closed browser tab does not leave it stuck (cancel, reopen, start again)", async () => {
  connect({});
  fakeNetwork({ "oauth2.googleapis.com/token": () => ({ access_token: "a", expires_in: 3600, refresh_token: "r", id_token: idTokenFor("second@example.com") }) });
  const opened: string[] = [];
  const base = await startServer(0, { agent: quietAgent(), openBrowser: (url) => opened.push(url) });
  const redirectOf = (url: string) => new URL(url).searchParams.get("redirect_uri") ?? "";

  // First attempt: the user closes the tab, then asks to open it again.
  await fetch(base + "/api/accounts/connect", { method: "POST" });
  await fetch(base + "/api/accounts/connect/open", { method: "POST" });
  assert.equal(opened.length, 2);
  assert.equal(opened[1], opened[0], "the same page is opened again");

  // Cancel: back to idle, and the old waiting address is dead.
  assert.deepEqual(await json(fetch(base + "/api/accounts/connect/cancel", { method: "POST" })), { state: "idle" });
  await assert.rejects(realFetch(redirectOf(opened[0] ?? "")), "the cancelled attempt no longer listens");

  // Starting twice in a row: the second replaces the first, and still completes.
  await fetch(base + "/api/accounts/connect", { method: "POST" });
  const again = await json(fetch(base + "/api/accounts/connect", { method: "POST" }));
  assert.equal(again.state, "waiting");
  assert.notEqual(redirectOf(opened[3] ?? ""), redirectOf(opened[2] ?? ""));
  await assert.rejects(realFetch(redirectOf(opened[2] ?? "")), "the replaced attempt no longer listens");

  const query = new URL(opened[3] ?? "").searchParams;
  await realFetch(`${query.get("redirect_uri")}/?code=C&state=${query.get("state")}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await json(fetch(base + "/api/accounts/connect")), { state: "done", email: "second@example.com" });
});

test("default account: can be set from the app, only to a connected account", async () => {
  connect({ "me@example.com": [], "work@example.com": [] });
  const base = await startServer(0, { agent: quietAgent() });
  const set = (email: string) => fetch(base + "/api/accounts/default", { method: "POST", body: JSON.stringify({ email }) });

  assert.equal((await set("stranger@example.com")).status, 400);
  const result = (await (await set("work@example.com")).json()) as { accounts: { email: string; isDefault: boolean }[] };
  assert.deepEqual(result.accounts.map((a) => [a.email, a.isDefault]), [["me@example.com", false], ["work@example.com", true]]);
});

test("character: the server holds the state, and a screen that draws it follows every change", async () => {
  const base = await startServer(0, { agent: new Agent({ client: fakeModel([[say("x")]]).client, tools: [] }) });
  assert.match(await (await fetch(base + "/character")).text(), /data-state="resting"/);
  assert.match(await (await fetch(base + "/stage")).text(), /data-state="resting"/);

  const stream = await fetch(base + "/api/character");
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
  const next = async () => (await reader.read()).value;
  assert.equal(await next(), "data: resting\n\n");

  const set = (state: unknown) => fetch(base + "/api/character", { method: "POST", body: JSON.stringify({ state }) });
  assert.equal((await set("thinking")).status, 204);
  assert.equal(await next(), "data: thinking\n\n");
  // An unknown state is refused and changes nothing.
  assert.equal((await set("dancing")).status, 400);
  assert.equal((await set("speaking")).status, 204);
  assert.equal(await next(), "data: speaking\n\n");
  await reader.cancel();

  // A screen that joins later gets the current state at once.
  const late = (await fetch(base + "/api/character")).body!.pipeThrough(new TextDecoderStream()).getReader();
  assert.equal((await late.read()).value, "data: speaking\n\n");
  await late.cancel();
});

test("character: a click, a hold and the voice level reach every screen by name", async () => {
  const base = await startServer(0, { agent: new Agent({ client: fakeModel([[say("x")]]).client, tools: [] }) });
  const reader = (await fetch(base + "/api/character")).body!.pipeThrough(new TextDecoderStream()).getReader();
  const next = async () => (await reader.read()).value;
  assert.equal(await next(), "data: resting\n\n");
  const post = (path: string, body: object = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body) });

  assert.equal((await post("/api/character/poke")).status, 204);
  assert.equal(await next(), "event: poke\ndata: \n\n");
  await post("/api/character/hold", { down: true });
  assert.equal(await next(), "event: hold\ndata: down\n\n");
  await post("/api/character/hold", { down: "yes" }); // anything except true lets go
  assert.equal(await next(), "event: hold\ndata: up\n\n");
  await post("/api/character/level", { level: 0.456 });
  assert.equal(await next(), "event: level\ndata: 0.46\n\n");
  for (const level of [2, -1, "loud"]) assert.equal((await post("/api/character/level", { level })).status, 400);
  // What the agent says on its own initiative reaches the chat as one clean line.
  await post("/api/character/nudge", { text: "בעוד 10 דקות:\n  פגישה" });
  assert.equal(await next(), "event: nudge\ndata: בעוד 10 דקות: פגישה\n\n");
  assert.equal((await post("/api/character/nudge", { text: " " })).status, 400);
  await reader.cancel();
});

test("screens: pictures come only from the desktop app, in a size the page asked for", async () => {
  const agent = () => new Agent({ client: fakeModel([[say("x")]]).client, tools: [] });
  // Without the desktop app there is nothing that can look at the screen.
  const plain = await startServer(0, { agent: agent() });
  assert.equal((await fetch(plain + "/api/screens")).status, 501);

  const asked: number[] = [];
  let allowed = true;
  const base = await startServer(0, {
    agent: agent(),
    captureScreens: async (maxBytes) => {
      asked.push(maxBytes);
      if (!allowed) throw new Error("אין הרשאה");
      return [{ id: "1", label: "Current screenshot: screen 1 of 1.", image: "data:image/jpeg;base64,AAAA" }];
    },
  });
  const reader = (await fetch(base + "/api/character")).body!.pipeThrough(new TextDecoderStream()).getReader();
  assert.equal((await reader.read()).value, "data: resting\n\n");

  const body = (await (await fetch(base + "/api/screens?max=150000")).json()) as { screens: { id: string }[] };
  assert.equal(body.screens[0]?.id, "1");
  // The character is told the moment the agent looks.
  assert.equal((await reader.read()).value, "event: glance\ndata: \n\n");
  // A missing or absurd size is brought into a sane range.
  await fetch(base + "/api/screens");
  await reader.read();
  await fetch(base + "/api/screens?max=999999999");
  await reader.read();
  assert.deepEqual(asked, [150000, 40000, 1000000]);

  allowed = false;
  const refused = await fetch(base + "/api/screens?max=150000");
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { error: string }).error, "אין הרשאה");

  // Vision on and off reaches the character, and a screen that joins later is told too.
  const set = (on: unknown) => fetch(base + "/api/character/vision", { method: "POST", body: JSON.stringify({ on }) });
  await set(true);
  assert.equal((await reader.read()).value, "event: vision\ndata: on\n\n");
  const late = (await fetch(base + "/api/character")).body!.pipeThrough(new TextDecoderStream()).getReader();
  let first = "";
  while (!first.includes("vision")) first += (await late.read()).value;
  assert.equal(first, "data: resting\n\nevent: vision\ndata: on\n\n");
  await set("yes"); // anything except true switches it off
  assert.equal((await reader.read()).value, "event: vision\ndata: off\n\n");
  await reader.cancel();
  await late.cancel();
});
