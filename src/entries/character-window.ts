// The character's window: small, see-through, above every app.
// This file is its body in the world: where it stands, how it glides around the
// screen and between screens, and what it looks at. What it is *doing*
// (listening, thinking…) is not decided here: that state lives in the server.

import { BrowserWindow, ipcMain, screen } from "electron";
import { fileURLToPath } from "node:url";
import { loadSettings, saveSettings } from "../core/settings.js";

// The window: the character's body plus room for its glow.
const SIZE = 144;
const BODY = 88;                     // the character itself; must match --character-size in tokens.css
const MARGIN = 24;
const FRAME_MS = 16;
const ROAM_SECONDS: [number, number] = [45, 100]; // how long it stays in one place between glides
const QUIET_AFTER_TOUCH_MS = 90_000; // after the user moves it, it stays put this long
const ASLEEP_AFTER_MS = 8 * 60_000;  // with nothing happening, it dozes off
const LOOK_RANGE = 500;              // beyond this distance it looks fully toward the point
const FOLLOW_AFTER_MS = 3500;        // the pointer must settle on another screen this long before it follows

type Point = { x: number; y: number };
export type CharacterOptions = {
  serverUrl: string;
  keepInside: (window: BrowserWindow) => void;
  // Resolves when the chat page is open and listening (opens it if needed).
  chatReady: () => Promise<void>;
};

const between = (min: number, max: number) => min + Math.random() * (max - min);
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// What the app can ask of the character once it is on the screen.
export type CharacterWindow = {
  window: BrowserWindow;
  // Shows a speech bubble next to it for a few seconds.
  say: (text: string) => void;
};

const SAY_MS = 9000; // how long a speech bubble stays

