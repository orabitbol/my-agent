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
  assert.equal(calls.filter((call) => call.url.includes("calendar/v3")).length, 4);
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

test("initiative: an important email is announced when it arrives, not when it was already waiting", async () => {
  settings({});
  connect({ "work@example.com": [SCOPE.mailRead] });
  const time = clock();
  let inbox = ["old"];
  const mail: Record<string, { from: string; subject: string }> = {
    old: { from: "Old <old@example.com>", subject: "ישן" },
    m1: { from: '"דנה לוי" <dana@example.com>', subject: "חוזה לחתימה" },
    m2: { from: "noreply@example.com", subject: "x".repeat(200) },
    m3: { from: "A <a@example.com>", subject: "3" },
    m4: { from: "B <b@example.com>", subject: "4" },
  };
  const calls = fakeNetwork({
    "/messages?": () => ({ messages: inbox.map((id) => ({ id })) }),
    "/messages/": (call) => {
      const id = call.url.split("/messages/")[1]!.split("?")[0]!;
      return { id, labelIds: ["UNREAD"], payload: { headers: [{ name: "From", value: mail[id]!.from }, { name: "Subject", value: mail[id]!.subject }] } };
    },
  });
  const initiative = new Initiative(time.now);

  // What was already in the inbox when the app opened is not news.
  assert.deepEqual(await initiative.check(), []);
  assert.match(decodeURIComponent(calls[0]!.url.replace(/\+/g, " ")), /is:unread is:important in:inbox/);

  // A minute later nothing is read again; after three minutes the new email is found.
  inbox = ["m1", "old"];
  time.forward(1);
  assert.deepEqual(await initiative.check(), []);
  time.forward(2);
  assert.deepEqual((await initiative.check()).map((nudge) => nudge.text), ["מייל חשוב מ-דנה לוי: חוזה לחתימה"]);

  // Said once. A long subject is cut. A sender with no name is shown by address.
  inbox = ["m2", "m1", "old"];
  time.forward(3);
  const [long] = await initiative.check();
  assert.match(long!.text, /^מייל חשוב מ-noreply@example\.com: x{69}…$/);

  // Three at once become one sentence.
  inbox = ["m4", "m3", "new", "m2", "m1", "old"];
  mail.new = { from: "C <c@example.com>", subject: "5" };
  time.forward(3);
  assert.deepEqual((await initiative.check()).map((nudge) => nudge.text), ["הגיעו 3 מיילים חשובים חדשים"]);

  // Switched off in the settings: the inbox is not even read.
  settings({ initiative: { mail: false } });
  const before = calls.length;
  time.forward(3);
  assert.deepEqual(await new Initiative(time.now).check(), []);
  assert.equal(calls.length, before);
  settings({});
});

const { portfolioSummary } = await import("../src/core/initiative.js");
const { getPortfolioToday } = await import("../src/core/tools/portfolio.js");

const portfolio = {
  asOf: { dataDate: "2026-11-23", usMarketOpen: false, valuationIsLive: false },
  portfolio: { valueUsd: 50000, today: { twrPct: 0.84, gainUsd: 420 } },
  positions: [
    { symbol: "NVDA", kind: "stock", valueUsd: 9000, dayChangePct: 3.12 },
    { symbol: "TSLA", kind: "stock", valueUsd: 4000, dayChangePct: -2.4 },
    { symbol: "AAPL", kind: "stock", valueUsd: 8000, dayChangePct: 0.3 },
    { symbol: "SPY 261218C00600000", kind: "option", valueUsd: 700, dayChangePct: 40 },
  ],
  upcoming: {
    earnings: [{ symbol: "AAPL", date: "2026-11-25", daysAway: 1 }, { symbol: "MSFT", date: "2026-12-04", daysAway: 10 }],
    optionExpiries: [{ symbol: "SPY 261127C00600000", underlying: "SPY", expiry: "2026-11-27", daysToExpiry: 2 }],
  },
  news: { holdings: [], market: [] },
};

