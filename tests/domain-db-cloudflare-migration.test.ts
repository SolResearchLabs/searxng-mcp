import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheAtomicUpdate: vi.fn(),
}));

import { cacheAtomicUpdate } from "../src/cache.js";
import type { DomainRecord } from "../src/domain-db.js";
import { recordTierAttempt } from "../src/domain-db.js";

const cacheAtomicUpdateMock = vi.mocked(cacheAtomicUpdate);

function stat(attempts: number, ok: number, fail: number) {
  return { attempts, ok, fail, window_start_ms: Date.now() };
}

describe("Cloudflare Tier-1 domain learning migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resets only legacy Firecrawl tier1 stats on the first Cloudflare attempt", async () => {
    const seed: DomainRecord = {
      schema_version: 4,
      domain: "example.com",
      first_seen: "2026-07-01T00:00:00Z",
      last_fetch: "2026-07-10T00:00:00Z",
      capabilities: {
        robots_txt: {
          present: true,
          fetched: "2026-07-10T00:00:00Z",
          allows_us: true,
        },
        seen_in_search: {
          count: 12,
          last_seen_at: "2026-07-10T00:00:00Z",
        },
      },
      tier_stats_30d: {
        tier1: stat(40, 2, 38),
        tier2: stat(7, 6, 1),
        tier3: stat(3, 3, 0),
        tier4: stat(2, 1, 1),
        github: stat(5, 5, 0),
      },
    };

    let stored = JSON.stringify(seed);
    cacheAtomicUpdateMock.mockImplementation(async (_key, _ttl, mutateFn) => {
      stored = mutateFn(stored);
    });

    await recordTierAttempt(
      "https://example.com/article",
      "tier1_cloudflare",
      "hit",
    );

    const written = JSON.parse(stored) as DomainRecord;
    expect(written.schema_version).toBe(4);
    expect(written.tier1_provider).toBe("cloudflare");
    expect(written.tier_stats_30d.tier1).toMatchObject({
      attempts: 1,
      ok: 1,
      fail: 0,
    });

    expect(written.tier_stats_30d.tier2).toMatchObject({
      attempts: 7,
      ok: 6,
      fail: 1,
    });
    expect(written.tier_stats_30d.tier3).toMatchObject({
      attempts: 3,
      ok: 3,
      fail: 0,
    });
    expect(written.tier_stats_30d.tier4).toMatchObject({
      attempts: 2,
      ok: 1,
      fail: 1,
    });
    expect(written.tier_stats_30d.github).toMatchObject({
      attempts: 5,
      ok: 5,
      fail: 0,
    });
    expect(written.capabilities.robots_txt?.allows_us).toBe(true);
    expect(written.capabilities.seen_in_search?.count).toBe(12);
    expect(written.first_seen).toBe("2026-07-01T00:00:00Z");
  });

  it("does not reset an existing Cloudflare learning window", async () => {
    const seed: DomainRecord = {
      schema_version: 4,
      domain: "example.com",
      first_seen: "2026-08-01T00:00:00Z",
      last_fetch: "2026-08-10T00:00:00Z",
      capabilities: {},
      tier_stats_30d: {
        tier1: stat(4, 3, 1),
        tier2: stat(0, 0, 0),
        tier3: stat(0, 0, 0),
        tier4: stat(0, 0, 0),
        github: stat(0, 0, 0),
      },
      tier1_provider: "cloudflare",
    };

    let stored = JSON.stringify(seed);
    cacheAtomicUpdateMock.mockImplementation(async (_key, _ttl, mutateFn) => {
      stored = mutateFn(stored);
    });

    await recordTierAttempt(
      "https://example.com/article",
      "tier1_cloudflare",
      "error",
      "timeout",
    );

    const written = JSON.parse(stored) as DomainRecord;
    expect(written.tier_stats_30d.tier1).toMatchObject({
      attempts: 5,
      ok: 3,
      fail: 2,
      last_fail_reason: "timeout",
    });
  });
});
