import { beforeEach, describe, expect, it, vi } from "vitest";

// Focused safety regression suite for the HOSTED_SEARCH_FALLBACK_ENABLED kill
// switch (src/search-providers/index.ts). Proves that a disabled fallback:
//   1. preserves the default/unset (OSS) behavior when the env is absent;
//   2. suppresses every hosted provider regardless of provider configuration;
//   3. consumes zero budget units (no status read, no reservation);
//   4. leaves provider circuit/gate health untouched;
// and that the recognized true/false value forms parse as intended.
//
// The registry layer (searchHostedFallback) calls provider.search() directly;
// the circuit/gate wrapper only runs inside the REAL provider implementations,
// which are mocked here, so the live control.ts objects are never exercised by
// an enabled path. The "circuit unchanged" assertion is therefore about the
// disabled path having zero side effects.

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

const budgets = vi.hoisted(() => ({
  getStatus: vi.fn(),
  reserve: vi.fn(),
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
    reserveHostedSearchBudget: budgets.reserve,
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

import { hostedSearchControlSnapshot } from "../src/search-providers/control.js";
import {
  hostedSearchFallbackEnabled,
  searchHostedFallback,
} from "../src/search-providers/index.js";

const request = {
  query: "kill switch test query",
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
  vi.resetAllMocks();
  delete process.env.HOSTED_SEARCH_PROVIDER_ORDER;
  delete process.env.HOSTED_SEARCH_FALLBACK_ENABLED;
  providers.exa.configured.mockReturnValue(true);
  providers.parallel.configured.mockReturnValue(true);
  providers.brave.configured.mockReturnValue(true);
  providers.exa.search.mockResolvedValue([]);
  providers.parallel.search.mockResolvedValue([]);
  providers.brave.search.mockResolvedValue([]);
  budgets.getStatus.mockResolvedValue({ state: "disabled", allowed: true });
  budgets.reserve.mockResolvedValue({ state: "disabled", allowed: true });
});

describe("HOSTED_SEARCH_FALLBACK_ENABLED kill switch", () => {
  it("default/unset preserves current fallback behavior", async () => {
    delete process.env.HOSTED_SEARCH_FALLBACK_ENABLED;
    // With providers configured, unset means enabled (backward-compat / OSS).
    expect(hostedSearchFallbackEnabled()).toBe(true);

    providers.exa.search.mockResolvedValueOnce([
      result("https://exa.test", "exa"),
    ]);

    const fallback = await searchHostedFallback(request);

    expect(fallback?.provider).toBe("exa");
    expect(providers.exa.search).toHaveBeenCalledTimes(1);
  });

  it("recognizes the disabled value forms (false/0/no/off, case-insensitive)", async () => {
    for (const value of ["false", "0", "no", "off", "FALSE", "No", "OFF"]) {
      process.env.HOSTED_SEARCH_FALLBACK_ENABLED = value;
      expect(hostedSearchFallbackEnabled()).toBe(false);
    }
  });

  it("recognizes the enabled value forms (true/1/yes/on, case-insensitive)", async () => {
    for (const value of ["true", "1", "yes", "on", "TRUE", "Yes", "ON"]) {
      process.env.HOSTED_SEARCH_FALLBACK_ENABLED = value;
      expect(hostedSearchFallbackEnabled()).toBe(true);
    }
  });

  it("treats an unrecognized value as enabled (backward compatibility)", async () => {
    process.env.HOSTED_SEARCH_FALLBACK_ENABLED = "banana";
    providers.exa.search.mockResolvedValueOnce([
      result("https://exa.test", "exa"),
    ]);

    const fallback = await searchHostedFallback(request);

    expect(fallback?.provider).toBe("exa");
  });

  describe("when disabled (HOSTED_SEARCH_FALLBACK_ENABLED=false)", () => {
    beforeEach(() => {
      process.env.HOSTED_SEARCH_FALLBACK_ENABLED = "false";
    });

    it("suppresses every hosted provider even when all are configured", async () => {
      const fallback = await searchHostedFallback(request);

      expect(fallback).toBeNull();
      expect(providers.exa.search).not.toHaveBeenCalled();
      expect(providers.parallel.search).not.toHaveBeenCalled();
      expect(providers.brave.search).not.toHaveBeenCalled();
    });

    it("consumes zero budget units (no status read, no reservation)", async () => {
      const fallback = await searchHostedFallback(request);

      expect(fallback).toBeNull();
      expect(budgets.getStatus).not.toHaveBeenCalled();
      expect(budgets.reserve).not.toHaveBeenCalled();
    });

    it("does not change provider circuit/gate health", async () => {
      const before = hostedSearchControlSnapshot();

      const fallback = await searchHostedFallback(request);

      expect(fallback).toBeNull();
      expect(providers.exa.search).not.toHaveBeenCalled();
      expect(hostedSearchControlSnapshot()).toEqual(before);
    });
  });
});
