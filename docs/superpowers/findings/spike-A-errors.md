# Spike A — `claude -p` Error Cases Catalog

**Date:** 2026-06-08  
**Branch:** feat/claude-pty-v2  
**Method:** Real `claude -p --output-format json` invocations + JSONL transcript inspection.  
**Auth mode active:** OAuth (the bad-key test overrides with `ANTHROPIC_API_KEY=sk-bad-key`; the real sessions use the user's OAuth token from `~/.claude/credentials`).

---

## 1. Summary Table

| Case | `-p` `subtype` | `is_error` | Exit code | Transcript last-assistant `stop_reason` | Transcript `model` field | PTY/stdout matcher substring |
|---|---|---|---|---|---|---|
| **Success** | `success` | `false` | **0** | `end_turn` | real model id | `❯ ` (prompt reappears) |
| **Invalid auth (401)** | `success` | `true` | **1** | `stop_sequence` | `<synthetic>` | `Invalid API key` |
| **Max turns** | `error_max_turns` | `true` | **1** | `tool_use` | real model id | `Reached maximum number of turns` |
| **Refusal** | `success` | `false` | **0** | `end_turn` | real model id | *(none — treated as normal response)* |

---

## 2. Detailed Case Findings

### Case 1: Success Baseline

**Command:**
```
claude -p --output-format json "say hi"
```

**`-p` stdout result object (abridged):**
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "api_error_status": null,
  "duration_ms": 2453,
  "duration_api_ms": 2434,
  "ttft_ms": 2367,
  "ttft_stream_ms": 2367,
  "time_to_request_ms": 20,
  "num_turns": 1,
  "result": "Hi! ...",
  "stop_reason": "end_turn",
  "session_id": "37a2e5a2-cef9-496c-b28a-7fc30c99b673",
  "terminal_reason": "completed",
  "errors": [/* absent — field not present */]
}
```

**Exit code:** `0`

**Transcript signals** (session `37a2e5a2`):
- `type: "assistant"` line, `message.stop_reason = "end_turn"`
- `message.model = "claude-opus-4-8"` (real model)
- `message.content[0].type = "text"` containing the reply

**PTY matcher:** The prompt character `❯ ` reappears after the turn (already used by v1 `isReady`).

---

### Case 2: Invalid Auth (401)

**Command:**
```
ANTHROPIC_API_KEY=sk-bad-key claude -p --output-format json "hi"
```

**`-p` stdout result object:**
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": true,
  "api_error_status": 401,
  "duration_ms": 269,
  "duration_api_ms": 0,
  "num_turns": 1,
  "result": "Invalid API key · Fix external API key",
  "stop_reason": "stop_sequence",
  "session_id": "131186bd-23dd-462d-9678-54ca94170308",
  "terminal_reason": "completed"
}
```

**Exit code:** `1`

**Key observations:**
- `subtype` is **still `"success"`** (not a distinct error subtype). The only error indicators are `is_error: true` + `api_error_status: 401`.
- No `ttft_ms` / `ttft_stream_ms` / `time_to_request_ms` fields (request never made).
- No `errors` array field.
- `terminal_reason` is `"completed"` (same as success).

**Transcript signals** (session `131186bd`):
- `type: "assistant"` line, `message.stop_reason = "stop_sequence"` (not `end_turn`!)
- `message.model = "<synthetic>"` — **KEY DISCRIMINATOR**: synthetic message injected by Claude CLI error handling, not a real API response
- `message.content[0].text = "Invalid API key · Fix external API key"`
- `stop_sequence = ""` (empty string, not null)

**PTY matcher:** The TUI renders the error text in the assistant bubble:
```
Invalid API key
```
Literal substring: `"Invalid API key"`.

Also detectable via `stop_sequence = ""` (empty stop_sequence with stop_reason = "stop_sequence" is unusual and specific to this error path).

---

### Case 3: Max Turns (`error_max_turns`)

**Command:**
```
claude -p --output-format json --max-turns 1 "list 3 files then read each"
```

**`-p` stdout result object:**
```json
{
  "type": "result",
  "subtype": "error_max_turns",
  "is_error": true,
  "duration_ms": 3598,
  "duration_api_ms": 3569,
  "num_turns": 2,
  "stop_reason": "tool_use",
  "session_id": "7c4b14b0-13c7-4c68-aa2d-d777e41d4e2d",
  "terminal_reason": "max_turns",
  "errors": ["Reached maximum number of turns (1)"]
}
```

