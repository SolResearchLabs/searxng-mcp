# Cloudflare Browser Run Tier

UltraSearch replaces the page-fetch cascade's former Firecrawl Tier 1 with Cloudflare Browser Run Quick Actions.

This phase changes **single-page retrieval only**. The existing `crawl_site` implementation still uses Firecrawl first, followed by sitemap parsing and optional BFS. Cloudflare `/crawl` is a separate follow-up phase.

## Fetch cascade

```text
GitHub / Kiwix / Hister fast paths when applicable
                 ↓
Cloudflare Browser Run /snapshot   Tier 1
                 ↓
Crawl4AI                            Tier 2
                 ↓
Raw HTTP + Readability              Tier 3
                 ↓
Wayback Machine                     Tier 4 optional
```

The existing pre-resolution SSRF guard remains in front of remote browser tiers. Caller-controlled public URLs are checked before they are handed to Cloudflare or Crawl4AI.

## Why `/snapshot`

The Browser Run `/snapshot` Quick Action can return multiple representations from one browser navigation. UltraSearch requests:

```json
{
  "formats": ["content", "markdown"]
}
```

This gives the existing fetch pipeline both:

- rendered HTML for post-extraction/title/metadata logic;
- rendered Markdown for the primary returned text.

That maps directly onto the upstream `TierResult` contract without introducing a second browser request.

## Configuration

Set:

```text
CLOUDFLARE_ACCOUNT_ID=<account id>
CLOUDFLARE_BROWSER_API_TOKEN=<token>
```

`CLOUDFLARE_API_TOKEN` is accepted as a fallback token variable, but the Browser Run-specific name is preferred so deployments can keep provider credentials scoped explicitly.

Optional:

```text
CLOUDFLARE_BROWSER_TIMEOUT_MS=30000
```

The default is 30 seconds. Values above 60 seconds are capped at 60 seconds locally.

The API token must be scoped to the intended Cloudflare account and have the Browser Rendering / Browser Run edit permission required by the REST Quick Actions API.

Do not commit the token to this repository. Production credentials belong in the private deployment/control-plane configuration.

## Request mapping

The adapter sends:

```text
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/browser-rendering/snapshot
Authorization: Bearer <token>
Content-Type: application/json
```

Base body:

```json
{
  "url": "https://example.com/",
  "formats": ["content", "markdown"],
  "userAgent": "searxng-mcp/<version>"
}
```

### `wait_for_selector`

The existing MCP `wait_for_selector` option maps to Browser Run's native `waitForSelector` option.

### `target_selector`

Browser Run snapshot does not expose the upstream fetch contract's exact "return only this CSS subtree" option. To preserve the existing behavior, the adapter injects a bounded inline script with `addScriptTag` after navigation. The selector is JSON-encoded as data, not interpolated as JavaScript source. The script clones the selected subtree into the document body before snapshot extraction.

If the selector matches nothing, the body is cleared so Tier 1 returns an empty result and the existing cascade can continue to Crawl4AI.

## Browser usage telemetry

Quick Actions return `X-Browser-Ms-Used` when browser-time information is available. UltraSearch records this as:

```text
searxng_browser_duration_seconds
```

with attributes:

```text
provider=cloudflare
action=snapshot
```

Missing or invalid usage headers are ignored rather than recorded as zero.

## Domain learning migration

The domain database keeps stable tier slots (`tier1`, `tier2`, and so on), but provider identity is tracked separately for Tier 1.

Existing schema-4 records may contain Firecrawl performance in `tier_stats_30d.tier1`. UltraSearch therefore follows two rules:

1. A record without `tier1_provider: "cloudflare"` cannot use its Tier-1 success rate to skip Cloudflare.
2. On the first actual `tier1_cloudflare` attempt, only the Tier-1 stat window is reset and marked as Cloudflare.

Crawl4AI, raw, Wayback, GitHub and capability history remain intact. This avoids a global domain-db schema bump for a provider-local migration.

## Failure behavior

Cloudflare errors do not terminate a normal page fetch. The existing tier wrapper records the failure and continues through the cascade.

Examples include:

- missing configuration;
- request timeout;
- Cloudflare API non-2xx response;
- invalid JSON;
- successful API envelope with no snapshot result;
- empty Markdown result.

The adapter reads the API response through the existing bounded-response helper before parsing JSON.

## Current phase boundary

Included now:

- `/snapshot` single-page retrieval;
- rendered HTML + Markdown;
- selector tuning;
- browser-time telemetry;
- provider-aware Tier-1 domain learning;
- unit and integration-contract tests.

Not included yet:

- Cloudflare `/crawl`;
- Cloudflare request token bucket / concurrency controller;
- circuit breakers;
- queue admission;
- hosted search-provider fallback pool;
- LibreChat deployment configuration.

Those remain later UltraSearch phases so the initial upstream delta stays reviewable and merge-friendly.

## Validation baseline

The feature branch was validated from the private `SolResearchLabs/UltraSearch` repository using its trusted self-hosted Ubuntu runner. The public fork is intentionally left without a self-hosted runner, and this lane does not depend on GitHub-hosted runner credits.

```text
TypeScript: pass
Biome: pass
Test files: 49 passed
Tests: 521 passed
Type errors: none
```

The private harness is manual-only, checks out only the explicitly pinned public feature branch and does not modify production containers or server configuration.

A live Cloudflare `/snapshot` request remains a deployment-time credential gate rather than a source-code validation dependency. It can be run later from the private control repository or another trusted environment with a narrowly scoped Browser Rendering token. No Cloudflare credential belongs in the public fork.
