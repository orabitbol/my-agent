import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, fakeNetwork } from "./helpers.js";

const { SCOPE } = await import("../src/core/google/auth.js");
const calendar = await import("../src/core/tools/calendar.js");
const mail = await import("../src/core/tools/mail.js");
const { tools } = await import("../src/core/tools/index.js");

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const allScopes = [
  SCOPE.calendarEvents, SCOPE.calendarFreeBusy, SCOPE.directory, SCOPE.contacts, SCOPE.otherContacts, SCOPE.rooms,
  SCOPE.mailRead, SCOPE.mailCompose,
];
const people = await import("../src/core/tools/people.js");
const rooms = await import("../src/core/tools/rooms.js");

test("every tool has a valid strict schema, and sensitive tools explain themselves", () => {
  for (const tool of tools) {
    const schema = tool.parameters as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    assert.equal(schema.additionalProperties, false, tool.name);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${tool.name}: every property must be required`);
    if (tool.needsApproval) assert.ok(tool.describe, `${tool.name} needs a describe()`);
  }
  assert.deepEqual(tools.filter((t) => t.needsApproval).map((t) => t.name), ["create_calendar_event"]);
  assert.ok(!tools.some((t) => /send|delete/.test(t.name)), "no tool sends or deletes");
});

test("calendar: merges and sorts events from all accounts, drops cancelled ones", async () => {
  connect({ "me@example.com": [SCOPE.calendarRead], "work@example.com": [SCOPE.calendarEvents] });
  const calls = fakeNetwork({
    "calendar/v3": (call) =>
      call.headers.Authorization === "Bearer access-me@example.com"
        ? { items: [{ summary: "ערב", start: { dateTime: "2026-11-24T20:00:00+02:00" }, end: { dateTime: "2026-11-24T21:00:00+02:00" } }] }
        : { items: [
            { summary: "Standup", start: { dateTime: "2026-11-24T09:00:00+02:00" }, end: { dateTime: "2026-11-24T09:15:00+02:00" }, attendees: [{ self: true, responseStatus: "accepted" }] },
            { summary: "gone", status: "cancelled", start: { date: "2026-11-24" }, end: { date: "2026-11-25" } },
          ] },
  });

  const result = (await calendar.getCalendarEvents.run({ start: "2026-11-24T00:00:00+02:00", end: "2026-11-25T00:00:00+02:00" })) as {
    events: { title: string; account: string; myResponse: string | null }[];
  };
  assert.deepEqual(result.events.map((e) => e.title), ["Standup", "ערב"]);
  assert.equal(result.events[0]?.account, "work@example.com");
  assert.equal(result.events[0]?.myResponse, "accepted");
  assert.equal(new URL(calls[0]?.url ?? "").searchParams.get("timeMin"), "2026-11-23T22:00:00.000Z");
});

test("calendar: one failing account is reported, all failing is an error (never 'a free day')", async () => {
  connect({ "me@example.com": [SCOPE.calendarRead], "work@example.com": [SCOPE.calendarRead] });
  const range = { start: "2026-11-24T00:00:00+02:00", end: "2026-11-25T00:00:00+02:00" };

  fakeNetwork({
    "calendar/v3": (call) =>
      call.headers.Authorization?.includes("work") ? Response.json({ error: { message: "nope" } }, { status: 401 }) : { items: [] },
  });
  const partial = (await calendar.getCalendarEvents.run(range)) as { failed: { account: string }[] };
  assert.deepEqual(partial.failed.map((f) => f.account), ["work@example.com"]);

  fakeNetwork({ "calendar/v3": () => Response.json({ error: { message: "nope" } }, { status: 401 }) });
  await assert.rejects(calendar.getCalendarEvents.run(range), /Could not read the calendar/);
  await assert.rejects(calendar.getCalendarEvents.run({ start: "tomorrow", end: "later" }), /ISO 8601/);
});

test("create event: sends the right event, to the right account, with a Hebrew summary for approval", async () => {
  connect({ "me@example.com": allScopes });
  const calls = fakeNetwork({ "calendar/v3": () => ({ htmlLink: "https://calendar.google.com/e/1" }) });
  const args = { title: "רופא שיניים", start: "2026-11-26T10:00:00+02:00", end: "2026-11-26T11:00:00+02:00", location: "תל אביב", notes: null, attendees: [], room_email: null, account: null };

  const prepared = (await calendar.createCalendarEvent.prepare?.(args)) ?? args;
  const summary = calendar.createCalendarEvent.describe?.(prepared) ?? "";
  assert.match(summary, /רופא שיניים/);
  assert.match(summary, /תל אביב/);
  assert.match(summary, /me@example\.com/, "the approval always names the account");

  const result = (await calendar.createCalendarEvent.run(prepared)) as { created: boolean; account: string };
  assert.equal(result.created, true);
  assert.equal(result.account, "me@example.com");
  assert.equal(calls[0]?.method, "POST");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    summary: "רופא שיניים",
    start: { dateTime: "2026-11-26T08:00:00.000Z" },
    end: { dateTime: "2026-11-26T09:00:00.000Z" },
    location: "תל אביב",
  });
});

test("create event: refused with read-only permission, and when the end is before the start", async () => {
  connect({ "me@example.com": [SCOPE.calendarRead] });
  const calls = fakeNetwork({});
  const args = { title: "x", start: "2026-11-26T10:00:00+02:00", end: "2026-11-26T11:00:00+02:00", location: null, notes: null, attendees: [], room_email: null, account: null };
  await assert.rejects(calendar.createCalendarEvent.run(args), /permission/);
  await assert.rejects(calendar.createCalendarEvent.run({ ...args, end: args.start }), /after start/);
  assert.equal(calls.length, 0);
});

test("mail search: returns sender, subject, date and preview", async () => {
  connect({ "me@example.com": allScopes });
  const calls = fakeNetwork({
    "/messages?": () => ({ messages: [{ id: "m1" }] }),
    "/messages/m1": () => ({
      id: "m1", snippet: "שלום, מצורפת החשבונית", labelIds: ["UNREAD", "INBOX"],
      payload: { headers: [{ name: "From", value: "Dana <dana@example.com>" }, { name: "Subject", value: "חשבונית" }, { name: "Date", value: "Mon, 23 Nov 2026 09:00:00 +0200" }] },
    }),
  });
  const result = (await mail.searchEmails.run({ query: "is:unread", limit: 99 })) as { emails: Record<string, unknown>[] };
  assert.deepEqual(result.emails, [{
    account: "me@example.com", id: "m1", from: "Dana <dana@example.com>", subject: "חשבונית",
    date: "Mon, 23 Nov 2026 09:00:00 +0200", unread: true, preview: "שלום, מצורפת החשבונית",
  }]);
  assert.equal(new URL(calls[0]?.url ?? "").searchParams.get("maxResults"), "20", "limit is capped");
});

test("mail read: prefers plain text, falls back to HTML without tags, cuts very long mail", async () => {
  connect({ "me@example.com": allScopes });
  const headers = [{ name: "Subject", value: "s" }];
  fakeNetwork({
    "/messages/plain": () => ({ id: "plain", payload: { headers, mimeType: "multipart/alternative", parts: [
      { mimeType: "text/html", body: { data: b64("<p>html</p>") } },
      { mimeType: "text/plain", body: { data: b64("טקסט רגיל") } } ] } }),
    "/messages/html": () => ({ id: "html", payload: { headers, mimeType: "text/html", body: { data: b64("<style>p{}</style><p>Hello&nbsp;<b>there</b></p>") } } }),
    "/messages/long": () => ({ id: "long", payload: { headers, mimeType: "text/plain", body: { data: b64("x".repeat(7000)) } } }),
  });
  const read = async (id: string) => (await mail.readEmail.run({ account: "me@example.com", id })) as { body: string; truncated: boolean };
  assert.equal((await read("plain")).body, "טקסט רגיל");
  assert.equal((await read("html")).body, "Hello there");
  const long = await read("long");
  assert.equal(long.body.length, 6000);
  assert.equal(long.truncated, true);
  await assert.rejects(mail.readEmail.run({ account: "me@example.com", id: "../drafts" }), /not a valid/);
});

test("draft: is saved (never sent), with Hebrew subject and body encoded correctly", async () => {
  connect({ "me@example.com": allScopes });
  const calls = fakeNetwork({ "/drafts": () => ({ id: "d1" }) });
  const result = (await mail.createEmailDraft.run({ to: "dana@example.com", subject: "פגישה מחר", body: "היי דנה,\nנפגש ב-10?", account: null })) as { sent: boolean; saved: boolean };
  assert.deepEqual([result.saved, result.sent], [true, false]);
  assert.ok(calls.every((call) => !call.url.includes("/send")), "nothing was sent");

  const raw = Buffer.from(JSON.parse(calls[0]?.body ?? "{}").message.raw, "base64url").toString("utf8");
  const [head, body] = raw.split("\r\n\r\n");
  assert.match(head ?? "", /^To: dana@example\.com\r\n/);
  const subject = /Subject: =\?UTF-8\?B\?(.+)\?=/.exec(head ?? "")?.[1] ?? "";
  assert.equal(Buffer.from(subject, "base64").toString("utf8"), "פגישה מחר");
  assert.equal(Buffer.from((body ?? "").replace(/\r\n/g, ""), "base64").toString("utf8"), "היי דנה,\nנפגש ב-10?");
});

test("draft: rejects anything that is not one plain address, so headers cannot be injected", async () => {
  connect({ "me@example.com": allScopes });
  const calls = fakeNetwork({ "/drafts": () => ({ id: "d1" }) });
  for (const to of ["dana@example.com\r\nBcc: evil@example.com", "a@b.com, c@d.com", "Dana <dana@example.com>", "not-an-address"]) {
    await assert.rejects(mail.createEmailDraft.run({ to, subject: "s", body: "b", account: null }), /single email address/);
  }
  await mail.createEmailDraft.run({ to: "dana@example.com", subject: "line one\r\nBcc: evil@example.com", body: "b", account: null });
  const raw = Buffer.from(JSON.parse(calls[0]?.body ?? "{}").message.raw, "base64url").toString("utf8");
  assert.ok(!/\r\nBcc:/.test(raw), "a line break in the subject cannot add a header");
});

test("several accounts: the event goes to the named account, else the default, else we ask", async () => {
  const { setDefaultAccount } = await import("../src/core/google/auth.js");
  const { saveSettings } = await import("../src/core/settings.js");
  const { buildInstructions } = await import("../src/core/prompt.js");
  connect({ "me@example.com": allScopes, "work@example.com": allScopes });
  await saveSettings({});
  const calls = fakeNetwork({ "calendar/v3": () => ({}) });
  const event = { title: "פגישה", start: "2026-11-26T10:00:00+02:00", end: "2026-11-26T11:00:00+02:00", location: null, notes: null, attendees: [], room_email: null };
  const create = async (account: string | null) => {
    const prepared = (await calendar.createCalendarEvent.prepare?.({ ...event, account })) ?? {};
    const approvalText = calendar.createCalendarEvent.describe?.(prepared) ?? "";
    const result = (await calendar.createCalendarEvent.run(prepared)) as { account: string };
    return { approvalText, account: result.account, token: calls.at(-1)?.headers.Authorization };
  };

  // No default yet, no account named: nothing is created.
  await assert.rejects(create(null), /no default is set/);
  assert.equal(calls.length, 0);

  await setDefaultAccount("work@example.com");
  assert.match(await buildInstructions(), /work@example\.com \(default for new events and drafts\)/);

  const byDefault = await create(null);
  assert.equal(byDefault.account, "work@example.com");
  assert.equal(byDefault.token, "Bearer access-work@example.com", "sent with the work account's own token");
  assert.match(byDefault.approvalText, /work@example\.com/);

  const named = await create("me@example.com");
  assert.equal(named.account, "me@example.com");
  assert.equal(named.token, "Bearer access-me@example.com");
  assert.match(named.approvalText, /me@example\.com/);
  assert.doesNotMatch(named.approvalText, /work@example\.com/);

  await assert.rejects(create("someone@else.com"), /not connected/);
});

test("drafts follow the same account rule", async () => {
  connect({ "me@example.com": allScopes, "work@example.com": allScopes });
  const calls = fakeNetwork({ "/drafts": () => ({ id: "d" }) });
  const draft = { to: "dana@example.com", subject: "s", body: "b" };
  const prepared = (await mail.createEmailDraft.prepare?.({ ...draft, account: null })) ?? {};
  assert.equal(((await mail.createEmailDraft.run(prepared)) as { account: string }).account, "work@example.com");
  assert.equal(calls.at(-1)?.headers.Authorization, "Bearer access-work@example.com");
});

test("find people: searches directory, contacts and mail history, one entry per address", async () => {
  connect({ "work@example.com": allScopes });
  const calls = fakeNetwork({
    "searchDirectoryPeople": () => ({ people: [
      { names: [{ displayName: "Tal Gur" }], emailAddresses: [{ value: "TalGu@example.com" }] },
      { names: [{ displayName: "Tal Levi" }], emailAddresses: [{ value: "tall@example.com" }] } ] }),
    "people:searchContacts": () => ({ results: [{ person: { names: [{ displayName: "Tal (mobile)" }], emailAddresses: [{ value: "talgu@example.com" }] } }] }),
    "otherContacts:search": () => ({ results: [{ person: { emailAddresses: [{ value: "tal@outside.com" }] } }] }),
  });
  const result = (await people.findPeople.run({ query: "טל" })) as { matches: Record<string, string>[] };
  assert.deepEqual(result.matches, [
    { name: "Tal Gur", email: "talgu@example.com", account: "work@example.com", source: "directory" },
    { name: "Tal Levi", email: "tall@example.com", account: "work@example.com", source: "directory" },
    { name: "tal@outside.com", email: "tal@outside.com", account: "work@example.com", source: "mail history" },
  ]);
  assert.equal(new URL(calls[0]?.url ?? "").searchParams.get("query"), "טל", "Hebrew is sent correctly");
});

test("find people: a source that fails does not hide the others; no match is an empty list, not an error", async () => {
  connect({ "me@example.com": allScopes });
  fakeNetwork({
    "searchDirectoryPeople": () => Response.json({ error: { message: "Must be a G Suite domain user" } }, { status: 403 }),
    "people:searchContacts": () => ({ results: [{ person: { names: [{ displayName: "Dana" }], emailAddresses: [{ value: "dana@example.com" }] } }] }),
    "otherContacts:search": () => ({}),
  });
  const found = (await people.findPeople.run({ query: "dana" })) as { matches: { email: string }[] };
  assert.deepEqual(found.matches.map((m) => m.email), ["dana@example.com"]);

  fakeNetwork({ "people.googleapis.com": () => ({}) });
  assert.deepEqual(((await people.findPeople.run({ query: "nobody" })) as { matches: unknown[] }).matches, []);

  connect({ "me@example.com": [SCOPE.calendarEvents] });
  await assert.rejects(people.findPeople.run({ query: "dana" }), /permission to look people up/);
});

const directoryRooms = { items: [
  { resourceEmail: "big@resource.calendar.google.com", generatedResourceName: "TLV-1-Board (12)", capacity: 12, resourceCategory: "CONFERENCE_ROOM" },
  { resourceEmail: "vision@resource.calendar.google.com", generatedResourceName: "TLV-1-Vision (4)", capacity: 4, resourceCategory: "CONFERENCE_ROOM" },
  { resourceEmail: "phone@resource.calendar.google.com", generatedResourceName: "Phone booth (1)", capacity: 1, resourceCategory: "CONFERENCE_ROOM" },
  { resourceEmail: "focus@resource.calendar.google.com", generatedResourceName: "TLV-1-Focus (6)", capacity: 6, resourceCategory: "CONFERENCE_ROOM" },
  { resourceEmail: "car@resource.calendar.google.com", generatedResourceName: "Company car", resourceCategory: "OTHER" } ] };
const range = { start: "2026-11-24T09:00:00+02:00", end: "2026-11-24T10:00:00+02:00" };

test("rooms: only free rooms that fit, smallest first; a room we could not check is never offered", async () => {
  connect({ "work@example.com": allScopes });
  const calls = fakeNetwork({
    "resources/calendars": () => directoryRooms,
    "/freeBusy": () => ({ calendars: {
      "vision@resource.calendar.google.com": { busy: [{ start: "x", end: "y" }] },
      "focus@resource.calendar.google.com": { busy: [] },
      // "big" is missing from the answer: unknown, so treated as busy
    } }),
  });
  const result = (await rooms.findFreeRooms.run({ ...range, people: 4, account: null })) as { freeRooms: { name: string }[]; roomListFrom: string };
  assert.deepEqual(result.freeRooms.map((r) => r.name), ["TLV-1-Focus (6)"]);
  assert.equal(result.roomListFrom, "organization");
  const asked = JSON.parse(calls.at(-1)?.body ?? "{}").items.map((i: { id: string }) => i.id);
  assert.deepEqual(asked.sort(), ["big@resource.calendar.google.com", "focus@resource.calendar.google.com", "vision@resource.calendar.google.com"], "too-small rooms and non-rooms are not even checked");
});

test("rooms: when the organization's list is closed, rooms are learned from my own meetings", async () => {
  connect({ "work@example.com": allScopes });
  fakeNetwork({
    "resources/calendars": () => Response.json({ error: { message: "Not Authorized" } }, { status: 403 }),
    "calendars/primary/events": () => ({ items: [
      { attendees: [{ email: "dana@example.com" }, { email: "Vision@resource.calendar.google.com", displayName: "accessiBe TLV-1-Vision (4)", resource: true }] },
      { attendees: [{ email: "lab@resource.calendar.google.com", displayName: "Lab", resource: true }] } ] }),
    "/freeBusy": () => ({ calendars: { "vision@resource.calendar.google.com": { busy: [] }, "lab@resource.calendar.google.com": { busy: [] } } }),
  });
  const result = (await rooms.findFreeRooms.run({ ...range, people: 3, account: null })) as { freeRooms: Record<string, unknown>[]; roomListFrom: string };
  assert.equal(result.roomListFrom, "my meetings");
  assert.deepEqual(result.freeRooms, [
    { email: "vision@resource.calendar.google.com", name: "accessiBe TLV-1-Vision (4)", capacity: 4 },
    { email: "lab@resource.calendar.google.com", name: "Lab", capacity: null },
  ]);
});

test("create event with people and a room: invitations are sent, and the approval says so first", async () => {
  connect({ "work@example.com": allScopes });
  const calls = fakeNetwork({ "resources/calendars": () => directoryRooms, "calendars/primary/events": () => ({ htmlLink: "l" }) });
  const args = {
    title: "פגישה עם טל", ...range, location: null, notes: "נושא: figma", account: null,
    attendees: ["TalGu@example.com", "talgu@example.com", "work@example.com"],
    room_email: "Vision@resource.calendar.google.com",
  };
  const prepared = (await calendar.createCalendarEvent.prepare?.(args)) ?? {};
  const approval = calendar.createCalendarEvent.describe?.(prepared) ?? "";
  assert.match(approval, /לשלוח זימון במייל אל: talgu@example\.com\n/, "duplicates and my own address are dropped");
  assert.match(approval, /לשריין את החדר: TLV-1-Vision \(4\)/);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "nothing is created before approval");

  const result = (await calendar.createCalendarEvent.run(prepared)) as { invited: string[]; room: string };
  const post = calls.find((c) => c.method === "POST");
  assert.equal(new URL(post?.url ?? "").searchParams.get("sendUpdates"), "all");
  assert.deepEqual(JSON.parse(post?.body ?? "{}").attendees, [
    { email: "talgu@example.com" },
    { email: "vision@resource.calendar.google.com", resource: true },
  ]);
  assert.deepEqual([result.invited, result.room], [["talgu@example.com"], "TLV-1-Vision (4)"]);
});

test("create event: a name instead of an address, or a room that is not a real room, is refused", async () => {
  connect({ "work@example.com": allScopes });
  const calls = fakeNetwork({ "resources/calendars": () => directoryRooms });
  const base = { title: "x", ...range, location: null, notes: null, account: null, attendees: [], room_email: null };
  await assert.rejects(calendar.createCalendarEvent.prepare?.({ ...base, attendees: ["Tal"] }) ?? Promise.resolve(), /not an email address/);
  await assert.rejects(calendar.createCalendarEvent.prepare?.({ ...base, room_email: "ceo@example.com" }) ?? Promise.resolve(), /not a known meeting room/);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("an event with nobody invited sends no invitations", async () => {
  connect({ "work@example.com": allScopes });
  const calls = fakeNetwork({ "calendars/primary/events": () => ({}) });
  const prepared = (await calendar.createCalendarEvent.prepare?.({ title: "לבד", ...range, location: null, notes: null, account: null, attendees: [], room_email: null })) ?? {};
  await calendar.createCalendarEvent.run(prepared);
  assert.equal(new URL(calls[0]?.url ?? "").searchParams.get("sendUpdates"), null);
  assert.equal(JSON.parse(calls[0]?.body ?? "{}").attendees, undefined);
});
