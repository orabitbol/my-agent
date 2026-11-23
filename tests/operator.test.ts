import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeModel, say, toolRequest } from "./helpers.js";

const { runOperator } = await import("../src/core/operator.js");
const { computerTool } = await import("../src/core/tools/computer.js");
const { runTool } = await import("../src/core/run-tool.js");
type Computer = import("../src/core/operator.js").Computer;

// A pretend computer that writes down everything that was done to it.
function fakeComputer(overrides: Partial<Computer> = {}) {
  const done: string[] = [];
  const computer: Computer = {
    begin: async () => void done.push("begin"),
    look: async () => {
      done.push("look");
      return [{ id: "1", label: "Current screenshot: screen 1 of 1.", image: "data:image/jpeg;base64,AAAA", width: 1600, height: 900 }];
    },
    click: async (screen, x, y, double) => void done.push(`${double ? "double" : "click"} ${screen}:${x},${y}`),
    typeText: async (text) => void done.push(`type ${text}`),
    pressKey: async (keys) => void done.push(`key ${keys}`),
    openApp: async (name) => void done.push(`open ${name}`),
    userTookOver: () => false,
    takeControl: () => void done.push("take control"),
    ...overrides,
  };
  return { computer, done };
}
const send = { summary_hebrew: 'לשלוח לטל בוואטסאפ: "מה קורה?"', app: "WhatsApp", keys: "return", screen: 1, x: 0, y: 0 };

test("operator: looks, acts step by step, and sends only after the user approves", async () => {
  const { computer, done } = fakeComputer();
  const { client, requests } = fakeModel([
    [toolRequest("open_app", { name: "WhatsApp" })],
    [toolRequest("click", { screen: 1, x: 800, y: 850 })],
    [toolRequest("type_text", { text: "מה קורה?" })],
    [toolRequest("confirm_and_do", send)],
    [toolRequest("finish", { done: true, summary_hebrew: "שלחתי לטל." })],
  ]);
  const asked: string[] = [];
  const result = await runOperator({ task: "כתוב לטל בוואטסאפ מה קורה", computer, client, settleMs: 0, confirm: async (summary) => (asked.push(summary), true) });

  assert.deepEqual(result, { done: true, summary: "שלחתי לטל.", steps: 5 });
  assert.deepEqual(asked, [send.summary_hebrew]);
  assert.deepEqual(done, ["begin", "look", "open WhatsApp", "look", "click 1:800,850", "look", "type מה קורה?", "look", "take control", "open WhatsApp", "key return", "look"]);

  // Only the newest screenshot is sent: older ones are taken out, so the cost does not pile up.
  const pictures = (input: unknown[]) => JSON.stringify(input).split('"input_image"').length - 1;
  assert.deepEqual(requests.map((request) => pictures(request.input)), [1, 1, 1, 1, 1]);
  assert.match(JSON.stringify(requests[0]!.input), /The task: כתוב לטל/);
});

test("operator: a declined step is not done", async () => {
  const { computer, done } = fakeComputer();
  const { client, requests } = fakeModel([[toolRequest("confirm_and_do", send)], [toolRequest("finish", { done: false, summary_hebrew: "לא שלחתי." })]]);
  const result = await runOperator({ task: "x", computer, client, settleMs: 0, confirm: async () => false });
  assert.equal(result.done, false);
  assert.ok(!done.some((step) => step.startsWith("key") || step.startsWith("open")), done.join(" | "));
  assert.match(JSON.stringify(requests[1]!.input), /did not approve/);
});

test("operator: stops when the user takes the mouse, when it runs too long, and when it has nothing to do", async () => {
  // The user moved the mouse after the first step.
  let moved = false;
  const taken = fakeComputer({ userTookOver: () => moved });
  taken.computer.click = async () => void (moved = true);
  const script = [[toolRequest("click", { screen: 1, x: 1, y: 1 })], [toolRequest("type_text", { text: "סוד" })]];
  const stopped = await runOperator({ task: "x", computer: taken.computer, client: fakeModel(script).client, settleMs: 0, confirm: async () => true });
  assert.equal(stopped.summary, "עצרתי כי הזזת את העכבר.");
  assert.ok(!taken.done.includes("type סוד"));

  // It never runs forever.
  const endless = await runOperator({ task: "x", computer: fakeComputer().computer, client: fakeModel([[toolRequest("wait", {})]]).client, settleMs: 0, confirm: async () => true });
  assert.deepEqual([endless.done, endless.steps], [false, 25]);

  // Words instead of a step end the work.
  const talk = await runOperator({ task: "x", computer: fakeComputer().computer, client: fakeModel([[say("לאיזה טל?")]]).client, settleMs: 0, confirm: async () => true });
  assert.deepEqual([talk.done, talk.summary], [false, "לאיזה טל?"]);
});

test("operator: a failed step is reported to the model, and a missing permission stops everything", async () => {
  const broken = fakeComputer({ openApp: async () => { throw new Error('Could not open an app named "Whatsap".'); } });
  const { client, requests } = fakeModel([[toolRequest("open_app", { name: "Whatsap" })], [toolRequest("finish", { done: false, summary_hebrew: "לא מצאתי." })]]);
  await runOperator({ task: "x", computer: broken.computer, client, settleMs: 0, confirm: async () => true });
  assert.match(JSON.stringify(requests[1]!.input), /Could not open an app named/);

  const locked = fakeComputer({ begin: async () => { throw new Error("אין הרשאה"); } });
  await assert.rejects(runOperator({ task: "x", computer: locked.computer, client: fakeModel([[]]).client, settleMs: 0, confirm: async () => true }), /אין הרשאה/);
  assert.deepEqual(locked.done, []);
});

test("use_computer: taking control needs approval, and the last step asks again through the same gate", async () => {
  const { computer, done } = fakeComputer();
  const model = () => fakeModel([[toolRequest("confirm_and_do", send)], [toolRequest("finish", { done: true, summary_hebrew: "נשלח." })]]).client;

  // With nobody to ask, nothing is touched.
  const alone = (await runTool([computerTool(computer, model())], "use_computer", JSON.stringify({ task: "כתוב לטל" }))) as { declined?: boolean };
  assert.equal(alone.declined, true);
  assert.deepEqual(done, []);

  const asked: string[] = [];
  const result = await runTool([computerTool(computer, model())], "use_computer", JSON.stringify({ task: "כתוב לטל" }), {
    approve: async ({ summary }) => (asked.push(summary), true),
  });
  assert.deepEqual(result, { done: true, summary: "נשלח.", steps: 2 });
  assert.equal(asked.length, 2);
  assert.match(asked[0]!, /לקחת שליטה על העכבר והמקלדת[\s\S]*כתוב לטל[\s\S]*הזז את העכבר/);
  assert.equal(asked[1], send.summary_hebrew);

  const empty = (await runTool([computerTool(computer, model())], "use_computer", JSON.stringify({ task: " " }), { approve: async () => true })) as { error?: string };
  assert.match(empty.error ?? "", /task is empty/);
});
