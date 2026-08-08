import { requestUrl } from 'obsidian';
import { BaseProvider, UnifiedMessage, UnifiedGenerationOptions, UnifiedResponse } from './unifiedProviderManager';
import { RateLimitManager } from '../utils/rateLimitManager';
import { simulatedStream, fetchStream, createSSEParser, PartialStreamError } from '../utils/streamingUtils';

/**
 * Normalizes a user-supplied base URL for an OpenAI-compatible API.
 *
 * Servers like LM Studio serve at `http://host:1234/v1`, but their UI shows
 * the address WITHOUT the `/v1` suffix (e.g. `http://192.168.100.6:1234`).
 * If the URL has no path, append `/v1` so calls hit the standard endpoint.
 * URLs that already carry a path are left untouched.
 */
export function normalizeOpenAIBaseUrl(raw: string): string {
    let url = (raw || '').trim();
    if (!url) return url;
    url = url.replace(/\/+$/, '');
    try {
        const parsed = new URL(url);
        const path = parsed.pathname || '';
        if (path === '' || path === '/') {
            return `${url}/v1`;
        }
        return url;
    } catch {
        // Not a parseable URL — return as-is; the request layer will surface the error
        return url;
    }
}

/**
 * CustomOpenAIProvider - Handles API calls to any OpenAI-compatible API
 * 
 * This provider allows users to connect to self-hosted (vLLM, Ollama, LM Studio) 
 * or alternative cloud providers (DeepSeek, Together AI, etc.) 
 * using the standard OpenAI chat completions format.
 */
export class CustomOpenAIProvider extends BaseProvider {
    readonly id: string;
    readonly name: string;
    private apiKey: string;
    private baseUrl: string;

    constructor(id: string, name: string, baseUrl: string, apiKey: string) {
        super();
        this.id = id;
        this.name = name;
        this.baseUrl = normalizeOpenAIBaseUrl(baseUrl);
        this.apiKey = apiKey;
    }

