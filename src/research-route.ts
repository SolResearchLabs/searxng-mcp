// Research-route provenance — "which provider/tier actually served this
// request?". Built ONLY from explicit runtime state (the provider returned by
// the search/fallback path and the tier that produced the accepted TierResult),
// never inferred from log lines or from which providers were merely attempted.
// Surfaced to users as a concise "Research route:" line and in
// structuredContent for badge rendering.

import type {
  FetchProviderId,
  FetchRoute,
  ResearchRoute,
  SearchProviderId,
  SearchRoute,
  SearxResult,
} from "./types.js";

const PROVIDER_LABELS: Record<string, string> = {
  searxng: "SearXNG",
  exa: "Exa",
  parallel: "Parallel",
  brave: "Brave",
  cloudflare: "Cloudflare",
  crawl4ai: "Crawl4AI",
  raw: "Raw HTTP",
  wayback: "Wayback Machine",
  github: "GitHub API",
  llms_full_txt: "llms.txt",
  kiwix: "Kiwix",
  hister: "Hister",
  youtube: "YouTube transcripts",
  reddit: "Reddit API",
  cache: "Cache",
};

function routeBaseLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

const KNOWN_SEARCH_PROVIDERS: readonly SearchProviderId[] = [
  "searxng",
  "exa",
  "parallel",
  "brave",
  "cache",
];

const KNOWN_FETCH_PROVIDERS: readonly FetchProviderId[] = [
  "cloudflare",
  "crawl4ai",
  "raw",
  "wayback",
  "github",
  "llms_full_txt",
  "kiwix",
  "hister",
  "youtube",
  "reddit",
  "cache",
];

export function isKnownSearchProvider(p: unknown): p is SearchProviderId {
  return typeof p === "string" && KNOWN_SEARCH_PROVIDERS.some((k) => k === p);
}

export function isKnownFetchProvider(p: unknown): p is FetchProviderId {
  return typeof p === "string" && KNOWN_FETCH_PROVIDERS.some((k) => k === p);
}

// Every tier the fetch cascade can serve is listed explicitly. An unrecognised
// tier name maps to null so a future tier can never masquerade as a provider
// that did not serve it.
const TIER_TO_PROVIDER: Record<string, FetchProviderId | undefined> = {
  github: "github",
  llms_full_txt: "llms_full_txt",
  kiwix: "kiwix",
  hister: "hister",
  youtube: "youtube",
  reddit: "reddit",
  tier1_cloudflare: "cloudflare",
  tier2_crawl4ai: "crawl4ai",
  tier3_rawfetch: "raw",
  tier4_wayback: "wayback",
};

/**
 * Map the tier that produced the accepted TierResult to a fetch route. The
 * caller supplies `fallback` from explicit control-flow knowledge: a cascade
 * tier reached after a higher-priority miss (tier2/tier3/wayback) is a
 * fallback; fast paths, the tier-1 primary and the direct PDF route are not.
 */
export function fetchRouteFromTier(
  tier: string,
  fallback = false,
): FetchRoute | null {
  const provider = TIER_TO_PROVIDER[tier];
  if (!provider) return null;
  return fallback ? { provider, fallback } : { provider };
}

/**
 * Deduplicated, capped list of the SearXNG engine names that produced the
 * results, e.g. ["DuckDuckGo", "Google"]. Kept short on purpose — the user
 * badge shows engines at a glance, it never dumps the full engine set.
 */
export function collectSearchEngines(
  results: SearxResult[],
  limit = 4,
): string[] {
  const seen: string[] = [];
  for (const r of results) {
    const engines = r.engines ?? (r.engine ? [r.engine] : []);
    for (const e of engines) {
      if (seen.length >= limit) break;
      if (!seen.includes(e)) seen.push(e);
    }
    if (seen.length >= limit) break;
  }
  return seen;
}

function searchRouteBaseLabel(route: SearchRoute): string {
  let base = routeBaseLabel(route.provider);
  if (
    route.provider === "searxng" &&
    route.engines &&
    route.engines.length > 0
  ) {
    base = `${base} (${route.engines.join(", ")})`;
  }
  return base;
}

export function formatSearchRoute(route: SearchRoute): string {
  const base =
    route.cacheHit && route.provider !== "cache"
      ? `Cache · originally ${searchRouteBaseLabel(route)}`
      : searchRouteBaseLabel(route);
  return route.fallback ? `${base} (fallback)` : base;
}

export function formatFetchRoute(route: FetchRoute): string {
  const base =
    route.cacheHit && route.provider !== "cache"
      ? `Cache · originally ${routeBaseLabel(route.provider)}`
      : routeBaseLabel(route.provider);
  const suffix = route.fallback ? " (fallback)" : "";
  if (route.also && route.also.length > 0) {
    return `${base}${suffix}, ${route.also
      .map((p) => routeBaseLabel(p))
      .join(", ")}`;
  }
  return `${base}${suffix}`;
}

/**
 * Combine the routes of every page fetched by search_and_fetch/summarize into
 * one route for the badge. All cache hits / all the same provider collapse to
 * a single route; a mix surfaces the distinct provider set.
 */
export function aggregateFetchRoutes(
  routes: Array<FetchRoute | null | undefined>,
): FetchRoute | null {
  const distinct = new Map<FetchProviderId, FetchRoute>();
  for (const r of routes) {
    if (!r) continue;
    const existing = distinct.get(r.provider);
    if (!existing) {
      distinct.set(r.provider, { ...r });
    } else {
      if (!existing.fallback && r.fallback) existing.fallback = true;
      if (!existing.cacheHit && r.cacheHit) existing.cacheHit = true;
    }
  }
  const list = [...distinct.values()];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const primary = list[0];
  return {
    provider: primary.provider,
    fallback: primary.fallback,
    cacheHit: list.every((r) => r.cacheHit),
    also: list.slice(1).map((r) => r.provider),
  };
}

/**
 * The one-line user-facing badge, e.g. "Research route: SearXNG (DuckDuckGo) →
 * Cloudflare". Returns null when nothing served, so callers can skip the line.
 */
export function researchRouteLine(route: ResearchRoute): string | null {
  const parts: string[] = [];
  if (route.search) parts.push(formatSearchRoute(route.search));
  if (route.fetch) parts.push(formatFetchRoute(route.fetch));
  return parts.length > 0 ? `Research route: ${parts.join(" → ")}` : null;
}

/**
 * Provenance for a cache hit. If the cached entry retains the route from the
 * original fetch, stamp cacheHit on it ("Cache · originally Cloudflare"). A
 * legacy entry with no stored provenance honestly reports provider "cache" —
 * never an inferred provider.
 */
export function searchRouteForCacheHit(parsed: {
  route?: SearchRoute;
}): SearchRoute {
  if (parsed.route && isKnownSearchProvider(parsed.route.provider)) {
    return { ...parsed.route, cacheHit: true };
  }
  return { provider: "cache", cacheHit: true };
}

export function fetchRouteForCacheHit(parsed: {
  route?: FetchRoute;
}): FetchRoute {
  if (parsed.route && isKnownFetchProvider(parsed.route.provider)) {
    return { ...parsed.route, cacheHit: true };
  }
  return { provider: "cache", cacheHit: true };
}
