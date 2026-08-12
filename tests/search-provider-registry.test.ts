import { beforeEach, describe, expect, it, vi } from "vitest";

const providers = vi.hoisted(() => ({
  exa: {
    configured: vi.fn(),
    search: vi.fn(),
  },
  parallel: {
    configured: vi.fn(),
    search: vi.fn(),
  },
  brave: {
    configured: vi.fn(),
    search: vi.fn(),
  },
}));

vi.mock("../src/search-providers/exa.js", () => ({
  exaSearchProvider: {
    id: "exa",
    capabilities: { semantic: true, recency: true, domains: true, news: true },
    configured: providers.exa.configured,
    search: providers.exa.search,
  },
}));

vi.mock("../src/search-providers/parallel.js", () => ({
  parallelSearchProvider: {
    id: "parallel",
    capabilities: {
      semantic: true,
      recency: false,
      domains: false,
      news: true,
    },
    configured: providers.parallel.configured,
    search: providers.parallel.search,
  },
}));

vi.mock("../src/search-providers/brave.js", () => ({
  braveSearchProvider: {
    id: "brave",
    capabilities: {
      semantic: false,
      recency: true,
      domains: true,
      news: false,
    },
    configured: providers.brave.configured,
    search: providers.brave.search,
  },
}));

import {
  configuredHostedSearchProviders,
  searchHostedFallback,
} from "../src/search-providers/index.js";

const request = {
  query: "test query",
  numResults: 5,
  category: "general",
};

const result = (url: string, engine: string) => ({
  title: engine,
  url,
  content: "snippet",
  engine,
  engines: [engine],
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.HOSTED_SEARCH_PROVIDER_ORDER;
  delete process.env.HOSTED_SEARCH_FALLBACK_ENABLED;
  providers.exa.configured.mockReturnValue(true);
  providers.parallel.configured.mockReturnValue(true);
  providers.brave.configured.mockReturnValue(true);
  providers.exa.search.mockResolvedValue([]);
  providers.parallel.search.mockResolvedValue([]);
  providers.brave.search.mockResolvedValue([]);
});

describe("hosted search registry", () => {
  it("tries providers sequentially and stops on the first hit", async () => {
    providers.exa.search.mockResolvedValueOnce([]);
    providers.parallel.search.mockResolvedValueOnce([
      result("https://parallel.test", "parallel"),
    ]);
    providers.brave.search.mockResolvedValueOnce([
      result("https://brave.test", "brave"),
    ]);

    const fallback = await searchHostedFallback(request);

    expect(providers.exa.search).toHaveBeenCalledTimes(1);
    expect(providers.parallel.search).toHaveBeenCalledTimes(1);
    expect(providers.brave.search).not.toHaveBeenCalled();
    expect(fallback?.provider).toBe("parallel");
    expect(fallback?.attempts).toEqual([
      { provider: "exa", outcome: "empty" },
      { provider: "parallel", outcome: "hit" },
    ]);
  });

  it("continues after a provider error instead of failing the whole fallback", async () => {
    providers.exa.search.mockRejectedValueOnce(new Error("exa unavailable"));
    providers.parallel.search.mockResolvedValueOnce([
      result("https://parallel.test", "parallel"),
    ]);

    const fallback = await searchHostedFallback(request);

    expect(fallback?.provider).toBe("parallel");
    expect(fallback?.attempts[0]).toMatchObject({
      provider: "exa",
      outcome: "error",
      error: "exa unavailable",
    });
  });

  it("skips unconfigured providers without attempting them", async () => {
    providers.exa.configured.mockReturnValue(false);
    providers.parallel.search.mockResolvedValueOnce([
      result("https://parallel.test", "parallel"),
    ]);

    const fallback = await searchHostedFallback(request);

    expect(providers.exa.search).not.toHaveBeenCalled();
    expect(fallback?.attempts[0]).toEqual({
      provider: "exa",
      outcome: "unconfigured",
    });
  });

  it("honors an operator-defined provider order", async () => {
    process.env.HOSTED_SEARCH_PROVIDER_ORDER = "brave,exa,parallel";
    providers.brave.search.mockResolvedValueOnce([
      result("https://brave.test", "brave"),
    ]);

    const fallback = await searchHostedFallback(request);

    expect(fallback?.provider).toBe("brave");
    expect(providers.brave.search).toHaveBeenCalledTimes(1);
    expect(providers.exa.search).not.toHaveBeenCalled();
  });

  it("can be disabled globally even when providers are configured", async () => {
    process.env.HOSTED_SEARCH_FALLBACK_ENABLED = "false";

    await expect(searchHostedFallback(request)).resolves.toBeNull();
    expect(providers.exa.search).not.toHaveBeenCalled();
    expect(providers.parallel.search).not.toHaveBeenCalled();
    expect(providers.brave.search).not.toHaveBeenCalled();
  });

  it("reports only configured providers", () => {
    providers.parallel.configured.mockReturnValue(false);
    expect(configuredHostedSearchProviders()).toEqual(["exa", "brave"]);
  });
});
