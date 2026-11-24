// Initiative: the agent turns to the user by itself when there is a reason.
// Three reasons so far: a meeting is about to start, an important email arrived,
// and the daily report on the investment portfolio.
//
// This costs nothing to run: it reads the calendar and the inbox and uses no
// model. Which email is "important" is Gmail's own judgment, not ours. It only
// decides WHAT is worth saying; the entry decides how to say it (a speech
// bubble next to the character, a system notification).
//
// It works while the app is open. A computer that is asleep or an app that is
// closed cannot remind anyone.

import { loadSettings } from "./settings.js";
import { getCalendarEvents } from "./tools/calendar.js";
import { searchEmails } from "./tools/mail.js";
import { fetchPortfolioToday } from "./tools/portfolio.js";
import type { PortfolioToday } from "./tools/portfolio.js";

export type Nudge = { id: string; text: string };

type CalendarEvent = { account: string; title: string; start: string; allDay: boolean; location: string | null; myResponse: string | null };

type Email = { account: string; id: string; from: string; subject: string };

// The report is said in the morning, Israel time, about the trading day that ended the night before.
const DEFAULTS = { enabled: true, minutesBefore: 10, quietHours: [22, 7] as [number, number], mail: true, portfolioReportAt: "08:30" };
const REPORT_WINDOW_MIN = 90; // if the app opens later than this after the set time, today's report is skipped
// Unread, in the main inbox, and marked important by Gmail itself.
const IMPORTANT_MAIL = "is:unread is:important in:inbox category:primary newer_than:1d";
const REFRESH_MS = 3 * 60_000; // how often the calendar is read again
const LOOK_AHEAD_MS = 45 * 60_000;

export async function initiativeSettings() {
  const { initiative } = await loadSettings();
  return { ...DEFAULTS, ...initiative };
}

