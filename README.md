# claude-pty

> A drop-in replacement for `claude -p` that drives the **real interactive Claude Code TUI** through a pseudo-terminal — and never shells out to `claude -p`.

`claude-pty <any claude args> "message"` behaves like `claude -p <any claude args> "message"`: same output formats, same streaming cadence, same exit codes. The difference is what happens under the hood. Instead of running Claude in headless print mode, `claude-pty` spawns the **actual interactive TUI** inside a pty, drives it programmatically, and reconstructs `-p`-identical output from the session's JSONL transcript.

```bash
claude-pty --output-format json "Summarize this repository"
# → same JSON envelope as `claude -p --output-format json "..."`,
#   but produced by driving the real interactive session.
```

---

## Table of contents

- [Why does this exist?](#why-does-this-exist)
- [How it works](#how-it-works)
- [Install](#install)
- [Install (release binary)](#install-release-binary)
- [Usage](#usage)
- [Parity with `claude -p`](#parity-with-claude--p)
- [Architecture](#architecture)
- [Scripts](#scripts)
- [Build](#build)
- [Limitations](#limitations)
- [How this project was built](#how-this-project-was-built)

---

## Why does this exist?

`claude -p` (print / headless mode) is the standard way to use Claude Code programmatically. But it is a *different runtime* from the interactive TUI you use day-to-day — different startup path, different behaviors, no interactive session.

The goal here is the opposite: **drive the genuine interactive session** — the same one you'd get by typing `claude` in your terminal — while still getting clean, scriptable output that matches `claude -p` byte-for-byte where possible. `claude-pty` deliberately **never invokes `claude -p`**; if you pass `--print`/`-p`, it errors out, because it *is* the replacement.

This gives you a programmatic handle on a real interactive Claude Code session: send a prompt, stream the events as they happen, get a structured result and a faithful exit code — all by puppeteering the TUI rather than bypassing it.

## How it works

The core idea: **the pty is only a remote control; the JSONL transcript is the source of truth.**

```
 argv ─▶ cli ─▶ session ──┐
                          ▼
              driver (node-pty) ──spawns──▶ real `claude` interactive TUI
                  │                                  │
                  │  reads the pty stream ONLY for   │ writes the conversation to
                  │  three binary signals:           ▼
                  │   • prompt ready  (❯ + U+00A0)   ~/.claude/projects/**/<session-id>.jsonl
                  │   • turn done     (prompt back)         │
                  │   • permission box → auto-deny (ESC)    │ tailer reads it
                  │                                         │ incrementally as it grows
                  └─────────────── injects keystrokes       ▼
                                                  reconstruct · errors · structured
                                                            │
                                                            ▼
                                          format/{text,json,stream-json} ─▶ stdout
```

1. **`driver`** spawns the real `claude` TUI in a pty and watches the raw byte stream — but *only* to detect when the input prompt is ready, when a turn has finished, and when a tool-permission box appears (which it auto-denies with `Esc`, exactly as `claude -p` denies tools outside `--allowedTools`). It never parses the screen for content.
2. Claude writes the full conversation — assistant messages, tool calls with complete input JSON, tool results, token usage — to its JSONL transcript.
3. **`tailer`** follows that transcript incrementally. As lines appear, **`format/stream-json`** emits events live; `text`/`json` buffer until the turn completes.
4. **`reconstruct`** assembles the final `result` object (cost estimated from a pricing table, turn count, duration), **`errors`** detects failure states (auth, max-turns) and sets the exit code, and **`structured`** validates `--json-schema` output.

Result: **zero ANSI screen-scraping for content.** The fragile part of driving a TUI (parsing redraws) is avoided entirely.

## Install

Prerequisites:

- [Bun](https://bun.com) (v1.3+)
- [Claude Code](https://claude.com/claude-code) installed — `claude-pty` drives the real `claude` binary.

```bash
bun install
```

Point `claude-pty` at your `claude` binary if it isn't at the default path:

```bash
export CLAUDE_PTY_BIN="/path/to/claude"   # default: C:\Users\arthur\.local\bin\claude.exe
```

Run it directly with Bun, or compile a binary (see [Build](#build)):

```bash
bun run src/main.ts --output-format text "hello"
```

## Install (release binary)

Prefer not to build from source? Each [GitHub Release](../../releases) ships a
prebuilt archive per OS/arch. Pick the one matching your platform:

| Platform | Archive |
| --- | --- |
| Windows x64 | `claude-pty-windows-x64.zip` |
| macOS Apple Silicon | `claude-pty-darwin-arm64.tar.gz` |
| Linux x64 | `claude-pty-linux-x64.tar.gz` |

Prerequisites:

- [Claude Code](https://claude.com/claude-code) installed — `claude-pty` drives the real `claude` binary.
- If `claude` isn't on your `PATH`, point at it: set `CLAUDE_PTY_BIN=/path/to/claude`.

> **Keep them together.** Every archive contains the `claude-pty` (or
> `claude-pty.exe`) binary **and** a `node_modules/node-pty/` folder. The binary
> is not standalone — at runtime it loads the native `node-pty` from a
> `node_modules/node-pty/` directory sitting **next to the executable's real
> location**. Always extract both into the same folder and keep them together.

### Windows

1. Download `claude-pty-windows-x64.zip` from the latest release.
2. Extract it to a stable folder, e.g. `%LOCALAPPDATA%\claude-pty`. After
   extraction that folder should contain `claude-pty.exe` and
   `node_modules\node-pty\`.
3. Add the folder to your user `PATH`:
   - GUI: Settings → System → About → Advanced system settings → Environment
     Variables → edit **Path** (user) → add `%LOCALAPPDATA%\claude-pty`.
   - Or from a terminal (persists for new shells):
     ```cmd
     setx PATH "%PATH%;%LOCALAPPDATA%\claude-pty"
     ```
4. Open a **new** terminal and run `claude-pty "hello"`.

### macOS / Linux

1. Download the matching `.tar.gz` (e.g. `claude-pty-darwin-arm64.tar.gz`).
2. Extract it to a stable folder, e.g. `~/.local/claude-pty`:
   ```bash
   mkdir -p ~/.local/claude-pty
   tar -xzf claude-pty-darwin-arm64.tar.gz --strip-components=1 -C ~/.local/claude-pty
   chmod +x ~/.local/claude-pty/claude-pty
   ```
   That folder should now contain `claude-pty` and `node_modules/node-pty/`.
3. Put it on your `PATH`, either by adding the folder:
   ```bash
   echo 'export PATH="$HOME/.local/claude-pty:$PATH"' >> ~/.zshrc   # or ~/.bashrc
   ```
   or by symlinking just the binary into a directory already on `PATH`:
   ```bash
   ln -s ~/.local/claude-pty/claude-pty ~/.local/bin/claude-pty
   ```
   A symlink is fine: `node-pty` is resolved relative to the binary's **real**
   path (`process.execPath`), so the bundled `node_modules/node-pty/` is still
   found via the symlink target — just keep the binary and that folder together.
4. Open a **new** terminal and run `claude-pty "hello"`.

> **First-run caveat.** Unlike `claude -p`, `claude-pty` drives the interactive
> TUI, so the **very first** run in a brand-new directory may show Claude's
> workspace-trust prompt. Run `claude-pty` once in a project you've already
> trusted, or trust the folder, and subsequent runs proceed non-interactively.

## Usage

```bash
# Show usage for claude-pty's own flags (does not drive the TUI)
claude-pty --help

# Plain text (default) — prints the final assistant message
claude-pty "What does this project do?"

# Full JSON result envelope (result, session_id, usage, cost, num_turns, is_error…)
claude-pty --output-format json "Find the riskiest file"

# Real-time stream-json — events emitted as the turn progresses
claude-pty --output-format stream-json "Refactor the parser"

# Pipe context in via stdin (appended to the prompt, like `claude -p`)
cat build-error.log | claude-pty "Explain this error"

# Pass through any interactive claude flag
claude-pty --model opus --allowedTools "Read,Grep" "Audit auth.ts"

# Structured output — validated against a JSON Schema (no `-p` used)
claude-pty --output-format json \
  --json-schema '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}' \
  "Summarize the README"

# Multi-turn input — newline-delimited JSON user messages on stdin
printf '%s\n%s\n' \
  '{"type":"user","content":"Remember the number 7."}' \
  '{"type":"user","content":"What number did I say?"}' \
  | claude-pty --input-format stream-json --output-format stream-json

# Resume / continue a prior session
claude-pty --continue "And now write the tests"
claude-pty --resume <session-id> "Keep going"
```

Useful env vars:

- `CLAUDE_PTY_BIN` — path to the `claude` binary.
- `CLAUDE_PTY_TURN_TIMEOUT_MS` — per-run hard deadline (default `600000`). Guards against a hung turn.

## Parity with `claude -p`

| Capability | Status |
| --- | --- |
| `--output-format text` | ✅ identical |
| `--output-format json` (result envelope) | ✅ — `result` / `session_id` / `usage` exact; `total_cost_usd` estimated |
| `--output-format stream-json` (real-time) | ✅ event-level, streamed live |
| `stdin` (piped message / context append) | ✅ |
| `--input-format stream-json` (multi-turn) | ✅ sequential injection |
| Error detection + non-zero exit codes (auth, max-turns) | ✅ verified against real `claude -p` |
| Tool-permission handling (deny outside `--allowedTools`) | ✅ auto-deny via the TUI |
| `--resume` / `--continue` | ✅ |
| `--json-schema` structured output | ✅ via an injected system prompt (approximation — see [Limitations](#limitations)) |
| `--model`, `--system-prompt`, `--append-system-prompt`, `--allowedTools`, … | ✅ passed through |
| `--print` / `-p` | ⛔ rejected by design (`claude-pty` replaces it) |
| `-h` / `--help` | ✅ prints `claude-pty`'s own usage and exits 0 (does not drive the TUI) |
| `--include-partial-messages` (token deltas) | ❌ not reconstructable from the transcript |

## Architecture

Small, single-responsibility modules with well-defined interfaces:

| Module | Responsibility |
| --- | --- |
| `src/cli.ts` | Parse argv → `Config`; classify consumed vs. passthrough flags; reject `--print`/`-p`; short-circuit `-h`/`--help`; capture `--json-schema` / `--system-prompt` / `--input-format`. |
| `src/session.ts` | Resolve which transcript to follow (generated id / `--session-id` / `--resume` / `--continue` discovery). |
| `src/driver.ts` | Spawn the TUI in a pty; emit ready / turn-done signals; inject messages; auto-deny permission boxes. Multi-turn capable. |
| `src/tailer.ts` | Incremental cursor over the growing JSONL — yields only newly completed events. |
| `src/transcript.ts` | Parse JSONL lines into typed `TranscriptEvent`s. |
| `src/reconstruct.ts` | Aggregate events into the `-p` `result` object. |
| `src/errors.ts` | Detect error states (auth, max-turns) from the transcript + pty text. |
| `src/structured.ts` | Extract + validate JSON for `--json-schema`. |
| `src/ndjson.ts` | Parse NDJSON user messages for `--input-format stream-json`. |
| `src/pricing.ts` | Model → price table, used to estimate cost. |
| `src/format/{text,json,streamjson}.ts` | Render events/result to each output format. |
| `src/main.ts` | Orchestrate: parse → drive → tail → format → exit. |

The Windows/Bun specifics of driving ConPTY (capturing the conin fd to work around a Bun `net.Socket` write bug, and loading `node-pty` via `createRequire` so the patch applies before the native module initializes) are documented inline in `src/driver.ts`, and the original go/no-go proof lives in `spike/hello-pty.ts`.

## Scripts

| Script | What it does |
| --- | --- |
| `bun run check` | Lint + format check via [Biome](https://biomejs.dev) — the CI / pre-commit gate |
| `bun run check:fix` | Apply Biome lint + format fixes |
| `bun run format` / `bun run lint` | Format-only / lint-only |
| `bun run check-types` | `tsc --noEmit` |
| `bun run test` | `bun test` |
| `bun run build` | Compile a binary for the current platform → `claude-pty.exe` |
| `bun run build:all` | Cross-compile for all main targets into `dist/` |
| `bun run bench` | Benchmark end-to-end latency vs `claude -p` (real API calls) — total, time-to-first-event, and the spawn→ready phase. Flags: `--reps N`, `--prompt "…"`, `--no-baseline` |

A [lefthook](https://lefthook.dev) **pre-commit** hook runs `check`, `check-types`, and `test` in parallel — a failing check blocks the commit. Run `bunx lefthook install` after cloning to enable it.

## Build

```bash
bun run build        # → ./claude-pty.exe (current platform)
bun run build:all    # → ./dist/claude-pty-<os>-<arch>
```

> **Heads-up: the binaries are not standalone.** `claude-pty` depends on **node-pty**, a native module whose code is *not* bundled into the compiled binary. At runtime the binary still needs `node_modules/node-pty/` (with the prebuild matching the host OS/arch) present in the run directory. Cross-compiled targets from `build:all` only run where the corresponding node-pty prebuild is installed — ship them alongside a matching `node_modules/node-pty/`.

## Daemon mode (optional, opt-in)

By default every `claude-pty` invocation spawns the TUI in-process (the *direct*
path) — nothing changes unless you opt in.

Set `CLAUDE_PTY_DAEMON=1` to route runs through a **background daemon** instead.
The first run launches the daemon (the *same single binary*, just `claude-pty
--daemon`, detached); subsequent runs connect to it over a loopback socket. The
daemon drives the TUI on your behalf and streams `-p`-identical output back, so
behaviour is unchanged. It idles out after a few minutes.

- It is a **pure optimization with a hard fallback**: on *any* daemon problem the
  client silently runs the direct path, so a run never fails because of the
  daemon. Force the direct path per-run with `--no-daemon`.
- The daemon is keyed to your build; a stale daemon from an older binary is
  ignored. The endpoint lives at `~/.claude-pty/daemon.json` (loopback port +
  token, `0600`).
- Today (M2) the daemon spawns a fresh TUI per request, so it does not yet make a
  single run faster — it is the foundation for a warm-TUI pool that removes the
  TUI-startup cost on repeated calls.

## Limitations

Honest about what the TUI-driven approach can and can't match:

- **`--include-partial-messages` is unsupported** — the transcript stores whole messages, not token-by-token deltas, so streaming deltas cannot be reconstructed without ANSI parsing (which this design avoids).
- **`total_cost_usd` is an estimate** — the transcript records per-message token usage but not the aggregated cost `-p` computes; cost is derived from a built-in pricing table.
- **`--json-schema` is an approximation** — real `-p` uses native constrained decoding; `claude-pty` injects a "respond with only JSON matching this schema" system prompt and validates the result. A minimal validator (`type`, `required`, property types — no `$ref`/`anyOf`/`enum`/…) is used. On failure it matches `-p`'s envelope (`is_error: true`, single turn) rather than retrying.
- **Signal calibration is version-coupled** — the prompt-ready signal (`❯` + U+00A0) and the permission-box matcher were calibrated against **Claude Code 2.1.168**. A global turn timeout makes a broken signal fail loudly instead of hanging.

## How this project was built

`claude-pty` was built test-first, with each capability validated against the **real** `claude -p` before being trusted. The design specs and implementation plans live under [`docs/superpowers/`](docs/superpowers/), and the empirical calibration findings (prompt signal, permission box, error catalog) under [`docs/superpowers/findings/`](docs/superpowers/findings/).
