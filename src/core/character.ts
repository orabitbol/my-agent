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

export class Character {
  private current: CharacterState = "resting";
  private watchers = new Set<(state: CharacterState) => void>();

  get state(): CharacterState {
    return this.current;
  }

  set(state: CharacterState): void {
    if (state === this.current) return;
    this.current = state;
    for (const watcher of this.watchers) watcher(state);
  }

  // Calls back on every change. Returns a function that stops watching.
  watch(watcher: (state: CharacterState) => void): () => void {
    this.watchers.add(watcher);
    return () => void this.watchers.delete(watcher);
  }
}
