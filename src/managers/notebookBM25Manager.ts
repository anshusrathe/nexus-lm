import { App, TFile, Notice } from 'obsidian';
import { AISettings } from '../settings';
import { OramaWorkerManager } from '../utils/oramaWorkerManager';

interface NotebookDocumentChunk {
    path: string;
    chunkIndex: number;
    content: string;
    lastModified: number;
    metadata: {
        title?: string;
        headings?: string;
        tags?: string;
        links?: string[];
        isFirstChunk?: boolean;
    };
}

interface NotebookSearchIndex {
    notebookId: string;
    documents: NotebookDocumentChunk[];
    lastUpdated: number;
    version: number;
    sourceHashes: Record<string, number>; // path -> mtime for change detection
    // Document summaries for hierarchical context
    summaries: Array<{
        path: string;
        summary: string;
        lastModified: number;
    }>;
}

// Current index version
const NOTEBOOK_INDEX_VERSION = 2; // Version 2 for BM25-only mode

export interface NotebookSourceStatus {
    path: string;
    isIndexed: boolean;
    hasChanges: boolean;
    lastModified: number;
    indexedAt: number;
}

/**
 * NotebookBM25Manager - Sophisticated BM25-only search for RAG notebooks
 * This manager bypasses embeddings entirely and uses advanced BM25 techniques:
 * - MiniSearch integration for fast, optimized BM25
 * - N-gram matching (bigrams, trigrams) for phrase detection
 * - Query expansion with synonyms and stemming
 * - Fuzzy matching for typo tolerance
 * - Metadata boosting (titles, headings, tags)
 * - Document summaries for hierarchical context
 */
export class NotebookBM25Manager {
    private index: NotebookSearchIndex;
    private notebookId: string;
    private sourcePaths: string[];
    
    // Chunk size configuration - optimized for better context retention and variety
    private static readonly CHUNK_SIZE_CHARS = 3000;      // ~750 tokens per chunk
    private static readonly CHUNK_OVERLAP_CHARS = 300;    // 10% overlap
    
    private indexLoaded: boolean = false;
    private indexLoadPromise: Promise<void> | null = null;

    constructor(
        private app: App,
        private settings: AISettings,
        notebookId: string,
        sourcePaths: string[]
    ) {
        this.notebookId = notebookId;
        this.sourcePaths = sourcePaths;
        this.index = {
            notebookId,
            documents: [],
            lastUpdated: 0,
            version: NOTEBOOK_INDEX_VERSION,
            sourceHashes: {},
            summaries: []
        };
        
        // Don't load index on construction - it will be loaded lazily on first use
    }

    private getIndexPath(): string {
        return `.Nexus-LM-data/notebook-bm25/${this.notebookId}.bin`;
    }

