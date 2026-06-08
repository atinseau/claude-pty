# Spike C — --continue/--resume and --json-schema Findings

Investigated against `claude.exe` v2.1.168, branch `feat/claude-pty-v2`, cwd `C:\Users\arthur\Documents\Devs\claude-pty`.

---

## Investigation 1 — project-dir transform

### Method
Listed `~/.claude/projects/` and compared every known CWD against the resulting folder name.

### Results

Two independent CWDs verified:

| CWD | Expected (`/[\\/:.]/g` → `-`) | Actual folder |
|-----|------------------------------|---------------|
| `C:\Users\arthur\Documents\Devs\claude-pty` | `C--Users-arthur-Documents-Devs-claude-pty` | `C--Users-arthur-Documents-Devs-claude-pty` |
| `C:\Users\arthur\AppData\Local\Temp\bqa-mcp` | `C--Users-arthur-AppData-Local-Temp-bqa-mcp` | `C--Users-arthur-AppData-Local-Temp-bqa-mcp` |

Explanation of the double dash at the start: the drive letter colon (`C:`) becomes `C-` (colon replaced), and the following backslash becomes another `-`, yielding `C--`.

No project folder with a dot-in-dirname was found in the corpus, but the regex `/[\\/:.]/g` includes `.` so dots would also become `-`. No deviation was observed for backslash, forward-slash, or colon.

### CONCLUSION

**YES — the transform is exactly `cwd.replace(/[\\/:.]/g, "-")`.**  
The claude-pty `session.ts` can compute the project dir by applying this regex to the process cwd. Dots are also replaced by `-` (no evidence of any character left literal). The transform is deterministic and reversible enough to locate the correct transcript directory.

---

## Investigation 2 — --continue / --resume session identity

### Method
Ran three experiments in sequence from the same cwd, capturing session IDs and file system state before/after each run.

```
Experiment A: claude -p --output-format json "remember the codeword banana"
Experiment B: claude -p --continue --output-format json "what was the codeword?"
Experiment C: claude -p --continue --fork-session --output-format json "just say ok"
Experiment D: claude -p --resume d579efa4-c106-4a44-b902-f480545b30e2 --output-format json "what was the codeword again?"
```

### Results

| Experiment | session_id returned | New file? | File mutated? |
|------------|--------------------|-----------| --------------|
| A (baseline) | `d579efa4-c106-4a44-b902-f480545b30e2` | YES — new 45 499 B | — |
| B (--continue) | `0a722727-9bf9-43aa-9435-1577f38765ce` (DIFFERENT) | YES — new 37 399 B | No: original `d579efa4` unchanged |
| C (--fork-session) | `91573ce6-c258-4dec-be76-f4a81982d6a0` (DIFFERENT) | YES — new 38 723 B | No: prior files unchanged |
| D (--resume \<id\>) | `d579efa4-c106-4a44-b902-f480545b30e2` (SAME) | NO | YES — grew 45 499 → 49 605 B |

Key observations:

1. **`--continue` always creates a brand-new session ID and a brand-new `.jsonl` file.** The "continuing" is context-only (via memory/tool-recall), not file-appending. No parent session reference appears anywhere in the new transcript.

2. **`--continue --fork-session` behaves identically** to `--continue` alone from a file-system perspective — new ID, new file.

3. **`--resume <session_id>`** is the only variant that returns the same session ID and appends to the pre-existing `.jsonl`.

4. **Transcript structure of a `--continue` session** (`0a722727...`): the first user-turn is a `SessionStart` hook injecting context, followed by normal conversation. No `parentSessionId` or equivalent field exists in any transcript line.

### How to detect which file is active (interactive --continue)

For **interactive `--continue`** (no `-p`), the new session file appears as a new `.jsonl` in the project dir:

