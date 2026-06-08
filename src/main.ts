import { Plugin, Notice, TFile, TAbstractFile, WorkspaceLeaf, ItemView, Setting, Menu, Editor, MarkdownView, Platform, Modal, requestUrl, normalizePath } from 'obsidian';
import { AISettingTab, AISettings, DEFAULT_SETTINGS, Provider, migrateSettings } from './settings';
import { AITutorView, VIEW_TYPE_NEXUS_TUTOR } from './views/view';
import { ResponseView, VIEW_TYPE_NEXUS_CHAT } from './views/responseView';
import { LandingView, VIEW_TYPE_LANDING } from './views/landingView';
import { EmbeddingsManager } from './managers/embeddingsManager';
import { PdfExtractOptionsModal, extractTextFromPdf } from './utils/pdfExtractor';
import { Vault } from 'obsidian';
import { VIEW_TYPE_NEXUS_FEED, FeedView } from './views/feedView';
import { FeedEntryView, VIEW_TYPE_NEXUS_FEED_ENTRIES } from './views/feedEntryView';
import { parseFeed, ParsedFeed, ParsedFeedEntry } from './parsing/feedParsing';
import { CombinedFeedView, VIEW_TYPE_COMBINED_FEED } from './views/combinedFeedView';
import { BookmarkView, VIEW_TYPE_BOOKMARKS } from './views/bookmarkView';
import { NotebookChatView, VIEW_TYPE_NOTEBOOK_CHAT } from './views/notebookChatView';
import { NotebookManager } from './managers/notebookManager';
import { PLATFORM_FEATURES } from './utils/platformFeatures';
import { YouTubeChatService } from './services/youtubeChatService';
import { YouTubeTranscriptModal } from './modals/youtubeTranscriptModal';
import { RateLimitManager } from './utils/rateLimitManager';
import { MCPService } from './mcp/mcpService';
import { MCPToolCallingService } from './mcp/mcpToolCalling';
import { IndexStatusModal } from './modals/indexStatusModal';
import { verifyModel, verifyEmbeddingModel, discoverModels, toCustomModels } from './services/modelDiscoveryService';
import { UnifiedProviderManager } from './services/unifiedProviderManager';
import { OpenCodeProvider } from './services/openCodeService';
import { CustomOpenAIProvider } from './services/customOpenAIProvider';
import { openEditSelectionModal } from './editSelection';



export default class AIPlugin extends Plugin {
    settings: AISettings = DEFAULT_SETTINGS;
    public embeddingsManager!: EmbeddingsManager;
    private visitedEntriesSet!: Set<string>;
    private bookmarkedEntriesSet!: Set<string>;
    public notebookManager!: NotebookManager;
    public mcpService!: MCPService;
    public mcpToolCallingService!: MCPToolCallingService;
    public verifyingProviders: Set<Provider> = new Set();
    public verifyingEmbeddingProviders: Set<Provider> = new Set();
    private currentViewMode: string = 'landing';

