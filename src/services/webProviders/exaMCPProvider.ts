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
    
    const text = await this.callTool('web_search_exa', {
      query,
      numResults: options?.numResults ?? 5,
    });
    
    const results = this.parseSearchResults(text);
    
    return results;
  }

  async fetchUrl(url: string): Promise<{ title: string; content: string }> {
    
    const content = await this.callTool('web_fetch_exa', { url });
    
    const titleMatch = content.match(/^#+\s+(.+)/m);
    return {
      title: titleMatch ? titleMatch[1].trim() : url,
      content,
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    

    const initResult = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'nexus-lm', version: '1.0.0' },
    });
    

    const listResult = await this.sendRequest('tools/list') as MCPListResult;
    

    if (!listResult || !Array.isArray(listResult.tools)) {
      throw new Error('Exa MCP: No tools discovered - server returned: ' + JSON.stringify(listResult));
    }
    if (listResult.tools.length === 0) {
      throw new Error('Exa MCP: Server returned empty tool list');
    }

    this.initialized = true;
    
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    
    await this.ensureInitialized();

    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    }) as MCPCallResult;

    

    if (result.isError) {
      throw new Error('Exa MCP tool "' + name + '" returned error');
    }

    if (!result.content) {
      
      return '';
    }

    if (Array.isArray(result.content)) {
      
      for (const item of result.content) {
        if (item.type === 'text' && item.text) {
          
          return item.text;
        }
        
      }
    } else {
      
      if (result.content.type === 'text' && result.content.text) {
        return result.content.text;
      }
    }

    
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

    

    if (response.status >= 400) {
      
      throw new Error('Exa MCP error: HTTP ' + response.status);
    }

    const rawContentType = (
      (response.headers && (response.headers['content-type'] || response.headers['Content-Type'])) ||
      ''
    ).toLowerCase();
    const bodyText = response.text || '';
    const looksLikeSSE = /^\s*event:/m.test(bodyText) || /^\s*data:/m.test(bodyText);

    if (rawContentType.includes('text/event-stream') || looksLikeSSE) {
      
      return this.parseSSE(bodyText, id);
    }

    let json: Record<string, unknown>;
    try {
      json = typeof response.json === 'object' ? response.json as Record<string, unknown> : JSON.parse(response.text || '{}') as Record<string, unknown>;
    } catch (e) {
      
      throw new Error('Exa MCP: Invalid JSON response: ' + response.text?.slice(0, 200));
    }

    if (json.error) {
      const errMsg = (json.error as Record<string, unknown>).message as string || 'Exa MCP request failed';
      
      throw new Error(errMsg);
    }

    
    return json.result;
  }

  private parseSSE(body: string, requestId: number): unknown {
    
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
            const msg = JSON.parse(currentData) as { id?: number; error?: { message?: string }; result?: unknown };
            if (msg.id === requestId) {
              if (msg.error) {
                throw new Error(msg.error.message || 'Exa MCP error');
              }
              result = msg.result;
              
            }
          } catch (e) {
            if (!(e instanceof SyntaxError)) {
              throw e;
            }
          }
        }
        currentEvent = '';
        currentData = '';
      }
    }

    if (result === null) {
      
      throw new Error('No response from Exa MCP stream');
    }
    return result;
  }

  private parseSearchResults(text: string): SearchResult[] {
    if (!text || text.trim() === '') {
      
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
