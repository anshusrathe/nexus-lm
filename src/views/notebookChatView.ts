import { ItemView, WorkspaceLeaf, Notice, TFile, ButtonComponent, TextAreaComponent, setIcon, Platform } from 'obsidian';
import { MarkdownRenderer, Component } from 'obsidian';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AISettings, Provider, getModelsGroupedByProvider, getModelDisplayName, getProviderForModel, getModelTemperature, getModelTopP } from '../settings';
import { Notebook, NotebookChatHistoryManager, NotebookChatSession, NotebookChatSessionMeta } from '../managers/notebookManager';
import AIPlugin from '../main';
import { Modal, Setting } from 'obsidian';

import { normalizePath } from 'obsidian';
import { SaveNoteModal } from '../modals/saveNoteModal';
import { PLATFORM_FEATURES } from '../utils/platformFeatures';
import { GroqService, ChatMessage as GroqChatMessage, GroqApiError } from '../services/groqService';
import { OpenRouterService, ChatMessage as OpenRouterChatMessage, OpenRouterApiError } from '../services/openRouterService';
import { OllamaService, ChatMessage as OllamaChatMessage, OllamaApiError } from '../services/ollamaService';
import { NvidiaService, ChatMessage as NvidiaChatMessage, NvidiaApiError } from '../services/nvidiaService';
import { RateLimitManager } from '../utils/rateLimitManager';
import { GeminiService } from '../services/geminiService';
import { UnifiedProviderManager } from '../services/unifiedProviderManager';
import { WebSearchService } from '../services/webSearch';
import {
  NotebookQuizGenerator,
  NotebookFlashcardGenerator,
  QuizRenderer,
  FlashcardRenderer,
  QuizState,
  FlashcardState,
  NotebookMCQ,
  NotebookFlashcard
} from '../managers/notebookQuizFlashcards';
import { NotebookBM25Manager, NotebookSourceStatus as BM25SourceStatus } from '../managers/notebookBM25Manager';

export const VIEW_TYPE_NOTEBOOK_CHAT = 'notebook-chat-view';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  sourceMapping?: string[]; 
}



function countTokens(text: string): number {
  return Math.ceil(text.length / 4); 
}


interface ExpandedQuery {
  original: string;
  expanded: string;
  subQueries: string[];
  keyTerms: string[];
}

export class NotebookChatView extends ItemView {
  private settings: AISettings;
  private plugin: AIPlugin;
  private notebook!: Notebook; 
  private messages: ChatMessage[] = [];
  private container: HTMLElement;
  private chatInput!: TextAreaComponent;
  private responsesContainer!: HTMLElement;
  private modelSelectButton!: ButtonComponent;

  
  private contextBarContainer!: HTMLElement;
  private contextProgressBar!: HTMLElement;
  private contextLabel!: HTMLElement;

  private chatHistoryManager: NotebookChatHistoryManager;
  private currentSession: NotebookChatSession | null = null;
  private sessionSelectorContainer!: HTMLElement;
  private sessionListContainer!: HTMLElement;
  private sessionActionsContainer!: HTMLElement;

