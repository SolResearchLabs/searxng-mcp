import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/search-providers/control.js", () => ({
  runHostedSearchProvider: async <T>(
    _provider: string,
    _key: string,
    fn: () => Promise<T>,
  ): Promise<T> => fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { braveSearchProvider } from "../src/search-providers/brave.js";
import { exaSearchProvider } from "../src/search-providers/exa.js";
import { parallelSearchProvider } from "../src/search-providers/parallel.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EXA_API_KEY = "exa-test";
  process.env.PARALLEL_API_KEY = "parallel-test";
  process.env.BRAVE_SEARCH_API_KEY = "brave-test";
  delete process.env.EXA_SEARCH_TYPE;
  delete process.env.PARALLEL_SEARCH_MODE;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("Exa hosted search", () => {
  it("maps domains, recency, news category and highlights", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            title: "Exa result",
            url: "https://example.com/exa",
            publishedDate: "2026-08-12T00:00:00.000Z",
            highlights: ["first highlight", "second highlight"],
          },
        ],
      }),
    );

    const results = await exaSearchProvider.search({
      query: "latest browser rendering",
      numResults: 5,
      category: "news",
      timeRange: "week",
      site: ["example.com", "docs.example.com"],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toBe("https://api.exa.ai/search");
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-api-key": "exa-test",
    });
    const body = JSON.parse(String(options.body));
    expect(body.query).toBe("latest browser rendering");
    expect(body.numResults).toBe(5);
    expect(body.type).toBe("auto");
    expect(body.category).toBe("news");
    expect(body.includeDomains).toEqual(["example.com", "docs.example.com"]);
    expect(body.startPublishedDate).toBeDefined();
    expect(body.contents).toEqual({ highlights: true });
    expect(results[0]).toMatchObject({
      url: "https://example.com/exa",
      engine: "exa",
      content: "first highlight\nsecond highlight",
    });
  });
});

describe("Parallel hosted search", () => {
  it("uses v1 search, strict source policy and normalized excerpts", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            title: "Parallel result",
            url: "https://example.com/parallel",
            publish_date: "2026-08-11",
            excerpts: ["excerpt one", "excerpt two"],
          },
        ],
      }),
    );

    const results = await parallelSearchProvider.search({
      query: "browser rendering update",
      numResults: 4,
      category: "news",
      timeRange: "day",
      site: "example.com",
    });

    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://api.parallel.ai/v1/search",
    );
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-api-key": "parallel-test",
    });
    const body = JSON.parse(String(options.body));
    expect(body.search_queries).toEqual(["browser rendering update"]);
    expect(body.mode).toBe("basic");
    expect(body.max_chars_total).toBe(4800);
    expect(body.objective).toContain("current news");
    expect(body.advanced_settings.max_results).toBe(4);
    expect(body.advanced_settings.source_policy.include_domains).toEqual([
      "example.com",
    ]);
    expect(body.advanced_settings.source_policy.after_date).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect(results[0]).toMatchObject({
      url: "https://example.com/parallel",
      engine: "parallel",
      content: "excerpt one\nexcerpt two",
      publishedDate: "2026-08-11",
    });
  });

  it("accepts the current advanced mode override", async () => {
    process.env.PARALLEL_SEARCH_MODE = "advanced";
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));

    await parallelSearchProvider.search({
      query: "complex research",
      numResults: 5,
      category: "general",
    });

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(options.body));
    expect(body.mode).toBe("advanced");
  });
});

describe("Brave hosted search", () => {
  it("maps site, language, freshness and snippets", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        web: {
          results: [
            {
              title: "Brave result",
              url: "https://example.com/brave",
              description: "main snippet",
              extra_snippets: ["extra one", "extra two"],
              page_age: "2026-08-12T00:00:00Z",
            },
          ],
        },
      }),
    );

    const results = await braveSearchProvider.search({
      query: "browser rendering",
      numResults: 7,
      category: "general",
      timeRange: "month",
      language: "en-CA",
      site: "example.com",
    });

    const calledUrl = new URL(mockFetch.mock.calls[0][0] as string);
    expect(`${calledUrl.origin}${calledUrl.pathname}`).toBe(
      "https://api.search.brave.com/res/v1/web/search",
    );
    expect(calledUrl.searchParams.get("q")).toBe(
      "site:example.com browser rendering",
    );
    expect(calledUrl.searchParams.get("count")).toBe("7");
    expect(calledUrl.searchParams.get("freshness")).toBe("pm");
    expect(calledUrl.searchParams.get("search_lang")).toBe("en");
    expect(calledUrl.searchParams.get("result_filter")).toBe("web");
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({
      Accept: "application/json",
      "X-Subscription-Token": "brave-test",
    });
    expect(results[0]).toMatchObject({
      url: "https://example.com/brave",
      engine: "brave",
      content: "main snippet\nextra one\nextra two",
      publishedDate: "2026-08-12T00:00:00Z",
    });
  });
});
