# Hosted Search Provider Fallback

UltraSearch is self-host-first. SearXNG remains the default discovery layer, but a self-hosted metasearch instance can still be unavailable, rate-limited by its upstream engines, or return no useful web results.

This phase adds a generic hosted-search provider registry as a controlled fallback rather than making any hosted API the primary search path.

## Default request path

```text
search request
    ↓
cache
    ↓ miss
SearXNG original query
    │
    ├── useful web results → return
    │
    ├── direct answer / infobox → return
    │
    └── technical failure or genuinely sparse result
              ↓
      hosted provider registry
              ↓
      first configured provider
              │
              ├── non-empty → stop and return
              └── empty/error → next provider
```

Providers are attempted **sequentially**. UltraSearch does not fan the same normal fallback request out to every configured hosted provider.

This is intentional for:

- quota protection;
- lower cost;
- lower tail latency;
- simpler provenance;
- easier provider-health reasoning.

Multi-provider aggregation / reciprocal-rank fusion remains a future explicit deep-search mode rather than the default failure path.

## Included providers

The registry contains:

```text
Exa
Parallel
TinyFish
Brave Search
```

Each provider implements the same `HostedSearchProvider` interface and returns the existing normalized `SearxResult` shape so downstream reranking, domain filtering, caching and fetch tooling do not need provider-specific branches.

The interface also records capabilities such as semantic search, recency, domain filtering and news support so future routing can become capability-aware without changing the adapter contract.

## Provider order

Default:

```text
exa,parallel,tinyfish,brave
```

Override with:

```text
HOSTED_SEARCH_PROVIDER_ORDER=tinyfish,parallel,brave,exa
```

Unknown names and duplicates are ignored. Unconfigured providers are skipped without an API call.

The first provider that returns a non-empty result set wins.

## Global enable / disable

Fallback automatically becomes available when at least one provider in the configured order has credentials.

It can be disabled explicitly:

```text
HOSTED_SEARCH_FALLBACK_ENABLED=false
```

No API credential is required when hosted fallback is disabled or no hosted providers are configured.

## Primary-result quality gate

Default:

```text
HOSTED_SEARCH_FALLBACK_MIN_RESULTS=1
```

With the default value, a successful SearXNG query only activates hosted fallback when its ordinary web result list is empty.

An operator may increase the threshold later if production measurements show that very sparse SearXNG result sets are often low quality.

SearXNG direct answers and infoboxes are treated as useful primary results even when its ordinary result list is empty. This prevents spending hosted quota when SearXNG already answered the question directly.

## Explicit SearXNG engine constraints

A caller may explicitly request:

```text
engines=google
```

Hosted providers cannot honestly preserve that instruction. UltraSearch therefore suppresses hosted fallback for explicitly engine-constrained searches by default.

An operator can choose best-effort behavior with:

```text
HOSTED_SEARCH_FALLBACK_WITH_ENGINE_FILTER=true
```

This is off by default because fallback should not silently weaken a caller's explicit source constraint.

## Query expansion and quota safety

When query expansion is enabled, only the **original query** can activate hosted fallback.

```text
original query → SearXNG → hosted fallback if needed
variant 1      → SearXNG only
variant 2      → SearXNG only
...
```

Expanded variants continue through the bounded SearXNG concurrency layer and use `Promise.allSettled`, but they never multiply one user request into several hosted-search calls.

## Cache behavior

A successful hosted fallback result is cached under the same normalized search cache key as the original query.

This means a temporary SearXNG outage does not cause repeated identical office queries to repeatedly consume hosted API quota.

The normalized result retains the provider name in `engine` / `engines`, for example:

```text
engine=exa
engine=parallel
engine=tinyfish
engine=brave
```

so downstream output still has provider provenance.

## Exa adapter

Credential:

```text
EXA_API_KEY
```

Optional search mode:

```text
EXA_SEARCH_TYPE=auto
```

Default is `auto`.

UltraSearch calls the Exa Search API and maps:

- query;
- requested result count;
- site filters to Exa include domains;
- UltraSearch time-range presets to a publication start date;
- `category=news` to Exa's news category;
- Exa highlights into the normalized search snippet/content.

Exa remains an optional provider. UltraSearch does not require an Exa account to run.

## Parallel adapter

Credential:

```text
PARALLEL_API_KEY
```

Optional mode:

```text
PARALLEL_SEARCH_MODE=basic
```

Accepted UltraSearch values for the current `/v1/search` API:

```text
basic
advanced
```

Parallel's current v1 documentation describes `advanced` as the API default and `basic` as the lower-latency mode. UltraSearch intentionally sends `basic` by default because Parallel is being used as a fallback inside an interactive search loop; operators can explicitly choose `advanced` when higher retrieval quality is worth additional latency.

