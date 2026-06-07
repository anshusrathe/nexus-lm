import { requestUrl } from 'obsidian';
import { BaseProvider, UnifiedMessage, UnifiedGenerationOptions, UnifiedResponse } from './unifiedProviderManager';
import { RateLimitManager } from '../utils/rateLimitManager';
import { simulatedStream, fetchStream, createSSEParser } from '../utils/streamingUtils';

/**
 * OpenCode Provider - Handles API calls to OpenCode Zen API
 */
export class OpenCodeProvider extends BaseProvider {
    readonly id = 'opencode';
    readonly name = 'OpenCode Zen';
    private apiKey: string;
    private baseUrl = 'https://opencode.ai/zen/v1';

    constructor(apiKey: string) {
        super();
        this.apiKey = apiKey;
    }

    /**
     * Always uses requestUrl to bypass CORS and guarantee cross-platform success.
     */
    async generateContent(
        modelId: string,
        messages: UnifiedMessage[],
        options?: UnifiedGenerationOptions
    ): Promise<UnifiedResponse> {
        await RateLimitManager.getInstance().waitForClearance(this.id, modelId, 1000);

        const body: SafeAny = {
            model: modelId,
            messages: messages,
            stream: false
        };
        if (options?.temperature !== undefined) body.temperature = options.temperature;
        if (options?.topP !== undefined) body.top_p = options.topP;
        if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;

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
                body: JSON.stringify(body),
                throw: false
            });

            if (response.status >= 400) {
                const errorData = typeof response.json === 'object' ? response.json : {};
                throw new Error(`OpenCode API error: ${response.status} ${errorData.error?.message || 'Request failed'}`);
            }

            // Standardize headers for RateLimitManager
            const headersObj = new Headers();
            Object.entries(response.headers).forEach(([key, value]) => {
                headersObj.set(key, Array.isArray(value) ? value.join(', ') : value);
            });
            RateLimitManager.getInstance().updateFromHeaders(this.id, modelId, headersObj);

            const data = response.json;
            if (data.usage) {
                RateLimitManager.getInstance().recordApiCall(this.id, modelId, data.usage.total_tokens);
            }

            return {
                text: data.choices[0]?.message?.content || '',
                usage: data.usage ? {
                    promptTokens: data.usage.prompt_tokens,
                    completionTokens: data.usage.completion_tokens,
                    totalTokens: data.usage.total_tokens
                } : undefined
            };
        } catch (error) {
            throw error;
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
            const body: SafeAny = { model: modelId, messages, stream };
            if (options?.temperature !== undefined) body.temperature = options.temperature;
            if (options?.topP !== undefined) body.top_p = options.topP;
            if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;
            return body;
        };

        const parser = createSSEParser();
        let fullContent = '';
        const callbacks = {
            onChunk: (text: string) => { fullContent += text; onChunk(text); },
            onThinking
        };

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
            return { text: fullContent };
        } catch (error) {
                    }

        // Fallback: requestUrl simulated streaming (cross-platform)
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
        return { text: fullContent };
    }

    async generateContentWithTools(
        modelId: string,
        messages: UnifiedMessage[],
        tools: SafeAny[],
        options: UnifiedGenerationOptions & { toolChoice?: string },
        executeToolsCallback?: (toolCalls: SafeAny[]) => Promise<SafeAny[]>,
        streamCallback?: (chunk: string) => void
    ): Promise<{ content: string; totalTokens?: number }> {
        let fullContent = '';
        let conversationMessages = [...messages] as SafeAny[];
        let totalTokens = 0;
        let toolRoundsExecuted = 0;
        const MAX_CONTINUATION_NUDGES = 3;
        let nudgeCount = 0;
        let currentToolChoice = options.toolChoice ?? 'auto';

        while (true) {
            if (options.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
            await RateLimitManager.getInstance().waitForClearance(this.id, modelId, 1000);

            const requestBody: SafeAny = {
                model: modelId,
                messages: conversationMessages,
                stream: false
            };
            if (options.temperature !== undefined) requestBody.temperature = options.temperature;
            if (options.topP !== undefined) requestBody.top_p = options.topP;
            if (options.maxTokens !== undefined) requestBody.max_tokens = options.maxTokens;

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
                    const errorData = typeof response.json === 'object' ? response.json : {};
                    throw new Error(`OpenCode API error: ${response.status} ${errorData.error?.message || 'Request failed'}`);
                }

                const headersObj = new Headers();
                Object.entries(response.headers).forEach(([key, value]) => {
                    headersObj.set(key, Array.isArray(value) ? value.join(', ') : value);
                });
                RateLimitManager.getInstance().updateFromHeaders(this.id, modelId, headersObj);

                const data = response.json;
                if (data.usage) {
                    totalTokens += (data.usage.total_tokens || 0);
                    RateLimitManager.getInstance().recordApiCall(this.id, modelId, data.usage.total_tokens);
                }

                const message = data.choices[0]?.message;
                if (!message) break;
                conversationMessages.push(message);

                if (message.tool_calls && message.tool_calls.length > 0) {
                    toolRoundsExecuted++;
                    if (currentToolChoice === 'required') currentToolChoice = 'auto';
                    
                    if (executeToolsCallback) {
                        const toolResults = await executeToolsCallback(message.tool_calls);
                        for (let i = 0; i < message.tool_calls.length; i++) {
                            const toolCall = message.tool_calls[i];
                            const toolResult = toolResults[i];
                            conversationMessages.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                name: toolCall.function.name,
                                content: toolResult.success ? toolResult.content : `Error: ${toolResult.error}`
                            });
                        }
                        continue;
                    } else throw new Error('Tool calls requested but no executeToolsCallback provided');
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
                    });
                    continue;
                }
                break;
            } catch (error) {
                throw error;
            }
        }
        return { content: fullContent, totalTokens };
    }
}
