// ═══════════════════════════════════════════════════════════════
// PEPAGI — Web Search (DuckDuckGo, no API key required)
// ═══════════════════════════════════════════════════════════════

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Search DuckDuckGo via HTML scraping (no API key needed).
 * Parses result links and snippets from the HTML response.
 */
export async function duckduckgoSearch(query: string, maxResults = 10): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PEPAGI-AGI/0.2; +https://github.com/pepagi)",
      "Accept": "text/html",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo search failed: HTTP ${res.status}`);
  }

  const html = await res.text();
  return parseResults(html, maxResults);
}

/**
 * Parse search results from DuckDuckGo HTML response.
 * Extracts result links and snippets using regex.
 */
function parseResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Match result blocks: <a class="result__a" href="...">title</a>
  // DuckDuckGo HTML structure: each result has result__a (title+url) and result__snippet
  const resultBlockRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetBlockRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const urls: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = resultBlockRe.exec(html)) !== null && urls.length < maxResults * 2) {
    const rawUrl = match[1];
    const rawTitle = match[2];
    if (!rawUrl || !rawTitle) continue;

    // DuckDuckGo wraps URLs in redirect: //duckduckgo.com/l/?uddg=<encoded>
    const actualUrl = extractActualUrl(rawUrl);
    if (!actualUrl) continue;

    const title = stripHtml(rawTitle).trim();
    if (title) {
      urls.push({ url: actualUrl, title });
    }
  }

  const snippets: string[] = [];
  while ((match = snippetBlockRe.exec(html)) !== null) {
    snippets.push(stripHtml(match[1]).trim());
  }

  for (let i = 0; i < Math.min(urls.length, maxResults); i++) {
    results.push({
      title: urls[i].title,
      url: urls[i].url,
      snippet: snippets[i] ?? "",
    });
  }

  return results;
}

/** Extract actual URL from DuckDuckGo redirect URL */
function extractActualUrl(raw: string): string | null {
  // DuckDuckGo redirect format: /l/?uddg=<encoded-url>&...
  if (raw.includes("uddg=")) {
    const uddgMatch = /[?&]uddg=([^&]+)/.exec(raw);
    if (uddgMatch) {
      try {
        return decodeURIComponent(uddgMatch[1]);
      } catch {
        return null;
      }
    }
  }
  // Direct URL (some results are direct)
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw;
  }
  return null;
}

/** Strip HTML tags and decode common HTML entities */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
