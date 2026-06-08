# claude-pty v2 — Design (full `claude -p` parity)

**Date:** 2026-06-08
**Status:** Approved, pre-implementation
**Builds on:** v1 (`2026-06-08-claude-pty-design.md`) — shipped, single-prompt text/json/stream-json via batch read.

## North star

**Reproduce the observable behavior of `claude -p` as faithfully as possible.**
Every design choice is judged against one test: *does `claude-pty <args> <msg>` produce
the same output, streaming cadence, and exit code as `claude -p <args> <msg>`?* Where the
interactive TUI cannot supply something `-p` emits (e.g. token-delta partial messages),
the gap is documented, not faked.

Unchanged invariant from v1: **the pty only yields signals** (prompt-ready, turn-done,
permission-box); **all content comes from the JSONL transcript**. No ANSI parsing for content.

## Scope (all four v2 tracks)

1. Error detection + exit codes
2. Real-time `stream-json` + stdin
3. Auto-answer permission prompts (deny)
4. `--resume`/`--continue` + structured output + `--input-format stream-json`

Build order (each tier independently shippable): **live-loop socle → errors+exit →
permissions → stdin → resume/continue → structured/input-format (last, defer-able).**

---

## Architecture pivot: batch → unified live tail loop

v1 reads the transcript *after* `onTurnDone`. Real-time `stream-json` requires tailing the
JSONL *during* the turn. v2 unifies on one path: tail incrementally, and the formatter
decides when to emit.

```
tailer.ts      NEW. Incremental JSONL reader: tracks byte offset, parses appended lines,
               yields each TranscriptEvent as it appears. Pure-ish; tested with a growing fixture.
session.ts     NEW. Resolves WHICH transcript to tail: generated id / --session-id /
               --resume <id> / --continue (discover most-recently-modified .jsonl for cwd).
errors.ts      NEW. detectError(events, ptyText) -> { isError, subtype } | null. Pure.
format/streamjson.ts  REFACTOR. Incremental emission (one event at a time) in addition to
               batch: synthesize system/init as soon as model+session_id are known, then
               emit each assistant/user event live, then the final result.
driver.ts      EXTEND. + permission-box detection and auto-deny (2nd semantic pty read);
               expose pty text to errors.ts.
main.ts        REFACTOR. Live-loop orchestration:
               parse(+stdin) -> session resolve -> driver -> tailer -> sink(format)
               -> termination -> exit code.
stdin.ts       NEW (small). Read piped stdin when present.
```

### Unified flow
1. Parse args; read stdin if piped; resolve the session/transcript to tail.
2. `driver`: spawn pty, inject message(s).
3. `tailer`: emit each new `TranscriptEvent` as the JSONL grows.
4. `sink` (per `--output-format`): `stream-json` writes each event immediately; `text`/`json` buffer.
5. **Termination** = (pty idle `❯`+U+00A0) **AND** (last assistant event has a terminal
   `stop_reason` with no pending `tool_use`) **OR** error detected **OR** global timeout
   (`CLAUDE_PTY_TURN_TIMEOUT_MS`, default 10 min).
6. Final emission (the `result` object) + exit code from `is_error`.

---

## Track 1 — Error detection + exit codes

`errors.ts: detectError(events, ptyText) -> { isError: boolean; subtype: string } | null`

- **Sources:** (a) the transcript — error-type lines, `stop_reason: "refusal"`, `max_tokens`,
  api-retry/error records; (b) the pty stream — errors that never reach the JSONL (auth,
  quota, TUI error banners).
- **Effect:** `result.is_error = true`, `result.subtype = "error_*"` (best-effort), and a
  **non-zero exit code**.
- **Fidelity:** pragmatic first — reliable `is_error` + non-zero exit, with a `subtype`
  matched to `-p`'s vocabulary when identifiable (`error_max_turns`,
  `error_during_execution`, refusal, …). The exhaustive `-p` subtype taxonomy depends on
  observed cases → **Spike A** catalogs them (trigger auth / max-turns / refusal, inspect
  JSONL + pty). Faithfulness to `-p`'s exact subtype strings is a goal, bounded by what the
  TUI/transcript actually expose.

