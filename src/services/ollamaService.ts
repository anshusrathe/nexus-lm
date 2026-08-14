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
import { simulatedStream, fetchStream, createOllamaParser, PartialStreamError } from '../utils/streamingUtils';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  images?: string[];
  tool_name?: string;
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

interface OllamaChatRequestBody {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
    top_p?: number;
  };
  tools?: ToolDefinition[];
  temperature?: number;
  think?: boolean | 'low' | 'medium' | 'high';
}

interface OllamaChatResponse {
  model?: string;
  message?: {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string;
    thinking?: string;
    tool_calls?: ToolCall[];
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaModelInfo {
  name: string;
}

interface OllamaWebSearchRequestBody {
  query: string;
  max_results: number;
}

interface OllamaWebFetchRequestBody {
  url: string;
}

interface ToolDefinition {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface ToolCall {
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ToolCallResult {
  success: boolean;
  content?: string;
  error?: string;
}

interface RequestUrlOptions {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

interface RequestUrlResponse {
  status: number;
  text: string;
  json: unknown;
  headers?: Record<string, string>;
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
    options?: GenerationOptions,
    onFinish?: (finishReason: string) => void
  ): Promise<string> {
    const requestBody: OllamaChatRequestBody = {
      model,
      messages,
      stream: false,
      options: {},
    };
    if (options?.temperature !== undefined) requestBody.options!.temperature = options.temperature;
    if (options?.maxTokens !== undefined) requestBody.options!.num_predict = options.maxTokens;
    if (options?.topP !== undefined) requestBody.options!.top_p = options.topP;
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

    const extractFinishReason = (data: OllamaChatResponse) => {
      if (data.done === false) {
        if (onFinish) onFinish('length');
      } else if (data.done === true) {
        if (onFinish) onFinish('stop');
      }
    };

    
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
        const errorData = (typeof response.json === 'object' ? response.json : { error: 'Unknown error' }) as OllamaErrorResponse;
        throw new OllamaApiError(errorData.error || `Ollama API error: ${response.status}`, response.status);
      }

      const data = response.json as OllamaChatResponse;
      extractFinishReason(data);
      return data.message?.content || '';
    } else {
      
      const response = await requestUrl({
        url: `${this.baseUrl}/api/chat`,
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        throw: false
      });

      
      if (this.onHeadersReceived) {
        const h = new Headers();
        Object.entries(response.headers).forEach(([k, v]) => h.set(k, Array.isArray(v) ? v.join(', ') : v));
        this.onHeadersReceived(h);
      }

      if (response.status >= 400) {
        const errorData = (await Promise.resolve(response.json).catch(() => ({ error: 'Unknown error' }))) as OllamaErrorResponse;
        throw new OllamaApiError(errorData.error || `Ollama API error: ${response.status}`, response.status);
      }

      const data = response.json as OllamaChatResponse;
      extractFinishReason(data);
      return data.message?.content || '';
    }
  }

  async generateContentStreamEvents(
    model: string,
    messages: ChatMessage[],
    onEvent: (evt: OllamaStreamEvent) => void,
    options?: GenerationOptions,
    onFinish?: (finishReason: string) => void
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

    const requestBody: OllamaChatRequestBody = {
      model,
      messages,
      stream: true,
      options: {},
    };
    if (options?.temperature !== undefined) requestBody.options!.temperature = options.temperature;
    if (options?.maxTokens !== undefined) requestBody.options!.num_predict = options.maxTokens;
    if (options?.topP !== undefined) requestBody.options!.top_p = options.topP;
    if (options?.think !== undefined) requestBody.think = options.think;

    const parser = createOllamaParser();
    const callbacks = {
      onChunk: (text: string) => onEvent({ type: 'content', text }),
      onThinking: (text: string) => onEvent({ type: 'thinking', text }),
      onFinish
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
      if (error instanceof PartialStreamError) throw error;
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
        const errorData = (typeof response.json === 'object' ? response.json : { error: 'Unknown error' }) as OllamaErrorResponse;
        throw new OllamaApiError(errorData.error || `Ollama API error: ${response.status}`, response.status);
      }

      const data = response.json as { models?: Array<{ name: string; size?: number; modified_at?: string }> };
      return data.models?.map((m: OllamaModelInfo) => m.name) || [];
    } else {

      const response = await requestUrl({
        url: `${this.baseUrl}/api/tags`,
        method: 'GET',
        headers,
        throw: false
      });

      if (response.status >= 400) {
        const errorData = (await Promise.resolve(response.json).catch(() => ({ error: 'Unknown error' }))) as OllamaErrorResponse;
        throw new OllamaApiError(errorData.error || `Ollama API error: ${response.status}`, response.status);
      }

      const data = response.json as { models?: Array<{ name: string; size?: number; modified_at?: string }> };
      return data.models?.map((m: OllamaModelInfo) => m.name) || [];
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

    const requestBody: OllamaWebSearchRequestBody = {
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
      const errorData = (typeof response.json === 'object' ? response.json : { error: 'Unknown error' }) as OllamaErrorResponse;
      
      
      if (response.status === 401) {
        throw new OllamaApiError('Invalid Ollama API key. Please check your API key in settings.', 401);
      } else if (response.status === 429) {
        throw new OllamaApiError('Ollama API rate limit exceeded. Please try again later.', 429);
      }
      
      throw new OllamaApiError(errorData.error || `Ollama web search error: ${response.status}`, response.status);
    }

    const data = response.json as { results?: unknown[] };
    
    return {
      results: (data.results || []) as OllamaWebSearchResult[]
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

    const requestBody: OllamaWebFetchRequestBody = {
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
      const errorData = (typeof response.json === 'object' ? response.json : { error: 'Unknown error' }) as OllamaErrorResponse;
      
      
      if (response.status === 401) {
        throw new OllamaApiError('Invalid Ollama API key. Please check your API key in settings.', 401);
      } else if (response.status === 429) {
        throw new OllamaApiError('Ollama API rate limit exceeded. Please try again later.', 429);
      }
      
      throw new OllamaApiError(errorData.error || `Ollama web fetch error: ${response.status}`, response.status);
    }

    const data = response.json as { title?: string; content?: string; links?: unknown[] };
    
    return {
      title: data.title || 'Untitled',
      content: data.content || '',
      links: (data.links || []) as string[]
    };
  }

  /**
   * Ollama's native /api/chat requires tool call arguments to be JSON OBJECTS.
   * OpenAI-format history carries them as JSON strings, which Ollama fails to
   * parse ("Value looks like object, but can't find closing '}' symbol").
   * Normalize every assistant tool_calls entry before sending.
   */
  private normalizeToolCallArguments(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((msg) => {
      if (msg.role !== 'assistant') return msg;
      const toolCalls = (msg as unknown as Record<string, unknown>).tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) return msg;
      const normalized = toolCalls.map((rawTc) => {
        const tc = rawTc as Record<string, unknown>;
        const fn = tc.function as Record<string, unknown> | undefined;
        if (!fn || typeof fn !== 'object' || typeof fn.arguments !== 'string') return tc;
        try {
          const parsed = JSON.parse(fn.arguments) as unknown;
          const argsObj = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
          return { ...tc, function: { ...fn, arguments: argsObj } };
        } catch {
          return { ...tc, function: { ...fn, arguments: {} } };
        }
      });
      return { ...msg, tool_calls: normalized } as unknown as ChatMessage;
    });
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
    tools: ToolDefinition[],
    options: GenerationOptions,
    executeToolsCallback: (toolCalls: ToolCall[]) => Promise<ToolCallResult[]>,
    useRequestUrl?: (options: RequestUrlOptions) => Promise<RequestUrlResponse>,
    onThinkingChunk?: (text: string) => void,
    streamCallback?: (chunk: string) => void
  ): Promise<{ content: string; totalTokens?: number }> {
    let fullContent = '';
    let conversationMessages = [...this.normalizeToolCallArguments(messages)];
    let totalTokens = 0;
    let toolRoundsExecuted = 0;
    const MAX_CONTINUATION_NUDGES = 3;
    let nudgeCount = 0;

    
    while (true) {
      if (options.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const requestBody: OllamaChatRequestBody = {
        model,
        messages: conversationMessages,
        tools,
        temperature: options.temperature ?? 0.7,
        stream: false
      };
      // Known Ollama server bug: thinking models (minimax-m3, nemotron-3-super,
      // qwen3) return EMPTY output when think + tools are combined (ollama#10976,
      // fixed by #16758). Disable think whenever tools are active.
      if (tools && tools.length > 0) {
        requestBody.think = false;
      } else if (options?.think !== undefined) {
        requestBody.think = options.think;
      }

      let data: OllamaChatResponse;
      
      
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

        data = response.json as OllamaChatResponse;
      } else {
        const response = await requestUrl({
          url: `${this.baseUrl}/api/chat`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {})
          },
          body: JSON.stringify(requestBody),
          throw: false
        });

        if (response.status >= 400) {
          const errorText = response.text;
          throw new OllamaApiError(`Ollama API error (${response.status}): ${errorText}`, response.status);
        }

        
        if (this.onHeadersReceived) {
          const h = new Headers();
          Object.entries(response.headers).forEach(([k, v]) => h.set(k, Array.isArray(v) ? v.join(', ') : v));
          this.onHeadersReceived(h);
        }

        data = response.json as OllamaChatResponse;
      }
      
      if (data.prompt_eval_count || data.eval_count) {
        totalTokens += (data.prompt_eval_count || 0) + (data.eval_count || 0);
      }

      const message = data.message;
      if (!message) break;

      if (message.thinking && onThinkingChunk) {
        onThinkingChunk(message.thinking);
      }

      
      conversationMessages.push(message as ChatMessage);

      
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
              ? (toolResult.content || '')
              : `Error: ${toolResult.error}`
          });
        }
        
        
        continue;
      }

      
      
      if (message.content || message.thinking) {
        
        fullContent = message.content || message.thinking || '';
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
        });
        continue;
      }

      break;
    }

    return { content: fullContent, totalTokens };
  }

  /**
   * Single-round native tool calling: one request, returns tool calls without executing them.
   * The caller owns the tool execution loop.
   */
  async generateContentWithToolsOnce(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: GenerationOptions
  ): Promise<{ content: string; finishReason?: string; toolCalls?: Array<Record<string, unknown>>; thinking?: string }> {
    if (options.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Self-healing: thinking models can return a totally empty message with no
    // tool_calls (empty-content bug, plus general flakiness). Instead of
    // handing the caller an empty response that the agent view would throw on,
    // append a continue-nudge and retry a limited number of times.
    const MAX_EMPTY_NUDGES = 2;
    let nudgeCount = 0;
    let workingMessages = messages;

    while (true) {
      const requestBody: OllamaChatRequestBody = {
        model,
        messages: this.normalizeToolCallArguments(workingMessages),
        tools,
        temperature: options.temperature ?? 0.7,
        stream: false
      };
      // Known Ollama server bug: thinking models return EMPTY output when
      // think + tools are combined (ollama#10976). Disable think when tools
      // are active — the caller's thinking preference cannot be honored anyway.
      if (tools && tools.length > 0) {
        requestBody.think = false;
      } else if (options?.think !== undefined) {
        requestBody.think = options.think;
      }

      const response = await requestUrl({
        url: `${this.baseUrl}/api/chat`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify(requestBody),
        throw: false
      });

      if (response.status >= 400) {
        const errorText = response.text;
        throw new OllamaApiError(`Ollama API error (${response.status}): ${errorText}`, response.status);
      }

      if (this.onHeadersReceived) {
        const h = new Headers();
        Object.entries(response.headers).forEach(([k, v]) => h.set(k, Array.isArray(v) ? v.join(', ') : v));
        this.onHeadersReceived(h);
      }

      const data = response.json as OllamaChatResponse;
      const message = data.message;

      const content = message?.content || '';
      const toolCalls = message?.tool_calls && message.tool_calls.length > 0
        ? message.tool_calls as unknown as Array<Record<string, unknown>>
        : undefined;
      const thinking = typeof message?.thinking === 'string' && message.thinking.length > 0 ? message.thinking : undefined;

      if (content || toolCalls || thinking || nudgeCount >= MAX_EMPTY_NUDGES) {
        return {
          content,
          finishReason: data.done ? 'stop' : undefined,
          toolCalls,
          thinking,
        };
      }

      nudgeCount++;
      workingMessages = [
        ...workingMessages,
        {
          role: 'user' as const,
          content: 'Your last response was empty. Produce a complete answer now — call a tool if you need information, otherwise answer directly.'
        }
      ];
    }
  }
}
