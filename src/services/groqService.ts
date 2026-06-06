/**
 * Groq Service - Handles API calls to Groq's OpenAI-compatible API
 * 
 * Groq provides fast LLM inference via an OpenAI-compatible API endpoint.
 * This service handles both streaming and non-streaming requests.
 */

import { requestUrl } from 'obsidian';
import { simulatedStream, fetchStream, createSSEParser } from '../utils/streamingUtils';

export type GroqContentPart = 
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | GroqContentPart[];
  tool_call_id?: string;
  name?: string;
}

export interface GenerationOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  toolChoice?: 'auto' | 'required' | 'none';
  think?: boolean;
  thinkingLevel?: 'low' | 'medium' | 'high';
  abortSignal?: AbortSignal;
}

export interface GroqStreamEvent {
  type: 'content' | 'thinking';
  text: string;
}

/**
 * Interface for parsed web search results
 */
export interface WebSource {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * Interface for Groq web search response
 */
export interface GroqWebSearchResponse {
  content: string;
  webSources: WebSource[];
  thinking?: string;
}

/**
 * Interface for executed tool in Groq response
 */
export interface ExecutedTool {
  index: number;
  type: string;
  arguments: string;
  output: string;
}

export interface GroqErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

/**
 * Custom error class for Groq API errors with status code
 */
export class GroqApiError extends Error {
  status: number;
  type: string;
  
  constructor(message: string, status: number, type: string = 'api_error') {
    super(message);
    this.name = 'GroqApiError';
    this.status = status;
    this.type = type;
  }
}

/**
 * Represents a message in Gemini's chat history format.
 */
export interface GeminiHistoryMessage {
  role: string;
  parts?: Array<{ 
    text?: string; 
    inlineData?: { mimeType: string; data: string } 
  }>;
  content?: string;
}

/**
 * Array of Groq model IDs that support built-in web search tool.
 * Compound models use server-side built-in tools with the compound_custom parameter.
 * GPT-OSS models use the tools parameter with browser_search type.
 */
export const GROQ_WEB_SEARCH_MODELS: string[] = [
  'groq/compound',
  'groq/compound-mini',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-safeguard-20b',
];

/**
 * Array of GPT-OSS model IDs that support browser_search tool.
 * These models use the tools parameter instead of compound_custom.
 */
export const GROQ_GPT_OSS_MODELS: string[] = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-safeguard-20b',
];

/**
 * The specific Groq Vision model that supports image recognition via Llama 4 Scout.
 */
export const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

/**
 * Checks if a Groq model supports built-in web search (Compound models) or browser_search (GPT-OSS models).
 * @param modelId - The model ID to check
 * @returns true if the model supports web search, false otherwise
 */
export function isGroqWebSearchCapable(modelId: string): boolean {
  if (!modelId) return false;
  const normalizedModelId = modelId.toLowerCase();
  return GROQ_WEB_SEARCH_MODELS.some(m => 
    normalizedModelId === m.toLowerCase()
  );
}

/**
 * Checks if a model is a GPT-OSS model that uses browser_search tool.
 * @param modelId - The model ID to check
 * @returns true if the model is a GPT-OSS model, false otherwise
 */
export function isGroqGptOssModel(modelId: string): boolean {
  if (!modelId) return false;
  const normalizedModelId = modelId.toLowerCase();
  return GROQ_GPT_OSS_MODELS.some(m => 
    normalizedModelId === m.toLowerCase()
  );
}

/**
 * Gets a user-friendly message for when web search is not available.
 * @param currentModel - The current model that doesn't support web search
 * @returns A helpful message
 */
export function getWebSearchModelSuggestion(currentModel: string): string {
  return `Web search is not available for "${currentModel}". Please select a Compound model (groq/compound or groq/compound-mini) or a GPT-OSS model (openai/gpt-oss-20b or openai/gpt-oss-120b) for web search.`;
}

/**
 * Custom error class for web search parsing errors.
 * Used when tool call results cannot be parsed correctly.
 */
export class WebSearchParseError extends Error {
  rawData: unknown;
  
