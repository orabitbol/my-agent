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
import { Character, isCharacterState } from "../core/character.js";
import { deleteFact, listFacts } from "../core/memory.js";
import { runTool } from "../core/run-tool.js";
import type { Approver } from "../core/run-tool.js";
import { tools as allTools } from "../core/tools/index.js";
import type { Tool } from "../core/tools/types.js";
import { startVoiceSession } from "../core/voice.js";
import type { ServerResponse } from "node:http";

// Listen on this computer only. Nothing on the network can reach the agent.
const HOST = "127.0.0.1";
// The files the page is made of. Resolved from the project root, so this works
// from src/ and from the built dist/. Nothing outside this list is ever served.
const WEB = new URL("../../src/entries/web/", import.meta.url);
const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/tokens.css": { file: "tokens.css", type: "text/css; charset=utf-8" },
  "/character": { file: "character.html", type: "text/html; charset=utf-8" },
};

async function readText(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return JSON.parse((await readText(request)) || "{}") as Record<string, unknown>;
}

export type ServerOptions = {
  agent?: Agent;
  // How to open an address in the user's browser. Needed for connecting a Google account.
  openBrowser?: (url: string) => void;
  // The tools the voice conversation may use. Defaults to all of them.
  tools?: Tool[];
  // Asks the operating system for the microphone, where that is needed (the desktop app).
  prepareMicrophone?: () => Promise<boolean>;
};

// Starts the server and returns its address. Port 0 means "any free port".
export function startServer(port: number, options: ServerOptions = {}): Promise<string> {
  const agent = options.agent ?? new Agent();
  const voiceTools = options.tools ?? allTools;
  // What the agent is doing right now. The chat page reports it, the character draws it.
  const character = new Character();

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

  // Builds the "ask the user" function for one streamed reply: it sends the
  // question down the stream, then waits for the page's answer on /api/approve.
  // If the page goes away before answering, every open question counts as "no".
  function askThePage(response: ServerResponse, write: (event: object) => void): Approver {
    const mine = new Set<string>();
    response.on("close", () => mine.forEach((id) => waitingApprovals.get(id)?.(false)));
    return ({ tool, summary }) =>
      new Promise<boolean>((resolve) => {
        const id = randomUUID();
        mine.add(id);
        waitingApprovals.set(id, (approved) => {
          waitingApprovals.delete(id);
          mine.delete(id);
          resolve(approved);
        });
        write({ type: "approval", id, tool, summary });
      });
  }

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

        try {
          const reply = await agent.send(String(text ?? ""), {
            onToolCall: (call) => write({ type: "tool", ...call }),
            approve: askThePage(response, write),
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

      // ---- the character ----
      // The chat page says what the agent is doing right now.
      if (request.method === "POST" && request.url === "/api/character") {
        const { state } = await readJson(request);
        if (!isCharacterState(state)) return void response.writeHead(400).end();
        character.set(state);
        response.writeHead(204).end();
        return;
      }
      // A click on the character, or holding it down. The chat page acts on it.
      if (request.method === "POST" && request.url === "/api/character/poke") {
        character.signal("poke");
        response.writeHead(204).end();
        return;
      }
      if (request.method === "POST" && request.url === "/api/character/hold") {
        const { down } = await readJson(request);
        character.signal("hold", down === true ? "down" : "up");
        response.writeHead(204).end();
        return;
      }
      // How loud the agent's voice is right now, so the character's mouth can follow it.
      if (request.method === "POST" && request.url === "/api/character/level") {
        const level = Number((await readJson(request)).level);
        if (!(level >= 0 && level <= 1)) return void response.writeHead(400).end();
        character.signal("level", level.toFixed(2));
        response.writeHead(204).end();
        return;
      }
      // Every screen listens here (server-sent events): it gets the state now and
      // on every change, and the passing events (poke, hold, level) by name.
      if (request.method === "GET" && request.url === "/api/character") {
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
        const send = (signal: string, data: string) =>
          response.write(signal === "state" ? `data: ${data}\n\n` : `event: ${signal}\ndata: ${data}\n\n`);
        send("state", character.state);
        response.on("close", character.watch(send));
        return;
      }

      // ---- voice ----
      // Starts a spoken conversation: the page sends its WebRTC offer, we return OpenAI's answer.
      if (request.method === "POST" && request.url === "/api/voice/session") {
        try {
          if (options.prepareMicrophone && !(await options.prepareMicrophone())) {
            return sendJson(403, { error: "אין הרשאה למיקרופון. אפשר לאשר אותה בהגדרות המערכת, תחת פרטיות ואבטחה > מיקרופון." });
          }
          sendJson(200, await startVoiceSession(await readText(request), voiceTools));
        } catch (error) {
          sendJson(502, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      // Runs one tool the voice model asked for, through the same gate as the text chat.
      // Streams what happens (the tool call, an approval question), then the result.
      if (request.method === "POST" && request.url === "/api/voice/tool") {
        const { name, arguments: rawArguments } = await readJson(request);
        response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
        const write = (event: object) => response.write(JSON.stringify(event) + "\n");
        const result = await runTool(voiceTools, String(name ?? ""), typeof rawArguments === "string" ? rawArguments : "{}", {
          onToolCall: (call) => write({ type: "tool", ...call }),
          approve: askThePage(response, write),
        });
        write({ type: "result", output: JSON.stringify(result) });
        response.end();
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
