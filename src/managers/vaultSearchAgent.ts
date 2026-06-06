import { App, Notice, requestUrl } from 'obsidian';
import { AISettings, getGeminiThinkingConfig, getModelTemperature, getModelTopP } from '../settings';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { MultimodalInput } from '../utils/multimodalUtils';
import { GroqService, GroqApiError, convertChatHistoryForGroq, ChatMessage as GroqChatMessage, GroqStreamEvent, GROQ_VISION_MODEL, GroqContentPart } from '../services/groqService';
import { OpenRouterService, OpenRouterApiError, ChatMessage as OpenRouterChatMessage } from '../services/openRouterService';
import { OllamaService, OllamaApiError } from '../services/ollamaService';
import { NvidiaService, NvidiaApiError, ChatMessage as NvidiaChatMessage } from '../services/nvidiaService';
import { RateLimitManager } from '../utils/rateLimitManager';
import { GeminiService } from '../services/geminiService';
import { UnifiedProviderManager } from '../services/unifiedProviderManager';

export interface VaultSearchResult {
    path: string;
    content: string;
    similarity: number;
}


type ProgressCallback = (step: number, totalSteps: number, message: string, contentSnippet?: string) => void;
type SnippetUpdateCallback = (message: string, snippet?: string) => void;





function extractRelevantPassages(content: string, query: string, maxTokens: number = 1500, minContentRatio: number = 0.4): string {
    const estTokens = (text: string) => Math.ceil((text || '').length / 4);
    const contentTokens = estTokens(content);
    
    
    if (contentTokens <= maxTokens) {
        return content;
    }
    
    
    const minTokensToKeep = Math.max(maxTokens * minContentRatio, 500);
    
    
    
    const sections = content.split(/\n\n+/);
    
    
    
    const scoredSections = sections.map((section, idx) => {
        let score = 20; 
        
        const sectionTokens = estTokens(section);
        const totalSections = sections.length;
        
        
        if (/^#{1,6}\s/.test(section)) {
            score += 25; 
        }
        if (/^[-*]\s|^\d+\.\s/m.test(section)) {
            score += 15; 
        }
        if (/```[\s\S]*?```/.test(section)) {
            score += 20; 
        }
        if (/\*\*[^*]+\*\*|__[^_]+__/.test(section)) {
            score += 10; 
        }
        if (/^>\s/m.test(section)) {
            score += 12; 
        }
        
        
        if (idx === 0) {
            score += 15; 
        } else if (idx < totalSections * 0.25) {
            score += 12; 
        } else if (idx >= totalSections * 0.25 && idx <= totalSections * 0.75) {
            score += 18; 
        } else if (idx === totalSections - 1) {
            score += 8; 
        }
        
        
        
        if (sectionTokens > 100 && sectionTokens < 500) {
            score += 15; 
        } else if (sectionTokens >= 500) {
            score += 10; 
        } else if (sectionTokens > 50) {
            score += 8; 
        }
        
        
        
        const hasNumbers = /\d+/.test(section);
        const hasFormulas = /[=+\-*/^]/.test(section);
        const hasCitations = /\[\d+\]|\[\^\w+\]/.test(section);
        const hasLinks = /\[.*?\]\(.*?\)|https?:\/\//.test(section);
        
        if (hasNumbers) score += 8; 
        if (hasFormulas) score += 10; 
        if (hasCitations) score += 12; 
        if (hasLinks) score += 6; 
        
        return { text: section, score, index: idx, tokens: sectionTokens };
    });
    
    
    scoredSections.sort((a, b) => b.score - a.score);
    
    
    const selectedSections: { text: string; index: number; tokens: number }[] = [];
    let currentTokens = 0;
    
    
    for (const section of scoredSections) {
        if (currentTokens >= minTokensToKeep) break;
        if (currentTokens + section.tokens <= maxTokens) {
            selectedSections.push(section);
            currentTokens += section.tokens;
        }
    }
    
    
    for (const section of scoredSections) {
        if (selectedSections.find(s => s.index === section.index)) continue; 
        if (currentTokens + section.tokens <= maxTokens) {
            selectedSections.push(section);
            currentTokens += section.tokens;
        }
    }
    
    
    if (selectedSections.length === 0) {
        return content.substring(0, maxTokens * 4);
    }
    
    
    
    selectedSections.sort((a, b) => a.index - b.index);
    
    return selectedSections.map(s => s.text).join('\n\n');
}

export class VaultSearchAgent {
    private static readonly MINIMUM_SIMILARITY_THRESHOLD = 0.3; 
    
    

    private app: App;
    private settings: AISettings;
    private progressCallback: ProgressCallback; 
    private stopProcessing: boolean = false; 
    private lastApiCallTime: number = 0;  
    private snippetUpdateCallback: SnippetUpdateCallback; 
    search: any;

    
    private rateLimitManager: RateLimitManager;

    /**
     * Calculate available token budget for vault search results.
     * This prevents rate limiting by ensuring we don't exceed TPM limits.
     * Uses RateLimitManager for dynamic limits from API headers.
     * 
     * @returns Available tokens for vault search content
     */
    private calculateAvailableTokenBudget(): number {
        return this.rateLimitManager.getAvailableTokenBudget(
            this.settings.provider,
            this.settings.model,
            0.3 
        );
    }

