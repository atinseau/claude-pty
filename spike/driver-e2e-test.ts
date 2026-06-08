// spike/driver-e2e-test.ts
// Quick end-to-end validation of src/driver.ts using the real Claude binary.
// NOT committed as a regular test — run manually during calibration.
// Usage: bun run spike/driver-e2e-test.ts

import { startSession } from "../src/driver";
import { randomUUID } from "crypto";

const SESSION_ID = randomUUID();
console.log(`[e2e] session-id: ${SESSION_ID}`);

const config = {
  message: "Reply with exactly: pong",
  sessionId: SESSION_ID,
  outputFormat: "text" as const,
  verbose: false,
  passthrough: ["--permission-mode", "bypassPermissions"],
};

const t0 = Date.now();
let readyFired = false;
let doneFired = false;

const pty = startSession(config, {
  onReady: () => {
    readyFired = true;
    console.log(`[e2e] onReady fired at +${Date.now() - t0}ms`);
  },
  onTurnDone: () => {
    doneFired = true;
    console.log(`[e2e] onTurnDone fired at +${Date.now() - t0}ms`);
    pty.kill();

    // Check transcript
    import("fs").then(({ readdirSync, existsSync }) => {
      const base = process.env.HOME ?? process.env.USERPROFILE ?? "";
      const projectsDir = base + "\\.claude\\projects";
      console.log(`[e2e] looking for transcript in: ${projectsDir}`);

      // Glob for the session file
      const found = findFile(projectsDir, SESSION_ID + ".jsonl");
      if (found) {
        console.log(`[e2e] PASS: transcript found at ${found}`);
      } else {
        console.log(`[e2e] WARN: transcript NOT found for ${SESSION_ID}`);
      }

      console.log(`[e2e] Results: onReady=${readyFired} onTurnDone=${doneFired}`);
      process.exit(readyFired && doneFired ? 0 : 1);
    });
  },
});

function findFile(dir: string, name: string): string | null {
  const { readdirSync, statSync, existsSync } = require("fs");
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    const full = dir + "\\" + entry;
    if (entry === name) return full;
    try {
      if (statSync(full).isDirectory()) {
        const found = findFile(full, name);
        if (found) return found;
      }
    } catch {}
  }
  return null;
}

// Timeout after 30s
setTimeout(() => {
  console.log(`[e2e] TIMEOUT: onReady=${readyFired} onTurnDone=${doneFired}`);
  pty.kill();
  process.exit(1);
}, 30000);
