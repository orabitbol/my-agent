// Text entry: a chat with the agent in the terminal.
// This file only handles typing and printing. All the thinking is in core/agent.ts.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Agent } from "../core/agent.js";

const agent = new Agent();
const terminal = createInterface({ input: stdin, output: stdout });

console.log('The agent is ready. Type a message, or "exit" to quit.\n');

while (true) {
  const userText = (await terminal.question("you > ")).trim();
  if (userText === "exit") break;
  if (!userText) continue;

  try {
    const reply = await agent.send(userText, {
      // Show every tool call as it happens.
      onToolCall: ({ tool, ok }) => console.log(`  [tool] ${tool} ${ok ? "ok" : "not done"}`),
      // Sensitive actions wait for a yes.
      approve: async ({ summary }) => {
        const answer = await terminal.question(`\n  approve? ${summary}\n  (y/n) > `);
        return answer.trim().toLowerCase() === "y";
      },
    });
    console.log(`\nagent > ${reply}\n`);
  } catch (error) {
    console.error("\nRequest failed:", error instanceof Error ? error.message : error, "\n");
  }
}

terminal.close();
