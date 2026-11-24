// Tool: the character moves between the computer's screen and the desk device.
//
// "לך למקום" sends it to the device; "חזור למחשב" brings it back. The voice
// conversation moves with it: it ends where it was and continues where it went.

import { moveCharacterTo } from "../place.js";
import type { Tool } from "./types.js";

export const moveCharacter: Tool = {
  name: "move_character",
  description:
    "Moves you, the character, between the user's computer screen and the small device on his desk. " +
    'Use where "device" when he tells you to go to your place or to the device ("לך למקום", "למקום", "עבור למכשיר"), ' +
    'and "computer" when he calls you back ("חזור למחשב", "בוא למחשב"). ' +
    "The voice conversation continues on the screen you move to and ends on the one you leave, a moment after you call this. " +
    "So before calling it say at most one short word (\"עובר\"), and say nothing after it.",
  parameters: {
    type: "object",
    properties: { where: { type: "string", enum: ["device", "computer"], description: "The screen to move to." } },
    required: ["where"],
    additionalProperties: false,
  },
  run: async (args) => {
    const where = args.where === "computer" ? "computer" : "device";
    moveCharacterTo(where);
    return { moving_to: where };
  },
};
