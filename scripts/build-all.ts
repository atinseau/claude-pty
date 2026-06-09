// scripts/build-all.ts
// Cross-compile claude-pty for the main platforms into dist/.
// NOTE: claude-pty depends on node-pty, a NATIVE module. These binaries are
// NOT standalone: each target only runs on a host that has the matching
// node-pty prebuild available in node_modules/node-pty/ at runtime.
import { $ } from "bun";

interface Target {
  bun: string;
  out: string;
}

const targets: Target[] = [
  { bun: "bun-windows-x64", out: "dist/claude-pty-windows-x64.exe" },
  { bun: "bun-linux-x64", out: "dist/claude-pty-linux-x64" },
  { bun: "bun-linux-arm64", out: "dist/claude-pty-linux-arm64" },
  { bun: "bun-darwin-x64", out: "dist/claude-pty-darwin-x64" },
  { bun: "bun-darwin-arm64", out: "dist/claude-pty-darwin-arm64" },
];

const results: { target: string; ok: boolean }[] = [];

for (const t of targets) {
  process.stdout.write(`Building ${t.bun} -> ${t.out} ... `);
  try {
    await $`bun build src/main.ts --compile --target=${t.bun} --outfile ${t.out}`.quiet();
    console.log("ok");
    results.push({ target: t.bun, ok: true });
  } catch (err) {
    console.log("FAILED");
    console.error(err instanceof Error ? err.message : err);
    results.push({ target: t.bun, ok: false });
  }
}

console.log("\nSummary:");
for (const r of results) {
  console.log(`  ${r.ok ? "OK  " : "FAIL"} ${r.target}`);
}

const failed = results.filter((r) => !r.ok).length;
if (failed > 0) process.exit(1);
