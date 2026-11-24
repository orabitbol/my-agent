// The technical log: a running list of what happens between the parts (the
// app, the desk device, the voice call), in plain English lines, the way a
// terminal would show it. It is for finding out why something did not work.
//
// It is kept in memory only (the last few hundred lines) and it never holds
// what was said, what a tool was given or what it returned: only that things
// happened, and errors.

export type TraceLine = { at: number; source: string; text: string };

const KEEP = 600;
const lines: TraceLine[] = [];

/** Adds one line. `source` is who is speaking: "app", "device", "call", "tool". */
export function trace(source: string, text: string): void {
  lines.push({ at: Date.now(), source, text: text.replace(/\s+/g, " ").trim().slice(0, 300) });
  if (lines.length > KEEP) lines.splice(0, lines.length - KEEP);
}

export function traceLines(): TraceLine[] {
  return [...lines];
}