  private rateLimitManager: RateLimitManager; 
  private webSearchService: WebSearchService;

  
  private notebookBM25Manager: NotebookBM25Manager | null = null; 
  private sourceStatuses: BM25SourceStatus[] = [];
  private ragSettingsContainer!: HTMLElement;
  private isIndexing: boolean = false;

  
  private dynamicTokens: number = 0; 
  private cagHistoryContextLength: number = 0; 

  
  private isMobile: boolean = Platform.isMobile;
  private mobileActiveTab: 'sources' | 'chat' = 'chat';
  private mobileTabRow!: HTMLElement;
  private mobileSourcesTab!: HTMLElement;
  private mobileChatTab!: HTMLElement;
  private outputTokens: number = 0; 
  private isGenerating: boolean = false;
  private tokenBarResetTimeout: ReturnType<typeof setTimeout> | null = null;

  
  private contextCache: {
    context: string;
    noteMeta: { path: string; mtime: number }[];
    sourcePaths: string[];
  } | null = null;

  
  private cacheDir: string = '.Nexus-LM-data/notebook-cache';

  
  private getCacheFilePath(): string {
    return normalizePath(`${this.cacheDir}/${this.notebook.id}.json`);
  }

  
  private async loadPersistentCache(): Promise<void> {
    try {
      const cachePath = this.getCacheFilePath();
      const exists = await this.app.vault.adapter.exists(cachePath);
      if (exists) {
        const json = await this.app.vault.adapter.read(cachePath);
        this.contextCache = JSON.parse(json);
      }
    } catch (e) {
      
    }
  }

  
  private async savePersistentCache(): Promise<void> {
    try {
      
      const exists = await this.app.vault.adapter.exists(this.cacheDir);
      if (!exists) {
        await this.app.vault.adapter.mkdir(this.cacheDir);
      }
      const cachePath = this.getCacheFilePath();
      await this.app.vault.adapter.write(cachePath, JSON.stringify(this.contextCache));
    } catch (e) {
      
    }
  }

  
  private async getCachedContext(): Promise<string> {
    
    const effectivePaths = this.getEffectiveSourcePaths();
    const selectedPaths = effectivePaths.filter(p => this.selectedSourcePaths.has(p));
    
    const effectiveWebSources = await this.getEffectiveWebSources();
    const selectedWebs = effectiveWebSources.filter(web => this.selectedSourcePaths.has(`web:${web.url}`));
    
    if (
      !this.contextCache ||
      !this.contextCache.sourcePaths ||
      this.contextCache.sourcePaths.length !== selectedPaths.length ||
      this.contextCache.sourcePaths.some((p, i) => p !== selectedPaths[i])
    ) {
      this.contextCache = null;
    }
    if (!this.contextCache) {
      const fileContents: string[] = [];
      const noteMeta: { path: string; mtime: number }[] = [];
      for (const path of selectedPaths) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          try {
            const content = await this.app.vault.read(file);
            
            
            
            fileContents.push(`--- File: ${file.basename} ---\n${content}\n`);
            noteMeta.push({ path, mtime: file.stat.mtime });
          } catch (e) {
            new Notice(`Could not read file: ${file.basename}`);
          }
        }
      }
      
      
      const context = fileContents.join('\n');
      this.contextCache = {
        context,
        noteMeta,
        sourcePaths: [...selectedPaths],
      };
      await this.savePersistentCache();
    }
    return this.contextCache.context;
  }

  
  private async getContextForExplanation(question: string): Promise<string> {
    
    if (this.notebook.mode === 'rag' && this.notebookBM25Manager) {
      try {
        const isIndexed = await this.notebookBM25Manager.isIndexed();
        if (isIndexed) {
          
          const effectivePaths = this.getEffectiveSourcePaths();
          const selectedPaths = effectivePaths.filter(p => this.selectedSourcePaths.has(p));
          if (selectedPaths.length > 0) {
            const results = await this.notebookBM25Manager.findSimilarContent(
              question,
              selectedPaths,
              3, 
              true 
            );

            if (results.length > 0) {
              const contextParts: string[] = [];
              results.forEach(result => {
                const file = this.app.vault.getAbstractFileByPath(result.path);
                const fileName = file && 'basename' in file ? (file as SafeAny).basename : result.path.split('/').pop();
                contextParts.push(`--- From: ${fileName} ---\n${result.content}\n`);
              });
              return contextParts.join('\n');
            }
          }
        }
      } catch (error) {
        
      }
    }
    
    return await this.getCachedContext();
  }

  

  /**
   * Expand user query using LLM to improve retrieval
   * Generates paraphrases, sub-queries, and key terms
   */
  private async expandQuery(query: string): Promise<ExpandedQuery> {
    const result: ExpandedQuery = {
      original: query,
      expanded: query,
      subQueries: [],
      keyTerms: []
    };

    
    if (query.length < 15 || query.split(/\s+/).length < 4) {
      
      result.keyTerms = this.extractKeyTerms(query);
      result.expanded = query;
      return result;
    }

    try {
      const expansionPrompt = `You are a search query optimizer. Given a user question, generate search variations to improve retrieval.

USER QUESTION: "${query}"

Respond in this exact JSON format (no markdown, just JSON):
{
  "paraphrases": ["alternative phrasing 1", "alternative phrasing 2"],
  "subQueries": ["specific sub-question 1", "specific sub-question 2"],
  "keyTerms": ["important term 1", "important term 2", "important term 3"]
}

Rules:
- Generate 2 paraphrases that capture the same intent differently
- Generate 2 sub-queries that break down complex questions
- Extract 3-5 key terms/concepts that should be searched
- Keep all variations concise and search-friendly
- Focus on the core information need`;

      let responseText = '';

      if (this.settings.notebookProvider === 'gemini') {
        const genAI = new GoogleGenerativeAI(this.settings.geminiApiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' }); 
        const response = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: expansionPrompt }] }],
          generationConfig: { temperature: getModelTemperature(this.settings.notebookModel, this.settings), maxOutputTokens: 500 }
        });
        responseText = response.response.text();
      } else if (this.settings.notebookProvider === 'groq') {
        const groqService = new GroqService(
          this.settings.groqApiKey,
          (headers) => this.rateLimitManager.updateFromHeaders('groq', 'llama-3.1-8b-instant', headers)
        );
        responseText = await groqService.generateContent(
          'llama-3.1-8b-instant', 
          [{ role: 'user', content: expansionPrompt }],
          { temperature: getModelTemperature(this.settings.notebookModel, this.settings), maxTokens: 500, topP: getModelTopP(this.settings.notebookModel, this.settings) }
        );
      } else if (this.settings.notebookProvider === 'openrouter') {
        const openRouterService = new OpenRouterService(
          this.settings.openRouterApiKey,
          (headers) => this.rateLimitManager.updateFromHeaders('openrouter', this.settings.notebookModel, headers)
        );
        responseText = await openRouterService.generateContent(
          this.settings.notebookModel, 
          [{ role: 'user', content: expansionPrompt }],
          { temperature: getModelTemperature(this.settings.notebookModel, this.settings), maxTokens: 500, topP: getModelTopP(this.settings.notebookModel, this.settings) }
        );
      } else if (this.settings.notebookProvider === 'ollama') {
        const ollamaService = new OllamaService(
          this.settings.ollamaBaseUrl,
          this.settings.ollamaApiKey || '',
          (headers) => this.rateLimitManager.updateFromHeaders('ollama', this.settings.notebookModel, headers)
        );
        responseText = await ollamaService.generateContent(
          this.settings.notebookModel,
          [{ role: 'user', content: expansionPrompt }],
          { temperature: getModelTemperature(this.settings.notebookModel, this.settings), maxTokens: 500, topP: getModelTopP(this.settings.notebookModel, this.settings) }
        );
      } else if (this.settings.notebookProvider === 'nvidia') {
        const nvidiaService = new NvidiaService(
          this.settings.nvidiaApiKey,
          (headers) => this.rateLimitManager.updateFromHeaders('nvidia', this.settings.notebookModel, headers)
        );
        responseText = await nvidiaService.generateContent(
          this.settings.notebookModel,
          [{ role: 'user', content: expansionPrompt }],
          { temperature: getModelTemperature(this.settings.notebookModel, this.settings), maxTokens: 500, topP: getModelTopP(this.settings.notebookModel, this.settings) }
        );
      } else if (UnifiedProviderManager.getInstance().hasProvider(this.settings.notebookProvider)) {
        const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(this.settings.notebookProvider)!;
        const response = await unifiedProvider.generateContent(
          this.settings.notebookModel,
          [{ role: 'user', content: expansionPrompt }],
          { temperature: getModelTemperature(this.settings.notebookModel, this.settings), maxTokens: 500, topP: getModelTopP(this.settings.notebookModel, this.settings) }
        );
        responseText = response.text;
      }

      
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        result.subQueries = parsed.subQueries || [];
        result.keyTerms = parsed.keyTerms || [];

        
        const paraphrases = parsed.paraphrases || [];
        result.expanded = [query, ...paraphrases].join(' | ');
      }
    } catch (error) {
      
      result.keyTerms = this.extractKeyTerms(query);
    }

    return result;
  }

  /**
   * Simple key term extraction without LLM
   */
  private extractKeyTerms(query: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
      'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'can', 'what', 'which', 'who', 'how',
      'why', 'when', 'where', 'this', 'that', 'these', 'those', 'i', 'you',
      'he', 'she', 'it', 'we', 'they', 'my', 'your', 'his', 'her', 'its',
      'our', 'their', 'me', 'him', 'us', 'them', 'about', 'into', 'through'
    ]);

    return query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word))
      .slice(0, 5);
  }

  
  private async getRagContext(query: string): Promise<string> {
    if (!this.notebookBM25Manager) {
      return await this.getCachedContext(); 
    }

    
    const effectivePaths = this.getEffectiveSourcePaths();
    const selectedPaths = effectivePaths.filter(p => this.selectedSourcePaths.has(p));

    if (selectedPaths.length === 0) {
      return '';
    }

    
    const isIndexed = await this.notebookBM25Manager.isIndexed();
    if (!isIndexed) {
      new Notice('Keyword index not built yet. Please build the index first.');
      return await this.getCachedContext(); 
    }

    try {
      
      
      const expandedQuery = await this.expandQuery(query);

      
      const searchQuery = expandedQuery.expanded;

      
      const results = await this.notebookBM25Manager.findSimilarContent(
        searchQuery,
        selectedPaths,
        5, 
        true 
      );

      
      
      const highConfidence = results.length > 0 && results.some(r => r.similarity > 0.3);

      
      if (!highConfidence && results.length < 3 && expandedQuery.subQueries.length > 0) {
        for (const subQuery of expandedQuery.subQueries.slice(0, 2)) {
          const subResults = await this.notebookBM25Manager.findSimilarContent(
            subQuery,
            selectedPaths,
            2, 
            false 
          );
          
          for (const sr of subResults) {
            if (!results.find(r => r.path === sr.path && r.chunkIndex === sr.chunkIndex)) {
              results.push(sr);
            }
          }
        }
      }

      if (results.length === 0) {
        
        return await this.getCachedContext();
      }

      
      const fileContents: string[] = [];

      
      const fileGroups = new Map<string, typeof results>();
      results.forEach(result => {
        if (!fileGroups.has(result.path)) {
          fileGroups.set(result.path, []);
        }
        fileGroups.get(result.path)!.push(result);
      });

      
      const sortedFiles = Array.from(fileGroups.entries())
        .sort((a, b) => Math.max(...b[1].map(r => r.similarity)) - Math.max(...a[1].map(r => r.similarity)));

      
      
      const documentSummaries = this.notebookBM25Manager.getDocumentSummaries(
        Array.from(fileGroups.keys())
      );

      if (documentSummaries.length > 0) {
        fileContents.push(`=== DOCUMENT OVERVIEWS ===`);
        documentSummaries.forEach((ds, idx) => {
          const file = this.app.vault.getAbstractFileByPath(ds.path);
          const fileName = file && 'basename' in file ? (file as SafeAny).basename : ds.path.split('/').pop();
          fileContents.push(`[${fileName}]: ${ds.summary}`);
        });
        fileContents.push(`=== RELEVANT Info ===\n`);
      }

      let sourceIndex = 1;
      const sourcePathMapping: string[] = []; 

      
      sortedFiles.forEach(([filePath, fileResults]) => {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        const fileName = file && 'basename' in file ? (file as SafeAny).basename : filePath.split('/').pop();

        
        const contentParts = fileResults.map(r => r.content).join('\n\n');

        
        fileContents.push(
          `--- Source ${sourceIndex}: ${fileName} ---\n${contentParts}\n`
        );
        sourcePathMapping.push(filePath); 
        sourceIndex++;
      });

      
      

      
      this.currentSourceMapping = sourcePathMapping;

      return fileContents.join('\n');
    } catch (error) {
      new Notice('Error retrieving context. Falling back to full context.');
      return await this.getCachedContext();
    }
  }

  
  private async invalidateContextCache(): Promise<void> {
    this.contextCache = null;
    
    try {
      const cachePath = this.getCacheFilePath();
      const exists = await this.app.vault.adapter.exists(cachePath);
      if (exists) {
        await this.app.vault.adapter.remove(cachePath);
      }
    } catch (e) {
      
    }
  }

  
  private async getNoteMeta(): Promise<{ path: string; mtime: number }[]> {
    const meta: { path: string; mtime: number }[] = [];
    const effectivePaths = this.getEffectiveSourcePaths();
    for (const path of effectivePaths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        meta.push({ path, mtime: file.stat.mtime });
      }
    }
    return meta;
  }

  
  private async isCacheValid(): Promise<boolean> {
    if (!this.contextCache) return false;
    const effectivePaths = this.getEffectiveSourcePaths();
    if (!this.contextCache.sourcePaths || this.contextCache.sourcePaths.length !== effectivePaths.length) return false;
    if (this.contextCache.sourcePaths.some((p, i) => p !== effectivePaths[i])) return false;
    const currentMeta = await this.getNoteMeta();
    if (currentMeta.length !== this.contextCache.noteMeta.length) return false;
    for (let i = 0; i < currentMeta.length; i++) {
      if (currentMeta[i].path !== this.contextCache.noteMeta[i].path || currentMeta[i].mtime !== this.contextCache.noteMeta[i].mtime) {
        return false;
      }
    }
    return true;
  }

  private selectedSourcePaths: Set<string> = new Set();
  private sourcesContainer!: HTMLElement;
  private currentSourceMapping: string[] = []; 
  private sourceViewMode: 'notes' | 'web' = 'notes'; 
  private effectiveWebSourcesCache: { url: string; name: string }[] = []; 
  private previousModel: { modelId: string; provider: string } | null = null; 

  constructor(leaf: WorkspaceLeaf, settings: AISettings, plugin: AIPlugin) {
    super(leaf);
    this.settings = settings;
    this.plugin = plugin;
    this.rateLimitManager = RateLimitManager.getInstance(); 
    this.webSearchService = new WebSearchService();
    this.container = this.contentEl.createDiv({ cls: 'notebook-chat-container' });
    this.chatHistoryManager = new NotebookChatHistoryManager(this.app);
  }

  getViewType() { return VIEW_TYPE_NOTEBOOK_CHAT; }
  getDisplayText() { return this.notebook ? `Notebook: ${this.notebook.name}` : 'Notebook'; }
  getIcon(): string { return 'notebook'; }

  
  private getEffectiveSourcePaths(): string[] {
    const paths = new Set<string>();

    
    if (this.notebook.sourcePaths) {
      this.notebook.sourcePaths.forEach(path => paths.add(path));
    }

    
    if (this.notebook.sourceFolders && this.notebook.sourceFolders.length > 0) {
      this.notebook.sourceFolders.forEach(folderPath => {
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (folder && 'children' in folder) {
          
          const files = this.app.vault.getMarkdownFiles().filter((file: TFile) =>
            file.path.startsWith(folderPath + '/')
          );
          files.forEach((file: TFile) => paths.add(file.path));
        }
      });
    }

    return Array.from(paths);
  }

  
  private async getEffectiveWebSources(): Promise<{ url: string; name: string }[]> {
    const webSources = [...(this.notebook.webSources || [])];

    
    if (this.notebook.feedSources && this.notebook.feedSources.length > 0) {
      for (const feedSource of this.notebook.feedSources) {
        try {
          
          const { parseFeed } = await import('../parsing/feedParsing');
          const feedData = await parseFeed(feedSource.url, feedSource.name);

          if (feedData && feedData.entries) {
            
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - feedSource.durationDays);

            const recentEntries = feedData.entries.filter(entry => {
              if (!entry.pubDate) return false;
              const entryDate = new Date(entry.pubDate);
              return entryDate >= cutoffDate;
            });

            
            recentEntries.forEach(entry => {
              if (entry.link && entry.title) {
                webSources.push({
                  url: entry.link,
                  name: `[${feedSource.name}] ${entry.title}`
                });
              }
            });
          }
        } catch (error) {
          
        }
      }
    }

    return webSources;
  }

  async onOpen() {
    
    await this.loadPersistentCache();
  }

  
  getState(): SafeAny {
    return {
      notebook: this.notebook,
      currentSessionId: this.currentSession?.id || null
    };
  }

  
  async setState(state: SafeAny, result: SafeAny) {
    
    if (state && state.notebook && (!this.notebook || this.notebook.id !== state.notebook.id)) {
      this.notebook = state.notebook;

      
      await this.loadPersistentCache();

      
      await this.renderSessionSelector();

      
      if (state.currentSessionId) {
        const sessions = await this.chatHistoryManager.listSessions(this.notebook.id);
        const sessionExists = sessions.some(s => s.id === state.currentSessionId);
        if (sessionExists) {
          await this.loadSession(state.currentSessionId);
        }
      }

      
      this.loadSourcesAsync();
    }
    super.setState(state, result);
  }

  
  private async loadSourcesAsync(): Promise<void> {
    try {
      
      this.effectiveWebSourcesCache = await this.getEffectiveWebSources();

      
      if (this.notebook.mode === 'rag') {
        
        const effectivePaths = this.getEffectiveSourcePaths();

        
        this.notebookBM25Manager = new NotebookBM25Manager(
          this.app,
          this.settings,
          this.notebook.id,
          effectivePaths
        );
        
        this.notebookBM25Manager.getSourcesStatus().then(statuses => {
          this.sourceStatuses = statuses;
          
          if (this.sourcesContainer) {
            this.renderSourcesPanel();
          }
        }).catch(error => {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          new Notice(`Failed to update index status: ${errorMessage}`);
          this.sourceStatuses = [];
        });
      } else {
        this.notebookBM25Manager = null;
        this.sourceStatuses = [];
        
        
        if (this.sourcesContainer) {
          this.renderSourcesPanel();
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Some sources failed to load: ${errorMessage}. Please check your notebook configuration.`);
    }
  }

  
  private async renderSessionSelector() {
    this.container.empty();

    
    if (this.isMobile) {
      this.container.addClass('notebook-mobile-view');
    }

    this.sessionSelectorContainer = this.container.createDiv({ cls: 'session-selector-container' });
    this.sessionActionsContainer = this.sessionSelectorContainer.createDiv({ cls: 'session-actions-container' });
    new ButtonComponent(this.sessionActionsContainer)
      .setIcon('plus-circle')
      .setTooltip('New Session')
      .onClick(async () => {
        new RenameSessionModal(this.app, '', async (newName) => {
          const session = await this.chatHistoryManager.createSession(this.notebook.id, newName.trim());
          await this.loadSession(session.id);
        }).open();
      });
    this.sessionListContainer = this.sessionSelectorContainer.createDiv({ cls: 'session-list-container' });
    await this.renderSessionList();
    
    if (!this.currentSession) {
      const sessions = await this.chatHistoryManager.listSessions(this.notebook.id);
      if (sessions.length > 0) {
        await this.loadSession(sessions[sessions.length - 1].id);
      }
    }
  }

  private async renderSessionList() {
    this.sessionListContainer.empty();
    const sessions = await this.chatHistoryManager.listSessions(this.notebook.id);
    if (sessions.length === 0) {
      this.sessionListContainer.createEl('div', { text: 'No sessions yet. Start a new one!', cls: 'no-sessions-message' });
      return;
    }
    sessions.forEach(meta => {
      const card = this.sessionListContainer.createDiv({ cls: 'session-card' });
      card.createSpan({ text: meta.name, cls: 'session-name' });
      card.createSpan({ text: new Date(meta.createdAt).toLocaleString(), cls: 'session-date' });
      card.onClickEvent(() => this.loadSession(meta.id));
      
      const actions = card.createDiv({ cls: 'session-actions' });
      
      new ButtonComponent(actions)
        .setIcon('download')
        .setTooltip('Export Session as Markdown')
        .onClick(async (e) => {
          e.stopPropagation();
          const session = await this.chatHistoryManager.loadSession(this.notebook.id, meta.id);
          if (!session) {
            new Notice('Failed to load session for export.');
            return;
          }

          const safeName = session.name.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 32) || session.id;
          const defaultFileName = `notebook-chat-${safeName}.md`;
          const defaultDirectory = 'Notebook Exports';

          new SaveNoteModal(this.app, defaultFileName, defaultDirectory, this.settings, async (fileName, directory, templatePath) => {
            try {
              
              let md = `# Chat Session: ${session.name}\n\n`;
              session.messages.forEach((msg) => {
                if (msg.role === 'user') {
                  md += `## User\n${msg.content}\n\n`;
                } else {
                  md += `## Assistant\n${msg.content}\n\n`;
                }
              });

              
              if (templatePath) {
                const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
                if (templateFile instanceof TFile) {
                  const templateContent = await this.app.vault.read(templateFile);
                  md = templateContent + '\n\n' + md;
                }
              }

              const filePath = normalizePath(`${directory}/${fileName}`);

              
              const folderPath = directory;
              const exists = await this.app.vault.adapter.exists(folderPath);
              if (!exists) {
                await this.app.vault.adapter.mkdir(folderPath);
              }

              await this.app.vault.create(filePath, md);
              new Notice(`Exported to ${filePath}`);
            } catch (err) {
              const errorMessage = err instanceof Error ? err.message : 'Unknown error';
              new Notice(`Failed to export chat as markdown: ${errorMessage}`);
            }
          }).open();
        });
      
      new ButtonComponent(actions)
        .setIcon('trash')
        .setTooltip('Delete Session')
        .onClick(async (e) => {
          e.stopPropagation();
          await this.deleteSession(meta.id);
        });
    });
  }

  private async loadSession(sessionId: string) {
    
    this.contextCache = null;
    await this.loadPersistentCache();
    
    const session = await this.chatHistoryManager.loadSession(this.notebook.id, sessionId);
    if (session) {
      this.currentSession = session;
      this.messages = []; 
      this.messages = [...session.messages];

      
      
      this.selectedSourcePaths.clear();

      this.renderInitial();
      await this.renderSessionList();
    }
  }

  private async deleteSession(sessionId: string) {
    const file = normalizePath(`.Nexus-LM-data/notebook-chat-history/${this.notebook.id}/${sessionId}.json`);
    try {
      await this.app.vault.adapter.remove(file);
      if (this.currentSession && this.currentSession.id === sessionId) {
        this.currentSession = null;
        this.messages = [];
        await this.invalidateContextCache(); 
        await this.renderSessionSelector();
      } else {
        await this.renderSessionList();
      }
    } catch (e) {
      new Notice('Failed to delete session.');
    }
  }

  
  private contextMenuEl: HTMLElement | null = null;

  
  renderInitial() {
    this.container.empty();

    
    if (this.isMobile) {
      this.container.addClass('notebook-mobile-view');
      this.renderMobileLayout();
      return;
    }

    
    
    this.sourcesContainer = this.container.createDiv({ cls: 'notebook-sources-panel' });

    
    const sessionBar = this.sourcesContainer.createDiv({ cls: 'session-bar' });
    new ButtonComponent(sessionBar)
      .setIcon('arrow-left')
      .setTooltip('Back to sessions')
      .onClick(() => this.renderSessionSelector());
    sessionBar.createSpan({ text: this.currentSession ? this.currentSession.name : 'No session', cls: 'session-bar-title' });

    
    this.contextBarContainer = this.sourcesContainer.createDiv({ cls: 'context-bar-container' });
    this.contextProgressBar = this.contextBarContainer.createDiv({ cls: 'context-progress-bar' });
    this.contextLabel = this.contextBarContainer.createDiv({ cls: 'context-label' });
    this.renderSourcesPanel();

    
    this.responsesContainer = this.container.createDiv({ cls: 'responses-container' });
    
    this.messages.forEach(msg => this.addMessage(msg.role, msg.content, false, [], false, msg.sourceMapping));

    
    const chatInputContainer = this.container.createDiv({ cls: 'chat-input-container notebook-chat-input-container' });

    
    const modelRow = chatInputContainer.createDiv({ cls: 'notebook-model-row' });
    this.modelSelectButton = new ButtonComponent(modelRow)
      .setButtonText(getModelDisplayName(this.settings.notebookModel, this.settings))
      .setClass('model-select-btn')
      .onClick(() => this.showModelMenu());
    
    
    this.renderModeToggle(modelRow);

    
    const inputRow = chatInputContainer.createDiv({ cls: 'notebook-input-row' });

    
    const leftControls = inputRow.createDiv({ cls: 'notebook-input-left-controls' });
    const plusBtn = leftControls.createDiv({ cls: 'context-menu-btn' });
    setIcon(plusBtn, 'plus');
    plusBtn.addClass('nl-cursor-pointer');
    plusBtn.setAttribute('aria-label', 'Add context');
    plusBtn.setAttribute('tabindex', '0');
    plusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openPrefixMenu(plusBtn);
    });

    
    this.chatInput = new TextAreaComponent(inputRow)
      .setPlaceholder('Ask a question...');
    this.chatInput.inputEl.rows = 1;
    this.chatInput.inputEl.classList.add('chat-textarea', 'flexible-textarea', 'notebook-query-input');

    
    this.chatInput.inputEl.addEventListener('input', function () {
      const parent = this.parentElement;
      if (parent) {
        parent.setCssProps({ 'min-height':  parent.clientHeight + 'px' });
      }
      this.addClass('nl-height-auto');
      this.setCssProps({ 'height':  Math.min(this.scrollHeight, 200) + 'px' });
      if (parent) {
        parent.addClass('nl-min-height-');
      }
    });

    
    const prompts = [
      'Ask any question based on sources...',
      'Use prefix @session to add sessions as context...',
      'Use prefix @quiz to generate MCQ quizzes...',
      'Use prefix @flashcards to create study cards...',
      'Full context → Sends whole context of the selected sources. AI sees the whole context, slow but powerful',
      'Keyword based → For facts use this. Keyword-filled query excels, fast'
    ];
    let promptIndex = 0;
    let placeholderInterval: SafeAny = null;
    let isInputActive = false;
    const setNextPlaceholder = () => {
      if (!isInputActive && document.activeElement !== this.chatInput.inputEl) {
        promptIndex = (promptIndex + 1) % prompts.length;
        if (this.chatInput.getValue().trim() === '') {
          this.chatInput.setPlaceholder(prompts[promptIndex]);
        }
      }
    };
    placeholderInterval = setInterval(setNextPlaceholder, 3500);
    this.chatInput.inputEl.addEventListener('focus', () => {
      isInputActive = true;
    });
    this.chatInput.inputEl.addEventListener('blur', () => {
      isInputActive = false;
      if (this.chatInput.getValue().trim() === '') {
        this.chatInput.setPlaceholder(prompts[promptIndex]);
      }
    });
    this.chatInput.inputEl.addEventListener('input', () => {
      isInputActive = (document.activeElement === this.chatInput.inputEl && this.chatInput.getValue().trim() !== '');
      if (this.chatInput.getValue().trim() === '') {
        this.chatInput.setPlaceholder(prompts[promptIndex]);
      } else {
        this.chatInput.setPlaceholder('');
      }
    });
    

    
    this.chatInput.inputEl.addEventListener('input', async (e) => {
      const value = this.chatInput.getValue();
      if (value.trim() === '@session') {
        const sessions = await this.chatHistoryManager.listSessions(this.notebook.id);
        if (sessions.length === 0) {
          new Notice('No sessions available.');
          return;
        }
        new SessionSelectModal(this.app, sessions, (sessionIds) => {
          this.chatInput.setValue(`@session-${sessionIds.join(', ')} `);
          this.chatInput.inputEl.focus();
        }).open();
      }
    });

    
    const rightControls = inputRow.createDiv({ cls: 'notebook-input-right-controls' });
    const sendBtn = rightControls.createDiv({ cls: 'send-button-new' });
    setIcon(sendBtn, 'arrow-up');
    sendBtn.addClass('nl-cursor-pointer');
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.setAttribute('tabindex', '0');
    sendBtn.addEventListener('click', () => this.handleSendMessage());

    this.chatInput.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSendMessage();
      }
    });

    
    this.updateContextBar();
  }

  
  private renderMobileLayout() {
    
    this.mobileTabRow = this.container.createDiv({ cls: 'mobile-tab-row' });

    this.mobileSourcesTab = this.mobileTabRow.createDiv({ cls: 'mobile-tab' });
    this.mobileSourcesTab.textContent = 'Sources';
    if (this.mobileActiveTab === 'sources') this.mobileSourcesTab.addClass('active');
    this.mobileSourcesTab.addEventListener('click', () => this.switchMobileTab('sources'));

    this.mobileChatTab = this.mobileTabRow.createDiv({ cls: 'mobile-tab' });
    this.mobileChatTab.textContent = 'Chat';
    if (this.mobileActiveTab === 'chat') this.mobileChatTab.addClass('active');
    this.mobileChatTab.addEventListener('click', () => this.switchMobileTab('chat'));

    
    const tabContent = this.container.createDiv({ cls: 'mobile-tab-content' });

    
    this.sourcesContainer = tabContent.createDiv({ cls: 'mobile-sources-panel' });
    if (this.mobileActiveTab !== 'sources') this.sourcesContainer.addClass('mobile-panel-hidden');
    this.renderMobileSourcesPanel();

    
    const chatPanel = tabContent.createDiv({ cls: 'mobile-chat-panel' });
    if (this.mobileActiveTab !== 'chat') chatPanel.addClass('mobile-panel-hidden');

    
    this.contextBarContainer = chatPanel.createDiv({ cls: 'context-bar-container mobile-context-bar' });
    this.contextProgressBar = this.contextBarContainer.createDiv({ cls: 'context-progress-bar' });
    this.contextLabel = this.contextBarContainer.createDiv({ cls: 'context-label' });

    
    this.responsesContainer = chatPanel.createDiv({ cls: 'responses-container mobile-responses' });
    
    this.messages.forEach(msg => this.addMessage(msg.role, msg.content, false, [], false, msg.sourceMapping));

    
    const chatInputContainer = chatPanel.createDiv({ cls: 'mobile-notebook-input-container' });

    
    let lastScrollTop = 0;
    let lastScrollHeight = this.responsesContainer.scrollHeight;
    let lastClientHeight = this.responsesContainer.clientHeight;

    this.responsesContainer.addEventListener('scroll', () => {
      const currentScrollTop = this.responsesContainer.scrollTop;
      const currentScrollHeight = this.responsesContainer.scrollHeight;
      const currentClientHeight = this.responsesContainer.clientHeight;

      // If layout shifted (streaming, toggles, or hide/show), ignore this scroll event
      if (currentScrollHeight !== lastScrollHeight || currentClientHeight !== lastClientHeight) {
        lastScrollHeight = currentScrollHeight;
        lastClientHeight = currentClientHeight;
        lastScrollTop = currentScrollTop;
        return;
      }

      if (Math.abs(currentScrollTop - lastScrollTop) < 10) return;

      if (currentScrollTop > lastScrollTop && currentScrollTop > 50) {
        chatInputContainer.classList.add('mobile-hidden');
        if (this.mobileTabRow) this.mobileTabRow.classList.add('mobile-hidden');
      } else {
        chatInputContainer.classList.remove('mobile-hidden');
        if (this.mobileTabRow) this.mobileTabRow.classList.remove('mobile-hidden');
      }
      lastScrollTop = currentScrollTop;
    });

    
    const inputRowContainer = chatInputContainer.createDiv({ cls: 'input-row-container' });

    
    const plusBtn = inputRowContainer.createDiv({ cls: 'context-menu-btn' });
    setIcon(plusBtn, 'plus');
    plusBtn.setAttribute('aria-label', 'Add context');
    plusBtn.setAttribute('tabindex', '0');
    plusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openPrefixMenu(plusBtn);
    });

    
    this.chatInput = new TextAreaComponent(inputRowContainer)
      .setPlaceholder('Ask a question...');
    this.chatInput.inputEl.rows = 1;
    this.chatInput.inputEl.classList.add('query-input-new');

    
    this.chatInput.inputEl.addEventListener('input', function () {
      const parent = this.parentElement;
      if (parent) {
        parent.setCssProps({ 'min-height':  parent.clientHeight + 'px' });
      }
      this.addClass('nl-height-auto');
      this.setCssProps({ 'height':  Math.min(this.scrollHeight, 120) + 'px' });
      if (parent) {
        parent.addClass('nl-min-height-');
      }
    });

    
    this.chatInput.inputEl.addEventListener('input', async () => {
      const value = this.chatInput.getValue();
      if (value.trim() === '@session') {
        const sessions = await this.chatHistoryManager.listSessions(this.notebook.id);
        if (sessions.length === 0) {
          new Notice('No sessions available.');
          return;
        }
        new SessionSelectModal(this.app, sessions, (sessionIds) => {
          this.chatInput.setValue(`@session-${sessionIds.join(', ')} `);
          this.chatInput.inputEl.focus();
        }).open();
      }
    });

    
    const sendBtn = inputRowContainer.createDiv({ cls: 'send-button-new' });
    setIcon(sendBtn, 'arrow-up');
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.setAttribute('tabindex', '0');
    sendBtn.addEventListener('click', () => this.handleSendMessage());

    this.chatInput.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSendMessage();
      }
    });

    
    const modelRow = chatInputContainer.createDiv({ cls: 'mobile-model-row' });
    this.modelSelectButton = new ButtonComponent(modelRow)
      .setButtonText(getModelDisplayName(this.settings.notebookModel, this.settings))
      .setClass('model-select-btn')
      .onClick(() => this.showModelMenu());
    
    
    this.renderModeToggle(modelRow);

    
    this.updateContextBar();
  }

  
  private renderModeToggle(container: HTMLElement) {
    const toggleContainer = container.createDiv({ cls: 'notebook-mode-toggle-container' });

    
    const cagWrap = toggleContainer.createDiv({ cls: 'notebook-mode-checkbox-wrap' });
    const cagCheckbox = cagWrap.createEl('input', { type: 'checkbox', cls: 'notebook-mode-checkbox' });
    cagCheckbox.id = `mode-cag-${Math.random().toString(36).substr(2, 9)}`; 
    cagCheckbox.checked = this.notebook.mode === 'cag' || !this.notebook.mode;
    const cagLabel = cagWrap.createEl('label', { text: 'Full context', cls: 'notebook-mode-label' });
    cagLabel.htmlFor = cagCheckbox.id;

    
    const ragWrap = toggleContainer.createDiv({ cls: 'notebook-mode-checkbox-wrap' });
    const ragCheckbox = ragWrap.createEl('input', { type: 'checkbox', cls: 'notebook-mode-checkbox' });
    ragCheckbox.id = `mode-rag-${Math.random().toString(36).substr(2, 9)}`; 
    ragCheckbox.checked = this.notebook.mode === 'rag';
    const ragLabel = ragWrap.createEl('label', { text: 'Keyword based', cls: 'notebook-mode-label' });
    ragLabel.htmlFor = ragCheckbox.id;

    
    cagCheckbox.addEventListener('change', () => {
      if (cagCheckbox.checked) {
        ragCheckbox.checked = false;
        this.switchMode('cag');
      } else {
        cagCheckbox.checked = true; 
      }
    });

    ragCheckbox.addEventListener('change', () => {
      if (ragCheckbox.checked) {
        cagCheckbox.checked = false;
        this.switchMode('rag');
      } else {
        ragCheckbox.checked = true; 
      }
    });
  }

  private async switchMode(newMode: 'cag' | 'rag') {
    if (this.notebook.mode === newMode) return;

    this.notebook.mode = newMode;
    
    
    await this.plugin.notebookManager.updateNotebook(
      this.notebook.id,
      this.notebook.name,
      this.notebook.sourcePaths,
      this.notebook.customInstruction,
      this.notebook.webSources,
      this.notebook.inlineCitation,
      newMode,
      this.notebook.sourceFolders,
      this.notebook.feedSources
    );

    
    if (newMode === 'rag') {
      const effectivePaths = this.getEffectiveSourcePaths();
      this.notebookBM25Manager = new NotebookBM25Manager(
        this.app,
        this.settings,
        this.notebook.id,
        effectivePaths
      );
      
      
      try {
        this.sourceStatuses = await this.notebookBM25Manager.getSourcesStatus();
      } catch (error) {
                this.sourceStatuses = [];
      }
    } else {
      this.notebookBM25Manager = null;
      this.sourceStatuses = [];
    }

    
    this.renderSourcesPanel();
    this.updateContextBar();
    new Notice(`Switched to ${newMode === 'cag' ? 'Full context' : 'Keyword based'}`);
  }

  
  private switchMobileTab(tab: 'sources' | 'chat') {
    this.mobileActiveTab = tab;

    
    if (this.mobileSourcesTab && this.mobileChatTab) {
      this.mobileSourcesTab.classList.toggle('active', tab === 'sources');
      this.mobileChatTab.classList.toggle('active', tab === 'chat');
    }

    
    const sourcesPanel = this.container.querySelector('.mobile-sources-panel');
    const chatPanel = this.container.querySelector('.mobile-chat-panel');

    if (sourcesPanel) {
      sourcesPanel.classList.toggle('mobile-panel-hidden', tab !== 'sources');
    }
    if (chatPanel) {
      chatPanel.classList.toggle('mobile-panel-hidden', tab !== 'chat');
    }
  }

  
  private renderMobileSourcesPanel() {
    if (!this.sourcesContainer) return;

    this.sourcesContainer.empty();

    
    const sourcesHeader = this.sourcesContainer.createDiv({ cls: 'mobile-sources-header' });

    
    const backBtn = new ButtonComponent(sourcesHeader)
      .setIcon('arrow-left')
      .setTooltip('Back to sessions')
      .setClass('mobile-back-btn')
      .onClick(() => this.renderSessionSelector());

    
    sourcesHeader.createSpan({
      text: this.currentSession ? this.currentSession.name : 'Session',
      cls: 'mobile-session-title'
    });

    
    if (this.notebook.mode === 'rag') {
      this.renderRagSettingsPanel();
    }

    
    const sourceControlsContainer = this.sourcesContainer.createDiv({ cls: 'mobile-source-controls-container' });

    
    const toggleContainer = sourceControlsContainer.createDiv({ cls: 'source-toggle-container mobile-toggle' });

    
    const notesButton = toggleContainer.createEl('button', {
      cls: `source-toggle-segment mobile-toggle-segment ${this.sourceViewMode === 'notes' ? 'active' : ''}`,
      attr: { 'aria-label': 'Show note sources' }
    });
    const notesIcon = notesButton.createSpan({ cls: 'source-toggle-icon' });
    setIcon(notesIcon, 'file-text');

    const webButton = toggleContainer.createEl('button', {
      cls: `source-toggle-segment mobile-toggle-segment ${this.sourceViewMode === 'web' ? 'active' : ''}`,
      attr: { 'aria-label': 'Show web sources' }
    });
    const webIcon = webButton.createSpan({ cls: 'source-toggle-icon' });
    setIcon(webIcon, 'globe');

    notesButton.addEventListener('click', async () => {
      if (this.sourceViewMode !== 'notes') {
        this.sourceViewMode = 'notes';
        
        
        if (this.previousModel) {
          this.settings.notebookModel = this.previousModel.modelId;
          this.settings.notebookProvider = this.previousModel.provider as Provider;
          await this.plugin.saveSettings();
          this.modelSelectButton.setButtonText(getModelDisplayName(this.settings.notebookModel, this.settings));
          this.updateContextBar();
          this.previousModel = null; 
        }
        
        this.renderMobileSourcesPanel();
      }
    });

    webButton.addEventListener('click', async () => {
      if (this.sourceViewMode !== 'web') {
        this.sourceViewMode = 'web';

        const currentModelId = this.settings.notebookModel;
        const currentProvider = this.settings.notebookProvider;
        
        if (currentProvider !== 'gemini' && currentProvider !== 'ollama') {
          this.previousModel = {
            modelId: currentModelId,
            provider: currentProvider
          };
          
          const webCapableModels = this.settings.customModels.filter(m => 
            (m.provider === 'gemini' || m.provider === 'ollama') && m.enabled !== false
          );

          if (webCapableModels.length > 0) {
            this.settings.notebookModel = webCapableModels[0].id;
            this.settings.notebookProvider = webCapableModels[0].provider;
            await this.plugin.saveSettings();
            this.modelSelectButton.setButtonText(getModelDisplayName(this.settings.notebookModel, this.settings));
            this.updateContextBar();

            
            new Notice(`Switched to ${webCapableModels[0].name} (Web sources require Gemini or Ollama models)`);
          } else {
            
            new Notice('⚠️ Web sources require Gemini or Ollama models. Please configure these models in settings.', 5000);
          }
        }

        this.renderMobileSourcesPanel();
      }
    });

    
    const selectAllContainer = sourceControlsContainer.createDiv({ cls: 'source-select-all-container mobile-select-all' });
    const selectAllCheckbox = selectAllContainer.createEl('input', {
      type: 'checkbox',
      cls: 'source-select-all-checkbox',
      attr: { 'aria-label': 'Select or deselect all sources' }
    });
    const selectAllLabel = selectAllContainer.createEl('label', {
      text: 'Select All',
      cls: 'source-select-all-label mobile-select-all-label'
    });
    selectAllLabel.prepend(selectAllCheckbox);

    
    let allSelected = false;
    if (this.sourceViewMode === 'notes') {
      const effectivePaths = this.getEffectiveSourcePaths();
      const validSourcePaths = effectivePaths.filter(path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile;
      });
      allSelected = validSourcePaths.length > 0 && validSourcePaths.every(p => this.selectedSourcePaths.has(p));
      selectAllCheckbox.checked = allSelected;
    } else {
      const webSources = this.effectiveWebSourcesCache;
      allSelected = webSources.length > 0 && webSources.every(web => this.selectedSourcePaths.has(`web:${web.url}`));
      selectAllCheckbox.checked = allSelected;
    }

    selectAllCheckbox.addEventListener('change', () => {
      if (this.sourceViewMode === 'notes') {
        const effectivePaths = this.getEffectiveSourcePaths();
        const validSourcePaths = effectivePaths.filter(path => {
          const file = this.app.vault.getAbstractFileByPath(path);
          return file instanceof TFile;
        });

        if (selectAllCheckbox.checked) {
          
          validSourcePaths.forEach(p => this.selectedSourcePaths.add(p));
          if (this.effectiveWebSourcesCache.length > 0) {
            this.effectiveWebSourcesCache.forEach(web => this.selectedSourcePaths.delete(`web:${web.url}`));
          }
        } else {
          
          validSourcePaths.forEach(p => this.selectedSourcePaths.delete(p));
        }
      } else {
        const webSources = this.effectiveWebSourcesCache;

        if (selectAllCheckbox.checked) {
          
          webSources.forEach(web => this.selectedSourcePaths.add(`web:${web.url}`));
          const effectivePaths = this.getEffectiveSourcePaths();
          effectivePaths.forEach(p => this.selectedSourcePaths.delete(p));
        } else {
          
          webSources.forEach(web => this.selectedSourcePaths.delete(`web:${web.url}`));
        }
      }

      this.invalidateContextCache();
      this.renderMobileSourcesPanel();
      this.updateContextBar();
    });

    
    const listWrapper = this.sourcesContainer.createDiv({ cls: 'mobile-sources-list-wrapper' });
    const list = listWrapper.createDiv({ cls: 'sources-list' });

    
    const effectivePaths = this.getEffectiveSourcePaths();
    const validSourcePaths = effectivePaths.filter(path => {
      const file = this.app.vault.getAbstractFileByPath(path);
      return file instanceof TFile;
    });

    
    this.selectedSourcePaths.forEach(path => {
      if (!validSourcePaths.includes(path) && !path.startsWith('web:')) {
        this.selectedSourcePaths.delete(path);
      }
    });

    
    const anyNoteChecked = validSourcePaths.some(p => this.selectedSourcePaths.has(p));
    const anyWebChecked = this.effectiveWebSourcesCache.length > 0 && this.effectiveWebSourcesCache.some(web => this.selectedSourcePaths.has(`web:${web.url}`));

    
    if (this.sourceViewMode === 'notes') {
      
      validSourcePaths.forEach(path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        const fileName = file && 'basename' in file ? (file as SafeAny).basename : path.split('/').pop();
        const row = list.createDiv({ cls: 'source-row' });
        const label = row.createEl('label', { cls: 'source-label' });
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = this.selectedSourcePaths.has(path);
        if (anyWebChecked) checkbox.disabled = true;
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) {
            this.selectedSourcePaths.add(path);
          } else {
            this.selectedSourcePaths.delete(path);
          }
          this.invalidateContextCache();
          this.renderMobileSourcesPanel();
          this.updateContextBar();
        });
        label.appendChild(checkbox);
        const nameSpan = document.createElement('span');
        nameSpan.textContent = ' ' + fileName;
        nameSpan.addClass('nl-font-weight-bold');
        label.appendChild(nameSpan);

        
        if (this.notebook.mode === 'rag') {
          const sourceStatus = this.sourceStatuses.find(s => s.path === path);
          if (sourceStatus) {
            if (sourceStatus.hasChanges) {
              const glowDot = document.createElement('span');
              glowDot.className = 'source-change-indicator';
              glowDot.title = 'Source has changed since last indexing';
              row.appendChild(glowDot);
            } else if (!sourceStatus.isIndexed) {
              const notIndexedDot = document.createElement('span');
              notIndexedDot.className = 'source-not-indexed-indicator';
              notIndexedDot.title = 'Source not indexed yet';
              row.appendChild(notIndexedDot);
            }
          }
        }

        row.appendChild(label);
      });
    } else {
      
      if (this.effectiveWebSourcesCache.length > 0) {
        this.effectiveWebSourcesCache.forEach(web => {
          const webKey = `web:${web.url}`;
          const row = list.createDiv({ cls: 'source-row web-source-row' });
          const label = row.createEl('label', { cls: 'source-label web-source-label' });
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = this.selectedSourcePaths.has(webKey);
          if (anyNoteChecked) checkbox.disabled = true;
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
              this.selectedSourcePaths.add(webKey);
            } else {
              this.selectedSourcePaths.delete(webKey);
            }
            this.invalidateContextCache();
            this.updateContextBar();
            this.renderMobileSourcesPanel();
          });
          label.appendChild(checkbox);
          const nameSpan = document.createElement('span');
          nameSpan.textContent = ' ' + web.name;
          nameSpan.className = 'web-source-name';
          label.appendChild(nameSpan);
          row.appendChild(label);
        });
      }
    }
  }

  
  private openPrefixMenu(anchorEl: HTMLElement) {
    this.closePrefixMenu();

    const menu = document.createElement('div');
    menu.className = 'context-file-menu notebook-prefix-menu';

    const rect = anchorEl.getBoundingClientRect();
    menu.addClass('nl-position-fixed');
    menu.setCssProps({ 'left':  `${rect.left}px` });
    menu.addClass('nl-z-index-9999');
    menu.addClass('nl-min-width-220px');

    
    const prefixOptions = [
      { label: '@session', value: '@session', description: 'Add session context' },
      { label: '@quiz', value: '@quiz ', description: 'Generate MCQ quiz from sources' },
      { label: '@flashcards', value: '@flashcards ', description: 'Generate flashcards from sources' }
    ];

    prefixOptions.forEach(opt => {
      const item = document.createElement('div');
      item.className = 'context-file-menu-item';

      const labelSpan = document.createElement('span');
      labelSpan.textContent = opt.label;
      labelSpan.addClass('nl-font-weight-500');
      item.appendChild(labelSpan);

      const descSpan = document.createElement('span');
      descSpan.textContent = opt.description;
      descSpan.setCssProps({ 'css-text':  'font-size: 0.85em; color: var(--text-muted); margin-left: 8px;' });
      item.appendChild(descSpan);

      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        this.closePrefixMenu();

        if (opt.value === '@session') {
          
          const sessions = await this.chatHistoryManager.listSessions(this.notebook.id);
          if (sessions.length === 0) {
            new Notice('No sessions available.');
            return;
          }
          new SessionSelectModal(this.app, sessions, (sessionIds) => {
            this.chatInput.setValue(`@session-${sessionIds.join(', ')} ` + this.chatInput.getValue());
            this.chatInput.inputEl.focus();
          }).open();
        } else {
          
          this.chatInput.setValue(opt.value + this.chatInput.getValue());
          this.chatInput.inputEl.focus();
        }
      });
      menu.appendChild(item);
    });

    document.body.appendChild(menu);

    
    const menuHeight = menu.offsetHeight;
    menu.setCssProps({ 'top':  `${rect.top - menuHeight - 8}px` });

    this.contextMenuEl = menu;

    
    setTimeout(() => {
      document.addEventListener('mousedown', this.handlePrefixMenuOutsideClick, true);
    }, 0);
  }

  private closePrefixMenu = () => {
    if (this.contextMenuEl) {
      document.body.removeChild(this.contextMenuEl);
      this.contextMenuEl = null;
    }
    document.removeEventListener('mousedown', this.handlePrefixMenuOutsideClick, true);
  };

  private handlePrefixMenuOutsideClick = (e: MouseEvent) => {
    if (this.contextMenuEl && !this.contextMenuEl.contains(e.target as Node)) {
      this.closePrefixMenu();
    }
  };

  private renderSourcesPanel() {
    
    const contextBar = this.contextBarContainer;
    const sessionBar = this.sourcesContainer.querySelector('.session-bar');
    this.sourcesContainer.empty();

    
    if (sessionBar) {
      this.sourcesContainer.appendChild(sessionBar);
    }
    
    this.sourcesContainer.appendChild(contextBar);

    
    if (!this.effectiveWebSourcesCache || (this.notebook.mode === 'rag' && !this.notebookBM25Manager)) {
      const loadingDiv = this.sourcesContainer.createDiv({ cls: 'sources-loading' });
      loadingDiv.createEl('div', { text: 'Loading sources...', cls: 'sources-loading-text' });
      return;
    }

    
    if (this.notebook.mode === 'rag') {
      this.renderRagSettingsPanel();
    }

    
    const sourcesHeader = this.sourcesContainer.createDiv({ cls: 'sources-header-fixed' });
    const headerTop = sourcesHeader.createDiv({ cls: 'sources-header-top' });

    
    const toggleContainer = headerTop.createDiv({ cls: 'source-toggle-container' });

    
    const notesButton = toggleContainer.createEl('button', {
      cls: `source-toggle-segment ${this.sourceViewMode === 'notes' ? 'active' : ''}`,
      attr: { 'aria-label': 'Show note sources' }
    });
    const notesIcon = notesButton.createSpan({ cls: 'source-toggle-icon' });
    setIcon(notesIcon, 'file-text');

    const webButton = toggleContainer.createEl('button', {
      cls: `source-toggle-segment ${this.sourceViewMode === 'web' ? 'active' : ''}`,
      attr: { 'aria-label': 'Show web sources' }
    });
    const webIcon = webButton.createSpan({ cls: 'source-toggle-icon' });
    setIcon(webIcon, 'globe');

    notesButton.addEventListener('click', async () => {
      if (this.sourceViewMode !== 'notes') {
        this.sourceViewMode = 'notes';
        
        
        if (this.previousModel) {
          this.settings.notebookModel = this.previousModel.modelId;
          this.settings.notebookProvider = this.previousModel.provider as Provider;
          await this.plugin.saveSettings();
          this.modelSelectButton.setButtonText(getModelDisplayName(this.settings.notebookModel, this.settings));
          this.updateContextBar();
          this.previousModel = null; 
        }
        
        this.renderSourcesPanel();
      }
    });

    webButton.addEventListener('click', async () => {
      if (this.sourceViewMode !== 'web') {
        this.sourceViewMode = 'web';

        
        const currentModelId = this.settings.notebookModel;
        const currentProvider = this.settings.notebookProvider;
        
        if (currentProvider !== 'gemini' && currentProvider !== 'ollama') {
          
          this.previousModel = {
            modelId: currentModelId,
            provider: currentProvider
          };
          
          
          const webCapableModels = this.settings.customModels.filter(m => 
            (m.provider === 'gemini' || m.provider === 'ollama') && m.enabled !== false
          );

          if (webCapableModels.length > 0) {
            
            this.settings.notebookModel = webCapableModels[0].id;
            this.settings.notebookProvider = webCapableModels[0].provider;
            await this.plugin.saveSettings();
            this.modelSelectButton.setButtonText(getModelDisplayName(this.settings.notebookModel, this.settings));
            this.updateContextBar();

            
            new Notice(`Switched to ${webCapableModels[0].name} (Web sources require Gemini or Ollama models)`);
          } else {
            
            new Notice('⚠️ Web sources require Gemini or Ollama models. Please configure these models in settings.', 5000);
          }
        }

        this.renderSourcesPanel();
      }
    });

    
    const sourceControls = headerTop.createDiv({ cls: 'source-controls' });

    
    const selectAllContainer = sourceControls.createDiv({ cls: 'source-select-all-container' });
    const selectAllCheckbox = selectAllContainer.createEl('input', {
      type: 'checkbox',
      cls: 'source-select-all-checkbox',
      attr: { 'aria-label': 'Select or deselect all sources' }
    });
    const selectAllLabel = selectAllContainer.createEl('label', {
      text: 'All',
      cls: 'source-select-all-label'
    });
    selectAllLabel.prepend(selectAllCheckbox);

    
    let allSelected = false;
    if (this.sourceViewMode === 'notes') {
      const effectivePaths = this.getEffectiveSourcePaths();
      const validSourcePaths = effectivePaths.filter(path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile;
      });
      allSelected = validSourcePaths.length > 0 && validSourcePaths.every(p => this.selectedSourcePaths.has(p));
      selectAllCheckbox.checked = allSelected;
    } else {
      const webSources = this.effectiveWebSourcesCache;
      allSelected = webSources.length > 0 && webSources.every(web => this.selectedSourcePaths.has(`web:${web.url}`));
      selectAllCheckbox.checked = allSelected;
    }

    selectAllCheckbox.addEventListener('change', () => {
      const listWrapper = this.sourcesContainer.querySelector('.sources-list-wrapper');
      const prevScroll = listWrapper ? listWrapper.scrollTop : 0;

      if (this.sourceViewMode === 'notes') {
        const effectivePaths = this.getEffectiveSourcePaths();
        const validSourcePaths = effectivePaths.filter(path => {
          const file = this.app.vault.getAbstractFileByPath(path);
          return file instanceof TFile;
        });

        if (selectAllCheckbox.checked) {
          
          validSourcePaths.forEach(p => this.selectedSourcePaths.add(p));
          if (this.effectiveWebSourcesCache.length > 0) {
            this.effectiveWebSourcesCache.forEach(web => this.selectedSourcePaths.delete(`web:${web.url}`));
          }
        } else {
          
          validSourcePaths.forEach(p => this.selectedSourcePaths.delete(p));
        }
      } else {
        const webSources = this.effectiveWebSourcesCache;

        if (selectAllCheckbox.checked) {
          
          webSources.forEach(web => this.selectedSourcePaths.add(`web:${web.url}`));
          const effectivePaths = this.getEffectiveSourcePaths();
          effectivePaths.forEach(p => this.selectedSourcePaths.delete(p));
        } else {
          
          webSources.forEach(web => this.selectedSourcePaths.delete(`web:${web.url}`));
        }
      }

      this.invalidateContextCache();
      this.renderSourcesPanel();
      const newListWrapper = this.sourcesContainer.querySelector('.sources-list-wrapper');
      if (newListWrapper) newListWrapper.scrollTop = prevScroll;
      this.updateContextBar();
    });

    
    const sliderContainer = sourcesHeader.createDiv({ cls: 'cag-history-slider-container' });
    sliderContainer.setCssProps({ 'display':  (this.notebook.mode === 'cag' && this.sourceViewMode === 'notes') ? 'flex':  'none' });
    sliderContainer.addClass('nl-align-items-center');
    sliderContainer.addClass('nl-gap-8px');
    sliderContainer.addClass('nl-font-size-08em');
    sliderContainer.addClass('nl-color-var--text-muted');
    sliderContainer.addClass('nl-margin-top-4px');

    const sliderLabel = sliderContainer.createSpan({ 
      text: `History: ${this.cagHistoryContextLength === 20 ? 'All' : this.cagHistoryContextLength}` 
    });
    
    const slider = sliderContainer.createEl('input', {
      type: 'range',
      attr: {
        min: '0',
        max: '20',
        value: this.cagHistoryContextLength.toString()
      },
      cls: 'cag-history-slider'
    });
    slider.addClass('nl-width-60px');
    slider.addClass('nl-height-4px');
    
    slider.addEventListener('input', (e) => {
      const val = parseInt((e.target as HTMLInputElement).value);
      this.cagHistoryContextLength = val;
      sliderLabel.setText(`History: ${val === 20 ? 'All' : val}`);
      this.updateContextBar();
    });

    

    
    const listWrapper = this.sourcesContainer.createDiv({ cls: 'sources-list-wrapper' });
    const list = listWrapper.createDiv({ cls: 'sources-list' });

    
    const effectivePaths = this.getEffectiveSourcePaths();
    const validSourcePaths = effectivePaths.filter(path => {
      const file = this.app.vault.getAbstractFileByPath(path);
      return file instanceof TFile;
    });

    
    this.selectedSourcePaths.forEach(path => {
      if (!validSourcePaths.includes(path) && !path.startsWith('web:')) {
        this.selectedSourcePaths.delete(path);
      }
    });

    
    const anyNoteChecked = validSourcePaths.some(p => this.selectedSourcePaths.has(p));
    const anyWebChecked = this.effectiveWebSourcesCache.length > 0 && this.effectiveWebSourcesCache.some(web => this.selectedSourcePaths.has(`web:${web.url}`));

    
    if (this.sourceViewMode === 'notes') {
      
      validSourcePaths.forEach(path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        const fileName = file && 'basename' in file ? (file as SafeAny).basename : path.split('/').pop();
        const row = list.createDiv({ cls: 'source-row' });
        const label = row.createEl('label', { cls: 'source-label' });
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = this.selectedSourcePaths.has(path);
        if (anyWebChecked) checkbox.disabled = true;
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) {
            this.selectedSourcePaths.add(path);
          } else {
            this.selectedSourcePaths.delete(path);
          }
          this.invalidateContextCache();
          this.updateContextBar(); 
        });
        label.appendChild(checkbox);
        
        const nameSpan = document.createElement('span');
        nameSpan.textContent = ' ' + fileName;
        nameSpan.addClass('nl-font-weight-bold');
        label.appendChild(nameSpan);

        
        if (this.notebook.mode === 'rag') {
          const sourceStatus = this.sourceStatuses.find(s => s.path === path);
          if (sourceStatus) {
            if (sourceStatus.hasChanges) {
              const glowDot = document.createElement('span');
              glowDot.className = 'source-change-indicator';
              glowDot.title = 'Source has changed since last indexing. Click to refresh.';
              glowDot.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.refreshSourceEmbedding(path);
              });
              row.appendChild(glowDot);
            } else if (!sourceStatus.isIndexed) {
              const notIndexedDot = document.createElement('span');
              notIndexedDot.className = 'source-not-indexed-indicator';
              notIndexedDot.title = 'Source not indexed yet. Click to index.';
              notIndexedDot.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.refreshSourceEmbedding(path);
              });
              row.appendChild(notIndexedDot);
            }
          }
        }

        row.appendChild(label);
      });
    } else {
      
      if (this.effectiveWebSourcesCache.length > 0) {
        this.effectiveWebSourcesCache.forEach(web => {
          const webKey = `web:${web.url}`;
          const row = list.createDiv({ cls: 'source-row web-source-row' });
          const label = row.createEl('label', { cls: 'source-label web-source-label' });
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = this.selectedSourcePaths.has(webKey);
          if (anyNoteChecked) checkbox.disabled = true;
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
              this.selectedSourcePaths.add(webKey);
            } else {
              this.selectedSourcePaths.delete(webKey);
            }
            this.invalidateContextCache();
            this.updateContextBar();
          });
          label.appendChild(checkbox);
          const nameSpan = document.createElement('span');
          nameSpan.textContent = ' ' + web.name;
          nameSpan.className = 'web-source-name';
          label.appendChild(nameSpan);
          row.appendChild(label);
        });
      }
    }

    
    if (this.isMobile) {
      this.renderMobileSourcesPanel();
    }
  }

  
  private renderRagSettingsPanel() {
    
    
    if (!this.notebookBM25Manager) return;
    
    
    if (!this.isIndexing) {
      const hasObviousChanges = this.sourceStatuses.some(s => s.hasChanges || !s.isIndexed);
      if (!hasObviousChanges) {
        
        return;
      }
    }

    
    this.notebookBM25Manager.getChunkCount().then(async chunkCount => {
      const fileCount = await this.notebookBM25Manager!.getIndexedFileCount();
      const hasChanges = this.sourceStatuses.some(s => s.hasChanges || !s.isIndexed);
      const needsIndexing = chunkCount === 0 || hasChanges;

      if (needsIndexing || this.isIndexing) {
        
        this.ragSettingsContainer = this.sourcesContainer.createDiv({ cls: 'rag-settings-panel' });

        
        const header = this.ragSettingsContainer.createDiv({ cls: 'rag-settings-header' });
        header.createEl('span', { text: '⚡ Keyword Index', cls: 'rag-settings-title' });

        
        const statusActionsContainer = this.ragSettingsContainer.createDiv({ cls: 'rag-status-actions-container' });

        if (this.isIndexing) {
          
          const indexingContainer = statusActionsContainer.createDiv({ cls: 'rag-indexing-container' });

          
          const progressContainer = indexingContainer.createDiv({ cls: 'rag-progress-container' });

          
          const progressBarOuter = progressContainer.createDiv({ cls: 'rag-progress-bar-outer' });
          const progressBarInner = progressBarOuter.createDiv({ cls: 'rag-progress-bar-inner' });
          progressBarInner.addClass('nl-width-0');

          
          progressContainer.createEl('span', { text: '0%', cls: 'rag-progress-text' });

        } else {
          
          const buildContainer = statusActionsContainer.createDiv({ cls: 'rag-build-container' });

          new ButtonComponent(buildContainer)
            .setButtonText(chunkCount === 0 ? 'Build keyword index' : 'Update keyword index')
            .setClass('rag-index-btn')
            .onClick(async () => {
              await this.buildRagIndex();
            });

          
          if (chunkCount === 0) {
            buildContainer.createEl('span', {
              text: 'Index not built yet',
              cls: 'rag-status-hint'
            });
          } else if (hasChanges) {
            buildContainer.createEl('span', {
              text: `Changes detected in sources`,
              cls: 'rag-status-hint rag-status-warning'
            });
          }
        }
      }
    });
  }

  
  private async buildRagIndex() {
    if (!this.notebookBM25Manager || this.isIndexing) return;

    this.isIndexing = true;
    this.renderSourcesPanel();

    try {
      await this.notebookBM25Manager.updateIndex((status) => {
        
        const progressText = this.ragSettingsContainer?.querySelector('.rag-progress-text');
        const progressBar = this.ragSettingsContainer?.querySelector('.rag-progress-bar-inner') as HTMLElement;

        
        const match = status.match(/PROGRESS:(\d+)/);
        if (match) {
          const percentage = parseInt(match[1]);

          
          if (progressBar) {
            progressBar.setCssProps({ 'width':  `${percentage}%` });
          }

          
          if (progressText) {
            progressText.textContent = `${percentage}%`;
          }
        }
      });

      
      this.sourceStatuses = await this.notebookBM25Manager.getSourcesStatus();
      new Notice('Keyword index built successfully!');
    } catch (error) {
      new Notice('Failed to build keyword index.');
    } finally {
      this.isIndexing = false;
      this.renderSourcesPanel();
    }
  }

  
  private async refreshSourceEmbedding(path: string) {
    if (!this.notebookBM25Manager || this.isIndexing) return;

    this.isIndexing = true;
    this.renderSourcesPanel();

    try {
      await this.notebookBM25Manager.updateIndex((status) => {
        
        const progressText = this.ragSettingsContainer?.querySelector('.rag-progress-text');
        const progressBar = this.ragSettingsContainer?.querySelector('.rag-progress-bar-inner') as HTMLElement;

        
        const match = status.match(/PROGRESS:(\d+)/);
        if (match) {
          const percentage = parseInt(match[1]);

          
          if (progressBar) {
            progressBar.setCssProps({ 'width':  `${percentage}%` });
          }

          
          if (progressText) {
            progressText.textContent = `${percentage}%`;
          }
        }
      }, [path]);

      this.sourceStatuses = await this.notebookBM25Manager.getSourcesStatus();
      new Notice(`Source "${path.split('/').pop()}" re-indexed!`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Failed to refresh source embedding: ${errorMessage}`);
    } finally {
      this.isIndexing = false;
      this.renderSourcesPanel();
    }
  }

  private addMessage(role: 'user' | 'assistant', content: string, save = true, webResults: SafeAny[] = [], pushToMessages: boolean = true, sourceMapping?: string[]): HTMLElement {
    
    let displayContent = content;
    if (role === 'assistant' && displayContent.trim().toLowerCase().startsWith('assistant:')) {
      displayContent = displayContent.replace(/^assistant:\s*/i, '');
    }

    
    const previousSourceMapping = this.currentSourceMapping;
    if (role === 'assistant' && sourceMapping) {
      this.currentSourceMapping = sourceMapping;
    }

    
    const quizMatch = displayContent.match(/^\[QUIZ:(.*?)\]$/);
    if (quizMatch && role === 'assistant') {
      const quizKey = quizMatch[1];
      
      this.currentSourceMapping = previousSourceMapping;
      return this.renderStoredQuiz(quizKey, displayContent, pushToMessages);
    }

    
    const flashcardMatch = displayContent.match(/^\[FLASHCARDS:(.*?)\]$/);
    if (flashcardMatch && role === 'assistant') {
      const flashcardKey = flashcardMatch[1];
      
      this.currentSourceMapping = previousSourceMapping;
      return this.renderStoredFlashcards(flashcardKey, displayContent, pushToMessages);
    }

    const messageContainer = this.responsesContainer.createDiv({ cls: `chat-message ${role}` });
    const contentEl = messageContainer.createDiv({ cls: 'message-content' });
    if (role === 'user') {
      contentEl.createEl('p', { text: displayContent });
      const actionsContainer = messageContainer.createDiv({ cls: 'response-actions' });
      new ButtonComponent(actionsContainer)
        .setIcon('copy')
        .setClass('response-action-btn')
        .setTooltip('Copy to clipboard')
        .onClick(() => navigator.clipboard.writeText(displayContent));
      new ButtonComponent(actionsContainer)
        .setIcon('edit')
        .setClass('response-action-btn')
        .setTooltip('Edit message')
        .onClick(() => {
          this.editUserMessage(messageContainer, contentEl, displayContent, actionsContainer, save);
        });
    } else {
      
      const processedContent = this.processFootnoteReferences(displayContent);
      this.renderMarkdown(processedContent, contentEl);
      const actionsContainer = messageContainer.createDiv({ cls: 'response-actions' });
      new ButtonComponent(actionsContainer)
        .setIcon('copy')
        .setClass('response-action-btn')
        .setTooltip('Copy to clipboard')
        .onClick(() => navigator.clipboard.writeText(displayContent));

      new ButtonComponent(actionsContainer)
        .setIcon('clipboard-minus')
        .setClass('response-action-btn')
        .setTooltip('Copy without citations')
        .onClick(() => {
          const cleanedText = this.removeCitations(displayContent);
          navigator.clipboard.writeText(cleanedText);
          new Notice('Message copied to clipboard (no citations)');
        });

      new ButtonComponent(actionsContainer)
        .setIcon('file-text')
        .setClass('response-action-btn')
        .setTooltip('Copy plain text')
        .onClick(() => {
          let cleanedText = this.removeCitations(displayContent);
          cleanedText = this.convertToPlainTextKeepTables(cleanedText);
          navigator.clipboard.writeText(cleanedText);
          new Notice('Message copied to clipboard (plain text)');
        });
      if (this.messages[this.messages.length - 1] === this.messages.find(m => m.content === displayContent)) {
      }
      new ButtonComponent(actionsContainer)
        .setIcon('trash')
        .setClass('response-action-btn')
        .setTooltip('Delete message')
        .onClick(() => {
          messageContainer.remove();
          this.messages = this.messages.filter(msg => msg.content !== displayContent);
          if (save) this.saveCurrentSession();
        });
    }

    
    this.currentSourceMapping = previousSourceMapping;

    if (pushToMessages) {
      const message: ChatMessage = { role, content: displayContent };
      if (role === 'assistant' && sourceMapping) {
        message.sourceMapping = sourceMapping;
      }
      this.messages.push(message);
    }
    this.responsesContainer.scrollTop = this.responsesContainer.scrollHeight;
    this.updateContextBar();
    if (save && pushToMessages) this.saveCurrentSession();
    return messageContainer;
  }

  
  private editUserMessage(messageContainer: HTMLElement, contentEl: HTMLElement, originalContent: string, actionsContainer: HTMLElement, saveSession: boolean) {
    contentEl.empty();
    actionsContainer.addClass('nl-display-none');

    const editContainer = contentEl.createDiv({ cls: 'query-edit-container' });
    const textArea = editContainer.createEl('textarea', { cls: 'query-edit-textarea' });
    textArea.value = originalContent;
    textArea.rows = originalContent.split('\n').length;

    const adjustHeight = () => {
      textArea.addClass('nl-height-auto');
      textArea.setCssProps({ 'height':  textArea.scrollHeight + 'px' });
    };
    textArea.addEventListener('input', adjustHeight);
    setTimeout(adjustHeight, 0);

    const buttonContainer = editContainer.createDiv({ cls: 'query-edit-buttons' });

    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => {
        contentEl.empty();
        contentEl.createEl('p', { text: originalContent });
        actionsContainer.addClass('nl-display-');
      });

    new ButtonComponent(buttonContainer)
      .setButtonText('Save & Regenerate')
      .setCta()
      .onClick(async () => {
        const editedQuery = textArea.value.trim();
        if (editedQuery && editedQuery !== originalContent) {
          const msgIndex = this.messages.findIndex(msg => msg.role === 'user' && msg.content === originalContent);
          if (msgIndex !== -1) {
            this.messages.splice(msgIndex, 1);
            if (msgIndex < this.messages.length && this.messages[msgIndex].role === 'assistant') {
              this.messages.splice(msgIndex, 1);
            }
            this.responsesContainer.empty();
            this.messages.forEach(msg => this.addMessage(msg.role, msg.content, false, [], false, msg.sourceMapping));
            if (saveSession) this.saveCurrentSession();

            this.chatInput.setValue(editedQuery);
            await this.handleSendMessage();
          }
        } else {
          contentEl.empty();
          contentEl.createEl('p', { text: originalContent });
          actionsContainer.addClass('nl-display-');
        }
      });
  }

  private renderStoredQuiz(quizKey: string, content: string, pushToMessages: boolean): HTMLElement {
    const messageContainer = this.responsesContainer.createDiv({ cls: 'chat-message assistant quiz-message' });
    const contentEl = messageContainer.createDiv({ cls: 'message-content' });
    const quizContainer = contentEl.createDiv({ cls: 'notebook-quiz-container' });
    quizContainer.setAttribute('data-quiz-key', quizKey);

    
    this.loadQuizState(quizKey).then(quizState => {
      if (quizState) {
        const renderer = new QuizRenderer(
          this.app,
          quizContainer,
          quizState,
          (updatedState) => {
            this.saveQuizState(quizKey, updatedState);
          },
          this.settings,
          (question: string) => this.getContextForExplanation(question),
          this.rateLimitManager
        );
        renderer.render();
      } else {
        quizContainer.createEl('p', { text: 'Quiz data not found. Please regenerate.', cls: 'quiz-error' });
      }
    });

    
    const actionsContainer = messageContainer.createDiv({ cls: 'response-actions' });
    new ButtonComponent(actionsContainer)
      .setIcon('trash')
      .setClass('response-action-btn')
      .setTooltip('Delete quiz')
      .onClick(async () => {
        messageContainer.remove();
        this.messages = this.messages.filter(msg => msg.content !== content);
        
        try {
          const cacheDir = '.Nexus-LM-data/notebook-quiz-cache';
          const filePath = normalizePath(`${cacheDir}/${quizKey}.json`);
          const exists = await this.app.vault.adapter.exists(filePath);
          if (exists) {
            await this.app.vault.adapter.remove(filePath);
          }
        } catch (e) {
          
        }
        this.saveCurrentSession();
      });

    if (pushToMessages) {
      this.messages.push({ role: 'assistant', content });
    }
    this.responsesContainer.scrollTop = this.responsesContainer.scrollHeight;
    this.updateContextBar();
    return messageContainer;
  }

  
  private renderStoredFlashcards(flashcardKey: string, content: string, pushToMessages: boolean): HTMLElement {
    const messageContainer = this.responsesContainer.createDiv({ cls: 'chat-message assistant flashcard-message' });
    const contentEl = messageContainer.createDiv({ cls: 'message-content' });
    const flashcardContainer = contentEl.createDiv({ cls: 'notebook-flashcard-container' });
    flashcardContainer.setAttribute('data-flashcard-key', flashcardKey);

    
    this.loadFlashcardState(flashcardKey).then(flashcardState => {
      if (flashcardState) {
        const renderer = new FlashcardRenderer(this.app, flashcardContainer, flashcardState, (updatedState) => {
          this.saveFlashcardState(flashcardKey, updatedState);
        });
        renderer.render();
      } else {
        flashcardContainer.createEl('p', { text: 'Flashcard data not found. Please regenerate.', cls: 'flashcard-error' });
      }
    });

    
    const actionsContainer = messageContainer.createDiv({ cls: 'response-actions' });
    new ButtonComponent(actionsContainer)
      .setIcon('trash')
      .setClass('response-action-btn')
      .setTooltip('Delete flashcards')
      .onClick(async () => {
        messageContainer.remove();
        this.messages = this.messages.filter(msg => msg.content !== content);
        
        try {
          const cacheDir = '.Nexus-LM-data/notebook-flashcard-cache';
          const filePath = normalizePath(`${cacheDir}/${flashcardKey}.json`);
          const exists = await this.app.vault.adapter.exists(filePath);
          if (exists) {
            await this.app.vault.adapter.remove(filePath);
          }
        } catch (e) {
          
        }
        this.saveCurrentSession();
      });

    if (pushToMessages) {
      this.messages.push({ role: 'assistant', content });
    }
    this.responsesContainer.scrollTop = this.responsesContainer.scrollHeight;
    this.updateContextBar();
    return messageContainer;
  }

  
  
  private addQuizMessage(quizState: QuizState): HTMLElement {
    const messageContainer = this.responsesContainer.createDiv({ cls: 'chat-message assistant quiz-message' });
    const contentEl = messageContainer.createDiv({ cls: 'message-content' });

    
    const quizStateKey = `quiz-${this.currentSession?.id}-${quizState.timestamp}`;
    this.saveQuizState(quizStateKey, quizState);

    
    const quizContainer = contentEl.createDiv({ cls: 'notebook-quiz-container' });
    quizContainer.setAttribute('data-quiz-key', quizStateKey);

    
    const renderer = new QuizRenderer(
      this.app,
      quizContainer,
      quizState,
      (updatedState) => {
        this.saveQuizState(quizStateKey, updatedState);
      },
      this.settings,
      (question: string) => this.getContextForExplanation(question),
      this.rateLimitManager
    );
    renderer.render();

    
    const quizContent = `[QUIZ:${quizStateKey}]`;

    
    const actionsContainer = messageContainer.createDiv({ cls: 'response-actions' });
    new ButtonComponent(actionsContainer)
      .setIcon('trash')
      .setClass('response-action-btn')
      .setTooltip('Delete quiz')
      .onClick(async () => {
        messageContainer.remove();
        this.messages = this.messages.filter(msg => msg.content !== quizContent);
        
        try {
          const cacheDir = '.Nexus-LM-data/notebook-quiz-cache';
          const filePath = normalizePath(`${cacheDir}/${quizStateKey}.json`);
          const exists = await this.app.vault.adapter.exists(filePath);
          if (exists) {
            await this.app.vault.adapter.remove(filePath);
          }
        } catch (e) {
          
        }
        this.saveCurrentSession();
      });

    this.messages.push({ role: 'assistant', content: quizContent });

    this.responsesContainer.scrollTop = this.responsesContainer.scrollHeight;
    this.updateContextBar();
    this.saveCurrentSession();

    return messageContainer;
  }

  
  private addFlashcardMessage(flashcardState: FlashcardState): HTMLElement {
    const messageContainer = this.responsesContainer.createDiv({ cls: 'chat-message assistant flashcard-message' });
    const contentEl = messageContainer.createDiv({ cls: 'message-content' });

    
    const flashcardStateKey = `flashcard-${this.currentSession?.id}-${flashcardState.timestamp}`;
    this.saveFlashcardState(flashcardStateKey, flashcardState);

    
    const flashcardContainer = contentEl.createDiv({ cls: 'notebook-flashcard-container' });
    flashcardContainer.setAttribute('data-flashcard-key', flashcardStateKey);

    
    const renderer = new FlashcardRenderer(this.app, flashcardContainer, flashcardState, (updatedState) => {
      this.saveFlashcardState(flashcardStateKey, updatedState);
    });
    renderer.render();

    
    const flashcardContent = `[FLASHCARDS:${flashcardStateKey}]`;

    
    const actionsContainer = messageContainer.createDiv({ cls: 'response-actions' });
    new ButtonComponent(actionsContainer)
      .setIcon('trash')
      .setClass('response-action-btn')
      .setTooltip('Delete flashcards')
      .onClick(async () => {
        messageContainer.remove();
        this.messages = this.messages.filter(msg => msg.content !== flashcardContent);
        
        try {
          const cacheDir = '.Nexus-LM-data/notebook-flashcard-cache';
          const filePath = normalizePath(`${cacheDir}/${flashcardStateKey}.json`);
          const exists = await this.app.vault.adapter.exists(filePath);
          if (exists) {
            await this.app.vault.adapter.remove(filePath);
          }
        } catch (e) {
          
        }
        this.saveCurrentSession();
      });

    this.messages.push({ role: 'assistant', content: flashcardContent });

    this.responsesContainer.scrollTop = this.responsesContainer.scrollHeight;
    this.updateContextBar();
    this.saveCurrentSession();

    return messageContainer;
  }

  
  private async saveQuizState(key: string, state: QuizState): Promise<void> {
    try {
      const cacheDir = '.Nexus-LM-data/notebook-quiz-cache';
      const exists = await this.app.vault.adapter.exists(cacheDir);
      if (!exists) {
        await this.app.vault.adapter.mkdir(cacheDir);
      }
      const filePath = normalizePath(`${cacheDir}/${key}.json`);
      await this.app.vault.adapter.write(filePath, JSON.stringify(state));
    } catch (e) {
      
    }
  }

  
  private async loadQuizState(key: string): Promise<QuizState | null> {
    try {
      const cacheDir = '.Nexus-LM-data/notebook-quiz-cache';
      const filePath = normalizePath(`${cacheDir}/${key}.json`);
      const exists = await this.app.vault.adapter.exists(filePath);
      if (exists) {
        const json = await this.app.vault.adapter.read(filePath);
        return JSON.parse(json);
      }
    } catch (e) {
      
    }
    return null;
  }

  
  private async saveFlashcardState(key: string, state: FlashcardState): Promise<void> {
    try {
      const cacheDir = '.Nexus-LM-data/notebook-flashcard-cache';
      const exists = await this.app.vault.adapter.exists(cacheDir);
      if (!exists) {
        await this.app.vault.adapter.mkdir(cacheDir);
      }
      const filePath = normalizePath(`${cacheDir}/${key}.json`);
      await this.app.vault.adapter.write(filePath, JSON.stringify(state));
    } catch (e) {
      
    }
  }

  
  private async loadFlashcardState(key: string): Promise<FlashcardState | null> {
    try {
      const cacheDir = '.Nexus-LM-data/notebook-flashcard-cache';
      const filePath = normalizePath(`${cacheDir}/${key}.json`);
      const exists = await this.app.vault.adapter.exists(filePath);
      if (exists) {
        const json = await this.app.vault.adapter.read(filePath);
        return JSON.parse(json);
      }
    } catch (e) {
      
    }
    return null;
  }

  private async handleSendMessage() {
    let query = this.chatInput.getValue().trim();
    if (!query) return;
    let originalQuery = query; 
    
    if (/^@session(-|\s|$)/.test(query)) {
      this.renderSourcesPanel();
    }
    
    let sessionContext = '';
    let sessionMatch = query.match(/^@session-([^,\s]+(?:,\s*[^,\s]+)*)\s+/);
    if (sessionMatch) {
      const sessionIds = sessionMatch[1].split(',').map(id => id.trim());
      const sessions = await this.chatHistoryManager.listSessions(this.notebook.id);
      const sessionMetas = sessions.filter(s => sessionIds.includes(s.id));
      if (sessionMetas.length > 0) {
        const sessionPromises = sessionMetas.map(meta => this.chatHistoryManager.loadSession(this.notebook.id, meta.id));
        const sessionResults = await Promise.all(sessionPromises);
        sessionResults.forEach(session => {
          if (session) {
            sessionContext += session.messages.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n') + '\n';
          }
        });
      }
      query = query.replace(/^@session-[^,\s]+(?:,\s*[^,\s]+)*\s+/, '');
    }

    
    let useQuizForThisQuery = false;
    if (query.trim().startsWith('@quiz')) {
      useQuizForThisQuery = true;
      query = query.replace(/^@quiz\s*/, '').trim();
      if (!query) {
        new Notice('Please provide a topic after @quiz');
        return;
      }
      if (this.selectedSourcePaths.size === 0) {
        new Notice('Please select at least one source for quiz generation');
        return;
      }
    }

    
    let useFlashcardsForThisQuery = false;
    if (query.trim().startsWith('@flashcards')) {
      useFlashcardsForThisQuery = true;
      query = query.replace(/^@flashcards\s*/, '').trim();
      if (!query) {
        new Notice('Please provide a topic after @flashcards');
        return;
      }
      if (this.selectedSourcePaths.size === 0) {
        new Notice('Please select at least one source for flashcard generation');
        return;
      }
    }

    
    const selectedWebs = this.effectiveWebSourcesCache.filter(web => this.selectedSourcePaths.has(`web:${web.url}`));
    if (selectedWebs.length > 0) {
      const urls = selectedWebs.map(web => web.url).join(' ');
      query = `${query} ${urls}`.trim();
    }
    this.chatInput.setValue('');
    this.chatInput.inputEl.addClass('nl-height-');
    
    
    
    const userMessageContainer = this.addMessage('user', originalQuery, false, [], false);
    const spinner = userMessageContainer.createDiv({ cls: 'loading-spinner' });
    spinner.addClass('nl-display-block');
    try {
      let cachedContext = '';
      
      
      
      const customModel = this.settings.customModels.find(m => 
        m.id === this.settings.notebookModel && 
        m.provider === this.settings.notebookProvider
      );
      let modelMaxTokens = 4000; 
      if (customModel && customModel.tokenLimit && customModel.tokenLimit > 0) {
        modelMaxTokens = customModel.tokenLimit;
      } else {
        
        const provider = this.settings.notebookProvider;
        if (provider === 'groq') {
          modelMaxTokens = 1000000; 
        } else if (provider === 'openrouter') {
          modelMaxTokens = 1000000; 
        } else if (provider === 'ollama') {
          modelMaxTokens = 1000000; 
        } else {
          modelMaxTokens = 1000000; 
        }
      }
      let prompt = '';
      let assistantResponse = '';
      let webResults: SafeAny[] = [];

      
      if (useQuizForThisQuery) {
        
        if (this.notebook.mode === 'rag') {
          this.startGeneration();
        }

        
        if (this.notebook.mode === 'rag' && this.notebookBM25Manager) {
          cachedContext = await this.getRagContext(query);
        } else {
          cachedContext = await this.getCachedContext();
        }
        const contextTokens = countTokens(cachedContext);

        
        if (this.notebook.mode === 'rag') {
          this.updateDynamicTokens(contextTokens, 0);
        }

        
        const quizGenerator = new NotebookQuizGenerator(this.app, this.settings, this.rateLimitManager, this.settings.notebookProvider, this.settings.notebookModel);
        
        if (!cachedContext.trim()) {
          new Notice('Please select at least one source for quiz generation');
          if (this.notebook.mode === 'rag') {
            this.endGeneration(0, 0);
          }
          spinner.remove();
          return;
        }

        const mcqs = await quizGenerator.generateMCQs(cachedContext, query);

        if (mcqs.length === 0) {
          if (this.notebook.mode === 'rag') {
            this.endGeneration(0, 0);
          }
          throw new Error('Failed to generate quiz questions');
        }

        spinner.remove();

        
        if (this.notebook.mode === 'rag') {
          
          const outputTokens = mcqs.length * 150; 
          this.endGeneration(contextTokens, outputTokens);
        }

        this.messages.push({ role: 'user', content: originalQuery });

        
        const quizState: QuizState = {
          mcqs,
          query,
          timestamp: Date.now()
        };

        const messageContainer = this.addQuizMessage(quizState);
        return;
      }

      
      if (useFlashcardsForThisQuery) {
        
        if (this.notebook.mode === 'rag') {
          this.startGeneration();
        }

        
        if (this.notebook.mode === 'rag' && this.notebookBM25Manager) {
          cachedContext = await this.getRagContext(query);
        } else {
          cachedContext = await this.getCachedContext();
        }
        const contextTokens = countTokens(cachedContext);

        
        if (this.notebook.mode === 'rag') {
          this.updateDynamicTokens(contextTokens, 0);
        }

        
        const flashcardGenerator = new NotebookFlashcardGenerator(this.app, this.settings, this.rateLimitManager, this.settings.notebookProvider, this.settings.notebookModel);
        
        if (!cachedContext.trim()) {
          new Notice('Please select at least one source for flashcard generation');
          if (this.notebook.mode === 'rag') {
            this.endGeneration(0, 0);
          }
          spinner.remove();
          return;
        }

        const flashcards = await flashcardGenerator.generateFlashcards(cachedContext, query);

        if (flashcards.length === 0) {
          if (this.notebook.mode === 'rag') {
            this.endGeneration(0, 0);
          }
          throw new Error('Failed to generate flashcards');
        }

        spinner.remove();

        
        if (this.notebook.mode === 'rag') {
          
          const outputTokens = flashcards.length * 80; 
          this.endGeneration(contextTokens, outputTokens);
        }

        this.messages.push({ role: 'user', content: originalQuery });

        
        const flashcardState: FlashcardState = {
          flashcards,
          currentIndex: 0,
          query,
          timestamp: Date.now()
        };

        const messageContainer = this.addFlashcardMessage(flashcardState);
        return;
      }

      
      let ragChunkTokens = 0;

      
      if (this.notebook.mode === 'rag' && this.notebookBM25Manager) {
        
        this.startGeneration();
        cachedContext = await this.getRagContext(query);
        ragChunkTokens = countTokens(cachedContext);
        this.updateDynamicTokens(ragChunkTokens, 0);
      } else {
        cachedContext = await this.getCachedContext();
      }
      if (sessionContext) {
        cachedContext = `SESSION CONTEXT:\n${sessionContext}\n---\n` + cachedContext;
      }
      prompt = this.buildPromptWithHistory(query, cachedContext, modelMaxTokens);
      if (this.settings.notebookProvider === 'gemini') {
          const genAI = new GoogleGenerativeAI(this.settings.geminiApiKey || this.settings.apiKey);
          const modelOptions: SafeAny = { model: this.settings.notebookModel };
          
          
          if (selectedWebs.length > 0) {
            modelOptions.tools = [this.webSearchService.getGoogleSearchToolConfig()];
          }
          
          const model = genAI.getGenerativeModel(modelOptions);
          const notebookTemperature = Math.min(getModelTemperature(this.settings.notebookModel, this.settings), 0.3);
          const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: notebookTemperature,
              topK: 40,
              topP: getModelTopP(this.settings.notebookModel, this.settings),
              maxOutputTokens: 8192,
            },
          });
          assistantResponse = result.response.text();
      } else if (this.settings.notebookProvider === 'groq') {
          
          const groqService = new GroqService(
            this.settings.groqApiKey,
            (headers) => this.rateLimitManager.updateFromHeaders('groq', this.settings.notebookModel, headers)
          );

          
          const groqMessages: GroqChatMessage[] = [];

          
          const systemContent = this.buildGroqSystemPrompt(cachedContext);
          groqMessages.push({
            role: 'system',
            content: systemContent
          });

          
          const contextLength = this.notebook.contextLength !== undefined ? this.notebook.contextLength : 3;
          const messagesToInclude = contextLength > 0 ? this.messages.slice(-contextLength) : [];
          for (const msg of messagesToInclude) {
            groqMessages.push({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content
            });
          }

          
          groqMessages.push({
            role: 'user',
            content: query
          });

          try {
            
            const notebookTemperature = Math.min(getModelTemperature(this.settings.notebookModel, this.settings), 0.3);
            
            assistantResponse = await groqService.generateContent(
              this.settings.notebookModel,
              groqMessages,
              {
                temperature: notebookTemperature,
                topP: getModelTopP(this.settings.notebookModel, this.settings)
              }
            );
          } catch (error) {
            if (error instanceof GroqApiError) {
              new Notice(error.message);
              throw error;
            }
            throw error;
          }
      } else if (this.settings.notebookProvider === 'openrouter') {
          
          const openRouterService = new OpenRouterService(
            this.settings.openRouterApiKey,
          (headers) => this.rateLimitManager.updateFromHeaders('openrouter', this.settings.notebookModel, headers)
          );

          
          const openRouterMessages: OpenRouterChatMessage[] = [];

          
          const systemContent = this.buildGroqSystemPrompt(cachedContext);
          openRouterMessages.push({
            role: 'system',
            content: systemContent
          });

          
          const contextLength = this.notebook.contextLength !== undefined ? this.notebook.contextLength : 3;
          const messagesToInclude = contextLength > 0 ? this.messages.slice(-contextLength) : [];
          for (const msg of messagesToInclude) {
            openRouterMessages.push({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content
            });
          }

          
          openRouterMessages.push({
            role: 'user',
            content: query
          });

          try {
            
            const notebookTemperature = Math.min(getModelTemperature(this.settings.notebookModel, this.settings), 0.3);
            
            assistantResponse = await openRouterService.generateContent(
              this.settings.notebookModel,
              openRouterMessages,
              {
                temperature: notebookTemperature,
                maxTokens: 8192,
                topP: getModelTopP(this.settings.notebookModel, this.settings)
              }
            );
          } catch (error) {
            if (error instanceof OpenRouterApiError) {
              new Notice(error.message);
              throw error;
            }
            throw error;
          }
      } else if (this.settings.notebookProvider === 'ollama') {
          
          const ollamaService = new OllamaService(
            this.settings.ollamaBaseUrl,
            this.settings.ollamaApiKey || '',
          (headers) => this.rateLimitManager.updateFromHeaders('ollama', this.settings.notebookModel, headers)
          );

          
          let webSourceContext = '';
          if (selectedWebs.length > 0) {
            if (!this.settings.ollamaApiKey) {
              new Notice('Ollama web source fetching requires an API key. Please add your Ollama API key in settings.');
            } else {
              const fetchedPages: { title: string; url: string; content: string }[] = [];
              for (const web of selectedWebs) {
                try {
                  const pageData = await ollamaService.webFetch(web.url);
                  fetchedPages.push({ title: pageData.title, url: web.url, content: pageData.content });
                                  } catch (fetchError) {
                                    new Notice(`Failed to fetch ${web.url}: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`);
                }
              }
              if (fetchedPages.length > 0) {
                webSourceContext = '\n\n--- WEB SOURCES ---\n\n';
                fetchedPages.forEach((page, idx) => {
                  webSourceContext += `--- Web Source [${idx + 1}]: ${page.title} (${page.url}) ---\n`;
                  webSourceContext += `${page.content.substring(0, 5000)}\n\n`;
                });
              }
            }
          }

          
          const ollamaMessages: OllamaChatMessage[] = [];

          
          const systemContent = this.buildGroqSystemPrompt(cachedContext) + webSourceContext;
          ollamaMessages.push({
            role: 'system',
            content: systemContent
          });

          
          const contextLength = this.notebook.contextLength !== undefined ? this.notebook.contextLength : 3;
          const messagesToInclude = contextLength > 0 ? this.messages.slice(-contextLength) : [];
          for (const msg of messagesToInclude) {
            ollamaMessages.push({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content
            });
          }

          
          ollamaMessages.push({
            role: 'user',
            content: query
          });

          try {
            
            const notebookTemperature = Math.min(getModelTemperature(this.settings.notebookModel, this.settings), 0.3);
            
            assistantResponse = await ollamaService.generateContent(
              this.settings.notebookModel,
              ollamaMessages,
              {
                temperature: notebookTemperature,
                maxTokens: 8192,
                topP: getModelTopP(this.settings.notebookModel, this.settings)
              }
            );
          } catch (error) {
            if (error instanceof OllamaApiError) {
              new Notice(error.message);
              throw error;
            }
            throw error;
          }
      } else if (this.settings.notebookProvider === 'nvidia' || UnifiedProviderManager.getInstance().hasProvider(this.settings.notebookProvider)) {
          
          
          
          let webSourceContext = '';
          if (selectedWebs.length > 0) {
            new Notice(`${this.settings.notebookProvider} web source fetching requires enabling web search. Use @web prefix.`);
          }

          if (this.settings.notebookProvider === 'nvidia') {
              const nvidiaService = new NvidiaService(
                this.settings.nvidiaApiKey,
              (headers) => this.rateLimitManager.updateFromHeaders('nvidia', this.settings.notebookModel, headers)
              );

              
              const nvidiaMessages: NvidiaChatMessage[] = [];

              
              const systemContent = this.buildGroqSystemPrompt(cachedContext);
              nvidiaMessages.push({
                role: 'system',
                content: systemContent
              });

              
              const contextLength = this.notebook.contextLength !== undefined ? this.notebook.contextLength : 3;
              const messagesToInclude = contextLength > 0 ? this.messages.slice(-contextLength) : [];
              for (const msg of messagesToInclude) {
                nvidiaMessages.push({
                  role: msg.role === 'user' ? 'user' : 'assistant',
                  content: msg.content
                });
              }

              
              nvidiaMessages.push({
                role: 'user',
                content: query
              });

              try {
                
                const notebookTemperature = Math.min(getModelTemperature(this.settings.notebookModel, this.settings), 0.3);
                assistantResponse = await nvidiaService.generateContent(
                  this.settings.notebookModel,
                  nvidiaMessages,
                  {
                    temperature: notebookTemperature,
                    maxTokens: 8192,
                    topP: getModelTopP(this.settings.notebookModel, this.settings)
                  }
                );
              } catch (error) {
                if (error instanceof NvidiaApiError) {
                  new Notice(error.message);
                  throw error;
                }
                throw error;
              }
          } else {
              
              const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(this.settings.notebookProvider)!;
              
              const unifiedMessages: SafeAny[] = [
                { role: 'system', content: this.buildGroqSystemPrompt(cachedContext) + (webSourceContext || '') },
                ...this.messages.slice(-(this.notebook.contextLength !== undefined ? this.notebook.contextLength : 3)).map(m => ({
                    role: m.role === 'user' ? 'user' : 'assistant',
                    content: m.content
                })),
                { role: 'user', content: query }
              ];

              try {
                const notebookTemperature = Math.min(getModelTemperature(this.settings.notebookModel, this.settings), 0.3);
                const response = await unifiedProvider.generateContent(
                  this.settings.notebookModel,
                  unifiedMessages,
                  {
                    temperature: notebookTemperature,
                    maxTokens: 8192,
                    topP: getModelTopP(this.settings.notebookModel, this.settings)
                  }
                );
                assistantResponse = response.text;
              } catch (error: SafeAny) {
                new Notice(`${this.settings.notebookProvider} API error: ${error.message || 'Unknown error'}`);
                throw error;
              }
          }
      }

      spinner.remove();

      
      if (this.notebook.mode === 'rag') {
        const responseTokens = countTokens(assistantResponse);
        const ragChunkTokens = countTokens(cachedContext);
        this.endGeneration(ragChunkTokens, responseTokens);
      }

      
      this.messages.push({ role: 'user', content: originalQuery });
      this.addMessage('assistant', assistantResponse, true, webResults, true, this.currentSourceMapping);
      
    } catch (e) {
      spinner.remove();
      
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      this.messages.push({ role: 'user', content: originalQuery });
      if (this.currentSession) {
        await this.saveCurrentSession();
      }
      new Notice(`Error generating response: ${errorMessage}`);
      this.addMessage('assistant', `Error generating response: ${errorMessage}`, true, [], true);
    }
  }

  private removeCitations(text: string): string {
    
    let cleaned = text.replace(/^\s*[-*]?\s*\[\^\d+\]:.*$/gm, '');

    
    cleaned = cleaned.replace(/\[\^\d+\]/g, '');

    
    const lines = cleaned.split('\n');
    const resultLines: string[] = [];
    let inFootnoteSection = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '---' || line === '***') {
            let foundCitation = false;
            for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                const nextLine = lines[j].trim();
                if (nextLine === '') continue;
                if (nextLine.startsWith('[[') || nextLine.startsWith('[') || nextLine.match(/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/)) {
                    foundCitation = true;
                    break;
                }
            }
            if (foundCitation) {
                inFootnoteSection = true;
                continue; 
            }
        }

        if (inFootnoteSection) {
            if (line === '' || line.startsWith('[[') || line.startsWith('[') || line.match(/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/)) {
                continue;
            } else {
                inFootnoteSection = false;
            }
        }
        resultLines.push(lines[i]);
    }

    cleaned = resultLines.join('\n');
    cleaned = cleaned.replace(/ {2,}/g, ' ');
    return cleaned.trim();
  }

  private convertToPlainTextKeepTables(text: string): string {
    let cleaned = text;

    cleaned = cleaned.replace(/^[*-]{3,}$/gm, '');
    cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    cleaned = cleaned.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '$1');
    cleaned = cleaned.replace(/\*\*|__|\*|_|~~|==/g, '');
    cleaned = cleaned.replace(/^#+\s+(.+)$/gm, '$1');
    cleaned = cleaned.replace(/^\s*>\s*/gm, '');
    cleaned = cleaned.replace(/```[\s\S]*?```/g, (match) => {
        return match.replace(/```[a-z]*\n?|```/gi, '');
    });
    cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
    cleaned = cleaned.split('\n').map(line => line.trimEnd()).join('\n');

    return cleaned.trim();
  }

  private async saveCurrentSession() {
    if (this.currentSession) {
      this.currentSession.messages = [...this.messages];
      await this.chatHistoryManager.saveSession(this.notebook.id, this.currentSession);
    }
  }

  
  private buildPromptWithHistory(userQuery: string, cachedContext: string, maxTokens: number): string {
    
    const citationsEnabled = this.notebook && this.notebook.inlineCitation !== false; 
    const isRagMode = this.notebook && this.notebook.mode === 'rag';
    
    const isWebOnly = this.selectedSourcePaths.size > 0 && Array.from(this.selectedSourcePaths).every(p => p.startsWith('web:'));
    
    const hasSessionContext = cachedContext.startsWith('SESSION CONTEXT:');

    
    let systemPrompt = '';
    if (this.notebook && this.notebook.customInstruction && this.notebook.customInstruction.trim().length > 0) {
      systemPrompt = `${this.notebook.customInstruction.trim()}\n\n`;
    }
    systemPrompt += `You are an AI research assistant specialized in analyzing and synthesizing information from notebook sources.

CORE MISSION: Provide comprehensive, accurate answers based STRICTLY on the knowledge base provided below.

CRITICAL REQUIREMENTS:
1. **Content Fidelity**: Answer ONLY using information from the provided knowledge base - no external knowledge
2. **Comprehensive Synthesis**: Review and synthesize information from ALL provided sources
3. **Detailed Responses**: Provide complete answers with specific examples, data, and context from the sources
4. **Clear Structure**: Use markdown formatting (headings, lists, code blocks, tables) for readability
5. **Logical Flow**: Organize information coherently with smooth transitions between topics
6. **Explicit Gaps**: If information is insufficient, clearly state what's missing without apologizing

STRICT GROUNDING ENFORCEMENT:
- You MUST NOT use any information from your training data or general knowledge
- You MUST NOT make assumptions or inferences beyond what is explicitly stated in the sources
- You MUST NOT provide examples, definitions, or explanations that are not present in the sources
- If a concept is mentioned in the question but not explained in the sources, state that it's not covered
- If you cannot answer based solely on the provided sources, say "I cannot answer this based on the available sources"
- Every fact, claim, or piece of information in your response must be traceable to the provided sources

RESPONSE QUALITY CHECKLIST:
✓ Have I reviewed ALL provided sources?
✓ Have I included specific details and examples?
✓ Is my answer well-structured and easy to follow?
✓ Have I cited sources correctly (if required)?
✓ Have I avoided adding external knowledge?
✓ Can I trace every statement in my response back to the provided sources?
`;

    
    if (hasSessionContext) {
      systemPrompt += `
IMPORTANT - SESSION CONTEXT:
The context below includes "SESSION CONTEXT" which contains the full conversation history from one or more previous chat sessions.
You MUST use this session history to understand what was discussed and provide relevant, contextual answers.
Treat the session context as your memory of past conversations with the user.
Reference specific details from the session context when answering questions about previous discussions.
`;
    }

    
    if (isRagMode) {
      systemPrompt += `
IMPORTANT CONTEXT HANDLING:
- The knowledge base contains relevant excerpts from source documents.
- Focus on the most relevant information to answer the user's question directly.
- If multiple sources are provided, synthesize the key points rather than processing every detail.
- Prioritize clarity and accuracy over comprehensiveness.
- If information seems incomplete, state what is known without over-explaining gaps.
`;
    }

    
    
    if (citationsEnabled && !isWebOnly) {
      systemPrompt += `
CRITICAL CITATION REQUIREMENTS (YOU MUST FOLLOW THESE):
- **MANDATORY**: Use footnote citations [^N] for EVERY fact, claim, or piece of information immediately after the sentence.
- The exact source numbers are provided in the KNOWLEDGE BASE below in format: --- File: FileName [Source N] ---
- Citation format: [^N] where N is the source number from the knowledge base
- For multiple sources in one sentence: [^1][^2]
- **DO NOT** skip citations - EVERY statement referencing the knowledge base MUST be cited.
- Example: "Photosynthesis is a process in plants[^1]."
- **DO NOT** create footnote definitions - they will be added automatically.
- Maintain proper formatting, structure, and readability in your response.`;
    } else {
      systemPrompt += `
- Maintain proper formatting, structure, and readability in your response.
- Do NOT include any citations or source references in your answer.`;
    }

    

    
    
    let notesSection = '\n\nPROCESSED KNOWLEDGE BASE:\n---\n';

    if (isRagMode) {
      
      
      notesSection += cachedContext;
    } else {
      
      const vaultName = this.app.vault.getName();
      const effectivePaths = this.getEffectiveSourcePaths();
      const selectedPaths = effectivePaths.filter(p => this.selectedSourcePaths.has(p));
      const fileContents = cachedContext.split(/--- File: .*? ---\n/).filter(c => c.trim().length > 0);

      selectedPaths.forEach((path, index) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          
          notesSection += `\n# Source ${index + 1}: ${file.basename}\n\n${fileContents[index] || ''}\n\n---\n`;
        }
      });
      
      this.currentSourceMapping = selectedPaths;
    }
    notesSection += '\n---';

    
    
    let contextLength = isRagMode 
      ? (this.notebook.contextLength !== undefined ? this.notebook.contextLength : 2)
      : this.cagHistoryContextLength;
    
    let messagesToInclude: ChatMessage[] = [];
    if (isRagMode) {
      messagesToInclude = contextLength > 0 ? this.messages.slice(-contextLength) : [];
    } else {
      if (contextLength === 20) {
        messagesToInclude = this.messages;
      } else if (contextLength > 0) {
        
        messagesToInclude = this.messages.slice(-contextLength * 2);
      }
    }

    const history: string[] = [];
    for (const msg of messagesToInclude) {
      if (msg.role === 'user') {
        history.push(`User: ${msg.content}`);
      } else {
        history.push(`Assistant: ${msg.content}`);
      }
    }
    
    const budget = maxTokens;
    
    let prompt = `${systemPrompt}${notesSection}\n\n`;
    let tokensUsed = countTokens(prompt);
    
    const included: string[] = [];
    for (const entry of history) {
      const entryTokens = countTokens(entry + '\n');
      if (tokensUsed + entryTokens > budget) break;
      included.push(entry);
      tokensUsed += entryTokens;
    }
    if (included.length > 0) {
      prompt += 'CONVERSATION HISTORY:\n' + included.join('\n') + '\n\n';
    }
    
    prompt += `CURRENT QUESTION:\nUser: ${userQuery}\n\nAssistant:`;

    return prompt;
  }

  /**
   * Builds a system prompt for Groq API with the notebook context.
   * Formats the context appropriately for Groq's OpenAI-compatible API.
   * @param cachedContext The cached context from notebook sources
   * @returns The formatted system prompt string
   */
  private buildGroqSystemPrompt(cachedContext: string): string {
    
    const citationsEnabled = this.notebook && this.notebook.inlineCitation !== false;
    const isRagMode = this.notebook && this.notebook.mode === 'rag';
    
    const isWebOnly = this.selectedSourcePaths.size > 0 && Array.from(this.selectedSourcePaths).every(p => p.startsWith('web:'));
    
    const hasSessionContext = cachedContext.startsWith('SESSION CONTEXT:');

    
    let systemPrompt = '';
    if (this.notebook && this.notebook.customInstruction && this.notebook.customInstruction.trim().length > 0) {
      systemPrompt = `${this.notebook.customInstruction.trim()}\n\n`;
    }
    systemPrompt += `You are an AI research assistant specialized in analyzing and synthesizing information from notebook sources.

CORE MISSION: Provide comprehensive, accurate answers based STRICTLY on the knowledge base provided below.

CRITICAL REQUIREMENTS:
1. **Content Fidelity**: Answer ONLY using information from the provided knowledge base - no external knowledge
2. **Comprehensive Synthesis**: Review and synthesize information from ALL provided sources
3. **Detailed Responses**: Provide complete answers with specific examples, data, and context from the sources
4. **Clear Structure**: Use markdown formatting (headings, lists, code blocks, tables) for readability
5. **Logical Flow**: Organize information coherently with smooth transitions between topics
6. **Explicit Gaps**: If information is insufficient, clearly state what's missing without apologizing

STRICT GROUNDING ENFORCEMENT:
- You MUST NOT use any information from your training data or general knowledge
- You MUST NOT make assumptions or inferences beyond what is explicitly stated in the sources
- You MUST NOT provide examples, definitions, or explanations that are not present in the sources
- If a concept is mentioned in the question but not explained in the sources, state that it's not covered
- If you cannot answer based solely on the provided sources, say "I cannot answer this based on the available sources"
- Every fact, claim, or piece of information in your response must be traceable to the provided sources

RESPONSE QUALITY CHECKLIST:
✓ Have I reviewed ALL provided sources?
✓ Have I included specific details and examples?
✓ Is my answer well-structured and easy to follow?
✓ Have I cited sources correctly (if required)?
✓ Have I avoided adding external knowledge?
✓ Can I trace every statement in my response back to the provided sources?
`;

    
    if (hasSessionContext) {
      systemPrompt += `
IMPORTANT - SESSION CONTEXT:
The context below includes "SESSION CONTEXT" which contains the full conversation history from one or more previous chat sessions.
You MUST use this session history to understand what was discussed and provide relevant, contextual answers.
Treat the session context as your memory of past conversations with the user.
Reference specific details from the session context when answering questions about previous discussions.
`;
    }

    
    if (isRagMode) {
      systemPrompt += `
IMPORTANT CONTEXT HANDLING:
- The knowledge base contains relevant excerpts from source documents.
- Focus on the most relevant information to answer the user's question directly.
- If multiple sources are provided, synthesize the key points rather than processing every detail.
- Prioritize clarity and accuracy over comprehensiveness.
- If information seems incomplete, state what is known without over-explaining gaps.
`;
    }

    
    
    if (citationsEnabled && !isWebOnly) {
      systemPrompt += `
CRITICAL CITATION REQUIREMENTS (YOU MUST FOLLOW THESE):
- **MANDATORY**: Use footnote citations [^N] for EVERY fact, claim, or piece of information immediately after the sentence.
- The exact source numbers are provided in the KNOWLEDGE BASE below in format: --- File: FileName [Source N] ---
- Citation format: [^N] where N is the source number from the knowledge base
- For multiple sources in one sentence: [^1][^2]
- **DO NOT** skip citations - EVERY statement referencing the knowledge base MUST be cited.
- Example: "Photosynthesis is a process in plants[^1]."
- **DO NOT** create footnote definitions - they will be added automatically.
- Maintain proper formatting, structure, and readability in your response.`;
    } else {
      systemPrompt += `
- Maintain proper formatting, structure, and readability in your response.
- Do NOT include any citations or source references in your answer.`;
    }

    

    
    
    let notesSection = '\n\nPROCESSED KNOWLEDGE BASE:\n---\n';

    if (isRagMode) {
      
      
      notesSection += cachedContext;
    } else {
      
      const vaultName = this.app.vault.getName();
      const effectivePaths = this.getEffectiveSourcePaths();
      const selectedPaths = effectivePaths.filter(p => this.selectedSourcePaths.has(p));
      const fileContents = cachedContext.split(/--- File: .*? ---\n/).filter(c => c.trim().length > 0);

      selectedPaths.forEach((path, index) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          
          notesSection += `\n# Source ${index + 1}: ${file.basename}\n\n${fileContents[index] || ''}\n\n---\n`;
        }
      });
      
      this.currentSourceMapping = selectedPaths;
    }
    notesSection += '\n---';

    return systemPrompt + notesSection;
  }

  private async handleRegenerate(originalContent: string) {
    
    this.messages = this.messages.filter(msg => msg.content !== originalContent);
    this.responsesContainer.empty(); 
    
    this.messages.forEach(msg => this.addMessage(msg.role, msg.content, false, [], false, msg.sourceMapping));

    
    const lastUserMessage = this.messages.filter(msg => msg.role === 'user').pop();
    if (lastUserMessage) {
      await this.handleSendMessage(); 
    } else {
      new Notice('No previous user message to regenerate from.');
    }
  }

  private async renderMarkdown(content: string, container: HTMLElement) {
    { const _comp = new Component();
    await MarkdownRenderer.renderMarkdown(content, container, this.app.vault.adapter.getResourcePath(''), _comp);
    _comp.load(); }

    
    const tables = container.querySelectorAll('table');
    tables.forEach(table => {
      table.classList.add('ai-chat-table');
    });

    container.findAll('a').forEach(link => {
      const href = link.getAttr('href');
      if (href) {
        if (href.startsWith('obsidian://')) {
          link.addEventListener('click', (event) => {
            event.preventDefault();
            window.open(href);
          });
        } else if (link.classList.contains('internal-link')) {
          link.addEventListener('click', (event) => {
            event.preventDefault();
            const linkText = link.getAttr('data-href');
            if (linkText) {
              this.app.workspace.openLinkText(linkText, '', false);
            }
          });
        }
      }
    });

    
    const webLinks = container.querySelectorAll('a[href^="http"]');
    webLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const href = (link as HTMLAnchorElement).href;
        window.open(href, '_blank');
      });
    });

    
    this.enableFootnoteInteractivity(container);
  }

  private processFootnoteReferences(content: string): string {
    
    const citationsEnabled = this.notebook && this.notebook.inlineCitation !== false;

    if (!citationsEnabled) {
      return content;
    }

    
    const footnoteRefs = content.match(/\[\^\d+\]/g) || [];
    if (footnoteRefs.length === 0) {
      return content;
    }

    
    const vaultName = this.app.vault.getName();
    const footnoteDefinitions: string[] = [];

    
    if (this.currentSourceMapping.length > 0) {
      this.currentSourceMapping.forEach((pathOrUrl, index) => {
        if (pathOrUrl.startsWith('web:')) {
          
          const url = pathOrUrl.substring(4);
          const web = this.effectiveWebSourcesCache.find(w => w.url === url);
          if (web) {
            footnoteDefinitions.push(`[^${index + 1}]: [${web.name}](${web.url})`);
          }
        } else {
          
          const file = this.app.vault.getAbstractFileByPath(pathOrUrl);
          if (file instanceof TFile) {
            const obsidianUrl = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file.path)}`;
            footnoteDefinitions.push(`[^${index + 1}]: [${file.basename}](${obsidianUrl})`);
          }
        }
      });
    } else {
      
      const effectivePaths = this.getEffectiveSourcePaths();
      const selectedPaths = effectivePaths.filter(p => this.selectedSourcePaths.has(p));
      selectedPaths.forEach((path, index) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          const obsidianUrl = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file.path)}`;
          footnoteDefinitions.push(`[^${index + 1}]: [${file.basename}](${obsidianUrl})`);
        }
      });

      
      
    }

    
    if (footnoteDefinitions.length > 0) {
      return content + '\n\n' + footnoteDefinitions.join('\n');
    }

    return content;
  }

  private enableFootnoteInteractivity(container: HTMLElement) {
    
    const allLinks = Array.from(container.querySelectorAll('a'));
    const footnoteRefs = allLinks.filter(link => {
      const href = link.getAttribute('href');
      const isInSup = link.closest('sup') !== null;
      const isFootnoteHref = href && (href.startsWith('#fn') || href.startsWith('#user-content-fn'));
      return isInSup || isFootnoteHref;
    });

    footnoteRefs.forEach((refLink) => {
      const href = refLink.getAttribute('href');

      if (!href || !href.startsWith('#')) return;

      
      refLink.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        const targetId = href.substring(1);

        
        let targetEl = container.querySelector(`#${targetId}`) as HTMLElement;

        
        if (!targetEl) {
          targetEl = container.querySelector(`[id="${targetId}"]`) as HTMLElement ||
            container.querySelector(`li[data-footnote-id="${targetId}"]`) as HTMLElement;
        }

        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

          
          targetEl.addClass('nl-background-color-var--text-accent');
          targetEl.addClass('nl-opacity-03');

          
          const backArrow = targetEl.querySelector('.footnote-backref') as HTMLElement;
          if (backArrow) {
            backArrow.addClass('nl-color-var--text-accent');
            backArrow.addClass('nl-font-weight-bold');
          }

          
          setTimeout(() => {
            targetEl.addClass('nl-background-color-');
            targetEl.addClass('nl-opacity-');
            if (backArrow) {
              backArrow.addClass('nl-color-');
              backArrow.addClass('nl-font-weight-');
            }
          }, 2000);
        }
      });

      
      refLink.addEventListener('mouseenter', (e: MouseEvent) => {
        const targetId = href.substring(1);
        let targetEl = container.querySelector(`#${targetId}`) as HTMLElement;

        if (!targetEl) {
          targetEl = container.querySelector(`[id="${targetId}"]`) as HTMLElement ||
            container.querySelector(`li[data-footnote-id="${targetId}"]`) as HTMLElement;
        }

        if (targetEl) {
          const tooltip = document.createElement('div');
          tooltip.classList.add('footnote-tooltip');
          tooltip.setCssProps({ 'css-text':  `
            position: fixed;
            background-color: var(--background-primary);
            border: 1px solid var(--background-modifier-border);
            border-radius: 4px;
            padding: 8px 12px;
            font-size: 0.9em;
            max-width: 300px;
            z-index: 1000;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
          ` });

          
          const clonedContent = targetEl.cloneNode(true) as HTMLElement;
          const backArrow = clonedContent.querySelector('.footnote-backref');
          if (backArrow) backArrow.remove();

          tooltip.empty();
          tooltip.appendChild(clonedContent);
          document.body.appendChild(tooltip);

          
          const rect = refLink.getBoundingClientRect();
          tooltip.setCssProps({ 'left':  `${rect.left}px` });
          tooltip.setCssProps({ 'top':  `${rect.bottom + 5}px` });

          
          const removeTooltip = () => {
            if (tooltip.parentNode) {
              tooltip.parentNode.removeChild(tooltip);
            }
            refLink.removeEventListener('mouseleave', removeTooltip);
          };

          refLink.addEventListener('mouseleave', removeTooltip);
        }
      });
    });

    
    const footnoteContainers = Array.from(container.querySelectorAll('.footnotes, section.footnotes, div.footnotes, ol.footnotes-list'));

    footnoteContainers.forEach(fnContainer => {
      const footnoteItems = Array.from(fnContainer.querySelectorAll('li'));

      footnoteItems.forEach((itemEl) => {
        
        if (itemEl.querySelector('.footnote-backref') || itemEl.textContent?.includes('↩')) {
          return;
        }

        const id = itemEl.getAttribute('id');

        if (id) {
          const backArrow = document.createElement('a');
          backArrow.classList.add('footnote-backref');
          backArrow.textContent = ' ↩';
          backArrow.setAttribute('aria-label', 'Back to content');
          backArrow.setCssProps({ 'css-text':  'margin-left: 0.25em; cursor: pointer; text-decoration: none;' });

          backArrow.addEventListener('click', (e: MouseEvent) => {
            e.preventDefault();
            
            const refLink = container.querySelector(`a[href="#${id}"]`) as HTMLElement;
            if (refLink) {
              refLink.scrollIntoView({ behavior: 'smooth', block: 'center' });

              
              refLink.addClass('nl-background-color-var--text-accent');
              refLink.addClass('nl-opacity-03');
              setTimeout(() => {
                refLink.addClass('nl-background-color-');
                refLink.addClass('nl-opacity-');
              }, 1000);
            }
          });

          itemEl.appendChild(backArrow);
        }
      });
    });
  }

  private showModelMenu() {
    
    const menu = this.container.querySelector('.model-select-menu');
    if (menu) {
      menu.remove();
      return;
    }
    const modelBtn = this.modelSelectButton.buttonEl;
    if (!modelBtn) return;
    const menuEl = document.createElement('div');
    menuEl.className = 'model-select-menu';

    
    const searchContainer = document.createElement('div');
    searchContainer.className = 'model-search-container';
    searchContainer.addClass('nl-position-sticky');
    searchContainer.addClass('nl-top-0');
    searchContainer.addClass('nl-background-var--background-primary');
    searchContainer.addClass('nl-z-index-2');
    searchContainer.addClass('nl-padding-8px');
    searchContainer.addClass('nl-border-bottom-1pxsolidvar--background-modifier-border');

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search models...';
    searchInput.className = 'model-search-input';
    searchInput.addClass('nl-width-100');
    searchInput.addClass('nl-box-sizing-border-box');
    searchInput.addEventListener('keydown', (e) => e.stopPropagation());
    searchContainer.appendChild(searchInput);
    menuEl.appendChild(searchContainer);
    setTimeout(() => searchInput.focus(), 100);

    const itemsToFilter: { itemEl: HTMLElement, name: string }[] = [];
    const headersToFilter: { headerEl: HTMLElement, items: HTMLElement[], separatorEl?: HTMLElement }[] = [];

    
    let modelGroups = getModelsGroupedByProvider(this.settings);

    
    if (this.sourceViewMode === 'web') {
      modelGroups = modelGroups.filter(group => group.provider === 'gemini' || group.provider === 'ollama' || group.provider === 'nvidia');

      
      if (modelGroups.length === 0) {
        const noticeEl = document.createElement('div');
        noticeEl.className = 'model-select-menu-notice';
        noticeEl.textContent = '⚠️ Web sources require Gemini, Ollama, or NVIDIA models. Please configure these models in settings.';
        menuEl.appendChild(noticeEl);

        document.body.appendChild(menuEl);
        const btnRect = modelBtn.getBoundingClientRect();
        const menuRect = menuEl.getBoundingClientRect();
        menuEl.addClass('nl-position-absolute');
        menuEl.setCssProps({ 'left':  `${btnRect.left}px` });
        menuEl.setCssProps({ 'top':  `${btnRect.top - menuRect.height - 8}px` });
        menuEl.addClass('nl-z-index-1000');

        setTimeout(() => {
          document.addEventListener('click', closeMenuNotice);
        }, 0);

        function closeMenuNotice(event: MouseEvent) {
          if (!menuEl.contains(event.target as Node) && event.target !== modelBtn) {
            menuEl.remove();
            document.removeEventListener('click', closeMenuNotice);
          }
        }
        return;
      }
    }

    
    modelGroups.forEach((group, groupIndex) => {
      
      const headerEl = document.createElement('div');
      headerEl.className = 'model-select-menu-header';
      headerEl.textContent = group.label;
      menuEl.appendChild(headerEl);

      const groupItems: HTMLElement[] = [];
      const headerObj = { headerEl, items: groupItems, separatorEl: undefined as HTMLElement | undefined };
      headersToFilter.push(headerObj);

      
      group.models.forEach(model => {
        const menuItem = document.createElement('div');
        menuItem.className = 'model-select-menu-item';
        groupItems.push(menuItem);
        itemsToFilter.push({ itemEl: menuItem, name: model.name.toLowerCase() });
        
        
        const textSpan = document.createElement('span');
        textSpan.textContent = model.name;
        menuItem.appendChild(textSpan);
        
        
        const webCapableModels = [
          'gemini-2.5-flash',
          'gemini-flash-lite-latest',
          'groq/compound',
          'groq/compound-mini'
        ];
        
        
        const isWebCapable = model.provider === 'ollama' || webCapableModels.includes(model.id);
        
        if (isWebCapable) {
          const iconSpan = document.createElement('span');
          iconSpan.className = 'model-web-icon';
          setIcon(iconSpan, 'globe');
          menuItem.appendChild(iconSpan);
        }
        
        if (model.id === this.settings.notebookModel) {
          menuItem.classList.add('is-active');
        }
        menuItem.onclick = async () => {
          this.settings.notebookModel = model.id;
          this.settings.notebookProvider = model.provider;
          await this.plugin.saveSettings();
          this.modelSelectButton.setButtonText(model.name);
          this.updateContextBar();
          menuEl.remove();
        };
        menuEl.appendChild(menuItem);
      });

      
      if (groupIndex < modelGroups.length - 1) {
        const separator = document.createElement('div');
        separator.className = 'model-select-menu-separator';
        menuEl.appendChild(separator);
        headerObj.separatorEl = separator;
      }
    });

    
    searchInput.addEventListener('input', (e) => {
      const query = (e.target as HTMLInputElement).value.toLowerCase();
      itemsToFilter.forEach(obj => {
        obj.itemEl.toggleClass('nl-display-none', !(obj.name.includes(query)));
      });
      headersToFilter.forEach(headerObj => {
        const hasVisibleItems = headerObj.items.some(item => item.style.display !== 'none');
        headerObj.headerEl.toggleClass('nl-display-none', !(hasVisibleItems));
        if (headerObj.separatorEl) headerObj.separatorEl.toggleClass('nl-display-none', !(hasVisibleItems));
      });
    });

    document.body.appendChild(menuEl);
    
    const btnRect = modelBtn.getBoundingClientRect();
    const menuRect = menuEl.getBoundingClientRect();
    menuEl.addClass('nl-position-absolute');
    menuEl.setCssProps({ 'left':  `${btnRect.left}px` });
    menuEl.setCssProps({ 'top':  `${btnRect.top - menuRect.height - 8}px` });
    menuEl.addClass('nl-z-index-1000');
    setTimeout(() => {
      document.addEventListener('click', closeMenu);
    }, 0);
    function closeMenu(event: MouseEvent) {
      if (!menuEl.contains(event.target as Node) && event.target !== modelBtn) {
        menuEl.remove();
        document.removeEventListener('click', closeMenu);
      }
    }
  }

  private async updateContextBar() {
    
    
    let maxTokens = 0;

    
    const customModel = this.settings.customModels.find(m => 
      m.id === this.settings.notebookModel && 
      m.provider === this.settings.notebookProvider
    );
    if (customModel && customModel.tokenLimit && customModel.tokenLimit > 0) {
      maxTokens = customModel.tokenLimit;
    } else {
      
      const provider = this.settings.notebookProvider;
      if (provider === 'groq') {
        maxTokens = 1000000; 
      } else if (provider === 'openrouter') {
        maxTokens = 1000000; 
      } else if (provider === 'ollama') {
        maxTokens = 1000000; 
      } else {
        maxTokens = 1000000; 
      }
    }

    this.contextBarContainer.addClass('nl-display-flex');

    let currentTokens = 0;
    let docsTokens = 0;
    let historyTokens = 0;
    const contextLength = this.notebook.contextLength !== undefined ? this.notebook.contextLength : 3;

    
    if (this.notebook.mode === 'rag') {
      
      if (contextLength > 0) {
        const recentMessages = this.messages.slice(-contextLength);
        recentMessages.forEach(msg => {
          currentTokens += countTokens(msg.content);
        });
      }
      

      
      currentTokens += this.dynamicTokens;

      
      currentTokens += this.outputTokens;
    } else {
      
      const cachedContext = await this.getCachedContext();
      docsTokens = countTokens(cachedContext);
      currentTokens += docsTokens;

      
      if (this.cagHistoryContextLength === 20) {
        this.messages.forEach(msg => {
          const t = countTokens(msg.content);
          historyTokens += t;
          currentTokens += t;
        });
      } else if (this.cagHistoryContextLength > 0) {
        const recentMessages = this.messages.slice(-this.cagHistoryContextLength * 2);
        recentMessages.forEach(msg => {
          const t = countTokens(msg.content);
          historyTokens += t;
          currentTokens += t;
        });
      }
    }

    const percentage = Math.min(100, (currentTokens / maxTokens) * 100);

    
    this.contextProgressBar.addClass('nl-transition-width03sease-out');
    this.contextProgressBar.setCssProps({ 'width':  `${percentage}%` });

    
    if (this.notebook.mode === 'rag') {
      if (this.isGenerating) {
        this.contextLabel.setText(`${currentTokens} / ${maxTokens} tokens (${percentage.toFixed(1)}%) • Generating...`);
      } else if (this.dynamicTokens > 0 || this.outputTokens > 0) {
        this.contextLabel.setText(`${currentTokens} / ${maxTokens} tokens (${percentage.toFixed(1)}%) • Last query`);
      } else {
        this.contextLabel.setText(`${currentTokens} / ${maxTokens} tokens (${percentage.toFixed(1)}%) • Context only`);
      }
    } else {
      const historyText = historyTokens > 0 ? ` (incl. ${historyTokens} history)` : '';
      this.contextLabel.setText(`${currentTokens} / ${maxTokens} tokens (${percentage.toFixed(1)}%)${historyText}`);
    }

    
    this.contextProgressBar.removeClass('low-usage', 'medium-usage', 'high-usage', 'over-usage', 'generating');
    let baseColorClass = '';
    if (this.isGenerating) {
      baseColorClass = 'generating';
    } else if (percentage < 50) {
      baseColorClass = 'low-usage';
    } else if (percentage < 80) {
      baseColorClass = 'medium-usage';
    } else if (percentage <= 100) {
      baseColorClass = 'high-usage';
    } else {
      baseColorClass = 'over-usage';
    }
    
    if (baseColorClass) this.contextProgressBar.addClass(baseColorClass);

    
    if (this.notebook.mode === 'cag' && historyTokens > 0 && currentTokens > 0) {
      let baseColor = 'var(--interactive-accent)';
      if (baseColorClass === 'generating') baseColor = 'var(--text-accent)';
      else if (baseColorClass === 'low-usage') baseColor = 'var(--color-green)';
      else if (baseColorClass === 'medium-usage') baseColor = 'var(--color-yellow)';
      else if (baseColorClass === 'high-usage') baseColor = 'var(--color-orange)';
      else if (baseColorClass === 'over-usage') baseColor = 'var(--color-red)';
      
      const docsRatio = docsTokens / currentTokens;
      const splitPoint = docsRatio * 100;
      this.contextProgressBar.setCssProps({ 'background':  `linear-gradient(to right, ${baseColor} ${splitPoint}%, var(--color-purple, #9b59b6) ${splitPoint}%)` });
    } else {
      this.contextProgressBar.addClass('nl-background-');
    }
  }

  
  private updateDynamicTokens(ragChunkTokens: number, responseTokens: number = 0) {
    this.dynamicTokens = ragChunkTokens;
    this.outputTokens = responseTokens;
    this.updateContextBar();
  }

  
  private startGeneration() {
    this.isGenerating = true;
    this.dynamicTokens = 0;
    this.outputTokens = 0;

    
    if (this.tokenBarResetTimeout) {
      clearTimeout(this.tokenBarResetTimeout);
      this.tokenBarResetTimeout = null;
    }

    this.updateContextBar();
  }

  
  private endGeneration(ragChunkTokens: number, responseTokens: number) {
    this.isGenerating = false;
    this.dynamicTokens = ragChunkTokens;
    this.outputTokens = responseTokens;
    this.updateContextBar();

    
    this.tokenBarResetTimeout = setTimeout(() => {
      this.animateTokenBarReset();
    }, 5000);
  }

  
  private animateTokenBarReset() {
    const steps = 20;
    const interval = 50; 
    const initialDynamic = this.dynamicTokens;
    const initialOutput = this.outputTokens;
    let step = 0;

    const animate = () => {
      step++;
      const progress = step / steps;
      const easeOut = 1 - Math.pow(1 - progress, 3); 

      this.dynamicTokens = Math.round(initialDynamic * (1 - easeOut));
      this.outputTokens = Math.round(initialOutput * (1 - easeOut));
      this.updateContextBar();

      if (step < steps) {
        requestAnimationFrame(animate);
      } else {
        this.dynamicTokens = 0;
        this.outputTokens = 0;
        this.updateContextBar();
      }
    };

    requestAnimationFrame(animate);
  }

  async onClose() {
    
  }

  
  public async externalInvalidateContextCache() {
    await this.invalidateContextCache();
  }

    
    private ragIndexStatusCache: {
      chunkCount: number;
      fileCount: number;
      hasChanges: boolean;
      needsIndexing: boolean;
      lastChecked: number;
    } | null = null;
}

