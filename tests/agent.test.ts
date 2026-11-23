import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeModel, home, say, toolRequest } from "./helpers.js";

const { Agent } = await import("../src/core/agent.js");
type Tool = import("../src/core/tools/types.js").Tool;

function recorder(extra: Partial<Tool> = {}) {
  const runs: unknown[] = [];
  const tool: Tool = {
    name: "do_thing",
    description: "test",
    parameters: {},
    run: async (args) => {
      runs.push(args);
      return { done: true };
    },
    ...extra,
  };
  return { tool, runs };
}

test("answers directly when the model asks for no tool", async () => {
  const { client, requests } = fakeModel([[say("שלום")]]);
  const agent = new Agent({ client, tools: [] });
  assert.equal(await agent.send("היי"), "שלום");
  assert.equal(requests.length, 1);
});

test("runs a tool, returns its result to the model, then answers", async () => {
  const { tool, runs } = recorder();
  const { client, requests } = fakeModel([[toolRequest("do_thing", { a: 1 })], [say("בוצע")]]);
  const seen: string[] = [];
  const agent = new Agent({ client, tools: [tool] });

  assert.equal(await agent.send("עשה", { onToolCall: (call) => seen.push(`${call.tool}:${call.ok}`) }), "בוצע");
  assert.deepEqual(runs, [{ a: 1 }]);
  assert.deepEqual(seen, ["do_thing:true"]);
  const second = requests[1]?.input as { type?: string; output?: string }[];
  assert.equal(second.at(-1)?.type, "function_call_output");
  assert.equal(second.at(-1)?.output, JSON.stringify({ done: true }));
});

test("keeps the conversation between turns, and forgets it on reset", async () => {
  const { client, requests } = fakeModel([[say("א")], [say("ב")], [say("ג")]]);
  const agent = new Agent({ client, tools: [] });
  await agent.send("ראשון");
  await agent.send("שני");
  assert.equal(requests[1]?.input.length, 3); // user, assistant, user
  agent.reset();
  await agent.send("שלישי");
  assert.equal(requests[2]?.input.length, 1);
});

test("a sensitive tool does not run when the user declines", async () => {
  const { tool, runs } = recorder({ needsApproval: true, describe: () => "לעשות משהו" });
  const { client, requests } = fakeModel([[toolRequest("do_thing", {})], [say("לא בוצע")]]);
  const asked: string[] = [];
  const agent = new Agent({ client, tools: [tool] });

  await agent.send("עשה", {
    approve: async (request) => {
      asked.push(request.summary);
      return false;
    },
  });
  assert.deepEqual(asked, ["לעשות משהו"]);
  assert.equal(runs.length, 0);
  const output = (requests[1]?.input as { output?: string }[]).at(-1)?.output ?? "";
  assert.match(output, /"declined":true/);
});

test("a sensitive tool does not run when nobody can be asked", async () => {
  const { tool, runs } = recorder({ needsApproval: true });
  const { client } = fakeModel([[toolRequest("do_thing", {})], [say("לא בוצע")]]);
  await new Agent({ client, tools: [tool] }).send("עשה");
  assert.equal(runs.length, 0);
});

test("a sensitive tool runs after the user approves", async () => {
  const { tool, runs } = recorder({ needsApproval: true });
  const { client } = fakeModel([[toolRequest("do_thing", { x: 2 })], [say("בוצע")]]);
  await new Agent({ client, tools: [tool] }).send("עשה", { approve: async () => true });
  assert.deepEqual(runs, [{ x: 2 }]);
});

test("prepare settles the arguments first: the approval and the action see the same thing", async () => {
  const { tool, runs } = recorder({
    needsApproval: true,
    prepare: async (args) => ({ ...args, account: "resolved@example.com" }),
    describe: (args) => `לפעול בחשבון ${String(args.account)}`,
  });
  const { client } = fakeModel([[toolRequest("do_thing", { account: null })], [say("בוצע")]]);
  const asked: unknown[] = [];
  await new Agent({ client, tools: [tool] }).send("עשה", {
    approve: async (request) => {
      asked.push(request.summary, request.args);
      return true;
    },
  });
  assert.deepEqual(asked, ["לפעול בחשבון resolved@example.com", { account: "resolved@example.com" }]);
  assert.deepEqual(runs, [{ account: "resolved@example.com" }]);
});

test("a failing or unknown tool becomes an error the model can read, not a crash", async () => {
  const { tool } = recorder({ run: async () => { throw new Error("boom"); } });
  const { client, requests } = fakeModel([
    [toolRequest("do_thing", {}, "c1"), toolRequest("no_such_tool", {}, "c2")],
    [say("נכשל")],
  ]);
  assert.equal(await new Agent({ client, tools: [tool] }).send("עשה"), "נכשל");
  const outputs = (requests[1]?.input as { output?: string }[]).slice(-2).map((item) => item.output);
  assert.match(outputs[0] ?? "", /boom/);
  assert.match(outputs[1] ?? "", /Unknown tool/);
});

test("stops when the model keeps calling tools forever", async () => {
  const { tool, runs } = recorder();
  const { client } = fakeModel([[toolRequest("do_thing", {})]]); // same request again and again
  const reply = await new Agent({ client, tools: [tool] }).send("עשה");
  assert.match(reply, /עצרתי/);
  assert.equal(runs.length, 8);
});

test("every tool call is written to the log", () => {
  const lines = readFileSync(join(home, "data", "tool-calls.log"), "utf8").trim().split("\n");
  const first = JSON.parse(lines[0] ?? "{}") as { tool: string; ok: boolean; time: string };
  assert.equal(first.tool, "do_thing");
  assert.ok(first.time);
  assert.ok(lines.length >= 11);
});
