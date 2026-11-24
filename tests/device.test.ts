import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, fakeModel, fakeNetwork, say } from "./helpers.js";

const { Agent } = await import("../src/core/agent.js");
const { startServer } = await import("../src/entries/server.js");
type Tool = import("../src/core/tools/types.js").Tool;
type Socket = import("../src/core/voice-sideband.js").Socket;

const OFFER = "v=0\r\no=- 1 2 IN IP4 192.168.1.50\r\n";
const KEY = "d".repeat(64);
const runs: unknown[] = [];
const plain: Tool = { name: "look_up", description: "Looks something up.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, run: async (args) => { runs.push(args); return { found: 3 }; } };
const sensitive: Tool = { ...plain, name: "do_sensitive", needsApproval: true, describe: () => "לעשות פעולה רגישה" };

// A pretend connection to the call: the test plays OpenAI's side.
function fakeSocket() {
  const listeners: Record<string, ((event: { data?: unknown }) => void)[]> = {};
  const sent: Record<string, unknown>[] = [];
  const opened: { url: string; headers: Record<string, string> }[] = [];
  let closed = false;
  const socket: Socket = {
    send: (data) => void sent.push(JSON.parse(data)),
    close: () => { closed = true; listeners.close?.forEach((listener) => listener({})); },
    addEventListener: (type, listener) => void (listeners[type] ??= []).push(listener),
  };
  return {
    sent, opened, isClosed: () => closed,
    hangUp: () => socket.close(), // the call ends from OpenAI's side
    connect: (url: string, headers: Record<string, string>) => { opened.push({ url, headers }); queueMicrotask(() => listeners.open?.forEach((listener) => listener({}))); return socket; },
    receive: (event: object) => listeners.message?.forEach((listener) => listener({ data: JSON.stringify(event) })),
  };
}
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(check(), "timed out waiting"); };
let nextPort = 18000 + Math.floor(Math.random() * 2000);

async function serve() {
  const port = nextPort++;
  const socket = fakeSocket();
  const base = await startServer(0, { agent: new Agent({ client: fakeModel([[say("x")]]).client, tools: [] }), tools: [plain, sensitive], device: { port, key: KEY, connect: socket.connect } });
  await new Promise((r) => setTimeout(r, 50)); // the door opens a moment after the main server
  const call = (headers: Record<string, string> = { Authorization: `Bearer ${KEY}` }, path = "/device/voice", method = "POST") =>
    fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: method === "POST" ? OFFER : undefined });
  return { base, socket, call };
}
const openai = () => fakeNetwork({ "realtime/calls": () => new Response("v=0 ANSWER", { status: 201, headers: { Location: "/v1/realtime/calls/rtc_abc123" } }) });

test("device: the door opens only for the device's key, and only for starting a call", async () => {
  connect({ "work@example.com": [] });
  const calls = openai();
  const { call, socket } = await serve();

  assert.equal((await call({})).status, 401);
  assert.equal((await call({ Authorization: "Bearer " + "x".repeat(64) })).status, 401);
  assert.equal((await call(undefined, "/api/chat")).status, 404);
  assert.equal((await call(undefined, "/", "GET")).status, 404);
  assert.equal(calls.length, 0, "nothing reached OpenAI");

  const response = await call();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "v=0 ANSWER");

  // The call is opened with OUR key, instructions and tools; the device sent none of them.
  assert.equal(calls[0]!.headers.Authorization, "Bearer test-key");
  const session = JSON.parse(String((calls[0]!.raw as FormData).get("session")));
  assert.match(session.instructions, /small device on his desk/);
  assert.deepEqual(session.tools.map((tool: { name: string }) => tool.name), ["look_up", "do_sensitive"]);
  assert.equal((calls[0]!.raw as FormData).get("sdp"), OFFER);

  // And the server joins that same call.
  assert.deepEqual(socket.opened, [{ url: "wss://api.openai.com/v1/realtime?call_id=rtc_abc123", headers: { Authorization: "Bearer test-key" } }]);
});

