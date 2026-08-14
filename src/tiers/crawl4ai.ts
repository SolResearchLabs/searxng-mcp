import {
  ADBLOCK_PROXY_URL,
  CRAWL4AI_API_TOKEN,
  CRAWL4AI_URL,
} from "../config.js";
import {
  preferReadability,
  runReadability,
} from "../extractors/readability.js";
import {
  type FetchTuning,
  readBoundedText,
  type TierResult,
} from "../fetch-utils.js";
import { runCrawl4ai } from "../provider-control.js";

export async function pollCrawl4aiTask(
  taskId: string,
  url: string,
  maxChars: number,
  signal: AbortSignal,
  preferFit = false,
): Promise<TierResult | null> {
  const deadline = Date.now() + 40_000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (signal.aborted) return null;

    try {
      // Observed pinned Crawl4AI 0.9.2 contract: async job status lives at
      // GET /crawl/job/{task_id} and requires Bearer auth (same credential
      // semantics as POST /crawl — attach only when the token is set). The
      // legacy /task/{id} route does not exist in 0.9.2.
      const resp = await fetch(`${CRAWL4AI_URL}/crawl/job/${taskId}`, {
        signal,
        ...(CRAWL4AI_API_TOKEN
          ? { headers: { Authorization: `Bearer ${CRAWL4AI_API_TOKEN}` } }
          : {}),
      });
      if (!resp.ok) return null;

      const data = JSON.parse(await readBoundedText(resp)) as Record<
        string,
        unknown
      >;
      if (data.status === "completed") {
        const result = data.result as Record<string, unknown> | null;
        const md = result?.markdown as Record<string, string> | null;
        const mdRaw = preferFit
          ? md?.fit_markdown || md?.raw_markdown
          : md?.raw_markdown || md?.fit_markdown;
        const text = (mdRaw ?? "").slice(0, maxChars);
        const metadata = result?.metadata as Record<string, string> | null;
        const title = metadata?.title || url;
        const html =
          typeof result?.html === "string"
            ? (result.html as string)
            : undefined;
        return text ? { title, url, text, html } : null;
      }
      if (data.status === "failed") return null;
    } catch {
      return null;
    }
  }

  return null;
}

export async function crawl4aiFetch(
  url: string,
  maxChars = 8000,
  preferFit = false,
  tuning?: FetchTuning,
): Promise<TierResult | null> {
  if (!CRAWL4AI_URL) return null;

  const controlKey = JSON.stringify([
    url,
    maxChars,
    preferFit,
    tuning?.targetSelector ?? "",
    tuning?.waitForSelector ?? "",
  ]);

  return runCrawl4ai(controlKey, async () => {
    // Start the request timeout only after the local bulkhead admits this job;
    // queue wait should not consume Crawl4AI's actual execution allowance.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);

    try {
      const crawlHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (CRAWL4AI_API_TOKEN)
        crawlHeaders.Authorization = `Bearer ${CRAWL4AI_API_TOKEN}`;
      // crawler_config is only attached when a selector is requested, so default
      // crawls send the exact same body as before. Crawl4AI honors css_selector
      // (scope extraction) and wait_for (CSS selector) natively.
      const crawlerConfig: Record<string, string> = {};
      if (tuning?.targetSelector)
        crawlerConfig.css_selector = tuning.targetSelector;
      if (tuning?.waitForSelector) {
        crawlerConfig.wait_for = `css:${tuning.waitForSelector}`;
      }
      const resp = await fetch(`${CRAWL4AI_URL}/crawl`, {
        method: "POST",
        headers: crawlHeaders,
        body: JSON.stringify({
          urls: [url],
          ...(ADBLOCK_PROXY_URL
            ? { proxy_config: { server: ADBLOCK_PROXY_URL } }
            : {}),
          ...(Object.keys(crawlerConfig).length > 0
            ? { crawler_config: crawlerConfig }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!resp.ok) return null;
      // Bounded read (2 MB cap) before JSON.parse — consistency with the rest of
      // the fetch layer; caps memory even on an unexpected oversized response.
      const data = JSON.parse(await readBoundedText(resp)) as Record<
        string,
        unknown
      >;

      // Synchronous response — results returned directly
      if (Array.isArray(data.results) && data.results.length > 0) {
        const result = data.results[0] as Record<string, unknown>;
        const md = result.markdown as Record<string, string> | null;
        const mdRaw = preferFit
          ? md?.fit_markdown || md?.raw_markdown
          : md?.raw_markdown || md?.fit_markdown;
        const text = (mdRaw ?? "").slice(0, maxChars);
        if (!text) return null;
        const metadata = result.metadata as Record<string, string> | null;
        const title = metadata?.title || url;
        const html =
          typeof result.html === "string" ? (result.html as string) : undefined;
        return { title, url, text, html };
      }

      // Asynchronous response — poll for completion while retaining this one
      // local-browser permit so another fallback cannot stampede the host.
      if (typeof data.task_id === "string") {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(data.task_id)) return null;
        return await pollCrawl4aiTask(
          data.task_id,
          url,
          maxChars,
          controller.signal,
          preferFit,
        );
      }

      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  });
}

export function applyTier2Readability(
  fetched: TierResult,
  url: string,
): TierResult {
  if (!fetched.html) return fetched;
  const readable = runReadability(fetched.html, url);
  if (preferReadability(readable, fetched) && readable) {
    return {
      ...fetched,
      title: readable.title ?? fetched.title,
      text: readable.text,
    };
  }
  return fetched;
}
