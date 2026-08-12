import { beforeEach, describe, expect, it, vi } from "vitest";

const hosted = vi.hoisted(() => ({
  searchHostedFallback: vi.fn(),
}));

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  searchCacheKey: vi.fn().mockReturnValue("cache-key"),
}));

vi.mock("../src/ollama.js", () => ({
  expandQuery: vi.fn().mockResolvedValue(["variant 1", "variant 2"]),
}));

vi.mock("../src/domains.js", () => ({
  applyDomainFilters: vi.fn().mockImplementation((results) => results),
}));

vi.mock("../src/domain-db.js", () => ({
  normalizeHostname: () => "example.com",
  recordSearchAppearance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/observability.js", () => ({
  withSpan: vi.fn().mockImplementation((_name, _attributes, fn) => fn()),
}));

vi.mock("../src/provider-control.js", () => ({
  runSearxng: async <T>(_key: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock("../src/search-providers/index.js", () => ({
  hasUsefulPrimarySearch: (
    count: number,
    meta: { answers: unknown[]; infoboxes: unknown[] },
  ) => count >= 1 || meta.answers.length > 0 || meta.infoboxes.length > 0,
  searchHostedFallback: hosted.searchHostedFallback,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { cacheSet } from "../src/cache.js";
import { searxSearch } from "../src/search.js";

const result = (url: string, engine = "google") => ({
  title: "Result",
  url,
  content: "snippet",
  engine,
  engines: [engine],
});

function searxResponse(
  results: unknown[],
  extras: Record<string, unknown> = {},
) {
  return new Response(JSON.stringify({ results, ...extras }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.HOSTED_SEARCH_FALLBACK_WITH_ENGINE_FILTER;
  hosted.searchHostedFallback.mockResolvedValue(null);
});

describe("SearXNG hosted fallback policy", () => {
  it("does not call hosted search when SearXNG returns useful results", async () => {
    mockFetch.mockResolvedValueOnce(
      searxResponse([result("https://searx.test")]),
    );

    const search = await searxSearch("query", "general", 5);

    expect(search.results[0].url).toBe("https://searx.test");
    expect(hosted.searchHostedFallback).not.toHaveBeenCalled();
  });

  it("does not spend hosted quota when SearXNG has a direct answer", async () => {
    mockFetch.mockResolvedValueOnce(
      searxResponse([], { answers: ["direct answer"] }),
    );

    const search = await searxSearch("query", "general", 5);

    expect(search.results).toEqual([]);
    expect(search.meta.answers).toEqual([{ answer: "direct answer" }]);
    expect(hosted.searchHostedFallback).not.toHaveBeenCalled();
  });

  it("uses one hosted fallback when SearXNG returns no useful result", async () => {
    mockFetch.mockResolvedValueOnce(searxResponse([]));
    hosted.searchHostedFallback.mockResolvedValueOnce({
      results: [result("https://exa.test", "exa")],
      meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
      provider: "exa",
      attempts: [{ provider: "exa", outcome: "hit" }],
    });

    const search = await searxSearch("query", "general", 5, "week");

    expect(hosted.searchHostedFallback).toHaveBeenCalledTimes(1);
    expect(hosted.searchHostedFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "query",
        category: "general",
        timeRange: "week",
      }),
    );
    expect(search.results[0].engine).toBe("exa");
    expect(cacheSet).toHaveBeenCalledOnce();
  });

  it("recovers from a SearXNG technical failure through hosted fallback", async () => {
    mockFetch.mockRejectedValueOnce(new Error("searx network down"));
    hosted.searchHostedFallback.mockResolvedValueOnce({
      results: [result("https://parallel.test", "parallel")],
      meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
      provider: "parallel",
      attempts: [{ provider: "parallel", outcome: "hit" }],
    });

    await expect(searxSearch("query", "general", 5)).resolves.toMatchObject({
      results: [expect.objectContaining({ engine: "parallel" })],
    });
  });

  it("returns the sparse SearXNG result when every hosted fallback fails", async () => {
    mockFetch.mockResolvedValueOnce(searxResponse([]));
    hosted.searchHostedFallback.mockResolvedValueOnce(null);

    await expect(searxSearch("query", "general", 5)).resolves.toMatchObject({
      results: [],
    });
  });

  it("rethrows the SearXNG failure when no hosted provider succeeds", async () => {
    mockFetch.mockRejectedValueOnce(new Error("searx network down"));
    hosted.searchHostedFallback.mockResolvedValueOnce(null);

    await expect(searxSearch("query", "general", 5)).rejects.toThrow(
      "searx network down",
    );
  });

  it("preserves explicit engine constraints by suppressing hosted fallback", async () => {
    mockFetch.mockResolvedValueOnce(searxResponse([]));
    hosted.searchHostedFallback.mockResolvedValueOnce({
      results: [result("https://exa.test", "exa")],
      meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
      provider: "exa",
      attempts: [{ provider: "exa", outcome: "hit" }],
    });

    const search = await searxSearch(
      "query",
      "general",
      5,
      undefined,
      undefined,
      undefined,
      undefined,
      "google",
    );

    expect(search.results).toEqual([]);
    expect(hosted.searchHostedFallback).not.toHaveBeenCalled();
  });

  it("allows an operator to opt into fallback despite an engine constraint", async () => {
    process.env.HOSTED_SEARCH_FALLBACK_WITH_ENGINE_FILTER = "true";
    mockFetch.mockResolvedValueOnce(searxResponse([]));
    hosted.searchHostedFallback.mockResolvedValueOnce({
      results: [result("https://brave.test", "brave")],
      meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
      provider: "brave",
      attempts: [{ provider: "brave", outcome: "hit" }],
    });

    const search = await searxSearch(
      "query",
      "general",
      5,
      undefined,
      undefined,
      undefined,
      undefined,
      "google",
    );

    expect(search.results[0].engine).toBe("brave");
  });

  it("allows hosted fallback only for the original expanded query", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("original SearXNG failed"))
      .mockRejectedValue(new Error("variant SearXNG failed"));
    hosted.searchHostedFallback.mockResolvedValueOnce({
      results: [result("https://exa.test", "exa")],
      meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
      provider: "exa",
      attempts: [{ provider: "exa", outcome: "hit" }],
    });

    const search = await searxSearch(
      "query",
      "general",
      5,
      undefined,
      undefined,
      true,
    );

    expect(search.results[0].engine).toBe("exa");
    expect(hosted.searchHostedFallback).toHaveBeenCalledTimes(1);
  });
});
