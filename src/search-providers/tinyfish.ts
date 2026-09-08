import { ProviderHttpError, parseRetryAfterMs } from "../provider-errors.js";
import type { SearxResult } from "../types.js";
import { runHostedSearchProvider } from "./control.js";
import type { HostedSearchProvider, HostedSearchRequest } from "./types.js";
import { siteList } from "./utils.js";

interface TinyFishResult {
  position?: number;
  site_name?: string;
  title?: string;
  snippet?: string;
  url?: string;
  date?: string;
  publisher?: string;
  authors?: string[];
  venue?: string;
  year?: number;
  cited_by_count?: number;
  pdf_url?: string;
}

interface TinyFishResponse {
  query?: string;
  results?: TinyFishResult[];
  total_results?: number;
  page?: number;
}

function apiKey(): string | undefined {
  return process.env.TINYFISH_API_KEY?.trim() || undefined;
}

function location(): string | undefined {
  const value = process.env.TINYFISH_SEARCH_LOCATION?.trim().toUpperCase();
  return value && /^[A-Z]{2}$/.test(value) ? value : undefined;
}

function searchLanguage(language?: string): string | undefined {
  if (!language || language === "all") return undefined;
  const primary = language.toLowerCase().split("-")[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

function recencyMinutes(timeRange?: string): number | undefined {
  switch (timeRange) {
    case "day":
      return 24 * 60;
    case "week":
      return 7 * 24 * 60;
    case "month":
      return 30 * 24 * 60;
    case "year":
      return 365 * 24 * 60;
    default:
      return undefined;
  }
}

export const tinyfishSearchProvider: HostedSearchProvider = {
  id: "tinyfish",
  capabilities: {
    semantic: false,
    recency: true,
    domains: true,
    news: true,
  },
  configured: () => Boolean(apiKey()),
  async search(request: HostedSearchRequest): Promise<SearxResult[]> {
    const key = apiKey();
    if (!key) return [];

    const controlKey = JSON.stringify(request);
    return runHostedSearchProvider("tinyfish", controlKey, async () => {
      const params = new URLSearchParams({
        query: request.query,
        page: "0",
        domain_type: request.category === "news" ? "news" : "web",
      });

      const includeDomains = siteList(request.site);
      if (includeDomains.length > 0) {
        params.set("include_domains", includeDomains.join(","));
      }

      const configuredLocation = location();
      if (configuredLocation) params.set("location", configuredLocation);

      const language = searchLanguage(request.language);
      if (language) params.set("language", language);

      const freshness = recencyMinutes(request.timeRange);
      if (freshness) params.set("recency_minutes", String(freshness));

      const res = await fetch(`https://api.search.tinyfish.ai?${params}`, {
        headers: {
          Accept: "application/json",
          "X-API-Key": key,
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        throw new ProviderHttpError(
          "tinyfish",
          res.status,
          `TinyFish search error: ${res.status} ${res.statusText}`,
          parseRetryAfterMs(res.headers.get("Retry-After")),
        );
      }

      const data = (await res.json()) as TinyFishResponse;
      return (data.results ?? [])
        .filter((result) => Boolean(result.url))
        .slice(0, request.numResults)
        .map((result) => ({
          title: result.title || result.url || "Untitled",
          url: result.url as string,
          content: result.snippet,
          engine: "tinyfish",
          engines: ["tinyfish"],
          publishedDate: result.date,
        }));
    });
  },
};
