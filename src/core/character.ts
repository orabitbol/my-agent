// The character: one state that says what the agent is doing right now.
// The brain holds the state; every screen (the floating character on the
// computer, later the device) only draws it. That is how one character can
// move between screens.

export const CHARACTER_STATES = [
  "resting",   // nothing is happening
  "ready",     // in a conversation, waiting for the user
  "listening", // the microphone is open
  "hearing",   // the user is speaking
  "thinking",  // working on an answer or running a tool
  "speaking",  // answering out loud
  "approval",  // waiting for the user to approve an action
] as const;
export type CharacterState = (typeof CHARACTER_STATES)[number];

export function isCharacterState(value: unknown): value is CharacterState {
  return (CHARACTER_STATES as readonly unknown[]).includes(value);
}

// What travels to the screens besides the state itself:
//   "poke":  the user clicked the character (start or stop talking)
//   "hold":  the user is holding the character down ("down") or let go ("up")
//   "level": how loud the agent's voice is right now, 0 to 1, so its mouth can follow
//   "vision": whether the agent may see the screen right now ("on" or "off")
//   "glance": it has just looked at the screen
export type CharacterSignal = "state" | "poke" | "hold" | "level" | "vision" | "glance";

export class Character {
  private current: CharacterState = "resting";
  private watchers = new Set<(signal: CharacterSignal, data: string) => void>();

  get state(): CharacterState {
    return this.current;
  }

  // Whether the agent may see the screen right now. Kept, like the state, so
  // the character can always show it: the user must never be watched unknowingly.
  private seeing = false;
  get vision(): boolean {
    return this.seeing;
  }
  setVision(on: boolean): void {
    if (on === this.seeing) return;
    this.seeing = on;
    this.signal("vision", on ? "on" : "off");
  }

  set(state: CharacterState): void {
    if (state === this.current) return;
    this.current = state;
    this.signal("state", state);
  }

  // Passes a passing event to every screen. Unlike the state, it is not kept.
  signal(signal: CharacterSignal, data = ""): void {
    for (const watcher of this.watchers) watcher(signal, data);
  }

  // Calls back on every change and event. Returns a function that stops watching.
  watch(watcher: (signal: CharacterSignal, data: string) => void): () => void {
    this.watchers.add(watcher);
    return () => void this.watchers.delete(watcher);
  }
}
