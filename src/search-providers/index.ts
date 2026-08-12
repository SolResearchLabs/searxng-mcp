import type { SearxMeta } from "../types.js";
import { braveSearchProvider } from "./brave.js";
import { exaSearchProvider } from "./exa.js";
import { parallelSearchProvider } from "./parallel.js";
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
  brave: braveSearchProvider,
};

const DEFAULT_ORDER: HostedSearchProviderId[] = ["exa", "parallel", "brave"];

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

export async function searchHostedFallback(
  request: HostedSearchRequest,
): Promise<HostedSearchFallbackResult | null> {
  if (!hostedSearchFallbackEnabled()) return null;

  const attempts: HostedSearchAttempt[] = [];
  for (const id of providerOrder()) {
    const provider = PROVIDERS[id];
    if (!provider.configured()) {
      attempts.push({ provider: id, outcome: "unconfigured" });
      continue;
    }

    try {
      const results = await provider.search(request);
      if (results.length === 0) {
        attempts.push({ provider: id, outcome: "empty" });
        continue;
      }
      attempts.push({ provider: id, outcome: "hit" });
      return {
        results,
        meta: EMPTY_META,
        provider: id,
        attempts,
      };
    } catch (err) {
      attempts.push({
        provider: id,
        outcome: "error",
        error: err instanceof Error ? err.message : "provider error",
      });
    }
  }

  return null;
}

export function configuredHostedSearchProviders(): HostedSearchProviderId[] {
  return providerOrder().filter((id) => PROVIDERS[id].configured());
}

export { hostedSearchControlSnapshot } from "./control.js";
export type {
  HostedSearchCapabilities,
  HostedSearchProvider,
  HostedSearchProviderId,
  HostedSearchRequest,
} from "./types.js";
