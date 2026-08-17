// tests/pty/kill-tree.test.ts
//
// The claude TUI spawns its own subprocesses (MCP servers, hooks). Killing only
// the TUI's pid leaves them running — orphaned under the daemon, which is a
// detached parent nobody reaps. killTree must take the whole tree down.
import { expect, test } from "bun:test";
import { killTree } from "../../src/pty/kill-tree";
import { ptySpawn } from "../../src/pty/runtime";

const isWindows = process.platform === "win32";

/** PIDs sharing `pgid` as their process group, per pgrep. */
function groupMembers(pgid: number): string[] {
  const r = Bun.spawnSync(["pgrep", "-g", String(pgid)]);
  return new TextDecoder()
    .decode(r.stdout)
    .split("\n")
    .filter((l) => l.trim() !== "");
}

/** Wait until `probe` is true, or give up after `timeoutMs`. */
async function until(probe: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe() && Date.now() < deadline) await Bun.sleep(25);
}

test.skipIf(isWindows)("kills children that ignore SIGHUP", async () => {
  // A plain background child is already reaped by the kernel's SIGHUP when the
  // pty's session leader dies — so the child here IGNORES SIGHUP, the way a
  // long-running MCP server can. Measured against the unpatched pty.kill(): 2 of
  // 4 group members survived. That is the leak this must close.
  const pty = ptySpawn(
    "/bin/sh",
    [
      "-c",
      "sh -c \"trap '' HUP; sleep 300\" & sleep 300 & echo children-started; wait",
    ],
    {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    },
  );
  let out = "";
  pty.onData((d) => {
    out += d;
  });
  await until(() => out.includes("children-started"));
  const pid = pty.pid;
  expect(groupMembers(pid).length).toBeGreaterThanOrEqual(4); // sh + wrapper + 2 sleeps

  killTree(pid);
  await until(() => groupMembers(pid).length === 0);

  expect(groupMembers(pid)).toEqual([]);
});

test.skipIf(isWindows)("is silent when the pid is already gone", () => {
  const pty = ptySpawn("/bin/sh", ["-c", "exit 0"], {
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });
  const pid = pty.pid;

  killTree(pid);
  expect(() => killTree(pid)).not.toThrow();
});
