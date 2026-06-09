# Spike D — First-run workspace-trust dialog

**Status:** CONFIRMED and FIXED.
**Claude Code version:** 2.1.169 (dialog text), driver verified against same.
**Date:** 2026-06-09

## Hypothesis

When the interactive Claude Code TUI starts in a brand-new / untrusted
directory, it shows a workspace-trust prompt BEFORE the input prompt is ready.
claude-pty waits for the prompt-ready signal (`❯` + U+00A0) that never comes, so
it hangs to the turn timeout. `claude -p` skips this dialog; the interactive TUI
does not.

## Verification (Step 1)

A throwaway capture (`spike/trust-capture.ts`, now removed) spawned the real
`claude` binary in a fresh dir `C:\Temp\cp-trust-<stamp>` (created at runtime,
also `process.chdir`'d into it because the driver spawns with
`cwd: process.cwd()`), with `CLAUDE_CODE_SESSION_ID` unset, and logged raw pty
chunks. Result: **the ready signal `❯`+NBSP did NOT appear within 12 s** — a
blocking trust dialog was rendered instead.

### Trust flag location

Per-directory trust is stored in `~/.claude.json` under
`projects["<abs path>"].hasTrustDialogAccepted` (boolean). A directory absent
from that map (or with the flag `false`) triggers the dialog on first run.

### Raw dialog frame (chunk #7, verbatim, JSON-escaped)

```
"[?25l[38;2;255;193;7m\r\n──…──[1m[3;2HAccessing[1Cworkspace:[m[1m[5;2HC:\\Temp\\cp-trust-mq6gxj79[22m[7;2HQuick[1Csafety[1Ccheck:[1CIs[1Cthis[1Ca[1Cproject[1Cyou[1Ccreated[1Cor[1Cone[1Cyou[1Ctrust?[1C(Like[1Cyour[1Cown[1Ccode,[1Ca[1Cwell-known[1Copen[1Csource[8;2Hproject,…).…[10;2HClaude[1CCode'll[1Cbe[1Cable[1Cto[1Cread,[1Cedit,[1Cand[1Cexecute[1Cfiles[1Chere.[38;2;153;153;153m[12;2HSecurity[1Cguide[38;2;177;185;249m[14;2H❯[38;2;153;153;153m[1C1.[38;2;177;185;249m[1CYes,[1CI[1Ctrust[1Cthis[1Cfolder[38;2;153;153;153m[15;4H2.[m[1CNo,[1Cexit[38;2;153;153;153m[17;2HEnter[1Cto[1Cconfirm[1C·[1CEsc[1Cto[1Ccancel"
```

Rendered, the dialog reads:

```
Accessing workspace:
C:\Temp\cp-trust-mq6gxj79

Quick safety check: Is this a project you created or one you trust? (Like your
own code, a well-known open source project, or work from your team). If not,
take a moment to review what's in this folder first.

Claude Code'll be able to read, edit, and execute files here.
Security guide

❯ 1. Yes, I trust this folder
  2. No, exit

Enter to confirm · Esc to cancel
```

## Matcher (Step 2)

**Critical gotcha:** words inside the dialog are separated by `[1C`
(cursor-forward one column) escapes, NOT literal spaces. Multi-word phrases like
`"Yes, I trust this folder"` therefore do NOT appear as contiguous substrings.
The matcher keys off SINGLE contiguous tokens that survive intact in the stream:

```ts
export function isTrustPrompt(buffer: string): boolean {
  return (
    buffer.includes("Yes,") &&
    buffer.includes("No,") &&
    buffer.includes("trust")
  );
}
```

Requiring all three tokens together avoids false-positives on a permission box
(which has Yes/No options but no `trust` wording) and on ordinary output.

## Accept keystroke (Step 2)

The default selection is option 1 (`❯ 1. Yes, I trust this folder`) and the
footer says "Enter to confirm". The verified accept keystroke is:

```ts
export const TRUST_ACCEPT_KEYSTROKE = "\r"; // CR, single byte 0x0d
```

**Evidence it unblocks:** after sending `\r`, the next chunk redraws the option
as `Yes, I trust this folder ✔` (color 78;186;101 = green), the TUI then renders
the full welcome frame, and that frame contains the prompt-ready signal
`[m❯ ` (`❯` U+276F followed by U+00A0 NBSP — confirmed by char-code:
`charCodeAt = 0x276f` then `0xa0`). `~/.claude.json` gains
`hasTrustDialogAccepted: true` for the directory.

## Implementation (Step 3)

In `src/driver.ts`, `startSession`'s `onData` handles the dialog in the
**pre-ready phase**, NOT gated behind `injected`/`awaitingTurn` (the dialog
appears before the prompt is ever ready, so gating it would re-introduce the
hang):

```ts
if (!trustAccepted && !injected && isTrustPrompt(buffer)) {
  trustAccepted = true;
  ptyWrite(pty, TRUST_ACCEPT_KEYSTROKE);
  buffer = "";   // so trust tokens can't re-trigger; ready check starts clean
  return;
}
```

`trustAccepted` guards it to fire exactly once.

## End-to-end verification (Step 4)

Compiled binary (`bun build src/main.ts --compile`) + a copy of
`node_modules/node-pty` staged into a fresh dir outside the project, run from a
brand-new untrusted cwd with `CLAUDE_CODE_SESSION_ID` unset and
`CLAUDE_PTY_TURN_TIMEOUT_MS=90000`:

```
$ cd C:/Temp/cp-run-<stamp>
$ CLAUDE_CODE_SESSION_ID= CLAUDE_PTY_TURN_TIMEOUT_MS=90000 \
    C:/Temp/cp-install-<stamp>/claude-pty.exe --output-format text "Reply with exactly the word: pong"
pong
--- exit code: 0 ---
```

Previously this hung to the turn timeout and produced "transcript not found".
Now it auto-accepts trust, reaches the prompt, injects the message, and returns
`pong`. `hasTrustDialogAccepted: true` is persisted for the run dir.
