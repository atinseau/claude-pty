# Spike B — Permission Box Capture & Auto-Deny

**Date**: 2026-06-08  
**Session**: `0a722727-9bf9-43aa-9435-1577f38765ce`  
**Claude version**: 2.1.168  
**Tool**: `spike/perm-capture.ts` (raw chunk log: `spike/perm-capture-log.txt`)

---

## 1. How the Permission Box Is Triggered

Spawning Claude with `--permission-mode default` (no `--allowedTools`) and asking it to run a shell command causes the TUI to render an interactive approval dialog before executing the tool. The dialog is rendered in the pty stream as cursor-positioned ANSI sequences, not as a separate screen layer.

---

## 2. Verbatim Raw Sample (Chunk #154)

This is the exact pty chunk that rendered the permission box (JSON-stringified, as it arrived in the stream). It is a single chunk containing the full dialog:

```
"[?25l[38;2;177;185;249m[20;1H────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────[1m[21;2HBash command[m[23;4Hrtk[1Cgit[1Cstatus[38;2;153;153;153m[24;4HShow working tree status[m[26;2HThis[1Ccommand[1Crequires[1Capproval[28;2HDo[1Cyou[1Cwant[1Cto[1Cproceed?[38;2;177;185;249m[29;2H❯[38;2;153;153;153m[1C1. [38;2;177;185;249mYes[38;2;153;153;153m[30;4H2. [mYes,[1Cand[1Cdon't[1Cask[1Cagain[1Cfor:[1Crtk[1Cgit[1C*[38;2;153;153;153m[31;4H3. [mNo[38;2;153;153;153m[33;2HEsc to cancel · Tab to amend · ctrl+e to explain[m[45;1H[K[46;204H[K\r\n ...[50;3H[K[218C"
```

### Decoded content (ANSI stripped, logical layout)

The dialog spans rows 20–33 of the 50-row terminal:

```
Row 20: ─────────────────── (horizontal rule, blue/periwinkle color #b1b9f9)
Row 21:  Bash command         (bold)
Row 23:     rtk git status
Row 24:     Show working tree status  (gray)
Row 26:  This command requires approval
Row 28:  Do you want to proceed?
Row 29:  ❯ 1. Yes             (❯ = currently selected = option 1)
Row 30:    2. Yes, and don't ask again for: rtk git *
Row 31:    3. No
Row 33:  Esc to cancel · Tab to amend · ctrl+e to explain  (gray hint)
```

**Key observations:**
- The render is done with absolute cursor positioning (`[<row>;<col>H`), not box-drawing characters.
- The `❯` on row 29 is the selection cursor — it marks the currently-focused option (option 1 = Yes by default).
- The option list uses `[1C` (cursor-forward-1) between words instead of spaces; the actual separator characters in the raw stream are `[1C` control sequences, not spaces.
- The hint line `Esc to cancel` appears verbatim as a literal ASCII string in the raw chunk.
- No NBSP (U+00A0) was observed inside the permission box itself (only the prompt-ready signal uses NBSP).

---

## 3. Recommended `isPermissionPrompt(buffer)` Matcher

### Best approach: literal substring on rolling buffer

The two most reliable literal substrings that appear together in a single chunk:

```typescript
/**
 * Returns true if the rolling pty buffer contains the permission approval dialog.
 *
 * The dialog always contains both of these literal ASCII strings:
 *   "This command requires approval"  — the header text
 *   "Do you want to proceed?"         — the question
 *
 * Both appear in the same chunk (chunk #154 in the calibration run), so
 * checking the rolling buffer for either one is sufficient.
 *
 * NOTE: No NBSP was observed in the permission box itself. The hint line
 * "Esc to cancel" also works as a standalone signal but is less specific
 * (could theoretically appear in other contexts).
 */
export function isPermissionPrompt(buffer: string): boolean {
  return (
    buffer.includes("This command requires approval") ||
    buffer.includes("Do you want to proceed?")
  );
}
```

### Alternative regex (more tolerant of future rewording)

```typescript
export function isPermissionPrompt(buffer: string): boolean {
  return /requires\s+approval|Do you want to proceed\?|Esc to cancel/i.test(buffer);
}
```

### Why these signals are reliable

