// The core of the agent. It knows nothing about terminals, browsers or voice:
// it gets the user's text, talks to the model, runs tools, and returns the reply.

import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { config } from "./config.js";
import { buildInstructions } from "./prompt.js";
import { logToolCall } from "./log.js";
import { tools } from "./tools/index.js";
import type { Tool } from "./tools/types.js";

// Safety stop: the model may call tools several times in a row,
// but never forever.
const MAX_STEPS = 8;

// Called whenever a tool runs, so an entry (terminal, GUI) can show it.
export type ToolCallEvent = { tool: string; args: unknown; ok: boolean; result: unknown; ms: number };
export type ToolCallListener = (call: ToolCallEvent) => void;

// How an entry lets the user approve a sensitive action. It shows the summary,
// waits for the answer, and resolves to true (approved) or false (declined).
export type ApprovalRequest = { tool: string; summary: string; args: unknown };
export type Approver = (request: ApprovalRequest) => Promise<boolean>;

// What an entry can hook into during one turn.
export type TurnHandlers = { onToolCall?: ToolCallListener; approve?: Approver };

export class Agent {
  private client: OpenAI;
  private tools: Tool[];

  // The conversation so far. The model has no memory of its own:
  // on every turn we send the whole history again.
  private history: ResponseInputItem[] = [];

  constructor(options: { client?: OpenAI; tools?: Tool[] } = {}) {
    this.client = options.client ?? new OpenAI({ apiKey: config.openaiApiKey });
    this.tools = options.tools ?? tools;
  }

  // Forget the conversation and start a new one.
  reset(): void {
    this.history = [];
  }

  async send(userText: string, handlers: TurnHandlers = {}): Promise<string> {
    this.history.push({ role: "user", content: userText });

    // THE LOOP. Each round: ask the model. If it asks for tools, run them,
    // add the results to the history, and ask again. If it does not, we are done.
    const instructions = await buildInstructions();
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await this.client.responses.create({
        model: config.model,
        instructions,
        input: this.history,
        tools: this.tools.map((tool) => ({
          type: "function" as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: true,
        })),
      });

      // Keep everything the model produced (text, tool requests) in the history.
      this.history.push(...(response.output as ResponseInputItem[]));

      const toolRequests = response.output.filter((item) => item.type === "function_call");
      if (toolRequests.length === 0) {
        return response.output_text;
      }

      for (const request of toolRequests) {
        const result = await this.runTool(request.name, request.arguments, handlers);
        this.history.push({
          type: "function_call_output",
          call_id: request.call_id,
          output: JSON.stringify(result),
        });
      }
    }

    return "עצרתי: יותר מדי קריאות לכלים ברצף.";
  }

  // Runs one tool. Never throws: an error is returned to the model as a result,
  // so it can tell the user what went wrong instead of crashing the conversation.
  private async runTool(name: string, rawArgs: string, handlers: TurnHandlers): Promise<unknown> {
    const started = Date.now();
    let args: unknown = rawArgs;
    let ok = false;
    let result: unknown;

    try {
      const tool = this.tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      args = JSON.parse(rawArgs || "{}");
      let toolArgs = args as Record<string, unknown>;
      if (tool.prepare) {
        toolArgs = await tool.prepare(toolArgs);
        args = toolArgs; // log and show what will really run
      }

      if (tool.needsApproval && !(await this.isApproved(tool, toolArgs, handlers.approve))) {
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
  private async isApproved(tool: Tool, args: Record<string, unknown>, approve?: Approver): Promise<boolean> {
    if (!approve) return false;
    const summary = tool.describe ? tool.describe(args) : `להפעיל את ${tool.name}`;
    return approve({ tool: tool.name, summary, args });
  }
}
