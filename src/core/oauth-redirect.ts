// The local half of every "sign in with ..." flow (Google, Zoom).
//
// After the user approves in the browser, the service sends the browser to an
// address on this computer, carrying a one-time code. This file runs the tiny
// server that receives it.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type RedirectListener = {
  /** The address to give the service as the redirect address. */
  redirectUri: string;
  /** Resolves with the one-time code, or rejects if the sign-in fails or is cancelled. */
  code: Promise<string>;
};

export function listenForRedirect(options: {
  port: number; // 0 = any free port
  path: string; // the path the service redirects to, for example "/"
  state: string; // the random value we sent; the redirect must bring it back
  cancel?: AbortSignal;
}): Promise<RedirectListener> {
  return new Promise((ready, failedToStart) => {
    let resolveCode: (code: string) => void = () => {};
    let rejectCode: (error: Error) => void = () => {};
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    code.catch(() => {}); // the caller handles it; this only avoids a warning if they are late

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== options.path) return void response.writeHead(404).end();

      const finish = (message: string) => {
        // "Connection: close" and closing everything after the reply: the browser must not
        // keep a line open to this server, or a later sign-in on the same port could be
        // answered by this finished one.
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
        response.end(
          `<!doctype html><meta charset="utf-8"><body dir="rtl" style="font:16px -apple-system,sans-serif;padding:48px">${message}</body>`,
          () => {
            server.close();
            server.closeAllConnections();
          },
        );
      };

      const error = url.searchParams.get("error");
      const received = url.searchParams.get("code");
      if (error || !received || url.searchParams.get("state") !== options.state) {
        finish("החיבור לא הושלם. אפשר לסגור את הלשונית ולנסות שוב.");
        rejectCode(new Error(error ? `The service returned: ${error}` : "The redirect was not valid."));
        return;
      }
      finish("החשבון חובר. אפשר לסגור את הלשונית ולחזור לאייג'נט.");
      resolveCode(received);
    });

    // We cannot see the browser, so we cannot know that its tab was closed.
    // Two ways out: the user cancels, or nothing happens for five minutes.
    const giveUp = (message: string) => {
      server.close();
      server.closeAllConnections();
      rejectCode(new Error(message));
    };
    options.cancel?.addEventListener("abort", () => giveUp("The connection was cancelled."), { once: true });
    setTimeout(() => giveUp("Timed out waiting for the approval in the browser."), 5 * 60 * 1000).unref();

    server.once("error", (error: NodeJS.ErrnoException) => {
      failedToStart(
        error.code === "EADDRINUSE"
          ? new Error(`Port ${options.port} is already in use on this computer. Close the other program and try again.`)
          : error,
      );
    });
    server.listen(options.port, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      ready({ redirectUri: `http://127.0.0.1:${port}${options.path === "/" ? "" : options.path}`, code });
    });
  });
}
