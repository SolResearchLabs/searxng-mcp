# Crawl4AI Host Load Shedding

UltraSearch treats Crawl4AI as a local browser fallback, not an unlimited second primary. Remote-provider degradation must not turn into a Chromium stampede on the machine that is also running the rest of the AI stack.

This phase adds memory-aware admission specifically around new Crawl4AI work.

## Three independent health domains

UltraSearch deliberately keeps three different kinds of health separate:

```text
provider health
  Cloudflare/SearXNG/Crawl4AI circuit state

host health
  local memory pressure and admission capacity

domain capability
  whether a particular website succeeds on a particular fetch tier
```

These must not contaminate each other.

Examples:

- Cloudflare HTTP 429 means Cloudflare/account pressure. It is **not** evidence that `example.com` is bad for Browser Run.
- Crawl4AI queue saturation means local admission pressure. It is **not** evidence that Crawl4AI is unhealthy and is **not** evidence that `example.com` fails in Crawl4AI.
- Critical host memory means no new local browser work should start. It is **not** a Crawl4AI provider failure and is **not** a target-domain failure.
- A real Crawl4AI page attempt that returns no usable content **is** provider/domain evidence.

## Memory source

On Linux, UltraSearch reads `/proc/meminfo` and uses:

```text
MemTotal
MemAvailable
```

`MemAvailable` is used rather than `MemFree` because it better represents memory the kernel can make available to applications without swapping heavily.

If `/proc/meminfo` cannot be read or UltraSearch runs on another platform, the monitor falls back to Node's `os.totalmem()` / `os.freemem()` values.

Sampling failure must never crash the fetch router.

## Sampling cache

Host memory is not read on every individual provider call.

Default:

```text
CRAWL4AI_HOST_PRESSURE_SAMPLE_TTL_MS=1000
```

The latest classification is reused for one second. This keeps admission cheap while still reacting quickly enough for interactive browser workloads.

## Pressure states

Default public thresholds:

```text
CRAWL4AI_HOST_PRESSURE_ENABLED=true
CRAWL4AI_HOST_PRESSURE_SOFT_AVAILABLE_PERCENT=25
CRAWL4AI_HOST_PRESSURE_HARD_AVAILABLE_PERCENT=15
CRAWL4AI_HOST_PRESSURE_HARD_AVAILABLE_MB=1024
```

Classification:

```text
critical
  available <= hard percentage
  OR available <= absolute MiB floor

degraded
  available <= soft percentage
  and not already critical

normal
  otherwise
```

The absolute floor protects smaller hosts where a percentage alone can leave too little practical headroom.

These are public defaults, not SolResearchLabs deployment tuning. Private deployment values should be chosen from measured host/Crawl4AI behavior.

## Admission behavior

### Normal

```text
Crawl4AI request
      ↓
normal bounded semaphore
      ↓
1 active by default
up to 8 queued by default
```

Existing Phase-2 concurrency limits still apply.

### Degraded

```text
Crawl4AI request
      ↓
host pressure = degraded
      ↓
is local browser slot immediately free?
   ├─ yes → start one request
   └─ no  → shed request, do not queue it
```

The semaphore's `runIfAvailable()` method also refuses to jump ahead of existing queued work.

This is important during a Cloudflare outage: degraded memory must not allow a backlog of future Chromium jobs to accumulate while one active browser is still working.

### Critical

```text
Crawl4AI request
      ↓
host pressure = critical
      ↓
LocalLoadShedError
      ↓
no Crawl4AI provider call
no provider-circuit failure
no domain failure learning
fetch cascade continues
```

Existing active Crawl4AI work is not killed by this phase. The policy controls **new admission**. Force-killing an active browser job is a different operational decision and can leave partial state behind.

## Domain-neutral fetch failure classification

The tier wrapper now classifies caught errors before updating per-domain statistics.

These are recorded as `tier_skipped` and are **not** written through `recordTierAttempt()`:

```text
QueueFullError
QueueTimeoutError
CircuitOpenError
LocalLoadShedError
Cloudflare Browser Run ProviderHttpError
```

Cloudflare Browser Run HTTP errors are responses from Cloudflare's account/API endpoint rather than direct status codes from the target website. They therefore describe provider/account/request health, not target-domain compatibility.

A Browser Run navigation/content failure that occurs after successful API admission can still be a normal tier/domain failure.

The centralized classifier lives in:

```text
src/fetch-failure-classification.ts
```

so future provider adapters can preserve the same failure-domain rule.

## Observability

Local admission skips use:

```text
fetch counter outcome=skipped
fetch latency histogram outcome=skipped
fetchTierSkipped event
```

and do not increment per-domain tier attempts.

`providerControlSnapshot()` includes the latest Crawl4AI host-pressure snapshot:

```text
enabled
state
totalBytes
availableBytes
availablePercent
availableMb
source
sampledAtMs
```

This is internal for now. A later health/telemetry surface can export it without reading `/proc` independently.

## Interaction with the circuit breaker

Order is intentional:

```text
singleflight
   ↓
host-pressure sample
   ├─ critical → shed
   ↓
Crawl4AI circuit pre-check
   ↓
normal: bounded queue
or
degraded: immediate-only admission
   ↓
circuit execute
   ↓
Crawl4AI
```

Host-pressure rejection happens before circuit execution and therefore cannot count as a Crawl4AI provider failure.

Likewise, a queue rejection occurs outside circuit execution.

## Interaction with fallback

The page-fetch cascade remains:

```text
Cloudflare Browser Run
        ↓
Crawl4AI
        ↓
Raw HTTP + Readability
        ↓
optional Wayback
```

If Cloudflare is unhealthy and host pressure is critical, Crawl4AI is skipped immediately and raw HTTP remains available. This is intentional graceful degradation.

## Disabled mode

Operators can set:

```text
CRAWL4AI_HOST_PRESSURE_ENABLED=false
```

The monitor still reports the sampled memory values, but admission reports `normal` and does not shed based on memory.

This is useful for containers where host-level memory numbers are not representative of the process's true cgroup budget. A future cgroup-aware extension can add a more precise source without changing the admission contract.

## Scope boundary

This phase does not yet implement:

- CPU/load-average shedding;
- swap-rate pressure;
- cgroup-v2 memory.current / memory.max awareness;
- Crawl4AI `/monitor` API integration;
- killing already-running browser jobs;
- per-user LibreChat admission;
- long-running Cloudflare `/crawl` priority queues;
- cross-replica distributed admission state.

Those can be added independently after production measurements show which signals actually improve decisions.

## Validation

Tests cover:

- Linux `MemAvailable` parsing;
- fallback-safe parsing failure behavior;
- normal/degraded/critical classification;
- absolute MiB critical floor;
- disabled enforcement;
- sample caching;
- invalid threshold ordering;
- immediate-only semaphore admission;
- domain-neutral classification for queue, circuit, host-pressure and Cloudflare account/API failures;
- ordinary page exceptions remaining domain failures.
