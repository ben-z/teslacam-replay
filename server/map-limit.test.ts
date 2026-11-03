import { describe, expect, it, vi } from "vitest";
import { mapLimit } from "./map-limit";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("bounded recording work", () => {
  it("preserves input order while running no more than the requested workers", async () => {
    const held = Array.from({ length: 3 }, deferred);
    const started: number[] = [];
    let active = 0;
    let maximum = 0;
    const work = mapLimit([0, 1, 2], 2, async (item) => {
      started.push(item);
      active++;
      maximum = Math.max(maximum, active);
      await held[item].promise;
      active--;
      return item * 2;
    });
    expect(started).toEqual([0, 1]);
    held[1].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    held[2].resolve();
    held[0].resolve();
    expect(await work).toEqual([0, 2, 4]);
    expect(maximum).toBe(2);
    expect(active).toBe(0);
  });

  it("stops pending work after the first failure and drains running workers", async () => {
    const held = [deferred(), deferred()];
    const started: number[] = [];
    const first = new Error("First recording header failed");
    const later = new Error("Another running header failed");
    let active = 0;
    let settled = false;
    const work = mapLimit([0, 1, 2, 3, 4], 2, async (item) => {
      started.push(item);
      active++;
      try {
        await held[item].promise;
        return item;
      } finally {
        active--;
      }
    }).then(
      () => { settled = true; throw new Error("Expected failure"); },
      (error: unknown) => { settled = true; return error; },
    );
    expect(started).toEqual([0, 1]);
    held[0].reject(first);
    await vi.waitFor(() => expect(active).toBe(1));
    expect(settled).toBe(false);
    expect(started).toEqual([0, 1]);
    held[1].reject(later);
    expect(await work).toBe(first);
    expect(active).toBe(0);
    expect(started).toEqual([0, 1]);
  });

  it("does not launch other work after a synchronous failure", async () => {
    const failure = new Error("Cannot start header read");
    const run = vi.fn((): Promise<number> => { throw failure; });
    await expect(mapLimit([0, 1, 2], 2, run)).rejects.toBe(failure);
    expect(run).toHaveBeenCalledOnce();
  });

  it("returns an empty result without starting workers", async () => {
    const run = vi.fn(async () => 1);
    expect(await mapLimit([], 3, run)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity])("rejects invalid concurrency %s even for empty work", async (concurrency) => {
    const run = vi.fn(async () => 1);
    await expect(mapLimit([], concurrency, run)).rejects.toThrow("Invalid worker concurrency");
    expect(run).not.toHaveBeenCalled();
  });
});
