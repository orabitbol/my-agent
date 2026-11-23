// The tool that lets the agent act on the computer: open apps, click and type.
// It exists only where there is a computer to act on (the desktop app), so it is
// not in the fixed list in index.ts: the entry builds it with its own Computer.

import type OpenAI from "openai";
import { runOperator } from "../operator.js";
import type { Computer } from "../operator.js";
import type { Tool } from "./types.js";

export function computerTool(computer: Computer, client?: OpenAI): Tool {
  return {
    name: "use_computer",
    description:
      "Carries out a task on the user's Mac for him by controlling the mouse and keyboard: opening apps, clicking, typing (for example: write a WhatsApp message to someone, search something in an app, fill in a field). " +
      "Use it when he asks you to DO something in an app on his screen and no other tool does it. Do not use it for the calendar or email: those have their own tools. " +
      "Put the whole task in `task`, in clear words: which app, to whom, and the exact text to write. If the text or the person is unclear, ask him first. " +
      "It takes a while: tell him you are starting. Steps that cannot be taken back (like sending) are confirmed with him by a button on the screen.",
    parameters: {
      type: "object",
      properties: { task: { type: "string", description: "The full task, with the app, the person and the exact text." } },
      required: ["task"],
      additionalProperties: false,
    },
    needsApproval: true,
    describe: (args) => `לקחת שליטה על העכבר והמקלדת כדי לבצע:\n${String(args.task)}\n\nכדי לעצור באמצע, פשוט הזז את העכבר.`,
    prepare: async (args) => {
      const task = String(args.task ?? "").trim();
      if (!task) throw new Error("task is empty. Say what to do on the computer.");
      return { task };
    },
    run: async (args, context) =>
      runOperator({ task: String(args.task), computer, client, confirm: context?.confirm ?? (async () => false) }),
  };
}
