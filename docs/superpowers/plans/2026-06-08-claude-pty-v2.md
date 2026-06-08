# claude-pty v2 Implementation Plan (full `claude -p` parity)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend claude-pty to reproduce `claude -p` as faithfully as possible: real-time `stream-json`, stdin, error detection + exit codes, auto-deny permissions, and resume/continue/structured/multi-turn input.

**Architecture:** Pivot from batch (read transcript after the turn) to a unified live tail loop: a `tailer` emits transcript events as the JSONL grows; the formatter decides when to emit (`stream-json` live, `text`/`json` buffered). The pty still only yields signals (ready / done / permission-box); all content comes from the JSONL.

**Tech Stack:** Bun + TypeScript, node-pty (loaded via createRequire per v1 driver), `bun test`, `bun build --compile`.

**North star:** every choice is judged by "does it match `claude -p`'s observable output / cadence / exit code?"

---

## Existing v1 APIs (build on these, do not rewrite)

- `src/types.ts`: `Usage`, `ContentBlock`, `TranscriptEvent` (`{kind:"assistant",model,content,usage,stop_reason,timestamp,uuid} | {kind:"user",content,timestamp,uuid} | {kind:"ignored"}`), `ResultObject`.
- `src/cli.ts`: `interface Config { message; sessionId; outputFormat; verbose; passthrough }`, `parseArgs(argv, genId?)`.
- `src/transcript.ts`: `parseLine(line)`, `parseTranscript(text)`.
- `src/reconstruct.ts`: `reconstruct(events, costFn, sessionId)`.
- `src/pricing.ts`: `costOf(model, usage)`.
- `src/format/{text,json,streamjson}.ts`: `formatText(events)`, `formatJson(result)`, `formatStreamJson(events, result, init)`.
- `src/driver.ts`: `isReady(buffer)`, `interface DriverHooks { onReady?; onTurnDone? }`, `startSession(config, hooks)` returning `IPty`; internal `ptyWrite(pty, data)`, `CLAUDE_BIN`, `isReady` matches `❯` + U+00A0.
- `src/main.ts`: current batch flow (will be refactored).

## File structure (new + modified)

```
docs/superpowers/findings/   NEW. spike-A-errors.md, spike-B-permission.md, spike-C-continue.md
src/tailer.ts                NEW. Incremental cursor over JSONL text → new TranscriptEvents.
src/session.ts               NEW. Resolve session id + locate transcript (uuid glob / continue discovery).
src/stdin.ts                 NEW. Read piped stdin.
src/errors.ts                NEW. detectError(events, ptyText) → {isError, subtype} | null.
src/format/streamjson.ts     MODIFY. Add incremental emitter (createStreamJsonEmitter).
src/driver.ts                MODIFY. Expose accumulated pty text; permission-box detect + auto-deny.
src/main.ts                  MODIFY. Live-loop orchestration; stdin; error wiring; resume/continue.
tests/*.test.ts              NEW per module.
```

Branch: create `feat/claude-pty-v2` from master before Task 1 (handled by subagent-driven-development).

---

## Phase 0 — Spikes (blocking; commit a findings doc each)

### Task 0A: Error catalog spike

**Files:** Create `docs/superpowers/findings/spike-A-errors.md`

- [ ] **Step 1: Trigger and capture error cases.** Using the v1 driver scaffolding (or `claude -p` directly for comparison), capture how each error surfaces in BOTH the JSONL transcript and the pty stream:
  - Invalid auth: run `CLAUDE_PTY_BIN` style invocation with a bad key env (`ANTHROPIC_API_KEY=bad claude -p --output-format json "hi"`) and record the `-p` JSON `subtype`/`is_error` AND what the interactive TUI + transcript show.
  - max-turns: `claude -p --max-turns 1 "do a multi-step task"` and record subtype.
  - refusal: a prompt that triggers a refusal; record `stop_reason` in the transcript.
- [ ] **Step 2: Write findings.** In `spike-A-errors.md`, for each case document: (a) the exact `-p` JSON `subtype` string and exit code, (b) the transcript signal (line type, `stop_reason`, any error field), (c) the pty banner text (a literal substring usable as a matcher). Produce a table mapping detectable-signal → `-p` subtype string.
- [ ] **Step 3: Commit.** `git add docs/superpowers/findings/spike-A-errors.md && git commit -m "spike: catalog claude -p error cases (subtypes, transcript + pty signals)"`

### Task 0B: Permission box spike

**Files:** Create `docs/superpowers/findings/spike-B-permission.md`, may add `spike/perm-capture.ts` (gitignored logs)

