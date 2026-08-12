import { describe, expect, it, vi } from "vitest";
import {
  classifyHostPressure,
  HostPressureMonitor,
  type HostPressureOptions,
  parseProcMeminfo,
} from "../src/host-pressure.js";

const GiB = 1024 ** 3;

function options(
  overrides?: Partial<HostPressureOptions>,
): HostPressureOptions {
  return {
    enabled: true,
    softAvailablePercent: 25,
    hardAvailablePercent: 15,
    hardAvailableMb: 1024,
    sampleTtlMs: 1000,
    ...overrides,
  };
}

describe("parseProcMeminfo", () => {
  it("uses MemAvailable instead of MemFree", () => {
    const parsed = parseProcMeminfo(`
MemTotal:       16384000 kB
MemFree:          200000 kB
MemAvailable:    9216000 kB
Buffers:          100000 kB
`);

    expect(parsed).not.toBeNull();
    expect(parsed?.totalBytes).toBe(16_384_000 * 1024);
    expect(parsed?.availableBytes).toBe(9_216_000 * 1024);
    expect(parsed?.source).toBe("proc_meminfo");
  });

  it("returns null when required fields are missing", () => {
    expect(parseProcMeminfo("MemTotal: 1000 kB\n")).toBeNull();
  });
});

describe("classifyHostPressure", () => {
  it("classifies comfortable memory as normal", () => {
    const result = classifyHostPressure(
      { totalBytes: 16 * GiB, availableBytes: 9 * GiB, source: "node_os" },
      options(),
      100,
    );
    expect(result.state).toBe("normal");
    expect(result.availablePercent).toBeCloseTo(56.25);
  });

  it("classifies below the soft percentage as degraded", () => {
    const result = classifyHostPressure(
      { totalBytes: 16 * GiB, availableBytes: 3 * GiB, source: "node_os" },
      options(),
    );
    expect(result.state).toBe("degraded");
  });

  it("classifies below the hard percentage as critical", () => {
    const result = classifyHostPressure(
      {
        totalBytes: 16 * GiB,
        availableBytes: 2 * GiB,
        source: "node_os",
      },
      options(),
    );
    expect(result.state).toBe("critical");
  });

  it("classifies below the absolute MiB floor as critical", () => {
    const result = classifyHostPressure(
      {
        totalBytes: 4 * GiB,
        availableBytes: 900 * 1024 ** 2,
        source: "node_os",
      },
      options(),
    );
    expect(result.availablePercent).toBeGreaterThan(15);
    expect(result.state).toBe("critical");
  });

  it("reports normal when pressure enforcement is disabled", () => {
    const result = classifyHostPressure(
      {
        totalBytes: 16 * GiB,
        availableBytes: 500 * 1024 ** 2,
        source: "node_os",
      },
      options({ enabled: false }),
    );
    expect(result.enabled).toBe(false);
    expect(result.state).toBe("normal");
  });
});

describe("HostPressureMonitor", () => {
  it("caches host sampling for the configured TTL", () => {
    const sampler = vi.fn(() => ({
      totalBytes: 16 * GiB,
      availableBytes: 8 * GiB,
      source: "node_os" as const,
    }));
    const monitor = new HostPressureMonitor(
      options({ sampleTtlMs: 1000 }),
      sampler,
    );

    expect(monitor.snapshot(1000).state).toBe("normal");
    expect(monitor.snapshot(1500).state).toBe("normal");
    expect(sampler).toHaveBeenCalledTimes(1);

    monitor.snapshot(2000);
    expect(sampler).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid threshold ordering", () => {
    expect(
      () =>
        new HostPressureMonitor(
          options({ softAvailablePercent: 10, hardAvailablePercent: 15 }),
          () => ({
            totalBytes: 16 * GiB,
            availableBytes: 8 * GiB,
            source: "node_os",
          }),
        ),
    ).toThrow("softAvailablePercent");
  });
});
