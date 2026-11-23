// The two Zoom actions the agent needs: create a meeting, and remove one again.

import { getZoomToken } from "./auth.js";

const API = "https://api.zoom.us/v2";

export type ZoomMeeting = { id: string; joinUrl: string; passcode: string | null };

async function zoomFetch(path: string, init: { method: string; body?: unknown }): Promise<Response> {
  const response = await fetch(`${API}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${await getZoomToken()}`, "Content-Type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) {
    const text = await response.text();
    let reason = text.slice(0, 200);
    try {
      reason = (JSON.parse(text) as { message?: string }).message ?? reason;
    } catch {
      // keep the raw text
    }
    throw new Error(`Zoom returned ${response.status}: ${reason}`);
  }
  return response;
}

/** Creates a new scheduled Zoom meeting for the connected user. */
export async function createZoomMeeting(meeting: { title: string; start: Date; end: Date; notes?: string }): Promise<ZoomMeeting> {
  const minutes = Math.max(1, Math.round((meeting.end.getTime() - meeting.start.getTime()) / 60_000));
  const response = await zoomFetch("/users/me/meetings", {
    method: "POST",
    body: {
      topic: meeting.title,
      type: 2, // a scheduled meeting
      start_time: meeting.start.toISOString().replace(/\.\d{3}Z$/, "Z"),
      timezone: "UTC",
      duration: minutes,
      ...(meeting.notes ? { agenda: meeting.notes.slice(0, 2000) } : {}),
    },
  });
  const created = (await response.json()) as { id: number | string; join_url: string; password?: string };
  return { id: String(created.id), joinUrl: created.join_url, passcode: created.password || null };
}

/** Removes a meeting. Used to clean up when the calendar event could not be created. */
export async function deleteZoomMeeting(id: string): Promise<void> {
  await zoomFetch(`/meetings/${encodeURIComponent(id)}`, { method: "DELETE" });
}
