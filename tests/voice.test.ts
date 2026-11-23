import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, fakeModel, fakeNetwork, say } from "./helpers.js";

const { Agent } = await import("../src/core/agent.js");
const { startServer } = await import("../src/entries/server.js");
const { addFact } = await import("../src/core/memory.js");
type Tool = import("../src/core/tools/types.js").Tool;

const OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";
const runs: unknown[] = [];
const plain: Tool = { name: "look_up", description: "Looks something up.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, run: async (args) => { runs.push(args); return { found: 3 }; } };
const sensitive: Tool = { ...plain, name: "do_sensitive", needsApproval: true, describe: () => "לעשות פעולה רגישה" };
const serve = (extra = {}) => startServer(0, { agent: new Agent({ client: fakeModel([[say("x")]]).client, tools: [] }), tools: [plain, sensitive], ...extra });
const startSession = (base: string, offer = OFFER) => fetch(base + "/api/voice/session", { method: "POST", headers: { "Content-Type": "application/sdp" }, body: offer });
const sessionOf = (call: { raw: unknown } | undefined) => JSON.parse(String((call?.raw as FormData).get("session")));

async function events(response: Response) {
  return (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("starting a voice session: our server sets the key, the instructions and the tools", async () => {
  connect({ "work@example.com": [] });
  await addFact("מעדיף פגישות של חצי שעה");
  const calls = fakeNetwork({ "realtime/calls": () => new Response("v=0 ANSWER", { status: 201, headers: { "Content-Type": "application/sdp" } }) });

  const response = await startSession(await serve());
  assert.deepEqual(await response.json(), { answerSdp: "v=0 ANSWER", transcription: true });

  const call = calls[0];
  assert.equal(call?.url, "https://api.openai.com/v1/realtime/calls");
  assert.equal(call?.headers.Authorization, "Bearer test-key");
  assert.equal((call?.raw as FormData).get("sdp"), OFFER);

  const session = sessionOf(call);
  assert.deepEqual([session.type, session.model, session.audio.output.voice], ["realtime", "gpt-realtime-2.1", "marin"]);
  assert.deepEqual(session.audio.input.transcription, { model: "gpt-transcribe", language: "he" });
  assert.equal(session.audio.input.turn_detection.type, "semantic_vad");
  assert.deepEqual(session.audio.input.noise_reduction, { type: "far_field" });
  assert.deepEqual(session.tools.map((t: { name: string; type: string }) => [t.type, t.name]), [["function", "look_up"], ["function", "do_sensitive"]]);
  assert.match(session.instructions, /You are now SPEAKING/);
  assert.match(session.instructions, /work@example\.com/, "knows the connected accounts");
  assert.match(session.instructions, /מעדיף פגישות של חצי שעה/, "knows the saved memories");
});

test("if OpenAI refuses the setup, the optional parts are dropped one at a time", async () => {
  // Refuses the noise filter only: the transcript is kept.
  let calls = fakeNetwork({
    "realtime/calls": (call) =>
      sessionOf(call).audio.input.noise_reduction ? Response.json({ error: { message: "Unknown parameter" } }, { status: 400 }) : new Response("v=0 ANSWER"),
  });
  assert.deepEqual(await (await startSession(await serve())).json(), { answerSdp: "v=0 ANSWER", transcription: true });
  assert.equal(calls.length, 2);
  assert.ok(sessionOf(calls[1]).audio.input.transcription);

  // Refuses the transcript too: the conversation still starts, without it.
  calls = fakeNetwork({
    "realtime/calls": (call) =>
      sessionOf(call).audio.input.transcription ? Response.json({ error: { message: "Unknown model" } }, { status: 400 }) : new Response("v=0 ANSWER"),
  });
  assert.deepEqual(await (await startSession(await serve())).json(), { answerSdp: "v=0 ANSWER", transcription: false });
  assert.equal(calls.length, 3);
  assert.equal(sessionOf(calls[2]).tools.length, 2, "everything else stays");
});

test("a failed start reaches the page with OpenAI's reason; a bad offer never reaches OpenAI", async () => {
  const calls = fakeNetwork({ "realtime/calls": () => Response.json({ error: { message: "Insufficient quota" } }, { status: 429 }) });
  const base = await serve();
  const failed = await startSession(base);
  assert.equal(failed.status, 502);
  assert.match(((await failed.json()) as { error: string }).error, /429.*Insufficient quota/);

  const before = calls.length;
  assert.equal((await startSession(base, "not an offer")).status, 502);
  assert.equal(calls.length, before);
});

test("without microphone permission nothing is started", async () => {
  const calls = fakeNetwork({ "realtime/calls": () => new Response("v=0 ANSWER") });
  const response = await startSession(await serve({ prepareMicrophone: async () => false }));
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await startSession(await serve({ prepareMicrophone: async () => true }))).status, 200);
});

test("a tool asked for by voice runs on our server and returns its result", async () => {
  runs.length = 0;
  const base = await serve();
  const stream = await events(await fetch(base + "/api/voice/tool", { method: "POST", body: JSON.stringify({ name: "look_up", arguments: '{"q":"טל"}' }) }));
  assert.deepEqual(stream.map((e) => e.type), ["tool", "result"]);
  assert.deepEqual(runs, [{ q: "טל" }]);
  assert.equal(stream[1]?.output, JSON.stringify({ found: 3 }));
});

test("by voice too, a sensitive tool waits for the button; saying yes out loud is not enough", async () => {
  for (const [approved, expectedRuns] of [[true, 1], [false, 0]] as const) {
    runs.length = 0;
    const base = await serve();
    const response = await fetch(base + "/api/voice/tool", { method: "POST", body: JSON.stringify({ name: "do_sensitive", arguments: "{}" }) });
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    const first = JSON.parse((await reader.read()).value ?? "{}") as { type: string; id: string; summary: string };
    assert.deepEqual([first.type, first.summary], ["approval", "לעשות פעולה רגישה"]);
    assert.equal(runs.length, 0, "nothing ran while waiting");

    await fetch(base + "/api/approve", { method: "POST", body: JSON.stringify({ id: first.id, approved }) });
    let rest = "";
    for (;;) { const { value, done } = await reader.read(); if (done) break; rest += value; }
    const result = JSON.parse(rest.trim().split("\n").at(-1) ?? "{}") as { type: string; output: string };
    assert.equal(result.type, "result");
    assert.equal(runs.length, expectedRuns);
    assert.equal(/declined/.test(result.output), !approved);
  }
});

test("an unknown tool, or one the model garbled, comes back as an error it can read", async () => {
  const base = await serve();
  for (const body of [{ name: "delete_everything", arguments: "{}" }, { name: "look_up", arguments: "{not json" }, {}]) {
    const stream = await events(await fetch(base + "/api/voice/tool", { method: "POST", body: JSON.stringify(body) }));
    assert.match(String(stream.at(-1)?.output), /error/);
  }
});

test("voice routes refuse requests from other websites", async () => {
  const calls = fakeNetwork({ "realtime/calls": () => new Response("v=0 ANSWER") });
  const base = await serve();
  for (const path of ["/api/voice/session", "/api/voice/tool"]) {
    assert.equal((await fetch(base + path, { method: "POST", headers: { Origin: "https://evil.example" }, body: OFFER })).status, 403);
  }
  assert.equal(calls.length, 0);
});
