// Desktop entry: the agent as an app with its own window (Electron).
// It starts the local server inside the app and shows the chat page in a window.

import "./load-env.js"; // must stay first
import { app, BrowserWindow, session, shell, systemPreferences } from "electron";
import { Agent } from "../core/agent.js";
import { computerTool } from "../core/tools/computer.js";
import { tools as coreTools } from "../core/tools/index.js";
import { openCharacter } from "./character-window.js";
import { createComputer } from "./computer.js";
import { captureScreens } from "./screens.js";
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

// Resolves when the chat page is open and listening. Opens the window if it was closed.
function chatReady(): Promise<void> {
  if (mainWindow && !mainWindow.webContents.isLoading()) return Promise.resolve();
  if (!mainWindow) openWindow();
  const { webContents } = mainWindow!;
  return new Promise((ready) => webContents.once("did-finish-load", () => setTimeout(ready, 400)));
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
    // The conversation keeps running at full speed while this window is behind others.
    webPreferences: { ...PAGE_ONLY, backgroundThrottling: false },
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
  // The desktop app has a computer to act on, so here the agent also gets hands.
  const tools = [...coreTools, computerTool(createComputer())];
  serverUrl = await startServer(0, {
    agent: new Agent({ tools }),
    tools,
    // An approval is waiting: bring the chat window, with its button, to the front.
    onApprovalAsked: () => void chatReady().then(() => { mainWindow?.show(); mainWindow?.focus(); }),
    openBrowser: (url) => void shell.openExternal(url),
    captureScreens,
    // macOS asks the user once; after that it answers from the saved choice.
    prepareMicrophone: async () => (process.platform === "darwin" ? systemPreferences.askForMediaAccess("microphone") : true),
  });

  // The app's own page may use the microphone. Nothing else may ask for anything.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, allow) => {
    allow(permission === "media" && webContents === mainWindow?.webContents && webContents.getURL().startsWith(serverUrl));
  });
  openWindow();
  void openCharacter({ serverUrl, keepInside, chatReady });
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
