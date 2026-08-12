import { ProviderHttpError, parseRetryAfterMs } from "../provider-errors.js";
import type { SearxResult } from "../types.js";
import { runHostedSearchProvider } from "./control.js";
import type { HostedSearchProvider, HostedSearchRequest } from "./types.js";
import { clampResults, siteList, timeRangeStartIso } from "./utils.js";

interface ParallelResult {
  url?: string;
  title?: string;
  publish_date?: string;
  excerpts?: string[];
}

interface ParallelResponse {
  results?: ParallelResult[];
}

function apiKey(): string | undefined {
  return process.env.PARALLEL_API_KEY?.trim() || undefined;
}

function mode(): "basic" | "advanced" {
  const value = process.env.PARALLEL_SEARCH_MODE?.trim();
  if (value === "advanced") return value;
  // UltraSearch intentionally favors the lower-latency v1 mode for a fallback
  // provider. Operators can select the higher-quality default explicitly.
  return "basic";
}

export const parallelSearchProvider: HostedSearchProvider = {
  id: "parallel",
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
    return runHostedSearchProvider("parallel", controlKey, async () => {
      const objectiveParts = [request.query];
      if (request.category === "news") {
        objectiveParts.push("Prefer current news and recent primary sources.");
      }

      const includeDomains = siteList(request.site);
      const afterDate = timeRangeStartIso(request.timeRange)?.slice(0, 10);
      const sourcePolicy: Record<string, unknown> = {};
      if (includeDomains.length > 0) sourcePolicy.include_domains = includeDomains;
      if (afterDate) sourcePolicy.after_date = afterDate;

      const advancedSettings: Record<string, unknown> = {
        max_results: clampResults(request.numResults, 20),
      };
      if (Object.keys(sourcePolicy).length > 0) {
        advancedSettings.source_policy = sourcePolicy;
      }

      const res = await fetch("https://api.parallel.ai/v1/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
        },
        body: JSON.stringify({
          objective: objectiveParts.join(" "),
          search_queries: [request.query],
          mode: mode(),
          max_chars_total: Math.max(2000, request.numResults * 1200),
          advanced_settings: advancedSettings,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        throw new ProviderHttpError(
          "parallel",
          res.status,
          `Parallel search error: ${res.status} ${res.statusText}`,
          parseRetryAfterMs(res.headers.get("Retry-After")),
        );
      }

      const data = (await res.json()) as ParallelResponse;
      return (data.results ?? [])
        .filter((result) => Boolean(result.url))
        .slice(0, request.numResults)
        .map((result) => ({
          title: result.title || result.url || "Untitled",
          url: result.url as string,
          content: result.excerpts?.filter(Boolean).join("\n"),
          engine: "parallel",
          engines: ["parallel"],
          publishedDate: result.publish_date,
        }));
    });
  },
};