Older Parallel migration documentation for `/v1beta/search` may mention different mode names. UltraSearch targets the current `/v1/search` endpoint and follows its current Search Modes contract.

UltraSearch sends the original query through `search_queries` and a self-contained objective. For constraints that Parallel v1 supports structurally, the adapter uses `advanced_settings` rather than merely hinting in prose:

- site restrictions map to `advanced_settings.source_policy.include_domains`;
- UltraSearch time-range presets map to `advanced_settings.source_policy.after_date`;
- requested result count maps to `advanced_settings.max_results`, capped at 20.

News intent is retained in the objective because it is a relevance preference rather than a strict domain/date constraint.

Parallel excerpts are normalized into the search result content field.

## TinyFish adapter

Credential:

```text
TINYFISH_API_KEY
```

Optional geo default:

```text
TINYFISH_SEARCH_LOCATION=US
```

UltraSearch calls TinyFish Search with `GET https://api.search.tinyfish.ai` and maps:

- query;
- site filters to TinyFish `include_domains`;
- `day/week/month/year` to `recency_minutes`;
- BCP-47-style language input to its primary language component when valid;
- `category=news` to `domain_type=news`;
- TinyFish snippets and publication dates into the normalized search result content/provenance fields.

TinyFish does not need a provider-specific branch in the search path. It is a normal hosted-search provider and runs through the same sequential fallback registry, budget reservation, bounded queue and circuit breaker as the other hosted providers.

## Brave Search adapter

Credential:

```text
BRAVE_SEARCH_API_KEY
```

UltraSearch uses Brave Web Search and maps:

- query;
- result count;
- site restrictions using search operators;
- `day/week/month/year` to Brave freshness presets;
- BCP-47-style language input to its primary language component when valid;
- Brave description and extra snippets into normalized result content.

Brave is useful as a provider whose conventional web index/search behavior differs from semantic-first APIs.

## Provider controls

Every hosted provider gets its own independent:

```text
singleflight namespace
bounded semaphore
bounded queue
circuit breaker
Retry-After handling through ProviderHttpError
```

Defaults per provider:

```text
<PROVIDER>_SEARCH_MAX_IN_FLIGHT=2
<PROVIDER>_SEARCH_MAX_QUEUE=8
<PROVIDER>_SEARCH_QUEUE_TIMEOUT_MS=5000

<PROVIDER>_SEARCH_CIRCUIT_FAILURE_THRESHOLD=3
<PROVIDER>_SEARCH_CIRCUIT_COOLDOWN_MS=30000
<PROVIDER>_SEARCH_CIRCUIT_MAX_COOLDOWN_MS=300000
```

Provider prefixes are:

```text
EXA
PARALLEL
TINYFISH
BRAVE
```

A failure/open circuit for one hosted provider does not prevent the fallback router from trying the next configured provider.

## Budget health is deliberately separate

Budget health is modeled separately from provider circuit health with states such as:

```text
healthy
near_limit
exhausted
unknown
```

A provider can be technically healthy while its configured monthly budget is nearly exhausted. Treating a billing/quota state as an ordinary technical failure would mix two different routing signals. The fallback router keeps the operator's configured order inside each budget-health class, while near-limit, exhausted or unverifiable budgets can be delayed or blocked according to the budget policy.

## Official provider MCPs are a separate failure domain

UltraSearch's built-in provider adapters protect against **search-backend failure inside UltraSearch**.

A separately configured official provider MCP in LibreChat protects against a different failure:

```text
UltraSearch MCP unavailable entirely
    ↓
LibreChat can still expose a separate official search MCP
```

For the SolResearchLabs deployment, Exa is planned as the initial break-glass MCP. That external MCP is intentionally not nested behind UltraSearch's own MCP protocol. UltraSearch uses provider APIs directly for its internal fallback adapters.

This prevents unnecessary MCP-inside-MCP complexity and keeps the emergency tool independent from UltraSearch's process.

## Adding another provider

A future provider should require only:

1. add its identifier to `HostedSearchProviderId`;
2. implement `HostedSearchProvider`;
3. normalize results into `SearxResult[]`;
4. use `ProviderHttpError` for provider HTTP failures;
5. run through `runHostedSearchProvider()`;
6. register it in `src/search-providers/index.ts`;
7. add adapter contract tests.

The search path itself should not acquire provider-specific branches.

Potential future adapters include:

```text
Tavily
Serper
Jina Search
other search APIs
```

## Scope boundaries

Not included in this phase:

- automatic account-quota discovery;
- query-aware provider scoring;
- provider latency EWMA;
- multi-provider rank fusion;
- deep-search mode;
- per-user hosted-search quotas;
- official Exa MCP LibreChat deployment;
- provider keys in the public repository.

Those remain independent layers on top of this registry.
