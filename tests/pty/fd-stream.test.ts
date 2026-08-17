// tests/pty/fd-stream.test.ts
import { expect, test } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, openSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FdReadStream } from "../../src/pty/fd-stream";

/** Open a temp file holding `content` and return its read fd. */
function fdOf(content: string): number {
  const dir = mkdtempSync(join(tmpdir(), "cp-fd-"));
  const path = join(dir, "data");
  writeFileSync(path, content);
  return openSync(path, "r");
}

/** Collect data chunks until `close`, or reject on `error`. */
function drain(s: FdReadStream): Promise<(string | Buffer)[]> {
  return new Promise((resolve, reject) => {
    const chunks: (string | Buffer)[] = [];
    s.on("data", (c: string | Buffer) => chunks.push(c));
    s.on("close", () => resolve(chunks));
    s.on("error", reject);
  });
}

test("emits the fd's bytes as Buffers, then closes at EOF", async () => {
  const s = new FdReadStream(fdOf("hello-from-fd"));

  const chunks = await drain(s);

  expect(Buffer.concat(chunks as Buffer[]).toString()).toBe("hello-from-fd");
  expect(chunks[0]).toBeInstanceOf(Buffer);
});

test("emits strings once setEncoding is called", async () => {
  const s = new FdReadStream(fdOf("héllo"));
  s.setEncoding("utf8");

  const chunks = await drain(s);

  expect(chunks).toEqual(["héllo"]);
});

test("reads a payload larger than one read buffer", async () => {
  const big = "x".repeat(200_000);
  const s = new FdReadStream(fdOf(big));
  s.setEncoding("utf8");

  const chunks = await drain(s);

  expect(chunks.join("")).toBe(big);
  expect(chunks.length).toBeGreaterThan(1);
});

test("exposes the fd it was constructed with", () => {
  const fd = fdOf("x");
  expect(new FdReadStream(fd).fd).toBe(fd);
});

test("destroy() emits close and stops emitting data", async () => {
  const s = new FdReadStream(fdOf("payload"));
  let dataAfterDestroy = false;

  const closed = new Promise<void>((r) => s.on("close", () => r()));
  s.destroy();
  s.on("data", () => {
    dataAfterDestroy = true;
  });
  await closed;
  await Bun.sleep(30);

  expect(dataAfterDestroy).toBe(false);
});

// A real tty.ReadStream releases its fd when destroyed, and node-pty relies on
// that: closing the pty MASTER is what makes the slave side hang up. Leaking it
// also leaks a descriptor per session — which the daemon does over and over.
test("destroy() releases the underlying fd", async () => {
  const fd = fdOf("payload");
  const s = new FdReadStream(fd);

  s.destroy();
  await Bun.sleep(30);

  expect(() => fstatSync(fd)).toThrow();
});

test("close fires only once even if destroy() is called twice", async () => {
  const s = new FdReadStream(fdOf("payload"));
  let closes = 0;
  s.on("close", () => closes++);

  s.destroy();
  s.destroy();
  await Bun.sleep(30);

  expect(closes).toBe(1);
});

// node-pty's UnixTerminal expects a tty.ReadStream: it maps EIO to 'close'
// itself, ignores EAGAIN, and rethrows anything else (unixTerminal.js 'error'
// handler). So the stream must surface read failures verbatim, errno code
// intact, rather than interpreting them.
test("surfaces a read failure verbatim, with its errno code", async () => {
  const dead = fdOf("payload");
  closeSync(dead);
  const s = new FdReadStream(dead);

  const err = await new Promise<NodeJS.ErrnoException>((r) => s.on("error", r));

  expect(err.code).toBe("EBADF");
});

// EIO on the master fd is how a pty reports "the child is gone" — the NORMAL end
// of every session, not an edge case. The fd must be released there too, or every
// session leaks one. (A directory fd is the portable stand-in: reads fail with
// EISDIR while the fd itself stays valid.)
test("releases the fd after a read failure", async () => {
  const dirFd = openSync(mkdtempSync(join(tmpdir(), "cp-fd-")), "r");
  const s = new FdReadStream(dirFd);
  s.on("error", () => {});

  await new Promise<void>((r) => s.on("close", () => r()));

  expect(() => fstatSync(dirFd)).toThrow();
});
