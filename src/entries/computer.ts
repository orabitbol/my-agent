// The agent's hands on this Mac: the real mouse and keyboard.
// The operator (core/operator.ts) decides what to do; this file only does it.
//
// macOS lets an app move the mouse and press keys only after the user allows
// it once, in System Settings > Privacy & Security > Accessibility.
// The events are sent with a few lines of JavaScript for Automation (osascript),
// which is part of macOS, so nothing has to be installed.

import { BrowserWindow, clipboard, screen, systemPreferences } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Computer } from "../core/operator.js";
import { captureScreens } from "./screens.js";
import type { ScreenCapture } from "./screens.js";

const run = promisify(execFile);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const NO_PERMISSION =
  "אין הרשאה לשלוט בעכבר ובמקלדת. צריך לאשר אותה בהגדרות המערכת, תחת פרטיות ואבטחה > נגישות (לאפליקציה שמופיעה שם: Electron, או הטרמינל שממנו הפעלת), ואז להפעיל את האפליקציה מחדש.";

// macOS event numbers (CoreGraphics). Written as numbers so nothing depends on name lookups.
const MOUSE = { moved: 5, down: 1, up: 2 };
const MODIFIERS: Record<string, number> = { cmd: 1 << 20, command: 1 << 20, shift: 1 << 17, ctrl: 1 << 18, control: 1 << 18, alt: 1 << 19, option: 1 << 19 };
const KEYS: Record<string, number> = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126, pageup: 116, pagedown: 121, home: 115, end: 119,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
  o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
};

async function script(code: string): Promise<void> {
  await run("osascript", ["-l", "JavaScript", "-e", `ObjC.import("CoreGraphics");\n${code}`], { timeout: 8000 });
}
const mouseEvent = (type: number, x: number, y: number, clicks: number) =>
  `(function(){var e=$.CGEventCreateMouseEvent(null,${type},{x:${x},y:${y}},0);$.CGEventSetIntegerValueField(e,1,${clicks});$.CGEventPost(0,e);})();`;
const keyEvent = (code: number, flags: number, down: boolean) =>
  `(function(){var e=$.CGEventCreateKeyboardEvent(null,${code},${down});$.CGEventSetFlags(e,${flags});$.CGEventPost(0,e);})();`;

const near = (a: Electron.Point, b: Electron.Point, distance: number) => Math.hypot(a.x - b.x, a.y - b.y) <= distance;

export function createComputer(): Computer {
  let views: ScreenCapture[] = [];
  // Where we last left the pointer. If it is somewhere else, the user moved it.
  let pointerLeftAt: Electron.Point | null = null;

  async function pressKeys(keys: string): Promise<void> {
    const parts = keys.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
    const key = parts.pop() ?? "";
    const code = KEYS[key];
    if (code === undefined) throw new Error(`Unknown key "${key}". Known keys: ${Object.keys(KEYS).join(", ")}.`);
    let flags = 0;
    for (const part of parts) {
      const flag = MODIFIERS[part];
      if (flag === undefined) throw new Error(`Unknown modifier "${part}". Use cmd, shift, ctrl or alt.`);
      flags |= flag;
    }
    await script(`${keyEvent(code, flags, true)} delay(0.04); ${keyEvent(code, flags, false)}`);
  }

  return {
    async begin() {
      if (process.platform !== "darwin") throw new Error("שליטה בעכבר ובמקלדת עובדת כרגע רק במק.");
      systemPreferences.isTrustedAccessibilityClient(true); // shows macOS's own question the first time
      // The real test: nudge the pointer by one point and see whether it moved.
      const before = screen.getCursorScreenPoint();
      const nudged = { x: before.x + (before.x > 2 ? -1 : 1), y: before.y };
      await script(mouseEvent(MOUSE.moved, nudged.x, nudged.y, 0)).catch(() => {});
      await wait(80);
      if (!near(screen.getCursorScreenPoint(), nudged, 0.5)) throw new Error(NO_PERMISSION);
      await script(mouseEvent(MOUSE.moved, before.x, before.y, 0));
      await wait(40);
      pointerLeftAt = screen.getCursorScreenPoint();
    },

    takeControl() {
      pointerLeftAt = screen.getCursorScreenPoint();
    },

    userTookOver() {
      return pointerLeftAt !== null && !near(screen.getCursorScreenPoint(), pointerLeftAt, 40);
    },

    async look() {
      views = await captureScreens(700_000);
      return views.map(({ id, label, image, width, height }) => ({ id, label, image, width, height }));
    },

    async click(screenNumber, x, y, double) {
      const view = views[screenNumber - 1];
      if (!view) throw new Error(`There is no screen ${screenNumber}. There are ${views.length}.`);
      if (!(x >= 0 && y >= 0 && x <= view.width && y <= view.height)) throw new Error(`The point is outside the picture, which is ${view.width}x${view.height} pixels.`);
      // From a point in the picture to a point on the real screen.
      const point = {
        x: Math.round(view.bounds.x + (x / view.width) * view.bounds.width),
        y: Math.round(view.bounds.y + (y / view.height) * view.bounds.height),
      };
      // The agent may never press its own buttons (for example its own approval button).
      for (const window of BrowserWindow.getAllWindows()) {
        const area = window.getBounds();
        const inside = point.x >= area.x && point.y >= area.y && point.x < area.x + area.width && point.y < area.y + area.height;
        if (inside && window.isVisible() && window.isFocusable()) throw new Error("That point is inside the agent's own window. You may not click there.");
      }
      const down = (clicks: number) => `${mouseEvent(MOUSE.down, point.x, point.y, clicks)} ${mouseEvent(MOUSE.up, point.x, point.y, clicks)}`;
      await script(`${mouseEvent(MOUSE.moved, point.x, point.y, 0)} delay(0.08); ${down(1)} ${double ? `delay(0.06); ${down(2)}` : ""}`);
      await wait(60);
      if (!near(screen.getCursorScreenPoint(), point, 3)) throw new Error(NO_PERMISSION);
      pointerLeftAt = point;
    },

    // Text goes in through the clipboard, so Hebrew and any other language arrive intact.
    async typeText(text) {
      const before = await clipboard.readText();
      clipboard.writeText(text);
      try {
        await pressKeys("cmd+v");
        await wait(350);
      } finally {
        clipboard.writeText(before);
      }
    },

    pressKey: pressKeys,

    async openApp(name) {
      const app = name.trim();
      if (!app || app.startsWith("-") || app.length > 60 || /[\/\\]/.test(app)) throw new Error("That is not an app name.");
      await run("open", ["-a", app], { timeout: 8000 }).catch(() => {
        throw new Error(`Could not open an app named "${app}". Check the exact name.`);
      });
    },
  };
}