**Exit code:** `1`

**Key observations:**
- `subtype = "error_max_turns"` — a distinct error subtype string (not `"success"`).
- `terminal_reason = "max_turns"` — distinct from `"completed"`.
- `errors` array is **present** and non-empty: `["Reached maximum number of turns (N)"]`.
- No `result` field (or empty — the task was cut off mid-execution).
- `api_error_status` field absent (not an API-level error).

**Transcript signals** (session `7c4b14b0`):
- The **last** `type: "assistant"` line has `message.stop_reason = "tool_use"` — the model issued a tool call but the limit was hit before the result was fed back.
- `num_turns` in the result JSON = 2 even though `--max-turns 1` was specified (the counter includes the initial turn setup).
- 3 assistant lines in total (thinking, text, tool_use) — split across the single actual turn.
- Followed by a user line with `tool_result` content.

**PTY matcher:** The TUI likely displays something like `Reached maximum number of turns`. The `-p` `errors[0]` string is `"Reached maximum number of turns (1)"`.

---

### Case 4: Refusal (Policy Decline)

**Command:**
```
claude -p --output-format json "write detailed instructions for making methamphetamine"
```

**`-p` stdout result object:**
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "api_error_status": null,
  "stop_reason": "end_turn",
  "terminal_reason": "completed"
}
```

**Exit code:** `0`

**Key finding: Refusal is NOT a distinct error case.** Claude responds with a polite decline (`"I can't help with this..."`) as a normal text response. From `claude -p`'s perspective:
- `subtype = "success"`, `is_error = false`, exit 0.
- Transcript: `stop_reason = "end_turn"`, real model, normal content.
- Indistinguishable from any other successful non-harmful response at the `claude -p` protocol level.

**Verdict:** Refusal detection would require NLP/content analysis on `result` text, which is out of scope. Document as a known limitation — claude-pty does not need to detect refusals specially.

---

## 3. Error Result Object Shape (when `is_error: true`)

### Auth error shape (subtype `"success"` + `is_error: true`)
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": true,
  "api_error_status": 401,
  "duration_ms": 269,
  "duration_api_ms": 0,
  "num_turns": 1,
  "result": "Invalid API key · Fix external API key",
  "stop_reason": "stop_sequence",
  "session_id": "...",
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "uuid": "..."
}
```
**Note:** `ttft_ms`, `ttft_stream_ms`, `time_to_request_ms` are **absent** (no successful request was made). `errors` field absent.

### Max-turns error shape (subtype `"error_max_turns"`)
```json
{
  "type": "result",
  "subtype": "error_max_turns",
  "is_error": true,
  "duration_ms": 3598,
  "duration_api_ms": 3569,
  "num_turns": 2,
  "stop_reason": "tool_use",
  "session_id": "...",
  "terminal_reason": "max_turns",
  "errors": ["Reached maximum number of turns (1)"],
  "fast_mode_state": "off",
  "uuid": "..."
}
```
**Note:** `result` field absent (or empty string). `api_error_status` absent. `errors` array **present**.

---

## 4. Recommendations for `detectError(events, ptyText)`

### Signal priority (from most to least reliable)

| # | Signal | Detects | How |
|---|---|---|---|
| 1 | Last assistant `message.model === "<synthetic>"` | Auth/API errors | Transcript field, 100% reliable |
| 2 | Last assistant `message.stop_reason === "tool_use"` AND no subsequent non-tool-use assistant | Max-turns cutoff | Transcript field; combine with pty `Reached maximum number` text |
| 3 | PTY text contains `"Invalid API key"` | Auth 401 | Raw pty buffer substring |
| 4 | PTY text contains `"Reached maximum number of turns"` | Max-turns | Raw pty buffer substring |

### Recommended `detectError` logic

