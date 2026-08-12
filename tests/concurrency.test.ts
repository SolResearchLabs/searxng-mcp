import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoundedSemaphore,
  QueueFullError,
  QueueTimeoutError,
  singleflight,
  singleflightSize,
  TokenBucket,
} from "../src/concurrency.js";

afterEach(() => {
  vi.useRealTimers();
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("BoundedSemaphore", () => {
  it("bounds active work and admits queued work after release", async () => {
    const gate = new BoundedSemaphore("provider", 1, 2, 500);
    const hold = deferred<void>();
    const order: string[] = [];

    const first = gate.run(async () => {
      order.push("first-start");
      await hold.promise;
      order.push("first-end");
      return 1;
    });
    await Promise.resolve();

    const second = gate.run(async () => {
      order.push("second-start");
      return 2;
    });
    await Promise.resolve();

    expect(gate.snapshot()).toMatchObject({ active: 1, queued: 1 });
    expect(order).toEqual(["first-start"]);

    hold.resolve();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
    expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("fails fast when the bounded queue is full", async () => {
    const gate = new BoundedSemaphore("provider", 1, 1, 500);
    const hold = deferred<void>();

    const first = gate.run(() => hold.promise);
    await Promise.resolve();
    const second = gate.run(async () => 2);
    await Promise.resolve();

    await expect(gate.run(async () => 3)).rejects.toBeInstanceOf(QueueFullError);

    hold.resolve();
    await first;
    await second;
  });

  it("removes a queued waiter when its timeout expires", async () => {
    vi.useFakeTimers();
    const gate = new BoundedSemaphore("provider", 1, 1, 100);
    const hold = deferred<void>();

    const first = gate.run(() => hold.promise);
    await Promise.resolve();
    const queued = gate.run(async () => 2);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(100);
    await expect(queued).rejects.toBeInstanceOf(QueueTimeoutError);
    expect(gate.snapshot()).toMatchObject({ active: 1, queued: 0 });

    hold.resolve();
    await first;
  });

  it("releases its permit when provider work throws", async () => {
    const gate = new BoundedSemaphore("provider", 1, 0, 100);
    await expect(
      gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(gate.run(async () => "recovered")).resolves.toBe("recovered");
  });
});

describe("TokenBucket", () => {
  it("allows a burst and then refills at the configured rate", async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket("rate", 2, 1, 2, 2000);

    await bucket.acquire();
    let admitted = false;
    const second = bucket.acquire().then(() => {
      admitted = true;
    });

    await vi.advanceTimersByTimeAsync(499);
    expect(admitted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(admitted).toBe(true);
  });

  it("bounds the number of callers waiting for rate tokens", async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket("rate", 1, 1, 1, 5000);

    await bucket.acquire();
    const waiting = bucket.acquire();
    await Promise.resolve();

    await expect(bucket.acquire()).rejects.toBeInstanceOf(QueueFullError);
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
  });
});

describe("singleflight", () => {
  it("shares identical in-flight work and removes it after completion", async () => {
    const hold = deferred<string>();
    let calls = 0;

    const first = singleflight("same-key", async () => {
      calls += 1;
      return hold.promise;
    });
    const second = singleflight("same-key", async () => {
      calls += 1;
      return "wrong";
    });

    await Promise.resolve();
    expect(calls).toBe(1);
    expect(singleflightSize()).toBe(1);

    hold.resolve("shared");
    await expect(first).resolves.toBe("shared");
    await expect(second).resolves.toBe("shared");
    expect(singleflightSize()).toBe(0);
  });

  it("keeps different keys independent", async () => {
    const values = await Promise.all([
      singleflight("key-a", async () => "a"),
      singleflight("key-b", async () => "b"),
    ]);
    expect(values).toEqual(["a", "b"]);
  });

  it("cleans up failed work so the next attempt can retry", async () => {
    await expect(
      singleflight("retry-key", async () => {
        throw new Error("first failed");
      }),
    ).rejects.toThrow("first failed");

    await expect(
      singleflight("retry-key", async () => "second worked"),
    ).resolves.toBe("second worked");
  });
});
