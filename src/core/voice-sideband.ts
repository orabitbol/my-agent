// The sideband: our server joins a voice call that is already running.
//
// When the user talks through the desk device, the sound travels directly
// between the device and OpenAI. The device is small and simple: it cannot
// run tools, hold keys or ask for approvals. So the server joins the same
// call over a second connection and does that part:
//   - when the model asks for a tool, it runs it through the same gate as
//     everything else (core/run-tool.ts) and hands the result back;
//   - it follows what is happening (listening, thinking, speaking), so the
//     character on the computer can show it;
//   - it ends a call that has gone quiet, so a forgotten device costs nothing.

import { config } from "./config.js";
import type { CharacterState } from "./character.js";
import { runTool } from "./run-tool.js";
import type { TurnHandlers } from "./run-tool.js";
import type { Tool } from "./tools/types.js";

const REALTIME = "api.openai.com/v1/realtime";
const IDLE_MS = 3 * 60_000;  // end the call after this much silence
const MAX_MS = 30 * 60_000;  // and never let one call run longer than this

// The little we need from a WebSocket, so a test can stand in for the real one.
export type Socket = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
};
type Connect = (url: string, headers: Record<string, string>) => Socket;

const connectForReal: Connect = (url, headers) =>
  // Node's own WebSocket takes headers this way (the browser's does not).
  new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => Socket)(url, { headers });

export type SidebandOptions = TurnHandlers & {
  onState?: (state: CharacterState) => void;
  connect?: Connect;
  // Said by the agent as soon as the call is up, before the user says anything ("בוקר טוב").
  opening?: string;
  idleMs?: number;
  maxMs?: number;
};

type RealtimeEvent = { type?: string; response_id?: string; response?: { id?: string }; item?: { type?: string; name?: string; arguments?: string; call_id?: string } };

/** Joins the call. Returns a function that leaves it, and a promise that resolves when it is over. */
export function attachToCall(callId: string, tools: Tool[], options: SidebandOptions = {}): { close: () => void; closed: Promise<void> } {
  const auth = { Authorization: `Bearer ${config.openaiApiKey}` };
  const socket = (options.connect ?? connectForReal)(`wss://${REALTIME}?call_id=${encodeURIComponent(callId)}`, auth);
  const started = Date.now();
  let lastActive = Date.now();
  let working = 0; // tools running right now
  let over = false;
  const jobs = new Map<string, Promise<void>[]>();
  // The model can only say one thing at a time. A tool that took a while (it waited
  // for an approval) may finish while the model is in the middle of another answer,
  // because the user kept talking. Asking it to continue right then is refused and the
  // result would never be spoken. So: if it is busy, remember that we owe it a turn.
  let answering = 0;
  let owed = false;
  const continueWhenFree = () => {
    if (answering > 0) return void (owed = true);
    owed = false;
    say({ type: "response.create" });
  };
  const say = (event: object) => {
    if (!over) socket.send(JSON.stringify(event));
  };
  const show = (state: CharacterState) => options.onState?.(state);

  async function runOne(item: NonNullable<RealtimeEvent["item"]>): Promise<void> {
    working++;
    show("thinking");
    try {
      const result = await runTool(tools, item.name ?? "", item.arguments ?? "{}", {
        onToolCall: options.onToolCall,
        approve: options.approve
          ? async (request) => {
              show("approval");
              const approved = await options.approve!(request);
              show("thinking");
              return approved;
            }
          : undefined,
      });
      say({ type: "conversation.item.create", item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify(result) } });
    } finally {
      working--;
      lastActive = Date.now();
    }
  }

  socket.addEventListener("message", (message) => {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(String(message.data)) as RealtimeEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        lastActive = Date.now();
        show("hearing");
        break;
      case "response.created":
        answering++;
        lastActive = Date.now();
        show("thinking");
        break;
      case "input_audio_buffer.speech_stopped":
        lastActive = Date.now();
        show("thinking");
        break;
      case "output_audio_buffer.started":
      case "response.output_audio_transcript.delta":
        show("speaking");
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        if (working === 0) show("listening");
        break;
      case "response.output_item.done":
        if (event.item?.type === "function_call" && event.response_id) {
          jobs.set(event.response_id, [...(jobs.get(event.response_id) ?? []), runOne(event.item)]);
        }
        break;
      case "response.done": {
        // If the model asked for tools, give it all the results, then let it continue.
        answering = Math.max(0, answering - 1);
        const id = event.response?.id ?? "";
        const waiting = jobs.get(id);
        if (waiting) {
          jobs.delete(id);
          void Promise.all(waiting).then(continueWhenFree);
        } else if (owed && answering === 0) continueWhenFree();
        else if (working === 0) show("listening");
        break;
      }
    }
  });

  let finish!: () => void;
  const closed = new Promise<void>((resolve) => (finish = resolve));
  const end = () => {
    if (over) return;
    over = true;
    clearInterval(watch);
    show("resting");
    finish();
  };
  socket.addEventListener("open", () => {
    show("listening");
    // The sound itself needs a moment to connect; a greeting sent at once would lose its first word.
    if (options.opening) setTimeout(() => say({ type: "response.create", response: { instructions: `Say out loud exactly this and nothing else: "${options.opening}". Then stop and listen.` } }), 1200).unref?.();
  });
  socket.addEventListener("close", end);
  socket.addEventListener("error", end);

  // Hang up a call nobody is using. The device can start a new one at any time.
  const idleMs = options.idleMs ?? IDLE_MS;
  const maxMs = options.maxMs ?? MAX_MS;
  const hangUp = () => {
    void fetch(`https://${REALTIME}/calls/${encodeURIComponent(callId)}/hangup`, { method: "POST", headers: auth }).catch(() => {});
    try {
      socket.close();
    } catch {
      // already closed
    }
    end();
  };
  const watch = setInterval(() => {
    if (working > 0) return;
    if (Date.now() - lastActive > idleMs || Date.now() - started > maxMs) hangUp();
  }, Math.min(5000, idleMs));
  watch.unref?.();

  return { close: hangUp, closed };
}
