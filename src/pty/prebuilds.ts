// src/pty/prebuilds.ts
//
// Repairs the executable bit on node-pty's prebuilt `spawn-helper`.
//
// On unix, node-pty spawns a pty by handing `spawn-helper` to posix_spawnp (see
// unixTerminal.js: `helperPath` → `pty.fork(...)`). The helper MUST be
// executable. `bun install` does not preserve the mode of files inside node-pty's
// prebuilds/ — they land as 0666 — so posix_spawnp fails with the opaque
// "posix_spawnp failed." and no pty is ever created.
//
// Fixing it at load time (rather than via a postinstall hook) covers every
// deployment shape uniformly: `bun install` in a checkout, an extracted release
// archive, and a compiled binary next to a bundled node_modules.

import { chmodSync, readdirSync, statSync } from "fs";
import { join } from "path";

/** Owner/group/other execute bits. */
const EXEC_BITS = 0o111;

/**
 * Add the execute bit to every `prebuilds/<triple>/spawn-helper` under
 * `nodePtyDir` that lacks it. Returns the paths actually changed (empty when
 * everything was already fine, or there is nothing to fix).
 *
 * Idempotent and total: a missing directory, an unreadable entry, or a chmod
 * denied by the filesystem is skipped rather than thrown, because a failure here
 * must never be worse than the status quo (node-pty may still work — e.g. on
 * Windows, or from a build/Release binding).
 */
export function ensureSpawnHelpersExecutable(nodePtyDir: string): string[] {
  const fixed: string[] = [];
  let triples: string[];
  try {
    triples = readdirSync(join(nodePtyDir, "prebuilds"));
  } catch {
    return fixed; // no prebuilds/ (source build, or wrong dir) — nothing to do
  }

  for (const triple of triples) {
    const helper = join(nodePtyDir, "prebuilds", triple, "spawn-helper");
    try {
      const mode = statSync(helper).mode & 0o777;
      if ((mode & EXEC_BITS) === EXEC_BITS) continue;
      chmodSync(helper, mode | EXEC_BITS);
      fixed.push(helper);
    } catch {
      // No helper for this triple, or a read-only install we cannot repair.
    }
  }
  return fixed;
}
