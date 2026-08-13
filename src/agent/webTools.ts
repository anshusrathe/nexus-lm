import type { ToolHandler } from './toolRegistry';
import type { WebSearchService } from '../services/webSearchService';

export function createWebSearchTool(webSearch: WebSearchService): ToolHandler {
  return {
    definition: {
      name: 'web_search',
      description: 'SEARCH THE WEB for real-time information, news, documentation, facts, current events, weather, sports scores, stock prices, or any online content. Returns results with titles, URLs, and content excerpts. Tool name: web_search (underscore). Use this when: (1) user asks to search the web, look up online, check current info, (2) task requires real-time or recent data, (3) user provides a search query. Do NOT make up answers for current information — always use this tool.',
      category: 'plugin',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query. Be specific and natural language. Example: "weather in Tokyo today" or "React hooks documentation".',
          },
          numResults: {
            type: 'number',
            default: 5,
            description: 'Number of results to return (1-10). Default 5.',
          },
          recency: {
            type: 'string',
            enum: ['any', 'day', 'week', 'month', 'year'],
            description: 'Time filter: only return results published within this period.',
          },
          includeDomains: {
            type: 'string',
            description: 'Comma-separated list of domains to restrict results to (e.g., "docs.python.org,github.com").',
          },
          contextSize: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            default: 'medium',
            description: 'Token budget for results. Low=~500 tok, Medium=~2K tok, High=~5K tok.',
          },
        },
        required: ['query'],
      },
      needsApproval: true,
    },
    execute: async (args, deps) => {
      const query = String(args.query ?? '');
      const numResults = Number(args.numResults ?? 5);
      const contextSize = String(args.contextSize ?? 'medium') as 'low' | 'medium' | 'high';
      const recency = String(args.recency ?? '');
      const domains = String(args.includeDomains ?? '');

      deps.onEvent({
        type: 'tool_call',
        data: { toolName: 'web_search', args },
        timestamp: Date.now(),
      });

      const results = await webSearch.search(query, {
        numResults,
        recency: recency || undefined,
        includeDomains: domains ? domains.split(',').map((d) => d.trim()).filter(Boolean) : undefined,
        tokenBudget: contextSize,
      });

      if (results.length === 0) {
        return 'No search results found. Please try a different query.';
      }

      let output = `Web search results for "${query}":\n\n`;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        output += `[${i + 1}] ${r.title}\n`;
        output += `    URL: ${r.url}\n`;
        if (r.publishedDate) output += `    Date: ${r.publishedDate}\n`;
        output += `    ${r.snippet}\n\n`;
      }

      return output;
    },
  };
}

export function createWebFetchTool(webSearch: WebSearchService): ToolHandler {
  return {
    definition: {
      name: 'webfetch',
      description: 'FETCH AND READ the content of a specific URL. Returns the page text or relevant excerpts. Tool name: webfetch (no underscore). Use when: (1) you have a URL and need its full content, (2) web_search results need deeper reading, (3) user provides a URL to read. If the URL is a PDF (ends in .pdf or serves application/pdf), its text is extracted automatically (first pages only by default — use fetch_pdf for full or page-specific extraction). Requires approval before execution.',
      category: 'plugin',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to fetch including protocol (e.g., https://example.com/page).',
          },
          mode: {
            type: 'string',
            enum: ['highlights', 'full'],
            default: 'highlights',
            description: '"highlights" returns relevant excerpts (token-efficient), "full" returns full page text.',
          },
        },
        required: ['url'],
      },
      needsApproval: true,
    },
    execute: async (args, deps) => {
      const url = String(args.url ?? '');
      const mode = String(args.mode ?? 'highlights') as 'highlights' | 'full';

      deps.onEvent({
        type: 'tool_call',
        data: { toolName: 'webfetch', args },
        timestamp: Date.now(),
      });

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return `Invalid URL: "${url}". URL must start with http:// or https://.`;
      }

      try {
        const result = await webSearch.fetchUrl(url, {
          mode: mode === 'full' ? 'text' : 'highlights',
        });

        return `Content from ${result.title} (${url}):\n\n${result.content}`;
      } catch (err: unknown) {
        return `Failed to fetch content from ${url}: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createPdfFetchTool(webSearch: WebSearchService): ToolHandler {
  return {
    definition: {
      name: 'fetch_pdf',
      description: 'FETCH AND EXTRACT TEXT from a PDF hosted online, page by page, using the plugin\'s PDF.js parser. The PDF bytes are read entirely in memory — never downloaded to the vault. Tool name: fetch_pdf (underscore). Use when: (1) the target URL is a PDF (ends in .pdf or serves application/pdf), (2) webfetch returned unreadable garbage or failed on a PDF link, (3) you need specific page ranges of a large document, (4) a PDF needs deeper reading than the default first-page excerpt. Only works on text-based PDFs; scanned/image-only (non-OCR) PDFs return no text. pageFrom/pageTo are 1-based page numbers; default pageFrom=1, pageTo=10. For long documents raise pageTo or paginate (e.g. 1-20, 21-40). Max supported PDF size is 50 MB. Requires approval before execution.',
      category: 'plugin',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL of the PDF including protocol (e.g., https://example.com/paper.pdf).',
          },
          pageFrom: {
            type: 'number',
            default: 1,
            description: 'First page to extract (1-based). Default 1.',
          },
          pageTo: {
            type: 'number',
            default: 10,
            description: 'Last page to extract, inclusive (1-based). Default 10. Raise for longer documents or paginate.',
          },
        },
        required: ['url'],
      },
      needsApproval: true,
    },
    execute: async (args, deps) => {
      const url = String(args.url ?? '');
      const pageFrom = args.pageFrom != null && !isNaN(Number(args.pageFrom)) ? Math.max(1, Number(args.pageFrom)) : undefined;
      const pageTo = args.pageTo != null && !isNaN(Number(args.pageTo)) ? Math.max(pageFrom ?? 1, Number(args.pageTo)) : undefined;

      deps.onEvent({
        type: 'tool_call',
        data: { toolName: 'fetch_pdf', args },
        timestamp: Date.now(),
      });

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return `Invalid URL: "${url}". URL must start with http:// or https://.`;
      }

      try {
        const result = await webSearch.fetchPdf(url, { from: pageFrom, to: pageTo });

        const rangeLabel =
          pageFrom || pageTo ? ` [pages ${pageFrom ?? 1}-${pageTo ?? 'end'}]` : '';
        return `PDF content from ${result.title} (${url})${rangeLabel}:\n\n${result.content}`;
      } catch (err: unknown) {
        return `Failed to fetch PDF from ${url}: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