test("device: a short key keeps the door closed", async () => {
  const port = nextPort++;
  await startServer(0, { agent: new Agent({ client: fakeModel([[say("x")]]).client, tools: [] }), tools: [], device: { port, key: "short" } });
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/device/voice`, { method: "POST" }));
});

test("device: the server runs the tools, shows the state, and asks for approval on the computer", async () => {
  openai();
  const { base, socket, call } = await serve();
  const stream = (await fetch(base + "/api/character")).body!.pipeThrough(new TextDecoderStream()).getReader();
  let seen = "";
  void (async () => { for (;;) { const { value, done } = await stream.read(); if (done) break; seen += value; } })();

  await call();
  await until(() => seen.includes("data: listening"));

  // He speaks; the model asks for a plain tool; the result goes back, then the model continues.
  runs.length = 0;
  socket.receive({ type: "input_audio_buffer.speech_started" });
  socket.receive({ type: "response.created" });
  socket.receive({ type: "response.output_item.done", response_id: "r1", item: { type: "function_call", name: "look_up", arguments: '{"q":1}', call_id: "c1" } });
  socket.receive({ type: "response.done", response: { id: "r1" } });
  await until(() => socket.sent.length === 2);
  assert.deepEqual(runs, [{ q: 1 }]);
  assert.deepEqual(socket.sent, [
    { type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1", output: '{"found":3}' } },
    { type: "response.create" },
  ]);
  assert.match(seen, /data: hearing[\s\S]*data: thinking/);

  // A sensitive tool waits for a button on the computer. "No" means it does not run.
  for (const [answer, ran] of [[false, 0], [true, 1]] as const) {
    runs.length = 0;
    socket.sent.length = 0;
    seen = "";
    socket.receive({ type: "response.output_item.done", response_id: "r2", item: { type: "function_call", name: "do_sensitive", arguments: "{}", call_id: "c2" } });
    socket.receive({ type: "response.done", response: { id: "r2" } });
    await until(() => seen.includes("event: approval"));
    const asked = JSON.parse(seen.split("event: approval\ndata: ")[1]!.split("\n")[0]!) as { id: string; summary: string };
    assert.equal(asked.summary, "לעשות פעולה רגישה");
    assert.match(seen, /data: approval/);
    assert.equal(runs.length, 0, "nothing runs before the answer");
    await fetch(base + "/api/approve", { method: "POST", body: JSON.stringify({ id: asked.id, approved: answer }) });
    await until(() => socket.sent.length === 2);
    assert.equal(runs.length, ran);
    const output = JSON.parse((socket.sent[0] as { item: { output: string } }).item.output) as { declined?: boolean };
    assert.equal(output.declined === true, !answer);
  }

  // A new call from the device replaces the old one.
  await call();
  assert.equal(socket.isClosed(), true);
  await stream.cancel();
});

test("sideband: a call that has gone quiet is hung up", async () => {
  const { attachToCall } = await import("../src/core/voice-sideband.js");
  const calls = fakeNetwork({ "/hangup": () => new Response(null, { status: 200 }) });
  const socket = fakeSocket();
  const states: string[] = [];
  const call = attachToCall("rtc_quiet", [], { connect: socket.connect, idleMs: 40, onState: (state) => states.push(state) });
  await call.closed;
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/realtime/calls/rtc_quiet/hangup");
  assert.equal(calls[0]!.headers.Authorization, "Bearer test-key");
  assert.equal(socket.isClosed(), true);
  assert.equal(states.at(-1), "resting");
});

test("device: its settings reach it through the door, and the app's light follows it", async () => {
  connect({ "work@example.com": [] });
  const calls = openai();
  const { base, call } = await serve();
  const app = async (change?: object) =>
    (await fetch(`${base}/api/device`, change ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) } : {})).json() as Promise<{ enabled: boolean; connected: boolean; inCall: boolean; settings: Record<string, unknown> }>;

  const before = await app();
  assert.equal(before.enabled, true);
  assert.equal(before.connected, false, "the device has not asked for anything yet");

  assert.equal((await call({}, "/device/settings", "GET")).status, 401);
  // Out-of-range and unknown values are brought back inside the limits; unknown names are dropped.
  const saved = await app({ volume: 250, muted: true, voice: "nobody", language: "auto", key: "x" });
  assert.deepEqual(saved.settings, { volume: 100, muted: true, voice: "", language: "auto", claps: true });

  const asked = await call(undefined, "/device/settings", "GET");
  assert.equal(asked.status, 200);
  const told = await asked.json() as Record<string, unknown>;
  assert.deepEqual({ volume: told.volume, muted: told.muted, here: told.here }, { volume: 100, muted: true, here: false });
  assert.equal((await app()).connected, true, "asking is how we know it is on");

  // The next call uses the chosen voice, and Hebrew only when that is chosen.
  await app({ voice: "cedar", language: "he", muted: false, volume: 90 });
  assert.equal((await call()).status, 200);
  const session = JSON.parse(String((calls.at(-1)!.raw as FormData).get("session")));
  assert.equal(session.audio.output.voice, "cedar");
  assert.match(session.instructions, /Always answer in Hebrew/);
  assert.equal((await app()).inCall, true);
});

test("device: a touch calls the character over and sends it back; each side leaves before the other shows it", async () => {
  connect({ "work@example.com": [] });
  openai();
  const port = nextPort++;
  const socket = fakeSocket();
  const places: string[] = [];
  await startServer(0, { agent: new Agent({ client: fakeModel([[say("x")]]).client, tools: [] }), tools: [plain], device: { port, key: KEY, connect: socket.connect }, onCharacterPlace: (where) => void places.push(where) });
  await new Promise((r) => setTimeout(r, 50));
  const auth = { Authorization: `Bearer ${KEY}` };
  type Told = { v: number; here: boolean; call: boolean; face: string };
  const ask = async (seen = 0) => (await fetch(`http://127.0.0.1:${port}/device/settings?v=${seen}`, { headers: auth })).json() as Promise<Told>;
  const touch = () => fetch(`http://127.0.0.1:${port}/device/touch`, { method: "POST", headers: auth });

  // Switched on, untouched: the character stays on the computer, the device is dark and silent.
  const first = await ask();
  assert.deepEqual({ here: first.here, call: first.call }, { here: false, call: false });
  assert.deepEqual(places, []);

  // A question with the current version stays open until something changes.
  let open = ask(first.v);
  let answered = false;
  void open.then(() => { answered = true; });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(answered, false, "nothing changed yet, so no answer yet");

  // A touch needs the device's key, like everything else at this door.
  assert.equal((await fetch(`http://127.0.0.1:${port}/device/touch`, { method: "POST" })).status, 401);
  assert.deepEqual(places, []);

  // Touched: the computer lets go first, and the device is told to start a call but not yet to show it.
  assert.equal((await touch()).status, 204);
  assert.deepEqual(places, ["device"]);
  const starting = await open;
  assert.deepEqual({ here: starting.here, call: starting.call }, { here: false, call: true });
  // A moment later (the computer's goodbye is over) it appears on the device.
  const arrived = await ask(starting.v);
  assert.equal(arrived.here, true);
  assert.equal(arrived.face, "thinking", "still connecting");

  // The device starts the call it was told to start.
  assert.equal((await fetch(`http://127.0.0.1:${port}/device/voice`, { method: "POST", headers: auth, body: OFFER })).status, 200);
  await until(() => socket.opened.length === 1);

  // Touched again: the device is told at once to go dark and hang up; the call is ended from our side too.
  open = ask(arrived.v);
  await touch();
  const leaving = await open;
  assert.deepEqual({ here: leaving.here, call: leaving.call }, { here: false, call: false });
  assert.equal(socket.isClosed(), true);
  assert.deepEqual(places, ["device"], "the computer waits for the device's goodbye");
  await until(() => places.length === 2);
  assert.deepEqual(places, ["device", "computer"]);
});