test("portfolio: read from the user's own site with the secret key, and never without it", async () => {
  delete process.env.POSITIONHERO_AGENT_KEY;
  await assert.rejects(getPortfolioToday.run({}), /POSITIONHERO_AGENT_KEY is missing/);

  process.env.POSITIONHERO_AGENT_KEY = "k".repeat(64);
  const calls = fakeNetwork({ "positionhero.com/api/agent/daily": () => portfolio });
  assert.deepEqual(await getPortfolioToday.run({}), portfolio);
  assert.equal(calls[0]!.url, "https://www.positionhero.com/api/agent/daily");
  assert.equal(calls[0]!.headers.Authorization, "Bearer " + "k".repeat(64));

  // Each way the site can say no becomes a sentence the agent can explain.
  for (const [status, message] of [[401, /refused the key/], [503, /not set up for the agent/], [404, /has to be deployed/], [500, /error \(500\)/]] as const) {
    fakeNetwork({ "positionhero.com": () => new Response("{}", { status }) });
    await assert.rejects(getPortfolioToday.run({}), message);
  }
  // The tool only reads, and it never asks for approval because nothing changes.
  assert.equal(getPortfolioToday.needsApproval, undefined);
  assert.match(getPortfolioToday.description, /never tell him to buy, sell or hold/);
  delete process.env.POSITIONHERO_AGENT_KEY;
});

test("portfolio report: said once in the morning after a trading day, as short facts", async () => {
  assert.equal(
    portfolioSummary(portfolio as never),
    "דוח יומי: התיק עלה 0.8% ביום המסחר האחרון. בולטות: NVDA +3.1%, TSLA -2.4%. דוח רבעוני בימים הקרובים: AAPL. אופציות שפוקעות בימים הקרובים: SPY.",
  );
  assert.equal(portfolioSummary({ ...portfolio, portfolio: { valueUsd: 1, today: { twrPct: -1.26, gainUsd: -5 } }, positions: [], upcoming: { earnings: [], optionExpiries: [] } } as never), "דוח יומי: התיק ירד 1.3% ביום המסחר האחרון.");
  assert.equal(portfolioSummary({ ...portfolio, portfolio: { valueUsd: 1, today: null }, positions: [], upcoming: { earnings: [], optionExpiries: [] } } as never), "דוח יומי של התיק.");

  settings({ initiative: { mail: false } });
  connect({});
  process.env.POSITIONHERO_AGENT_KEY = "k".repeat(64);
  const calls = fakeNetwork({ "positionhero.com": () => portfolio });
  const texts = async (initiative: InstanceType<typeof Initiative>) => (await initiative.check()).map((nudge) => nudge.text);

  // 24.11.2026 is a Tuesday. Before 08:30 nothing; at 08:30 the report; later the same day not again.
  const time = clock(8, 20);
  const initiative = new Initiative(time.now);
  assert.deepEqual(await texts(initiative), []);
  time.forward(10);
  assert.match((await texts(initiative))[0]!, /^דוח יומי: התיק עלה 0\.8%/);
  time.forward(5);
  assert.deepEqual(await texts(initiative), []);
  assert.equal(calls.length, 1);

  // Opened long after the set time: today's report is skipped, not said at noon.
  assert.deepEqual(await texts(new Initiative(clock(12, 0).now)), []);
  // His own hour.
  settings({ initiative: { mail: false, portfolioReportAt: "12:00" } });
  assert.equal((await texts(new Initiative(clock(12, 0).now))).length, 1);
  // Switched off, and the mornings after a weekend in New York.
  settings({ initiative: { mail: false, portfolioReportAt: "" } });
  assert.deepEqual(await texts(new Initiative(clock(8, 30).now)), []);
  settings({ initiative: { mail: false } });
  const monday = new Date(2026, 10, 23, 8, 30);
  assert.deepEqual(await texts(new Initiative(() => monday)), []);
  // The site is down: silence, and no retry every minute.
  const failing = fakeNetwork({ "positionhero.com": () => new Response("{}", { status: 500 }) });
  const down = clock(8, 30);
  const quiet = new Initiative(down.now);
  assert.deepEqual(await texts(quiet), []);
  down.forward(1);
  assert.deepEqual(await texts(quiet), []);
  assert.equal(failing.length, 1);

  delete process.env.POSITIONHERO_AGENT_KEY;
  settings({});
});
