export function siteList(site?: string | string[]): string[] {
  if (!site) return [];
  return (Array.isArray(site) ? site : [site])
    .map((value) => value.trim())
    .filter(Boolean);
}

export function timeRangeStartIso(
  timeRange: string | undefined,
  now = new Date(),
): string | undefined {
  if (!timeRange) return undefined;
  const start = new Date(now);
  switch (timeRange) {
    case "day":
      start.setUTCDate(start.getUTCDate() - 1);
      break;
    case "week":
      start.setUTCDate(start.getUTCDate() - 7);
      break;
    case "month":
      start.setUTCMonth(start.getUTCMonth() - 1);
      break;
    case "year":
      start.setUTCFullYear(start.getUTCFullYear() - 1);
      break;
    default:
      return undefined;
  }
  return start.toISOString();
}

export function braveFreshness(timeRange?: string): string | undefined {
  switch (timeRange) {
    case "day":
      return "pd";
    case "week":
      return "pw";
    case "month":
      return "pm";
    case "year":
      return "py";
    default:
      return undefined;
  }
}

export function clampResults(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value)));
}
