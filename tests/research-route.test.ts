// Unit tests for the research-route provenance module — the pure functions that
// build the "Research route:" badge. These never touch the network or the cache.

import { describe, expect, it } from "vitest";
import {
  aggregateFetchRoutes,
  collectSearchEngines,
  fetchRouteForCacheHit,
  fetchRouteFromTier,
  formatFetchRoute,
  formatSearchRoute,
  researchRouteLine,
  searchRouteForCacheHit,
} from "../src/research-route.js";

describe("fetchRouteFromTier", () => {
  it("maps the tier-1 primary to Cloudflare without a fallback flag", () => {
    expect(fetchRouteFromTier("tier1_cloudflare")).toEqual({
      provider: "cloudflare",
    });
  });

  it("marks a cascade tier reached after a miss as a fallback", () => {
    expect(fetchRouteFromTier("tier2_crawl4ai", true)).toEqual({
      provider: "crawl4ai",
      fallback: true,
    });
    expect(fetchRouteFromTier("tier3_rawfetch", true)).toEqual({
      provider: "raw",
      fallback: true,
    });
    expect(fetchRouteFromTier("tier4_wayback", true)).toEqual({
      provider: "wayback",
      fallback: true,
    });
  });

  it("keeps fast paths and the direct PDF route non-fallback", () => {
    expect(fetchRouteFromTier("github")).toEqual({ provider: "github" });
    expect(fetchRouteFromTier("tier2_crawl4ai")).toEqual({
      provider: "crawl4ai",
    });
    expect(fetchRouteFromTier("kiwix")).toEqual({ provider: "kiwix" });
    expect(fetchRouteFromTier("llms_full_txt")).toEqual({
      provider: "llms_full_txt",
    });
  });

  it("returns null for an unknown tier so it can never masquerade", () => {
    expect(fetchRouteFromTier("tier9_mystery")).toBeNull();
    expect(fetchRouteFromTier("anything")).toBeNull();
  });
});

describe("collectSearchEngines", () => {
  it("collects engines across results, preserving first-seen order", () => {
    const results = [
      { title: "a", url: "https://a.com", engines: ["google", "DuckDuckGo"] },
      { title: "b", url: "https://b.com", engine: "bing" },
    ];
    expect(collectSearchEngines(results)).toEqual([
      "google",
      "DuckDuckGo",
      "bing",
    ]);
  });

  it("caps the list at 4 and dedupes", () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      title: `r${i}`,
      url: `https://r${i}.com`,
      engines: [`engine${i}`, "duplicate"],
    }));
    const engines = collectSearchEngines(results);
    expect(engines.length).toBeLessThanOrEqual(4);
    expect(new Set(engines).size).toBe(engines.length);
  });

  it("returns [] when results carry no engine metadata", () => {
    expect(
      collectSearchEngines([{ title: "a", url: "https://a.com" }]),
    ).toEqual([]);
  });
});

describe("formatSearchRoute", () => {
  it("renders engine provenance for SearXNG", () => {
    expect(
      formatSearchRoute({
        provider: "searxng",
        engines: ["DuckDuckGo", "Google"],
      }),
    ).toBe("SearXNG (DuckDuckGo, Google)");
  });

  it("omits the engine list for hosted providers", () => {
    expect(formatSearchRoute({ provider: "exa" })).toBe("Exa");
    expect(formatSearchRoute({ provider: "tinyfish" })).toBe("TinyFish");
  });

  it("marks a hosted fallback", () => {
    expect(formatSearchRoute({ provider: "brave", fallback: true })).toBe(
      "Brave (fallback)",
    );
  });

  it("renders cache provenance when the stored provider is known", () => {
    expect(
      formatSearchRoute({
        provider: "searxng",
        engines: ["Google"],
        cacheHit: true,
      }),
    ).toBe("Cache · originally SearXNG (Google)");
  });

  it("renders bare Cache for a legacy entry without provenance", () => {
    expect(formatSearchRoute({ provider: "cache", cacheHit: true })).toBe(
      "Cache",
    );
  });
});

