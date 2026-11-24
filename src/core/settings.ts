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
  // "roamSeconds" is how long it stays in one place between glides: [least, most].
  character?: { x?: number; y?: number; roam?: boolean; roamSeconds?: [number, number] };
  // When the agent turns to the user by itself. "minutesBefore": how long before
  // a meeting. "quietHours": [from, to], the hours in which it stays silent.
  // "mail: false" stops the announcements of important emails.
  // "portfolioReportAt": when the daily portfolio report is said, as "HH:MM". "" switches it off.
  initiative?: { enabled?: boolean; minutesBefore?: number; quietHours?: [number, number]; mail?: boolean; portfolioReportAt?: string };
  // The desk device. See deviceSettings() below for what each one means.
  device?: Partial<DeviceSettings>;
};

export const DEVICE_VOICES = ["marin", "cedar", "coral", "sage", "ash"] as const;
export type DeviceSettings = {
  volume: number;            // the speaker, 0 to 100
  muted: boolean;            // true: the microphone hears nothing
  voice: string;             // "" means the voice the computer uses
  language: "he" | "auto";   // "he": always Hebrew. "auto": the language he speaks
  claps: boolean;            // true: two claps near the device wake the character. Off unless switched on: it is not reliable yet
};

/** The device's settings with everything filled in and kept inside its limits. */
export function fillDeviceSettings(given: Partial<DeviceSettings> = {}): DeviceSettings {
  const volume = Number(given.volume);
  return {
    volume: Number.isFinite(volume) ? Math.min(100, Math.max(0, Math.round(volume))) : 90,
    muted: given.muted === true,
    voice: (DEVICE_VOICES as readonly string[]).includes(String(given.voice)) ? String(given.voice) : "",
    language: given.language === "auto" ? "auto" : "he",
    claps: given.claps === true,
  };
}
export async function deviceSettings(): Promise<DeviceSettings> {
  return fillDeviceSettings((await loadSettings()).device);
}

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