  constructor(message: string, rawData?: unknown) {
    super(message);
    this.name = 'WebSearchParseError';
    this.rawData = rawData;
  }
}

/**
 * Estimates token count for a string using character-based heuristic.
 * Standard approximation: 1 token ≈ 4 characters
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Truncates a message content to fit within a token limit.
 * Preserves the beginning of the message and adds truncation indicator.
 */
function truncateContent(content: string, maxTokens: number): string {
  const currentTokens = estimateTokens(content);
  if (currentTokens <= maxTokens) return content;
  
  
  const maxChars = (maxTokens * 4) - 50;
  if (maxChars <= 0) return '[Message truncated]';
  
  return content.substring(0, maxChars) + '... [truncated]';
}

/**
 * Converts Gemini-format chat history to Groq-compatible format.
 * 
 * Handles vision capabilities specifically for the Llama 4 Scout model.
 * 
 * @param geminiHistory - Array of messages in Gemini's format
 * @param modelId - The model ID being used
 * @param maxTotalTokens - Optional maximum total tokens for the entire history
 * @returns Array of messages in Groq's ChatMessage format
 */
export function convertChatHistoryForGroq(
  geminiHistory: GeminiHistoryMessage[],
  modelId: string,
  maxTotalTokens?: number
): ChatMessage[] {
  const isVisionCapable = modelId === GROQ_VISION_MODEL;

  
  const converted: ChatMessage[] = geminiHistory.map(msg => {
    const role = msg.role === 'model' ? 'assistant' : (msg.role as 'user' | 'assistant' | 'system' | 'tool');
    
    
    const hasImages = msg.parts?.some(p => p.inlineData);
    
    if (isVisionCapable && hasImages) {
      const contentParts: GroqContentPart[] = [];
      
      msg.parts?.forEach(part => {
        if (part.text) {
          contentParts.push({ type: 'text', text: part.text });
        } else if (part.inlineData) {
          contentParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
            }
          });
        }
      });
      
      return { role, content: contentParts };
    }

    
    return {
      role,
      content: msg.parts?.map(p => p.text || '').join('') || msg.content || ''
    };
  }).filter(msg => {
    if (typeof msg.content === 'string') return msg.content.trim().length > 0;
    if (Array.isArray(msg.content)) return msg.content.length > 0;
    return false;
  });

  
  if (!maxTotalTokens || maxTotalTokens <= 0) {
    return converted;
  }

  
  
  const historyTokenBudget = Math.floor(maxTotalTokens * 0.6);
  
  
  const maxTokensPerMessage = Math.floor(historyTokenBudget * 0.25);

  
  const result: ChatMessage[] = [];
  let totalTokens = 0;

  for (let i = converted.length - 1; i >= 0; i--) {
    const msg = converted[i];
    
    
    let textContent = '';
    if (Array.isArray(msg.content)) {
      textContent = msg.content
        .filter(p => p.type === 'text')
        .map(p => (p as { text: string }).text)
        .join('');
    } else {
      textContent = msg.content;
    }

    let msgTokens = estimateTokens(textContent);

    
    if (!Array.isArray(msg.content) && msgTokens > maxTokensPerMessage) {
      msg.content = truncateContent(msg.content, maxTokensPerMessage);
      msgTokens = estimateTokens(msg.content);
    }

    
    if (totalTokens + msgTokens > historyTokenBudget) {
      if (result.length === 0 && !Array.isArray(msg.content)) {
        const remainingTokens = historyTokenBudget - totalTokens;
        if (remainingTokens > 50) {
          msg.content = truncateContent(msg.content, remainingTokens);
          result.unshift(msg);
        }
      }
      break;
    }

    result.unshift(msg);
    totalTokens += msgTokens;
  }

  return result;
}

export class GroqService {
  private apiKey: string;
  private baseUrl: string = 'https://api.groq.com/openai/v1';
  
  
  private onHeadersReceived?: (headers: Headers) => void;

  constructor(apiKey: string, onHeadersReceived?: (headers: Headers) => void) {
    this.apiKey = apiKey;
    this.onHeadersReceived = onHeadersReceived;
  }