- [ ] **Step 1: Trigger a real permission box.** Spawn the interactive TUI via the v1 driver scaffolding with `--permission-mode default` and a prompt that forces a tool not in `--allowedTools` (e.g. "run `git status`" with no Bash allowed). Log raw pty chunks (`JSON.stringify`).
- [ ] **Step 2: Capture the box pattern + deny keystroke.** Record: (a) a tolerant literal/regex that identifies the permission box (e.g. the question text and the option list, noting any NBSP like the prompt signal), (b) the exact keystroke sequence that selects "No/deny" (e.g. Escape `\x1b`, or arrow + `\r`, or the digit for the deny option). Verify the deny keystroke by sending it and confirming the turn proceeds without running the tool.
- [ ] **Step 3: Write findings + commit.** Document the matcher and deny keystroke with a raw sample in `spike-B-permission.md`. `git add docs/superpowers/findings/spike-B-permission.md && git commit -m "spike: capture permission box pattern and deny keystroke"`

### Task 0C: continue / json-schema spike

**Files:** Create `docs/superpowers/findings/spike-C-continue.md`

- [ ] **Step 1: `--continue` session id.** Run a first session (record its session-id and transcript path). Run `claude --continue` (interactive, via driver) in the same cwd with a new message; confirm whether it appends to the SAME `.jsonl` (same id) or forks. Confirm `--fork-session` creates a new id. Note whether the newest-mtime `.jsonl` in the project dir reliably identifies the continued session BEFORE injecting.
- [ ] **Step 2: project-dir transform.** Confirm the `~/.claude/projects/<dir>` name is `cwd.replace(/[\\/:.]/g, "-")` by listing the dir for the current cwd (expected `C--Users-arthur-Documents-Devs-claude-pty`).
- [ ] **Step 3: `--json-schema`.** Run `claude -p --output-format json --json-schema '{"type":"object","properties":{"x":{"type":"string"}},"required":["x"]}' "set x to hi"` and inspect the `-p` JSON for `structured_output`. Then check whether the interactive transcript records `structured_output` anywhere. Conclude: recoverable from transcript (implement) or not (defer, documented).
- [ ] **Step 4: Write findings + commit.** `git add docs/superpowers/findings/spike-C-continue.md && git commit -m "spike: confirm --continue id behavior, project-dir transform, json-schema landing"`

---

## Phase 1 — Live-loop socle

### Task 1: Incremental transcript cursor (`tailer.ts`)

**Files:** Create `src/tailer.ts`; Test `tests/tailer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/tailer.test.ts
import { test, expect } from "bun:test";
import { makeTranscriptCursor } from "../src/tailer";

test("cursor returns only newly-appended events on each consume()", () => {
  const cursor = makeTranscriptCursor();
  const l1 = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"uuid":"u1","timestamp":"t1"}';
  const l2 = '{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"yo"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"uuid":"a1","timestamp":"t2"}';

  const first = cursor.consume(l1 + "\n");
  expect(first.map(e => e.kind)).toEqual(["user"]);

  // Same text again → nothing new
  expect(cursor.consume(l1 + "\n")).toEqual([]);

  // Appended line → only the new event
  const second = cursor.consume(l1 + "\n" + l2 + "\n");
  expect(second.map(e => e.kind)).toEqual(["assistant"]);
});

test("cursor ignores a trailing partial (unterminated) line until completed", () => {
  const cursor = makeTranscriptCursor();
  const full = '{"type":"user","message":{"role":"user","content":[]},"uuid":"u1","timestamp":"t1"}';
  // Partial line with no newline yet → not emitted
  expect(cursor.consume(full.slice(0, 20))).toEqual([]);
  // Completed with newline → emitted once
  expect(cursor.consume(full + "\n").map(e => e.kind)).toEqual(["user"]);
});
```

- [ ] **Step 2: Run → FAIL.** `bun test tests/tailer.test.ts`

- [ ] **Step 3: Implement**

```typescript
// src/tailer.ts
import { parseLine } from "./transcript";
import type { TranscriptEvent } from "./types";

/**
 * Stateful cursor over the growing transcript TEXT. Each consume(fullText) returns
 * only the events from lines that are newly COMPLETE (newline-terminated) since the
 * previous call. A trailing line without a newline is treated as still being written
 * and is not emitted until it is completed.
 */
export function makeTranscriptCursor() {
  let emittedLines = 0;

  return {
    consume(fullText: string): TranscriptEvent[] {
      // Only fully terminated lines are safe to parse.
      const lastNl = fullText.lastIndexOf("\n");
      if (lastNl < 0) return [];
      const complete = fullText.slice(0, lastNl).split("\n");

      if (complete.length <= emittedLines) return [];
      const fresh = complete.slice(emittedLines);
      emittedLines = complete.length;

      return fresh.map(parseLine).filter((e) => e.kind !== "ignored");
    },
  };
}
```

