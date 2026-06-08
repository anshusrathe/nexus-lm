/**
 * NVIDIA Service - Handles API calls to NVIDIA NIM API
 * 
 * NVIDIA NIM provides access to various LLMs through an OpenAI-compatible API.
 * This service handles both streaming and non-streaming requests.
 */

import { requestUrl } from 'obsidian';
import { simulatedStream, fetchStream, createSSEParser } from '../utils/streamingUtils';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
}
export interface GenerationOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  toolChoice?: 'auto' | 'required' | 'none';
  abortSignal?: AbortSignal;
}

export interface NvidiaErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

/**
 * Custom error class for NVIDIA API errors with status code
 */
export class NvidiaApiError extends Error {
  status: number;
  type: string;
  
  constructor(message: string, status: number, type: string = 'api_error') {
    super(message);
    this.name = 'NvidiaApiError';
    this.status = status;
    this.type = type;
  }
}

/**
 * Validates a NVIDIA API key.
 * NVIDIA API keys must have a minimum length of 20 characters.
 * @param key - The API key to validate
 * @returns true if the key is valid, false otherwise
 */
export function validateNvidiaApiKey(key: string): boolean {
  if (!key) return false;
  if (key.length < 20) return false;
  return true;
}

export class NvidiaService {
  private apiKey: string;
  private baseUrl: string = 'https://integrate.api.nvidia.com';
  
  // Callback to report response headers for rate limit tracking
  private onHeadersReceived?: (headers: Headers) => void;

  constructor(apiKey: string, onHeadersReceived?: (headers: Headers) => void) {
    this.apiKey = apiKey;
    this.onHeadersReceived = onHeadersReceived;
  }

