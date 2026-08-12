import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";

export type HostPressureState = "normal" | "degraded" | "critical";

export interface HostMemorySnapshot {
  totalBytes: number;
  availableBytes: number;
  source: "proc_meminfo" | "node_os";
}

export interface HostPressureSnapshot extends HostMemorySnapshot {
  enabled: boolean;
  state: HostPressureState;
  availablePercent: number;
  availableMb: number;
  sampledAtMs: number;
}

export interface HostPressureOptions {
  enabled: boolean;
  softAvailablePercent: number;
  hardAvailablePercent: number;
  hardAvailableMb: number;
  sampleTtlMs: number;
}

export class LocalLoadShedError extends Error {
  constructor(
    public readonly pressure: HostPressureState,
    public readonly availablePercent: number,
    public readonly availableMb: number,
  ) {
    super(
      `local host pressure is ${pressure} (${availablePercent.toFixed(1)}% / ${availableMb.toFixed(0)} MiB available)`,
    );
    this.name = "LocalLoadShedError";
  }
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function parseProcMeminfo(raw: string): HostMemorySnapshot | null {
  const values = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB\s*$/.exec(line);
    if (!match) continue;
    values.set(match[1], Number(match[2]) * 1024);
  }

  const totalBytes = values.get("MemTotal");
  const availableBytes = values.get("MemAvailable");
  if (
    !Number.isFinite(totalBytes) ||
    !Number.isFinite(availableBytes) ||
    !totalBytes ||
    availableBytes === undefined
  ) {
    return null;
  }

  return {
    totalBytes,
    availableBytes: Math.min(totalBytes, Math.max(0, availableBytes)),
    source: "proc_meminfo",
  };
}

export function readHostMemorySnapshot(): HostMemorySnapshot {
  if (process.platform === "linux") {
    try {
      const parsed = parseProcMeminfo(readFileSync("/proc/meminfo", "utf8"));
      if (parsed) return parsed;
    } catch {
      // Fall back to node:os below. Host-pressure sampling must never crash the
      // provider router merely because /proc is unavailable in a sandbox.
    }
  }

  const totalBytes = Math.max(1, totalmem());
  const availableBytes = Math.min(totalBytes, Math.max(0, freemem()));
  return { totalBytes, availableBytes, source: "node_os" };
}

export function classifyHostPressure(
  memory: HostMemorySnapshot,
  options: HostPressureOptions,
  sampledAtMs = Date.now(),
): HostPressureSnapshot {
  const availablePercent = (memory.availableBytes / memory.totalBytes) * 100;
  const availableMb = memory.availableBytes / (1024 * 1024);

  let state: HostPressureState = "normal";
  if (
    availablePercent <= options.hardAvailablePercent ||
    availableMb <= options.hardAvailableMb
  ) {
    state = "critical";
  } else if (availablePercent <= options.softAvailablePercent) {
    state = "degraded";
  }

  return {
    ...memory,
    enabled: options.enabled,
    state: options.enabled ? state : "normal",
    availablePercent,
    availableMb,
    sampledAtMs,
  };
}

export class HostPressureMonitor {
  private cached: HostPressureSnapshot | null = null;

  constructor(
    public readonly options: HostPressureOptions,
    private readonly sampler: () => HostMemorySnapshot = readHostMemorySnapshot,
  ) {
    if (
      options.hardAvailablePercent <= 0 ||
      options.hardAvailablePercent >= 100
    ) {
      throw new Error("hardAvailablePercent must be between 0 and 100");
    }
    if (
      options.softAvailablePercent <= options.hardAvailablePercent ||
      options.softAvailablePercent >= 100
    ) {
      throw new Error(
        "softAvailablePercent must be above hardAvailablePercent and below 100",
      );
    }
    if (options.hardAvailableMb <= 0)
      throw new Error("hardAvailableMb must be positive");
    if (options.sampleTtlMs <= 0)
      throw new Error("sampleTtlMs must be positive");
  }

  snapshot(nowMs = Date.now()): HostPressureSnapshot {
    if (
      this.cached &&
      nowMs - this.cached.sampledAtMs < this.options.sampleTtlMs
    ) {
      return this.cached;
    }

    this.cached = classifyHostPressure(this.sampler(), this.options, nowMs);
    return this.cached;
  }
}

export const crawl4aiHostPressure = new HostPressureMonitor({
  enabled: booleanEnv("CRAWL4AI_HOST_PRESSURE_ENABLED", true),
  softAvailablePercent: positiveNumber(
    "CRAWL4AI_HOST_PRESSURE_SOFT_AVAILABLE_PERCENT",
    25,
  ),
  hardAvailablePercent: positiveNumber(
    "CRAWL4AI_HOST_PRESSURE_HARD_AVAILABLE_PERCENT",
    15,
  ),
  hardAvailableMb: positiveNumber(
    "CRAWL4AI_HOST_PRESSURE_HARD_AVAILABLE_MB",
    1024,
  ),
  sampleTtlMs: positiveNumber("CRAWL4AI_HOST_PRESSURE_SAMPLE_TTL_MS", 1000),
});
