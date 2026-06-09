// scripts/package-release.ts
//
// Produces a per-OS release archive for claude-pty.
//
// The compiled binary is NOT standalone: node-pty is a native module that is
// not bundled into the executable. At runtime, src/pty/runtime.ts resolves node-pty
// from (among other places) `dirname(process.execPath)/node_modules/node-pty`.
// Therefore a release archive must ship the binary alongside a
// `node_modules/node-pty/` directory, trimmed to runtime-only files.
//
// This script is meant to run NATIVELY on each target OS (in CI, one runner per
// OS). It builds for the host (no --target), so the bundled node-pty native
// binding always matches the runner's OS/arch.
//
//   bun run scripts/package-release.ts
//
// Output: dist/claude-pty-<os>-<arch>.{zip,tar.gz}

import { $ } from "bun";
import { Glob } from "bun";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const isWindows = process.platform === "win32";

// os label: windows | darwin | linux
const osLabel =
  process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";
const arch = process.arch; // x64 | arm64 | ...

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const STAGE = join(DIST, `claude-pty-${osLabel}-${arch}`);
const BINARY_NAME = isWindows ? "claude-pty.exe" : "claude-pty";
const ARCHIVE_EXT = isWindows ? "zip" : "tar.gz";
const ARCHIVE_NAME = `claude-pty-${osLabel}-${arch}.${ARCHIVE_EXT}`;

// node-pty subpaths to KEEP (runtime-only). Build-time dirs (deps/, src/,
// third_party/, scripts/, binding.gyp) are intentionally dropped. The native
// binding lives in prebuilds/ (win/mac) or build/Release/ (linux) — keep
// whichever exist on this runner.
const KEEP = [
  "lib",
  "package.json",
  "typings",
  "LICENSE",
  "prebuilds",
  "build", // build/Release — node-gyp output on linux (and conpty on win)
];

async function main() {
  console.log(`Packaging claude-pty for ${osLabel}-${arch}`);

  // ─── Clean staging ───────────────────────────────────────────────────────
  rmSync(STAGE, { recursive: true, force: true });
  rmSync(join(DIST, ARCHIVE_NAME), { force: true });
  mkdirSync(STAGE, { recursive: true });

  // ─── 1. Build the binary (host target) ───────────────────────────────────
  const binOut = join(STAGE, BINARY_NAME);
  console.log(`Building binary -> ${binOut}`);
  await $`bun build ${join(ROOT, "src/main.ts")} --compile --outfile ${binOut}`;
  if (!existsSync(binOut)) {
    throw new Error(`Build failed: ${binOut} not produced`);
  }

  // ─── 2. Stage trimmed node-pty ───────────────────────────────────────────
  const srcNodePty = join(ROOT, "node_modules", "node-pty");
  if (!existsSync(srcNodePty)) {
    throw new Error(
      `node_modules/node-pty not found at ${srcNodePty} — run \`bun install\` first.`,
    );
  }
  const dstNodePty = join(STAGE, "node_modules", "node-pty");
  mkdirSync(dstNodePty, { recursive: true });

  for (const entry of KEEP) {
    const src = join(srcNodePty, entry);
    if (!existsSync(src)) continue;
    const dst = join(dstNodePty, entry);
    cpSync(src, dst, { recursive: true });
  }

  // Drop *.pdb debug symbols — Windows prebuilds ship ~50MB of them and they
  // are never loaded at runtime.
  const pdbGlob = new Glob("**/*.pdb");
  for await (const rel of pdbGlob.scan({ cwd: dstNodePty })) {
    rmSync(join(dstNodePty, rel), { force: true });
  }

  // Sanity: the native binding must be present in either prebuilds/ or build/.
  const hasPrebuilds = existsSync(join(dstNodePty, "prebuilds"));
  const hasBuild = existsSync(join(dstNodePty, "build"));
  if (!hasPrebuilds && !hasBuild) {
    throw new Error(
      "node-pty native binding missing: neither prebuilds/ nor build/ was staged. " +
        "On linux, node-pty must be built from source (node-gyp) by `bun install`.",
    );
  }
  console.log(
    `Staged node-pty (prebuilds=${hasPrebuilds} build=${hasBuild})`,
  );

  // ─── 3. Verify the bundle resolves node-pty from OUTSIDE the project ──────
  await verifyBundle(binOut);

  // ─── 4. Archive ──────────────────────────────────────────────────────────
  const archivePath = join(DIST, ARCHIVE_NAME);
  console.log(`Archiving -> ${archivePath}`);
  if (isWindows) {
    // Compress-Archive zips the staging dir contents (binary + node_modules)
    // at the archive root.
    await $`powershell -NoProfile -Command Compress-Archive -Path ${join(STAGE, "*")} -DestinationPath ${archivePath} -Force`;
  } else {
    // tar from inside DIST so paths are relative to the staging dir name.
    await $`tar -czf ${archivePath} -C ${DIST} ${`claude-pty-${osLabel}-${arch}`}`;
  }

  const sizeMB = (statSync(archivePath).size / (1024 * 1024)).toFixed(2);
  console.log(`\nDone: ${ARCHIVE_NAME} (${sizeMB} MB)`);
}

/**
 * Run the staged binary from a temp dir OUTSIDE the project and confirm it does
 * NOT fail with a node-pty module-resolution error.
 *
 * driver.ts loads node-pty at module-load time (the `createRequire(...)` /
 * `_require("./index.js")` runs as soon as `main.ts` imports `./driver`). If
 * the bundled node-pty cannot be resolved, the process aborts IMMEDIATELY at
 * startup with "Cannot find package 'node-pty'" / "Cannot find module" before
 * any session is spawned. So we run the binary against a bogus claude binary
 * (which makes the actual pty spawn fail fast) with a tiny turn timeout, and
 * assert only that no module-resolution error appears. A full live run may also
 * hit Claude's workspace-trust dialog in a fresh dir; that is expected and
 * orthogonal — we are not asserting a successful turn here.
 */
async function verifyBundle(binOut: string) {
  console.log("Verifying node-pty resolves from the bundle...");
  const sandbox = mkdtempSync(join(tmpdir(), "claude-pty-verify-"));
  try {
    const res = await $`${binOut} "noop"`
      .cwd(sandbox)
      .env({
        ...process.env,
        CLAUDE_PTY_BIN: "claude-pty-nonexistent-bin",
        CLAUDE_PTY_TURN_TIMEOUT_MS: "4000",
      })
      .nothrow()
      .quiet();
    const out = res.stdout.toString() + res.stderr.toString();
    const moduleError =
      out.includes("Cannot find package 'node-pty'") ||
      out.includes("Cannot find package \"node-pty\"") ||
      out.includes("Cannot find module") ||
      out.toLowerCase().includes("err_module_not_found");
    if (moduleError) {
      throw new Error(`node-pty did NOT resolve from the bundle:\n${out}`);
    }
    console.log(
      "OK: node-pty loaded from the bundled copy (no module-resolution error).",
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
