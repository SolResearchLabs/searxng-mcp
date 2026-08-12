import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getValkey: vi.fn(),
  get: vi.fn(),
  eval: vi.fn(),
}));

vi.mock("../src/cache.js", () => ({
  getValkey: mocks.getValkey,
}));

import {
  budgetRoutingRank,
  getHostedSearchBudgetStatus,
  reserveHostedSearchBudget,
} from "../src/search-providers/budget.js";

const originalEnv = { ...process.env };
const NOW = new Date("2026-08-12T20:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...originalEnv };
  delete process.env.EXA_SEARCH_BUDGET_MONTHLY_UNITS;
  delete process.env.EXA_SEARCH_BUDGET_UNITS_PER_REQUEST;
  delete process.env.EXA_SEARCH_BUDGET_WARN_PERCENT;
  delete process.env.HOSTED_SEARCH_BUDGET_FAIL_OPEN;
  mocks.getValkey.mockResolvedValue({
    get: mocks.get,
    eval: mocks.eval,
  });
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("hosted search budget status", () => {
  it("is disabled and does not touch Valkey when no monthly cap is configured", async () => {
    const status = await getHostedSearchBudgetStatus("exa", NOW);
    expect(status).toMatchObject({
      provider: "exa",
      state: "disabled",
      allowed: true,
      usedUnits: 0,
      period: "2026-08",
    });
    expect(mocks.getValkey).not.toHaveBeenCalled();
  });

  it("classifies healthy and near-limit usage from the monthly counter", async () => {
    process.env.EXA_SEARCH_BUDGET_MONTHLY_UNITS = "100";
    process.env.EXA_SEARCH_BUDGET_WARN_PERCENT = "80";

    mocks.get.mockResolvedValueOnce("25");
    await expect(getHostedSearchBudgetStatus("exa", NOW)).resolves.toMatchObject({
      state: "healthy",
      allowed: true,
      usedUnits: 25,
      remainingUnits: 75,
    });

    mocks.get.mockResolvedValueOnce("85");
    await expect(getHostedSearchBudgetStatus("exa", NOW)).resolves.toMatchObject({
      state: "near_limit",
      allowed: true,
      usedUnits: 85,
      remainingUnits: 15,
    });
  });

  it("classifies usage at the hard cap as exhausted", async () => {
    process.env.EXA_SEARCH_BUDGET_MONTHLY_UNITS = "100";
    mocks.get.mockResolvedValueOnce("100");

    await expect(getHostedSearchBudgetStatus("exa", NOW)).resolves.toMatchObject({
      state: "exhausted",
      allowed: false,
      usedUnits: 100,
      remainingUnits: 0,
    });
  });

  it("fails closed by default when a configured budget cannot be verified", async () => {
    process.env.EXA_SEARCH_BUDGET_MONTHLY_UNITS = "100";
    mocks.getValkey.mockResolvedValueOnce(null);

    await expect(getHostedSearchBudgetStatus("exa", NOW)).resolves.toMatchObject({
      state: "unknown",
      allowed: false,
      failOpen: false,
    });
  });

  it("can explicitly fail open when budget storage is unavailable", async () => {
    process.env.EXA_SEARCH_BUDGET_MONTHLY_UNITS = "100";
    process.env.HOSTED_SEARCH_BUDGET_FAIL_OPEN = "true";
    mocks.getValkey.mockResolvedValueOnce(null);

    await expect(getHostedSearchBudgetStatus("exa", NOW)).resolves.toMatchObject({
      state: "unknown",
      allowed: true,
      failOpen: true,
    });
  });
});

describe("hosted search budget reservation", () => {
  it("atomically reserves configured units in the calendar-month key", async () => {
    process.env.EXA_SEARCH_BUDGET_MONTHLY_UNITS = "100";
    process.env.EXA_SEARCH_BUDGET_UNITS_PER_REQUEST = "2.5";
    mocks.eval.mockResolvedValueOnce([1, "82.5"]);

    const status = await reserveHostedSearchBudget("exa", NOW);

    expect(status).toMatchObject({
      state: "near_limit",
      allowed: true,
      usedUnits: 82.5,
      remainingUnits: 17.5,
      period: "2026-08",
      resetAt: "2026-09-01T00:00:00.000Z",
    });
    expect(mocks.eval).toHaveBeenCalledTimes(1);
    const args = mocks.eval.mock.calls[0];
    expect(args[1]).toBe(1);
    expect(args[2]).toBe("budget:hosted-search:exa:2026-08");
    expect(args[3]).toBe("2.5");
    expect(args[4]).toBe("100");
  });

  it("returns exhausted without incrementing beyond the hard cap", async () => {
    process.env.EXA_SEARCH_BUDGET_MONTHLY_UNITS = "100";
    mocks.eval.mockResolvedValueOnce([0, "100"]);

    await expect(reserveHostedSearchBudget("exa", NOW)).resolves.toMatchObject({
      state: "exhausted",
      allowed: false,
      usedUnits: 100,
    });
  });

  it("keeps budget-health rank independent from provider technical health", () => {
    expect(budgetRoutingRank("healthy")).toBeLessThan(
      budgetRoutingRank("near_limit"),
    );
    expect(budgetRoutingRank("near_limit")).toBeLessThan(
      budgetRoutingRank("unknown"),
    );
    expect(budgetRoutingRank("unknown")).toBeLessThan(
      budgetRoutingRank("exhausted"),
    );
  });
});
