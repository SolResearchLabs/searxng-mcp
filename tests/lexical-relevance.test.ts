import { describe, expect, it } from "vitest";
import {
  hasQueryRelevantResult,
  lexicalRerank,
  queryOverlapCount,
} from "../src/lexical-relevance.js";

const result = (title: string, url: string, content = "") => ({
  title,
  url,
  content,
  engine: "bing",
  engines: ["bing"],
});

describe("lexical relevance fallback", () => {
  const query =
    "BCREA British Columbia Real Estate Association rules regulations";

  const sports = [
    result(
      "News, Scores and Live Streaming - Sportsnet.ca",
      "https://www.sportsnet.ca/",
    ),
    result(
      "NHL News, Scores and Highlights",
      "https://www.sportsnet.ca/hockey/nhl/",
    ),
    result(
      "MLB News, Scores and Highlights",
      "https://www.sportsnet.ca/baseball/mlb/",
    ),
    result("Sportsnet - Curling", "https://watch.sportsnet.ca/curling"),
  ];

  const bcrea = result(
    "BCREA - British Columbia Real Estate Association",
    "https://www.bcrea.bc.ca/",
    "BCREA is the provincial association for BC REALTORS.",
  );

  it("rejects the exact off-topic Sportsnet result shape from the production incident", () => {
    expect(hasQueryRelevantResult(query, sports)).toBe(false);
  });

  it("accepts an actually relevant BCREA result", () => {
    expect(queryOverlapCount(query, bcrea)).toBeGreaterThanOrEqual(2);
    expect(hasQueryRelevantResult(query, [bcrea, ...sports])).toBe(true);
  });

  it("lexically reranks relevant results ahead of raw Bing noise", () => {
    const ranked = lexicalRerank(query, [...sports, bcrea], 5);
    expect(ranked[0].url).toBe("https://www.bcrea.bc.ca/");
  });

  it("preserves original order when the query has no usable lexical signal", () => {
    const ranked = lexicalRerank("a to of", sports, 3);
    expect(ranked.map((item) => item.url)).toEqual(
      sports.slice(0, 3).map((item) => item.url),
    );
  });
});