    /**
     * Filter vault search results based on available token budget.
     * Prioritizes results by similarity score and includes as many as fit within budget.
     * 
     * IMPORTANT: This estimates tokens AFTER tiered extraction, not raw content size.
     * 
     * @param results Vault search results sorted by similarity
     * @param maxResults User's requested max results (from slider)
     * @param dynamicThresholds Dynamic similarity thresholds for tiered extraction
     * @param bypassTokenLimit For temporal queries, bypass token limits to include all files
     * @returns Filtered results that fit within token budget
     */
    private filterResultsByTokenBudget(
        results: VaultSearchResult[], 
        maxResults: number,
        dynamicThresholds: { high: number; medium: number },
        bypassTokenLimit: boolean = false
    ): { filtered: VaultSearchResult[], totalTokens: number, reason: string } {
        
        
        const customModel = this.settings.customModels?.find(m => m.id === this.settings.model);
        const tokenLimit = customModel?.tokenLimit || 0;
        
        const effectiveBudget = tokenLimit > 0 ? tokenLimit : 50000;
        
        
        
        
        if (bypassTokenLimit) {
            const totalTokens = results.reduce((sum, r) => sum + this._estimateTokens(r.content), 0);
            return {
                filtered: results,
                totalTokens,
                reason: 'temporal query (all files included)'
            };
        }
        
        
        const sorted = [...results].sort((a, b) => b.similarity - a.similarity);
        
        
        const filtered: VaultSearchResult[] = [];
        let totalTokens = 0;
        
        for (let i = 0; i < Math.min(sorted.length, maxResults); i++) {
            const result = sorted[i];
            
            
            let estimatedTokensAfterExtraction: number;
            const rawTokens = this._estimateTokens(result.content);
            
            if (result.similarity >= dynamicThresholds.high) {
                
                estimatedTokensAfterExtraction = rawTokens;
            } else if (result.similarity >= dynamicThresholds.medium) {
                
                estimatedTokensAfterExtraction = Math.min(5000, rawTokens * 0.75);
            } else {
                
                estimatedTokensAfterExtraction = Math.min(2000, rawTokens * 0.60);
            }
            
            
            if (totalTokens + estimatedTokensAfterExtraction <= effectiveBudget) {
                filtered.push(result);
                totalTokens += estimatedTokensAfterExtraction;
            } else {
                
                break;
            }
        }
        
        
        let reason = '';
        if (filtered.length < maxResults && filtered.length < sorted.length) {
            reason = `token budget (${Math.floor(effectiveBudget)} tokens available)`;
        } else if (filtered.length < sorted.length) {
            reason = `max results setting (${maxResults})`;
        } else {
            reason = 'all results included';
        }
        
        return { filtered, totalTokens, reason };
    }

    constructor(app: App, settings: AISettings, progressCallback: ProgressCallback, snippetUpdateCallback: SnippetUpdateCallback) {
        this.app = app;
        this.settings = settings;
        this.progressCallback = progressCallback;
        this.snippetUpdateCallback = snippetUpdateCallback;
         
         this.stop = this.stop.bind(this);
         
         this.rateLimitManager = RateLimitManager.getInstance();
    }

    
    private _estimateTokens(text: string): number {
        if (!text) return 0;
        
        return Math.ceil(text.length / 4);
    }

     
     stop() {
        this.stopProcessing = true;
     }

    /**
     * Calculate dynamic similarity thresholds based on actual score distribution.
     * This solves the "embedding dilution" problem where documents with highly relevant
     * content score lower than expected due to document-level embeddings.
     * 
     * Strategy:
     * - If top doc scores high (>0.65): Use strict thresholds (docs are focused)
     * - If top doc scores medium (0.5-0.65): Use relaxed thresholds (dilution present)
     * - If top doc scores low (<0.5): Use very relaxed thresholds (broad search)
     */
    private calculateDynamicThresholds(docs: VaultSearchResult[]): { high: number; medium: number } {
        if (docs.length === 0) {
            return { high: 0.65, medium: 0.45 }; 
        }

        
        const sortedDocs = [...docs].sort((a, b) => b.similarity - a.similarity);
        
        const topScore = sortedDocs[0].similarity;
        const secondScore = sortedDocs.length > 1 ? sortedDocs[1].similarity : topScore;
        const avgTopThree = sortedDocs.length >= 3
            ? (sortedDocs[0].similarity + sortedDocs[1].similarity + sortedDocs[2].similarity) / 3
            : topScore;
        
        
        const allScores = sortedDocs.map(d => d.similarity);
        const medianScore = allScores[Math.floor(allScores.length / 2)];
        const scoreRange = topScore - (sortedDocs[sortedDocs.length - 1]?.similarity || 0);
        
        let highThreshold: number;
        let mediumThreshold: number;
        
        
        if (topScore >= 0.65) {
            highThreshold = 0.65;
            mediumThreshold = 0.50;
        }
        
        else if (topScore >= 0.55) {
            
            highThreshold = Math.max(0.50, avgTopThree - 0.05);
            mediumThreshold = Math.max(0.40, medianScore - 0.05);
        }
        
        else if (topScore >= 0.45) {
            
            highThreshold = Math.max(0.45, topScore - 0.03);
            mediumThreshold = Math.max(0.35, avgTopThree - 0.10);
        }
        
        else {
            
            highThreshold = Math.max(0.40, topScore - 0.02);
            mediumThreshold = Math.max(0.30, secondScore - 0.05);
        }
        
        
        highThreshold = Math.max(highThreshold, VaultSearchAgent.MINIMUM_SIMILARITY_THRESHOLD + 0.15);
        mediumThreshold = Math.max(mediumThreshold, VaultSearchAgent.MINIMUM_SIMILARITY_THRESHOLD + 0.05);
        mediumThreshold = Math.min(mediumThreshold, highThreshold - 0.08); 
        
        return { high: highThreshold, medium: mediumThreshold };
    }

