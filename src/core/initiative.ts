// Initiative: the agent turns to the user by itself when there is a reason.
// The first reason: a meeting is about to start.
//
// This costs nothing to run: it reads the calendar and uses no model. It only
// decides WHAT is worth saying; the entry decides how to say it (a speech
// bubble next to the character, a system notification).
//
// It works while the app is open. A computer that is asleep or an app that is
// closed cannot remind anyone.

import { loadSettings } from "./settings.js";
import { getCalendarEvents } from "./tools/calendar.js";

export type Nudge = { id: string; text: string };

type CalendarEvent = { account: string; title: string; start: string; allDay: boolean; location: string | null; myResponse: string | null };

const DEFAULTS = { enabled: true, minutesBefore: 10, quietHours: [22, 7] as [number, number] };
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
const place = (location: string | null) => (location && location.length <= 40 && !/https?:\/\//.test(location) ? ` (${location})` : "");

export class Initiative {
  private events: CalendarEvent[] = [];
  private readAt = 0;
  private said = new Set<string>();

  constructor(private now: () => Date = () => new Date()) {}

  /** Called about once a minute. Returns what is worth telling the user right now, each thing once. */
  async check(): Promise<Nudge[]> {
    const settings = await initiativeSettings();
    const now = this.now();
    if (!settings.enabled || isQuiet(now.getHours(), settings.quietHours)) return [];

    if (now.getTime() - this.readAt >= REFRESH_MS) {
      try {
        const result = (await getCalendarEvents.run({ start: now.toISOString(), end: new Date(now.getTime() + LOOK_AHEAD_MS).toISOString() })) as { events: CalendarEvent[] };
        this.events = result.events;
        this.readAt = now.getTime();
      } catch {
        // No account, no network, an expired sign-in: stay silent and try again next time.
        return [];
      }
    }

    const nudges: Nudge[] = [];
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
}

/** Starts checking once a minute. Returns a function that stops it. */
export function startInitiative(notify: (nudge: Nudge) => void, everyMs = 60_000): () => void {
  const initiative = new Initiative();
  const timer = setInterval(() => {
    void initiative.check().then((nudges) => nudges.forEach(notify)).catch(() => {});
  }, everyMs);
  return () => clearInterval(timer);
}
