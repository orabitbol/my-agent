// The agent's long-term memory: short facts about the user that survive between
// conversations. Kept in one SQLite file, data/memory.db, on this computer only.
//
// SQLite is built into Node, so there is nothing to install. It is loaded only
// when memory is first used; if it is missing, memory fails with a clear error
// and the rest of the agent keeps working.

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./paths.js";

export type Fact = { id: number; text: string; createdAt: string };

const MAX_FACTS = 200;
const MAX_LENGTH = 300;

type Statement = { all: (...values: unknown[]) => unknown[]; run: (...values: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint } };
type Database = { exec: (sql: string) => void; prepare: (sql: string) => Statement };

let opened: Promise<Database> | null = null;

function open(): Promise<Database> {
  opened ??= (async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: new (path: string) => Database };
    const database = new DatabaseSync(fileURLToPath(new URL("memory.db", DATA_DIR)));
    database.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    return database;
  })();
  return opened;
}

/** Everything the agent remembers, oldest first. */
export async function listFacts(): Promise<Fact[]> {
  const rows = (await open()).prepare("SELECT id, text, created_at FROM facts ORDER BY id").all() as { id: number; text: string; created_at: string }[];
  return rows.map((row) => ({ id: Number(row.id), text: row.text, createdAt: row.created_at }));
}

/** Saves one fact. Returns the saved fact, or the existing one if it was already known. */
export async function addFact(text: string): Promise<Fact> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("There is nothing to remember.");
  if (clean.length > MAX_LENGTH) throw new Error(`A memory must be one short fact, up to ${MAX_LENGTH} characters.`);

  const facts = await listFacts();
  const same = facts.find((fact) => fact.text === clean);
  if (same) return same;
  if (facts.length >= MAX_FACTS) throw new Error("The memory is full. Ask the user which memories to delete.");

  const createdAt = new Date().toISOString();
  const result = (await open()).prepare("INSERT INTO facts (text, created_at) VALUES (?, ?)").run(clean, createdAt);
  return { id: Number(result.lastInsertRowid), text: clean, createdAt };
}

/** Deletes one fact. Returns false if there was no such fact. */
export async function deleteFact(id: number): Promise<boolean> {
  if (!Number.isInteger(id)) return false;
  return Number((await open()).prepare("DELETE FROM facts WHERE id = ?").run(id).changes) > 0;
}