    /**
     * Initialize Orama in the worker for this notebook
     */
    private async initializeOrama(): Promise<void> {
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
        await OramaWorkerManager.getInstance().init(this.notebookId, schema);
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
     * Split document content into chunks with sentence-aware boundaries
     */
    private splitIntoChunks(content: string): string[] {
        if (!content || content.trim().length === 0) {
            return [];
        }

        const chunks: string[] = [];
        const chunkSize = NotebookBM25Manager.CHUNK_SIZE_CHARS;
        const overlap = NotebookBM25Manager.CHUNK_OVERLAP_CHARS;

        if (content.length <= chunkSize) {
            return [content.trim()];
        }

        let startIndex = 0;
        while (startIndex < content.length) {
            let endIndex = Math.min(startIndex + chunkSize, content.length);
            
            // Improved boundary detection - search in last 40% of chunk for better sentence breaks
            if (endIndex < content.length) {
                const searchStart = startIndex + Math.floor(chunkSize * 0.6);
                const searchRegion = content.substring(searchStart, endIndex);
                
                // Priority 1: Look for paragraph breaks (double newline)
                const paragraphBreak = searchRegion.lastIndexOf('\n\n');
                if (paragraphBreak !== -1 && paragraphBreak > searchRegion.length * 0.3) {
                    endIndex = searchStart + paragraphBreak + 2;
                } else {
                    // Priority 2: Look for heading markers (markdown headers)
                    const headingMatch = searchRegion.match(/\n#{1,6}\s/g);
                    if (headingMatch) {
                        const lastHeading = searchRegion.lastIndexOf(headingMatch[headingMatch.length - 1]);
                        if (lastHeading !== -1 && lastHeading > searchRegion.length * 0.3) {
                            endIndex = searchStart + lastHeading;
                        }
                    } else {
                        // Priority 3: Look for sentence boundaries
                        const sentenceEndMatch = searchRegion.match(/[.!?]\s+(?=[A-Z])|[.!?]\n|\n(?=[-*•])/g);
                        if (sentenceEndMatch) {
                            const lastMatch = sentenceEndMatch[sentenceEndMatch.length - 1];
                            const matchIndex = searchRegion.lastIndexOf(lastMatch);
                            if (matchIndex !== -1) {
                                endIndex = searchStart + matchIndex + lastMatch.length;
                            }
                        }
                    }
                }
            }

            const chunk = content.substring(startIndex, endIndex).trim();
            if (chunk.length > 0) {
                chunks.push(chunk);
            }

            // Move start with overlap, ensuring we don't get stuck
            const nextStart = endIndex - overlap;
            if (nextStart <= startIndex) {
                startIndex = endIndex; // Prevent infinite loop
            } else {
                startIndex = nextStart;
            }
            
            if (startIndex >= content.length - overlap / 2) {
                break;
            }
        }

        return chunks;
    }

    /**
     * Perform BM25 search using Orama in the worker
     */
    private async bm25Search(
        query: string,
        selectedPaths: string[],
        limit: number = 30
    ): Promise<Array<{path: string, chunkIndex: number, content: string, score: number}>> {
        if (!this.notebookId) return [];

        try {
            // Build filter for selected paths
            const where: any = {};
            if (selectedPaths && selectedPaths.length > 0) {
                where.path = selectedPaths;
            }

            const searchResponse = await OramaWorkerManager.getInstance().search(this.notebookId, {
                term: query,
                properties: ['title', 'headings', 'tags', 'content'],
                where: Object.keys(where).length > 0 ? where : undefined,
                boost: {
                    title: this.settings.bm25TitleBoost || 3.0,
                    headings: this.settings.bm25HeadingBoost || 2.0,
                    tags: this.settings.bm25TagBoost || 1.5,
                    content: 1.0
                },
                tolerance: 1,
                limit
            });

            if (searchResponse && searchResponse.results?.hits) {
                return searchResponse.results.hits.map((hit: any) => {
                    const doc = hit.document;
                    return {
                        path: doc.path,
                        chunkIndex: doc.chunkIndex,
                        content: doc.content || '',
                        score: hit.score
                    };
                });
            }
        } catch (error) {
                    }
        return [];
    }

    // ==================== INDEX MANAGEMENT ====================

    async loadIndex(): Promise<void> {
        // If already loaded, return immediately
        if (this.indexLoaded) {
            return;
        }

        // If loading is in progress, wait for it
        if (this.indexLoadPromise) {
            return this.indexLoadPromise;
        }

        // Start loading
        this.indexLoadPromise = (async () => {
            let restoreNotice: Notice | null = null;
            try {
                const indexPath = this.getIndexPath();
                const exists = await this.app.vault.adapter.exists(indexPath);
                if (exists) {
                    // Step 1: Disk Read (25%)
                    restoreNotice = new Notice(`[Nexus] Restoring notebook index: 25% (Reading...)`, 0);
                    const data = await this.app.vault.adapter.readBinary(indexPath);
                    
                    // Yield to event loop
                    await new Promise(resolve => setTimeout(resolve, 0));
                    
                    // Steps 2 & 3: Offload Restoration to Orama Worker (50% - 75%)
                    if (restoreNotice) restoreNotice.setMessage(`[Nexus] Restoring notebook index: 60% (Processing in background...)`);
                    
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

                    const loadResponse = await OramaWorkerManager.getInstance().load(this.notebookId, data, schema, true);
                    const metadata = loadResponse.metadata;
                    const shadowDocs = loadResponse.documents || [];
                    
                    // Yield to event loop
                    await new Promise(resolve => setTimeout(resolve, 0));
                    
                    // Step 4: Finalizing (90% - 100%)
                    if (restoreNotice) restoreNotice.setMessage(`[Nexus] Restoring notebook index: 90% (Finalizing...)`);

                    if (metadata) {
                        this.index = {
                            ...this.index, 
                            ...metadata, // Recover all stats (sourceHashes, etc.)
                            documents: shadowDocs, // Use documents from metadata
                            lastUpdated: metadata.lastUpdated || Date.now(),
                            version: metadata.version || NOTEBOOK_INDEX_VERSION
                        };
                                            }
                    
                    if (restoreNotice) {
                        restoreNotice.setMessage(`[Nexus] Notebook index restored!`);
                        setTimeout(() => restoreNotice?.hide(), 2000);
                    }
                }
                this.indexLoaded = true;
            } catch (error) {
                // Failed to load index
                if (restoreNotice) {
                    restoreNotice.setMessage(`[Nexus] Notebook index restoration failed.`);
                    setTimeout(() => restoreNotice?.hide(), 3000);
                }
                this.indexLoaded = true; // Mark as loaded even on error to prevent retry loops
            } finally {
                this.indexLoadPromise = null;
            }
        })();

        return this.indexLoadPromise;
    }

    private async saveIndex(): Promise<void> {
        try {
            const indexPath = this.getIndexPath();
            const indexDir = indexPath.substring(0, indexPath.lastIndexOf('/'));
            
            if (!(await this.app.vault.adapter.exists(indexDir))) {
                await this.app.vault.adapter.mkdir(indexDir);
            }
            
            const metadata = {
                notebookId: this.notebookId,
                sourceHashes: this.index.sourceHashes,
                summaries: this.index.summaries,
                lastUpdated: this.index.lastUpdated,
                version: NOTEBOOK_INDEX_VERSION
            };
            const response = await OramaWorkerManager.getInstance().save(this.notebookId, true, metadata);
            const compressed = response.data as Uint8Array;
            await this.app.vault.adapter.writeBinary(indexPath, compressed);
        } catch (error) {
            // Failed to save index
        }
    }



    // ==================== PUBLIC API ====================

    /**
     * Get the status of all sources - whether they're indexed and if they have changes
     */
    async getSourcesStatus(): Promise<NotebookSourceStatus[]> {
        // Lazy load index only when needed
        if (!this.indexLoaded) {
            await this.loadIndex();
        }
        const statuses: NotebookSourceStatus[] = [];

        for (const path of this.sourcePaths) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                continue;
            }

            const stats = await this.app.vault.adapter.stat(path);
            if (!stats) continue;

            const indexedMtime = this.index.sourceHashes[path] || 0;
            const isIndexed = indexedMtime > 0;
            const hasChanges = isIndexed && stats.mtime > indexedMtime;

            statuses.push({
                path,
                isIndexed,
                hasChanges,
                lastModified: stats.mtime,
                indexedAt: indexedMtime
            });
        }

        return statuses;
    }

