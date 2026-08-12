export class QueueFullError extends Error {
  constructor(public readonly gate: string) {
    super(`${gate} queue is full`);
    this.name = "QueueFullError";
  }
}

export class QueueTimeoutError extends Error {
  constructor(public readonly gate: string) {
    super(`${gate} queue wait timed out`);
    this.name = "QueueTimeoutError";
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Small in-process bulkhead for one provider/capability.
 *
 * The queue is intentionally bounded. Under sustained overload callers receive
 * a deterministic error that the existing fetch cascade can treat as a tier
 * failure instead of accumulating unbounded promises until the process OOMs.
 */
export class BoundedSemaphore {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    public readonly name: string,
    public readonly maxInFlight: number,
    public readonly maxQueue: number,
    public readonly queueTimeoutMs: number,
  ) {
    if (!Number.isInteger(maxInFlight) || maxInFlight < 1)
      throw new Error("maxInFlight must be a positive integer");
    if (!Number.isInteger(maxQueue) || maxQueue < 0)
      throw new Error("maxQueue must be a non-negative integer");
    if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs <= 0)
      throw new Error("queueTimeoutMs must be positive");
  }

  snapshot(): {
    active: number;
    queued: number;
    maxInFlight: number;
    maxQueue: number;
  } {
    return {
      active: this.active,
      queued: this.queue.length,
      maxInFlight: this.maxInFlight,
      maxQueue: this.maxQueue,
    };
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxInFlight) {
      this.active += 1;
      return Promise.resolve();
    }

    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new QueueFullError(this.name));
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          if (waiter.timer) clearTimeout(waiter.timer);
          this.active += 1;
          resolve();
        },
        reject,
        timer: null,
      };

      waiter.timer = setTimeout(() => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new QueueTimeoutError(this.name));
      }, this.queueTimeoutMs);

      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const waiter = this.queue.shift();
    waiter?.resolve();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lightweight token bucket. It intentionally does not own the provider
 * concurrency slot while waiting for a token; callers should acquire the token
 * before entering their BoundedSemaphore.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private waiters = 0;

  constructor(
    public readonly name: string,
    public readonly ratePerSecond: number,
    public readonly capacity: number,
    public readonly maxWaiters: number,
    public readonly maxWaitMs: number,
  ) {
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0)
      throw new Error("ratePerSecond must be positive");
    if (!Number.isFinite(capacity) || capacity < 1)
      throw new Error("capacity must be at least 1");
    if (!Number.isInteger(maxWaiters) || maxWaiters < 0)
      throw new Error("maxWaiters must be a non-negative integer");
    if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0)
      throw new Error("maxWaitMs must be positive");

    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  snapshot(): {
    tokens: number;
    waiters: number;
    ratePerSecond: number;
    capacity: number;
  } {
    this.refill();
    return {
      tokens: this.tokens,
      waiters: this.waiters,
      ratePerSecond: this.ratePerSecond,
      capacity: this.capacity,
    };
  }

  async acquire(): Promise<void> {
    if (this.tryTake()) return;
    if (this.waiters >= this.maxWaiters) throw new QueueFullError(this.name);

    this.waiters += 1;
    const started = Date.now();
    try {
      while (true) {
        if (this.tryTake()) return;

        const elapsed = Date.now() - started;
        if (elapsed >= this.maxWaitMs) throw new QueueTimeoutError(this.name);

        const missing = Math.max(0, 1 - this.tokens);
        const refillWait = Math.max(
          1,
          Math.ceil((missing / this.ratePerSecond) * 1000),
        );
        await sleep(Math.min(refillWait, this.maxWaitMs - elapsed));
      }
    } finally {
      this.waiters -= 1;
    }
  }

  private tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = Math.max(0, now - this.lastRefillMs) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSeconds * this.ratePerSecond,
    );
    this.lastRefillMs = now;
  }
}

const inFlight = new Map<string, Promise<unknown>>();

/** Share one in-flight operation among callers with the same normalized key. */
export function singleflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = Promise.resolve()
    .then(fn)
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

export function singleflightSize(): number {
  return inFlight.size;
}
