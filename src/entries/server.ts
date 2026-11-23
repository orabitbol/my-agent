// A small local web server. It serves the chat page and passes messages
// between the page and the agent. It holds no logic of its own: all the
// thinking is in core/agent.ts. Used by the desktop app and by the browser entry.

import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Agent } from "../core/agent.js";
import { connectAccount, describeAccounts, setDefaultAccount } from "../core/google/auth.js";
import { connectZoom, zoomStatus, ZOOM_REDIRECT_URI } from "../core/zoom/auth.js";
import { deleteFact, listFacts } from "../core/memory.js";

// Listen on this computer only. Nothing on the network can reach the agent.
const HOST = "127.0.0.1";
// The files the page is made of. Resolved from the project root, so this works
// from src/ and from the built dist/. Nothing outside this list is ever served.
const WEB = new URL("../../src/entries/web/", import.meta.url);
const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/tokens.css": { file: "tokens.css", type: "text/css; charset=utf-8" },
};

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body || "{}") as Record<string, unknown>;
}

export type ServerOptions = {
  agent?: Agent;
  // How to open an address in the user's browser. Needed for connecting a Google account.
  openBrowser?: (url: string) => void;
};

// Starts the server and returns its address. Port 0 means "any free port".
export function startServer(port: number, options: ServerOptions = {}): Promise<string> {
  const agent = options.agent ?? new Agent();

  // The state of the "connect a Google account" flow. The page polls it.
  type Connecting =
    | { state: "idle" }
    | { state: "waiting"; url: string; cancel: AbortController }
    | { state: "done"; email: string }
    | { state: "failed"; error: string };
  let connecting: Connecting = { state: "idle" };

  // Starts a sign-in and returns as soon as the consent address is known.
  // Starting again while one is waiting replaces it.
  async function startConnecting(openBrowser: (url: string) => void, service: "google" | "zoom"): Promise<void> {
    const connect = service === "zoom" ? connectZoom : connectAccount;
    if (connecting.state === "waiting") connecting.cancel.abort();
    const cancel = new AbortController();

    await new Promise<void>((ready) => {
      connect((url) => {
        connecting = { state: "waiting", url, cancel };
        openBrowser(url);
        ready();
      }, cancel.signal)
        .then((email) => {
          connecting = { state: "done", email };
        })
        .catch((error: unknown) => {
          // A cancelled attempt leaves no trace; a newer attempt may already be running.
          if (cancel.signal.aborted) {
            if (connecting.state === "waiting" && connecting.cancel === cancel) connecting = { state: "idle" };
          } else {
            connecting = { state: "failed", error: error instanceof Error ? error.message : String(error) };
          }
          ready();
        });
    });
  }

  // Approvals the page has been asked for and has not answered yet.
  const waitingApprovals = new Map<string, (approved: boolean) => void>();

  const server = createServer(async (request, response) => {
    try {
      // Only this app's own page may talk to the server. A web page open in the
      // user's browser can try to send requests to 127.0.0.1; the browser marks
      // those with the page's Origin, and we refuse any Origin that is not ours.
      const host = request.headers.host ?? "";
      const origin = request.headers.origin;
      const ownHost = /^(127\.0\.0\.1|localhost):\d+$/.test(host);
      if (!ownHost || (origin !== undefined && origin !== `http://${host}`)) {
        response.writeHead(403).end();
        return;
      }

      const page = request.method === "GET" ? FILES[request.url ?? ""] : undefined;
      if (page) {
        response.writeHead(200, { "Content-Type": page.type });
        response.end(await readFile(new URL(page.file, WEB)));
        return;
      }

      if (request.method === "POST" && request.url === "/api/reset") {
        agent.reset();
        response.writeHead(204).end();
        return;
      }

      // The reply is a stream of JSON lines, so the page can show each tool call
      // the moment it happens, before the final answer arrives.
      if (request.method === "POST" && request.url === "/api/chat") {
        const { text } = await readJson(request);
        response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
        const write = (event: object) => response.write(JSON.stringify(event) + "\n");

        // If the page goes away mid-turn, every open question counts as "no".
        const mine = new Set<string>();
        response.on("close", () => mine.forEach((id) => waitingApprovals.get(id)?.(false)));

        try {
          const reply = await agent.send(String(text ?? ""), {
            onToolCall: (call) => write({ type: "tool", ...call }),
            // Ask the page, then wait for its answer on /api/approve.
            approve: ({ tool, summary }) =>
              new Promise<boolean>((resolve) => {
                const id = randomUUID();
                mine.add(id);
                waitingApprovals.set(id, (approved) => {
                  waitingApprovals.delete(id);
                  mine.delete(id);
                  resolve(approved);
                });
                write({ type: "approval", id, tool, summary });
              }),
          });
          write({ type: "reply", text: reply });
        } catch (error) {
          write({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
        response.end();
        return;
      }

      const sendJson = (status: number, body: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(body));
      };

      if (request.method === "GET" && request.url === "/api/accounts") {
        sendJson(200, {
          accounts: await describeAccounts(),
          canConnect: options.openBrowser !== undefined,
          zoom: { ...(await zoomStatus()), redirectUri: ZOOM_REDIRECT_URI },
        });
        return;
      }

      // ---- memory: the user can always see and delete what the agent remembers ----
      if (request.method === "GET" && request.url === "/api/memory") {
        sendJson(200, { facts: await listFacts() });
        return;
      }
      if (request.method === "POST" && request.url === "/api/memory/delete") {
        const { id } = await readJson(request);
        await deleteFact(Number(id));
        sendJson(200, { facts: await listFacts() });
        return;
      }

      // ---- connecting a Google account ----
      const connectStatus = () =>
        connecting.state === "waiting" ? { state: "waiting", url: connecting.url } : connecting;

      if (request.method === "GET" && request.url === "/api/accounts/connect") {
        sendJson(200, connectStatus());
        // A finished attempt is reported once, then forgotten.
        if (connecting.state === "done" || connecting.state === "failed") connecting = { state: "idle" };
        return;
      }
      if (request.method === "POST" && request.url === "/api/accounts/connect") {
        if (!options.openBrowser) return sendJson(501, { state: "failed", error: "This entry cannot open a browser." });
        const { service } = await readJson(request);
        await startConnecting(options.openBrowser, service === "zoom" ? "zoom" : "google");
        sendJson(200, connectStatus());
        return;
      }
      // Opens the same consent page again (for example after the tab was closed).
      if (request.method === "POST" && request.url === "/api/accounts/connect/open") {
        if (connecting.state === "waiting") options.openBrowser?.(connecting.url);
        sendJson(200, connectStatus());
        return;
      }
      if (request.method === "POST" && request.url === "/api/accounts/connect/cancel") {
        if (connecting.state === "waiting") connecting.cancel.abort();
        connecting = { state: "idle" };
        sendJson(200, connectStatus());
        return;
      }
      if (request.method === "POST" && request.url === "/api/accounts/default") {
        const { email } = await readJson(request);
        try {
          await setDefaultAccount(String(email));
          sendJson(200, { accounts: await describeAccounts() });
        } catch (error) {
          sendJson(400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (request.method === "POST" && request.url === "/api/approve") {
        const { id, approved } = await readJson(request);
        const answer = waitingApprovals.get(String(id));
        if (!answer) return void response.writeHead(404).end();
        answer(approved === true); // anything except an explicit yes is a no
        response.writeHead(204).end();
        return;
      }

      response.writeHead(404).end();
    } catch (error) {
      console.error(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      const address = server.address() as AddressInfo;
      resolve(`http://${HOST}:${address.port}`);
    });
  });
}