  /**
   * Generates content using Groq's chat completions API (non-streaming).
   * @param model - The model ID to use (e.g., 'llama-3.3-70b-versatile')
   * @param messages - Array of chat messages
   * @param options - Optional generation parameters
   * @returns The generated text response
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
      stream: false
    };
    
    
    if (options?.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }
    
    if (options?.thinkingLevel) {
      body.reasoning_effort = options.thinkingLevel;
    }
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: options?.abortSignal,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    
    if (this.onHeadersReceived) {
      this.onHeadersReceived(response.headers);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  }

  /**
   * Generates content using Groq's chat completions API with streaming.
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
    onChunk: (chunk: string) => void
  ): Promise<string> {
    const body: any = {
      model,
      messages,
      temperature: options?.temperature ?? 0.7,
      top_p: options?.topP ?? 0.95,
      stream: true
    };
    if (options?.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }
    if (options?.thinkingLevel) {
      body.reasoning_effort = options.thinkingLevel;
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };

    const parser = createSSEParser();
    let fullContent = '';
    const callbacks = { onChunk: (text: string) => { fullContent += text; onChunk(text); } };

    
    try {
      await fetchStream(
        `${this.baseUrl}/chat/completions`,
        headers,
        JSON.stringify(body),
        parser,
        callbacks,
        options?.abortSignal
      );
      return fullContent;
    } catch (error) {
      if (error instanceof GroqApiError) throw error;
          }

    
    try {
      const respHeaders = await simulatedStream(
        `${this.baseUrl}/chat/completions`,
        'POST',
        headers,
        JSON.stringify(body),
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
      if (error instanceof GroqApiError) throw error;
      throw new GroqApiError(
        `Streaming failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        0,
        'stream_error'
      );
    }
  }

  /**
   * Generates content using Groq's chat API with structured stream events.
   * Emits `thinking` and `content` separately when available for GPT-OSS models.
   *
   * For GPT-OSS models with thinking enabled, we use non-streaming to ensure we get
   * reasoning_content from the final message, since these models may not stream thinking tokens.
   *
   * @param model - The model ID to use
   * @param messages - Array of chat messages
   * @param onEvent - Callback function called with each event (thinking or content)
   * @param options - Optional generation parameters
   * @returns Promise<void>
   */
  async generateContentStreamEvents(
    model: string,
    messages: ChatMessage[],
    onEvent: (evt: GroqStreamEvent) => void,
    options?: GenerationOptions
  ): Promise<void> {
    const isGptOss = model.toLowerCase().includes('gpt-oss');
    const useThinking = isGptOss && options?.thinkingLevel;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };

    if (useThinking) {
      await this.generateContentWithThinking(model, messages, onEvent, options, headers);
      return;
    }

    const requestBody: any = {
      model,
      messages,
      stream: true,
      temperature: options?.temperature ?? 0.7,
      top_p: options?.topP ?? 0.95,
    };
    if (options?.maxTokens !== undefined) {
      requestBody.max_tokens = options.maxTokens;
    }
    if (options?.thinkingLevel) {
      requestBody.reasoning_effort = options.thinkingLevel;
    }

