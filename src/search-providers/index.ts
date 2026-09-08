import type { SearxMeta } from "../types.js";
import { braveSearchProvider } from "./brave.js";
import {
  budgetRoutingRank,
  getHostedSearchBudgetStatus,
  HostedSearchBudgetError,
  type HostedSearchBudgetStatus,
} from "./budget.js";
import { exaSearchProvider } from "./exa.js";
import { parallelSearchProvider } from "./parallel.js";
import { tinyfishSearchProvider } from "./tinyfish.js";
import type {
  HostedSearchAttempt,
  HostedSearchFallbackResult,
  HostedSearchProvider,
  HostedSearchProviderId,
  HostedSearchRequest,
} from "./types.js";

const EMPTY_META: SearxMeta = {
  answers: [],
  infoboxes: [],
  corrections: [],
  suggestions: [],
};

const PROVIDERS: Record<HostedSearchProviderId, HostedSearchProvider> = {
  exa: exaSearchProvider,
  parallel: parallelSearchProvider,
  tinyfish: tinyfishSearchProvider,
  brave: braveSearchProvider,
};

const DEFAULT_ORDER: HostedSearchProviderId[] = [
  "exa",
  "parallel",
  "tinyfish",
  "brave",
];

function providerOrder(): HostedSearchProviderId[] {
  const raw = process.env.HOSTED_SEARCH_PROVIDER_ORDER?.trim();
  if (!raw) return DEFAULT_ORDER;

  const seen = new Set<HostedSearchProviderId>();
  const order: HostedSearchProviderId[] = [];
  for (const item of raw.split(",")) {
    const id = item.trim().toLowerCase() as HostedSearchProviderId;
    if (!(id in PROVIDERS) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  return order.length > 0 ? order : DEFAULT_ORDER;
}

export function hostedSearchFallbackEnabled(): boolean {
  const raw = process.env.HOSTED_SEARCH_FALLBACK_ENABLED?.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(raw ?? "")) return false;
  return providerOrder().some((id) => PROVIDERS[id].configured());
}

export function hostedSearchFallbackMinResults(): number {
  const raw = process.env.HOSTED_SEARCH_FALLBACK_MIN_RESULTS;
  if (raw === undefined) return 1;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 ? value : 1;
}

export function hasUsefulPrimarySearch(
  resultsCount: number,
  meta: SearxMeta,
): boolean {
  if (resultsCount >= hostedSearchFallbackMinResults()) return true;
  // SearXNG direct answers/infoboxes are already useful even when its ordinary
  // web result list is empty. Do not spend hosted-search quota unnecessarily.
  return meta.answers.length > 0 || meta.infoboxes.length > 0;
}

interface BudgetCandidate {
  id: HostedSearchProviderId;
  index: number;
  budget: HostedSearchBudgetStatus;
}

async function budgetAwareCandidates(
  attempts: HostedSearchAttempt[],
): Promise<BudgetCandidate[]> {
  const configured: Array<{
    id: HostedSearchProviderId;
    index: number;
  }> = [];

  for (const [index, id] of providerOrder().entries()) {
    if (!PROVIDERS[id].configured()) {
      attempts.push({ provider: id, outcome: "unconfigured" });
      continue;
    }
    configured.push({ id, index });
  }

  const candidates = await Promise.all(
    configured.map(async ({ id, index }) => ({
      id,
      index,
      budget: await getHostedSearchBudgetStatus(id),
    })),
  );

  // Keep the operator's configured order inside each budget-health class. A
  // near-limit provider moves behind healthy/uncapped providers; unknown health
  // moves behind near-limit when fail-open is enabled. Exhausted/fail-closed
  // unknown providers remain in the list only so the attempt trail can explain
  // why they were skipped.
  candidates.sort(
    (a, b) =>
      budgetRoutingRank(a.budget.state) - budgetRoutingRank(b.budget.state) ||
      a.index - b.index,
  );
  return candidates;
}

export async function searchHostedFallback(
  request: HostedSearchRequest,
): Promise<HostedSearchFallbackResult | null> {
  if (!hostedSearchFallbackEnabled()) return null;

  const attempts: HostedSearchAttempt[] = [];
  const candidates = await budgetAwareCandidates(attempts);

  for (const { id, budget } of candidates) {
    const provider = PROVIDERS[id];
    if (!budget.allowed) {
      attempts.push({
        provider: id,
        outcome: "budget_blocked",
        budgetState: budget.state,
      });
      continue;
    }

    try {
      const results = await provider.search(request);
      if (results.length === 0) {
        attempts.push({
          provider: id,
          outcome: "empty",
          budgetState: budget.state,
        });
        continue;
      }
      attempts.push({
        provider: id,
        outcome: "hit",
        budgetState: budget.state,
      });
      return {
        results,
        meta: EMPTY_META,
        provider: id,
        attempts,
      };
    } catch (err) {
      if (err instanceof HostedSearchBudgetError) {
        attempts.push({
          provider: id,
          outcome: "budget_blocked",
          budgetState: err.budget.state,
          error: err.message,
        });
        continue;
      }

      attempts.push({
        provider: id,
        outcome: "error",
        budgetState: budget.state,
        error: err instanceof Error ? err.message : "provider error",
      });
    }
  }

  return null;
}

export function configuredHostedSearchProviders(): HostedSearchProviderId[] {
  return providerOrder().filter((id) => PROVIDERS[id].configured());
}

export async function hostedSearchBudgetSnapshot(): Promise<
  Record<HostedSearchProviderId, HostedSearchBudgetStatus>
> {
  const entries = await Promise.all(
    DEFAULT_ORDER.map(
      async (id) => [id, await getHostedSearchBudgetStatus(id)] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<
    HostedSearchProviderId,
    HostedSearchBudgetStatus
  >;
}

export { hostedSearchControlSnapshot } from "./control.js";
export type {
  HostedSearchCapabilities,
  HostedSearchProvider,
  HostedSearchProviderId,
  HostedSearchRequest,
} from "./types.js";
