import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../src/circuit-breaker.js";
import {
  ProviderHttpError,
  parseRetryAfterMs,
} from "../src/provider-errors.js";

afterEach(() => {
  vi.useRealTimers();
});

function breaker(overrides?: {
  failureThreshold?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
}) {
  return new CircuitBreaker("provider", {
    failureThreshold: overrides?.failureThreshold ?? 3,
    cooldownMs: overrides?.cooldownMs ?? 1000,
    maxCooldownMs: overrides?.maxCooldownMs ?? 8000,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("CircuitBreaker", () => {
  it("stays closed across successful calls", async () => {
    const circuit = breaker();
    await expect(circuit.execute(async () => "ok")).resolves.toBe("ok");
    expect(circuit.snapshot()).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });

  it("opens after the configured consecutive-failure threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T20:00:00Z"));
    const circuit = breaker({ failureThreshold: 2 });

    for (let i = 0; i < 2; i += 1) {
      await expect(
        circuit.execute(async () => {
          throw new Error("upstream failed");
        }),
      ).rejects.toThrow("upstream failed");
    }

    expect(circuit.snapshot()).toMatchObject({
      state: "open",
      consecutiveFailures: 2,
      retryAfterMs: 1000,
    });
    await expect(circuit.execute(async () => "nope")).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
  });

  it("admits exactly one half-open probe after cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T20:00:00Z"));
    const circuit = breaker({ failureThreshold: 1 });

    await expect(
      circuit.execute(async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");

    await vi.advanceTimersByTimeAsync(1000);
    const hold = deferred<string>();
    const probe = circuit.execute(() => hold.promise);
    await Promise.resolve();

    expect(circuit.snapshot()).toMatchObject({ state: "half_open" });
    await expect(
      circuit.execute(async () => "second probe"),
    ).rejects.toBeInstanceOf(CircuitOpenError);

    hold.resolve("recovered");
    await expect(probe).resolves.toBe("recovered");
    expect(circuit.snapshot()).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });

  it("reopens with exponential cooldown when a half-open probe fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T20:00:00Z"));
    const circuit = breaker({ failureThreshold: 1, cooldownMs: 1000 });

    await expect(
      circuit.execute(async () => {
        throw new Error("first");
      }),
    ).rejects.toThrow("first");
    await vi.advanceTimersByTimeAsync(1000);

    await expect(
      circuit.execute(async () => {
        throw new Error("probe failed");
      }),
    ).rejects.toThrow("probe failed");

    expect(circuit.snapshot()).toMatchObject({
      state: "open",
      cooldownMs: 2000,
      retryAfterMs: 2000,
    });
  });

  it("opens immediately on a 429 and honors a longer Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T20:00:00Z"));
    const circuit = breaker({ failureThreshold: 99, cooldownMs: 1000 });

    await expect(
      circuit.execute(async () => {
        throw new ProviderHttpError("provider", 429, "rate limited", 5000);
      }),
    ).rejects.toThrow("rate limited");

    expect(circuit.snapshot()).toMatchObject({
      state: "open",
      consecutiveFailures: 1,
      retryAfterMs: 5000,
    });
  });

  it("counts configured failure results without changing the caller contract", async () => {
    const circuit = breaker({ failureThreshold: 2 });

    await expect(
      circuit.execute(async () => null, { isFailureResult: (v) => v === null }),
    ).resolves.toBeNull();
    await expect(
      circuit.execute(async () => null, { isFailureResult: (v) => v === null }),
    ).resolves.toBeNull();

    expect(circuit.snapshot().state).toBe("open");
  });

  it("resets the failure streak after a successful call", async () => {
    const circuit = breaker({ failureThreshold: 3 });

    await expect(
      circuit.execute(async () => {
        throw new Error("one");
      }),
    ).rejects.toThrow("one");
    await expect(circuit.execute(async () => "ok")).resolves.toBe("ok");

    expect(circuit.snapshot()).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("2.5", 0)).toBe(2500);
  });

  it("parses an HTTP-date relative to now", () => {
    const now = Date.parse("2026-08-12T20:00:00Z");
    expect(parseRetryAfterMs("Wed, 12 Aug 2026 20:00:05 GMT", now)).toBe(5000);
  });

  it("returns undefined for invalid input", () => {
    expect(parseRetryAfterMs("banana", 0)).toBeUndefined();
    expect(parseRetryAfterMs(null, 0)).toBeUndefined();
  });
});
