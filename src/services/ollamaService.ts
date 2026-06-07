/**
 * Ollama Service - Handles API calls to Ollama's API
 * 
 * Ollama provides local LLM inference with an OpenAI-compatible API endpoint.
 * This service handles both streaming and non-streaming requests.
 * 
 * Note: For Obsidian plugins, cloud API requests use requestUrl to bypass CORS,
 * while local requests can use fetch for streaming support.
 */

import { requestUrl } from 'obsidian';
import { simulatedStream, fetchStream, createOllamaParser } from '../utils/streamingUtils';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  images?: string[]; 
                     
                     
                     
}

export interface GenerationOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  think?: boolean | 'low' | 'medium' | 'high';
  abortSignal?: AbortSignal;
}

export interface OllamaErrorResponse {
  error: string;
}

export type OllamaStreamEvent =
  | { type: 'thinking'; text: string }
  | { type: 'content'; text: string }
  | { type: 'done' };

/**
 * Interface for Ollama web search result
 */
export interface OllamaWebSearchResult {
  title: string;
  url: string;
  content: string;
}

/**
 * Interface for Ollama web search response
 */
export interface OllamaWebSearchResponse {
  results: OllamaWebSearchResult[];
}

/**
 * Interface for Ollama web fetch response
 */
export interface OllamaWebFetchResponse {
  title: string;
  content: string;
  links: string[];
}

/**
 * Custom error class for Ollama API errors with status code
 */
export class OllamaApiError extends Error {
  status: number;
  
  constructor(message: string, status: number) {
    super(message);
    this.name = 'OllamaApiError';
    this.status = status;
  }
}

export class OllamaService {
  private apiKey: string;
  private baseUrl: string;
  private isCloudMode: boolean;
  
  
  private onHeadersReceived?: (headers: Headers) => void;

  constructor(baseUrl: string, apiKey: string = '', onHeadersReceived?: (headers: Headers) => void) {
    
    let normalizedUrl = baseUrl.replace(/\/$/, ''); 
    
    normalizedUrl = normalizedUrl.replace(/\/api$/, '');
    
    
    
    if (normalizedUrl.includes('ollama.com')) {
      
      if (normalizedUrl === 'https://api.ollama.com') {
        normalizedUrl = 'https://ollama.com';
      }
      this.isCloudMode = true;
    } else {
      this.isCloudMode = false;
    }
    
    this.baseUrl = normalizedUrl;
    this.apiKey = apiKey;
    this.onHeadersReceived = onHeadersReceived;
  }