    /**
     * Processes a vault search query using an agentic approach to handle large contexts.
     * @param query The user's query.
     * @param relevantContent The content retrieved from the vault search.
     * @param webResults Optional web search results to include.
     * @param enableInlineCitations Enable inline footnote citations.
     * @param chatHistory Chat history for context.
     * @param multimodalInputs Optional array of multimodal inputs (images, PDFs, audio, video).
     * @returns The final comprehensive answer.
     */
    async processVaultSearch(
        query: string,
        relevantContent: VaultSearchResult[],
        enableInlineCitations: boolean = false, 
        chatHistory: any[] = [], 
        multimodalInputs: MultimodalInput[] = [],
        systemInstructions: string = '', 
        temporalContext?: {startDate: number | null, endDate: number | null, cleanQuery: string}, 
        abortSignal?: AbortSignal
    ): Promise<{ answer: string, sources: { path: string; relevance: number }[], totalTokens?: number }> {
        this.stopProcessing = false;
        this.reportProgress(0, 1, 'Starting vault search...');
        
        
        let totalTokens: number | undefined = undefined;

        
        const hasTemporalFilter = !!(temporalContext && (temporalContext.startDate || temporalContext.endDate));
        
        
        
        const isExplicitFileListQuery = !!(
            query.toLowerCase().match(/\b(what|which|list|show|tell me|give me|find).{0,20}(files?|documents?|notes?).{0,30}(created|modified|changed|updated|edited|this week|this month|last week|last month|today|yesterday|recently)/i) ||
            query.toLowerCase().match(/\b(files?|documents?|notes?)\s+(i\s+)?(created|modified|changed|updated|edited)/i) ||
            query.toLowerCase().match(/\b(what|which)\s+(files?|documents?|notes?)\s+(did|have|were)/i)
        );
        
        
        
        const isFileListQuery = isExplicitFileListQuery;

        
        let filteredRelevantContent: VaultSearchResult[];
        if (isFileListQuery || hasTemporalFilter) {
            
            filteredRelevantContent = relevantContent.sort((a, b) => b.similarity - a.similarity);
        } else {
            
            filteredRelevantContent = this.filterRelevantContent(relevantContent);
        }
        
        
        
        const dynamicThresholds = this.calculateDynamicThresholds(filteredRelevantContent);
        
        
        
        let maxResults = this.settings.maxVaultSearchResults || 10;
        if (isFileListQuery || hasTemporalFilter) {
            
            maxResults = Math.max(maxResults, filteredRelevantContent.length);
        }
        
        
        
        const { filtered: tokenFilteredContent, totalTokens: vaultContentTokens, reason: filterReason } = 
            this.filterResultsByTokenBudget(filteredRelevantContent, maxResults, dynamicThresholds, isFileListQuery || hasTemporalFilter);
        
        
        
        const finalFilteredContent = tokenFilteredContent;
        
        
        
        
        let estimatedContentTokens = 0;
        finalFilteredContent.forEach(doc => {
            if (doc.similarity >= dynamicThresholds.high) {
                estimatedContentTokens += this._estimateTokens(doc.content);
            } else if (doc.similarity >= dynamicThresholds.medium) {
                estimatedContentTokens += Math.min(1500, this._estimateTokens(doc.content));
            } else {
                estimatedContentTokens += Math.min(500, this._estimateTokens(doc.content));
            }
        });

        const estimatedQueryTokens = this._estimateTokens(query);
        const estimatedOverheadTokens = 3000; 
        const totalEstimatedTokens = estimatedContentTokens + estimatedQueryTokens + estimatedOverheadTokens;

        
        
        


        let finalAnswer = "";
        
        
        
        const documentsUsedForGeneration: VaultSearchResult[] = [];
        
        
        
        
        const citationSourcesMapping = finalFilteredContent.map(result => ({
            path: result.path,
            relevance: Math.round(result.similarity * 100)
        }));

        

        
        this.reportProgress(1, 1, `Processing ${finalFilteredContent.length} documents in single pass...`);

            
            
            
            const formattedVaultContent = finalFilteredContent
                .map((r, idx) => {
                    let contentToUse: string;
                    const originalTokens = this._estimateTokens(r.content);
                    
                    
                    documentsUsedForGeneration.push(r);
                    
                    if (r.similarity >= dynamicThresholds.high) {
                        
                        contentToUse = r.content;
                    } else if (r.similarity >= dynamicThresholds.medium) {
                        
                        
                        const targetTokens = Math.min(originalTokens, 5000); 
                        contentToUse = extractRelevantPassages(r.content, query, targetTokens, 0.75);
                    } else {
                        
                        
                        const targetTokens = Math.min(originalTokens, 2000); 
                        contentToUse = extractRelevantPassages(r.content, query, targetTokens, 0.60);
                    }
                    
                    
                    return `# [^${idx + 1}] ${r.path}\n\n${contentToUse}\n\nRelevance: ${(r.similarity * 100).toFixed(1)}%`;
                })
                .join('\n\n---\n\n');

            
            let citationInstructions = '';
            if (enableInlineCitations && citationSourcesMapping.length > 0) {
                
                
                const sourceMapping = citationSourcesMapping
                    .map((s, idx) => `[^${idx + 1}]: ${s.path}`)
                    .join('\n');
                citationInstructions = `
**⚠️ MANDATORY CITATION REQUIREMENT ⚠️**

You MUST cite sources using footnote format: [^1], [^2], [^3], etc.

Each source document below is prefixed with its citation number in the heading (e.g. "# [^1] filename").
Use ONLY those numbers when citing — do NOT invent new numbers.

Available sources for citation:
${sourceMapping}

CITATION RULES (STRICTLY ENFORCED):
1. Place [^N] at the END of each paragraph that uses information from source N
2. If a paragraph uses multiple sources, cite all: [^1][^2]
3. EVERY paragraph must have at least one citation
4. Use the exact format [^N] - no variations
5. The number MUST match the [^N] shown in the document heading

Example:
"Machine learning uses algorithms to learn patterns.[^1] Deep learning is a subset that uses neural networks.[^2]"

FAILURE TO INCLUDE CITATIONS = INCOMPLETE ANSWER
`;
            } else {
                
                citationInstructions = `\n**IMPORTANT: Do NOT include a "Sources:" section or list sources at the end of your answer.** Provide only the direct answer content. Sources will be displayed separately in the UI.`;
            }
            
            
            
            
            let baseSystemInstructions = '';
            
            if (isFileListQuery && finalFilteredContent.length > 0) {
                
                const fileList = Array.from(new Set(finalFilteredContent.map(doc => doc.path))).join('\n- ');
                
                
                let dateRangeText = '';
                if (temporalContext) {
                    const startDateStr = temporalContext.startDate ? new Date(temporalContext.startDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'any time';
                    const endDateStr = temporalContext.endDate ? new Date(temporalContext.endDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'now';
                    dateRangeText = `\n\nTIME RANGE: ${startDateStr} to ${endDateStr}`;
                }
                
                
                const wantsJustList = !!(query.toLowerCase().match(/\b(just\s+)?(list|show|give me|tell me)\s+(the\s+)?(files?|documents?|notes?)/i) ||
                    query.toLowerCase().match(/\bwhat\s+(files?|documents?|notes?)\s+(were|did|have|are)/i));
                
                const taskInstruction = wantsJustList
                    ? `YOUR TASK:
1. Acknowledge the time period the user asked about
2. List ALL the files below — one per line, using the exact file path
3. Do NOT add summaries or descriptions unless the user asked for them
4. Keep the response concise`
                    : `YOUR TASK:
1. Acknowledge the time period the user asked about
2. List ALL the files shown below that match this time range
3. For each file, provide a brief 1-2 sentence summary based on its content
4. Use clear formatting with file names as headings
5. Be concise but informative`;
                
                baseSystemInstructions = `You are an AI assistant helping users find files in their vault.

IMPORTANT: The user asked about files created or modified in a specific time period.${dateRangeText}

FILES FOUND IN THE SPECIFIED TIME RANGE (list ALL of these):
- ${fileList}

${taskInstruction}

CRITICAL: These files WERE found and DO match the user's time criteria. List every single file above — do NOT omit any. Do NOT say "I don't have explicit information".

${citationInstructions}`;
            } else if (hasTemporalFilter && finalFilteredContent.length > 0) {
                
                
                const fileList = Array.from(new Set(finalFilteredContent.map(doc => doc.path))).join('\n- ');
                let dateRangeText = '';
                if (temporalContext) {
                    const startDateStr = temporalContext.startDate ? new Date(temporalContext.startDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'any time';
                    const endDateStr = temporalContext.endDate ? new Date(temporalContext.endDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'now';
                    dateRangeText = `${startDateStr} to ${endDateStr}`;
                }
                
                baseSystemInstructions = `You are an AI research assistant helping users understand their vault activity over a time period.

TEMPORAL CONTEXT: The user's query covers the period ${dateRangeText || 'as specified'}.
All ${finalFilteredContent.length} files below were filtered to match this time range based on their last modified date.

FILES IN THIS TIME RANGE:
- ${fileList}

YOUR TASK:
1. Answer the user's question by synthesizing information from ALL the files above
2. Acknowledge the time period in your response
3. Cover ALL files — do not skip or omit any
4. Use clear structure (headings, bullet points) for readability
5. Be comprehensive but concise — focus on what the user actually asked

CRITICAL: Base your answer ONLY on the vault content provided below. Do NOT add external knowledge.
${citationInstructions}

RESPONSE QUALITY CHECKLIST:
✓ Have I covered ALL ${finalFilteredContent.length} files in the time range?
✓ Have I answered the user's actual question (not just listed files)?
✓ Have I cited sources correctly (if required)?`;
            } else {
                
                let temporalContextNote = '';
                if (temporalContext && (temporalContext.startDate || temporalContext.endDate)) {
                    const startDateStr = temporalContext.startDate ? new Date(temporalContext.startDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'any time';
                    const endDateStr = temporalContext.endDate ? new Date(temporalContext.endDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'now';
                    temporalContextNote = `\n\n**TEMPORAL CONTEXT**: The user's query relates to a specific time period (${startDateStr} to ${endDateStr}). The files provided below were filtered to match this time range based on their last modified date. When answering, acknowledge this temporal context if relevant to the query.`;
                }
                
                baseSystemInstructions = `You are an AI research assistant specialized in analyzing and synthesizing information from vault notes.

CORE MISSION: Provide comprehensive, accurate answers based STRICTLY on the vault content provided below.${temporalContextNote}

CRITICAL REQUIREMENTS:
1. **Content Fidelity**: Answer ONLY using information from the provided vault notes - no external knowledge
2. **Comprehensive Synthesis**: Review and synthesize information from ALL provided sources
3. **Detailed Responses**: Provide complete answers with specific examples, data, and context from the sources
4. **Clear Structure**: Use markdown formatting (headings, lists, code blocks, tables) for readability
5. **Logical Flow**: Organize information coherently with smooth transitions between topics
6. **Explicit Gaps**: If information is insufficient, clearly state what's missing without apologizing
${citationInstructions}

RESPONSE QUALITY CHECKLIST:
✓ Have I reviewed ALL provided sources?
✓ Have I included specific details and examples?
✓ Is my answer well-structured and easy to follow?
✓ Have I cited sources correctly (if required)?
✓ Have I avoided adding external knowledge?`;
            }

            
            if (systemInstructions && systemInstructions.trim()) {
                baseSystemInstructions += `\n\n--- ADDITIONAL USER INSTRUCTIONS ---\n${systemInstructions.trim()}`;
            }

            

            try {
                if (this.settings.provider === 'gemini') {
                    const genAI = new GoogleGenerativeAI(this.settings.geminiApiKey || this.settings.apiKey);
                    const model = genAI.getGenerativeModel({ model: this.settings.model });

                    
                    const chatConfig: any = {
                        history: chatHistory,
                        generationConfig: {
                            temperature: getModelTemperature(this.settings.model, this.settings),
                            topK: 40,
                            topP: getModelTopP(this.settings.model, this.settings),
                            maxOutputTokens: 8192,
                        },
                    };
                    const geminiThinkingConfig = getGeminiThinkingConfig(this.settings.model, this.settings);
                    if (geminiThinkingConfig) {
                        chatConfig.generationConfig.thinkingConfig = geminiThinkingConfig.thinkingConfig;
                    }
                    
                    const chat = model.startChat(chatConfig);
                    
                    
                    const messageParts: any[] = [];
                    
                    
                    const fullPrompt = `${baseSystemInstructions}\n\nContent from notes:\n${formattedVaultContent}\n\nQuestion: ${query}`;
                    messageParts.push({ text: fullPrompt });
                    
                    
                    const inlineInputs = multimodalInputs.filter(input => input.type === 'inline' && input.data);
                    if (inlineInputs.length > 0) {
                        for (const input of inlineInputs) {
                            messageParts.push({
                                inlineData: {
                                    mimeType: input.mimeType,
                                    data: input.data!
                                }
                            });
                        }
                    }
                    
                    
                    const fileUriInputs = multimodalInputs.filter(input => input.type === 'fileUri' && input.uri);
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

                    const streamResult = await chat.sendMessageStream(messageParts, { signal: abortSignal });
                    for await (const chunk of streamResult.stream) {
                        if (abortSignal?.aborted || this.stopProcessing) {
                            throw new DOMException('Aborted', 'AbortError');
                        }
                        const candidate = chunk.candidates?.[0];
                        const parts = candidate?.content?.parts;
                        if (!Array.isArray(parts)) continue;
                        for (const part of parts) {
                            const text = typeof part?.text === 'string' ? part.text : '';
                            if (!text) continue;
                            if ((part as any)?.thought === true) {
                                this.snippetUpdateCallback('Thinking...', text);
                            } else {
                                finalAnswer += text;
                                this.snippetUpdateCallback('Generating response...', text);
                            }
                        }
                    }
                    const finalResponse = await streamResult.response;
                    if ((!finalAnswer || !finalAnswer.trim()) && finalResponse?.text) {
                        finalAnswer = finalResponse.text();
                    }
                    
                    
                    if ((finalResponse as any).usageMetadata) {
                        const usage = (finalResponse as any).usageMetadata;
                        totalTokens = (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0);
                    }
                } else if (this.settings.provider === 'groq') {
                    
                    const groqService = new GroqService(
                        this.settings.groqApiKey,
                        (headers) => this.rateLimitManager.updateFromHeaders('groq', this.settings.model, headers)
                    );
                    
                    
                    const isGroqGptOssModel = (this.settings.model || '').toLowerCase().includes('gpt-oss');
                    const groqThinkingLevel = isGroqGptOssModel ? (this.settings.groqThinkingLevel || 'medium') : undefined;
                    
                    
                    
                    const rateLimitState = this.rateLimitManager.getState(this.settings.provider, this.settings.model);
                    const modelTokenLimit = rateLimitState.limits?.tokensPerMinute || 8000;
                    const groqMessages: GroqChatMessage[] = [
                        { role: 'system', content: baseSystemInstructions },
                        ...convertChatHistoryForGroq(chatHistory, this.settings.model, modelTokenLimit)
                    ];
                    if (formattedVaultContent) {
                        groqMessages.push({ role: 'user', content: `Content from notes:\n${formattedVaultContent}` } as GroqChatMessage);
                    }
                    
                    if (this.settings.model === GROQ_VISION_MODEL) {
                        const inlineInputs = multimodalInputs.filter(input => input.type === 'inline' && input.data);
                        if (inlineInputs.length > 0) {
                            const contentParts: GroqContentPart[] = [{ type: 'text', text: `Question: ${query}` }];
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
                            groqMessages.push({ role: 'user', content: `Question: ${query}` });
                        }
                    } else {
                        groqMessages.push({ role: 'user', content: `Question: ${query}` });
                    }

                    
                    
                    if (groqThinkingLevel) {
                        let contentBuffer = '';
                        await groqService.generateContentStreamEvents(
                            this.settings.model,
                            groqMessages,
                            (evt: GroqStreamEvent) => {
                                if (evt.type === 'thinking') {
                                    this.snippetUpdateCallback('Thinking...', evt.text);
                                } else if (evt.type === 'content') {
                                    contentBuffer += evt.text;
                                    finalAnswer += evt.text;
                                    this.snippetUpdateCallback('Generating response...', evt.text);
                                }
                            },
                            {
                                temperature: getModelTemperature(this.settings.model, this.settings),
                                topP: getModelTopP(this.settings.model, this.settings),
                                thinkingLevel: groqThinkingLevel,
                                abortSignal
                            }
                        );
                        finalAnswer = contentBuffer;
                    } else {
                        
                        finalAnswer = await groqService.generateContent(
                            this.settings.model,
                            groqMessages,
                            {
                                temperature: getModelTemperature(this.settings.model, this.settings),
                                topP: getModelTopP(this.settings.model, this.settings),
                                abortSignal
                            }
                        );
                        this.snippetUpdateCallback('Generating response...', finalAnswer);
                    }
                } else if (this.settings.provider === 'openrouter') {
                    
                    const openRouterService = new OpenRouterService(
                        this.settings.openRouterApiKey,
                        (headers) => this.rateLimitManager.updateFromHeaders('openrouter', this.settings.model, headers)
                    );
                    
                    
                    const rateLimitState = this.rateLimitManager.getState(this.settings.provider, this.settings.model);
                    const modelTokenLimit = rateLimitState.limits?.tokensPerMinute || 8000;
                    const openRouterMessages: OpenRouterChatMessage[] = [
                        { role: 'system', content: baseSystemInstructions },
                        ...convertChatHistoryForGroq(chatHistory, this.settings.model, modelTokenLimit) as OpenRouterChatMessage[]
                    ];
                    if (formattedVaultContent) {
                        openRouterMessages.push({ role: 'user', content: `Content from notes:\n${formattedVaultContent}` });
                    }
                    openRouterMessages.push({ role: 'user', content: `Question: ${query}` });

                    finalAnswer = await openRouterService.generateContentStream(
                        this.settings.model,
                        openRouterMessages,
                        {
                            temperature: getModelTemperature(this.settings.model, this.settings),
                            maxTokens: 8192,
                            topP: getModelTopP(this.settings.model, this.settings),
                            abortSignal
                        },
                        (chunk: string) => {
                            finalAnswer += chunk;
                            this.snippetUpdateCallback('Generating response...', chunk);
                        }
                    );
                } else if (this.settings.provider === 'ollama') {
                    
                    const { OllamaService } = await import('../services/ollamaService');
                    const ollamaService = new OllamaService(
                        this.settings.ollamaBaseUrl,
                        this.settings.ollamaApiKey,
                        (headers) => this.rateLimitManager.updateFromHeaders('ollama', this.settings.model, headers)
                    );
                    
                    
                    const rateLimitState = this.rateLimitManager.getState(this.settings.provider, this.settings.model);
                    const modelTokenLimit = rateLimitState.limits?.tokensPerMinute || 8000;
                    const ollamaMessages: any[] = [
                        { role: 'system', content: baseSystemInstructions },
                        ...convertChatHistoryForGroq(chatHistory, this.settings.model, modelTokenLimit)
                    ];
                    if (formattedVaultContent) {
                        ollamaMessages.push({ role: 'user', content: `Content from notes:\n${formattedVaultContent}` });
                    }
                    ollamaMessages.push({ role: 'user', content: `Question: ${query}` });

                    const normalizedOllamaModelId = (this.settings.model || '').toLowerCase();
                    const isOllamaGptOssModel = normalizedOllamaModelId.includes('gpt-oss');
                    const ollamaThinkOption = isOllamaGptOssModel
                        ? (this.settings.ollamaGptOssThinkingLevel || 'medium')
                        : !!this.settings.ollamaThinkingEnabled;

                    
                    if (ollamaThinkOption) {
                        let contentBuffer = '';
                        await (ollamaService as any).generateContentStreamEvents(
                            this.settings.model,
                            ollamaMessages,
                            (evt: any) => {
                                if (evt?.type === 'thinking' && evt.text) {
                                    this.snippetUpdateCallback('Thinking...', evt.text);
                                } else if (evt?.type === 'content' && evt.text) {
                                    contentBuffer += evt.text;
                                    this.snippetUpdateCallback('Generating response...', evt.text);
                                }
                            },
                            {
                                temperature: getModelTemperature(this.settings.model, this.settings),
                                maxTokens: 8192,
                                topP: getModelTopP(this.settings.model, this.settings),
                                think: ollamaThinkOption,
                                abortSignal
                            }
                        );
                        finalAnswer = contentBuffer;
                    } else {
                        
                        let contentBuffer = '';
                        await (ollamaService as any).generateContentStream(
                            this.settings.model,
                            ollamaMessages,
                            (chunk: string) => {
                                contentBuffer += chunk;
                                this.snippetUpdateCallback('Generating response...', chunk);
                            },
                            {
                                temperature: getModelTemperature(this.settings.model, this.settings),
                                maxTokens: 8192,
                                topP: getModelTopP(this.settings.model, this.settings),
                                think: ollamaThinkOption,
                                abortSignal
                            }
                        );
                        finalAnswer = contentBuffer;
                    }
                } else if (this.settings.provider === 'nvidia') {
                    
                    const nvidiaService = new NvidiaService(
                        this.settings.nvidiaApiKey,
                        (headers) => this.rateLimitManager.updateFromHeaders('nvidia', this.settings.model, headers)
                    );
                    
                    
                    const rateLimitState = this.rateLimitManager.getState(this.settings.provider, this.settings.model);
                    const modelTokenLimit = rateLimitState.limits?.tokensPerMinute || 8000;
                    const nvidiaMessages: NvidiaChatMessage[] = [
                        { role: 'system', content: baseSystemInstructions },
                        ...(convertChatHistoryForGroq(chatHistory, this.settings.model, modelTokenLimit) as any[])
                    ];
                    if (formattedVaultContent) {
                        nvidiaMessages.push({ role: 'user', content: `Content from notes:\n${formattedVaultContent}` } as NvidiaChatMessage);
                    }
                    nvidiaMessages.push({ role: 'user', content: `Question: ${query}` } as NvidiaChatMessage);

                    
                    try {
                        finalAnswer = await nvidiaService.generateContent(
                            this.settings.model,
                            nvidiaMessages,
                            {
                                temperature: getModelTemperature(this.settings.model, this.settings),
                                maxTokens: 8192,
                                topP: getModelTopP(this.settings.model, this.settings),
                                abortSignal
                            }
                        );
                        
                        this.snippetUpdateCallback('Generating response...', finalAnswer);
                    } catch (streamError) {
                        
                                                finalAnswer = await nvidiaService.generateContentStream(
                            this.settings.model,
                            nvidiaMessages,
                            {
                                temperature: getModelTemperature(this.settings.model, this.settings),
                                maxTokens: 8192,
                                topP: getModelTopP(this.settings.model, this.settings),
                                abortSignal
                            },
                            (chunk: string) => {
                                finalAnswer += chunk;
                                this.snippetUpdateCallback('Generating response...', chunk);
                            }
                        );
                    }
                } else if (UnifiedProviderManager.getInstance().hasProvider(this.settings.provider)) {
                    const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(this.settings.provider)!;
                    
                    const unifiedMessages: any[] = [
                        { role: 'system', content: baseSystemInstructions },
                        ...chatHistory
                            .filter(m => (m.parts?.[0]?.text || m.content || '').trim().length > 0)
                            .map(m => ({
                                role: (m.role === 'model' || m.role === 'assistant') ? 'assistant' : 'user',
                                content: m.parts?.[0]?.text || m.content || ''
                            }))
                    ];

                    let finalUserContent = '';
                    if (formattedVaultContent) {
                        finalUserContent += `Content from notes:\n${formattedVaultContent}\n\n`;
                    }
                    finalUserContent += `Question: ${query}`;
                    
                    unifiedMessages.push({ role: 'user', content: finalUserContent });

                    if (unifiedProvider.streamContent) {
                        const response = await unifiedProvider.streamContent(
                            this.settings.model,
                            unifiedMessages,
                            (chunk: string) => {
                                finalAnswer += chunk;
                                this.snippetUpdateCallback('Generating response...', chunk);
                            },
                            {
                                temperature: getModelTemperature(this.settings.model, this.settings),
                                maxTokens: 8192,
                                topP: getModelTopP(this.settings.model, this.settings),
                                abortSignal
                            },
                            (thinking: string) => {
                                this.snippetUpdateCallback('Thinking...', thinking);
                            }
                        );
                        if (!finalAnswer && response.text) finalAnswer = response.text;
                    } else {
                        const response = await unifiedProvider.generateContent(
                            this.settings.model,
                            unifiedMessages,
                            {
                                temperature: getModelTemperature(this.settings.model, this.settings),
                                maxTokens: 8192,
                                topP: getModelTopP(this.settings.model, this.settings),
                                abortSignal
                            },
                            (thinking: string) => {
                                this.snippetUpdateCallback('Thinking...', thinking);
                            }
                        );
                        finalAnswer = response.text;
                    }
                } else {
                    
                    
                    const messages: any[] = [
                        { role: 'system', content: baseSystemInstructions },
                        ...chatHistory 
                    ];

                    let finalUserContent = '';
                    if (formattedVaultContent) {
                        finalUserContent += `Content from notes:\n${formattedVaultContent}\n\n`;
                    }
                    finalUserContent += `Question: ${query}`;
                    
                    messages.push({ role: 'user', content: finalUserContent });

                     const resp = await requestUrl({
                        url: 'https://api.openai.com/v1/chat/completions',
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${this.settings.geminiApiKey || this.settings.apiKey}`,
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
                    finalAnswer = resp.json.choices[0].message.content;
                }
            } catch (error: any) {
                                  
                 
                 if (this.stopProcessing) {
                     
                     const stopSources = documentsUsedForGeneration.map(result => ({
                         path: result.path,
                         relevance: Math.round(result.similarity * 100)
                     }));
                     return { answer: "Vault search stopped by user.", sources: stopSources };
                 }
                 
                 
                  if (error instanceof GroqApiError) {
                      if (error.status === 429) {
                          
                          throw new Error(`Groq API rate limit exceeded`);
                      } else {
                         
                         
                         if (!this.settings.autoModeEnabled) {
                             new Notice(error.message);
                         }
                         throw new Error(`Groq API error: ${error.message}`);
                     }
                 }
                 
                  else if (error instanceof OllamaApiError) {
                      if (error.status === 429) {
                          
                          throw new Error(`Ollama API rate limit exceeded`);
                      } else {
                         
                         
                         if (!this.settings.autoModeEnabled) {
                             new Notice(error.message);
                         }
                         throw new Error(`Ollama API error: ${error.message}`);
                     }
                 }
                  
                  else if (error.status === 429) { 
                       
                       throw new Error(`API rate limit exceeded`);
                  } else if (error instanceof Error) {
                      
                      throw new Error(`Failed to generate response: ${error.message}`);
                 } else {
                     
                     throw new Error(`Failed to generate response: An unknown error occurred.`);
                 }
            }

            this.reportProgress(1, 1, 'Processing complete.');

        
        if (enableInlineCitations && finalAnswer && citationSourcesMapping.length > 0) {
            
            
            
            finalAnswer = this.validateAndFilterCitations(finalAnswer, citationSourcesMapping, finalFilteredContent);

            
            const citationRegex = /\[\^(\d+)\]/g;
            const citationsUsed = new Set<number>();
            let match;
            while ((match = citationRegex.exec(finalAnswer)) !== null) {
                citationsUsed.add(parseInt(match[1]));
            }
            
            if (citationsUsed.size > 0) {
                
                const footnoteDefinitions = Array.from(citationsUsed)
                    .sort((a, b) => a - b)
                    .map(num => {
                        const source = citationSourcesMapping[num - 1]; 
                        if (source) {
                            return `[^${num}]: [[${source.path}]]`;
                        }
                        return null;
                    })
                    .filter(def => def !== null)
                    .join('\n');
                
                if (footnoteDefinitions) {
                    finalAnswer += `\n\n${footnoteDefinitions}`;
                }
            } else {
                
                            }
        }

        
        
        const finalSources = documentsUsedForGeneration.map(result => ({
            path: result.path,
            relevance: Math.round(result.similarity * 100)
        }));
        
        
        if (!totalTokens && finalAnswer) {
            
            const inputTokens = Math.ceil((formattedVaultContent + query).length / 4);
            const outputTokens = Math.ceil(finalAnswer.length / 4);
            totalTokens = inputTokens + outputTokens;
        }

        return { answer: finalAnswer, sources: finalSources, totalTokens };
    }

     
    private reportProgress(step: number, totalSteps: number, message: string, contentSnippet?: string) {
        this.progressCallback(step, totalSteps, message, contentSnippet);
    }

    /**
     * Filters and sorts content based on similarity scores.
     * Returns only the content above the similarity threshold.
     */
    private filterRelevantContent(content: VaultSearchResult[]): VaultSearchResult[] {
        const filteredContent = content
            .filter(doc => doc.similarity >= VaultSearchAgent.MINIMUM_SIMILARITY_THRESHOLD)
            .sort((a, b) => b.similarity - a.similarity);

        
        if (filteredContent.length === 0 && content.length > 0) {
            content.sort((a, b) => b.similarity - a.similarity);
            return content.slice(0, 3); 
        }

        return filteredContent;
    }

    /**
     * Validates inline citations in the AI's answer against the actual source content.
     *
     * Problem: BM25 can surface docs with high keyword frequency that weren't actually
     * used by the AI to form its answer. The AI may cite them simply because they were
     * listed in the source map, not because their content contributed to the response.
     *
     * Solution: For each [^N] citation in the answer, check whether the paragraph that
     * contains it shares meaningful term overlap with the cited doc's content. If the
     * overlap is below a minimum threshold, the citation is spurious and gets removed.
     *
     * High-similarity docs (genuinely relevant) get a lower overlap requirement since
     * the embeddings/BM25 already confirmed their relevance. Low-similarity docs (BM25
     * keyword hits that may not be truly relevant) require stronger textual evidence.
     */
    private validateAndFilterCitations(
        answer: string,
        citationSourcesMapping: Array<{ path: string; relevance: number }>,
        finalFilteredContent: VaultSearchResult[]
    ): string {
        
        const STOPWORDS = new Set([
            'a','an','the','and','or','but','in','on','at','to','for','of','with',
            'is','are','was','were','be','been','being','have','has','had','do','does',
            'did','will','would','could','should','may','might','shall','can','need',
            'this','that','these','those','it','its','i','you','he','she','we','they',
            'not','no','so','if','as','by','from','up','about','into','through','during',
            'what','which','who','when','where','how','all','each','more','also','than',
            'then','just','because','while','although','however','therefore','thus'
        ]);

        const tokenize = (text: string): Set<string> => {
            const tokens = text.toLowerCase()
                .replace(/[^a-z0-9\s]/g, ' ')
                .split(/\s+/)
                .filter(t => t.length > 2 && !STOPWORDS.has(t));
            return new Set(tokens);
        };

        
        const overlapScore = (a: Set<string>, b: Set<string>): number => {
            if (a.size === 0 || b.size === 0) return 0;
            let intersection = 0;
            for (const t of a) { if (b.has(t)) intersection++; }
            return intersection / Math.min(a.size, b.size); 
        };

        
        const paragraphs = answer.split(/\n+/);

        
        const citationParagraphs = new Map<number, string[]>();
        const citationRegex = /\[\^(\d+)\]/g;
        for (const para of paragraphs) {
            let m: RegExpExecArray | null;
            citationRegex.lastIndex = 0;
            while ((m = citationRegex.exec(para)) !== null) {
                const num = parseInt(m[1]);
                if (!citationParagraphs.has(num)) citationParagraphs.set(num, []);
                citationParagraphs.get(num)!.push(para);
            }
        }

        
        const invalidCitations = new Set<number>();

        for (const [num, paras] of citationParagraphs) {
            const sourceIdx = num - 1; 
            const sourceMeta = citationSourcesMapping[sourceIdx];
            const sourceDoc = finalFilteredContent[sourceIdx];

            if (!sourceMeta || !sourceDoc) {
                
                invalidCitations.add(num);
                continue;
            }

            
            
            
            const similarityPct = sourceMeta.relevance; 
            if (similarityPct >= 40) {
                
                continue;
            }

            
            const docTokens = tokenize(sourceDoc.content);
            let maxOverlap = 0;
            for (const para of paras) {
                
                const cleanPara = para.replace(/\[\^\d+\]/g, '');
                const paraTokens = tokenize(cleanPara);
                const score = overlapScore(paraTokens, docTokens);
                if (score > maxOverlap) maxOverlap = score;
            }

            
            if (maxOverlap < 0.15) {
                                invalidCitations.add(num);
            }
        }

        if (invalidCitations.size === 0) return answer;

        
        let cleaned = answer.replace(/\[\^(\d+)\]/g, (match, numStr) => {
            return invalidCitations.has(parseInt(numStr)) ? '' : match;
        });

        
        cleaned = cleaned.replace(/  +/g, ' ').replace(/ \./g, '.').replace(/ ,/g, ',');

                return cleaned;
    }
}
