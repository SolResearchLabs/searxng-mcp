import { CircuitBreaker } from "./circuit-breaker.js";
import { BoundedSemaphore, singleflight, TokenBucket } from "./concurrency.js";

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function circuit(
  name: string,
  prefix: string,
  defaults: { failures: number; cooldownMs: number },
): CircuitBreaker {
  return new CircuitBreaker(name, {
    failureThreshold: positiveInt(
      `${prefix}_CIRCUIT_FAILURE_THRESHOLD`,
      defaults.failures,
    ),
    cooldownMs: positiveInt(
      `${prefix}_CIRCUIT_COOLDOWN_MS`,
      defaults.cooldownMs,
    ),
    maxCooldownMs: positiveInt(`${prefix}_CIRCUIT_MAX_COOLDOWN_MS`, 300_000),
  });
}

const searxngGate = new BoundedSemaphore(
  "searxng",
  positiveInt("SEARXNG_MAX_IN_FLIGHT", 6),
  nonNegativeInt("SEARXNG_MAX_QUEUE", 24),
  positiveInt("SEARXNG_QUEUE_TIMEOUT_MS", 5000),
);
const searxngCircuit = circuit("searxng", "SEARXNG", {
  failures: 5,
  cooldownMs: 30_000,
});

const cloudflareGate = new BoundedSemaphore(
  "cloudflare-browser-run",
  positiveInt("CLOUDFLARE_MAX_IN_FLIGHT", 12),
  nonNegativeInt("CLOUDFLARE_MAX_QUEUE", 24),
  positiveInt("CLOUDFLARE_QUEUE_TIMEOUT_MS", 5000),
);

// Public-safe default follows the current Workers Free Quick Actions limit:
// one request every ten seconds. Paid deployments should explicitly raise this
// below their account ceiling (currently 10 req/s by default).
const cloudflareRate = new TokenBucket(
  "cloudflare-browser-run-rate",
  positiveNumber("CLOUDFLARE_QUICK_ACTION_RPS", 0.1),
  positiveInt("CLOUDFLARE_QUICK_ACTION_BURST", 1),
  nonNegativeInt("CLOUDFLARE_RATE_MAX_WAITERS", 24),
  positiveInt("CLOUDFLARE_RATE_MAX_WAIT_MS", 30_000),
);
const cloudflareCircuit = circuit("cloudflare-browser-run", "CLOUDFLARE", {
  failures: 5,
  cooldownMs: 30_000,
});

const crawl4aiGate = new BoundedSemaphore(
  "crawl4ai",
  positiveInt("CRAWL4AI_MAX_IN_FLIGHT", 1),
  nonNegativeInt("CRAWL4AI_MAX_QUEUE", 8),
  positiveInt("CRAWL4AI_QUEUE_TIMEOUT_MS", 5000),
);
const crawl4aiCircuit = circuit("crawl4ai", "CRAWL4AI", {
  failures: 3,
  cooldownMs: 30_000,
});

export function runSearxng<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return singleflight(`searxng:${key}`, async () => {
    // Do not consume a finite provider queue slot when the circuit is known to
    // be open. execute() checks again after admission to handle races.
    searxngCircuit.assertAvailable();
    return searxngGate.run(() => searxngCircuit.execute(fn));
  });
}

export function runCloudflareQuickAction<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  return singleflight(`cloudflare:${key}`, async () => {
    // Circuit pre-check comes before the token bucket so an unhealthy provider
    // consumes neither a future rate token nor an active-request permit.
    cloudflareCircuit.assertAvailable();
    await cloudflareRate.acquire();
    return cloudflareGate.run(() => cloudflareCircuit.execute(fn));
  });
}

export function runCrawl4ai<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return singleflight(`crawl4ai:${key}`, async () => {
    crawl4aiCircuit.assertAvailable();
    return crawl4aiGate.run(() =>
      crawl4aiCircuit.execute(fn, {
        // Crawl4AI uses null as its established "could not produce content"
        // result. Count that toward local-provider health without changing the
        // existing adapter contract seen by the fetch cascade.
        isFailureResult: (result) => result === null,
      }),
    );
  });
}

export function providerControlSnapshot() {
  return {
    searxng: {
      ...searxngGate.snapshot(),
      circuit: searxngCircuit.snapshot(),
    },
    cloudflare: {
      ...cloudflareGate.snapshot(),
      rate: cloudflareRate.snapshot(),
      circuit: cloudflareCircuit.snapshot(),
    },
    crawl4ai: {
      ...crawl4aiGate.snapshot(),
      circuit: crawl4aiCircuit.snapshot(),
    },
  };
}
