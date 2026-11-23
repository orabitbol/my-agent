// Small user settings, kept in data/settings.json.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { DATA_DIR } from "./paths.js";

const FILE = new URL("settings.json", DATA_DIR);

export type Settings = {
  // The account new events and drafts go to when the user does not name one.
  defaultAccount?: string;
};

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
