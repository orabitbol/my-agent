// A first, simple tool: the current date and time.
// The model does not know what day it is, and it needs this to understand
// words like "tomorrow" once the calendar is connected.

import type { Tool } from "./types.js";

export const getCurrentTime: Tool = {
  name: "get_current_time",
  description:
    "Returns the current date, time, weekday and time zone. " +
    "Call it before answering anything that depends on today's date or the current time.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  run: async () => {
    const now = new Date();
    return {
      iso: now.toISOString(),
      local: now.toLocaleString("he-IL", { dateStyle: "full", timeStyle: "short" }),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  },
};
