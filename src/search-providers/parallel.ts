import { ProviderHttpError, parseRetryAfterMs } from "../provider-errors.js";
import type { SearxResult } from "../types.js";
import { runHostedSearchProvider } from "./control.js";
import type { HostedSearchProvider, HostedSearchRequest } from "./types.js";

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

function mode(): "turbo" | "basic" | "advanced" {
  const value = process.env.PARALLEL_SEARCH_MODE?.trim();
  if (value === "turbo" || value === "advanced") return value;
  return "basic";
}

export const parallelSearchProvider: HostedSearchProvider = {
  id: "parallel",
  capabilities: {
    semantic: true,
    recency: false,
    domains: false,
    news: true,
  },
  configured: () => Boolean(apiKey()),
  async search(request: HostedSearchRequest): Promise<SearxResult[]> {
    const key = apiKey();
    if (!key) return [];

    const controlKey = JSON.stringify(request);
    return runHostedSearchProvider("parallel", controlKey, async () => {
      const objectiveParts = [request.query];
      if (request.category === "news")
        objectiveParts.push("Prefer current news and recent primary sources.");
      if (request.timeRange)
        objectiveParts.push(
          `Prefer sources from the last ${request.timeRange}.`,
        );
      if (request.site) {
        const sites = (
          Array.isArray(request.site) ? request.site : [request.site]
        )
          .map((value) => value.trim())
          .filter(Boolean);
        if (sites.length > 0)
          objectiveParts.push(`Prefer sources from: ${sites.join(", ")}.`);
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
