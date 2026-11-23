// Every tool call is written to data/tool-calls.log, one JSON object per line,
// so we can always see what the agent did and why something went wrong.

import { appendFile, mkdir } from "node:fs/promises";
import { DATA_DIR } from "./paths.js";

const LOG_FILE = new URL("tool-calls.log", DATA_DIR);

export type ToolCallRecord = {
  tool: string;
  args: unknown;
  ok: boolean;
  result: unknown;
  ms: number;
};

export async function logToolCall(record: ToolCallRecord): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const line = JSON.stringify({ time: new Date().toISOString(), ...record });
  await appendFile(LOG_FILE, line + "\n");
}
