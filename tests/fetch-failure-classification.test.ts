import { describe, expect, it } from "vitest";
import { CircuitOpenError } from "../src/circuit-breaker.js";
import { QueueFullError, QueueTimeoutError } from "../src/concurrency.js";
import { classifyFetchFailure } from "../src/fetch-failure-classification.js";
import { LocalLoadShedError } from "../src/host-pressure.js";
import { ProviderHttpError } from "../src/provider-errors.js";

describe("classifyFetchFailure", () => {
  it.each([
    [new QueueFullError("crawl4ai"), "local_queue_full"],
    [new QueueTimeoutError("crawl4ai"), "local_queue_timeout"],
    [new CircuitOpenError("crawl4ai", 30000), "provider_circuit_open"],
    [new LocalLoadShedError("critical", 10, 800), "host_pressure_critical"],
  ])("classifies local admission error as a tier skip", (error, reason) => {
    expect(classifyFetchFailure(error)).toEqual({
      disposition: "tier_skipped",
      reason,
    });
  });

  it("treats Cloudflare rate limiting as provider-global rather than domain failure", () => {
    const classified = classifyFetchFailure(
      new ProviderHttpError(
        "cloudflare-browser-run",
        429,
        "Cloudflare Browser Run error: rate limited",
        5000,
      ),
    );

    expect(classified).toEqual({
      disposition: "tier_skipped",
      reason: "provider_rate_limited",
    });
  });

  it("treats other Cloudflare API HTTP failures as provider-global", () => {
    expect(
      classifyFetchFailure(
        new ProviderHttpError(
          "cloudflare-browser-run",
          503,
          "Cloudflare Browser Run error: unavailable",
        ),
      ),
    ).toEqual({
      disposition: "tier_skipped",
      reason: "provider_http_503",
    });
  });

  it("keeps genuine page/provider exceptions as domain failures", () => {
    expect(classifyFetchFailure(new Error("navigation failed"))).toEqual({
      disposition: "domain_failure",
      reason: "navigation failed",
    });
  });

  it("does not hide HTTP failures from unrelated providers", () => {
    const error = new ProviderHttpError("other-provider", 500, "failed");
    expect(classifyFetchFailure(error)).toEqual({
      disposition: "domain_failure",
      reason: "failed",
    });
  });
});
