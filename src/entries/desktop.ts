// Desktop entry: the agent as an app with its own window (Electron).
// It starts the local server inside the app and shows the chat page in a window.

import "./load-env.js"; // must stay first
import { app, BrowserWindow, shell } from "electron";
import { startServer } from "./server.js";

let serverUrl = "";

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
    webPreferences: {
      // The page is a plain web page: it gets no access to Node or the system.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Links open in the normal browser, never inside the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  // The window never leaves the app's own page: a link inside a message opens in the browser.
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(serverUrl)) return;
    event.preventDefault();
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
  });

  // Show the window only when the page is drawn, so it never flashes empty.
  window.once("ready-to-show", () => window.show());
  void window.loadURL(serverUrl);
}

// Not a top-level await: Electron only becomes "ready" after this file finishes loading.
void app.whenReady().then(async () => {
  serverUrl = await startServer(0, { openBrowser: (url) => void shell.openExternal(url) });
  openWindow();
});

// macOS: clicking the dock icon reopens the window; closing it keeps the app alive.
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) openWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