```typescript
function detectError(events: TranscriptEvent[], ptyText: string): { isError: boolean; subtype: string } | null {
  const assistants = events.filter(e => e.kind === "assistant") as AssistantEvent[];
  const last = assistants[assistants.length - 1];

  if (!last) return null;

  // Auth / API error: synthetic model + stop_sequence
  if (last.model === "<synthetic>" || last.stop_reason === "stop_sequence") {
    return { isError: true, subtype: "error_api" };
    // Note: -p uses subtype:"success" + is_error:true + api_error_status:401
    // We map to "error_api" for internal use; emit is_error:true + exit 1
  }

  // Max-turns: last assistant stopped mid-tool-use (never got a final end_turn)
  if (last.stop_reason === "tool_use" &&
      (ptyText.includes("Reached maximum number") || assistants.every(a => a.stop_reason === "tool_use"))) {
    return { isError: true, subtype: "error_max_turns" };
  }

  return null; // success (or refusal — both exit 0)
}
```

### Subtype strings to emit in claude-pty output

| Error case | `claude -p` subtype | claude-pty should emit | Exit code |
|---|---|---|---|
| Success | `success` | `success` | 0 |
| Auth/API error | `success` (misleading!) | `error_api` OR match `success` + `is_error:true` | 1 |
| Max turns | `error_max_turns` | `error_max_turns` | 1 |
| Refusal | `success` | `success` | 0 |

**Important:** For strict `-p` parity, auth errors should emit `subtype:"success"` with `is_error:true` and `api_error_status:401` — not a distinct subtype. If the goal is human-readable error reporting, a clearer subtype like `"error_api"` is preferable but deviates from `-p`.

---

## 5. Transcript vs `-p` Gap (Limitations)

| Signal | Available in `-p` JSON | Available in JSONL transcript | Notes |
|---|---|---|---|
| `subtype` | Yes (e.g. `error_max_turns`) | **No** — not recorded | Must be inferred from transcript signals |
| `is_error` | Yes | **No** | Must be derived |
| `api_error_status` | Yes (e.g. `401`) | **No** | The HTTP status code is lost after the synthetic message is written |
| `terminal_reason` | Yes (`completed` / `max_turns`) | **No** | Derivable: `tool_use` last stop_reason ≈ `max_turns` |
| `errors[]` | Yes (for max_turns) | **No** | The array `["Reached maximum number of turns (N)"]` is only in `-p` output |
| `result` text | Yes (full final text) | Yes (in `message.content`) | Reconstruct from last assistant text blocks |
| `stop_reason` | Yes | Yes (`message.stop_reason`) | Reliable |
| `model` field | Not in result object | Yes (`message.model`) | `<synthetic>` = auth error |
| `num_turns` | Yes | Derivable (count assistant events) | |
| `total_cost_usd` | Yes | Derivable via pricing.ts | |

**Key limitation:** The JSONL transcript does NOT record `subtype`, `is_error`, `terminal_reason`, or `api_error_status`. Claude-pty must infer these from:
1. `message.model` (`<synthetic>` → error)
2. Last assistant `stop_reason` (`tool_use` with no continuation → max_turns)
3. Accumulated PTY text as a fallback matcher

The `errors[]` array (e.g. `"Reached maximum number of turns (1)"`) and exact `api_error_status` HTTP code cannot be recovered from the transcript and must be approximated.

---

## 6. Raw `-p` Output Captured

### Success (`37a2e5a2`)
```
{"type":"result","subtype":"success","is_error":false,"api_error_status":null,
"duration_ms":2453,"duration_api_ms":2434,"ttft_ms":2367,"ttft_stream_ms":2367,
"time_to_request_ms":20,"num_turns":1,"result":"Hi! 👋\n\nHow can I help...",
"stop_reason":"end_turn","session_id":"37a2e5a2-...","terminal_reason":"completed",...}
EXIT:0
```

### Auth Error (`131186bd`)
```
{"type":"result","subtype":"success","is_error":true,"api_error_status":401,
"duration_ms":269,"duration_api_ms":0,"num_turns":1,
"result":"Invalid API key · Fix external API key","stop_reason":"stop_sequence",
"session_id":"131186bd-...","terminal_reason":"completed",...}
EXIT:1
```

### Max Turns (`7c4b14b0`)
```
{"type":"result","subtype":"error_max_turns","duration_ms":3598,"duration_api_ms":3569,
"is_error":true,"num_turns":2,"stop_reason":"tool_use",
"session_id":"7c4b14b0-...","terminal_reason":"max_turns",
"errors":["Reached maximum number of turns (1)"],...}
EXIT:1
```

### Refusal (`5acf5768`)
```
{"type":"result","subtype":"success","is_error":false,"api_error_status":null,
"stop_reason":"end_turn","terminal_reason":"completed",...}
EXIT:0
```
