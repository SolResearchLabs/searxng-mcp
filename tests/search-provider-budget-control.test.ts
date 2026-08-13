import { beforeEach, describe, expect, it, vi } from "vitest";

const budget = vi.hoisted(() => ({
  reserve: vi.fn(),
}));

vi.mock("../src/search-providers/budget.js", () => {
  class HostedSearchBudgetError extends Error {
    constructor(
      public readonly provider: string,
      public readonly budget: { state: string; allowed: boolean },
    ) {
      super(`${provider} search budget is exhausted`);
      this.name = "HostedSearchBudgetError";
    }
  }

  return {
    reserveHostedSearchBudget: budget.reserve,
    HostedSearchBudgetError,
  };
});

import { HostedSearchBudgetError } from "../src/search-providers/budget.js";
import {
  hostedSearchControlSnapshot,
  runHostedSearchProvider,
} from "../src/search-providers/control.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hosted provider budget/control boundary", () => {
  it("rejects a blocked budget before provider execution without poisoning its circuit", async () => {
    budget.reserve.mockResolvedValueOnce({
      provider: "exa",
      state: "exhausted",
      allowed: false,
      usedUnits: 100,
      limitUnits: 100,
      remainingUnits: 0,
      warnPercent: 80,
      period: "2026-08",
      resetAt: "2026-09-01T00:00:00.000Z",
      failOpen: false,
    });
    const providerCall = vi.fn(async () => "should not run");

    await expect(
      runHostedSearchProvider("exa", "budget-blocked", providerCall),
    ).rejects.toBeInstanceOf(HostedSearchBudgetError);

    expect(providerCall).not.toHaveBeenCalled();
    expect(hostedSearchControlSnapshot().exa.circuit).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });
});
