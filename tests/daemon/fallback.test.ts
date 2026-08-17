// tests/daemon/fallback.test.ts
//
// Falling back to the direct path after a daemon failure is only safe while
// NOTHING has been written yet. Once response bytes have reached stdout, rerunning
// the request appends a SECOND response to the same stream.
//
// Measured before the fix, by SIGKILLing the daemon mid-response on a real
// stream-json run: types were `system, system, assistant, result` with TWO
// distinct session_ids in one stream — and exit code 0, presenting it as success.
//
// These tests drive a fake daemon over a real loopback socket, so they need no
// claude binary and no API calls.

import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "net";
import { runAgainstEndpoint } from "../../src/daemon/client";
import { type Endpoint, encodeFrame } from "../../src/daemon/protocol";

let server: Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

/** A fake daemon that runs `script` on the connected socket. Resolves its endpoint. */
function fakeDaemon(
  script: (sock: import("net").Socket) => void,
): Promise<Endpoint> {
  return new Promise((resolve) => {
    server = createServer((sock) => {
      sock.setEncoding("utf8");
      sock.once("data", () => script(sock));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, token: "test-token", pid: process.pid, v: "test" });
    });
  });
}

/** Capture what the client writes instead of touching the real stdout/stderr. */
function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

const REQ = { argv: ["hello"], cwd: "/tmp", env: {}, stdin: "" };

test("returns the daemon's exit code on a normal exchange", async () => {
  const ep = await fakeDaemon((sock) => {
    sock.write(encodeFrame({ s: "o", d: "hi\n" }));
    sock.end(encodeFrame({ s: "x", c: 0 }));
  });
  const s = sink();

  const code = await runAgainstEndpoint(ep, REQ, s.io);

  expect(code).toBe(0);
  expect(s.stdout()).toBe("hi\n");
});

test("allows fallback when the daemon dies before writing anything", async () => {
  const ep = await fakeDaemon((sock) => sock.destroy());
  const s = sink();

  const code = await runAgainstEndpoint(ep, REQ, s.io);

  // Nothing reached stdout, so rerunning the request cannot duplicate output.
  expect(code).toBeNull();
  expect(s.stdout()).toBe("");
});

test("refuses fallback when the daemon dies after writing output", async () => {
  const ep = await fakeDaemon((sock) => {
    sock.write(encodeFrame({ s: "o", d: '{"type":"system"}\n' }));
    setTimeout(() => sock.destroy(), 20);
  });
  const s = sink();

  const code = await runAgainstEndpoint(ep, REQ, s.io);

  // A non-null code stops main() from running the direct path, which would append
  // a second, complete response to the partial one already emitted.
  expect(code).not.toBeNull();
  expect(code).not.toBe(0); // and it must not look like success
});

test("reports the interrupted response on stderr", async () => {
  const ep = await fakeDaemon((sock) => {
    sock.write(encodeFrame({ s: "o", d: "partial\n" }));
    setTimeout(() => sock.destroy(), 20);
  });
  const s = sink();

  await runAgainstEndpoint(ep, REQ, s.io);

  expect(s.stderr()).toContain("daemon");
  // The partial output stays as-is: it is already in the consumer's stream.
  expect(s.stdout()).toBe("partial\n");
});

test("counts stderr output as written too", async () => {
  // A warning relayed on stderr is still bytes the consumer has seen; rerunning
  // would duplicate it alongside a fresh stdout response.
  const ep = await fakeDaemon((sock) => {
    sock.write(encodeFrame({ s: "e", d: "warning\n" }));
    setTimeout(() => sock.destroy(), 20);
  });
  const s = sink();

  const code = await runAgainstEndpoint(ep, REQ, s.io);

  expect(code).not.toBeNull();
});
