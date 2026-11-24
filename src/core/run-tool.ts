// Runs one tool, the same way for every entry (text chat, voice, background):
// settle the arguments, ask for approval when needed, run, log.
//
// This is the single gate every action of the agent passes through. The model,
// whichever one it is, can only ask; what actually happens is decided here.

import { logToolCall } from "./log.js";
import type { Tool } from "./tools/types.js";

// Called whenever a tool runs, so an entry (terminal, GUI) can show it.
export type ToolCallEvent = { tool: string; args: unknown; ok: boolean; result: unknown; ms: number };
export type ToolCallListener = (call: ToolCallEvent) => void;

// How an entry lets the user approve a sensitive action. It shows the summary,
// waits for the answer, and resolves to true (approved) or false (declined).
export type ApprovalRequest = { tool: string; summary: string; args: unknown };
export type Approver = (request: ApprovalRequest) => Promise<boolean>;

// What an entry can hook into during one turn.
export type TurnHandlers = { onToolCall?: ToolCallListener; approve?: Approver };

/**
 * Never throws: an error is returned as the result, so the model can tell the
 * user what went wrong instead of crashing the conversation.
 */
export async function runTool(tools: Tool[], name: string, rawArgs: string, handlers: TurnHandlers = {}): Promise<unknown> {
  const started = Date.now();
  let args: unknown = rawArgs;
  let ok = false;
  let result: unknown;

  try {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    args = JSON.parse(rawArgs || "{}");
    let toolArgs = args as Record<string, unknown>;
    if (tool.prepare) {
      toolArgs = await tool.prepare(toolArgs);
      args = toolArgs; // log and show what will really run
    }

    if (tool.needsApproval && !(await isApproved(tool, toolArgs, handlers.approve))) {
      result = { declined: true, message: "The user did not approve this action. Do not try again unless the user asks." };
    } else {
      result = await tool.run(toolArgs);
      ok = true;
    }
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  }

  const event = { tool: name, args, ok, result, ms: Date.now() - started };
  await logToolCall(event);
  handlers.onToolCall?.(event);
  return result;
}

// The permission gate. With no way to ask the user, the answer is always no.
async function isApproved(tool: Tool, args: Record<string, unknown>, approve?: Approver): Promise<boolean> {
  if (!approve) return false;
  const summary = tool.describe ? tool.describe(args) : `להפעיל את ${tool.name}`;
  return approve({ tool: tool.name, summary, args });
}
