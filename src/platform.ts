// src/platform.ts
//
// Platform-dependent naming, in one place. The compiled binary's filename is
// needed by three build-time consumers (scripts/build.ts, scripts/bench.ts,
// scripts/package-release.ts), and hardcoding "claude-pty.exe" is exactly how the
// build ended up producing a .exe on macOS.

/** The compiled binary's filename for `platform` (default: the host). */
export function binaryName(platform: string = process.platform): string {
  return platform === "win32" ? "claude-pty.exe" : "claude-pty";
}
