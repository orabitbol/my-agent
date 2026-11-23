// The character's window: small, see-through, above every app.
// This file is its body in the world: where it stands, how it hops around the
// screen and between screens, and what it looks at. What it is *doing*
// (listening, thinking…) is not decided here: that state lives in the server.

import { BrowserWindow, ipcMain, screen } from "electron";
import { fileURLToPath } from "node:url";
import { loadSettings, saveSettings } from "../core/settings.js";

// The window: the character's body plus room for its glow.
const SIZE = 144;
const MARGIN = 24;
const FRAME_MS = 16;
const STEP = 240;                    // the longest single hop, in points
const QUIET_AFTER_TOUCH_MS = 90_000; // after the user moves it, it stays put this long
const ASLEEP_AFTER_MS = 8 * 60_000;  // with nothing happening, it dozes off
const LOOK_RANGE = 500;              // beyond this distance it looks fully toward the point

type Point = { x: number; y: number };
export type CharacterOptions = {
  serverUrl: string;
  keepInside: (window: BrowserWindow) => void;
  // Resolves when the chat page is open and listening (opens it if needed).
  chatReady: () => Promise<void>;
};

const between = (min: number, max: number) => min + Math.random() * (max - min);
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export async function openCharacter(options: CharacterOptions): Promise<BrowserWindow> {
  const settings = await loadSettings();
  const roams = settings.character?.roam !== false;

  // Start in the bottom corner, or where the user last left it, if that spot is still on a screen.
  const { workArea } = screen.getPrimaryDisplay();
  let spot: Point = { x: workArea.x + workArea.width - SIZE - MARGIN, y: workArea.y + workArea.height - SIZE - MARGIN };
  const saved = settings.character;
  const onScreen = (point: Point) =>
    screen.getAllDisplays().some(({ bounds }) => point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height);
  if (typeof saved?.x === "number" && typeof saved.y === "number") {
    const last = { x: saved.x, y: saved.y };
    if (Number.isFinite(last.x) && Number.isFinite(last.y) && onScreen(last)) spot = last;
  }

  const window = new BrowserWindow({
    ...spot,
    width: SIZE,
    height: SIZE,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // it keeps moving while the user works in another app
      preload: fileURLToPath(new URL("./character-preload.cjs", import.meta.url)),
    },
  });
  options.keepInside(window);
  // Above normal windows, on every desktop, and over full-screen apps too.
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });

  const tell = (name: string, data?: unknown) => {
    if (!window.isDestroyed()) window.webContents.send("character:event", name, data);
  };
  const position = (): Point => {
    const [x = 0, y = 0] = window.getPosition();
    return { x, y };
  };

  let state = "resting";
  let lastActivity = Date.now(); // the last time anything happened to it
  let lastTouched = 0;           // the last time the user moved it
  let dragging: { offset: Point; timer: NodeJS.Timeout } | null = null;
  let hopping = false;
  let asleep = false;
  const busy = () => !["resting", "ready"].includes(state);

  // ---- what the user does to it (only this window's page may say so) ----
  const fromPage = (handler: (...args: unknown[]) => void) => (event: Electron.IpcMainEvent, ...args: unknown[]) => {
    if (!window.isDestroyed() && event.sender === window.webContents) handler(...args);
  };
  const post = (path: string, body: object = {}) =>
    fetch(options.serverUrl + path, { method: "POST", body: JSON.stringify(body) }).catch(() => {});

  const onClick = fromPage(() => {
    lastActivity = Date.now();
    void options.chatReady().then(() => post("/api/character/poke"));
  });
  const onHold = fromPage((down) => {
    lastActivity = Date.now();
    void post("/api/character/hold", { down: down === true });
  });
  const onState = fromPage((next) => {
    state = String(next);
    lastActivity = Date.now();
  });
  // Dragging: while the button is down, the window follows the pointer.
  const onDrag = fromPage((start) => {
    if (dragging) clearInterval(dragging.timer);
    dragging = null;
    lastActivity = lastTouched = Date.now();
    if (start !== true) {
      // Remember where the user put it.
      void loadSettings().then((latest) => saveSettings({ ...latest, character: { ...latest.character, ...position() } }));
      return;
    }
    const pointer = screen.getCursorScreenPoint();
    const here = position();
    const offset = { x: pointer.x - here.x, y: pointer.y - here.y };
    const timer = setInterval(() => {
      if (window.isDestroyed()) return clearInterval(timer);
      const now = screen.getCursorScreenPoint();
      window.setPosition(now.x - offset.x, now.y - offset.y);
    }, FRAME_MS);
    dragging = { offset, timer };
  });
  ipcMain.on("character:click", onClick);
  ipcMain.on("character:hold", onHold);
  ipcMain.on("character:state", onState);
  ipcMain.on("character:drag", onDrag);

  // ---- moving ----
  // One hop: the window travels along an arc while the page squashes and stretches.
  async function hop(to: Point, duration: number, height: number): Promise<boolean> {
    const from = position();
    const started = Date.now();
    hopping = true;
    tell("hop", duration);
    try {
      for (;;) {
        await wait(FRAME_MS);
        if (window.isDestroyed() || dragging) return false;
        const t = Math.min(1, (Date.now() - started) / duration);
        const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        const lift = height * 4 * t * (1 - t);
        window.setPosition(Math.round(from.x + (to.x - from.x) * eased), Math.round(from.y + (to.y - from.y) * eased - lift));
        if (t === 1) return true;
      }
    } finally {
      hopping = false;
    }
  }

  // A stroll: a few hops to a new spot on this screen, or one big jump to another screen.
  async function roam(): Promise<void> {
    const here = position();
    const display = screen.getDisplayMatching({ ...here, width: SIZE, height: SIZE });
    const others = screen.getAllDisplays().filter((other) => other.id !== display.id);
    const spotOn = (area: Electron.Rectangle): Point => ({
      x: Math.round(between(area.x + MARGIN, area.x + area.width - SIZE - MARGIN)),
      y: Math.round(between(area.y + MARGIN, area.y + area.height - SIZE - MARGIN)),
    });

    const other = others[Math.floor(Math.random() * others.length)];
    if (other && Math.random() < 0.3) {
      await hop(spotOn(other.workArea), 900, 220);
      return;
    }
    const target = spotOn(display.workArea);
    const distance = Math.hypot(target.x - here.x, target.y - here.y);
    const hops = Math.max(1, Math.ceil(distance / STEP));
    for (let i = 1; i <= hops; i++) {
      const next = { x: Math.round(here.x + ((target.x - here.x) * i) / hops), y: Math.round(here.y + ((target.y - here.y) * i) / hops) };
      if (busy() || !(await hop(next, 420, 56))) return;
      await wait(110);
    }
  }

  let roaming: NodeJS.Timeout;
  const planRoam = () => {
    roaming = setTimeout(async () => {
      const free = roams && !asleep && !busy() && !dragging && Date.now() - lastTouched > QUIET_AFTER_TOUCH_MS;
      if (free) await roam().catch(() => {});
      if (!window.isDestroyed()) planRoam();
    }, between(20_000, 50_000));
  };
  planRoam();

  // ---- attention: the point the character looks at ----
  // Today that point is the mouse pointer. Later it can be the user's eyes, from
  // the device's camera: whatever the source, the page only gets a direction.
  let lastLook = "";
  const attention = setInterval(() => {
    if (window.isDestroyed()) return;
    const pointer = screen.getCursorScreenPoint();
    const here = position();
    const dx = pointer.x - (here.x + SIZE / 2);
    const dy = pointer.y - (here.y + SIZE / 2);
    const distance = Math.hypot(dx, dy);
    if (distance < SIZE) lastActivity = Date.now(); // the pointer came close: it notices

    const nowAsleep = state === "resting" && Date.now() - lastActivity > ASLEEP_AFTER_MS;
    if (nowAsleep !== asleep) tell("asleep", (asleep = nowAsleep));
    if (asleep || hopping) return;

    const strength = Math.min(1, distance / LOOK_RANGE);
    const look = { x: distance ? +((dx / distance) * strength).toFixed(2) : 0, y: distance ? +((dy / distance) * strength).toFixed(2) : 0 };
    const key = `${look.x},${look.y}`;
    if (key !== lastLook) tell("attention", look);
    lastLook = key;
  }, 100);

  window.on("closed", () => {
    clearTimeout(roaming);
    clearInterval(attention);
    if (dragging) clearInterval(dragging.timer);
    ipcMain.off("character:click", onClick);
    ipcMain.off("character:hold", onHold);
    ipcMain.off("character:state", onState);
    ipcMain.off("character:drag", onDrag);
  });

  // A page that just loaded knows nothing yet: tell it again where to look.
  window.webContents.on("did-finish-load", () => { lastLook = ""; });

  // Appear without taking the keyboard away from the app the user is in.
  window.once("ready-to-show", () => window.showInactive());
  void window.loadURL(options.serverUrl + "/character");
  return window;
}
