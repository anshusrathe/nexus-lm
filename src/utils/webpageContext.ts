import { Notice } from 'obsidian';

export interface WebpageFetcher {
  fetchUrl(url: string, options?: { mode?: 'highlights' | 'text' }): Promise<{ title: string; content: string }>;
}

export interface WebpageContextResult {
  context: string;
  fetched: number;
  total: number;
}

const DEFAULT_MAX_CHARS_PER_PAGE = 5000;

export function isGeminiOrOllama(provider: string): boolean {
  return provider === 'gemini' || provider === 'ollama';
}

/**
 * Fetches web pages (HTML or online PDFs) via the plugin's requestUrl-based
 * NativeFetchProvider and formats them into a context block for the system prompt.
 * PDFs are parsed in-memory with PDF.js — never downloaded to the vault.
 */
export async function buildWebpageContext(
  fetcher: WebpageFetcher,
  urls: string[],
  options?: { maxCharsPerPage?: number }
): Promise<WebpageContextResult> {
  const maxChars = options?.maxCharsPerPage ?? DEFAULT_MAX_CHARS_PER_PAGE;
  const fetchedPages: { url: string; title: string; content: string }[] = [];
  const failedUrls: string[] = [];

  for (const url of urls) {
    try {
      const page = await fetcher.fetchUrl(url, { mode: 'highlights' });
      if (page.content && page.content.trim().length > 0) {
        fetchedPages.push({ url, title: page.title, content: page.content });
      } else {
        failedUrls.push(url);
      }
    } catch (err: unknown) {
      failedUrls.push(url);
      console.warn(`[NexusLM] Webpage fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (fetchedPages.length === 0) {
    return { context: '', fetched: 0, total: urls.length };
  }

  let context = '\n\n--- Web Pages ---\n\n';
  fetchedPages.forEach((page, index) => {
    context += `--- Web Page [${index + 1}]: ${page.title} (${page.url}) ---\n`;
    context += `${page.content.substring(0, maxChars)}\n\n`;
  });

  if (failedUrls.length > 0) {
    new Notice(
      `Failed to fetch ${failedUrls.length} webpage(s): ${failedUrls.slice(0, 3).join(', ')}${failedUrls.length > 3 ? '...' : ''}`
    );
  }

  return { context, fetched: fetchedPages.length, total: urls.length };
}