- [ ] **Step 4: Run → PASS.** `bun test tests/tailer.test.ts`
- [ ] **Step 5: Commit.** `git add src/tailer.ts tests/tailer.test.ts && git commit -m "feat: incremental transcript cursor"`

### Task 2: Session resolution (`session.ts`)

**Files:** Create `src/session.ts`; Test `tests/session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/session.test.ts
import { test, expect } from "bun:test";
import { resolveSessionId, projectDirName } from "../src/session";

test("projectDirName mirrors Claude Code's cwd transform", () => {
  expect(projectDirName("C:\\Users\\arthur\\Documents\\Devs\\claude-pty"))
    .toBe("C--Users-arthur-Documents-Devs-claude-pty");
});

test("generated id is used and flagged for injection when none supplied", () => {
  const r = resolveSessionId(["hi"], () => "gen-id");
  expect(r.sessionId).toBe("gen-id");
  expect(r.injectSessionId).toBe(true);
  expect(r.mode).toBe("new");
});

test("explicit --session-id is used and not re-injected (already in passthrough)", () => {
  const r = resolveSessionId(["--session-id", "abc", "hi"], () => "gen-id");
  expect(r.sessionId).toBe("abc");
  expect(r.injectSessionId).toBe(false);
  expect(r.mode).toBe("explicit");
});

test("--resume <id> tails that id, no generated injection", () => {
  const r = resolveSessionId(["--resume", "res-id", "hi"], () => "gen-id");
  expect(r.sessionId).toBe("res-id");
  expect(r.injectSessionId).toBe(false);
  expect(r.mode).toBe("resume");
});

test("--continue marks discovery mode with unknown id", () => {
  const r = resolveSessionId(["--continue", "hi"], () => "gen-id");
  expect(r.sessionId).toBe(null);
  expect(r.injectSessionId).toBe(false);
  expect(r.mode).toBe("continue");
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```typescript
// src/session.ts
import { homedir } from "os";
import { join } from "path";

export type SessionMode = "new" | "explicit" | "resume" | "continue";

export interface SessionResolution {
  sessionId: string | null; // null only for "continue" (discovered at runtime)
  injectSessionId: boolean; // true → caller prepends ["--session-id", sessionId]
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

/** For --continue: the most-recently-modified transcript in the cwd's project dir. */
export async function newestTranscriptForCwd(cwd: string): Promise<string | null> {
  const dir = join(PROJECTS_ROOT, projectDirName(cwd));
  const glob = new Bun.Glob(`*.jsonl`);
  let newest: string | null = null;
  let newestMtime = -1;
  for await (const f of glob.scan({ cwd: dir, absolute: true })) {
    const stat = await Bun.file(f).stat();
    if (stat.mtimeMs > newestMtime) { newestMtime = stat.mtimeMs; newest = f; }
  }
  return newest;
}
```

- [ ] **Step 4: Run → PASS.** (Only the pure functions are unit-tested; the async file finders are exercised by integration later.)
- [ ] **Step 5: Commit.** `git add src/session.ts tests/session.test.ts && git commit -m "feat: session resolution (new/explicit/resume/continue) + transcript locators"`

### Task 3: Incremental stream-json emitter

**Files:** Modify `src/format/streamjson.ts`; Test `tests/format-streamjson-live.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/format-streamjson-live.test.ts
import { test, expect } from "bun:test";
import { createStreamJsonEmitter } from "../src/format/streamjson";
import type { TranscriptEvent, ResultObject } from "../src/types";

const userEv: TranscriptEvent = { kind: "user", content: [{ type: "text", text: "hi" }], timestamp: "t1", uuid: "u1" };
const asstEv: TranscriptEvent = { kind: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "yo" }], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: "end_turn", timestamp: "t2", uuid: "a1" };

test("init is emitted once, before the first event, carrying the model from the first assistant", () => {
  const em = createStreamJsonEmitter("sid");
  // The user event arrives first but has no model: it is buffered until init can carry a model.
  const afterUser = em.onEvent(userEv).map(l => JSON.parse(l));
  expect(afterUser).toEqual([]); // nothing flushed yet (waiting to learn the model)

  const afterAsst = em.onEvent(asstEv).map(l => JSON.parse(l));
  expect(afterAsst[0]).toMatchObject({ type: "system", subtype: "init", session_id: "sid", model: "claude-opus-4-8" });
  expect(afterAsst[1]).toMatchObject({ type: "user" });
  expect(afterAsst[2]).toMatchObject({ type: "assistant" });

  // Subsequent events pass straight through (no second init).
  const more = em.onEvent(asstEv).map(l => JSON.parse(l));
  expect(more.length).toBe(1);
  expect(more[0]).toMatchObject({ type: "assistant" });
});

