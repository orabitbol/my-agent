// The agent's eyes on the computer: one picture of every connected screen.
// A picture is taken only when the chat page asks for one, which it does only
// while "vision" is switched on in a spoken conversation. Nothing is saved to disk.

import { desktopCapturer, screen, systemPreferences } from "electron";
import type { Screenshot } from "./server.js";

// Big enough to read normal text, small enough to stay cheap.
const LONGEST_SIDE = 1600;

// Shrinks a picture until it fits the size the voice connection can carry.
function fit(image: Electron.NativeImage, maxBytes: number): { jpeg: Buffer; width: number; height: number } {
  let smallest = { jpeg: image.toJPEG(40), ...image.getSize() };
  for (const scale of [1, 0.8, 0.64, 0.5]) {
    const { width } = image.getSize();
    const scaled = scale === 1 ? image : image.resize({ width: Math.round(width * scale), quality: "best" });
    for (const quality of [70, 55, 40]) {
      smallest = { jpeg: scaled.toJPEG(quality), ...scaled.getSize() };
      if (smallest.jpeg.length <= maxBytes) return smallest;
    }
  }
  return smallest;
}

export async function captureScreens(maxBytes: number): Promise<Screenshot[]> {
  if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    // Asking for the screens makes macOS show its permission question the first time.
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
    if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
      throw new Error("אין הרשאה לראות את המסך. צריך לאשר אותה בהגדרות המערכת, תחת פרטיות ואבטחה > הקלטת מסך, ואז להפעיל את האפליקציה מחדש.");
    }
  }

  const primary = String(screen.getPrimaryDisplay().id);
  const withPointer = String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
  const sources = (await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: LONGEST_SIDE, height: LONGEST_SIDE } }))
    .filter((source) => !source.thumbnail.isEmpty());

  return sources.map((source, index) => {
    const notes = [source.display_id === primary ? "the primary screen" : "", source.display_id === withPointer ? "the mouse pointer is on this screen" : ""].filter(Boolean);
    const picture = fit(source.thumbnail, maxBytes);
    return {
      id: source.display_id || source.id,
      label: `Current screenshot: screen ${index + 1} of ${sources.length}${notes.length ? ` (${notes.join("; ")})` : ""}.`,
      image: "data:image/jpeg;base64," + picture.jpeg.toString("base64"),
    };
  });
}