describe("formatFetchRoute", () => {
  it("renders the provider label", () => {
    expect(formatFetchRoute({ provider: "cloudflare" })).toBe("Cloudflare");
    expect(formatFetchRoute({ provider: "raw", fallback: true })).toBe(
      "Raw HTTP (fallback)",
    );
  });

  it("renders cache provenance for a known provider", () => {
    expect(formatFetchRoute({ provider: "cloudflare", cacheHit: true })).toBe(
      "Cache · originally Cloudflare",
    );
  });

  it("surfaces an also-list for multi-provider fetches", () => {
    expect(
      formatFetchRoute({ provider: "cloudflare", also: ["raw", "crawl4ai"] }),
    ).toBe("Cloudflare, Raw HTTP, Crawl4AI");
  });
});

describe("researchRouteLine — the concise user badge", () => {
  it("renders the search-only case", () => {
    expect(
      researchRouteLine({
        search: { provider: "searxng", engines: ["DuckDuckGo"] },
      }),
    ).toBe("Research route: SearXNG (DuckDuckGo)");
  });

  it("chains search → fetch with an arrow", () => {
    expect(
      researchRouteLine({
        search: { provider: "searxng", engines: ["DuckDuckGo"] },
        fetch: { provider: "cloudflare" },
      }),
    ).toBe("Research route: SearXNG (DuckDuckGo) → Cloudflare");
  });

  it("renders a lone fetch route for a direct fetch_url", () => {
    expect(researchRouteLine({ fetch: { provider: "cloudflare" } })).toBe(
      "Research route: Cloudflare",
    );
  });

  it("returns null when nothing served so callers can skip the line", () => {
    expect(researchRouteLine({})).toBeNull();
  });
});

describe("aggregateFetchRoutes", () => {
  it("returns null when no page produced a route", () => {
    expect(aggregateFetchRoutes([null, undefined])).toBeNull();
  });

  it("collapses a single route unchanged", () => {
    expect(aggregateFetchRoutes([{ provider: "cloudflare" }])).toEqual({
      provider: "cloudflare",
    });
  });

  it("merges the same provider, propagating fallback and cacheHit", () => {
    expect(
      aggregateFetchRoutes([
        { provider: "cloudflare" },
        { provider: "cloudflare", fallback: true },
        { provider: "cloudflare", cacheHit: true },
      ]),
    ).toEqual({ provider: "cloudflare", fallback: true, cacheHit: true });
  });

  it("surfaces distinct providers via also, cacheHit only when all were cached", () => {
    expect(
      aggregateFetchRoutes([
        { provider: "cloudflare" },
        { provider: "raw", fallback: true },
      ]),
    ).toEqual({ provider: "cloudflare", also: ["raw"], cacheHit: false });
  });
});

describe("cache-hit provenance stampers", () => {
  it("keeps known search provenance and stamps cacheHit", () => {
    expect(
      searchRouteForCacheHit({
        route: { provider: "searxng", engines: ["Google"] },
      }),
    ).toEqual({ provider: "searxng", engines: ["Google"], cacheHit: true });
  });

  it("reports provider 'cache' for a legacy search entry without provenance", () => {
    expect(searchRouteForCacheHit({})).toEqual({
      provider: "cache",
      cacheHit: true,
    });
  });

  it("keeps known fetch provenance and stamps cacheHit", () => {
    expect(
      fetchRouteForCacheHit({ route: { provider: "cloudflare" } }),
    ).toEqual({
      provider: "cloudflare",
      cacheHit: true,
    });
  });

  it("reports provider 'cache' for a legacy fetch entry without provenance", () => {
    expect(fetchRouteForCacheHit({})).toEqual({
      provider: "cache",
      cacheHit: true,
    });
  });

  it("does not trust an unrecognised provider stored in the cache", () => {
    expect(
      searchRouteForCacheHit({
        route: { provider: "tier1_cloudflare" as never },
      }),
    ).toEqual({ provider: "cache", cacheHit: true });
  });
});

describe("rendered lines are static labels only", () => {
  it("never includes URLs, tokens, keys, or internal identifiers", () => {
    const line = researchRouteLine({
      search: { provider: "searxng", engines: ["DuckDuckGo"] },
      fetch: { provider: "cloudflare", cacheHit: true },
    });
    expect(line).toBe(
      "Research route: SearXNG (DuckDuckGo) → Cache · originally Cloudflare",
    );
    // The badge is a fixed vocabulary of provider labels + engine names + cache
    // markers. Anything that hints at internal detail must never leak.
    for (const forbidden of [
      "http://",
      "https://",
      "Bearer",
      "sk-",
      "key=",
      "/api/",
      "tier",
      "queue",
    ]) {
      expect(line ?? "").not.toContain(forbidden);
    }
  });
});
