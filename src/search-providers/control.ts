import { CircuitBreaker } from "../circuit-breaker.js";
import { BoundedSemaphore, singleflight } from "../concurrency.js";
import {
  HostedSearchBudgetError,
  reserveHostedSearchBudget,
} from "./budget.js";
import type { HostedSearchProviderId } from "./types.js";

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

interface HostedProviderControl {
  gate: BoundedSemaphore;
  circuit: CircuitBreaker;
}

function makeControl(id: HostedSearchProviderId): HostedProviderControl {
  const prefix = id.toUpperCase();
  return {
    gate: new BoundedSemaphore(
      `${id}-search`,
      positiveInt(`${prefix}_SEARCH_MAX_IN_FLIGHT`, 2),
      positiveInt(`${prefix}_SEARCH_MAX_QUEUE`, 8),
      positiveInt(`${prefix}_SEARCH_QUEUE_TIMEOUT_MS`, 5000),
    ),
    circuit: new CircuitBreaker(`${id}-search`, {
      failureThreshold: positiveInt(
        `${prefix}_SEARCH_CIRCUIT_FAILURE_THRESHOLD`,
        3,
      ),
      cooldownMs: positiveInt(`${prefix}_SEARCH_CIRCUIT_COOLDOWN_MS`, 30_000),
      maxCooldownMs: positiveInt(
        `${prefix}_SEARCH_CIRCUIT_MAX_COOLDOWN_MS`,
        300_000,
      ),
    }),
  };
}

const controls: Record<HostedSearchProviderId, HostedProviderControl> = {
  exa: makeControl("exa"),
  parallel: makeControl("parallel"),
  tinyfish: makeControl("tinyfish"),
  brave: makeControl("brave"),
};

export function runHostedSearchProvider<T>(
  provider: HostedSearchProviderId,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const control = controls[provider];
  return singleflight(`hosted-search:${provider}:${key}`, async () => {
    // Keep known-unhealthy providers out of the queue. We check again after
    // admission because another concurrent request may open the circuit while
    // this caller is waiting for a provider slot.
    control.circuit.assertAvailable();
    return control.gate.run(async () => {
      control.circuit.assertAvailable();

      // Budget accounting sits outside circuit execution. An exhausted or
      // unverifiable hard budget is an operator-routing condition, not evidence
      // that the provider itself is unhealthy.
      const budget = await reserveHostedSearchBudget(provider);
      if (!budget.allowed) throw new HostedSearchBudgetError(provider, budget);

      return control.circuit.execute(fn);
    });
  });
}

export function hostedSearchControlSnapshot() {
  return Object.fromEntries(
    (
      Object.entries(controls) as Array<
        [HostedSearchProviderId, HostedProviderControl]
      >
    ).map(([id, control]) => [
      id,
      {
        ...control.gate.snapshot(),
        circuit: control.circuit.snapshot(),
      },
    ]),
  );
}
