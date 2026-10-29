import type { SearxResult } from "./types.js";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "or",
  "please",
  "search",
  "the",
  "to",
  "up",
  "with",
]);

export function queryTerms(query: string): string[] {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [
    ...new Set(
      tokens.filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
    ),
  ];
}

function searchableText(result: SearxResult): string {
  return `${result.title ?? ""} ${result.content ?? ""} ${result.url ?? ""}`.toLowerCase();
}

export function queryOverlapCount(query: string, result: SearxResult): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const haystack = searchableText(result);
  let count = 0;
  for (const term of terms) {
    if (haystack.includes(term)) count += 1;
  }
  return count;
}

export function hasQueryRelevantResult(
  query: string,
  results: SearxResult[],
): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0 || results.length === 0) return true;
  const requiredMatches = terms.length >= 6 ? 2 : 1;
  return results.some(
    (result) => queryOverlapCount(query, result) >= requiredMatches,
  );
}

export function lexicalRerank(
  query: string,
  results: SearxResult[],
  topN: number,
): SearxResult[] {
  const terms = queryTerms(query);
  if (results.length === 0 || terms.length === 0) return results.slice(0, topN);

  const scored = results.map((result, index) => {
    const title = (result.title ?? "").toLowerCase();
    const content = (result.content ?? "").toLowerCase();
    const url = (result.url ?? "").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 5;
      if (url.includes(term)) score += 3;
      if (content.includes(term)) score += 1;
    }
    return { result, index, score };
  });

  if (scored.every(({ score }) => score === 0)) return results.slice(0, topN);

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, topN).map(({ result }) => result);
}
