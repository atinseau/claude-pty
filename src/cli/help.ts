// src/cli/help.ts
//
// claude-pty's own usage text. Kept apart from the parser so args.ts stays
// purely about parsing.

/**
 * Render claude-pty's own usage text.
 *
 * Documents ONLY the flags claude-pty owns/consumes plus its passthrough
 * behaviour, env vars and exit codes — it deliberately does NOT duplicate
 * claude's own flag list (those are forwarded to the real TUI; run
 * `claude --help` for them). Pure, returns a string — exported for testing.
 */
export function helpText(): string {
  return `claude-pty — a drop-in replacement for 'claude -p' that drives the real
interactive Claude Code TUI through a pseudo-terminal.

USAGE
  claude-pty [options] "message"
  cat context.txt | claude-pty [options] "message"

OPTIONS OWNED BY claude-pty (consumed, not forwarded to claude)
  --output-format <text|json|stream-json>
                          Output shape. Default: text.
  --input-format <text|stream-json>
                          Input shape. stream-json reads NDJSON user messages
                          from stdin for multi-turn. Default: text.
  --json-schema <schema>  Constrain the reply to a JSON object matching the
                          given JSON Schema (injected via a system prompt).
  --system-prompt <text>  System prompt (merged with the --json-schema
                          instruction when both are given).
  --verbose               Verbose mode.
  --no-daemon             Force the in-process direct path even if the daemon
                          is enabled (see CLAUDE_PTY_DAEMON).
  -h, --help              Show this help and exit.

PASSTHROUGH
  Any other flag (e.g. --model, --allowedTools, --resume, --continue,
  --session-id, --append-system-prompt) is passed through unchanged to the
  real claude TUI. Run 'claude --help' for the full list of those flags.

  --print / -p is rejected by design: claude-pty IS the -p replacement.

ENVIRONMENT
  CLAUDE_PTY_BIN              Path to the claude binary to drive.
  CLAUDE_PTY_TURN_TIMEOUT_MS  Per-run hard deadline in ms. Default: 600000.
  CLAUDE_PTY_DAEMON           Set to 1 to route runs through a background daemon
                              (opt-in, default off). Falls back to the direct
                              path on any daemon error. Override per-run with
                              --no-daemon.
  CLAUDE_PTY_WARM             Warm TUIs kept ready per signature (default 1; 0
                              disables the pool). Removes the TUI-startup cost on
                              repeated same-signature daemon runs.
  CLAUDE_PTY_WARM_MAX         Hard cap on total warm TUIs (default 4).
  CLAUDE_PTY_WARM_TTL_MS      Discard a warm TUI older than this (default 600000).

EXIT CODES
  0  success
  1  runtime error (e.g. auth failure, max turns, empty transcript)
  2  invalid arguments (e.g. --print/-p passed)
`;
}
