# Hosted Search Provider Budget Health

UltraSearch keeps **budget health** separate from **technical provider health**.

A provider can be technically healthy while an operator has nearly exhausted the amount of usage they are willing to spend that month. Likewise, an exhausted local budget is not evidence that the provider is failing and must not open a provider circuit.

This phase adds durable, operator-defined monthly budget units for hosted search providers.

## Design principles

1. SearXNG remains the primary search path, so hosted budgets are consumed only on fallback.
2. Budget state is independent from circuit-breaker state.
3. Public OSS does not hardcode vendor prices, free-credit programs or account-specific tricks.
4. Operators define their own accounting units and monthly caps.
5. Monthly counters live in Valkey so MCP restarts do not reset usage.
6. Near-limit providers are deprioritized rather than treated as broken.
7. Exhausted providers are skipped without an API call.
8. If an explicitly configured hard budget cannot be verified, UltraSearch fails closed by default.

## Budget units

A budget unit is an **operator-defined local accounting unit**.

It is deliberately not defined as:

- dollars;
- provider credits;
- API requests globally;
- a hardcoded vendor billing formula.

Default usage is one unit per hosted search attempt:

```text
<PROVIDER>_SEARCH_BUDGET_UNITS_PER_REQUEST=1
```

An operator can map that scale to whatever makes sense for the configured provider and search mode.

Example:

```text
EXA_SEARCH_BUDGET_MONTHLY_UNITS=1000
EXA_SEARCH_BUDGET_UNITS_PER_REQUEST=1
```

or, if the operator wants a weighted local model:

```text
EXA_SEARCH_BUDGET_MONTHLY_UNITS=100
EXA_SEARCH_BUDGET_UNITS_PER_REQUEST=2.5
```

UltraSearch does not claim that those units correspond to current Exa dollars or credits. Provider pricing can change independently from this routing guardrail.

## Configuration

Provider prefixes are:

```text
EXA
PARALLEL
BRAVE
```

For each provider:

```text
<PROVIDER>_SEARCH_BUDGET_MONTHLY_UNITS
<PROVIDER>_SEARCH_BUDGET_UNITS_PER_REQUEST=1
<PROVIDER>_SEARCH_BUDGET_WARN_PERCENT=80
```

If `MONTHLY_UNITS` is unset, budget control for that provider is disabled and the provider behaves as it did before this phase.

Global storage-failure policy:

```text
HOSTED_SEARCH_BUDGET_FAIL_OPEN=false
```

Default is fail-closed **only when a provider has an explicit monthly cap configured**.

With:

```text
HOSTED_SEARCH_BUDGET_FAIL_OPEN=true
```

an unverifiable budget is allowed to proceed, but its budget state remains `unknown` and is ranked behind healthy or near-limit providers.

## Calendar-month keys

Counters use UTC calendar months:

```text
budget:hosted-search:exa:2026-08
budget:hosted-search:parallel:2026-08
budget:hosted-search:brave:2026-08
```

The active routing key naturally moves to the new `YYYY-MM` namespace on the first day of the next UTC month.

Completed counters remain briefly after reset for diagnostics and then expire automatically.

This avoids background reset jobs and makes monthly rollover deterministic.

## Atomic reservation

Budget reservation uses a Valkey Lua script.

Conceptually:

```text
read current units
       ↓
would current + request units exceed hard cap?
       ├─ yes → deny without increment
       └─ no  → atomically increment + keep expiry
```

This prevents concurrent fallback calls from independently reading the same remaining budget and collectively overshooting the configured hard cap.

Budget units are reserved conservatively for an admitted hosted-search attempt before the provider HTTP call begins. This is intentional. UltraSearch's local budget is a guardrail, not a reconstruction of each vendor's final invoice semantics.

## Budget states

```text
disabled
healthy
near_limit
exhausted
unknown
```

### disabled

No monthly cap configured.

```text
allowed=true
routing rank=best
```

### healthy

Usage is below the configured warning threshold.

```text
allowed=true
routing rank=best
```

### near_limit

Usage is at or above:

```text
<PROVIDER>_SEARCH_BUDGET_WARN_PERCENT
```

but still below the hard monthly cap.

```text
allowed=true
routing rank=deprioritized
```

### exhausted

