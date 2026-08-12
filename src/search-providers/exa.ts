import { ProviderHttpError, parseRetryAfterMs } from "../provider-errors.js";
import type { SearxResult } from "../types.js";
import { runHostedSearchProvider } from "./control.js";
import type { HostedSearchProvider, HostedSearchRequest } from "./types.js";
import { clampResults, siteList, timeRangeStartIso } from "./utils.js";

interface ExaResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  text?: string;
  highlights?: string[];
  summary?: string;
}

interface ExaResponse {
  results?: ExaResult[];
}

function apiKey(): string | undefined {
  return process.env.EXA_API_KEY?.trim() || undefined;
}

function searchType(): string {
  const value = process.env.EXA_SEARCH_TYPE?.trim();
  return value || "auto";
}

export const exaSearchProvider: HostedSearchProvider = {
  id: "exa",
  capabilities: {
    semantic: true,
    recency: true,
    domains: true,
    news: true,
  },
  configured: () => Boolean(apiKey()),
  async search(request: HostedSearchRequest): Promise<SearxResult[]> {
    const key = apiKey();
    if (!key) return [];

    const controlKey = JSON.stringify(request);
    return runHostedSearchProvider("exa", controlKey, async () => {
      const includeDomains = siteList(request.site);
      const startPublishedDate = timeRangeStartIso(request.timeRange);
      const body: Record<string, unknown> = {
        query: request.query,
        numResults: clampResults(request.numResults, 20),
        type: searchType(),
        contents: { highlights: true },
      };
      if (includeDomains.length > 0) body.includeDomains = includeDomains;
      if (startPublishedDate) body.startPublishedDate = startPublishedDate;
      if (request.category === "news") body.category = "news";

      const res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        throw new ProviderHttpError(
          "exa",
          res.status,
          `Exa search error: ${res.status} ${res.statusText}`,
          parseRetryAfterMs(res.headers.get("Retry-After")),
        );
      }

      const data = (await res.json()) as ExaResponse;
      return (data.results ?? [])
        .filter((result) => Boolean(result.url))
        .slice(0, request.numResults)
        .map((result) => ({
          title: result.title || result.url || "Untitled",
          url: result.url as string,
          content:
            result.highlights?.filter(Boolean).join("\n") ||
            result.summary ||
            result.text,
          engine: "exa",
          engines: ["exa"],
          publishedDate: result.publishedDate,
        }));
    });
  },
};
