import { AISettings } from '../settings';
import { GoogleGenerativeAI, Part } from '@google/generative-ai';
import { RateLimitManager } from '../utils/rateLimitManager';
import { GeminiService } from './geminiService';
import { YouTubeTranscriptService } from './youtubeTranscriptService';
import { Notice } from 'obsidian';
import { OllamaService } from './ollamaService';
import { GroqService } from './groqService';
import { OpenRouterService } from './openRouterService';
import { UnifiedProviderManager } from './unifiedProviderManager';

export class YouTubeChatService {
    private settings: AISettings;
    private rateLimitManager: RateLimitManager;
    private transcriptService: YouTubeTranscriptService;

    constructor(settings: AISettings, rateLimitManager: RateLimitManager) {
        this.settings = settings;
        this.rateLimitManager = rateLimitManager;
        this.transcriptService = new YouTubeTranscriptService();
    }

    /**
     * Processes a YouTube URL query using the configured processing mode.
     * For Gemini native mode, processes the video directly.
     * For transcript mode, this method can use any provider (Gemini, Groq, OpenRouter, Ollama).
     * 
     * @param youtubeUrl The YouTube video URL.
     * @param promptText The user's prompt/question.
     * @param onStream Optional callback for streaming response chunks.
     * @returns The AI's response.
     */
    async process(youtubeUrl: string, promptText: string, onStream?: (chunk: string) => void): Promise<string> {
        // Check if using Gemini native mode
        if (this.settings.youtubeProcessingMode === 'gemini-native') {
            return await this.processWithGeminiNative(youtubeUrl, promptText, onStream);
        }
        
        // For transcript mode, use the selected provider
        return await this.processWithTranscript(youtubeUrl, promptText);
    }

