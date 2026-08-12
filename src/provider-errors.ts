export function parseRetryAfterMs(
  value: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const retryAt = Date.parse(trimmed);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - nowMs);
}

export class ProviderHttpError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}
