# claude-pty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `claude-pty`, a drop-in replacement for `claude -p` that drives the interactive Claude Code TUI through node-pty and reconstructs `-p`-identical output from the session's JSONL transcript.

**Architecture:** A thin pty `driver` extracts only two binary signals from the TUI (prompt-ready / turn-done) and answers permission prompts; all content comes from tailing `~/.claude/projects/**/<session-id>.jsonl`. Pure functions (`transcript`, `reconstruct`, `format/*`, `pricing`) transform JSONL lines into `text` / `json` / `stream-json` output. Shipped as a standalone binary via `bun build --compile`.

**Tech Stack:** Bun + TypeScript, `node-pty` (native module), `bun test`, `bun build --compile`.

---

## File Structure

```
spike/hello-pty.ts        Phase 0 go/no-go: node-pty under a compiled binary
src/types.ts              Shared types (Usage, ContentBlock, TranscriptEvent, ResultObject)
src/pricing.ts            model id → price table; costOf(model, usage)
src/transcript.ts         parseLine / parseTranscript: JSONL string → TranscriptEvent[]
src/reconstruct.ts        reconstruct(events, costFn) → ResultObject
src/format/text.ts        formatText(events) → string
src/format/json.ts        formatJson(result) → string
src/format/streamjson.ts  formatStreamJson(events, result) → string[]
src/cli.ts                parseArgs(argv, genId) → Config
src/driver.ts             runSession(config): spawn pty, inject msg, signal turn-done
src/main.ts               entry point: wires cli → driver → transcript → format → stdout
tests/fixtures/session.jsonl   synthetic but structurally-faithful transcript
tests/*.test.ts           unit tests per module
```

Build command (used in Task 11): `bun build src/main.ts --compile --outfile claude-pty.exe`

---

## Phase 0 — Spike: node-pty under a compiled binary (GO/NO-GO)

This is the project's true risk. Do it first. It is a spike, not TDD: the deliverable is a compiled binary that demonstrably drives a pty.

### Task 0: Prove `bun build --compile` + node-pty works

**Files:**
- Create: `spike/hello-pty.ts`

- [ ] **Step 1: Write the spike**

```typescript
// spike/hello-pty.ts
import { spawn } from "node-pty";

const shell = process.platform === "win32" ? "powershell.exe" : "bash";
const pty = spawn(shell, [], { cols: 120, rows: 30 });

let out = "";
pty.onData((d) => { out += d; process.stdout.write(d); });
pty.onExit(({ exitCode }) => {
  console.log(`\n[spike] exited ${exitCode}; captured ${out.length} bytes`);
  process.exit(out.length > 0 ? 0 : 1);
});

// Type a command and exit, proving we can drive the pty.
pty.write("echo hello-from-pty\r");
setTimeout(() => pty.write("exit\r"), 800);
```

- [ ] **Step 2: Run uncompiled to confirm node-pty loads under Bun**

Run: `bun run spike/hello-pty.ts`
Expected: output contains `hello-from-pty`, then `[spike] exited 0`.

- [ ] **Step 3: Compile and run the binary**

Run:
```bash
bun build spike/hello-pty.ts --compile --outfile spike-hello.exe
./spike-hello.exe
```
Expected: same `hello-from-pty` output from the compiled binary.

- [ ] **Step 4: If the native `.node` fails to load when compiled**

node-pty ships a prebuilt `.node`. If the compiled binary cannot find it, copy the addon next to the binary and/or add it as an asset. Determine the path:
```bash
node -e "console.log(require.resolve('node-pty/build/Release/pty.node'))"
```
Document the working approach (asset embedding vs. sidecar `.node`) in a comment at the top of `spike/hello-pty.ts`. **Do not proceed to Phase 1 until the compiled binary drives the pty.**

- [ ] **Step 5: Commit**

```bash
git add spike/hello-pty.ts
git commit -m "spike: prove node-pty works under bun --compile"
```

---

## Phase 1 — Pure core (TDD)

### Task 1: Shared types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write the types** (no test — type-only module)