Used units have reached the hard cap, or the next atomic reservation would exceed it.

```text
allowed=false
no provider API call
```

### unknown

A hard budget is configured but Valkey could not verify/reserve it.

Default:

```text
allowed=false
```

With explicit global fail-open:

```text
allowed=true
routing rank behind known near-limit providers
```

## Budget-aware provider order

The operator still chooses the base preference:

```text
HOSTED_SEARCH_PROVIDER_ORDER=exa,parallel,brave
```

Budget health then adjusts that order while preserving configured order inside each health class.

Example:

```text
configured order
Exa      near_limit
Parallel healthy
Brave    healthy

actual fallback order
Parallel
Brave
Exa
```

If Parallel returns a useful result, Exa receives no call and preserves its remaining budget.

An exhausted provider stays out of execution entirely.

## Interaction with provider circuits

Budget enforcement is placed outside `CircuitBreaker.execute()`.

```text
provider circuit pre-check
       ↓
bounded provider slot
       ↓
second circuit pre-check
       ↓
atomic budget reservation
       ├─ denied → HostedSearchBudgetError
       │           circuit unchanged
       │
       └─ allowed
             ↓
       circuit execute
             ↓
       provider HTTP request
```

Therefore:

```text
budget exhausted ≠ provider failure
budget storage unavailable ≠ provider failure
```

The provider registry catches `HostedSearchBudgetError` and continues to the next hosted provider.

## Interaction with sequential fallback

The normal hosted-search path remains sequential:

```text
SearXNG
   ↓ fallback needed
budget-aware hosted order
   ↓
provider A
   ├─ useful → stop
   └─ empty/error/budget-blocked → provider B
```

Budget control does not introduce multi-provider fanout.

## Persistence failure

If Valkey is unavailable while no monthly budget is configured, hosted search behavior is unaffected.

If a monthly budget **is** configured, UltraSearch refuses to pretend that zero usage has occurred. It reports budget state `unknown`.

Fail-closed is the public default because an explicit hard budget is an operator safety policy. Operators who prefer search availability over strict local spend enforcement can opt into fail-open deliberately.

## Public OSS vs private deployment

Public UltraSearch supports:

- generic budget units;
- generic hard monthly caps;
- warning thresholds;
- fail-open/fail-closed policy;
- budget-aware provider ordering;
- BYO provider keys.

The public project does **not** contain:

- SolResearchLabs provider credentials;
- provider-account balances;
- free-tier rotation strategies;
- account-specific credit exploitation;
- office-specific usage thresholds.

Those belong in private deployment configuration.

## Official Exa MCP boundary

The internal Exa adapter participates in UltraSearch's own budget policy.

A separately configured official Exa MCP in LibreChat remains an independent break-glass tool for UltraSearch-process failure. Its access and quotas are intentionally not hidden behind UltraSearch's internal provider accounting.

If the private deployment wants the break-glass MCP to have its own human/admin usage policy, that should be configured at the LibreChat/deployment layer rather than sharing the internal fallback budget counter accidentally.

## Observability API

`hostedSearchBudgetSnapshot()` returns the current budget health of Exa, Parallel and Brave without consuming units.

Each provider snapshot includes:

```text
state
allowed
usedUnits
limitUnits
remainingUnits
warnPercent
period
resetAt
failOpen
```

This is not exposed as a public MCP tool yet. The later operational-health surface can combine:

- provider circuits;
- provider queues;
- host pressure;
- hosted budget health.

## Scope boundaries

Not included in this phase:

- automatic vendor billing API reconciliation;
- hardcoded live vendor prices;
- per-user monthly budgets;
- per-workspace budgets;
- automatic free-credit discovery;
- multi-account rotation;
- monetary forecasting;
- query-aware cost/quality scoring;
- LibreChat user identity propagation.

Those can be layered on without changing the provider adapter contract.

## Test coverage

Focused tests verify:

- disabled budgets avoid Valkey entirely;
- healthy / near-limit / exhausted classification;
- fail-closed unknown state;
- explicit fail-open unknown state;
- atomic monthly reservation;
- hard-cap denial without increment;
- weighted units per request;
- budget-health routing rank;
- near-limit provider deprioritization;
- exhausted provider never executes;
- unknown fail-closed provider never executes;
- budget rejection does not increment provider circuit failure state.
