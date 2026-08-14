import { beforeEach, describe, expect, it, vi } from "vitest";

// Mutable holder so tests exercise both token-present and token-absent poll
// auth. vi.hoisted runs before the hoisted vi.mock factory below.
const token = vi.hoisted(() => ({ value: undefined as string | undefined }));

// vi.mock is hoisted — runs before imports, so CRAWL4AI_URL is set correctly.
// The getter keeps CRAWL4AI_API_TOKEN a live binding the adapter reads at
// request-build time, so each test can control poll auth individually.
vi.mock("../../src/config.js", () => ({
  CRAWL4AI_URL: "http://crawl4ai:8000",
  get CRAWL4AI_API_TOKEN() {
    return token.value;
  },
  ADBLOCK_PROXY_URL: null,
}));

// Adapter tests cover Crawl4AI request/response mapping. Circuit and bulkhead
// behavior is tested separately so null/error adapter fixtures do not share
// provider-health state across test cases.
vi.mock("../../src/provider-control.js", () => ({
  runCrawl4ai: async <T>(_key: string, fn: () => Promise<T>): Promise<T> =>
    fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { crawl4aiFetch, pollCrawl4aiTask } from "../../src/tiers/crawl4ai.js";

beforeEach(() => {
  token.value = undefined;
  vi.clearAllMocks();
});

const URL = "https://example.com/page";

// Real Response so crawl4aiFetch's readBoundedText(resp) has a body to read.
const syncResponse = (text = "# Page Content\n\nSome text") =>
  new Response(
    JSON.stringify({
      results: [
        {
          markdown: { raw_markdown: text },
          metadata: { title: "Page Title" },
          html: "<p>html</p>",
        },
      ],
    }),
    { status: 200 },
  );

describe("crawl4aiFetch", () => {
  it("returns result immediately on synchronous response", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse());
    const result = await crawl4aiFetch(URL);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Page Title");
    expect(result?.text).toContain("Some text");
  });

  it("truncates text to maxChars", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse("abcdefghij"));
    const result = await crawl4aiFetch(URL, 3);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("abc");
  });

  it("returns null when sync result has empty markdown", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse(""));
    const result = await crawl4aiFetch(URL);
    expect(result).toBeNull();
  });

  it("returns null for invalid task_id format (path traversal guard)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ task_id: "../../etc/passwd" }), {
        status: 200,
      }),
    );
    const result = await crawl4aiFetch(URL);
    expect(result).toBeNull();
  });

  it("polls GET /crawl/job/{task_id} when /crawl returns a task_id (pinned 0.9.2 contract)", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task_id: "crawl_abc123" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            result: {
              markdown: { raw_markdown: "async page content" },
              metadata: { title: "Async Page" },
              html: "<p>async</p>",
            },
          }),
          { status: 200 },
        ),
      );

    vi.useFakeTimers();
    const promise = crawl4aiFetch(URL);
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    vi.useRealTimers();

    const pollCall = mockFetch.mock.calls[1];
    expect(String(pollCall[0])).toBe(
      "http://crawl4ai:8000/crawl/job/crawl_abc123",
    );
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Async Page");
    expect(result?.text).toBe("async page content");
  });

  it("returns null when response is not-ok", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({}),
    });
    const result = await crawl4aiFetch(URL);
    expect(result).toBeNull();
  });

  it("omits crawler_config from the request body by default", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse());
    await crawl4aiFetch(URL);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.crawler_config).toBeUndefined();
  });

  it("maps selectors into crawler_config (css_selector + wait_for)", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse());
    await crawl4aiFetch(URL, 8000, false, {
      targetSelector: "main",
      waitForSelector: "#ready",
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.crawler_config).toEqual({
      css_selector: "main",
      wait_for: "css:#ready",
    });
  });
});

describe("pollCrawl4aiTask", () => {
  it("returns result when status is completed", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "completed",
          result: {
            markdown: { raw_markdown: "page content" },
            metadata: { title: "Polled Page" },
            html: null,
          },
        }),
        { status: 200 },
      ),
    );

    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = pollCrawl4aiTask("task123", URL, 8000, controller.signal);
    // Advance past the initial 2s sleep
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    vi.useRealTimers();

    expect(String(mockFetch.mock.calls[0][0])).toBe(
      "http://crawl4ai:8000/crawl/job/task123",
    );
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Polled Page");
    expect(result?.text).toBe("page content");
  });

  it("sends Bearer auth on the poll when CRAWL4AI_API_TOKEN is set", async () => {
    token.value = "secret-token";
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "completed",
          result: {
            markdown: { raw_markdown: "auth content" },
            metadata: { title: "Auth Page" },
            html: null,
          },
        }),
        { status: 200 },
      ),
    );

    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = pollCrawl4aiTask("task123", URL, 8000, controller.signal);
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    vi.useRealTimers();

    const [, init] = mockFetch.mock.calls[0];
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      "http://crawl4ai:8000/crawl/job/task123",
    );
    expect(init.headers).toEqual({ Authorization: "Bearer secret-token" });
    expect(result?.title).toBe("Auth Page");
  });

  it("sends no Authorization header on the poll when token is absent", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "completed",
          result: {
            markdown: { raw_markdown: "noauth content" },
            metadata: { title: "NoAuth Page" },
            html: null,
          },
        }),
        { status: 200 },
      ),
    );

    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = pollCrawl4aiTask("task123", URL, 8000, controller.signal);
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    vi.useRealTimers();

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers).toBeUndefined();
    expect(result?.title).toBe("NoAuth Page");
  });

  it("returns null when status is failed", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "failed" }), { status: 200 }),
    );

    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = pollCrawl4aiTask("task123", URL, 8000, controller.signal);
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    vi.useRealTimers();

    expect(result).toBeNull();
  });

  it("returns null when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const promise = pollCrawl4aiTask("task123", URL, 8000, controller.signal);
    // abort check runs after the 2s sleep, so advance past it
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    vi.useRealTimers();
    expect(result).toBeNull();
  });
});