    const parser = createSSEParser();
    const callbacks = {
      onChunk: (text: string) => onEvent({ type: 'content', text }),
      onThinking: (text: string) => onEvent({ type: 'thinking', text })
    };

    
    try {
      await fetchStream(
        `${this.baseUrl}/chat/completions`,
        headers,
        JSON.stringify(requestBody),
        parser,
        callbacks,
        options?.abortSignal
      );
      return;
    } catch (error) {
      if (error instanceof GroqApiError) throw error;
          }

    
    try {
      const respHeaders = await simulatedStream(
        `${this.baseUrl}/chat/completions`,
        'POST',
        headers,
        JSON.stringify(requestBody),
        callbacks,
        options?.abortSignal,
        'openai'
      );
      if (this.onHeadersReceived) {
        const h = new Headers();
        Object.entries(respHeaders).forEach(([k, v]) => h.set(k, Array.isArray(v) ? v.join(', ') : v));
        this.onHeadersReceived(h);
      }
    } catch (error) {
      if (error instanceof GroqApiError) throw error;
      throw new GroqApiError(
        `Streaming failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        0,
        'stream_error'
      );
    }
  }

  private async generateContentWithThinking(
    model: string,
    messages: ChatMessage[],
    onEvent: (evt: GroqStreamEvent) => void,
    options: GenerationOptions | undefined,
    headers: Record<string, string>
  ): Promise<void> {
    const body: any = {
      model,
      messages,
      stream: false,
      temperature: options?.temperature ?? 0.7,
      top_p: options?.topP ?? 0.95,
    };
    if (options?.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }
    body.reasoning_effort = options?.thinkingLevel;

    
    try {
      const resp = await requestUrl({
        url: `${this.baseUrl}/chat/completions`,
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        throw: false
      });
      if (this.onHeadersReceived) {
        const h = new Headers();
        Object.entries(resp.headers).forEach(([k, v]) => h.set(k, Array.isArray(v) ? v.join(', ') : v));
        this.onHeadersReceived(h);
      }
      if (resp.status >= 400) {
        const errorData: GroqErrorResponse = typeof resp.json === 'object' ? resp.json : { error: { message: `HTTP ${resp.status}` } };
        throw new GroqApiError(errorData.error?.message || `Groq API error: ${resp.status}`, resp.status);
      }
      const data = resp.json;
      const message = data.choices[0]?.message;
      const reasoning = message?.reasoning_content || message?.reasoning || '';
      if (reasoning) onEvent({ type: 'thinking', text: reasoning });
      const content = message?.content || '';
      if (content) onEvent({ type: 'content', text: content });
      return;
    } catch (error) {
      if (error instanceof GroqApiError) throw error;
          }

    
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: options?.abortSignal,
        headers,
        body: JSON.stringify(body)
      });
      if (!response.ok) await this.handleErrorResponse(response);
      if (this.onHeadersReceived) this.onHeadersReceived(response.headers);
      const data = await response.json();
      const message = data.choices[0]?.message;
      const reasoning = message?.reasoning_content || message?.reasoning || '';
      if (reasoning) onEvent({ type: 'thinking', text: reasoning });
      const content = message?.content || '';
      if (content) onEvent({ type: 'content', text: content });
    } catch (error) {
      if (error instanceof GroqApiError) throw error;
      throw new GroqApiError(
        `Non-streaming generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        0
      );
    }
  }

  /**
   * Generates content using Groq's chat completions API with built-in web search.
   * Supports both Compound models (compound_custom) and GPT-OSS models (browser_search tool).
   * Uses non-streaming to ensure executed_tools are captured properly.
   * @param model - The model ID to use (must be a web search capable model)
   * @param messages - Array of chat messages
   * @param options - Optional generation parameters
   * @param onChunk - Optional callback function called with each text chunk (simulated for non-streaming)
   * @returns Object containing the generated content and extracted web sources
   */
  async generateContentWithWebSearch(
    model: string,
    messages: ChatMessage[],
    options?: GenerationOptions,
    onChunk?: (chunk: string) => void,
    onThinking?: (thinking: string) => void
  ): Promise<GroqWebSearchResponse> {
    const isCompoundModel = isGroqWebSearchCapable(model) && !isGroqGptOssModel(model);
    const isGptOssModel = isGroqGptOssModel(model);
    
    const requestBody: any = {
      model,
      messages,
      temperature: options?.temperature ?? 0.7,
      top_p: options?.topP ?? 0.95,
      stream: false
    };
    if (options?.maxTokens !== undefined) {
      requestBody.max_tokens = options.maxTokens;
    }

    
    if (isGptOssModel && options?.thinkingLevel) {
      requestBody.reasoning_effort = options.thinkingLevel;
    }

    
    if (isCompoundModel) {
      
      requestBody.compound_custom = {
        tools: {
          enabled_tools: ['web_search']
        }
      };
    } else if (isGptOssModel) {
      
      requestBody.tools = [{ type: 'browser_search' }];
      requestBody.tool_choice = 'required';
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: options?.abortSignal,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    
    if (this.onHeadersReceived) {
      this.onHeadersReceived(response.headers);
    }

    const data = await response.json();
        
    const choice = data.choices?.[0];
    if (!choice) {
      throw new GroqApiError('No choices in response', 500, 'invalid_response');
    }

    const fullResponse = choice.message?.content || '';
    
    
    const thinking = choice.message?.reasoning_content || choice.message?.reasoning || '';
    
    
    if (onThinking && thinking) {
      onThinking(thinking);
    }
    
    
    if (onChunk && fullResponse) {
      
      const words = fullResponse.split(' ');
      for (let i = 0; i < words.length; i++) {
        onChunk(words[i] + (i < words.length - 1 ? ' ' : ''));
      }
    }

    let webSources: WebSource[] = [];
    let executedTools: ExecutedTool[] = [];

    
    if (choice.message?.executed_tools) {
      executedTools = choice.message.executed_tools;
          } else if (choice.executed_tools) {
      executedTools = choice.executed_tools;
          } else if (data.executed_tools) {
      executedTools = data.executed_tools;
          }

    
    if (executedTools.length > 0) {
            webSources = this.parseExecutedTools(executedTools);
          } else {
          }

    return {
      content: fullResponse,
      webSources,
      thinking: thinking || undefined
    };
  }

  /**
   * Parses executed_tools from Groq's response to extract web sources.
   * Groq's built-in tools return results in the executed_tools array.
   * @param executedTools - Array of executed tools from the API response
   * @returns Array of parsed WebSource objects
   */
  private parseExecutedTools(executedTools: ExecutedTool[]): WebSource[] {
    const webSources: WebSource[] = [];
    
    for (const tool of executedTools) {
      try {
        
        if (tool.type === 'search' || tool.type === 'web_search' || tool.type === 'browser_search') {
          
          if (tool.output) {
            
            
            const sources = this.extractSourcesFromOutput(tool.output);
            webSources.push(...sources);
          }
          
          
          if (tool.arguments) {
            try {
              const args = JSON.parse(tool.arguments);
              if (args.results && Array.isArray(args.results)) {
                const parsedResults = this.parseWebSearchResults(args.results);
                webSources.push(...parsedResults);
              }
            } catch {
              
            }
          }
        }
      } catch (error) {
              }
    }
    
    return webSources;
  }

  /**
   * Extracts web sources from the output text of executed tools.
   * The output typically contains formatted text with URLs and titles.
   * @param output - The output text from the executed tool
   * @returns Array of parsed WebSource objects
   */
  private extractSourcesFromOutput(output: string): WebSource[] {
    const sources: WebSource[] = [];
    
    if (!output) return sources;
    
    
    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) {
        return this.parseWebSearchResults(parsed);
      } else if (parsed.results && Array.isArray(parsed.results)) {
        return this.parseWebSearchResults(parsed.results);
      }
    } catch {
      
    }
    
    
    
    
    
    const titleUrlPattern = /Title:\s*([^\n]+?)(?:\n|\s+)(?:URL|Link):\s*(https?:\/\/[^\s\n]+)/gi;
    let match;
    while ((match = titleUrlPattern.exec(output)) !== null) {
      sources.push({
        title: match[1].trim(),
        url: match[2].trim(),
        snippet: ''
      });
    }
    
    
    const markdownPattern = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
    while ((match = markdownPattern.exec(output)) !== null) {
      sources.push({
        title: match[1].trim(),
        url: match[2].trim(),
        snippet: ''
      });
    }
    
    
    if (sources.length === 0) {
      const urlPattern = /(https?:\/\/[^\s\n]+)/g;
      while ((match = urlPattern.exec(output)) !== null) {
        const url = match[1].trim();
        sources.push({
          title: url,
          url: url,
          snippet: ''
        });
      }
    }
    
    return sources;
  }

  /**
   * Parses web search results from tool call response.
   * Handles various response formats gracefully and logs parsing issues.
   * @param results - Array of raw search results from the API
   * @returns Array of parsed WebSource objects
   */
  private parseWebSearchResults(results: unknown[]): WebSource[] {
    const webSources: WebSource[] = [];
    
    if (!Array.isArray(results)) {
            return webSources;
    }
    
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      try {
        if (typeof result === 'object' && result !== null) {
          const r = result as Record<string, unknown>;
          const title = (r.title as string) || (r.name as string) || '';
          const url = (r.url as string) || (r.link as string) || (r.href as string) || '';
          const snippet = (r.snippet as string) || (r.description as string) || (r.content as string) || '';
          
          if (url) {
            webSources.push({
              title: title || url,
              url,
              snippet: snippet || undefined
            });
          } else {
                      }
        } else {
                  }
      } catch (parseError) {
                
      }
    }
    
    if (webSources.length === 0 && results.length > 0) {
          }
    
    return webSources;
  }


  /**
   * Handles error responses from the Groq API.
   * Throws appropriate GroqApiError based on status code.
   * @param response - The fetch Response object
   * @throws GroqApiError with user-friendly message
   */
  private async handleErrorResponse(response: Response): Promise<never> {
    let errorMessage: string;
    let errorType = 'api_error';

    try {
      const errorData: GroqErrorResponse = await response.json();
      errorMessage = errorData.error?.message || 'Unknown error occurred';
      errorType = errorData.error?.type || 'api_error';
    } catch {
      errorMessage = `HTTP error ${response.status}`;
    }

    
    switch (response.status) {
      case 401:
        throw new GroqApiError(
          'Invalid API key. Please check your Groq API key in settings.',
          401,
          'authentication_error'
        );
      case 429:
        throw new GroqApiError(
          'Rate limit exceeded. Please wait a moment and try again.',
          429,
          'rate_limit_error'
        );
      case 404:
        throw new GroqApiError(
          'Model not found. Please select a valid model.',
          404,
          'model_not_found'
        );
      default:
        if (response.status >= 500) {
          throw new GroqApiError(
            'Groq service is temporarily unavailable. Please try again later.',
            response.status,
            'server_error'
          );
        }
        throw new GroqApiError(errorMessage, response.status, errorType);
    }
  }

  /**
   * Returns a user-friendly error message for display in the UI.
   * @param error - The error to get a message for
   * @returns A user-friendly error message string
   */
  static getReadableErrorMessage(error: unknown): string {
    if (error instanceof GroqApiError) {
      return error.message;
    }
    if (error instanceof Error) {
      return error.message;
    }
    return 'An unexpected error occurred';
  }

  /**
   * Generate content with tool calling support
   */
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
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: options?.abortSignal,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: conversationMessages,
          tools,
          tool_choice: currentToolChoice,
          temperature: options.temperature ?? 0.7,
          ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
          top_p: options.topP ?? 1,
          stream: false
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new GroqApiError(
          errorData.error?.message || 'Groq API request failed',
          response.status,
          'groq_api_error'
        );
      }

      const data = await response.json();
      
      if (data.usage) {
        totalTokens += (data.usage.total_tokens || 0);
      }

      const message = data.choices[0]?.message;
      if (!message) break;

      
      conversationMessages.push(message);

      
      if (message.tool_calls && message.tool_calls.length > 0) {
                toolRoundsExecuted++;
        
        
        
        if (currentToolChoice === 'required') {
          currentToolChoice = 'auto';
        }
        
        
        const toolResults = await executeToolsCallback(message.tool_calls);
        
        
        for (let i = 0; i < message.tool_calls.length; i++) {
          const toolCall = message.tool_calls[i];
          const toolResult = toolResults[i];
          
          conversationMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: toolResult.success 
              ? toolResult.content 
              : `Error: ${toolResult.error}`
          } as any);
        }
        
        
        continue;
      }

      
      if (message.content) {
        
        fullContent = message.content;
        
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
        } as any);
        continue;
      }

      
      break;
    }

    return { content: fullContent, totalTokens };
  }
}