  /**
   * Generates content using Ollama's chat completions API (non-streaming).
   * @param model - The model ID to use (e.g., 'llama3.2', 'mistral')
   * @param messages - Array of chat messages
   * @param options - Optional generation parameters
   * @returns The generated text response
   */
  async generateContent(
    model: string,
    messages: ChatMessage[],
    options?: GenerationOptions
  ): Promise<string> {
    const requestBody: SafeAny = {
      model,
      messages,
      stream: false,
      options: {},
    };
    if (options?.temperature !== undefined) requestBody.options.temperature = options.temperature;
    if (options?.maxTokens !== undefined) requestBody.options.num_predict = options.maxTokens;
    if (options?.topP !== undefined) requestBody.options.top_p = options.topP;
    if (options?.think !== undefined) requestBody.think = options.think;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    
    if (this.apiKey || this.isCloudMode) {
      if (!this.apiKey && this.isCloudMode) {
        throw new OllamaApiError('API key is required for Ollama cloud mode. Please configure your Ollama API key in settings.', 401);
      }
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    
    if (this.isCloudMode) {
      const response = await requestUrl({
        url: `${this.baseUrl}/api/chat`,
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        throw: false
      });

      
      if (this.onHeadersReceived) {
        const headersObj = new Headers();
        Object.entries(response.headers).forEach(([key, value]) => {
          headersObj.set(key, value);
        });
        this.onHeadersReceived(headersObj);
      }

      if (response.status >= 400) {
        const errorData: OllamaErrorResponse = typeof response.json === 'object' ? response.json : { error: 'Unknown error' };
        throw new OllamaApiError(errorData.error || `Ollama API error: ${response.status}`, response.status);
      }

      const data = response.json;
      return data.message?.content || '';
    } else {
      
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        signal: options?.abortSignal,
        headers,
        body: JSON.stringify(requestBody)
      });

      
      if (this.onHeadersReceived) {
        this.onHeadersReceived(response.headers);
      }

      if (!response.ok) {
        const errorData: OllamaErrorResponse = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new OllamaApiError(errorData.error || `Ollama API error: ${response.status}`, response.status);
      }

      const data = await response.json();
      return data.message?.content || '';
    }
  }

  async generateContentStreamEvents(
    model: string,
    messages: ChatMessage[],
    onEvent: (evt: OllamaStreamEvent) => void,
    options?: GenerationOptions
  ): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey || this.isCloudMode) {
      if (!this.apiKey && this.isCloudMode) {
        throw new OllamaApiError('API key is required for Ollama cloud mode. Please configure your Ollama API key in settings.', 401);
      }
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const requestBody: SafeAny = {
      model,
      messages,
      stream: true,
      options: {},
    };
    if (options?.temperature !== undefined) requestBody.options.temperature = options.temperature;
    if (options?.maxTokens !== undefined) requestBody.options.num_predict = options.maxTokens;
    if (options?.topP !== undefined) requestBody.options.top_p = options.topP;
    if (options?.think !== undefined) requestBody.think = options.think;

    const parser = createOllamaParser();
    const callbacks = {
      onChunk: (text: string) => onEvent({ type: 'content', text }),
      onThinking: (text: string) => onEvent({ type: 'thinking', text })
    };

    
    try {
      await fetchStream(
        `${this.baseUrl}/api/chat`,
        headers,
        JSON.stringify(requestBody),
        parser,
        callbacks,
        options?.abortSignal
      );
      return;
    } catch (error) {
      if (error instanceof OllamaApiError) throw error;
          }

    
    try {
      const respHeaders = await simulatedStream(
        `${this.baseUrl}/api/chat`,
        'POST',
        headers,
        JSON.stringify(requestBody),
        callbacks,
        options?.abortSignal,
        'ollama'
      );
      if (this.onHeadersReceived) {
        const h = new Headers();
        Object.entries(respHeaders).forEach(([k, v]) => h.set(k, Array.isArray(v) ? v.join(', ') : v));
        this.onHeadersReceived(h);
      }
    } catch (error) {
      if (error instanceof OllamaApiError) throw error;
      throw new OllamaApiError(
        `All streaming methods failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        0
      );
    }
  }

  /**
   * Lists available models from the Ollama instance.
   * @returns Array of model names
   */
  async listModels(): Promise<string[]> {
    const headers: Record<string, string> = {};

    
    if (this.apiKey || this.isCloudMode) {
      if (!this.apiKey && this.isCloudMode) {
        throw new OllamaApiError('API key is required for Ollama cloud mode. Please configure your Ollama API key in settings.', 401);
      }
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    
    if (this.isCloudMode) {
      const response = await requestUrl({
        url: `${this.baseUrl}/api/tags`,
        method: 'GET',
        headers,
        throw: false
      });

      if (response.status >= 400) {
        const errorData: OllamaErrorResponse = typeof response.json === 'object' ? response.json : { error: 'Unknown error' };
        throw new OllamaApiError(errorData.error || `Ollama API error: ${response.status}`, response.status);
      }

      const data = response.json;
      return data.models?.map((m: SafeAny) => m.name) || [];
    } else {
      
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        headers
      });

      if (!response.ok) {
        const errorData: OllamaErrorResponse = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new OllamaApiError(errorData.error || `Ollama API error: ${response.status}`, response.status);
      }

      const data = await response.json();
      return data.models?.map((m: SafeAny) => m.name) || [];
    }
  }

  /**
   * Performs web search using Ollama's web search API.
   * This API is separate from the chat API and ALWAYS requires an API key,
   * even when using local models.
   * 
   * @param query - Search query string
   * @param maxResults - Maximum number of results to return (default 5, max 10)
   * @returns Search results with title, url, and content
   * @throws OllamaApiError if API key is not configured or API request fails
   */
  async webSearch(query: string, maxResults: number = 5): Promise<OllamaWebSearchResponse> {
    
    if (!this.apiKey) {
      throw new OllamaApiError(
        'Ollama web search requires an API key. Please configure your Ollama API key in settings to use web search features.',
        401
      );
    }

    
    if (maxResults < 1 || maxResults > 10) {
      maxResults = Math.min(Math.max(maxResults, 1), 10);
    }

    
    const webSearchUrl = 'https://ollama.com/api/web_search';

    const requestBody: SafeAny = {
      query,
      max_results: maxResults
    };

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };

    
    
    const response = await requestUrl({
      url: webSearchUrl,
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      throw: false
    });

    
    if (this.onHeadersReceived) {
      const headersObj = new Headers();
      Object.entries(response.headers).forEach(([key, value]) => {
        headersObj.set(key, value);
      });
      this.onHeadersReceived(headersObj);
    }

    if (response.status >= 400) {
      const errorData: OllamaErrorResponse = typeof response.json === 'object' ? response.json : { error: 'Unknown error' };
      
      
      if (response.status === 401) {
        throw new OllamaApiError('Invalid Ollama API key. Please check your API key in settings.', 401);
      } else if (response.status === 429) {
        throw new OllamaApiError('Ollama API rate limit exceeded. Please try again later.', 429);
      }
      
      throw new OllamaApiError(errorData.error || `Ollama web search error: ${response.status}`, response.status);
    }

    const data = response.json;
    
    return {
      results: data.results || []
    };
  }

  /**
   * Fetches webpage content using Ollama's web fetch API.
   * This API is separate from the chat API and ALWAYS requires an API key,
   * even when using local models.
   * 
   * @param url - URL to fetch (must be HTTPS)
   * @returns Webpage title, content, and links
   * @throws OllamaApiError if API key is not configured or API request fails
   */
  async webFetch(url: string): Promise<OllamaWebFetchResponse> {
    
    if (!this.apiKey) {
      throw new OllamaApiError(
        'Ollama web fetch requires an API key. Please configure your Ollama API key in settings to use webpage features.',
        401
      );
    }

    
    if (!url || !url.startsWith('http')) {
      throw new OllamaApiError('Invalid URL. URL must start with http:', 400);
    }

    
    let cleanUrl = url.split('?')[0].split('#')[0];

    
    const webFetchUrl = 'https://ollama.com/api/web_fetch';

    const requestBody: SafeAny = {
      url: cleanUrl
    };

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };

    
    
    const response = await requestUrl({
      url: webFetchUrl,
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      throw: false
    });

    
    if (this.onHeadersReceived) {
      const headersObj = new Headers();
      Object.entries(response.headers).forEach(([key, value]) => {
        headersObj.set(key, value);
      });
      this.onHeadersReceived(headersObj);
    }

    if (response.status >= 400) {
      const errorData: OllamaErrorResponse = typeof response.json === 'object' ? response.json : { error: 'Unknown error' };
      
      
      if (response.status === 401) {
        throw new OllamaApiError('Invalid Ollama API key. Please check your API key in settings.', 401);
      } else if (response.status === 429) {
        throw new OllamaApiError('Ollama API rate limit exceeded. Please try again later.', 429);
      }
      
      throw new OllamaApiError(errorData.error || `Ollama web fetch error: ${response.status}`, response.status);
    }

    const data = response.json;
    
    return {
      title: data.title || 'Untitled',
      content: data.content || '',
      links: data.links || []
    };
  }

  /**
   * Generate content with tool calling support
   * @param model - The model ID to use
   * @param messages - Array of chat messages
   * @param tools - Array of tool definitions in OpenAI format
   * @param options - Optional generation parameters
   * @param executeToolsCallback - Callback to execute tools
   * @param useRequestUrl - Use Obsidian's requestUrl to bypass CORS (for cloud mode)
   * @returns The complete generated text response and total tokens
   */
  async generateContentWithTools(
    model: string,
    messages: ChatMessage[],
    tools: SafeAny[],
    options: GenerationOptions,
    executeToolsCallback: (toolCalls: SafeAny[]) => Promise<SafeAny[]>,
    useRequestUrl?: (options: SafeAny) => Promise<SafeAny>,
    onThinkingChunk?: (text: string) => void,
    streamCallback?: (chunk: string) => void
  ): Promise<{ content: string; totalTokens?: number }> {
    let fullContent = '';
    let conversationMessages = [...messages];
    let totalTokens = 0;
    let toolRoundsExecuted = 0;
    const MAX_CONTINUATION_NUDGES = 3;
    let nudgeCount = 0;

    
    while (true) {
      if (options.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const requestBody: SafeAny = {
        model,
        messages: conversationMessages,
        tools,
        temperature: options.temperature ?? 0.7,
        stream: false
      };
      if (options?.think !== undefined) {
        requestBody.think = options.think;
      }

      let data: SafeAny;
      
      
      if (useRequestUrl) {
        const response = await useRequestUrl({
          url: `${this.baseUrl}/api/chat`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {})
          },
          body: JSON.stringify(requestBody)
        });

        if (response.status !== 200) {
          throw new OllamaApiError(`Ollama API error (${response.status}): ${response.text}`, response.status);
        }

        
        if (this.onHeadersReceived && response.headers) {
          
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            headers.set(key, String(value));
          }
          this.onHeadersReceived(headers);
        }

        data = response.json;
      } else {
        const response = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          signal: options.abortSignal,
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {})
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new OllamaApiError(`Ollama API error (${response.status}): ${errorText}`, response.status);
        }

        
        if (this.onHeadersReceived) {
          this.onHeadersReceived(response.headers);
        }

        data = await response.json();
      }
      
      if (data.prompt_eval_count || data.eval_count) {
        totalTokens += (data.prompt_eval_count || 0) + (data.eval_count || 0);
      }

      const message = data.message;
      if (!message) break;

      if (message.thinking && onThinkingChunk) {
        onThinkingChunk(message.thinking);
      }

      
      conversationMessages.push(message);

      
      if (message.tool_calls && message.tool_calls.length > 0) {
                toolRoundsExecuted++;
        
        
        const toolResults = await executeToolsCallback(message.tool_calls);
        
        
        
        
        for (let i = 0; i < message.tool_calls.length; i++) {
          const toolCall = message.tool_calls[i];
          const toolResult = toolResults[i];
          const toolName = toolCall.function?.name || 'unknown';

          conversationMessages.push({
            role: 'tool',
            tool_name: toolName,
            content: toolResult.success
              ? toolResult.content
              : `Error: ${toolResult.error}`
          } as SafeAny);
        }
        
        
        continue;
      }

      
      
      if (message.content || message.thinking) {
        
        fullContent = message.content || message.thinking;
        if (streamCallback) {
          streamCallback(fullContent);
        }
        break;
      }

      
      if (toolRoundsExecuted > 0 && nudgeCount < MAX_CONTINUATION_NUDGES) {
        nudgeCount++;
                conversationMessages.push({
          role: 'user',
          content: 'You have already called some tools and received results. Please now synthesise a complete, direct answer to the original question using all the tool results above. Do not call any more tools — just write the final answer.'
        } as SafeAny);
        continue;
      }

      break;
    }

    return { content: fullContent, totalTokens };
  }
}