    async onload() {
        await this.loadSettings();

        
        if (this.settings.indexConfigurations) {
            let changed = false;
            this.settings.indexConfigurations.forEach(config => {
                if (config.isBuilding) {
                    config.isBuilding = false;
                    config.buildProgress = 0;
                    changed = true;
                }
            });
            if (changed) {
                await this.saveData(this.settings);
            }
        }

        
        if (this.settings.openCodeApiKey) {
            UnifiedProviderManager.getInstance().registerProvider(
                new OpenCodeProvider(this.settings.openCodeApiKey)
            );
        }
        this.registerCustomProviders();

        
        
        setTimeout(() => {
            const mcqOverlays = document.body.querySelectorAll('.mcq-error-overlay, .mcq-progress-dialog');
            mcqOverlays.forEach(overlay => overlay.remove());
        }, 0);

        
        this.embeddingsManager = new EmbeddingsManager(this.app, this.settings);
        
        
        this.mcpService = new MCPService();
        this.mcpToolCallingService = new MCPToolCallingService(this.mcpService);

        
        this.notebookManager = new NotebookManager(this.app);

        
        
        this.app.workspace.onLayoutReady(() => {
            
            this.embeddingsManager.syncIndexFiles().then(async (changed) => {
                if (changed) {
                    await this.saveSettings();
                                    }
            }).catch(err => {
                            });

            
            if (this.settings.mcpEnabled && this.settings.mcpServers && (this.settings.mcpAutoConnect ?? true)) {
                this.settings.mcpServers
                    .filter(server => !server.disabled)
                    .forEach(server => {
                        this.mcpService.connectServer(server).catch(err => {
                                                        new Notice(`Failed to connect to MCP server ${server.name}`);
                        });
                    });
            }

            
            this.notebookManager.loadNotebooks().catch(err => {
                            });

            
            this.refreshModelsFromProviders().catch(err => {
                            });

            
            this.deferredSetInitialization();

            
            
            
            
            (async () => {
                if (!this.embeddingsManager) return;
                try {
                    const embId = this.settings.selectedEmbeddingIndexId;
                    if (embId) {
                        await this.embeddingsManager.loadIndex(embId);
                    }
                    const bm25Id = this.settings.selectedBM25IndexId;
                    if (bm25Id) {
                        await this.embeddingsManager.loadIndex(bm25Id);
                    }
                } catch (err) {
                                    }
            })();
        });

        
        this.visitedEntriesSet = new Set();
        this.bookmarkedEntriesSet = new Set();

        
        this.addSettingTab(new AISettingTab(this.app, this));

        
        this.registerView(
            VIEW_TYPE_LANDING,
            (leaf) => new LandingView(leaf, this)
        );

        this.registerView(
            VIEW_TYPE_NEXUS_TUTOR,
            (leaf) => new AITutorView(leaf, this.settings, this)
        );

        this.registerView(
            VIEW_TYPE_NEXUS_CHAT,
            (leaf) => new ResponseView(leaf, this)
        );

        
        if (PLATFORM_FEATURES.RSS_FEEDS) {
            this.registerView(
                VIEW_TYPE_NEXUS_FEED,
                (leaf) => new FeedView(leaf, this)
            );

            this.registerView(
                VIEW_TYPE_NEXUS_FEED_ENTRIES,
                (leaf) => new FeedEntryView(leaf, this)
            );

            this.registerView(
                VIEW_TYPE_COMBINED_FEED,
                (leaf) => new CombinedFeedView(leaf, this)
            );

            this.registerView(
                VIEW_TYPE_BOOKMARKS,
                (leaf) => new BookmarkView(leaf, this)
            );
        }

        
        this.registerView(
            VIEW_TYPE_NOTEBOOK_CHAT,
            (leaf) => new NotebookChatView(leaf, this.settings, this)
        );

        
        this.addRibbonIcon('loader-pinwheel', 'Open Nexus-LM', async () => {
            await this.activateView('landing');
        });

        
        
        this.addCommand({
            id: 'open-nexus-lm-hub',
            name: 'Open Nexus-LM Hub',
            callback: async () => {
                await this.activateView('landing');
            }
        });

        this.addCommand({
            id: 'open-ai-chat',
            name: 'Open Nexus Chat',
            callback: () => {
                this.activateView('chat');
            }
        });

        
        this.addCommand({
            id: 'open-tutor-view',
            name: 'Open Tutor view',
            callback: async () => {
                await this.activateView('tutor');
            }
        });

        
        this.addCommand({
            id: 'view-indexed-files',
            name: 'View indexed files',
            callback: async () => {
                await this.createIndexedFilesList();
            }
        });

        
        this.addCommand({
            id: 'edit-selection',
            name: 'Nexuslm: Edit selection',
            editorCallback: (editor: Editor, view: MarkdownView | SafeAny) => {
                openEditSelectionModal(this.app, this.settings);
            }
        });

        
        if (PLATFORM_FEATURES.PDF_EXTRACTION) {
            this.addCommand({
                id: 'extract-text-from-pdf',
                name: 'Extract text from current PDF',
                checkCallback: (checking: boolean) => {
                    const activeFile = this.app.workspace.getActiveFile();
                    const isPDF = activeFile && activeFile instanceof TFile && activeFile.extension === 'pdf';
                    
                    if (checking) {
                        return !!isPDF;
                    }
                    
                    if (isPDF) {
                        (async () => {
                            try {
                                
                                const vault = this.app.vault;
                                const arrayBuffer = await vault.readBinary(activeFile!);
                                const pdfjsLib = (window as SafeAny).pdfjsLib;
                                if (!pdfjsLib) throw new Error('PDF.js library not loaded.');
                                const pdfDocument = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                                const numPages = pdfDocument.numPages;
                                
                                const defaultDir = this.settings.pdfOutputDirectory || 'PDF-Extracted-Text';
                                new PdfExtractOptionsModal(this.app, numPages, defaultDir, pdfDocument, async (opts) => {
                                    new Notice(`Extracting text from ${activeFile!.name}...`);
                                    const extractedText = await extractTextFromPdf(activeFile!, vault, { from: opts.from, to: opts.to });
                                    
                                    const outputDir = opts.directory || defaultDir;
                                    await vault.adapter.mkdir(outputDir);
                                    
                                    const fileNameWithoutExtension = activeFile!.basename;
                                    let outputFileName = '';
                                    if (opts.full) {
                                        outputFileName = `${fileNameWithoutExtension} text.md`;
                                    } else {
                                        outputFileName = `${fileNameWithoutExtension} ${opts.from}-${opts.to} text.md`;
                                    }
                                    const outputPath = normalizePath(`${outputDir}/${outputFileName}`);
                                    await vault.create(outputPath, extractedText);
                                    new Notice(`Text extracted and saved to ${outputPath}`);
                                }).open();
                            } catch (error) {
                                                                const message = error instanceof Error ? error.message : String(error);
                                new Notice(`Failed to extract or save text from PDF: ${message}`);
                            }
                        })();
                    }
                }
            });
        }

        
        this.addCommand({
            id: 'fetch-youtube-transcript',
            name: 'Fetch YouTube transcript',
            callback: async () => {
                
                const modal = new Modal(this.app);
                modal.titleEl.setText('Fetch YouTube Transcript');
                modal.contentEl.createEl('p', { text: 'Enter the YouTube video URL to fetch its transcript.' });
                
                const urlInput = modal.contentEl.createEl('input', {
                    type: 'text',
                    placeholder: 'Enter YouTube URL',
                    cls: 'nexus-youtube-input'
                });
                
                const buttonContainer = modal.contentEl.createDiv({ cls: 'modal-button-container' });
                
                const fetchButton = buttonContainer.createEl('button', {
                    text: 'Fetch Transcript',
                    cls: 'mod-cta'
                });
                
                const cancelButton = buttonContainer.createEl('button', {
                    text: 'Cancel'
                });
                
                fetchButton.addEventListener('click', async () => {
                    const youtubeUrl = urlInput.value.trim();
                    if (!youtubeUrl) {
                        new Notice('Please enter a YouTube URL');
                        return;
                    }
                    
                    modal.close();
                    
                    try {
                        new Notice('Fetching YouTube transcript...');
                        const rateLimitManager = RateLimitManager.getInstance();
                        const ytService = new YouTubeChatService(this.settings, rateLimitManager);
                        
                        
                        const [transcript, videoTitle] = await Promise.all([
                            ytService.getTranscriptOnly(youtubeUrl),
                            ytService.getVideoTitle(youtubeUrl)
                        ]);
                        
                        const defaultFolder = this.settings.youtubeTranscriptFolder || 'YouTube Transcripts';
                        
                        
                        new YouTubeTranscriptModal(
                            this.app,
                            defaultFolder,
                            videoTitle,
                            async (fileName: string, folderPath: string) => {
                                try {
                                    
                                    const vault = this.app.vault;
                                    if (folderPath !== '/') {
                                        await vault.adapter.mkdir(folderPath);
                                    }
                                    
                                    
                                    const filePath = normalizePath(`${folderPath}/${fileName}`);
                                    
                                    
                                    const content = `# ${videoTitle}\n\nSource: ${youtubeUrl}\n\n## Transcript\n\n${transcript}`;
                                    
                                    
                                    await vault.create(filePath, content);
                                    
                                    new Notice(`Transcript saved to ${filePath}`);
                                } catch (error) {
                                                                        const message = error instanceof Error ? error.message : String(error);
                                    new Notice(`Failed to save transcript: ${message}`);
                                }
                            }
                        ).open();
                    } catch (error) {
                                                const message = error instanceof Error ? error.message : String(error);
                        new Notice(`Failed to fetch transcript: ${message}`);
                    }
                });
                
                cancelButton.addEventListener('click', () => {
                    modal.close();
                });
                
                
                urlInput.focus();
                urlInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        fetchButton.click();
                    }
                });
                
                modal.open();
            }
        });

        
        if (PLATFORM_FEATURES.RSS_FEEDS) {
            
            this.addCommand({
                id: 'open-your-feed',
                name: 'Open Nexus Feed',
                callback: async () => {
                    await this.activateView('feed');
                }
            });

            
            this.addCommand({
                id: 'open-combined-feed-view',
                name: 'Open Combined Feed View',
                callback: async () => {
                    await this.activateView('combined-feed');
                }
            });

            
            this.addCommand({
                id: 'open-bookmark-view',
                name: 'Open Bookmark View',
                callback: async () => {
                    await this.activateView('bookmarks');
                }
            });
            }

            
            this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                const selection = editor.getSelection();
                if (selection && selection.trim().length > 0) {
                    menu.addItem((item) => {
                        item
                            .setTitle('Nexuslm: Edit selection')
                            .onClick(async () => {
                                openEditSelectionModal(this.app, this.settings);
                            });
                    });
                }
            })
            );
        }

    
    async searchVault(query: string, limit: number = 5, hybridEnabled: boolean = true): Promise<{results: Array<{path: string, content: string, similarity: number}>, temporalContext?: {startDate: number | null, endDate: number | null, cleanQuery: string}}> {
        return this.embeddingsManager.findSimilarContent(query, limit, hybridEnabled);
    }

    
    async searchVaultBM25Only(query: string, limit: number = 5): Promise<{results: Array<{path: string, content: string, similarity: number}>, temporalContext?: {startDate: number | null, endDate: number | null, cleanQuery: string}}> {
        return this.embeddingsManager.findSimilarContentBM25Only(query, limit);
    }

    async activateView(mode: 'landing' | 'tutor' | 'chat' | 'feed' | 'feed-entries' | 'combined-feed' | 'bookmarks', subMode?: 'qa' | 'mcq', data?: unknown): Promise<void> {
        this.currentViewMode = mode;
        let viewType: string;
        let state: Record<string, unknown> = {};
        
        
        const isMobile = Platform.isMobile;

        switch (mode) {
            case 'landing':
                viewType = VIEW_TYPE_LANDING;
                break;
            case 'tutor':
                viewType = VIEW_TYPE_NEXUS_TUTOR;
                if (subMode) state.mode = subMode;
                break;
            case 'chat':
                viewType = VIEW_TYPE_NEXUS_CHAT;
                break;
            case 'feed':
                
                if (!PLATFORM_FEATURES.RSS_FEEDS) {
                                        new Notice('RSS feeds are not supported on mobile devices.', 5000);
                    return;
                }
                viewType = VIEW_TYPE_NEXUS_FEED;
                break;
            case 'feed-entries':
                
                if (!PLATFORM_FEATURES.RSS_FEEDS) {
                                        new Notice('RSS feeds are not supported on mobile devices.', 5000);
                    return;
                }
                viewType = VIEW_TYPE_NEXUS_FEED_ENTRIES;
                state.feedData = data;
                break;
            case 'combined-feed':
                
                if (!PLATFORM_FEATURES.RSS_FEEDS) {
                                        new Notice('RSS feeds are not supported on mobile devices.', 5000);
                    return;
                }
                viewType = VIEW_TYPE_COMBINED_FEED;
                break;
            case 'bookmarks':
                viewType = VIEW_TYPE_BOOKMARKS;
                break;
            default:
                                return;
        }

        let leaf: WorkspaceLeaf | null = null;
        const existingLeaves = this.app.workspace.getLeavesOfType(viewType);

        if (existingLeaves.length > 0) {
            leaf = existingLeaves[0];
        } else {
            leaf = isMobile ? this.app.workspace.getLeaf(true) : this.app.workspace.getRightLeaf(false);
        }

        if (leaf) {
            if (leaf.view.getViewType() !== viewType) {
                if (leaf.view.getViewType() !== 'empty') {
                    await leaf.setViewState({ type: 'empty' });
                }
                await leaf.setViewState({
                    type: viewType,
                    state,
                    active: true
                });
            } else if (Object.keys(state).length > 0) {
                
                await leaf.setViewState({
                    type: viewType,
                    state,
                    active: true
                });
            }
            
            this.app.workspace.revealLeaf(leaf);
        } else {
            new Notice(`Could not find or create leaf to open ${mode} view.`);
        }
    }

    async onunload() {
        
        if (this.mcpService) {
            await this.mcpService.disconnectAll();
        }

        
        const mcqOverlays = document.body.querySelectorAll('.mcq-error-overlay');
        mcqOverlays.forEach(overlay => overlay.remove());

        await this.notebookManager.saveNotebooks();
    }
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        
        
        const { settings: migratedSettings, migrated } = migrateSettings(this.settings);
        this.settings = migratedSettings;
        
        
        if (migrated) {
            
            this.saveData(this.settings).catch(err => {
                            });
        }
        
        
        setTimeout(() => {
            this.settings.bookmarkedEntries = this.settings.bookmarkedEntries.map(entry => ({
                ...entry,
                title: entry.title || undefined,
                link: entry.link || undefined,
                pubDate: entry.pubDate || undefined,
                content: entry.content || undefined,
                thumbnail: entry.thumbnail || undefined,
                feedName: entry.feedName || undefined,
            }));
        }, 0);
    }
    
    /**
     * Deferred Set initialization to avoid blocking plugin load
     * Populates Sets in the background after plugin is interactive
     */
    private deferredSetInitialization(): void {
        setTimeout(() => {
            
            if (this.settings.visitedEntries && this.settings.visitedEntries.length > 0) {
                this.visitedEntriesSet = new Set(this.settings.visitedEntries);
            }
            
            
            if (this.settings.bookmarkedEntries && this.settings.bookmarkedEntries.length > 0) {
                this.bookmarkedEntriesSet = new Set(
                    this.settings.bookmarkedEntries.map(entry => JSON.stringify(entry))
                );
            }
        }, 50); 
    }

    async saveSettings() {
        if (this.bookmarkedEntriesSet) {
            this.settings.bookmarkedEntries = Array.from(this.bookmarkedEntriesSet.values()).map(jsonString => JSON.parse(jsonString));
        }
        await this.saveData(this.settings);

        
        if (this.settings.openCodeApiKey) {
            UnifiedProviderManager.getInstance().registerProvider(
                new OpenCodeProvider(this.settings.openCodeApiKey)
            );
        }
        this.registerCustomProviders();
    }

    private registerCustomProviders() {
        
        UnifiedProviderManager.getInstance().getAllProviders().forEach(p => {
            if (p instanceof CustomOpenAIProvider) {
                UnifiedProviderManager.getInstance().unregisterProvider(p.id);
            }
        });

        if (this.settings.customProviders) {
            this.settings.customProviders.forEach(config => {
                UnifiedProviderManager.getInstance().registerProvider(
                    new CustomOpenAIProvider(config.id, config.name, config.baseUrl, config.apiKey)
                );
            });
        }
    }

    
    private async openResponseView(): Promise<ResponseView | null> {
        let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_NEXUS_CHAT)[0];
        
        if (!leaf) {
            const newLeaf = this.app.workspace.getRightLeaf(false);
            if (!newLeaf) {
                new Notice('Could not create new leaf');
                return null;
            }
            leaf = newLeaf;
            await leaf.setViewState({
                type: VIEW_TYPE_NEXUS_CHAT,
                state: { mode: 'chat' }
            });
        }
        
        const view = leaf.view;
        if (view instanceof ResponseView) {
            return view;
        }
        return null;
    }

    private async createIndexedFilesList(): Promise<void> {
        new IndexStatusModal(this.app, this.settings, this.embeddingsManager).open();
    }

    
    isEntryVisited(url: string): boolean {
        return this.visitedEntriesSet.has(url);
    }

    
    markEntryVisited(url: string): void {
        if (!this.visitedEntriesSet.has(url)) {
            this.visitedEntriesSet.add(url);
            
            this.saveSettings();
        }
    }

    
    isEntryBookmarked(entry: ParsedFeedEntry): boolean {
        return this.bookmarkedEntriesSet.has(JSON.stringify(entry));
    }

    
    addBookmark(entry: ParsedFeedEntry): void {
        const stringifiedEntry = JSON.stringify(entry);
        if (!this.bookmarkedEntriesSet.has(stringifiedEntry)) {
            this.bookmarkedEntriesSet.add(stringifiedEntry);
            this.settings.bookmarkedEntries.push(entry);
            this.saveSettings();
            new Notice(`'${entry.title || 'Entry'}' bookmarked!`);
        }
    }

    
    removeBookmark(entry: ParsedFeedEntry): void {
        const stringifiedEntry = JSON.stringify(entry);
        if (this.bookmarkedEntriesSet.has(stringifiedEntry)) {
            this.bookmarkedEntriesSet.delete(stringifiedEntry);
            this.settings.bookmarkedEntries = this.settings.bookmarkedEntries.filter(b => b.link !== entry.link);
            this.saveSettings();
            new Notice(`'${entry.title || 'Entry'}' bookmark removed.`);
        }
    }

    /**
     * Refreshes models from provider APIs (OpenRouter, Ollama Cloud, Nvidia).
     * Updates the custom models list and caches results for fallback.
     * This runs in the background after plugin load to avoid slowing down startup.
     */
    public async refreshModelsFromProviders(force: boolean = false): Promise<void> {
        // Prevent redundant background refreshes on every app reload
        const lastFetched = this.settings.modelCache?.lastFetched || 0;
        const CACHE_TTL = 60 * 60 * 1000; // 1 hour
        if (!force && Date.now() - lastFetched < CACHE_TTL) return;

        const config = {
            openRouterApiKey: this.settings.openRouterApiKey,
            openCodeApiKey: this.settings.openCodeApiKey,
            ollamaApiKey: this.settings.ollamaApiKey,
            ollamaBaseUrl: this.settings.ollamaBaseUrl,
            nvidiaApiKey: this.settings.nvidiaApiKey,
            geminiApiKey: this.settings.geminiApiKey,
            groqApiKey: this.settings.groqApiKey,
            customProviders: this.settings.customProviders
        };

        try {
            const results = await discoverModels(config);

            const cache = this.settings.modelCache || {};
            
            cache.customProviders = {};
            let hasUpdates = false;

            for (const result of results) {
                const models = toCustomModels(result);
                
                
                
                switch (result.provider) {
                    case 'gemini':
                        cache.gemini = models;
                        cache.geminiEmbeddings = result.embeddingModels ? toCustomModels({ ...result, models: result.embeddingModels }) : [];
                        hasUpdates = true;
                        break;
                    case 'openrouter':
                        cache.openrouter = models;
                        cache.openrouterEmbeddings = result.embeddingModels ? toCustomModels({ ...result, models: result.embeddingModels }) : [];
                        hasUpdates = true;
                        break;
                    case 'opencode':
                        cache.opencode = models;
                        hasUpdates = true;
                        break;
                    case 'ollama':
                        cache.ollama = models;
                        cache.ollamaEmbeddings = result.embeddingModels ? toCustomModels({ ...result, models: result.embeddingModels }) : [];
                        hasUpdates = true;
                        break;
                    case 'nvidia':
                        cache.nvidia = models;
                        cache.nvidiaEmbeddings = result.embeddingModels ? toCustomModels({ ...result, models: result.embeddingModels }) : [];
                        hasUpdates = true;
                        break;
                    case 'groq':
                        cache.groq = models;
                        hasUpdates = true;
                        break;
                    default:
                        
                        if (!cache.customProviders) cache.customProviders = {};
                        cache.customProviders[result.provider] = models;
                        if (result.embeddingModels && result.embeddingModels.length > 0) {
                            if (!cache.customProviderEmbeddings) cache.customProviderEmbeddings = {};
                            cache.customProviderEmbeddings[result.provider] = toCustomModels({ ...result, models: result.embeddingModels });
                        }
                        hasUpdates = true;
                        break;
                }
            }

            
            
            
            
            
            if (hasUpdates || results.length === 0) {
                cache.lastFetched = Date.now();
                this.settings.modelCache = cache;

                
                const existingModelMap = new Map(this.settings.customModels.map(m => [`${m.provider}:${m.id}`, m]));

                const dynamicModels = [
                    ...(cache.gemini || []),
                    ...(cache.openrouter || []),
                    ...(cache.opencode || []),
                    ...(cache.ollama || []),
                    ...(cache.nvidia || []),
                    ...(cache.groq || []),
                    ...Object.values(cache.customProviders || {}).flat()
                ].map(m => {
                    const existing = existingModelMap.get(`${m.provider}:${m.id}`);
                    if (existing) {
                        
                        return {
                            ...m,
                            enabled: existing.enabled ?? m.enabled,
                            lastVerified: existing.lastVerified,
                            verificationStatus: existing.verificationStatus,
                            verificationError: existing.verificationError,
                            verificationLatency: existing.verificationLatency,
                            isNew: existing.isNew ?? false 
                        };
                    }
                    return m;
                });

                
                
                const customProviderIds = new Set(this.settings.customProviders?.map(p => p.id) || []);
                const dynamicModelIds = new Set(dynamicModels.map(m => `${m.provider}:${m.id}`));
                const manualModels = this.settings.customModels.filter(m => 
                    customProviderIds.has(m.provider as string) && !dynamicModelIds.has(`${m.provider}:${m.id}`)
                );

                this.settings.customModels = [...manualModels, ...dynamicModels];

                
                const dynamicProviders = new Set(['gemini', 'openrouter', 'nvidia']);
                const nonDynamicEmbeddings = this.settings.customEmbeddingModels.filter(m =>
                    !dynamicProviders.has(m.provider) && !customProviderIds.has(m.provider)
                );

                const existingEmbeddingMap = new Map(this.settings.customEmbeddingModels.map(m => [`${m.provider}:${m.id}`, m]));

                const dynamicEmbeddingsRaw = [
                    ...(cache.geminiEmbeddings || []),
                    ...(cache.openrouterEmbeddings || []),
                    ...(cache.nvidiaEmbeddings || []),
                    ...Object.values(cache.customProviderEmbeddings || {}).flat()
                ];

                const dynamicEmbeddings = dynamicEmbeddingsRaw.map(m => {
                    const existing = existingEmbeddingMap.get(`${m.provider}:${m.id}`);
                    if (existing) {
                        return {
                            ...m,
                            enabled: existing.enabled ?? m.enabled,
                            lastVerified: existing.lastVerified,
                            verificationStatus: existing.verificationStatus,
                            verificationError: existing.verificationError,
                            isNew: existing.isNew ?? false
                        };
                    }
                    return m;
                });

                this.settings.customEmbeddingModels = [...nonDynamicEmbeddings, ...dynamicEmbeddings];

                await this.saveSettings();
            }
        } catch (error) {
                    }
    }

    /**
     * Verifies all models for a provider in the background.
     */
    async verifyProviderModels(provider: Provider, onComplete?: () => void) {
        if (this.verifyingProviders.has(provider)) return;

        this.verifyingProviders.add(provider);
        const models = this.settings.customModels.filter(m => m.provider === provider);
        
        if (models.length === 0) {
            this.verifyingProviders.delete(provider);
            if (onComplete) onComplete();
            return;
        }

        const notice = new Notice(`Verifying ${models.length} models for ${provider}...`, 0);
        let processedCount = 0;
        let hasCredits = true;

        if (provider === 'openrouter' && this.settings.openRouterApiKey) {
            try {
                const response = await requestUrl({
                    url: 'https://openrouter.ai/api/v1/credits',
                    headers: { 'Authorization': `Bearer ${this.settings.openRouterApiKey}` }
                });
                const data = response.json;
                if (data && data.data) {
                    const credits = data.data.total_credits ?? 0;
                    const usage = data.data.total_usage ?? 0;
                    if (credits - usage <= 0) {
                        hasCredits = false;
                    }
                }
            } catch (error) {
                            }
        }

        try {
            
            const CONCURRENCY_LIMIT = 5;
            const activeTasks = new Set<Promise<void>>();
            
            for (const model of models) {
                
                if (activeTasks.size >= CONCURRENCY_LIMIT) {
                    await Promise.race(activeTasks);
                }

                const taskPromise = (async () => {
                    let result: { success: boolean; error?: string; latency?: number };

                    if (provider === 'openrouter' && !hasCredits && !model.isFree) {
                        result = { success: false, error: 'Insufficient credits (Account balance is 0.00)' };
                    } else {
                        result = await verifyModel(model, this.settings);
                    }
                    
                    
                    const modelIndex = this.settings.customModels.findIndex(m => m.provider === model.provider && m.id === model.id);
                    if (modelIndex !== -1) {
                        const targetModel = this.settings.customModels[modelIndex];
                        targetModel.lastVerified = Date.now();
                        targetModel.isNew = false;
                        
                        if (result.success) {
                            targetModel.verificationStatus = 'verified';
                            targetModel.verificationError = undefined;
                            targetModel.verificationLatency = result.latency;
                            targetModel.enabled = true; 
                        } else {
                            targetModel.verificationStatus = 'failed';
                            targetModel.verificationError = result.error;
                            targetModel.enabled = false; 
                        }
                    }
                    processedCount++;
                    notice.setMessage(`Verifying models for ${provider}: ${processedCount}/${models.length}...`);

                    
                    if (processedCount % 5 === 0 || processedCount === models.length) {
                        await this.saveSettings();
                    }
                })();

                
                activeTasks.add(taskPromise);
                taskPromise.finally(() => activeTasks.delete(taskPromise));
            }

            
            await Promise.all(activeTasks);
            
            notice.setMessage(`Verification complete for ${provider}: ${processedCount} models processed.`);
            setTimeout(() => notice.hide(), 4000);
        } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
            notice.setMessage(`Verification failed for ${provider}: ${errorMessage}`);
            setTimeout(() => notice.hide(), 5000);
        } finally {
            const now = Date.now();
            let unresponsiveCount = 0;
            for (const m of this.settings.customModels) {
                if (m.provider !== provider) continue;
                if (m.isNew || !m.lastVerified || m.verificationStatus === 'unverified') {
                    m.isNew = false;
                    m.lastVerified = now;
                    m.verificationStatus = 'failed';
                    m.verificationError = 'Verification did not complete - model unresponsive';
                    m.enabled = false;
                    unresponsiveCount++;
                }
            }
            if (unresponsiveCount > 0) {
                await this.saveSettings();
                new Notice(`${unresponsiveCount} model(s) are unverified due to unresponsiveness, please verify availability manually for these models`, 8000);
            }
            this.verifyingProviders.delete(provider);
            if (onComplete) onComplete();
        }
    }

    /**
     * Verifies all embedding models for a provider in the background.
     */
    async verifyProviderEmbeddingModels(provider: Provider, onComplete?: () => void) {
        if (this.verifyingEmbeddingProviders.has(provider)) return;

        this.verifyingEmbeddingProviders.add(provider);
        const models = this.settings.customEmbeddingModels.filter(m => m.provider === provider);
        
        if (models.length === 0) {
            this.verifyingEmbeddingProviders.delete(provider);
            if (onComplete) onComplete();
            return;
        }

        const notice = new Notice(`Verifying ${models.length} embedding models for ${provider}...`, 0);
        let processedCount = 0;
        let hasCredits = true;

        if (provider === 'openrouter' && this.settings.openRouterApiKey) {
            try {
                const response = await requestUrl({
                    url: 'https://openrouter.ai/api/v1/credits',
                    headers: { 'Authorization': `Bearer ${this.settings.openRouterApiKey}` }
                });
                const data = response.json;
                if (data && data.data) {
                    const credits = data.data.total_credits ?? 0;
                    const usage = data.data.total_usage ?? 0;
                    if (credits - usage <= 0) {
                        hasCredits = false;
                    }
                }
            } catch (error) {
                            }
        }

        try {
            
            const CONCURRENCY_LIMIT = 5;
            const activeTasks = new Set<Promise<void>>();
            
            for (const model of models) {
                
                if (activeTasks.size >= CONCURRENCY_LIMIT) {
                    await Promise.race(activeTasks);
                }

                const taskPromise = (async () => {
                    let result: { success: boolean; error?: string };

                    if (provider === 'openrouter' && !hasCredits && !model.isFree) {
                        result = { success: false, error: 'Insufficient credits (Account balance is 0.00)' };
                    } else {
                        result = await verifyEmbeddingModel(model, this.settings);
                    }
                    
                    
                    const modelIndex = this.settings.customEmbeddingModels.findIndex(m => m.provider === model.provider && m.id === model.id);
                    if (modelIndex !== -1) {
                        const targetModel = this.settings.customEmbeddingModels[modelIndex];
                        targetModel.lastVerified = Date.now();
                        targetModel.isNew = false;
                        
                        if (result.success) {
                            targetModel.verificationStatus = 'verified';
                            targetModel.verificationError = undefined;
                            targetModel.enabled = true; 
                        } else {
                            targetModel.verificationStatus = 'failed';
                            targetModel.verificationError = result.error;
                            targetModel.enabled = false; 
                        }
                    }
                    processedCount++;
                    notice.setMessage(`Verifying embedding models for ${provider}: ${processedCount}/${models.length}...`);

                    
                    if (processedCount % 5 === 0 || processedCount === models.length) {
                        await this.saveSettings();
                    }
                })();

                
                activeTasks.add(taskPromise);
                taskPromise.finally(() => activeTasks.delete(taskPromise));
            }

            
            await Promise.all(activeTasks);
            
            notice.setMessage(`Verification complete for ${provider}: ${processedCount} embedding models processed.`);
            setTimeout(() => notice.hide(), 4000);
        } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
            notice.setMessage(`Embedding verification failed for ${provider}: ${errorMessage}`);
            setTimeout(() => notice.hide(), 5000);
        } finally {
            const now = Date.now();
            let unresponsiveCount = 0;
            for (const m of this.settings.customEmbeddingModels) {
                if (m.provider !== provider) continue;
                if (m.isNew || !m.lastVerified || m.verificationStatus === 'unverified') {
                    m.isNew = false;
                    m.lastVerified = now;
                    m.verificationStatus = 'failed';
                    m.verificationError = 'Verification did not complete - model unresponsive';
                    m.enabled = false;
                    unresponsiveCount++;
                }
            }
            if (unresponsiveCount > 0) {
                await this.saveSettings();
                new Notice(`${unresponsiveCount} embedding model(s) are unverified due to unresponsiveness, please verify availability manually for these models`, 8000);
            }
            this.verifyingEmbeddingProviders.delete(provider);
            if (onComplete) onComplete();
        }
    }
}