// src/pty/fd-stream.ts
//
// A minimal stand-in for `tty.ReadStream`, reading an fd with fs.read.
//
// ─── Bun net/tty read bug (unix) ─────────────────────────────────────────────
// This is the exact mirror image of the Windows write bug documented in
// ./runtime.ts. On unix, node-pty reads the pty master by wrapping its fd in
// `new tty.ReadStream(term.fd)` (unixTerminal.js). Under Bun on macOS/Linux that
// stream never yields anything: zero 'data' events, no 'close', no 'error' — so
// the TUI's output is invisible and every session hangs until its turn timeout.
// (Verified against the same spawn under Node.js, where it works.)
//
// fs.read on the same fd works fine under Bun, so ./runtime.ts substitutes this
// class for tty.ReadStream before node-pty loads.
//
// ─── Contract: behave like the fs.ReadStream node-pty expects ────────────────
// node-pty's UnixTerminal already interprets read failures itself: it ignores
// EAGAIN, maps EIO to a normal 'close' (the pty master's way of reporting the
// child is gone), and rethrows anything else. So this stream must NOT interpret
// errors — it surfaces them verbatim with the errno code intact. The single
// exception is EAGAIN, which on a non-blocking pty master merely means "nothing
// to read yet" and must be retried, or the stream would stall on the first one.

import { EventEmitter } from "events";
import { closeSync, read } from "fs";

/** Read buffer size — matches node-pty's own chunking granularity closely enough. */
const READ_CHUNK_BYTES = 65536;

/** Backoff before retrying a read that returned EAGAIN (nothing available yet). */
const EAGAIN_RETRY_MS = 5;

export class FdReadStream extends EventEmitter {
  readable = true;
  private encoding: BufferEncoding | null = null;
  private closed = false;
  private paused = false;

  constructor(readonly fd: number) {
    super();
    // Defer the first read so the caller can attach listeners / setEncoding()
    // before any 'data' can be emitted (node-pty does both synchronously right
    // after construction).
    queueMicrotask(() => this.pump());
  }

  setEncoding(encoding: BufferEncoding): this {
    this.encoding = encoding;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  /**
   * Stop reading, release the fd, and emit 'close' — at most once.
   *
   * Releasing the fd is not just tidiness: closing the pty MASTER is what hangs
   * up the slave side, which is how node-pty's teardown reaches the child. It
   * also keeps a long-lived process (the daemon, which spawns a TUI per session)
   * from leaking one descriptor per session.
   */
  destroy(): this {
    if (this.closed) return this;
    this.closed = true;
    this.readable = false;
    try {
      closeSync(this.fd);
    } catch {
      // Already gone (the child died and took the pty with it).
    }
    this.emit("close");
    return this;
  }

  /** Read-emit loop: one outstanding fs.read at a time, until closed. */
  private pump(): void {
    if (this.closed) return;
    if (this.paused) {
      setTimeout(() => this.pump(), EAGAIN_RETRY_MS);
      return;
    }
    const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    read(this.fd, buf, 0, buf.length, null, (err, bytesRead) => {
      if (this.closed) return;
      if (err) {
        if ((err as NodeJS.ErrnoException).code === "EAGAIN") {
          setTimeout(() => this.pump(), EAGAIN_RETRY_MS);
          return;
        }
        // Report it first (node-pty's handler turns EIO into its own 'close'),
        // then release the fd — 'close' is emitted at most once either way.
        this.emit("error", err);
        this.destroy();
        return;
      }
      if (bytesRead === 0) {
        this.destroy(); // EOF: release the fd and report 'close'
        return;
      }
      const chunk = buf.subarray(0, bytesRead);
      this.emit("data", this.encoding ? chunk.toString(this.encoding) : chunk);
      this.pump();
    });
  }
}