```typescript
// src/types.ts
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean };

export type TranscriptEvent =
  | {
      kind: "assistant";
      model: string;
      content: ContentBlock[];
      usage: Usage;
      stop_reason: string | null;
      timestamp: string;
      uuid: string;
    }
  | { kind: "user"; content: ContentBlock[]; timestamp: string; uuid: string }
  | { kind: "ignored" };

export interface ResultObject {
  type: "result";
  subtype: string; // "success" | "error_*"
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage: Usage;
  duration_ms: number;
  num_turns: number;
  is_error: boolean;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: shared types"
```

### Task 2: Pricing

**Files:**
- Create: `src/pricing.ts`
- Test: `tests/pricing.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/pricing.test.ts
import { test, expect } from "bun:test";
import { costOf } from "../src/pricing";

test("opus cost = input + output + cache, per million tokens", () => {
  const cost = costOf("claude-opus-4-8", {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
  // opus: $15/M input, $75/M output
  expect(cost).toBeCloseTo(90, 5);
});

test("unknown model falls back to zero cost without throwing", () => {
  expect(costOf("made-up-model", {
    input_tokens: 1000, output_tokens: 1000,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  })).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pricing.test.ts`
Expected: FAIL — `costOf` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/pricing.ts
import type { Usage } from "./types";

interface Price { input: number; output: number; cacheWrite: number; cacheRead: number } // $/Mtok

// Prices in USD per 1M tokens. Extend as needed.
const TABLE: Record<string, Price> = {
  "claude-opus-4-8":   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4-6": { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  "claude-haiku-4-5":  { input: 1,  output: 5,  cacheWrite: 1.25,  cacheRead: 0.1 },
};

function priceFor(model: string): Price | undefined {
  if (TABLE[model]) return TABLE[model];
  // alias match: "opus" / "sonnet" / "haiku" substrings
  for (const key of Object.keys(TABLE)) {
    const fam = key.split("-")[1]; // opus | sonnet | haiku
    if (fam && model.includes(fam)) return TABLE[key];
  }
  return undefined;
}