## Track 2 — Real-time `stream-json` + stdin

- **Real-time:** `format/streamjson.ts` emits incrementally off the tailer. `system/init` is
  synthesized as soon as `session_id` (known up-front) and `model` (first assistant line)
  are available; assistant/user events stream as the JSONL grows; `result` is emitted at
  termination. Cadence should approximate `-p` (per-message, not per-token; partial messages
  are out of scope — see Limitations).
- **stdin:** if stdin is piped (not a TTY), read it. Final message = non-empty of
  `[positional arg, stdin content]` joined — mirroring `-p` (`cat err.txt | claude-pty
  "explain"` and `echo msg | claude-pty` both work).

## Track 3 — Auto-answer permission prompts (deny)

- **Policy (decided): deny**, faithful to `-p` (which denies tools outside `--allowedTools`).
- **Detection:** the driver gains a tolerant matcher for the permission box (text like
  "Do you want to proceed?" + options "❯ 1. Yes / 2. No"), **calibrated against Claude Code
  2.1.168** the same way the prompt signal was → **Spike B** (trigger a real box, capture
  the raw render + the exact keystroke that denies).
- **Action:** send the deny keystroke via `ptyWrite`, once per box (anti-double-fire), then
  let the turn continue.
- **`-p` consistency:** since `--permission-mode`/`--allowedTools` are passed through, no box
  appears under `bypassPermissions`/`acceptEdits`; auto-deny only fires under `default` for
  non-pre-authorized tools — exactly `-p`'s behavior.

## Track 4 — resume/continue + structured output + multi-turn input

- **`--resume <id>` / `--session-id <id>`:** id known → tail that file; do not also inject a
  generated `--session-id`.
- **`--continue`:** id not passed by us → `session.ts` records the most-recently-modified
  `.jsonl` for the cwd's project dir *before* spawn and tails it (claude `--continue`
  re-appends). `--fork-session` creates a new id → confirmed by **Spike C**.
- **`--json-schema` (structured output):** passthrough; if `structured_output` appears in the
  transcript, surface it in the `json` result's `structured_output` field. Where it lands in
  interactive mode is uncertain → **Spike C** decides: implement or document as deferred.
- **`--input-format stream-json`:** read NDJSON user messages from stdin and inject them
  sequentially (multi-turn extension of the live loop). Substantial; **last tier**, shippable
  on its own.

---

## Phase-0 spikes (blocking investigations, do early)

- **Spike A — error catalog:** trigger auth / max-turns / refusal; inspect JSONL + pty;
  enumerate detectable signals and their `-p` subtype mapping. Feeds `errors.ts`.
- **Spike B — permission box:** trigger a real permission box; capture raw pty render + the
  exact deny keystroke. Feeds `driver.ts`.
- **Spike C — continue/json-schema:** confirm `--continue`/`--fork-session` session-id
  behavior and where (if anywhere) `structured_output` lands in the transcript.

## Testing

- `tailer`, `errors`, incremental `streamjson` are pure → unit tests with growing-fixture
  inputs (append lines, assert emitted events/output).
- `session.ts` resolution → unit tests over a fake projects dir.
- Permission auto-deny → calibration + one guarded integration test (`CLAUDE_PTY_E2E=1`).
- **Golden e2e per format**, including `stream-json`: compare the *event sequence* to
  `claude -p`'s, modulo non-reconstructable fields (exact cost/usage, partial messages).
- Exit-code tests: assert non-zero on a deliberately-erroring invocation.

## Limitations (documented, not faked)

- **`--include-partial-messages`** remains unsupported: the JSONL stores whole messages, not
  token deltas; reconstructing deltas would require ANSI parsing, which the design forbids.
- **`total_cost_usd`** stays an estimate (pricing table), since the transcript omits the
  aggregated cost `-p` computes.
- The `❯`+U+00A0 readiness signal and the permission-box matcher are **coupled to Claude Code
  2.1.168**; the global turn timeout makes a broken signal fail loudly rather than hang.
- `structured_output` may be deferred if Spike C shows it is not recoverable from the
  interactive transcript.
```
