# Concurrency and Load-Control Foundation

UltraSearch protects upstream providers and the local host with bounded, provider-specific controls rather than round-robin fanout or unbounded `Promise.all` concurrency.

This document describes the first concurrency phase. It intentionally covers short interactive search/fetch operations only. Per-user admission, long-running crawl queues, circuit breakers and distributed coordination are later phases.

## Design goals

1. Do not let one provider outage or slowdown consume unbounded memory.
2. Do not let Cloudflare rate-limit bursts turn into a local Crawl4AI browser stampede.
3. Do not let query expansion create unlimited SearXNG fanout.
4. Coalesce identical concurrent requests so multiple users asking for the same resource share one upstream call.
5. Keep the implementation small and process-local while UltraSearch runs as one MCP process.
6. Fail in a controlled way when queues are full or callers wait too long.

## Architecture

```text
incoming operation
       │
       ▼
  singleflight
       │
       ├── identical request already running → share its Promise
       │
       ▼
provider-specific policy
       │
       ├── SearXNG   → bounded semaphore
       ├── Cloudflare→ token bucket → bounded semaphore
       └── Crawl4AI  → bounded semaphore
       │
       ▼
 provider request
```

The controls live in:

```text
src/concurrency.ts
src/provider-control.ts
```

Provider adapters call the control layer rather than implementing their own queueing behavior.

## BoundedSemaphore

`BoundedSemaphore` has four important properties:

- `maxInFlight`: maximum active operations admitted at once;
- `maxQueue`: maximum callers allowed to wait;
- `queueTimeoutMs`: maximum queue wait before controlled rejection;
- permit release occurs in `finally`, including provider failures.

When the queue is already full, callers receive `QueueFullError` immediately. When a queued operation exceeds its wait budget, callers receive `QueueTimeoutError`.

The page-fetch cascade already treats provider exceptions as tier failures, so overload of one fetch provider can fall through to the next tier instead of accumulating work indefinitely.

## Singleflight

`singleflight(key, fn)` stores only currently running work.

```text
request A ─┐
request B ─┼── same normalized key ── one provider call
request C ─┘
```

When that Promise settles, success or failure, the key is removed. A later request can therefore retry normally.

Singleflight is not a persistent cache. It only removes duplicate work that overlaps in time.

### Keys

SearXNG keys include the effective query dimensions used by the request:

- query;
- category;
- fetch count;
- time range;
- language;
- engines;
- site filter.

Cloudflare snapshot keys include:

- URL;
- maximum characters;
- target selector;
- wait selector.

Crawl4AI keys include:

- URL;
- maximum characters;
- fit/raw Markdown preference;
- target selector;
- wait selector.

This prevents different extraction semantics from being incorrectly coalesced.

## SearXNG defaults

```text
SEARXNG_MAX_IN_FLIGHT=6
SEARXNG_MAX_QUEUE=24
SEARXNG_QUEUE_TIMEOUT_MS=5000
```

Expanded queries still run concurrently from the caller's perspective, but only the configured number of actual SearXNG requests may be active at once.

The queue is intentionally bounded because SearXNG eventually fans out to external engines. Increasing local concurrency cannot create unlimited useful upstream capacity.

## Cloudflare Browser Run defaults

```text
CLOUDFLARE_MAX_IN_FLIGHT=12
CLOUDFLARE_MAX_QUEUE=24
CLOUDFLARE_QUEUE_TIMEOUT_MS=5000

CLOUDFLARE_QUICK_ACTION_RPS=0.1
CLOUDFLARE_QUICK_ACTION_BURST=1
CLOUDFLARE_RATE_MAX_WAITERS=24
CLOUDFLARE_RATE_MAX_WAIT_MS=30000
```

The public default is deliberately conservative and compatible with the current Workers Free Quick Actions rate of one request every ten seconds. Operators on Workers Paid should explicitly increase `CLOUDFLARE_QUICK_ACTION_RPS` while leaving margin below their actual account limit.

The token bucket is acquired **before** the concurrency semaphore. A caller waiting for a future rate token therefore does not occupy a finite active Browser Run slot.

UltraSearch's private paid deployment is expected to use a higher configured value after the real Cloudflare account is connected and measured. Account-specific tuning does not belong in the public source defaults.

## Crawl4AI defaults

```text
CRAWL4AI_MAX_IN_FLIGHT=1
CRAWL4AI_MAX_QUEUE=8
CRAWL4AI_QUEUE_TIMEOUT_MS=5000
```

Crawl4AI is the local browser fallback, so its default is intentionally much tighter than Cloudflare.

For asynchronous Crawl4AI tasks, the permit remains held while the task is polled. This is deliberate: an asynchronous response still represents browser work owned by that fallback request, and releasing the permit early would allow multiple jobs to accumulate behind the local crawler.

The Crawl4AI request timeout starts only after the bulkhead admits the request. Queue wait therefore does not consume the crawler's execution timeout budget.

## Failure behavior

### Queue full

```text
provider queue full
       ↓
QueueFullError
       ↓
fetch tier records error
       ↓
next fetch tier may run
```

For SearXNG, a queue-full error surfaces as a search error in this phase. Hosted search provider fallback is a later phase.

### Queue timeout

A queued request that cannot start within its configured wait budget is removed from the queue and fails deterministically.

### Provider error

The active permit is always released. Singleflight removes the failed key, allowing a later retry.

## What this phase does not do

### No per-user admission yet

LibreChat user identity has not yet been wired into the MCP request context. UltraSearch will not invent a fake identity model. Per-user bulkheads belong in the LibreChat integration/admission phase.

### No circuit breakers yet

This phase bounds simultaneous work and queued work, but it does not yet remember provider failure streaks. Circuit breakers, `Retry-After` handling and technical-vs-budget health are a separate lane.

### No long-running `/crawl` queue yet

Site crawls are a different workload class from interactive page fetches. Cloudflare `/crawl` will use asynchronous job semantics and its own low-priority admission pool rather than sharing the short-fetch controls documented here.

### No distributed limiter yet

All state in `src/concurrency.ts` is in-process.

That is intentional for the initial single-process MCP deployment. If UltraSearch is later replicated horizontally, each process would otherwise own an independent semaphore/token bucket. At that point provider-wide rate and concurrency state must move to a shared coordination backend such as Valkey.

## Operational snapshots

`providerControlSnapshot()` exposes internal state for future health/telemetry wiring:

```text
SearXNG active / queued
Cloudflare active / queued / available rate tokens / rate waiters
Crawl4AI active / queued
```

This phase does not expose that snapshot as a public MCP tool. It exists so the next observability/admission lane can publish metrics without reaching into private class state.

## Validation requirements

The concurrency primitives have focused tests for:

- semaphore active limits;
- queued admission after release;
- queue-full failure;
- queue timeout and removal;
- permit release after provider error;
- token-bucket burst/refill;
- bounded rate waiters;
- identical singleflight coalescing;
- independent keys;
- failed singleflight cleanup.

The complete upstream-derived test suite must remain green in the private trusted validation harness before this lane is merged.