| Signal | Specificity | Notes |
|--------|-------------|-------|
| `"This command requires approval"` | High | Appears verbatim; not part of any other TUI element |
| `"Do you want to proceed?"` | High | Appears verbatim; unique to the permission dialog |
| `"Esc to cancel"` | Medium | Also present in the permission box hint; but may appear elsewhere |
| Box-drawing `─` or color `[38;2;177;185;249m` | Low | Too broad; both appear in other TUI elements |

---

## 4. Verified DENY Keystroke

### Keystroke: `\x1b` (Escape, single byte 0x1B)

**Source evidence from perm-capture-log.txt:**

```
[DENY] Trying keystroke: Escape (bytes: "")

CHUNK #159: "[?1000h[?1002h[?1003h[?1006h[m"
[POST-DENY] VERIFY: Prompt-ready signal reappeared after deny — DENY WORKED!

CHUNK #161: "\r [38;2;153;153;153m[1CRan [1m1[22m shell command[K
            [m\r\n[K[20;1H[clears rows 20-33: the permission box lines]
            ...❯ [2mTry ... ← the input prompt reappeared"
```

**What happened after `\x1b`:**

1. The dialog immediately cleared (rows 20–33 were erased in chunk #161).
2. The status bar briefly showed "Ran 1 shell command" (this is the optimistic pre-approval status that Claude renders while waiting for confirmation — the text refers to Claude's *intent*, not the actual execution).
3. The `❯ ` prompt-ready signal reappeared at the bottom of the screen.
4. Stream went idle 1.2 seconds later — no tool output was rendered, Claude's turn ended.

**Interpretation of "Ran 1 shell command"**: The TUI renders "Running N shell command" in the status bar while waiting for approval. After Escape cancels, it updates this to "Ran N shell command" as a past-tense cleanup step. This does NOT indicate the command executed — there was no tool result in the conversation transcript, no `git status` output visible, and Claude's turn ended without producing content about the git status.

**The "No" option (option 3 via digit `3`)**: Not tested in this spike, as Escape worked on the first attempt. Escape is strongly preferred because:
- It is the canonical cancel/dismiss key in terminal UIs.
- The hint line explicitly says `Esc to cancel`.
- It does not require knowing which digit corresponds to the deny option (which could change if options are reordered).

---

## 5. The Exact Deny Keystroke

```
Keystroke: ESC
Bytes:     0x1B  (single byte)
JS:        "\x1b"
```

Write via `fs.writeSync(coninFd, "\x1b")` on Windows (same pattern as all other pty writes in this project).

---

## 6. Edge Cases and Guard Notes

### Multiple boxes in one turn

Claude may call multiple tools in a single turn (e.g., two Bash commands back-to-back). Each tool call gets its own permission box. The box is rendered, awaits input, and only then re-renders for the next tool. The driver must detect and deny each box individually using a "once-per-box" guard:

- Reset the detection state (`permBoxSeen = false`) each time after sending `\x1b`.
- Wait for the box's cleanup (rows 20–33 cleared) before re-arming the detector.
- A safe guard: wait until `isPermissionPrompt(buffer)` returns `false` for at least 500ms before re-arming, or simply re-arm immediately after sending Escape (since the box clears within ~100ms).

### Re-rendering / animation

The permission box may be partially re-rendered during spinner/timer animations on the status bar (row 45). This does NOT indicate a new dialog — the key rows (26–31) only change when the actual dialog appears or disappears. Restrict detection to `buffer.includes("This command requires approval")` to avoid false positives from partial re-renders.

### Timing

The box appears **~4.4 seconds** after injection in the calibration run (chunks 12–154 span ~4.3s). This is the model's thinking + tool call planning time, not a fixed delay. The driver should detect asynchronously via the data handler, not by polling.

### Permission already granted (allowedTools)

If `--allowedTools Bash` or equivalent is passed, no permission box appears. This spike only applies to the `--permission-mode default` path without pre-granted tools.

---

## 7. Summary

| Property | Value |
|----------|-------|
| Matcher (primary) | `buffer.includes("This command requires approval")` |
| Matcher (secondary) | `buffer.includes("Do you want to proceed?")` |
| NBSP in matcher | No — the permission box uses ASCII spaces |
| Deny keystroke | `"\x1b"` (single ESC byte, 0x1B) |
| Deny confirmed | Yes — box cleared, prompt returned, no tool output |
| Options in box | `1. Yes`, `2. Yes, and don't ask again for: <pattern>`, `3. No` |
| Default selection | Option 1 (Yes) — `❯` cursor shown on row 29 |
| Hint line | `Esc to cancel · Tab to amend · ctrl+e to explain` |
