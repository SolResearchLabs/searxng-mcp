import {
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_BROWSER_API_TOKEN,
  CLOUDFLARE_BROWSER_TIMEOUT_MS,
} from "../config.js";
import {
  type FetchTuning,
  readBoundedText,
  type TierResult,
  USER_AGENT,
} from "../fetch-utils.js";
import { recordHistogram } from "../observability.js";
import { runCloudflareQuickAction } from "../provider-control.js";
import { parseRetryAfterMs, ProviderHttpError } from "../provider-errors.js";

interface CloudflareApiMessage {
  code?: number;
  message?: string;
}

interface CloudflareSnapshotResponse {
  success: boolean;
  result?: {
    content?: string;
    markdown?: string;
  };
  meta?: {
    status?: number;
    title?: string;
  };
  errors?: CloudflareApiMessage[];
  messages?: CloudflareApiMessage[];
}

function targetSelectorScript(selector: string): string {
  const selectorLiteral = JSON.stringify(selector);
  return `(() => { const el = document.querySelector(${selectorLiteral}); if (!el) { document.body.replaceChildren(); return; } document.body.replaceChildren(el.cloneNode(true)); })();`;
}

function apiErrorDetail(
  data: CloudflareSnapshotResponse | null,
): string | null {
  const item = data?.errors?.[0] ?? data?.messages?.[0];
  if (!item) return null;
  if (item.message && item.code !== undefined)
    return `${item.code} ${item.message}`;
  return item.message ?? (item.code !== undefined ? String(item.code) : null);
}

export async function cloudflareSnapshot(
  url: string,
  maxChars = 8000,
  tuning?: FetchTuning,
): Promise<TierResult> {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_BROWSER_API_TOKEN) {
    throw new Error(
      "Cloudflare Browser Run is not configured (CLOUDFLARE_ACCOUNT_ID and API token required)",
    );
  }

  const controlKey = JSON.stringify([
    url,
    maxChars,
    tuning?.targetSelector ?? "",
    tuning?.waitForSelector ?? "",
  ]);

  return runCloudflareQuickAction(controlKey, async () => {
    const body: Record<string, unknown> = {
      url,
      formats: ["content", "markdown"],
      userAgent: USER_AGENT,
    };

    if (tuning?.waitForSelector) {
      body.waitForSelector = {
        selector: tuning.waitForSelector,
        timeout: Math.min(CLOUDFLARE_BROWSER_TIMEOUT_MS, 60_000),
      };
    }

    // Browser Run snapshot has no direct "return only this selector" option.
    // Inject a bounded script after navigation that replaces the body with the
    // requested subtree. The selector is JSON-encoded into the script rather
    // than interpolated as source, preserving fetch_url's existing
    // target_selector semantics without creating an injection primitive.
    if (tuning?.targetSelector) {
      body.addScriptTag = [
        { content: targetSelectorScript(tuning.targetSelector) },
      ];
    }

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      CLOUDFLARE_ACCOUNT_ID,
    )}/browser-rendering/snapshot`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CLOUDFLARE_BROWSER_API_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CLOUDFLARE_BROWSER_TIMEOUT_MS),
    });

    const browserMsHeader = res.headers.get("X-Browser-Ms-Used");
    if (browserMsHeader !== null) {
      const browserMs = Number(browserMsHeader);
      if (Number.isFinite(browserMs) && browserMs >= 0) {
        recordHistogram("browser", browserMs / 1000, {
          provider: "cloudflare",
          action: "snapshot",
        });
      }
    }

    const raw = await readBoundedText(res);
    let data: CloudflareSnapshotResponse | null = null;
    try {
      data = JSON.parse(raw) as CloudflareSnapshotResponse;
    } catch {
      if (res.ok) {
        throw new Error("Cloudflare Browser Run returned invalid JSON");
      }
    }

    if (!res.ok) {
      const detail = apiErrorDetail(data) ?? `${res.status} ${res.statusText}`;
      throw new ProviderHttpError(
        "cloudflare-browser-run",
        res.status,
        `Cloudflare Browser Run error: ${detail}`,
        parseRetryAfterMs(res.headers.get("Retry-After")),
      );
    }

    if (!data?.success || !data.result) {
      throw new Error(
        apiErrorDetail(data) ??
          "Cloudflare Browser Run returned no snapshot data",
      );
    }

    const text = (data.result.markdown ?? "").slice(0, maxChars);
    const html = data.result.content;
    const title = data.meta?.title || url;

    return { title, url, text, html };
  });
}
