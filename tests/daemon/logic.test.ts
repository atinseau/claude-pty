// tests/daemon-logic.test.ts
import { describe, expect, test } from "bun:test";
import { takeLiveWarm, warmMessages, warmSess } from "../../src/daemon/logic";
import type { Warm } from "../../src/daemon/pool";

type Live = { alive(): boolean };
// A minimal fake pool returning the queued entries in order.
function fakePool(queue: (Warm<Live> | null)[]) {
  return { take: () => (queue.length ? (queue.shift() ?? null) : null) };
}
function warm(id: string, alive: boolean, killed: string[]): Warm<Live> {
  return {
    sig: "s",
    sessionId: id,
    bornAt: 0,
    kill: () => killed.push(id),
    value: { alive: () => alive },
  };
}

describe("takeLiveWarm", () => {
  test("returns the first live entry", () => {
    const w = warm("a", true, []);
    expect(takeLiveWarm(fakePool([w]), "s")).toBe(w);
  });

  test("skips and kills dead entries until a live one", () => {
    const killed: string[] = [];
    const dead1 = warm("d1", false, killed);
    const dead2 = warm("d2", false, killed);
    const live = warm("ok", true, killed);
    expect(takeLiveWarm(fakePool([dead1, dead2, live]), "s")).toBe(live);
    expect(killed).toEqual(["d1", "d2"]);
  });

  test("returns null when the pool is empty or all dead", () => {
    expect(takeLiveWarm(fakePool([]), "s")).toBeNull();
    const killed: string[] = [];
    expect(
      takeLiveWarm(fakePool([warm("d", false, killed), null]), "s"),
    ).toBeNull();
    expect(killed).toEqual(["d"]);
  });
});

describe("warmMessages", () => {
  test("text input → the single combined message", () => {
    expect(warmMessages("text", "hi", [])).toEqual(["hi"]);
  });
  test("stream-json input → the NDJSON turns", () => {
    expect(warmMessages("stream-json", "", ["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("warmSess", () => {
  test("uses the warm TUI's assigned id as an explicit session", () => {
    expect(warmSess("sid-123")).toEqual({
      sessionId: "sid-123",
      injectSessionId: false,
      mode: "explicit",
    });
  });
});
