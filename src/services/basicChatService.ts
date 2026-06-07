import { App, Notice } from 'obsidian';
import { requestUrl } from 'obsidian';
import { AISettings, getProviderForModel, getModelTemperature, getModelTopP, getGeminiThinkingConfig, Provider } from '../settings';
import { GoogleGenerativeAI, Part, GenerateContentCandidate, GroundingMetadata } from '@google/generative-ai';
import { WebSearchService, SearchResult as WebSearchResult } from './webSearch';
import { MultimodalInput } from '../utils/multimodalUtils';
import { GroqService, ChatMessage as GroqChatMessage, GroqApiError, convertChatHistoryForGroq, isGroqWebSearchCapable, isGroqGptOssModel, WebSource, GroqStreamEvent, GROQ_VISION_MODEL, GroqContentPart, GeminiHistoryMessage } from './groqService';
import { OpenRouterService, ChatMessage as OpenRouterChatMessage, OpenRouterApiError } from './openRouterService';
import { OllamaService, OllamaApiError } from './ollamaService';
import { NvidiaService, NvidiaApiError } from './nvidiaService';
import { RateLimitManager } from '../utils/rateLimitManager';
import { GeminiService } from './geminiService';
import { ModelSelection } from '../modelSelector';
import { UnifiedProviderManager, UnifiedMessage } from './unifiedProviderManager';
import { sanitizeServerName } from '../mcp/mcpToolCalling';
import { TaskType } from '../utils/tokenEstimator';
import {
    MCPExecutionLedger,
    MAX_SYNTHESIS_ATTEMPTS,
    buildFallbackPlan,
    createLedger,
    buildSynthesisFromLedger
} from '../mcp/mcpExecutionLedger';


type ProgressCallback = (step: number, totalSteps: number, message: string, contentSnippet?: string) => void;


type SnippetUpdateCallback = (message: string, snippet?: string) => void;

interface BasicChatResult {
    answer: string;
    webResults: WebSearchResult[];
    totalTokens?: number; 
    modelName?: string;   
    providerName?: string; 
}





const FINAL_ANSWER_MIN_LENGTH = 60;
const NON_ANSWER_PATTERNS: RegExp[] = [
    /^\s*acknowledged\.?\s*$/i,
    /^\s*received\.?\s*$/i,
    /^\s*ok\.?\s*$/i,
    /^\s*got it\.?\s*$/i,
    /^\s*noted\.?\s*$/i,
    /^\s*understood\.?\s*$/i,
    /^\s*results? received\.?\s*$/i,
    /^\s*tools? (have been )?executed\.?\s*$/i,
    /^\s*all tools? (have been )?(executed|completed)\.?\s*$/i,
    /^\s*i'?ll (now |just )?(provide|synthesize|generate) (a |the )?(final )?answer\.?\s*$/i,
];
const looksLikeFinalAnswer = (content: string | undefined | null): boolean => {
    if (!content) return false;
    const trimmed = content.trim();
    if (trimmed.length < FINAL_ANSWER_MIN_LENGTH) return false;
    if (NON_ANSWER_PATTERNS.some(p => p.test(trimmed))) return false;
    return true;
};

export class BasicChatService {
    private app: App;
    private settings: AISettings;
    private webSearchService: WebSearchService;
    private rateLimitManager: RateLimitManager;
    private saveSettings: () => Promise<void>;

    constructor(app: App, settings: AISettings, webSearchService: WebSearchService, saveSettings?: () => Promise<void>) {
        this.app = app;
        this.settings = settings;
        this.webSearchService = webSearchService;
        this.rateLimitManager = RateLimitManager.getInstance();
        this.saveSettings = saveSettings || (async () => {});
    }

    private processGeminiStreamingCandidate(
        candidate: GenerateContentCandidate,
        updateSnippetUI: SnippetUpdateCallback
    ): string {
        const content = candidate?.content;
        if (!content?.parts || !Array.isArray(content.parts)) return '';
        let answerText = '';
        for (const part of content.parts) {
            const text = part?.text || '';
            if (!text) continue;
            if ((part as any).thought === true) {
                updateSnippetUI('Thinking...', text);
                continue;
            }
            answerText += text;
            updateSnippetUI('Generating response...', text);
        }
        return answerText;
    }

    /**
     * Gets the context window size for the current model.
     * This is different from TPM rate limits - it's the max tokens per request.
     */
    private getContextWindowSize(model?: string): number {
        const modelId = model || this.settings.model;
        const customModel = this.settings.customModels?.find(m => m.id === modelId);
        
        if (customModel && customModel.tokenLimit && customModel.tokenLimit > 0) {
            return customModel.tokenLimit;
        }
        
        
        const provider = getProviderForModel(modelId, this.settings);
        if (provider === 'groq') {
            return 1000000; 
        } else if (provider === 'gemini') {
            return 1000000; 
        } else if (provider === 'openrouter') {
            return 1000000; 
        } else if (provider === 'ollama') {
            return 1000000; 
        } else if (provider === 'nvidia') {
            return 1000000; 
        }
        
        return 1000000; 
    }

