import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { connect, fakeNetwork, home } from "./helpers.js";

const { SCOPE } = await import("../src/core/google/auth.js");
const { Initiative, isQuiet } = await import("../src/core/initiative.js");

const settings = (value: object) => {
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "data", "settings.json"), JSON.stringify(value));
};
// A clock the test moves by hand. 10:00 in the morning, local time.
function clock(hour = 10, minute = 0) {
  let time = new Date(2026, 10, 24, hour, minute, 0);
  return { now: () => new Date(time), forward: (minutes: number) => void (time = new Date(time.getTime() + minutes * 60_000)), at: (minutes: number) => new Date(time.getTime() + minutes * 60_000).toISOString() };
}

test("initiative: a meeting is announced once, shortly before it starts", async () => {
  settings({});
  connect({ "me@example.com": [SCOPE.calendarRead], "work@example.com": [SCOPE.calendarRead] });
  const time = clock();
  const at20 = time.at(20), at21 = time.at(21), at50 = time.at(50); // fixed moments: the meetings do not move with the clock
  const calls = fakeNetwork({
    "calendar/v3": () => ({
      items: [
        { summary: "סנכרון עם נועם", location: "TLV-Carmel", start: { dateTime: at20 }, end: { dateTime: at50 } },
        { summary: "יום הולדת", start: { date: "2026-11-24" }, end: { date: "2026-11-25" } },
        { summary: "פגישה שדחיתי", start: { dateTime: at20 }, end: { dateTime: at50 }, attendees: [{ self: true, responseStatus: "declined" }] },
        { summary: "שיחת וידאו", location: "https://zoom.us/j/123456789?pwd=abcdefghijklmnop", start: { dateTime: at21 }, end: { dateTime: at50 } },
      ],
    }),
  });
  const initiative = new Initiative(time.now);

  // Twenty minutes before: too early to say anything.
  assert.deepEqual(await initiative.check(), []);
  time.forward(10);
  // Ten minutes before. The same meeting is in both calendars, and it is said once.
  assert.deepEqual((await initiative.check()).map((nudge) => nudge.text), ["בעוד 10 דקות: סנכרון עם נועם (TLV-Carmel)"]);
  time.forward(1);
  // The next one, a minute later. A long link is not read out. The first is not repeated.
  assert.deepEqual((await initiative.check()).map((nudge) => nudge.text), ["בעוד 10 דקות: שיחת וידאו"]);
  time.forward(1);
  assert.deepEqual(await initiative.check(), []);

  // The calendar is read every few minutes, not every minute: 2 accounts, read at 10:00 and again at 10:10.
  assert.equal(calls.length, 4);
});

test("initiative: silent in quiet hours, when switched off, and when the calendar cannot be read", async () => {
  connect({ "me@example.com": [SCOPE.calendarRead] });
  const soon = (time: ReturnType<typeof clock>) => {
    const start = time.at(5), end = time.at(30);
    return { "calendar/v3": () => ({ items: [{ summary: "פגישה", start: { dateTime: start }, end: { dateTime: end } }] }) };
  };

  settings({});
  const night = clock(23, 30);
  fakeNetwork(soon(night));
  assert.deepEqual(await new Initiative(night.now).check(), []);

  settings({ initiative: { enabled: false } });
  const day = clock();
  fakeNetwork(soon(day));
  assert.deepEqual(await new Initiative(day.now).check(), []);

  // His own settings: 5 minutes before, and no quiet hours at all.
  settings({ initiative: { minutesBefore: 5, quietHours: [0, 0] } });
  fakeNetwork(soon(night));
  assert.deepEqual((await new Initiative(night.now).check()).map((nudge) => nudge.text), ["בעוד 5 דקות: פגישה"]);

  settings({});
  fakeNetwork({ "calendar/v3": () => Response.json({ error: { message: "nope" } }, { status: 401 }) });
  assert.deepEqual(await new Initiative(day.now).check(), []);

  assert.deepEqual([isQuiet(23, [22, 7]), isQuiet(3, [22, 7]), isQuiet(7, [22, 7]), isQuiet(12, [22, 7]), isQuiet(13, [12, 14]), isQuiet(5, [0, 0])], [true, true, false, false, true, false]);
  settings({});
});