export function costOf(model: string, u: Usage): number {
  const p = priceFor(model);
  if (!p) return 0;
  return (
    (u.input_tokens / 1e6) * p.input +
    (u.output_tokens / 1e6) * p.output +
    (u.cache_creation_input_tokens / 1e6) * p.cacheWrite +
    (u.cache_read_input_tokens / 1e6) * p.cacheRead
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/pricing.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pricing.ts tests/pricing.test.ts
git commit -m "feat: pricing table and costOf"
```

### Task 3: Test fixture

**Files:**
- Create: `tests/fixtures/session.jsonl`

- [ ] **Step 1: Create the fixture** (one assistant turn with a tool call, then a final text turn)

```jsonl
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"read foo.txt"}]},"uuid":"u1","timestamp":"2026-06-08T10:00:00.000Z","sessionId":"11111111-1111-1111-1111-111111111111"}
{"type":"assistant","message":{"model":"claude-opus-4-8","id":"a1","role":"assistant","type":"message","content":[{"type":"text","text":"Reading it."},{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"foo.txt"}}],"stop_reason":"tool_use","usage":{"input_tokens":100,"output_tokens":20,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"uuid":"a1","timestamp":"2026-06-08T10:00:01.000Z","sessionId":"11111111-1111-1111-1111-111111111111"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"hello from foo","is_error":false}]},"uuid":"u2","timestamp":"2026-06-08T10:00:02.000Z","sessionId":"11111111-1111-1111-1111-111111111111"}
{"type":"assistant","message":{"model":"claude-opus-4-8","id":"a2","role":"assistant","type":"message","content":[{"type":"text","text":"The file says: hello from foo"}],"stop_reason":"end_turn","usage":{"input_tokens":150,"output_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"uuid":"a2","timestamp":"2026-06-08T10:00:03.000Z","sessionId":"11111111-1111-1111-1111-111111111111"}
```

- [ ] **Step 2: Commit**

```bash
git add tests/fixtures/session.jsonl
git commit -m "test: add transcript fixture"
```

### Task 4: Transcript parser

**Files:**
- Create: `src/transcript.ts`
- Test: `tests/transcript.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/transcript.test.ts
import { test, expect } from "bun:test";
import { parseLine, parseTranscript } from "../src/transcript";

test("parseLine ignores meta/system lines", () => {
  expect(parseLine('{"type":"system","subtype":"bridge_status"}').kind).toBe("ignored");
  expect(parseLine('not json').kind).toBe("ignored");
  expect(parseLine('').kind).toBe("ignored");
});

test("parseLine extracts an assistant message", () => {
  const line = '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":2,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"uuid":"x","timestamp":"2026-06-08T10:00:00.000Z"}';
  const ev = parseLine(line);
  expect(ev.kind).toBe("assistant");
  if (ev.kind !== "assistant") throw new Error("type");
  expect(ev.model).toBe("claude-opus-4-8");
  expect(ev.content[0]).toEqual({ type: "text", text: "hi" });
  expect(ev.usage.input_tokens).toBe(5);
  expect(ev.stop_reason).toBe("end_turn");
});

test("parseTranscript reads the fixture into 2 assistant + 2 user events", async () => {
  const text = await Bun.file("tests/fixtures/session.jsonl").text();
  const events = parseTranscript(text);
  expect(events.filter(e => e.kind === "assistant").length).toBe(2);
  expect(events.filter(e => e.kind === "user").length).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/transcript.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/transcript.ts
import type { TranscriptEvent, ContentBlock, Usage } from "./types";

const IGNORED: TranscriptEvent = { kind: "ignored" };

function normalizeUsage(u: any): Usage {
  return {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
  };
}

export function parseLine(line: string): TranscriptEvent {
  if (!line.trim()) return IGNORED;
  let o: any;
  try { o = JSON.parse(line); } catch { return IGNORED; }
  const msg = o?.message;
  if (o?.type === "assistant" && msg) {
    return {
      kind: "assistant",
      model: msg.model ?? "",
      content: (msg.content ?? []) as ContentBlock[],
      usage: normalizeUsage(msg.usage),
      stop_reason: msg.stop_reason ?? null,
      timestamp: o.timestamp ?? "",
      uuid: o.uuid ?? "",
    };
  }
  if (o?.type === "user" && msg && Array.isArray(msg.content)) {
    return {
      kind: "user",
      content: msg.content as ContentBlock[],
      timestamp: o.timestamp ?? "",
      uuid: o.uuid ?? "",
    };
  }
  return IGNORED;
}

export function parseTranscript(text: string): TranscriptEvent[] {
  return text.split("\n").map(parseLine).filter(e => e.kind !== "ignored");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/transcript.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/transcript.ts tests/transcript.test.ts
git commit -m "feat: transcript JSONL parser"
```

### Task 5: Reconstruct result object

**Files:**
- Create: `src/reconstruct.ts`
- Test: `tests/reconstruct.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/reconstruct.test.ts
import { test, expect } from "bun:test";
import { parseTranscript } from "../src/transcript";
import { reconstruct } from "../src/reconstruct";

test("reconstruct builds the -p result object from the fixture", async () => {
  const events = parseTranscript(await Bun.file("tests/fixtures/session.jsonl").text());
  // deterministic cost fn: $1 per 1000 total tokens
  const costFn = (_m: string, u: any) =>
    (u.input_tokens + u.output_tokens) / 1000;
  const r = reconstruct(events, costFn, "11111111-1111-1111-1111-111111111111");

  expect(r.type).toBe("result");
  expect(r.subtype).toBe("success");
  expect(r.result).toBe("The file says: hello from foo"); // last assistant text
  expect(r.session_id).toBe("11111111-1111-1111-1111-111111111111");
  expect(r.num_turns).toBe(2);                 // 2 assistant messages
  expect(r.usage.input_tokens).toBe(250);      // 100 + 150
  expect(r.usage.output_tokens).toBe(30);      // 20 + 10
  expect(r.duration_ms).toBe(3000);            // 10:00:03 - 10:00:00
  expect(r.total_cost_usd).toBeCloseTo(0.28, 5); // (250+30)/1000 per assistant summed
  expect(r.is_error).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/reconstruct.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/reconstruct.ts
import type { TranscriptEvent, ResultObject, Usage } from "./types";

type CostFn = (model: string, usage: Usage) => number;

function textOf(content: { type: string; text?: string }[]): string {
  return content.filter(c => c.type === "text").map(c => c.text ?? "").join("");
}

export function reconstruct(
  events: TranscriptEvent[],
  costFn: CostFn,
  sessionId: string,
): ResultObject {
  const assistants = events.filter(e => e.kind === "assistant") as Extract<TranscriptEvent, { kind: "assistant" }>[];

  const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let cost = 0;
  for (const a of assistants) {
    usage.input_tokens += a.usage.input_tokens;
    usage.output_tokens += a.usage.output_tokens;
    usage.cache_creation_input_tokens += a.usage.cache_creation_input_tokens;
    usage.cache_read_input_tokens += a.usage.cache_read_input_tokens;
    cost += costFn(a.model, a.usage);
  }

  const last = assistants[assistants.length - 1];
  const result = last ? textOf(last.content as any) : "";

  const times = events.map(e => (e.kind === "ignored" ? "" : e.timestamp)).filter(Boolean).map(t => Date.parse(t)).filter(n => !Number.isNaN(n));
  const duration_ms = times.length >= 2 ? Math.max(...times) - Math.min(...times) : 0;

  return {
    type: "result",
    subtype: "success",
    result,
    session_id: sessionId,
    total_cost_usd: cost,
    usage,
    duration_ms,
    num_turns: assistants.length,
    is_error: false,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/reconstruct.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reconstruct.ts tests/reconstruct.test.ts
git commit -m "feat: reconstruct -p result object"
```

---

## Phase 2 — Output formats (TDD)

### Task 6: text format

**Files:**
- Create: `src/format/text.ts`
- Test: `tests/format-text.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/format-text.test.ts
import { test, expect } from "bun:test";
import { parseTranscript } from "../src/transcript";
import { formatText } from "../src/format/text";

test("text format prints only the final assistant text", async () => {
  const events = parseTranscript(await Bun.file("tests/fixtures/session.jsonl").text());
  expect(formatText(events)).toBe("The file says: hello from foo");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/format-text.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/format/text.ts
import type { TranscriptEvent } from "../types";

export function formatText(events: TranscriptEvent[]): string {
  const assistants = events.filter(e => e.kind === "assistant") as Extract<TranscriptEvent, { kind: "assistant" }>[];
  const last = assistants[assistants.length - 1];
  if (!last) return "";
  return last.content.filter(c => c.type === "text").map(c => (c as any).text ?? "").join("");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/format-text.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/format/text.ts tests/format-text.test.ts
git commit -m "feat: text output format"
```

### Task 7: json format

**Files:**
- Create: `src/format/json.ts`
- Test: `tests/format-json.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/format-json.test.ts
import { test, expect } from "bun:test";
import { formatJson } from "../src/format/json";
import type { ResultObject } from "../src/types";

test("json format serializes the result object on one line", () => {
  const r: ResultObject = {
    type: "result", subtype: "success", result: "hi",
    session_id: "s1", total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    duration_ms: 100, num_turns: 1, is_error: false,
  };
  const out = formatJson(r);
  expect(out.endsWith("\n")).toBe(false);
  expect(JSON.parse(out)).toEqual(r);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/format-json.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/format/json.ts
import type { ResultObject } from "../types";

export function formatJson(result: ResultObject): string {
  return JSON.stringify(result);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/format-json.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/format/json.ts tests/format-json.test.ts
git commit -m "feat: json output format"
```

### Task 8: stream-json format

**Files:**
- Create: `src/format/streamjson.ts`
- Test: `tests/format-streamjson.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/format-streamjson.test.ts
import { test, expect } from "bun:test";
import { parseTranscript } from "../src/transcript";
import { reconstruct } from "../src/reconstruct";
import { formatStreamJson } from "../src/format/streamjson";

test("stream-json emits init, one event per message, then result", async () => {
  const events = parseTranscript(await Bun.file("tests/fixtures/session.jsonl").text());
  const result = reconstruct(events, () => 0, "11111111-1111-1111-1111-111111111111");
  const lines = formatStreamJson(events, result, { model: "claude-opus-4-8" });

  const parsed = lines.map(l => JSON.parse(l));
  expect(parsed[0]).toMatchObject({ type: "system", subtype: "init", session_id: "11111111-1111-1111-1111-111111111111" });
  expect(parsed[1]).toMatchObject({ type: "assistant" });
  expect(parsed[2]).toMatchObject({ type: "user" });
  expect(parsed[parsed.length - 1]).toMatchObject({ type: "result", subtype: "success" });
  // 1 init + 4 messages + 1 result
  expect(parsed.length).toBe(6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/format-streamjson.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/format/streamjson.ts
import type { TranscriptEvent, ResultObject } from "../types";

interface InitInfo { model: string; tools?: string[] }

export function formatStreamJson(
  events: TranscriptEvent[],
  result: ResultObject,
  init: InitInfo,
): string[] {
  const out: string[] = [];
  out.push(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: result.session_id,
    model: init.model,
    tools: init.tools ?? [],
  }));

  for (const e of events) {
    if (e.kind === "assistant") {
      out.push(JSON.stringify({
        type: "assistant",
        session_id: result.session_id,
        message: { role: "assistant", model: e.model, content: e.content, stop_reason: e.stop_reason, usage: e.usage },
      }));
    } else if (e.kind === "user") {
      out.push(JSON.stringify({
        type: "user",
        session_id: result.session_id,
        message: { role: "user", content: e.content },
      }));
    }
  }

  out.push(JSON.stringify(result));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/format-streamjson.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/format/streamjson.ts tests/format-streamjson.test.ts
git commit -m "feat: stream-json output format"
```

---

## Phase 3 — CLI arg classification (TDD)

### Task 9: parseArgs

**Files:**
- Create: `src/cli.ts`
- Test: `tests/cli.test.ts`

Config shape (define in `src/cli.ts`):
```typescript
export interface Config {
  message: string;
  sessionId: string;
  outputFormat: "text" | "json" | "stream-json";
  verbose: boolean;
  passthrough: string[]; // args forwarded to the interactive claude process
}
```

Classification rules:
- **Consumed** (not forwarded): `-p`, `--print`, `--output-format <v>`, `--input-format <v>`, `--verbose`, `--include-partial-messages`, `--replay-user-messages`, `--json-schema <v>`.
- **Special:** `--session-id <uuid>` → use as `sessionId`; otherwise generate via `genId()`.
- **Passthrough:** every other flag and its value(s) → `passthrough`.
- The lone non-flag argument is the `message`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli.test.ts
import { test, expect } from "bun:test";
import { parseArgs } from "../src/cli";

const fixedId = () => "fixed-uuid";

test("extracts message and defaults output-format to text", () => {
  const c = parseArgs(["hello world"], fixedId);
  expect(c.message).toBe("hello world");
  expect(c.outputFormat).toBe("text");
  expect(c.sessionId).toBe("fixed-uuid");
  expect(c.passthrough).toEqual([]);
});

test("consumes -p and --output-format, never forwarding them", () => {
  const c = parseArgs(["-p", "--output-format", "json", "hi"], fixedId);
  expect(c.outputFormat).toBe("json");
  expect(c.message).toBe("hi");
  expect(c.passthrough).not.toContain("-p");
  expect(c.passthrough).not.toContain("--output-format");
});

test("forwards unknown flags with their values as passthrough", () => {
  const c = parseArgs(["--model", "opus", "--allowedTools", "Read,Edit", "do it"], fixedId);
  expect(c.passthrough).toEqual(["--model", "opus", "--allowedTools", "Read,Edit"]);
  expect(c.message).toBe("do it");
});

test("uses a provided --session-id instead of generating one", () => {
  const c = parseArgs(["--session-id", "abc-123", "hi"], fixedId);
  expect(c.sessionId).toBe("abc-123");
  expect(c.passthrough).toContain("--session-id"); // session-id IS forwarded to claude
  expect(c.passthrough).toContain("abc-123");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/cli.ts
export interface Config {
  message: string;
  sessionId: string;
  outputFormat: "text" | "json" | "stream-json";
  verbose: boolean;
  passthrough: string[];
}

// flags we consume and DROP (with the number of value tokens they take)
const CONSUMED_WITH_VALUE = new Set(["--output-format", "--input-format", "--json-schema"]);
const CONSUMED_BOOL = new Set(["-p", "--print", "--include-partial-messages", "--replay-user-messages"]);

export function parseArgs(argv: string[], genId: () => string = () => crypto.randomUUID()): Config {
  let message = "";
  let outputFormat: Config["outputFormat"] = "text";
  let verbose = false;
  let sessionId = "";
  const passthrough: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--verbose") { verbose = true; continue; }
    if (CONSUMED_BOOL.has(a)) { continue; }
    if (a === "--output-format") { outputFormat = argv[++i] as Config["outputFormat"]; continue; }
    if (CONSUMED_WITH_VALUE.has(a)) { i++; continue; }
    if (a === "--session-id") { sessionId = argv[i + 1] ?? ""; passthrough.push(a, argv[++i]!); continue; }
    if (a.startsWith("-")) {
      passthrough.push(a);
      // forward a following value token if present and not another flag
      if (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) passthrough.push(argv[++i]!);
      continue;
    }
    message = a; // the lone positional
  }

  if (!sessionId) sessionId = genId();
  return { message, sessionId, outputFormat, verbose, passthrough };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: CLI arg classification"
```

---

## Phase 4 — Driver + wiring + binary

### Task 10: pty driver

**Files:**
- Create: `src/driver.ts`

The driver is the hard-to-unit-test boundary, so it stays thin. It is validated by the Phase 0 spike and the Task 11 golden integration test.

- [ ] **Step 1: Write the driver**

```typescript
// src/driver.ts
import { spawn, type IPty } from "node-pty";
import type { Config } from "./cli";

const CLAUDE_BIN = process.env.CLAUDE_PTY_BIN ?? "C:\\Users\\arthur\\.local\\bin\\claude.exe";

// Tolerant "input box ready" signal calibrated to Claude Code 2.1.168.
// Calibrate this regex during Task 0/11 by logging the raw pty stream.
const READY_RE = /[│║]\s*>\s/;

export interface DriverHooks {
  onReady?: () => void;
  onTurnDone?: () => void;
}

export function startSession(config: Config, hooks: DriverHooks = {}): IPty {
  const args = ["--session-id", config.sessionId, ...config.passthrough];
  const pty = spawn(CLAUDE_BIN, args, { cols: 120, rows: 40, cwd: process.cwd() });

  let injected = false;
  let buffer = "";
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  pty.onData((data) => {
    buffer += data;
    if (buffer.length > 8192) buffer = buffer.slice(-8192);

    if (!injected && READY_RE.test(buffer)) {
      injected = true;
      hooks.onReady?.();
      pty.write(config.message + "\r");
      buffer = "";
      return;
    }

    if (injected) {
      // Turn-done heuristic: prompt box returned AND the stream went quiet.
      if (READY_RE.test(buffer)) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => hooks.onTurnDone?.(), 600);
      }
    }
  });

  return pty;
}
```

- [ ] **Step 2: Manual calibration check**

Run a throwaway harness that logs the raw pty stream against the real binary, confirm `READY_RE` fires both at startup and after a turn. Adjust the regex if the box-drawing characters differ on this terminal. (No automated assertion — this is calibration; the golden test in Task 11 is the real gate.)

Run: `CLAUDE_PTY_BIN="C:\\Users\\arthur\\.local\\bin\\claude.exe" bun run src/driver.ts` (add a temporary `if (import.meta.main)` logging block, then remove it).

- [ ] **Step 3: Commit**

```bash
git add src/driver.ts
git commit -m "feat: thin pty driver with ready/turn-done signals"
```

### Task 11: main entry + golden integration test + binary

**Files:**
- Create: `src/main.ts`
- Test: `tests/golden.test.ts`

- [ ] **Step 1: Write main.ts (wires everything)**

```typescript
// src/main.ts
import { parseArgs } from "./cli";
import { startSession } from "./driver";
import { parseTranscript } from "./transcript";
import { reconstruct } from "./reconstruct";
import { costOf } from "./pricing";
import { formatText } from "./format/text";
import { formatJson } from "./format/json";
import { formatStreamJson } from "./format/streamjson";
import { homedir } from "os";
import { join } from "path";

async function findTranscript(sessionId: string): Promise<string | null> {
  const root = join(homedir(), ".claude", "projects");
  const glob = new Bun.Glob(`**/${sessionId}.jsonl`);
  for await (const f of glob.scan({ cwd: root, absolute: true })) return f;
  return null;
}

async function main() {
  const config = parseArgs(Bun.argv.slice(2));

  await new Promise<void>((resolve) => {
    const pty = startSession(config, { onTurnDone: () => { pty.kill(); resolve(); } });
  });

  // Give the transcript a moment to flush, then read it.
  const path = await findTranscript(config.sessionId);
  if (!path) { process.stderr.write(`transcript not found for ${config.sessionId}\n`); process.exit(1); }
  const events = parseTranscript(await Bun.file(path!).text());
  const result = reconstruct(events, costOf, config.sessionId);

  if (config.outputFormat === "text") {
    process.stdout.write(formatText(events) + "\n");
  } else if (config.outputFormat === "json") {
    process.stdout.write(formatJson(result) + "\n");
  } else {
    const model = events.find(e => e.kind === "assistant")?.kind === "assistant"
      ? (events.find(e => e.kind === "assistant") as any).model : "";
    for (const line of formatStreamJson(events, result, { model })) process.stdout.write(line + "\n");
  }

  process.exit(result.is_error ? 1 : 0);
}

main();
```

- [ ] **Step 2: Write the golden integration test**

```typescript
// tests/golden.test.ts
import { test, expect } from "bun:test";

const RUN = process.env.CLAUDE_PTY_E2E === "1";

test.skipIf(!RUN)("claude-pty text output matches claude -p text output", async () => {
  const prompt = "Reply with exactly the word: pong";

  const ref = await new Response(
    Bun.spawn(["claude", "-p", "--output-format", "text", prompt]).stdout
  ).text();

  const ours = await new Response(
    Bun.spawn(["bun", "run", "src/main.ts", "--output-format", "text", prompt]).stdout
  ).text();

  expect(ours.trim()).toBe(ref.trim());
});
```

- [ ] **Step 3: Run unit tests (golden skipped by default)**

Run: `bun test`
Expected: all unit tests PASS; `golden` SKIPPED.

- [ ] **Step 4: Run the golden test against the real binary**

Run: `CLAUDE_PTY_E2E=1 bun test tests/golden.test.ts`
Expected: PASS — our text output equals `claude -p` text output. If it differs, calibrate `READY_RE` / turn-done timing in `driver.ts` until it matches.

- [ ] **Step 5: Compile the binary**

Run: `bun build src/main.ts --compile --outfile claude-pty.exe`
Expected: `claude-pty.exe` produced. Then:
```bash
./claude-pty.exe --output-format text "Reply with exactly the word: pong"
```
Expected: prints `pong`. (If the native `.node` issue from Task 0 recurs, apply the same fix.)

- [ ] **Step 6: Commit**

```bash
git add src/main.ts tests/golden.test.ts
git commit -m "feat: main entry, golden e2e test, compiled binary"
```

---

## Self-review notes (addressed)

- **Spec coverage:** text/json/stream-json (Tasks 6–8), arg classification incl. consumed/passthrough/special (Task 9), session-id glob lookup (Task 11 `findTranscript`), cost/num_turns/duration reconstruction (Task 5), bun-compile go/no-go (Task 0), bun-compile final binary (Task 11), permissions/`--include-partial-messages` are documented spec limitations — no task needed for the latter (explicitly unsupported in v1).
- **Permissions:** v1 forwards `--permission-mode`/`--allowedTools` as passthrough (Task 9). Auto-answering permission boxes in the driver is **deferred past v1** (not in the golden path with a benign prompt); flagged here so it is a conscious omission, not a gap. Add a driver hook for it when a real prompt requires it.
- **Type consistency:** `Config`, `TranscriptEvent`, `Usage`, `ResultObject`, `costOf`, `reconstruct(events, costFn, sessionId)`, `formatStreamJson(events, result, init)` are used identically across tasks.
```
