import { App, TFile, Notice, Vault, requestUrl } from 'obsidian';
import { AISettings, CustomEmbeddingModel, getProviderForEmbeddingModel } from '../settings';
import { extractTextFromPdf } from '../utils/pdfExtractor';
import { parseTemporalQuery } from '../utils/temporalFilter';
import { OramaWorkerManager } from '../utils/oramaWorkerManager';

interface DocumentChunk {
    path: string;
    chunkIndex: number;
    content: string;
    embedding: number[];
    lastModified: number;
    hasEmbedding?: boolean;
    metadata?: {
        title?: string;
        headings?: string;
        tags?: string;
        isFirstChunk?: boolean;
    };
}

interface SearchIndex {
    documents: DocumentChunk[];
    lastUpdated: number;
    version: number; // Index version for migration detection
    model?: string; // Embedding model used for this index

}

// Current index version - increment when index structure changes
const INDEX_VERSION = 6; // Incremented for Orama integration

export class EmbeddingsManager {
    public index: SearchIndex = { documents: [], lastUpdated: 0, version: INDEX_VERSION };
    private indexCache: Map<string, { index: SearchIndex }> = new Map();
    private static readonly MAX_CACHED_INDEXES = 5;
    private cacheAccessOrder: string[] = []; // Tracks LRU order for cache eviction
    private isLoadingIndex: boolean = false; // Flag to prevent concurrent index loads
    private loadedIndexId: string | null = null; // Track which index is currently loaded in memory
    private pausedIndexIds: Set<string> = new Set();
    private activeBuilds: Map<string, { progress: number; fileStatus?: string; type: 'embedding' | 'bm25' }> = new Map();
    private buildCallbacks: Map<string, Set<(status: string) => void>> = new Map();
    private buildNotice: Notice | null = null;
    
    // Chunk size configuration for document splitting
    // Both Gemini and OpenRouter: Target ~1000 tokens per chunk
    private static readonly CHUNK_SIZE_CHARS_GEMINI = 2000;
    private static readonly CHUNK_SIZE_CHARS_OPENROUTER = 4000;
    // Overlap between chunks to preserve context at boundaries (~50 tokens = 200 chars)
    private static readonly CHUNK_OVERLAP_CHARS = 200;
    
    // Maximum content size for embedding generation (to avoid API limits)
    // Google's embedding models have ~2048 token limit per request
    // Using conservative limit to stay well under limit
    private static readonly MAX_EMBEDDING_CHARS_GEMINI = 3000;
    // OpenRouter models typically support 8192 tokens
    // Using conservative 8000 tokens = 32000 chars to stay well under limit
    private static readonly MAX_EMBEDDING_CHARS_OPENROUTER = 32000;
    // Ollama embedding models (all-minilm, nomic-embed-text, etc.) have smaller context windows
    // all-minilm supports ~256 tokens
    // Multi-byte Unicode (Hindi, etc.) uses more tokens, safe limit is ~500 chars
    private static readonly MAX_EMBEDDING_CHARS_OLLAMA = 500;
    private static readonly CHUNK_SIZE_CHARS_OLLAMA = 400;
    private static readonly CHUNK_OVERLAP_CHARS_OLLAMA = 40;
    // NVIDIA NIM embedding models support up to 4096 tokens
    // Using conservative limit for small inputs (512-600 range requested)
    private static readonly MAX_EMBEDDING_CHARS_NVIDIA = 5000;
    private static readonly CHUNK_SIZE_CHARS_NVIDIA = 1500;
    private static readonly CHUNK_OVERLAP_CHARS_NVIDIA = 150;

    // Batch size configuration for batch processing
    private static readonly BATCH_SIZE_GEMINI = 10;
    private static readonly BATCH_SIZE_OPENROUTER = 60;
    private static readonly BATCH_SIZE_NVIDIA = 128;
    private static readonly BATCH_SIZE_OLLAMA = 32;
    
    constructor(
        private app: App,
        private settings: AISettings
    ) {
        // Don't load index on construction - it will be loaded lazily on first use
        // This significantly improves plugin startup time
    }

