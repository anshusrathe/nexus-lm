/**
 * Gemini Service - Wrapper for Google Generative AI with rate limit tracking
 * 
 * This service wraps the Google Generative AI SDK to provide consistent
 * rate limit header tracking across all providers.
 */

import { GoogleGenerativeAI, GenerativeModel, ChatSession } from '@google/generative-ai';

export interface GeminiGenerationOptions {
  temperature?: number;
  maxOutputTokens?: number;
  topK?: number;
  topP?: number;
  thinkingConfig?: {
    thinkingBudget?: number;
    thinkingLevel?: 'minimal' | 'low' | 'high';
    includeThoughts?: boolean;
  };
  abortSignal?: AbortSignal;
}

export interface GeminiChatConfig {
  history?: Record<string, unknown>[];
  generationConfig?: GeminiGenerationOptions;
  tools?: Record<string, unknown>[];
}

/**
 * Gemini Service that wraps the Google SDK and provides header tracking
 */
export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private onHeadersReceived?: (headers: Headers) => void;
  
  constructor(apiKey: string, onHeadersReceived?: (headers: Headers) => void) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.onHeadersReceived = onHeadersReceived;
  }
  
  /**
   * Get a generative model instance
   */
  getGenerativeModel(config: { model: string; generationConfig?: any; tools?: any[] }): GenerativeModel {
    return this.genAI.getGenerativeModel(config);
  }
  
  /**
   * Make a direct API call to Gemini to capture headers
   * This is used when we need header information
   */
  private async makeDirectApiCall(
    model: string,
    contents: any[],
    generationConfig?: any,
    tools?: any[],
    abortSignal?: AbortSignal
  ): Promise<{ response: any; headers: Headers }> {
    const apiKey = (this.genAI as unknown as any)._apiKey;
    const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    
    const requestBody: any = {
      contents,
      generationConfig: generationConfig || {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192,
      }
    };
    
    if (tools && tools.length > 0) {
      requestBody.tools = tools;
    }
    
    const response = await fetch(`${baseUrl}/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      signal: abortSignal,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
    }
    
    const data = await response.json();
    return { response: data, headers: response.headers };
  }
  
  /**
   * Generate content with header tracking
   */
  async generateContentWithHeaders(
    model: string,
    prompt: string,
    generationConfig?: any,
    abortSignal?: AbortSignal
  ): Promise<string> {
    const contents = [{ role: 'user', parts: [{ text: prompt }] }];
    const { response, headers } = await this.makeDirectApiCall(model, contents, generationConfig, undefined, abortSignal);
    
    // Report headers for rate limit tracking
    if (this.onHeadersReceived) {
      this.onHeadersReceived(headers);
    }
    
    return response.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  
  /**
   * Start a chat session with header tracking
   * Note: For chat sessions, we can only capture headers on the first message
   */
  async startChatWithHeaders(
    model: string,
    config: GeminiChatConfig
  ): Promise<{ chat: ChatSession; captureHeaders: () => Promise<void> }> {
    const modelInstance = this.genAI.getGenerativeModel({ 
      model,
      generationConfig: config.generationConfig,
      ...(config.tools ? { tools: config.tools } : {})
    });
    
    const chat = modelInstance.startChat({
      history: (config.history as unknown as any) || [],
      generationConfig: config.generationConfig as unknown as any
    });
    
    // Provide a method to capture headers on next API call
    const captureHeaders = async () => {
      // Make a dummy call to capture headers
      try {
        const contents = config.history || [];
        if (contents.length > 0) {
          const { headers } = await this.makeDirectApiCall(
            model,
            contents.slice(-1), // Just use last message
            config.generationConfig,
            config.tools
          );
          
          if (this.onHeadersReceived) {
            this.onHeadersReceived(headers);
          }
        }
      } catch (error) {
              }
    };
    
    return { chat, captureHeaders };
  }

  /**
   * Generate content with tool calling support
   * @param model - The model ID to use
   * @param messages - Array of chat messages in OpenAI format
   * @param tools - Array of tool definitions in OpenAI format
   * @param options - Optional generation parameters
   * @param executeToolsCallback - Callback to execute tools
   * @returns The complete generated text response and total tokens
   */
  async generateContentWithTools(
    model: string,
    messages: any[],
    tools: any[],
    options: GeminiGenerationOptions,
    executeToolsCallback: (toolCalls: any[]) => Promise<any[]>,
    onThinkingChunk?: (text: string) => void,
    streamCallback?: (chunk: string) => void
  ): Promise<{ content: string; totalTokens?: number }> {
    // Convert OpenAI-style tools to Gemini format
    const geminiTools = this.convertToolsToGeminiFormat(tools);

    // Build the full contents array from messages using generateContent directly.
    // We do NOT use startChat() because its history validation rejects sequences
    // that end with a user/functionResponse turn — which is exactly what we inject
    // when resuming a tool conversation from the ledger.
    // generateContent() with a full contents array gives us complete control.
    const { systemInstruction, contents } = this.convertMessagesToGeminiContents(messages);

    const modelInstance = this.genAI.getGenerativeModel({
      model,
      systemInstruction: systemInstruction ? { text: systemInstruction } : undefined,
      tools: geminiTools.length > 0 ? geminiTools : undefined
    });

    let fullContent = '';
    let totalTokens = 0;
    let toolRoundsExecuted = 0;
    const MAX_CONTINUATION_NUDGES = 3;
    let nudgeCount = 0;

    // Mutable contents array — we append turns as the conversation progresses
    const conversationContents = [...contents];

    // Tool calling loop using generateContent directly
    while (true) {
      if (options.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await modelInstance.generateContent({
        contents: conversationContents,
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          topK: options.topK ?? 40,
          topP: options.topP ?? 0.95,
          maxOutputTokens: options.maxOutputTokens ?? 8192,
          ...(options.thinkingConfig ? { thinkingConfig: options.thinkingConfig } : {})
        }
      }, { signal: options.abortSignal });

      const response = result.response;

      // Track tokens
      if ((response as unknown as any).usageMetadata) {
        const usage = (response as unknown as any).usageMetadata;
        totalTokens = (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0);
      }

      const candidate = response.candidates?.[0];
      if (!candidate) break;

      // Extract and emit thought parts for thinking models
      const thoughtParts = candidate.content.parts?.filter((part: any) => part.thought === true);
      if (thoughtParts?.length > 0 && onThinkingChunk) {
        for (const thought of thoughtParts) {
          if (thought.text) onThinkingChunk(thought.text);
        }
      }

      // Append the model's response to the conversation
      conversationContents.push({
        role: 'model',
        parts: candidate.content.parts
      });

      // Check for function calls
      const functionCalls = candidate.content.parts?.filter((part: any) => part.functionCall);

      if (functionCalls && functionCalls.length > 0) {
                toolRoundsExecuted++;

        // Convert Gemini function calls to OpenAI format for the callback
        const toolCalls = functionCalls.map((fc: any, index: number) => ({
          id: `call_${index}`,
          type: 'function',
          function: {
            name: fc.functionCall.name,
            arguments: JSON.stringify(fc.functionCall.args || {})
          }
        }));

        // Execute tools
        const toolResults = await executeToolsCallback(toolCalls);

        // Append function responses as a single user turn (Gemini requires this)
        const functionResponseParts = toolResults.map((res, index) => ({
          functionResponse: {
            name: functionCalls[index]?.functionCall?.name || 'unknown',
            response: {
              content: res.success ? res.content : `Error: ${res.error}`
            }
          }
        }));

        conversationContents.push({
          role: 'user',
          parts: functionResponseParts
        });

        continue;
      }

      // No function calls — this is the synthesis turn
      const textPart = candidate.content.parts?.find((part: any) => part.text && part.thought !== true);
      if (textPart && textPart.text) {
        fullContent = textPart.text;
        if (streamCallback) {
          streamCallback(fullContent);
        }
        break;
      }

      // No function calls AND no text — nudge the model
      if (toolRoundsExecuted > 0 && nudgeCount < MAX_CONTINUATION_NUDGES) {
        nudgeCount++;
                conversationContents.push({
          role: 'user',
          parts: [{ text: 'You have already called some tools and received results. Please now synthesise a complete, direct answer to the original question using all the tool results above. Do not call any more tools — just write the final answer.' }]
        });
        continue;
      }

      break;
    }

    return { content: fullContent, totalTokens };
  }

  /**
   * Convert OpenAI-style messages to Gemini generateContent format.
   * Returns systemInstruction and a contents array ready for generateContent().
   * This handles injected tool history (assistant+tool pairs) correctly by
   * building proper model/functionCall + user/functionResponse turn pairs.
   */
  private convertMessagesToGeminiContents(messages: any[]): {
    systemInstruction: string | null;
    contents: any[];
  } {
    let systemInstruction: string | null = null;
    const contents: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = msg.content;

      } else if (msg.role === 'user') {
        // Plain user text message
        contents.push({
          role: 'user',
          parts: [{ text: msg.content || '' }]
        });

      } else if (msg.role === 'assistant' || msg.role === 'model') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Each tool_call becomes its own model/functionCall turn so that
          // the following user/functionResponse turn pairs correctly with it
          for (const tc of msg.tool_calls) {
            contents.push({
              role: 'model',
              parts: [{
                functionCall: {
                  name: tc.function?.name || tc.name,
                  args: (() => {
                    try {
                      return typeof tc.function?.arguments === 'string'
                        ? JSON.parse(tc.function.arguments)
                        : (tc.function?.arguments || {});
                    } catch { return {}; }
                  })()
                }
              }]
            });
          }
        } else if (msg.content) {
          contents.push({
            role: 'model',
            parts: [{ text: msg.content }]
          });
        }

      } else if (msg.role === 'tool') {
        // Tool result — must be a user turn with functionResponse part,
        // immediately following the model/functionCall turn
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: msg.name || 'tool',
              response: { content: msg.content || '' }
            }
          }]
        });
      }
    }

    return { systemInstruction, contents };
  }
  
  /**
   * Convert OpenAI-style tools to Gemini format
   */
  private convertToolsToGeminiFormat(tools: any[]): any[] {
    return tools.map(tool => {
      // Deep-clone and strip fields Gemini rejects: $schema, additionalProperties
      const parameters = this.sanitizeSchemaForGemini(tool.function.parameters);

      return {
        functionDeclarations: [{
          name: tool.function.name,
          description: tool.function.description,
          parameters
        }]
      };
    });
  }

  /**
   * Recursively removes JSON Schema fields that Gemini's API rejects:
   * - $schema
   * - additionalProperties
   * - $defs / definitions (not supported)
   */
  private sanitizeSchemaForGemini(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(item => this.sanitizeSchemaForGemini(item));

    const cleaned: any = {};
    for (const key of Object.keys(schema)) {
      if (key === '$schema' || key === 'additionalProperties' || key === '$defs' || key === 'definitions') continue;
      cleaned[key] = this.sanitizeSchemaForGemini(schema[key]);
    }
    return cleaned;
  }
}
