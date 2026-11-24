// Where the character is: on the computer's screen or on the desk device's.
//
// The server owns the move itself (it knows whether the device is reachable
// and tells both screens). This small file is the doorway to it, so a tool
// can ask for a move without knowing anything about servers or screens.

export type Place = "computer" | "device";

// Moves the character. Returns why it cannot, or null when it is on its way.
type Mover = (where: Place) => string | null;
let mover: Mover | null = null;

/** The server registers itself as the one that moves the character. */
export function setMover(move: Mover | null): void {
  mover = move;
}

/** Asks for a move. Throws, with the reason, when it cannot happen. */
export function moveCharacterTo(where: Place): void {
  if (!mover) throw new Error("The character cannot move right now: the desktop app is not running.");
  const refused = mover(where);
  if (refused) throw new Error(refused);
}
