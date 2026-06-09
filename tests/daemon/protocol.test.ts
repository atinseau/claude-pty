// tests/ipc.test.ts
import { describe, expect, test } from "bun:test";
import { createFrameDecoder, encodeFrame } from "../../src/daemon/protocol";

describe("encodeFrame", () => {
  test("serializes an object to one newline-terminated JSON line", () => {
    expect(encodeFrame({ s: "o", d: "hi" })).toBe('{"s":"o","d":"hi"}\n');
  });

  test("escapes embedded newlines so framing stays one-line-per-frame", () => {
    const line = encodeFrame({ d: "a\nb" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1); // only the trailing newline
  });
});

describe("createFrameDecoder", () => {
  test("yields complete frames, buffering partial trailing data", () => {
    const dec = createFrameDecoder();
    expect(dec.push('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("reassembles a frame split across chunks", () => {
    const dec = createFrameDecoder();
    expect(dec.push('{"a":')).toEqual([]);
    expect(dec.push("1}\n")).toEqual([{ a: 1 }]);
  });

  test("holds a partial trailing line until its newline arrives", () => {
    const dec = createFrameDecoder();
    expect(dec.push('{"a":1}\n{"b":')).toEqual([{ a: 1 }]);
    expect(dec.push("2}\n")).toEqual([{ b: 2 }]);
  });

  test("round-trips with encodeFrame", () => {
    const dec = createFrameDecoder();
    const msgs = [
      { s: "o", d: "line1\n" },
      { s: "x", c: 0 },
    ];
    const wire = msgs.map(encodeFrame).join("");
    expect(dec.push(wire)).toEqual(msgs);
  });
});