test("device: told to move in words, the character goes a moment later; without a device it says so", async () => {
  connect({ "work@example.com": [] });
  openai();
  const port = nextPort++;
  const places: string[] = [];
  await startServer(0, { agent: new Agent({ client: fakeModel([[say("x")]]).client, tools: [] }), tools: [plain], device: { port, key: KEY, connect: fakeSocket().connect }, onCharacterPlace: (where) => void places.push(where) });
  await new Promise((r) => setTimeout(r, 50));
  const { moveCharacter } = await import("../src/core/tools/move.js");

  // The device is switched off: the move is refused, with a reason the agent can say.
  await assert.rejects(() => moveCharacter.run({ where: "device" }), /not connected/);

  // Switched on: it moves, but not before it had time to finish its word.
  await fetch(`http://127.0.0.1:${port}/device/settings`, { headers: { Authorization: `Bearer ${KEY}` } });
  assert.deepEqual(await moveCharacter.run({ where: "device" }), { moving_to: "device" });
  assert.deepEqual(places, []);
  await new Promise((r) => setTimeout(r, 2100));
  assert.deepEqual(places, ["device"]);
});

test("device: two claps wake it, with a hello first; switched off in the settings they do nothing", async () => {
  connect({ "work@example.com": [] });
  openai();
  const port = nextPort++;
  const socket = fakeSocket();
  const places: string[] = [];
  const base = await startServer(0, { agent: new Agent({ client: fakeModel([[say("x")]]).client, tools: [] }), tools: [plain], device: { port, key: KEY, connect: socket.connect }, onCharacterPlace: (where) => void places.push(where) });
  await new Promise((r) => setTimeout(r, 50));
  const auth = { Authorization: `Bearer ${KEY}` };
  const device = (path: string, method = "POST", body?: string) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: auth, body });
  const set = (change: object) => fetch(`${base}/api/device`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) });

  // Switched off: the device is told not to listen, and a stray report changes nothing.
  await set({ claps: false });
  assert.equal(((await (await device("/device/settings", "GET")).json()) as { claps: boolean }).claps, false);
  assert.equal((await device("/device/wake")).status, 204);
  assert.deepEqual(places, []);

  // Switched on: two claps call it over, and the call opens with a greeting.
  await set({ claps: true });
  assert.equal((await fetch(`http://127.0.0.1:${port}/device/wake`, { method: "POST" })).status, 401);
  await device("/device/wake");
  assert.deepEqual(places, ["device"]);
  assert.equal((await device("/device/voice", "POST", OFFER)).status, 200);
  await until(() => socket.sent.some((event) => event.type === "response.create"));
  const hello = socket.sent.find((event) => event.type === "response.create") as { response: { instructions: string } };
  assert.match(hello.response.instructions, /בוקר טוב|צהריים טובים|ערב טוב|לילה טוב/);

  // Claps while it is already here do not send it away (only a touch does).
  await device("/device/wake");
  assert.deepEqual(places, ["device"]);
});

