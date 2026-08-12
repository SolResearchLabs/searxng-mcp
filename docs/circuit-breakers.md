# Provider Circuit Breakers

UltraSearch uses provider-specific circuit breakers on top of its bounded queues and rate controls.

The purpose is different from concurrency limiting:

- **bulkheads** control how much work may run or wait;
- **rate limiting** controls request velocity;
- **circuit breakers** stop sending work to a provider that is currently unhealthy.

These mechanisms remain independent so local overload is not misclassified as upstream provider failure.

## States

Each provider circuit has three states:

```text
closed
  │
  │ consecutive provider failures
  ▼
open
  │
  │ cooldown expires
  ▼
half_open
  │
  ├── one successful probe ──► closed
  │
  └── failed probe ──────────► open with longer cooldown
```

Only one probe may run while a circuit is half-open. Other callers receive `CircuitOpenError` and can follow the normal fallback behavior for their operation.

## What counts as a provider failure

### Counts

- admitted provider request throws because of network/upstream failure;
- provider returns an HTTP error represented by `ProviderHttpError`;
- Cloudflare or SearXNG returns HTTP 429;
- Crawl4AI returns its established `null` result indicating that no usable page content was produced.

### Does not count

- local provider queue is full;
- local queue wait times out;
- a caller is rejected by an already-open circuit;
- Cloudflare token-bucket waiting itself;
- missing Cloudflare credentials rejected before the provider-control layer.

This distinction matters. A busy UltraSearch process must not mark Cloudflare or SearXNG as unhealthy simply because UltraSearch's own local queue was saturated.

## 429 and Retry-After

`ProviderHttpError` carries:

```text
provider
HTTP status
message
optional retryAfterMs
```

`Retry-After` supports both standard forms:

```text
Retry-After: 5
Retry-After: Wed, 12 Aug 2026 20:00:05 GMT
```

A 429 opens the provider circuit immediately even if the normal failure threshold has not been reached.

If `Retry-After` is present, the circuit remains open for at least that long. Otherwise it uses the configured cooldown.

UltraSearch does not blindly sleep inside each caller after a 429. Opening the shared process-local circuit prevents a thundering herd of callers from independently retrying the same provider.

## Half-open behavior

When the open interval expires, the circuit becomes half-open.

Exactly one admitted request becomes the probe:

```text
half-open
   │
   ├── probe in flight
   │      │
   │      ├── success → close + reset failure streak/cooldown
   │      └── failure → reopen + increase cooldown
   │
   └── other callers → CircuitOpenError
```

The failed-probe cooldown doubles until the configured maximum. A successful probe returns the circuit to its base cooldown.

## Default configuration

### SearXNG

```text
SEARXNG_CIRCUIT_FAILURE_THRESHOLD=5
SEARXNG_CIRCUIT_COOLDOWN_MS=30000
SEARXNG_CIRCUIT_MAX_COOLDOWN_MS=300000
```

### Cloudflare Browser Run

```text
CLOUDFLARE_CIRCUIT_FAILURE_THRESHOLD=5
CLOUDFLARE_CIRCUIT_COOLDOWN_MS=30000
CLOUDFLARE_CIRCUIT_MAX_COOLDOWN_MS=300000
```

### Crawl4AI

```text
CRAWL4AI_CIRCUIT_FAILURE_THRESHOLD=3
CRAWL4AI_CIRCUIT_COOLDOWN_MS=30000
CRAWL4AI_CIRCUIT_MAX_COOLDOWN_MS=300000
```

Crawl4AI is intentionally more sensitive because it is a local fallback whose failures may indicate browser or host pressure. The dedicated host-pressure/admission phase may later suppress local browser work before the circuit is involved.

## Request order

### SearXNG

```text
singleflight
   ↓
circuit pre-check
   ↓
bounded semaphore
   ↓
circuit execute
   ↓
SearXNG
```

The pre-check keeps known-open providers out of the queue. The second check inside circuit execution closes the race where provider state changes while the caller is waiting for a semaphore slot.

### Cloudflare Browser Run

```text
singleflight
   ↓
circuit pre-check
   ↓
token bucket
   ↓
bounded semaphore
   ↓
circuit execute
   ↓
Browser Run
```

A known-open Cloudflare circuit therefore consumes neither a future rate token nor an active Browser Run permit.

### Crawl4AI

```text
singleflight
   ↓
circuit pre-check
   ↓
bounded local semaphore
   ↓
circuit execute
   ↓
Crawl4AI
```

`null` remains part of Crawl4AI's existing adapter contract, but the circuit records it as an unsuccessful provider attempt.

## Fallback interaction

A circuit-open error from a page-fetch tier is handled like another provider-tier error by the existing fetch cascade.

Example:

```text
Cloudflare circuit open
        ↓
Cloudflare returns immediately without API call
        ↓
Crawl4AI fallback bulkhead
        ↓
if Crawl4AI is saturated/unhealthy
        ↓
raw HTTP / later fallback tiers
```

The Crawl4AI bulkhead remains active even when Cloudflare is open. This prevents a remote-provider outage from becoming an uncontrolled local Chromium burst.

SearXNG currently has no hosted-search fallback in this phase, so a SearXNG circuit-open error surfaces as a search failure. The generic hosted-provider pool is a later UltraSearch lane.

## Observability

`providerControlSnapshot()` now includes the circuit snapshot for each controlled provider:

```text
state
consecutiveFailures
retryAfterMs
cooldownMs
```

This is intentionally internal for now. A later observability/admission lane can publish these states as metrics and health output without accessing private circuit fields directly.

## Process-local boundary

Like the concurrency controls, these circuit breakers are process-local.

That is correct for the initial single-process MCP deployment. If UltraSearch later runs multiple replicas, each replica would otherwise learn health independently. Provider-wide circuit state should then move to a shared coordination backend or a deliberate distributed-health design.

## Test coverage

Focused tests verify:

- success keeps the circuit closed;
- consecutive failures open at the threshold;
- open circuits reject new work;
- exactly one half-open probe is admitted;
- successful probe closes and resets state;
- failed half-open probe reopens with longer cooldown;
- HTTP 429 opens immediately;
- Retry-After extends the open interval;
- Crawl4AI-style null results can count as failures without changing the returned value;
- Retry-After delta-seconds and HTTP-date parsing;
- invalid Retry-After input is ignored safely.
