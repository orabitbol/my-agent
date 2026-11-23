// Browser entry: the same chat page, opened in a normal browser tab.
// Useful for development. The main way to use the agent is the desktop app.

import { execFile } from "node:child_process";
import { startServer } from "./server.js";

const url = await startServer(Number(process.env.PORT ?? 3000), {
  openBrowser: (address) => void execFile("open", [address]),
});
console.log(`The agent is ready: ${url}`);
