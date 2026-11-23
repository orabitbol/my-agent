// Desktop entry: the agent as an app with its own window (Electron).
// It starts the local server inside the app and shows the chat page in a window.

import "./load-env.js"; // must stay first
import { app, BrowserWindow, screen, session, shell, systemPreferences } from "electron";
import { loadSettings, saveSettings } from "../core/settings.js";
import { startServer } from "./server.js";

let serverUrl = "";
let mainWindow: BrowserWindow | null = null;

// A window shows only the app's own pages. Any other link opens in the normal browser.
function keepInside(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(serverUrl)) return;
    event.preventDefault();
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
  });
}

// The page is a plain web page: it gets no access to Node or the system.
const PAGE_ONLY = { contextIsolation: true, nodeIntegration: false, sandbox: true };

// The size of the window the character floats in: its body plus room for its glow.
const CHARACTER_WINDOW = 144;

// The character: a small see-through window that floats above every app.
// It draws what the agent is doing; the state itself lives in the server.
async function openCharacter(): Promise<void> {
  const { workArea } = screen.getPrimaryDisplay();
  const margin = 24;
  // Start in the bottom corner, or where the user last left it, if that spot is still on a screen.
  let spot = { x: workArea.x + workArea.width - CHARACTER_WINDOW - margin, y: workArea.y + workArea.height - CHARACTER_WINDOW - margin };
  const saved = (await loadSettings()).character;
  const onScreen = (point: { x: number; y: number }) =>
    screen.getAllDisplays().some(({ bounds }) => point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height);
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && onScreen(saved)) spot = { x: saved.x, y: saved.y };

  const window = new BrowserWindow({
    ...spot,
    width: CHARACTER_WINDOW,
    height: CHARACTER_WINDOW,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: PAGE_ONLY,
  });
  keepInside(window);
  // Above normal windows, on every desktop, and over full-screen apps too.
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // Remember where the user dragged it.
  window.on("moved", () => {
    const [x, y] = window.getPosition();
    void loadSettings().then((settings) => saveSettings({ ...settings, character: { x: x ?? 0, y: y ?? 0 } }));
  });
  // Appear without taking the keyboard away from the app the user is in.
  window.once("ready-to-show", () => window.showInactive());
  void window.loadURL(serverUrl + "/character");
}

function openWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 520,
    minHeight: 420,
    title: "האייג'נט שלי",
    // macOS look: no separate title bar, and a translucent sidebar that lets
    // the desktop show through. The page draws its own toolbar.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 19, y: 18 },
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
    backgroundColor: "#00000000",
    show: false,
    webPreferences: PAGE_ONLY,
  });
  keepInside(window);
  mainWindow = window;
  window.on("closed", () => { mainWindow = null; });

  // Show the window only when the page is drawn, so it never flashes empty.
  window.once("ready-to-show", () => window.show());
  void window.loadURL(serverUrl);
}

// Not a top-level await: Electron only becomes "ready" after this file finishes loading.
void app.whenReady().then(async () => {
  serverUrl = await startServer(0, {
    openBrowser: (url) => void shell.openExternal(url),
    // macOS asks the user once; after that it answers from the saved choice.
    prepareMicrophone: async () => (process.platform === "darwin" ? systemPreferences.askForMediaAccess("microphone") : true),
  });

  // The app's own page may use the microphone. Nothing else may ask for anything.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, allow) => {
    allow(permission === "media" && webContents === mainWindow?.webContents && webContents.getURL().startsWith(serverUrl));
  });
  openWindow();
  void openCharacter();
});

// macOS: clicking the dock icon reopens the window; closing it keeps the app alive.
app.on("activate", () => {
  // The character window stays open, so we look for the chat window itself.
  if (mainWindow) mainWindow.show();
  else if (serverUrl) openWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
