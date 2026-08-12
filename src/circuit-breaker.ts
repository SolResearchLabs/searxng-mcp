import { ProviderHttpError } from "./provider-errors.js";

export type CircuitState = "closed" | "open" | "half_open";

export class CircuitOpenError extends Error {
  constructor(
    public readonly circuit: string,
    public readonly retryAfterMs: number,
  ) {
    super(`${circuit} circuit is open`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  maxCooldownMs?: number;
}

export interface CircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  retryAfterMs: number;
  cooldownMs: number;
}

interface ExecuteOptions<T> {
  isFailureResult?: (result: T) => boolean;
}

/**
 * Small process-local consecutive-failure circuit breaker.
 *
 * A provider 429 opens immediately. If Retry-After is present, the circuit
 * remains open for at least that duration. Ordinary failures open only after
 * the configured consecutive-failure threshold. Once the cooldown expires,
 * exactly one half-open probe is admitted.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openUntilMs = 0;
  private halfOpenProbeInFlight = false;
  private currentCooldownMs: number;

  constructor(
    public readonly name: string,
    private readonly options: CircuitBreakerOptions,
  ) {
    if (
      !Number.isInteger(options.failureThreshold) ||
      options.failureThreshold < 1
    )
      throw new Error("failureThreshold must be a positive integer");
    if (!Number.isFinite(options.cooldownMs) || options.cooldownMs <= 0)
      throw new Error("cooldownMs must be positive");
    if (
      options.maxCooldownMs !== undefined &&
      (!Number.isFinite(options.maxCooldownMs) ||
        options.maxCooldownMs < options.cooldownMs)
    ) {
      throw new Error("maxCooldownMs must be >= cooldownMs");
    }
    this.currentCooldownMs = options.cooldownMs;
  }

  snapshot(nowMs = Date.now()): CircuitSnapshot {
    this.refreshState(nowMs);
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      retryAfterMs:
        this.state === "open" ? Math.max(0, this.openUntilMs - nowMs) : 0,
      cooldownMs: this.currentCooldownMs,
    };
  }

  /** Fast pre-check so callers do not consume a rate token/queue slot when open. */
  assertAvailable(nowMs = Date.now()): void {
    this.refreshState(nowMs);
    if (this.state === "open") {
      throw new CircuitOpenError(
        this.name,
        Math.max(0, this.openUntilMs - nowMs),
      );
    }
    if (this.state === "half_open" && this.halfOpenProbeInFlight) {
      throw new CircuitOpenError(this.name, this.currentCooldownMs);
    }
  }

  async execute<T>(
    fn: () => Promise<T> | T,
    options?: ExecuteOptions<T>,
  ): Promise<T> {
    const isHalfOpenProbe = this.acquireExecutionPermit();
    try {
      const result = await fn();
      if (options?.isFailureResult?.(result)) {
        this.recordFailure(undefined, isHalfOpenProbe);
      } else {
        this.recordSuccess();
      }
      return result;
    } catch (err) {
      // A CircuitOpenError can only originate from nested control logic; it
      // says nothing new about this provider's health.
      if (!(err instanceof CircuitOpenError)) {
        this.recordFailure(err, isHalfOpenProbe);
      } else if (isHalfOpenProbe) {
        this.halfOpenProbeInFlight = false;
      }
      throw err;
    }
  }

  private acquireExecutionPermit(nowMs = Date.now()): boolean {
    this.refreshState(nowMs);
    if (this.state === "open") {
      throw new CircuitOpenError(
        this.name,
        Math.max(0, this.openUntilMs - nowMs),
      );
    }
    if (this.state === "half_open") {
      if (this.halfOpenProbeInFlight) {
        throw new CircuitOpenError(this.name, this.currentCooldownMs);
      }
      this.halfOpenProbeInFlight = true;
      return true;
    }
    return false;
  }

  private refreshState(nowMs: number): void {
    if (this.state === "open" && nowMs >= this.openUntilMs) {
      this.state = "half_open";
      this.halfOpenProbeInFlight = false;
    }
  }

  private recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openUntilMs = 0;
    this.halfOpenProbeInFlight = false;
    this.currentCooldownMs = this.options.cooldownMs;
  }

  private recordFailure(err: unknown, wasHalfOpenProbe: boolean): void {
    const providerError = err instanceof ProviderHttpError ? err : null;
    const immediateOpen = providerError?.rateLimited === true;

    if (wasHalfOpenProbe || this.state === "half_open") {
      this.currentCooldownMs = Math.min(
        this.currentCooldownMs * 2,
        this.options.maxCooldownMs ?? this.options.cooldownMs * 8,
      );
      this.open(providerError?.retryAfterMs);
      return;
    }

    this.consecutiveFailures += 1;
    if (
      immediateOpen ||
      this.consecutiveFailures >= this.options.failureThreshold
    ) {
      this.open(providerError?.retryAfterMs);
    }
  }

  private open(retryAfterMs?: number): void {
    const now = Date.now();
    const waitMs = Math.max(this.currentCooldownMs, retryAfterMs ?? 0);
    this.state = "open";
    this.openUntilMs = now + waitMs;
    this.halfOpenProbeInFlight = false;
  }
}
