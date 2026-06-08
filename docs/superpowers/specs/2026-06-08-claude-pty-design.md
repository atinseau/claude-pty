# claude-pty — Design

**Date:** 2026-06-08
**Status:** Approved, pre-implementation

## Goal

`claude-pty` is a **drop-in replacement for `claude -p`**. It accepts the same
arguments and a message, and produces the same output — but instead of calling
`claude -p`, it drives the **real interactive Claude Code TUI** through a pty
(`node-pty`) and reads the session's structured JSONL transcript as the source
of truth.

```
claude-pty <any claude args> "message"
claude -p  <any claude args> "message"   # same observable behavior
```

Explicit non-goal: we do not call `claude -p` under the hood, ever.

Finality: ship a standalone binary via `bun build --compile` (`claude-pty.exe`).

## Why this is feasible (key insight)

The interactive TUI is **lossy** (it renders `● Read(x)` summaries, not raw
JSON). But Claude Code persists every session as structured JSONL at
`~/.claude/projects/<project-hash>/<session-id>.jsonl`. Verified on the target
machine (Claude Code 2.1.168):

- `type:"assistant"` lines carry the raw API message: `content[]` (text +
  `tool_use` with **complete input JSON**), `usage` (input/output/cache tokens),
  `model`.
- `type:"user"` lines carry `tool_result`.
- The aggregated `-p` `result` object (`total_cost_usd`, `num_turns`,
  `duration_ms`) is **not** persisted — it is computed by the CLI at runtime, so
  we **reconstruct** it (cost = tokens × pricing table, `num_turns` = count,
  `duration_ms` = timestamp delta).

Consequence: **zero ANSI parsing**. The pty drives; the JSONL is truth.

## Architecture

```
cli.ts          parse argv → config (consumed args vs passthrough args)
driver.ts       node-pty: spawn interactive claude, detect "prompt ready",
                inject the message, detect "turn done", kill the process.
                Reads the pty stream ONLY for binary signals (ready / done)
                and permission-prompt handling — never for content.
transcript.ts   locate + tail the session JSONL, parse each line into typed events
reconstruct.ts  aggregate lines → final `result` object (cost / num_turns / duration)
format/
  text.ts       transcript → plain final text (matches -p text)
  json.ts       transcript → single result object (matches -p json)
  streamjson.ts transcript → NDJSON event stream (matches -p stream-json)
pricing.ts      model → price table, used to reconstruct cost
```

**Design principle:** `driver` extracts only two binary signals from the pty
("prompt ready", "turn done") plus permission-prompt answers. All content flows
from `transcript`.

## Invocation lifecycle

```
1. cli         generate a session-id (UUID v4); classify args
2. driver      spawn:  claude --session-id <uuid> [passthrough args]
               in a pty (cwd = current cwd); wait for "prompt ready" signal
3. driver      inject the message (keystrokes + Enter into the pty)
4. transcript  locate ~/.claude/projects/**/<uuid>.jsonl via glob on the uuid
               (no need to recompute the cwd→hash transform); begin tailing
5. loop        transcript emits events as lines append; format/ writes stdout
               according to --output-format
6. driver      sees "turn done" (prompt box reappeared) → stop the loop
7. reconstruct compute the final result object; format/ emits it
8. driver      kill the pty; exit code reflects is_error
```

Because **we impose `--session-id`**, the transcript is found by a simple glob
`**/<uuid>.jsonl` under `~/.claude/projects/` — sidestepping the fragile
cwd→hash transformation.

## Argument handling

| Category | Args | Treatment |
|---|---|---|
| **Consumed** (we implement their semantics) | `-p/--print` (implicit), `--output-format`, `--input-format`, `--verbose`, `--include-partial-messages`, `--replay-user-messages`, `--json-schema` | never forwarded |
| **Passthrough** to the interactive instance | `--model`, `--effort`, `--system-prompt`, `--append-system-prompt`, `--add-dir`, `--mcp-config`, `--settings`, `--allowedTools`, `--disallowedTools`, `--agents`, `--bare`, … | forwarded verbatim |
| **Special** | `--session-id` (use the user's if given, else generate), `--resume`/`--continue`/`--fork-session` (tail *that* transcript), `--permission-mode` | dedicated logic |

**Permissions:** `-p` denies tools outside `--allowedTools`. In driven
interactive mode a permission box may still appear; the `driver` answers it
automatically per policy (default deny, matching `-p`). This is the only
*semantic* read of the pty stream beyond the idle signal.

## Output fidelity

- **`text`** — print the last assistant message's text. Faithful to `-p`.
- **`json`** — reconstructed `result` object. `result`/`session_id`/`usage`
  exact (from transcript); `total_cost_usd`/`num_turns`/`duration_ms`
  reconstructed (cost is an estimate to the pricing-table's accuracy).
- **`stream-json`** — map each transcript line → NDJSON event (`system/init`
  synthesized, `assistant`, `user`, final `result`). Faithful at the
  **message** level.
  - **Limitation:** `--include-partial-messages` is **not supported in v1**.
    The transcript stores whole messages, not token deltas; deltas are not
    reconstructable from JSONL (reconstructing them would require ANSI parsing,
    which this design explicitly avoids). Documented as unsupported.

## v1 scope

- Output formats delivered in tiers: `text` → `json` → `stream-json`.
- Single message; current cwd; passthrough of `--model` / `--system-prompt` /
  `--allowedTools`.
- Standalone binary via `bun build --compile`.

## Risks (prototype in Phase 0 before building the rest)

1. **`bun build --compile` + node-pty** — node-pty is a native module (prebuilt
   `.node`). `--compile` must embed/locate that native binary. **Risk #1, the
   true go/no-go**: a compiled "hello pty" that actually runs.
2. **"prompt ready" / "turn done" detection** — the only heuristic over the pty
   stream; a tolerant pattern calibrated to Claude Code 2.1.168.
3. **Message injection** — keystrokes + Enter vs positional prompt vs bracketed
   paste (multiline).
4. **Auto-answering permission boxes.**
5. **Transcript file appearance** — timing/glob race after spawn.

## Methodology

**TDD throughout.** Each unit (`cli`, `transcript`, `reconstruct`, `format/*`,
`pricing`) is built test-first against recorded fixtures:

- `transcript` / `reconstruct` / `format/*` / `pricing` are **pure functions**
  over JSONL fixtures → straightforward unit tests (capture real transcript
  lines as fixtures, assert the produced output matches `claude -p`'s output for
  the same session).
- `driver` (pty I/O) is the hard-to-unit-test boundary → kept thin; covered by a
  small number of integration tests plus the Phase 0 spike.

Golden-file strategy: run a real `claude -p` once per format, capture its stdout
as the expected fixture, and assert `claude-pty` reproduces it byte-for-byte
(modulo reconstructed cost/duration tolerances).
