/**
 * Gemini Service - Wrapper for Google Generative AI with rate limit tracking
 * 
 * This service wraps the Google Generative AI SDK to provide consistent
 * rate limit header tracking across all providers.
 */

import { GoogleGenerativeAI, GenerativeModel, ChatSession, GenerationConfig, Content, Part } from '@google/generative-ai';
import { requestUrl } from 'obsidian';

interface OpenAIMessage {
  role: string;
  content?: string;
  name?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: {
      name: string;
      arguments: string;
    };
    name?: string;
  }>;
}

interface OpenAITool {
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface ToolCallResult {
  success: boolean;
  content: string;
  error?: string;
}

interface GeminiApiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<Record<string, unknown>>;
      role?: string;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

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
  getGenerativeModel(config: { model: string; generationConfig?: GenerationConfig; tools?: Record<string, unknown>[] }): GenerativeModel {
    return this.genAI.getGenerativeModel(config);
  }
  
  /**
   * Make a direct API call to Gemini to capture headers
   * This is used when we need header information
   */
  private async makeDirectApiCall(
    model: string,
    contents: Content[],
    generationConfig?: Record<string, unknown>,
    tools?: Record<string, unknown>[],
    abortSignal?: AbortSignal
  ): Promise<{ response: GeminiApiResponse; headers: Headers }> {
    const apiKey = (this.genAI as unknown as { apiKey: string }).apiKey;
    const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    
    const requestBody: Record<string, unknown> = {
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
    
    const response = await requestUrl({
      url: `${baseUrl}/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      throw: false
    });
    
    if (response.status >= 400) {
      const errorData = response.json as { error?: { message?: string } };
      const errorMsg = errorData?.error?.message || `Gemini API error: ${response.status}`;
      throw new Error(typeof errorMsg === 'string' ? errorMsg : `Gemini API error: ${response.status}`);
    }
    
    const data = response.json as GeminiApiResponse;
    const h = new Headers();
    Object.entries(response.headers).forEach(([k, v]) => h.set(k, Array.isArray(v) ? v.join(', ') : v));
    return { response: data, headers: h };
  }
  
  /**
   * Generate content with header tracking
   */
  async generateContentWithHeaders(
    model: string,
    prompt: string,
    generationConfig?: Record<string, unknown>,
    abortSignal?: AbortSignal,
    onFinish?: (finishReason: string) => void
  ): Promise<string> {
    const contents: Content[] = [{ role: 'user', parts: [{ text: prompt }] }];
    const { response, headers } = await this.makeDirectApiCall(model, contents, generationConfig, undefined, abortSignal);
    
    // Report headers for rate limit tracking
    if (this.onHeadersReceived) {
      this.onHeadersReceived(headers);
    }

    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason && onFinish) onFinish(finishReason);
    
    return (response.candidates?.[0]?.content?.parts?.[0]?.text as string) || '';
  }

  async generateContentStream(
    model: string,
    prompt: string,
    generationConfig: GeminiGenerationOptions | undefined,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    const modelInstance = this.genAI.getGenerativeModel({
      model,
      generationConfig: generationConfig as GenerationConfig,
    });
    const result = await modelInstance.generateContentStream(prompt, { signal: generationConfig?.abortSignal });
    let content = '';
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (!text) continue;
      content += text;
      onChunk(text);
    }
    return content;
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
      history: (config.history as unknown as Content[]) || [],
      generationConfig: config.generationConfig as GenerationConfig
    });
    
    // Provide a method to capture headers on next API call
    const captureHeaders = async () => {
      // Make a dummy call to capture headers
      try {
        const contents = (config.history || []) as unknown as Content[];
        if (contents.length > 0) {
          const { headers } = await this.makeDirectApiCall(
            model,
            contents.slice(-1), // Just use last message
            config.generationConfig as unknown as Record<string, unknown>,
            config.tools
          );
          
          if (this.onHeadersReceived) {
            this.onHeadersReceived(headers);
          }
        }
      } catch (e: unknown) {
        if (e instanceof Error) {
          // Silently ignore header capture failures
        }
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
    messages: OpenAIMessage[],
    tools: OpenAITool[],
    options: GeminiGenerationOptions,
    executeToolsCallback: (toolCalls: OpenAITool['function'][]) => Promise<ToolCallResult[]>,
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
      if (response.usageMetadata) {
        const usage = response.usageMetadata;
        totalTokens = (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0);
      }

      const candidate = response.candidates?.[0];
      if (!candidate) break;

      // Extract and emit thought parts for thinking models
      const thoughtParts = candidate.content?.parts?.filter((part) => (part as unknown as Record<string, unknown>).thought === true);
      if (thoughtParts?.length > 0 && onThinkingChunk) {
        for (const thought of thoughtParts) {
          if ((thought as unknown as Record<string, unknown>).text) onThinkingChunk((thought as unknown as Record<string, unknown>).text as string);
        }
      }

      // Append the model's response to the conversation
      conversationContents.push({
        role: 'model',
        parts: candidate.content?.parts
      });

      // Check for function calls
      const functionCalls = candidate.content?.parts?.filter((part) => (part as unknown as Record<string, unknown>).functionCall);

      if (functionCalls && functionCalls.length > 0) {
                toolRoundsExecuted++;

        // Convert Gemini function calls to OpenAI format for the callback
        const toolCalls = functionCalls.map((fc, index) => {
          const fcRecord = fc as unknown as Record<string, unknown>;
          const functionCall = fcRecord.functionCall as Record<string, unknown>;
          return {
            id: `call_${index}`,
            type: 'function',
            function: {
              name: functionCall.name as string,
              arguments: JSON.stringify(functionCall.args || {})
            }
          };
        });

        // Execute tools
        const toolResults = await executeToolsCallback(toolCalls.map(tc => tc.function));

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
      const textPart = candidate.content?.parts?.find((part) => (part as unknown as Record<string, unknown>).text && (part as unknown as Record<string, unknown>).thought !== true);
      if (textPart && (textPart as unknown as Record<string, unknown>).text) {
        fullContent = (textPart as unknown as Record<string, unknown>).text as string;
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
   * Single-round native tool calling: one request, returns function calls without executing them.
   * The caller owns the tool execution loop.
   */
  async generateContentWithToolsOnce(
    model: string,
    messages: OpenAIMessage[],
    tools: OpenAITool[],
    options: GeminiGenerationOptions
  ): Promise<{ content: string; finishReason?: string; toolCalls?: Array<Record<string, unknown>>; thinking?: string }> {
    if (options.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const geminiTools = this.convertToolsToGeminiFormat(tools);
    const { systemInstruction, contents } = this.convertMessagesToGeminiContents(messages);

    const modelInstance = this.genAI.getGenerativeModel({
      model,
      systemInstruction: systemInstruction ? { text: systemInstruction } : undefined,
      tools: geminiTools.length > 0 ? geminiTools : undefined
    });

    const result = await modelInstance.generateContent({
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        topK: options.topK ?? 40,
        topP: options.topP ?? 0.95,
        maxOutputTokens: options.maxOutputTokens ?? 8192,
        ...(options.thinkingConfig ? { thinkingConfig: options.thinkingConfig } : {})
      }
    }, { signal: options.abortSignal });

    const response = result.response;
    const candidate = response.candidates?.[0];
    if (!candidate) return { content: '' };

    const parts = candidate.content?.parts ?? [];
    const functionCalls = parts.filter((part) => (part as unknown as Record<string, unknown>).functionCall);
    const textPart = parts.find((part) => (part as unknown as Record<string, unknown>).text && (part as unknown as Record<string, unknown>).thought !== true);
    const thinking = parts
      .filter((part) => (part as unknown as Record<string, unknown>).thought === true)
      .map((part) => String((part as unknown as Record<string, unknown>).text ?? ''))
      .filter((t) => t.length > 0)
      .join('\n');

    return {
      content: (textPart as unknown as Record<string, unknown>)?.text ? String((textPart as unknown as Record<string, unknown>).text) : '',
      finishReason: candidate.finishReason ? candidate.finishReason.toLowerCase() : undefined,
      toolCalls: functionCalls.length > 0 ? functionCalls as unknown as Array<Record<string, unknown>> : undefined,
      thinking: thinking.length > 0 ? thinking : undefined,
    };
  }

  /**
   * Convert OpenAI-style messages to Gemini generateContent format.
   * Returns systemInstruction and a contents array ready for generateContent().
   * This handles injected tool history (assistant+tool pairs) correctly by
   * building proper model/functionCall + user/functionResponse turn pairs.
   */
  private convertMessagesToGeminiContents(messages: OpenAIMessage[]): {
    systemInstruction: string | null;
    contents: Content[];
  } {
    let systemInstruction: string | null = null;
    const contents: Content[] = [];

    // Gemini 3.x validates thought signatures per "step". Parallel function calls
    // returned in ONE response form ONE step: the API attaches a thought_signature
    // only to the FIRST functionCall part of that step. Splitting parallel calls
    // into separate model/functionCall turns would make each one a new step whose
    // first functionCall requires its own signature — causing 400 errors. So we
    // rebuild each assistant tool_calls message as ONE model content with N parts,
    // followed by ONE user content with N functionResponse parts.
    let pendingToolResponses = 0;
    const pendingResponseParts: Array<Record<string, unknown>> = [];

    const flushPendingToolResponses = () => {
      if (pendingResponseParts.length > 0) {
        contents.push({
          role: 'user',
          parts: [...pendingResponseParts] as unknown as Part[]
        });
        pendingResponseParts.length = 0;
        pendingToolResponses = 0;
      }
    };

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Multiple system messages (policy, memory, tool rules, context) must all
        // be preserved — join them instead of letting the last one win.
        systemInstruction = systemInstruction
          ? `${systemInstruction}\n\n${msg.content ?? ''}`
          : (msg.content ?? null);

      } else if (msg.role === 'user') {
        flushPendingToolResponses();
        // Plain user text message
        contents.push({
          role: 'user',
          parts: [{ text: msg.content || '' }]
        });

      } else if (msg.role === 'assistant' || msg.role === 'model') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          flushPendingToolResponses();
          // One model content with N functionCall parts (one step).
          const parts = msg.tool_calls.map((tc) => {
            const fn = (tc.function ?? {}) as Record<string, unknown>;
            const functionCall: Record<string, unknown> = {
              name: tc.function?.name || tc.name || 'unknown',
              args: (() => {
                try {
                  return typeof tc.function?.arguments === 'string'
                    ? JSON.parse(tc.function.arguments) as Record<string, unknown>
                    : (tc.function?.arguments || {});
                } catch { return {}; }
              })()
            };
            // Gemini 3.x requires the thought_signature to be echoed back on the
            // PART that carries the functionCall (part-level field, not inside
            // functionCall). Missing signatures on the current turn's first
            // functionCall part cause 400s; the post-pass below injects the
            // documented sentinel when the real signature is unavailable.
            const thoughtSignature = fn.thought_signature ?? fn.thoughtSignature;
            const part: Record<string, unknown> = { functionCall };
            if (typeof thoughtSignature === 'string' && thoughtSignature.length > 0) {
              part.thoughtSignature = thoughtSignature;
            }
            return part;
          });
          contents.push({
            role: 'model',
            parts: parts as unknown as Part[]
          });
          pendingToolResponses = msg.tool_calls.length;
        } else if (msg.content) {
          flushPendingToolResponses();
          contents.push({
            role: 'model',
            parts: [{ text: msg.content }]
          });
        }

      } else if (msg.role === 'tool') {
        // Tool result — user/functionResponse part, grouped with the other
        // results of the same response into one user content.
        if (pendingToolResponses === 0) {
          // No pending assistant tool_calls turn (e.g. history cut by context
          // compaction). A functionResponse part with no preceding functionCall
          // would 400 — degrade to a plain user text part instead.
          contents.push({
            role: 'user',
            parts: [{ text: `Tool result: ${msg.content || ''}` }]
          });
        } else {
          pendingResponseParts.push({
            functionResponse: {
              name: msg.name || 'tool',
              response: { content: msg.content || '' }
            }
          });
          if (pendingResponseParts.length >= pendingToolResponses) {
            flushPendingToolResponses();
          }
        }
      }
    }
    flushPendingToolResponses();

    return { systemInstruction, contents: this.ensureActiveLoopThoughtSignatures(contents) };
  }

  /**
   * Gemini 3.x strictly validates thought signatures on the first functionCall
   * part of every model step in the CURRENT turn (the turn starts at the most
   * recent user message that is not a functionResponse). History from older
   * rounds or sessions often lacks the real signature, which produces
   * 400 errors like "Function call ... is missing a thought_signature".
   * Mirror gemini-cli's ensureActiveLoopHasThoughtSignatures(): for each model
   * content inside the active loop, ensure the first functionCall part carries
   * a signature — the real one if present, otherwise the documented
   * "skip_thought_signature_validator" sentinel.
   */
  private ensureActiveLoopThoughtSignatures(contents: Content[]): Content[] {
    let activeLoopStartIndex = -1;
    for (let i = contents.length - 1; i >= 0; i--) {
      const content = contents[i];
      if (content.role === 'user' && content.parts?.some((p) => (p as unknown as Record<string, unknown>).text)) {
        activeLoopStartIndex = i;
        break;
      }
    }
    if (activeLoopStartIndex === -1) return contents;

    const newContents = contents.slice();
    for (let i = activeLoopStartIndex; i < newContents.length; i++) {
      const content = newContents[i];
      if (content.role !== 'model' || !content.parts) continue;
      const newParts = content.parts.slice();
      for (let j = 0; j < newParts.length; j++) {
        const part = newParts[j] as unknown as Record<string, unknown>;
        if (!part.functionCall) continue;
        if (!part.thoughtSignature) {
          newParts[j] = { ...part, thoughtSignature: 'skip_thought_signature_validator' } as unknown as Part;
          newContents[i] = { ...content, parts: newParts };
        }
        break;
      }
    }
    return newContents;
  }
  
  /**
   * Convert OpenAI-style tools to Gemini format
   */
  private convertToolsToGeminiFormat(tools: OpenAITool[]): Record<string, unknown>[] {
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
  private sanitizeSchemaForGemini(schema: unknown): Record<string, unknown> | unknown[] | string | number | boolean | null {
    if (!schema || typeof schema !== 'object') return schema as string | number | boolean | null;
    if (Array.isArray(schema)) return schema.map(item => this.sanitizeSchemaForGemini(item));

    const schemaObj = schema as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const key of Object.keys(schemaObj)) {
      if (key === '$schema' || key === 'additionalProperties' || key === '$defs' || key === 'definitions') continue;
      cleaned[key] = this.sanitizeSchemaForGemini(schemaObj[key]);
    }
    return cleaned;
  }
}