  /**
   * Generates content using NVIDIA's chat completions API (non-streaming).
   * Uses requestUrl to bypass CORS in Obsidian.
   * @param model - The model ID to use
   * @param messages - Array of chat messages
   * @param options - Optional generation parameters
   * @returns The generated text response
   */
  async generateContent(
    model: string,
    messages: ChatMessage[],
    options?: GenerationOptions
  ): Promise<string> {
    const requestBody = {
      model,
      messages,
      temperature: options?.temperature ?? 0.7,
      top_p: options?.topP ?? 0.95,
      max_tokens: options?.maxTokens ?? 8192,
      stream: false
    };

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://obsidian.md',
      'X-Title': 'Obsidian AI Tutor'
    };

    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/v1/chat/completions`,
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        throw: false
      });

      // Report headers for rate limit tracking
      if (this.onHeadersReceived && response.headers) {
        const headersObj = new Headers();
        Object.entries(response.headers).forEach(([key, value]) => {
          headersObj.set(key, value);
        });
        this.onHeadersReceived(headersObj);
      }

      if (response.status >= 400) {
        const errorData: NvidiaErrorResponse = typeof response.json === 'object' ? response.json : { error: { message: `HTTP ${response.status}: Request failed` } };
        throw new NvidiaApiError(errorData.error?.message || `HTTP ${response.status}: API request failed`, response.status);
      }

      const data = response.json;
      return data.choices[0]?.message?.content || '';
    } catch (error) {
      if (error instanceof NvidiaApiError) throw error;
      // Convert fetch errors to NvidiaApiError
      throw new NvidiaApiError(`Request failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 0);
    }
  }

  /**
   * Generates content using NVIDIA's chat completions API with streaming.
   * Uses requestUrl as primary (cross-platform, bypasses CORS), fetch as fallback.
   * @param model - The model ID to use
   * @param messages - Array of chat messages
   * @param options - Optional generation parameters
   * @param onChunk - Callback function called with each text chunk
   * @returns The complete generated text response
   */
  async generateContentStream(
    model: string,
    messages: ChatMessage[],
    options: GenerationOptions | undefined,
    onChunk: (chunk: string) => void,
    onThinking?: (thinking: string) => void
  ): Promise<string> {
    const buildBody = (stream: boolean) => ({
      model,
      messages,
      temperature: options?.temperature ?? 0.7,
      top_p: options?.topP ?? 0.95,
      max_tokens: options?.maxTokens ?? 8192,
      stream
    });

    const fullHeaders: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://obsidian.md',
      'X-Title': 'Obsidian AI Tutor'
    };

    const minimalHeaders: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const parser = createSSEParser();
    let fullContent = '';
    const callbacks = { onChunk: (text: string) => { fullContent += text; onChunk(text); }, onThinking };

    // Primary: native fetch streaming (true token-level streaming when available)
    try {
      await fetchStream(
        `${this.baseUrl}/v1/chat/completions`,
        minimalHeaders,
        JSON.stringify(buildBody(true)),
        parser,
        callbacks,
        options?.abortSignal
      );
      return fullContent;
    } catch (error) {
      if (error instanceof NvidiaApiError) throw error;
          }

    // Fallback: requestUrl simulated streaming (cross-platform, bypasses CORS)
    try {
      const respHeaders = await simulatedStream(
        `${this.baseUrl}/v1/chat/completions`,
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
      if (error instanceof NvidiaApiError) throw error;
      throw new NvidiaApiError(
        `All streaming methods failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        0
      );
    }
  }

  /**
   * Generates content with tool calling support.
   * @param model - The model ID to use
   * @param messages - Array of chat messages
   * @param tools - Array of tool definitions
   * @param options - Optional generation parameters
   * @param executeToolCallback - Callback to execute tools and return results
   * @returns The generated text response with tool results
   */
  async generateContentWithTools(
    model: string,
    messages: ChatMessage[],
    tools: SafeAny[],
    options: GenerationOptions | undefined,
    executeToolCallback: (toolCalls: SafeAny[]) => Promise<SafeAny[]>,
    streamCallback?: (chunk: string) => void
  ): Promise<{ content: string; totalTokens?: number }> {
    let allMessages = [...messages];
    let totalTokens: number | undefined;
    let finalContent = '';

    let toolCallsMade = false;
    let maxToolIterations = 5;

    while (!toolCallsMade && maxToolIterations > 0) {
      if (options?.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      maxToolIterations--;

      const requestBody = {
        model,
        messages: allMessages,
        temperature: options?.temperature ?? 0.7,
        top_p: options?.topP ?? 0.95,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? (options?.toolChoice ?? 'auto') : undefined,
        max_tokens: options?.maxTokens ?? 8192,
        stream: false
      };

      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://obsidian.md',
        'X-Title': 'Obsidian AI Tutor'
      };

      const response = await requestUrl({
        url: `${this.baseUrl}/v1/chat/completions`,
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        throw: false
      });

      if (response.status >= 400) {
        const errorData: NvidiaErrorResponse = typeof response.json === 'object' ? response.json : { error: { message: `HTTP ${response.status}: Request failed` } };
        throw new NvidiaApiError(errorData.error?.message || `HTTP ${response.status}: API request failed`, response.status);
      }

      // Report headers for rate limit tracking
      if (this.onHeadersReceived && response.headers) {
        const headersObj = new Headers();
        Object.entries(response.headers).forEach(([key, value]) => {
          headersObj.set(key, value);
        });
        this.onHeadersReceived(headersObj);
      }

      const data = response.json;
      const message = data.choices?.[0]?.message;
      
      // Track token usage
      if (data.usage) {
        totalTokens = (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0);
      }

      // Add assistant message to conversation
      allMessages.push(message);

      // Check for tool calls
      const toolCalls = message?.tool_calls || [];
      if (toolCalls.length > 0) {
        // Execute tools
        const toolResults = await executeToolCallback(toolCalls);
        
        // Add tool results to conversation
        for (const toolCall of toolCalls) {
          const result = toolResults.find((r: SafeAny) => r.toolCallId === toolCall.id);
          const resultContent = result?.success !== false ? result?.content || '' : `Error: ${result?.error || 'Tool execution failed'}`;
          
          allMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultContent
          });
        }
      } else {
        // No more tool calls, this is the final response
        finalContent = message?.content || '';
        if (streamCallback) {
          streamCallback(finalContent);
        }
        toolCallsMade = true;
      }
    }

    return { content: finalContent, totalTokens };
  }

  /**
   * Handles error responses from NVIDIA API
   */
  private async handleErrorResponse(response: Response): Promise<void> {
    try {
      const data = await response.json();
      const errorMsg = data.error?.message || `HTTP ${response.status}: API request failed`;
      throw new NvidiaApiError(errorMsg, response.status, data.error?.type);
    } catch (e) {
      if (e instanceof NvidiaApiError) throw e;
      throw new NvidiaApiError(`HTTP ${response.status}: ${response.statusText}`, response.status);
    }
  }
}