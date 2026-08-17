// tests/pty/runtime.test.ts
//
// The portability gate: a real pty spawn through src/pty/runtime.ts. This is the
// regression test for the two platform bugs that made claude-pty unusable on
// macOS/Linux — node-pty's non-executable prebuilt spawn-helper (spawn fails
// outright) and Bun's dead tty.ReadStream (spawn works but no bytes ever arrive).
// Either one reappearing turns every session into a silent hang, so it is worth
// paying a real spawn here.
import { expect, test } from "bun:test";
import { ptySpawn } from "../../src/pty/runtime";

const isWindows = process.platform === "win32";

/** Spawn `cmd` in a pty and resolve its output once it exits. */
function runInPty(
  cmd: string,
  args: string[],
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const pty = ptySpawn(cmd, args, {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
    let output = "";
    pty.onData((d) => {
      output += d;
    });
    pty.onExit(({ exitCode }) => resolve({ output, exitCode }));
    setTimeout(
      () => reject(new Error(`pty produced: ${JSON.stringify(output)}`)),
      10_000,
    );
  });
}

test.skipIf(isWindows)("streams a spawned process's output", async () => {
  const { output } = await runInPty("/bin/sh", ["-c", "echo hello-from-pty"]);

  expect(output).toContain("hello-from-pty");
});

test.skipIf(isWindows)("reports the child's exit code", async () => {
  const { exitCode } = await runInPty("/bin/sh", ["-c", "exit 3"]);

  expect(exitCode).toBe(3);
});

test.skipIf(isWindows)("round-trips input written to the pty", async () => {
  const pty = ptySpawn("/bin/sh", [], {
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });
  let output = "";
  pty.onData((d) => {
    output += d;
  });

  const exited = new Promise<void>((r) => pty.onExit(() => r()));
  pty.write("echo written-to-pty\nexit\n");
  await exited;

  expect(output).toContain("written-to-pty");
});