    /**
     * Convert an index display name to a safe filename slug.
     * e.g. "Default Embedding Index" → "default-embedding-index"
     */
    private slugifyName(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    private touchCacheAccess(id: string): void {
        this.cacheAccessOrder = this.cacheAccessOrder.filter(k => k !== id);
        this.cacheAccessOrder.push(id);
        if (this.cacheAccessOrder.length > EmbeddingsManager.MAX_CACHED_INDEXES) {
            const oldest = this.cacheAccessOrder.shift();
            if (oldest && oldest !== this.loadedIndexId) {
                this.indexCache.delete(oldest);
            }
        }
    }

    /**
     * Get the file path for a specific index configuration.
     * - Embedding indexes → .Nexus-LM-data/vault-embeddings/<slug>.bin
     * - BM25 indexes      → .Nexus-LM-data/vault-bm25/<slug>.bin
     * The filename is derived from the index's display name so it is human-readable
     * in the file explorer.
     */
    public getIndexFilePath(indexId: string): string {
        const config = this.settings.indexConfigurations?.find((c: any) => c.id === indexId);
        const isBM25 = config?.type === 'bm25';
        const folder = isBM25
            ? '.Nexus-LM-data/vault-bm25'
            : '.Nexus-LM-data/vault-embeddings';
        // Use slugified display name when available, fall back to the ID
        const slug = config?.name ? this.slugifyName(config.name) : indexId;
        return `${folder}/${slug}.bin`;
    }

    public async syncIndexFiles(): Promise<boolean> {
        const adapter = this.app.vault.adapter;
        const dirs = [
            { type: 'embedding' as const, path: '.Nexus-LM-data/vault-embeddings' },
            { type: 'bm25' as const, path: '.Nexus-LM-data/vault-bm25' }
        ];

        let settingsChanged = false;

        for (const dir of dirs) {
            if (!(await adapter.exists(dir.path))) continue;

            const listed = await adapter.list(dir.path);
            const files = listed.files.filter(f => f.endsWith('.bin'));

            for (const file of files) {
                // Get just the filename slug without extension
                const fileName = file.substring(file.lastIndexOf('/') + 1);
                const slug = fileName.substring(0, fileName.lastIndexOf('.bin'));
                
                // Check if this file maps to an existing configuration
                // We compare the slug of the file with the slug that would be generated by each config
                const existingConfig = this.settings.indexConfigurations.find((c: any) => {
                    if (c.type !== dir.type) return false;
                    const cSlug = c.name ? this.slugifyName(c.name) : c.id;
                    return cSlug === slug;
                });

                if (!existingConfig) {
                                        
                    let model = undefined;
                    let fileCount = 0;
                    let lastUpdated = Date.now();

                    try {
                        const data = await adapter.readBinary(file);
                        
                        // Use Orama worker to load and then get metadata
                        const tempId = `sync-${Math.random().toString(36).substring(2, 7)}`;
                        const schema = {
                            id: 'string',
                            path: 'string',
                            chunkIndex: 'number',
                            title: 'string',
                            headings: 'string',
                            tags: 'string',

                            content: 'string',
                            lastModified: 'number'
                        };

                        await OramaWorkerManager.getInstance().load(tempId, data, schema, true);
                        const response = await OramaWorkerManager.getInstance().getMetadata(tempId);
                        const metadata = response.metadata;
                        await OramaWorkerManager.getInstance().clear(tempId); // Clear temp instance

                        if (!metadata) continue;

                        // Extract model from index
                        model = metadata.model;
                        fileCount = metadata.fileCount || 0;
                        lastUpdated = metadata.lastUpdated || Date.now();
                    } catch (e) {
                                                continue;
                    }

                    if (dir.type === 'embedding' && !model) {
                        model = this.settings.customEmbeddingModels?.find(m => m.enabled)?.id || 'text-embedding-004';
                    }

                    // Create recovered configuration with a clean name and deterministic ID
                    const recoveredName = slug
                        .split('-')
                        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                        .join(' ');

                    const newConfig = {
                        id: `${dir.type}-${slug}`, // Deterministic ID based on type and slug
                        type: dir.type,
                        name: recoveredName,
                        model: dir.type === 'embedding' ? model : undefined,
                        enabled: false,
                        fileCount: fileCount,
                        lastUpdated: lastUpdated,
                    };

                    this.settings.indexConfigurations.push(newConfig);
                    settingsChanged = true;
        }
    }
}

        return settingsChanged;
    }

    /**
     * Pauses an active index build.
     */
    public pauseIndexBuild(indexId: string): void {
        this.pausedIndexIds.add(indexId);
            }

    /**
     * Resumes an index build if it was paused.
     */
    public resumeIndexBuild(indexId: string): void {
        this.pausedIndexIds.delete(indexId);
            }

    /**
     * Gets the current progress of an active build.
     */
    public getActiveBuildProgress(indexId: string): { progress: number; fileStatus?: string } | null {
        return this.activeBuilds.get(indexId) || null;
    }

    /**
     * Checks if an index is currently being built.
     */
    public isIndexBuilding(indexId: string): boolean {
        return this.activeBuilds.has(indexId);
    }

    /**
     * Updates or creates the persistent build notice.
     */
    private updateBuildNotice(message: string, isFinished = false): void {
        if (isFinished) {
            if (this.buildNotice) {
                this.buildNotice.setMessage(message);
                // Allow the notice to disappear after a few seconds
                setTimeout(() => {
                    this.buildNotice = null;
                }, 5000);
            } else {
                new Notice(message);
            }
            return;
        }

        if (!this.buildNotice) {
            this.buildNotice = new Notice(message, 0); // Persistent
        } else {
            this.buildNotice.setMessage(message);
        }
    }

    /**
     * Notifies all registered callbacks for a specific build.
     */
    private notifyBuildCallbacks(indexId: string, status: string): void {
        const callbacks = this.buildCallbacks.get(indexId);
        if (callbacks) {
            callbacks.forEach(cb => {
                try {
                    cb(status);
                } catch (e) {
                                    }
            });
        }
    }

    /**
     * Physically deletes the index file from the vault's storage.
     */
    public async deleteIndexFile(indexId: string): Promise<boolean> {
        try {
            const indexPath = this.getIndexFilePath(indexId);
            const adapter = this.app.vault.adapter;

            if (await adapter.exists(indexPath)) {
                await adapter.remove(indexPath);
                                return true;
            }
            return false;
        } catch (error) {
                        return false;
        }
    }
    private getSelectedEmbeddingIndex(): { id: string; model: string } | null {
        const selectedId = this.settings.selectedEmbeddingIndexId;
        if (!selectedId) return null;

        const indexConfig = this.settings.indexConfigurations?.find(
            idx => idx.id === selectedId && idx.type === 'embedding'
        );

        if (!indexConfig || !indexConfig.model) return null;

        return {
            id: indexConfig.id,
            model: indexConfig.model
        };
    }

    /**
     * Get the currently selected BM25 index configuration
     */
    private getSelectedBM25Index(): { id: string } | null {
        const selectedId = this.settings.selectedBM25IndexId;
        if (!selectedId) return null;

        const indexConfig = this.settings.indexConfigurations?.find(
            idx => idx.id === selectedId && idx.type === 'bm25'
        );

        if (!indexConfig) return null;

        return {
            id: indexConfig.id
        };
    }

    /**
     * Initialize Orama in the worker for a specific index
     */
    private async initializeOrama(instanceId: string): Promise<void> {
        // Find if this is a BM25 or embedding index
        const indexConfig = this.settings.indexConfigurations?.find(c => c.id === instanceId);
        const isBM25 = indexConfig?.type === 'bm25';
        
        const schema: any = {
            id: 'string',
            path: 'string',
            chunkIndex: 'number',
            title: 'string',
            headings: 'string',
            tags: 'string',
            content: 'string',
            lastModified: 'number'
        };

        if (!isBM25) {
            schema.embedding = 'vector[1]'; // Dummy dimension, refined by worker on actual use
        }

        const metadata: any = {};
        if (indexConfig?.model) {
            metadata.model = indexConfig.model;
        }
        await OramaWorkerManager.getInstance().init(instanceId, schema, metadata);
    }

    private _embeddingTokenLimit: number = 0; // Default or custom token limit
    private _embeddingRequestLimit: number = 0; // Default or custom request limit
    private _lastResetTime: number = Date.now();
    private _currentRequestCount: number = 0;
    private _currentTokenCount: number = 0;

    private _initializeRateLimits(): void {
      const { embeddingModel } = this.settings;
      let tokenLimit = 0;
      let requestLimit = 0;

      // Check custom embedding models (supports both Gemini and OpenRouter)
      const provider = getProviderForEmbeddingModel(embeddingModel, this.settings);
      const customEmbeddingModel = this.settings.customEmbeddingModels.find(
        model => model.id === embeddingModel
      );
      
      // Use custom model's rate limit if specified
      if (customEmbeddingModel || provider !== 'gemini') {
        // OpenRouter models typically have different rate limits
        if (provider === 'openrouter') {
          tokenLimit = 100000; // Conservative token limit for OpenRouter
          requestLimit = customEmbeddingModel?.requestsPerMinute || 1000;
        } else if (provider === 'nvidia') {
          tokenLimit = 100000; // Conservative limit for NVIDIA
          requestLimit = customEmbeddingModel?.requestsPerMinute || 30; // High tier RPM
        } else if (provider === 'ollama') {
          tokenLimit = 0; // No limit for local Ollama
          requestLimit = 0;
        } else {
          // Gemini models (embedding-001, etc.)
          tokenLimit = 30000; // Google Gemini free tier: 30k tokens per minute
          requestLimit = customEmbeddingModel?.requestsPerMinute || 1500;
        }
      } else {
        // Default to Gemini limits if model not found
        tokenLimit = 30000;
        requestLimit = 1500;
      }
      this._embeddingTokenLimit = tokenLimit;
      this._embeddingRequestLimit = requestLimit;
    }

    // Token estimation using character count (more accurate than word count)
    // Conservative heuristic: 1 token ≈ 3 characters (safer for dense text)
    private _getTokenCount(text: string): number {
      if (!text) return 0;
      return Math.ceil(text.length / 3);
    }

    private async _waitForRateLimitClearance(tokens: number): Promise<void> {
      const now = Date.now();
      const oneMinute = 60 * 1000;

      // If a new minute has started, reset counts
      if (now - this._lastResetTime >= oneMinute) {
        this._currentRequestCount = 0;
        this._currentTokenCount = 0;
        this._lastResetTime = now;
      }

      // Check if limits are defined
      const hasTokenLimit = this._embeddingTokenLimit > 0;
      const hasRequestLimit = this._embeddingRequestLimit > 0;

      let delayNeeded = 0; // in milliseconds

      // Calculate delay based on token limit
      if (hasTokenLimit && (this._currentTokenCount + tokens > this._embeddingTokenLimit)) {
        const timeElapsedInMinute = now - this._lastResetTime;
        const timeLeftInMinute = oneMinute - timeElapsedInMinute;
        delayNeeded = Math.max(delayNeeded, timeLeftInMinute + 100); // Add a small buffer
      }

      // Smart adaptive rate limiting for requests
      // Instead of waiting for the full minute to reset, we distribute requests evenly
      if (hasRequestLimit && this._embeddingRequestLimit > 0) {
        const timeElapsedInMinute = now - this._lastResetTime;
        const requestsRemaining = this._embeddingRequestLimit - this._currentRequestCount;
        
        // If we're approaching the limit, calculate optimal delay
        if (requestsRemaining <= 0) {
          // We've hit the limit, wait for the minute to reset
          const timeLeftInMinute = oneMinute - timeElapsedInMinute;
          delayNeeded = Math.max(delayNeeded, timeLeftInMinute + 100);
        } else if (this._currentRequestCount > 0) {
          // Adaptive pacing: distribute remaining requests across remaining time
          // This prevents bursting and keeps indexing smooth
          const timeRemainingInMinute = oneMinute - timeElapsedInMinute;
          const optimalDelayPerRequest = timeRemainingInMinute / requestsRemaining;
          
          // Use a safety margin (80% of limit) to prevent hitting the exact limit
          const safetyThreshold = this._embeddingRequestLimit * 0.8;
          
          if (this._currentRequestCount >= safetyThreshold) {
            // We're in the safety zone, slow down significantly
            const minDelay = Math.max(100, optimalDelayPerRequest * 1.2);
            delayNeeded = Math.max(delayNeeded, minDelay);
          } else if (this._currentRequestCount > this._embeddingRequestLimit * 0.5) {
            // We're past halfway, start pacing
            const minDelay = Math.max(50, optimalDelayPerRequest * 0.8);
            delayNeeded = Math.max(delayNeeded, minDelay);
          }
          // Below 50% usage: no artificial delay, go full speed
        }
      }

      if (delayNeeded > 0) {
        await new Promise(resolve => setTimeout(resolve, delayNeeded));
        // After waiting, re-check and potentially reset if enough time has passed
        const afterDelay = Date.now();
        if (afterDelay - this._lastResetTime >= oneMinute) {
            this._currentRequestCount = 0;
            this._currentTokenCount = 0;
            this._lastResetTime = afterDelay;
        }
      }

      // Update counts after clearance
      this._currentRequestCount++;
      this._currentTokenCount += tokens;
    }

    private extractHeadings(content: string): string {
        const headings: string[] = [];
        for (const line of content.split('\n')) {
            const match = line.trimStart().match(/^#{1,6}\s+(.+)/);
            if (match) headings.push(match[1].trim());
        }
        return headings.join(' ');
    }

    private extractTags(content: string): string {
        const tags: string[] = [];
        for (const line of content.split('\n')) {
            if (/^#{1,6}\s/.test(line.trimStart())) continue;
            const matches = line.match(/(?:^|\s)#([A-Za-z0-9_\-/.]+)/g);
            if (matches) {
                for (const m of matches) {
                    const t = m.trim().substring(1);
                    if (t) tags.push(t);
                }
            }
        }
        return tags.join(' ');
    }

    /**
     * Split document content into smaller chunks for more granular embeddings.
     * Uses sentence-aware splitting to avoid breaking mid-sentence when possible.
     * @param content - The content to split
     * @param chunkSize - Optional chunk size in characters (defaults based on provider)
     */
    private splitIntoChunks(content: string, chunkSize?: number): string[] {
        if (!content || content.trim().length === 0) {
            return [];
        }

        const currentModel = this.settings.embeddingModel;
        const provider = getProviderForEmbeddingModel(currentModel, this.settings);

        // Determine chunk size based on provider and specific model if not specified
        if (!chunkSize) {
            if (provider === 'nvidia') {
                // Legacy NVIDIA models with small 512-token context windows
                const isLegacyNvidia = currentModel.includes('nv-embedqa-e5-v5') || currentModel.includes('nv-embed-v1');
                chunkSize = isLegacyNvidia ? 1500 : 4000;
            } else {
                chunkSize = provider === 'openrouter' 
                    ? EmbeddingsManager.CHUNK_SIZE_CHARS_OPENROUTER 
                    : provider === 'ollama'
                    ? EmbeddingsManager.CHUNK_SIZE_CHARS_OLLAMA
                    : provider === 'nvidia'
                    ? EmbeddingsManager.CHUNK_SIZE_CHARS_NVIDIA
                    : EmbeddingsManager.CHUNK_SIZE_CHARS_GEMINI;
            }
        }

        // Determine overlap (generally 10% of chunk size)
        const overlap = provider === 'ollama'
            ? EmbeddingsManager.CHUNK_OVERLAP_CHARS_OLLAMA
            : Math.floor(chunkSize * 0.1);
        
        
        // If content is smaller than chunk size, return as single chunk
        if (content.length <= chunkSize) {
            return [content.trim()];
        }

        const chunks: string[] = [];
        let startIndex = 0;
        while (startIndex < content.length) {
            let endIndex = Math.min(startIndex + chunkSize, content.length);
            
            // If not at the end, try to find a good break point (sentence end)
            if (endIndex < content.length) {
                // Look for sentence endings within the last 20% of the chunk
                const searchStart = startIndex + Math.floor(chunkSize * 0.8);
                const searchRegion = content.substring(searchStart, endIndex);
                
                // Find last sentence-ending punctuation followed by space or newline
                const sentenceEndMatch = searchRegion.match(/[.!?]\s+(?=[A-Z])|[.!?]\n|\n\n/g);
                if (sentenceEndMatch) {
                    const lastMatch = sentenceEndMatch[sentenceEndMatch.length - 1];
                    const matchIndex = searchRegion.lastIndexOf(lastMatch);
                    if (matchIndex !== -1) {
                        endIndex = searchStart + matchIndex + lastMatch.length;
                    }
                }
            }

            const chunk = content.substring(startIndex, endIndex).trim();
            if (chunk.length > 0) {
                chunks.push(chunk);
            }

            // Move start index, accounting for overlap
            startIndex = endIndex - overlap;
            
            // Prevent infinite loop if overlap is larger than remaining content
            if (startIndex >= content.length - overlap) {
                break;
            }
        }

        return chunks;
    }

    async getEmbedding(text: string, isQuery: boolean = false): Promise<number[]> {
        try {
            const { embeddingModel, geminiApiKey, openRouterApiKey } = this.settings;
            
                        
            // Determine provider for the embedding model
            const provider = getProviderForEmbeddingModel(embeddingModel, this.settings);
            
                        
            // Debug: log chunk size
                        
            // Validate API key based on provider
            if (provider === 'openrouter') {
                if (!openRouterApiKey || openRouterApiKey.trim() === '') {
                                        throw new Error('OpenRouter API key is required for OpenRouter embeddings. Please configure your OpenRouter API key in settings.');
                }
                            } else if (provider === 'ollama') {
                // Ollama doesn't require API key for local instances
                            } else if (provider === 'nvidia') {
                if (!this.settings.nvidiaApiKey || this.settings.nvidiaApiKey.trim() === '') {
                                        throw new Error('NVIDIA API key is required for NVIDIA embeddings. Please configure your NVIDIA API key in settings.');
                }
                            } else {
                // Check if it's a custom provider
                const customProvider = this.settings.customProviders?.find(p => p.id === provider);
                if (customProvider && customProvider.enableEmbeddings) {
                                    } else if (!geminiApiKey || geminiApiKey.trim() === '') {
                    // Default to Gemini
                                        throw new Error('Gemini API key is required for embeddings. Please configure your Gemini API key in settings.');
                }
            }

            // Ensure rate limits are initialized before first use
            if (this._embeddingTokenLimit === 0 && this._embeddingRequestLimit === 0) {
                this._initializeRateLimits();
            }

            // Truncate content if it exceeds maximum size for embedding API
            // Note: We only truncate for embedding generation, full content is still stored in index
            let contentForEmbedding = text;
            const maxChars = provider === 'openrouter' 
                ? EmbeddingsManager.MAX_EMBEDDING_CHARS_OPENROUTER 
                : provider === 'ollama'
                ? EmbeddingsManager.MAX_EMBEDDING_CHARS_OLLAMA
                : provider === 'nvidia'
                ? EmbeddingsManager.MAX_EMBEDDING_CHARS_NVIDIA
                : EmbeddingsManager.MAX_EMBEDDING_CHARS_GEMINI;
            
            if (text.length > maxChars) {
                contentForEmbedding = text.substring(0, maxChars);
                            }

            const tokenCount = this._getTokenCount(contentForEmbedding);
            await this._waitForRateLimitClearance(tokenCount);

            // Use appropriate provider for embeddings
            if (provider === 'openrouter') {
                                return await this.getOpenRouterEmbedding(contentForEmbedding, embeddingModel, openRouterApiKey);
            } else if (provider === 'ollama') {
                                return await this.getOllamaEmbedding(contentForEmbedding, embeddingModel);
            } else if (provider === 'nvidia') {
                                return await this.getNvidiaEmbedding(contentForEmbedding, embeddingModel, this.settings.nvidiaApiKey, isQuery);
            } else {
                // Check if it's a custom provider
                const customProvider = this.settings.customProviders?.find(p => p.id === provider);
                if (customProvider && customProvider.enableEmbeddings) {
                                        return await this.getCustomProviderEmbedding(contentForEmbedding, embeddingModel, customProvider);
                }
                
                // Default to Gemini
                                return await this.getGeminiEmbedding(contentForEmbedding, embeddingModel, geminiApiKey);
            }
        } catch (error: any) {
                        if (error.status && error.json) {
                throw new Error(`Failed to generate embedding: ${error.json?.error?.message || error.message}`);
            }
            throw new Error('Failed to generate embedding');
        }
    }

    /**
     * Get embeddings for multiple texts in a single batch request (Unified)
     */
    async getEmbeddingBatch(texts: string[], isQuery: boolean = false): Promise<number[][]> {
        try {
            const { embeddingModel, geminiApiKey, openRouterApiKey, nvidiaApiKey } = this.settings;
            
            // Determine provider for the embedding model
            const provider = getProviderForEmbeddingModel(embeddingModel, this.settings);

            // Calculate total tokens for rate limiting
            const totalTokens = texts.reduce((sum, text) => sum + this._getTokenCount(text), 0);
            
            // Wait for rate limit clearance
            await this._waitForRateLimitClearance(totalTokens);

            // Routing
            if (provider === 'openrouter') {
                return await this.getOpenRouterEmbeddingBatch(texts, embeddingModel, openRouterApiKey);
            } else if (provider === 'ollama') {
                return await this.getOllamaEmbeddingBatch(texts, embeddingModel);
            } else if (provider === 'nvidia') {
                return await this.getNvidiaEmbeddingBatch(texts, embeddingModel, nvidiaApiKey, isQuery);
            } else {
                // Check if it's a custom provider
                const customProvider = this.settings.customProviders?.find(p => p.id === provider);
                if (customProvider && customProvider.enableEmbeddings) {
                    return await this.getCustomProviderEmbeddingBatch(texts, embeddingModel, customProvider);
                }

                // Default to Gemini
                return await this.getGeminiEmbeddingBatch(texts, embeddingModel, geminiApiKey);
            }
        } catch (error) {
                        throw error;
        }
    }

    /**
     * Get embedding from a custom OpenAI-compatible provider
     */
    private async getCustomProviderEmbedding(text: string, modelId: string, provider: any): Promise<number[]> {
        try {
                        
            const baseUrl = provider.baseUrl.replace(/\/+$/, '');
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://obsidian.md',
                'X-Title': 'Nexus-LM'
            };
            if (provider.apiKey) {
                headers['Authorization'] = `Bearer ${provider.apiKey}`;
            }

            const response = await requestUrl({
                url: `${baseUrl}/embeddings`,
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: modelId,
                    input: text
                }),
                throw: false
            });
            
            if (response.status >= 400) {
                throw new Error(`${provider.name} API error: ${response.json?.error?.message || response.status}`);
            }
            
            if (!response.json || !response.json.data || !response.json.data[0] || !response.json.data[0].embedding) {
                throw new Error(`Invalid response from ${provider.name} API`);
            }
            
            return response.json.data[0].embedding;
        } catch (error) {
                        throw error;
        }
    }

    /**
     * Get embeddings from a custom OpenAI-compatible provider in batch
     */
    private async getCustomProviderEmbeddingBatch(texts: string[], modelId: string, provider: any): Promise<number[][]> {
        try {
                        
            const baseUrl = provider.baseUrl.replace(/\/+$/, '');
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://obsidian.md',
                'X-Title': 'Nexus-LM'
            };
            if (provider.apiKey) {
                headers['Authorization'] = `Bearer ${provider.apiKey}`;
            }

            const response = await requestUrl({
                url: `${baseUrl}/embeddings`,
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: modelId,
                    input: texts
                }),
                throw: false
            });
            