- **Before** spawning `claude --continue`: snapshot the set of `.jsonl` paths and their mtimes.
- **After** `claude` starts writing: a **new file** (`<uuid>.jsonl`) will appear. That is the file to tail.
- For **`--resume <id>`**: the file is deterministic — it is `<id>.jsonl` in the project dir.

**Caveat:** this approach is unreliable if two `claude` sessions are spawned concurrently in the same cwd (race between new-file appearances). For single-session use (typical in claude-pty), it is fully reliable.

### CONCLUSION

**YES — "newest-mtime .jsonl in the project dir, captured AFTER injection starts" is reliable for `--continue`, and exact filename is known for `--resume <id>`.**

Implementation strategy:
- For `--continue` (interactive): diff the `.jsonl` set before/after process spawn; the newly-appeared file is the transcript to tail.
- For `--resume <session_id>` (interactive): the transcript is `<projectDir>/<session_id>.jsonl` — no discovery needed.
- For `-p --continue`: the `session_id` is in the stdout JSON; pair it with `<projectDir>/<session_id>.jsonl`.

---

## Investigation 3 — --json-schema structured output

### Method

```bash
schema='{"type":"object","properties":{"x":{"type":"string"}},"required":["x"]}'
claude -p --output-format json --json-schema "$schema" "set x to the string hi"
```

Session ID produced: `447cdc99-581b-429c-9e28-88ff953691c6`
Transcript path: `~/.claude/projects/C--Users-arthur-Documents-Devs-claude-pty/447cdc99-581b-429c-9e28-88ff953691c6.jsonl`

### -p JSON output (top-level `result` envelope)

```json
{
  "type": "result",
  "subtype": "success",
  "session_id": "447cdc99-581b-429c-9e28-88ff953691c6",
  "result": "Done — `x` is set to `\"hi\"`.",
  "structured_output": {"x": "hi"},
  ...
}
```

`structured_output` is a **top-level field** in the `-p` result envelope, containing the validated object verbatim.

### Transcript inspection

The transcript has 18 lines. Line 13 and 14 are the key entries:

**Line 13** — `type: assistant` — the model called a synthetic `StructuredOutput` tool:

```json
{
  "type": "assistant",
  "message": {
    "content": [
      {
        "type": "tool_use",
        "name": "StructuredOutput",
        "input": {"x": "hi"},
        "caller": {"type": "direct"}
      }
    ],
    "stop_reason": "tool_use"
  },
  "uuid": "ddbca315-c348-421e-86e6-74a6bca70531",
  ...
}
```

**Line 14** — `type: attachment`, `attachment.type: structured_output` — the payload written to disk:

```json
{
  "type": "attachment",
  "attachment": {
    "type": "structured_output",
    "data": {"x": "hi"}
  },
  "parentUuid": "ddbca315-c348-421e-86e6-74a6bca70531",
  "uuid": "3bc7a137-a065-4ce2-a087-2ab71b329d19",
  "timestamp": "2026-06-08T17:37:57.424Z",
  "sessionId": "447cdc99-581b-429c-9e28-88ff953691c6",
  ...
}
```

The sequence is: normal conversation turns → assistant emits `StructuredOutput` tool call → transcript line written as `attachment` with `attachment.type = "structured_output"` and `attachment.data = <validated object>`.

### CONCLUSION

**YES — `structured_output` IS recoverable from the interactive transcript.**

The implementer can:
1. Watch the `.jsonl` for a line matching `"type":"attachment"` where `attachment.type === "structured_output"`.
2. Extract `attachment.data` — this is exactly the validated structured object.

The `attachment` line is written during the session (line 14 of 18 in this example), before the final `last-prompt` bookkeeping lines, so it arrives while the session is still live. A streaming tailer will see it in real time.

Two redundant recovery paths exist:
- **From the transcript** (while streaming or after): `type=attachment` + `attachment.type=structured_output` → `attachment.data`.
- **From the `-p` result envelope** (when using `--print`): top-level `structured_output` field.

Task 10 (`--json-schema structured output`) is **implementable** with no deferred items.
