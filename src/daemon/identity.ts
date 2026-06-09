// src/daemon/identity.ts
//
// Build identity shared by the daemon server and client, so a client never talks
// to a daemon from a DIFFERENT build (which would serve stale behaviour).
//
// Derived from the size+mtime of the running binary and the claude binary — both
// change on rebuild/upgrade — so a rebuilt client's probe sees a version mismatch
// and spawns a fresh daemon. The stale daemon then idles out. (A hard-coded
// constant would never invalidate.)

import { statSync } from "fs";
import { CLAUDE_BIN } from "../pty/session";
import { fnv1a } from "./signature";

function buildSignature(): string {
  const parts: string[] = [];
  for (const p of [process.execPath, CLAUDE_BIN]) {
    try {
      const s = statSync(p);
      parts.push(`${p}:${s.size}:${Math.floor(s.mtimeMs)}`);
    } catch {
      parts.push(`${p}:?`);
    }
  }
  return fnv1a(parts.join("|"));
}

/** This build's identity string, embedded in the endpoint file and probed by clients. */
export const PROTOCOL_VERSION = buildSignature();
