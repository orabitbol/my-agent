// Small user settings, kept in data/settings.json.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { DATA_DIR } from "./paths.js";

const FILE = new URL("settings.json", DATA_DIR);

export type Settings = {
  // The account new events and drafts go to when the user does not name one.
  defaultAccount?: string;
  // Which meeting rooms the agent may book. Only rooms in this country are ever
  // offered. Default: Israel. See roomPolicy() below.
  rooms?: { country?: string; nameHints?: string[] };
  // Where the user left the floating character on the screen.
  // "roam: false" keeps it in place instead of strolling around the screen.
  character?: { x?: number; y?: number; roam?: boolean };
};

/**
 * The rule for meeting rooms. A room is allowed only when we can tell it is in
 * the user's country: from the organization's building list when it is known,
 * otherwise from the room's name. A room we cannot place is not offered.
 */
export async function roomPolicy(): Promise<{ country: string; nameHints: string[] }> {
  const { rooms } = await loadSettings();
  return {
    country: (rooms?.country ?? "IL").toUpperCase(),
    nameHints: rooms?.nameHints ?? ["TLV", "Tel Aviv", "Israel", "תל אביב", "ישראל"],
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as Settings;
  } catch {
    return {};
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(settings, null, 2));
}