    /**
     * Processes a standard chat, Q&A, MCQ query, or Quick Search follow-up.
     * This handles the AI API calls for these modes, including web search integration.
     * @param query The original user query.
     * @param enhancedQuery The mode-enhanced user query.
     * @param vaultContext Formatted content from selected vault files/folders or quick search snippets.
     * @param chatHistory Recent chat history for context.
     * @param webEnabled Whether web search is enabled for this query type (ignored for Quick Search follow-ups).
     * @param updateProcessingUI Callback to update the processing UI.
     * @param isQuickSearchFollowUp Flag indicating if this is a follow-up to a Quick Search.
     * @param updateSnippetUI Callback to update detailed processing messages and snippets.
     * @param multimodalInputs Optional array of multimodal inputs (images, PDFs, audio, video).
     * @param customSystemInstructions Optional custom system instructions to prepend to the system prompt.
     * @returns The generated answer and any web results used (only for non-QS follow-ups).
     */
    async process(
        query: string,
        enhancedQuery: string,
        vaultContext: string,
        chatHistory: GeminiHistoryMessage[],
        webEnabled: boolean,
        updateProcessingUI: ProgressCallback,
        isQuickSearchFollowUp: boolean = false,
        updateSnippetUI: SnippetUpdateCallback,
        multimodalInputs: MultimodalInput[] = [],
        customSystemInstructions: string = '',
        passedModel?: string,
        passedProvider?: Provider,
        abortSignal?: AbortSignal
    ): Promise<BasicChatResult> {        let responseText = "";
        let webResults: WebSearchResult[] = [];
        let totalTokens: number | undefined = undefined;

        
        const currentModel = passedModel || this.settings.model;
        const currentProvider = passedProvider || this.settings.provider;

        const normalizedOllamaModelId = (currentModel || '').toLowerCase();
        const isOllamaGptOssModel = normalizedOllamaModelId.includes('gpt-oss');
        const ollamaThinkOption = isOllamaGptOssModel
            ? (this.settings.ollamaGptOssThinkingLevel || 'medium')
            : !!this.settings.ollamaThinkingEnabled;

        
        
        
        
        const totalSteps = 1;

        try {
            
            

            let context: string[] = [];
            let systemPrompt: string;

            
            if (isQuickSearchFollowUp) {
                 
                 if (vaultContext) {
                     
                     const sourceCount = (vaultContext.match(/--- Source \[\d+\]:/g) || []).length;
                     context.push(`Relevant Vault Content (${sourceCount} source${sourceCount !== 1 ? 's' : ''}):\n${vaultContext}`);
                 }
                 systemPrompt = `You are an AI tutor and research assistant. Answer the user's question *strictly* based on the 'Relevant Vault Content' provided below.

Instructions:
1. Provide a direct response based *only* on the provided text from ALL sources (marked as [Source [N]]).
2. Do *not* use any external knowledge, web search results, or previous chat history for this specific question.
3. Do *not* use information from your training data or make assumptions beyond what is explicitly stated in the sources.
4. Do *not* provide examples, definitions, or explanations that are not present in the sources.
5. If the answer cannot be found *entirely* within the provided 'Relevant Vault Content', state clearly and concisely that you cannot answer the question based on the available findings, without apologizing.
6. Every fact, claim, or piece of information in your response must be traceable to the provided sources.
7. Use markdown formatting for clarity.`;

            } else {
                
                if (vaultContext) {
                    
                    const sourceCount = (vaultContext.match(/--- Source \[\d+\]:/g) || []).length;
                    context.push(`Relevant Vault Content (${sourceCount} source${sourceCount !== 1 ? 's' : ''}):\n${vaultContext}`);
                }
                
                 systemPrompt = `You are an AI tutor and research assistant. Follow these guidelines:

1. Provide direct responses without unnecessary introductory phrases.
2. For complex questions with multiple parts, break down and address each part systematically.
3. When vault content is provided, carefully review ALL sources (marked as [Source [N]]) and synthesize information from ALL relevant files to answer comprehensively.
4. Use markdown formatting for clarity.`; 
            }

            
            if (customSystemInstructions) {
                systemPrompt = `${customSystemInstructions}\n\n${systemPrompt}`;
            }


            
            if (this.settings.provider === 'gemini') {
                const genAI = new GoogleGenerativeAI(this.settings.geminiApiKey || this.settings.apiKey);
                const model = genAI.getGenerativeModel({ model: this.settings.model });

                
                const generationStep = 0; 
                updateProcessingUI(generationStep, totalSteps, 'Generating response...', `Input query: ${enhancedQuery}`); 

                const chatConfig: Record<string, any> = {
                    history: isQuickSearchFollowUp ? [] : chatHistory,
                    generationConfig: {
                        temperature: getModelTemperature(this.settings.model, this.settings),
                        topK: 40,
                        topP: getModelTopP(this.settings.model, this.settings),
                        maxOutputTokens: 8192,
                    },
                };

                
                if (webEnabled) {
                    chatConfig.tools = [this.webSearchService.getGoogleSearchToolConfig()];
                }

                const geminiThinkingConfig = getGeminiThinkingConfig(this.settings.model, this.settings);
                if (geminiThinkingConfig) {
                    if (!chatConfig.generationConfig) chatConfig.generationConfig = {};
                    (chatConfig.generationConfig as Record<string, any>).thinkingConfig = geminiThinkingConfig.thinkingConfig;
                    
                    if (!chatConfig.tools) {
                        chatConfig.tools = [];
                    }
                    if (!(chatConfig.tools as Record<string, any>[]).some((tool: any) => tool.urlContext !== undefined)) {
                        (chatConfig.tools as Record<string, any>[]).push({ urlContext: {} });
                    }
                }

                
                const messageParts: Record<string, unknown>[] = [];
                
                
                const inlineInputs = multimodalInputs.filter(input => input.type === 'inline' && input.data);
                const fileUriInputs = multimodalInputs.filter(input => input.type === 'fileUri' && input.uri);
                const hasImages = inlineInputs.length > 0 || fileUriInputs.length > 0;

                if (hasImages) {
                    let multimodalPrompt = `${systemPrompt}\n\n`;
                    
                    if (context.length > 0) {
                        multimodalPrompt += `## TEXT CONTEXT FROM NOTES\n${context.join('\n\n')}\n\n`;
                    }
                    
                    multimodalPrompt += `## USER REQUEST\n${enhancedQuery}\n\n`;
                    multimodalPrompt += `CRITICAL INSTRUCTION: You are provided with both text context (from Obsidian notes) and embedded images/files. ` +
                                      `You MUST synthesize information from BOTH the text and the images to provide a comprehensive answer. ` +
                                      `Do not ignore the text in favor of the images, or vice-versa.`;

                    messageParts.push({ text: multimodalPrompt });
                    
                    
                    if (inlineInputs.length > 0) {
                        updateProcessingUI(generationStep, totalSteps, `Processing ${inlineInputs.length} multimodal input(s)...`);
                        for (const input of inlineInputs) {
                            messageParts.push({
                                inlineData: {
                                    mimeType: input.mimeType,
                                    data: input.data!
                                }
                            });
                        }
                    }
                    
                    
                    if (fileUriInputs.length > 0) {
                        for (const input of fileUriInputs) {
                            messageParts.push({
                                fileData: {
                                    mimeType: input.mimeType,
                                    fileUri: input.uri!
                                }
                            });
                        }
                    }
                } else {
                    
                    messageParts.push({
                        text: `${systemPrompt}\n\n${context.length > 0 ? context.join('\n\n') + '\n\n' : ''}Question: ${enhancedQuery}`
                    });
                }
                
                const streamResult = await model.startChat(chatConfig as unknown as any).sendMessageStream(messageParts as unknown as any, { signal: abortSignal });

                for await (const chunk of streamResult.stream) {
                    if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
                    const candidate = chunk.candidates?.[0];
                    if (candidate) {
                        responseText += this.processGeminiStreamingCandidate(candidate as unknown as GenerateContentCandidate, updateSnippetUI);
                    }
                }
                
                const finalResponse = await streamResult.response;

                
                if (finalResponse.candidates && finalResponse.candidates.length > 0) {
                    const candidate = finalResponse.candidates[0];
                    if (candidate.groundingMetadata) {
                        responseText = this.addCitations(responseText, candidate.groundingMetadata);
                        
                        webResults = (candidate.groundingMetadata as any).groundingChunks?.map((chunk: { web?: { title?: string, uri?: string } }) => ({
                            title: chunk.web?.title || 'Unknown Source',
                            link: chunk.web?.uri || '#',
                            snippet: '', 
                        })) || [];
                    }
                }
                
                
                const responseWithUsage = finalResponse as { usageMetadata?: { promptTokenCount?: number, candidatesTokenCount?: number } };
                if (responseWithUsage.usageMetadata) {
                    const usage = responseWithUsage.usageMetadata;
                    totalTokens = (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0);
                }
                
            } else if (this.settings.provider === 'groq') {
                
                const groqService = new GroqService(
                    this.settings.groqApiKey,
                    (headers) => this.rateLimitManager.updateFromHeaders('groq', this.settings.model, headers)
                );
                
                
                const normalizedGroqModelId = (this.settings.model || '').toLowerCase();
                const isLocalGroqGptOssModel = normalizedGroqModelId.includes('gpt-oss');
                const groqThinkingLevel = isLocalGroqGptOssModel ? (this.settings.groqThinkingLevel || 'medium') : undefined;
                
                
                const groqMessages: GroqChatMessage[] = [
                    {
                        role: 'system',
                        content: `${systemPrompt}\n\n${context.length > 0 ? context.join('\n\n') + '\n\n' : ''}`
                    }
                ];
                
                
                
                
                if (!isQuickSearchFollowUp && chatHistory.length > 0) {
                    
                    const contextWindowSize = this.getContextWindowSize();
                    const convertedHistory = convertChatHistoryForGroq(chatHistory, this.settings.model, contextWindowSize);
                    groqMessages.push(...convertedHistory);
                }
                
                
                if (this.settings.model === GROQ_VISION_MODEL) {
                    const inlineInputs = multimodalInputs.filter(input => input.type === 'inline' && input.data);
                    if (inlineInputs.length > 0) {
                        let multimodalInstruction = `## USER REQUEST\n${enhancedQuery}\n\n` +
                                                   `CRITICAL INSTRUCTION: You are provided with both text context (from Obsidian notes) and embedded images. ` +
                                                   `You MUST synthesize information from BOTH the text and the images to provide a comprehensive answer. ` +
                                                   `Do not ignore the text in favor of the images, or vice-versa.`;

                        const contentParts: GroqContentPart[] = [{ type: 'text', text: multimodalInstruction }];
                        for (const input of inlineInputs) {
                            contentParts.push({
                                type: 'image_url',
                                image_url: {
                                    url: `data:${input.mimeType};base64,${input.data}`
                                }
                            });
                        }
                        groqMessages.push({ role: 'user', content: contentParts });
                    } else {
                        groqMessages.push({ role: 'user', content: enhancedQuery });
                    }
                } else {
                    groqMessages.push({ role: 'user', content: enhancedQuery });
                }

                
                const generationStep = 0;

                try {
                    
                    if (webEnabled) {
                        const supportsWebSearch = isGroqWebSearchCapable(this.settings.model);
                        
                        if (supportsWebSearch) {
                            
                            const isGptOssForWeb = isGroqGptOssModel(this.settings.model);
                            updateProcessingUI(generationStep, totalSteps, `Generating response with Groq web search...`, `Input query: ${enhancedQuery}`);
                            
                            const result = await groqService.generateContentWithWebSearch(
                                this.settings.model,
                                groqMessages,
                                {
                                    temperature: getModelTemperature(this.settings.model, this.settings),
                                    topP: getModelTopP(this.settings.model, this.settings),
                                    thinkingLevel: groqThinkingLevel
                                },
                                (chunk: string) => {
                                    updateSnippetUI('Generating response...', chunk);
                                },
                                isGptOssForWeb ? (thinking: string) => {
                                    updateSnippetUI('Thinking...', thinking);
                                } : undefined
                            );
                            
                            responseText = result.content;
                            
                            
                            webResults = result.webSources.map((source: WebSource) => ({
                                title: source.title,
                                link: source.url,
                                snippet: source.snippet || ''
                            }));
                            
                            
                            if (webResults.length > 0) {
                                responseText = this.formatGroqWebCitations(responseText, result.webSources);
                                                            } else {
                                
                                
                                                            }
                        } else {
                            
                                                        updateProcessingUI(generationStep, totalSteps, 'Generating response with Groq...', `Input query: ${enhancedQuery}`);
                            
                            
                            if (groqThinkingLevel) {
                                let contentBuffer = '';
                                await groqService.generateContentStreamEvents(
                                    this.settings.model,
                                    groqMessages,
                                    (evt: GroqStreamEvent) => {
                                        if (evt.type === 'thinking') {
                                            updateSnippetUI('Thinking...', evt.text);
                                        } else if (evt.type === 'content') {
                                            contentBuffer += evt.text;
                                        }
                                    },
                                    {
                                        temperature: getModelTemperature(this.settings.model, this.settings),
                                        topP: getModelTopP(this.settings.model, this.settings),
                                        thinkingLevel: groqThinkingLevel
                                    }
                                );
                                responseText = contentBuffer;
                            } else {
                                responseText = await groqService.generateContentStream(
                                    this.settings.model,
                                    groqMessages,
                                    {
                                        temperature: getModelTemperature(this.settings.model, this.settings),
                                        topP: getModelTopP(this.settings.model, this.settings),
                                        thinkingLevel: groqThinkingLevel
                                    },
                                    (chunk: string) => {
                                        updateSnippetUI('Generating response...', chunk);
                                    }
                                );
                            }
                        }
                    } else {
                        
                        updateProcessingUI(generationStep, totalSteps, 'Generating response with Groq...', `Input query: ${enhancedQuery}`);
                        
                        
                        if (groqThinkingLevel) {
                            let contentBuffer = '';
                            await groqService.generateContentStreamEvents(
                                this.settings.model,
                                groqMessages,
                                (evt: GroqStreamEvent) => {
                                    if (evt.type === 'thinking') {
                                        updateSnippetUI('Thinking...', evt.text);
                                    } else if (evt.type === 'content') {
                                        contentBuffer += evt.text;
                                    }
                                },
                                {
                                    temperature: getModelTemperature(this.settings.model, this.settings),
                                    topP: getModelTopP(this.settings.model, this.settings),
                                    thinkingLevel: groqThinkingLevel
                                }
                            );
                            responseText = contentBuffer;
                        } else {
                            responseText = await groqService.generateContentStream(
                                this.settings.model,
                                groqMessages,
                                {
                                    temperature: getModelTemperature(this.settings.model, this.settings),
                                    topP: getModelTopP(this.settings.model, this.settings),
                                    thinkingLevel: groqThinkingLevel
                                },
                                (chunk: string) => {
                                    updateSnippetUI('Generating response...', chunk);
                                }
                            );
                        }
                    }
                } catch (error) {
                    if (error instanceof GroqApiError) {
                        
                        if (!this.settings.autoModeEnabled) {
                            new Notice(error.message);
                        }
                        throw error;
                    }
                    
                                        throw error;
                }
            } else if (this.settings.provider === 'openrouter') {
                
                const openRouterService = new OpenRouterService(
                    this.settings.openRouterApiKey,
                    (headers) => this.rateLimitManager.updateFromHeaders('openrouter', this.settings.model, headers)
                );
                
                
                const { formatMultimodalForOpenRouter, getOpenRouterPDFPlugins } = await import('../utils/multimodalUtils');
                
                
                const generationStep = 0;
                
                
                const openRouterMessages: OpenRouterChatMessage[] = [
                    {
                        role: 'system',
                        content: `${systemPrompt}\n\n${context.length > 0 ? context.join('\n\n') + '\n\n' : ''}`
                    }
                ];
                
                
                
                if (!isQuickSearchFollowUp && chatHistory.length > 0) {
                    
                    const contextWindowSize = this.getContextWindowSize();
                    const convertedHistory = convertChatHistoryForGroq(chatHistory, this.settings.model, contextWindowSize);
                    openRouterMessages.push(...convertedHistory as OpenRouterChatMessage[]);
                }
                
                
                const inlineInputs = multimodalInputs.filter(input => input.type === 'inline' && input.data);
                const hasPDFs = inlineInputs.some(input => input.fileName.toLowerCase().endsWith('.pdf'));
                
                
                if (inlineInputs.length > 0) {
                    updateProcessingUI(generationStep, totalSteps, `Processing ${inlineInputs.length} multimodal input(s)...`);
                    
                    
                    const multimodalContent = formatMultimodalForOpenRouter(enhancedQuery, inlineInputs);
                    openRouterMessages.push({
                        role: 'user',
                        content: multimodalContent
                    });
                } else {
                    
                    openRouterMessages.push({
                        role: 'user',
                        content: enhancedQuery
                    });
                }

                try {
                    
                    if (webEnabled) {
                                                
                        
                        if (this.settings.geminiApiKey || this.settings.apiKey) {
                            const geminiModel = 'gemini-2.5-flash-exp';
                            updateProcessingUI(generationStep, totalSteps, `Generating response with ${geminiModel} (web search)...`, `Input query: ${enhancedQuery}`);
                            
                            const genAI = new GoogleGenerativeAI(this.settings.geminiApiKey || this.settings.apiKey);
                            const model = genAI.getGenerativeModel({ model: geminiModel });
                            
                            const chatConfig: Record<string, any> = {
                                history: isQuickSearchFollowUp ? [] : chatHistory,
                                generationConfig: {
                                    temperature: getModelTemperature(this.settings.model, this.settings),
                                    topK: 40,
                                    topP: getModelTopP(this.settings.model, this.settings),
                                    maxOutputTokens: 8192,
                                },
                                tools: [this.webSearchService.getGoogleSearchToolConfig()]
                            };
                            
                            const messageParts: Record<string, unknown>[] = [{
                                text: `${systemPrompt}\n\n${context.length > 0 ? context.join('\n\n') + '\n\n' : ''}Question: ${enhancedQuery}`
                            }];
                            
                            const streamResult = await model.startChat(chatConfig as unknown as any).sendMessageStream(messageParts as unknown as any, { signal: abortSignal });
                            
                            for await (const chunk of streamResult.stream) {
                                if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
                                const candidate = chunk.candidates?.[0];
                                if (candidate) responseText += this.processGeminiStreamingCandidate(candidate, updateSnippetUI);
                            }
                            
                            const finalResponse = await streamResult.response;
                            if (finalResponse.candidates && finalResponse.candidates.length > 0) {
                                const candidate = finalResponse.candidates[0];
                                if (candidate.groundingMetadata) {
                                    responseText = this.addCitations(responseText, candidate.groundingMetadata);
                                    webResults = candidate.groundingMetadata.groundingChunks?.map((chunk: any) => ({
                                        title: chunk.web?.title || 'Unknown Source',
                                        link: chunk.web?.uri || '#',
                                        snippet: '',
                                    })) || [];
                                }
                            }
                        } else if (this.settings.groqApiKey) {
                            
                            const groqService = new GroqService(
                                this.settings.groqApiKey,
                                (headers) => this.rateLimitManager.updateFromHeaders('groq', switchedToModel || this.settings.model, headers)
                            );
                            const webCapableGroqModels = ['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile'];
                            let switchedToModel: string | null = null;
                            
                            for (const capableModel of webCapableGroqModels) {
                                if (isGroqWebSearchCapable(capableModel)) {
                                    switchedToModel = capableModel;
                                    break;
                                }
                            }
                            
                            if (switchedToModel) {
                                updateProcessingUI(generationStep, totalSteps, `Generating response with ${switchedToModel} (web search)...`, `Input query: ${enhancedQuery}`);
                                
                                const groqMessages: GroqChatMessage[] = [
                                    { role: 'system', content: `${systemPrompt}\n\n${context.length > 0 ? context.join('\n\n') + '\n\n' : ''}` }
                                ];
                                
                                if (!isQuickSearchFollowUp && chatHistory.length > 0) {
                                    
                                    const contextWindowSize = this.getContextWindowSize(switchedToModel);
                                    const convertedHistory = convertChatHistoryForGroq(chatHistory, switchedToModel, contextWindowSize);
                                    groqMessages.push(...convertedHistory);
                                }
                                
                                groqMessages.push({ role: 'user', content: enhancedQuery });
                                
                                const result = await groqService.generateContentWithWebSearch(
                                    switchedToModel,
                                    groqMessages,
                                    { 
                                        temperature: getModelTemperature(this.settings.model, this.settings), 
                                        topP: getModelTopP(this.settings.model, this.settings),
                                        thinkingLevel: switchedToModel.toLowerCase().includes('gpt-oss') ? (this.settings.groqThinkingLevel || 'medium') : undefined
                                    },
                                    (chunk: string) => { updateSnippetUI('Generating response...', chunk); }
                                );
                                
                                responseText = result.content;
                                webResults = result.webSources.map((source: WebSource) => ({
                                    title: source.title,
                                    link: source.url,
                                    snippet: source.snippet || ''
                                }));
                                
                                if (webResults.length > 0) {
                                    responseText = this.formatGroqWebCitations(responseText, result.webSources);
                                }
                            } else {
                                
                                                                updateProcessingUI(generationStep, totalSteps, 'Generating response with OpenRouter (without web search)...', `Input query: ${enhancedQuery}`);
                            }
                        } else {
                            
                                                        updateProcessingUI(generationStep, totalSteps, 'Generating response with OpenRouter (without web search)...', `Input query: ${enhancedQuery}`);
                        }
                    }
                    
                    
                    if (!responseText) {
                        updateProcessingUI(generationStep, totalSteps, 'Generating response with OpenRouter...', `Input query: ${enhancedQuery}`);
                        
                        
                        const generationOptions: any = {
                            temperature: getModelTemperature(this.settings.model, this.settings),
                            maxTokens: 8192,
                            topP: getModelTopP(this.settings.model, this.settings)
                        };
                        
                        
                        if (hasPDFs) {
                            generationOptions.plugins = getOpenRouterPDFPlugins();
                            updateProcessingUI(generationStep, totalSteps, 'Processing PDFs with OpenRouter (free pdf-text engine)...', `Input query: ${enhancedQuery}`);
                        }
                        
                        responseText = await openRouterService.generateContentStream(
                            this.settings.model,
                            openRouterMessages,
                            generationOptions,
                            (chunk: string) => {
                                updateSnippetUI('Generating response...', chunk);
                            },
                            (thinking: string) => {
                                updateSnippetUI('Thinking...', thinking);
                            }
                        );
                    }
                } catch (error) {
                    if (error instanceof OpenRouterApiError) {
                        
                        if (!this.settings.autoModeEnabled) {
                            new Notice(error.message);
                        }
                        throw error;
                    }
                    
                                        throw error;
                }
            } else if (this.settings.provider === 'ollama') {
                
                const ollamaService = new OllamaService(
                    this.settings.ollamaBaseUrl || 'http://localhost:11434',
                    this.settings.ollamaApiKey || '',
                    (headers) => this.rateLimitManager.updateFromHeaders('ollama', this.settings.model, headers)
                );
                
                
                const generationStep = 0;
                
                
                const inlineInputs = multimodalInputs.filter(input => input.type === 'inline' && input.data);
                const imageInputs = inlineInputs.filter(input => input.mimeType.startsWith('image/'));
                const hasImages = imageInputs.length > 0;

                
                const ollamaMessages: any[] = [
                    {
                        role: 'system',
                        content: hasImages ? systemPrompt : `${systemPrompt}\n\n${context.length > 0 ? context.join('\n\n') + '\n\n' : ''}`
                    }
                ];

                
                if (!isQuickSearchFollowUp && chatHistory.length > 0) {
                    
                    const contextWindowSize = this.getContextWindowSize();
                    const convertedHistory = convertChatHistoryForGroq(chatHistory, this.settings.model, contextWindowSize);
                    ollamaMessages.push(...convertedHistory);
                }

                
                const userMessage: any = {
                    role: 'user',
                    content: enhancedQuery
                };

                
                
                
                if (hasImages) {
                    updateProcessingUI(generationStep, totalSteps, `Processing ${imageInputs.length} image(s) with Ollama vision...`);
                    userMessage.images = imageInputs.map(img => img.data); 
                    
                    
                    let multimodalContent = '';
                    if (context.length > 0) {
                        multimodalContent += `## TEXT CONTEXT FROM NOTES\n${context.join('\n\n')}\n\n`;
                    }

                    multimodalContent += `## USER REQUEST\n${enhancedQuery}\n\n` +
                                       `CRITICAL INSTRUCTION: You are provided with both text context (from Obsidian notes) and embedded images. ` +
                                       `You MUST synthesize information from BOTH the text and the images to provide a comprehensive answer. ` +
                                       `Do not ignore the text in favor of the images, or vice-versa.`;

                    userMessage.content = multimodalContent;
                }

                ollamaMessages.push(userMessage);
                const normalizedOllamaModelId = (this.settings.model || '').toLowerCase();
                const isOllamaGptOssModel = normalizedOllamaModelId.includes('gpt-oss');
                const ollamaThinkOption = isOllamaGptOssModel
                    ? (this.settings.ollamaGptOssThinkingLevel || 'medium')
                    : !!this.settings.ollamaThinkingEnabled;

                try {
                    
                    if (webEnabled) {
                        if (!this.settings.ollamaApiKey) {
                                                        new Notice('Ollama web search requires an API key. Please add your Ollama API key in settings to enable web search.');
                            updateProcessingUI(generationStep, totalSteps, 'Generating response (web search unavailable)...', `Input query: ${enhancedQuery}`);
                        } else {
                            
                            updateProcessingUI(generationStep, totalSteps, 'Searching the web with Ollama...', `Query: ${enhancedQuery}`);
                            
                            try {
                                const searchResults = await ollamaService.webSearch(enhancedQuery, 5);
                                
                                if (searchResults.results.length > 0) {
                                    
                                    const webContext = this.formatOllamaWebSearchResults(searchResults.results);
                                    
                                    
                                    ollamaMessages[0].content += `\n\n${webContext}`;
                                    
                                    
                                    webResults = searchResults.results.map(r => ({
                                        title: r.title,
                                        link: r.url,
                                        snippet: r.content
                                    }));
                                    
                                                                        updateProcessingUI(generationStep, totalSteps, `Found ${webResults.length} web sources. Generating response...`);
                                } else {
                                                                        updateProcessingUI(generationStep, totalSteps, 'No web results found. Generating response...');
                                }
                            } catch (webSearchError) {
                                                                const errorMsg = webSearchError instanceof Error ? webSearchError.message : 'Web search failed';
                                new Notice(`Web search failed: ${errorMsg}. Continuing without web results.`);
                                updateProcessingUI(generationStep, totalSteps, 'Web search failed. Generating response...');
                            }
                        }
                    } else {
                        updateProcessingUI(generationStep, totalSteps, 'Generating response with Ollama...', `Input query: ${enhancedQuery}`);
                    }
                    
                    
                    
                    
                    let contentBuffer = '';
                    await ollamaService.generateContentStreamEvents(
                        this.settings.model,
                        ollamaMessages,
                        (evt) => {
                            if (evt.type === 'thinking') {
                                updateSnippetUI('Thinking...', evt.text);
                            } else if (evt.type === 'content') {
                                contentBuffer += evt.text;
                                updateSnippetUI('Generating response...', evt.text);
                            }
                        },
                        {
                            temperature: getModelTemperature(this.settings.model, this.settings),
                            maxTokens: 8192,
                            topP: getModelTopP(this.settings.model, this.settings),
                            think: ollamaThinkOption
                        }
                    );
                    responseText = contentBuffer;
                    
                    
                    if (webResults.length > 0) {
                        responseText = this.formatOllamaWebCitations(responseText, webResults);
                                            }
                } catch (error) {
                    if (error instanceof OllamaApiError) {
                        
                        if (!this.settings.autoModeEnabled) {
                            new Notice(error.message);
                        }
                        throw error;
                    }
                    
                                        throw error;
                }
            } else if (this.settings.provider === 'nvidia') {
                
                const nvidiaService = new NvidiaService(
                    this.settings.nvidiaApiKey,
                    (headers) => this.rateLimitManager.updateFromHeaders('nvidia', this.settings.model, headers)
                );
                
                
                const generationStep = 0;
                
                
                const nvidiaMessages: any[] = [
                    {
                        role: 'system',
                        content: `${systemPrompt}\n\n${context.length > 0 ? context.join('\n\n') + '\n\n' : ''}`
                    }
                ];
                
                
                if (!isQuickSearchFollowUp && chatHistory.length > 0) {
                    
                    const contextWindowSize = this.getContextWindowSize();
                    const convertedHistory = convertChatHistoryForGroq(chatHistory, this.settings.model, contextWindowSize);
                    nvidiaMessages.push(...convertedHistory);
                }
                
                
                nvidiaMessages.push({
                    role: 'user',
                    content: enhancedQuery
                });

                try {
                    
                    if (webEnabled) {
                                                updateProcessingUI(generationStep, totalSteps, 'Generating response with NVIDIA (without web search)...', `Input query: ${enhancedQuery}`);
                    } else {
                        updateProcessingUI(generationStep, totalSteps, 'Generating response with NVIDIA...', `Input query: ${enhancedQuery}`);
                    }
                    
                    try {
                        responseText = await nvidiaService.generateContentStream(
                            this.settings.model,
                            nvidiaMessages,
                            {
                                temperature: getModelTemperature(this.settings.model, this.settings),
                                maxTokens: 8192,
                                topP: getModelTopP(this.settings.model, this.settings)
                            },
                            (chunk: string) => {
                                updateSnippetUI('Generating response...', chunk);
                            },
                            (thinking: string) => {
                                updateSnippetUI('Thinking...', thinking);
                            }
                        );
                    } catch (streamError) {
                                                responseText = await nvidiaService.generateContent(
                            this.settings.model,
                            nvidiaMessages,
                            {
                                temperature: getModelTemperature(this.settings.model, this.settings),
                                maxTokens: 8192,
                                topP: getModelTopP(this.settings.model, this.settings)
                            }
                        );
                        updateSnippetUI('Generating response...', responseText);
                    }
                } catch (error) {
                    if (error instanceof NvidiaApiError) {
                        
                        if (!this.settings.autoModeEnabled) {
                            new Notice(error.message);
                        }
                        throw error;
                    }
                    
                                        throw error;
                }
            } else if (UnifiedProviderManager.getInstance().hasProvider(currentProvider)) {
                updateProcessingUI(0, totalSteps, `Generating response with ${currentProvider}...`, `Input query: ${enhancedQuery}`);
                const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(currentProvider)!;
                
                
                const baseMessages = [
                    { role: 'system', content: `${systemPrompt}\n\n${context.length > 0 ? context.join('\n\n') + '\n\n' : ''}` },
                    ...convertChatHistoryForGroq(isQuickSearchFollowUp ? [] : chatHistory, currentModel, this.getContextWindowSize())
                ];

                const unifiedMessages: any[] = [...baseMessages];
                
                
                const customModel = this.settings.customModels?.find(m => m.id === currentModel);
                const isVisionCapable = customModel?.capabilities?.includes('vision') || 
                                       currentModel.toLowerCase().includes('vision') || 
                                       currentModel.toLowerCase().includes('llava') || 
                                       currentModel.toLowerCase().includes('-vl') ||
                                       currentModel.toLowerCase().includes('gpt-4o');

                if (isVisionCapable) {
                    const inlineInputs = multimodalInputs.filter(input => input.type === 'inline' && input.data && input.mimeType.startsWith('image/'));
                    if (inlineInputs.length > 0) {
                        const contentParts: any[] = [{ type: 'text', text: enhancedQuery }];
                        for (const input of inlineInputs) {
                            contentParts.push({
                                type: 'image_url',
                                image_url: {
                                    url: `data:${input.mimeType};base64,${input.data}`
                                }
                            });
                        }
                        unifiedMessages.push({ role: 'user', content: contentParts });
                    } else {
                        unifiedMessages.push({ role: 'user', content: enhancedQuery });
                    }
                } else {
                    unifiedMessages.push({ role: 'user', content: enhancedQuery });
                }

                if (unifiedProvider.streamContent) {
                    const response = await unifiedProvider.streamContent(
                        currentModel,
                        unifiedMessages,
                        (chunk: string) => {
                            responseText += chunk;
                            updateSnippetUI('Generating response...', chunk);
                        },
                        {
                            temperature: getModelTemperature(currentModel, this.settings),
                            topP: getModelTopP(currentModel, this.settings),
                            maxTokens: 8192
                        },
                        (thinking: string) => {
                            updateSnippetUI('Thinking...', thinking);
                        }
                    );
                    if (!responseText && response.text) responseText = response.text;
                } else {
                    const response = await unifiedProvider.generateContent(
                        currentModel,
                        unifiedMessages,
                        {
                            temperature: getModelTemperature(currentModel, this.settings),
                            topP: getModelTopP(currentModel, this.settings),
                            maxTokens: 8192
                        },
                        (thinking: string) => {
                            updateSnippetUI('Thinking...', thinking);
                        }
                    );
                    responseText = response.text;
                }
            } else { 
                const messages = [
                    {
                        role: 'system',
                         content: `${systemPrompt}\n\n${context.length > 0 ? context.join('\n\n') + '\n\n' : ''}` 
                    },
                    ...(isQuickSearchFollowUp ? [] : chatHistory),
                    { role: 'user', content: enhancedQuery }
                ];

                  
                 const generationStep = 0; 
                 updateProcessingUI(generationStep, totalSteps, 'Generating response...', `Input query: ${enhancedQuery}`); 


                const resp = await requestUrl({
                    url: 'https://api.openai.com/v1/chat/completions',
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.settings.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: this.settings.model,
                        messages,
                        temperature: getModelTemperature(this.settings.model, this.settings),
                        top_p: getModelTopP(this.settings.model, this.settings),
                        max_tokens: 8192,
                    })
                });

                responseText = resp.json.choices[0].message.content;
            }

            
            updateProcessingUI(totalSteps, totalSteps, 'Complete!', 'Processing finished.'); 

            
            if (!totalTokens && responseText) {
                
                const inputTokens = Math.ceil((systemPrompt + context.join('') + enhancedQuery).length / 4);
                const outputTokens = Math.ceil(responseText.length / 4);
                totalTokens = inputTokens + outputTokens;
            }

