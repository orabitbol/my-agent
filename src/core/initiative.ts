// Initiative: the agent turns to the user by itself when there is a reason.
// Two reasons so far: a meeting is about to start, and an important email arrived.
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

export type Nudge = { id: string; text: string };

type CalendarEvent = { account: string; title: string; start: string; allDay: boolean; location: string | null; myResponse: string | null };

type Email = { account: string; id: string; from: string; subject: string };

const DEFAULTS = { enabled: true, minutesBefore: 10, quietHours: [22, 7] as [number, number], mail: true };
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

const place = (location: string | null) => (location && location.length <= 40 && !/https?:\/\//.test(location) ? ` (${location})` : "");

export class Initiative {
  private events: CalendarEvent[] = [];
  private readAt = 0;
  private said = new Set<string>();
  private mailReadAt = 0;
  private knownMail: Set<string> | null = null; // null until the inbox was read once

  constructor(private now: () => Date = () => new Date()) {}

  /** Called about once a minute. Returns what is worth telling the user right now, each thing once. */
  async check(): Promise<Nudge[]> {
    const settings = await initiativeSettings();
    const now = this.now();
    if (!settings.enabled || isQuiet(now.getHours(), settings.quietHours)) return [];

    const nudges: Nudge[] = [];
    if (settings.mail) nudges.push(...(await this.newMail(now)));

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
