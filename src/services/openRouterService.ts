/**
 * OpenRouter Service - Handles API calls to OpenRouter's API
 */
import { requestUrl } from 'obsidian';
import { simulatedStream, fetchStream, createSSEParser } from '../utils/streamingUtils';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; file?: { filename: string; fileData: string } }>;
}

export interface GenerationOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  toolChoice?: 'auto' | 'required' | 'none';
  plugins?: Array<{
    id: string;
    pdf?: {
      engine: string;
    };
  }>;
  abortSignal?: AbortSignal;
}

export interface OpenRouterErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

export class OpenRouterApiError extends Error {
  status: number;
  type: string;
  
  constructor(message: string, status: number, type: string = 'api_error') {
    super(message);
    this.name = 'OpenRouterApiError';
    this.status = status;
    this.type = type;
  }
}

export function validateOpenRouterApiKey(key: string): boolean {
  if (!key || !key.startsWith('sk-or-') || key.length < 20) return false;
  return true;
}

export class OpenRouterService {
  private apiKey: string;
  private baseUrl: string = 'https://openrouter.ai/api/v1';
  private onHeadersReceived?: (headers: Headers) => void;

  constructor(apiKey: string, onHeadersReceived?: (headers: Headers) => void) {
    this.apiKey = apiKey;
    this.onHeadersReceived = onHeadersReceived;
  }

  /**
   * Fundamental cross-platform generateContent using requestUrl.
   */
  async generateContent(
    model: string,
    messages: ChatMessage[],
    options?: GenerationOptions
  ): Promise<string> {
    const body: any = {
      model,
      messages,
      temperature: options?.temperature ?? 0.7,
      top_p: options?.topP ?? 0.95,
      stream: false,
      plugins: options?.plugins
    };

    if (options?.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }

    const response = await requestUrl({
      url: `${this.baseUrl}/chat/completions`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://obsidian.md',
        'X-Title': 'Nexus-LM'
      },
      body: JSON.stringify(body),
      throw: false
    });

    if (response.status >= 400) {
      await this.handleRequestUrlError(response);
    }

    if (this.onHeadersReceived) {
      const headersObj = new Headers();
      Object.entries(response.headers).forEach(([k, v]) => {
          headersObj.set(k, Array.isArray(v) ? v.join(', ') : v);
      });
      this.onHeadersReceived(headersObj);
    }

    return response.json.choices[0]?.message?.content || '';
  }

  async generateContentStream(
    model: string,
    messages: ChatMessage[],
    options: GenerationOptions | undefined,
    onChunk: (chunk: string) => void,
    onThinking?: (thinking: string) => void
  ): Promise<string> {
    const fullHeaders: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://obsidian.md',
      'X-Title': 'Nexus-LM'
    };

    const minimalHeaders: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };

    const buildBody = (stream: boolean) => {
      const body: any = { model, messages, stream };
      if (options?.temperature !== undefined) body.temperature = options.temperature;
      if (options?.topP !== undefined) body.top_p = options.topP;
      if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;
      if (options?.plugins) body.plugins = options.plugins;
      return body;
    };

    const parser = createSSEParser();
    let fullContent = '';
    const callbacks = { onChunk: (text: string) => { fullContent += text; onChunk(text); }, onThinking };

    // Primary: native fetch streaming (true token-level streaming)
    try {
      await fetchStream(
        `${this.baseUrl}/chat/completions`,
        minimalHeaders,
        JSON.stringify(buildBody(true)),
        parser,
        callbacks,
        options?.abortSignal
      );
      return fullContent;
    } catch (error) {
      if (error instanceof OpenRouterApiError) throw error;
          }

    // Fallback: requestUrl simulated streaming (cross-platform)
    try {
      const respHeaders = await simulatedStream(
        `${this.baseUrl}/chat/completions`,
        'POST',
        fullHeaders,
        JSON.stringify(buildBody(true)),
        callbacks,
        options?.abortSignal,
        'openai'
      );
      if (this.onHeadersReceived) {
        const h = new Headers();
        Object.entries(respHeaders).forEach(([k, v]) => h.set(k, Array.isArray(v) ? v.join(', ') : v));
        this.onHeadersReceived(h);
      }
      return fullContent;
    } catch (error) {
      if (error instanceof OpenRouterApiError) throw error;
      throw new OpenRouterApiError(
        `All streaming methods failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        0
      );
    }
  }

  private async handleRequestUrlError(response: any): Promise<never> {
    const errorData = response.json || {};
    const message = errorData.error?.message || `HTTP ${response.status}`;
    throw new OpenRouterApiError(message, response.status);
  }

  async generateContentWithTools(
    model: string,
    messages: ChatMessage[],
    tools: any[],
    options: GenerationOptions,
    executeToolsCallback: (toolCalls: any[]) => Promise<any[]>,
    streamCallback?: (chunk: string) => void
  ): Promise<{ content: string; totalTokens?: number }> {
    let fullContent = '';
    let conversationMessages = [...messages];
    let totalTokens = 0;
    let toolRoundsExecuted = 0;
    const MAX_CONTINUATION_NUDGES = 3;
    let nudgeCount = 0;
    let currentToolChoice = options.toolChoice ?? 'auto';

    while (true) {
      if (options.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      
      const body: any = {
        model,
        messages: conversationMessages,
        temperature: options.temperature ?? 0.7,
        top_p: options.topP ?? 1,
        stream: false
      };

      if (options.maxTokens !== undefined) {
        body.max_tokens = options.maxTokens;
      }

      if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = currentToolChoice;
      }

      const response = await requestUrl({
        url: `${this.baseUrl}/chat/completions`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://obsidian.md',
          'X-Title': 'Nexus-LM'
        },
        body: JSON.stringify(body),
        throw: false
      });

      if (response.status >= 400) await this.handleRequestUrlError(response);
      if (this.onHeadersReceived) {
        const h = new Headers();
        Object.entries(response.headers).forEach(([k, v]) => {
            h.set(k, Array.isArray(v) ? v.join(', ') : v);
        });
        this.onHeadersReceived(h);
      }

      const data = response.json;
      if (data.usage) totalTokens += (data.usage.total_tokens || 0);

      const message = data.choices[0]?.message;
      if (!message) break;
      conversationMessages.push(message);

      if (message.tool_calls && message.tool_calls.length > 0) {
        toolRoundsExecuted++;
        if (currentToolChoice === 'required') currentToolChoice = 'auto';
        const toolResults = await executeToolsCallback(message.tool_calls);
        for (let i = 0; i < message.tool_calls.length; i++) {
          const toolCall = message.tool_calls[i];
          const toolResult = toolResults[i];
          conversationMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: toolResult.success ? toolResult.content : `Error: ${toolResult.error}`
          } as any);
        }
        continue;
      }

      if (message.content) {
        fullContent = message.content;
        if (streamCallback) streamCallback(fullContent);
        break;
      }

      if (toolRoundsExecuted > 0 && nudgeCount < MAX_CONTINUATION_NUDGES) {
        nudgeCount++;
        conversationMessages.push({
          role: 'user',
          content: 'Please synthesise a final answer based on the tool results above.'
        } as any);
        continue;
      }
      break;
    }

    return { content: fullContent, totalTokens };
  }
}
