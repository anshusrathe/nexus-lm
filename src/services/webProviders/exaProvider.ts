import { requestUrl } from 'obsidian';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  publishedDate?: string;
  author?: string;
}

interface ExaSearchResponse {
  results?: Array<{
    title: string;
    url: string;
    id: string;
    publishedDate?: string;
    author?: string;
    text?: string;
    highlights?: string[];
    score?: number;
  }>;
  costDollars?: { total: number };
}

interface ExaContentsResponse {
  results?: Array<{
    title?: string;
    url: string;
    text?: string;
    highlights?: string[];
  }>;
}

export class ExaProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async search(
    query: string,
    options?: {
      numResults?: number;
      recency?: string;
      includeDomains?: string[];
      mode?: 'highlights' | 'text';
    },
  ): Promise<SearchResult[]> {
    const contents: Record<string, unknown> = {};
    if (options?.mode === 'text') {
      contents.text = { maxCharacters: 5000 };
    } else {
      contents.highlights = { maxCharacters: 2000 };
    }

    const body: Record<string, unknown> = {
      query,
      type: 'auto',
      numResults: options?.numResults ?? 5,
      contents,
    };

    if (options?.recency) {
      body.startPublishedDate = this.recencyToDate(options.recency);
    }
    if (options?.includeDomains?.length) {
      body.includeDomains = options.includeDomains;
    }

    const response = await requestUrl({
      url: 'https://api.exa.ai/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
      throw: false,
    });

    if (response.status === 402) {
      throw new Error('Exa API: Free credits may be exhausted. Check billing at https://dashboard.exa.ai');
    }
    if (response.status === 401) {
      throw new Error('Exa API: Invalid API key. Verify your key at https://dashboard.exa.ai/api-keys');
    }
    if (response.status >= 400) {
      throw new Error(`Exa API error: HTTP ${response.status}`);
    }

    const data = response.json as ExaSearchResponse;
    return (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.highlights?.[0] ?? r.text?.slice(0, 300) ?? '',
      content: r.text,
      publishedDate: r.publishedDate ?? undefined,
      author: r.author ?? undefined,
    }));
  }

  async fetchUrl(
    url: string,
    options?: { mode?: 'highlights' | 'text' },
  ): Promise<{ title: string; content: string }> {
    const body: Record<string, unknown> = { urls: [url] };
    if (options?.mode === 'highlights') {
      body.highlights = { maxCharacters: 4000 };
    } else {
      body.text = { maxCharacters: 15000 };
    }

    const response = await requestUrl({
      url: 'https://api.exa.ai/contents',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
      throw: false,
    });

    if (response.status === 402) {
      throw new Error('Exa API: Free credits may be exhausted. Check billing at https://dashboard.exa.ai');
    }
    if (response.status === 401) {
      throw new Error('Exa API: Invalid API key. Verify your key at https://dashboard.exa.ai/api-keys');
    }
    if (response.status >= 400) {
      throw new Error(`Exa API error: HTTP ${response.status}`);
    }

    const data = response.json as ExaContentsResponse;
    const result = data.results?.[0];
    if (!result) {
      throw new Error(`Exa: Could not fetch content from ${url}`);
    }

    return {
      title: result.title ?? url,
      content: result.highlights?.join('\n') ?? result.text ?? '(No content extracted)',
    };
  }

  private recencyToDate(recency: string): string {
    const now = new Date();
    switch (recency) {
      case 'day':
        return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      case 'week':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      case 'month':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      case 'year':
        return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      default:
        return '';
    }
  }
}
