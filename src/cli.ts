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
}

const CONSUMED_WITH_VALUE = new Set(["--output-format"]);

/** Passthrough flags that are boolean — they must NOT consume the following token as a value. */
const PASSTHROUGH_BOOL = new Set([
  "--continue", "-c",
  "--fork-session",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--ide",
]);

/**
 * Build the schema-enforcement instruction for the system prompt.
 * Tells Claude to output ONLY a JSON object conforming to the given schema.
 */
export function buildSchemaInstruction(schema: string): string {
  return (
    "You must respond with ONLY a single JSON object that strictly conforms to the following " +
    "JSON Schema. Output nothing else: no prose, no explanation, no markdown code fences. " +
    "JSON Schema:\n" + schema
  );
}

export function parseArgs(argv: string[], genId: () => string = () => crypto.randomUUID()): Config {
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
        "claude-pty replaces 'claude -p'; the --print/-p flag is not supported"
      );
    }

    if (a === "--verbose") { verbose = true; continue; }
    if (a === "--output-format") { outputFormat = argv[++i] as Config["outputFormat"]; continue; }
    if (a === "--input-format") { inputFormat = argv[++i] as Config["inputFormat"]; continue; }
    if (CONSUMED_WITH_VALUE.has(a)) { i++; continue; }

    // Capture --json-schema: do NOT forward to passthrough.
    if (a === "--json-schema") { jsonSchema = argv[++i]; continue; }

    // Capture --system-prompt: do NOT forward to passthrough yet (merged below).
    if (a === "--system-prompt") { systemPrompt = argv[++i]; continue; }

    if (a === "--session-id") { sessionId = argv[i + 1] ?? ""; passthrough.push(a, argv[++i]!); continue; }
    if (a.startsWith("-")) {
      passthrough.push(a);
      if (!PASSTHROUGH_BOOL.has(a) && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) passthrough.push(argv[++i]!);
      continue;
    }
    message = a;
  }

  // Build effective system prompt:
  // If --json-schema present, merge user's --system-prompt (if any) with the
  // schema instruction and forward as a single --system-prompt.
  // If only --system-prompt present (no schema), forward it as-is.
  const schemaInstruction = jsonSchema ? buildSchemaInstruction(jsonSchema) : undefined;
  const mergedSP = [systemPrompt, schemaInstruction].filter(Boolean).join("\n\n");
  if (mergedSP) passthrough.push("--system-prompt", mergedSP);

  if (!sessionId) sessionId = genId();
  return { message, sessionId, outputFormat, inputFormat, verbose, passthrough, jsonSchema, systemPrompt };
}
