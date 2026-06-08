// src/session.ts
import { homedir } from "os";
import { join } from "path";

export type SessionMode = "new" | "explicit" | "resume" | "continue";
export interface SessionResolution {
  sessionId: string | null;
  injectSessionId: boolean;
  mode: SessionMode;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function resolveSessionId(argv: string[], genId: () => string = () => crypto.randomUUID()): SessionResolution {
  const resume = flagValue(argv, "--resume") ?? flagValue(argv, "-r");
  if (resume) return { sessionId: resume, injectSessionId: false, mode: "resume" };
  if (argv.includes("--continue") || argv.includes("-c")) {
    return { sessionId: null, injectSessionId: false, mode: "continue" };
  }
  const explicit = flagValue(argv, "--session-id");
  if (explicit) return { sessionId: explicit, injectSessionId: false, mode: "explicit" };
  return { sessionId: genId(), injectSessionId: true, mode: "new" };
}

export function projectDirName(cwd: string): string {
  return cwd.replace(/[\\/:.]/g, "-");
}

const PROJECTS_ROOT = join(homedir(), ".claude", "projects");

/** Locate a transcript by exact session id (glob avoids recomputing the cwd hash). */
export async function findTranscriptById(sessionId: string): Promise<string | null> {
  const glob = new Bun.Glob(`**/${sessionId}.jsonl`);
  for await (const f of glob.scan({ cwd: PROJECTS_ROOT, absolute: true })) return f;
  return null;
}

/** Snapshot the set of transcript file paths for a cwd's project dir (used to detect a newly-created session, e.g. --continue which always forks a new file). */
export async function listTranscripts(cwd: string): Promise<string[]> {
  const dir = join(PROJECTS_ROOT, projectDirName(cwd));
  const glob = new Bun.Glob(`*.jsonl`);
  const out: string[] = [];
  try {
    for await (const f of glob.scan({ cwd: dir, absolute: true })) out.push(f);
  } catch {
    // Project dir doesn't exist yet (first session in this cwd) — return empty.
  }
  return out;
}
