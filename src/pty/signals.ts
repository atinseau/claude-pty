// src/pty/signals.ts
//
// Pure detectors over the raw pty byte stream: prompt-ready, permission box,
// workspace-trust dialog — plus the keystrokes that answer the latter two.
// No I/O, no node-pty: every function here is a pure predicate over a buffer,
// which is what makes the driver's signal handling unit-testable.
//
// ─── Calibrated ready / turn-done detection (Claude Code 2.1.168) ───────────
//
// The raw pty stream is inspected for the prompt character ❯ (U+276F, a heavy
// right-pointing angle quotation mark) followed by a space — this is the exact
// character the TUI renders as its input prompt indicator.
//
// Evidence from calibration run (session cc29e93c-3ac2-4bd3-905b-e86afcd493d1):
//
//   Startup ready (chunk #9):
//     RAW: "...────────────────────────────────────────────────[m❯ [2m..."
//     → The giant initial frame always contains ❯  followed by placeholder text.
//
//   Turn done (chunk #67):
//     RAW: "[?25l...[38;1H❯ [38;2;153;153;153m[40;51H← for agents..."
//     → After the assistant reply, cursor moves to row 38 col 1, prints ❯ .
//
// Both startup and post-turn share the literal substring "❯ " (U+276F +
// U+00A0 NON-BREAKING SPACE) in the raw chunk. IMPORTANT: the space that
// follows ❯ in the actual pty stream is U+00A0 (non-breaking space, 0xa0),
// NOT a regular ASCII space (U+0020). This was confirmed by char-code
// inspection: buffer[1973]=0x276f ("❯"), buffer[1974]=0xa0 (" "). Searching
// for "❯ " (regular space) silently fails.

/**
 * Prompt-ready predicate.
 *
 * Matches the raw pty stream when the TUI's input box is ready for input.
 * The signal is "❯" (U+276F, HEAVY RIGHT-POINTING ANGLE QUOTATION MARK)
 * followed by U+00A0 (NON-BREAKING SPACE). Claude Code 2.1.168 consistently
 * emits this two-character sequence when the prompt row is rendered, at both
 * startup and after each assistant turn.
 *
 * CALIBRATION NOTE: The space character after ❯ is U+00A0 (0xa0), NOT a
 * regular ASCII space (U+0020). This was confirmed by char-code inspection of
 * the live pty buffer (session cc29e93c-3ac2-4bd3-905b-e86afcd493d1):
 *   buffer[1973] = 0x276f  (❯)
 *   buffer[1974] = 0x00a0  (NBSP — the "space" after the prompt char)
 * Searching for "❯ " (ASCII space) silently fails.
 *
 * Exported for unit testing — keep this pure (no side-effects).
 */
export function isReady(buffer: string): boolean {
  // U+276F (❯) followed by U+00A0 (non-breaking space) — the real prompt signal.
  // Spelled with explicit escapes so no editor can silently normalise the NBSP
  // (U+00A0) into an ASCII space (U+0020), which would break detection.
  return buffer.includes("\u276F\u00A0");
}

/**
 * Detects the interactive permission-confirmation box.
 *
 * The dialog renders two reliable literal ASCII substrings (no NBSP):
 *   "This command requires approval"  — row 26 of the permission box
 *   "Do you want to proceed?"         — row 28 of the permission box
 *
 * Verified in docs/superpowers/findings/spike-B-permission.md (Claude Code
 * 2.1.168, session 0a722727). Both strings appear in the same pty chunk
 * (#154) so matching either one is sufficient.
 *
 * Exported for unit testing — keep this pure (no side-effects).
 */
export function isPermissionPrompt(buffer: string): boolean {
  return (
    buffer.includes("This command requires approval") ||
    buffer.includes("Do you want to proceed?")
  );
}

/**
 * Keystroke that dismisses the permission box (ESC, single byte 0x1B).
 *
 * Verified in spike-B-permission.md: after sending ESC the dialog clears
 * within ~100ms, the tool is NOT executed, and the assistant turn continues
 * normally until the prompt-ready signal reappears.
 */
export const DENY_KEYSTROKE = "\x1b";

/**
 * Detects the workspace-trust dialog ("Is this a project you ... trust?").
 *
 * On the VERY FIRST run in a directory Claude has never seen (no
 * `hasTrustDialogAccepted: true` for that path in ~/.claude.json), the
 * interactive TUI renders a full-screen trust prompt BEFORE the input prompt is
 * ever ready. If left unanswered, the prompt-ready signal (❯ + NBSP) never
 * appears and claude-pty hangs forever. `claude -p` skips this dialog; the
 * interactive TUI does not.
 *
 * Verified in docs/superpowers/findings/spike-D-trust.md (Claude Code 2.1.169,
 * fresh dir C:\Temp\cp-trust-*). The dialog's raw pty frame looks like:
 *
 *   "...[3;2HAccessing[1Cworkspace:...
 *      Is[1Cthis[1Ca[1Cproject[1Cyou[1Ccreated...trust?...
 *      [14;2H❯...1.[1CYes,[1CI[1Ctrust[1Cthis[1Cfolder
 *      [15;4H2.[m[1CNo,[1Cexit
 *      [17;2HEnter[1Cto[1Cconfirm..."
 *
 * IMPORTANT: words inside the dialog are separated by `[1C` (cursor-forward
 * one column) escapes, NOT literal spaces — so multi-word phrases like
 * "Yes, I trust this folder" do NOT appear as contiguous substrings. The matcher
 * therefore keys off SINGLE contiguous tokens that survive intact in the stream:
 * the two option labels "Yes," and "No," plus the word "trust". Requiring all
 * three together avoids false-positives on ordinary output.
 *
 * Exported for unit testing — keep this pure (no side-effects).
 */
export function isTrustPrompt(buffer: string): boolean {
  return (
    buffer.includes("Yes,") &&
    buffer.includes("No,") &&
    buffer.includes("trust")
  );
}

/**
 * Keystroke that ACCEPTS the trust dialog (Enter / carriage return, 0x0D).
 *
 * The dialog's default selection is option 1 ("❯ 1. Yes, I trust this folder")
 * and the footer reads "Enter to confirm". Verified in spike-D-trust.md: sending
 * "\r" selects "Yes, I trust this folder" (the TUI redraws it with a ✔), the
 * directory is recorded as trusted, and the session then renders the normal
 * welcome frame containing the prompt-ready signal (❯ + NBSP) — the hang is gone.
 */
export const TRUST_ACCEPT_KEYSTROKE = "\r";