    /**
     * Builds request headers for OpenAI-compatible endpoints.
     * The Authorization header is only included when an API key/token is
     * actually configured — local servers (LM Studio without auth, Ollama)
     * can reject an empty `Bearer` header.
     */
    private buildHeaders(extra?: Record<string, string>): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(extra ?? {})
        };
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }
        return headers;
    }

    /**
     * Obsidian's requestUrl().json getter THROWS a SyntaxError when the body is
     * not valid JSON (e.g. a plain-text gateway error page). Accessing it
     * unguarded masks the real status + message. Always go through this.
     */
    private safeJson(response: { status: number; json?: unknown; text?: string }): { json: unknown; text: string } {
        try {
            return { json: response.json, text: typeof response.text === 'string' ? response.text : '' };
        } catch {
            return { json: undefined, text: typeof response.text === 'string' ? response.text : '' };
        }
    }

    private requireJson(response: { status: number; json?: unknown; text?: string }): Record<string, unknown> {
        const { json, text } = this.safeJson(response);
        if (json && typeof json === 'object' && !Array.isArray(json)) {
            return json as Record<string, unknown>;
        }
        throw new Error(`${this.name} API error: ${response.status} Non-JSON response: ${text.slice(0, 500) || 'empty body'}`);
    }

    private sanitizeMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
        const result: UnifiedMessage[] = [];
        // Track the tool_call ids of the most recent assistant tool_calls turn.
        // OpenAI-compatible APIs reject role:'tool' messages whose tool_call_id
        // has no matching entry in the immediately preceding assistant message
        // ("No tool call found for function call output with call_id ...").
        // History can contain such orphans after context compaction cut a tool
        // round in half — convert them to plain user text instead of 400ing.
        let lastToolCallIds: Set<string> | null = null;

        for (const msg of messages) {
            const record = msg as unknown as Record<string, unknown>;
            const isToolResult = record.role === 'tool';
            const isAssistant = record.role === 'assistant';

            if (isAssistant) {
                const tcs = record.tool_calls;
                lastToolCallIds = Array.isArray(tcs) && (tcs as unknown[]).length > 0
                    ? new Set((tcs as Array<Record<string, unknown>>).map(tc => String((tc as { id?: string }).id ?? '')).filter(Boolean))
                    : null;
            } else if (isToolResult) {
                const callId = String(record.tool_call_id ?? '');
                if (callId && (!lastToolCallIds || !lastToolCallIds.has(callId))) {
                    const content = typeof record.content === 'string' ? record.content : '';
                    result.push({
                        role: 'user',
                        content: content.trim()
                            ? `Tool result: ${content}`
                            : 'Tool executed successfully.',
                    } as unknown as UnifiedMessage);
                    continue;
                }
            }

            const hasTextContent = typeof msg.content === 'string' && msg.content.trim().length > 0;
            const hasArrayContent = Array.isArray(msg.content) && msg.content.length > 0;
            const hasToolCalls = 'tool_calls' in msg && Array.isArray(record.tool_calls) && (record.tool_calls as unknown[]).length > 0;
            
            // Keep if it has valid content OR tool calls OR it's a tool result
            if (!(hasTextContent || hasArrayContent || hasToolCalls || isToolResult)) continue;

            if (isToolResult) {
                let content = msg.content;
                if (!content || (typeof content === 'string' && content.trim() === '')) {
                    content = 'Success (no output)';
                }
                result.push({ ...msg, content });
                continue;
            }
            
            // If assistant message has empty content but has tool_calls, ensure content is null or removed
            if (isAssistant && hasToolCalls) {
                if (msg.content === '' || msg.content === null) {
                    const newMsg = { ...msg };
                    delete (newMsg as Record<string, unknown>).content;
                    result.push(newMsg);
                    continue;
                }
            }
            
            result.push(msg);
        }

        return result;
    }

    /**
     * Always uses requestUrl to bypass CORS and guarantee cross-platform success.
     */
    async generateContent(
        modelId: string,
        messages: UnifiedMessage[],
        options?: UnifiedGenerationOptions
    ): Promise<UnifiedResponse> {
        // Wait for rate limit clearance if needed (conservative estimate)
        await RateLimitManager.getInstance().waitForClearance(this.id, modelId, 1000);

        const body: {
            model: string;
            messages: UnifiedMessage[];
            stream: boolean;
            temperature?: number;
            top_p?: number;
            max_tokens?: number;
        } = {
            model: modelId,
            messages: this.sanitizeMessages(messages),
            stream: false
        };
        if (options?.temperature !== undefined) body.temperature = options.temperature;
        if (options?.topP !== undefined) body.top_p = options.topP;
        if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;

        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/chat/completions`,
                method: 'POST',
                headers: this.buildHeaders({
                    'HTTP-Referer': 'https://obsidian.md',
                    'X-Title': 'Nexus-LM'
                }),
                body: JSON.stringify(body),
                throw: false
            });

            if (response.status >= 400) {
                const errResp = this.safeJson(response);
                const errorData = (errResp.json && typeof errResp.json === 'object' ? errResp.json : {}) as { error?: { message?: string } };
                throw new Error(`${this.name} API error: ${response.status} ${errorData.error?.message || errResp.text.slice(0, 500) || 'Request failed'}`);
            }

            // Update rate limits from headers if available
            const headersObj = new Headers();
            Object.entries(response.headers).forEach(([key, value]) => {
                // Ensure value is a string for Headers.set
                headersObj.set(key, Array.isArray(value) ? value.join(', ') : value);
            });
            RateLimitManager.getInstance().updateFromHeaders(this.id, modelId, headersObj);

            const data = this.requireJson(response) as unknown as OpenAIChatCompletionResponse;
            
            // Record API call usage
            if (data.usage) {
                RateLimitManager.getInstance().recordApiCall(this.id, modelId, data.usage.total_tokens ?? 0);
            }

            return {
                text: data.choices?.[0]?.message?.content || '',
                usage: data.usage ? {
                    promptTokens: data.usage.prompt_tokens ?? 0,
                    completionTokens: data.usage.completion_tokens ?? 0,
                    totalTokens: data.usage.total_tokens ?? 0
                } : undefined,
                finishReason: data.choices?.[0]?.finish_reason
            };
        } catch (error) {
            if (error instanceof Error) {
                throw error;
            }
            throw new Error(String(error));
        }
    }

    async streamContent(
        modelId: string,
        messages: UnifiedMessage[],
        onChunk: (chunk: string) => void,
        options?: UnifiedGenerationOptions,
        onThinking?: (thinking: string) => void
    ): Promise<UnifiedResponse> {
        await RateLimitManager.getInstance().waitForClearance(this.id, modelId, 1000);

        const fullHeaders: Record<string, string> = this.buildHeaders({
            'HTTP-Referer': 'https://obsidian.md',
            'X-Title': 'Nexus-LM'
        });

        const minimalHeaders: Record<string, string> = this.buildHeaders();

        const buildBody = (stream: boolean) => {
            const body: {
                model: string;
                messages: UnifiedMessage[];
                stream: boolean;
                temperature?: number;
                top_p?: number;
                max_tokens?: number;
            } = { 
                model: modelId, 
                messages: this.sanitizeMessages(messages), 
                stream 
            };
            if (options?.temperature !== undefined) body.temperature = options.temperature;
            if (options?.topP !== undefined) body.top_p = options.topP;
            if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;
            return body;
        };

        const parser = createSSEParser();
        let fullContent = '';
        let finishReason: string | undefined;
        const callbacks = {
            onChunk: (text: string) => { fullContent += text; onChunk(text); },
            onThinking,
            onFinish: (reason: string) => { finishReason = reason; }
        };

        // Primary: native fetch streaming (true token-level streaming)
        // Falls through to simulatedStream on CORS/network error
        try {
            await fetchStream(
                `${this.baseUrl}/chat/completions`,
                minimalHeaders,
                JSON.stringify(buildBody(true)),
                parser,
                callbacks,
                options?.abortSignal
            );
            return { text: fullContent, finishReason };
        } catch (error) {
            if (error instanceof PartialStreamError) throw error;
            // CORS or network error — fall through to simulatedStream below
        }

        // Fallback: requestUrl simulated streaming (cross-platform, bypasses CORS)
        const respHeaders = await simulatedStream(
            `${this.baseUrl}/chat/completions`,
            'POST',
            fullHeaders,
            JSON.stringify(buildBody(true)),
            callbacks,
            options?.abortSignal,
            'openai'
        );
        const headersObj = new Headers();
        Object.entries(respHeaders).forEach(([key, value]) => headersObj.set(key, Array.isArray(value) ? value.join(', ') : value));
        RateLimitManager.getInstance().updateFromHeaders(this.id, modelId, headersObj);
        return { text: fullContent, finishReason };
    }

    /**
     * Generates content using the OpenAI-compatible chat completions API with tools.
     */
    async generateContentWithTools(
        modelId: string,
        messages: UnifiedMessage[],
        tools: Array<Record<string, unknown>>,
        options: UnifiedGenerationOptions & { toolChoice?: string },
        executeToolsCallback?: (toolCalls: Array<Record<string, unknown>>) => Promise<Array<Record<string, unknown>>>,
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
            await RateLimitManager.getInstance().waitForClearance(this.id, modelId, 1000);

            const requestBody: {
                model: string;
                messages: UnifiedMessage[];
                stream: boolean;
                temperature?: number;
                top_p?: number;
                max_tokens?: number;
                tools?: Array<Record<string, unknown>>;
                tool_choice?: string;
            } = {
                model: modelId,
                messages: this.sanitizeMessages(conversationMessages),
                stream: false
            };
            if (options.temperature !== undefined) requestBody.temperature = options.temperature;
            if (options.topP !== undefined) requestBody.top_p = options.topP;
            if (options.maxTokens !== undefined) requestBody.max_tokens = options.maxTokens;

            // Only include tools if they are provided and not empty
            if (tools && tools.length > 0) {
                requestBody.tools = tools;
                requestBody.tool_choice = currentToolChoice;
            }

            try {
                const response = await requestUrl({
                    url: `${this.baseUrl}/chat/completions`,
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'https://obsidian.md',
                        'X-Title': 'Nexus-LM'
                    },
                    body: JSON.stringify(requestBody),
                    throw: false
                });

                if (response.status >= 400) {
                    const errResp = this.safeJson(response);
                    const errorData = (errResp.json && typeof errResp.json === 'object' ? errResp.json : {}) as { error?: { message?: string } };
                    throw new Error(`${this.name} API error: ${response.status} ${errorData.error?.message || errResp.text.slice(0, 500) || 'Request failed'}`);
                }

                // Update rate limits from headers if available
                const headersObj = new Headers();
                Object.entries(response.headers).forEach(([key, value]) => {
                    headersObj.set(key, Array.isArray(value) ? value.join(', ') : value);
                });
                RateLimitManager.getInstance().updateFromHeaders(this.id, modelId, headersObj);

                const data = this.requireJson(response) as unknown as OpenAIChatCompletionResponse;
                
                if (data.usage) {
                    totalTokens += (data.usage.total_tokens ?? 0);
                    RateLimitManager.getInstance().recordApiCall(this.id, modelId, data.usage.total_tokens ?? 0);
                }

                const message = data.choices?.[0]?.message;
                if (!message) break;

                // Add assistant message to conversation
                conversationMessages.push(message as unknown as UnifiedMessage);

                // Check for tool calls
                if (message.tool_calls && message.tool_calls.length > 0) {
                                        toolRoundsExecuted++;
                    
                    if (currentToolChoice === 'required') {
                        currentToolChoice = 'auto';
                    }
                    
                    if (executeToolsCallback) {
                        const toolResults = await executeToolsCallback(message.tool_calls as unknown as Array<Record<string, unknown>>);
                        
                        for (let i = 0; i < message.tool_calls.length; i++) {
                            const toolCall = message.tool_calls[i] as { id?: string; function?: { name: string }; name?: string };
                            const toolResult = toolResults[i];
                            
                            conversationMessages.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                name: toolCall.function?.name || toolCall.name || 'unknown',
                                content: toolResult.success 
                                    ? toolResult.content 
                                    : `Error: ${toolResult.error}`
                            } as unknown as UnifiedMessage);
                        }
                        continue;
                    } else {
                        throw new Error('Tool calls requested but no executeToolsCallback provided');
                    }
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
                    });
                    continue;
                }

                break;
            } catch (error) {
                if (error instanceof Error) {
                    throw error;
                }
                throw new Error(String(error));
            }
        }

        return { content: fullContent, totalTokens };
    }

    /**
     * Single-round native tool calling: one request, returns tool calls without executing them.
     * The caller owns the tool execution loop.
     */
    async generateContentWithToolsOnce(
        modelId: string,
        messages: UnifiedMessage[],
        tools: Array<Record<string, unknown>>,
        options: UnifiedGenerationOptions & { toolChoice?: string }
    ): Promise<{ content: string; finishReason?: string; toolCalls?: Array<Record<string, unknown>>; thinking?: string }> {
        if (options.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
        await RateLimitManager.getInstance().waitForClearance(this.id, modelId, 1000);

        const requestBody: {
            model: string;
            messages: UnifiedMessage[];
            stream: boolean;
            temperature?: number;
            top_p?: number;
            max_tokens?: number;
            tools?: Array<Record<string, unknown>>;
            tool_choice?: string;
        } = {
            model: modelId,
            messages: this.sanitizeMessages(messages),
            stream: false
        };
        if (options.temperature !== undefined) requestBody.temperature = options.temperature;
        if (options.topP !== undefined) requestBody.top_p = options.topP;
        if (options.maxTokens !== undefined) requestBody.max_tokens = options.maxTokens;

        if (tools && tools.length > 0) {
            requestBody.tools = tools;
            requestBody.tool_choice = options.toolChoice ?? 'auto';
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
            body: JSON.stringify(requestBody),
            throw: false
        });

        if (response.status >= 400) {
            const errResp = this.safeJson(response);
            const errorData = (errResp.json && typeof errResp.json === 'object' ? errResp.json : {}) as { error?: { message?: string } };
            throw new Error(`${this.name} API error: ${response.status} ${errorData.error?.message || errResp.text.slice(0, 500) || 'Request failed'}`);
        }

        const headersObj = new Headers();
        Object.entries(response.headers).forEach(([key, value]) => {
            headersObj.set(key, Array.isArray(value) ? value.join(', ') : value);
        });
        RateLimitManager.getInstance().updateFromHeaders(this.id, modelId, headersObj);

        const data = this.requireJson(response) as unknown as OpenAIChatCompletionResponse;
        if (data.usage) {
            RateLimitManager.getInstance().recordApiCall(this.id, modelId, data.usage.total_tokens ?? 0);
        }

        const message = data.choices?.[0]?.message as unknown as Record<string, unknown> | undefined;
        if (!message) return { content: '' };

        return {
            content: typeof message.content === 'string' ? message.content : '',
            finishReason: data.choices?.[0]?.finish_reason,
            toolCalls: (message.tool_calls as Array<Record<string, unknown>> | undefined) ?? undefined,
            thinking: typeof message.reasoning_content === 'string' && (message.reasoning_content as string).length > 0
                ? (message.reasoning_content as string)
                : undefined,
        };
    }
}
