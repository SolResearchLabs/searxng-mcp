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

const searxngGate = new BoundedSemaphore(
  "searxng",
  positiveInt("SEARXNG_MAX_IN_FLIGHT", 6),
  nonNegativeInt("SEARXNG_MAX_QUEUE", 24),
  positiveInt("SEARXNG_QUEUE_TIMEOUT_MS", 5000),
);

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

const crawl4aiGate = new BoundedSemaphore(
  "crawl4ai",
  positiveInt("CRAWL4AI_MAX_IN_FLIGHT", 1),
  nonNegativeInt("CRAWL4AI_MAX_QUEUE", 8),
  positiveInt("CRAWL4AI_QUEUE_TIMEOUT_MS", 5000),
);

export function runSearxng<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return singleflight(`searxng:${key}`, () => searxngGate.run(fn));
}

export function runCloudflareQuickAction<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  return singleflight(`cloudflare:${key}`, async () => {
    // Rate waiting happens before the concurrency slot so queued callers do
    // not consume one of the finite active-request permits.
    await cloudflareRate.acquire();
    return cloudflareGate.run(fn);
  });
}

export function runCrawl4ai<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return singleflight(`crawl4ai:${key}`, () => crawl4aiGate.run(fn));
}

export function providerControlSnapshot() {
  return {
    searxng: searxngGate.snapshot(),
    cloudflare: {
      ...cloudflareGate.snapshot(),
      rate: cloudflareRate.snapshot(),
    },
    crawl4ai: crawl4aiGate.snapshot(),
  };
}