            return { answer: responseText, webResults: isQuickSearchFollowUp ? [] : webResults, totalTokens };

        } catch (error: any) { 
                          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
             
             
             await this.handlePermanentModelError(error);

             
             updateProcessingUI(0, totalSteps, 'Error', `Failed: ${errorMessage}`); 
             throw new Error(`Error generating response: ${errorMessage}`); 
        }
         
    }

    /**
     * Identifies and auto-disables models that return permanent errors (auth, payment, not found).
     */
    private async handlePermanentModelError(error: any) {
        const status = error.status || error.statusCode || error.httpStatus;
        const message = error.message || '';
        
        
        const permanentErrors = [401, 402, 403, 404];
        
        if (permanentErrors.includes(status) || 
            message.includes('Insufficient credits') || 
            message.includes('Model not found') ||
            message.includes('Authentication failed') ||
            message.includes('payment_required')) {
            
            const currentModelId = this.settings.model;
            const currentProvider = this.settings.provider;
            
            const modelIndex = this.settings.customModels.findIndex(m => m.id === currentModelId && m.provider === currentProvider);
            
            if (modelIndex !== -1) {
                const model = this.settings.customModels[modelIndex];
                model.enabled = false;
                model.verificationStatus = 'failed';
                model.verificationError = message;
                model.lastVerified = Date.now();
                
                await this.saveSettings();
                new Notice(`Model '${model.name || model.id}' auto-disabled due to permanent error: ${message}`);
            }
        }
    }

    /**
     * Adds footnote-style citations to the text based on grounding metadata.
     * Uses Obsidian's footnote format [^1], [^2], etc. with definitions at the end.
     * @param text The original text from the Gemini response.
     * @param groundingMetadata The grounding metadata from the Gemini response.
     * @returns The text with footnote citations and definitions appended.
     */
    private addCitations(text: string, groundingMetadata: GroundingMetadata): string {
        const supports = (groundingMetadata as any).groundingSupports as Record<string, unknown>[];
        const chunks = (groundingMetadata as any).groundingChunks as Record<string, unknown>[];

        if (!supports || !chunks || supports.length === 0 || chunks.length === 0) {
            return text;
        }

        
        const sourceMap = new Map<string, number>();
        let footnoteCounter = 1;

        
        const sortedSupports = [...supports].sort(
            (a, b) => {
                const aEnd = (a.segment as Record<string, unknown>)?.endIndex as number || 0;
                const bEnd = (b.segment as Record<string, unknown>)?.endIndex as number || 0;
                return bEnd - aEnd;
            },
        );

        for (const support of sortedSupports) {
            const endIndex = (support.segment as Record<string, unknown>)?.endIndex as number;
            if (endIndex === undefined || !(support.groundingChunkIndices as number[])?.length) {
                continue;
            }

            
            const footnoteNumbers: number[] = [];
            
            for (const chunkIndex of (support.groundingChunkIndices as number[])) {
                const chunk = chunks[chunkIndex];
                const uri = (chunk?.web as Record<string, unknown>)?.uri as string;
                
                if (uri) {
                    
                    if (!sourceMap.has(uri)) {
                        sourceMap.set(uri, footnoteCounter);
                        footnoteCounter++;
                    }
                    footnoteNumbers.push(sourceMap.get(uri)!);
                }
            }

            
            if (footnoteNumbers.length > 0) {
                
                const uniqueNumbers = [...new Set(footnoteNumbers)].sort((a, b) => a - b);
                const citationString = uniqueNumbers.map(num => `[^${num}]`).join('');
                text = text.slice(0, endIndex) + citationString + text.slice(endIndex);
            }
        }

        
        if (sourceMap.size > 0) {
            const footnoteDefinitions: string[] = [];
            
            
            const sortedSources = Array.from(sourceMap.entries()).sort((a, b) => a[1] - b[1]);
            
            for (const [uri, num] of sortedSources) {
                
                const chunk = chunks.find((c) => (c?.web as Record<string, unknown>)?.uri === uri);
                const title = (chunk?.web as Record<string, unknown>)?.title as string || 'Web Source';
                
                footnoteDefinitions.push(`[^${num}]: [${title}](${uri})`);
            }
            
            text += '\n\n' + footnoteDefinitions.join('\n');
        }

        return text;
    }

    /**
     * Formats Groq web search results into footnote-style citations.
     * Uses the same footnote format as Gemini citations [^1], [^2], etc.
     * Since Groq doesn't provide inline citation positions like Gemini's
     * grounding metadata, this adds a summary citation reference at the end
     * of the response text and appends footnote definitions.
     * @param text The original text from the Groq response.
     * @param webSources Array of web sources from the Groq web search.
     * @returns The text with inline citation references and footnote definitions appended.
     */
    private formatGroqWebCitations(text: string, webSources: WebSource[]): string {
        if (!webSources || webSources.length === 0) {
            return text;
        }

        
        const footnoteDefinitions: string[] = [];
        const citationRefs: string[] = [];
        
        for (let i = 0; i < webSources.length; i++) {
            const source = webSources[i];
            const footnoteNum = i + 1;
            const title = source.title || 'Web Source';
            const url = source.url;
            
            
            citationRefs.push(`[^${footnoteNum}]`);
            
            footnoteDefinitions.push(`[^${footnoteNum}]: [${title}](${url})`);
        }

        
        
        if (citationRefs.length > 0) {
            text += ' ' + citationRefs.join('');
        }

        
        if (footnoteDefinitions.length > 0) {
            text += '\n\n' + footnoteDefinitions.join('\n');
        }

        return text;
    }

    /**
     * Formats Ollama web search results into context text for the system prompt.
     * Structures the results in a clear format that the model can reference.
     * @param results Array of web search results from Ollama
     * @returns Formatted context string with web search results
     */
    private formatOllamaWebSearchResults(results: any[]): string {
        if (!results || results.length === 0) {
            return '';
        }

        let context = 'Web Search Results:\n\n';
        
        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            const num = i + 1;
            context += `[${num}] ${result.title}\n`;
            context += `URL: ${result.url}\n`;
            context += `Content: ${result.content}\n\n`;
        }

        context += 'Instructions: Use the web search results above to provide accurate, up-to-date information. Cite sources using [^n] format where n is the result number.';
        
        return context;
    }

    /**
     * Formats Ollama web search citations into footnote-style references.
     * Uses the same footnote format as Gemini and Groq citations [^1], [^2], etc.
     * Since Ollama web search is performed before generation (not during),
     * this adds citation references at the end and appends footnote definitions.
     * @param text The original text from the Ollama response
     * @param webResults Array of web search results
     * @returns The text with citation references and footnote definitions appended
     */
    private formatOllamaWebCitations(text: string, webResults: WebSearchResult[]): string {
        if (!webResults || webResults.length === 0) {
            return text;
        }

        
        const footnoteDefinitions: string[] = [];
        const citationRefs: string[] = [];
        
        for (let i = 0; i < webResults.length; i++) {
            const result = webResults[i];
            const footnoteNum = i + 1;
            const title = result.title || 'Web Source';
            const url = result.link;
            
            
            citationRefs.push(`[^${footnoteNum}]`);
            
            footnoteDefinitions.push(`[^${footnoteNum}]: [${title}](${url})`);
        }

        
        
        if (citationRefs.length > 0) {
            text += ' ' + citationRefs.join('');
        }

        
        if (footnoteDefinitions.length > 0) {
            text += '\n\n' + footnoteDefinitions.join('\n');
        }

        return text;
    }

    /**
     * Process MCP query with tool calling support.
     *
     * Manual mode: user selects a model → model runs tool calls → model generates answer. That's it.
     *
     * Auto mode uses a two-phase ledger approach:
     *   Phase 1 — Planning: one LLM call produces a JSON execution plan.
     *   Phase 2 — Execution: tools run against the plan (parallel where possible,
     *             per-step retry on failure). The ledger is the source of truth for
     *             the entire fallback chain — no lossy text summarization.
     *
     * Synthesis attempts across the chain are capped at MAX_SYNTHESIS_ATTEMPTS
     * to prevent the chain from burning through all models without fulfilling the query.
     */
    async processMCPQuery(
        query: string,
        enhancedQuery: string,
        mcpContext: string,
        chatHistory: GeminiHistoryMessage[],
        updateProcessingUI: ProgressCallback,
        updateSnippetUI: SnippetUpdateCallback,
        mcpTools: Record<string, unknown>[],
        executeToolCallback: (toolCall: Record<string, any>) => Promise<Record<string, any>>,
        autoSelection: ModelSelection | null = null,
        isAutoToolMode: boolean = false,
        
        
        
        serverGroups: Map<string, Record<string, unknown>[]> = new Map(),
        
        enableRateLimit: boolean = true,
        multimodalInputs: MultimodalInput[] = [],
        abortSignal?: AbortSignal
    ): Promise<BasicChatResult> {
        let responseText = "";
        let webResults: WebSearchResult[] = [];
        let totalTokens: number | undefined = undefined;
        const mcpNormalizedOllamaModelId = (this.settings.model || '').toLowerCase();
        const mcpIsOllamaGptOssModel = mcpNormalizedOllamaModelId.includes('gpt-oss');
        const ollamaThinkOption = mcpIsOllamaGptOssModel
            ? (this.settings.ollamaGptOssThinkingLevel || 'medium')
            : !!this.settings.ollamaThinkingEnabled;

        try {
            
            const getTimeoutForTask = (taskType: TaskType, isRetry: boolean = false): number => {
                const base = isRetry ? 0.8 : 1.0;
                switch (taskType) {
                    case TaskType.BASIC_CHAT:
                    case TaskType.VAULT_SEARCH:
                    case TaskType.FLASH_SEARCH:
                    case TaskType.YOUTUBE_QUERY:
                        return Math.round(45_000 * base);
                    case TaskType.MCP_TOOL_CALLING:
                        return Math.round(60_000 * base);
                    case TaskType.DEEP_REASONING:
                    case TaskType.CODE_GENERATION:
                    case TaskType.WEBPAGE_FETCH:
                        return Math.round(150_000 * base);
                    default:
                        return Math.round(75_000 * base);
                }
            };

            const withTimeout = <T>(
                promiseFactory: (signal: AbortSignal) => Promise<T>, 
                ms: number
            ): Promise<T> & { resetTimer: () => void; disableTimer: () => void } => {
                let timer: ReturnType<typeof setTimeout> | null;
                let rejectFn: (err: Error) => void;
                const internalAbort = new AbortController();
                
                
                if (abortSignal) {
                    if (abortSignal.aborted) internalAbort.abort();
                    abortSignal.addEventListener('abort', () => internalAbort.abort(), { once: true });
                }

                const timeout = new Promise<never>((_, reject) => {
                    rejectFn = reject;
                    timer = setTimeout(() => {
                        internalAbort.abort(); 
                        reject(new Error(`__MCP_TIMEOUT__: model did not respond within ${ms / 1000}s`));
                    }, ms);
                });

                const abortPromise = new Promise<never>((_, reject) => {
                    if (internalAbort.signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
                    internalAbort.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                });

                const passPromise = promiseFactory(internalAbort.signal);
                const raced = Promise.race([passPromise, timeout, abortPromise]).finally(() => {
                    if (timer) {
                        clearTimeout(timer);
                        timer = null;
                    }
                }) as Promise<T> & { resetTimer: () => void; disableTimer: () => void };

                raced.resetTimer = () => {
                    if (timer) clearTimeout(timer);
                    timer = setTimeout(() => {
                        internalAbort.abort();
                        rejectFn(new Error(`__MCP_TIMEOUT__: model did not respond within ${ms / 1000}s`));
                    }, ms);
                };

                raced.disableTimer = () => {
                    if (timer) {
                        clearTimeout(timer);
                        timer = null;
                    }
                };
                return raced;
            };

            
            const hasTools = mcpTools && mcpTools.length > 0;

            if (!hasTools) {
                                return await this.process(
                    query,
                    enhancedQuery,
                    mcpContext,
                    chatHistory,
                    false,
                    updateProcessingUI,
                    false,
                    updateSnippetUI,
                    [],
                    ''
                );
            }

            
            
            
            if (autoSelection === null) {
                const toolNames = mcpTools.map((t: any) => t.function?.name).filter(Boolean);

                
                
                const toolDescriptions = (() => {
                    if (serverGroups.size > 1) {
                        const lines: string[] = [];
                        for (const [srvName, srvTools] of serverGroups.entries()) {
                            if (srvTools.length === 0) continue;
                            lines.push(`### Server: ${srvName}`);
                            for (const t of srvTools) {
                                const n = (t as unknown as any).function?.name || 'unknown';
                                const d = (t as unknown as any).function?.description || 'No description';
                                lines.push(`- ${n}: ${d}`);
                            }
                        }
                        return lines.join('\n');
                    }
                    return mcpTools.map((t: any) => {
                        const name = t.function?.name || 'unknown';
                        const desc = t.function?.description || 'No description';
                        return `- ${name}: ${desc}`;
                    }).join('\n');
                })();

                
                const toolChoice: 'auto' | 'required' = isAutoToolMode ? 'auto' : 'required';

                
                const toolListText = toolNames.length > 0
                    ? (isAutoToolMode
                        ? `\n\n## Available Tools\n\nYou have access to the following ${toolNames.length} tool(s). Use ONLY the tools that are RELEVANT to answering the user's specific question:\n\n${toolDescriptions}\n\n**Think carefully:** Analyze the user's query and select the minimal subset of tools that will provide the needed information. Do NOT call tools unnecessarily.`
                        : `\n\n## Available Tools (User-Selected)\n\nYou have access to the following ${toolNames.length} tool(s). The user has EXPLICITLY selected these tools and expects you to use ALL of them:\n\n${toolDescriptions}\n\n**IMPORTANT: You MUST call EVERY tool listed above.** The user selected them intentionally for a reason. Do not skip any tool, even if you think it might not be relevant.`)
                    : '';

                const systemPrompt = `You are a helpful AI assistant with access to MCP (Model Context Protocol) tools.${toolListText}

## Your Task

${isAutoToolMode
    ? `1. **Understand what the user is asking** - identify the key information needs
2. **Select the most appropriate tool(s)** based on the query
3. **Call ONLY the relevant tools** - not all tools are needed for every query
4. **Synthesize a complete answer** from tool results`
    : `1. **Call every tool** that the user explicitly selected
2. **Wait for all results** before synthesizing your final answer
3. **Synthesize a complete answer** that incorporates all tool results`}

## Guidelines

${isAutoToolMode
    ? `- Carefully analyze which tools are actually needed
- Start with the most likely useful tool(s)
- After receiving results, determine if more tools are needed
- NOT all tools need to be called`
    : `- You MUST call every tool the user selected
- Call all tools even if some seem redundant`}

- Call tools using the exact format specified in the tool definitions
- Provide all required parameters for each tool
- If a tool returns an error, note it and continue with remaining tools
- Do NOT fabricate tool results — only use actual responses
- After receiving results, provide a comprehensive answer

## Error Handling

- If a tool fails, document the error but proceed with remaining tools
- If all tools fail, explain the errors clearly to the user

${mcpContext}`;

                
                let plannedTools: string[] | null = null;

                if (isAutoToolMode && toolNames.length > 0 && toolNames.length <= 100) {
                    updateProcessingUI(1, 3, 'Planning tool execution...');
                    updateSnippetUI('Analysing query and selecting tools...');

                    try {
                        const planningProvider = getProviderForModel(this.settings.model, this.settings, this.settings.provider);
                        
                        
                        const planningServerContext = serverGroups.size > 1
                            ? '\n\nSERVER GROUPINGS (for context — tool names must still be exact):\n' +
                              Array.from(serverGroups.entries())
                                  .filter(([, t]) => t.length > 0)
                                  .map(([srvName, srvTools]) =>
                                      `- Server "${srvName}": ${srvTools.map((t: any) => t.function?.name).filter(Boolean).join(', ')}`
                                  ).join('\n')
                            : '';

                        const planningPrompt = `You are a tool orchestration planner. Your job is to select the most relevant tools to answer the user's query.

TOOLS LIST: ${toolNames.join(', ')}${planningServerContext}

IMPORTANT: You DO NOT have direct access to these tools. You MUST NOT attempt to call them directly. 
Your ONLY valid action is to call the 'submit_tool_selection' tool with your selection of tool names from the list above. 

Be extremely selective and choose only the minimal set of tools needed. If no tools are needed, return an empty list via 'submit_tool_selection'.`;

                        const planningMessages = [
                            { role: 'system', content: planningPrompt },
                            { role: 'user', content: enhancedQuery }
                        ];

                        const selectionTool = {
                            type: 'function',
                            function: {
                                name: 'submit_tool_selection',
                                description: 'Submit the list of tool names selected to answer the user query.',
                                parameters: {
                                    type: 'object',
                                    properties: {
                                        selected_tools: {
                                            type: 'array',
                                            items: { 
                                                type: 'string',
                                                enum: toolNames
                                            },
                                            description: 'The exact names of the tools selected.'
                                        },
                                        rationale: {
                                            type: 'string',
                                            description: 'Brief reason for these selections.'
                                        }
                                    },
                                    required: ['selected_tools', 'rationale']
                                }
                            }
                        };

                        const planningTools = [selectionTool];
                        let extractedTools: string[] = [];

                        const planningExecCb = async (toolCalls: any[]) => {
                            if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
                            for (const tc of toolCalls) {
                                if (tc.function?.name === 'submit_tool_selection') {
                                    try {
                                        const args = typeof tc.function.arguments === 'string' 
                                            ? JSON.parse(tc.function.arguments) 
                                            : tc.function.arguments;
                                        if (args.selected_tools && Array.isArray(args.selected_tools)) {
                                            extractedTools = args.selected_tools;
                                        }
                                    } catch (e) {
                                                                            }
                                }
                            }
                            return toolCalls.map(() => ({ success: true, content: 'Selection received.' }));
                        };

                        const planningOptions: any = { temperature: 0.1, abortSignal };

                        if (planningProvider === 'groq') {
                            const gs = new GroqService(this.settings.groqApiKey,
                                (h: any) => this.rateLimitManager.updateFromHeaders('groq', this.settings.model, h));
                            await gs.generateContentWithTools(this.settings.model, planningMessages as any[], planningTools, { ...planningOptions, toolChoice: 'required' }, planningExecCb);
                        } else if (planningProvider === 'gemini') {
                            const gs = new GeminiService(this.settings.geminiApiKey || this.settings.apiKey,
                                (h: any) => this.rateLimitManager.updateFromHeaders('gemini', this.settings.model, h));
                            await gs.generateContentWithTools(this.settings.model, planningMessages, planningTools, { ...planningOptions, maxOutputTokens: 1024 }, planningExecCb);
                        } else if (planningProvider === 'openrouter') {
                            const ors = new OpenRouterService(this.settings.openRouterApiKey,
                                (h: any) => this.rateLimitManager.updateFromHeaders('openrouter', this.settings.model, h));
                            await ors.generateContentWithTools(this.settings.model, planningMessages as any[], planningTools, { ...planningOptions, toolChoice: 'required' }, planningExecCb);
                        } else if (planningProvider === 'ollama') {
                            const os = new OllamaService(this.settings.ollamaBaseUrl || 'http://localhost:11434', this.settings.ollamaApiKey,
                                (h: any) => this.rateLimitManager.updateFromHeaders('ollama', this.settings.model, h));
                            await os.generateContentWithTools(this.settings.model, planningMessages as any[], planningTools, planningOptions, planningExecCb);
                        } else if (UnifiedProviderManager.getInstance().hasProvider(planningProvider)) {
                            const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(planningProvider)!;
                            if (unifiedProvider.generateContentWithTools) {
                                await unifiedProvider.generateContentWithTools(this.settings.model, planningMessages as any[], planningTools, planningOptions, planningExecCb);
                            }
                        }

                        if (extractedTools.length > 0) {
                            
                            plannedTools = extractedTools.map(selected => {
                                if (toolNames.includes(selected)) return selected;
                                const match = toolNames.find(tn => tn.endsWith(`__${selected}`));
                                return match || selected;
                            }).filter(tn => toolNames.includes(tn));
                            
                                                    }
                    } catch (planErr) {
                                            }
                }

                
                const toolsToUse = plannedTools
                    ? mcpTools.filter((t: any) => plannedTools!.includes(t.function?.name))
                    : mcpTools;

                
                
                
                
                
                
                const serverEntries = Array.from(serverGroups.entries())
                    .filter(([, tools]) => tools.length > 0)
                    .sort((a, b) => {
                        if (!plannedTools || plannedTools.length === 0) return 0;
                        const firstIndexOf = ([, tools]: [string, any[]]) => {
                            let minIdx = Infinity;
                            for (const t of tools) {
                                const name = t.function?.name;
                                if (!name) continue;
                                const idx = plannedTools!.indexOf(name);
                                if (idx !== -1 && idx < minIdx) minIdx = idx;
                            }
                            return minIdx === Infinity ? plannedTools!.length : minIdx;
                        };
                        return firstIndexOf(a) - firstIndexOf(b);
                    });
                const isMultiServer = serverEntries.length > 1;

                
                const getFilteredServerTools = (serverTools: any[]): any[] => {
                    if (!plannedTools || plannedTools.length === 0) {
                        return serverTools;
                    }
                    return serverTools.filter((t: any) => plannedTools.includes(t.function?.name));
                };

                
                
                const rateLimitSeconds = enableRateLimit ? (this.settings.rateLimitSeconds || 25) : 0;
                const rateLimitMs = rateLimitSeconds * 1000;
                const provider = getProviderForModel(this.settings.model, this.settings, this.settings.provider);
                const modelTPM = this.settings.customModels?.find(m => m.id === this.settings.model && m.provider === provider)?.tokenLimit || 8000;

                
                
                const modelCooldownUntil: Map<string, number> = new Map();

                const setModelCooldown = (cooldownModelId: string, cooldownProvider: string, waitTimeMs?: number): void => {
                    if (!enableRateLimit) return;
                    const waitMs = waitTimeMs || rateLimitMs;
                    const key = `${cooldownModelId}:${cooldownProvider}`;
                    modelCooldownUntil.set(key, Date.now() + waitMs);
                                    };

                const isModelOnCooldown = (mId: string, p: string): boolean => {
                    const key = `${mId}:${p}`;
                    const until = modelCooldownUntil.get(key) || 0;
                    return until > Date.now();
                };

                const checkAndApplyCooldown = async (cooldownModelId: string, cooldownProvider: string): Promise<void> => {
                    if (!enableRateLimit) return;
                    const key = `${cooldownModelId}:${cooldownProvider}`;
                    const cooldownUntil = modelCooldownUntil.get(key);
                    if (cooldownUntil) {
                        const waitMs = cooldownUntil - Date.now();
                        if (waitMs > 0) {
                            updateSnippetUI(`Rate limited — waiting ${Math.ceil(waitMs / 1000)}s...`);
                            updateProcessingUI(2, 3, `TPM error, waiting ${Math.ceil(waitMs / 1000)}s before retrying...`);
                                                        await new Promise(resolve => setTimeout(resolve, waitMs));
                        }
                    }
                };

                const messages: any[] = [{ role: 'system', content: systemPrompt }];
                if (chatHistory.length > 0) {
                    messages.push(...convertChatHistoryForGroq(chatHistory, this.settings.model, this.getContextWindowSize()));
                }
                if (this.settings.model === GROQ_VISION_MODEL) {
                    const inlineInputs = multimodalInputs.filter(input => input.type === 'inline' && input.data);
                    if (inlineInputs.length > 0) {
                        const contentParts: GroqContentPart[] = [{ type: 'text', text: enhancedQuery }];
                        for (const input of inlineInputs) {
                            contentParts.push({
                                type: 'image_url',
                                image_url: {
                                    url: `data:${input.mimeType};base64,${input.data}`
                                }
                            });
                        }
                        messages.push({ role: 'user', content: contentParts });
                    } else {
                        messages.push({ role: 'user', content: enhancedQuery });
                    }
                } else {
                    messages.push({ role: 'user', content: enhancedQuery });
                }

                
                const currBaseTokens = Math.ceil(messages.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m).length), 0) / 4);
                
                if (currBaseTokens > modelTPM * 0.7) {
                                        const trimmedMessages = [{ role: 'system', content: systemPrompt }];
                    if (chatHistory.length > 2) {
                        trimmedMessages.push(...chatHistory.slice(-2).map(m => ({ role: m.role, content: m.content || '' })));
                    }
                    trimmedMessages.push({ role: 'user', content: enhancedQuery });
                    messages.length = 0;
                    messages.push(...trimmedMessages);
                }

                
                const executeToolsForServer = async (
                    tools: any[],
                    serverName: string,
                    toolChoiceVal: 'auto' | 'required'
                ): Promise<{ content: string; totalTokens?: number }> => {
                    const estimateToolTokens = (tool: any): number => {
                        try { return Math.ceil(JSON.stringify(tool).length / 4); } catch { return 300; }
                    };

                    const chunkToolsFn = (toolsArr: any[]): any[][] => {
                        const budget = Math.max(2000, Math.floor(modelTPM * 0.5));
                        const chunks: any[][] = [];
                        let current: any[] = [];
                        let currentTokens = 0;
                        for (const tool of toolsArr) {
                            const t = estimateToolTokens(tool);
                            if (current.length > 0 && currentTokens + t > budget) {
                                chunks.push(current);
                                current = [];
                                currentTokens = 0;
                            }
                            current.push(tool);
                            currentTokens += t;
                        }
                        if (current.length > 0) chunks.push(current);
                        return chunks.length > 0 ? chunks : [toolsArr];
                    };

                    const chunks = chunkToolsFn(tools);
                    let serverContent = '';
                    let serverTokens: number | undefined;

                    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
                        const chunk = chunks[chunkIdx];
                        const chunkLabel = chunks.length > 1 ? `[batch ${chunkIdx + 1}/${chunks.length}]` : '';

                        await checkAndApplyCooldown(this.settings.model, provider);

                        const execCb = async (toolCalls: any[]) => {
                            if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
                            const results = [];
                            for (const toolCall of toolCalls) {
                                if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
                                const toolName = toolCall.function?.name || toolCall.name || 'unknown';
                                updateSnippetUI(`Executing ${toolName}...`);
                                updateProcessingUI(2, 3, `Running: ${toolName}`);
                                try {
                                    const result = await executeToolCallback(toolCall);
                                    const snippet = result?.content || (result?.error ? `Error: ${result.error}` : '(no output)');
                                    updateSnippetUI(`✓ ${toolName}`, snippet);
                                    results.push(result);
                                } catch (err) {
                                    const errMsg = err instanceof Error ? err.message : String(err);
                                    updateSnippetUI(`✗ ${toolName}`, errMsg);
                                    results.push({ success: false, content: '', error: errMsg });
                                }
                            }
                            return results;
                        };

                        try {
                            let chunkResult: { content: string; totalTokens?: number };
                            if (provider === 'groq') {
                                const gs = new GroqService(this.settings.groqApiKey,
                                    (h) => this.rateLimitManager.updateFromHeaders('groq', this.settings.model, h));
                                chunkResult = await gs.generateContentWithTools(this.settings.model, messages as any[], chunk,
                                    { temperature: getModelTemperature(this.settings.model, this.settings, 'groq' as any), topP: getModelTopP(this.settings.model, this.settings, 'groq' as any), toolChoice: toolChoiceVal, abortSignal },
                                    execCb);
                            } else if (provider === 'gemini') {
                                const { GeminiService: GS } = await import('./geminiService');
                                const gs = new GS(this.settings.geminiApiKey || this.settings.apiKey,
                                    (h) => this.rateLimitManager.updateFromHeaders('gemini', this.settings.model, h));
                                chunkResult = await gs.generateContentWithTools(this.settings.model, messages, chunk,
                                    {
                                        temperature: getModelTemperature(this.settings.model, this.settings, 'gemini' as any),
                                        maxOutputTokens: 8192,
                                        topP: getModelTopP(this.settings.model, this.settings, 'gemini' as any),
                                        thinkingConfig: getGeminiThinkingConfig(this.settings.model, this.settings)?.thinkingConfig,
                                        abortSignal
                                    },
                                    execCb,
                                    (thinking) => updateSnippetUI('Thinking...', thinking));
                            } else if (provider === 'openrouter') {
                                const { OpenRouterService: ORS } = await import('./openRouterService');
                                const ors = new ORS(this.settings.openRouterApiKey,
                                    (h) => this.rateLimitManager.updateFromHeaders('openrouter', this.settings.model, h));
                                chunkResult = await ors.generateContentWithTools(this.settings.model, messages as any[], chunk,
                                    { temperature: getModelTemperature(this.settings.model, this.settings, 'openrouter' as any), topP: getModelTopP(this.settings.model, this.settings, 'openrouter' as any), toolChoice: toolChoiceVal, abortSignal },
                                    execCb);
                            } else if (provider === 'ollama') {
                                const { OllamaService: OS } = await import('./ollamaService');
                                const os = new OS(this.settings.ollamaBaseUrl || 'http://localhost:11434', this.settings.ollamaApiKey,
                                    (h) => this.rateLimitManager.updateFromHeaders('ollama', this.settings.model, h));
                                const useReqUrl = this.settings.ollamaMode === 'cloud' ? requestUrl : undefined;
                                chunkResult = await os.generateContentWithTools(this.settings.model, messages as any[], chunk,
                                    { temperature: getModelTemperature(this.settings.model, this.settings, 'ollama' as any), think: ollamaThinkOption, abortSignal },
                                    execCb, useReqUrl,
                                    (thinking) => updateSnippetUI('Thinking...', thinking));
                            } else if (provider === 'nvidia') {
                                const { NvidiaService: NS } = await import('./nvidiaService');
                                const ns = new NS(this.settings.nvidiaApiKey,
                                    (h) => this.rateLimitManager.updateFromHeaders('nvidia', this.settings.model, h));
                                chunkResult = await ns.generateContentWithTools(this.settings.model, messages as any[], chunk,
                                    { temperature: getModelTemperature(this.settings.model, this.settings, 'nvidia' as any), maxTokens: 8192, topP: getModelTopP(this.settings.model, this.settings, 'nvidia' as any), toolChoice: toolChoiceVal, abortSignal },
                                    execCb);
                            } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
                                const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
                                if (unifiedProvider.generateContentWithTools) {
                                    chunkResult = await unifiedProvider.generateContentWithTools(
                                        this.settings.model,
                                        messages as any[],
                                        chunk,
                                        {
                                            temperature: getModelTemperature(this.settings.model, this.settings, provider as any),
                                            maxTokens: 8192,
                                            topP: getModelTopP(this.settings.model, this.settings, provider as any),
                                            toolChoice: toolChoiceVal,
                                            abortSignal
                                        },
                                        execCb,
                                        (thinking) => updateSnippetUI('Thinking...', thinking)
                                    );
                                } else {
                                    throw new Error(`Provider ${provider} does not support tool calling (required for MCP)`);
                                }
                            } else {
                                throw new Error(`Provider ${provider} not supported for tool calling`);
                            }

                            serverContent += (serverContent ? '\n\n' : '') + chunkResult.content;
                            serverTokens = chunkResult.totalTokens;

                        } catch (err) {
                            if (err instanceof DOMException && err.name === 'AbortError') {
                                throw err;
                            }
                            const errMsg = err instanceof Error ? err.message : String(err);
                            const errMsgLower = errMsg.toLowerCase();
                            const isRateLimitError = errMsgLower.includes('rate limit') || errMsgLower.includes('429');
                            const isTPMError = isRateLimitError || errMsgLower.includes('too large') ||
                                              errMsgLower.includes('413') || errMsgLower.includes('payload') ||
                                              errMsgLower.includes('token');

                            if (isRateLimitError && enableRateLimit && rateLimitMs > 0) {
                                setModelCooldown(this.settings.model, provider, rateLimitMs);
                                updateSnippetUI(`Rate limited — waiting ${rateLimitSeconds}s before retry...`);
                                updateProcessingUI(2, 3, `TPM error, waiting ${rateLimitSeconds}s before retrying...`);
                                await new Promise(resolve => setTimeout(resolve, rateLimitMs));
                                chunkIdx--;
                                continue;
                            }

                            if (isTPMError) {
                                setModelCooldown(this.settings.model, provider, rateLimitMs);
                                updateProcessingUI(2, 3, `TPM error, waiting ${rateLimitSeconds}s before retrying...`);
                            }

                            if (chunkIdx === chunks.length - 1 && !serverContent) {
                                throw err;
                            }
                        }
                    }

                    return { content: serverContent, totalTokens: serverTokens };
                };

                if (isMultiServer) {
                    
                                        
                    const allResults: string[] = [];
                    
                    for (const [serverName, serverTools] of serverEntries) {
                        if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
                        const filteredTools = getFilteredServerTools(serverTools);
                        if (filteredTools.length === 0) {
                                                        continue;
                        }
                        
                                                updateProcessingUI(2, 3, `Executing: ${serverName}`);
                        updateSnippetUI(`Querying ${serverName}...`);

                        
                        try {
                            const serverResult = await executeToolsForServer(
                                filteredTools,
                                serverName,
                                toolChoice
                            );
                            
                            if (serverResult.content) {
                                allResults.push(`## ${serverName}\n\n${serverResult.content}`);
                            } else {
                                                            }
                        } catch (serverErr) {
                            if (serverErr instanceof DOMException && serverErr.name === 'AbortError') {
                                throw serverErr;
                            }
                            
                            const errMsg = serverErr instanceof Error ? serverErr.message : String(serverErr);
                                                        allResults.push(`## ${serverName}\n\nError: ${errMsg}`);
                        }
                    }
                    
                    
                    
                    
                    
                    if (allResults.length === 0) {
                        throw new Error('MCP Query Error: No tools were executed successfully from any server');
                    }

                    const combinedServerContent = allResults.join('\n\n');

                    
                    if (allResults.length === 1) {
                        updateProcessingUI(3, 3, 'Complete!');
                        updateSnippetUI('Response generated successfully');
                        return {
                            answer: combinedServerContent,
                            webResults,
                            modelName: this.settings.model,
                            providerName: this.settings.provider
                        };
                    }

                    
                    updateProcessingUI(3, 3, 'Synthesising final answer...');
                    updateSnippetUI('Combining results from all servers...');

                    const multiServerSynthPrompt = [
                        { role: 'system', content: systemPrompt },
                        {
                            role: 'user',
                            content:
                                `${enhancedQuery}\n\n` +
                                `## Results from All MCP Servers\n\n` +
                                `${combinedServerContent}\n\n` +
                                `All servers have been queried. Using the results above from ALL servers, ` +
                                `provide ONE complete, unified answer that integrates information from every server. ` +
                                `Do NOT structure your answer per-server — synthesise a single coherent response. ` +
                                `CRITICAL: The user CANNOT see the tool results. Embed all relevant data, URLs, and details directly in your answer.`
                        }
                    ];

                    let consolidatedAnswer = '';
                    try {
                        if (provider === 'groq') {
                            const gs = new GroqService(this.settings.groqApiKey,
                                (h) => this.rateLimitManager.updateFromHeaders('groq', this.settings.model, h));
                            consolidatedAnswer = await gs.generateContent(
                                this.settings.model, multiServerSynthPrompt as any[],
                                { temperature: getModelTemperature(this.settings.model, this.settings), topP: getModelTopP(this.settings.model, this.settings) }
                            );
                        } else if (provider === 'gemini') {
                            const { GeminiService: GS } = await import('./geminiService');
                            const gs = new GS(this.settings.geminiApiKey || this.settings.apiKey,
                                (h) => this.rateLimitManager.updateFromHeaders('gemini', this.settings.model, h));
                            const prompt = `${systemPrompt}\n\n${multiServerSynthPrompt[1].content}`;
                            consolidatedAnswer = await gs.generateContentWithHeaders(
                                this.settings.model, prompt,
                                { temperature: getModelTemperature(this.settings.model, this.settings), maxOutputTokens: 8192, topP: getModelTopP(this.settings.model, this.settings) }
                            );
                        } else if (provider === 'openrouter') {
                            const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                                method: 'POST',
                                headers: { 'Authorization': `Bearer ${this.settings.openRouterApiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://obsidian.md', 'X-Title': 'Obsidian AI Tutor' },
                                body: JSON.stringify({ model: this.settings.model, messages: multiServerSynthPrompt, temperature: getModelTemperature(this.settings.model, this.settings), max_tokens: 8192, top_p: getModelTopP(this.settings.model, this.settings), stream: false })
                            });
                            if (resp.ok) {
                                const d = await resp.json();
                                consolidatedAnswer = d.choices?.[0]?.message?.content || '';
                            } else {
                                throw new Error(`OpenRouter synthesis error: ${resp.status}`);
                            }
                        } else if (provider === 'ollama') {
                            const baseUrl = this.settings.ollamaBaseUrl || 'http://localhost:11434';
                            const resp = await fetch(`${baseUrl}/api/chat`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    model: this.settings.model,
                                    messages: multiServerSynthPrompt,
                                    stream: false,
                                    think: ollamaThinkOption,
                                    options: { temperature: getModelTemperature(this.settings.model, this.settings) }
                                })
                            });
                            if (resp.ok) {
                                const d = await resp.json();
                                consolidatedAnswer = d.message?.content || '';
                            } else {
                                throw new Error(`Ollama synthesis error: ${resp.status}`);
                            }
                        } else if (provider === 'nvidia') {
                            const { NvidiaService: NS } = await import('./nvidiaService');
                            const ns = new NS(this.settings.nvidiaApiKey,
                                (h) => this.rateLimitManager.updateFromHeaders('nvidia', this.settings.model, h));
                            consolidatedAnswer = await ns.generateContent(this.settings.model, multiServerSynthPrompt as any[],
                                { temperature: getModelTemperature(this.settings.model, this.settings), maxTokens: 8192, topP: getModelTopP(this.settings.model, this.settings) });
                        } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
                            const up = UnifiedProviderManager.getInstance().getProvider(provider)!;
                            const res = await up.generateContent(this.settings.model, multiServerSynthPrompt as any[],
                                { temperature: getModelTemperature(this.settings.model, this.settings), maxTokens: 8192, topP: getModelTopP(this.settings.model, this.settings) });
                            consolidatedAnswer = res.text;
                        }
                    } catch (synthErr) {
                                                
                        consolidatedAnswer = combinedServerContent;
                    }

                    updateProcessingUI(3, 3, 'Complete!');
                    updateSnippetUI('Response generated successfully');
                    return {
                        answer: consolidatedAnswer || combinedServerContent,
                        webResults,
                        modelName: this.settings.model,
                        providerName: this.settings.provider
                    };
                }

                
                

                updateProcessingUI(2, 3, 'Executing tools...');
                updateSnippetUI('Running tool calls...');

                
                const estimateToolTokens = (tool: any): number => {
                    try { return Math.ceil(JSON.stringify(tool).length / 4); } catch { return 300; }
                };

                const chunkTools = (tools: any[]): any[][] => {
                    const budget = Math.max(2000, Math.floor(modelTPM * 0.5));
                    const chunks: any[][] = [];
                    let current: any[] = [];
                    let currentTokens = 0;
                    for (const tool of tools) {
                        const t = estimateToolTokens(tool);
                        if (current.length > 0 && currentTokens + t > budget) {
                            chunks.push(current);
                            current = [];
                            currentTokens = 0;
                        }
                        current.push(tool);
                        currentTokens += t;
                    }
                    if (current.length > 0) chunks.push(current);
                    return chunks.length > 0 ? chunks : [tools];
                };

                const chunks = chunkTools(toolsToUse);
                const isChunked = chunks.length > 1;

                if (isChunked) {
                                    }

                
                messages.length = 0;
                messages.push({ role: 'system', content: systemPrompt });
                if (chatHistory.length > 0) {
                    messages.push(...convertChatHistoryForGroq(chatHistory, this.settings.model, this.getContextWindowSize()));
                }
                if (this.settings.model === GROQ_VISION_MODEL) {
                    const inlineInputs = multimodalInputs.filter(input => input.type === 'inline' && input.data);
                    if (inlineInputs.length > 0) {
                        const contentParts: GroqContentPart[] = [{ type: 'text', text: enhancedQuery }];
                        for (const input of inlineInputs) {
                            contentParts.push({
                                type: 'image_url',
                                image_url: {
                                    url: `data:${input.mimeType};base64,${input.data}`
                                }
                            });
                        }
                        messages.push({ role: 'user', content: contentParts });
                    } else {
                        messages.push({ role: 'user', content: enhancedQuery });
                    }
                } else {
                    messages.push({ role: 'user', content: enhancedQuery });
                }

                
                const singleBaseTokens = Math.ceil(messages.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m).length), 0) / 4);
                
                if (singleBaseTokens > modelTPM * 0.7) {
                                        const trimmedMessages = [{ role: 'system', content: systemPrompt }];
                    if (chatHistory.length > 2) {
                        trimmedMessages.push(...chatHistory.slice(-2).map(m => ({ role: m.role, content: m.content || '' })));
                    }
                    trimmedMessages.push({ role: 'user', content: enhancedQuery });
                    messages.length = 0;
                    messages.push(...trimmedMessages);
                }

                
                await checkAndApplyCooldown(this.settings.model, provider);

                const execCb = async (toolCalls: any[]) => {
                    const results = [];
                    for (const toolCall of toolCalls) {
                        const toolName = toolCall.function?.name || toolCall.name || 'unknown';
                        updateSnippetUI(`Executing ${toolName}...`);
                        updateProcessingUI(2, 3, `Running: ${toolName}`);
                        try {
                            const result = await executeToolCallback(toolCall);
                            const snippet = result?.content || (result?.error ? `Error: ${result.error}` : '(no output)');
                            updateSnippetUI(`✓ ${toolName}`, snippet);
                            results.push(result);
                        } catch (err) {
                            if (err instanceof DOMException && err.name === 'AbortError') {
                                throw err;
                            }
                            const errMsg = err instanceof Error ? err.message : String(err);
                            updateSnippetUI(`✗ ${toolName}`, errMsg);
                            results.push({ success: false, content: '', error: errMsg });
                        }
                    }
                    return results;
                };

                let finalContent = '';
                let finalTokens: number | undefined;

                
                
                for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
                    const chunk = chunks[chunkIdx];
                    const chunkLabel = isChunked ? `[batch ${chunkIdx + 1}/${chunks.length}]` : '';

                    try {
                        let chunkResult: { content: string; totalTokens?: number };

                        if (provider === 'groq') {
                            const gs = new GroqService(this.settings.groqApiKey,
                                (h) => this.rateLimitManager.updateFromHeaders('groq', this.settings.model, h));
                            chunkResult = await gs.generateContentWithTools(this.settings.model, messages as any[], chunk,
                                { temperature: getModelTemperature(this.settings.model, this.settings, 'groq' as any), topP: getModelTopP(this.settings.model, this.settings, 'groq' as any), toolChoice, abortSignal },
                                execCb);
                        } else if (provider === 'gemini') {
                            const { GeminiService: GS } = await import('./geminiService');
                            const gs = new GS(this.settings.geminiApiKey || this.settings.apiKey,
                                (h) => this.rateLimitManager.updateFromHeaders('gemini', this.settings.model, h));
                            chunkResult = await gs.generateContentWithTools(this.settings.model, messages, chunk,
                                {
                                    temperature: getModelTemperature(this.settings.model, this.settings, 'gemini' as any),
                                    maxOutputTokens: 8192,
                                    topP: getModelTopP(this.settings.model, this.settings, 'gemini' as any),
                                    thinkingConfig: getGeminiThinkingConfig(this.settings.model, this.settings)?.thinkingConfig,
                                    abortSignal
                                },
                                execCb,
                                (thinking) => updateSnippetUI('Thinking...', thinking));
                        } else if (provider === 'openrouter') {
                            const { OpenRouterService: ORS } = await import('./openRouterService');
                            const ors = new ORS(this.settings.openRouterApiKey,
                                (h) => this.rateLimitManager.updateFromHeaders('openrouter', this.settings.model, h));
                            chunkResult = await ors.generateContentWithTools(this.settings.model, messages as any[], chunk,
                                { temperature: getModelTemperature(this.settings.model, this.settings, 'openrouter' as any), topP: getModelTopP(this.settings.model, this.settings, 'openrouter' as any), toolChoice, abortSignal },
                                execCb);
                        } else if (provider === 'ollama') {
                            const { OllamaService: OS } = await import('./ollamaService');
                            const os = new OS(this.settings.ollamaBaseUrl || 'http://localhost:11434', this.settings.ollamaApiKey,
                                (h) => this.rateLimitManager.updateFromHeaders('ollama', this.settings.model, h));
                            const useReqUrl = this.settings.ollamaMode === 'cloud' ? requestUrl : undefined;
                            chunkResult = await os.generateContentWithTools(this.settings.model, messages as any[], chunk,
                                { temperature: getModelTemperature(this.settings.model, this.settings, 'ollama' as any), think: ollamaThinkOption, abortSignal },
                                execCb, useReqUrl,
                                (thinking) => updateSnippetUI('Thinking...', thinking));
                        } else if (provider === 'nvidia') {
                            const { NvidiaService: NS } = await import('./nvidiaService');
                            const ns = new NS(this.settings.nvidiaApiKey,
                                (h) => this.rateLimitManager.updateFromHeaders('nvidia', this.settings.model, h));
                            chunkResult = await ns.generateContentWithTools(this.settings.model, messages as any[], chunk,
                                { temperature: getModelTemperature(this.settings.model, this.settings, 'nvidia' as any), maxTokens: 8192, topP: getModelTopP(this.settings.model, this.settings, 'nvidia' as any), toolChoice, abortSignal },
                                execCb);
                        } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
                            const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
                            if (unifiedProvider.generateContentWithTools) {
                                chunkResult = await unifiedProvider.generateContentWithTools(
                                    this.settings.model,
                                    messages as any[],
                                    chunk,
                                    {
                                        temperature: getModelTemperature(this.settings.model, this.settings, provider as any),
                                        maxTokens: 8192,
                                        topP: getModelTopP(this.settings.model, this.settings, provider as any),
                                        toolChoice,
                                        abortSignal
                                    },
                                    execCb,
                                    (thinking) => updateSnippetUI('Thinking...', thinking)
                                );
                            } else {
                                throw new Error(`Provider ${provider} does not support tool calling (required for MCP)`);
                            }
                        } else {
                            throw new Error(`Provider ${provider} not supported for tool calling`);
                        }

                        finalContent += (finalContent ? '\n\n' : '') + chunkResult.content;
                        finalTokens = chunkResult.totalTokens;

                        
                        if (chunkIdx === chunks.length - 1 && finalContent.trim()) {
                            break;
                        }

                        
                        if (chunkIdx < chunks.length - 1 && chunkResult.content) {
                            messages.push({ role: 'assistant', content: chunkResult.content });
                            messages.push({ role: 'user', content: 'Continue with the remaining tools and provide the final answer.' });
                        }

                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        const errMsgLower = errMsg.toLowerCase();
                        const isRateLimitError = errMsgLower.includes('rate limit') || errMsgLower.includes('429');
                        const isTPMError = isRateLimitError || errMsgLower.includes('too large') ||
                                          errMsgLower.includes('413') || errMsgLower.includes('payload') ||
                                          errMsgLower.includes('token');

                        
                        if (isRateLimitError && enableRateLimit && rateLimitMs > 0) {
                            setModelCooldown(this.settings.model, provider, rateLimitMs);
                            const waitSeconds = rateLimitSeconds;
                            updateSnippetUI(`Rate limited — waiting ${waitSeconds}s before retry...`);
                            updateProcessingUI(2, 3, `TPM error, waiting ${waitSeconds}s before retrying...`);
                            
                            
                                                        await new Promise(resolve => setTimeout(resolve, rateLimitMs));
                            
                            
                            
                            const systemMsg = messages[0];
                            const userMsg = messages.find((m: any) => m.role === 'user' && m.content === enhancedQuery);
                            if (systemMsg && userMsg) {
                                messages.length = 0;
                                messages.push(systemMsg);
                                messages.push(userMsg);
                                                            }
                            
                            
                            chunkIdx--;
                            continue;
                        }

                        
                        if (isTPMError && !isRateLimitError) {
                            setModelCooldown(this.settings.model, provider, rateLimitMs);
                            
                            
                            const systemMsg = messages[0];
                            const userMsg = messages.find((m: any) => m.role === 'user' && m.content === enhancedQuery);
                            if (systemMsg && userMsg && messages.length > 2) {
                                messages.length = 0;
                                messages.push(systemMsg);
                                messages.push(userMsg);
                                                                
                                
                                chunkIdx--;
                                continue;
                            }
                            
                            
                            if (chunk.length > 1 && chunkIdx < chunks.length - 1) {
                                                                continue;
                            }
                        }

                        
                        if (chunkIdx === chunks.length - 1) {
                            throw err;
                        }

                                            }
                }

                
                
                const modelTPMLimit = this.settings.customModels?.find(m => m.id === this.settings.model)?.tokenLimit || 8000;
                const synthBaseTokens = Math.ceil((systemPrompt.length + enhancedQuery.length) / 4);
                const toolResultsTokens = Math.ceil(finalContent.length / 4);
                const totalInputTokens = synthBaseTokens + toolResultsTokens;
                const estimatedOutputTokens = 2048;
                const totalEstimatedTokens = totalInputTokens + estimatedOutputTokens;

                
                if (totalEstimatedTokens > modelTPMLimit && finalContent.trim()) {
                    
                    
                    const MAX_CHUNK_TOKENS = Math.max(1500, Math.floor(modelTPMLimit * 0.4));
                    const resultChunks: string[] = [];
                    let currentChunk = '';
                    let currentTokens = 0;

                    
                    const resultSections = finalContent.split(/(?=### \w+)/);
                    for (const section of resultSections) {
                        const sectionTokens = Math.ceil(section.length / 4);
                        if (currentTokens + sectionTokens > MAX_CHUNK_TOKENS && currentChunk.length > 0) {
                            resultChunks.push(currentChunk);
                            currentChunk = '';
                            currentTokens = 0;
                        }
                        currentChunk += section;
                        currentTokens += sectionTokens;
                    }
                    if (currentChunk.length > 0) {
                        resultChunks.push(currentChunk);
                    }

                    
                    
                    const synthesizedAnswers: string[] = [];
                    for (let i = 0; i < resultChunks.length; i++) {
                        const isLast = i === resultChunks.length - 1;
                        const synthMessages = [
                            { role: 'system', content: systemPrompt },
                            {
                                role: 'user',
                                content: `The following tool results are from batch ${i + 1}/${resultChunks.length}:\n\n${resultChunks[i]}\n\n${isLast ? 'All tool results have been provided. Please synthesize a complete answer to the original question.' : 'Continue processing the remaining tool results.'}`
                            }
                        ];

                        try {
                            let synthResult: string;
                            if (provider === 'groq') {
                                const gs = new GroqService(this.settings.groqApiKey,
                                    (h) => this.rateLimitManager.updateFromHeaders('groq', this.settings.model, h));
                                synthResult = await gs.generateContent(this.settings.model, synthMessages as any[],
                                    { temperature: getModelTemperature(this.settings.model, this.settings), topP: getModelTopP(this.settings.model, this.settings) });
                            } else if (provider === 'gemini') {
                                const { GeminiService: GS } = await import('./geminiService');
                                const gs = new GS(this.settings.geminiApiKey || this.settings.apiKey,
                                    (h) => this.rateLimitManager.updateFromHeaders('gemini', this.settings.model, h));
                                const prompt = `${systemPrompt}\n\n${synthMessages[1].content}`;
                                const geminiResult = await gs.generateContentWithHeaders(this.settings.model, prompt,
                                    { temperature: getModelTemperature(this.settings.model, this.settings), maxOutputTokens: 8192, topP: getModelTopP(this.settings.model, this.settings) });
                                synthResult = geminiResult;
                            } else if (provider === 'openrouter') {
                                const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                                    method: 'POST',
                                    headers: { 'Authorization': `Bearer ${this.settings.openRouterApiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://obsidian.md', 'X-Title': 'Obsidian AI Tutor' },
                                    body: JSON.stringify({ model: this.settings.model, messages: synthMessages, temperature: getModelTemperature(this.settings.model, this.settings), max_tokens: 8192, top_p: getModelTopP(this.settings.model, this.settings), stream: false })
                                });
                                if (resp.ok) {
                                    const d = await resp.json();
                                    synthResult = d.choices?.[0]?.message?.content || '';
                                } else {
                                    throw new Error(`OpenRouter synthesis error: ${resp.status}`);
                                }
                            } else if (provider === 'ollama') {
                                const baseUrl = this.settings.ollamaBaseUrl || 'http://localhost:11434';
                                const resp = await fetch(`${baseUrl}/api/chat`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        model: this.settings.model,
                                        messages: synthMessages,
                                        stream: false,
                                        think: ollamaThinkOption,
                                        options: { temperature: getModelTemperature(this.settings.model, this.settings) }
                                    })
                                });
                                if (resp.ok) {
                                    const d = await resp.json();
                                    synthResult = d.message?.content || '';
                                } else {
                                    throw new Error(`Ollama synthesis error: ${resp.status}`);
                                }
                            } else if (provider === 'nvidia') {
                                const { NvidiaService: NS } = await import('./nvidiaService');
                                const ns = new NS(this.settings.nvidiaApiKey,
                                    (h) => this.rateLimitManager.updateFromHeaders('nvidia', this.settings.model, h));
                                synthResult = await ns.generateContent(this.settings.model, synthMessages as any[],
                                    { temperature: getModelTemperature(this.settings.model, this.settings), maxTokens: 8192, topP: getModelTopP(this.settings.model, this.settings) });
                            } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
                                const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
                                const response = await unifiedProvider.generateContent(
                                    this.settings.model,
                                    synthMessages as any[],
                                    {
                                        temperature: getModelTemperature(this.settings.model, this.settings),
                                        maxTokens: 8192,
                                        topP: getModelTopP(this.settings.model, this.settings)
                                    }
                                );
                                synthResult = response.text;
                            } else {
                                throw new Error(`Provider ${provider} not supported for synthesis`);
                            }

                            if (synthResult && synthResult.trim()) {
                                synthesizedAnswers.push(synthResult.trim());
                            }

                            
                            if (!isLast && i < resultChunks.length - 1) {
                                
                            }

                        } catch (synthErr) {
                            const errMsg = synthErr instanceof Error ? synthErr.message.toLowerCase() : String(synthErr);
                            const isRateLimit = errMsg.includes('rate limit') || errMsg.includes('429');
                            const isTPMError = isRateLimit || errMsg.includes('too large') || errMsg.includes('413') || errMsg.includes('payload') || errMsg.includes('token');

                            if (isRateLimit) {
                                
                                const waitMs = enableRateLimit ? rateLimitMs : 3000;
                                if (enableRateLimit) {
                                    updateSnippetUI(`Rate limited — waiting ${Math.ceil(waitMs / 1000)}s...`);
                                    updateProcessingUI(2, 3, `TPM error, waiting ${Math.ceil(waitMs / 1000)}s before retrying...`);
                                    await new Promise(resolve => setTimeout(resolve, waitMs));
                                }
                                i--; 
                            } else if (isTPMError) {
                                
                                                                updateProcessingUI(2, 3, `TPM error, skipping this chunk...`);
                                
                            } else {
                                                            }
                        }
                    }

                    
                    if (synthesizedAnswers.length > 0) {
                        finalContent = synthesizedAnswers.join('\n\n');
                                            } else if (finalContent.trim()) {
                        
                                            }
                }

                updateProcessingUI(3, 3, 'Complete!');
                updateSnippetUI('Response generated successfully');
                return {
                    answer: finalContent,
                    webResults,
                    totalTokens: finalTokens,
                    modelName: this.settings.model,
                    providerName: this.settings.provider
                };
            }
            

            updateProcessingUI(1, 2, 'Planning tool execution...');
            updateSnippetUI('Analysing query and available tools...');

            
            const toolNames = mcpTools.map((t: any) => t.function?.name).filter(Boolean);

            
            
            const toolDescriptions = (() => {
                if (serverGroups.size > 1) {
                    const lines: string[] = [];
                    for (const [srvName, srvTools] of serverGroups.entries()) {
                        if (srvTools.length === 0) continue;
                        lines.push(`### Server: ${srvName}`);
                        for (const t of srvTools) {
                            const n = (t as unknown as any).function?.name || 'unknown';
                            const d = (t as unknown as any).function?.description || 'No description';
                            lines.push(`- ${n}: ${d}`);
                        }
                    }
                    return lines.join('\n');
                }
                return mcpTools.map((t: any) => {
                    const name = t.function?.name || 'unknown';
                    const desc = t.function?.description || 'No description';
                    return `- ${name}: ${desc}`;
                }).join('\n');
            })();

            const toolListText = toolNames.length > 0
                ? (isAutoToolMode
                    ? `\n\n## Available Tools\n\nYou have access to the following ${toolNames.length} tool(s). Use ONLY the tools that are RELEVANT to answering the user's specific question:\n\n${toolDescriptions}\n\n**Think carefully:** Analyze the user's query and select the minimal subset of tools that will provide the needed information. Do NOT call tools unnecessarily.`
                    : `\n\n## Available Tools (User-Selected)\n\nYou have access to the following ${toolNames.length} tool(s). The user has EXPLICITLY selected these tools and expects you to use ALL of them:\n\n${toolDescriptions}\n\n**IMPORTANT: You MUST call EVERY tool listed above.** The user selected them intentionally for a reason. Do not skip any tool, even if you think it might not be relevant.`)
                : '';

            const systemPrompt = `You are a helpful AI assistant with access to MCP (Model Context Protocol) tools.${toolListText}

## Your Task

1. **Understand what the user is asking** - identify the key information needs
2. **Select the most appropriate tool(s)** based on the query${isAutoToolMode ? ' (if any)' : ''}
3. **Call the selected tool(s)** with appropriate parameters
4. **Analyze the results** and determine if additional tools are needed
5. **Synthesize a final answer** incorporating:
   - Tool call results
   - Any provided context files
   - Your general knowledge where relevant

## Guidelines

${isAutoToolMode
    ? `**Auto Mode (AI selects tools):**