            if (response.status >= 400) {
                throw new Error(`${provider.name} batch API error: ${response.json?.error?.message || response.status}`);
            }
            
            if (!response.json || !response.json.data || !Array.isArray(response.json.data)) {
                throw new Error(`Invalid batch response from ${provider.name} API`);
            }
            
            return response.json.data.map((item: any) => item.embedding);
        } catch (error) {
                        throw error;
        }
    }

    /**
     * Get embedding from Google Gemini API
     */
    private async getGeminiEmbedding(text: string, modelId: string, apiKey: string): Promise<number[]> {
        // Determine the model ID to use for the API call
        let modelIdToUse = modelId || 'text-embedding-004';

        const response = await requestUrl({
            url: `https://generativelanguage.googleapis.com/v1beta/models/${modelIdToUse}:batchEmbedContents?key=${apiKey}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                requests: [{
                    model: `models/${modelIdToUse}`,
                    content: {
                        parts: [{
                            text: text
                        }]
                    }
                }]
            })
        });
        return response.json.embeddings[0].values;
    }

    /**
     * Get embeddings from Google Gemini API in batch
     */
    private async getGeminiEmbeddingBatch(texts: string[], modelId: string, apiKey: string): Promise<number[][]> {
        let modelIdToUse = modelId || 'text-embedding-004';
        
        const response = await requestUrl({
            url: `https://generativelanguage.googleapis.com/v1beta/models/${modelIdToUse}:batchEmbedContents?key=${apiKey}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                requests: texts.map(text => ({
                    model: `models/${modelIdToUse}`,
                    content: {
                        parts: [{ text }]
                    }
                }))
            })
        });

        if (!response.json || !response.json.embeddings) {
            throw new Error('Invalid response from Gemini batch API');
        }

        return response.json.embeddings.map((emb: any) => emb.values);
    }

    /**
     * Get embedding from OpenRouter API
     * OpenRouter uses OpenAI-compatible embeddings endpoint
     */
    private async getOpenRouterEmbedding(text: string, modelId: string, apiKey: string): Promise<number[]> {
        try {
                        
            const response = await requestUrl({
                url: 'https://openrouter.ai/api/v1/embeddings',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://obsidian.md',
                    'X-Title': 'Nexus-LM'
                },
                body: JSON.stringify({
                    model: modelId,
                    input: text
                }),
                throw: false
            });
            
                        
            if (response.status >= 400) {
                                throw new Error(`OpenRouter API error: ${response.json?.error?.message || response.status}`);
            }
            
            if (!response.json || !response.json.data || !response.json.data[0] || !response.json.data[0].embedding) {
                                throw new Error('Invalid response from OpenRouter API');
            }
            
            return response.json.data[0].embedding;
        } catch (error) {
                        throw error;
        }
    }

    /**
     * Get embeddings for multiple texts in a single batch request (OpenRouter)
     * This is much faster than individual requests
     */
    private async getOpenRouterEmbeddingBatch(texts: string[], modelId: string, apiKey: string): Promise<number[][]> {
        try {
                        
            const response = await requestUrl({
                url: 'https://openrouter.ai/api/v1/embeddings',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://obsidian.md',
                    'X-Title': 'Nexus-LM'
                },
                body: JSON.stringify({
                    model: modelId,
                    input: texts
                }),
                throw: false
            });
            
                        
            if (response.status >= 400) {
                                throw new Error(`OpenRouter batch API error: ${response.json?.error?.message || response.status}`);
            }
            
            if (!response.json || !response.json.data || !Array.isArray(response.json.data)) {
                                throw new Error('Invalid batch response from OpenRouter API');
            }
            
            return response.json.data.map((item: any) => item.embedding);
        } catch (error) {
                        throw error;
        }
    }

    /**
     * Get embedding from Ollama API
     * Ollama uses its own embeddings endpoint
     */
    private async getOllamaEmbedding(text: string, modelId: string): Promise<number[]> {
        try {
                        
            const baseUrl = this.settings.ollamaBaseUrl || 'http://localhost:11434';
            const isCloudMode = baseUrl.includes('ollama.com');
            
            const headers: Record<string, string> = {
                'Content-Type': 'application/json'
            };
            
            if (isCloudMode) {
                if (!this.settings.ollamaApiKey) {
                    throw new Error('API key is required for Ollama cloud mode');
                }
                headers['Authorization'] = `Bearer ${this.settings.ollamaApiKey}`;
            }
            
            const requestBody = {
                model: modelId,
                input: text
            };
            
            const response = await requestUrl({
                url: `${baseUrl}/api/embed`,
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody),
                throw: false
            });
            
                        
            if (response.status >= 400) {
                                throw new Error(`Ollama API error: ${response.json?.error || response.status}`);
            }
            
            if (!response.json || !response.json.embeddings || !response.json.embeddings[0]) {
                                throw new Error('Invalid response from Ollama API');
            }
            
            return response.json.embeddings[0];
        } catch (error) {
                        throw error;
        }
    }

    /**
     * Get embeddings from Ollama API in batch
     */
    private async getOllamaEmbeddingBatch(texts: string[], modelId: string): Promise<number[][]> {
        try {
                        
            const baseUrl = this.settings.ollamaBaseUrl || 'http://localhost:11434';
            const isCloudMode = baseUrl.includes('ollama.com');
            
            const headers: Record<string, string> = {
                'Content-Type': 'application/json'
            };
            
            if (isCloudMode) {
                if (!this.settings.ollamaApiKey) {
                    throw new Error('API key is required for Ollama cloud mode');
                }
                headers['Authorization'] = `Bearer ${this.settings.ollamaApiKey}`;
            }
            
            const requestBody = {
                model: modelId,
                input: texts
            };
            
            const response = await requestUrl({
                url: `${baseUrl}/api/embed`,
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody),
                throw: false
            });
            
            if (response.status >= 400) {
                throw new Error(`Ollama API error: ${response.json?.error || response.status}`);
            }
            
            return response.json.embeddings;
        } catch (error) {
                        throw error;
        }
    }

    /**
     * Get embedding from NVIDIA NIM API
     * Uses NVIDIA's /v1/embeddings endpoint
     */
    private async getNvidiaEmbedding(text: string, modelId: string, apiKey: string, isQuery: boolean = false): Promise<number[]> {
        try {
                        
            const baseUrl = 'https://integrate.api.nvidia.com';
            
            const requestBody: any = {
                input: text,
                model: modelId
            };

            // Add input_type unconditionally for NVIDIA NIM models as most are asymmetric
            requestBody.input_type = isQuery ? 'query' : 'passage';
                        
            const headers: Record<string, string> = {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://obsidian.md',
                'X-Title': 'Obsidian AI Tutor'
            };
            
            // Use requestUrl to bypass CORS
            const response = await requestUrl({
                url: `${baseUrl}/v1/embeddings`,
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody),
                throw: false
            });
            
                        
            if (response.status >= 400) {
                                throw new Error(`NVIDIA API error: ${response.json?.error?.message || response.status}`);
            }
            
            if (!response.json || !response.json.data || !response.json.data[0] || !response.json.data[0].embedding) {
                                throw new Error('Invalid response from NVIDIA API');
            }
            
            return response.json.data[0].embedding;
        } catch (error) {
                        throw error;
        }
    }

    /**
     * Get embeddings from NVIDIA NIM API in batch
     */
    private async getNvidiaEmbeddingBatch(texts: string[], modelId: string, apiKey: string, isQuery: boolean = false): Promise<number[][]> {
        try {
                        
            const baseUrl = 'https://integrate.api.nvidia.com';
            const requestBody: any = {
                input: texts,
                model: modelId,
                input_type: isQuery ? 'query' : 'passage'
            };

            const headers: Record<string, string> = {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://obsidian.md',
                'X-Title': 'Obsidian AI Tutor'
            };
            
            const response = await requestUrl({
                url: `${baseUrl}/v1/embeddings`,
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody),
                throw: false
            });
            
            if (response.status >= 400) {
                throw new Error(`NVIDIA API error: ${response.json?.error?.message || response.status}`);
            }
            
            if (!response.json || !response.json.data) {
                throw new Error('Invalid response from NVIDIA API');
            }
            
            return response.json.data.map((item: any) => item.embedding);
        } catch (error) {
                        throw error;
        }
    }



    async getIndexData(): Promise<string[]> {
        try {
            // Load index if not loaded
            if (this.index.documents.length === 0) {
                await this.loadIndex();
            }
            // Return unique file paths (remove duplicates from chunks)
            const uniquePaths = [...new Set(this.index.documents.map(doc => doc.path))];
            return uniquePaths;
        } catch (error) {
                        return [];
        }
    }

    /**
     * Get the list of indexed file paths for a specific index ID.
     * Restores the previously loaded index ID so active searches are not disrupted.
     */
    async getIndexedFilesForId(indexId: string): Promise<string[]> {
        try {
            const previousLoadedId = this.loadedIndexId;
            await this.loadIndex(indexId);
            const paths = [...new Set(this.index.documents.map(doc => doc.path))].sort();
            // Restore the tracking ID so the next vault/flash search reloads its own index
            this.loadedIndexId = previousLoadedId;
            return paths;
        } catch (error) {
                        return [];
        }
    }
    /**
     * Get the number of unique files tracked in an embedding index.
     * @param indexId - The index ID to check (optional, uses current index if not provided)
     */
    async getEmbeddedFileCount(indexId?: string): Promise<number> {
        try {
            // Load the specific index
            await this.loadIndex(indexId);

            const uniqueFilesWithEmbeddings = new Set(
                this.index.documents.map(doc => doc.path)
            );

            // Include empty/no-content files so the count matches total eligible files
            const allMdFiles = this.app.vault.getMarkdownFiles();
            for (const f of allMdFiles) {
                if (!uniqueFilesWithEmbeddings.has(f.path) && !this.isFileExcluded(f.path, indexId) && (f.stat?.size || 0) === 0) {
                    uniqueFilesWithEmbeddings.add(f.path);
                }
            }

            return uniqueFilesWithEmbeddings.size;
        } catch (error) {
                        return 0;
        }
    }
    /**
     * Get the number of unique files tracked in a BM25 index.
     * @param indexId - The index ID to check (optional, uses current index if not provided)
     */
    async getBM25FileCount(indexId?: string): Promise<number> {
        try {
            await this.loadIndex(indexId);
            const targetId = indexId || this.loadedIndexId || 'default-bm25';
            const metadata = await OramaWorkerManager.getInstance().getMetadata(targetId);
            const docs = metadata?.documents || [];
            const uniquePaths = new Set(docs.map((d: any) => d.path));

            // Include empty/no-content files so the count matches total eligible files
            const allMdFiles = this.app.vault.getMarkdownFiles();
            for (const f of allMdFiles) {
                // BM25 uses global exclusions
                if (!uniquePaths.has(f.path) && !this.isFileExcluded(f.path, undefined) && (f.stat?.size || 0) === 0) {
                    uniquePaths.add(f.path);
                }
            }

            return uniquePaths.size;
        } catch (error) {
                        return 0;
        }
    }

    /**
     * Build embedding index only (separate from BM25)
     * @param embeddingModel - The embedding model to use
     * @param statusCallback - Callback for progress updates
     * @param indexId - The index ID to build (determines which file to use)
     */
    async buildEmbeddingIndex(embeddingModel: string, statusCallback?: (status: string) => void, indexId?: string): Promise<void> {
        try {
            if (!indexId) return;

            // If already building, just add callback and return
            if (this.activeBuilds.has(indexId)) {
                if (statusCallback) {
                    if (!this.buildCallbacks.has(indexId)) {
                        this.buildCallbacks.set(indexId, new Set());
                    }
                    this.buildCallbacks.get(indexId)!.add(statusCallback);
                    
                    // Immediately report current progress to new subscriber
                    const current = this.activeBuilds.get(indexId)!;
                    const msg = current.fileStatus 
                        ? `EMBEDDINGS:${current.progress}:${current.fileStatus}` 
                        : `EMBEDDINGS:${current.progress}`;
                    statusCallback(msg);
                }
                
                // Return a promise that resolves when the build is finished
                return new Promise((resolve, reject) => {
                    const checkInterval = setInterval(() => {
                        if (!this.activeBuilds.has(indexId)) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 500);
                });
            }

                        
            // Clear pause flag for this index if it exists
            this.pausedIndexIds.delete(indexId);

            // Register as active build
            this.activeBuilds.set(indexId, { progress: 0, type: 'embedding' });
            if (statusCallback) {
                if (!this.buildCallbacks.has(indexId)) {
                    this.buildCallbacks.set(indexId, new Set());
                }
                this.buildCallbacks.get(indexId)!.add(statusCallback);
            }
            this.updateBuildNotice('Indexing started...');

            // Temporarily override the embedding model in settings
            const originalEmbeddingModel = this.settings.embeddingModel;
            this.settings.embeddingModel = embeddingModel;
            
            // Determine if we should use batch processing
            const provider = getProviderForEmbeddingModel(embeddingModel, this.settings);
            
            // Batching is now supported and recommended for all providers
            const useBatchProcessing = true;
            
            try {
                // Get all markdown files, respecting per-index exclusions
                const allFiles = this.app.vault.getFiles();
                const allMarkdownFiles = allFiles.filter(file => file.extension === 'md' && !this.isFileExcluded(file.path, indexId));

                // Avoid reading file content in this pre-pass — let the batch/sequential
                // methods handle content reading and empty-file filtering inline.
                const filesToProcess: TFile[] = allMarkdownFiles;

                const total = filesToProcess.length;
                let processed = 0;

                // Load existing index for this specific index ID
                await this.loadIndex(indexId);

                // Verify the loaded index matches the model we're building
                if (this.index.model && this.index.model !== embeddingModel) {
                                        this.index = { documents: [], lastUpdated: 0, version: INDEX_VERSION, model: embeddingModel };
                    await this.initializeOrama(indexId || 'default-embedding');
                    this.touchCacheAccess(indexId || 'default-embedding');
                    this.indexCache.set(indexId || 'default-embedding', { index: this.index });
                } else if (this.index.version < INDEX_VERSION) {
                                        this.index = { documents: [], lastUpdated: 0, version: INDEX_VERSION, model: embeddingModel };
                    await this.initializeOrama(indexId || 'default-embedding');
                    this.touchCacheAccess(indexId || 'default-embedding');
                    this.indexCache.set(indexId || 'default-embedding', { index: this.index });
                } else if (!this.index.model) {
                    // Set model if not set
                    this.index.model = embeddingModel;
                }

                if (statusCallback) {
                    this.notifyBuildCallbacks(indexId, `EMBEDDINGS:0`);
                }

                const wrappedCallback = (status: string) => {
                    this.notifyBuildCallbacks(indexId, status);

                    const match = status.match(/EMBEDDINGS:(\d+)(?::(\d+\/\d+))?/);
                    if (match) {
                        const progress = parseInt(match[1]);
                        const fileStatus = match[2];
                        this.activeBuilds.set(indexId, { progress, fileStatus, type: 'embedding' });
                        
                        const msg = fileStatus 
                            ? `Indexing: ${fileStatus} (${progress}%)` 
                            : `Indexing: ${progress}%`;
                        this.updateBuildNotice(msg);
                    }
                };

                if (useBatchProcessing) {
                    // Use batch processing for OpenRouter
                    await this.buildEmbeddingIndexBatch(filesToProcess, total, processed, wrappedCallback, indexId);
                } else {
                    // Use sequential processing for Gemini
                    await this.buildEmbeddingIndexSequential(filesToProcess, total, processed, wrappedCallback, indexId);
                }

                // Check if we finished because of a pause
                if (this.pausedIndexIds.has(indexId)) {
                                        this.activeBuilds.delete(indexId);
                    this.updateBuildNotice('Indexing paused', true);
                    this.notifyBuildCallbacks(indexId, `PAUSED`);
                    this.buildCallbacks.delete(indexId);
                    return;
                }

                // Update index metadata
                this.index.lastUpdated = Date.now();
                this.index.version = INDEX_VERSION;
                this.index.model = embeddingModel; // Ensure model is set
                
                // Final save to the specific index file
                await this.saveIndex(indexId);

                // Cleanup active build
                this.activeBuilds.delete(indexId);
                this.updateBuildNotice('Indexing complete!', true);
                this.notifyBuildCallbacks(indexId, `EMBEDDINGS:100`);
                this.buildCallbacks.delete(indexId);

            } catch (buildError) {
                // Handle paused state if thrown from sub-methods
                if (buildError instanceof Error && buildError.message === 'PAUSED') {
                                        this.activeBuilds.delete(indexId);
                    this.updateBuildNotice('Indexing paused', true);
                    this.notifyBuildCallbacks(indexId, `PAUSED`);
                    this.buildCallbacks.delete(indexId);
                    return;
                }

                this.activeBuilds.delete(indexId);
                this.updateBuildNotice('Indexing failed', true);
                this.notifyBuildCallbacks(indexId, `ERROR:embeddings:${(buildError as Error).message}`);
                this.buildCallbacks.delete(indexId);

                // If there's an error during building, try to save what we have so far
                try {
                    await this.saveIndex(indexId);
                } catch (saveError) {
                                    }
            } finally {
                // Restore the original embedding model
                this.settings.embeddingModel = originalEmbeddingModel;
            }
        } catch (error) {
                        if (indexId) {
                this.activeBuilds.delete(indexId);
                this.updateBuildNotice('Indexing failed', true);
                this.notifyBuildCallbacks(indexId, `ERROR:embeddings:${(error as Error).message}`);
                this.buildCallbacks.delete(indexId);
            }
        }
    }

    /**
     * Build embedding index using sequential processing (for Gemini)
     */
    private async buildEmbeddingIndexSequential(
        filesToProcess: TFile[],
        total: number,
        processed: number,
        statusCallback?: (status: string) => void,
        indexId?: string
    ): Promise<void> {
        const SAVE_INTERVAL = 10; // Save progress every 10 files
        let filesSinceLastSave = 0;

        for (const file of filesToProcess) {
            // Check for pause request
            if (indexId && this.pausedIndexIds.has(indexId)) {
                                await this.saveIndex(indexId);
                return;
            }

            const stats = await this.app.vault.adapter.stat(file.path);

            if (!stats) continue;

            // Find existing chunks for this file
            const existingChunks = this.index.documents.filter(doc => doc.path === file.path);
            const hasExistingChunks = existingChunks.length > 0;
            const isUpToDate = hasExistingChunks && existingChunks[0].lastModified >= stats.mtime;

            // Skip if file hasn't been modified since it was last indexed.
            // Model changes are caught upstream (model mismatch check resets the index).
            // Version bumps are caught by the INDEX_VERSION check.
            if (isUpToDate) {
                processed++;
                if (statusCallback) {
                    const percentage = Math.round((processed / total) * 100);
                                        statusCallback(`EMBEDDINGS:${percentage}:${processed}/${total}`);
                }
                continue;
            }

            
            // Read file content
            let content = '';
            try {
                content = await this.app.vault.read(file);
            } catch (error) {
                                processed++;
                continue;
            }

            // Remove old chunks for this file before re-processing
            this.index.documents = this.index.documents.filter(doc => doc.path !== file.path);
            if (indexId) {
                await OramaWorkerManager.getInstance().clearFile(indexId, file.path);
            }

                // Split content into chunks (fixed 2000-char size for BM25, independent of embedding model)
                const chunks = this.splitIntoChunks(content, 2000);
                const newChunks: DocumentChunk[] = [];

            // Update embeddings for each chunk
            for (let i = 0; i < chunks.length; i++) {
                // Check for pause request inside the chunk loop for even better responsiveness
                if (indexId && this.pausedIndexIds.has(indexId)) {
                                        await this.saveIndex(indexId);
                    throw new Error('PAUSED');
                }

                const chunk = chunks[i];

                try {
                    const embedding = await this.getEmbedding(chunk);

                    // Create new chunk with embedding
                    const doc: DocumentChunk = {
                        path: file.path,
                        chunkIndex: i,
                        content: chunk,
                        embedding,
                        lastModified: stats.mtime,
                        hasEmbedding: true,
                        metadata: {
                            isFirstChunk: i === 0,
                            title: file.basename
                        }
                    };
                    this.index.documents.push(doc);
                    newChunks.push(doc);
                } catch (error) {
                    const err = error as Error;
                                        if (statusCallback) {
                        statusCallback(`ERROR:embeddings:${err.message}`);
                    }
                    throw error;
                }
            }

            // Immediately insert new chunks into Orama worker to preserve content
            if (newChunks.length > 0 && indexId) {
                newChunks.forEach(doc => {
                    doc.metadata = doc.metadata || {};
                    doc.metadata.headings = this.extractHeadings(doc.content);
                    doc.metadata.tags = this.extractTags(doc.content);
                });
                const oramaDocs = newChunks.map(doc => {
                    const meta = doc.metadata || {};
                    return {
                        id: `${doc.path}:${doc.chunkIndex}`,
                        path: doc.path,
                        chunkIndex: doc.chunkIndex,
                        title: meta.title || '',
                        headings: meta.headings || '',
                        tags: meta.tags || '',
                        content: doc.content,
                        embedding: doc.embedding,
                        lastModified: doc.lastModified
                    };
                });
                await OramaWorkerManager.getInstance().insertBatch(indexId, oramaDocs);
            }

            processed++;
            filesSinceLastSave++;

            // Incremental save: Save progress every SAVE_INTERVAL files
            if (filesSinceLastSave >= SAVE_INTERVAL) {
                try {
                                        this.index.lastUpdated = Date.now();
                    await this.saveIndex(indexId);
                    filesSinceLastSave = 0;
                } catch (saveError) {
                                        // Continue processing even if save fails
                }
            }

            if (statusCallback) {
                const percentage = Math.round((processed / total) * 100);
                                statusCallback(`EMBEDDINGS:${percentage}:${processed}/${total}`);
            }
        }
    }

    /**
     * Build embedding index using batch processing (for all providers)
     * Processes multiple chunks in parallel batches for much faster indexing
     */
    private async buildEmbeddingIndexBatch(
        filesToProcess: TFile[], 
        total: number, 
        processed: number, 
        statusCallback?: (status: string) => void,
        indexId?: string
    ): Promise<void> {
        const provider = getProviderForEmbeddingModel(this.settings.embeddingModel, this.settings);

        // Determine batch size based on provider
        const BATCH_SIZE = provider === 'openrouter' 
            ? EmbeddingsManager.BATCH_SIZE_OPENROUTER 
            : provider === 'ollama'
            ? EmbeddingsManager.BATCH_SIZE_OLLAMA
            : provider === 'nvidia'
            ? EmbeddingsManager.BATCH_SIZE_NVIDIA
            : EmbeddingsManager.BATCH_SIZE_GEMINI;

        const SAVE_INTERVAL_BATCHES = 20; // Save progress every 20 batches
        
        // Collect all chunks that need processing
        interface ChunkToProcess {
            file: TFile;
            chunkIndex: number;
            content: string;
            stats: any;
        }
        
        const chunksToProcess: ChunkToProcess[] = [];
        const completedFilePaths = new Set<string>();
        let skippedCount = 0;
        
        // First pass: identify which files/chunks need processing
        for (const file of filesToProcess) {
            // Check for pause request during the first pass (collecting chunks)
            if (indexId && this.pausedIndexIds.has(indexId)) {
                                await this.saveIndex(indexId);
                throw new Error('PAUSED');
            }

            const stats = await this.app.vault.adapter.stat(file.path);
            if (!stats) continue;

            // Find existing chunks for this file
            const existingChunks = this.index.documents.filter(doc => doc.path === file.path);
            const hasExistingChunks = existingChunks.length > 0;
            const isUpToDate = hasExistingChunks && existingChunks[0].lastModified >= stats.mtime;

            // Skip if file hasn't been modified since it was last indexed.
            // Model changes are caught upstream (model mismatch check resets the index).
            // Version bumps are caught by the INDEX_VERSION check.
            if (isUpToDate) {
                processed++;
                skippedCount++;
                if (statusCallback) {
                    const percentage = Math.round((processed / total) * 100);
                                        statusCallback(`EMBEDDINGS:${percentage}:${processed}/${total}`);
                }
                continue;
            }

            
            // Read file content
            let content = '';
            try {
                content = await this.app.vault.read(file);
            } catch (error) {
                                processed++;
                continue;
            }

            // Remove old chunks for this file before re-processing
            this.index.documents = this.index.documents.filter(doc => doc.path !== file.path);
            if (indexId) {
                await OramaWorkerManager.getInstance().clearFile(indexId, file.path);
            }

            // Split content into chunks and add to processing queue
            const chunks = this.splitIntoChunks(content);
            for (let i = 0; i < chunks.length; i++) {
                chunksToProcess.push({
                    file,
                    chunkIndex: i,
                    content: chunks[i],
                    stats
                });
            }
        }

        
        // Second pass: process chunks in batches
        let batchNumber = 0;
        for (let batchStart = 0; batchStart < chunksToProcess.length; batchStart += BATCH_SIZE) {
            // Check for pause request before starting a new batch
            if (indexId && this.pausedIndexIds.has(indexId)) {
                                await this.saveIndex(indexId);
                throw new Error('PAUSED');
            }

            const batchEnd = Math.min(batchStart + BATCH_SIZE, chunksToProcess.length);
            const batch = chunksToProcess.slice(batchStart, batchEnd);
            batchNumber++;
            
            
            try {
                // Get embeddings for entire batch in one API call
                const batchTexts = batch.map(item => item.content);
                const embeddings = await this.getEmbeddingBatch(batchTexts);

                // Create document chunks with embeddings
                const newChunks: DocumentChunk[] = [];
                for (let i = 0; i < batch.length; i++) {
                    const item = batch[i];
                    const embedding = embeddings[i];

                    const doc: DocumentChunk = {
                        path: item.file.path,
                        chunkIndex: item.chunkIndex,
                        content: item.content,
                        embedding,
                        lastModified: item.stats.mtime,
                        hasEmbedding: true,
                        metadata: {
                            isFirstChunk: item.chunkIndex === 0,
                            title: item.file.basename
                        }
                    };
                    this.index.documents.push(doc);
                    newChunks.push(doc);
                }

                // Immediately insert new chunks into Orama worker to preserve content
                if (newChunks.length > 0 && indexId) {
                    newChunks.forEach(doc => {
                        doc.metadata = doc.metadata || {};
                        doc.metadata.headings = this.extractHeadings(doc.content);
                        doc.metadata.tags = this.extractTags(doc.content);
                    });
                    const oramaDocs = newChunks.map(doc => {
                        const meta = doc.metadata || {};
                        return {
                            id: `${doc.path}:${doc.chunkIndex}`,
                            path: doc.path,
                            chunkIndex: doc.chunkIndex,
                            title: meta.title || '',
                            headings: meta.headings || '',
                            tags: meta.tags || '',

                            content: doc.content,
                            embedding: doc.embedding,
                            lastModified: doc.lastModified
                        };
                    });
                    await OramaWorkerManager.getInstance().insertBatch(indexId, oramaDocs);
                }

                // Update progress based on files completed this batch
                for (const item of batch) {
                    completedFilePaths.add(item.file.path);
                }
                processed = skippedCount + completedFilePaths.size;
                
                // Incremental save: Save progress every SAVE_INTERVAL_BATCHES batches
                if (batchNumber % SAVE_INTERVAL_BATCHES === 0) {
                    try {
                                                this.index.lastUpdated = Date.now();
                        await this.saveIndex(indexId);
                    } catch (saveError) {
                                                // Continue processing even if save fails
                    }
                }
                
                if (statusCallback) {
                    const percentage = Math.round((processed / total) * 100);
                                        statusCallback(`EMBEDDINGS:${percentage}:${processed}/${total}`);
                }

            } catch (error) {
                const err = error as Error;
                                if (statusCallback) {
                    statusCallback(`ERROR:embeddings:${err.message}`);
                }
                throw error;
            }
        }
    }

    /**
     * Build BM25 index only (separate from embeddings)
     */
    async buildBM25Index(statusCallback?: (status: string) => void, indexId?: string): Promise<void> {
        try {
            // Get the BM25 index ID to build
            let bm25IndexId = indexId;
            if (!bm25IndexId) {
                const selectedBM25Index = this.getSelectedBM25Index();
                bm25IndexId = selectedBM25Index?.id;
            }

            if (!bm25IndexId) {
                throw new Error('No BM25 index selected or provided');
            }

            // If already building, just add callback and return
            if (this.activeBuilds.has(bm25IndexId)) {
                if (statusCallback) {
                    if (!this.buildCallbacks.has(bm25IndexId)) {
                        this.buildCallbacks.set(bm25IndexId, new Set());
                    }
                    this.buildCallbacks.get(bm25IndexId)!.add(statusCallback);
                    
                    // Immediately report current progress to new subscriber
                    const current = this.activeBuilds.get(bm25IndexId)!;
                    const msg = current.fileStatus 
                        ? `BM25:${current.progress}:${current.fileStatus}` 
                        : `BM25:${current.progress}`;
                    statusCallback(msg);
                }
                
                // Return a promise that resolves when the build is finished
                return new Promise((resolve, reject) => {
                    const checkInterval = setInterval(() => {
                        if (!this.activeBuilds.has(bm25IndexId)) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 500);
                });
            }

            // Clear pause flag for this index
            this.pausedIndexIds.delete(bm25IndexId);

            // Register as active build
            this.activeBuilds.set(bm25IndexId, { progress: 0, type: 'bm25' });
            if (statusCallback) {
                if (!this.buildCallbacks.has(bm25IndexId)) {
                    this.buildCallbacks.set(bm25IndexId, new Set());
                }
                this.buildCallbacks.get(bm25IndexId)!.add(statusCallback);
            }
            this.updateBuildNotice('BM25 Indexing started...');

            // Get all markdown files
            // BM25 indexes the whole vault — no exclusions applied
            const allFiles = this.app.vault.getFiles();
            const allMarkdownFiles = allFiles.filter(file =>
                file.extension === 'md'
            );

            // Avoid reading file content in this pre-pass — let the main processing loop
            // handle content reading and empty-file filtering inline.
            const filesToProcess: TFile[] = allMarkdownFiles;

            const total = filesToProcess.length;
            let processed = 0;

            // Load existing index for this BM25 index ID
            await this.loadIndex(bm25IndexId);

            if (statusCallback) {
                this.notifyBuildCallbacks(bm25IndexId, `BM25:0`);
            }

            const wrappedCallback = (status: string) => {
                this.notifyBuildCallbacks(bm25IndexId, status);

                const match = status.match(/BM25:(\d+)(?::(\d+\/\d+))?/);
                if (match) {
                    const progress = parseInt(match[1]);
                    const fileStatus = match[2];
                    this.activeBuilds.set(bm25IndexId, { progress, fileStatus, type: 'bm25' });
                    
                    const msg = fileStatus 
                        ? `BM25 Indexing: ${fileStatus} (${progress}%)` 
                        : `BM25 Indexing: ${progress}%`;
                    this.updateBuildNotice(msg);
                }
            };

            for (const file of filesToProcess) {
                // Check for pause request
                if (this.pausedIndexIds.has(bm25IndexId)) {
                                        await this.saveIndex(bm25IndexId);
                    this.activeBuilds.delete(bm25IndexId);
                    this.updateBuildNotice('BM25 Indexing paused', true);
                    this.notifyBuildCallbacks(bm25IndexId, `PAUSED`);
                    this.buildCallbacks.delete(bm25IndexId);
                    return;
                }

                const stats = await this.app.vault.adapter.stat(file.path);
                if (!stats) continue;

                // Check if file is up-to-date for BM25 (skip if unchanged)
                const existingChunks = this.index.documents.filter(doc => doc.path === file.path);
                const hasExistingChunks = existingChunks.length > 0;
                const isUpToDate = hasExistingChunks && existingChunks[0].lastModified >= stats.mtime;

                if (isUpToDate) {
                    processed++;
                    if (wrappedCallback) {
                        const percentage = Math.round((processed / total) * 100);
                                                wrappedCallback(`BM25:${percentage}:${processed}/${total}`);
                    }
                    continue;
                }

                // Read file content
                let content = '';
                try {
                    content = await this.app.vault.read(file);
                } catch (error) {
                                        processed++;
                    continue;
                }

                // Remove old chunks from both main thread and Orama worker
                this.index.documents = this.index.documents.filter(doc => doc.path !== file.path);
                await OramaWorkerManager.getInstance().clearFile(bm25IndexId, file.path);

                // Split content into chunks
                const chunks = this.splitIntoChunks(content);
                const newChunks: DocumentChunk[] = [];

                // Update BM25 data for each chunk
                for (let i = 0; i < chunks.length; i++) {
                    // Check for pause request inside the chunk loop
                    if (this.pausedIndexIds.has(bm25IndexId)) {
                                                await this.saveIndex(bm25IndexId);
                        this.activeBuilds.delete(bm25IndexId);
                        this.updateBuildNotice('BM25 Indexing paused', true);
                        this.notifyBuildCallbacks(bm25IndexId, `PAUSED`);
                        this.buildCallbacks.delete(bm25IndexId);
                        throw new Error('PAUSED');
                    }

                    const chunk = chunks[i];
                    
                    const doc: DocumentChunk = {
                        path: file.path,
                        chunkIndex: i,
                        content: chunk,
                        embedding: [], // Empty embedding
                        lastModified: stats.mtime,
                        metadata: {
                            isFirstChunk: i === 0,
                            title: file.basename
                        }
                    };
                    this.index.documents.push(doc);
                    newChunks.push(doc);
                }

                // Immediately insert new chunks into Orama worker to preserve content
                if (newChunks.length > 0) {
                    newChunks.forEach(doc => {
                        doc.metadata = doc.metadata || {};
                        doc.metadata.headings = this.extractHeadings(doc.content);
                        doc.metadata.tags = this.extractTags(doc.content);
                    });
                    const oramaDocs = newChunks.map(doc => {
                        const meta = doc.metadata || {};
                        return {
                            id: `${doc.path}:${doc.chunkIndex}`,
                            path: doc.path,
                            chunkIndex: doc.chunkIndex,
                            title: meta.title || '',
                            headings: meta.headings || '',
                            tags: meta.tags || '',

                            content: doc.content,
                            lastModified: doc.lastModified
                        };
                    });
                    await OramaWorkerManager.getInstance().insertBatch(bm25IndexId, oramaDocs);
                }

                processed++;
                if (wrappedCallback) {
                    const percentage = Math.round((processed / total) * 100);
                    wrappedCallback(`BM25:${percentage}:${processed}/${total}`);
                }
            }



            // Rebuild Orama index - already handled incrementally
            
            // Update index metadata
            this.index.lastUpdated = Date.now();
            this.index.version = INDEX_VERSION;
            await this.saveIndex(bm25IndexId);

            // Cleanup active build
            this.activeBuilds.delete(bm25IndexId);
            this.updateBuildNotice('BM25 Indexing complete!', true);
            this.notifyBuildCallbacks(bm25IndexId, `BM25:100`);
            this.buildCallbacks.delete(bm25IndexId);

        } catch (error) {
            if (error instanceof Error && error.message === 'PAUSED') {
                throw error; // Already handled
            }
            const id = this.getSelectedBM25Index()?.id || '';
            this.activeBuilds.delete(id);
            this.updateBuildNotice('BM25 Indexing failed', true);
            this.notifyBuildCallbacks(id, `ERROR:bm25:${(error as Error).message}`);
            this.buildCallbacks.delete(id);
                        throw error;
        }
    }

    /**
     * Checks if there are any files that have changed since the last index update
     * for a specific index (embedding or BM25).
     *
     * Reads the index file directly so it never mutates this.index (shared state).
     * - BM25 indexes: compare against ALL markdown files (no exclusions)
     * - Embedding indexes: compare against files not excluded by per-index exclusions
     *
     * @param indexId - The specific index config ID to check (required)
     * @returns Object with hasChanges boolean and counts of different change types
     */
    async detectChanges(indexId: string): Promise<{ hasChanges: boolean; newFiles: number; modifiedFiles: number; deletedFiles: number }> {
        try {
            // Resolve config to know type and exclusions
            const indexConfig = this.settings.indexConfigurations?.find((c: any) => c.id === indexId);
            const isBM25 = indexConfig?.type === 'bm25';

            // Use the already loaded index if possible, otherwise we have to return "no changes" to avoid freezing
            // or perform a very minimal check. Since this is for the UI dot, using the loaded index is preferred.
            let indexedFilesMap = new Map<string, number>();
            
            // If the requested index is the one currently loaded, use it.
            // Otherwise, we'd need to parse the binary, which we want to avoid on the UI thread.
            if (this.loadedIndexId === indexId && this.index && this.index.documents) {
                for (const doc of this.index.documents) {
                    if (!doc.path.endsWith('.md')) continue;
                    if (!indexedFilesMap.has(doc.path) || doc.lastModified > indexedFilesMap.get(doc.path)!) {
                        indexedFilesMap.set(doc.path, doc.lastModified);
                    }
                }
            } else {
                // Load the index asynchronously to get an accurate check
                try {
                    const previousLoadedId = this.loadedIndexId;
                    await this.loadIndex(indexId);
                    for (const doc of this.index.documents) {
                        if (!doc.path.endsWith('.md')) continue;
                        if (!indexedFilesMap.has(doc.path) || doc.lastModified > indexedFilesMap.get(doc.path)!) {
                            indexedFilesMap.set(doc.path, doc.lastModified);
                        }
                    }
                    this.loadedIndexId = previousLoadedId;
                } catch {
                    return { hasChanges: true, newFiles: 1, modifiedFiles: 0, deletedFiles: 0 };
                }
            }

            // Build the set of files that should be in this index
            const allFiles = this.app.vault.getFiles();
            const indexableFiles: TFile[] = [];

            for (const file of allFiles) {
                if (file.extension !== 'md') continue;
                // BM25 indexes everything; embedding respects per-index exclusions
                if (!isBM25 && this.isFileExcluded(file.path, indexId)) continue;
                
                // IMPORTANT: Do NOT read file content here. That freezes the UI.
                // Just use the file object which Obsidian already has in memory.
                indexableFiles.push(file);
            }

            let newFiles = 0;
            let modifiedFiles = 0;
            let deletedFiles = 0;

            for (const file of indexableFiles) {
                // Use stat.mtime from the file object directly if available, or fetch it
                const mtime = file.stat?.mtime || (await this.app.vault.adapter.stat(file.path))?.mtime || 0;
                
                if (!indexedFilesMap.has(file.path)) {
                    // Check if it's actually new or just skipped (e.g., empty file)
                    if (mtime > (this.index.lastUpdated || 0)) {
                        newFiles++;
                    }
                } else if (mtime > indexedFilesMap.get(file.path)!) {
                    modifiedFiles++;
                }
            }

            const currentFilePaths = new Set(indexableFiles.map(f => f.path));
            for (const indexedPath of indexedFilesMap.keys()) {
                if (!currentFilePaths.has(indexedPath)) {
                    deletedFiles++;
                }
            }

            return {
                hasChanges: newFiles > 0 || modifiedFiles > 0 || deletedFiles > 0,
                newFiles,
                modifiedFiles,
                deletedFiles
            };
        } catch (error) {
                        return { hasChanges: false, newFiles: 0, modifiedFiles: 0, deletedFiles: 0 };
        }
    }

    /**
     * BM25-only search for @flash prefix (fast keyword search without embeddings)
     * This is used for quick searches that don't require semantic understanding
     */
    async findSimilarContentBM25Only(query: string, limit: number = 5): Promise<{results: Array<{path: string, content: string, similarity: number, chunkIndex?: number}>, temporalContext?: {startDate: number | null, endDate: number | null, cleanQuery: string}}> {
        try {
            // Load the BM25 index if needed
            const selectedBM25Id = this.settings.selectedBM25IndexId;
            const indexMismatch = selectedBM25Id !== this.loadedIndexId;
            
            if ((this.index.documents.length === 0 || indexMismatch) && !this.isLoadingIndex) {
                await this.loadIndex(selectedBM25Id || undefined);
            }

            // Parse temporal query
            const temporalQuery = await parseTemporalQuery(query, new Date(), this.settings);
            const searchQuery = temporalQuery.hasTemporalFilter ? temporalQuery.cleanQuery : query;

            const targetId = this.loadedIndexId || 'default-bm25';
            
            // Build where clause for Orama if temporal filter is present
            const where: any = {};
            if (temporalQuery.hasTemporalFilter) {
                if (temporalQuery.startDate !== null && temporalQuery.endDate !== null) {
                    where.lastModified = { between: [temporalQuery.startDate, temporalQuery.endDate] };
                } else if (temporalQuery.startDate !== null) {
                    where.lastModified = { gt: temporalQuery.startDate };
                } else if (temporalQuery.endDate !== null) {
                    where.lastModified = { lt: temporalQuery.endDate };
                }
            }

            // Offload keyword search to Orama Worker
            const bm25SearchResponse = await OramaWorkerManager.getInstance().search(targetId, {
                term: searchQuery,
                properties: ['title', 'headings', 'tags', 'content'],
                where: Object.keys(where).length > 0 ? where : undefined,
                boost: {
                    title: this.settings.bm25TitleBoost || 3.0,
                    headings: this.settings.bm25HeadingBoost || 2.0,
                    tags: this.settings.bm25TagBoost || 1.5,
                    content: 1.0
                },
                tolerance: 1,
                limit: limit * 5
            });

            const bm25Results = (bm25SearchResponse.results?.hits || []).map((hit: any) => ({
                path: hit.document.path,
                chunkIndex: hit.document.chunkIndex,
                content: hit.document.content || '',
                similarity: hit.score,
                lastModified: hit.document.lastModified
            }));

            // Group by file
            const fileChunksMap = new Map<string, Array<{chunkIndex: number, content: string, similarity: number, lastModified: number}>>();
            for (const result of bm25Results) {
                if (!fileChunksMap.has(result.path)) {
                    fileChunksMap.set(result.path, []);
                }
                fileChunksMap.get(result.path)!.push({
                    chunkIndex: result.chunkIndex,
                    content: result.content,
                    similarity: result.similarity,
                    lastModified: result.lastModified
                });
            }

            const results: Array<{path: string, content: string, similarity: number, chunkIndex?: number}> = [];
            const sortedEntries = Array.from(fileChunksMap.entries()).sort((a, b) => {
                const maxSimA = Math.max(...a[1].map(c => c.similarity));
                const maxSimB = Math.max(...b[1].map(c => c.similarity));
                if (maxSimA !== maxSimB) return maxSimB - maxSimA;
                return Math.max(...b[1].map(c => c.lastModified)) - Math.max(...a[1].map(c => c.lastModified));
            });

            for (const [filePath, chunks] of sortedEntries) {
                chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
                const topChunks = chunks.slice(0, 5);
                const combinedContent = topChunks.map(c => c.content).join('\n\n...\n\n');
                results.push({
                    path: filePath,
                    content: combinedContent,
                    similarity: chunks[0].similarity,
                    chunkIndex: chunks[0].chunkIndex
                });
                if (results.length >= limit) break;
            }

            return {
                results,
                temporalContext: temporalQuery.hasTemporalFilter ? {
                    startDate: temporalQuery.startDate,
                    endDate: temporalQuery.endDate,
                    cleanQuery: temporalQuery.cleanQuery
                } : undefined
            };
        } catch (error: any) {
                        return { results: [], temporalContext: undefined };
        }
    }

    public isFileExcluded(filePath: string, indexId?: string): boolean {
        // Determine which exclusion lists to use
        let excludedFolders: string[];
        let excludedFiles: string[];

        if (indexId) {
            // Per-index exclusions (embedding indexes)
            const indexConfig = this.settings.indexConfigurations?.find(
                (c: any) => c.id === indexId
            );
            excludedFolders = indexConfig?.excludedFolders || [];
            excludedFiles = indexConfig?.excludedFiles || [];
        } else {
            // Fall back to global exclusions (kept for BM25 / legacy callers)
            excludedFolders = this.settings.excludedFolders || [];
            excludedFiles = this.settings.excludedFiles || [];
        }

        // Check if file is in excluded folders
        const inExcludedFolder = excludedFolders.some(folder => {
            // Special case: empty string '' means vault root — only match files with no subfolder
            if (folder === '') {
                return !filePath.includes('/');
            }
            const normalizedFolder = folder.startsWith('/') ? folder : '/' + folder;
            const normalizedPath = filePath.startsWith('/') ? filePath : '/' + filePath;
            return normalizedPath.startsWith(normalizedFolder + '/') || normalizedPath === normalizedFolder;
        });

        if (inExcludedFolder) return true;

        // Check if file is in excluded files list
        return excludedFiles.some(excludedFile => {
            const normalizedExcluded = excludedFile.startsWith('/') ? excludedFile.slice(1) : excludedFile;
            const normalizedPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
            return normalizedPath === normalizedExcluded;
        });
    }

    /**
     * Load index from file
     * If indexId is provided, loads that specific index file
     * Otherwise loads the default/legacy index
     */
    public async loadIndex(indexId?: string): Promise<void> {
        // Resolve the actual ID to load
        let targetId = indexId;
        if (!targetId) {
            const selectedEmbeddingIndex = this.getSelectedEmbeddingIndex();
            const selectedBM25Index = this.getSelectedBM25Index();
            targetId = selectedEmbeddingIndex?.id || selectedBM25Index?.id || this.settings.selectedEmbeddingIndexId || 'default-embedding';
        }

        // 1. Check if index is already in memory cache
        if (this.indexCache.has(targetId)) {
            const cached = this.indexCache.get(targetId)!;
            this.index = cached.index;
            this.loadedIndexId = targetId;
            this.touchCacheAccess(targetId);
                        return;
        }

        // Prevent concurrent loads - wait for existing load to complete
        if (this.isLoadingIndex) {
                        // Wait for the current load to finish
            while (this.isLoadingIndex) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            // After waiting, check cache again as the other load might have populated it
            if (this.indexCache.has(targetId)) {
                const cached = this.indexCache.get(targetId)!;
                this.index = cached.index;
                this.loadedIndexId = targetId;
                this.touchCacheAccess(targetId);
                return;
            }
        }
        
        this.isLoadingIndex = true;
        let restoreNotice: Notice | null = null;
        
        // Determine index label based on type
        const indexConfig = this.settings.indexConfigurations?.find(idx => idx.id === targetId);
        const label = indexConfig?.type === 'bm25' ? 'BM25 index' : 'index';
        
        try {
            const adapter = this.app.vault.adapter;
            const indexPath = this.getIndexFilePath(targetId);

                        
            const exists = await adapter.exists(indexPath);
            if (exists) {
                // Step 1: Disk Read (25%)
                restoreNotice = new Notice(`[Nexus] Restoring ${label}: 25% (Reading disk...)`, 0);
                const data = await adapter.readBinary(indexPath);
                
                // Yield to event loop to allow UI to paint
                await new Promise(resolve => setTimeout(resolve, 0));
                
                // Steps 2 & 3: Offload Restoration to Orama Worker (50% - 75%)
                if (restoreNotice) restoreNotice.setMessage(`[Nexus] Restoring ${label}: 60% (Processing in background...)`);

                // Build schema dynamically based on index type
                const isBM25 = indexConfig?.type === 'bm25';
                const schema: any = {
                    id: 'string',
                    path: 'string',
                    chunkIndex: 'number',
                    title: 'string',
                    headings: 'string',
                    tags: 'string',
                    content: 'string',
                    lastModified: 'number'
                };

                // Add embedding only for non-BM25 indices
                // Note: Worker will refine the exact dimension during load automatically
                if (!isBM25) {
                    schema.embedding = 'vector[1]'; // Dummy dimension, refined by worker on LOAD
                }

                const loadResponse = await OramaWorkerManager.getInstance().load(targetId, data, schema, true);
                const metadata = loadResponse.metadata;
                const shadowDocs = loadResponse.documents || [];

                // Yield to event loop
                await new Promise(resolve => setTimeout(resolve, 0));

                // Step 4: Finalizing (90% - 100%)
                if (restoreNotice) restoreNotice.setMessage(`[Nexus] Restoring ${label}: 90% (Finalizing...)`);

                if (metadata) {
                    this.index = {
                        documents: shadowDocs, // Lightweight docs (no embeddings)
                        lastUpdated: metadata.lastUpdated || Date.now(),
                        version: metadata.version || INDEX_VERSION,
                        model: metadata.model || indexConfig?.model || targetId
                    };
                                    }
            } else {
                                this.index = { 
                    documents: [], 
                    lastUpdated: 0, 
                    version: INDEX_VERSION, 
                    model: indexConfig?.model || targetId 
                };
                if (this.loadedIndexId) {
            await this.initializeOrama(this.loadedIndexId);
        }
            }

            // Update cache and current pointer
            this.touchCacheAccess(targetId);
            this.indexCache.set(targetId, { index: this.index });
            this.loadedIndexId = targetId;
            
            if (restoreNotice) {
                restoreNotice.setMessage(`[Nexus] ${label.charAt(0).toUpperCase() + label.slice(1)} restored successfully!`);
                setTimeout(() => restoreNotice?.hide(), 2000);
            }

        } catch (error) {
                        if (restoreNotice) {
                restoreNotice.setMessage(`[Nexus] ${label.charAt(0).toUpperCase() + label.slice(1)} restoration failed.`);
                setTimeout(() => restoreNotice?.hide(), 3000);
            }
            this.index = { documents: [], lastUpdated: 0, version: INDEX_VERSION, model: targetId };
            if (this.loadedIndexId) {
            await this.initializeOrama(this.loadedIndexId);
        }
            this.touchCacheAccess(targetId);
            this.indexCache.set(targetId, { index: this.index });
            this.loadedIndexId = targetId;
        } finally {
            this.isLoadingIndex = false;
        }
    }

    /**
     * Save index to file
     * If indexId is provided, saves to that specific index file
     * Otherwise saves to the default/legacy path
     */
    private async saveIndex(indexId?: string): Promise<void> {        
        const targetId = indexId || this.loadedIndexId;
        if (!targetId) return;

        try {
            
            // Sync cache if needed (lightweight metadata)
            if (targetId === this.loadedIndexId) {
                this.touchCacheAccess(targetId);
                this.indexCache.set(targetId, { index: this.index });
            }

            // Fetch current state from Orama worker
            const response = await OramaWorkerManager.getInstance().save(targetId, true);
            const compressed = response.data as Uint8Array;

            const indexPath = this.getIndexFilePath(targetId);
            const adapter = this.app.vault.adapter;

            // Make sure the directory exists
            const indexDir = indexPath.substring(0, indexPath.lastIndexOf('/'));
            if (indexDir && !(await adapter.exists(indexDir))) {
                await adapter.mkdir(indexDir);
            }

            await adapter.writeBinary(indexPath, compressed);
                    } catch (error) {
                    }
    }
    async findSimilarContent(query: string, limit: number = 5, hybridEnabled: boolean = true): Promise<{results: Array<{path: string, content: string, similarity: number, chunkIndex?: number}>, temporalContext?: {startDate: number | null, endDate: number | null, cleanQuery: string}}> {
        try {
            // Lazy load index on first use, or switch if the selected embedding index has changed
            const currentSelectedId = this.settings.selectedEmbeddingIndexId;
            const indexMismatch = currentSelectedId !== this.loadedIndexId;
            
            if ((this.index.documents.length === 0 || indexMismatch) && !this.isLoadingIndex) {
                // This will either resolve from cache instantly or load from disk if missing
                await this.loadIndex(currentSelectedId || undefined);
            }

            // Parse temporal query to extract date filters (supports all providers)
            const temporalQuery = await parseTemporalQuery(query, new Date(), this.settings);
            const searchQuery = temporalQuery.hasTemporalFilter ? temporalQuery.cleanQuery : query;

            // Check which indexes are enabled
            const embeddingIndexEnabled = this.settings.selectedEmbeddingIndexId !== null;
            const bm25IndexEnabled = this.settings.selectedBM25IndexId !== null;

            // If no indexes are enabled, return empty results with clear error
            if (!embeddingIndexEnabled && !bm25IndexEnabled) {
                                throw new Error('No embedding or BM25 index selected. Please select an index in settings to use vault search.');
            }

            // Determine effective search mode
            // hybridEnabled=false forces embedding-only even when BM25 index is selected
            const useHybrid = hybridEnabled && embeddingIndexEnabled && bm25IndexEnabled;
            const useEmbeddingOnly = embeddingIndexEnabled && (!bm25IndexEnabled || !hybridEnabled);
            const useBM25Only = !embeddingIndexEnabled && bm25IndexEnabled;

            


            // Get the selected embedding index configuration to use its model
            let embeddingModel = this.settings.embeddingModel; // Fallback
            if (embeddingIndexEnabled) {
                const selectedEmbeddingIndex = this.settings.indexConfigurations?.find(
                    idx => idx.id === this.settings.selectedEmbeddingIndexId && idx.type === 'embedding'
                );
                if (selectedEmbeddingIndex?.model) {
                    embeddingModel = selectedEmbeddingIndex.model;
                }
            }

            // Temporarily override embedding model for this search
            const originalEmbeddingModel = this.settings.embeddingModel;
            this.settings.embeddingModel = embeddingModel;

            try {
                // If only BM25 is enabled (or forced BM25-only), use BM25-only search
                if (useBM25Only) {
                    const bm25Response = await this.findSimilarContentBM25Only(query, limit);
                    return {
                        results: bm25Response.results,
                        temporalContext: bm25Response.temporalContext ?? (temporalQuery.hasTemporalFilter ? {
                            startDate: temporalQuery.startDate,
                            endDate: temporalQuery.endDate,
                            cleanQuery: temporalQuery.cleanQuery
                        } : undefined)
                    };
                }

                // If embedding-only (no BM25 selected, or hybrid disabled by user)
                if (useEmbeddingOnly) {
                    const embeddingResults = await this.findSimilarContentEmbeddingOnly(query, limit);
                    return {
                        results: embeddingResults,
                        temporalContext: temporalQuery.hasTemporalFilter ? {
                            startDate: temporalQuery.startDate,
                            endDate: temporalQuery.endDate,
                            cleanQuery: temporalQuery.cleanQuery
                        } : undefined
                    };
                }

                // Both indexes selected and hybrid enabled — fall through to hybrid (RRF) path

                // ==================== TEMPORAL QUERY OPTIMIZATION ====================
                // For temporal queries, skip semantic/keyword scoring and return ALL files in date range
                if (temporalQuery.hasTemporalFilter) {
                    // Filter documents in date range (cheaper than Orama where clause for this case)
                    const docsInRange = this.index.documents.filter(doc => {
                        if (temporalQuery.startDate !== null && doc.lastModified < temporalQuery.startDate) return false;
                        if (temporalQuery.endDate !== null && doc.lastModified > temporalQuery.endDate) return false;
                        return true;
                    });
                    
                    if (docsInRange.length === 0) {
                        return {
                            results: [],
                            temporalContext: {
                                startDate: temporalQuery.startDate,
                                endDate: temporalQuery.endDate,
                                cleanQuery: temporalQuery.cleanQuery
                            }
                        };
                    }
                    
                    // Group all chunks by file (no scoring, no filtering)
                    const fileChunksMap = new Map<string, Array<{chunkIndex: number, content: string, lastModified: number}>>();
                    
                    for (const doc of docsInRange) {
                        if (!fileChunksMap.has(doc.path)) {
                            fileChunksMap.set(doc.path, []);
                        }
                        fileChunksMap.get(doc.path)!.push({
                            chunkIndex: doc.chunkIndex,
                            content: doc.content,
                            lastModified: doc.lastModified
                        });
                    }
                    
                    const results: Array<{path: string, content: string, similarity: number, chunkIndex?: number}> = [];
                    
                    // Sort files by last modified date (most recent first)
                    const sortedFiles = Array.from(fileChunksMap.entries())
                        .sort((a, b) => Math.max(...b[1].map(c => c.lastModified)) - Math.max(...a[1].map(c => c.lastModified)));
                    
                    for (const [filePath, chunks] of sortedFiles) {
                        // Take up to 5 chunks per file
                        const topChunks = chunks
                            .sort((a, b) => a.chunkIndex - b.chunkIndex) // Sort by chunk order
                            .slice(0, 5);
                        
                        const combinedContent = topChunks.map(c => c.content).join('\n\n...\n\n');
                        
                        results.push({
                            path: filePath,
                            content: combinedContent,
                            similarity: 0.8, // High similarity for temporal matches
                            chunkIndex: topChunks[0].chunkIndex
                        });
                        
                        if (results.length >= limit) break;
                    }
                    
                                        return {
                        results,
                        temporalContext: {
                            startDate: temporalQuery.startDate,
                            endDate: temporalQuery.endDate,
                            cleanQuery: temporalQuery.cleanQuery
                        }
                    };
                }

                // ==================== HYBRID SEARCH (Orama Native) ====================
                
                const queryEmbedding = await this.getEmbedding(searchQuery, true);
                const targetId = this.loadedIndexId || 'default-embedding';
                
                // Build where clause for Orama if temporal filter is present
                const where: any = {};
                if (temporalQuery.hasTemporalFilter) {
                    if (temporalQuery.startDate !== null && temporalQuery.endDate !== null) {
                        where.lastModified = { between: [temporalQuery.startDate, temporalQuery.endDate] };
                    } else if (temporalQuery.startDate !== null) {
                        where.lastModified = { gt: temporalQuery.startDate };
                    } else if (temporalQuery.endDate !== null) {
                        where.lastModified = { lt: temporalQuery.endDate };
                    }
                }

                const hybridSearchResponse = await OramaWorkerManager.getInstance().search(targetId, {
                    mode: 'hybrid',
                    term: searchQuery,
                    vector: {
                        value: queryEmbedding,
                        property: 'embedding'
                    },
                    properties: ['title', 'headings', 'tags', 'content'],
                    boost: {
                        title: this.settings.bm25TitleBoost || 3.0,
                        headings: this.settings.bm25HeadingBoost || 2.0,
                        tags: this.settings.bm25TagBoost || 1.5,
                        content: 1.0
                    },
                    where: Object.keys(where).length > 0 ? where : undefined,
                    limit: limit * 5,
                    similarity: 0.4
                });

                const fusedResults = (hybridSearchResponse.results?.hits || []).map((hit: any) => ({
                    path: hit.document.path,
                    chunkIndex: hit.document.chunkIndex,
                    content: hit.document.content || '',
                    similarity: hit.score,
                    lastModified: hit.document.lastModified
                }));

                // ==================== PROCESS RESULTS ====================

                // Group chunks by file
                const fileChunksMap = new Map<string, Array<{chunkIndex: number, content: string, similarity: number, lastModified: number}>>();
                
                for (const hit of fusedResults) {
                    if (!fileChunksMap.has(hit.path)) {
                        fileChunksMap.set(hit.path, []);
                    }
                    fileChunksMap.get(hit.path)!.push({
                        chunkIndex: hit.chunkIndex,
                        content: hit.content,
                        similarity: hit.similarity,
                        lastModified: hit.lastModified
                    });
                }

                // Sort files by their best chunk's similarity score
                const sortedFiles = Array.from(fileChunksMap.entries())
                    .sort((a, b) => Math.max(...b[1].map(c => c.similarity)) - Math.max(...a[1].map(c => c.similarity)));

                const results: Array<{path: string, content: string, similarity: number, chunkIndex?: number, lastModified?: number}> = [];

                for (const [filePath, chunks] of sortedFiles) {
                    // Take up to 5 chunks per file (matching RAG Notebooks)
                    const topChunks = chunks
                        .sort((a, b) => b.similarity - a.similarity)
                        .slice(0, 5);
                    
                    // Sort by chunk index to maintain document order
                    topChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
                    
                    const combinedContent = topChunks.map(c => c.content).join('\n\n...\n\n');
                    const maxSimilarity = Math.max(...topChunks.map(c => c.similarity));
                    
                results.push({
                    path: filePath,
                    content: combinedContent,
                    similarity: maxSimilarity,
                    chunkIndex: topChunks[0].chunkIndex,
                    lastModified: topChunks[0].lastModified
                });
                
                if (results.length >= limit) break;
                }
                
                return {
                    results,
                    temporalContext: temporalQuery.hasTemporalFilter ? {
                        startDate: temporalQuery.startDate,
                        endDate: temporalQuery.endDate,
                        cleanQuery: temporalQuery.cleanQuery
                    } : undefined
                };
            } finally {
                this.settings.embeddingModel = originalEmbeddingModel;
            }
        } catch (error: any) {
            if (error?.message?.includes('DIMENSION_MISMATCH')) {
                new Notice(`[Nexus] Embedding dimension mismatch. Please click "Rebuild Index" in settings to update "${this.loadedIndexId || 'the index'}" for the current model.`);
                                throw new Error('Dimension mismatch. Please rebuild the index.');
            }
                        throw new Error('Failed to search index');
        }
    }

    private async findSimilarContentEmbeddingOnly(query: string, limit: number = 5): Promise<Array<{path: string, content: string, similarity: number, chunkIndex?: number}>> {
        try {
            // Parse temporal query to extract date filters (supports all providers)
            const temporalQuery = await parseTemporalQuery(query, new Date(), this.settings);
            const searchQuery = temporalQuery.hasTemporalFilter ? temporalQuery.cleanQuery : query;

            // CRITICAL FIX: Filter documents by date BEFORE searching
            let documentsToSearch = this.index.documents;
            if (temporalQuery.hasTemporalFilter) {
                                documentsToSearch = documentsToSearch.filter(doc => {
                    const fileModTime = doc.lastModified;
                    
                    if (temporalQuery.startDate !== null && fileModTime < temporalQuery.startDate) {
                        return false;
                    }
                    if (temporalQuery.endDate !== null && fileModTime > temporalQuery.endDate) {
                        return false;
                    }
                    return true;
                });
                
                // Count unique files
                const uniqueFiles = new Set(documentsToSearch.map(doc => doc.path));
                                                
                if (documentsToSearch.length === 0) {
                                        return [];
                }
            }

            // Get the selected embedding index configuration to use its model
            let embeddingModel = this.settings.embeddingModel; // Fallback
            const selectedEmbeddingIndex = this.settings.indexConfigurations?.find(
                idx => idx.id === this.settings.selectedEmbeddingIndexId && idx.type === 'embedding'
            );
            if (selectedEmbeddingIndex?.model) {
                embeddingModel = selectedEmbeddingIndex.model;
            }

            // Temporarily override embedding model for this search
            const originalEmbeddingModel = this.settings.embeddingModel;
            this.settings.embeddingModel = embeddingModel;

            try {
                // Get query embedding
                const queryEmbedding = await this.getEmbedding(searchQuery, true);
                
                const targetId = this.loadedIndexId || 'default-embedding';

                // Build where clause for Orama if temporal filter is present
                const where: any = {};
                if (temporalQuery.hasTemporalFilter) {
                    if (temporalQuery.startDate !== null && temporalQuery.endDate !== null) {
                        where.lastModified = { between: [temporalQuery.startDate, temporalQuery.endDate] };
                    } else if (temporalQuery.startDate !== null) {
                        where.lastModified = { gt: temporalQuery.startDate };
                    } else if (temporalQuery.endDate !== null) {
                        where.lastModified = { lt: temporalQuery.endDate };
                    }
                }

                // Offload vector search to Orama Worker
                const vectorSearchResponse = await OramaWorkerManager.getInstance().search(targetId, {
                    mode: 'vector',
                    vector: {
                        value: queryEmbedding,
                        property: 'embedding'
                    },
                    where: Object.keys(where).length > 0 ? where : undefined,
                    limit: 100, // Get enough candidates for filtering/grouping
                    similarity: 0.4
                });

                const vectorResults: Array<{path: string, chunkIndex: number, content: string, similarity: number, lastModified: number}> = 
                    (vectorSearchResponse.results?.hits || []).map((hit: any) => ({
                        path: hit.document.path,
                        chunkIndex: hit.document.chunkIndex,
                        content: hit.document.content || '',
                        similarity: hit.score,
                        lastModified: hit.document.lastModified
                    }));
                
                // Note: Results are already sorted by Orama
                const filteredResults = vectorResults;
                
                // Group by file and combine chunks
                const fileChunksMap = new Map<string, Array<{chunkIndex: number, content: string, similarity: number, lastModified: number}>>();
                
                for (const result of filteredResults.slice(0, limit * 5)) {
                    if (!fileChunksMap.has(result.path)) {
                        fileChunksMap.set(result.path, []);
                    }
                    fileChunksMap.get(result.path)!.push({
                        chunkIndex: result.chunkIndex,
                        content: result.content,
                        similarity: result.similarity,
                        lastModified: result.lastModified
                    });
                }
                
                // Sort files by best chunk similarity
                const sortedFiles = Array.from(fileChunksMap.entries())
                    .sort((a, b) => Math.max(...b[1].map(c => c.similarity)) - Math.max(...a[1].map(c => c.similarity)));
                
                const results: Array<{path: string, content: string, similarity: number, chunkIndex?: number, lastModified?: number}> = [];
                
                for (const [filePath, chunks] of sortedFiles) {
                    const topChunks = chunks
                        .sort((a, b) => b.similarity - a.similarity)
                        .slice(0, 5);
                    
                    topChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
                    
                    const combinedContent = topChunks.map(c => c.content).join('\n\n...\n\n');
                    const maxSimilarity = Math.max(...topChunks.map(c => c.similarity));
                    
                    results.push({
                        path: filePath,
                        content: combinedContent,
                        similarity: maxSimilarity,
                        chunkIndex: topChunks[0].chunkIndex,
                        lastModified: topChunks[0].lastModified
                    });
                    
                    if (results.length >= limit) break;
                }
                
                return results;
            } finally {
                // Restore original embedding model
                this.settings.embeddingModel = originalEmbeddingModel;
            }
        } catch (error: any) {
            if (error?.message?.includes('DIMENSION_MISMATCH')) {
                new Notice(`[Nexus] Embedding dimension mismatch. Please click "Rebuild Index" in settings to update "${this.loadedIndexId || 'the index'}" for the current model.`);
                            }
                        return [];
        }
    }







}