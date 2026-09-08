import { z } from "zod";

export interface DomainProfile {
  boost?: string[];
  block?: string[];
}

export type TierSlot = "tier1" | "tier2" | "tier3";

export interface DomainConfig {
  boost: string[];
  block: string[];
  llms_txt?: string[];
  tier_skip?: Record<string, TierSlot[]>;
  // Per-domain adblock bypass. v1 only carries the schema slot — Firecrawl
  // does not forward custom headers to the puppeteer-service, so the
  // X-Disable-Adblock signaling described in the build plan can't be wired
  // yet. Tracked in scope-creep.md.
  adblock_skip?: string[];
  profiles: Record<string, DomainProfile>;
}

export interface SearxResult {
  title: string;
  url: string;
  content?: string;
  engine?: string;
  engines?: string[];
  publishedDate?: string;
}

// SearXNG's raw JSON carries these alongside `results`. Their shapes vary a bit
// across versions (answers/corrections have been both strings and objects), so
// the raw types below are permissive and normalizeSearxMeta() collapses them.
export interface SearxResponse {
  results: SearxResult[];
  answers?: Array<string | { answer?: string; content?: string; url?: string }>;
  infoboxes?: Array<{
    infobox?: string;
    content?: string;
    urls?: Array<{ url?: string; title?: string }>;
  }>;
  corrections?: Array<string | { title?: string; url?: string }>;
  suggestions?: string[];
}

// Normalized, caller-facing shapes for the surfaced meta.
export interface SearxAnswer {
  answer: string;
  url?: string;
}

export interface SearxInfobox {
  title: string;
  content: string;
  url?: string;
}

export interface SearxMeta {
  answers: SearxAnswer[];
  infoboxes: SearxInfobox[];
  corrections: string[];
  suggestions: string[];
}

export interface SearxSearchResult {
  results: SearxResult[];
  meta: SearxMeta;
  route?: SearchRoute;
}

// ── Research-route provenance ───────────────────────────────────────────────
// Which provider/tier actually served a request. Surfaced to users as a
// concise "Research route:" line and in structuredContent for badge rendering.
// Built only from explicit runtime state, never inferred from logs.
export type SearchProviderId =
  | "searxng"
  | "exa"
  | "parallel"
  | "tinyfish"
  | "brave"
  | "cache";
export type FetchProviderId =
  | "cloudflare"
  | "crawl4ai"
  | "raw"
  | "wayback"
  | "github"
  | "llms_full_txt"
  | "kiwix"
  | "hister"
  | "youtube"
  | "reddit"
  | "cache";

export interface SearchRoute {
  provider: SearchProviderId;
  /** SearXNG engine names that returned results (searxng only). */
  engines?: string[];
  /** True when a primary provider missed and a fallback served instead. */
  fallback?: boolean;
  /** True when served from the search cache rather than a live query. */
  cacheHit?: boolean;
}

export interface FetchRoute {
  provider: FetchProviderId;
  fallback?: boolean;
  cacheHit?: boolean;
  /** Additional distinct fetch providers (multi-page search_and_fetch). */
  also?: FetchProviderId[];
}

export interface ResearchRoute {
  search?: SearchRoute;
  fetch?: FetchRoute;
}

export interface FirecrawlScrapeResponse {
  success: boolean;
  data?: {
    markdown?: string;
    html?: string;
    metadata?: { title?: string; sourceURL?: string };
  };
}

export interface Crawl4AIResult {
  success?: boolean;
  url?: string;
  markdown?: {
    raw_markdown?: string;
    fit_markdown?: string;
  };
  html?: string;
  metadata?: { title?: string };
}

export interface Crawl4AISyncResponse {
  results?: Crawl4AIResult[];
  data?: {
    results?: Crawl4AIResult[];
    task_id?: string;
  };
  task_id?: string;
}

export interface Crawl4AIAsyncResponse {
  status?: string;
  result?: Crawl4AIResult;
  results?: Crawl4AIResult[];
  data?: {
    result?: Crawl4AIResult;
    results?: Crawl4AIResult[];
  };
}

export interface FetchResult {
  title: string;
  url: string;
  text: string;
  route?: FetchRoute;
}

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface SearchArgs {
  query: string;
  num_results?: number;
  category?: string;
  time_range?: string;
  domain_profile?: string;
  expand?: boolean;
  language?: string;
  engines?: string;
  site?: string | string[];
}

export interface FetchArgs {
  url: string;
  domain_profile?: string;
  max_tokens?: number;
  target_selector?: string;
  wait_for_selector?: string;
}

export interface SearchAndFetchArgs extends SearchArgs {
  fetch_count?: number;
}

export interface SearchAndSummarizeArgs extends SearchArgs {
  fetch_count?: number;
}

export interface CrawlSiteArgs {
  url: string;
  max_pages?: number;
  bfs?: boolean;
}

export interface ClearCacheArgs {
  target: "search" | "fetch" | "crawl" | "all";
}

export interface DomainStatsArgs {
  hostname?: string;
}

export const SearchArgsSchema = z.object({
  query: z.string().min(1),
  num_results: z.number().int().min(1).max(20).optional(),
  category: z.enum(["general", "news", "it", "science"]).optional(),
  time_range: z.enum(["day", "week", "month", "year"]).optional(),
  domain_profile: z.string().optional(),
  expand: z.boolean().optional(),
  language: z.string().optional(),
  engines: z.string().optional(),
  site: z.union([z.string(), z.array(z.string())]).optional(),
});

export const FetchArgsSchema = z.object({
  url: z.string().url(),
  domain_profile: z.string().optional(),
  max_tokens: z.number().int().min(1).max(10000).optional(),
  target_selector: z.string().optional(),
  wait_for_selector: z.string().optional(),
});

export const SearchAndFetchArgsSchema = SearchArgsSchema.extend({
  fetch_count: z.number().int().min(1).max(3).optional(),
});

export const SearchAndSummarizeArgsSchema = SearchArgsSchema.extend({
  fetch_count: z.number().int().min(1).max(5).optional(),
});

export const CrawlSiteArgsSchema = z.object({
  url: z.string().url(),
  max_pages: z.number().int().min(1).max(200).optional(),
  bfs: z.boolean().optional(),
});

export const ClearCacheArgsSchema = z.object({
  target: z.enum(["search", "fetch", "crawl", "all"]),
});

export const DomainStatsArgsSchema = z.object({
  hostname: z.string().optional(),
});
