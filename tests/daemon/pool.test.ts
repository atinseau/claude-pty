// tests/pool.test.ts
import { describe, expect, test } from "bun:test";
import { type Warm, WarmPool } from "../../src/daemon/pool";

function stub(sig: string, bornAt: number, killed: string[]): Warm<null> {
  const id = `${sig}@${bornAt}`;
  return {
    sig,
    sessionId: id,
    bornAt,
    kill: () => killed.push(id),
    value: null,
  };
}

describe("WarmPool", () => {
  test("add then take returns a matching entry", () => {
    const pool = new WarmPool<null>({ max: 4, ttlMs: 1000, now: () => 0 });
    const w = stub("sigA", 0, []);
    pool.add(w);
    expect(pool.take("sigA")).toBe(w);
    expect(pool.take("sigA")).toBeNull(); // consumed
  });

  test("take returns null for an unknown signature", () => {
    const pool = new WarmPool<null>({ max: 4, ttlMs: 1000, now: () => 0 });
    pool.add(stub("sigA", 0, []));
    expect(pool.take("sigB")).toBeNull();
  });

  test("expired entries are never returned and are killed", () => {
    const killed: string[] = [];
    let t = 0;
    const pool = new WarmPool<null>({ max: 4, ttlMs: 1000, now: () => t });
    pool.add(stub("sigA", 0, killed));
    t = 1500; // past ttl
    expect(pool.take("sigA")).toBeNull();
    expect(killed).toEqual(["sigA@0"]);
  });

  test("adding beyond max evicts the oldest (and kills it)", () => {
    const killed: string[] = [];
    const pool = new WarmPool<null>({ max: 2, ttlMs: 10_000, now: () => 100 });
    pool.add(stub("s", 1, killed));
    pool.add(stub("s", 2, killed));
    pool.add(stub("s", 3, killed)); // exceeds max → evict oldest (bornAt 1)
    expect(killed).toEqual(["s@1"]);
    expect(pool.size()).toBe(2);
  });

  test("countFor and size track per-signature and total", () => {
    const pool = new WarmPool<null>({ max: 9, ttlMs: 10_000, now: () => 0 });
    pool.add(stub("a", 0, []));
    pool.add(stub("a", 0, []));
    pool.add(stub("b", 0, []));
    expect(pool.countFor("a")).toBe(2);
    expect(pool.countFor("b")).toBe(1);
    expect(pool.size()).toBe(3);
  });

  test("clear kills everything", () => {
    const killed: string[] = [];
    const pool = new WarmPool<null>({ max: 9, ttlMs: 10_000, now: () => 0 });
    pool.add(stub("a", 0, killed));
    pool.add(stub("b", 0, killed));
    pool.clear();
    expect(killed.sort()).toEqual(["a@0", "b@0"]);
    expect(pool.size()).toBe(0);
  });
});
