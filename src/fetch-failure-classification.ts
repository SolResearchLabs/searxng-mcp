import { CircuitOpenError } from "./circuit-breaker.js";
import { QueueFullError, QueueTimeoutError } from "./concurrency.js";
import { LocalLoadShedError } from "./host-pressure.js";
import { ProviderHttpError } from "./provider-errors.js";

export type FetchFailureDisposition = "domain_failure" | "tier_skipped";

export interface ClassifiedFetchFailure {
  disposition: FetchFailureDisposition;
  reason: string;
}

/**
 * Decide whether a caught tier error is evidence about the target domain.
 *
 * Local admission/health controls and provider-account/API failures are not
 * domain-specific. Recording those as per-domain failures would teach the
 * routing database that a website is bad for a tier even though that URL was
 * never actually attempted by the provider.
 */
export function classifyFetchFailure(err: unknown): ClassifiedFetchFailure {
  if (err instanceof QueueFullError) {
    return { disposition: "tier_skipped", reason: "local_queue_full" };
  }
  if (err instanceof QueueTimeoutError) {
    return { disposition: "tier_skipped", reason: "local_queue_timeout" };
  }
  if (err instanceof CircuitOpenError) {
    return { disposition: "tier_skipped", reason: "provider_circuit_open" };
  }
  if (err instanceof LocalLoadShedError) {
    return {
      disposition: "tier_skipped",
      reason: `host_pressure_${err.pressure}`,
    };
  }

  // Browser Run's HTTP status is from Cloudflare's account-level API endpoint,
  // not the target website. 429, 5xx and request-level 4xx therefore describe
  // provider/service/account health or our adapter request, not whether this
  // domain works with a browser tier. Navigation/content failures that arrive
  // inside a successful API envelope remain ordinary errors and can still
  // train domain history.
  if (
    err instanceof ProviderHttpError &&
    err.provider === "cloudflare-browser-run"
  ) {
    return {
      disposition: "tier_skipped",
      reason: err.rateLimited
        ? "provider_rate_limited"
        : `provider_http_${err.status}`,
    };
  }

  return {
    disposition: "domain_failure",
    reason: err instanceof Error ? err.message : "error",
  };
}
