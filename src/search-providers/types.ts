import type { SearxResult, SearxSearchResult } from "../types.js";
import type { BudgetHealthState } from "./budget.js";

export type HostedSearchProviderId = "exa" | "parallel" | "tinyfish" | "brave";

export interface HostedSearchCapabilities {
  semantic: boolean;
  recency: boolean;
  domains: boolean;
  news: boolean;
}

export interface HostedSearchRequest {
  query: string;
  numResults: number;
  category: string;
  timeRange?: string;
  language?: string;
  site?: string | string[];
}

export interface HostedSearchProvider {
  id: HostedSearchProviderId;
  capabilities: HostedSearchCapabilities;
  configured(): boolean;
  search(request: HostedSearchRequest): Promise<SearxResult[]>;
}

export interface HostedSearchAttempt {
  provider: HostedSearchProviderId;
  outcome: "hit" | "empty" | "error" | "unconfigured" | "budget_blocked";
  error?: string;
  budgetState?: BudgetHealthState;
}

export interface HostedSearchFallbackResult extends SearxSearchResult {
  provider: HostedSearchProviderId;
  attempts: HostedSearchAttempt[];
}
