// Tool: find a meeting room that is free at a given time.
//
// A meeting room in Google Calendar is a calendar with its own address.
// Booking a room means inviting that address to the event.

import type { Tool } from "./types.js";
import { SCOPE } from "../google/auth.js";
import { googleFetch, hasScope, resolveAccount } from "../google/api.js";

type Room = { email: string; name: string; capacity: number | null };

// The organization's official room list. It includes how many people fit.
// Some organizations do not let regular users read it; then we fall back.
async function roomsFromDirectory(account: string): Promise<Room[]> {
  const body = await googleFetch<{
    items?: { resourceEmail?: string; resourceName?: string; generatedResourceName?: string; capacity?: number; resourceCategory?: string }[];
  }>(account, [SCOPE.rooms], "https://admin.googleapis.com/admin/directory/v1/customer/my_customer/resources/calendars?maxResults=500");

  return (body.items ?? [])
    .filter((item) => item.resourceEmail && (item.resourceCategory ?? "CONFERENCE_ROOM") === "CONFERENCE_ROOM")
    .map((item) => ({
      email: String(item.resourceEmail).toLowerCase(),
      name: item.generatedResourceName ?? item.resourceName ?? String(item.resourceEmail),
      capacity: typeof item.capacity === "number" && item.capacity > 0 ? item.capacity : null,
    }));
}

// Fallback: the rooms that appear in the user's own meetings (4 months back, 2 ahead).
// The size is not known this way, unless the room's name says it, like "Vision (6)".
async function roomsFromMyEvents(account: string): Promise<Room[]> {
  const day = 24 * 60 * 60 * 1000;
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.search = new URLSearchParams({
    timeMin: new Date(Date.now() - 120 * day).toISOString(),
    timeMax: new Date(Date.now() + 60 * day).toISOString(),
    singleEvents: "true",
    maxResults: "500",
    fields: "items(attendees(email,displayName,resource))",
  }).toString();
  const body = await googleFetch<{ items?: { attendees?: { email?: string; displayName?: string; resource?: boolean }[] }[] }>(
    account, [SCOPE.calendarRead, SCOPE.calendarEvents], url,
  );

  const rooms = new Map<string, Room>();
  for (const attendee of (body.items ?? []).flatMap((event) => event.attendees ?? [])) {
    if (!attendee.resource || !attendee.email) continue;
    const name = attendee.displayName ?? attendee.email;
    const size = /\((\d{1,3})\)/.exec(name)?.[1];
    rooms.set(attendee.email.toLowerCase(), { email: attendee.email.toLowerCase(), name, capacity: size ? Number(size) : null });
  }
  return [...rooms.values()];
}

/** Every room the account knows about, from the best source available. */
export async function listRooms(account: string): Promise<{ rooms: Room[]; source: "organization" | "my meetings" }> {
  if (await hasScope(account, SCOPE.rooms)) {
    try {
      const rooms = await roomsFromDirectory(account);
      if (rooms.length > 0) return { rooms, source: "organization" };
    } catch {
      // not allowed, or the API is off: use the fallback
    }
  }
  return { rooms: await roomsFromMyEvents(account), source: "my meetings" };
}

export const findFreeRooms: Tool = {
  name: "find_free_rooms",
  description:
    "Finds meeting rooms that are free for a whole time range, big enough for the given number of people, " +
    "smallest suitable room first. To book one, pass its email as room_email to create_calendar_event. " +
    "A room whose size is unknown has capacity null: tell the user the size is not known.",
  parameters: {
    type: "object",
    properties: {
      start: { type: "string", description: "Start, ISO 8601 with offset." },
      end: { type: "string", description: "End, ISO 8601 with offset." },
      people: { type: "integer", description: "How many people will be in the room, including the user." },
      account: { type: ["string", "null"], description: "The account whose organization has the rooms. Null for the default." },
    },
    required: ["start", "end", "people", "account"],
    additionalProperties: false,
  },
  prepare: async (args) => ({ ...args, account: await resolveAccount(args.account) }),
  run: async (args) => {
    const start = new Date(String(args.start));
    const end = new Date(String(args.end));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new Error("start and end must be valid ISO 8601 times, with end after start.");
    }
    const people = Math.max(1, Number(args.people) || 1);
    const account = await resolveAccount(args.account);

    const { rooms, source } = await listRooms(account);
    if (rooms.length === 0) {
      return { account, freeRooms: [], note: "No meeting rooms are known for this account." };
    }
    const bigEnough = rooms.filter((room) => room.capacity === null || room.capacity >= people);

    // Ask Google which of these rooms are busy in the range. Up to 50 per request.
    const busy = new Set<string>();
    for (let i = 0; i < bigEnough.length; i += 50) {
      const batch = bigEnough.slice(i, i + 50);
      const body = await googleFetch<{ calendars?: Record<string, { busy?: unknown[]; errors?: unknown[] }> }>(
        account, [SCOPE.calendarFreeBusy, SCOPE.calendarRead], "https://www.googleapis.com/calendar/v3/freeBusy",
        { method: "POST", body: { timeMin: start.toISOString(), timeMax: end.toISOString(), items: batch.map((room) => ({ id: room.email })) } },
      );
      for (const room of batch) {
        const state = body.calendars?.[room.email];
        // Unknown counts as busy: never offer a room we could not check.
        if (!state || (state.errors?.length ?? 0) > 0 || (state.busy?.length ?? 0) > 0) busy.add(room.email);
      }
    }

    const freeRooms = bigEnough
      .filter((room) => !busy.has(room.email))
      .sort((a, b) => (a.capacity ?? 999) - (b.capacity ?? 999) || a.name.localeCompare(b.name));
    return { account, people, roomListFrom: source, freeRooms };
  },
};
