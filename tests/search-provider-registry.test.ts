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
  tinyfish: {
    configured: vi.fn(),
    search: vi.fn(),
  },
  brave: {
    configured: vi.fn(),
    search: vi.fn(),
  },
}));

const budgets = vi.hoisted(() => ({
  getStatus: vi.fn(),
}));

vi.mock("../src/search-providers/budget.js", () => {
  class HostedSearchBudgetError extends Error {
    constructor(
      public readonly provider: string,
      public readonly budget: { state: string },
    ) {
      super(`${provider} search budget is exhausted`);
      this.name = "HostedSearchBudgetError";
    }
  }

  return {
    getHostedSearchBudgetStatus: budgets.getStatus,
    HostedSearchBudgetError,
    budgetRoutingRank: (state: string) => {
      switch (state) {
        case "disabled":
        case "healthy":
          return 0;
        case "near_limit":
          return 1;
        case "unknown":
          return 2;
        case "exhausted":
          return 3;
        default:
          return 99;
      }
    },
  };
});

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
      recency: true,
      domains: true,
      news: true,
    },
    configured: providers.parallel.configured,
    search: providers.parallel.search,
  },
}));

vi.mock("../src/search-providers/tinyfish.js", () => ({
  tinyfishSearchProvider: {
    id: "tinyfish",
    capabilities: {
      semantic: false,
      recency: true,
      domains: true,
      news: true,
    },
    configured: providers.tinyfish.configured,
    search: providers.tinyfish.search,
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

function budgetStatus(
  provider: string,
  state: "disabled" | "healthy" | "near_limit" | "exhausted" | "unknown",
  allowed = state !== "exhausted" && state !== "unknown",
) {
  return {
    provider,
    state,
    allowed,
    usedUnits: state === "near_limit" ? 85 : state === "exhausted" ? 100 : 0,
    limitUnits: state === "disabled" ? undefined : 100,
    remainingUnits:
      state === "disabled" ? undefined : state === "near_limit" ? 15 : 100,
    warnPercent: 80,
    period: "2026-08",
    resetAt: "2026-09-01T00:00:00.000Z",
    failOpen: false,
  };
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks): clears residual mockResolvedValueOnce
  // queues from the previous test so a once-only provider result cannot leak
  // into the next test's expectation.
  vi.resetAllMocks();
  delete process.env.HOSTED_SEARCH_PROVIDER_ORDER;
  delete process.env.HOSTED_SEARCH_FALLBACK_ENABLED;
  providers.exa.configured.mockReturnValue(true);
  providers.parallel.configured.mockReturnValue(true);
  providers.tinyfish.configured.mockReturnValue(true);
  providers.brave.configured.mockReturnValue(true);
  providers.exa.search.mockResolvedValue([]);
  providers.parallel.search.mockResolvedValue([]);
  providers.tinyfish.search.mockResolvedValue([]);
  providers.brave.search.mockResolvedValue([]);
  budgets.getStatus.mockImplementation(async (provider: string) =>
    budgetStatus(provider, "disabled"),
  );
});

describe("hosted search registry", () => {
  it("tries providers sequentially and stops on the first hit", async () => {
    providers.exa.search.mockResolvedValueOnce([]);
    providers.parallel.search.mockResolvedValueOnce([
      result("https://parallel.test", "parallel"),
    ]);
    providers.tinyfish.search.mockResolvedValueOnce([
      result("https://tinyfish.test", "tinyfish"),
    ]);

    const fallback = await searchHostedFallback(request);

    expect(providers.exa.search).toHaveBeenCalledTimes(1);
    expect(providers.parallel.search).toHaveBeenCalledTimes(1);
    expect(providers.tinyfish.search).not.toHaveBeenCalled();
    expect(providers.brave.search).not.toHaveBeenCalled();
    expect(fallback?.provider).toBe("parallel");
    expect(fallback?.attempts).toEqual([
      { provider: "exa", outcome: "empty", budgetState: "disabled" },
      { provider: "parallel", outcome: "hit", budgetState: "disabled" },
    ]);
  });

  it("can route to tinyfish as a first-class provider", async () => {
    process.env.HOSTED_SEARCH_PROVIDER_ORDER = "tinyfish,exa,parallel,brave";
    providers.tinyfish.search.mockResolvedValueOnce([
      result("https://tinyfish.test", "tinyfish"),
    ]);

    const fallback = await searchHostedFallback(request);

    expect(fallback?.provider).toBe("tinyfish");
    expect(providers.tinyfish.search).toHaveBeenCalledTimes(1);
    expect(providers.exa.search).not.toHaveBeenCalled();
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
      budgetState: "disabled",
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
    process.env.HOSTED_SEARCH_PROVIDER_ORDER = "brave,exa,tinyfish,parallel";
    providers.brave.search.mockResolvedValueOnce([
      result("https://brave.test", "brave"),
    ]);

    const fallback = await searchHostedFallback(request);

    expect(fallback?.provider).toBe("brave");
    expect(providers.brave.search).toHaveBeenCalledTimes(1);
    expect(providers.exa.search).not.toHaveBeenCalled();
  });

  it("moves a near-limit provider behind healthier-budget providers", async () => {
    budgets.getStatus.mockImplementation(async (provider: string) =>
      budgetStatus(provider, provider === "exa" ? "near_limit" : "healthy"),
    );
    providers.parallel.search.mockResolvedValueOnce([
      result("https://parallel.test", "parallel"),
    ]);

    const fallback = await searchHostedFallback(request);

    expect(fallback?.provider).toBe("parallel");
    expect(providers.parallel.search).toHaveBeenCalledTimes(1);
    expect(providers.exa.search).not.toHaveBeenCalled();
  });

  it("never calls a provider whose hard budget is exhausted", async () => {
    budgets.getStatus.mockImplementation(async (provider: string) =>
      budgetStatus(provider, provider === "exa" ? "exhausted" : "healthy"),
    );

    const fallback = await searchHostedFallback(request);

    expect(fallback).toBeNull();
    expect(providers.exa.search).not.toHaveBeenCalled();
    expect(providers.parallel.search).toHaveBeenCalledTimes(1);
    expect(providers.tinyfish.search).toHaveBeenCalledTimes(1);
    expect(providers.brave.search).toHaveBeenCalledTimes(1);
  });

  it("skips unknown budget health when fail-open is not enabled", async () => {
    budgets.getStatus.mockImplementation(async (provider: string) =>
      provider === "exa"
        ? budgetStatus(provider, "unknown", false)
        : budgetStatus(provider, "healthy"),
    );
    providers.parallel.search.mockResolvedValueOnce([
      result("https://parallel.test", "parallel"),
    ]);

    const fallback = await searchHostedFallback(request);

    expect(fallback?.provider).toBe("parallel");
    expect(providers.exa.search).not.toHaveBeenCalled();
  });

  it("can be disabled globally even when providers are configured", async () => {
    process.env.HOSTED_SEARCH_FALLBACK_ENABLED = "false";

    await expect(searchHostedFallback(request)).resolves.toBeNull();
    expect(providers.exa.search).not.toHaveBeenCalled();
    expect(providers.parallel.search).not.toHaveBeenCalled();
    expect(providers.tinyfish.search).not.toHaveBeenCalled();
    expect(providers.brave.search).not.toHaveBeenCalled();
  });

  it("reports only configured providers", () => {
    providers.parallel.configured.mockReturnValue(false);
    expect(configuredHostedSearchProviders()).toEqual([
      "exa",
      "tinyfish",
      "brave",
    ]);
  });
});