class RenameSessionModal extends Modal {
  private initialName: string;
  private onSubmit: (newName: string) => void;

  constructor(app: SafeAny, initialName: string, onSubmit: (newName: string) => void) {
    super(app);
    this.initialName = initialName;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Name your session' });
    let newName = this.initialName;
    new Setting(contentEl)
      .setName('Session Name')
      .addText(text => text
        .setValue(this.initialName)
        .onChange(value => { newName = value; })
        .inputEl.focus()
      );
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());
    new ButtonComponent(buttonContainer)
      .setButtonText('Save')
      .setCta()
      .onClick(() => {
        if (newName.trim()) {
          this.onSubmit(newName);
          this.close();
        }
      });
  }
}

class SessionSelectModal extends Modal {
  private sessions: NotebookChatSessionMeta[];
  private onSelect: (sessionIds: string[]) => void;
  private selectedSessions: Set<string> = new Set();

  constructor(app: SafeAny, sessions: NotebookChatSessionMeta[], onSelect: (sessionIds: string[]) => void) {
    super(app);
    this.sessions = sessions;
    this.onSelect = onSelect;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('session-select-modal');
    contentEl.createEl('h2', { text: 'Select Sessions for Context' });

    
    const scrollableContainer = contentEl.createDiv({ cls: 'session-select-scrollable-container' });
    this.sessions.forEach(session => {
      const sessionItem = scrollableContainer.createDiv({ cls: 'session-item' });
      const checkbox = sessionItem.createEl('input', { type: 'checkbox', value: session.id });
      const label = sessionItem.createEl('label', { text: session.name });

      checkbox.onchange = () => {
        if (checkbox.checked) {
          this.selectedSessions.add(session.id);
        } else {
          this.selectedSessions.delete(session.id);
        }
      };

      label.onclick = () => {
        checkbox.checked = !checkbox.checked;
        if (checkbox.checked) {
          this.selectedSessions.add(session.id);
        } else {
          this.selectedSessions.delete(session.id);
        }
      };
    });

    
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());
    new ButtonComponent(buttonContainer)
      .setButtonText('Done')
      .setCta()
      .onClick(() => {
        this.onSelect(Array.from(this.selectedSessions));
        this.close();
      });
  }
}