test("device: the technical log shows what happened, including the device's own lines, and never what was said", async () => {
  connect({ "work@example.com": [] });
  openai();
  const port = nextPort++;
  const base = await startServer(0, { agent: new Agent({ client: fakeModel([[say("x")]]).client, tools: [] }), tools: [plain], device: { port, key: KEY, connect: fakeSocket().connect } });
  await new Promise((r) => setTimeout(r, 50));
  const auth = { Authorization: `Bearer ${KEY}` };

  assert.equal((await fetch(`http://127.0.0.1:${port}/device/log`, { method: "POST", body: "x" })).status, 401);
  const sent = await fetch(`http://127.0.0.1:${port}/device/log`, { method: "POST", headers: auth, body: "\u001b[0;32mI (2100) AGENT_CLAPS: First clap (loudness 30000, room 400)\u001b[0m\nE (2200) DEV_LCD_TOUCH: no touch\n" });
  assert.equal(sent.status, 204);
  await fetch(`http://127.0.0.1:${port}/device/touch`, { method: "POST", headers: auth });

  const { lines } = (await (await fetch(`${base}/api/trace`)).json()) as { lines: { source: string; text: string }[] };
  const text = lines.map((line) => `[${line.source}] ${line.text}`).join("\n");
  assert.match(text, /\[device\] I \(2100\) AGENT_CLAPS: First clap/);
  assert.match(text, /\[device\] E \(2200\) DEV_LCD_TOUCH: no touch/);
  assert.match(text, /\[device\] the screen was touched/);
  assert.match(text, /\[app\] the character is wanted on the device/);
  assert.doesNotMatch(text, /\u001b/, "color codes are stripped");
  assert.doesNotMatch(text, new RegExp(KEY), "the device's key never appears");
});
