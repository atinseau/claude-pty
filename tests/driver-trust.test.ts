// tests/driver-trust.test.ts
//
// Unit tests for isTrustPrompt() — the pure predicate that detects Claude
// Code's first-run workspace-trust dialog ("Is this a project you ... trust?").
//
// Sample is VERBATIM from a live capture (docs/superpowers/findings/spike-D-trust.md,
// Claude Code 2.1.169, fresh dir C:\Temp\cp-trust-mq6gxj79). Note that words
// inside the dialog are separated by [1C cursor-forward escapes, NOT spaces.

import { expect, test } from "bun:test";
import { isTrustPrompt, TRUST_ACCEPT_KEYSTROKE } from "../src/driver";

// Verbatim trust-dialog chunk (chunk #7 from the capture), un-escaped here so
// the [1C cursor-forward separators between words are preserved exactly.
const TRUST_DIALOG_CHUNK =
  "[?25l[38;2;255;193;7m\r\n" +
  "─".repeat(120) +
  "[1m[3;2HAccessing[1Cworkspace:[m[1m[5;2HC:\\Temp\\cp-trust-mq6gxj79[22m" +
  "[7;2HQuick[1Csafety[1Ccheck:[1CIs[1Cthis[1Ca[1Cproject[1Cyou[1Ccreated[1Cor[1Cone[1Cyou[1Ctrust?" +
  "[38;2;177;185;249m[14;2H❯[38;2;153;153;153m[1C1.[38;2;177;185;249m[1CYes,[1CI[1Ctrust[1Cthis[1Cfolder" +
  "[38;2;153;153;153m[15;4H2.[m[1CNo,[1Cexit" +
  "[38;2;153;153;153m[17;2HEnter[1Cto[1Cconfirm[1C·[1CEsc[1Cto[1Ccancel";

test("TRUST_ACCEPT_KEYSTROKE is a single CR byte (0x0d)", () => {
  expect(TRUST_ACCEPT_KEYSTROKE).toBe("\r");
  expect(TRUST_ACCEPT_KEYSTROKE.length).toBe(1);
  expect(TRUST_ACCEPT_KEYSTROKE.charCodeAt(0)).toBe(0x0d);
});

test("detects the trust dialog (verbatim captured chunk)", () => {
  expect(isTrustPrompt(TRUST_DIALOG_CHUNK)).toBe(true);
});

test("does not fire on the normal welcome / ready frame", () => {
  // The post-trust welcome frame contains the ready signal but none of the
  // three required trust tokens together.
  const welcome =
    '╭─── Claude Code v2.1.169 ───╮\nWelcome back Arthur!\n[m❯ [2mTry "how does <filepath> work?"';
  expect(isTrustPrompt(welcome)).toBe(false);
});

test("does not fire on ordinary assistant output", () => {
  expect(isTrustPrompt("Here is the answer: 42")).toBe(false);
  expect(isTrustPrompt("pong")).toBe(false);
});

test("does not fire on empty string", () => {
  expect(isTrustPrompt("")).toBe(false);
});

test("requires all three tokens (Yes, / No, / trust) together", () => {
  // A permission box has "Yes" and "No" options but not the trust wording —
  // and lacks the comma form + 'trust' token, so it must NOT match.
  expect(isTrustPrompt("❯ 1. Yes\n  3. No\nDo you want to proceed?")).toBe(
    false,
  );
  // 'trust' alone, or with only one option, must not match.
  expect(isTrustPrompt("I trust this is correct. Yes, indeed.")).toBe(false);
});