- Carefully analyze which tools are actually needed for this specific query
- Start with the most likely useful tool(s)
- After receiving results, determine if more tools are needed
- NOT all tools need to be called — only those that contribute to answering the query
- If no tools are needed, respond based on your knowledge alone`
    : `**Manual Mode (User selected tools):**
- You MUST call every tool the user selected — do not skip any
- The user chose these tools intentionally for a purpose
- Call all tools even if some seem redundant — they may have complementary purposes`}

- Use exact tool names as defined in the tool specifications
- Provide all required parameters for each tool
- If a parameter is unclear, make a reasonable guess based on context
- If a tool returns an error, note it and continue with other tools if applicable
- After getting results, provide a well-structured, comprehensive answer
- NEVER fabricate tool results — use only actual responses

## Important Reminders

- Do NOT call tools for information you already know or that's irrelevant
- Do NOT call multiple tools simultaneously unless they are independent
- Do NOT keep calling the same tool repeatedly with different parameters unless necessary
- Prioritize quality of answer over quantity of tool calls
- Include specific details from tool results in your answer (don't summarize too broadly)

## Error Handling

- If a tool fails, explain the error to the user
- If all tools fail, provide your best answer using your own knowledge
- Partial tool results are still valuable — incorporate what worked

${mcpContext}`;

            
            const messages: any[] = [{ role: 'system', content: systemPrompt }];
            if (chatHistory.length > 0) {
                messages.push(...convertChatHistoryForGroq(chatHistory, this.settings.model, this.getContextWindowSize()));
            }
            if (this.settings.model === GROQ_VISION_MODEL) {
                const inlineInputs = multimodalInputs.filter(input => input.type === 'inline' && input.data);
                if (inlineInputs.length > 0) {
                    const contentParts: GroqContentPart[] = [{ type: 'text', text: enhancedQuery }];
                    for (const input of inlineInputs) {
                        contentParts.push({
                            type: 'image_url',
                            image_url: {
                                url: `data:${input.mimeType};base64,${input.data}`
                            }
                        });
                    }
                    messages.push({ role: 'user', content: contentParts });
                } else {
                    messages.push({ role: 'user', content: enhancedQuery });
                }
            } else {
                messages.push({ role: 'user', content: enhancedQuery });
            }

            
            
            
            
            
            let ledger: MCPExecutionLedger | null = null;

            const PLANNING_TOOL_LIMIT = 100;

            if (autoSelection !== null && toolNames.length > 0 && toolNames.length <= PLANNING_TOOL_LIMIT) {
                
                const planningModels = [
                    { provider: autoSelection.provider, modelId: autoSelection.modelId, modelName: autoSelection.modelName },
                    ...(autoSelection.fallbacks.length > 0 ? [autoSelection.fallbacks[0]] : [])
                ];
                
                let planCreated = false;

                for (let i = 0; i < planningModels.length; i++) {
                    const modelEntry = planningModels[i];
                    try {
                        const planningProvider = modelEntry.provider;
                        const planningModelId = modelEntry.modelId;

                        
                        
                        
                        const planningServerContext = serverGroups.size > 1
                            ? '\n\nSERVER GROUPINGS (for context — tool names must still be exact):\n' +
                              Array.from(serverGroups.entries())
                                  .filter(([, t]) => t.length > 0)
                                  .map(([srvName, srvTools]) =>
                                      `- Server "${srvName}": ${srvTools.map((t: any) => t.function?.name).filter(Boolean).join(', ')}`
                                  ).join('\n')
                            : '';

                        const planningPrompt = `You are a tool orchestration planner. Your job is to select the most relevant tools to answer the user's query.

TOOLS LIST: ${toolNames.join(', ')}${planningServerContext}

IMPORTANT: You DO NOT have direct access to these tools. You MUST NOT attempt to call them directly. 
Your ONLY valid action is to call the 'submit_tool_selection' tool with your selection of tool names from the list above. 

Be extremely selective and choose only the minimal set of tools needed. If no tools are needed, return an empty list via 'submit_tool_selection'.`;

                        const planningMessages = [
                            { role: 'system', content: planningPrompt },
                            { role: 'user', content: enhancedQuery }
                        ];

                        const selectionTool = {
                            type: 'function',
                            function: {
                                name: 'submit_tool_selection',
                                description: 'Submit the list of tool names selected to answer the user query.',
                                parameters: {
                                    type: 'object',
                                    properties: {
                                        selected_tools: {
                                            type: 'array',
                                            items: { 
                                                type: 'string',
                                                enum: toolNames
                                            },
                                            description: 'The exact names of the tools selected.'
                                        },
                                        rationale: {
                                            type: 'string',
                                            description: 'Brief reason for these selections.'
                                        }
                                    },
                                    required: ['selected_tools', 'rationale']
                                }
                            }
                        };

                        const planningTools = [selectionTool];
                        let extractedTools: string[] = [];

                        const planningExecCb = async (toolCalls: any[]) => {
                            if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
                            for (const tc of toolCalls) {
                                if (tc.function?.name === 'submit_tool_selection') {
                                    try {
                                        const args = typeof tc.function.arguments === 'string' 
                                            ? JSON.parse(tc.function.arguments) 
                                            : tc.function.arguments;
                                        if (args.selected_tools && Array.isArray(args.selected_tools)) {
                                            extractedTools = args.selected_tools;
                                        }
                                    } catch (e) {
                                                                            }
                                }
                            }
                            return toolCalls.map(() => ({ success: true, content: 'Selection received.' }));
                        };

                        const planningOptions: any = { temperature: 0.1, abortSignal };

                        if (planningProvider === 'groq') {
                            const gs = new GroqService(this.settings.groqApiKey,
                                (h: any) => this.rateLimitManager.updateFromHeaders('groq', planningModelId, h));
                            await gs.generateContentWithTools(planningModelId, planningMessages as any[], planningTools, { ...planningOptions, toolChoice: 'required' }, planningExecCb);
                        } else if (planningProvider === 'gemini') {
                            const gs = new GeminiService(this.settings.geminiApiKey || this.settings.apiKey,
                                (h: any) => this.rateLimitManager.updateFromHeaders('gemini', planningModelId, h));
                            await gs.generateContentWithTools(planningModelId, planningMessages, planningTools, { ...planningOptions, maxOutputTokens: 1024 }, planningExecCb);
                        } else if (planningProvider === 'openrouter') {
                            const ors = new OpenRouterService(this.settings.openRouterApiKey,
                                (h: any) => this.rateLimitManager.updateFromHeaders('openrouter', planningModelId, h));
                            await ors.generateContentWithTools(planningModelId, planningMessages as any[], planningTools, { ...planningOptions, toolChoice: 'required' }, planningExecCb);
                        } else if (planningProvider === 'ollama') {
                            const os = new OllamaService(this.settings.ollamaBaseUrl || 'http://localhost:11434', this.settings.ollamaApiKey,
                                (h: any) => this.rateLimitManager.updateFromHeaders('ollama', planningModelId, h));
                            await os.generateContentWithTools(planningModelId, planningMessages as any[], planningTools, planningOptions, planningExecCb);
                        } else if (UnifiedProviderManager.getInstance().hasProvider(planningProvider)) {
                            const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(planningProvider)!;
                            if (unifiedProvider.generateContentWithTools) {
                                await unifiedProvider.generateContentWithTools(planningModelId, planningMessages as any[], planningTools, planningOptions, planningExecCb);
                            }
                        }

                        
                        const plannedNames = extractedTools.map(selected => {
                            if (toolNames.includes(selected)) return selected;
                            return toolNames.find(tn => tn.endsWith(`__${selected}`)) || selected;
                        }).filter(tn => toolNames.includes(tn));
                        
                        const filteredTools = mcpTools.filter((t: any) => plannedNames.includes(t.function?.name));
                        const plan = buildFallbackPlan(enhancedQuery, filteredTools);
                        ledger = createLedger(plan);
                                                planCreated = true;
                        break; 
                        
                    } catch (planErr) {
                                                
                    }
                }
                
                if (!planCreated) {
                                    }
            } else if (toolNames.length > PLANNING_TOOL_LIMIT) {
                            }

            
            if (!ledger) {
                const fallbackPlan = buildFallbackPlan(enhancedQuery, mcpTools);
                ledger = createLedger(fallbackPlan);
                            }

            
            
            
            
            
            
            
            
            updateProcessingUI(1, 2, 'Executing tools...');

            
            const toolPassModels: Array<{ provider: Provider; modelId: string; modelName: string }> = [];
            if (autoSelection !== null) {
                
                toolPassModels.push({
                    provider: autoSelection.provider,
                    modelId: autoSelection.modelId,
                    modelName: autoSelection.modelName
                });
                toolPassModels.push(...autoSelection.fallbacks);
            }
            if (toolPassModels.length === 0) {
                toolPassModels.push({ provider: this.settings.provider, modelId: this.settings.model, modelName: this.settings.model });
            }

            
            
            const estimateToolTokens = (tool: any): number => {
                try { return Math.ceil(JSON.stringify(tool).length / 4); } catch { return 300; }
            };

            
            
            const chunkTools = (tools: any[], modelTPM: number): any[][] => {
                
                const budget = Math.max(2000, Math.floor(modelTPM * 0.5));
                const chunks: any[][] = [];
                let current: any[] = [];
                let currentTokens = 0;
                for (const tool of tools) {
                    const t = estimateToolTokens(tool);
                    if (current.length > 0 && currentTokens + t > budget) {
                        chunks.push(current);
                        current = [];
                        currentTokens = 0;
                    }
                    current.push(tool);
                    currentTokens += t;
                }
                if (current.length > 0) chunks.push(current);
                return chunks.length > 0 ? chunks : [tools];
            };

            
            
            
            
            
            const MODEL_COOLDOWN_MS = 35_000; 
            const modelCooldownUntil: Map<string, number> = new Map();

            const isModelOnCooldown = (mId: string, p: string): boolean => {
                const key = `${mId}:${p}`;
                const until = modelCooldownUntil.get(key);
                return until !== undefined && Date.now() < until;
            };

            const setModelCooldown = (mId: string, p: string): void => {
                const key = `${mId}:${p}`;
                modelCooldownUntil.set(key, Date.now() + MODEL_COOLDOWN_MS);
                            };

            
            
            
            
            let passAbandoned = false;

            
            
            
            
            

            
            const executeToolsViaModel = async (toolCalls: any[], passLabel: string) => {
                const results = new Array(toolCalls.length);
                const promises = toolCalls.map(async (toolCall, i) => {
                    if (passAbandoned) {
                        results[i] = { success: false, content: '', error: 'Pass abandoned' };
                        return;
                    }

                    const toolName = toolCall.function?.name || toolCall.name || 'unknown';
                    const label = `[${passLabel}] ${toolName}`;
                    try {
                        if (!passAbandoned) {
                            updateSnippetUI(`Executing ${label}...`);
                            const completedCount = ledger!.plan.steps.filter(s => s.status === 'completed').length;
                            
                            const mcpTotalSteps = 1 + ledger!.plan.steps.length + 1;
                            updateProcessingUI(1 + completedCount, mcpTotalSteps, `Running: ${toolName}`);
                        }
                        const result = await executeToolCallback(toolCall);
                        if (passAbandoned) {
                            results[i] = { success: false, content: '', error: 'Pass abandoned' };
                            return;
                        }
                        const snippet = result?.content || (result?.error ? `Error: ${result.error}` : '(no output)');
                        updateSnippetUI(`✓ ${label}`, snippet);

                        
                        const existingStep = ledger!.plan.steps.find(
                            s => s.toolName === toolName && s.status === 'pending'
                        );
                        if (existingStep) {
                            existingStep.status = 'completed';
                            existingStep.result = result?.content || snippet;
                            ledger!.completedSteps.push(existingStep.stepId);
                        } else {
                            const dynId = `dyn_${toolName}_${Date.now()}_${i}`;
                            const dynStep = {
                                stepId: dynId,
                                toolName,
                                arguments: toolCall.function?.arguments
                                    ? (typeof toolCall.function.arguments === 'string'
                                        ? (() => { try { return JSON.parse(toolCall.function.arguments); } catch { return {}; } })()
                                        : toolCall.function.arguments)
                                    : {},
                                dependsOn: [],
                                rationale: `model-driven (${passLabel})`,
                                status: 'completed' as const,
                                result: result?.content || snippet,
                                retryCount: 0,
                                maxRetries: 2
                            };
                            ledger!.plan.steps.push(dynStep);
                            ledger!.completedSteps.push(dynId);
                        }
                        results[i] = result;
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        if (!passAbandoned) updateSnippetUI(`✗ ${label}`, errMsg);
                        results[i] = { success: false, content: '', error: errMsg };
                    }
                });

                await Promise.all(promises);
                return results;
            };

            
            
            
            
            
            
            const invokeToolsOnModel = async (
                modelId: string,
                provider: string,
                passTools: any[],
                passLabel: string,
                toolChoice: 'auto' | 'required' | 'none',
                signal?: AbortSignal
            ): Promise<{ content: string; totalTokens?: number }> => {
                const execCb = (toolCalls: any[]) => executeToolsViaModel(toolCalls, passLabel);

                const effectiveSignal = signal || abortSignal;

                
                const passToolNames = passTools.map((t: any) => t.function?.name).filter(Boolean);
                const passToolListText = passToolNames.length > 0
                    ? (isAutoToolMode
                        ? `\n\nYou have ${passToolNames.length} tool(s) available for this step: ${passToolNames.join(', ')}.\n\nOnly call tools from this list.`
                        : `\n\nUse the following ${passToolNames.length} tool(s): ${passToolNames.join(', ')}.\n\nOnly call tools from this list.`)
                    : '';
                const passSystemPrompt = `You are a helpful AI assistant with access to MCP (Model Context Protocol) tools.${passToolListText}

Rules:
${isAutoToolMode
    ? '- Call the tools that are relevant to answering the user\'s question.\n- Only use tools listed above.\n- After receiving tool results, you may either (a) provide a complete final answer, or (b) acknowledge that the results have been received. A separate synthesis pass will only run if you do not provide a final answer.'
    : '- You MUST call every tool listed above.\n- Only call tools from the list above — do not call any other tools.\n- After receiving tool results, you may either (a) provide a complete final answer, or (b) acknowledge that the results have been received.'
}

CRITICAL: The user CANNOT see the tool execution results. If you provide a final answer, you MUST embed all relevant information, including full URLs, markdown images (e.g., ![Title](url)), and data points directly into your answer. Do NOT use placeholders, and do NOT refer the user to "the tool results".

- When context files are provided, incorporate them into your answer.

${mcpContext}`;

                
                const passMessages: any[] = [{ role: 'system', content: passSystemPrompt }];
                if (chatHistory.length > 0) {
                    passMessages.push(...convertChatHistoryForGroq(chatHistory, modelId, this.getContextWindowSize()));
                }
                
                if (modelId === GROQ_VISION_MODEL) {
                    const inlineInputs = multimodalInputs.filter(input => input.type === 'inline' && input.data);
                    if (inlineInputs.length > 0) {
                        const contentParts: GroqContentPart[] = [{ type: 'text', text: enhancedQuery }];
                        for (const input of inlineInputs) {
                            contentParts.push({
                                type: 'image_url',
                                image_url: {
                                    url: `data:${input.mimeType};base64,${input.data}`
                                }
                            });
                        }
                        passMessages.push({ role: 'user', content: contentParts });
                    } else {
                        passMessages.push({ role: 'user', content: enhancedQuery });
                    }
                } else {
                    passMessages.push({ role: 'user', content: enhancedQuery });
                }

                
                
                
                const allCompletedSteps = ledger!.plan.steps.filter(step => step.status === 'completed');

                if (allCompletedSteps.length > 0) {
                    
                    
                    
                    
                    
                    
                    for (let i = 0; i < allCompletedSteps.length; i++) {
                        const step = allCompletedSteps[i];
                        const callId = `resumed_${step.stepId}_${i}`;

                        
                        passMessages.push({
                            role: 'assistant',
                            content: '',
                            tool_calls: [{
                                id: callId,
                                type: 'function',
                                function: {
                                    name: step.toolName,
                                    arguments: JSON.stringify(step.arguments || {})
                                }
                            }]
                        });

                        
                        passMessages.push({
                            role: 'tool',
                            tool_call_id: callId,
                            name: step.toolName,
                            content: step.result || '(no output)'
                        });
                    }

                    
                    const completedToolNames = new Set(allCompletedSteps.map(s => s.toolName));
                    const remainingInChunk = passToolNames.filter(name => !completedToolNames.has(name));

                    if (remainingInChunk.length === 0) {
                        
                        passMessages.push({
                            role: 'user',
                            content: 'All tools in this batch have already been executed and their results are shown above. Do not call any more tools and do not provide a final answer yet. Simply acknowledge that the results have been received.'
                        });
                        toolChoice = 'none';
                    } else {
                        passMessages.push({
                            role: 'user',
                            content: `The tools above have already been executed. You still need to call: ${remainingInChunk.join(', ')}. Do not provide a final answer yet.`
                        });
                    }

                                    }

                if (provider === 'groq') {
                    const gs = new GroqService(this.settings.groqApiKey,
                        (h) => this.rateLimitManager.updateFromHeaders('groq', modelId, h));
                    return gs.generateContentWithTools(modelId, passMessages as any[], passTools,
                        { temperature: getModelTemperature(modelId, this.settings), topP: getModelTopP(modelId, this.settings), toolChoice, abortSignal: effectiveSignal },
                        execCb);
                } else if (provider === 'gemini') {
                    const { GeminiService: GS } = await import('./geminiService');
                    const gs = new GS(this.settings.geminiApiKey || this.settings.apiKey,
                        (h) => this.rateLimitManager.updateFromHeaders('gemini', modelId, h));
                    return gs.generateContentWithTools(modelId, passMessages, passTools,
                        {
                            temperature: getModelTemperature(modelId, this.settings),
                            maxOutputTokens: 8192,
                            topP: getModelTopP(modelId, this.settings),
                            thinkingConfig: getGeminiThinkingConfig(modelId, this.settings)?.thinkingConfig,
                            abortSignal: effectiveSignal
                        },
                        execCb);
                } else if (provider === 'openrouter') {
                    const { OpenRouterService: ORS } = await import('./openRouterService');
                    const ors = new ORS(this.settings.openRouterApiKey,
                        (h) => this.rateLimitManager.updateFromHeaders('openrouter', modelId, h));
                    return ors.generateContentWithTools(modelId, passMessages as any[], passTools,
                        { temperature: getModelTemperature(modelId, this.settings), topP: getModelTopP(modelId, this.settings), toolChoice, abortSignal: effectiveSignal },
                        execCb);
                } else if (provider === 'ollama') {
                    const { OllamaService: OS } = await import('./ollamaService');
                    const os = new OS(this.settings.ollamaBaseUrl || 'http://localhost:11434', this.settings.ollamaApiKey,
                        (h) => this.rateLimitManager.updateFromHeaders('ollama', modelId, h));
                    const useReqUrl = this.settings.ollamaMode === 'cloud' ? requestUrl : undefined;
                    
                    
                    
                    const ollamaMessages = passMessages.map((m: any) => {
                        if (m.role === 'assistant' && m.tool_calls) {
                            return {
                                role: 'assistant',
                                content: m.content || '',
                                tool_calls: m.tool_calls.map((tc: any, idx: number) => ({
                                    type: 'function',
                                    function: {
                                        index: idx,
                                        name: tc.function?.name || tc.name,
                                        arguments: (() => {
                                            try {
                                                return typeof tc.function?.arguments === 'string'
                                                    ? JSON.parse(tc.function.arguments)
                                                    : (tc.function?.arguments || {});
                                            } catch { return {}; }
                                        })()
                                    }
                                }))
                            };
                        }
                        if (m.role === 'tool') {
                            return {
                                role: 'tool',
                                tool_name: m.name || m.tool_name || 'tool',
                                content: m.content || ''
                            };
                        }
                        return m;
                    });
                    return os.generateContentWithTools(modelId, ollamaMessages as any[], passTools,
                        { temperature: getModelTemperature(modelId, this.settings), abortSignal: effectiveSignal },
                        execCb, useReqUrl);
                } else if (provider === 'nvidia') {
                    const { NvidiaService: NS } = await import('./nvidiaService');
                    const ns = new NS(this.settings.nvidiaApiKey,
                        (h) => this.rateLimitManager.updateFromHeaders('nvidia', modelId, h));
                    return ns.generateContentWithTools(modelId, passMessages as any[], passTools,
                        { temperature: getModelTemperature(modelId, this.settings), maxTokens: 8192, topP: getModelTopP(modelId, this.settings), toolChoice, abortSignal: effectiveSignal },
                        execCb);
                } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
                    const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
                    if (unifiedProvider.generateContentWithTools) {
                        return unifiedProvider.generateContentWithTools(
                            modelId,
                            passMessages as any[],
                            passTools,
                            {
                                temperature: getModelTemperature(modelId, this.settings),
                                maxTokens: 8192,
                                topP: getModelTopP(modelId, this.settings),
                                toolChoice,
                                abortSignal: effectiveSignal
                            },
                            execCb,
                            (thinking) => updateSnippetUI('Thinking...', thinking)
                        );
                    } else {
                        throw new Error(`Provider ${provider} does not support tool calling (required for MCP)`);
                    }
                }
                throw new Error(`Provider ${provider} not supported for tool calling`);
            };

            
            
            
            
            
            const runToolPass = async (
                passTools: any[],
                passLabel: string,
                toolChoice: 'auto' | 'required' | 'none'
            ): Promise<{ content: string; totalTokens?: number; isFinalAnswer: boolean } | null> => {

                for (let mi = 0; mi < toolPassModels.length; mi++) {
                    if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
                    const modelEntry = toolPassModels[mi];
                    const provider = modelEntry.provider;

                    
                    
                    if (isModelOnCooldown(modelEntry.modelId, provider)) {
                        
                        const hasNonCooled = toolPassModels.slice(mi + 1).some(
                            m => !isModelOnCooldown(m.modelId, m.provider)
                        );
                        if (hasNonCooled) {
                                                        continue;
                        }
                        
                        const waitMs = Math.min(
                            ...toolPassModels.slice(mi).map(m => {
                                const key = `${m.modelId}:${m.provider}`;
                                const until = modelCooldownUntil.get(key) || 0;
                                return Math.max(0, until - Date.now());
                            })
                        );
                        if (waitMs > 0) {
                                                        updateSnippetUI(`Rate limited — waiting ${Math.ceil(waitMs / 1000)}s for cooldown...`);
                            updateProcessingUI(1, 2, `TPM error, waiting ${Math.ceil(waitMs / 1000)}s before retrying...`);
                            await new Promise(resolve => setTimeout(resolve, waitMs));
                        }
                    }

                    const allPlannedStepsCompleted = ledger!.plan.steps.length > 0 && ledger!.plan.steps.every(s => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped');
                    if (allPlannedStepsCompleted) {
                                                
                        
                        return { content: 'All tools completed', isFinalAnswer: false };
                    }
                    const remainingTools = passTools; 

                    const modelTPM = this.settings.customModels.find(m => m.id === modelEntry.modelId && m.provider === provider)?.tokenLimit || 8000;

                    
                    this.settings.provider = modelEntry.provider;
                    this.settings.model = modelEntry.modelId;

                    
                    passAbandoned = false;

                    
                    
                    const chunks = isAutoToolMode ? [remainingTools] : chunkTools(remainingTools, modelTPM);
                    const isChunked = chunks.length > 1;

                    if (isChunked) {
                                            }

                    let lastChunkResult: { content: string; totalTokens?: number } | null = null;
                    let chunkFailed = false;

                    for (let ci = 0; ci < chunks.length; ci++) {
                        const chunk = chunks[ci];
                        const chunkLabel = isChunked ? `${passLabel} [batch ${ci + 1}/${chunks.length}]` : passLabel;
                        try {
                            updateSnippetUI(isChunked ? `Querying ${passLabel} (batch ${ci + 1}/${chunks.length})...` : `Querying ${passLabel}...`);
                            
                            
                            const passTimeoutMs = getTimeoutForTask(TaskType.MCP_TOOL_CALLING, mi > 0);
                            
                            const result = await withTimeout(
                                (signal) => invokeToolsOnModel(modelEntry.modelId, provider, chunk, chunkLabel, toolChoice, signal),
                                passTimeoutMs
                            );
                            lastChunkResult = result;
                        } catch (err) {
                            if (err instanceof DOMException && err.name === 'AbortError') {
                                throw err;
                            }
                            const errMsg = err instanceof Error ? err.message : String(err);
                            const errLower = errMsg.toLowerCase();

                            const isRateLimit = errLower.includes('rate limit') || errLower.includes('429');
                            const isPayloadTooLarge = errLower.includes('too large') || errLower.includes('413') || errLower.includes('payload');
                            const isTPMError = isRateLimit || isPayloadTooLarge || errLower.includes('token');
                            
                            
                            const isUnsupported = errLower.includes('not supported') || errLower.includes('no tools') || errLower.includes('tool calling');

                            
                            
                            const isHardError = errMsg.includes('__MCP_TIMEOUT__') || isUnsupported ||
                                                errLower.includes('no endpoints') || errLower.includes('model not found') ||
                                                errLower.includes('not found') || errLower.includes('404') ||
                                                errLower.includes('503') || errLower.includes('unavailable') ||
                                                errLower.includes('unauthorized') || errLower.includes('401') ||
                                                errLower.includes('invalid api key') || errLower.includes('api key not valid') ||
                                                errLower.includes('tool call validation') || errLower.includes('not in request') ||
                                                errLower.includes('did not match schema') || errLower.includes('missing properties');
                            const isAuthError = errLower.includes('401') || errLower.includes('unauthorized') ||
                                                errLower.includes('invalid api key') || errLower.includes('api key not valid');
                            
                            
                            
                            
                            
                            const shouldEscalate = isTPMError || isHardError;

                            
                            
                            
                            if (isRateLimit || isAuthError) {
                                setModelCooldown(modelEntry.modelId, provider);
                            }

                            if (shouldEscalate && mi < toolPassModels.length - 1) {
                                
                                passAbandoned = true;

                                
                                if (isPayloadTooLarge) {
                                    const currentTPM = modelTPM;
                                    let nextMi = mi + 1;
                                    while (nextMi < toolPassModels.length) {
                                        const nextModel = toolPassModels[nextMi];
                                        const nextTPM = this.settings.customModels.find(m => m.id === nextModel.modelId && m.provider === nextModel.provider)?.tokenLimit || 0;
                                        if (nextTPM > currentTPM || nextModel.provider !== provider) {
                                            break;
                                        }
                                                                                nextMi++;
                                    }
                                    mi = nextMi - 1; 
                                }

                                                                chunkFailed = true;
                                break;
                            }
                            
                            passAbandoned = true;
                            chunkFailed = true;
                            break;
                        }
                    }

                    if (!chunkFailed && lastChunkResult) {
                        
                        const content = lastChunkResult.content || '';
                        return {
                            content,
                            totalTokens: lastChunkResult.totalTokens,
                            isFinalAnswer: looksLikeFinalAnswer(content),
                        };
                    }

                    
                    if (mi === toolPassModels.length - 1) {
                                                return null;
                    }
                    
                }

                return null;
            };

            
            
            
            
            const plannedStepToolNames = ledger?.plan?.steps?.map((s: any) => s.toolName) || [];
            const serverEntries = Array.from(serverGroups.entries())
                .filter(([, tools]) => tools.length > 0)
                .sort((a, b) => {
                    if (plannedStepToolNames.length === 0) return 0;
                    const firstIndexOf = ([, tools]: [string, any[]]) => {
                        let minIdx = Infinity;
                        for (const t of tools) {
                            const name = t.function?.name;
                            if (!name) continue;
                            const idx = plannedStepToolNames.indexOf(name);
                            if (idx !== -1 && idx < minIdx) minIdx = idx;
                        }
                        return minIdx === Infinity ? plannedStepToolNames.length : minIdx;
                    };
                    return firstIndexOf(a) - firstIndexOf(b);
                });
            const isMultiServer = serverEntries.length > 1;
            const toolChoiceForMode: 'auto' | 'required' = isAutoToolMode ? 'auto' : 'required';

            
            const plannedToolNames = ledger?.plan?.steps?.map(s => s.toolName) || [];
            const filterToolsByPlan = (tools: any[]): any[] => {
                if (plannedToolNames.length === 0) {
                    
                    return tools;
                }
                return tools.filter((t: any) => {
                    const toolName = t.function?.name;
                    if (toolName && (toolName.includes('thinking') || toolName.includes('thought') || toolName === 'submit_tool_selection')) {
                        return true;
                    }
                    return plannedToolNames.includes(toolName);
                });
            };

            let lastPassResult: { content: string; totalTokens?: number; isFinalAnswer: boolean } | null = null;
            let earlyReturnedFromToolPass = false;

            
            
            
            const buildEarlyReturnFromToolPass = (passResult: { content: string; totalTokens?: number }) => ({
                answer: passResult.content,
                webResults,
                totalTokens: passResult.totalTokens,
                modelName: toolPassModels[0]?.modelName || this.settings.model,
                providerName: toolPassModels[0]?.provider || this.settings.provider,
            });

            if (isMultiServer) {
                
                                const allServerResults: string[] = [];

                for (const [serverName, serverTools] of serverEntries) {
                    
                    const filteredTools = filterToolsByPlan(serverTools);
                    if (filteredTools.length === 0) {
                                                continue;
                    }
                                        updateSnippetUI(`Querying ${serverName}...`);

                    
                    try {
                        const passResult = await runToolPass(filteredTools, serverName, 'required');
                        if (passResult) {
                            lastPassResult = passResult;
                            allServerResults.push(`## ${serverName}\n\n${passResult.content}`);

                            
                            
                            if (passResult.isFinalAnswer) {
                                                                updateProcessingUI(2, 2, 'Complete!');
                                updateSnippetUI('Response generated successfully');
                                earlyReturnedFromToolPass = true;
                                return buildEarlyReturnFromToolPass(passResult);
                            }
                        }
                    } catch (serverErr) {
                        
                        const errMsg = serverErr instanceof Error ? serverErr.message : String(serverErr);
                                                allServerResults.push(`## ${serverName}\n\nError: ${errMsg}`);
                    }
                }

                
                if (allServerResults.length > 0 && lastPassResult) {
                    lastPassResult.content = allServerResults.join('\n\n');
                }
            } else {
                
                const filteredTools = filterToolsByPlan(mcpTools);
                                lastPassResult = await runToolPass(filteredTools, 'tools', toolChoiceForMode);

                if (!lastPassResult) {
                    
                    
                    
                    const completedCount = ledger!.completedSteps.length;
                    if (completedCount > 0) {
                                                
                    } else {
                        
                                                return await this.process(query, enhancedQuery, mcpContext, chatHistory, false, updateProcessingUI, false, updateSnippetUI, [], '');
                    }
                } else if (lastPassResult.isFinalAnswer) {
                    
                    
                                        updateProcessingUI(2, 2, 'Complete!');
                    updateSnippetUI('Response generated successfully');
                    earlyReturnedFromToolPass = true;
                    return buildEarlyReturnFromToolPass(lastPassResult);
                } else {
                    
                    
                                    }
            }

            
            
            
            
            
            if (earlyReturnedFromToolPass) {
                throw new Error('MCP Query: unreachable — early return from tool pass should have exited');
            }

            
            

            
            const streamProviderForSynthesis = async (
                provider: string,
                modelId: string,
                msgs: any[],
                onToken: (token: string) => void,
                onThinking?: (thinking: string) => void,
                signal?: AbortSignal
            ): Promise<{ content: string; totalTokens?: number }> => {
                let responseText = '';
                const effectiveSignal = signal || abortSignal;
                if (provider === 'groq') {
                    const groqService = new GroqService(
                        this.settings.groqApiKey,
                        (headers) => this.rateLimitManager.updateFromHeaders('groq', modelId, headers)
                    );
                    const groqThinkingLevel = modelId.toLowerCase().includes('gpt-oss') ? (this.settings.groqThinkingLevel || 'medium') : undefined;
                    if (groqThinkingLevel) {
                        let contentBuffer = '';
                        await groqService.generateContentStreamEvents(
                            modelId,
                            msgs as any[],
                            (evt: any) => {
                                if (evt.type === 'thinking') {
                                    if (onThinking) onThinking(evt.text);
                                } else if (evt.type === 'content') {
                                    contentBuffer += evt.text;
                                    onToken(evt.text);
                                }
                            },
                            {
                                temperature: getModelTemperature(modelId, this.settings),
                                topP: getModelTopP(modelId, this.settings),
                                thinkingLevel: groqThinkingLevel,
                                abortSignal
                            }
                        );
                        responseText = contentBuffer;
                    } else {
                        responseText = await groqService.generateContentStream(
                            modelId,
                            msgs as any[],
                            {
                                temperature: getModelTemperature(modelId, this.settings),
                                topP: getModelTopP(modelId, this.settings),
                                abortSignal
                            },
                            (chunk: string) => {
                                responseText += chunk;
                                onToken(chunk);
                            }
                        );
                    }
                    return { content: responseText };
                } else if (provider === 'gemini') {
                    const { GeminiService } = await import('./geminiService');
                    const geminiService = new GeminiService(
                        this.settings.geminiApiKey || this.settings.apiKey,
                        (headers) => this.rateLimitManager.updateFromHeaders('gemini', modelId, headers)
                    );
                    const sysMsg  = msgs.find((m: any) => m.role === 'system');
                    const userMsg = msgs.find((m: any) => m.role === 'user');
                    const prompt  = `${sysMsg ? sysMsg.content + '\n\n' : ''}${userMsg?.content || ''}`;

                    const geminiModel = geminiService.getGenerativeModel({
                        model: modelId,
                        generationConfig: {
                            temperature: getModelTemperature(modelId, this.settings),
                            maxOutputTokens: 8192,
                            topP: getModelTopP(modelId, this.settings)
                        }
                    });
                    const streamResult = await geminiModel.generateContentStream(prompt);
                    for await (const chunk of streamResult.stream) {
                        const candidate = chunk.candidates?.[0];
                        if (candidate) {
                            const chunkText = this.processGeminiStreamingCandidate(candidate, (label, val) => {
                                if (label === 'Thinking...' && onThinking) {
                                    onThinking(val || '');
                                } else if (label === 'Generating response...' && onToken) {
                                    onToken(val || '');
                                }
                            });
                            responseText += chunkText;
                        }
                    }
                    const finalResponse = await streamResult.response;
                    if (finalResponse.candidates && finalResponse.candidates.length > 0) {
                        const candidate = finalResponse.candidates[0];
                        if (candidate.groundingMetadata) {
                            responseText = this.addCitations(responseText, candidate.groundingMetadata);
                        }
                    }
                    return { content: responseText };
                } else if (provider === 'openrouter') {
                    const { OpenRouterService } = await import('./openRouterService');
                    const openRouterService = new OpenRouterService(
                        this.settings.openRouterApiKey,
                        (headers) => this.rateLimitManager.updateFromHeaders('openrouter', modelId, headers)
                    );
                    responseText = await openRouterService.generateContentStream(
                        modelId,
                        msgs as any[],
                        {
                            temperature: getModelTemperature(modelId, this.settings),
                            maxTokens: 8192,
                            topP: getModelTopP(modelId, this.settings),
                            abortSignal: effectiveSignal
                        },
                        (chunk: string) => {
                            responseText += chunk;
                            onToken(chunk);
                        },
                        (thinking: string) => {
                            if (onThinking) onThinking(thinking);
                        }
                    );
                    return { content: responseText };
                } else if (provider === 'ollama') {
                    const { OllamaService } = await import('./ollamaService');
                    const ollamaService = new OllamaService(
                        this.settings.ollamaBaseUrl || 'http://localhost:11434',
                        this.settings.ollamaApiKey,
                        (headers) => this.rateLimitManager.updateFromHeaders('ollama', modelId, headers)
                    );
                    let contentBuffer = '';
                    await ollamaService.generateContentStreamEvents(
                        modelId,
                        msgs as any[],
                        (evt: any) => {
                            if (evt.type === 'thinking') {
                                if (onThinking) onThinking(evt.text);
                            } else if (evt.type === 'content') {
                                contentBuffer += evt.text;
                                onToken(evt.text);
                            }
                        },
                        {
                            temperature: getModelTemperature(modelId, this.settings),
                            maxTokens: 8192,
                            topP: getModelTopP(modelId, this.settings),
                            think: ollamaThinkOption,
                            abortSignal: effectiveSignal
                        }
                    );
                    responseText = contentBuffer;
                    return { content: responseText };
                } else if (provider === 'nvidia') {
                    const { NvidiaService } = await import('./nvidiaService');
                    const nvidiaService = new NvidiaService(
                        this.settings.nvidiaApiKey,
                        (headers) => this.rateLimitManager.updateFromHeaders('nvidia', modelId, headers)
                    );
                    responseText = await nvidiaService.generateContentStream(
                        modelId,
                        msgs,
                        {
                            temperature: getModelTemperature(modelId, this.settings),
                            maxTokens: 8192,
                            topP: getModelTopP(modelId, this.settings),
                            abortSignal: effectiveSignal
                        },
                        (chunk: string) => {
                            responseText += chunk;
                            onToken(chunk);
                        },
                        (thinking: string) => {
                            if (onThinking) onThinking(thinking);
                        }
                    );
                    return { content: responseText };
                } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
                    const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
                    if (unifiedProvider.streamContent) {
                        const response = await unifiedProvider.streamContent(
                            modelId,
                            msgs as any[],
                            (chunk: string) => {
                                responseText += chunk;
                                onToken(chunk);
                            },
                            {
                                temperature: getModelTemperature(modelId, this.settings),
                                topP: getModelTopP(modelId, this.settings),
                                maxTokens: 8192,
                                abortSignal: effectiveSignal
                            },
                            (thinking: string) => {
                                if (onThinking) onThinking(thinking);
                            }
                        );
                        if (!responseText && response.text) responseText = response.text;
                        return { content: responseText, totalTokens: response.usage?.totalTokens };
                    } else {
                        const response = await unifiedProvider.generateContent(
                            modelId,
                            msgs as any[],
                            {
                                temperature: getModelTemperature(modelId, this.settings),
                                topP: getModelTopP(modelId, this.settings),
                                maxTokens: 8192,
                                abortSignal: effectiveSignal
                            }
                        );
                        responseText = response.text;
                        onToken(responseText);
                        return { content: responseText, totalTokens: response.usage?.totalTokens };
                    }
                } else {
                    throw new Error(`Provider ${provider} not supported for streaming synthesis`);
                }
            };

            
            
            
            
            
            

            
            
            
            const synthesizeChunkOnProvider = async (
                chunkProvider: string,
                chunkModelId: string,
                chunkSystemPrompt: string,
                synthMessages: any[]
            ): Promise<string> => {
                if (chunkProvider === 'groq') {
                    const gs = new GroqService(this.settings.groqApiKey,
                        (h) => this.rateLimitManager.updateFromHeaders('groq', chunkModelId, h));
                    return await gs.generateContent(chunkModelId, synthMessages as any[],
                        { temperature: getModelTemperature(chunkModelId, this.settings), topP: getModelTopP(chunkModelId, this.settings) });
                } else if (chunkProvider === 'gemini') {
                    const { GeminiService: GS } = await import('./geminiService');
                    const gs = new GS(this.settings.geminiApiKey || this.settings.apiKey,
                        (h) => this.rateLimitManager.updateFromHeaders('gemini', chunkModelId, h));
                    return await gs.generateContentWithHeaders(chunkModelId,
                        `${chunkSystemPrompt}\n\n${synthMessages[1].content}`,
                        { temperature: getModelTemperature(chunkModelId, this.settings), maxOutputTokens: 8192, topP: getModelTopP(chunkModelId, this.settings) });
                } else if (chunkProvider === 'openrouter') {
                    const ors = new OpenRouterService(this.settings.openRouterApiKey,
                        (h) => this.rateLimitManager.updateFromHeaders('openrouter', chunkModelId, h));
                    return await ors.generateContent(chunkModelId, synthMessages as any[],
                        { temperature: getModelTemperature(chunkModelId, this.settings), topP: getModelTopP(chunkModelId, this.settings), maxTokens: 8192 });
                } else if (chunkProvider === 'ollama') {
                    const os = new OllamaService(this.settings.ollamaBaseUrl || 'http://localhost:11434', this.settings.ollamaApiKey,
                        (h) => this.rateLimitManager.updateFromHeaders('ollama', chunkModelId, h));
                    return await os.generateContent(chunkModelId, synthMessages as any[],
                        { temperature: getModelTemperature(chunkModelId, this.settings) });
                } else if (chunkProvider === 'nvidia') {
                    const ns = new NvidiaService(this.settings.nvidiaApiKey,
                        (h) => this.rateLimitManager.updateFromHeaders('nvidia', chunkModelId, h));
                    return await ns.generateContent(chunkModelId, synthMessages as any[],
                        { temperature: getModelTemperature(chunkModelId, this.settings), maxTokens: 8192, topP: getModelTopP(chunkModelId, this.settings) });
                } else if (UnifiedProviderManager.getInstance().hasProvider(chunkProvider)) {
                    const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(chunkProvider)!;
                    const response = await unifiedProvider.generateContent(
                        chunkModelId,
                        synthMessages as any[],
                        {
                            temperature: getModelTemperature(chunkModelId, this.settings),
                            topP: getModelTopP(chunkModelId, this.settings),
                            maxTokens: 8192
                        }
                    );
                    return response.text;
                } else {
                    
                    throw new Error(`__MCP_UNKNOWN_PROVIDER__:${chunkProvider}`);
                }
            };

            const synthesizeWithChunking = async (
                chunkLedger: MCPExecutionLedger,
                chunkQuery: string,
                chunkSystemPrompt: string,
                chunkProvider: string,
                chunkModelId: string
            ): Promise<string | null> => {
                const { plan } = chunkLedger;

                
                const toolResults: string[] = [];
                for (const step of plan.steps) {
                    if (step.status === 'completed' && step.result) {
                        toolResults.push(`### ${step.toolName}\n${step.result}`);
                    }
                }

                if (toolResults.length === 0) {
                    return null;
                }

                
                
                const chunkModelTPM = this.settings.customModels?.find(m => m.id === chunkModelId && m.provider === chunkProvider)?.tokenLimit || 8000;
                const MAX_CHUNK_TOKENS = Math.max(1500, Math.floor(chunkModelTPM * 0.35));

                
                const chunks: string[] = [];
                let currentChunk = '';
                let currentTokens = 0;

                for (const result of toolResults) {
                    const resultTokens = Math.ceil(result.length / 4);
                    if (currentTokens + resultTokens > MAX_CHUNK_TOKENS && currentChunk.length > 0) {
                        chunks.push(currentChunk);
                        currentChunk = '';
                        currentTokens = 0;
                    }
                    currentChunk += result + '\n\n';
                    currentTokens += resultTokens;
                }
                if (currentChunk.length > 0) {
                    chunks.push(currentChunk);
                }

                
                
                const synthesizedAnswers: string[] = [];

                for (let i = 0; i < chunks.length; i++) {
                    const isLast = i === chunks.length - 1;
                    const instruction = isLast
                        ? 'All tools have been executed. Provide a complete answer to the original question based on these results.\n\nCRITICAL INSTRUCTION: The user CANNOT see the tool execution results. You MUST embed all relevant information, including full URLs, markdown images (e.g., ![Title](url)), and data points directly into your final answer. Do NOT use placeholders, and do NOT refer the user to "the tool results".'
                        : 'Continue processing the remaining tool results. Extract and preserve any important data, URLs, or markdown images so they can be included in the final answer.';

                    const synthMessages = [
                        { role: 'system', content: chunkSystemPrompt },
                        {
                            role: 'user',
                            content: `Tool execution results (batch ${i + 1}/${chunks.length}):\n\n${chunks[i]}\n\n${instruction}`
                        }
                    ];

                    try {
                        const synthResult = await synthesizeChunkOnProvider(
                            chunkProvider,
                            chunkModelId,
                            chunkSystemPrompt,
                            synthMessages
                        );

                        if (synthResult && synthResult.trim()) {
                            synthesizedAnswers.push(synthResult.trim());
                        }
                    } catch (synthErr) {
                        const errMsg = synthErr instanceof Error ? synthErr.message : String(synthErr);
                        if (errMsg.startsWith('__MCP_UNKNOWN_PROVIDER__:')) {
                            
                            
                                                        return null;
                        }
                                                
                    }
                }

                if (synthesizedAnswers.length > 0) {
                    return synthesizedAnswers.join('\n\n');
                }

                
                return null;
            };

            
            
            
            const formatRawLedger = (rawLedger: MCPExecutionLedger): string => {
                const completedSteps = rawLedger.plan.steps.filter(s => s.status === 'completed' && s.result);
                if (completedSteps.length === 0) {
                    return '> [!WARNING]\n> No tool results were returned. All tool executions may have failed.';
                }

                const sections: string[] = [
                    '> [!NOTE]',
                    '> AI synthesis was unavailable for this query. Below are the raw tool results formatted for readability.',
                    ''
                ];

                for (const step of completedSteps) {
                    sections.push(`## 🔧 ${step.toolName}`);
                    sections.push('');

                    let content = step.result || '';
                    
                    try {
                        const parsed = JSON.parse(content);
                        if (Array.isArray(parsed)) {
                            
                            if (parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
                                const keys = Object.keys(parsed[0]).slice(0, 8); 
                                sections.push('| ' + keys.join(' | ') + ' |');
                                sections.push('| ' + keys.map(() => '---').join(' | ') + ' |');
                                for (const item of parsed.slice(0, 25)) { 
                                    const vals = keys.map(k => {
                                        const v = item[k];
                                        if (v === null || v === undefined) return '';
                                        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
                                        return s.length > 80 ? s.substring(0, 77) + '...' : s;
                                    });
                                    sections.push('| ' + vals.join(' | ') + ' |');
                                }
                                if (parsed.length > 25) {
                                    sections.push(`\n*... and ${parsed.length - 25} more items*`);
                                }
                            } else {
                                
                                for (const item of parsed.slice(0, 50)) {
                                    sections.push(`- ${String(item)}`);
                                }
                            }
                        } else if (typeof parsed === 'object' && parsed !== null) {
                            
                            for (const [key, value] of Object.entries(parsed)) {
                                const displayVal = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
                                if (displayVal.length > 200) {
                                    sections.push(`**${key}**:`);
                                    sections.push('```');
                                    sections.push(displayVal.substring(0, 500));
                                    sections.push('```');
                                } else {
                                    sections.push(`- **${key}**: ${displayVal}`);
                                }
                            }
                        } else {
                            sections.push(content);
                        }
                    } catch {
                        
                        
                        if (content.length > 5000) {
                            sections.push(content.substring(0, 5000));
                            sections.push('\n*... (result truncated for readability)*');
                        } else {
                            sections.push(content);
                        }
                    }
                    sections.push('');
                }

                return sections.join('\n');
            };

            
            
            
            
            
            
            
            
            
            
            
            
            
            //
            
            
            
            
            
            modelCooldownUntil.clear();

            const modelsToTry: Array<{ provider: Provider; modelId: string; modelName: string }> = [];

            
            const isProviderActive = (p: Provider): boolean => {
                switch (p) {
                    case 'gemini':     return !!(this.settings.geminiApiKey || this.settings.apiKey);
                    case 'groq':       return !!this.settings.groqApiKey;
                    case 'openrouter': return !!this.settings.openRouterApiKey;
                    case 'nvidia':     return !!this.settings.nvidiaApiKey;
                    case 'ollama':     return !!this.settings.ollamaBaseUrl;
                    case 'opencode':   return !!this.settings.openCodeApiKey;
                    default:           return UnifiedProviderManager.getInstance().hasProvider(p);
                }
            };

            if (autoSelection !== null) {
                
                let allActiveCandidates: Array<{ provider: Provider; modelId: string; modelName: string; tokenLimit: number }> = [];
                
                const knownProviders: Provider[] = ['gemini', 'groq', 'openrouter', 'nvidia', 'ollama', 'opencode'];
                for (const p of knownProviders) {
                    if (!isProviderActive(p)) continue;
                    const providerModels = (this.settings.customModels || [])
                        .filter(m => m.provider === p && m.enabled !== false && (m.tokenLimit || 0) > 0);
                    for (const m of providerModels) {
                        allActiveCandidates.push({
                            provider: m.provider,
                            modelId: m.id,
                            modelName: m.name || m.id,
                            tokenLimit: m.tokenLimit || 0
                        });
                    }
                }

                
                if (this.settings.customProviders) {
                    for (const cp of this.settings.customProviders) {
                        if (!UnifiedProviderManager.getInstance().hasProvider(cp.id)) continue;
                        const providerModels = (this.settings.customModels || [])
                            .filter(m => m.provider === cp.id && m.enabled !== false && (m.tokenLimit || 0) > 0);
                        for (const m of providerModels) {
                            allActiveCandidates.push({
                                provider: m.provider,
                                modelId: m.id,
                                modelName: m.name || m.id,
                                tokenLimit: m.tokenLimit || 0
                            });
                        }
                    }
                }

                
                
                const MIN_GLOBAL_TPM = 7000;
                allActiveCandidates = allActiveCandidates.filter(m => m.tokenLimit >= MIN_GLOBAL_TPM);

                
                const synthMsgsForEstimate = buildSynthesisFromLedger(ledger, enhancedQuery, systemPrompt);
                const synthPayloadTokens = Math.ceil(
                    synthMsgsForEstimate.reduce((acc: number, m: any) =>
                        acc + (typeof m.content === 'string' ? m.content.length : 0), 0) / 4
                );
                
                const minTPMRequired = Math.ceil(synthPayloadTokens * 1.2);

                
                
                
                const capableGlobally = allActiveCandidates
                    .filter(m => m.tokenLimit >= minTPMRequired)
                    .sort((a, b) => b.tokenLimit - a.tokenLimit);

                const belowCapacityGlobally = allActiveCandidates
                    .filter(m => m.tokenLimit < minTPMRequired)
                    .sort((a, b) => b.tokenLimit - a.tokenLimit);

                if (capableGlobally.length > 0) {
                    modelsToTry.push(...capableGlobally);
                } else if (belowCapacityGlobally.length > 0) {
                    
                    modelsToTry.push(...belowCapacityGlobally.slice(0, 3));
                }

                                            }

            const RECOVERY_MESSAGES = [
                'Optimising response pipeline...',
                'Refining tool execution...',
                'Adjusting processing parameters...',
                'Enhancing query resolution...',
                'Calibrating response engine...',
            ];
            let recoveryMsgIdx = 0;
            const nextRecoveryMessage = () => RECOVERY_MESSAGES[recoveryMsgIdx++ % RECOVERY_MESSAGES.length];

            let lastError: Error | null = null;

            
            const maxSynthesisAttempts = Math.min(modelsToTry.length, MAX_SYNTHESIS_ATTEMPTS);

            for (let attempt = 0; attempt < modelsToTry.length; attempt++) {
                if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
                
                if (ledger.synthesisAttempts >= maxSynthesisAttempts) {
                                        break;
                }

                const modelEntry = modelsToTry[attempt];
                this.settings.provider = modelEntry.provider;
                this.settings.model = modelEntry.modelId;

                const provider = modelEntry.provider;
                
                const timeoutMs = getTimeoutForTask(TaskType.DEEP_REASONING, attempt > 0);

                try {
                    ledger.synthesisAttempts++;
                    updateSnippetUI('Synthesising answer from tool results...');
                    
                    const synthTotalSteps = 1 + ledger.plan.steps.length + 1;
                    updateProcessingUI(synthTotalSteps - 1, synthTotalSteps, 'Generating final answer...');

                    
                    const synthMsgs = buildSynthesisFromLedger(ledger, enhancedQuery, systemPrompt);

                    let timedPromise: any;
                    timedPromise = withTimeout(
                        (signal) => streamProviderForSynthesis(
                            provider,
                            modelEntry.modelId,
                            synthMsgs,
                            (token: string) => {
                                if (timedPromise) timedPromise.disableTimer();
                                updateSnippetUI('Generating response...', token);
                            },
                            (thinking: string) => {
                                if (timedPromise) timedPromise.disableTimer();
                                updateSnippetUI('Thinking...', thinking);
                            },
                            signal 
                        ),
                        timeoutMs
                    );
                    const result = await timedPromise;

                    responseText = result.content;
                    totalTokens  = result.totalTokens;

                    if (!responseText || responseText.trim().length === 0) {
                        throw new Error('__MCP_BLANK__: model returned an empty response');
                    }

                    updateSnippetUI('Response generated successfully');
                    return {
                        answer: responseText,
                        webResults,
                        totalTokens,
                        modelName: modelEntry.modelName,
                        providerName: modelEntry.provider
                    };

                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') {
                        throw error;
                    }
                    lastError = error instanceof Error ? error : new Error(String(error));
                    const errMsg = lastError.message;
                    const errMsgLower = errMsg.toLowerCase();

                    const isTimeout    = errMsg.includes('__MCP_TIMEOUT__');
                    const isBlank      = errMsg.includes('__MCP_BLANK__');
                    const isRateLimit  = errMsgLower.includes('rate limit') || errMsgLower.includes('429');
                    const isTokenLimit = errMsgLower.includes('token') || errMsgLower.includes('context length') || errMsgLower.includes('maximum context') || errMsgLower.includes('413') || errMsgLower.includes('too large');
                    
                    const isHardFail   = errMsgLower.includes('no endpoints') || errMsgLower.includes('model not found') ||
                                         errMsgLower.includes('404') || errMsgLower.includes('invalid api key') ||
                                         errMsgLower.includes('api key not valid') || errMsgLower.includes('unauthorized') ||
                                         errMsgLower.includes('401') || errMsgLower.includes('not found') ||
                                         errMsgLower.includes('503') || errMsgLower.includes('tool call validation') ||
                                         errMsgLower.includes('not in request');
                    const isUnavail    = errMsgLower.includes('unavailable') || isHardFail;
                    
                    const isAuthError  = errMsgLower.includes('401') || errMsgLower.includes('unauthorized') ||
                                         errMsgLower.includes('invalid api key') || errMsgLower.includes('api key not valid');

                    let logLabel = 'Unknown error';
                    if (isTimeout)         logLabel = 'Timeout';
                    else if (isBlank)      logLabel = 'Blank response';
                    else if (isRateLimit)  logLabel = 'Rate limit';
                    else if (isTokenLimit) logLabel = 'Token limit';
                    else if (isHardFail)   logLabel = 'Hard fail (skipping instantly)';
                    else if (isUnavail)    logLabel = 'Unavailable';

                    
                    
                    if (isRateLimit) {
                        setModelCooldown(modelEntry.modelId, modelEntry.provider);
                    }
                    
                    if (isAuthError) {
                        setModelCooldown(modelEntry.modelId, modelEntry.provider);
                    }

                    const hasMoreModels = attempt < modelsToTry.length - 1;
                    const underCap = ledger.synthesisAttempts < maxSynthesisAttempts;

                    if (hasMoreModels && underCap) {
                        
                        let nextIdx = attempt + 1;
                        while (nextIdx < modelsToTry.length && isModelOnCooldown(modelsToTry[nextIdx].modelId, modelsToTry[nextIdx].provider)) {
                                                        nextIdx++;
                        }
                        
                        if (nextIdx >= modelsToTry.length) {
                            const waitMs = Math.min(
                                ...modelsToTry.slice(attempt + 1).map(m => {
                                    const key = `${m.modelId}:${m.provider}`;
                                    const until = modelCooldownUntil.get(key) || 0;
                                    return Math.max(0, until - Date.now());
                                })
                            );
                            if (waitMs > 0 && waitMs < 60_000) {
                                                                updateSnippetUI(`Rate limited — waiting ${Math.ceil(waitMs / 1000)}s...`);
                                updateProcessingUI(1, 2, `TPM error, waiting ${Math.ceil(waitMs / 1000)}s before retrying...`);
                                await new Promise(resolve => setTimeout(resolve, waitMs));
                            }
                            
                            nextIdx = attempt + 1;
                        }
                        
                        if (nextIdx > attempt + 1) {
                            attempt = nextIdx - 1; 
                        }
                        const nextModel = modelsToTry[attempt + 1];
                        if (nextModel) {
                                                    }
                        updateSnippetUI(nextRecoveryMessage());
                        
                        
                        if (!isHardFail && !isRateLimit && !isTokenLimit) {
                            await new Promise(resolve => setTimeout(resolve, 300));
                        }
                        continue;
                    }

                                        
                    
                    
                    
                    const hasToolResults = ledger.completedSteps.length > 0;
                    
                    if (hasToolResults) {
                                                
                        for (const chunkModel of modelsToTry) {
                            try {
                                                                const fallbackResponse = await synthesizeWithChunking(
                                    ledger, enhancedQuery, systemPrompt, chunkModel.provider, chunkModel.modelId
                                );
                                if (fallbackResponse) {
                                                                        return {
                                        answer: fallbackResponse,
                                        webResults,
                                        modelName: chunkModel.modelName,
                                        providerName: chunkModel.provider
                                    };
                                }
                            } catch (chunkErr) {
                                                            }
                        }

                        
                                                const formattedFallback = formatRawLedger(ledger);
                        return {
                            answer: formattedFallback,
                            webResults,
                            modelName: 'Formatted Tool Results',
                            providerName: 'fail-safe'
                        };
                    }
                    
                    throw new Error(`MCP Query Error: All synthesis attempts failed. Last error: ${lastError.message}`);
                }
            }
            

            
            throw lastError || new Error('MCP Query: unexpected exit from fallback loop');

        } catch (error) {
                        
            
            if (error instanceof Error && error.message.startsWith('MCP Query Error:')) {
                throw error;
            }

            const errorMessage = error instanceof Error ? error.message : 'Failed to process MCP query';
            throw new Error(`MCP Query Error: ${errorMessage}`);
        }
    }
}
