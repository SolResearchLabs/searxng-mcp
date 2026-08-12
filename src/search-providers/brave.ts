import { ProviderHttpError, parseRetryAfterMs } from "../provider-errors.js";
import type { SearxResult } from "../types.js";
import { runHostedSearchProvider } from "./control.js";
import type { HostedSearchProvider, HostedSearchRequest } from "./types.js";
import { braveFreshness, clampResults, siteList } from "./utils.js";

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  extra_snippets?: string[];
  page_age?: string;
  age?: string;
}

interface BraveResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

function apiKey(): string | undefined {
  return process.env.BRAVE_SEARCH_API_KEY?.trim() || undefined;
}

function queryWithSites(query: string, site?: string | string[]): string {
  const sites = siteList(site);
  if (sites.length === 0) return query;
  if (sites.length === 1) return `site:${sites[0]} ${query}`;
  return `(${sites.map((value) => `site:${value}`).join(" OR ")}) ${query}`;
}

function searchLanguage(language?: string): string | undefined {
  if (!language || language === "all") return undefined;
  const primary = language.toLowerCase().split("-")[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

export const braveSearchProvider: HostedSearchProvider = {
  id: "brave",
  capabilities: {
    semantic: false,
    recency: true,
    domains: true,
    news: false,
  },
  configured: () => Boolean(apiKey()),
  async search(request: HostedSearchRequest): Promise<SearxResult[]> {
    const key = apiKey();
    if (!key) return [];

    const controlKey = JSON.stringify(request);
    return runHostedSearchProvider("brave", controlKey, async () => {
      const params = new URLSearchParams({
        q: queryWithSites(request.query, request.site),
        count: String(clampResults(request.numResults, 20)),
        result_filter: "web",
        text_decorations: "false",
        extra_snippets: "true",
      });
      const freshness = braveFreshness(request.timeRange);
      if (freshness) params.set("freshness", freshness);
      const language = searchLanguage(request.language);
      if (language) params.set("search_lang", language);

      const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?${params}`,
        {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": key,
          },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!res.ok) {
        throw new ProviderHttpError(
          "brave",
          res.status,
          `Brave search error: ${res.status} ${res.statusText}`,
          parseRetryAfterMs(res.headers.get("Retry-After")),
        );
      }

      const data = (await res.json()) as BraveResponse;
      return (data.web?.results ?? [])
        .filter((result) => Boolean(result.url))
        .slice(0, request.numResults)
        .map((result) => ({
          title: result.title || result.url || "Untitled",
          url: result.url as string,
          content: [result.description, ...(result.extra_snippets ?? [])]
            .filter(Boolean)
            .join("\n"),
          engine: "brave",
          engines: ["brave"],
          publishedDate: result.page_age || result.age,
        }));
    });
  },
};
