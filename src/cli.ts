// src/cli.ts
export interface Config {
  message: string;
  sessionId: string;
  outputFormat: "text" | "json" | "stream-json";
  verbose: boolean;
  passthrough: string[];
}

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
      if (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) passthrough.push(argv[++i]!);
      continue;
    }
    message = a;
  }

  if (!sessionId) sessionId = genId();
  return { message, sessionId, outputFormat, verbose, passthrough };
}
