// The only bridge between the character's page and the app. The page stays a
// plain web page: it can report what the user did to the character, and hear
// how to move. Nothing else. (CommonJS, because Electron requires that here.)

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("characterWindow", {
  // What the user did to the character.
  click: () => ipcRenderer.send("character:click"),
  hold: (down: boolean) => ipcRenderer.send("character:hold", down === true),
  dragStart: () => ipcRenderer.send("character:drag", true),
  dragEnd: () => ipcRenderer.send("character:drag", false),
  // What the character is doing now, so the app knows when it may wander.
  state: (state: string) => ipcRenderer.send("character:state", String(state)),
  // What the app tells the character: "hop", "attention", "asleep".
  listen: (handler: (name: string, data: unknown) => void) => {
    ipcRenderer.on("character:event", (_event, name: string, data: unknown) => handler(name, data));
  },
});
