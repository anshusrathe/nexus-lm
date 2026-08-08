import { requestUrl } from 'obsidian';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
}

interface MCPContentItem {
  type: string;
  text?: string;
}

interface MCPCallResult {
  content?: MCPContentItem[] | MCPContentItem;
  isError?: boolean;
}

interface MCPTool {
  name: string;
}

interface MCPListResult {
  tools?: MCPTool[];
}

export class ExaMCPProvider {
  private baseUrl = 'https://mcp.exa.ai/mcp';
  private initialized = false;
  private messageId = 0;

  async search(query: string, options?: { numResults?: number }): Promise<SearchResult[]> {
    console.log('[ExaMCP] search called with query="' + query + '" numResults=' + (options?.numResults ?? 5));
    const text = await this.callTool('web_search_exa', {
      query,
      numResults: options?.numResults ?? 5,
    });
    console.log('[ExaMCP] search raw response length=' + text.length + ' text="' + text.slice(0, 200) + '..."');
    const results = this.parseSearchResults(text);
    console.log('[ExaMCP] parsed ' + results.length + ' search results');
    return results;
  }

  async fetchUrl(url: string): Promise<{ title: string; content: string }> {
    console.log('[ExaMCP] fetchUrl called for url=' + url);
    const content = await this.callTool('web_fetch_exa', { url });
    console.log('[ExaMCP] fetchUrl response length=' + content.length);
    const titleMatch = content.match(/^#+\s+(.+)/m);
    return {
      title: titleMatch ? titleMatch[1].trim() : url,
      content,
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    console.log('[ExaMCP] Initializing...');

    const initResult = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'nexus-lm', version: '1.0.0' },
    });
    console.log('[ExaMCP] initialize response received');

    const listResult = await this.sendRequest('tools/list') as MCPListResult;
    console.log('[ExaMCP] tools/list returned tools=' + JSON.stringify(listResult?.tools?.map((t: MCPTool) => t.name)));

    if (!listResult || !Array.isArray(listResult.tools)) {
      throw new Error('Exa MCP: No tools discovered - server returned: ' + JSON.stringify(listResult));
    }
    if (listResult.tools.length === 0) {
      throw new Error('Exa MCP: Server returned empty tool list');
    }

