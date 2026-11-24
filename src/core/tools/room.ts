// Tool: the room, as the desk device senses it.
//
// The temperature and humidity come from the sensor in the device's base. Read-only.

import { senses } from "../senses.js";
import type { Tool } from "./types.js";

export const getRoom: Tool = {
  name: "get_room",
  description:
    "The room around the user's desk device right now: temperature in Celsius and humidity in percent. " +
    'Use it when he asks how warm or humid it is where he sits ("כמה חם פה", "מה הטמפרטורה בחדר"). ' +
    "The sensor sits right under the device, which is warm, so the temperature can read a degree or two high: say \"about\". " +
    "This is not the weather outside.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  run: async () => {
    const now = senses();
    if (now.temperature === null && now.humidity === null) {
      throw new Error("The desk device is not reporting right now (it is off, out of reach, or has no sensor base).");
    }
    return { temperature_celsius: now.temperature, humidity_percent: now.humidity };
  },
};
