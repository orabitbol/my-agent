import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fakeModel, home, say, toolRequest } from "./helpers.js";

const memory = await import("../src/core/memory.js");
const tools = await import("../src/core/tools/memory.js");
const { buildInstructions } = await import("../src/core/prompt.js");
const { Agent } = await import("../src/core/agent.js");
const { startServer } = await import("../src/entries/server.js");

test("with nothing saved, the agent is told it has no memories yet", async () => {
  assert.deepEqual(await memory.listFacts(), []);
  assert.match(await buildInstructions(), /no saved memories/);
});

test("a fact is saved to one file on disk, cleaned up, and not saved twice", async () => {
  const first = await memory.addFact("  מעדיף פגישות\nקצרות  ");
  assert.equal(first.text, "מעדיף פגישות קצרות");
  assert.equal((await memory.addFact("מעדיף פגישות קצרות")).id, first.id);
  assert.equal((await memory.listFacts()).length, 1);
  assert.ok(existsSync(join(home, "data", "memory.db")));
});

test("empty and overlong facts are refused", async () => {
  await assert.rejects(memory.addFact("   "), /nothing to remember/);
  await assert.rejects(memory.addFact("x".repeat(301)), /one short fact/);
});

test("saved facts reach the model on the next turn, numbered so it can forget them", async () => {
  await memory.addFact("טל גורביץ' הוא המעצב שלי");
  const instructions = await buildInstructions();
  assert.match(instructions, /1\. מעדיף פגישות קצרות\n2\. טל גורביץ' הוא המעצב שלי/);

  // A brand-new agent (a new conversation) still knows them.
  const { client, requests } = fakeModel([[say("ok")]]);
  await new Agent({ client, tools: [] }).send("היי");
  assert.match((requests[0] as unknown as { instructions: string }).instructions, /מעדיף פגישות קצרות/);
});

test("the remember and forget tools save and delete", async () => {
  const saved = (await tools.remember.run({ fact: "שותה קפה בלי סוכר" })) as { id: number };
  assert.equal((await memory.listFacts()).at(-1)?.text, "שותה קפה בלי סוכר");
  assert.deepEqual(await tools.forget.run({ id: saved.id }), { deleted: true });
  await assert.rejects(tools.forget.run({ id: saved.id }), /no memory with that number/);
  assert.equal((await memory.listFacts()).length, 2);
});

test("the model can save a memory during a conversation", async () => {
  const { client } = fakeModel([[toolRequest("remember", { fact: "עובד מהבית בימי שלישי" })], [say("רשמתי")]]);
  const seen: string[] = [];
  await new Agent({ client, tools: [tools.remember] }).send("אני עובד מהבית בימי שלישי", { onToolCall: (c) => seen.push(`${c.tool}:${c.ok}`) });
  assert.deepEqual(seen, ["remember:true"]);
  assert.ok((await memory.listFacts()).some((fact) => fact.text === "עובד מהבית בימי שלישי"));
});

test("the app can list and delete memories", async () => {
  const base = await startServer(0, { agent: new Agent({ client: fakeModel([[say("x")]]).client, tools: [] }) });
  const listed = (await (await fetch(base + "/api/memory")).json()) as { facts: { id: number; text: string }[] };
  assert.equal(listed.facts.length, 3);
  const target = listed.facts[0];
  const after = (await (await fetch(base + "/api/memory/delete", { method: "POST", body: JSON.stringify({ id: target?.id }) })).json()) as { facts: { id: number }[] };
  assert.equal(after.facts.length, 2);
  assert.ok(!after.facts.some((fact) => fact.id === target?.id));
  assert.doesNotMatch(await buildInstructions(), new RegExp(target?.text ?? "x"));
});