    this.initialized = true;
    console.log('[ExaMCP] Initialized successfully with ' + listResult.tools.length + ' tools');
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    console.log('[ExaMCP] calling tool "' + name + '"');
    await this.ensureInitialized();

    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    }) as MCPCallResult;

    console.log('[ExaMCP] tool response isError=' + result.isError + ' content=' + (result.content ? 'present' : 'undefined'));

    if (result.isError) {
      throw new Error('Exa MCP tool "' + name + '" returned error');
    }

    if (!result.content) {
      console.log('[ExaMCP] tool response has no content');
      return '';
    }

    if (Array.isArray(result.content)) {
      console.log('[ExaMCP] content is array of ' + result.content.length + ' items');
      for (const item of result.content) {
        if (item.type === 'text' && item.text) {
          console.log('[ExaMCP] found text item (type=' + item.type + ') length=' + item.text.length);
          return item.text;
        }
        console.log('[ExaMCP] content item type=' + item.type + ' text=' + (item.text ? 'present' : 'undefined'));
      }
    } else {
      console.log('[ExaMCP] content is single object, type=' + result.content.type);
      if (result.content.type === 'text' && result.content.text) {
        return result.content.text;
      }
    }

    console.log('[ExaMCP] no text content found in response');
    return '';
  }

  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.messageId;
    const requestBody = {
      jsonrpc: '2.0',
      id,
      method,
      params: params || {},
    };
    const body = JSON.stringify(requestBody);

    console.log('[ExaMCP] Sending request id=' + id + ' method=' + method + ' params=' + JSON.stringify(params));

    const response = await requestUrl({
      url: this.baseUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-03-26',
      },
      body,
      throw: false,
    });

    console.log('[ExaMCP] Response status=' + response.status + ' content-type=' + (response.headers['content-type'] || 'none'));

    if (response.status >= 400) {
      console.log('[ExaMCP] HTTP error: ' + response.status + ' ' + response.text?.slice(0, 500));
      throw new Error('Exa MCP error: HTTP ' + response.status);
    }

    const contentType = (response.headers['content-type'] || '').toLowerCase();

    if (contentType.includes('text/event-stream')) {
      console.log('[ExaMCP] Parsing SSE response length=' + response.text?.length);
      return this.parseSSE(response.text || '', id);
    }

    if (contentType.includes('application/json')) {
      console.log('[ExaMCP] Parsing JSON response');
    }

    let json: Record<string, unknown>;
    try {
      json = typeof response.json === 'object' ? response.json as Record<string, unknown> : JSON.parse(response.text || '{}');
    } catch (e) {
      console.log('[ExaMCP] JSON parse failed: text=' + response.text?.slice(0, 500));
      throw new Error('Exa MCP: Invalid JSON response: ' + response.text?.slice(0, 200));
    }

    if (json.error) {
      const errMsg = (json.error as Record<string, unknown>).message as string || 'Exa MCP request failed';
      console.log('[ExaMCP] RPC error: ' + errMsg);
      throw new Error(errMsg);
    }

    console.log('[ExaMCP] Success response for method=' + method + ' id=' + id + ' has result=' + ('result' in json));
    return json.result;
  }

  private parseSSE(body: string, requestId: number): unknown {
    console.log('[ExaMCP] parseSSE for requestId=' + requestId + ' body length=' + body.length);
    let result: unknown = null;
    const lines = body.split('\n');
    let currentEvent = '';
    let currentData = '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        currentData = line.slice(5).trim();
      } else if (line === '') {
        if (currentEvent === 'message' && currentData) {
          try {
            const msg = JSON.parse(currentData);
            if (msg.id === requestId) {
              if (msg.error) {
                throw new Error((msg.error.message as string) || 'Exa MCP error');
              }
              result = msg.result;
              console.log('[ExaMCP] SSE parsed result for requestId=' + requestId + ', has result=' + (result !== null));
            }
          } catch (e) {
            if (e instanceof SyntaxError) {
              console.log('[ExaMCP] SSE JSON parse error for data=' + currentData.slice(0, 200));
            } else {
              throw e;
            }
          }
        }
        currentEvent = '';
        currentData = '';
      }
    }

    if (result === null) {
      console.log('[ExaMCP] SSE stream did not contain matching response for requestId=' + requestId);
      throw new Error('No response from Exa MCP stream');
    }
    return result;
  }

  private parseSearchResults(text: string): SearchResult[] {
    if (!text || text.trim() === '') {
      console.log('[ExaMCP] parseSearchResults: empty text');
      return [];
    }

    // Exa MCP web_search_exa returns results in this format:
    //   Title: {title}
    //   URL: {url}
    //   Published: {date}
    //   Author: {author}
    //   Highlights:
    //   {highlight lines}
    //   ---
    //   (next result)
    const results: SearchResult[] = [];

    // Split by separator lines: --- (optionally surrounded by newlines)
    const blocks = text.split(/\n?---+\n?/);

    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi].trim();
      if (!block) continue;

      const lines = block.split('\n');
      let title = '';
      let url = '';
      let published = '';
      let author = '';
      const contentLines: string[] = [];
      let inContent = false;
      let contentField = '';

      for (const line of lines) {
        if (line.startsWith('Title: ')) {
          title = line.slice(7).trim();
        } else if (line.startsWith('URL: ')) {
          url = line.slice(5).trim();
        } else if (line.startsWith('Published: ')) {
          published = line.slice(11).trim();
        } else if (line.startsWith('Author: ')) {
          author = line.slice(8).trim();
        } else if (line.startsWith('Highlights:') || line.startsWith('Content:')) {
          inContent = true;
          contentField = line.startsWith('Highlights:') ? 'Highlights:' : 'Content:';
          const after = line.slice(contentField.length).trim();
          if (after) contentLines.push(after);
        } else if (line.startsWith('Text: ')) {
          inContent = true;
          contentLines.push(line.slice(6).trim());
        } else if (inContent) {
          contentLines.push(line);
        }
      }

      if (title && url) {
        const content = contentLines.join('\n').trim();
        const snippet = content.length > 300 ? content.slice(0, 300) + '...' : content;
        results.push({ title, url, snippet, content });
      }
    }

    return results;
  }
}
