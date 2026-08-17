// scripts/build.ts
// Compile claude-pty for the HOST platform, named for that platform (a bare
// `--outfile claude-pty.exe` is how the macOS build ended up emitting a .exe).
import { $ } from "bun";
import { binaryName } from "../src/platform";

const out = binaryName();
console.log(`Building ${out} ...`);
await $`bun build src/main.ts --compile --outfile ${out}`;
