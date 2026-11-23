// The core of the agent. It knows nothing about terminals, browsers or voice:
// it gets the user's text, talks to the model, runs tools, and returns the reply.

import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { config } from "./config.js";
import { buildInstructions } from "./prompt.js";
import { runTool } from "./run-tool.js";
import type { TurnHandlers } from "./run-tool.js";
import { tools } from "./tools/index.js";
import type { Tool } from "./tools/types.js";

// Safety stop: the model may call tools several times in a row,
// but never forever.
const MAX_STEPS = 8;

export type { ApprovalRequest, Approver, ToolCallEvent, ToolCallListener, TurnHandlers } from "./run-tool.js";

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
        const result = await runTool(this.tools, request.name, request.arguments, handlers);
        this.history.push({
          type: "function_call_output",
          call_id: request.call_id,
          output: JSON.stringify(result),
        });
      }
    }

    return "עצרתי: יותר מדי קריאות לכלים ברצף.";
  }
}