// Quiet hours may cross midnight (22 to 7).
export function isQuiet(hour: number, [from, to]: [number, number]): boolean {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

// A room name is worth showing; a long link is not.
// "Dana Levi <dana@example.com>" is said as "Dana Levi".
const senderName = (from: string) => from.replace(/<[^>]*>/g, "").replace(/["']/g, "").trim() || from.replace(/[<>]/g, "").trim();
const short = (value: string, length: number) => (value.length > length ? value.slice(0, length - 1).trimEnd() + "…" : value);

const signed = (percent: number) => `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;

/** The daily report, short enough for a speech bubble: facts only. */
export function portfolioSummary(data: PortfolioToday): string {
  const parts: string[] = [];
  const change = data.portfolio.today?.twrPct;
  parts.push(
    change == null ? "דוח יומי של התיק" : change === 0 ? "דוח יומי: התיק בלי שינוי ביום המסחר האחרון" : `דוח יומי: התיק ${change > 0 ? "עלה" : "ירד"} ${Math.abs(change).toFixed(1)}% ביום המסחר האחרון`,
  );
  // The holdings that moved the most, up or down.
  const movers = data.positions
    .filter((position) => position.kind === "stock" && position.dayChangePct != null && Math.abs(position.dayChangePct) >= 1)
    .sort((a, b) => Math.abs(b.dayChangePct!) - Math.abs(a.dayChangePct!))
    .slice(0, 3);
  if (movers.length > 0) parts.push(`בולטות: ${movers.map((position) => `${position.symbol} ${signed(position.dayChangePct!)}`).join(", ")}`);
  const earnings = data.upcoming.earnings.filter((event) => event.daysAway != null && event.daysAway <= 2).map((event) => event.symbol);
  if (earnings.length > 0) parts.push(`דוח רבעוני בימים הקרובים: ${earnings.slice(0, 3).join(", ")}`);
  const expiring = data.upcoming.optionExpiries.filter((option) => option.daysToExpiry <= 2).map((option) => option.underlying);
  if (expiring.length > 0) parts.push(`אופציות שפוקעות בימים הקרובים: ${[...new Set(expiring)].slice(0, 3).join(", ")}`);
  return parts.join(". ") + ".";
}

const place = (location: string | null) => (location && location.length <= 40 && !/https?:\/\//.test(location) ? ` (${location})` : "");

export class Initiative {
  private events: CalendarEvent[] = [];
  private readAt = 0;
  private said = new Set<string>();
  private mailReadAt = 0;
  private knownMail: Set<string> | null = null; // null until the inbox was read once
  private reportDay = ""; // the day the portfolio report was last said

  constructor(private now: () => Date = () => new Date()) {}

  /** Called about once a minute. Returns what is worth telling the user right now, each thing once. */
  async check(): Promise<Nudge[]> {
    const settings = await initiativeSettings();
    const now = this.now();
    if (!settings.enabled || isQuiet(now.getHours(), settings.quietHours)) return [];

    const nudges: Nudge[] = [];
    if (settings.mail) nudges.push(...(await this.newMail(now)));
    nudges.push(...(await this.portfolioReport(now, settings.portfolioReportAt)));

    if (now.getTime() - this.readAt >= REFRESH_MS) {
      try {
        const result = (await getCalendarEvents.run({ start: now.toISOString(), end: new Date(now.getTime() + LOOK_AHEAD_MS).toISOString() })) as { events: CalendarEvent[] };
        this.events = result.events;
        this.readAt = now.getTime();
      } catch {
        // No account, no network, an expired sign-in: stay silent and try again next time.
        return nudges;
      }
    }

    for (const event of this.events) {
      const minutes = Math.ceil((new Date(event.start).getTime() - now.getTime()) / 60_000);
      if (event.allDay || event.myResponse === "declined" || !(minutes > 0 && minutes <= settings.minutesBefore)) continue;
      // The same meeting can sit in two connected calendars: say it once.
      const id = `${event.start}|${event.title}`;
      if (this.said.has(id)) continue;
      this.said.add(id);
      nudges.push({ id, text: `${minutes === 1 ? "בעוד דקה" : `בעוד ${minutes} דקות`}: ${event.title}${place(event.location)}` });
    }
    return nudges;
  }

  // The daily report on the portfolio: once a day, at the set time, after a trading day.
  private async portfolioReport(now: Date, at: string): Promise<Nudge[]> {
    const time = /^(\d{1,2}):(\d{2})$/.exec(at);
    if (!time || !process.env.POSITIONHERO_AGENT_KEY) return [];
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const late = now.getHours() * 60 + now.getMinutes() - (Number(time[1]) * 60 + Number(time[2]));
    // Sunday and Monday mornings follow days with no trading in New York.
    if (this.reportDay === day || late < 0 || late > REPORT_WINDOW_MIN || now.getDay() === 0 || now.getDay() === 1) return [];
    this.reportDay = day; // one try a day: a failure is not retried every minute
    try {
      return [{ id: `portfolio|${day}`, text: portfolioSummary(await fetchPortfolioToday()) }];
    } catch {
      return []; // the site is down or not set up: stay silent
    }
  }

  // Important emails that arrived since the last look. What was already waiting
  // when the app opened is not announced: only what arrives from then on.
  private async newMail(now: Date): Promise<Nudge[]> {
    if (now.getTime() - this.mailReadAt < REFRESH_MS) return [];
    let emails: Email[];
    try {
      emails = ((await searchEmails.run({ query: IMPORTANT_MAIL, limit: 10 })) as { emails: Email[] }).emails;
      this.mailReadAt = now.getTime();
    } catch {
      return []; // no mail permission, no network: stay silent
    }
    const first = this.knownMail === null;
    const known = (this.knownMail ??= new Set());
    const fresh = emails.filter((email) => !known.has(`${email.account}|${email.id}`));
    for (const email of fresh) known.add(`${email.account}|${email.id}`);
    if (first || fresh.length === 0) return [];
    // Several at once (after quiet hours, after a long meeting) are one sentence, not a flood.
    if (fresh.length > 2) return [{ id: `mail|${fresh.map((email) => email.id).join(",")}`, text: `הגיעו ${fresh.length} מיילים חשובים חדשים` }];
    return fresh.map((email) => ({ id: `mail|${email.id}`, text: `מייל חשוב מ-${short(senderName(email.from), 30)}: ${short(email.subject, 70)}` }));
  }
}

/** Starts checking once a minute. Returns a function that stops it. */
export function startInitiative(notify: (nudge: Nudge) => void, everyMs = 60_000): () => void {
  const initiative = new Initiative();
  const timer = setInterval(() => {
    void initiative.check().then((nudges) => nudges.forEach(notify)).catch(() => {});
  }, everyMs);
  return () => clearInterval(timer);
}