    /**
     * Processes YouTube video using transcript mode with any provider.
     * This method extracts the transcript and sends it to the selected AI provider.
     * 
     * @param youtubeUrl The YouTube video URL
     * @param promptText The user's prompt/question
     * @returns The AI's response
     */
    private async processWithTranscript(youtubeUrl: string, promptText: string): Promise<string> {
        // Validate URL
        if (!this.transcriptService.isValidYouTubeUrl(youtubeUrl)) {
            throw new Error('Invalid YouTube URL format. Please provide a valid YouTube video link.');
        }

        // Get transcript
        const transcript = await this.getTranscriptOnly(youtubeUrl);
        
        // Build prompt with transcript context
        const systemPrompt = `You are an AI assistant analyzing a YouTube video transcript. Answer the user's question based on the transcript provided.`;
        const fullPrompt = `${systemPrompt}\n\nTranscript:\n${transcript}\n\nQuestion: ${promptText}`;
        
        // Route to appropriate provider
        const provider = this.settings.provider;
        
        if (provider === 'gemini') {
            if (!this.settings.geminiApiKey || this.settings.geminiApiKey.length === 0) {
                throw new Error('Gemini API key is not set. Please configure it in settings.');
            }
            
            const geminiService = new GeminiService(
                this.settings.geminiApiKey,
                (headers) => this.rateLimitManager.updateFromHeaders('gemini', this.settings.model, headers)
            );
            
            const model = geminiService.getGenerativeModel({ model: this.settings.model });
            const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: fullPrompt }] }] });
            return result.response.text();
        } else if (provider === 'groq') {
            if (!this.settings.groqApiKey || this.settings.groqApiKey.length === 0) {
                throw new Error('Groq API key is not set. Please configure it in settings.');
            }
            
            const groqService = new GroqService(
                this.settings.groqApiKey,
                (headers) => this.rateLimitManager.updateFromHeaders('groq', this.settings.model, headers)
            );
            
            const youtubeMessages = [
                    { role: 'system' as const, content: systemPrompt },
                    { role: 'user' as const, content: `Transcript:\n${transcript}\n\nQuestion: ${promptText}` }
                ];
            return await groqService.generateContent(
                this.settings.model,
                youtubeMessages,
                { temperature: 0.7, topP: 0.95 }
            );
        } else if (provider === 'openrouter') {
            if (!this.settings.openRouterApiKey || this.settings.openRouterApiKey.length === 0) {
                throw new Error('OpenRouter API key is not set. Please configure it in settings.');
            }
            
            const openRouterService = new OpenRouterService(
                this.settings.openRouterApiKey,
                (headers) => this.rateLimitManager.updateFromHeaders('openrouter', this.settings.model, headers)
            );
            
            return await openRouterService.generateContent(
                this.settings.model,
                [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Transcript:\n${transcript}\n\nQuestion: ${promptText}` }
                ],
                { temperature: 0.7, topP: 0.95 }
            );
        } else if (provider === 'ollama') {
            if (this.settings.ollamaMode === 'cloud' && (!this.settings.ollamaApiKey || this.settings.ollamaApiKey.length === 0)) {
                throw new Error('Ollama API key is not set for cloud mode. Please configure it in settings.');
            }
            
            const ollamaService = new OllamaService(
                this.settings.ollamaBaseUrl,
                this.settings.ollamaApiKey,
                (headers) => this.rateLimitManager.updateFromHeaders('ollama', this.settings.model, headers)
            );
            
            return await ollamaService.generateContent(
                this.settings.model,
                [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Transcript:\n${transcript}\n\nQuestion: ${promptText}` }
                ],
                { temperature: 0.7, topP: 0.95 }
            );
        } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
            const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
            const response = await unifiedProvider.generateContent(
                this.settings.model,
                [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Transcript:\n${transcript}\n\nQuestion: ${promptText}` }
                ],
                { temperature: 0.7, topP: 0.95 }
            );
            return response.text;
        } else {
            throw new Error(`Unsupported provider: ${provider}`);
        }
    }

    /**
     * Processes YouTube video using Gemini's native multimodal API.
     * This method sends the video URL directly to Gemini for processing.
     * 
     * @param youtubeUrl The YouTube video URL
     * @param promptText The user's prompt/question
     * @param onStream Optional callback for streaming response chunks.
     * @returns The AI's response
     */
    private async processWithGeminiNative(youtubeUrl: string, promptText: string, onStream?: (chunk: string) => void): Promise<string> {
        if (!this.settings.geminiApiKey || this.settings.geminiApiKey.length === 0) {
            throw new Error('Gemini API key is not set. Please configure it in settings or use transcript mode.');
        }

        // Validate URL
        if (!this.transcriptService.isValidYouTubeUrl(youtubeUrl)) {
            throw new Error('Invalid YouTube URL format. Please provide a valid YouTube video link.');
        }

        const geminiService = new GeminiService(
            this.settings.geminiApiKey,
            (headers) => this.rateLimitManager.updateFromHeaders('gemini', this.settings.model, headers)
        );
        
        // For multimodal content (YouTube videos), we need to use a Gemini model
        // Use gemini-2.5-flash as it supports video processing
        const geminiModel = this.settings.model.startsWith('gemini') ? this.settings.model : 'gemini-2.5-flash';
        const model = geminiService.getGenerativeModel({ model: geminiModel });
        
        const parts: Part[] = [
            { text: promptText },
            {
                fileData: {
                    mimeType: 'video/mp4',
                    fileUri: youtubeUrl,
                },
            },
        ];

        try {
            if (onStream) {
                const result = await model.generateContentStream({ contents: [{ role: 'user', parts }] });
                let fullText = '';
                for await (const chunk of result.stream) {
                    const chunkText = chunk.text();
                    fullText += chunkText;
                    onStream(chunkText);
                }
                return fullText;
            } else {
                const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
                const response = result.response;
                return response.text();
            }
        } catch (error: SafeAny) {
            if (error.status === 400 && error.message?.includes('Invalid `file_uri`')) {
                throw new Error('The YouTube URL might be invalid or inaccessible to the Gemini API. Ensure it is a public video.');
            }
            throw new Error(error.message || 'Failed to process YouTube video with Gemini.');
        }
    }

    /**
     * Gets the transcript only (without AI processing).
     * Useful for saving transcripts or using them elsewhere.
     * Auto-detects the best available language.
     * 
     * @param youtubeUrl The YouTube video URL
     * @returns The transcript text
     */
    async getTranscriptOnly(youtubeUrl: string): Promise<string> {
        return await this.transcriptService.getTranscript(youtubeUrl);
    }

    /**
     * Gets the video title from a YouTube URL.
     * 
     * @param youtubeUrl The YouTube video URL
     * @returns The video title
     */
    async getVideoTitle(youtubeUrl: string): Promise<string> {
        return await this.transcriptService.getVideoTitle(youtubeUrl);
    }
} 