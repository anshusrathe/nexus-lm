import { ExaProvider, type SearchResult as ExaSearchResult } from './webProviders/exaProvider';
import { ExaMCPProvider, type SearchResult as MCPResult } from './webProviders/exaMCPProvider';
import { NativeFetchProvider } from './webProviders/nativeFetchProvider';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  publishedDate?: string;
  author?: string;
}

export interface WebSearchConfig {
  exaApiKey: string;
  defaultNumResults: number;
  contentMode: 'highlights' | 'text';
  cacheEnabled: boolean;
  tokenBudget: 'low' | 'medium' | 'high';
}

export interface SearchOptions {
  numResults?: number;
  recency?: string;
  includeDomains?: string[];
  mode?: 'highlights' | 'text';
  tokenBudget?: 'low' | 'medium' | 'high';
}

export interface FetchOptions {
  mode?: 'highlights' | 'text';
}

const TOKEN_BUDGETS: Record<string, { maxSnippetChars: number; maxTotalChars: number }> = {
  low: { maxSnippetChars: 2000, maxTotalChars: 4000 },
  medium: { maxSnippetChars: 8000, maxTotalChars: 16000 },
  high: { maxSnippetChars: 20000, maxTotalChars: 40000 },
};

interface CacheEntry {
  results: SearchResult[];
  timestamp: number;
}

class SearchCache {
  private store = new Map<string, CacheEntry>();
  private maxEntries = 50;
  private ttlMs: number;

  constructor(ttlMinutes = 15) {
    this.ttlMs = ttlMinutes * 60 * 1000;
  }

  get(key: string): SearchResult[] | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    return entry.results;
  }

  set(key: string, results: SearchResult[]): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.entries().next().value;
      if (oldest) this.store.delete(oldest[0]);
    }
    this.store.set(key, { results, timestamp: Date.now() });
  }

  clear(): void {
    this.store.clear();
  }
}

export class WebSearchService {
  private nativeProvider: NativeFetchProvider;
  private exaProvider: ExaProvider | null = null;
  private mcpProvider: ExaMCPProvider;
  private cache: SearchCache;
  private config: WebSearchConfig;

  constructor(config: WebSearchConfig) {
    this.config = config;
    this.nativeProvider = new NativeFetchProvider();
    if (config.exaApiKey) {
      this.exaProvider = new ExaProvider(config.exaApiKey);
    }
    this.mcpProvider = new ExaMCPProvider();
    this.cache = new SearchCache(15);
  }

  updateApiKey(apiKey: string): void {
    this.config.exaApiKey = apiKey;
    if (apiKey) {
      this.exaProvider = new ExaProvider(apiKey);
    } else {
      this.exaProvider = null;
    }
    this.cache.clear();
  }

  get hasApiKey(): boolean {
    return !!this.config.exaApiKey;
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const effectiveOptions: SearchOptions = {
      numResults: options?.numResults ?? this.config.defaultNumResults,
      mode: options?.mode ?? this.config.contentMode,
      tokenBudget: options?.tokenBudget ?? this.config.tokenBudget,
      recency: options?.recency,
      includeDomains: options?.includeDomains,
    };

    const cacheKey = this.buildCacheKey(query, effectiveOptions);
    if (this.config.cacheEnabled) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    let results: SearchResult[];

    if (this.exaProvider) {
      const exaResults = await this.exaProvider.search(query, {
        numResults: effectiveOptions.numResults,
        recency: effectiveOptions.recency,
        includeDomains: effectiveOptions.includeDomains,
        mode: effectiveOptions.mode,
      });
      results = exaResults.map((r: ExaSearchResult) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        content: r.content,
        publishedDate: r.publishedDate,
        author: r.author,
      }));
    } else {
      console.log('[WebSearch] Using Exa MCP fallback for query="' + query + '"');
      const mcpResults = await this.mcpProvider.search(query, {
        numResults: effectiveOptions.numResults,
      });
      console.log('[WebSearch] Exa MCP returned ' + mcpResults.length + ' results');
      if (mcpResults.length > 0) {
        console.log('[WebSearch] First result: title="' + mcpResults[0].title + '" url="' + mcpResults[0].url + '"');
      }
      results = mcpResults.map((r: MCPResult) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        content: r.content,
      }));
    }

    results = this.filterByTokenBudget(results, effectiveOptions.tokenBudget ?? 'medium');

    if (this.config.cacheEnabled) {
      this.cache.set(cacheKey, results);
    }

    return results;
  }

  async fetchUrl(url: string, options?: FetchOptions): Promise<{ title: string; content: string }> {
    try {
      const nativeResult = await this.nativeProvider.fetchUrl(url);
      if (nativeResult.content && nativeResult.content.length >= 20) {
        return nativeResult;
      }
      console.warn(`[WebSearch] Native fetch returned minimal content for ${url}. Attempting Exa fallback.`);
    } catch (nativeErr: any) {
      console.warn(
        `[WebSearch] Native fetch failed for ${url}: ${nativeErr?.message || String(nativeErr)}. Attempting Exa fallback.`
      );
    }

    try {
      if (this.exaProvider) {
        return await this.exaProvider.fetchUrl(url, {
          mode: options?.mode ?? this.config.contentMode,
        });
      }
      return await this.mcpProvider.fetchUrl(url);
    } catch (exaErr: any) {
      console.error(`[WebSearch] Exa fallback fetch failed for ${url}: ${exaErr?.message || String(exaErr)}`);
      throw new Error(
        `Failed to fetch content from ${url}. Primary (Native Fetch) and Fallback (Exa) both failed: ${
          exaErr?.message || String(exaErr)
        }`
      );
    }
  }

  private filterByTokenBudget(results: SearchResult[], budget: 'low' | 'medium' | 'high'): SearchResult[] {
    const limits = TOKEN_BUDGETS[budget];
    let snippetTotal = 0;
    const filtered: SearchResult[] = [];

    for (const r of results) {
      const snippetCost = r.snippet.length;
      const totalCost = snippetCost + (r.content?.length ?? 0);

      if (snippetTotal + totalCost > limits.maxTotalChars && filtered.length > 0) {
        break;
      }

      snippetTotal += snippetCost;
      filtered.push(r);
    }

    return filtered;
  }

  private buildCacheKey(query: string, options: SearchOptions): string {
    const parts = [
      query.toLowerCase().trim(),
      String(options.numResults),
      options.mode ?? 'highlights',
      options.tokenBudget ?? 'medium',
      options.recency ?? '',
      (options.includeDomains ?? []).join(','),
      this.hasApiKey ? 'exa' : 'mcp',
    ];
    return parts.join('|');
  }
}
