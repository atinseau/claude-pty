// src/ipc.ts
//
// Tiny line-delimited-JSON framing for the client↔daemon loopback channel, plus
// endpoint-file / token helpers. Each frame is one JSON object on its own line.
//
// Wire vocabulary:
//   request  (client → daemon): { token, argv, cwd, env, stdin }
//   response (daemon → client): { s:"o"|"e", d:string }   (stdout / stderr chunk)
//                               { s:"x", c:number }        (final exit code)

import { homedir } from "os";
import { join } from "path";

export interface Endpoint {
  port: number;
  token: string;
  pid: number;
  /** claude-pty version + claude bin signature, to invalidate stale daemons. */
  v: string;
}

/** Per-user endpoint file describing the running daemon (loopback port + token). */
export function endpointPath(): string {
  return join(homedir(), ".claude-pty", "daemon.json");
}

/** Random 128-bit hex token used to authenticate client→daemon requests. */
export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Serialize one frame to a newline-terminated JSON line. */
export function encodeFrame(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

/**
 * Streaming decoder: feed it socket chunks, get back the complete frames parsed
 * so far. A partial trailing line (no newline yet) is buffered until completed.
 * Unparseable lines are skipped.
 */
export function createFrameDecoder() {
  let buf = "";
  return {
    push(chunk: string): unknown[] {
      buf += chunk;
      const out: unknown[] = [];
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > 0) {
          try {
            out.push(JSON.parse(line));
          } catch {
            /* skip malformed line */
          }
        }
        nl = buf.indexOf("\n");
      }
      return out;
    },
  };
}
