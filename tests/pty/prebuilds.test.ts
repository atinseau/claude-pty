// tests/pty/prebuilds.test.ts
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureSpawnHelpersExecutable } from "../../src/pty/prebuilds";

/** A fake node-pty dir containing prebuilds/<triple>/spawn-helper at `mode`. */
function fakeNodePty(triples: Record<string, number>): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-prebuilds-"));
  for (const [triple, mode] of Object.entries(triples)) {
    const d = join(dir, "prebuilds", triple);
    mkdirSync(d, { recursive: true });
    const helper = join(d, "spawn-helper");
    writeFileSync(helper, "#!/bin/sh\n");
    chmodSync(helper, mode);
  }
  return dir;
}

test("makes a non-executable spawn-helper executable", () => {
  const dir = fakeNodePty({ "darwin-arm64": 0o666 });

  const fixed = ensureSpawnHelpersExecutable(dir);

  const helper = join(dir, "prebuilds", "darwin-arm64", "spawn-helper");
  expect(fixed).toEqual([helper]);
  expect(statSync(helper).mode & 0o111).toBe(0o111);
});

test("preserves the read/write bits it already had", () => {
  const dir = fakeNodePty({ "darwin-arm64": 0o644 });

  ensureSpawnHelpersExecutable(dir);

  const helper = join(dir, "prebuilds", "darwin-arm64", "spawn-helper");
  expect(statSync(helper).mode & 0o777).toBe(0o755);
});

test("leaves an already-executable spawn-helper alone", () => {
  const dir = fakeNodePty({ "darwin-arm64": 0o755 });

  expect(ensureSpawnHelpersExecutable(dir)).toEqual([]);
});

test("fixes every prebuild triple present", () => {
  const dir = fakeNodePty({ "darwin-arm64": 0o666, "linux-x64": 0o666 });

  expect(ensureSpawnHelpersExecutable(dir).length).toBe(2);
});

test("returns empty when there is no prebuilds dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-prebuilds-"));

  expect(ensureSpawnHelpersExecutable(dir)).toEqual([]);
});

test("returns empty for a node-pty dir that does not exist", () => {
  expect(ensureSpawnHelpersExecutable("/nope/not/here")).toEqual([]);
});
