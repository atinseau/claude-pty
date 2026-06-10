// src/domain/chain.ts
//
// Turn-chain filter for shared transcript files (--resume / --continue).
//
// claude allows resuming the SAME session from two processes in parallel: both
// append their turns interleaved into one .jsonl, no lock, no fork (verified
// against the real CLI). Real `claude -p` is immune in its OUTPUT because it
// holds the conversation in memory — claude-pty reconstructs its result by
// tailing the file, so without this filter each driver would also collect the
// OTHER run's events (mixed result text, summed usage/cost, early turn-done).
//
// The filter follows the transcript's uuid/parentUuid chain over RAW line
// objects, pre-parse, because the chain passes through line types the parser
// ignores (`attachment` sits between our user message and the assistant
// reply), and the injected user line itself carries STRING content the parser
// also ignores.
//
// Protocol: seed() the exact text of each message right before injecting it;
// admit() every raw line the tail reads. A user prompt whose text matches the
// pending seed claims the chain root; descendants are admitted by parent
// membership; uuid'd lines outside the chain (the other run's turn) are
// rejected. Lines without a uuid are metadata (mode, queue-operation, …) — the
// parser ignores them, so they pass through untouched.
//
// Known limitation: two parallel runs injecting IDENTICAL text are
// indistinguishable from the file alone — the first arrival claims the seed
// (the real claude CLI cannot be confused this way; nothing downstream can fix
// that without claude exposing a per-process marker).

interface RawLine {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  message?: { content?: unknown };
}

/** The prompt text of a raw user line: string content, or its text blocks joined. */
function promptText(o: RawLine): string | null {
  if (o.type !== "user") return null;
  const c = o.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const texts = c.filter(
      (b) => b && typeof b === "object" && b.type === "text",
    );
    if (texts.length === 0) return null; // tool_result-only: not a prompt
    return texts.map((b) => b.text ?? "").join("\n");
  }
  return null;
}

export interface ChainFilter {
  /** Register the exact text of the NEXT message this run injects. */
  seed(messageText: string): void;
  /** True when this raw transcript line belongs to this run's chain. */
  admit(raw: unknown): boolean;
}

export function makeTurnChainFilter(): ChainFilter {
  const ours = new Set<string>();
  const pendingSeeds: string[] = [];

  return {
    seed(messageText: string): void {
      pendingSeeds.push(messageText.trim());
    },

    admit(raw: unknown): boolean {
      if (typeof raw !== "object" || raw === null) return true;
      const o = raw as RawLine;
      const uuid = typeof o.uuid === "string" ? o.uuid : "";
      if (!uuid) return true; // metadata line: no chain identity, parser ignores it

      const parent = typeof o.parentUuid === "string" ? o.parentUuid : "";
      if (parent && ours.has(parent)) {
        ours.add(uuid);
        return true;
      }

      const text = promptText(o);
      if (
        text !== null &&
        pendingSeeds.length > 0 &&
        text.trim() === pendingSeeds[0]
      ) {
        pendingSeeds.shift();
        ours.add(uuid);
        return true;
      }

      return false;
    },
  };
}