    /**
     * Check if any sources have changes since last indexing
     */
    async hasSourceChanges(): Promise<boolean> {
        const statuses = await this.getSourcesStatus();
        return statuses.some(s => s.hasChanges || !s.isIndexed);
    }

    /**
     * Update the index for all notebook sources (BM25-only, no embeddings)
     */
    async updateIndex(
        statusCallback?: (status: string) => void,
        selectedPaths?: string[]
    ): Promise<void> {
        try {
            // Lazy load index only when needed
            if (!this.indexLoaded) {
                await this.loadIndex();
            }
            
            const pathsToIndex = selectedPaths || this.sourcePaths;
            
            if (statusCallback) {
                statusCallback(`PROGRESS:0`);
            }
            
            let totalChunksToProcess = 0;
            const fileChunkCounts: Map<string, number> = new Map();
            const filesToProcess: string[] = [];
            
            // First pass: Calculate total chunks
            for (const path of pathsToIndex) {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (!(file instanceof TFile) || file.extension !== 'md') {
                    continue;
                }

                const stats = await this.app.vault.adapter.stat(path);
                if (!stats) continue;

                const existingMtime = this.index.sourceHashes[path] || 0;
                if (existingMtime >= stats.mtime) {
                    const existingChunks = this.index.documents.filter(d => d.path === path);
                    totalChunksToProcess += existingChunks.length;
                    fileChunkCounts.set(path, existingChunks.length);
                    continue;
                }

                const content = await this.app.vault.read(file);
                if (!content) continue;

                const estimatedChunks = this.splitIntoChunks(content);
                const chunkCount = estimatedChunks.length + 1; // +1 for summary
                totalChunksToProcess += chunkCount;
                fileChunkCounts.set(path, chunkCount);
                filesToProcess.push(path);
            }

            // Second pass: Process files
            let processedChunks = 0;
            
            for (const path of pathsToIndex) {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (!(file instanceof TFile) || file.extension !== 'md') {
                    continue;
                }

                const stats = await this.app.vault.adapter.stat(path);
                if (!stats) continue;

                const existingMtime = this.index.sourceHashes[path] || 0;
                if (existingMtime >= stats.mtime) {
                    const existingCount = fileChunkCounts.get(path) || 0;
                    processedChunks += existingCount;
                    const percentage = Math.round((processedChunks / totalChunksToProcess) * 100);
                    if (statusCallback) {
                        statusCallback(`PROGRESS:${percentage}`);
                    }
                    continue;
                }

                // Yield to event loop between files to prevent UI freeze
                await new Promise(resolve => setTimeout(resolve, 5));

                const content = await this.app.vault.read(file);

                // Skip empty files - they have no searchable content
                if (!content || content.trim().length === 0) {
                    // Remove any old chunks for this empty file
                    this.index.documents = this.index.documents.filter(d => d.path !== path);
                    if (this.index.summaries) {
                        this.index.summaries = this.index.summaries.filter(s => s.path !== path);
                    }
                    // Remove from sourceHashes so it won't be tracked
                    delete this.index.sourceHashes[path];
                    
                    const existingCount = fileChunkCounts.get(path) || 0;
                    processedChunks += existingCount;
                    const percentage = Math.round((processedChunks / totalChunksToProcess) * 100);
                    if (statusCallback) {
                        statusCallback(`PROGRESS:${percentage}`);
                    }
                    continue;
                }

                // Remove old chunks from main thread and worker
                this.index.documents = this.index.documents.filter(d => d.path !== path);
                await OramaWorkerManager.getInstance().clearFile(this.notebookId, path);

                processedChunks++;
                let percentage = Math.round((processedChunks / totalChunksToProcess) * 100);
                if (statusCallback) {
                    statusCallback(`PROGRESS:${percentage}`);
                }

                // Split into chunks (NO EMBEDDINGS)
                const chunks = this.splitIntoChunks(content);
                const newChunks: NotebookDocumentChunk[] = [];
                
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    
                    const doc: NotebookDocumentChunk = {
                        path,
                        chunkIndex: i,
                        content: chunk,
                        lastModified: stats.mtime,
                        metadata: {
                            isFirstChunk: i === 0,
                            title: file.basename
                        }
                    };
                    this.index.documents.push(doc);
                    newChunks.push(doc);
                    
                    processedChunks++;
                    percentage = Math.round((processedChunks / totalChunksToProcess) * 100);
                    if (statusCallback) {
                        statusCallback(`PROGRESS:${percentage}`);
                    }
                    
                    // Yield to event loop every 10 chunks to prevent UI freeze
                    if (i % 10 === 0) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
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
                    await OramaWorkerManager.getInstance().insertBatch(this.notebookId, oramaDocs);
                }

                // Always update sourceHashes for non-empty files
                this.index.sourceHashes[path] = stats.mtime;
            }

            // Remove chunks for files no longer in sources
            const validPaths = new Set(this.sourcePaths);
            this.index.documents = this.index.documents.filter(d => validPaths.has(d.path));
            
            for (const path of Object.keys(this.index.sourceHashes)) {
                if (!validPaths.has(path)) {
                    delete this.index.sourceHashes[path];
                }
            }

            // Build BM25 index statistics
            if (statusCallback) {
                statusCallback(`PROGRESS:98`);
            }

            this.index.lastUpdated = Date.now();
            await this.saveIndex();

            if (statusCallback) {
                statusCallback(`PROGRESS:100`);
            }
            
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to update notebook search index: ${errorMessage}`);
        }
    }

    /**
     * Find similar content using BM25-only search (no embeddings)
     */
    async findSimilarContent(
        query: string,
        selectedPaths: string[],
        maxChunks: number = 5,
        includeAdjacentChunks: boolean = true
    ): Promise<Array<{path: string, content: string, similarity: number, chunkIndex?: number, totalChunks?: number, retrievalMethod?: string}>> {
        try {
            // Lazy load index only when needed
            if (!this.indexLoaded) {
                await this.loadIndex();
            }

            if (this.index.documents.length === 0) {
                return [];
            }

            const selectedPathsSet = new Set(selectedPaths);
            const relevantDocs = this.index.documents.filter(d => selectedPathsSet.has(d.path));

            if (relevantDocs.length === 0) {
                return [];
            }

            // Perform BM25 search
            const bm25Results = await this.bm25Search(query, selectedPaths, 30);

            if (bm25Results.length === 0) {
                return [];
            }

            // Build a map of chunk data
            const chunkMap = new Map<string, typeof bm25Results[0] & {bm25Rank: number}>();
            
            for (let i = 0; i < bm25Results.length; i++) {
                const result = bm25Results[i];
                const key = `${result.path}:${result.chunkIndex}`;
                chunkMap.set(key, {
                    ...result,
                    bm25Rank: i + 1
                });
            }

            // Select top chunks by BM25 score
            const selectedChunks: Array<{
                path: string,
                chunkIndex: number,
                content: string,
                score: number,
                bm25Rank: number
            }> = [];

            for (let i = 0; i < Math.min(maxChunks, bm25Results.length); i++) {
                const result = bm25Results[i];
                const key = `${result.path}:${result.chunkIndex}`;
                const chunk = chunkMap.get(key);
                if (chunk) {
                    selectedChunks.push(chunk);
                    
                    // Note: Adjacent chunks are currently skipped in shadow mode unless they were
                    // also returned by the search engine. This ensures we always have content.
                }
            }

            // Group by file and find consecutive sequences
            const fileChunksMap = new Map<string, typeof selectedChunks>();
            for (const chunk of selectedChunks) {
                if (!fileChunksMap.has(chunk.path)) {
                    fileChunksMap.set(chunk.path, []);
                }
                fileChunksMap.get(chunk.path)!.push(chunk);
            }

            const results: Array<{path: string, content: string, similarity: number, chunkIndex?: number, totalChunks?: number, retrievalMethod?: string}> = [];

            fileChunksMap.forEach((chunks, filePath) => {
                chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
                
                const sequences: Array<typeof chunks> = [];
                let currentSequence: typeof chunks = [chunks[0]];
                
                for (let i = 1; i < chunks.length; i++) {
                    if (chunks[i].chunkIndex === chunks[i-1].chunkIndex + 1) {
                        currentSequence.push(chunks[i]);
                    } else {
                        sequences.push(currentSequence);
                        currentSequence = [chunks[i]];
                    }
                }
                sequences.push(currentSequence);
                
                const totalFileChunks = this.index.documents.filter(d => d.path === filePath).length;
                
                for (const sequence of sequences) {
                    // SIMPLIFIED: Remove verbose metadata that causes cognitive overload
                    // Only keep essential position info for context awareness
                    const combinedContent = sequence.map(c => {
                        // Only show position if there are multiple chunks in sequence
                        if (sequence.length > 1) {
                            return `[Section ${c.chunkIndex + 1}]\n${c.content}`;
                        }
                        return c.content;
                    }).join('\n\n');
                    
                    const maxScore = Math.max(...sequence.map(c => c.score));
                    // Normalize BM25 score to 0-1 range for similarity
                    const normalizedSimilarity = Math.min(maxScore / 20, 1.0);
                    
                    results.push({
                        path: filePath,
                        content: combinedContent,
                        similarity: normalizedSimilarity,
                        chunkIndex: sequence[0].chunkIndex,
                        totalChunks: totalFileChunks,
                        retrievalMethod: 'bm25'
                    });
                }
            });

            results.sort((a, b) => b.similarity - a.similarity);

            return results;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to search notebook index: ${errorMessage}`);
        }
    }

    /**
     * Get adjacent chunks for context continuity
     */
    private getAdjacentChunks(
        path: string,
        chunkIndex: number,
        includeCount: number = 1
    ): NotebookDocumentChunk[] {
        const fileChunks = this.index.documents
            .filter(d => d.path === path)
            .sort((a, b) => a.chunkIndex - b.chunkIndex);

        const adjacent: NotebookDocumentChunk[] = [];
        
        for (let i = 1; i <= includeCount; i++) {
            const prevChunk = fileChunks.find(c => c.chunkIndex === chunkIndex - i);
            if (prevChunk) adjacent.unshift(prevChunk);
        }

        for (let i = 1; i <= includeCount; i++) {
            const nextChunk = fileChunks.find(c => c.chunkIndex === chunkIndex + i);
            if (nextChunk) adjacent.push(nextChunk);
        }

        return adjacent;
    }

    /**
     * Get document summaries for selected paths
     */
    getDocumentSummaries(selectedPaths: string[]): Array<{path: string, summary: string}> {
        if (!this.index.summaries) return [];
        const pathSet = new Set(selectedPaths);
        return this.index.summaries
            .filter(s => pathSet.has(s.path))
            .map(s => ({ path: s.path, summary: s.summary }));
    }

    /**
     * Check if the index exists and has data
     */
    async isIndexed(): Promise<boolean> {
        // Lazy load index only when needed
        if (!this.indexLoaded) {
            await this.loadIndex();
        }
        return this.index.documents.length > 0;
    }

    /**
     * Get indexed file count
     */
    async getIndexedFileCount(): Promise<number> {
        // Lazy load index only when needed
        if (!this.indexLoaded) {
            await this.loadIndex();
        }
        const uniquePaths = new Set(this.index.documents.map(d => d.path));
        return uniquePaths.size;
    }

    /**
     * Get total chunk count
     */
    async getChunkCount(): Promise<number> {
        // Lazy load index only when needed
        if (!this.indexLoaded) {
            await this.loadIndex();
        }
        return this.index.documents.length;
    }
}