export async function openCharacter(options: CharacterOptions): Promise<CharacterWindow> {
  const settings = await loadSettings();
  const roams = settings.character?.roam !== false;
  const [stayMin, stayMax] = settings.character?.roamSeconds ?? ROAM_SECONDS;
  const pagePreferences = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false, // it keeps moving while the user works in another app
    preload: fileURLToPath(new URL("./character-preload.cjs", import.meta.url)),
  };

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
    webPreferences: pagePreferences,
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
  let gliding = false;
  let talking = false;
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
  // The small window cannot move smoothly enough by itself, so for a glide the
  // character changes stage: a see-through sheet covers each screen, clicks pass
  // straight through it, and the character flies across it with a trail of light.
  // When it lands, the small window reappears in the new place and the sheet goes away.
  const stages = new Map<number, BrowserWindow>();
  function stageFor(display: Electron.Display): BrowserWindow {
    let stage = stages.get(display.id);
    if (stage && !stage.isDestroyed()) return stage;
    stage = new BrowserWindow({
      ...display.workArea,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: pagePreferences,
    });
    options.keepInside(stage);
    stage.setIgnoreMouseEvents(true); // the user's clicks reach whatever is underneath
    stage.setAlwaysOnTop(true, "floating");
    stage.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    void stage.loadURL(options.serverUrl + "/stage");
    stages.set(display.id, stage);
    return stage;
  }
  // Have a stage ready on every screen, also on one that is connected later.
  const prepareStages = () => {
    const displays = screen.getAllDisplays();
    for (const display of displays) stageFor(display);
    for (const [id, stage] of stages) {
      if (displays.some((display) => display.id === id)) continue;
      if (!stage.isDestroyed()) stage.destroy();
      stages.delete(id);
    }
  };
  prepareStages();
  screen.on("display-added", prepareStages);
  screen.on("display-removed", prepareStages);

  // One glide to a new place, on this screen or across to another one.
  async function glide(to: Point): Promise<void> {
    if (gliding || talking) return; // one journey at a time, and not while it is saying something
    const from = position();
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const duration = Math.round(Math.min(2400, 800 + distance * 0.9));
    // A gentle arc: the path bends to one side instead of running straight.
    const bend = distance * 0.16 * (Math.random() < 0.5 ? -1 : 1);
    const control = { x: (from.x + to.x) / 2 - ((to.y - from.y) / (distance || 1)) * bend, y: (from.y + to.y) / 2 + ((to.x - from.x) / (distance || 1)) * bend };

    // Every screen the path may cross gets the same flight, in its own coordinates.
    const inset = (SIZE - BODY) / 2;
    const flying = [...stages.values()].filter((stage) => !stage.isDestroyed() && !stage.webContents.isLoading());
    if (flying.length === 0) return; // no stage is ready yet: stay where it is
    const startAt = Date.now() + 160;
    for (const stage of flying) {
      const area = stage.getBounds();
      const local = (point: Point) => ({ x: point.x + inset - area.x, y: point.y + inset - area.y });
      stage.webContents.send("character:event", "fly", { from: local(from), control: local(control), to: local(to), startAt, duration });
      stage.showInactive();
    }
    gliding = true;
    try {
      await wait(startAt - Date.now());
      window.hide(); // the stage now shows it in the very same spot
      await wait(duration + 60);
      if (window.isDestroyed()) return;
      window.setPosition(Math.round(to.x), Math.round(to.y));
      window.showInactive();
      tell("land");
      await wait(90);
    } finally {
      gliding = false;
      for (const stage of flying) if (!stage.isDestroyed()) { stage.webContents.send("character:event", "rest"); stage.hide(); }
    }
  }

  const displayOf = (point: Point) => screen.getDisplayMatching({ ...point, width: SIZE, height: SIZE });
  const spotOn = (area: Electron.Rectangle): Point => ({
    x: Math.round(between(area.x + MARGIN, area.x + area.width - SIZE - MARGIN)),
    y: Math.round(between(area.y + MARGIN, area.y + area.height - SIZE - MARGIN)),
  });

  // A stroll: one long glide to a new spot. It stays on its own screen, which
  // is the screen the user works on (see "following the user" below).
  async function roam(): Promise<void> {
    const here = position();
    const area = displayOf(here).workArea;
    // A real journey, not a shuffle: pick a spot well away from here.
    const far = Math.hypot(area.width, area.height) * 0.35;
    let target = spotOn(area);
    for (let tries = 0; tries < 12 && Math.hypot(target.x - here.x, target.y - here.y) < far; tries++) target = spotOn(area);
    await glide(target);
  }

  // Following the user: the character lives on the screen the user works on,
  // and that is the screen the pointer is on. It does not chase the pointer:
  // only once the pointer has settled on another screen does it glide over,
  // to the same corner it was in before.
  let pointerElsewhereSince = 0;
  async function followPointer(pointer: Point): Promise<void> {
    const here = position();
    const mine = displayOf(here);
    const theirs = screen.getDisplayNearestPoint(pointer);
    if (theirs.id === mine.id || dragging) return void (pointerElsewhereSince = 0);
    pointerElsewhereSince ||= Date.now();
    if (gliding || Date.now() - pointerElsewhereSince < FOLLOW_AFTER_MS) return;
    pointerElsewhereSince = 0;
    lastActivity = Date.now(); // it wakes up to come along

    const from = mine.workArea, to = theirs.workArea;
    const place = (value: number, start: number, length: number, newStart: number, newLength: number) => {
      const share = Math.max(0, Math.min(1, (value - start) / Math.max(1, length - SIZE)));
      return Math.round(newStart + MARGIN + share * Math.max(0, newLength - SIZE - 2 * MARGIN));
    };
    await glide({ x: place(here.x, from.x, from.width, to.x, to.width), y: place(here.y, from.y, from.height, to.y, to.height) }).catch(() => {});
  }

  let roaming: NodeJS.Timeout;
  const planRoam = () => {
    roaming = setTimeout(async () => {
      const free = roams && !asleep && !busy() && !dragging && Date.now() - lastTouched > QUIET_AFTER_TOUCH_MS;
      if (free) await roam().catch(() => {});
      if (!window.isDestroyed()) planRoam();
    }, between(stayMin, stayMax) * 1000);
  };
  planRoam();

  // ---- attention: the point the character looks at ----
  // Today that point is the mouse pointer. Later it can be the user's eyes, from
  // the device's camera: whatever the source, the page only gets a direction.
  let lastLook = "";
  const attention = setInterval(() => {
    if (window.isDestroyed()) return;
    const pointer = screen.getCursorScreenPoint();
    void followPointer(pointer);
    const here = position();
    const dx = pointer.x - (here.x + SIZE / 2);
    const dy = pointer.y - (here.y + SIZE / 2);
    const distance = Math.hypot(dx, dy);
    if (distance < SIZE) lastActivity = Date.now(); // the pointer came close: it notices

    const nowAsleep = state === "resting" && Date.now() - lastActivity > ASLEEP_AFTER_MS;
    if (nowAsleep !== asleep) tell("asleep", (asleep = nowAsleep));
    if (asleep || gliding) return;

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
    screen.off("display-added", prepareStages);
    screen.off("display-removed", prepareStages);
    for (const stage of stages.values()) if (!stage.isDestroyed()) stage.destroy();
  });

  // A page that just loaded knows nothing yet: tell it again where to look.
  window.webContents.on("did-finish-load", () => { lastLook = ""; });

  // Appear without taking the keyboard away from the app the user is in.
  window.once("ready-to-show", () => window.showInactive());
  void window.loadURL(options.serverUrl + "/character");
  // ---- speaking up ----
  // A speech bubble next to the character, drawn on the stage of its screen.
  // Clicks pass through it, so it never gets in the way of the user's work.
  async function sayNow(text: string): Promise<void> {
    while (gliding) await wait(200);
    if (window.isDestroyed()) return;
    lastActivity = Date.now(); // it wakes up to say it
    const here = position();
    const stage = stageFor(displayOf(here));
    if (stage.webContents.isLoading()) return;
    const area = stage.getBounds();
    talking = true;
    try {
      stage.webContents.send("character:event", "say", { text, x: here.x + SIZE / 2 - area.x, y: here.y + (SIZE - BODY) / 2 - area.y, width: area.width });
      stage.showInactive();
      tell("land"); // a small move, so the eye catches it
      await wait(SAY_MS);
    } finally {
      talking = false;
      if (!stage.isDestroyed()) {
        stage.webContents.send("character:event", "hush");
        if (!gliding) stage.hide();
      }
    }
  }
  // Two things to say at once are said one after the other.
  let saying = Promise.resolve();
  const say = (text: string) => void (saying = saying.then(() => sayNow(text)).catch(() => {}));

  return { window, say };
}