class SearchResultsModal extends Modal {
  private results: SafeAny[];
  private onAdd: (results: SafeAny[]) => void;
  private isLoading: boolean;
  private error: string | null;
  private selectedResults: Set<number> = new Set();

  constructor(app: SafeAny, results: SafeAny[], onAdd: (results: SafeAny[]) => void, isLoading = false, error: string | null = null) {
    super(app);
    this.results = results;
    this.onAdd = onAdd;
    this.isLoading = isLoading;
    this.error = error;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('session-select-modal');
    contentEl.createEl('h2', { text: 'Search Results' });
    if (this.isLoading) {
      contentEl.createDiv({ text: 'Searching...' });
      return;
    }
    if (this.error) {
      contentEl.createDiv({ text: this.error, cls: 'search-error' });
      return;
    }
    if (!this.results.length) {
      contentEl.createDiv({ text: 'No results found.' });
      return;
    }
    
    const scrollableContainer = contentEl.createDiv({ cls: 'search-results-scrollable-container' });
    
    this.results.forEach((result, idx) => {
      const item = scrollableContainer.createDiv({ cls: 'session-item' });
      const checkbox = item.createEl('input', { type: 'checkbox' });
      checkbox.checked = this.selectedResults.has(idx);
      checkbox.onchange = () => {
        if (checkbox.checked) this.selectedResults.add(idx);
        else this.selectedResults.delete(idx);
      };
      const title = item.createEl('a', { text: result.title, href: result.link });
      title.target = '_blank';
      title.rel = 'noopener';
      item.createDiv({ text: result.snippet, cls: 'notebook-search-snippet' });
    });
    
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());
    new ButtonComponent(buttonContainer)
      .setButtonText('Done')
      .setCta()
      .onClick(() => {
        const selected = Array.from(this.selectedResults).map(idx => this.results[idx]);
        this.onAdd(selected);
        this.close();
      });
  }
}
