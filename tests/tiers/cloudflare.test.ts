import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { recordHistogram } = vi.hoisted(() => ({
  recordHistogram: vi.fn(),
}));
vi.mock("../../src/observability.js", () => ({ recordHistogram }));

vi.mock("../../src/config.js", () => ({
  CLOUDFLARE_ACCOUNT_ID: "acct-test",
  CLOUDFLARE_BROWSER_API_TOKEN: "token-test",
  CLOUDFLARE_BROWSER_TIMEOUT_MS: 30_000,
}));

// Adapter tests validate Cloudflare request/response mapping. Provider bulkheads,
// rate limiting and singleflight have their own focused tests.
vi.mock("../../src/provider-control.js", () => ({
  runCloudflareQuickAction: async <T>(
    _key: string,
    fn: () => Promise<T>,
  ): Promise<T> => fn(),
}));

import { cloudflareSnapshot } from "../../src/tiers/cloudflare.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const URL = "https://example.com/page";

function mockSuccess(overrides?: {
  result?: { content?: string; markdown?: string };
  meta?: { title?: string; status?: number };
}) {
  return new Response(
    JSON.stringify({
      success: true,
      result: {
        content: "<html><body><h1>Title</h1><p>Content here</p></body></html>",
        markdown: "# Title\n\nContent here",
        ...overrides?.result,
      },
      meta: {
        title: "Title",
        status: 200,
        ...overrides?.meta,
      },
      errors: [],
      messages: [],
    }),
    {
      status: 200,
      headers: { "X-Browser-Ms-Used": "1234" },
    },
  );
}

describe("cloudflareSnapshot", () => {
  it("returns title, url, markdown text, and rendered HTML", async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    const result = await cloudflareSnapshot(URL);

    expect(result.title).toBe("Title");
    expect(result.url).toBe(URL);
    expect(result.text).toContain("Content here");
    expect(result.html).toContain("<h1>Title</h1>");
  });

  it("uses the snapshot endpoint with content + markdown formats", async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await cloudflareSnapshot(URL);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-test/browser-rendering/snapshot",
    );
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer token-test",
    });
    const body = JSON.parse(String(options.body));
    expect(body.url).toBe(URL);
    expect(body.formats).toEqual(["content", "markdown"]);
    expect(body.userAgent).toContain("searxng-mcp/");
  });

  it("truncates markdown to maxChars", async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    const result = await cloudflareSnapshot(URL, 5);

    expect(result.text).toHaveLength(5);
  });

  it("records Cloudflare browser milliseconds when the header is present", async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await cloudflareSnapshot(URL);

    expect(recordHistogram).toHaveBeenCalledWith("browser", 1.234, {
      provider: "cloudflare",
      action: "snapshot",
    });
  });

  it("does not record browser time for a missing or invalid header", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          result: { content: "<p>x</p>", markdown: "x" },
          meta: { title: "x" },
        }),
        { status: 200 },
      ),
    );

    await cloudflareSnapshot(URL);

    expect(recordHistogram).not.toHaveBeenCalled();
  });

  it("surfaces Cloudflare API error details on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 2001, message: "Rate limit exceeded" }],
        }),
        { status: 429, statusText: "Too Many Requests" },
      ),
    );

    await expect(cloudflareSnapshot(URL)).rejects.toThrow(
      "Cloudflare Browser Run error: 2001 Rate limit exceeded",
    );
  });

  it("throws when a successful HTTP response has no snapshot result", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, errors: [] }), {
        status: 200,
      }),
    );

    await expect(cloudflareSnapshot(URL)).rejects.toThrow(
      "Cloudflare Browser Run returned no snapshot data",
    );
  });

  it("throws when Cloudflare returns invalid JSON", async () => {
    mockFetch.mockResolvedValueOnce(new Response("not-json", { status: 200 }));

    await expect(cloudflareSnapshot(URL)).rejects.toThrow(
      "Cloudflare Browser Run returned invalid JSON",
    );
  });

  it("returns empty text when markdown is empty so the tier wrapper can fall through", async () => {
    mockFetch.mockResolvedValueOnce(
      mockSuccess({ result: { markdown: "", content: "<p>x</p>" } }),
    );

    const result = await cloudflareSnapshot(URL);

    expect(result.text).toBe("");
  });

  it("falls back to the requested URL when Cloudflare has no title", async () => {
    mockFetch.mockResolvedValueOnce(
      mockSuccess({ meta: { title: "", status: 200 } }),
    );

    const result = await cloudflareSnapshot(URL);

    expect(result.title).toBe(URL);
  });

  it("omits selector tuning fields by default", async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await cloudflareSnapshot(URL);

    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body));
    expect(body.waitForSelector).toBeUndefined();
    expect(body.addScriptTag).toBeUndefined();
  });

  it("maps wait_for_selector and target_selector to Browser Run options", async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await cloudflareSnapshot(URL, 8000, {
      targetSelector: 'article[data-kind="main"]',
      waitForSelector: ".loaded",
    });

    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body));
    expect(body.waitForSelector).toEqual({
      selector: ".loaded",
      timeout: 30_000,
    });
    expect(body.addScriptTag).toHaveLength(1);
    expect(body.addScriptTag[0].content).toContain(
      'document.querySelector("article[data-kind=\\"main\\"]")',
    );
  });
});
