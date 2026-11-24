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
import { DEVICE_VOICES, deviceSettings, fillDeviceSettings, loadSettings, saveSettings } from "../core/settings.js";
import { attachToCall } from "../core/voice-sideband.js";
import type { SidebandOptions } from "../core/voice-sideband.js";
import { timingSafeEqual, createHash } from "node:crypto";
import { setMover } from "../core/place.js";
import { trace, traceLines } from "../core/trace.js";
import { reportSenses, senses } from "../core/senses.js";
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
  // The same character, on the see-through sheet it glides across (see character-window.ts).
  "/stage": { file: "character.html", type: "text/html; charset=utf-8" },
};

async function readText(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return JSON.parse((await readText(request)) || "{}") as Record<string, unknown>;
}

// One picture of one screen, ready to hand to the voice model.
export type Screenshot = { id: string; label: string; image: string };

export type ServerOptions = {
  agent?: Agent;
  // How to open an address in the user's browser. Needed for connecting a Google account.
  openBrowser?: (url: string) => void;
  // The tools the voice conversation may use. Defaults to all of them.
  tools?: Tool[];
  // Asks the operating system for the microphone, where that is needed (the desktop app).
  prepareMicrophone?: () => Promise<boolean>;
  // Takes a picture of every screen, each no bigger than the given size. Only the desktop app can.
  captureScreens?: (maxBytes: number) => Promise<Screenshot[]>;
  // Called when the user must approve something, so the entry can bring the question into view.
  onApprovalAsked?: () => void;
  // The character moved: "device" means it left this computer for the desk device's screen.
  onCharacterPlace?: (where: "computer" | "device") => void;
  // The desk device (see startDeviceDoor below). Without it, nothing listens on the network.
  device?: { port: number; key: string; connect?: SidebandOptions["connect"] };
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
        options.onApprovalAsked?.();
      });
  }

  // Asks the user to approve an action when there is no chat reply to ask in
  // (the desk device). The question goes to every open screen; the chat window
  // shows the card. No answer within three minutes counts as "no".
  const askAnywhere: Approver = ({ tool, summary }) =>
    new Promise<boolean>((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => waitingApprovals.get(id)?.(false), 3 * 60_000);
      waitingApprovals.set(id, (approved) => {
        clearTimeout(timer);
        waitingApprovals.delete(id);
        resolve(approved);
      });
      character.signal("approval", JSON.stringify({ id, tool, summary }));
      options.onApprovalAsked?.();
    });

  // THE DEVICE'S DOOR. The main server above answers only this computer. The
  // desk device is another machine on the home network, so it gets a door of
  // its own: a second, tiny server that knows exactly one request, "start a
  // voice call", and answers it only to someone who shows the device's key.
  // The device sends its WebRTC offer; we open the call at OpenAI with our key,
  // our instructions and our tools, join the call ourselves to run the tools,
  // and send back OpenAI's answer. No key and no tool ever lives on the device.
  // When the device last asked us anything, and whether it is in a call.
  let lastSeen = 0;
  let deviceStatus: (() => { connected: boolean; inCall: boolean }) | null = null;

  // ---- where the character is ----
  // It is on ONE screen at a time: the computer's, or the desk device's while
  // the user talks through the device. A move is always "leave first, then
  // arrive": the side it leaves plays its goodbye, and only then the other
  // side is told to show it.
  const LEAVE_COMPUTER_MS = 650; // the computer's goodbye
  const LEAVE_DEVICE_MS = 550;   // the device's goodbye
  let place: "computer" | "device" = "computer";
  let onDevice = false; // what the device is told: draw the character or stay dark
  let wanted = false;   // the user's decision: the character should be on the device
  let buttonMuted = false; // the mute button on the device itself is on
  let arriving: NodeJS.Timeout | undefined;
  // What the device is told changes: wake the questions it left open with us.
  let deviceVersion = 1;
  const deviceWaiters = new Set<() => void>();
  const tellDevice = () => {
    deviceVersion++;
    for (const answer of [...deviceWaiters]) answer();
  };
  function moveCharacter(where: "computer" | "device", deviceReachable = true): void {
    if (where === place) return;
    place = where;
    trace("app", `the character moves to the ${where}`);
    clearTimeout(arriving);
    character.signal("place", where); // the chat page ends its own voice conversation when it leaves
    if (where === "device") {
      options.onCharacterPlace?.("device");
      arriving = setTimeout(() => { onDevice = true; tellDevice(); }, LEAVE_COMPUTER_MS);
    } else {
      const wasThere = onDevice;
      onDevice = false;
      tellDevice();
      // A device that is switched off has no goodbye to wait for.
      arriving = setTimeout(() => options.onCharacterPlace?.("computer"), wasThere && deviceReachable ? LEAVE_DEVICE_MS : 0);
    }
  }
  // While it is on the device, the device draws what the agent is doing.
  character.watch((signal) => { if (signal === "state" && onDevice) tellDevice(); });

  function startDeviceDoor(device: NonNullable<ServerOptions["device"]>): void {
    const sameKey = (given: string) =>
      timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(device.key).digest());
    let current: { close: () => void } | null = null;
    deviceStatus = () => ({ connected: deviceWaiters.size > 0 || Date.now() - lastSeen < 8000, inCall: current !== null });

    // The user decides where the character is: a touch on the device's screen
    // calls it over or sends it back, and so does telling it to move.
    // "wanted" is that decision. The device is then told two things: show the
    // character, and run a voice call. It never starts a call by itself.
    const CALL_MUST_START_MS = 20_000;
    let wantedSince = 0;
    let pending: NodeJS.Timeout | undefined;
    let greetNext = false; // woken by claps: it says hello first
    const greeting = () => {
      const hour = new Date().getHours();
      return hour >= 5 && hour < 12 ? "בוקר טוב" : hour < 17 ? "צהריים טובים" : hour < 22 ? "ערב טוב" : "לילה טוב";
    };
    const want = (on: boolean, greet = false) => {
      clearTimeout(pending);
      if (on === wanted) return;
      wanted = on;
      greetNext = on && greet;
      trace("app", on ? `the character is wanted on the device${greet ? " (with a greeting)" : ""}` : "the character is sent back to the computer");
      wantedSince = Date.now();
      if (on) character.set("thinking"); // on its way, the call is still connecting
      else {
        current?.close();
        current = null;
        character.set("resting");
      }
      tellDevice();
      settle();
    };
    let wasConnected = false;
    const settle = () => {
      const { connected } = deviceStatus!();
      if (connected !== wasConnected) trace("app", connected ? "the device is connected" : "the device stopped answering");
      wasConnected = connected;
      if (wanted && current === null && Date.now() - wantedSince > CALL_MUST_START_MS) trace("app", "the device did not start a call in time");
      // A device that went away, or a call that never started: it comes home.
      if (wanted && (!connected || (current === null && Date.now() - wantedSince > CALL_MUST_START_MS))) return void want(false);
      moveCharacter(wanted && connected ? "device" : "computer", connected);
    };
    setInterval(settle, 1000).unref();
    // Asked for in words ("לך למקום"): it moves a moment later, so it can finish its word first.
    setMover((where) => {
      if (where === "device" && !deviceStatus!().connected) return "The desk device is not connected right now, so you cannot move to it. Tell him that.";
      clearTimeout(pending);
      pending = setTimeout(() => want(where === "device"), 1800);
      return null;
    });

    const door = createServer(async (request, response) => {
      try {
        const asked = new URL(request.url ?? "/", "http://device");
        const asksSettings = request.method === "GET" && asked.pathname === "/device/settings";
        const touched = request.method === "POST" && asked.pathname === "/device/touch";
        const woken = request.method === "POST" && asked.pathname === "/device/wake";
        const notes = request.method === "POST" && asked.pathname === "/device/log";
        const sensed = request.method === "POST" && asked.pathname === "/device/sense";
        const muteButton = request.method === "POST" && asked.pathname === "/device/mute";
        if (!asksSettings && !touched && !woken && !notes && !sensed && !muteButton && (request.method !== "POST" || request.url !== "/device/voice")) return void response.writeHead(404).end();
        const given = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (!given || !sameKey(given)) return void response.writeHead(401).end();
        lastSeen = Date.now();

        // The mute button on the device itself: the microphones are off in the hardware.
        if (muteButton) {
          let text = "";
          for await (const chunk of request) {
            text += chunk;
            if (text.length > 200) break;
          }
          const now = /"muted"\s*:\s*true/.test(text);
          if (now !== buttonMuted) trace("device", now ? "muted with the button on the device" : "the mute button was released");
          buttonMuted = now;
          return void response.writeHead(204).end();
        }

        // What the device senses: the room's temperature and humidity.
        if (sensed) {
          let text = "";
          for await (const chunk of request) {
            text += chunk;
            if (text.length > 1000) break;
          }
          try {
            reportSenses(JSON.parse(text) as Record<string, unknown>);
          } catch {
            return void response.writeHead(400).end();
          }
          return void response.writeHead(204).end();
        }

        // The device's own log lines, so they can be read here instead of in a terminal.
        if (notes) {
          let text = "";
          for await (const chunk of request) {
            text += chunk;
            if (text.length > 8000) break;
          }
          for (const line of text.split("\n")) if (line.trim()) trace("device", line.replace(/\x1b\[[0-9;]*m/g, ""));
          return void response.writeHead(204).end();
        }

        // A touch on the device's screen: call the character over, or send it back.
        if (touched) {
          trace("device", "the screen was touched");
          request.resume();
          want(!wanted);
          return void response.writeHead(204).end();
        }

        // Two claps near the device: it comes over and says hello. Never sends it back.
        if (woken) {
          request.resume();
          const listens = (await deviceSettings()).claps;
          trace("device", `two claps${listens ? "" : " (ignored: switched off in the settings)"}`);
          if (listens) want(true, true);
          return void response.writeHead(204).end();
        }

        // The device keeps this question open: "anything new since version v?".
        // We answer the moment there is, or after a few seconds with the same
        // answer. The asking itself is how we know the device is switched on.
        if (asksSettings) {
          if (Number(asked.searchParams.get("v")) === deviceVersion) {
            await new Promise<void>((answer) => {
              const done = () => { clearTimeout(timer); deviceWaiters.delete(done); answer(); };
              const timer = setTimeout(done, 5000);
              deviceWaiters.add(done);
              request.on("close", done);
            });
            if (response.destroyed) return;
            lastSeen = Date.now();
          }
          const { volume, muted, claps } = await deviceSettings();
          const body = JSON.stringify({ v: deviceVersion, volume, muted, claps, here: onDevice, call: wanted, face: character.state });
          response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
          return void response.end(body);
        }

        let offer = "";
        for await (const chunk of request) {
          offer += chunk;
          if (offer.length > 64_000) return void response.writeHead(413).end();
        }
        trace("device", "asks to start a voice call");
        if (!wanted) want(true); // a call the device started by itself also brings the character over
        const chosen = await deviceSettings();
        const { answerSdp, callId } = await startVoiceSession(offer, voiceTools, "device", { voice: chosen.voice, hebrewOnly: chosen.language === "he" });
        // One device, one call: a new call replaces the one before it.
        current?.close();
        current = null;
        if (callId) {
          const call = attachToCall(callId, voiceTools, {
            connect: device.connect,
            opening: greetNext ? greeting() : undefined,
            approve: askAnywhere,
            onState: (state) => { trace("call", state); character.set(state); },
          });
          current = call;
          greetNext = false;
          trace("call", `started (${callId})`);
          void call.closed.then(() => {
            trace("call", `ended (${callId})`);
            if (current !== call) return;
            current = null;
            want(false); // the call ended (a long silence, or the device hung up): it goes home
          });
        }
        // With its length stated, so the device gets the answer in one piece.
        response.writeHead(200, { "Content-Type": "application/sdp", "Content-Length": Buffer.byteLength(answerSdp) });
        response.end(answerSdp);
      } catch (error) {
        console.error("device:", error instanceof Error ? error.message : error);
        trace("app", `the device's request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
    door.on("error", (error) => console.error("The device's door could not open:", error.message));
    door.listen(device.port, "0.0.0.0", () => trace("app", `waiting for the device on port ${device.port}`));
  }
  if (options.device) {
    if (options.device.key.length >= 32) startDeviceDoor(options.device);
    else console.error("The device's door stays closed: DEVICE_KEY must be at least 32 characters.");
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

      const sendJson = (status: number, body: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(body));
      };

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

      // The technical log, for the "לוגים" tab.
      if (request.method === "GET" && request.url === "/api/trace") {
        sendJson(200, { lines: traceLines() });
        return;
      }

      // The desk device: its light (is it switched on and reaching us) and its settings.
      if (request.url === "/api/device" && (request.method === "GET" || request.method === "POST")) {
        if (request.method === "POST") {
          const asked = await readJson(request);
          const settings = await loadSettings();
          const allowed = Object.fromEntries(Object.entries(asked).filter(([name]) => ["volume", "muted", "voice", "language", "claps"].includes(name)));
          settings.device = fillDeviceSettings({ ...settings.device, ...allowed });
          await saveSettings(settings);
          tellDevice();
        }
        sendJson(200, { enabled: deviceStatus !== null, ...(deviceStatus?.() ?? { connected: false, inCall: false }), characterOn: place, buttonMuted: deviceStatus?.().connected === true && buttonMuted, senses: senses(), settings: await deviceSettings(), voices: DEVICE_VOICES });
        return;
      }

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
      // The agent turned to the user by itself (see core/initiative.ts). The chat shows it too.
      if (request.method === "POST" && request.url === "/api/character/nudge") {
        const said = String((await readJson(request)).text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
        if (!said) return void response.writeHead(400).end();
        character.signal("nudge", said);
        response.writeHead(204).end();
        return;
      }
      // Whether the agent may see the screen right now, and the moment it looks.
      if (request.method === "POST" && request.url === "/api/character/vision") {
        character.setVision((await readJson(request)).on === true);
        response.writeHead(204).end();
        return;
      }
      // The user's screens, as pictures. Asked for by the chat page when the user
      // starts speaking with vision switched on. Never saved, never sent anywhere from here.
      if (request.method === "GET" && request.url?.startsWith("/api/screens")) {
        if (!options.captureScreens) return sendJson(501, { error: "רק אפליקציית הדסקטופ יכולה לראות את המסך." });
        const asked = Number(new URL(request.url, "http://localhost").searchParams.get("max"));
        const maxBytes = Math.min(Math.max(Number.isFinite(asked) ? asked : 0, 40_000), 1_000_000);
        try {
          const screens = await options.captureScreens(maxBytes);
          character.signal("glance");
          sendJson(200, { screens });
        } catch (error) {
          sendJson(403, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      // Every screen listens here (server-sent events): it gets the state now and
      // on every change, and the passing events (poke, hold, level) by name.
      if (request.method === "GET" && request.url === "/api/character") {
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
        const send = (signal: string, data: string) =>
          response.write(signal === "state" ? `data: ${data}\n\n` : `event: ${signal}\ndata: ${data}\n\n`);
        send("state", character.state);
        if (character.vision) send("vision", "on");
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
          const { answerSdp, transcription } = await startVoiceSession(await readText(request), voiceTools);
          sendJson(200, { answerSdp, transcription });
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