test("flush() emits init even if no assistant event ever arrived", () => {
  const em = createStreamJsonEmitter("sid");
  em.onEvent(userEv);
  const flushed = em.flush().map(l => JSON.parse(l));
  expect(flushed[0]).toMatchObject({ type: "system", subtype: "init", model: "" });
  expect(flushed[1]).toMatchObject({ type: "user" });
});

test("onResult returns the stringified result line", () => {
  const em = createStreamJsonEmitter("sid");
  const result = { type: "result", subtype: "success" } as ResultObject;
  expect(JSON.parse(em.onResult(result))).toMatchObject({ type: "result", subtype: "success" });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement (append to existing file; keep `formatStreamJson` unchanged)**

```typescript
// src/format/streamjson.ts  — ADD below the existing formatStreamJson export

function assistantLine(sessionId: string, e: Extract<TranscriptEvent, { kind: "assistant" }>): string {
  return JSON.stringify({
    type: "assistant",
    session_id: sessionId,
    message: { role: "assistant", model: e.model, content: e.content, stop_reason: e.stop_reason, usage: e.usage },
  });
}
function userLine(sessionId: string, e: Extract<TranscriptEvent, { kind: "user" }>): string {
  return JSON.stringify({ type: "user", session_id: sessionId, message: { role: "user", content: e.content } });
}
function initLine(sessionId: string, model: string): string {
  return JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model, tools: [] });
}

/**
 * Live emitter: buffers events until it can emit `system/init` carrying the model
 * (learned from the first assistant event), then flushes init + buffered events and
 * passes subsequent events straight through. Mirrors `claude -p` ordering (init first).
 */
export function createStreamJsonEmitter(sessionId: string) {
  let initEmitted = false;
  const buffered: TranscriptEvent[] = [];

  function lineFor(e: TranscriptEvent): string | null {
    if (e.kind === "assistant") return assistantLine(sessionId, e);
    if (e.kind === "user") return userLine(sessionId, e);
    return null;
  }
  function flushBuffered(model: string): string[] {
    const out = [initLine(sessionId, model)];
    initEmitted = true;
    for (const e of buffered) { const l = lineFor(e); if (l) out.push(l); }
    buffered.length = 0;
    return out;
  }

  return {
    onEvent(e: TranscriptEvent): string[] {
      if (initEmitted) { const l = lineFor(e); return l ? [l] : []; }
      if (e.kind === "assistant") return flushBuffered(e.model);
      buffered.push(e);
      return [];
    },
    /** Emit init (model "") + any buffered events that never got an assistant to anchor init. */
    flush(): string[] {
      if (initEmitted) return [];
      return flushBuffered("");
    },
    onResult(result: ResultObject): string {
      return JSON.stringify(result);
    },
  };
}
```

- [ ] **Step 4: Run → PASS** (and `bun test` stays green; the existing `formatStreamJson` batch test is untouched).
- [ ] **Step 5: Commit.** `git add src/format/streamjson.ts tests/format-streamjson-live.test.ts && git commit -m "feat: incremental stream-json emitter"`

### Task 4: Expose pty output from the driver

**Files:** Modify `src/driver.ts`

The error detector (Task 6) and permission handler (Task 7) need the pty text. Change `startSession` to return a small handle instead of the bare `IPty`.

- [ ] **Step 1: Change the return type and accumulate output.** In `src/driver.ts`, modify `startSession` to keep the existing logic but also accumulate ALL pty data into a separate unbounded-but-capped (e.g. last 64KB) `outputLog`, and return `{ pty, snapshot }`:

```typescript
// src/driver.ts — modify the signature and end of startSession
export interface Session { pty: IPty; snapshot: () => string }

// inside startSession: add near the other state
let outputLog = "";
const OUTPUT_CAP = 65536;
// inside pty.onData, after `buffer += data;`:
//   outputLog += data; if (outputLog.length > OUTPUT_CAP) outputLog = outputLog.slice(-OUTPUT_CAP);

// change the final `return pty;` to:
return { pty, snapshot: () => outputLog };
```

Update the return type annotation `: IPty` → `: Session`.

- [ ] **Step 2: Verify build + tests.** `bunx tsc --noEmit` (the only caller, `main.ts`, will be updated in Task 5; if tsc flags main.ts, that's expected and fixed there — run `bun test` which does not import main and must stay green). Expected: `bun test` green; tsc may report main.ts until Task 5.
- [ ] **Step 3: Commit.** `git add src/driver.ts && git commit -m "feat(driver): expose accumulated pty output via Session.snapshot"`

### Task 5: Refactor `main.ts` to the live loop

**Files:** Modify `src/main.ts`

- [ ] **Step 1: Rewrite main to tail live and route per format.** Replace `src/main.ts` with:

```typescript
// src/main.ts
import { parseArgs } from "./cli";
import { startSession } from "./driver";
import { reconstruct } from "./reconstruct";
import { costOf } from "./pricing";
import { formatText } from "./format/text";
import { formatJson } from "./format/json";
import { createStreamJsonEmitter } from "./format/streamjson";
import { makeTranscriptCursor } from "./tailer";
import { resolveSessionId, findTranscriptById, newestTranscriptForCwd } from "./session";
import type { TranscriptEvent } from "./types";

const TURN_TIMEOUT_MS = Number(process.env.CLAUDE_PTY_TURN_TIMEOUT_MS) || 600_000;
const POLL_MS = 120;

function isTerminal(events: TranscriptEvent[]): boolean {
  const assistants = events.filter((e): e is Extract<TranscriptEvent, { kind: "assistant" }> => e.kind === "assistant");
  const last = assistants[assistants.length - 1];
  return !!last && last.stop_reason !== "tool_use" && last.stop_reason !== null;
}

async function locate(sessionId: string | null, cwd: string): Promise<string | null> {
  return sessionId ? findTranscriptById(sessionId) : newestTranscriptForCwd(cwd);
}

async function main() {
  const config = parseArgs(Bun.argv.slice(2));
  const sess = resolveSessionId(Bun.argv.slice(2));
  const effectiveId = sess.sessionId ?? config.sessionId; // continue mode resolves later

  const cursor = makeTranscriptCursor();
  const emitter = config.outputFormat === "stream-json" ? createStreamJsonEmitter(effectiveId) : null;
  const collected: TranscriptEvent[] = [];

  let ptyDone = false;
  const session = startSession(config, { onTurnDone: () => { ptyDone = true; } });

  // Live tail loop until termination or timeout.
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let path: string | null = null;
  let lastSawTerminal = false;
  while (Date.now() < deadline) {
    if (!path) path = await locate(sess.sessionId, process.cwd());
    if (path) {
      const text = await Bun.file(path).text();
      const fresh = cursor.consume(text);
      for (const e of fresh) {
        collected.push(e);
        if (emitter) for (const line of emitter.onEvent(e)) process.stdout.write(line + "\n");
      }
      lastSawTerminal = isTerminal(collected);
    }
    if (ptyDone && lastSawTerminal) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  session.pty.kill();

  if (collected.length === 0) {
    process.stderr.write(`transcript not found or empty for session ${effectiveId}\n`);
    process.exit(1);
  }

  const result = reconstruct(collected, costOf, effectiveId);

  if (config.outputFormat === "text") {
    process.stdout.write(formatText(collected) + "\n");
  } else if (config.outputFormat === "json") {
    process.stdout.write(formatJson(result) + "\n");
  } else if (emitter) {
    for (const line of emitter.flush()) process.stdout.write(line + "\n"); // init if no assistant ever
    process.stdout.write(emitter.onResult(result) + "\n");
  }

  process.exit(result.is_error ? 1 : 0);
}

main();
```

- [ ] **Step 2: Verify.** `bunx tsc --noEmit` clean; `bun test` green (golden still skipped).
- [ ] **Step 3: Golden e2e for all three formats.** Add to `tests/golden.test.ts` a stream-json case (skip-by-default) comparing the EVENT SEQUENCE (types in order: system, …, result) to `claude -p --output-format stream-json --verbose`:

```typescript
test.skipIf(process.env.CLAUDE_PTY_E2E !== "1")("stream-json event types match claude -p", async () => {
  const prompt = "Reply with exactly the word: pong";
  const oursRaw = await new Response(Bun.spawn(["bun", "run", "src/main.ts", "--output-format", "stream-json", prompt]).stdout).text();
  const ours = oursRaw.trim().split("\n").map(l => JSON.parse(l).type);
  expect(ours[0]).toBe("system");
  expect(ours[ours.length - 1]).toBe("result");
  expect(ours).toContain("assistant");
}, 60000);
```

- [ ] **Step 4: Run the e2e.** `CLAUDE_PTY_E2E=1 bun test tests/golden.test.ts` — confirm text still matches and stream-json yields system…assistant…result, streaming as the turn progresses. Report ACTUAL output. If timing is off, tune `POLL_MS` / `isTerminal`.
- [ ] **Step 5: Commit.** `git add src/main.ts tests/golden.test.ts && git commit -m "feat: unified live tail loop; real-time stream-json"`

---

## Phase 2 — Error detection + exit codes

### Task 6: `errors.ts` + wiring

**Files:** Create `src/errors.ts`; Test `tests/errors.test.ts`; Modify `src/main.ts`

> Use the subtype strings and pty marker substrings captured in `docs/superpowers/findings/spike-A-errors.md`. The constants below are the first-cut from known cases; replace/extend them with the spike's verified strings.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/errors.test.ts
import { test, expect } from "bun:test";
import { detectError } from "../src/errors";
import type { TranscriptEvent } from "../src/types";

const asst = (stop: string | null): TranscriptEvent => ({
  kind: "assistant", model: "m", content: [{ type: "text", text: "" }],
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  stop_reason: stop, timestamp: "t", uuid: "u",
});

test("no error on a normal end_turn", () => {
  expect(detectError([asst("end_turn")], "")).toBeNull();
});

test("refusal stop_reason is an error", () => {
  expect(detectError([asst("refusal")], "")).toEqual({ isError: true, subtype: "error_refusal" });
});

test("auth failure surfaced only in pty text is detected", () => {
  expect(detectError([asst("end_turn")], "...Invalid API key · Please run /login...")).toEqual({ isError: true, subtype: "error_auth" });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (replace markers with spike-A verified strings)

```typescript
// src/errors.ts
import type { TranscriptEvent } from "./types";

export interface ErrorVerdict { isError: boolean; subtype: string }

// pty banner substrings → -p-style subtype. Source: docs/superpowers/findings/spike-A-errors.md
const PTY_MARKERS: Array<[RegExp, string]> = [
  [/Invalid API key|Please run \/login|authentication/i, "error_auth"],
  [/Credit balance|quota|insufficient/i, "error_quota"],
  [/rate limit|overloaded/i, "error_overloaded"],
];

export function detectError(events: TranscriptEvent[], ptyText: string): ErrorVerdict | null {
  const assistants = events.filter((e): e is Extract<TranscriptEvent, { kind: "assistant" }> => e.kind === "assistant");
  const last = assistants[assistants.length - 1];
  if (last && last.stop_reason === "refusal") return { isError: true, subtype: "error_refusal" };

  for (const [re, subtype] of PTY_MARKERS) {
    if (re.test(ptyText)) return { isError: true, subtype };
  }
  return null;
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Wire into main.** In `src/main.ts`, import `detectError`; after computing `result`, before formatting, apply the verdict using the driver snapshot:

```typescript
import { detectError } from "./errors";
// ...after `const result = reconstruct(...)`:
const verdict = detectError(collected, session.snapshot());
if (verdict?.isError) { result.is_error = true; result.subtype = verdict.subtype; }
```

(The `text` branch still prints the final text; `json`/`stream-json` carry the error subtype; exit code is already `result.is_error ? 1 : 0`.)

- [ ] **Step 6: Verify + commit.** `bunx tsc --noEmit` clean, `bun test` green. `git add src/errors.ts tests/errors.test.ts src/main.ts && git commit -m "feat: error detection + non-zero exit codes"`

---

## Phase 3 — Auto-deny permissions

### Task 7: Permission box detection + auto-deny in driver

**Files:** Modify `src/driver.ts`; Test `tests/driver-permission.test.ts`

> Use the matcher and deny keystroke captured in `docs/superpowers/findings/spike-B-permission.md`. The constants below are placeholders to be replaced with the spike's verified values.

- [ ] **Step 1: Write the failing predicate test**

```typescript
// tests/driver-permission.test.ts
import { test, expect } from "bun:test";
import { isPermissionPrompt } from "../src/driver";

test("detects the permission box from a real captured chunk", () => {
  // Replace this string with a verbatim sample from spike-B-permission.md
  const box = "Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently";
  expect(isPermissionPrompt(box)).toBe(true);
});

test("does not fire on normal assistant output", () => {
  expect(isPermissionPrompt("Here is the answer: 42")).toBe(false);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement detection + auto-deny.** In `src/driver.ts`:

```typescript
/** Detects the permission confirmation box. Pattern verified in spike-B-permission.md. */
export function isPermissionPrompt(buffer: string): boolean {
  return /Do you want to proceed\?/.test(buffer) && /No, and tell Claude/.test(buffer);
}

// Deny keystroke captured in spike-B (e.g. Escape). Replace with verified value.
const DENY_KEYSTROKE = "\x1b";
```

In `startSession`'s `onData`, after the injection block and before/independent of the turn-done block, add a once-per-box guard that sends the deny keystroke when a fresh box appears:

```typescript
// add state near the others:
let permHandledMarker = "";
// inside onData, after buffer update:
if (injected && isPermissionPrompt(buffer)) {
  // Avoid re-denying the same rendered box repeatedly.
  const marker = buffer.slice(-200);
  if (marker !== permHandledMarker) {
    permHandledMarker = marker;
    ptyWrite(pty, DENY_KEYSTROKE);
  }
}
```

- [ ] **Step 4: Run predicate test → PASS;** `bun test` green; `bunx tsc --noEmit` clean.
- [ ] **Step 5: Guarded integration test.** Add (skip-by-default) a test that drives a real session with `--permission-mode default` and a prompt requiring a disallowed tool, asserting the run terminates (does not hang) and exits non-zero or returns without executing the tool. Document the observed behavior.

```typescript
// tests/golden.test.ts — append
test.skipIf(process.env.CLAUDE_PTY_E2E !== "1")("permission box is auto-denied and the run terminates", async () => {
  const p = Bun.spawn(["bun", "run", "src/main.ts", "--output-format", "text", "--permission-mode", "default", "Run the shell command: git status"]);
  const out = await new Response(p.stdout).text();
  await p.exited;
  expect(out.length).toBeGreaterThan(0); // it did not hang; Claude reports it could not run the tool
}, 90000);
```

- [ ] **Step 6: Run the integration test for real, tune, commit.** `CLAUDE_PTY_E2E=1 bun test tests/driver-permission.test.ts tests/golden.test.ts`. `git add src/driver.ts tests/driver-permission.test.ts tests/golden.test.ts && git commit -m "feat(driver): auto-deny permission prompts (faithful to -p)"`

---

## Phase 4 — stdin

### Task 8: stdin input

**Files:** Create `src/stdin.ts`; Test `tests/stdin.test.ts`; Modify `src/main.ts`

- [ ] **Step 1: Write the failing test** (pure combiner; the actual TTY read is integration)

```typescript
// tests/stdin.test.ts
import { test, expect } from "bun:test";
import { combineMessage } from "../src/stdin";

test("positional only", () => {
  expect(combineMessage("hi", "")).toBe("hi");
});
test("stdin only", () => {
  expect(combineMessage("", "piped text")).toBe("piped text");
});
test("positional + stdin are joined (mirrors claude -p context append)", () => {
  expect(combineMessage("explain", "error log line")).toBe("explain\n\nerror log line");
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```typescript
// src/stdin.ts
export function combineMessage(positional: string, stdinText: string): string {
  return [positional.trim(), stdinText.trim()].filter(Boolean).join("\n\n");
}

/** Read piped stdin if present (not a TTY). Returns "" when stdin is a terminal. */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return await new Response(Bun.stdin.stream()).text();
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Wire into main.** In `src/main.ts`, after `parseArgs`, replace the message:

```typescript
import { combineMessage, readStdin } from "./stdin";
// ...
const stdinText = await readStdin();
config.message = combineMessage(config.message, stdinText);
```

- [ ] **Step 6: Verify + commit.** `bunx tsc --noEmit`, `bun test` green. `git add src/stdin.ts tests/stdin.test.ts src/main.ts && git commit -m "feat: stdin input (piped message + context append)"`

---

## Phase 5 — resume / continue

### Task 9: continue discovery wiring + integration

**Files:** Modify `src/main.ts`; Test `tests/golden.test.ts`

> session.ts already provides `resolveSessionId` (mode) and the locators. main.ts already calls `locate(sess.sessionId, cwd)` which uses `newestTranscriptForCwd` when sessionId is null (continue). This task validates and hardens that path per spike-C findings.

- [ ] **Step 1: Continue-mode correctness.** Confirm via spike-C that in `continue` mode the newest `.jsonl` for the cwd is the right file BEFORE injection. If spike-C found `--continue` keeps the same id, no change needed beyond what main.ts does. If it forks, adjust `locate` to re-scan for the newest file AFTER `onReady` (capture the pre-injection newest mtime, then pick the file whose mtime advanced).
- [ ] **Step 2: Implement any adjustment** found necessary in Step 1 (e.g. capture `preNewest` before spawn; in continue mode prefer a file modified after `preNewest`). Keep the change localized to the `locate`/loop in main.ts. If no change is needed, note that explicitly.
- [ ] **Step 3: Guarded integration test.**

```typescript
// tests/golden.test.ts — append
test.skipIf(process.env.CLAUDE_PTY_E2E !== "1")("--continue resumes the prior session", async () => {
  await new Response(Bun.spawn(["bun", "run", "src/main.ts", "--output-format", "text", "Remember the codeword: banana"]).stdout).text();
  const out = await new Response(Bun.spawn(["bun", "run", "src/main.ts", "--output-format", "text", "--continue", "What was the codeword?"]).stdout).text();
  expect(out.toLowerCase()).toContain("banana");
}, 120000);
```

- [ ] **Step 4: Run for real, tune, commit.** `CLAUDE_PTY_E2E=1 bun test tests/golden.test.ts`. `git add src/main.ts tests/golden.test.ts && git commit -m "feat: --continue/--resume support with transcript discovery"`

---

## Phase 6 — structured output + multi-turn input (last; defer per spike-C)

### Task 10: `--json-schema` structured output (only if spike-C says recoverable)

**Files:** Modify `src/types.ts`, `src/reconstruct.ts`, `src/main.ts`; Test `tests/structured.test.ts`

- [ ] **Step 1: Decision gate.** If `spike-C-continue.md` concluded `structured_output` is NOT recoverable from the interactive transcript, SKIP this task and add one line to the v2 spec's Limitations marking it deferred, then commit that doc change. Otherwise continue.
- [ ] **Step 2: Write failing test** — given a transcript fixture that contains the structured payload (use the exact shape spike-C found), `reconstruct` (or a new `extractStructuredOutput(events)`) populates `result.structured_output`.

```typescript
// tests/structured.test.ts
import { test, expect } from "bun:test";
import { extractStructuredOutput } from "../src/reconstruct";
import { parseTranscript } from "../src/transcript";

test("structured_output is lifted from the transcript", async () => {
  // fixture path/shape per spike-C
  const events = parseTranscript(await Bun.file("tests/fixtures/structured.jsonl").text());
  expect(extractStructuredOutput(events)).toEqual({ x: "hi" });
});
```

- [ ] **Step 3: Implement** `extractStructuredOutput(events)` per the spike-C shape, add `structured_output?: unknown` to `ResultObject`, and set it in main for the `json` format. Create `tests/fixtures/structured.jsonl` from spike-C's captured data.
- [ ] **Step 4: Run → PASS;** verify with a real `CLAUDE_PTY_E2E` run comparing to `claude -p --json-schema`. Commit: `feat: --json-schema structured output`.

### Task 11: `--input-format stream-json` (multi-turn)

**Files:** Modify `src/cli.ts` (stop consuming when value is stream-json? no — keep consumed but record), `src/main.ts`; Test `tests/golden.test.ts`

- [ ] **Step 1: Record the input format.** In `src/cli.ts`, add `inputFormat: "text" | "stream-json"` to `Config`; set it from `--input-format` (still consumed/not forwarded). Add a unit test asserting `parseArgs(["--input-format","stream-json","x"]).inputFormat === "stream-json"`.
- [ ] **Step 2: Multi-turn loop.** In `main.ts`, when `inputFormat === "stream-json"`, read NDJSON user messages from stdin (`{"type":"user","content":"..."}` per line); for each, inject via the driver and run a tail cycle, emitting output per turn; reuse the same session id across turns (`--resume`/same `--session-id`). Implement as a loop around the existing single-turn tail logic (extract the single-turn body into a helper `runTurn(message)`).
- [ ] **Step 3: Guarded integration test** sending two NDJSON messages and asserting both turns produce output in order.
- [ ] **Step 4: Run for real, commit.** `feat: --input-format stream-json multi-turn input`.

---

## Final steps (after all tasks)

- [ ] Full suite: `bun test` green; `CLAUDE_PTY_E2E=1 bun test` for all golden cases.
- [ ] Recompile: `bun build src/main.ts --compile --outfile claude-pty.exe` and smoke-test each format.
- [ ] Dispatch a final whole-implementation review, then `superpowers:finishing-a-development-branch`.

---

## Self-review notes (addressed)

- **Spec coverage:** live loop (Tasks 1,3,4,5); errors+exit (Task 6, Spike A); real-time stream-json (Tasks 3,5); stdin (Task 8); permissions auto-deny (Task 7, Spike B); resume/continue (Tasks 2,9, Spike C); structured output (Task 10, Spike C gate); input-format stream-json (Task 11). Limitations (`--include-partial-messages`, estimated cost, version coupling) unchanged from v1 — no task, documented.
- **Spike-dependent constants:** error markers (Task 6), permission matcher + deny keystroke (Task 7), continue behavior (Task 9), structured shape (Task 10) come from committed Phase-0 findings docs — the task code gives the concrete structure and instructs replacement with verified values (same pattern as v1's readiness-signal calibration).
- **Type consistency:** `Session {pty,snapshot}`, `SessionResolution {sessionId,injectSessionId,mode}`, `createStreamJsonEmitter(sessionId) → {onEvent,flush,onResult}`, `detectError(events,ptyText) → {isError,subtype}|null`, `makeTranscriptCursor() → {consume}`, `combineMessage(positional,stdin)` used consistently across tasks.
- **Driver return change** (`IPty` → `Session`) has one caller (main.ts), updated in Task 5; `bun test` stays green meanwhile since tests don't import main.
```
