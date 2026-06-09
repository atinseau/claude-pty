// src/cli.ts
export interface Config {
  message: string;
  sessionId: string;
  outputFormat: "text" | "json" | "stream-json";
  /** Input format: "text" (default) or "stream-json" (NDJSON multi-turn). */
  inputFormat: "text" | "stream-json";
  verbose: boolean;
  passthrough: string[];
  /** Raw --json-schema value (captured, NOT forwarded directly). */
  jsonSchema?: string;
  /** Raw --system-prompt value (captured, NOT forwarded directly). */
  systemPrompt?: string;
  /** True when --help / -h was passed; main.ts prints helpText() and exits 0. */
  help: boolean;
}

const CONSUMED_WITH_VALUE = new Set(["--output-format"]);

/** Passthrough flags that are boolean — they must NOT consume the following token as a value. */
const PASSTHROUGH_BOOL = new Set([
  "--continue",
  "-c",
  "--fork-session",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--ide",
]);

/**
 * Extract the `--model` value from a passthrough arg list, or "" if absent.
 *
 * Used to populate the model field of the stream-json `system/init` line that
 * claude-pty emits as soon as the session is ready — before any assistant event
 * exists to learn the model from. When the caller did not pin a model, "" is
 * returned (consistent with the emitter's no-assistant fallback).
 */
export function modelFlag(passthrough: string[]): string {
  const i = passthrough.indexOf("--model");
  if (i < 0) return "";
  return passthrough[i + 1] ?? "";
}

/**
 * Build the schema-enforcement instruction for the system prompt.
 * Tells Claude to output ONLY a JSON object conforming to the given schema.
 */
export function buildSchemaInstruction(schema: string): string {
  return (
    "You must respond with ONLY a single JSON object that strictly conforms to the following " +
    "JSON Schema. Output nothing else: no prose, no explanation, no markdown code fences. " +
    "JSON Schema:\n" +
    schema
  );
}

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

EXIT CODES
  0  success
  1  runtime error (e.g. auth failure, max turns, empty transcript)
  2  invalid arguments (e.g. --print/-p passed)
`;
}

export function parseArgs(
  argv: string[],
  genId: () => string = () => crypto.randomUUID(),
): Config {
  // --help / -h short-circuits everything else (even --print/-p and a message):
  // return immediately so main.ts can print helpText() and exit 0.
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      message: "",
      sessionId: "",
      outputFormat: "text",
      inputFormat: "text",
      verbose: false,
      passthrough: [],
      help: true,
    };
  }

  let message = "";
  let outputFormat: Config["outputFormat"] = "text";
  let inputFormat: Config["inputFormat"] = "text";
  let verbose = false;
  let sessionId = "";
  const passthrough: string[] = [];
  let jsonSchema: string | undefined;
  let systemPrompt: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;

    // --print / -p: explicitly unsupported — claude-pty IS the -p replacement.
    if (a === "--print" || a === "-p") {
      throw new Error(
        "claude-pty replaces 'claude -p'; the --print/-p flag is not supported",
      );
    }

    if (a === "--verbose") {
      verbose = true;
      continue;
    }
    // Daemon control flags are claude-pty-owned: consume them so they never leak
    // to the claude TUI's argv. --daemon (server mode) is handled in main()
    // before parseArgs; --no-daemon only opts the client out of using a daemon.
    if (a === "--daemon" || a === "--no-daemon") {
      continue;
    }
    if (a === "--output-format") {
      outputFormat = argv[++i] as Config["outputFormat"];
      continue;
    }
    if (a === "--input-format") {
      inputFormat = argv[++i] as Config["inputFormat"];
      continue;
    }
    if (CONSUMED_WITH_VALUE.has(a)) {
      i++;
      continue;
    }

    // Capture --json-schema: do NOT forward to passthrough.
    if (a === "--json-schema") {
      jsonSchema = argv[++i];
      continue;
    }

    // Capture --system-prompt: do NOT forward to passthrough yet (merged below).
    if (a === "--system-prompt") {
      systemPrompt = argv[++i];
      continue;
    }

    if (a === "--session-id") {
      sessionId = argv[i + 1] ?? "";
      passthrough.push(a, argv[++i]!);
      continue;
    }
    if (a.startsWith("-")) {
      passthrough.push(a);
      if (
        !PASSTHROUGH_BOOL.has(a) &&
        i + 1 < argv.length &&
        !argv[i + 1]!.startsWith("-")
      )
        passthrough.push(argv[++i]!);
      continue;
    }
    message = a;
  }

  // Build effective system prompt:
  // If --json-schema present, merge user's --system-prompt (if any) with the
  // schema instruction and forward as a single --system-prompt.
  // If only --system-prompt present (no schema), forward it as-is.
  const schemaInstruction = jsonSchema
    ? buildSchemaInstruction(jsonSchema)
    : undefined;
  const mergedSP = [systemPrompt, schemaInstruction]
    .filter(Boolean)
    .join("\n\n");
  if (mergedSP) passthrough.push("--system-prompt", mergedSP);

  if (!sessionId) sessionId = genId();
  return {
    message,
    sessionId,
    outputFormat,
    inputFormat,
    verbose,
    passthrough,
    jsonSchema,
    systemPrompt,
    help: false,
  };
}
