import { App, ItemView, WorkspaceLeaf, ButtonComponent, Notice, MarkdownRenderer, TFile, Component, SuggestModal, TFolder, Modal, Setting, setIcon, normalizePath, requestUrl, Platform } from 'obsidian';
import { OramaWorkerManager } from '../utils/oramaWorkerManager';
import { AISettings, Provider, getModelsGroupedByProvider, getModelDisplayName as getModelDisplayNameFromSettings, getProviderForEmbeddingModel, getGeminiThinkingConfig, getModelTemperature, getModelTopP, getModelZapColor, isThinkingButtonVisible } from '../settings';
import { TokenEstimator, TaskType } from '../utils/tokenEstimator';
import { ModelSelector, ModelSelection } from '../modelSelector';
import AIPlugin from '../main';
import { WebSearchService, SearchResult as WebSearchResult } from '../services/webSearch';
import { VaultSearchAgent } from '../managers/vaultSearchAgent';
import { BasicChatService } from '../services/basicChatService';
import { OllamaService } from '../services/ollamaService';
import { UnifiedProviderManager } from '../services/unifiedProviderManager';
import { AIChatSessionManager, AIChatSession } from '../managers/aiChatSessionManager';
import { YouTubeChatService } from '../services/youtubeChatService';
import { YouTubeTranscriptModal } from '../modals/youtubeTranscriptModal';
import { processDiagramContent } from '../tools/fileCreateTool';
import { MultimodalInput, processFileForMultimodal, isTextFile, isImageFile, isPDFFile, isAudioFile, isVideoFile, isMultimodalSupported, getFileIcon, extractImagesFromMarkdown } from '../utils/multimodalUtils';
import { extractTextFromFile, isExtractable } from '../utils/localFileExtractor';
import { RateLimitManager } from '../utils/rateLimitManager';
import { GeminiService } from '../services/geminiService';
import { GeminiFileAPIService } from '../services/geminiFileAPI';
import { MCPServerSelectionModal } from '../modals/mcpServerSelectionModal';
import { MCPToolCallingService } from '../mcp/mcpToolCalling';
import { executeCode, detectLanguage, isExecutable, isRenderable, wrapInMarkdownFence } from '../tools/codeExecutor';
import { SaveNoteModal } from '../modals/saveNoteModal';
import { openSessionHistoryModal } from '../modals/sessionHistoryModal';
import { createDetached } from '../utils/domUtils';
import { isGeminiOrOllama, buildWebpageContext } from '../utils/webpageContext';

interface MCPResourceReadResult {
    contents: Array<{
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
    }>;
}

function $q<T extends Element>(el: Element | null | undefined, sel: string): T | null {
    return (el ?? null)?.querySelector<T>(sel) ?? null;
}
function $qa<T extends Element>(el: Element, sel: string): T[] {
    return Array.from(el.querySelectorAll<T>(sel));
}
function $c<T extends Element>(el: Element, sel: string): T | null {
    return el.closest<T>(sel) ?? null;
}

export const VIEW_TYPE_NEXUS_CHAT = 'NEXUS_CHAT_VIEW';

interface Response {
    question: string;
    answer: string;
    context: string[];
    timestamp: Date;
    sources?: Array<{
        path: string;
        relevance: number;
        url?: string; 
    }>;
    webResults?: WebSearchResult[];
    webAnswer?: string; 
    id?: string;
    sessionId?: string;
    fileActionIds?: string[]; 
    fileActionData?: { [actionId: string]: FileActionData };
    
    modelName?: string; 
    totalTokens?: number; 
    responseTimeMs?: number; 
    
    mcpTools?: Array<{
        server: string;
        tool: string;
    }>;
    
    searchMode?: 'vault' | 'flash';
    
    vaultIndexName?: string;

    agentSteps?: unknown[];
    isAgentResponse?: boolean;
    vaultAnswer?: string;
    vaultResults?: Array<{ path: string; score: number }>;
    fileOperations?: unknown[];
    summary?: string;
    keywords?: string[];
    lessons?: string[];
    importance?: number;
    stepsCount?: number;
    success?: boolean;
    artifacts?: string[];
    
    metadata?: {
        vaultSearchFallback?: {
            used: boolean;
            reason: string;
        };
        aiAnalysisFailed?: {
            failed: boolean;
            reason: string;
            hadResults: boolean;
        };
    };
}

interface ModelRateLimitInfo {
    modelId: string;
    rank: number;
    callsPerMinute: number;
    currentCalls: number;
    lastResetTime: number;
}

interface SearchResult {
    path: string;
    content: string;
    similarity: number;
}

interface GeminiPart {
    text?: string;
    thought?: boolean;
}

interface GeminiCandidate {
    content?: {
        parts?: GeminiPart[];
    };
}

interface GeminiResponse {
    candidates?: GeminiCandidate[];
    text?: () => string;
    response?: GeminiResponse;
}

interface AIResponseResult {
    answer?: string;
    response?: string;
    content?: string;
    text?: string;
    message?: string;
}

interface FileCreationPlan {
    folderName: string;
    files: Array<{
        name: string;
        content: string;
        extension: string;
        description?: string;
        templatePath?: string;
    }>;
}

interface CanvasData {
    nodes: unknown[];
    edges?: unknown[];
    targetPath?: string;
}

interface ExcalidrawData {
    elements: unknown[];
    type?: string;
    version?: number;
    source?: string;
    appState?: Record<string, unknown>;
    files?: Record<string, unknown>;
    targetPath?: string;
}

interface GeminiResponse {
    candidates?: GeminiCandidate[];
    text?: () => string;
    [key: string]: unknown;
}

interface ContextFile {
    basename: string;
    content: string;
    [key: string]: unknown;
}

interface PrefixOption {
    label: string;
    value: string;
    action: string;
    description?: string;
    modalType?: string;
    hasToggle?: boolean;
    badge?: string;
    disabled?: boolean;
}

interface ChatHistoryEntry {
    role: string;
    parts: Array<{ text: string }>;
}

interface DiagramGenerationContext {
    settings: AISettings;
    userPrompt: string;
    targetFolder?: string;
    contextFiles: ContextFile[];
    webSearchEnabled?: boolean;
    webSearchService?: WebSearchService;
    chatHistory?: ChatHistoryEntry[];
}

interface IframeResizeMessage {
    iframeHeight: number;
}

interface FileActionResult {
    type?: 'edit' | 'create' | 'canvas' | 'excalidraw';
    folderName?: string;
    creationPrompt?: string;
    files?: Array<{ name?: string; description?: string; content?: string; extension?: string; templatePath?: string }> | unknown[];
    editData?: { filePath?: string; originalContent?: string; editedContent?: string; editPrompt?: string };
    createData?: { folderName?: string; creationPrompt?: string; files?: unknown[] };
    file?: { path?: string; basename?: string } | null;
    originalContent?: string;
    editedContent?: string;
    editPrompt?: string;
    nodes?: unknown[];
    edges?: unknown[];
    targetPath?: string;
    elements?: unknown[];
}

interface FileActionSaveData {
    type: 'edit' | 'create';
    fileName: string;
    status: string;
    isApplied: boolean;
    editData?: {
        filePath: string;
        originalContent: string;
        editedContent: string;
        editPrompt: string;
    };
    createData?: {
        folderName: string;
        creationPrompt: string;
        files: unknown[];
    };
}

interface FileActionState {
    id: string;
    type: 'edit' | 'create';
    fileName: string;
    status: 'processing' | 'completed' | 'failed' | 'accepted' | 'rejected';
    element: HTMLElement;
    data?: FileActionResult;
    error?: string;
    isApplied?: boolean;
    originalFileContent?: string;
    isExcalidraw?: boolean;
}

class FileModal extends SuggestModal<TFile> {
    private selectedCallback: (file: TFile) => void;
    private cursorPosition: number;
    private queryInput: HTMLTextAreaElement;

    constructor(app: App, onSelect: (file: TFile) => void, queryInput: HTMLTextAreaElement, cursorPosition: number) {
        super(app);
        this.selectedCallback = onSelect;
        this.queryInput = queryInput;
        this.cursorPosition = cursorPosition;
    }

    getSuggestions(query: string): TFile[] {
        const files = this.app.vault.getFiles();
        return files.filter((file: TFile) =>
            file.path.toLowerCase().includes(query.toLowerCase())
        );
    }

    renderSuggestion(file: TFile, el: HTMLElement) {
        el.createDiv({ text: file.path });
    }

    onChooseSuggestion(file: TFile) {
        const value = this.queryInput.value;
        const beforeCursor = value.slice(0, this.cursorPosition - 2);
        const afterCursor = value.slice(this.cursorPosition);

        this.queryInput.value = beforeCursor + afterCursor;
        this.selectedCallback(file);
    }
}

class FolderModal extends SuggestModal<TFolder> {
    private selectedCallback: (folder: TFolder) => void;
    private cursorPosition: number;
    private queryInput: HTMLTextAreaElement;

    constructor(app: App, onSelect: (folder: TFolder) => void, queryInput: HTMLTextAreaElement, cursorPosition: number) {
        super(app);
        this.selectedCallback = onSelect;
        this.queryInput = queryInput;
        this.cursorPosition = cursorPosition;
    }

    getSuggestions(query: string): TFolder[] {
        const folders = this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder);
        return folders.filter((folder: TFolder) =>
            folder.path.toLowerCase().includes(query.toLowerCase())
        );
    }

    renderSuggestion(folder: TFolder, el: HTMLElement) {
        el.createDiv({ text: folder.path + '/' });
    }

    onChooseSuggestion(folder: TFolder) {
        const value = this.queryInput.value;
        const beforeCursor = value.slice(0, this.cursorPosition - 1);

        this.queryInput.value = beforeCursor + folder.path + '/';
        this.queryInput.setSelectionRange(this.queryInput.value.length, this.queryInput.value.length);
        this.selectedCallback(folder);
    }
}

class ImageModal extends SuggestModal<TFile> {
    private selectedCallback: (file: TFile) => void;
    private cursorPosition: number;
    private queryInput: HTMLTextAreaElement;

    constructor(app: App, onSelect: (file: TFile) => void, queryInput: HTMLTextAreaElement, cursorPosition: number) {
        super(app);
        this.selectedCallback = onSelect;
        this.queryInput = queryInput;
        this.cursorPosition = cursorPosition;
    }

    getSuggestions(query: string): TFile[] {
        const files = this.app.vault.getFiles();
        return files.filter((file: TFile) =>
            /\.(png|jpg|jpeg|gif|bmp|svg|webp)$/i.test(file.path) && file.path.toLowerCase().includes(query.toLowerCase())
        );
    }

    renderSuggestion(file: TFile, el: HTMLElement) {
        el.createDiv({ text: file.path });
    }

    onChooseSuggestion(file: TFile) {
        const value = this.queryInput.value;
        const beforeCursor = value.slice(0, this.cursorPosition - 2);
        const afterCursor = value.slice(this.cursorPosition);
        
        const imageSyntax = `![${file.name}](${file.path})`;
        this.queryInput.value = beforeCursor + imageSyntax + afterCursor;
        this.queryInput.setSelectionRange(beforeCursor.length + imageSyntax.length, beforeCursor.length + imageSyntax.length);
        this.selectedCallback(file);
    }
}

class YouTubeURLModal extends Modal {
    private youtubeUrl: string = '';
    private onSubmit: (url: string) => void;

    constructor(app: App, onSubmit: (url: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
        this.modalEl.addClass('youtube-url-modal');
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('url-input-modal-content');

        contentEl.createEl('h2', { text: '▶️ Add YouTube Video' });
        contentEl.createEl('p', {
            text: 'Enter the YouTube video URL to add as context',
            cls: 'modal-description'
        });

        new Setting(contentEl)
            .setName('YouTube URL')
            .setDesc('Paste the full YouTube video URL (e.g., https://youtube.com/watch?v=..., https://youtube.com/live/..., or https://youtu.be/...)')
            .addText(text => {
                text.setPlaceholder('https://youtube.com/watch?v=... or https://youtube.com/live/...')
                    .setValue(this.youtubeUrl)
                    .onChange(value => {
                        this.youtubeUrl = value;
                    });
                text.inputEl.addClass('nl-width-100');
                
                window.setTimeout(() => text.inputEl.focus(), 50);
            });

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        new ButtonComponent(buttonContainer)
            .setButtonText('Cancel')
            .onClick(() => this.close());

        new ButtonComponent(buttonContainer)
            .setButtonText('Add to Context')
            .setCta()
            .onClick(() => {
                const url = this.youtubeUrl.trim();
                if (!url) {
                    new Notice('Please enter a YouTube URL');
                    return;
                }
                if (!/^https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be)\//i.test(url)) {
                    new Notice('Invalid YouTube URL. Please enter a valid YouTube video link.');
                    return;
                }
                this.onSubmit(url);
                this.close();
            });
    }

    onClose() {
        this.contentEl.empty();
    }
}

class WebPageURLModal extends Modal {
    private webUrls: string[] = [''];
    private onSubmit: (urls: string[]) => void;

    constructor(app: App, onSubmit: (urls: string[]) => void) {
        super(app);
        this.onSubmit = onSubmit;
        this.modalEl.addClass('webpage-url-modal');
    }

    onOpen() {
        this.renderContent();
    }

    private renderContent() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('url-input-modal-content');

        contentEl.createEl('h2', { text: '🌐 Add Web Pages' });
        contentEl.createEl('p', {
            text: 'Enter one or more web page URLs to add as context',
            cls: 'modal-description'
        });

        const urlsContainer = contentEl.createDiv({ cls: 'urls-container' });

        this.webUrls.forEach((url, index) => {
            const urlRow = urlsContainer.createDiv({ cls: 'url-input-row' });

            const inputWrapper = urlRow.createDiv({ cls: 'url-input-wrapper' });
            const input = inputWrapper.createEl('input', {
                type: 'text',
                placeholder: 'https://example.com',
                value: url,
                cls: 'url-input-field'
            });

            input.addEventListener('input', (e) => {
                this.webUrls[index] = (e.target as HTMLInputElement).value;
            });

            
            if (index === 0) {
                window.setTimeout(() => input.focus(), 50);
            }

            
            if (this.webUrls.length > 1) {
                const removeBtn = urlRow.createEl('button', {
                    text: '✕',
                    cls: 'url-remove-btn'
                });
                removeBtn.addEventListener('click', () => {
                    this.webUrls.splice(index, 1);
                    this.renderContent();
                });
            }
        });

        
        const addUrlBtn = contentEl.createDiv({ cls: 'add-url-btn-container' });
        new ButtonComponent(addUrlBtn)
            .setButtonText('+ Add Another URL')
            .setClass('add-url-btn')
            .onClick(() => {
                this.webUrls.push('');
                this.renderContent();
            });

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        new ButtonComponent(buttonContainer)
            .setButtonText('Cancel')
            .onClick(() => this.close());

        new ButtonComponent(buttonContainer)
            .setButtonText('Add to Context')
            .setCta()
            .onClick(() => {
                const validUrls = this.webUrls
                    .map(u => u.trim())
                    .filter(u => u.length > 0);

                if (validUrls.length === 0) {
                    new Notice('Please enter at least one URL');
                    return;
                }

                
                const invalidUrls = validUrls.filter(url => !/^https?:\/\/.+/.test(url));
                if (invalidUrls.length > 0) {
                    new Notice('Some URLs are invalid. Please check and try again.');
                    return;
                }

                this.onSubmit(validUrls);
                this.close();
            });
    }

    onClose() {
        this.contentEl.empty();
    }
}


const COLLECTION_ICONS = [
    'bot', 'brain', 'cpu', 'code', 'terminal', 'file-text', 'book-open', 'book', 'bookmark',
    'pen-tool', 'edit', 'feather', 'zap', 'star', 'heart', 'shield', 'lock', 'key', 'globe',
    'search', 'compass', 'map', 'layers', 'database', 'server', 'cloud', 'wifi', 'link',
    'message-circle', 'message-square', 'mail', 'inbox', 'send', 'bell', 'flag', 'tag',
    'user', 'users', 'person-standing', 'graduation-cap', 'briefcase', 'building',
    'lightbulb', 'flask-conical', 'microscope', 'atom', 'dna', 'leaf', 'tree-pine',
    'music', 'headphones', 'camera', 'image', 'video', 'film', 'palette', 'brush',
    'calculator', 'chart-bar', 'chart-line', 'pie-chart', 'trending-up', 'activity',
    'clock', 'calendar', 'timer', 'alarm-clock', 'hourglass', 'watch',
    'settings', 'sliders', 'wrench', 'hammer', 'tool', 'package', 'box', 'archive',
    'rocket', 'plane', 'car', 'bike', 'anchor', 'compass', 'navigation',
    'sun', 'moon', 'cloud-sun', 'snowflake', 'flame', 'droplets', 'wind',
    'smile', 'laugh', 'meh', 'frown', 'angry', 'cool', 'wink',
    'check-circle', 'x-circle', 'alert-circle', 'info', 'help-circle',
    'home', 'building-2', 'store', 'hospital', 'school', 'church',
    'coffee', 'pizza', 'apple', 'carrot', 'wine', 'beer',
    'gamepad-2', 'joystick', 'dice', 'trophy', 'medal', 'award',
    'dollar-sign', 'euro', 'bitcoin', 'credit-card', 'wallet', 'piggy-bank',
    'newspaper', 'rss', 'radio', 'tv', 'monitor', 'smartphone', 'tablet', 'laptop',
    'git-branch', 'github', 'gitlab', 'code-2', 'braces', 'brackets', 'hash',
    'infinity', 'sigma', 'function-square', 'binary', 'variable',
    'sword', 'shield-check', 'crosshair', 'target', 'swords',
    'cat', 'dog', 'bird', 'fish', 'rabbit', 'turtle', 'bug', 'butterfly',
    'mountain', 'waves', 'sunset', 'sunrise', 'cloud-rain', 'cloud-lightning',
    'sparkles', 'wand-2', 'magic-wand', 'crystal-ball', 'gem', 'diamond',
    'puzzle', 'blocks', 'grid', 'layout', 'columns', 'rows',
    'eye', 'ear', 'hand', 'footprints', 'fingerprint',
    'recycle', 'leaf', 'sprout', 'flower', 'tree-deciduous',
    'battery', 'battery-charging', 'plug', 'power', 'toggle-left',
    'map-pin', 'locate', 'navigation-2', 'route', 'milestone',
    'clipboard', 'clipboard-list', 'clipboard-check', 'sticky-note', 'notepad-text',
    'folder', 'folder-open', 'folder-plus', 'file', 'file-plus', 'files',
    'printer', 'scanner', 'hard-drive', 'usb', 'bluetooth',
    'volume-2', 'volume-x', 'mic', 'mic-off', 'speaker',
    'zoom-in', 'zoom-out', 'maximize', 'minimize', 'expand', 'shrink',
    'rotate-cw', 'rotate-ccw', 'flip-horizontal', 'flip-vertical', 'move',
    'copy', 'scissors', 'paste', 'trash', 'trash-2', 'delete',
    'download', 'upload', 'share', 'share-2', 'external-link',
    'plus', 'minus', 'x', 'check', 'chevron-up', 'chevron-down',
    'arrow-up', 'arrow-down', 'arrow-left', 'arrow-right',
    'refresh-cw', 'loader', 'loader-2', 'more-horizontal', 'more-vertical',
];

class SystemInstructionsModal extends Modal {
    private instructions: string;
    private onSubmit: (instructions: string, icon?: string) => void;
    private settings: AISettings;
    private saveSettingsCallback: () => Promise<void>;
    private textarea!: HTMLTextAreaElement;
    private charCount!: HTMLElement;
    private selectedIcon: string | undefined;

    constructor(app: App, currentInstructions: string, settings: AISettings, saveSettingsCallback: () => Promise<void>, onSubmit: (instructions: string, icon?: string) => void) {
        super(app);
        this.instructions = currentInstructions;
        this.onSubmit = onSubmit;
        this.settings = settings;
        this.saveSettingsCallback = saveSettingsCallback;
        this.modalEl.addClass('system-instructions-modal');
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('system-instructions-modal-content');

        
        const headerContainer = contentEl.createDiv({ cls: 'system-instructions-header' });
        headerContainer.createEl('h2', { text: '⚙️ System Instructions' });

        
        const saveToCollectionBtn = headerContainer.createEl('button', {
            cls: 'system-instructions-save-to-collection-btn',
            attr: { 'aria-label': 'Save to collection' }
        });
        setIcon(saveToCollectionBtn, 'plus');
        saveToCollectionBtn.addEventListener('click', () => this.showSaveToCollectionPrompt());

        contentEl.createEl('p', {
            text: 'Set custom instructions for the messages in this session.',
            cls: 'modal-description'
        });

        const textareaContainer = contentEl.createDiv({ cls: 'system-instructions-textarea-container' });
        this.textarea = textareaContainer.createEl('textarea', {
            placeholder: 'e.g., "You are a helpful coding assistant. Always provide code examples in TypeScript. Be concise and direct."',
            cls: 'system-instructions-textarea'
        });
        this.textarea.value = this.instructions;
        this.textarea.addEventListener('input', (e) => {
            this.instructions = (e.target as HTMLTextAreaElement).value;
        });

        
        window.setTimeout(() => this.textarea.focus(), 50);

        
        this.charCount = contentEl.createDiv({ cls: 'system-instructions-char-count' });
        const updateCharCount = () => {
            this.charCount.textContent = `${this.instructions.length} characters`;
        };
        updateCharCount();
        this.textarea.addEventListener('input', updateCharCount);

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container system-instructions-button-container' });

        
        const collectionsBtn = new ButtonComponent(buttonContainer)
            .setButtonText('Collections')
            .onClick(() => this.showCollectionsModal());
        collectionsBtn.buttonEl.addClass('system-instructions-collections-btn');

        
        buttonContainer.createDiv({ cls: 'button-spacer' });

        
        new ButtonComponent(buttonContainer)
            .setButtonText('Clear')
            .onClick(() => {
                this.textarea.value = '';
                this.instructions = '';
                updateCharCount();
            });

        new ButtonComponent(buttonContainer)
            .setButtonText('Cancel')
            .onClick(() => this.close());

        new ButtonComponent(buttonContainer)
            .setButtonText('Save')
            .setCta()
            .onClick(() => {
                this.onSubmit(this.instructions.trim(), this.selectedIcon);
                this.close();
            });
    }

    private showSaveToCollectionPrompt() {
        if (!this.instructions.trim()) {
            new Notice('Please enter some instructions first');
            return;
        }

        const promptModal = new Modal(this.app);
        promptModal.modalEl.addClass('save-instruction-name-modal');

        const { contentEl } = promptModal;
        contentEl.empty();
        contentEl.addClass('save-instruction-name-content');

        contentEl.createEl('h3', { text: 'Save to Collection' });
        contentEl.createEl('p', {
            text: 'Enter a name for this system instruction:',
            cls: 'modal-description'
        });

        const inputContainer = contentEl.createDiv({ cls: 'save-instruction-input-container' });
        const nameInput = inputContainer.createEl('input', {
            type: 'text',
            placeholder: 'e.g., Coding Assistant, Essay Writer...',
            cls: 'save-instruction-name-input'
        });

        
        contentEl.createEl('p', { text: 'Choose an icon (optional):', cls: 'modal-description' });
        const iconPickerContainer = contentEl.createDiv({ cls: 'collection-icon-picker-container' });

        
        const iconSearchInput = iconPickerContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search icons...',
            cls: 'collection-icon-search'
        });

        let selectedIconName: string | undefined = undefined;
        let selectedIconEl: HTMLElement | null = null;

        const iconGrid = iconPickerContainer.createDiv({ cls: 'collection-icon-grid' });

        const renderIcons = (filter: string) => {
            iconGrid.empty();
            const filtered = filter.trim()
                ? COLLECTION_ICONS.filter(n => n.includes(filter.toLowerCase()))
                : COLLECTION_ICONS;
            filtered.slice(0, 80).forEach(iconName => {
                const iconBtn = iconGrid.createDiv({ cls: 'collection-icon-btn' });
                if (iconName === selectedIconName) iconBtn.addClass('selected');
                iconBtn.setAttribute('title', iconName);
                setIcon(iconBtn, iconName);
                iconBtn.addEventListener('click', () => {
                    if (selectedIconEl) selectedIconEl.removeClass('selected');
                    if (selectedIconName === iconName) {
                        selectedIconName = undefined;
                        selectedIconEl = null;
                    } else {
                        selectedIconName = iconName;
                        selectedIconEl = iconBtn;
                        iconBtn.addClass('selected');
                    }
                });
            });
        };
        renderIcons('');

        iconSearchInput.addEventListener('input', () => renderIcons(iconSearchInput.value));

        window.setTimeout(() => nameInput.focus(), 50);

        const btnContainer = contentEl.createDiv({ cls: 'modal-button-container' });

        new ButtonComponent(btnContainer)
            .setButtonText('Cancel')
            .onClick(() => promptModal.close());

        new ButtonComponent(btnContainer)
            .setButtonText('Save')
            .setCta()
            .onClick(async () => {
                const name = nameInput.value.trim();
                if (!name) {
                    new Notice('Please enter a name');
                    return;
                }

                
                const existingIndex = this.settings.savedSystemInstructions.findIndex(
                    s => s.name.toLowerCase() === name.toLowerCase()
                );

                if (existingIndex !== -1) {
                    
                    this.settings.savedSystemInstructions[existingIndex].instructions = this.instructions.trim();
                    if (selectedIconName !== undefined) {
                        this.settings.savedSystemInstructions[existingIndex].icon = selectedIconName;
                    }
                    new Notice(`Updated "${name}" in collection`);
                } else {
                    
                    this.settings.savedSystemInstructions.push({
                        name: name,
                        instructions: this.instructions.trim(),
                        icon: selectedIconName,
                    });
                    new Notice(`Saved "${name}" to collection`);
                }

                await this.saveSettingsCallback();
                promptModal.close();
            });

        
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                btnContainer.querySelector('.mod-cta')?.dispatchEvent(new MouseEvent('click'));
            }
        });

        promptModal.open();
    }

    private showCollectionsModal() {
        const collectionsModal = new Modal(this.app);
        collectionsModal.modalEl.addClass('system-instructions-collections-modal');

        const { contentEl } = collectionsModal;
        contentEl.empty();
        contentEl.addClass('system-instructions-collections-content');

        contentEl.createEl('h3', { text: '📚 Saved Instructions' });

        const savedInstructions = this.settings.savedSystemInstructions;

        if (savedInstructions.length === 0) {
            contentEl.createEl('p', {
                text: 'No saved instructions yet. Use the + button to save your current instructions.',
                cls: 'collections-empty-message'
            });
        } else {
            const listContainer = contentEl.createDiv({ cls: 'collections-list' });

            savedInstructions.forEach((saved, index) => {
                const itemEl = listContainer.createDiv({ cls: 'collections-item' });

                
                const iconEl = itemEl.createDiv({ cls: 'collections-item-icon' });
                if (saved.icon) {
                    setIcon(iconEl, saved.icon);
                } else {
                    setIcon(iconEl, 'file-text');
                    iconEl.addClass('collections-item-icon-default');
                }

                const itemContent = itemEl.createDiv({ cls: 'collections-item-content' });
                itemContent.createSpan({ text: saved.name, cls: 'collections-item-name' });
                itemContent.createSpan({
                    text: `${saved.instructions.length} chars`,
                    cls: 'collections-item-meta'
                });

                
                itemContent.addEventListener('click', () => {
                    this.instructions = saved.instructions;
                    this.textarea.value = saved.instructions;
                    this.charCount.textContent = `${this.instructions.length} characters`;
                    this.selectedIcon = saved.icon;
                    collectionsModal.close();
                    new Notice(`Loaded "${saved.name}"`);
                });

                
                const editIconBtn = itemEl.createEl('button', {
                    cls: 'collections-item-edit-icon',
                    attr: { 'aria-label': 'Change icon' }
                });
                setIcon(editIconBtn, 'radio');
                editIconBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.showIconPickerForItem(index, iconEl, collectionsModal);
                });

                
                const deleteBtn = itemEl.createEl('button', {
                    cls: 'collections-item-delete',
                    attr: { 'aria-label': 'Delete' }
                });
                setIcon(deleteBtn, 'x');
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.settings.savedSystemInstructions.splice(index, 1);
                    this.saveSettingsCallback().then(() => {
                        new Notice(`Deleted "${saved.name}"`);
                        
                        this.showCollectionsModal();
                        collectionsModal.close();
                    }).catch(console.error);
                });
            });
        }

        const btnContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        new ButtonComponent(btnContainer)
            .setButtonText('Close')
            .onClick(() => collectionsModal.close());

        collectionsModal.open();
    }

    private showIconPickerForItem(index: number, iconDisplayEl: HTMLElement, parentModal: Modal) {
        const pickerModal = new Modal(this.app);
        pickerModal.modalEl.addClass('collection-icon-picker-modal');
        const { contentEl } = pickerModal;
        contentEl.empty();
        contentEl.createEl('h3', { text: 'Choose Icon' });

        const searchInput = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Search icons...',
            cls: 'collection-icon-search'
        });

        const saved = this.settings.savedSystemInstructions[index];
        let selectedIconName: string | undefined = saved.icon;
        let selectedIconEl: HTMLElement | null = null;

        const iconGrid = contentEl.createDiv({ cls: 'collection-icon-grid' });

        const renderIcons = (filter: string) => {
            iconGrid.empty();
            selectedIconEl = null;
            const filtered = filter.trim()
                ? COLLECTION_ICONS.filter(n => n.includes(filter.toLowerCase()))
                : COLLECTION_ICONS;
            filtered.slice(0, 80).forEach(iconName => {
                const iconBtn = iconGrid.createDiv({ cls: 'collection-icon-btn' });
                if (iconName === selectedIconName) {
                    iconBtn.addClass('selected');
                    selectedIconEl = iconBtn;
                }
                iconBtn.setAttribute('title', iconName);
                setIcon(iconBtn, iconName);
                iconBtn.addEventListener('click', () => {
                    if (selectedIconEl) selectedIconEl.removeClass('selected');
                    if (selectedIconName === iconName) {
                        selectedIconName = undefined;
                        selectedIconEl = null;
                    } else {
                        selectedIconName = iconName;
                        selectedIconEl = iconBtn;
                        iconBtn.addClass('selected');
                    }
                });
            });
        };
        renderIcons('');
        searchInput.addEventListener('input', () => renderIcons(searchInput.value));
        window.setTimeout(() => searchInput.focus(), 50);

        const btnContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        new ButtonComponent(btnContainer).setButtonText('Cancel').onClick(() => pickerModal.close());
        new ButtonComponent(btnContainer).setButtonText('Apply').setCta().onClick(async () => {
            this.settings.savedSystemInstructions[index].icon = selectedIconName;
            await this.saveSettingsCallback();
            iconDisplayEl.empty();
            if (selectedIconName) {
                setIcon(iconDisplayEl, selectedIconName);
                iconDisplayEl.removeClass('collections-item-icon-default');
            } else {
                setIcon(iconDisplayEl, 'file-text');
                iconDisplayEl.addClass('collections-item-icon-default');
            }
            pickerModal.close();
        });

        pickerModal.open();
    }

    onClose() {
        this.contentEl.empty();
    }
}

export class ResponseView extends ItemView {
    private responses: Response[] = [];
    private settings: AISettings;
    private contentContainer!: HTMLElement;
    private queryInput!: HTMLTextAreaElement;
    private selectedFiles: Set<string> = new Set();
    private activeSearchModes: Set<string> = new Set();
    private inputContainer!: HTMLElement;
    private navRailEl: HTMLElement | null = null;
    private navListEl: HTMLElement | null = null;
    private navOpenTimer: number | null = null;
    private jumpBtnEl: HTMLElement | null = null;
    private selectedFilesDisplay!: HTMLElement;
    private plugin: AIPlugin;
    get activeDocument() { return this.containerEl.ownerDocument; }
    private geminiFileAPI: GeminiFileAPIService;
    private loadingSpinner!: HTMLElement;
    private mode: 'chat' | 'qa' | 'mcq' = 'chat';
    private isProcessing: boolean = false;
    private stopKnowDeepBtn!: HTMLElement;
    private currentAbortController: AbortController | null = null;
    private webEnabled: boolean = false;
    private webSearchService: WebSearchService;
    
    private vaultSearchAgent: VaultSearchAgent;
    private basicChatService: BasicChatService;
    private rateLimitManager: RateLimitManager; 
    private enableThinkingMode: boolean = false;
    private contextCollapsed: boolean = false; 

    private contextMenuEl: HTMLElement | null = null;
    private contextMenuInput: HTMLInputElement | null = null;
    private contextMenuOpenFromMore: boolean = false;
    private contextMenuAtIndex: number = -1; 
    private contextMenuSearchTerm: string = ''; 
    private contextMenuPreviewEl: HTMLElement | null = null; 
    private pendingMCPSelection: { selectedServers: string[]; selectedResources: Map<string, string[]>; selectedTools: Map<string, string[]> } | null = null;

    private aiChatSessionManager: AIChatSessionManager;
    private sessionHistoryModal: HTMLElement | null = null;
    private currentSessionId: string | null = null;
    private currentSessionType: 'chat' | 'agent' | null = null;
    private currentSessionCreatedAt: number | null = null;
    private renderingRestoredSession: boolean = false; 
    private currentSystemInstructions: string = ''; 

    
    private activeFileActions: Map<string, FileActionState> = new Map();
    private fileActionCounter: number = 0;

    
    private vaultInlineCitationsEnabled: boolean = true; 

    

    
    private flashInlineCitationsEnabled: boolean = true; 

    private activeCanvas: CodeCanvasModal | null = null;

    
    private agentRateLimitEnabled: boolean = true; 

    
    private mcpRateLimitEnabled: boolean = true; 

    private thinkingBtnEl: HTMLElement | null = null; 

    
    private webSearchRetryCount: number = 0;

    
    private mcpToolCallingService!: MCPToolCallingService;

    private modelRateLimits: Map<string, ModelRateLimitInfo> = new Map();

    private currentProgressResponseEl: HTMLElement | null = null;
    private currentProgressEl: HTMLElement | null = null;
    private currentThinkingEl: HTMLElement | null = null;
    private currentThinkingText: string = '';
    private currentThinkingContainerEl: HTMLElement | null = null;
    private currentThinkingLabelEl: HTMLElement | null = null;
    private currentThinkingChunkEl: HTMLElement | null = null;
    private currentThinkingChunkText: string = '';
    private lastThinkingTime: number = 0;

    // Throttled answer rendering
    private lastAnswerRenderTime: number = 0;
    private answerRenderTimeout: number | null = null;

    
    private currentStreamingAnswerEl: HTMLElement | null = null;
    private currentStreamingAnswerText: string = '';
    private generatingIndicatorActive: boolean = false;

    

    
    private youtubeTranscriptCache: Map<string, { transcript: string; videoTitle: string }> = new Map();

    
    private wallpaperEl: HTMLElement | null = null;
    private headerSection!: HTMLElement;

    constructor(leaf: WorkspaceLeaf, plugin: AIPlugin) {
        super(leaf);
        this.responses = [];
        this.selectedFiles = new Set();
        this.mode = 'chat';
        this.isProcessing = false;
        this.webEnabled = false;
        this.plugin = plugin;
        this.settings = plugin.settings;
        this.rateLimitManager = RateLimitManager.getInstance(); 

        this.geminiFileAPI = new GeminiFileAPIService(this.app, this.settings);
        this.webSearchService = new WebSearchService();
        this.vaultSearchAgent = new VaultSearchAgent(
            this.app,
            this.settings,
            this.updateProcessingUI.bind(this),
            this.updateStreamingAnswer.bind(this)
        );
        this.basicChatService = new BasicChatService(this.app, this.settings, this.webSearchService, async () => { await this.plugin.saveSettings(); });
        this.enableThinkingMode = this.settings.enableThinkingMode; 
        this.aiChatSessionManager = new AIChatSessionManager(this.app);
        this.activeFileActions = new Map();
        this.fileActionCounter = 0;
        this.mcpToolCallingService = plugin.mcpToolCallingService;
        
        
        
        
    }

    getViewType() { return VIEW_TYPE_NEXUS_CHAT; }
    getDisplayText() {
        switch (this.mode) {
            case 'qa': return 'Nexus Q&A';
            case 'mcq': return 'Nexus MCQs';
            default: return 'Nexus Chat';
        }
    }
    getIcon(): string {
        return 'message-circle';
    }

    /**
     * Find if a session is already open in another tab
     */
    private findLeafWithSession(sessionId: string): WorkspaceLeaf | null {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_NEXUS_CHAT);
        for (const leaf of leaves) {
            const view = leaf.view;
            if (view instanceof ResponseView) {
                if (view.currentSessionId === sessionId) {
                    return leaf;
                }
            }
        }
        return null;
    }

    /**
     * Gets chat history based on the chatContextSize setting.
     * Returns empty array if chatContextSize is 0, otherwise returns the last N exchanges.
     */
    private getChatHistory(): Array<{ role: string; parts: Array<{ text: string }> }> {
        if (this.settings.chatContextSize <= 0) {
            return [];
        }
        return this.responses
            .slice(-this.settings.chatContextSize)
            .flatMap(r => [
                { role: "user", parts: [{ text: r.question }] },
                { role: "model", parts: [{ text: r.answer }] }
            ]);
    }

    /**
     * Estimates token count for a given text using a simple approximation.
     * Roughly 4 characters per token for English text.
     */
    private estimateTokenCount(text: string): number {
        if (!text) return 0;
        return Math.ceil(text.length / 4);
    }

    /**
     * Helper to extract YouTube URL from source content.
     * YouTube sources have content format: "YouTube Video: {title}\nSource: {url}\n\nTranscript:\n{transcript}"
     */
    private extractYouTubeUrlFromContent(content: string): string | null {
        if (!content) return null;
        const sourceMatch = content.match(/Source:\s*(https?:\/\/[^\s\n]+)/);
        return sourceMatch ? sourceMatch[1] : null;
    }

    /**
     * Maps search results to source objects, extracting YouTube URLs when present.
     */
    private mapToSources(results: SearchResult[]): Array<{ path: string; relevance: number; url?: string }> {
        return results.map(r => {
            const source: { path: string; relevance: number; url?: string } = {
                path: r.path,
                relevance: r.similarity
            };

            
            if (r.path.startsWith('YouTube:') && r.content) {
                const url = this.extractYouTubeUrlFromContent(r.content);
                if (url) {
                    source.url = url;
                }
            }

            return source;
        });
    }

    /**
     * Context bar removed - was confusing for users
     * Keeping method as no-op to avoid breaking existing calls
     */
    private updateContextBar() {
        
    }

    private updateContextContainerVisibility() {
        const fileTagsScrollWrapper = this.inputContainer.querySelector('.file-tags-scroll-wrapper') as HTMLElement;
        const toggleBtn = this.inputContainer.querySelector('.context-toggle-btn') as HTMLElement;

        
        if (!fileTagsScrollWrapper) {
            return;
        }

        if (this.contextCollapsed) {
            fileTagsScrollWrapper.addClass('nl-display-none');
            if (toggleBtn) {
                toggleBtn.createSpan({ text: '▶', cls: 'nl-font-size-18px nl-user-select-none' });
            }
        } else {
            fileTagsScrollWrapper.addClass('nl-display-');
            if (toggleBtn) {
                toggleBtn.createSpan({ text: '▼', cls: 'nl-font-size-18px nl-user-select-none' });
            }
        }
    }

    async onOpen() {
        const state = this.leaf.getViewState();
        this.mode = (state.state?.mode as "chat" | "qa" | "mcq") || 'chat';
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('ai-response-view');

        const wrapper = containerEl.createDiv({ cls: 'response-view-wrapper' });

        
        const headerSection = wrapper.createDiv({ cls: 'chat-header-section' });
        wrapper.prepend(headerSection);
        this.headerSection = headerSection;

        
        if (this.settings.chatWallpaperEnabled && this.settings.chatWallpaperPath) {
            headerSection.classList.add('liquid-glass-active');
        }

        
        const headerLeftControls = headerSection.createDiv({ cls: 'header-left-controls' });

        
        if (this.settings.aiChatHistoryEnabled) {
            const historyBtn = headerLeftControls.createDiv({ cls: 'header-history-btn' });
            setIcon(historyBtn, 'history');
            historyBtn.addClass('nl-cursor-pointer');
            historyBtn.setAttr('aria-label', 'View chat history');
            historyBtn.setAttr('tabindex', '0');
            historyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                void this.openSessionHistoryModal();
            });
        }

        
        const dbIndexBtn = headerLeftControls.createDiv({ cls: 'header-db-index-btn header-history-btn' });
        setIcon(dbIndexBtn, 'database-zap');
        dbIndexBtn.setAttr('aria-label', 'Change embedding index');
        dbIndexBtn.setAttr('tabindex', '0');
        dbIndexBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void this.showEmbeddingIndexMenu(dbIndexBtn);
        });

         
        const systemInstructionsBtn = headerLeftControls.createDiv({ cls: 'header-system-instructions-btn' });
        setIcon(systemInstructionsBtn, 'wrench');
        systemInstructionsBtn.addClass('nl-cursor-pointer');
        systemInstructionsBtn.setAttr('aria-label', 'System Instructions');
        systemInstructionsBtn.setAttr('tabindex', '0');
        
        if (this.currentSystemInstructions) {
            systemInstructionsBtn.addClass('has-instructions');
        }
        systemInstructionsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openSystemInstructionsModal();
        });

        
        const newChatBtn = headerLeftControls.createDiv({ cls: 'header-new-chat-btn' });
        setIcon(newChatBtn, 'plus');
        newChatBtn.addClass('nl-cursor-pointer');
        newChatBtn.setAttr('aria-label', 'Start new chat');
        newChatBtn.setAttr('tabindex', '0');
        newChatBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.startNewSession();
        });


        
        const headerRightControls = headerSection.createDiv({ cls: 'header-right-controls' });

        
        new ButtonComponent(headerRightControls)
            .setButtonText(this.getModelButtonText())
            .setClass('header-model-btn')
            .onClick(() => this.showModelMenu());

        this.renderOllamaThinkingButton(headerRightControls);

        
        const ellipsisBtn = headerRightControls.createDiv({ cls: 'header-ellipsis-btn' });
        setIcon(ellipsisBtn, 'more-vertical');
        ellipsisBtn.addClass('nl-cursor-pointer');
        ellipsisBtn.setAttr('aria-label', 'Menu options');
        ellipsisBtn.setAttr('tabindex', '0');
        ellipsisBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showHeaderMenu(ellipsisBtn);
        });

        this.contentContainer = wrapper.createDiv({ cls: 'responses-container' });

        
        this.inputContainer = wrapper.createDiv({ cls: 'chat-input-container' });

        const navRail = wrapper.createDiv({ cls: 'agent-nav-rail' });
        this.navRailEl = navRail;
        const navBar = navRail.createDiv({ cls: 'agent-nav-rail-bar' });
        navBar.setAttr('aria-label', 'Session questions navigation');
        navBar.addEventListener('click', (e) => {
            e.stopPropagation();
            navRail.addClass('is-open');
        });
        navRail.addEventListener('mouseenter', () => this.setNavOpen(true));
        navRail.addEventListener('mouseleave', () => this.scheduleNavClose());
        document.addEventListener('click', (e) => {
            if (this.navRailEl && !this.navRailEl.contains(e.target as Node)) {
                this.setNavOpen(false);
            }
        });
        const navPopover = navRail.createDiv({ cls: 'agent-nav-rail-popover' });
        this.navListEl = navPopover.createDiv({ cls: 'agent-nav-rail-list' });

        const jumpBtn = this.inputContainer.createDiv({ cls: 'agent-jump-bottom-btn' });
        this.jumpBtnEl = jumpBtn;
        setIcon(jumpBtn, 'arrow-down');
        jumpBtn.setAttr('aria-label', 'Scroll to bottom');
        jumpBtn.setAttr('tabindex', '0');
        jumpBtn.addEventListener('click', () => {
            if (this.contentContainer) {
                this.contentContainer.scrollTo({ top: this.contentContainer.scrollHeight, behavior: 'smooth' });
            }
        });
        this.contentContainer.addEventListener('scroll', () => this.updateJumpButton());

        
        if (Platform.isMobile) {
            let lastScrollTop = 0;
            let lastScrollHeight = this.contentContainer.scrollHeight;
            let lastClientHeight = this.contentContainer.clientHeight;

            this.contentContainer.addEventListener('scroll', () => {
                const currentScrollTop = this.contentContainer.scrollTop;
                const currentScrollHeight = this.contentContainer.scrollHeight;
                const currentClientHeight = this.contentContainer.clientHeight;

                // If layout shifted (streaming, toggles, or hide/show), ignore this scroll event
                if (currentScrollHeight !== lastScrollHeight || currentClientHeight !== lastClientHeight) {
                    lastScrollHeight = currentScrollHeight;
                    lastClientHeight = currentClientHeight;
                    lastScrollTop = currentScrollTop;
                    return;
                }

                if (Math.abs(currentScrollTop - lastScrollTop) < 10) return;

                if (currentScrollTop > lastScrollTop && currentScrollTop > 50) {
                    if (this.headerSection) this.headerSection.classList.add('mobile-hidden');
                    if (this.inputContainer) this.inputContainer.classList.add('mobile-hidden');
                } else {
                    if (this.headerSection) this.headerSection.classList.remove('mobile-hidden');
                    if (this.inputContainer) this.inputContainer.classList.remove('mobile-hidden');
                }
                lastScrollTop = currentScrollTop;
            });
        }

        
        const capsuleContainer = this.inputContainer.createDiv({ cls: 'context-capsule-container' });
        const capsuleDisplay = capsuleContainer.createDiv({ cls: 'context-capsule-display' });
        this.renderFileCapsules(capsuleDisplay);

        
        const inputRow = this.inputContainer.createDiv({ cls: 'input-row-container' });

        
        const leftControls = inputRow.createDiv({ cls: 'input-left-controls' });

        
        const capsuleBtn = leftControls.createDiv({ cls: 'context-menu-btn' });
        setIcon(capsuleBtn, 'plus');
        capsuleBtn.addClass('nl-cursor-pointer');
        capsuleBtn.setAttr('aria-label', 'Add context');
        capsuleBtn.setAttr('tabindex', '0');
        capsuleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openContextMenu(capsuleBtn, false);
        });

        
        this.queryInput = inputRow.createEl('textarea', {
            placeholder: 'Ask anything...',
            cls: 'query-input-new'
        });

        
        if (this.settings.chatWallpaperEnabled && this.settings.chatWallpaperPath) {
            this.queryInput.classList.add('liquid-glass-active');
            this.inputContainer.classList.add('liquid-glass-active');
        }

        
        const sendBtn = inputRow.createDiv({ cls: 'send-button-new' });
        setIcon(sendBtn, 'arrow-up');
        sendBtn.addClass('nl-cursor-pointer');
        sendBtn.setAttr('aria-label', 'Send message');
        sendBtn.setAttr('tabindex', '0');
        sendBtn.setAttr('data-state', 'send'); 

        sendBtn.addEventListener('click', () => {
            const currentState = sendBtn.getAttribute('data-state');

            if (currentState === 'send') {
                
                const query = this.queryInput.value;
                if (query.trim()) {
                    this.loadingSpinner.classList.add('visible');
                                        this.processQuery(query).then(() => {
                        this.loadingSpinner.classList.remove('visible');
                        this.queryInput.value = '';
                        this.adjustTextareaHeight();
                    }).catch((error) => {
                        this.loadingSpinner.classList.remove('visible');
                        
                        if (error instanceof Error && error.message.startsWith('PRESERVE_INPUT:')) {
                            // Preserve input text on PRESERVE_INPUT error
                        } else {
                            
                            this.queryInput.value = '';
                            
                            throw error;
                        }
                        this.adjustTextareaHeight();
                    });
                }
            } else {
                


                
                this.vaultSearchAgent.stop();
                if (this.currentAbortController) {
                    this.currentAbortController.abort();
                    this.currentAbortController = null;
                }

                this.isProcessing = false;
                this.setSendButtonState(sendBtn, 'send');

                this.queryInput.placeholder = 'Ask anything...';
                this.loadingSpinner.classList.remove('visible');

                

                new Notice('Processing cancelled');
            }
        });

        
        this.stopKnowDeepBtn = sendBtn;

        
        const prompts = [
            'Ask anything... Give it a moment to generate...',
            'Use prefix @webpage to read web pages and online PDFs...',
            'Use prefix @vault for semantic vault search...',
            'Use prefix @flash for faster vault search via keyword...',
            'Use prefix @web for web searched answers...',
            'Use prefix @mcp to use MCP servers and tools...'
        ];
        let promptIndex = 0;

        let isInputActive = false;
        const setNextPlaceholder = () => {
            if (!isInputActive && this.activeDocument.activeElement !== this.queryInput) {
                promptIndex = (promptIndex + 1) % prompts.length;
                if (this.queryInput.value.trim() === '') {
                    this.queryInput.setAttribute('placeholder', prompts[promptIndex]);
                }
            }
        };
        window.setInterval(setNextPlaceholder, 3500);
        this.queryInput.addEventListener('focus', () => {
            isInputActive = true;
        });
        this.queryInput.addEventListener('blur', () => {
            isInputActive = false;
            if (this.queryInput.value.trim() === '') {
                this.queryInput.setAttribute('placeholder', prompts[promptIndex]);
            }
        });
        this.queryInput.addEventListener('input', () => {
            isInputActive = (this.activeDocument.activeElement === this.queryInput && this.queryInput.value.trim() !== '');
            if (this.queryInput.value.trim() === '') {
                this.queryInput.setAttribute('placeholder', prompts[promptIndex]);
            } else {
                this.queryInput.setAttribute('placeholder', '');
            }
        });
        

        
        const hiddenToolbar = this.inputContainer.createDiv({ cls: 'hidden-toolbar' });
        const spinnerContainer = hiddenToolbar.createDiv({ cls: 'spinner-container' });
        this.loadingSpinner = spinnerContainer.createDiv({ cls: 'loading-spinner' });


        this.queryInput.addEventListener('input', (e) => {
            this.adjustTextareaHeight();

            
            const value = this.queryInput.value;
            const cursorPos = this.queryInput.selectionStart || 0;

            
            const textBeforeCursor = value.substring(0, cursorPos);
            const lastAtIndex = textBeforeCursor.lastIndexOf('@');

            if (lastAtIndex !== -1) {
                
                const textAfterAt = textBeforeCursor.substring(lastAtIndex);
                const searchTerm = textAfterAt.substring(1); 

                
                
                const textAfterCursor = value.substring(cursorPos);
                const nextAtIndex = textAfterCursor.indexOf('@');
                const hasAnotherAt = nextAtIndex !== -1;

                
                const completedPrefixes = ['youtube ', 'webpage ', 'vault ', 'flash ', 'web ', 'create ', 'edit ', 'agent ', 'mcp '];
                const isCompletedPrefix = completedPrefixes.some(prefix =>
                    searchTerm.startsWith(prefix) && searchTerm.length > prefix.length
                );

                
                let isCompletedFilename = false;
                
                for (const filePath of Array.from(this.selectedFiles)) {
                    const file = this.app.vault.getAbstractFileByPath(filePath);
                    if (file instanceof TFile) {
                        const filename = file.basename;
                        
                        
                        if (searchTerm.startsWith(filename + ' ')) {
                            isCompletedFilename = true;
                            break;
                        }
                    }
                }

                if (hasAnotherAt || isCompletedPrefix || isCompletedFilename) {
                    
                    this.closeContextMenu();
                } else {
                    
                    
                    this.openContextMenuWithFilter(capsuleBtn, false, searchTerm, lastAtIndex);
                }
            } else {
                
                this.closeContextMenu();
            }
        });

        this.queryInput.addEventListener('keydown', (e) => {
            
            if (this.contextMenuEl && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();

                const items = $qa<HTMLElement>(this.contextMenuEl, '.context-file-menu-item:not([style*="opacity: 0.5"])');
                if (items.length === 0) return;

                const currentSelected = this.contextMenuEl.querySelector('.context-file-menu-item.selected') as HTMLElement;
                let currentIndex = currentSelected ? items.indexOf(currentSelected) : -1;

                
                if (currentSelected) {
                    currentSelected.classList.remove('selected');
                }

                
                if (e.key === 'ArrowDown') {
                    currentIndex = (currentIndex + 1) % items.length;
                } else if (e.key === 'ArrowUp') {
                    currentIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
                }

                
                items[currentIndex].classList.add('selected');

                
                items[currentIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });

                
                this.updateContextMenuPreview(items[currentIndex]).catch(console.error);

                return;
            }

            
            if (e.key === 'Escape' && this.contextMenuEl) {
                e.preventDefault();
                this.closeContextMenu();
                return;
            }

            
            if (e.key === 'Enter' && this.contextMenuEl) {
                e.preventDefault();

                
                const selectedItem = this.contextMenuEl.querySelector('.context-file-menu-item.selected') as HTMLElement;

                if (selectedItem) {
                    const optionType = selectedItem.getAttribute('data-option-type');

                    if (optionType === 'prefix') {
                        
                        const opt = {
                            label: selectedItem.textContent || '',
                            value: selectedItem.getAttribute('data-option-value') || '',
                            action: selectedItem.getAttribute('data-option-action') || '',
                            modalType: selectedItem.getAttribute('data-modal-type') || undefined
                        };
                        this.handlePrefixSelection(opt);
                    } else if (optionType === 'file') {
                        
                        const filePath = selectedItem.getAttribute('data-file-path');
                        if (filePath) {
                            const file = this.app.vault.getAbstractFileByPath(filePath);
                            if (file instanceof TFile) {
                                this.handleFileSelection(file);
                            }
                        }
                    }
                }
                return;
            }

            if (e.key === 'Enter' && !e.shiftKey && !Platform.isMobile) {
                e.preventDefault();
                const query = this.queryInput.value;
                if (query.trim()) {
                    this.loadingSpinner.classList.add('visible');
                    this.processQuery(query).then(() => {
                        this.loadingSpinner.classList.remove('visible');
                        this.queryInput.value = '';
                        this.adjustTextareaHeight();
                    }).catch((error) => {
                        this.loadingSpinner.classList.remove('visible');
                        
                        if (error instanceof Error && error.message.startsWith('PRESERVE_INPUT:')) {
                            // Preserve input text on PRESERVE_INPUT error
                        } else {
                            
                            this.queryInput.value = '';
                            
                            throw error;
                        }
                        this.adjustTextareaHeight();
                    });
                }
            }
        });

        if (this.queryInput) {
            switch (this.mode) {
                default:
                    this.queryInput.placeholder = 'Ask anything...';
            }
        }

        this.updateFeatureTogglesVisibility();
        this.updateContextContainerVisibility(); 

        
        this.updateWallpaper();
    }

    private adjustTextareaHeight() {
        const textarea = this.queryInput;
        
        const parent = textarea.parentElement;
        if (parent) {
            parent.setCssProps({ '--response-min-height':  parent.clientHeight + 'px' });
        }

        textarea.addClass('nl-height-auto');
        textarea.setCssProps({ '--response-height':  textarea.scrollHeight + 'px' });

        
        if (parent) {
            parent.addClass('nl-min-height-');
        }
    }

    private getModelDisplayName(modelId: string): string {
        return getModelDisplayNameFromSettings(modelId, this.settings);
    }

    private getModelButtonText(): string {
        if (this.settings.autoModeEnabled) {
            return 'Auto';
        }
        return this.getModelDisplayName(this.settings.aiChatModel || this.settings.model);
    }

    private updateModelButton(buttonEl: HTMLElement) {
        
        buttonEl.empty();
        let text: string;

        if (this.settings.autoModeEnabled) {
            const iconSpan = buttonEl.createSpan({ cls: 'model-btn-icon' });
            setIcon(iconSpan, 'bot');
            text = ' Auto';
        } else {
            text = this.getModelDisplayName(this.settings.aiChatModel || this.settings.model);
        }

        const nameSpan = buttonEl.createSpan({ 
            text: text,
            cls: 'model-name-text'
        });

        // Deterministic scaling using CSS transform
        window.requestAnimationFrame(() => {
            if (!nameSpan.parentElement) return;
            
            // Fixed available width: button width (130px) minus padding and icon
            // Icon is ~14px + 4px gap. Padding is 8px each side.
            const maxAllowedWidth = 96; // 130 - 16 - 18
            const currentWidth = nameSpan.scrollWidth;

            if (currentWidth > maxAllowedWidth) {
                const ratio = maxAllowedWidth / currentWidth;
                nameSpan.setCssProps({ '--scale-transform':  `scale(${ratio})` });
                nameSpan.setCssProps({ '--name-width':  `${currentWidth}px` }); // Force span to maintain its natural width so scale works
                nameSpan.setCssProps({ '--name-margin-left':  `${(maxAllowedWidth - currentWidth) / 2}px` }); // Center the scaled text
                nameSpan.setCssProps({ '--name-margin-right':  `${(maxAllowedWidth - currentWidth) / 2}px` });
            } else {
                nameSpan.addClass('nl-transform-none');
                nameSpan.addClass('nl-width-auto');
                nameSpan.addClass('nl-margin-0');
            }
        });
    }

    private getActiveChatProvider(): Provider {
        return this.settings.aiChatProvider || this.settings.provider;
    }

    private getActiveChatModelId(): string {
        return this.settings.aiChatModel || this.settings.model;
    }

    private isOllamaGptOssModel(modelId: string): boolean {
        return modelId.toLowerCase().includes('gpt-oss');
    }

    private renderOllamaThinkingButton(container: HTMLElement): void {
        const activeProvider = this.getActiveChatProvider();
        const currentModelId = this.getActiveChatModelId();
        if (!isThinkingButtonVisible(activeProvider, currentModelId, this.settings)) return;

        const groqGptOssRegex = /^openai\/gpt-oss(-safeguard)?-(20b|120b)$/i;
        const isGroqGptOss = activeProvider === 'groq' && groqGptOssRegex.test(currentModelId);
        const isOllamaGptOss = activeProvider === 'ollama' && this.isOllamaGptOssModel(currentModelId);
        const isGptOss = isOllamaGptOss || isGroqGptOss;
        
        const isGemini25 = activeProvider === 'gemini' && currentModelId.startsWith('gemini-2.5');
        const isGemini3 = activeProvider === 'gemini' && currentModelId.startsWith('gemini-3');
        const isActive = activeProvider === 'gemini'
            ? !!this.settings.enableThinkingMode
            : (isGptOss ? !!(activeProvider === 'groq' ? this.settings.groqThinkingLevel : this.settings.ollamaGptOssThinkingLevel) : !!this.settings.ollamaThinkingEnabled);

        const brainBtn = container.createDiv({ cls: 'header-ollama-thinking-btn' });
        this.thinkingBtnEl = brainBtn;
        setIcon(brainBtn, 'brain');
        brainBtn.addClass('nl-cursor-pointer');
        brainBtn.setAttr('aria-label', `${activeProvider === 'gemini' ? 'Gemini' : activeProvider === 'groq' ? 'Groq' : 'Ollama'} thinking controls`);
        brainBtn.setAttr('tabindex', '0');
        if (isGemini25 || isGemini3 || isGptOss) {
            brainBtn.addClass('has-dropdown');
        }
        if (isActive) {
            brainBtn.addClass('has-instructions');
        }
        if (activeProvider === 'gemini' && isGemini25) {
            brainBtn.setAttr('title', `Gemini 2.5 thinking: ${this.settings.enableThinkingMode ? (this.settings.gemini25ThinkingMode || 'dynamic') : 'off'}`);
        } else if (activeProvider === 'gemini' && isGemini3) {
            brainBtn.setAttr('title', `Gemini 3.x thinking: ${this.settings.enableThinkingMode ? (this.settings.gemini3ThinkingLevel || 'high') : 'off'}`);
        } else if (activeProvider === 'gemini') {
            brainBtn.setAttr('title', this.settings.enableThinkingMode ? 'Thinking enabled' : 'Thinking disabled');
        } else if (isGptOss) {
            const thinkingLevel = activeProvider === 'groq' ? this.settings.groqThinkingLevel : this.settings.ollamaGptOssThinkingLevel;
            brainBtn.setAttr('title', `Thinking level: ${thinkingLevel || 'medium'}`);
        } else {
            brainBtn.setAttr('title', this.settings.ollamaThinkingEnabled ? 'Thinking enabled' : 'Thinking disabled');
        }

        brainBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void this.handleOllamaThinkingControlClick(brainBtn);
        });
        }


    private async handleOllamaThinkingControlClick(buttonEl: HTMLElement): Promise<void> {
        const activeProvider = this.getActiveChatProvider();
        const modelId = this.getActiveChatModelId();
        if (activeProvider === 'gemini') {
            if (modelId.startsWith('gemini-2.5')) {
                this.showGemini25ThinkingMenu(buttonEl);
                return;
            }
            if (modelId.startsWith('gemini-3')) {
                this.showGemini3ThinkingMenu(buttonEl);
                return;
            }
            this.settings.enableThinkingMode = !this.settings.enableThinkingMode;
            await this.plugin.saveSettings();
            this.updateHeader();
            return;
        }

        const isGptOss = this.isOllamaGptOssModel(modelId);
        if ((activeProvider === 'ollama' || activeProvider === 'groq') && isGptOss) {
            this.showOllamaThinkingLevelMenu(buttonEl);
            return;
        }

        this.settings.ollamaThinkingEnabled = !this.settings.ollamaThinkingEnabled;
        await this.plugin.saveSettings();
        this.updateHeader();
    }

    private showOllamaThinkingLevelMenu(anchorEl: HTMLElement): void {
        const existingMenu = this.containerEl.querySelector('.ollama-thinking-menu');
        if (existingMenu) {
            existingMenu.remove();
            return;
        }

        const menuEl = this.containerEl.createDiv({ cls: 'ollama-thinking-menu' });
        const levels: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
        const activeProvider = this.getActiveChatProvider();
        const currentThinkingLevel = activeProvider === 'groq' ? this.settings.groqThinkingLevel : this.settings.ollamaGptOssThinkingLevel;

        levels.forEach(level => {
            const item = menuEl.createDiv({ cls: 'ollama-thinking-menu-item' });
            item.textContent = level.charAt(0).toUpperCase() + level.slice(1);
            if ((currentThinkingLevel || 'medium') === level) {
                item.addClass('selected');
            }
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                if (activeProvider === 'groq') {
                    this.settings.groqThinkingLevel = level;
                } else {
                    this.settings.ollamaGptOssThinkingLevel = level;
                }
                this.plugin.saveSettings().then(() => {
                    menuEl.remove();
                    this.updateHeader();
                }).catch(console.error);
            });
        });

        const btnRect = anchorEl.getBoundingClientRect();
        const containerRect = this.containerEl.getBoundingClientRect();
        menuEl.addClass('nl-position-absolute');
        menuEl.setCssProps({ '--menu-top':  `${btnRect.bottom - containerRect.top + 4}px` });
        menuEl.setCssProps({ '--menu-right':  `${containerRect.right - btnRect.right}px` });

        const closeHandler = (e: MouseEvent) => {
            if (!menuEl.contains(e.target as Node) &&
                !(e.target as Element).closest('.header-ollama-thinking-btn')) {
                menuEl.remove();
                this.activeDocument.removeEventListener('click', closeHandler);
            }
        };
        window.setTimeout(() => this.activeDocument.addEventListener('click', closeHandler), 0);
    }

    private showGemini25ThinkingMenu(anchorEl: HTMLElement): void {
        const existingMenu = this.containerEl.querySelector('.ollama-thinking-menu');
        if (existingMenu) {
            existingMenu.remove();
            return;
        }

        const menuEl = this.containerEl.createDiv({ cls: 'ollama-thinking-menu' });
        const options: Array<{ id: AISettings['gemini25ThinkingMode']; label: string }> = [
            { id: 'off', label: 'Off' },
            { id: 'low', label: 'Low' },
            { id: 'medium', label: 'Medium' },
            { id: 'high', label: 'High' },
            { id: 'dynamic', label: 'Dynamic' },
        ];
        const selected = this.settings.enableThinkingMode ? (this.settings.gemini25ThinkingMode || 'dynamic') : 'off';

        options.forEach(option => {
            const item = menuEl.createDiv({ cls: 'ollama-thinking-menu-item' });
            item.textContent = option.label;
            if (selected === option.id) item.addClass('selected');
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                this.settings.gemini25ThinkingMode = option.id;
                this.settings.enableThinkingMode = option.id !== 'off';
                this.plugin.saveSettings().then(() => {
                    menuEl.remove();
                    this.updateHeader();
                }).catch(console.error);
            });
        });

        const btnRect = anchorEl.getBoundingClientRect();
        const containerRect = this.containerEl.getBoundingClientRect();
        menuEl.addClass('nl-position-absolute');
        menuEl.setCssProps({ '--menu-top':  `${btnRect.bottom - containerRect.top + 4}px` });
        menuEl.setCssProps({ '--menu-right':  `${containerRect.right - btnRect.right}px` });
        const closeHandler = (e: MouseEvent) => {
            if (!menuEl.contains(e.target as Node) &&
                !(e.target as Element).closest('.header-ollama-thinking-btn')) {
                menuEl.remove();
                this.activeDocument.removeEventListener('click', closeHandler);
            }
        };
        window.setTimeout(() => this.activeDocument.addEventListener('click', closeHandler), 0);
    }

    private showGemini3ThinkingMenu(anchorEl: HTMLElement): void {
        const existingMenu = this.containerEl.querySelector('.ollama-thinking-menu');
        if (existingMenu) {
            existingMenu.remove();
            return;
        }

        const menuEl = this.containerEl.createDiv({ cls: 'ollama-thinking-menu' });
        const options: Array<{ id: 'off' | AISettings['gemini3ThinkingLevel']; label: string }> = [
            { id: 'off', label: 'Off' },
            { id: 'minimal', label: 'Minimal' },
            { id: 'low', label: 'Low' },
            { id: 'high', label: 'High' },
        ];
        const selected: 'off' | AISettings['gemini3ThinkingLevel'] =
            this.settings.enableThinkingMode ? (this.settings.gemini3ThinkingLevel || 'high') : 'off';

        options.forEach(option => {
            const item = menuEl.createDiv({ cls: 'ollama-thinking-menu-item' });
            item.textContent = option.label;
            if (selected === option.id) item.addClass('selected');
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                if (option.id === 'off') {
                    this.settings.enableThinkingMode = false;
                } else {
                    this.settings.gemini3ThinkingLevel = option.id;
                    this.settings.enableThinkingMode = true;
                }
                this.plugin.saveSettings().then(() => {
                    menuEl.remove();
                    this.updateHeader();
                }).catch(console.error);
            });
        });

        const btnRect = anchorEl.getBoundingClientRect();
        const containerRect = this.containerEl.getBoundingClientRect();
        menuEl.addClass('nl-position-absolute');
        menuEl.setCssProps({ '--menu-top':  `${btnRect.bottom - containerRect.top + 4}px` });
        menuEl.setCssProps({ '--menu-right':  `${containerRect.right - btnRect.right}px` });
        const closeHandler = (e: MouseEvent) => {
            if (!menuEl.contains(e.target as Node) &&
                !(e.target as Element).closest('.header-ollama-thinking-btn')) {
                menuEl.remove();
                this.activeDocument.removeEventListener('click', closeHandler);
            }
        };
        window.setTimeout(() => this.activeDocument.addEventListener('click', closeHandler), 0);
    }

    private setSendButtonState(button: HTMLElement, state: 'send' | 'stop') {
        button.setAttribute('data-state', state);

        if (state === 'stop') {
            
            setIcon(button, 'square');
            button.setAttr('aria-label', 'Stop processing');
            button.classList.add('stop-mode');
        } else {
            
            setIcon(button, 'arrow-up');
            button.setAttr('aria-label', 'Send message');
            button.classList.remove('stop-mode');
        }
    }

    private async showEmbeddingIndexMenu(anchorEl: HTMLElement) {
        const menu = this.containerEl.querySelector('.embedding-index-menu');
        if (menu) {
            menu.remove();
            return;
        }

        const menuEl = this.containerEl.createDiv({ cls: 'embedding-index-menu model-select-menu' });
        
        
        const rect = anchorEl.getBoundingClientRect();
        const containerRect = this.containerEl.getBoundingClientRect();
        menuEl.addClass('nl-position-absolute');
        menuEl.setCssProps({ '--menu-top':  `${rect.bottom - containerRect.top + 5}px` });
        menuEl.setCssProps({ '--menu-left':  `${rect.left - containerRect.left}px` });
        menuEl.addClass('nl-z-index-1000');
        menuEl.addClass('nl-min-width-250px');
        menuEl.addClass('nl-max-height-400px');
        menuEl.addClass('nl-overflow-y-auto');
        menuEl.addClass('nl-background-color-var--background-primary');
        menuEl.addClass('nl-border-1pxsolidvar--background-modifier-border');
        menuEl.addClass('nl-border-radius-6px');
        menuEl.addClass('nl-box-shadow-var--shadow-s');
        menuEl.addClass('nl-padding-4px');

        const indexConfigs = this.settings.indexConfigurations || [];
        const embeddingIndexes = indexConfigs.filter(config => config.type === 'embedding');

        if (embeddingIndexes.length === 0) {
            const emptyMsg = menuEl.createDiv({ cls: 'model-select-menu-item' });
            emptyMsg.createSpan({ text: 'No embedding indexes found' });
            emptyMsg.addClass('nl-cursor-default');
        } else {
            embeddingIndexes.forEach((index, idx) => {
                const itemEl = menuEl.createDiv({ cls: 'model-select-menu-item' });
                itemEl.addClass('nl-display-flex');
                itemEl.addClass('nl-flex-direction-column');
                itemEl.addClass('nl-padding-8px12px');
                itemEl.addClass('nl-gap-2px');

                if (this.settings.selectedEmbeddingIndexId === index.id) {
                    itemEl.classList.add('selected');
                }

                
                const topRow = itemEl.createDiv();
                topRow.addClass('nl-display-flex');
                topRow.addClass('nl-justify-content-space-between');
                topRow.addClass('nl-align-items-center');
                topRow.addClass('nl-width-100');

                const leftInfo = topRow.createDiv();
                leftInfo.addClass('nl-display-flex');
                leftInfo.addClass('nl-align-items-center');
                leftInfo.addClass('nl-gap-8px');

                const nameSpan = leftInfo.createSpan();
                nameSpan.textContent = index.name;
                nameSpan.addClass('nl-font-weight-var--font-semibold');

                const countSpan = leftInfo.createSpan();
                countSpan.textContent = `(${index.fileCount || 0} files)`;
                countSpan.addClass('nl-font-size-08em');
                countSpan.addClass('nl-color-var--text-muted');

                const checkbox = topRow.createEl('input', { type: 'checkbox' });
                checkbox.checked = this.settings.selectedEmbeddingIndexId === index.id;
                checkbox.addClass('nl-pointer-events-none'); 

                
                const bottomRow = itemEl.createDiv();
                const modelSpan = bottomRow.createSpan();
                modelSpan.textContent = index.model || 'Unknown model';
                modelSpan.addClass('nl-font-size-085em');
                modelSpan.addClass('nl-color-var--text-muted');

                itemEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const oldId = this.settings.selectedEmbeddingIndexId;
                    this.settings.selectedEmbeddingIndexId = index.id;
                    this.plugin.saveSettings().then(() => {
                        menuEl.remove();
                        
                        
                        if (oldId !== index.id) {
                            return this.plugin.embeddingsManager.loadIndex(index.id);
                        }
                    }).then(() => {
                        new Notice(`Selected embedding index: ${index.name}`);
                    }).catch(console.error);
                });

                
                if (idx < embeddingIndexes.length - 1) {
                    menuEl.createEl('hr', { cls: 'menu-separator' });
                }
            });
        }

        
        const closeHandler = (e: MouseEvent) => {
            if (!menuEl.contains(e.target as Node) && !anchorEl.contains(e.target as Node)) {
                menuEl.remove();
                this.activeDocument.removeEventListener('click', closeHandler);
            }
        };
        window.setTimeout(() => this.activeDocument.addEventListener('click', closeHandler), 0);
    }

    private async showModelMenu() {
        const menu = this.containerEl.querySelector('.model-select-menu');
        if (menu) {
            menu.remove();
            return;
        }

        const modelBtn = this.containerEl.querySelector('.header-model-btn') as HTMLElement;
        if (!modelBtn) return;

        const menuEl = this.containerEl.createDiv({ cls: 'model-select-menu' });

        
        const autoModeToggle = menuEl.createDiv({ cls: 'auto-mode-toggle' });
        if (this.settings.autoModeEnabled) {
            autoModeToggle.classList.add('active');
        }

        const toggleLabel = autoModeToggle.createDiv({ cls: 'toggle-label' });
        const iconSpan = toggleLabel.createSpan({ cls: 'toggle-icon' });
        setIcon(iconSpan, 'bot');
        toggleLabel.createSpan({ text: 'Auto Mode' });

        const toggleCheckbox = autoModeToggle.createEl('input', { type: 'checkbox' });
        toggleCheckbox.checked = this.settings.autoModeEnabled || false;
        toggleCheckbox.addEventListener('click', (e) => {
            e.stopPropagation(); 
        });
        toggleCheckbox.addEventListener('change', () => {
            this.settings.autoModeEnabled = toggleCheckbox.checked;
            this.plugin.saveSettings().then(() => {

                if (toggleCheckbox.checked) {
                    autoModeToggle.classList.add('active');
                    modelList.classList.add('disabled');
                    
                    if (modelBtn) this.updateModelButton(modelBtn);
                    
                    if (this.thinkingBtnEl) {
                        this.thinkingBtnEl.remove();
                        this.thinkingBtnEl = null;
                    }
                } else {
                    autoModeToggle.classList.remove('active');
                    modelList.classList.remove('disabled');
                    
                    if (modelBtn) this.updateModelButton(modelBtn);
                }

                
                menuEl.remove();
            }).catch(console.error);
        });

        
        menuEl.createEl('hr', { cls: 'menu-separator-full' });

        
        const searchContainer = menuEl.createDiv({ 
            cls: `model-search-container${this.settings.autoModeEnabled ? ' nl-display-none' : ''}`
        });
        const searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search models...',
            cls: 'model-search-input'
        });
        searchInput.addEventListener('keydown', (e) => e.stopPropagation());
        window.setTimeout(() => searchInput.focus(), 100);

        const itemsToFilter: { itemEl: HTMLElement, name: string }[] = [];
        const headersToFilter: { headerEl: HTMLElement, items: HTMLElement[], separatorEl?: HTMLElement }[] = [];

        
        const modelList = menuEl.createDiv({ cls: 'model-list' });
        if (this.settings.autoModeEnabled) {
            modelList.classList.add('disabled');
        }

        
        const modelGroups = getModelsGroupedByProvider(this.settings);

        
        modelGroups.forEach((group, groupIndex) => {
            
            const headerEl = modelList.createDiv({ cls: 'model-select-menu-header' });
            headerEl.addClass('nl-display-flex');
            headerEl.addClass('nl-justify-content-space-between');
            headerEl.addClass('nl-align-items-center');
            headerEl.addClass('nl-padding-right-8px');

            const headerTitle = headerEl.createSpan();
            headerTitle.textContent = group.label === 'Google Gemini' ? 'Gemini' : group.label;

            
            const modalitiesContainer = headerEl.createSpan({ cls: 'provider-modalities' });
            modalitiesContainer.addClass('nl-display-flex');
            modalitiesContainer.addClass('nl-gap-4px');
            modalitiesContainer.addClass('nl-align-items-center');

            const addModalityIcon = (iconName: string) => {
                const iconEl = modalitiesContainer.createSpan();
                setIcon(iconEl, iconName);
                const svg = iconEl.querySelector('svg');
                if (svg) {
                    svg.addClass('nl-opacity-07');
                }
            };

            switch (group.provider) {
                case 'gemini':
                    ['type', 'image', 'video', 'audio-lines', 'file-question'].forEach(addModalityIcon);
                    break;
                case 'groq':
                case 'ollama':
                    ['type', 'image'].forEach(addModalityIcon);
                    break;
                case 'openrouter':
                case 'opencode':
                case 'nvidia':
                    ['type'].forEach(addModalityIcon);
                    break;
            }

            const groupItems: HTMLElement[] = [];
            const headerObj = { headerEl, items: groupItems, separatorEl: undefined as HTMLElement | undefined };
            headersToFilter.push(headerObj);

            
            group.models.forEach(model => {
                const option = modelList.createDiv({ cls: 'model-select-menu-item' });
                groupItems.push(option);
                itemsToFilter.push({ itemEl: option, name: model.name.toLowerCase() });

                if ((this.settings.aiChatModel || this.settings.model) === model.id) {
                    option.classList.add('selected');
                }

                
                const textSpan = option.createSpan();
                textSpan.textContent = model.name;

                
                const lowerId = model.id.toLowerCase();
                const isGemini = model.provider === 'gemini' && (lowerId.includes('gemini-') || lowerId.includes('gemma-'));
                const isOllama = model.provider === 'ollama';
                
                const isGroqWebCapable = model.provider === 'groq' && [
                    'groq/compound',
                    'groq/compound-mini',
                    'gpt-oss-120b',
                    'gpt-oss-20b',
                    'gpt-oss-safeguard-20b'
                ].some(m => lowerId.includes(m));

                const isWebCapable = isGemini || isOllama || isGroqWebCapable;
                
                
                const iconsContainer = option.createSpan({ cls: 'model-icons-container' });
                iconsContainer.addClass('nl-display-flex');
                iconsContainer.addClass('nl-gap-4px');
                iconsContainer.addClass('nl-align-items-center');

                
                const zapSpan = iconsContainer.createSpan({ cls: 'model-zap-icon' });
                setIcon(zapSpan, 'zap');
                zapSpan.style.color = getModelZapColor(this.settings, model.provider, model.id);

                if ((isOllama || isGemini) && model.capabilities?.includes('thinking')) {
                    const iconSpan = iconsContainer.createSpan({ cls: 'model-web-icon' });
                    setIcon(iconSpan, 'brain');
                }

                
                if (isGemini || (isOllama && model.capabilities?.includes('vision')) || model.id === 'meta-llama/llama-4-scout-17b-16e-instruct') {
                    const iconSpan = iconsContainer.createSpan({ cls: 'model-web-icon' });
                    setIcon(iconSpan, 'eye');
                }

                if (isWebCapable) {
                    const iconSpan = iconsContainer.createSpan({ cls: 'model-web-icon' });
                    setIcon(iconSpan, 'globe');
                }

                option.addEventListener('click', () => {
                    
                    this.settings.aiChatModel = model.id;
                    this.settings.aiChatProvider = model.provider;
                    
                    this.settings.model = model.id;
                    this.settings.provider = model.provider;
                    if (modelBtn) modelBtn.textContent = model.name;
                    menuEl.remove();
                    this.plugin.saveSettings().then(() => {
                        
                        this.updateContextBar();
                        
                        this.updateHeader();
                    }).catch(console.error);
                });
            });

            
            if (groupIndex < modelGroups.length - 1) {
                const separator = modelList.createDiv({ cls: 'model-select-menu-separator' });
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

        const btnRect = modelBtn.getBoundingClientRect();
        const containerRect = this.containerEl.getBoundingClientRect();

        
        menuEl.addClass('nl-position-absolute');
        menuEl.setCssProps({ '--menu-top':  `${btnRect.bottom - containerRect.top + 4}px` });
        menuEl.setCssProps({ '--menu-right':  `${containerRect.right - btnRect.right}px` });

        const closeHandler = (e: MouseEvent) => {
            if (!menuEl.contains(e.target as Node) &&
                !(e.target as Element).closest('.header-model-btn')) {
                menuEl.remove();
                this.activeDocument.removeEventListener('click', closeHandler);
            }
        };
        window.setTimeout(() => this.activeDocument.addEventListener('click', closeHandler), 0);
    }

    private showAutoSelectionIndicator(selection: { modelName: string; reason: string }) {
        
        const existing = this.containerEl.querySelector('.auto-selection-indicator');
        if (existing) {
            existing.remove();
        }

        
        const indicator = this.containerEl.createDiv({ cls: 'auto-selection-indicator' });
        const autoIcon = indicator.createSpan({ cls: 'auto-icon' });
        setIcon(autoIcon, 'bot');
        indicator.createSpan({ cls: 'model-name', text: selection.modelName });
        indicator.createSpan({ cls: 'reason', text: selection.reason });

        
        const responsesContainer = this.containerEl.querySelector('.responses-container');
        if (responsesContainer && responsesContainer.firstChild) {
            responsesContainer.insertBefore(indicator, responsesContainer.firstChild);
        }

        
        window.setTimeout(() => {
            indicator.addClass('nl-opacity-0');
            window.setTimeout(() => indicator.remove(), 300);
        }, 5000);
    }

    /**
     * Performs auto mode model selection for agent, create, and edit modes
     * @param query - The user query
     * @param mode - The mode being used (@agent, @create, @edit)
     * @returns The model selection with fallback chain, or null if auto mode failed
     */
    private async performAutoModeSelection(query: string, mode: string): Promise<ModelSelection | null> {
        try {
            const tokenEstimator = new TokenEstimator();
            const modelSelector = new ModelSelector(this.settings);

            
            let hasMultimodal = this.selectedFiles.size > 0 &&
                Array.from(this.selectedFiles).some(path =>
                    /\.(jpg|jpeg|png|gif|webp|pdf)$/i.test(path)
                );

            
            let webEnabled = this.webEnabled || query.trim().startsWith('@web') || query.trim().startsWith('@webpage');

            
            if (mode === '@agent' && !webEnabled) {
                const webSearchKeywords = [
                    'search web', 'web search', 'google', 'online',
                    'internet', 'current', 'latest', 'recent', 'news',
                    'today', 'this week', 'this month', 'this year',
                    'up to date', 'up-to-date', 'real-time', 'live'
                ];
                const lowerQuery = query.toLowerCase();
                webEnabled = webSearchKeywords.some(keyword => lowerQuery.includes(keyword));
            }

            
            const youtubeRegex = /https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be)\//i;
            const isYoutubeQuery = youtubeRegex.test(query) || 
                Array.from(this.selectedFiles).some(path => youtubeRegex.test(path));

            
            const isWebpageQuery = query.trim().startsWith('@webpage') || 
                Array.from(this.selectedFiles).some(path => /^https?:\/\//.test(path) && !youtubeRegex.test(path));

            
            let vaultContext = '';
            if (this.selectedFiles.size > 0) {
                
                for (const path of Array.from(this.selectedFiles)) {
                    if (!/^https?:\/\//.test(path)) {
                        const file = this.app.vault.getAbstractFileByPath(path);
                        if (file instanceof TFile) {
                            const content = await this.app.vault.read(file);
                            vaultContext += content + '\n\n';

                            
                            if (!hasMultimodal && file.extension === 'md') {
                                if (/!\[\[|!\[.*\]\(.*\)/.test(content)) {
                                    hasMultimodal = true;
                                }
                            }
                        }
                    }
                }            }

            
            let taskType: TaskType;
            if (mode === '@agent') {
                taskType = TaskType.DEEP_REASONING; 
            } else if (mode === '@create') {
                taskType = TaskType.CODE_GENERATION; 
            } else if (mode === '@mcp') {
                taskType = TaskType.MCP_TOOL_CALLING; 
            } else if (mode === '@vault') {
                taskType = TaskType.VAULT_SEARCH; 
            } else if (mode === '@flash') {
                taskType = TaskType.FLASH_SEARCH; 
            } else if (isYoutubeQuery && this.settings.youtubeProcessingMode !== 'gemini-native') {
                taskType = TaskType.YOUTUBE_QUERY; 
            } else if (isWebpageQuery) {
                taskType = TaskType.WEBPAGE_FETCH; 
            } else if (webEnabled) {
                taskType = TaskType.WEB_SEARCH; 
            } else {
                
                taskType = TokenEstimator.classifyTask(
                    query,
                    vaultContext,
                    webEnabled,
                    isYoutubeQuery && this.settings.youtubeProcessingMode === 'gemini-native' ? true : hasMultimodal,
                    false
                );
            }

            
            
            
            
            
            if (taskType === TaskType.VAULT_SEARCH || taskType === TaskType.FLASH_SEARCH) {
                const avgDocTokens = 1000;
                const maxResults = this.settings.maxVaultSearchResults || 10;
                vaultContext += '\n' + Array(avgDocTokens * maxResults).fill('data').join(' ');
            }

            const chatHistory = this.getChatHistory();
            const estimatedTokens = tokenEstimator.estimate(
                query,
                vaultContext,
                chatHistory,
                taskType
            );

            
            const selection = modelSelector.selectModel(
                taskType,
                estimatedTokens,
                {
                    supportsWebSearch: webEnabled,
                    supportsMultimodal: hasMultimodal,
                    supportsThinking: this.settings.enableThinkingMode,
                    supportsMCPToolCalling: mode === '@mcp'
                }
            );

            
            if (webEnabled) {
                // Intentionally empty
            }

            
            this.settings.provider = selection.provider;
            this.settings.model = selection.modelId;
            await this.plugin.saveSettings();

            
            const modelBtn = this.containerEl.querySelector('.header-model-btn') as HTMLElement;
            if (modelBtn) {
                this.updateModelButton(modelBtn);
            }

            
            if (this.settings.showAutoSelectionReason) {
                this.showAutoSelectionIndicator(selection);
            }

            
            return selection;

        } catch {
                        
            return null;
        }
    }

    /**
     * Robust execution with model fallback
     * Handles both Auto Mode (pre-calculated chain) and Manual Mode (exhaustive chain)
     */
    private async executeWithFallback<T>(
        apiCall: () => Promise<T>,
        autoSelection: ModelSelection | null,
        operationName: string,
        isBackground: boolean = false
    ): Promise<T> {
        let modelsToTry: Array<{ provider: string; modelId: string; modelName: string }> = [];

        if (autoSelection) {
            
            modelsToTry = [
                { provider: autoSelection.provider, modelId: autoSelection.modelId, modelName: autoSelection.modelName },
                ...(autoSelection.fallbacks || [])
            ];
        } else {
            
            
            modelsToTry = [{ 
                provider: this.settings.provider, 
                modelId: this.settings.model, 
                modelName: this.getModelDisplayName(this.settings.model) 
            }];
        }

        let lastError: Error | null = null;
        const originalProvider = this.settings.provider;
        const originalModel = this.settings.model;

        try {
            for (let i = 0; i < modelsToTry.length; i++) {
                if (!this.isProcessing && !isBackground) throw new Error('Processing stopped by user');
                
                const model = modelsToTry[i];

                
                const knownProviders = ['gemini', 'groq', 'openrouter', 'ollama', 'nvidia', 'opencode'];
                if (!knownProviders.includes(model.provider) && !UnifiedProviderManager.getInstance().hasProvider(model.provider)) {
                                        continue;
                }

                try {
                    this.settings.provider = model.provider;
                    this.settings.model = model.modelId;

                    const result = await apiCall();

                    
                    let isBlank = false;
                    if (typeof result === 'string' && result.trim() === '') {
                        isBlank = true;
                    } else if (result && typeof result === 'object') {
                        
                        const r = result as AIResponseResult;
                        const text = r.answer ?? r.response ?? r.content ?? r.text ?? r.message;
                        if (typeof text === 'string' && text.trim() === '') {
                            isBlank = true;
                        }
                    }

                    if (isBlank) {
                        throw new Error('model returned a blank response');
                    }

                    const isActuallyError = this.isErrorResponse(result, operationName);
                    if (isActuallyError) throw new Error(`Service returned error message: ${isActuallyError}`);

                    if (i > 0 && !autoSelection && operationName.includes('Final Answer')) {
                        new Notice(`Agent used fallback model: ${model.modelName} (original failed due to limits)`);
                    }

                    return result;

                } catch (error) {
                    lastError = error as Error;
                    
                    if (i === modelsToTry.length - 1) {
                        throw new Error(`${operationName} failed: All ${modelsToTry.length} models exhausted. Last error: ${lastError.message}`);
                    }

                    await this.sleep(1000);
                    continue;
                }
            }

            throw lastError || new Error(`${operationName} failed`);
        } finally {
            
            
            this.settings.provider = originalProvider;
            this.settings.model = originalModel;
        }
    }

    /**
     * Checks if a response is actually an error message disguised as success
     * Services sometimes catch errors and return error messages instead of throwing
     */
    private isErrorResponse(result: unknown, operationName: string): string | false {
        
        const errorPatterns = [
            'encountered a temporary rate limit',
            'rate limit exceeded',
            'please try again',
            'failed to generate',
            'error occurred',
            'unable to process',
            'service unavailable',
            'temporarily unavailable',
            'quota exceeded',
            'too many requests'
        ];

        
        let textToCheck = '';

        if (typeof result === 'string') {
            textToCheck = result.toLowerCase();
        } else if (result && typeof result === 'object') {
            const r = result as Record<string, unknown>;
            const text = r.answer ?? r.response ?? r.content ?? r.text ?? r.message;
            if (typeof text === 'string') textToCheck = text.toLowerCase();
        }

        
        for (const pattern of errorPatterns) {
            if (textToCheck.includes(pattern)) {
                return textToCheck.substring(0, 100); 
            }
        }

        return false;
    }

    private showHeaderMenu(ellipsisBtn: HTMLElement) {
        const menu = this.containerEl.querySelector('.header-menu');
        if (menu) {
            menu.remove();
            return;
        }

        const menuEl = this.containerEl.createDiv({ cls: 'header-menu' });

        
        const saveOption = menuEl.createDiv({ cls: 'header-menu-item' });
        setIcon(saveOption, 'save');
        saveOption.createSpan({ text: 'Save Session as Note' });
        saveOption.addEventListener('click', () => {
            void this.saveSession();
            menuEl.remove();
        });

        
        const historyToggleOption = menuEl.createDiv({ cls: 'header-menu-item header-menu-toggle' });
        setIcon(historyToggleOption, 'history');
        historyToggleOption.createSpan({ text: 'Chat History' });
        const historyToggle = historyToggleOption.createEl('input', { type: 'checkbox' });
        historyToggle.checked = this.settings.aiChatHistoryEnabled;
        historyToggle.addEventListener('change', () => {
            this.settings.aiChatHistoryEnabled = historyToggle.checked;
            this.plugin.saveSettings().then(() => {
            
                this.updateHeader();
            }).catch(console.error);
        });

        
        const contextSliderOption = menuEl.createDiv({ cls: 'header-menu-item header-menu-slider' });
        setIcon(contextSliderOption, 'message-square');
        const contextLabel = contextSliderOption.createSpan({ 
            text: `Context: ${this.settings.chatContextSize} ${this.settings.chatContextSize === 1 ? 'exchange' : 'exchanges'}` 
        });
        const contextSlider = contextSliderOption.createEl('input', { type: 'range' });
        contextSlider.min = '0';
        contextSlider.max = '50';
        contextSlider.step = '1';
        contextSlider.value = this.settings.chatContextSize.toString();
        contextSlider.addEventListener('input', () => {
            this.settings.chatContextSize = parseInt(contextSlider.value);
            contextLabel.textContent = `Context: ${this.settings.chatContextSize} ${this.settings.chatContextSize === 1 ? 'exchange' : 'exchanges'}`;
            this.plugin.saveSettings().then(() => {
                this.updateContextBar();
            }).catch(console.error);
        });

        
        const wallpaperOption = menuEl.createDiv({ cls: 'header-menu-item' });
        const hasWallpaper = !!this.settings.chatWallpaperPath;
        setIcon(wallpaperOption, 'image');
        wallpaperOption.createSpan({ text: hasWallpaper ? 'Remove Wallpaper' : 'Add Wallpaper' });
        wallpaperOption.addEventListener('click', () => {
            menuEl.remove();
            if (hasWallpaper) {
                this.settings.chatWallpaperPath = null;
                this.plugin.saveSettings().then(() => {
                    this.updateWallpaper();
                    new Notice('Wallpaper removed');
                }).catch(console.error);
            } else {
                void this.pickWallpaperImage();
            }
        });

        const btnRect = ellipsisBtn.getBoundingClientRect();
        const containerRect = this.containerEl.getBoundingClientRect();
        menuEl.addClass('nl-position-absolute');
        menuEl.style.top = `${btnRect.bottom - containerRect.top + 4}px`;
        menuEl.style.right = `${containerRect.right - btnRect.right}px`;

        const closeHandler = (e: MouseEvent) => {
            if (!menuEl.contains(e.target as Node) &&
                !(e.target as Element).closest('.header-ellipsis-btn')) {
                menuEl.remove();
                this.activeDocument.removeEventListener('click', closeHandler);
            }
        };
        window.setTimeout(() => this.activeDocument.addEventListener('click', closeHandler), 0);
    }

    private async pickWallpaperImage() {
        const images: TFile[] = [];
        const allFiles = this.app.vault.getFiles();
        for (const file of allFiles) {
            const ext = file.extension.toLowerCase();
            if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
                images.push(file);
            }
        }

        if (images.length === 0) {
            new Notice('No image files found in vault');
            return;
        }

        const pickerEl = createDetached(this.activeDocument, 'div');
        pickerEl.className = 'wallpaper-picker';
        pickerEl.addClass('nl-position-absolute');
        pickerEl.addClass('nl-z-index-1000');
        pickerEl.addClass('nl-background-rem-7');
        pickerEl.addClass('nl-border-rem-8');
        pickerEl.addClass('nl-border-radius-8px');
        pickerEl.addClass('nl-padding-8px');
        pickerEl.addClass('nl-max-height-300px');
        pickerEl.addClass('nl-overflow-y-auto');
        pickerEl.addClass('nl-min-width-250px');
        pickerEl.classList.add('wallpaper-picker-shadow');
        pickerEl.addClass('nl-color-rem-9');

        const btnRect = this.containerEl.querySelector('.header-ellipsis-btn')?.getBoundingClientRect();
        if (btnRect) {
            pickerEl.setCssProps({ '--picker-top':  `${btnRect.bottom + 4}px` });
            pickerEl.addClass('nl-right-10px');
        }

        const titleEl = pickerEl.createDiv({ cls: 'wallpaper-picker-title' });
        titleEl.textContent = 'Select Wallpaper Image';
        titleEl.addClass('nl-font-weight-bold');
        titleEl.addClass('nl-margin-bottom-8px');
        titleEl.addClass('nl-padding-4px');
        titleEl.addClass('nl-color-rem-10');

        for (const file of images) {
            const itemEl = pickerEl.createDiv({ cls: 'wallpaper-picker-item' });
            itemEl.textContent = file.path;
            itemEl.addClass('nl-padding-6px8px');
            itemEl.addClass('nl-cursor-pointer');
            itemEl.addClass('nl-border-radius-4px');
            itemEl.addClass('nl-color-rem-11');
            itemEl.addClass('nl-background-transparent');
            itemEl.addEventListener('mouseenter', () => {
                itemEl.addClass('nl-background-rem-12');
            });
            itemEl.addEventListener('mouseleave', () => {
                itemEl.addClass('nl-background-transparent');
            });
            itemEl.addEventListener('click', () => {
                pickerEl.remove();
                void this.setWallpaper(file.path);
            });
        }

        this.activeDocument.body.appendChild(pickerEl);

        const closeHandler = (e: MouseEvent) => {
            if (!pickerEl.contains(e.target as Node)) {
                pickerEl.remove();
                this.activeDocument.removeEventListener('click', closeHandler);
            }
        };
        window.setTimeout(() => this.activeDocument.addEventListener('click', closeHandler), 0);
    }

    private async setWallpaper(filePath: string) {
        this.settings.chatWallpaperPath = filePath;
        this.settings.chatWallpaperEnabled = true;
        await this.plugin.saveSettings();
        this.updateWallpaper();
        new Notice('Wallpaper set');
    }

    private updateWallpaper() {
        const container = this.containerEl;
        if (!container) return;

        const wallpaperEnabled = this.settings.chatWallpaperEnabled ?? false;
        const wallpaperPath = this.settings.chatWallpaperPath;
        const hasWallpaperPath = !!wallpaperPath;

        
        const needsRecreation = !this.wallpaperEl || (this.wallpaperEl && this.wallpaperEl.getAttribute('data-wallpaper-path') !== wallpaperPath);
        
        
        if (this.wallpaperEl && needsRecreation) {
            this.wallpaperEl.remove();
            this.wallpaperEl = null;
        }

        
        const headerSection = container.querySelector('.chat-header-section');
        const inputContainer = container.querySelector('.chat-input-container');
        const responsesContainer = container.querySelector('.responses-container');

        
        const responseItemsList = container.querySelectorAll('.response-item');
        const queryInput = $q<HTMLTextAreaElement>(container, '.query-input-new');

        
        this.applyLiquidGlass(headerSection, inputContainer, responsesContainer, responseItemsList, queryInput, wallpaperEnabled && hasWallpaperPath);

        
        if (!wallpaperEnabled || !hasWallpaperPath) {
            return;
        }


        const wpPath = this.settings.chatWallpaperPath;
        if (!wpPath) return;

        const file = this.app.vault.getAbstractFileByPath(wpPath);
        if (!file || !(file instanceof TFile)) {
            return;
        }

        
        this.wallpaperEl = container.createDiv({ cls: 'chat-wallpaper' });
        this.wallpaperEl.setAttribute('data-wallpaper-path', wpPath);
        
        
        container.insertBefore(this.wallpaperEl, container.firstChild);
        
        this.wallpaperEl.addClass('nl-position-absolute');
        this.wallpaperEl.addClass('nl-top-0');
        this.wallpaperEl.addClass('nl-left-0');
        this.wallpaperEl.addClass('nl-width-100');
        this.wallpaperEl.addClass('nl-height-100');
        this.wallpaperEl.addClass('nl-z-index-0');
        this.wallpaperEl.addClass('nl-pointer-events-none');
        this.wallpaperEl.addClass('nl-display-block');
        this.wallpaperEl.addClass('nl-overflow-hidden');

        const wallpaperOpacity = this.settings.chatWallpaperOpacity ?? 0.5;
        this.wallpaperEl.setCssProps({ '--wallpaper-opacity':  wallpaperOpacity.toString() });
        
        
        const imgEl = this.wallpaperEl.createEl('img');
        imgEl.addClass('nl-width-100');
        imgEl.addClass('nl-height-100');
        imgEl.addClass('nl-object-fit-cover');
        imgEl.addClass('nl-pointer-events-none');
        

        const resourcePath = this.app.vault.adapter.getResourcePath(wpPath);
        imgEl.src = resourcePath;
    }

    private applyLiquidGlass(
        headerSection: Element | null,
        inputContainer: Element | null,
        responsesContainer: Element | null,
        responseItems: NodeListOf<Element>,
        queryInput: HTMLTextAreaElement | null,
        apply: boolean
    ) {
        const headerOpacity = this.settings.chatWallpaperHeaderOpacity ?? 0.2;
        const responseOpacity = this.settings.chatWallpaperResponseOpacity ?? 0.25;

        if (apply) {
            
            
            const headerGlassFactor = 1 - headerOpacity;
            const responseGlassFactor = 1 - responseOpacity;
            
            
            if (headerSection && headerGlassFactor > 0) {
                headerSection.classList.add('liquid-glass-active');
                (headerSection as HTMLElement).setCssProps({ '--header-background':  `rgba(255, 255, 255, ${Math.min(0.95, headerGlassFactor)})` });
            } else if (headerSection) {
                headerSection.classList.remove('liquid-glass-active');
                (headerSection as HTMLElement).addClass('nl-background-');
            }
            
            if (inputContainer && headerGlassFactor > 0) {
                inputContainer.classList.add('liquid-glass-active');
                (inputContainer as HTMLElement).setCssProps({ '--input-background':  `rgba(255, 255, 255, ${Math.min(0.95, headerGlassFactor)})` });
            } else if (inputContainer) {
                inputContainer.classList.remove('liquid-glass-active');
                (inputContainer as HTMLElement).addClass('nl-background-');
            }
            
            if (responsesContainer && responseGlassFactor > 0) {
                responsesContainer.classList.add('liquid-glass-active');
            }

            
            responseItems.forEach((item) => {
                if (responseGlassFactor > 0) {
                    item.classList.add('liquid-glass-active');
                    (item as HTMLElement).setCssProps({ '--item-background':  `rgba(255, 255, 255, ${Math.min(0.95, responseGlassFactor)})` });
                    (item as HTMLElement).setCssProps({ '--item-border-color':  `rgba(255, 255, 255, ${Math.min(0.5, responseGlassFactor)})` });
                } else {
                    item.classList.remove('liquid-glass-active');
                    (item as HTMLElement).addClass('nl-background-');
                    (item as HTMLElement).addClass('nl-border-color-');
                }
            });

            
            if (queryInput && headerGlassFactor > 0) {
                queryInput.classList.add('liquid-glass-active');
queryInput.setCssProps({ '--query-background':  `rgba(255, 255, 255, ${Math.min(0.95, headerGlassFactor)})` });
            }
        } else {
            
            if (headerSection) headerSection.classList.remove('liquid-glass-active');
            if (inputContainer) inputContainer.classList.remove('liquid-glass-active');
            if (responsesContainer) responsesContainer.classList.remove('liquid-glass-active');

            
            responseItems.forEach(item => {
                item.classList.remove('liquid-glass-active');
            });

            
            if (queryInput) {
                queryInput.classList.remove('liquid-glass-active');
            }
        }
    }

    private updateHeader() {
        
        const existingHeader = this.containerEl.querySelector('.chat-header-section');
        if (existingHeader) {
            existingHeader.remove();
        }

        
        const wrapper = this.containerEl.querySelector('.response-view-wrapper');
        if (!wrapper) return;

        
        const headerSection = wrapper.createDiv({ cls: 'chat-header-section' });
        wrapper.prepend(headerSection);
        this.headerSection = headerSection;

        
        const headerLeftControls = headerSection.createDiv({ cls: 'header-left-controls' });

        
        if (this.settings.aiChatHistoryEnabled) {
            const historyBtn = headerLeftControls.createDiv({ cls: 'header-history-btn' });
            setIcon(historyBtn, 'history');
            historyBtn.addClass('nl-cursor-pointer');
            historyBtn.setAttr('aria-label', 'View chat history');
            historyBtn.setAttr('tabindex', '0');
            historyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                void this.openSessionHistoryModal();
            });
        }

        
        const dbIndexBtn = headerLeftControls.createDiv({ cls: 'header-db-index-btn header-history-btn' });
        setIcon(dbIndexBtn, 'database-zap');
        dbIndexBtn.setAttr('aria-label', 'Change embedding index');
        dbIndexBtn.setAttr('tabindex', '0');
        dbIndexBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void this.showEmbeddingIndexMenu(dbIndexBtn);
        });

         
        const systemInstructionsBtn = headerLeftControls.createDiv({ cls: 'header-system-instructions-btn' });
        setIcon(systemInstructionsBtn, 'wrench');
        systemInstructionsBtn.addClass('nl-cursor-pointer');
        systemInstructionsBtn.setAttr('aria-label', 'System Instructions');
        systemInstructionsBtn.setAttr('tabindex', '0');
        
        if (this.currentSystemInstructions) {
            systemInstructionsBtn.addClass('has-instructions');
        }
        systemInstructionsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openSystemInstructionsModal();
        });

        
        const newChatBtn = headerLeftControls.createDiv({ cls: 'header-new-chat-btn' });
        setIcon(newChatBtn, 'plus');
        newChatBtn.addClass('nl-cursor-pointer');
        newChatBtn.setAttr('aria-label', 'Start new chat');
        newChatBtn.setAttr('tabindex', '0');
        newChatBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.startNewSession();
        });


        
        const headerRightControls = headerSection.createDiv({ cls: 'header-right-controls' });

        
        new ButtonComponent(headerRightControls)
            .setButtonText(this.getModelButtonText())
            .setClass('header-model-btn')
            .onClick(() => this.showModelMenu());

        this.renderOllamaThinkingButton(headerRightControls);

        
        const ellipsisBtn = headerRightControls.createDiv({ cls: 'header-ellipsis-btn' });
        setIcon(ellipsisBtn, 'more-vertical');
        ellipsisBtn.addClass('nl-cursor-pointer');
        ellipsisBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showHeaderMenu(ellipsisBtn);
        });
    }

    private renderFileCapsules(container: HTMLElement) {
        container.empty();
        const files = Array.from(this.selectedFiles);
        const maxVisible = 3;

        
        const capsuleContainer = container.parentElement;
        if (capsuleContainer && capsuleContainer.classList.contains('context-capsule-container')) {
            if (files.length > 0) {
                capsuleContainer.classList.add('has-content');
            } else {
                capsuleContainer.classList.remove('has-content');
            }
        }
        files.slice(0, maxVisible).forEach((path, idx) => {
            const tag = container.createDiv({ cls: 'capsule-file-tag' });

            
            const isYouTubeUrl = /^https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be)\//i.test(path);
            const isWebUrl = /^https?:\/\//.test(path) && !isYouTubeUrl;

            if (isYouTubeUrl) {
                
                const icon = tag.createSpan({ cls: 'capsule-icon' });
                icon.setText('▶️');
                const label = tag.createSpan({ cls: 'capsule-label' });
                label.textContent = 'YouTube';
                tag.setAttr('title', path);
            } else if (isWebUrl) {
                
                const icon = tag.createSpan({ cls: 'capsule-icon' });
                icon.setText('🌐');
                const label = tag.createSpan({ cls: 'capsule-label' });
                
                try {
                    const url = new URL(path);
                    label.textContent = url.hostname.replace('www.', '');
                } catch {
                    label.textContent = 'Web';
                }
                tag.setAttr('title', path);
            } else {
                
                const file = this.app.vault.getAbstractFileByPath(path);
                if (!file) return;

                
                if (file instanceof TFile) {
                    const icon = tag.createSpan({ cls: 'capsule-icon' });
                    setIcon(icon, this.getFileTypeIcon(file.name));
                    const label = tag.createSpan({ cls: 'capsule-label' });
                    label.textContent = file.basename;
                    tag.setAttr('title', path);
                } else {
                    
                    tag.textContent = file.name;
                    tag.setAttr('title', path);
                }
            }

            tag.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selectedFiles.delete(path);

                
                if (isYouTubeUrl) {
                    this.youtubeTranscriptCache.delete(path);
                }

                this.renderFileCapsules(container);
            });
        });
        if (files.length > maxVisible) {
            const moreTag = container.createDiv({ cls: 'capsule-file-tag capsule-more-tag' });
            moreTag.textContent = `+${files.length - maxVisible}`;
            moreTag.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openContextMenu(moreTag, true);
            });
        }
    }

    private handleInput(e: Event) {
        if (!(e instanceof InputEvent)) return;
        const input = this.queryInput;
        const curPos = input.selectionStart || 0;
        const value = input.value;
        const lastTwo = value.slice(curPos - 2, curPos);
        const lastOne = value.slice(curPos - 1, curPos);
        if (lastTwo === '[[') {
            if (e.inputType === 'insertText' && (e.data === '[' || e.data === '[')) {
                const modal = new FileModal(
                    this.app,
                    (file: TFile) => {
                        const currentValue = this.queryInput.value;
                        const updatedValue = currentValue.slice(0, curPos - 2) + `[[${file.path}]]` + currentValue.slice(curPos);
                        this.queryInput.value = updatedValue;
                        this.queryInput.setSelectionRange(curPos - 2 + `[[${file.path}]]`.length, curPos - 2 + `[[${file.path}]]`.length);
                        this.selectedFiles.add(file.path);
                        const tagsContainer = this.inputContainer.querySelector('.selected-files-container');
                        if (tagsContainer instanceof HTMLElement) {
                            this.renderFileCapsules(tagsContainer);
                        }
                    },
                    this.queryInput,
                    curPos
                );
                modal.open();
            }
        } else if (lastOne === '/') {
            if (e.inputType === 'insertText' && e.data === '/') {
                const modal = new FolderModal(
                    this.app,
                    (folder: TFolder) => {
                        const currentValue = this.queryInput.value;
                        const updatedValue = currentValue.slice(0, curPos - 1) + `${folder.path}/` + currentValue.slice(curPos);
                        this.queryInput.value = updatedValue;
                        this.queryInput.setSelectionRange(curPos - 1 + `${folder.path}/`.length, curPos - 1 + `${folder.path}/`.length);
                        const filesInFolder = this.getAllFilesInFolder(folder);
                        filesInFolder.forEach(file => this.selectedFiles.add(file.path));
                        const tagsContainer = this.inputContainer.querySelector('.selected-files-container');
                        if (tagsContainer instanceof HTMLElement) {
                            this.renderFileCapsules(tagsContainer);
                        }
                    },
                    this.queryInput,
                    curPos
                );
                modal.open();
            }
        } else if (lastTwo === '![') {
            if (e.inputType === 'insertText' && e.data === '[') {
                const modal = new ImageModal(
                    this.app,
                    (file: TFile) => {
                        const currentValue = this.queryInput.value;
                        const imageSyntax = `![${file.name}](${file.path})`;
                        const updatedValue = currentValue.slice(0, curPos - 2) + imageSyntax + currentValue.slice(curPos);
                        this.queryInput.value = updatedValue;
                        this.queryInput.setSelectionRange(curPos - 2 + imageSyntax.length, curPos - 2 + imageSyntax.length);
                        this.selectedFiles.add(file.path);
                        const tagsContainer = this.inputContainer.querySelector('.selected-files-container');
                        if (tagsContainer instanceof HTMLElement) {
                            this.renderFileCapsules(tagsContainer);
                        }
                    },
                    this.queryInput,
                    curPos
                );
                modal.open();
            }
        }
        this.adjustTextareaHeight();
    }

    private getAllFilesInFolder(folder: TFolder): TFile[] {
        let files: TFile[] = [];
        for (const child of folder.children) {
            if (child instanceof TFile && (isExtractable(child.name) || isMultimodalSupported(child.name))) {
                files.push(child);
            } else if (child instanceof TFolder) {
                files = files.concat(this.getAllFilesInFolder(child));
            }
        }
        return files;
    }

    private async sleep(ms: number) {
        return new Promise(resolve => window.setTimeout(resolve, ms));
    }

    /**
     * Calculate dynamic file limit based on query complexity.
     * Analyzes the edit prompt to determine how many files should be processed.
     */
    private calculateFileLimit(query: string): number {
        const queryLower = query.toLowerCase();

        
        const linkingKeywords = ['link', 'connect', 'relate', 'relationship', 'associate', 'bridge', 'unify'];
        const simpleKeywords = ['link', 'connect', 'relate'];
        const complexKeywords = ['comprehensive', 'all', 'every', 'complete', 'thorough', 'entire', 'system', 'architecture', 'structure'];
        const multipleKeywords = ['multiple', 'many', 'several', 'various', 'different', 'across'];

        
        const isLinkingQuery = linkingKeywords.some(k => queryLower.includes(k));

        
        const hasComplexKeywords = complexKeywords.some(k => queryLower.includes(k));
        const hasMultipleKeywords = multipleKeywords.some(k => queryLower.includes(k));

        
        const wordCount = query.split(/\s+/).length;

        let limit = 5; 

        if (isLinkingQuery && !hasComplexKeywords) {
            
            limit = 8;

            if (hasMultipleKeywords) {
                limit = 10; 
            }
        } else if (hasComplexKeywords || wordCount > 15) {
            
            limit = 3;
        } else if (wordCount < 8 && simpleKeywords.some(k => queryLower.includes(k))) {
            
            limit = 7;
        }

        
        return Math.max(3, Math.min(10, limit));
    }

    private async rateLimitedSleep() {
        await this.sleep(this.settings.rateLimitSeconds * 1000);
    }

    
    private updateProcessingUI(step: number, totalSteps: number, message: string, contentSnippet?: string) {
        if (this.currentProgressResponseEl && this.currentProgressEl) {
            let displayMessage = message;
            if (message.startsWith('Running: ') || message.startsWith('Executing ')) {
                const toolName = message.replace('Running: ', '').replace('Executing ', '');
                displayMessage = `Running: ${toolName}`;
            }
            this.updateResponseProgress(this.currentProgressResponseEl, this.currentProgressEl, displayMessage);

            if (message.startsWith('Generating response')) {
                const finalContentEl = this.currentProgressResponseEl.querySelector('.final-answer-content');
                if (finalContentEl && !this.currentStreamingAnswerText && !this.generatingIndicatorActive) {
                    finalContentEl.addClass('generating-dots');
                    finalContentEl.textContent = '';
                    this.generatingIndicatorActive = true;
                }
            }
        }
    }
    private updateProcessingMessageAndSnippet(message: string, snippet?: string) {
        if (!this.currentProgressResponseEl) return;

        const targetThinkingEl =
            this.currentThinkingEl ||
            this.currentProgressResponseEl.querySelector('.thinking-content');

        if (!targetThinkingEl) return;

        
        if (!message.toLowerCase().includes('thinking')) return;
        if (!snippet) return;

        
        const container = this.currentThinkingContainerEl
            || $c<HTMLElement>(targetThinkingEl, '.thinking-container');
        if (container && container.classList.contains('collapsed')) {
            this.setThinkingCollapsed(container, false);
        }

        
        if (this.currentThinkingLabelEl) {
            this.currentThinkingLabelEl.removeClass('is-hidden');
        } else {
            const label = this.currentProgressResponseEl.querySelector('.thinking-label');
            if (label) label.removeClass('is-hidden');
        }

        this.currentThinkingText += snippet;
        
        
        
        const now = Date.now();
        const timeDiff = now - this.lastThinkingTime;
        this.lastThinkingTime = now;

        
        if (timeDiff > 300 || !this.currentThinkingChunkEl) {
            
            if (this.currentThinkingChunkEl && this.currentThinkingChunkText.trim()) {
                const textToRender = this.currentThinkingChunkText;
                this.currentThinkingChunkEl.empty();
                void MarkdownRenderer.render(this.app, textToRender, this.currentThinkingChunkEl, '', this);
            }

            this.currentThinkingChunkEl = targetThinkingEl.createDiv({ cls: 'thinking-timeline-item' });
            this.currentThinkingChunkText = '';
        }

        this.currentThinkingChunkText += snippet;
        this.currentThinkingChunkEl.textContent = this.currentThinkingChunkText;
    }

    /**
     * Streams answer content in real-time to the response card
     * Called by basicChatService.process() for each streaming chunk
     * Handles both thinking content and answer content separately
     */
    private updateStreamingAnswer(message: string, snippet?: string) {
        if (!this.currentProgressResponseEl) return;
        if (!snippet) return;

        const messageLower = message.toLowerCase();

        
        if (messageLower.includes('thinking')) {
            
            let targetThinkingEl = this.currentThinkingEl;
            if (!targetThinkingEl) {
                targetThinkingEl = $q<HTMLElement>(this.currentProgressResponseEl, '.thinking-content');
            }

            if (targetThinkingEl) {
                
                const container = $c<HTMLElement>(targetThinkingEl, '.thinking-container')
                    || this.currentThinkingContainerEl;
                if (container && container.classList.contains('collapsed')) {
                    this.setThinkingCollapsed(container, false);
                }

                
                if (this.currentThinkingLabelEl) {
                    this.currentThinkingLabelEl.removeClass('is-hidden');
                } else {
                    const label = this.currentProgressResponseEl.querySelector('.thinking-label');
                    if (label) label.removeClass('is-hidden');
                }

                
                this.currentThinkingText += snippet;
                
                
                const now = Date.now();
                const timeDiff = now - this.lastThinkingTime;
                this.lastThinkingTime = now;

                
                if (timeDiff > 300 || !this.currentThinkingChunkEl) {
                    
                    if (this.currentThinkingChunkEl && this.currentThinkingChunkText.trim()) {
                const textToRender = this.currentThinkingChunkText;
                this.currentThinkingChunkEl.empty();
                void MarkdownRenderer.render(this.app, textToRender, this.currentThinkingChunkEl, '', this);
            }




                    this.currentThinkingChunkEl = targetThinkingEl.createDiv({ cls: 'thinking-timeline-item' });
                    this.currentThinkingChunkText = '';
                }

                this.currentThinkingChunkText += snippet;
                this.currentThinkingChunkEl.textContent = this.currentThinkingChunkText;
            }
            return;
        }

        
        
        let finalContentEl = $q<HTMLElement>(this.currentProgressResponseEl, '.final-answer-content');

        
        if (!finalContentEl) {
            const answerEl = this.currentProgressResponseEl.querySelector('.response-answer');
            if (answerEl) {
                finalContentEl = answerEl.querySelector('.final-answer-content');
            }
        }

        if (!finalContentEl) return;

        if (this.generatingIndicatorActive) {
            finalContentEl.removeClass('generating-dots');
            this.generatingIndicatorActive = false;
        }

        this.currentStreamingAnswerText += snippet;

        // Throttled markdown rendering
        const now = Date.now();
        const throttleInterval = 150;

        const renderAnswer = async () => {
            if (!finalContentEl) return;
            finalContentEl.empty();
            await MarkdownRenderer.render(this.app, this.currentStreamingAnswerText, finalContentEl, '', this);
            this.lastAnswerRenderTime = Date.now();
            this.answerRenderTimeout = null;
            
            // Scroll to bottom after render
            this.contentContainer.scrollTo({
                top: this.contentContainer.scrollHeight,
                behavior: 'smooth'
            });
        };

        if (now - this.lastAnswerRenderTime > throttleInterval) {
            if (this.answerRenderTimeout) {
                window.clearTimeout(this.answerRenderTimeout);
                this.answerRenderTimeout = null;
            }
            void renderAnswer();
        } else if (!this.answerRenderTimeout) {
            this.answerRenderTimeout = window.setTimeout(() => { renderAnswer().catch(console.error); }, throttleInterval - (now - this.lastAnswerRenderTime));
        }

        
        this.contentContainer.scrollTo({
            top: this.contentContainer.scrollHeight,
            behavior: 'smooth'
        });
    }

    private setThinkingCollapsed(container: HTMLElement, collapsed: boolean) {
        if (collapsed) container.addClass('collapsed');
        else container.removeClass('collapsed');

        const chev = container.querySelector('.thinking-chevron');
        if (chev) chev.setText(collapsed ? '▸' : '▾');
    }

    private extractGeminiAnswerTextFromResponse(response: unknown): string {
        const r = response as GeminiResponse;
        const parts = r?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) return r?.text?.() || '';
        return parts
            .filter((part: GeminiPart) => typeof part?.text === 'string' && part.text.trim().length > 0 && part?.thought !== true)
            .map((part: GeminiPart) => part.text)
            .join('');
    }

    private async performWebSearch(query: string): Promise<WebSearchResult[]> {
        try {
            return await this.webSearchService.searchWeb(query);
        } catch {
                        new Notice('Web search failed. Please check your API credentials.');
            return [];
        }
    }

    private isRecentQuery(query: string): boolean {
        const recentKeywords = [
            'recent', 'current', 'latest', 'new', 'up-to-date', 'today',
            'developments', 'trends', ' الأحدث', ' الحالي', ' آخر', ' جديد', 'تحديث', ' اليوم', 'تطورات', 'اتجاهات'
        ];

        const timeKeywords = [
            'this year', 'this month', 'this week', 'today', 'yesterday',
            'last week', 'last month', 'last year',
            'current year', 'current month', 'current week',
            'latest', 'recent', 'new', 'up-to-date'
        ];

        const lowerQuery = query.toLowerCase();

        
        if (timeKeywords.some(keyword => lowerQuery.includes(keyword))) {
            return true;
        }

        
        const now = new Date();
        const currentYear = now.getFullYear().toString();
        const currentMonth = now.toLocaleString('default', { month: 'long' }).toLowerCase();

        if (lowerQuery.includes(currentYear) || lowerQuery.includes(currentMonth)) {
            return true;
        }

        
        const relativeTimePatterns = [
            /\b(?:in|during|over|past|last)\s+(?:the\s+)?(?:few|several|couple|many)\s+(?:days|weeks|months|years)\b/i,
            /\b(?:since|from|after)\s+(?:the\s+)?(?:beginning|start|first|early)\s+(?:of\s+)?(?:this|last|previous)\s+(?:year|month|week)\b/i,
            /\b(?:this|current|present|ongoing)\s+(?:year|month|week|day)\b/i
        ];

        if (relativeTimePatterns.some(pattern => pattern.test(lowerQuery))) {
            return true;
        }

        
        return recentKeywords.some(keyword => lowerQuery.includes(keyword));
    }

    private modelSupportsVision(modelId: string): boolean {
        
        const model = this.settings.customModels.find(m => m.id === modelId);
        if (!model) {
            
            
            return modelId.toLowerCase().includes('gemini');
        }

        if (model.provider === 'gemini') return true;
        if (model.capabilities?.includes('vision') || model.capabilities?.includes('multimodal')) return true;
        
        const lowerId = model.id.toLowerCase();
        return lowerId.includes('vision') || lowerId.includes('multimodal') || lowerId === 'meta-llama/llama-4-scout-17b-16e-instruct';
    }

    public async processQuery(query: string) {
        this.isProcessing = true;
        this.currentAbortController = new AbortController();

        
        let autoSelectedModel: ModelSelection | null = null;

        if (this.settings.autoModeEnabled) {
            autoSelectedModel = await this.performAutoModeSelection(query, '@chat');
        }
        

        
        let useWebForThisQuery = false;
        if (query.trim().startsWith('@web') || this.activeSearchModes.has('@web')) {
            useWebForThisQuery = true;
            query = query.replace(/^@web\s*/, '').trim();
            if (!query) {
                new Notice('Please provide a query after @web');
                return;
            }
        }

        
        if (query.trim().startsWith('@mcp')) {
            query = query.replace(/^@mcp\s*/, '').trim();
            if (!query) {
                new Notice('Please provide a query after @mcp');
                return;
            }

            
            if (!this.settings.mcpEnabled) {
                new Notice('MCP support is disabled. Enable it in settings.');
                return;
            }

            
            const availableServers = (this.settings.mcpServers || []).filter(s => !s.disabled && (!Platform.isMobile || s.transport === 'sse'));
            if (availableServers.length === 0) {
                new Notice(Platform.isMobile ? 'No active HTTPS (SSE) MCP servers found. Add or enable HTTPS servers in settings.' : 'No MCP servers configured. Please add servers in settings.');
                return;
            }

            
            if (this.settings.autoModeEnabled) {
                autoSelectedModel = await this.performAutoModeSelection(query, '@mcp');
            }
            

            
            const mcpAutoModel = autoSelectedModel;

            
            const modal = new MCPServerSelectionModal(
                this.app,
                this.plugin.mcpService,
                availableServers,
                (selection) => {
                    
                    const enableRateLimit = mcpAutoModel === null ? this.mcpRateLimitEnabled : false;
                    this.processMCPQuery(query, selection, mcpAutoModel, enableRateLimit).catch(console.error);
                },
                this.plugin.settings.mcpAutoConnect ?? true
            );
            modal.open();
            return;
        }

        
        if (this.pendingMCPSelection) {
            const mcpSelection = this.pendingMCPSelection;

            
            if (this.settings.autoModeEnabled) {
                autoSelectedModel = await this.performAutoModeSelection(query, '@mcp');
            }
            

            
            
            
            const enableRateLimit = autoSelectedModel === null ? this.mcpRateLimitEnabled : false;
            await this.processMCPQuery(query, mcpSelection, autoSelectedModel, enableRateLimit);
            return;
        }

        
        if (query.trim().startsWith('@create')) {
            const creationPrompt = query.replace(/^@create\s*/, '').trim();
            if (!creationPrompt) {
                new Notice('Please provide a description of what files to create after @create');
                return;
            }

            
            const isCanvasRequest = /\bcanvas\b/i.test(creationPrompt);
            const isExcalidrawRequest = /\bexcalidraw\b/i.test(creationPrompt);

            
            if (this.settings.autoModeEnabled && !autoSelectedModel) {
                autoSelectedModel = await this.performAutoModeSelection(query, '@create');
            }
            

            let targetFolder: string | undefined;

            
            if (this.selectedFiles.size > 0) {
                const fileContents: string[] = [];

                for (const path of Array.from(this.selectedFiles)) {
                    if (!/^https?:\/\//.test(path)) {
                        const fileOrFolder = this.app.vault.getAbstractFileByPath(path);

                        if (fileOrFolder instanceof TFolder) {
                            if (!targetFolder) {
                                targetFolder = fileOrFolder.path;
                                new Notice(`Target folder: ${targetFolder}`);
                            }
                        } else if (fileOrFolder instanceof TFile) {
                            try {
                                const content = isExtractable(fileOrFolder.name)
                                    ? await extractTextFromFile(this.app, fileOrFolder)
                                    : await this.app.vault.read(fileOrFolder);
                                fileContents.push(`--- File: ${fileOrFolder.basename} ---\n${content}\n`);
                            } catch {
                                // File may not exist or be accessible - safe to ignore
                            }
                        }
                    }
                }

            }

            
            if (!targetFolder) {
                const folderPatterns = [
                    /(?:in|to|inside)\s+(?:the\s+)?(?:folder|directory)\s+['"]([^'"]+)['"]/i,
                    /(?:in|to|inside)\s+(?:the\s+)?(?:folder|directory)\s+([\w\s/-]+?)(?=\s+(?:create|make|with|and|\.|$))/i,
                    /(?:folder|directory):\s*['"]?([^'"\n]+)['"]?/i
                ];

                for (const pattern of folderPatterns) {
                    const match = creationPrompt.match(pattern);
                    if (match && match[1]) {
                        const folderName = match[1].trim();
                        const existingFolder = this.app.vault.getAbstractFileByPath(folderName);
                        if (existingFolder instanceof TFolder) {
                            targetFolder = existingFolder.path;
                            new Notice(`Target folder found: ${targetFolder}`);
                            break;
                        } else {
                            targetFolder = folderName;
                            break;
                        }
                    }
                }
            }

            
            const contextFiles: Array<{ path: string; content: string; basename: string }> = [];

            if (this.selectedFiles.size > 0) {
                for (const path of Array.from(this.selectedFiles)) {
                    if (!/^https?:\/\//.test(path)) {
                        const fileOrFolder = this.app.vault.getAbstractFileByPath(path);
                        if (fileOrFolder instanceof TFile) {
                            try {
                                const content = isExtractable(fileOrFolder.name)
                                    ? await extractTextFromFile(this.app, fileOrFolder)
                                    : await this.app.vault.read(fileOrFolder);
                                contextFiles.push({
                                    path: fileOrFolder.path,
                                    content: content,
                                    basename: fileOrFolder.basename
                                });
                            } catch {
                                // File may not exist or be accessible - safe to ignore
                            }
                        }
                    }
                }
            }

            const folderName = targetFolder || 'New Files';
            const actionId = this.createFileActionCapsule('create', folderName);

            
            if (isCanvasRequest) {
                const message = `I'll create a canvas file for you${targetFolder ? ` in the **${targetFolder}** folder` : ''}. Let me generate a visual layout for your content.`;
                void this.processCanvasCreate(actionId, creationPrompt, targetFolder, contextFiles, autoSelectedModel);
                this.addFileActionResponse(creationPrompt, message, [actionId]);
            } else if (isExcalidrawRequest) {
                const message = `I'll create an Excalidraw diagram for you${targetFolder ? ` in the **${targetFolder}** folder` : ''}. Processing...`;
                void this.processExcalidrawCreate(actionId, creationPrompt, targetFolder, contextFiles, autoSelectedModel);
                this.addFileActionResponse(creationPrompt, message, [actionId]);
            } else {
                const message = `I'll create files for you${targetFolder ? ` in the **${targetFolder}** folder` : ''}. Let me generate the content and structure.`;
                void this.processFileCreate(actionId, creationPrompt, targetFolder, contextFiles, autoSelectedModel);
                this.addFileActionResponse(creationPrompt, message, [actionId]);
            }
            return;
        }

        const isVaultWideSearch = query.startsWith('@vault ') || this.activeSearchModes.has('@vault');
        const isFlashSearch = query.startsWith('@flash ') || this.activeSearchModes.has('@flash');

        const vaultIndexName = (() => {
            const configs = this.settings.indexConfigurations || [];
            if (isFlashSearch) {
                const bm25 = configs.find(c => c.id === this.settings.selectedBM25IndexId && c.type === 'bm25');
                return bm25?.name ?? null;
            }
            if (isVaultWideSearch) {
                const emb = configs.find(c => c.id === this.settings.selectedEmbeddingIndexId && c.type === 'embedding');
                return emb?.name ?? null;
            }
            return null;
        })();

        let cleanQuery = query.trim();
        if (isVaultWideSearch) {
            cleanQuery = cleanQuery.replace(/^@vault\s*/i, '').trim();
        } else if (isFlashSearch) {
            cleanQuery = cleanQuery.replace(/^@flash\s*/i, '').trim();
        }

        
        if (this.settings.autoModeEnabled && (isVaultWideSearch || isFlashSearch)) {
            autoSelectedModel = await this.performAutoModeSelection(query, isFlashSearch ? '@flash' : '@vault');
        }
        

        this.isProcessing = true;
        this.setSendButtonState(this.stopKnowDeepBtn, 'stop');

        let errorOccurred = false;

        this.queryInput.placeholder = 'Ask anything...';

        try {
            let relevantVaultContent: SearchResult[] = [];
            let multimodalInputs: MultimodalInput[] = []; 
            let contextUrls: string[] = []; 

            
            if (this.selectedFiles.size > 0) {
                Array.from(this.selectedFiles).forEach(path => {
                    if (/^https?:\/\//.test(path)) {
                        contextUrls.push(path);
                    }
                });
            }

            
            const youtubeUrlMatch = query.match(/https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be)\/[^\s]+/i);
            const youtubeUrlFromCapsule = contextUrls.find(url => /^https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be)\//i.test(url));

            if (youtubeUrlMatch || youtubeUrlFromCapsule) {
                const rawYoutubeUrl = youtubeUrlMatch ? youtubeUrlMatch[0] : youtubeUrlFromCapsule!;
                const youtubeUrl = rawYoutubeUrl.replace(/[),.;:!?]+$/, '');
                const isFromCapsule = !!youtubeUrlFromCapsule;
                const promptText = youtubeUrlMatch
                    ? query.replace(rawYoutubeUrl, '').trim()
                    : query.trim();
                const finalPrompt = promptText || 'Summarize the main points of this YouTube video.';

                const ytService = new YouTubeChatService(this.settings, this.rateLimitManager);

                
                const mode = this.settings.youtubeProcessingMode || 'transcript';

                if (mode === 'gemini-native') {
                    
                    this.updateProcessingUI(0, 1, 'Processing YouTube video with Gemini...', youtubeUrl);

                    
                    const { responseEl: progressResponseEl, progressEl: progressEl } = this.addResponse(
                        query,
                        '',
                        [],
                        [],
                        { modelName: this.settings.model },
                        undefined,
                        { initialProgressText: 'Processing YouTube video with Gemini...' }
                    );
                    this.currentProgressResponseEl = progressResponseEl;
                    this.currentProgressEl = progressEl;

                    try {
                        const startTime = Date.now();
                        const ytResponse = await this.executeWithFallback(
                            async () => await ytService.process(youtubeUrl, finalPrompt, this.updateStreamingAnswer.bind(this)),
                            autoSelectedModel,
                            'YouTube Video Processing'
                        );
                        const responseTimeMs = Date.now() - startTime;

                        
                        if (isFromCapsule) {
                            this.selectedFiles.delete(youtubeUrl);
                            this.renderFileCapsules(this.inputContainer.querySelector('.context-capsule-display') as HTMLElement);
                        }

                        
                        if (progressResponseEl && progressEl) {
                            this.finalizeResponse(
                                progressResponseEl,
                                progressEl,
                                query,
                                ytResponse,
                                [],
                                [],
                                { modelName: this.settings.model, responseTimeMs }
                            );
                        }
                        this.currentProgressResponseEl = null;
                        this.currentProgressEl = null;
                    } catch (ytError: unknown) {
                        const errorMsg = ytError instanceof Error ? ytError.message : 'Failed to process YouTube video.';
                        if (progressResponseEl && progressEl) {
                            this.finalizeResponse(
                                progressResponseEl,
                                progressEl,
                                query,
                                `Error: ${errorMsg}`,
                                [],
                                [],
                                { modelName: this.settings.model }
                            );
                        }
                        this.currentProgressResponseEl = null;
                        this.currentProgressEl = null;


                        if (!this.settings.autoModeEnabled) {
                            new Notice(errorMsg);
                        }
                    }
                    this.isProcessing = false;
                    this.setSendButtonState(this.stopKnowDeepBtn, 'send');
                    this.updateProcessingUI(1, 1, 'Complete!', 'YouTube video processed.');
                    return;
                } else {
                    
                    this.updateProcessingUI(0, 1, 'Extracting YouTube transcript...', youtubeUrl);

                    
                    const shouldSaveTranscript = this.settings.saveYoutubeTranscripts ?? true;

                    if (!shouldSaveTranscript) {
                        
                        const cached = this.youtubeTranscriptCache.get(youtubeUrl);

                        if (cached) {
                            
                            
                            relevantVaultContent.push({
                                path: `YouTube: ${cached.videoTitle}`,
                                content: `YouTube Video: ${cached.videoTitle}\nSource: ${youtubeUrl}\n\nTranscript:\n${cached.transcript}`,
                                similarity: 1.0
                            });

                            
                            

                            
                            query = finalPrompt;

                            
                            
                        } else {
                            
                            try {
                                const [transcript, videoTitle] = await Promise.all([
                                    ytService.getTranscriptOnly(youtubeUrl),
                                    ytService.getVideoTitle(youtubeUrl)
                                ]);

                                
                                this.youtubeTranscriptCache.set(youtubeUrl, { transcript, videoTitle });

                                
                                relevantVaultContent.push({
                                    path: `YouTube: ${videoTitle}`,
                                    content: `YouTube Video: ${videoTitle}\nSource: ${youtubeUrl}\n\nTranscript:\n${transcript}`,
                                    similarity: 1.0
                                });

                                
                                

                                
                                query = finalPrompt;
                            } catch (transcriptError: unknown) {
                                const errorMsg = transcriptError instanceof Error ? transcriptError.message : 'Failed to extract YouTube transcript.';
                                if (!this.settings.autoModeEnabled) {
                                    new Notice(errorMsg);
                                }
                                this.addResponse(query, `Error: ${errorMsg}`, [], [], { modelName: this.settings.model });
                                this.isProcessing = false;
                                this.setSendButtonState(this.stopKnowDeepBtn, 'send');
                                this.updateProcessingUI(1, 1, 'Failed', 'Transcript extraction failed.');
                                return;
                            }
                        }
                    } else {

                        try {

                            const [transcript, videoTitle] = await Promise.all([
                                ytService.getTranscriptOnly(youtubeUrl),
                                ytService.getVideoTitle(youtubeUrl)
                            ]);

                            const defaultFolder = this.settings.youtubeTranscriptFolder || 'YouTube Transcripts';


                            const savePromise = new Promise<{ fileName: string; folderPath: string } | null>((resolve) => {
                                const modal = new YouTubeTranscriptModal(
                                    this.app,
                                    defaultFolder,
                                    videoTitle,
                                    (fileName: string, folderPath: string) => {
                                        resolve({ fileName, folderPath });
                                    }
                                );


                                const originalOnClose = modal.onClose.bind(modal);
                                modal.onClose = function () {
                                    originalOnClose();
                                    resolve(null);
                                };

                                modal.open();
                            });

                            
                            const saveResult = await savePromise;

                            if (!saveResult) {
                                
                                new Notice('Transcript save cancelled');
                                this.isProcessing = false;
                                this.setSendButtonState(this.stopKnowDeepBtn, 'send');
                                return;
                            }

                            const { fileName, folderPath } = saveResult;

                            try {
                                
                                const normalizedFolder = folderPath === '/' ? '' : folderPath;
                                if (normalizedFolder) {
                                    const folder = this.app.vault.getAbstractFileByPath(normalizedFolder);
                                    if (!folder) {
                                        await this.app.vault.createFolder(normalizedFolder);
                                    }
                                }

                                
                                const fullPath = normalizedFolder ? normalizePath(`${normalizedFolder}/${fileName}`) : fileName;

                                
                                const transcriptContent = `# ${videoTitle}\n\n**Source:** ${youtubeUrl}\n\n---\n\n${transcript}`;

                                
                                const existingFile = this.app.vault.getAbstractFileByPath(fullPath);
                                if (existingFile instanceof TFile) {
                                    await this.app.vault.process(existingFile, () => transcriptContent);
                                    new Notice(`Updated transcript: ${fileName}`);
                                } else {                                    await this.app.vault.create(fullPath, transcriptContent);
                                    new Notice(`Saved transcript: ${fileName}`);
                                }

                                
                                if (isFromCapsule) {
                                    this.selectedFiles.delete(youtubeUrl);
                                }

                                
                                this.selectedFiles.add(fullPath);
                                this.renderFileCapsules(this.inputContainer.querySelector('.context-capsule-display') as HTMLElement);

                                
                                query = finalPrompt;

                                
                                

                            } catch (saveError: unknown) {
                                const errorMsg = saveError instanceof Error ? saveError.message : 'Failed to save transcript';
                                if (!this.settings.autoModeEnabled) {
                                    new Notice(`Failed to save transcript: ${errorMsg}`);
                                }
                                this.isProcessing = false;
                                this.setSendButtonState(this.stopKnowDeepBtn, 'send');
                                return;
                            }

                        } catch (transcriptError: unknown) {
                            const errorMsg = transcriptError instanceof Error ? transcriptError.message : 'Failed to extract YouTube transcript.';
                            if (!this.settings.autoModeEnabled) {
                                new Notice(errorMsg);
                            }
                            this.addResponse(query, `Error: ${errorMsg}`, [], [], { modelName: this.settings.model });
                            this.isProcessing = false;
                            this.setSendButtonState(this.stopKnowDeepBtn, 'send');
                            this.updateProcessingUI(1, 1, 'Failed', 'Transcript extraction failed.');
                            return;
                        }
                    }
                }
            }
            

            if (this.selectedFiles.size > 0) {
                this.updateProcessingUI(0, 1, 'Reading selected files and URLs...');
                const fileContents = await Promise.all(
                    Array.from(this.selectedFiles).map(async path => {
                        
                        if (/^https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be)\//i.test(path)) {
                            const shouldSaveTranscript = this.settings.saveYoutubeTranscripts ?? true;

                            if (!shouldSaveTranscript) {
                                
                                const cached = this.youtubeTranscriptCache.get(path);
                                if (cached) {
                                    return {
                                        path: `YouTube: ${cached.videoTitle}`,
                                        content: `YouTube Video: ${cached.videoTitle}\nSource: ${path}\n\nTranscript:\n${cached.transcript}`,
                                        similarity: 1.0
                                    };
                                }
                            }
                            
                            return null;
                        }

                        
                        if (/^https?:\/\//.test(path)) {
                            
                            return null;
                        }

                        
                        const fileOrFolder = this.app.vault.getAbstractFileByPath(path);

                        
                        if (fileOrFolder instanceof TFolder) {
                            const folderFiles: SearchResult[] = [];
                            const allFiles = fileOrFolder.children.filter((child): child is TFile => child instanceof TFile);

                            for (const file of allFiles) {
                                try {
                                    
                                    if (isMultimodalSupported(file.name)) {
                                        const multimodalData = await processFileForMultimodal(this.app, file);
                                        if (multimodalData) {
                                            multimodalInputs.push(multimodalData);

                                            
                                            if (multimodalData.type === 'fileUri') {
                                                folderFiles.push({ path: file.path, content: `Large file (${getFileIcon(file.name)} ${file.name}) - will be uploaded via File API`, similarity: 1.0 });
                                            } else {
                                                
                                                const fileType = isImageFile(file.name) ? 'Image' :
                                                    isPDFFile(file.name) ? 'PDF' :
                                                        isAudioFile(file.name) ? 'Audio' :
                                                            isVideoFile(file.name) ? 'Video' : 'File';
                                                folderFiles.push({ path: file.path, content: `${fileType}: ${file.name}`, similarity: 1.0 });
                                            }
                                        }
                                    } else if (isTextFile(file.name)) {
                                        
                                        const content = await this.app.vault.read(file);
                                        
                                        
                                        if (file.extension === 'md') {
                                            const embeddedImages = extractImagesFromMarkdown(this.app, content, file.path);
                                            for (const imgFile of embeddedImages) {
                                                const imgData = await processFileForMultimodal(this.app, imgFile);
                                                if (imgData) {
                                                    multimodalInputs.push(imgData);
                                                }
                                            }
                                        }
                                        
                                        folderFiles.push({ path: file.path, content, similarity: 1.0 });
                                    } else if (isExtractable(file.name)) {
                                        
                                        const content = await extractTextFromFile(this.app, file);
                                        folderFiles.push({ path: file.path, content, similarity: 1.0 });
                                    }
                                } catch {
                                    // File may not exist or be accessible - safe to ignore
                                }
                            }

                            return folderFiles;
                        }

                        
                        if (fileOrFolder instanceof TFile) {
                            try {
                                
                                if (isMultimodalSupported(fileOrFolder.name)) {
                                    const multimodalData = await processFileForMultimodal(this.app, fileOrFolder);
                                    if (multimodalData) {
                                        multimodalInputs.push(multimodalData);

                                        
                                        if (multimodalData.type === 'fileUri') {
                                            return { path: fileOrFolder.path, content: `Large file (${getFileIcon(fileOrFolder.name)} ${fileOrFolder.name}) - will be uploaded via File API`, similarity: 1.0 };
                                        }

                                        
                                        const fileType = isImageFile(fileOrFolder.name) ? 'Image' :
                                            isPDFFile(fileOrFolder.name) ? 'PDF' :
                                                isAudioFile(fileOrFolder.name) ? 'Audio' :
                                                    isVideoFile(fileOrFolder.name) ? 'Video' : 'File';
                                        return { path: fileOrFolder.path, content: `${fileType}: ${fileOrFolder.name}`, similarity: 1.0 };
                                    }
                                }

                                
                                if (isTextFile(fileOrFolder.name)) {
                                    const content = await this.app.vault.read(fileOrFolder);
                                    
                                    
                                    if (fileOrFolder.extension === 'md') {
                                        const embeddedImages = extractImagesFromMarkdown(this.app, content, fileOrFolder.path);
                                        for (const imgFile of embeddedImages) {
                                            const imgData = await processFileForMultimodal(this.app, imgFile);
                                            if (imgData) {
                                                multimodalInputs.push(imgData);
                                            }
                                        }
                                    }
                                    
                                    return { path: fileOrFolder.path, content, similarity: 1.0 };
                                }

                                
                                if (isExtractable(fileOrFolder.name)) {
                                    const content = await extractTextFromFile(this.app, fileOrFolder);
                                    return { path: fileOrFolder.path, content, similarity: 1.0 };
                                }

                                
                                return null;
                            } catch {
                                                                new Notice(`Could not read file: ${path}`);
                                return null;
                            }
                        }
                        return null;
                    })
                );

                
                relevantVaultContent = fileContents.flat().filter((note): note is SearchResult => note !== null);

                
                const largeFiles = multimodalInputs.filter(input => input.type === 'fileUri' && !input.uri);
                if (largeFiles.length > 0 && this.settings.provider === 'gemini') {
                    this.updateProcessingUI(0.3, 1, `Uploading ${largeFiles.length} large file(s)...`);
                    multimodalInputs = await this.geminiFileAPI.processLargeFiles(multimodalInputs);
                }

                if (relevantVaultContent.length > 0 || contextUrls.length > 0 || multimodalInputs.length > 0) {
                    const totalItems = relevantVaultContent.length + contextUrls.length + multimodalInputs.length;
                    this.updateProcessingUI(0.5, 1, `Read ${totalItems} selected items.`);

                    
                    const modelToCheck = autoSelectedModel ? autoSelectedModel.modelId : this.settings.model;
                    if (multimodalInputs.length > 0 && !this.modelSupportsVision(modelToCheck)) {
                        new Notice("Images detected in your note, but the selected model does not support vision. Images will be ignored.");
                        multimodalInputs = []; 
                    }
                } else if (this.selectedFiles.size > 0 && contextUrls.length === 0) {
                    new Notice('Could not read content from selected items.');
                }
            }

            
            let vaultContext = relevantVaultContent.length > 0
                ? relevantVaultContent.map((note, index) => `--- Source [${index + 1}]: ${note.path} ---\nContent:\n${note.content}`).join('\n\n')
                : '';

            
            if (vaultContext) {
                const contextTokens = Math.ceil(vaultContext.length / 4); 

                
                
                if (contextTokens > 100000 && !this.settings.autoModeEnabled) {
                    new Notice(`Warning: Large context (${relevantVaultContent.length} files, ~${Math.floor(contextTokens / 1000)}k tokens). Some content may be truncated by the AI model.`, 8000);
                }
            }

            
            let enhancedQuery = query;
            if (contextUrls.length > 0) {
                const provider = this.settings.provider;
                if (isGeminiOrOllama(provider)) {
                    if (provider === 'ollama') {
                        // Primary: Ollama's web fetch API. Fallback: requestUrl mechanism for failed/keyless fetches.
                        this.updateProcessingUI(0.3, 1, `Fetching ${contextUrls.length} webpage(s) with Ollama...`);

                        const ollamaPages: Array<{ url: string; title: string; content: string }> = [];

                        if (this.settings.ollamaApiKey) {
                            try {
                                const ollamaService = new OllamaService(
                                    this.settings.ollamaBaseUrl || 'http://localhost:11434',
                                    this.settings.ollamaApiKey || '',
                                    (headers) => this.rateLimitManager.updateFromHeaders('ollama', this.settings.model, headers)
                                );

                                for (const url of contextUrls) {
                                    try {
                                        const pageData = await ollamaService.webFetch(url);
                                        ollamaPages.push({
                                            url: url,
                                            title: pageData.title,
                                            content: pageData.content
                                        });
                                    } catch (fetchError) {
                                        const errorMsg = fetchError instanceof Error ? fetchError.message : 'Unknown error';
                                        console.warn(`[NexusLM] Ollama webFetch failed for ${url}: ${errorMsg}`);
                                    }
                                }
                            } catch (error) {
                                const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                                console.warn(`[NexusLM] Ollama web fetch service error: ${errorMsg}`);
                            }
                        }

                        const fetchedUrlSet = new Set(ollamaPages.map(p => p.url));
                        const failedUrls = contextUrls.filter(u => !fetchedUrlSet.has(u));

                        let webpageContext = '';
                        if (ollamaPages.length > 0) {
                            webpageContext += '\n\n--- Web Pages ---\n\n';
                            ollamaPages.forEach((page, index) => {
                                webpageContext += `--- Web Page [${index + 1}]: ${page.title} (${page.url}) ---\n`;
                                webpageContext += `${page.content.substring(0, 5000)}\n\n`;
                            });
                        }

                        let totalFetched = ollamaPages.length;
                        if (failedUrls.length > 0) {
                            this.updateProcessingUI(0.35, 1, `Fetching ${failedUrls.length} webpage(s) via fallback...`);
                            const fallback = await buildWebpageContext(this.plugin.webSearchService, failedUrls);
                            webpageContext += fallback.context;
                            totalFetched += fallback.fetched;
                        }

                        if (webpageContext.trim()) {
                            vaultContext += webpageContext;
                            this.updateProcessingUI(0.4, 1, `Fetched ${totalFetched} webpage(s). Processing...`);
                        }
                    } else {
                        // Gemini: Google Search grounding (URLs in query) is the primary mechanism when enabled.
                        const groundingEnabled = this.webEnabled || useWebForThisQuery;
                        if (groundingEnabled) {
                            enhancedQuery = query + ' ' + contextUrls.join(' ');
                            cleanQuery = cleanQuery + ' ' + contextUrls.join(' ');
                        } else {
                            // Fallback: fetch via requestUrl when grounding is not active.
                            this.updateProcessingUI(0.3, 1, `Fetching ${contextUrls.length} webpage(s)...`);
                            const result = await buildWebpageContext(this.plugin.webSearchService, contextUrls);
                            if (result.context) {
                                vaultContext += result.context;
                                this.updateProcessingUI(0.4, 1, `Fetched ${result.fetched} webpage(s). Processing...`);
                            }
                        }
                    }
                } else {
                    this.updateProcessingUI(0.3, 1, `Fetching ${contextUrls.length} webpage(s)...`);
                    const result = await buildWebpageContext(this.plugin.webSearchService, contextUrls);
                    if (result.context) {
                        vaultContext += result.context;
                        this.updateProcessingUI(0.4, 1, `Fetched ${result.fetched} webpage(s). Processing...`);
                    }
                }
            }

                if (isVaultWideSearch || isFlashSearch || this.selectedFiles.size > 0 || contextUrls.length > 0) {
                    
                    let temporalContext: { startDate: number | null, endDate: number | null, cleanQuery: string } | undefined = undefined;

                    if (isVaultWideSearch || isFlashSearch) {
                        try {
                            this.updateProcessingUI(0, 1, isFlashSearch ? 'Fast BM25 search...' : 'Searching vault...');

                            
                            const { parseTemporalQuery } = await import('../utils/temporalFilter');
                            const temporalQuery = await parseTemporalQuery(cleanQuery, new Date(), this.settings);

                            
                            const searchLimit = (temporalQuery?.hasTemporalFilter)
                                ? 1000
                                : (this.settings.maxVaultSearchResults || 10);

                            
                            const vaultSearchResponse = isFlashSearch
                                ? await this.plugin.searchVaultBM25Only(cleanQuery, searchLimit)
                                : await this.plugin.searchVault(cleanQuery, searchLimit);

                            const vaultSearchResults = vaultSearchResponse.results;
                            temporalContext = vaultSearchResponse.temporalContext;

                            const allRelevantContent = new Map<string, SearchResult>();
                            relevantVaultContent.forEach(item => allRelevantContent.set(item.path, item));
                            vaultSearchResults.forEach((item: SearchResult) => {
                                const file = this.app.vault.getAbstractFileByPath(item.path);
                                if (file instanceof TFile) {
                                    allRelevantContent.set(item.path, item);
                                }
                            });
                            relevantVaultContent = Array.from(allRelevantContent.values());


                            if (relevantVaultContent.length === 0) {
                                
                                if (!this.settings.autoModeEnabled) {
                                    new Notice('No relevant content found in vault or selected files.');
                                }

                                
                                const searchType = isFlashSearch ? 'Flash Search' : 'Vault Search';
                                const noResultsMessage = `## ${searchType} - No Results Found\n\n` +
                                    `No relevant content was found in your vault for the query: **"${cleanQuery}"**\n\n` +
                                    `**Suggestions:**\n` +
                                    `- Try using different keywords or phrases\n` +
                                    `- Check if your vault has been indexed (use Command Palette → "Rebuild Search Index")\n` +
                                    `- Try using ${isFlashSearch ? '@vault for semantic search' : '@flash for keyword-based search'} instead\n` +
                                    `- Ensure your vault contains markdown files related to this topic`;

                                this.addResponse(
                                    query,
                                    noResultsMessage,
                                    [], 
                                    [], 
                                    { modelName: this.settings.model, searchMode: isFlashSearch ? 'flash' : 'vault', vaultIndexName: vaultIndexName ?? undefined }
                                );

                                errorOccurred = true;
                                this.updateProcessingUI(1, 1, 'Search complete. No content found.');
                                return;
                            }
                            this.updateProcessingUI(1, 1, `Found ${relevantVaultContent.length} relevant items.`);
                        } catch (error: unknown) {
                            const errorMessage = error instanceof Error ? error.message : 'Unknown error during vault search';

                            
                            if (!this.settings.autoModeEnabled) {
                                new Notice(`Error: ${errorMessage}`);
                            }

                            
                            const searchType = isFlashSearch ? 'Flash Search' : 'Vault Search';
                            let userFriendlyMessage = `## ${searchType} Failed\n\n`;

                            
                            if (errorMessage.includes('API key') || errorMessage.includes('api key')) {
                                
                                const configs = this.settings.indexConfigurations || [];
                                const embConfig = configs.find(c => c.id === this.settings.selectedEmbeddingIndexId && c.type === 'embedding');
                                const modelId = embConfig?.model || this.settings.embeddingModel;
                                const provider = getProviderForEmbeddingModel(modelId, this.settings);
                                
                                const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
                                const apiKeyField = provider === 'gemini' ? 'Gemini API key' :
                                                   provider === 'groq' ? 'Groq API key' :
                                                   provider === 'openrouter' ? 'OpenRouter API key' :
                                                   provider === 'nvidia' ? 'NVIDIA API key' :
                                                   `${providerName} API key`;

                                userFriendlyMessage += `**Issue:** ${apiKeyField} is not configured.\n\n`;
                                userFriendlyMessage += `**Solution:** Please configure your ${apiKeyField} in settings:\n`;
                                userFriendlyMessage += `1. Open Settings (gear icon)\n`;
                                userFriendlyMessage += `2. Navigate to the AI Chat section\n`;
                                userFriendlyMessage += `3. Enter your ${apiKeyField}\n\n`;
                                userFriendlyMessage += `*Note: ${apiKeyField} is required for ${isFlashSearch ? 'BM25 indexing' : 'semantic search'} when using the ${providerName} embedding model.*`;
                            } else if (errorMessage.includes('embedding')) {
                                userFriendlyMessage += `**Issue:** Failed to generate embeddings for search.\n\n`;
                                userFriendlyMessage += `**Possible causes:**\n`;
                                userFriendlyMessage += `- API key may be invalid or expired\n`;
                                userFriendlyMessage += `- Network connectivity issues\n`;
                                userFriendlyMessage += `- Embedding model service temporarily unavailable\n\n`;
                                userFriendlyMessage += `**Solution:** Please check your API key and network connection, then try again.`;
                            } else if (errorMessage.includes('index')) {
                                userFriendlyMessage += `**Issue:** Search index is not available or corrupted or maybe the embedding model is unavailable at the moment.\n\n`;
                                userFriendlyMessage += `**Solution:** Try rebuilding the search index:\n`;
                                userFriendlyMessage += `1. Open Command Palette (Ctrl/Cmd + P)\n`;
                                userFriendlyMessage += `2. Search for "Rebuild Search Index"\n`;
                                userFriendlyMessage += `3. Wait for indexing to complete\n\n`;
                                userFriendlyMessage += `If you are unable to build the index then change the embedding model to the one which is available for your Gemini API or you can use @flash search instead.`;
                            } else {
                                userFriendlyMessage += `**Error:** ${errorMessage}\n\n`;
                                userFriendlyMessage += `**Solution:** Please check the console for more details and try again. If the issue persists, consider:\n`;
                                userFriendlyMessage += `- Verifying your API credentials\n`;
                                userFriendlyMessage += `- Checking your network connection\n`;
                                userFriendlyMessage += `- Rebuilding the search index`;
                            }

                            
                            this.addResponse(
                                query,
                                userFriendlyMessage,
                                [], 
                                [], 
                                { modelName: this.settings.model, searchMode: isFlashSearch ? 'flash' : 'vault', vaultIndexName: vaultIndexName ?? undefined }
                            );

                            errorOccurred = true;
                            this.updateProcessingUI(0, 1, `Search failed: ${errorMessage}`);
                            return;
                        }
                    } else if (this.selectedFiles.size > 0 && relevantVaultContent.length === 0 && contextUrls.length === 0) {
                        
                        if (!this.settings.autoModeEnabled) {
                            new Notice('No readable content found in selected files or folders.');
                        }
                        errorOccurred = true;
                        this.updateProcessingUI(1, 1, 'Reading complete. No content found.');
                        return;
                    } else if ((this.selectedFiles.size > 0 && relevantVaultContent.length > 0) || contextUrls.length > 0) {
                        const itemCount = relevantVaultContent.length + contextUrls.length;
                        this.updateProcessingUI(1, 1, `Read ${itemCount} selected items.`);
                    }


                    if (!this.isProcessing) return;

                    
                    
                    if (contextUrls.length > 0 && relevantVaultContent.length === 0) {
                        
                        this.updateProcessingUI(0, 1, 'Reading through your sources...');

                        const chatHistory = this.getChatHistory();

                        const startTime = Date.now();

                        
                        const { responseEl: progressResponseEl, progressEl: progressEl } = this.addResponse(
                            query,
                            '',
                            [],
                            [],
                            undefined,
                            undefined,
                            { initialProgressText: 'Reading through your sources...' }
                        );
                        this.currentProgressResponseEl = progressResponseEl;
                        this.currentProgressEl = progressEl;

                        
                        await this.sleep(500);

                        const basicChatResult = await this.basicChatService.process(
                            enhancedQuery,
                            cleanQuery,
                            vaultContext,
                            chatHistory,
                            this.webEnabled || useWebForThisQuery,
                            this.updateProcessingUI.bind(this),
                            false,
                            this.updateStreamingAnswer.bind(this),
                            multimodalInputs,
                            this.currentSystemInstructions, 
                            undefined,
                            undefined,
                            this.currentAbortController?.signal
                        );

                        
                        if (!this.isProcessing) {
                            this.finalizeResponse(
                                progressResponseEl,
                                progressEl!,
                                query,
                                'Processing stopped by user.',
                                [],
                                [],
                                {
 modelName: this.settings.model }
                            );
                            this.currentProgressResponseEl = null;
                            this.currentProgressEl = null;
                            return;
                        }

                        const responseTimeMs = Date.now() - startTime;

                        this.finalizeResponse(
                            progressResponseEl,
                            progressEl!,
                            query,
                            basicChatResult.answer,
                            [], 
                            basicChatResult.webResults,
                            { modelName: this.settings.model, totalTokens: basicChatResult.totalTokens, responseTimeMs }
                        );
                        this.currentProgressResponseEl = null;
                        this.currentProgressEl = null;
                    } else if (isVaultWideSearch || isFlashSearch) {
                        
                        
                        
                        const initialProgressText = isFlashSearch 
                            ? 'Fetching keywords from your query...' 
                            : 'Understanding your query...';
                        
                        
                        const { responseEl: progressResponseEl, progressEl: progressEl } = this.addResponse(
                            query,
                            '',
                            [],
                            [],
                            undefined,
                            undefined,
                            { initialProgressText }

                        );
                        this.currentProgressResponseEl = progressResponseEl;
                        this.currentProgressEl = progressEl;

                        
                        await this.sleep(500);

                        
                        const progressMessages = isFlashSearch 
                            ? [
                                'Fetching keywords from your query...',
                                'Going through your vault...',
                                'Generating comprehensive answer...'
                              ]
                            : [
                                'Understanding your query...',
                                'Going through your embeddings...',
                                'Filtering relevant info...',
                                'Generating your answer...'
                              ];
                        
                        let messageIndex = 1;
                        const progressInterval = window.setInterval(() => {
                            if (messageIndex < progressMessages.length && this.currentProgressEl) {
                                this.updateResponseProgress(this.currentProgressResponseEl!, this.currentProgressEl, progressMessages[messageIndex]);
                                messageIndex++;
                            }
                        }, 1500);

                        
                        
                        
                        let chatHistory: Record<string, unknown>[] = [];
                        if (isVaultWideSearch) {
                            const fullChatHistory = this.getChatHistory();
                            
                            chatHistory = fullChatHistory.slice(-2);
                        } else {
                            // No action needed for this case
                        }

                        const startTime = Date.now();

                        
                        const citationsEnabled = isFlashSearch ? this.flashInlineCitationsEnabled : this.vaultInlineCitationsEnabled;

                        
                        const agentResult = await this.executeWithFallback(
                            async () => await this.vaultSearchAgent.processVaultSearch(
                                cleanQuery,
                                relevantVaultContent,
                                citationsEnabled, 
                                chatHistory, 
                                multimodalInputs,
                                this.currentSystemInstructions, 
                                temporalContext, 
                                this.currentAbortController?.signal
                            ),
                            autoSelectedModel,
                            isFlashSearch ? 'Flash Search' : 'Vault Search'
                        );

                        
                        window.clearInterval(progressInterval);

                        
                        if (!this.isProcessing) {
                            this.finalizeResponse(
                                progressResponseEl,
                                progressEl!,
                                query,
                                'Processing stopped by user.',
                                [],
                                [],
                                {
 modelName: this.settings.model }
                            );
                            this.currentProgressResponseEl = null;
                            this.currentProgressEl = null;
                            return;
                        }

                        const responseTimeMs = Date.now() - startTime;

                        
                        this.finalizeResponse(
                            progressResponseEl,
                            progressEl!,
                            query,
                            agentResult.answer,
                            agentResult.sources, 
                            [],
                            { modelName: this.settings.model, totalTokens: agentResult.totalTokens, responseTimeMs, searchMode: isFlashSearch ? 'flash' : 'vault', vaultIndexName: vaultIndexName ?? undefined }
                        );
                        this.currentProgressResponseEl = null;
                        this.currentProgressEl = null;
                    } else if (this.selectedFiles.size > 0) {
                        
                        const chatHistory = this.getChatHistory();

                        const startTime = Date.now();

                        
                        const { responseEl: progressResponseEl, progressEl: progressEl } = this.addResponse(
                            query,
                            '',
                            [],
                            [],
                            undefined,
                            undefined,
                            { initialProgressText: 'Understanding attached files...' }
                        );
                        this.currentProgressResponseEl = progressResponseEl;
                        this.currentProgressEl = progressEl;

                        
                        await this.sleep(500);

                        
                        const basicChatResult = await this.executeWithFallback(
                            async () => await this.basicChatService.process(
                                enhancedQuery,
                                cleanQuery,
                                vaultContext,
                                chatHistory,
                                this.webEnabled || useWebForThisQuery,
                                this.updateProcessingUI.bind(this),
                                false,
                                this.updateStreamingAnswer.bind(this),
                                multimodalInputs,
                                this.currentSystemInstructions, 
                                undefined,
                                undefined,
                                this.currentAbortController?.signal
                            ),
                            autoSelectedModel,
                            'Basic Chat'
                        );

                        
                        if (!this.isProcessing) {
                            this.finalizeResponse(
                                progressResponseEl,
                                progressEl!,
                                query,
                                'Processing stopped by user.',
                                this.mapToSources(relevantVaultContent),
                                [],
                                { modelName: this.settings.model }
                            );
                            this.currentProgressResponseEl = null;
                            this.currentProgressEl = null;
                            return;
                        }

                        const responseTimeMs = Date.now() - startTime;

                        
                        this.finalizeResponse(
                            progressResponseEl,
                            progressEl!,
                            query,
                            basicChatResult.answer,
                            this.mapToSources(relevantVaultContent),
                            basicChatResult.webResults,
                            { modelName: this.settings.model, totalTokens: basicChatResult.totalTokens, responseTimeMs }
                        );
                        this.currentProgressResponseEl = null;
                        this.currentProgressEl = null;
                    } else {
                        
                        const isWebSearchMode = this.webEnabled || useWebForThisQuery;
                        
                        const chatHistory = this.getChatHistory();

                        const startTime = Date.now();

                        
                        const initialProgressText = isWebSearchMode
                            ? 'Searching through web...'
                            : 'Understanding your query...';

                        
                        const { responseEl: progressResponseEl, progressEl: progressEl } = this.addResponse(
                            query,
                            '',
                            [],
                            [],
                            undefined,
                            undefined,
                            { initialProgressText }

                        );
                        this.currentProgressResponseEl = progressResponseEl;
                        this.currentProgressEl = progressEl;

                        
                        await this.sleep(500);

                        
                        const progressMessages = isWebSearchMode
                            ? [
                                'Searching through web...',
                                'Gathering relevant info...',
                                'Filtering relevant websites...',
                                'Generating your answer...'
                              ]
                            : [
                                'Understanding your query...',
                                'Generating your response...'
                              ];
                        
                        let messageIndex = 1;
                        const progressInterval = window.setInterval(() => {
                            if (messageIndex < progressMessages.length && this.currentProgressEl) {
                                this.updateResponseProgress(this.currentProgressResponseEl!, this.currentProgressEl, progressMessages[messageIndex]);
                                messageIndex++;
                            }
                        }, 1500);

                        
                        const basicChatResult = await this.executeWithFallback(
                            async () => await this.basicChatService.process(
                                enhancedQuery,
                                cleanQuery,
                                vaultContext,
                                chatHistory,
                                this.webEnabled || useWebForThisQuery,
                                this.updateProcessingUI.bind(this),
                                false,
                                this.updateStreamingAnswer.bind(this),
                                multimodalInputs,
                                this.currentSystemInstructions,
                                undefined,
                                undefined,
                                this.currentAbortController?.signal
                            ),
                            autoSelectedModel,
                            'Basic Chat'
                        );

                        
                        window.clearInterval(progressInterval);

                        
                        if (!this.isProcessing) {
                            this.finalizeResponse(
                                progressResponseEl,
                                progressEl!,
                                query,
                                'Processing stopped by user.',
                                [],
                                [],
                                {
 modelName: this.settings.model }
                            );
                            this.currentProgressResponseEl = null;
                            this.currentProgressEl = null;
                            return;
                        }

                        const responseTimeMs = Date.now() - startTime;

                        this.finalizeResponse(
                            progressResponseEl,
                            progressEl!,
                            query,
                            basicChatResult.answer,
                            [],
                            basicChatResult.webResults,
                            { modelName: this.settings.model, totalTokens: basicChatResult.totalTokens, responseTimeMs }
                        );
                        this.currentProgressResponseEl = null;
                        this.currentProgressEl = null;
                    }

                } else {
                    const chatHistory = this.getChatHistory();

                    const startTime = Date.now();

                    
                    const { responseEl: progressResponseEl, progressEl: progressEl } = this.addResponse(
                        query,
                        '',
                        [],
                        [],
                        undefined,
                        undefined,
                        { initialProgressText: 'Understanding your query...' }
                    );
                    this.currentProgressResponseEl = progressResponseEl;
                    this.currentProgressEl = progressEl;

                    
                    await this.sleep(500);

                    
                    const basicChatResult = await this.executeWithFallback(
                        async () => await this.basicChatService.process(
                            enhancedQuery,
                            cleanQuery,
                            vaultContext,
                            chatHistory,
                            this.webEnabled || useWebForThisQuery,
                            this.updateProcessingUI.bind(this),
                            false,
                            this.updateStreamingAnswer.bind(this),
                            multimodalInputs,
                            this.currentSystemInstructions, 
                            undefined,
                            undefined,
                            this.currentAbortController?.signal
                        ),
                        autoSelectedModel,
                        'Basic Chat'
                    );

                    
                    if (!this.isProcessing) {
                        this.finalizeResponse(
                            progressResponseEl,
                            progressEl!,
                            query,
                            'Processing stopped by user.',
                            this.mapToSources(relevantVaultContent),
                            [],
                            { modelName: this.settings.model }
                        );
                        this.currentProgressResponseEl = null;
                        this.currentProgressEl = null;
                        return;
                    }

                    const responseTimeMs = Date.now() - startTime;

                    
                    this.finalizeResponse(
                        progressResponseEl,
                        progressEl!,
                        query,
                        basicChatResult.answer,
                        this.mapToSources(relevantVaultContent),
                        basicChatResult.webResults,
                        { modelName: this.settings.model, totalTokens: basicChatResult.totalTokens, responseTimeMs }
                    );
                    this.currentProgressResponseEl = null;
                    this.currentProgressEl = null;
                }

        } catch (error: unknown) {
            errorOccurred = true;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            
            if (!this.settings.autoModeEnabled) {
                new Notice(`Error: ${errorMessage}`);
            }

            
            if (this.currentProgressResponseEl && this.currentProgressEl) {
                this.finalizeResponse(
                    this.currentProgressResponseEl,
                    this.currentProgressEl,
                    query,
                    `Error: ${errorMessage}`,
                    [],
                    [],
                    {
 modelName: this.settings.model }
                );
                this.currentProgressResponseEl = null;
                this.currentProgressEl = null;
            } else {
                this.addResponse(query, `Error: ${errorMessage}`, [], [], { modelName: this.settings.model });
            }
        } finally {
            this.isProcessing = false;
            this.setSendButtonState(this.stopKnowDeepBtn, 'send');
            this.updateProcessingUI(100, 100, errorOccurred ? 'Error' : 'Complete');
            
            this.currentProgressResponseEl = null;
            this.currentProgressEl = null;
        }
    }

    /**
     * Post-processes rendered markdown to enable full interactive features for:
     * - Internal links (clickable and hover preview)
     * - Footnote citations (clickable to jump to definition)
     * - Footnote definitions (back arrows to return to citation)
     */
    private enableMarkdownInteractivity(container: HTMLElement) {
        
        const internalLinks = container.findAll('a.internal-link');

        internalLinks.forEach((link) => {
            const href = link.getAttr('data-href');
            if (href) {
                
                this.registerDomEvent(link, 'click', async (e: MouseEvent) => {
                    e.preventDefault();
                    const file = this.app.metadataCache.getFirstLinkpathDest(href, '');
                    if (file instanceof TFile) {
                        await this.app.workspace.getLeaf().openFile(file);
                    }
                });

                
                this.registerDomEvent(link, 'mouseover', (e: MouseEvent) => {
                    const file = this.app.metadataCache.getFirstLinkpathDest(href, '');
                    if (file instanceof TFile) {
                        this.app.workspace.trigger('hover-link', {
                            event: e,
                            source: VIEW_TYPE_NEXUS_CHAT,
                            hoverParent: container,
                            targetEl: link,
                            linktext: href,
                            sourcePath: file.path
                        });
                    }
                });
            }
        });

        
        container.findAll('a').forEach((link) => {
            const href = link.getAttr('href');
            if (href && href.startsWith('obsidian://')) {
                this.registerDomEvent(link, 'click', (event: MouseEvent) => {
                    event.preventDefault();
                    window.open(href);
                });
            }
        });

        
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

            
            this.registerDomEvent(refLink, 'click', (e: MouseEvent) => {
                e.preventDefault();
                const targetId = href.substring(1);

                
                let targetEl = container.querySelector(`#${targetId}`) as HTMLElement;
                if (!targetEl) {
                    targetEl = container.querySelector(`li[id="${targetId}"]`) as HTMLElement;
                }
                if (!targetEl && targetId.includes('user-content')) {
                    const simpleId = targetId.replace('user-content-', '');
                    targetEl = container.querySelector(`#${simpleId}`) as HTMLElement;
                }

                if (targetEl) {
                    targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

                    
                    // Highlight target footnote definition
                    targetEl.addClass('nl-background-color-var--text-accent');

                    // If it has a backref link, highlight that too
                    const backArrow = targetEl.querySelector('.footnote-backref') as HTMLElement;
                    if (backArrow) {
                        backArrow.addClass('nl-color-var--text-accent');
                        backArrow.addClass('nl-font-weight-bold');

                        window.setTimeout(() => {
                            backArrow.removeClass('nl-color-var--text-accent');
                            backArrow.removeClass('nl-font-weight-bold');
                        }, 2000);
                    }

                    window.setTimeout(() => {
                        targetEl.removeClass('nl-background-color-var--text-accent');
                    }, 2000);
                }
            });

            
            this.registerDomEvent(refLink, 'mouseenter', (e: MouseEvent) => {
                const targetId = href.substring(1);
                let targetEl = container.querySelector(`#${targetId}`) as HTMLElement;
                if (!targetEl) {
                    targetEl = container.querySelector(`li[id="${targetId}"]`) as HTMLElement;
                }
                if (!targetEl && targetId.includes('user-content')) {
                    const simpleId = targetId.replace('user-content-', '');
                    targetEl = container.querySelector(`#${simpleId}`) as HTMLElement;
                }

                if (targetEl) {
                    const tooltip = createDetached(this.activeDocument, 'div');
                    tooltip.classList.add('footnote-tooltip');
                    tooltip.addClass('footnote-tooltip-style');

                    
                    const text = targetEl.textContent?.replace(/↩/g, '').replace(/\[\^\d+\]:\s*/, '').trim() || '';
                    tooltip.textContent = text;

                    const rect = refLink.getBoundingClientRect();
                    tooltip.setCssProps({ '--tooltip-left':  rect.left + 'px' });
                    tooltip.setCssProps({ '--tooltip-top':  (rect.bottom + 5) + 'px' });

                    this.activeDocument.body.appendChild(tooltip);

                    let timeoutId: number | null = null;
                    const removeTooltip = () => {
                        if (timeoutId) {
                            window.clearTimeout(timeoutId);
                            timeoutId = null;
                        }
                        if (tooltip.parentNode) {
                            tooltip.remove();
                        }
                        refLink.removeEventListener('mouseleave', removeTooltip);
                    };

                    refLink.addEventListener('mouseleave', removeTooltip, { once: true });
                    timeoutId = window.setTimeout(removeTooltip, 2000); 
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
                    const backArrow = createDetached(this.activeDocument, 'a');
                    backArrow.classList.add('footnote-backref');
                    backArrow.textContent = ' ↩';
                    backArrow.setAttribute('aria-label', 'Back to content');
                    backArrow.addClass('nl-css-text-remaining-8');

                    this.registerDomEvent(backArrow, 'click', (e: MouseEvent) => {
                        e.preventDefault();

                        
                        let refEl = container.querySelector(`sup a[href="#${id}"]`) as HTMLElement;
                        if (!refEl) {
                            refEl = container.querySelector(`a[href="#${id}"]`) as HTMLElement;
                        }
                        if (refEl) {
                            refEl = refEl.closest('sup') || refEl;
                        }

                        if (refEl) {
                            refEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            refEl.addClass('nl-background-color-var--text-accent');
                            window.setTimeout(() => {
                                refEl.removeClass('nl-background-color-var--text-accent');
                            }, 2000);
                        }
                    });

                    itemEl.appendChild(backArrow);
                }
            });
        });
    }

    private addSourcesToResponseElement(responseEl: HTMLElement, sources: Array<{ path: string; relevance: number; url?: string; content?: string }> = []) {
        if (sources && sources.length > 0) {
            const sourcesEl = responseEl.createDiv({ cls: 'response-sources' });

            
            const sourcesHeader = sourcesEl.createDiv({ cls: 'sources-header' });
            const toggleIcon = sourcesHeader.createSpan({ cls: 'sources-toggle-icon' });
            toggleIcon.setText('▶'); 

            
            const answerEl = responseEl.querySelector('.response-answer');
            const answerText = answerEl?.textContent || '';
            const hasCitations = /\[\^\d+\]/.test(answerText);

            
            let citedSourceIndices: Set<number> = new Set();
            if (hasCitations) {
                const citationMatches = answerText.matchAll(/\[\^(\d+)\]/g);
                for (const match of citationMatches) {
                    citedSourceIndices.add(parseInt(match[1]) - 1); 
                }
            }

            
            let headerText: string;
            if (hasCitations && citedSourceIndices.size > 0) {
                headerText = `Sources cited (${citedSourceIndices.size} of ${sources.length})`;
            } else {
                headerText = `Sources provided (${sources.length})`;
            }

            sourcesHeader.createEl('h6', { text: headerText });

            
            const sourcesContent = sourcesEl.createDiv({ cls: 'sources-content' });
            sourcesContent.addClass('collapsed'); 

            
            const extractYouTubeId = (url: string): string | null => {
                const patterns = [
                    /[?&]v=([^&#]+)/,
                    /youtu\.be\/([^?#]+)/,
                    /(?:youtube\.com|youtu\.be)\/(?:live|shorts|embed|v)\/([^/?&]+)/,
                ];
                for (const pattern of patterns) {
                    const match = url.match(pattern);
                    if (match) return match[1];
                }
                return null;
            };

            
            const isYouTubeSource = (path: string): boolean => {
                return path.startsWith('YouTube:');
            };

            
            const getYouTubeUrl = async (path: string, sourceContent?: string): Promise<string | null> => {
                
                for (const [url, cached] of this.youtubeTranscriptCache.entries()) {
                    if (path === `YouTube: ${cached.videoTitle}`) {
                        return url;
                    }
                }

                
                const source = sources.find(s => s.path === path);
                if (source && source.url) {
                    return source.url;
                }

                
                
                if (sourceContent) {
                    const sourceMatch = sourceContent.match(/Source:\s*(https?:\/\/[^\s\n]+)/);
                    if (sourceMatch) {
                        return sourceMatch[1];
                    }
                }

                
                if (source && source.content) {
                    const sourceMatch = source.content.match(/Source:\s*(https?:\/\/[^\s\n]+)/);
                    if (sourceMatch) {
                        return sourceMatch[1];
                    }
                }

                return null;
            };

            if (hasCitations) {
                
                const citationsList = sourcesContent.createDiv({ cls: 'footnote-citations' });
                sources.forEach((source, idx) => {
                    const citationItem = citationsList.createDiv({ cls: 'citation-item' });
                    citationItem.setText(`[^${idx + 1}]: `);

                    if (isYouTubeSource(source.path)) {
                        
                        void getYouTubeUrl(source.path, source.content).then(url => {
                            if (url) {
                                const videoId = extractYouTubeId(url);
                                if (videoId) {
                                    const embedContainer = citationItem.createDiv({ cls: 'youtube-embed-container' });
                                    embedContainer.createEl('iframe', {
                                        cls: 'youtube-embed',
                                        attr: {
                                            src: `https://www.youtube.com/embed/${videoId}`,
                                            frameborder: '0',
                                            allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
                                            allowfullscreen: 'true'
                                        }
                                    });
                                    embedContainer.createDiv({
                                        cls: 'youtube-embed-title',
                                        text: source.path.replace('YouTube: ', '')
                                    });
                                }
                            }
                        });
                    } else {
                        const sourceLink = citationItem.createEl('a', {
                            text: `[[${source.path}]]`,
                            cls: 'internal-link'
                        });
                        sourceLink.addEventListener('click', (e) => {
                            e.preventDefault();
                            const file = this.app.vault.getAbstractFileByPath(source.path);
                            if (file instanceof TFile) {
                                this.app.workspace.getLeaf().openFile(file).catch(console.error);
                            }
                        });
                    }
                });
            } else {
                
                const sourcesList = sourcesContent.createEl('ul');
                sources.forEach(source => {
                    const sourceItem = sourcesList.createEl('li');

                    if (isYouTubeSource(source.path)) {
                        
                        getYouTubeUrl(source.path, source.content).then(url => {
                            if (url) {
                                const videoId = extractYouTubeId(url);
                                if (videoId) {
                                    const embedContainer = sourceItem.createDiv({ cls: 'youtube-embed-container' });
                                    embedContainer.createEl('iframe', {
                                        cls: 'youtube-embed',
                                        attr: {
                                            src: `https://www.youtube.com/embed/${videoId}`,
                                            frameborder: '0',
                                            allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
                                            allowfullscreen: 'true'
                                        }
                                    });
                                    embedContainer.createDiv({
                                        cls: 'youtube-embed-title',
                                        text: source.path.replace('YouTube: ', '')
                                    });
                                }
                            }
                        }).catch(console.error);
                    } else {
                        const sourceLink = sourceItem.createEl('a', {
                            text: `${source.path}`,
                            cls: 'internal-link'
                        });
                        sourceLink.addEventListener('click', (e) => {
                            e.preventDefault();
                            const file = this.app.vault.getAbstractFileByPath(source.path);
                            if (file instanceof TFile) {
                                this.app.workspace.getLeaf().openFile(file).catch(console.error);
                            }
                        });
                    }
                });
            }

            
            sourcesHeader.addEventListener('click', () => {
                const isCollapsed = sourcesContent.classList.contains('collapsed');
                if (isCollapsed) {
                    sourcesContent.removeClass('collapsed');
                } else {
                    sourcesContent.addClass('collapsed');
                }
                toggleIcon.setText(isCollapsed ? '▼' : '▶'); 
            });

            
            sourcesHeader.addClass('nl-cursor-pointer');
        }
    }

    private addMCPToolsToResponseElement(responseEl: HTMLElement, mcpTools: Array<{ server: string; tool: string }> = []) {
        if (mcpTools && mcpTools.length > 0) {
            const toolsEl = responseEl.createDiv({ cls: 'response-sources mcp-tools' });

            
            const toolsHeader = toolsEl.createDiv({ cls: 'sources-header' });
            const toggleIcon = toolsHeader.createSpan({ cls: 'sources-toggle-icon' });
            toggleIcon.setText('▶'); 

            const headerText = `Tools used (${mcpTools.length})`;
            toolsHeader.createEl('h6', { text: headerText });

            
            const toolsContent = toolsEl.createDiv({ cls: 'sources-content' });
            toolsContent.addClass('collapsed'); 

            
            const toolsByServer = new Map<string, string[]>();
            mcpTools.forEach(({ server, tool }) => {
                if (!toolsByServer.has(server)) {
                    toolsByServer.set(server, []);
                }
                toolsByServer.get(server)!.push(tool);
            });

            
            toolsByServer.forEach((tools, server) => {
                const serverSection = toolsContent.createDiv({ cls: 'mcp-server-section' });
                serverSection.createEl('strong', { text: `${server}:` });
                const toolsList = serverSection.createEl('ul');
                tools.forEach(tool => {
                    toolsList.createEl('li', { text: tool });
                });
            });

            
            toolsHeader.addEventListener('click', () => {
                const isCollapsed = toolsContent.classList.contains('collapsed');
                if (isCollapsed) {
                    toolsContent.removeClass('collapsed');
                } else {
                    toolsContent.addClass('collapsed');
                }
                toggleIcon.setText(isCollapsed ? '▼' : '▶'); 
            });

            
            toolsHeader.addClass('nl-cursor-pointer');
        }
    }

    private addWebResultsToResponseElement(responseEl: HTMLElement, webResults: WebSearchResult[] = []) {
        if (webResults && webResults.length > 0) {
            const webSourcesEl = responseEl.createDiv({ cls: 'response-sources' });

            
            const sourcesHeader = webSourcesEl.createDiv({ cls: 'sources-header' });
            const toggleIcon = sourcesHeader.createSpan({ cls: 'sources-toggle-icon' });
            toggleIcon.setText('▶'); 
            sourcesHeader.createEl('h6', { text: `Web Sources (${webResults.length})` });

            
            const sourcesContent = webSourcesEl.createDiv({ cls: 'sources-content' });
            sourcesContent.addClass('collapsed'); 

            const sourcesList = sourcesContent.createEl('ul');
            webResults.forEach(result => {
                const listItem = sourcesList.createEl('li');
                const link = listItem.createEl('a', {
                    text: result.title,
                    href: result.link,
                    cls: 'external-link'
                });
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    window.open(result.link, '_blank');
                });
            });

            
            sourcesHeader.addEventListener('click', () => {
                const isCollapsed = sourcesContent.classList.contains('collapsed');
                if (isCollapsed) {
                    sourcesContent.removeClass('collapsed');
                } else {
                    sourcesContent.addClass('collapsed');
                }
                toggleIcon.setText(isCollapsed ? '▼' : '▶');
            });

            
            sourcesHeader.addClass('nl-cursor-pointer');
        }
    }

    /**
     * Unified sources section for agent responses combining vault and web sources
     */
    private addUnifiedSourcesForAgent(
        responseEl: HTMLElement,
        vaultResults: SearchResult[] = [],
        webResults: WebSearchResult[] = []
    ) {
        const totalSources = vaultResults.length + webResults.length;
        if (totalSources === 0) return;

        const sourcesEl = responseEl.createDiv({ cls: 'response-sources' });

        
        const sourcesHeader = sourcesEl.createDiv({ cls: 'sources-header' });
        const toggleIcon = sourcesHeader.createSpan({ cls: 'sources-toggle-icon' });
        toggleIcon.setText('▶'); 
        sourcesHeader.createEl('h6', { text: `Sources Referred (${totalSources})` });

        
        const sourcesContent = sourcesEl.createDiv({ cls: 'sources-content' });
        sourcesContent.addClass('collapsed'); 

        
        const answerEl = responseEl.querySelector('.agent-final-answer-content') || responseEl.querySelector('.response-answer');
        const answerText = answerEl?.textContent || '';
        
        const hasCitations = /\[\^\d+\]/.test(answerText) || (vaultResults.length > 0 || webResults.length > 0);

        if (hasCitations) {
            
            const citationsList = sourcesContent.createDiv({ cls: 'footnote-citations' });
            let citationIndex = 1;

            
            vaultResults.forEach((result, idx) => {
                const citationItem = citationsList.createDiv({ cls: 'citation-item' });
                citationItem.setText(`[^${citationIndex}]: `);

                const sourceLink = citationItem.createEl('a', {
                    text: `[[${result.path}]]`,
                    cls: 'internal-link'
                });
                sourceLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    const file = this.app.vault.getAbstractFileByPath(result.path);
                    if (file instanceof TFile) {
                        this.app.workspace.getLeaf().openFile(file).catch(console.error);
                    }
                });
                citationIndex++;
            });

            
            webResults.forEach((result, idx) => {
                const citationItem = citationsList.createDiv({ cls: 'citation-item' });
                citationItem.setText(`[^${citationIndex}]: `);

                const sourceLink = citationItem.createEl('a', {
                    text: result.title,
                    href: result.link,
                    cls: 'external-link'
                });
                sourceLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (result.link && result.link !== '#' && !result.link.includes('#grounded-search')) {
                        window.open(result.link, '_blank');
                    }
                });
                citationIndex++;
            });
        } else {
            
            const sourcesList = sourcesContent.createEl('ul');

            
            vaultResults.forEach(result => {
                const listItem = sourcesList.createEl('li');
                const link = listItem.createEl('a', {
                    text: `📝 ${result.path}`,
                    cls: 'internal-link'
                });
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    const file = this.app.vault.getAbstractFileByPath(result.path);
                    if (file instanceof TFile) {
                        this.app.workspace.getLeaf().openFile(file).catch(console.error);
                    }
                });
            });

            
            webResults.forEach(result => {
                const listItem = sourcesList.createEl('li');
                const link = listItem.createEl('a', {
                    text: `🌐 ${result.title}`,
                    href: result.link,
                    cls: 'external-link'
                });
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (result.link && result.link !== '#' && !result.link.includes('#grounded-search')) {
                        window.open(result.link, '_blank');
                    }
                });
            });
        }

        
        sourcesHeader.addEventListener('click', () => {
            const isCollapsed = sourcesContent.classList.contains('collapsed');
            if (isCollapsed) {
                sourcesContent.removeClass('collapsed');
            } else {
                sourcesContent.addClass('collapsed');
            }
            toggleIcon.setText(isCollapsed ? '▼' : '▶');
        });

        
        sourcesHeader.addClass('nl-cursor-pointer');
    }




    private createResponseActions(responseEl: HTMLElement, question: string, answer: string) {
        const actionsContainer = responseEl.createDiv({ cls: 'response-actions' });

        
        if (this.settings.chatWallpaperEnabled && this.settings.chatWallpaperPath) {
            actionsContainer.classList.add('liquid-glass-active');
        }

        const getResponseIndex = (): number => {
            const items = this.contentContainer
                ? Array.from(this.contentContainer.querySelectorAll('.response-item'))
                : [];
            const domIndex = items.indexOf(responseEl);
            if (domIndex !== -1) return domIndex;
            return this.responses.findIndex(r => r.question === question);
        };

        const deleteBtn = actionsContainer.createDiv({ cls: 'response-action-btn delete-response' });
        deleteBtn.setAttribute('aria-label', 'Delete response');
        setIcon(deleteBtn, 'trash-2');
        deleteBtn.addEventListener('click', () => {
            const index = getResponseIndex();
            if (index !== -1) {
                this.responses.splice(index, 1);
            }
            responseEl.remove();
            new Notice('Response deleted');
            
            this.updateContextBar();
            this.updateNavRail();
            this.updateJumpButton();
            
            void this.saveCurrentSession();
        });

        const regenerateBtn = actionsContainer.createDiv({ cls: 'response-action-btn regenerate-response' });
        regenerateBtn.setAttribute('aria-label', 'Regenerate response');
        setIcon(regenerateBtn, 'refresh-cw');
        regenerateBtn.addEventListener('click', () => {
            const index = getResponseIndex();
            if (index !== -1) {
                this.responses.splice(index, 1);
            }
            responseEl.remove();
            
            this.updateContextBar();
            this.updateNavRail();
            this.updateJumpButton();

            this.loadingSpinner.classList.add('visible');
            this.processQuery(question).then(() => {
                this.loadingSpinner.classList.remove('visible');
                this.adjustTextareaHeight();
            }).catch(console.error);
            
        });

        const saveBtn = actionsContainer.createDiv({ cls: 'response-action-btn save-response' });
        saveBtn.setAttribute('aria-label', 'Save as note');
        setIcon(saveBtn, 'save');
        saveBtn.addEventListener('click', () => void this.saveResponseAsNote(question));

        const copyBtn = actionsContainer.createDiv({ cls: 'response-action-btn copy-response' });
        copyBtn.setAttribute('aria-label', 'Copy response');
        setIcon(copyBtn, 'copy');
        copyBtn.addEventListener('click', () => {
            const responseToCopy = this.responses.find(r => r.question === question);
            if (responseToCopy) {
                void navigator.clipboard.writeText(responseToCopy.answer);
                new Notice('Response copied to clipboard');
            } else {
                new Notice('Could not find response to copy.');
            }
        });

        const copyNoCitationsBtn = actionsContainer.createDiv({ cls: 'response-action-btn copy-no-citations' });
        copyNoCitationsBtn.setAttribute('aria-label', 'Copy without citations');
        setIcon(copyNoCitationsBtn, 'clipboard-minus');
        copyNoCitationsBtn.addEventListener('click', () => {
            const responseToCopy = this.responses.find(r => r.question === question);
            if (responseToCopy) {
                const cleanedText = this.removeCitations(responseToCopy.answer);
                void navigator.clipboard.writeText(cleanedText);
                new Notice('Response copied to clipboard (no citations)');
            } else {
                new Notice('Could not find response to copy.');
            }
        });

        const copyPlainTextBtn = actionsContainer.createDiv({ cls: 'response-action-btn copy-plain-text' });
        copyPlainTextBtn.setAttribute('aria-label', 'Copy plain text');
        setIcon(copyPlainTextBtn, 'file-text');
        copyPlainTextBtn.addEventListener('click', () => {
            const responseToCopy = this.responses.find(r => r.question === question);
            if (responseToCopy) {
                let cleanedText = this.removeCitations(responseToCopy.answer);
                cleanedText = this.convertToPlainTextKeepTables(cleanedText);
                void navigator.clipboard.writeText(cleanedText);
                new Notice('Response copied to clipboard (plain text)');
            } else {
                new Notice('Could not find response to copy.');
            }
        });
    }

    private async saveResponseAsNote(question: string) {
        const responseToSave = this.responses.find(r => r.question === question);
        if (!responseToSave) {
            new Notice('Could not find response to save.');
            return;
        }

        const defaultFileName = `AI-Response-${new Date().toLocaleString().replace(/[/:]/g, '-')}`;
        const defaultDirectory = this.plugin.settings.saveDirectory?.trim() || '';

        new SaveNoteModal(this.app, defaultFileName, defaultDirectory, this.plugin.settings, (fileName, directory, templatePath) => {
            void (async () => {
                try {
                    const filePath = directory ? normalizePath(`${directory}/${fileName}`) : fileName;

                    if (directory) {
                        const dirPath = this.app.vault.getAbstractFileByPath(directory);
                        if (!dirPath) {
                            try {
                                await this.app.vault.createFolder(directory);
                            } catch {
                                new Notice(`Failed to create directory: ${directory}`);
                                return;
                            }
                        }
                    }


                    const hasCitations = /\[\^\d+\]: \[\[/.test(responseToSave.answer);

                    
                    const sourcesList = !hasCitations && responseToSave.sources && responseToSave.sources.length > 0
                        ? '\n\n## Sources\n' + responseToSave.sources
                            .map(source => `- [[${source.path}]]`)
                            .join('\n')
                        : '';

                    const webSourcesList = responseToSave.webResults && responseToSave.webResults.length > 0
                        ? '\n\n## Web Sources\n' + responseToSave.webResults
                            .map(result => `- [${result.title}](${result.link})`)
                            .join('\n')
                        : '';

                    let contents = [
                        `> [!question] ${responseToSave.question}\n`,
                        responseToSave.answer,
                        sourcesList,
                        webSourcesList,
                    ].join('\n');

                    
                    if (templatePath) {
                        const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
                        if (templateFile instanceof TFile) {
                            const templateContent = await this.app.vault.read(templateFile);
                            contents = templateContent + '\n\n' + contents;
                        }
                    }

                    await this.app.vault.create(filePath, contents);
                    new Notice(`Response saved as ${filePath}`);
                } catch (error: unknown) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    new Notice(`Error saving response as note: ${errorMessage}`);
                }
            })();
        }).open();
    }

    async saveSession() {
        if (this.responses.length === 0) {
            new Notice('No responses to save');
            return;
        }

        const defaultFileName = `Chat-Session-${new Date().toLocaleString().replace(/[/:]/g, '-')}`;
        const defaultDirectory = this.plugin.settings.saveDirectory?.trim() || '';

        new SaveNoteModal(this.app, defaultFileName, defaultDirectory, this.plugin.settings, (fileName, directory, templatePath) => {
            void (async () => {
                try {
                    const filePath = directory ? normalizePath(`${directory}/${fileName}`) : fileName;

                    if (directory) {
                        const dirPath = this.app.vault.getAbstractFileByPath(directory);
                        if (!dirPath) {
                            try {
                                await this.app.vault.createFolder(directory);
                            } catch {
                                new Notice(`Failed to create directory: ${directory}`);
                                return;
                            }
                        }
                    }

                    let contents = [
                        '# AI Chat Session\n',
                        ...this.responses.map(r => {
                            const sourcesList = r.sources && r.sources.length > 0
                                ? '\nSources:\n' + r.sources.map(source => `- [[${source.path}]]`).join('\n')
                                : '';

                            const webSourcesList = r.webResults && r.webResults.length > 0
                                ? '\nWeb Sources:\n' + r.webResults.map(result => `- [${result.title}](${result.link})`).join('\n')
                                : '';

                            const mcpToolsList = r.mcpTools && r.mcpTools.length > 0
                                ? '\nTools Used:\n' + r.mcpTools.map(tool => `- ${tool.server}: ${tool.tool}`).join('\n')
                                : '';

                            return [
                                `> [!question] ${r.question}`,
                                r.answer,
                                sourcesList,
                                webSourcesList,
                                mcpToolsList,
                                ''
                            ];
                        }).flat()
                    ].join('\n');

                    
                    if (templatePath) {
                        const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
                        if (templateFile instanceof TFile) {
                            const templateContent = await this.app.vault.read(templateFile);
                            contents = templateContent + '\n\n' + contents;
                        }
                    }

                    await this.app.vault.create(filePath, contents);
                    new Notice(`Chat session saved as ${filePath}`);
                } catch (error: unknown) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    new Notice(`Error saving chat session: ${errorMessage}`);
                }
            })();
        }).open();
    }

    private updateFeatureTogglesVisibility() {
        
        
    }

    private addResponse(
        question: string,
        answer: string,
        sources: Array<{ path: string; relevance: number }> = [],
        webResults: WebSearchResult[] = [],
        metadata?: { modelName?: string; totalTokens?: number; responseTimeMs?: number; searchMode?: 'vault' | 'flash'; vaultIndexName?: string },
        mcpTools?: Array<{ server: string; tool: string }>,
        waitingState?: { initialProgressText: string }
    ): { responseEl: HTMLElement; progressEl: HTMLElement | null; newResponse: Response } {
        const newResponse: Response = {
            question,
            answer,
            context: sources.map(s => s.path),
            timestamp: new Date(),
            sources,
            webResults,
            modelName: metadata?.modelName || this.settings.model,
            totalTokens: metadata?.totalTokens,
            responseTimeMs: metadata?.responseTimeMs,
            searchMode: metadata?.searchMode,
            vaultIndexName: metadata?.vaultIndexName,
            mcpTools
        };
        this.responses.push(newResponse);
        this.updateContextBar();

        const responseEl = this.contentContainer.createDiv({ cls: 'response-item' });

        
        if (this.settings.chatWallpaperEnabled && this.settings.chatWallpaperPath) {
            responseEl.classList.add('liquid-glass-active');
        }

        const questionEl = responseEl.createDiv({ cls: 'response-question' });

        
        if (this.settings.chatWallpaperEnabled && this.settings.chatWallpaperPath) {
            questionEl.classList.add('liquid-glass-active');
        }

        const questionTextEl = questionEl.createSpan();
        questionTextEl.textContent = question;
        
        questionTextEl.classList.add('user-question-dynamic-color');

        this.createQuestionActions(questionEl, question);

        let progressEl: HTMLElement | null = null;

        if (waitingState) {
            
            this.currentStreamingAnswerText = '';
            this.currentThinkingText = '';

            
            const answerEl = responseEl.createDiv({ cls: 'response-answer' });

            
            
            const thinkingContainer = answerEl.createDiv({ cls: 'thinking-container thinking-inline' });
            const thinkingHeader = thinkingContainer.createDiv({ cls: 'thinking-header thinking-inline-header' });
            const thinkingHeaderLeft = thinkingHeader.createDiv({ cls: 'thinking-header-left' });
            thinkingHeaderLeft.createSpan({ cls: 'thinking-inline-title', text: 'Reasoning' });
            const thinkingLabel = thinkingHeaderLeft.createSpan({ cls: 'thinking-label thinking-inline-indicator is-hidden' });
            thinkingLabel.setText('Thinking');
            const thinkingDots = thinkingLabel.createSpan({ cls: 'thinking-dots' });
            thinkingDots.setText('...');

            const thinkingChevron = thinkingHeader.createDiv({ cls: 'thinking-chevron', text: '▾' });
            thinkingChevron.setAttr('aria-label', 'Collapse reasoning');
            thinkingChevron.setAttr('tabindex', '0');
            thinkingChevron.addClass('nl-cursor-pointer');
            thinkingChevron.addEventListener('click', (e) => {
                e.stopPropagation();
                const isCollapsed = thinkingContainer.classList.contains('collapsed');
                this.setThinkingCollapsed(thinkingContainer, !isCollapsed);
            });

            const thinkingContent = thinkingContainer.createDiv({ cls: 'thinking-content thinking-inline-content' });
            this.currentThinkingEl = thinkingContent;
            this.currentThinkingText = '';
            this.currentThinkingContainerEl = thinkingContainer;
            this.currentThinkingLabelEl = thinkingLabel;
            this.currentThinkingChunkEl = null;
            this.currentThinkingChunkText = '';
            this.lastThinkingTime = 0;
            
            // Reset throttled answer rendering state
            this.lastAnswerRenderTime = 0;
            if (this.answerRenderTimeout) {
                window.clearTimeout(this.answerRenderTimeout);
                this.answerRenderTimeout = null;
            }

            this.setThinkingCollapsed(thinkingContainer, true);

            
            const finalAnswerContainer = answerEl.createDiv({ cls: 'final-answer-container' });
            finalAnswerContainer.createDiv({ cls: 'final-answer-content generating-dots' });
            this.generatingIndicatorActive = true;

            
            progressEl = responseEl.createDiv({ cls: 'response-progress-text' });
            progressEl.createSpan({ cls: 'shimmer-text', text: waitingState.initialProgressText });
            progressEl.createSpan({ cls: 'dots' });
        } else {
            
            const answerEl = responseEl.createDiv({ cls: 'response-answer' });
            void MarkdownRenderer.render(this.app, answer, answerEl, '', this);

            
            this.wrapTablesInScrollContainers(answerEl);

            
            this.enableMarkdownInteractivity(answerEl);
            
            this.enhanceCodeBlocks(answerEl, question);

            if (sources && sources.length > 0) {
                this.addSourcesToResponseElement(responseEl, sources);
            }
            if (webResults && webResults.length > 0) {
                this.addWebResultsToResponseElement(responseEl, webResults);
            }
            if (mcpTools && mcpTools.length > 0) {
                this.addMCPToolsToResponseElement(responseEl, mcpTools);
            }

            
            this.addResponseMetadata(responseEl, newResponse);

            this.createResponseActions(responseEl, question, answer);
        }

        this.contentContainer.scrollTo({
            top: this.contentContainer.scrollHeight,
            behavior: 'smooth'
        });

        
        void this.saveCurrentSession();

        this.updateNavRail();
        this.updateJumpButton();

        return { responseEl, progressEl, newResponse };
    }

    /**
     * Wraps all tables in the answer element with scrollable containers
     */
    private wrapTablesInScrollContainers(answerEl: HTMLElement) {
        const tables = answerEl.querySelectorAll('table');
        tables.forEach(table => {
            
            if (table.parentElement?.classList.contains('table-wrapper')) return;

            const wrapper = createDetached(this.activeDocument, 'div');
            wrapper.className = 'table-wrapper';
            table.parentNode?.insertBefore(wrapper, table);
            wrapper.appendChild(table);
        });
    }

    private updateResponseProgress(responseEl: HTMLElement, progressEl: HTMLElement, newProgressText: string) {
        const shimmerSpan = progressEl.querySelector('.shimmer-text');
        if (shimmerSpan) {
            shimmerSpan.textContent = newProgressText;
        } else {
            progressEl.empty();
            progressEl.createSpan({ cls: 'shimmer-text', text: newProgressText });
            progressEl.createSpan({ cls: 'dots' });
        }
    }

    private finalizeResponse(
        responseEl: HTMLElement,
        progressEl: HTMLElement,
        question: string,
        answer: string,
        sources: Array<{ path: string; relevance: number }> = [],
        webResults: WebSearchResult[] = [],
        metadata?: { modelName?: string; totalTokens?: number; responseTimeMs?: number; searchMode?: 'vault' | 'flash'; vaultIndexName?: string },
        mcpTools?: Array<{ server: string; tool: string }>
    ) {
        // Clear any pending throttled render
        if (this.answerRenderTimeout) {
            window.clearTimeout(this.answerRenderTimeout);
            this.answerRenderTimeout = null;
        }

        progressEl.remove();

        
        const answerEl = responseEl.querySelector('.response-answer') || responseEl.createDiv({ cls: 'response-answer' });
        const finalContentEl =
            $q<HTMLElement>(answerEl, '.final-answer-content') ||
            answerEl.createDiv({ cls: 'final-answer-content' });

        finalContentEl.empty();
        finalContentEl.removeClass('generating-dots');
        void MarkdownRenderer.render(this.app, answer, finalContentEl, '', this);

        
        this.wrapTablesInScrollContainers(finalContentEl);

        
        this.enableMarkdownInteractivity(finalContentEl);
        
        this.enhanceCodeBlocks(finalContentEl, question);

        
        const responseIndex = this.responses.findIndex(r => r.question === question);
        if (responseIndex !== -1) {
            const existingResponse = this.responses[responseIndex];
            existingResponse.answer = answer;
            if (metadata?.totalTokens) existingResponse.totalTokens = metadata.totalTokens;
            if (metadata?.responseTimeMs) existingResponse.responseTimeMs = metadata.responseTimeMs;
            
            
            if (metadata?.modelName) existingResponse.modelName = metadata.modelName;
            
            
            if (metadata?.searchMode) existingResponse.searchMode = metadata.searchMode;
            if (metadata?.vaultIndexName !== undefined) existingResponse.vaultIndexName = metadata.vaultIndexName;

            if (sources.length > 0) existingResponse.sources = sources;
            if (webResults.length > 0) existingResponse.webResults = webResults;
            if (mcpTools && mcpTools.length > 0) existingResponse.mcpTools = mcpTools;

            
            if (sources && sources.length > 0) {
                this.addSourcesToResponseElement(responseEl, sources);
            }
            if (webResults && webResults.length > 0) {
                this.addWebResultsToResponseElement(responseEl, webResults);
            }
            if (mcpTools && mcpTools.length > 0) {
                this.addMCPToolsToResponseElement(responseEl, mcpTools);
            }

            
            this.addResponseMetadata(responseEl, existingResponse);

            this.createResponseActions(responseEl, question, answer);
        }

        
        
        const thinkingContainer = $q<HTMLElement>(responseEl, '.thinking-container');
        if (thinkingContainer) {
            
            if (this.currentThinkingChunkEl && this.currentThinkingChunkText.trim()) {
                const textToRender = this.currentThinkingChunkText;
                this.currentThinkingChunkEl.empty();
                void MarkdownRenderer.render(this.app, textToRender, this.currentThinkingChunkEl, '', this);
            }

            
            
            this.setThinkingCollapsed(thinkingContainer, true);
        }

        
        const label = (responseEl.querySelector('.thinking-label')) || this.currentThinkingLabelEl;
        if (label) label.addClass('is-hidden');

        
        this.currentThinkingEl = null;
        this.currentThinkingText = '';
        this.currentThinkingContainerEl = null;
        this.currentThinkingLabelEl = null;
        this.currentThinkingChunkEl = null;
        this.currentThinkingChunkText = '';
        this.lastThinkingTime = 0;

        
        void this.saveCurrentSession();
    }

    /**
     * Enhances code blocks in a rendered answer element with run, repair, and expand controls.
     * Called after every MarkdownRenderer.render() invocation.
     */
    /**
     * Replaces oldCode with newCode inside the stored response answer for `question`,
     * then persists the session so the fix survives reloads.
     */
    private saveCodeEdit(question: string, oldCode: string, newCode: string, lang: string) {
        if (!question) return;
        const response = this.responses.find(r => r.question === question);
        if (!response) return;

        
        const trimmedOld = oldCode.trim();
        if (!trimmedOld) return;

        
        const escapedOld = trimmedOld
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\n/g, '\\r?\\n');

        
        
        const fencePattern = new RegExp(
            '```[a-zA-Z0-9+-]*\\s*\\n\\s*' + escapedOld + '\\s*\\n```',
            's'
        );

        if (fencePattern.test(response.answer)) {
            response.answer = response.answer.replace(
                fencePattern,
                '```' + lang + '\n' + newCode + '\n```'
            );
        } else {
            
            if (response.answer.includes(oldCode)) {
                response.answer = response.answer.replace(oldCode, newCode);
            } else if (response.answer.includes(trimmedOld)) {
                response.answer = response.answer.replace(trimmedOld, newCode);
            }
        }

        
        void this.saveCurrentSession();
    }

    private enhanceCodeBlocks(answerEl: HTMLElement, question = '') {
        const preEls = answerEl.querySelectorAll('pre');
        preEls.forEach((pre) => {
            
            if (pre.parentElement?.classList.contains('code-block-wrapper')) return;

            const lang = detectLanguage(pre);
            const executable = isExecutable(lang);

            
            const wrapper = createDetached(this.activeDocument, 'div');
            wrapper.className = 'code-block-wrapper';
            pre.parentNode?.insertBefore(wrapper, pre);
            wrapper.appendChild(pre);

            const initialCode = pre.querySelector('code')?.textContent || '';
            wrapper.dataset.code = initialCode;

            
            const toolbar = createDetached(this.activeDocument, 'div');
            toolbar.className = 'code-block-toolbar';

            
            if (lang !== 'unknown') {
                const badge = createDetached(this.activeDocument, 'span');
                badge.className = 'code-lang-badge';
                badge.textContent = lang;
                toolbar.appendChild(badge);
            }

            const toolbarRight = createDetached(this.activeDocument, 'div');
            toolbarRight.className = 'code-block-toolbar-right';

            
            const copyBtn = createDetached(this.activeDocument, 'button');
            copyBtn.className = 'code-block-btn';
            copyBtn.setAttribute('aria-label', 'Copy code');
            setIcon(copyBtn, 'copy');
            copyBtn.addEventListener('click', () => {
                const code = wrapper.dataset.code || '';
                void navigator.clipboard.writeText(code);
                setIcon(copyBtn, 'check');
                window.setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
            });
            toolbarRight.appendChild(copyBtn);

            
            const expandBtn = createDetached(this.activeDocument, 'button');
            expandBtn.className = 'code-block-btn';
            expandBtn.setAttribute('aria-label', 'Expand in canvas');
            setIcon(expandBtn, 'maximize-2');
            expandBtn.addEventListener('click', () => {
                const code = wrapper.dataset.code || '';
                const modal = new CodeCanvasModal(
                    this.app,
                    code,
                    lang,
                    (newCode) => { 
                        const currentCode = wrapper.dataset.code || '';
                        wrapper.dataset.code = newCode;
                        const codeEl = wrapper.querySelector('pre code');
                        if (codeEl) codeEl.textContent = newCode;
                        this.saveCodeEdit(question, currentCode, newCode, lang);
                    },
                    (newCode) => { 
                        wrapper.dataset.code = newCode;
                        const codeEl = wrapper.querySelector('pre code');
                        if (codeEl) codeEl.textContent = newCode;
                    }
                );
                modal.onCloseCallback = () => { this.activeCanvas = null; };
                this.activeCanvas = modal;
                modal.open();
            });
            toolbarRight.appendChild(expandBtn);

            toolbar.appendChild(toolbarRight);
            wrapper.insertBefore(toolbar, pre);

            
            if (lang === 'mermaid') {
                this.watchMermaidErrors(pre, wrapper, question);
                return;
            }

            
            if (lang === 'json') {
                const outputEl = createDetached(this.activeDocument, 'div');
                outputEl.className = 'code-exec-output hidden';
                wrapper.appendChild(outputEl);

                const autoMode = this.plugin.settings.codeExecutionAutoMode ?? false;

                if (autoMode) {
                    pre.addClass('nl-display-none');
                    outputEl.classList.remove('hidden');
                    void this.runCode(pre, lang, outputEl, wrapper, false, question);
                    return;
                }

                const renderToggleRow = createDetached(this.activeDocument, 'div');
                renderToggleRow.className = 'code-exec-toggle-row';

                const renderLabel = createDetached(this.activeDocument, 'span');
                renderLabel.className = 'code-exec-label';
                renderLabel.textContent = 'Render visualization';

                const renderToggle = createDetached(this.activeDocument, 'div');
                renderToggle.className = 'code-exec-toggle';
                renderToggle.setAttribute('role', 'switch');
                renderToggle.setAttribute('aria-checked', 'false');
                renderToggle.setAttribute('aria-label', 'Render visualization');

                const backBtn = createDetached(this.activeDocument, 'button');
                backBtn.className = 'code-block-btn code-back-btn';
                backBtn.setAttribute('aria-label', 'Back to code');
                backBtn.addClass('nl-display-none');
                setIcon(backBtn, 'code-2');
                backBtn.addEventListener('click', () => {
                    pre.addClass('nl-display-');
                    outputEl.classList.add('hidden');
                    outputEl.empty();
                    outputEl.className = 'code-exec-output hidden';
                    renderToggle.classList.remove('is-enabled');
                    renderToggle.setAttribute('aria-checked', 'false');
                    backBtn.addClass('nl-display-none');
                });

                renderToggle.addEventListener('click', () => {
                    if (renderToggle.classList.contains('is-enabled')) return;
                    renderToggle.classList.add('is-enabled');
                    renderToggle.setAttribute('aria-checked', 'true');
                    pre.addClass('nl-display-none');
                    outputEl.classList.remove('hidden');
                    backBtn.addClass('nl-display-');
                    this.runCode(pre, lang, outputEl, wrapper, false, question).catch(console.error);
                });

                renderToggleRow.appendChild(renderLabel);
                renderToggleRow.appendChild(renderToggle);
                renderToggleRow.appendChild(backBtn);
                wrapper.insertBefore(renderToggleRow, outputEl);
                return;
            }

            
            if (!executable) return;

            
            const outputEl = createDetached(this.activeDocument, 'div');
            outputEl.className = 'code-exec-output hidden';
            
            wrapper.appendChild(outputEl);

            const autoMode = this.plugin.settings.codeExecutionAutoMode ?? false;

            if (autoMode) {
                
                pre.addClass('nl-display-none');
                outputEl.classList.remove('hidden');
                void this.runCode(pre, lang, outputEl, wrapper, true, question);
            } else {
                
                const runToggleRow = createDetached(this.activeDocument, 'div');
                runToggleRow.className = 'code-exec-toggle-row';

                const runLabel = createDetached(this.activeDocument, 'span');
                runLabel.className = 'code-exec-label';
                runLabel.textContent = 'Run code';

                const runToggle = createDetached(this.activeDocument, 'div');
                runToggle.className = 'code-exec-toggle';
                runToggle.setAttribute('role', 'switch');
                runToggle.setAttribute('aria-checked', 'false');
                runToggle.setAttribute('aria-label', 'Run code');

                
                const backBtn = createDetached(this.activeDocument, 'button');
                backBtn.className = 'code-block-btn code-back-btn';
                backBtn.setAttribute('aria-label', 'Back to code');
                backBtn.addClass('nl-display-none');
                setIcon(backBtn, 'code-2');
                backBtn.addEventListener('click', () => {
                    
                    pre.addClass('nl-display-');
                    outputEl.classList.add('hidden');
                    outputEl.empty();
                    outputEl.className = 'code-exec-output hidden';
                    
                    runToggle.classList.remove('is-enabled');
                    runToggle.setAttribute('aria-checked', 'false');
                    backBtn.addClass('nl-display-none');
                    
                    wrapper.querySelector('.code-repair-toggle-row')?.remove();
                });

                runToggle.addEventListener('click', () => {
                    if (runToggle.classList.contains('is-enabled')) return;
                    runToggle.classList.add('is-enabled');
                    runToggle.setAttribute('aria-checked', 'true');
                    
                    pre.addClass('nl-display-none');
                    outputEl.classList.remove('hidden');
                    backBtn.addClass('nl-display-');
                    this.runCode(pre, lang, outputEl, wrapper, false, question).catch(console.error);
                });

                runToggleRow.appendChild(runLabel);
                runToggleRow.appendChild(runToggle);
                runToggleRow.appendChild(backBtn);
                wrapper.insertBefore(runToggleRow, outputEl);
            }
        });
    }

    /**
     * Executes the code in a pre element and renders the result into outputEl.
     * If autoFix is true, automatically sends errors to the AI for repair.
     */
    private async runCode(
        preEl: HTMLElement,
        lang: string,
        outputEl: HTMLElement,
        wrapper: HTMLElement,
        autoFix: boolean,
        question = ''
    ) {
        const code = preEl.querySelector('code')?.textContent || '';
        outputEl.classList.remove('hidden', 'code-exec-error', 'code-exec-success');
        outputEl.classList.add('code-exec-running');
        outputEl.empty();

        const spinner = createDetached(this.activeDocument, 'span');
        spinner.className = 'code-exec-spinner';
        setIcon(spinner, 'loader');
        outputEl.appendChild(spinner);

        const result = await executeCode(code, lang);

        outputEl.classList.remove('code-exec-running');
        outputEl.empty();

        if (result.isHtml && result.htmlContent) {
            outputEl.classList.add('code-exec-success');
            const iframe = createDetached(this.activeDocument, 'iframe');
            iframe.className = 'code-exec-iframe';
            iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-modals');
            iframe.srcdoc = result.htmlContent;
            outputEl.appendChild(iframe);
            
            const onMsg = (e: MessageEvent) => {
                const data = e.data as unknown as Partial<IframeResizeMessage>;
                if (data?.iframeHeight && iframe.isConnected) {
                    iframe.setCssProps({ '--iframe-height':  data.iframeHeight + 'px' });
                    window.removeEventListener('message', onMsg);
                }
            };
            window.addEventListener('message', onMsg);
        } else if (result.isMarkdown && result.markdownContent) {
            outputEl.classList.add('code-exec-success');
            outputEl.addClass('nl-font-family-var--font-text');
            outputEl.addClass('nl-padding-12px');
            void MarkdownRenderer.render(this.app, result.markdownContent, outputEl, '', this);
        } else if (result.success) {
            outputEl.classList.add('code-exec-success');
            const outputPre = createDetached(this.activeDocument, 'pre');
            outputPre.className = 'code-exec-output-text';
            outputPre.textContent = result.output;
            outputEl.appendChild(outputPre);
        } else {
            outputEl.classList.add('code-exec-error');
            const errorPre = createDetached(this.activeDocument, 'pre');
            errorPre.className = 'code-exec-output-text';
            errorPre.textContent = `Error: ${result.error}`;
            if (result.output) {
                errorPre.textContent += `\n\n${result.output}`;
            }
            outputEl.appendChild(errorPre);

            if (autoFix) {
                void this.triggerCodeRepair(code, lang, result.error || '', preEl, outputEl, wrapper, true, question);
            } else {
                this.addRepairToggle(code, lang, result.error || '', preEl, outputEl, wrapper, question);
            }
        }
    }

    /**
     * Watches a mermaid <pre> block for Obsidian parse errors and injects a repair button.
     * Obsidian renders mermaid asynchronously via a codeblock processor; we use a
     * MutationObserver to detect when the error text appears in the DOM.
     */
    private watchMermaidErrors(preEl: HTMLElement, wrapper: HTMLElement, question = '') {
        const MERMAID_ERROR_TEXT = 'Error parsing Mermaid diagram';
        const MAX_WAIT_MS = 8000;

        
        const originalCode = preEl.querySelector('code')?.textContent || '';

        const injectRepairUI = (errorText: string) => {
            
            if (wrapper.querySelector('.mermaid-repair-row')) return;

            const repairRow = createDetached(this.activeDocument, 'div');
            repairRow.className = 'code-exec-toggle-row mermaid-repair-row';

            const repairLabel = createDetached(this.activeDocument, 'span');
            repairLabel.className = 'code-exec-label';
            repairLabel.textContent = 'Repair diagram';

            const repairBtn = createDetached(this.activeDocument, 'button');
            repairBtn.className = 'code-block-btn';
            repairBtn.setAttribute('aria-label', 'Repair mermaid diagram');
            setIcon(repairBtn, 'wrench');

            repairBtn.addEventListener('click', () => {
                repairRow.remove();
                this.triggerMermaidRepair(originalCode, errorText, preEl, wrapper, question).catch(console.error);
            });

            repairRow.appendChild(repairLabel);
            repairRow.appendChild(repairBtn);
            wrapper.appendChild(repairRow);
        };

        const checkForError = (root: HTMLElement): string | null => {
            const walker = this.activeDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node: Text | null;
            while ((node = walker.nextNode() as Text | null)) {
                if (node.textContent?.includes(MERMAID_ERROR_TEXT)) {
                    
                    
                    const svg = node.parentElement?.closest('svg');
                    if (svg) {
                        const textNodes = Array.from(svg.querySelectorAll('text'));
                        if (textNodes.length > 0) {
                            return textNodes.map(t => t.textContent).join('\n');
                        }
                    }
                    
                    return node.parentElement?.textContent || node.textContent || '';
                }
            }
            return null;
        };

        
        const immediate = checkForError(wrapper);
        if (immediate) { injectRepairUI(immediate); return; }

        const observer = new MutationObserver(() => {
            const err = checkForError(wrapper);
            if (err) {
                observer.disconnect();
                injectRepairUI(err);
            }
        });
        observer.observe(wrapper, { childList: true, subtree: true, characterData: true });

        
        window.setTimeout(() => observer.disconnect(), MAX_WAIT_MS);
    }

    /**
     * Sends a mermaid diagram + its parse error to the AI and re-renders the fixed version.
     */
    private async triggerMermaidRepair(
        code: string,
        error: string,
        preEl: HTMLElement,
        wrapper: HTMLElement,
        question = ''
    ) {
        
        const loadingEl = createDetached(this.activeDocument, 'div');
        loadingEl.className = 'code-exec-output code-exec-running';
        const spinner = createDetached(this.activeDocument, 'span');
        spinner.className = 'code-exec-spinner';
        setIcon(spinner, 'loader');
        loadingEl.appendChild(spinner);
        const loadingText = createDetached(this.activeDocument, 'span');
        loadingText.className = 'code-exec-label';
        loadingText.textContent = 'Repairing diagram…';
        loadingEl.appendChild(loadingText);
        wrapper.appendChild(loadingEl);

        const prompt = `The following Mermaid diagram has a parse error. Fix ONLY the Mermaid syntax. Return ONLY the corrected mermaid code block with no explanation:\n\n\`\`\`mermaid\n${code}\n\`\`\`\n\nError:\n${error}`;

        try {
            const repaired = await this.getRepairFromAI(prompt);
            const match = repaired.match(/```(?:mermaid)?\n([\s\S]*?)```/);
            const fixedCode = match ? match[1].trim() : repaired.trim();

            loadingEl.remove();

            
            const oldCode = wrapper.dataset.code || code;
            wrapper.dataset.code = fixedCode;

            
            const codeEl = preEl.querySelector('code');
            if (codeEl) codeEl.textContent = fixedCode;

            
            if (this.activeCanvas) this.activeCanvas.updateCode(fixedCode);

            
            this.saveCodeEdit(question, oldCode, fixedCode, 'mermaid');

            
            const tempContainer = createDetached(this.activeDocument, 'div');
            await MarkdownRenderer.render(
                this.app,
                '```mermaid\n' + fixedCode + '\n```',
                tempContainer,
                '',
                this
            );

            
            const rendered = tempContainer.firstElementChild;
            if (rendered) {
                
                const existingPre = wrapper.querySelector('pre');
                existingPre?.replaceWith(rendered);
            }

            
            this.watchMermaidErrors(rendered as HTMLElement ?? preEl, wrapper, question);
        } catch (err: unknown) {
            loadingEl.remove();

            const errRow = createDetached(this.activeDocument, 'div');
            errRow.className = 'code-exec-toggle-row mermaid-repair-row';
            const errLabel = createDetached(this.activeDocument, 'span');
            errLabel.className = 'code-exec-label';
            errLabel.addClass('nl-color-remaining-13');
            errLabel.textContent = `Repair failed: ${err instanceof Error ? err.message : String(err)}`;
            const retryBtn = createDetached(this.activeDocument, 'button');
            retryBtn.className = 'code-block-btn';
            retryBtn.setAttribute('aria-label', 'Retry repair');
            setIcon(retryBtn, 'refresh-cw');
            retryBtn.addEventListener('click', () => {
                errRow.remove();
                this.triggerMermaidRepair(code, error, preEl, wrapper, question).catch(console.error);
            });
            errRow.appendChild(errLabel);
            errRow.appendChild(retryBtn);
            wrapper.appendChild(errRow);
        }
    }

    private addRepairToggle(
        code: string,
        lang: string,
        error: string,
        preEl: HTMLElement,
        outputEl: HTMLElement,
        wrapper: HTMLElement,
        question = ''
    ) {
        
        outputEl.querySelector('.code-repair-toggle-row')?.remove();
        wrapper.querySelector('.code-repair-toggle-row')?.remove();

        const repairRow = createDetached(this.activeDocument, 'div');
        repairRow.className = 'code-exec-toggle-row code-repair-toggle-row';

        const repairLabel = createDetached(this.activeDocument, 'span');
        repairLabel.className = 'code-exec-label';
        repairLabel.textContent = 'Repair code';

        const repairToggle = createDetached(this.activeDocument, 'div');
        repairToggle.className = 'code-exec-toggle code-repair-toggle-switch';
        repairToggle.setAttribute('role', 'switch');
        repairToggle.setAttribute('aria-checked', 'false');
        repairToggle.setAttribute('aria-label', 'Repair code');

        repairToggle.addEventListener('click', () => {
            repairToggle.classList.add('is-enabled');
            repairToggle.setAttribute('aria-checked', 'true');
            repairRow.remove();
            this.triggerCodeRepair(code, lang, error, preEl, outputEl, wrapper, false, question).catch(console.error);
        });

        repairRow.appendChild(repairLabel);
        repairRow.appendChild(repairToggle);

        
        outputEl.appendChild(repairRow);
    }

    private async triggerCodeRepair(
        code: string,
        lang: string,
        error: string,
        preEl: HTMLElement,
        outputEl: HTMLElement,
        wrapper: HTMLElement,
        autoFix: boolean,
        question = ''
    ) {
        outputEl.classList.remove('hidden', 'code-exec-error', 'code-exec-success');
        outputEl.classList.add('code-exec-running');
        outputEl.empty();
        const spinner = createDetached(this.activeDocument, 'span');
        spinner.className = 'code-exec-spinner';
        setIcon(spinner, 'loader');
        outputEl.appendChild(spinner);

        const repairPrompt = `The following ${lang} code has an error. Fix ONLY the code, return ONLY the corrected code block with no explanation:\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\nError:\n${error}`;

        try {
            const repaired = await this.getRepairFromAI(repairPrompt);
            
            const match = repaired.match(/```(?:\w+)?\n([\s\S]*?)```/);
            const fixedCode = match ? match[1].trim() : repaired.trim();

            
            const oldCode = wrapper.dataset.code || code;
            wrapper.dataset.code = fixedCode;

            
            const codeEl = preEl.querySelector('code');
            if (codeEl) codeEl.textContent = fixedCode;

            
            if (this.activeCanvas) this.activeCanvas.updateCode(fixedCode);

            
            this.saveCodeEdit(question, oldCode, fixedCode, lang);

            outputEl.classList.remove('code-exec-running');
            outputEl.empty();

            
            await this.runCode(preEl, lang, outputEl, wrapper, autoFix);
        } catch (err: unknown) {
            outputEl.classList.remove('code-exec-running');
            outputEl.classList.add('code-exec-error');
            outputEl.empty();
            const errPre = createDetached(this.activeDocument, 'pre');
            errPre.className = 'code-exec-output-text';
            errPre.textContent = `Repair failed: ${err instanceof Error ? err.message : String(err)}`;
            outputEl.appendChild(errPre);

            if (!autoFix) {
                const currentCode = preEl.querySelector('code')?.textContent || code;
                this.addRepairToggle(currentCode, lang, err instanceof Error ? err.message : '', preEl, outputEl, wrapper, question);
            }
        }
    }

    /**
     * Calls the currently active AI provider to repair code.
     */
    private async getRepairFromAI(prompt: string): Promise<string> {
        const provider = this.settings.aiChatProvider || this.settings.provider;
        const model = this.settings.aiChatModel || this.settings.model;

        if (provider === 'gemini') {
            if (!this.settings.geminiApiKey) {
                throw new Error('Gemini API key is not configured in settings.');
            }
            const service = new GeminiService(this.settings.geminiApiKey);
            return await service.generateContentWithHeaders(model, prompt);
        }

        if (provider === 'groq') {
            if (!this.settings.groqApiKey) {
                throw new Error('Groq API key is not configured in settings.');
            }
            const response = await requestUrl({
                url: 'https://api.groq.com/openai/v1/chat/completions',
                method: 'POST',
                headers: { Authorization: `Bearer ${this.settings.groqApiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 2048 })
            });
            return (response.json as OpenAIChatCompletionResponse).choices?.[0]?.message?.content ?? '';
        }

        if (provider === 'openrouter') {
            if (!this.settings.openRouterApiKey) {
                throw new Error('OpenRouter API key is not configured in settings.');
            }
            const response = await requestUrl({
                url: 'https://openrouter.ai/api/v1/chat/completions',
                method: 'POST',
                headers: { Authorization: `Bearer ${this.settings.openRouterApiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 2048 })
            });
            return (response.json as OpenAIChatCompletionResponse).choices?.[0]?.message?.content ?? '';
        }

        if (provider === 'opencode') {
            if (!this.settings.openCodeApiKey) {
                throw new Error('OpenCode Zen API key is not configured in settings.');
            }
            const { OpenCodeProvider } = await import('../services/openCodeService');
            const service = new OpenCodeProvider(this.settings.openCodeApiKey);
            const response = await service.generateContent(model, [{ role: 'user', content: prompt }], { maxTokens: 2048 });
            return response.text;
        }

        if (provider === 'nvidia') {
            if (!this.settings.nvidiaApiKey) {
                throw new Error('NVIDIA API key is not configured in settings.');
            }
            const { NvidiaService } = await import('../services/nvidiaService');
            const service = new NvidiaService(this.settings.nvidiaApiKey);
            return await service.generateContent(model, [{ role: 'user', content: prompt }], { maxTokens: 2048 });
        }

        if (provider === 'ollama') {
            if (this.settings.ollamaMode === 'cloud' && !this.settings.ollamaApiKey) {
                throw new Error('Ollama API key is not configured for cloud mode.');
            }
            const baseUrl = this.settings.ollamaBaseUrl || 'http://localhost:11434';
            const ollamaService = new OllamaService(baseUrl, this.settings.ollamaApiKey || '');
            return await ollamaService.generateContent(model, [{ role: 'user', content: prompt }]);
        }

        if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
            const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
            
            
            const response = await unifiedProvider.generateContent(
                model,
                [{ role: 'user', content: prompt }],
                { temperature: 0.2, maxTokens: 2048 }
            );
            return response.text;
        }

        throw new Error(`No AI provider configured for code repair (current: ${provider})`);
    }

    /**
     * Formats token count with better notation (e.g., 1.2k for 1200)
     */
    private formatTokenCount(tokens: number): string {
        if (tokens >= 1000000) {
            return (tokens / 1000000).toFixed(1) + 'M';
        } else if (tokens >= 1000) {
            return (tokens / 1000).toFixed(1) + 'k';
        }
        return tokens.toString();
    }

    /**
     * Adds response metadata (model, tokens, time) below the response card.
     * For vault/flash search responses, also shows an index status indicator.
     */
    private addResponseMetadata(responseEl: HTMLElement, response: Response) {
        const metadataEl = responseEl.createDiv({ cls: 'response-metadata' });

        
        if (this.settings.chatWallpaperEnabled && this.settings.chatWallpaperPath) {
            metadataEl.classList.add('liquid-glass-active');
        }

        
        if (response.vaultIndexName && (response.searchMode === 'vault' || response.searchMode === 'flash')) {
            const indexItem = metadataEl.createDiv({ cls: 'response-metadata-item' });
            const indexIcon = indexItem.createSpan({ cls: 'metadata-icon' });
            setIcon(indexIcon, 'database');
            indexItem.createSpan({ cls: 'metadata-label', text: 'Index:' });
            indexItem.createSpan({ cls: 'metadata-value response-vault-index-name', text: response.vaultIndexName });
        }

        
        const modelName = response.modelName || this.settings.model;
        const modelItem = metadataEl.createDiv({ cls: 'response-metadata-item' });

        
        
        if (!this.renderingRestoredSession && (response.searchMode === 'vault' || response.searchMode === 'flash')) {
            this.addIndexStatusDot(modelItem, response.searchMode);
        }

        const modelIcon = modelItem.createSpan({ cls: 'metadata-icon' });
        setIcon(modelIcon, 'bot');
        modelItem.createSpan({ cls: 'metadata-value', text: this.getModelDisplayName(modelName) });

        
        if (response.totalTokens && response.totalTokens > 0) {
            const tokensItem = metadataEl.createDiv({ cls: 'response-metadata-item' });
            const tokensIcon = tokensItem.createSpan({ cls: 'metadata-icon' });
            setIcon(tokensIcon, 'hash');
            tokensItem.createSpan({ cls: 'metadata-label', text: 'Tokens:' });
            tokensItem.createSpan({ cls: 'metadata-value', text: this.formatTokenCount(response.totalTokens) });
        }

        
        if (response.responseTimeMs && response.responseTimeMs > 0) {
            const timeItem = metadataEl.createDiv({ cls: 'response-metadata-item' });
            timeItem.createSpan({ cls: 'metadata-icon', text: '⏱️' });
            timeItem.createSpan({ cls: 'metadata-label', text: 'Time:' });
            const timeInSeconds = (response.responseTimeMs / 1000).toFixed(1);
            timeItem.createSpan({ cls: 'metadata-value', text: `${timeInSeconds}s` });
        }
    }

    /**
     * Adds a red glowing dot before the model name when the vault/BM25 index
     * is not fully up to date. Clicking/hovering shows a callout with an
     * "Index Now" button that triggers incremental indexing — identical to
     * clicking "Build Index" in the Settings → Vault tab.
     *
     * Uses detectChanges() for a live check rather than the stale cached
     * bm25IndexedFiles / embeddingIndexedFiles percentages, which are only
     * updated by the combined build path and can be stale.
     */
    private addIndexStatusDot(container: HTMLElement, searchMode: 'vault' | 'flash') {
        
        
        const dotWrapper = container.createDiv({ cls: 'index-status-dot-wrapper' });
        const dot = dotWrapper.createDiv({ cls: 'index-status-dot' });

        
        const callout = dotWrapper.createDiv({ cls: 'index-status-callout' });
        callout.createEl('p', {
            text: 'The selected vault is not fully indexed. Please index to retrieve the most up to date info from your inclusions.',
            cls: 'index-status-callout-text'
        });

        
        const filesSection = callout.createDiv({ cls: 'index-status-files-section' });
        const filesToggle = filesSection.createDiv({ cls: 'index-status-files-toggle' });
        const toggleIcon = filesToggle.createSpan({ cls: 'index-status-files-toggle-icon', text: '▶' });
        filesToggle.createSpan({ text: 'View non-indexed files' });

        const filesList = filesSection.createDiv({ cls: 'index-status-files-list' });
        const filesListInner = filesList.createDiv({ cls: 'index-status-files-list-inner' });
        filesListInner.createSpan({ text: 'Loading...', cls: 'index-status-files-loading' });

        let isExpanded = false;
        let filesLoaded = false;

        filesToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            isExpanded = !isExpanded;
            toggleIcon.classList.toggle('expanded', isExpanded);
            filesList.classList.toggle('expanded', isExpanded);

            
            if (isExpanded && !filesLoaded) {
                filesLoaded = true;
                this.loadNonIndexedFiles(filesListInner, searchMode).catch(console.error);
            }
        });

        const indexBtn = callout.createEl('button', {
            text: 'Index Now',
            cls: 'index-status-callout-btn'
        });

        
        const embeddingsManager = this.plugin.embeddingsManager;
        if (embeddingsManager && typeof embeddingsManager.detectChanges === 'function') {
            
            let targetIndexId: string | null = null;
            if (searchMode === 'flash') {
                targetIndexId = this.settings.selectedBM25IndexId || null;
            } else {
                targetIndexId = this.settings.selectedEmbeddingIndexId || null;
            }

            if (targetIndexId) {
                embeddingsManager.detectChanges(targetIndexId).then((changes: { hasChanges: boolean }) => {
                    if (changes.hasChanges) {
                        dotWrapper.addClass('is-visible');
                    }
                }).catch(() => {
                    // on error keep hidden
                });
            }
        }

        let isIndexing = false;
        indexBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isIndexing) return;
            isIndexing = true;
            indexBtn.disabled = true;
            indexBtn.textContent = 'Indexing…';

            (async () => {
                const notice = new Notice('Incremental Indexing started…', 0);

                try {
                    const indexConfigs = this.settings.indexConfigurations || [];

                    if (searchMode === 'flash') {
                        const bm25Config = indexConfigs.find((c) => c.type === 'bm25' && c.enabled)
                            ?? indexConfigs.find((c) => c.type === 'bm25');

                        if (bm25Config) {
                            bm25Config.isBuilding = true;
                            bm25Config.buildProgress = 0;
                            bm25Config.buildError = undefined;
                        }

                        await embeddingsManager.buildBM25Index((status: string) => {
                            const m = status.match(/BM25:(\d+)/);
                            if (m) {
                                const pct = parseInt(m[1]);
                                if (bm25Config) bm25Config.buildProgress = pct;
                                notice.setMessage(`Incremental Indexing: BM25 ${pct}%`);
                            }
                        });

                        if (bm25Config) {
                            const bm25FileCount = await embeddingsManager.getBM25FileCount(bm25Config.id);
                            bm25Config.fileCount = bm25FileCount;
                            bm25Config.lastUpdated = Date.now();
                            bm25Config.isBuilding = false;
                            bm25Config.buildProgress = 0;
                        }

                        const allFiles = this.app.vault.getFiles().filter(f => f.extension === 'md' || f.extension === 'pdf');
                        const bm25Count = bm25Config ? bm25Config.fileCount : 0;
                        this.settings.bm25IndexedFiles = allFiles.length > 0
                            ? Math.round((bm25Count / allFiles.length) * 100) : 0;
                    } else {
                        const embConfig = indexConfigs.find((c) => c.type === 'embedding' && c.enabled)
                            ?? indexConfigs.find((c) => c.type === 'embedding');

                        const embModel = embConfig?.model || this.settings.embeddingModel;

                        if (embConfig) {
                            embConfig.isBuilding = true;
                            embConfig.buildProgress = 0;
                            embConfig.buildError = undefined;
                        }

                        await embeddingsManager.buildEmbeddingIndex(
                            embModel,
                            (status: string) => {
                                const m = status.match(/EMBEDDINGS:(\d+)/);
                                if (m) {
                                    const pct = parseInt(m[1]);
                                    if (embConfig) embConfig.buildProgress = pct;
                                    notice.setMessage(`Incremental Indexing: Embeddings ${pct}%`);
                                }
                            },
                            embConfig?.id
                        );

                        if (embConfig) {
                            const embFileCount = await embeddingsManager.getEmbeddedFileCount(embConfig.id);
                            embConfig.fileCount = embFileCount;
                            embConfig.lastUpdated = Date.now();
                            embConfig.isBuilding = false;
                            embConfig.buildProgress = 0;
                        }

                        const allFiles = this.app.vault.getMarkdownFiles();
                        const nonExcluded = allFiles.filter((f) => !embeddingsManager.isFileExcluded(f.path, embConfig?.id));
                        const embCount = embConfig ? embConfig.fileCount : 0;
                        this.settings.embeddingIndexedFiles = nonExcluded.length > 0
                            ? Math.round((embCount / nonExcluded.length) * 100) : 0;
                    }

                    await this.plugin.saveSettings();
                    notice.setMessage('Incremental Indexing complete.');
                    window.setTimeout(() => notice.hide(), 3000);

                    dotWrapper.remove();
                } catch (err: unknown) {
                    notice.setMessage(`Indexing failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
                    window.setTimeout(() => notice.hide(), 5000);
                    indexBtn.disabled = false;
                    indexBtn.textContent = 'Retry';
                    isIndexing = false;

                    const indexConfigs = this.settings.indexConfigurations || [];
                    indexConfigs.forEach((c) => { c.isBuilding = false; });
                }
            })().catch((err) => {
                console.error('Index click handler failed:', err);
            });
        });

        
        callout.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        
        let calloutVisible = false;
        dot.addEventListener('click', (e) => {
            e.stopPropagation();
            calloutVisible = !calloutVisible;
            callout.classList.toggle('visible', calloutVisible);
        });
        dot.addEventListener('mouseenter', () => {
            callout.classList.add('visible');
        });
        dotWrapper.addEventListener('mouseleave', () => {
            if (!calloutVisible) callout.classList.remove('visible');
        });

        
        this.activeDocument.addEventListener('click', () => {
            calloutVisible = false;
            callout.classList.remove('visible');
        }, { capture: true });
    }

    private async loadNonIndexedFiles(container: HTMLElement, searchMode: 'vault' | 'flash') {
        try {
            const embeddingsManager = this.plugin.embeddingsManager;
            if (!embeddingsManager) {
                container.empty();
                container.createSpan({ text: 'Unable to load files', cls: 'index-status-files-loading' });
                return;
            }

            const indexConfigs = this.settings.indexConfigurations || [];

            let targetConfig: (typeof indexConfigs)[number] | null;
            if (searchMode === 'flash') {
                targetConfig = indexConfigs.find((c) => c.type === 'bm25' && c.enabled)
                    ?? indexConfigs.find((c) => c.type === 'bm25')
                    ?? null;
            } else {
                targetConfig = indexConfigs.find((c) => c.type === 'embedding' && c.enabled)
                    ?? indexConfigs.find((c) => c.type === 'embedding')
                    ?? null;
            }

            if (!targetConfig) {
                container.empty();
                container.createSpan({ text: 'No index configured', cls: 'index-status-files-loading' });
                return;
            }

            const isBM25 = targetConfig.type === 'bm25';
            const indexId: string = targetConfig.id;

            
            const indexPath = embeddingsManager.getIndexFilePath
                ? embeddingsManager.getIndexFilePath(indexId)
                : `.Nexus-LM-data/vault-embeddings/embeddings-${indexId}.bin`;

            const indexedFilePaths = new Set<string>();
            if (await this.app.vault.adapter.exists(indexPath)) {
                try {
                    const data = await this.app.vault.adapter.readBinary(indexPath);
                    
                    
                    const tempId = `metadata-${Math.random().toString(36).substring(2, 7)}`;
                    const schema = {
                        id: 'string',
                        path: 'string',
                        version: 'number'
                    };

                    const loadResponse = await OramaWorkerManager.getInstance().load(tempId, data, schema, true) as { documents?: Array<Record<string, unknown>>; metadata?: { documents?: Array<Record<string, unknown>> } } | undefined;
                    await OramaWorkerManager.getInstance().remove(tempId, ''); 

                    const docs = loadResponse?.documents || loadResponse?.metadata?.documents || [];
                    for (const doc of docs) {
                        const docPath = String(doc.path || '');
                        if (docPath && (docPath.endsWith('.md') || (isBM25 && docPath.endsWith('.pdf')))) {
                            indexedFilePaths.add(docPath);
                        }
                    }
                } catch { /* treat as empty */ }
            }

            
            
            const allFiles = isBM25
                ? this.app.vault.getFiles().filter(f => f.extension === 'md' || f.extension === 'pdf')
                : this.app.vault.getMarkdownFiles();
            const includedFiles = isBM25
                ? allFiles
                : allFiles.filter((file) => !embeddingsManager.isFileExcluded(file.path, indexId));

            
            const nonIndexedFiles = includedFiles.filter((file) => !indexedFilePaths.has(file.path) && (file.stat?.size || 0) > 0);

            container.empty();

            if (nonIndexedFiles.length === 0) {
                container.createSpan({ text: 'All files are indexed!', cls: 'index-status-files-loading' });
            } else {
                const countText = container.createDiv();
                countText.createSpan({ text: `${nonIndexedFiles.length}`, cls: 'index-status-files-count' });
                countText.appendText(` file${nonIndexedFiles.length !== 1 ? 's' : ''} not indexed:`);

                nonIndexedFiles.sort((a, b) => a.path.localeCompare(b.path));

                const displayLimit = 50;
                for (const file of nonIndexedFiles.slice(0, displayLimit)) {
                    container.createDiv({ text: file.path, cls: 'index-status-file-item' });
                }
                if (nonIndexedFiles.length > displayLimit) {
                    container.createDiv({
                        text: `... and ${nonIndexedFiles.length - displayLimit} more`,
                        cls: 'index-status-file-item index-status-files-loading'
                    });
                }
            }
        } catch {
                        container.empty();
            container.createSpan({ text: 'Error loading files', cls: 'index-status-files-loading' });
        }
    }

    private async saveCurrentSession() {
        
        if (this.settings.aiChatHistoryEnabled && this.responses.length > 0) {
            
            const first = this.responses[0]?.question || 'AI Chat';
            const sessionName = first.split(/\s+/).slice(0, 20).join(' ');
            const now = Date.now();

            
            if (!this.currentSessionId) {
                this.currentSessionId = now.toString();
            }

            const session: AIChatSession = {
                id: this.currentSessionId,
                name: sessionName,
                createdAt: this.currentSessionCreatedAt ?? now, 
                updatedAt: now,
                sessionType: this.currentSessionType ?? 'chat',
                systemInstructions: this.currentSystemInstructions || undefined, 
                messages: this.responses.map(r => ({
                    question: r.question,
                    answer: r.answer,
                    timestamp: r.timestamp instanceof Date ? r.timestamp.getTime() : (typeof r.timestamp === 'number' ? r.timestamp : now),
                    
                    id: r.id,
                    sessionId: r.sessionId,
                    fileActionIds: r.fileActionIds,
                    context: r.context,
                    sources: r.sources,
                    webResults: r.webResults as unknown as Record<string, unknown>[],
                    

                    fileActionData: r.fileActionIds ? this.getFileActionDataForSave(r.fileActionIds) as unknown as Record<string, unknown> : undefined,
                    
                    modelName: r.modelName,
                    totalTokens: r.totalTokens,
                    responseTimeMs: r.responseTimeMs,
                    
                    mcpTools: r.mcpTools as Record<string, unknown>[],
                    
                    searchMode: r.searchMode,
                    
                    vaultIndexName: r.vaultIndexName,

                    isAgentResponse: r.isAgentResponse,
                    agentSteps: r.agentSteps,
                    vaultAnswer: r.vaultAnswer,
                    vaultResults: r.vaultResults,
                    fileOperations: r.fileOperations,
                    summary: r.summary,
                    keywords: r.keywords,
                    lessons: r.lessons,
                    importance: r.importance,
                    stepsCount: r.stepsCount,
                    success: r.success,
                    artifacts: r.artifacts
                }))
            };

            await this.aiChatSessionManager.saveSession(session);
        }
    }

    private getFileActionDataForSave(fileActionIds: string[]): { [actionId: string]: FileActionSaveData } {
        const actionData: { [actionId: string]: FileActionSaveData } = {};

        for (const actionId of fileActionIds) {
            const actionState = this.activeFileActions.get(actionId);
            if (actionState) {
                const saveData: FileActionSaveData = {
                    type: actionState.type,
                    fileName: actionState.fileName,
                    status: actionState.status,
                    isApplied: actionState.isApplied || false,
                };

                
                if (actionState.type === 'edit' && actionState.data) {
                    saveData.editData = {
                        filePath: actionState.data.file?.path || '',
                        originalContent: actionState.data.originalContent || '',
                        editedContent: actionState.data.editedContent || '',
                        editPrompt: actionState.data.editPrompt || ''
                    };
                }

                
                if (actionState.type === 'create' && actionState.data) {
                    saveData.createData = {
                        folderName: actionState.data.folderName || '',
                        creationPrompt: actionState.data.creationPrompt || '',
                        files: actionState.data.files || []
                    };
                }

                actionData[actionId] = saveData;
            }
        }

        return actionData;
    }

    private startNewSession() {
        
        this.responses = [];
        this.currentSessionId = null;
        this.currentSessionType = 'chat';
        this.currentSessionCreatedAt = null;
        this.currentSystemInstructions = ''; 

        
        this.pendingMCPSelection = null;

        
        this.updateContextBar();

        
        this.activeFileActions.clear();

        
        if (this.contentContainer) {
            this.contentContainer.empty();
        }

        

        
        if (this.queryInput) {
            this.queryInput.value = '';
            this.queryInput.placeholder = 'Ask anything...';
        }

        
        const btn = $q<HTMLElement>(this.containerEl, '.header-system-instructions-btn');
        if (btn) {
            btn.removeClass('has-instructions');
            btn.removeAttribute('data-collection-icon');
            
            setIcon(btn, 'wrench');
        }

        this.updateNavRail();
        this.updateJumpButton();
    }

    private setNavOpen(open: boolean): void {
        if (this.navOpenTimer !== null) {
            window.clearTimeout(this.navOpenTimer);
            this.navOpenTimer = null;
        }
        this.navRailEl?.toggleClass('is-open', open);
    }

    private scheduleNavClose(): void {
        if (this.navOpenTimer !== null) {
            window.clearTimeout(this.navOpenTimer);
        }
        this.navOpenTimer = window.setTimeout(() => this.setNavOpen(false), 220);
    }

    private truncateQuery(text: string): string {
        const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return '';
        const words = cleaned.split(' ');
        const trimmed = words.slice(0, 5).join(' ');
        const truncated = trimmed.length > 34 ? trimmed.slice(0, 34).replace(/\s+\S*$/, '') : trimmed;
        const shortened = truncated.length < cleaned.length ? `${truncated.replace(/[.,;:]+$/, '')}…` : truncated;
        return shortened || cleaned.slice(0, 34) + '…';
    }

    private updateNavRail(): void {
        if (!this.navRailEl || !this.navListEl || !this.contentContainer) return;
        const listEl = this.navListEl;
        listEl.empty();
        const items = Array.from(this.contentContainer.querySelectorAll('.response-item'));
        this.navRailEl.toggleClass('is-hidden', items.length === 0);
        items.forEach((el, index) => {
            const question = this.responses[index]?.question ?? '';
            if (!question.trim()) return;
            const row = listEl.createDiv({ cls: 'agent-nav-rail-item' });
            const dot = row.createDiv({ cls: 'agent-nav-rail-item-dot' });
            if (index === items.length - 1 && el.querySelector('.response-progress-text')) {
                dot.setAttr('data-running', 'true');
            }
            const labelEl = row.createDiv({ cls: 'agent-nav-rail-item-text' });
            labelEl.setText(this.truncateQuery(question));
            labelEl.setAttr('title', question);
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                this.setNavOpen(false);
            });
        });
    }

    private updateJumpButton(): void {
        const btn = this.jumpBtnEl;
        const container = this.contentContainer;
        if (!btn || !container) return;
        const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
        btn.toggleClass('is-visible', this.responses.length > 0 && !atBottom && container.scrollHeight > container.clientHeight);
    }

    private createQuestionActions(questionEl: HTMLElement, question: string) {
        const actionsContainer = questionEl.createDiv({ cls: 'response-actions query-actions' });

        
        if (this.settings.chatWallpaperEnabled && this.settings.chatWallpaperPath) {
            actionsContainer.classList.add('liquid-glass-active');
        }

        
        new ButtonComponent(actionsContainer)
            .setIcon('copy')
            .setTooltip('Copy query')
            .onClick(() => {
                void navigator.clipboard.writeText(question);
                new Notice('Query copied to clipboard');
            });

        
        new ButtonComponent(actionsContainer)
            .setIcon('edit')
            .setTooltip('Edit query')
            .onClick(() => {
                this.editQuery(questionEl, question);
            });
    }

    private editQuery(questionEl: HTMLElement, originalQuestion: string) {
        questionEl.empty(); 

        const editContainer = questionEl.createDiv({ cls: 'query-edit-container' });
        const textArea = editContainer.createEl('textarea', { cls: 'query-edit-textarea' });
        textArea.value = originalQuestion;
        textArea.rows = originalQuestion.split('\n').length; 

        
        const adjustHeight = () => {
            textArea.addClass('nl-height-auto');
            textArea.setCssProps({ '--response-height':  textArea.scrollHeight + 'px' });
        };
        textArea.addEventListener('input', adjustHeight);
        window.setTimeout(adjustHeight, 0); 

        const buttonContainer = editContainer.createDiv({ cls: 'query-edit-buttons' });

        new ButtonComponent(buttonContainer)
            .setButtonText('Cancel')
            .onClick(() => {
                questionEl.empty();
                questionEl.createSpan().textContent = originalQuestion;
                this.createQuestionActions(questionEl, originalQuestion);
            });

        new ButtonComponent(buttonContainer)
            .setButtonText('Save & Regenerate')
            .setCta()
            .onClick(async () => {
                const editedQuery = textArea.value.trim();
                if (editedQuery && editedQuery !== originalQuestion) {
                    
                    const index = this.responses.findIndex(res => res.question === originalQuestion);
                    if (index !== -1) {
                        
                        this.responses.splice(index, 1);
                        
                        
                    }
                    questionEl.empty(); 
                    questionEl.createSpan().textContent = editedQuery; 
                    this.createQuestionActions(questionEl, editedQuery); 
                    this.contentContainer.removeChild(questionEl.parentElement!); 
                    
                    this.updateContextBar();

                    await this.processQuery(editedQuery); 
                    
                } else {
                    
                    questionEl.empty();
                    questionEl.createSpan().textContent = originalQuestion;
                    this.createQuestionActions(questionEl, originalQuestion);
                }
            });
    }

    private openContextMenu(anchorEl: HTMLElement, fromMore: boolean) {
        this.closeContextMenu();
        this.contextMenuOpenFromMore = fromMore;
        
        const menu = createDetached(this.activeDocument, 'div');
        menu.className = 'context-file-menu';
        
        const rect = anchorEl.getBoundingClientRect();
        menu.addClass('nl-position-fixed');
        menu.setCssProps({ '--menu-left':  `${rect.left}px` });
        menu.addClass('nl-z-index-9999');
        menu.addClass('nl-min-width-260px');
        
        const searchInput = createDetached(this.activeDocument, 'input');
        searchInput.type = 'text';
        searchInput.className = 'context-file-menu-search';
        searchInput.placeholder = 'Search files directly by name, use / for folders';
        menu.appendChild(searchInput);
        this.contextMenuInput = searchInput;
        
        const listContainer = createDetached(this.activeDocument, 'div');
        listContainer.className = 'context-file-menu-list';
        menu.appendChild(listContainer);
        
        this.renderContextMenuOptions(listContainer, '');
        
        searchInput.addEventListener('input', (e) => {
            const val = searchInput.value;
            
            if (val.endsWith('[[')) {
                this.closeContextMenu();
                
                const curPos = val.length;
                const modal = new FileModal(
                    this.app,
                    (file: TFile) => {
                        this.selectedFiles.add(file.path);
                        this.renderFileCapsules(this.inputContainer.querySelector('.context-capsule-display') as HTMLElement);
                    },
                    searchInput as unknown as HTMLTextAreaElement,
                    curPos
                );
                modal.open();
                return;
            } else if (val.endsWith('/')) {
                this.closeContextMenu();
                
                const curPos = val.length;
                const modal = new FolderModal(
                    this.app,
                    (folder: TFolder) => {
                        const filesInFolder = this.getAllFilesInFolder(folder);
                        filesInFolder.forEach(file => this.selectedFiles.add(file.path));
                        this.renderFileCapsules(this.inputContainer.querySelector('.context-capsule-display') as HTMLElement);
                    },
                    searchInput as unknown as HTMLTextAreaElement,
                    curPos
                );
                modal.open();
                return;
            }
            this.renderContextMenuOptions(listContainer, val);
        });
        
        window.setTimeout(() => {
            this.activeDocument.addEventListener('mousedown', this.handleContextMenuOutsideClick, true);
        }, 0);
        this.activeDocument.body.appendChild(menu);
        
        const menuHeight = menu.offsetHeight;
        
        if (anchorEl.classList.contains('capsule-more-tag')) {
            menu.setCssProps({ '--menu-left':  `${rect.right - menu.offsetWidth}px` });
        } else {
            menu.setCssProps({ '--menu-left':  `${rect.left}px` });
        }
        menu.setCssProps({ '--menu-top':  `${rect.top - menuHeight - 8}px` });
        this.contextMenuEl = menu;
    }

    private closeContextMenu = () => {
        if (this.contextMenuEl) {
            this.activeDocument.body.removeChild(this.contextMenuEl);
            this.contextMenuEl = null;
        }
        if (this.contextMenuPreviewEl) {
            this.activeDocument.body.removeChild(this.contextMenuPreviewEl);
            this.contextMenuPreviewEl = null;
        }
        this.activeDocument.removeEventListener('mousedown', this.handleContextMenuOutsideClick, true);
        this.contextMenuAtIndex = -1;
        this.contextMenuSearchTerm = '';
    };

    /**
     * Opens context menu with filtering based on @ symbol detection
     * @param anchorEl - Element to anchor the menu to
     * @param fromMore - Whether opened from '+N' button
     * @param searchTerm - Text typed after '@'
     * @param atIndex - Position of '@' in the input
     */
    private openContextMenuWithFilter(anchorEl: HTMLElement, fromMore: boolean, searchTerm: string, atIndex: number) {
        this.contextMenuAtIndex = atIndex;
        this.contextMenuSearchTerm = searchTerm;

        
        if (this.contextMenuEl) {
            const listContainer = this.contextMenuEl.querySelector('.context-file-menu-list') as HTMLElement;
            if (listContainer) {
                this.renderContextMenuOptionsFiltered(listContainer, searchTerm);
            }
            return;
        }

        
        this.closeContextMenu();
        this.contextMenuOpenFromMore = fromMore;

        const menu = createDetached(this.activeDocument, 'div');
        menu.className = 'context-file-menu';

        
        const rect = anchorEl.getBoundingClientRect();
        menu.addClass('nl-position-fixed');
        menu.setCssProps({ '--menu-left':  `${rect.left}px` });
        menu.addClass('nl-z-index-9999');
        menu.addClass('nl-min-width-260px');

        
        const listContainer = createDetached(this.activeDocument, 'div');
        listContainer.className = 'context-file-menu-list';
        menu.appendChild(listContainer);

        
        this.renderContextMenuOptionsFiltered(listContainer, searchTerm);

        
        window.setTimeout(() => {
            this.activeDocument.addEventListener('mousedown', this.handleContextMenuOutsideClick, true);
        }, 0);

        this.activeDocument.body.appendChild(menu);

        
        const menuHeight = menu.offsetHeight;
        menu.setCssProps({ '--menu-top':  `${rect.top - menuHeight - 8}px` });

        this.contextMenuEl = menu;
    }

    /**
     * Renders context menu options filtered by search term
     * Shows feature prefixes first, then matching files
     */
    private renderContextMenuOptionsFiltered(container: HTMLElement, searchTerm: string) {
        container.empty();

        const lowerSearch = searchTerm.toLowerCase();

        
        const prefixOptions: PrefixOption[] = [
            { label: '@flash', value: '@flash ', action: 'prefix', description: 'Fast BM25 keyword search', hasToggle: true },
            { label: '@vault', value: '@vault ', action: 'prefix', hasToggle: true },
            { label: '@web', value: '@web ', action: 'prefix' },
            { label: '@mcp', value: '@mcp ', action: 'prefix', description: 'Use MCP servers and tools' },
            { label: '@create', value: '@create ', action: 'prefix', description: 'Create files (canvas/excalidraw/markdown)' },
            
            { label: '@webpage', value: '@webpage', action: 'modal', modalType: 'webpage' },
            { label: '@youtube', value: '@youtube', action: 'modal', modalType: 'youtube' }
        ];

        
        const matchingPrefixes = prefixOptions.filter(opt =>
            opt.label.toLowerCase().includes(lowerSearch)
        );

        
        if (matchingPrefixes.length > 0) {
            matchingPrefixes.forEach((opt, index) => {
                const item = createDetached(this.activeDocument, 'div');
                item.className = 'context-file-menu-item';

                
                if ('badge' in opt && opt.badge) {
                    const labelSpan = createDetached(this.activeDocument, 'span');
                    labelSpan.textContent = opt.label;

                    const badgeSpan = createDetached(this.activeDocument, 'span');
                    badgeSpan.className = 'feature-badge beta-badge';
                    badgeSpan.textContent = opt.badge!;
                    badgeSpan.addClass('nl-css-text-remaining-14');

                    item.appendChild(labelSpan);
                    item.appendChild(badgeSpan);
                } else {
                    item.textContent = opt.label;
                }

                
                item.setAttribute('data-option-type', 'prefix');
                item.setAttribute('data-option-value', opt.value);
                item.setAttribute('data-option-action', opt.action);
                if (opt.modalType) {
                    item.setAttribute('data-modal-type', opt.modalType);
                }

                
                if (index === 0) {
                    item.classList.add('selected');
                }

                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.handlePrefixSelection(opt);
                });

                container.appendChild(item);
            });
        }

        
        if (matchingPrefixes.length === 0 && searchTerm.length > 0) {
            const files = this.app.vault.getFiles().filter(file =>
                isExtractable(file.name) || isMultimodalSupported(file.name)
            );
            const matchingFiles = files.filter(file =>
                file.basename.toLowerCase().includes(lowerSearch) ||
                file.path.toLowerCase().includes(lowerSearch)
            ).slice(0, 10); 

            if (matchingFiles.length > 0) {
                const fileHeader = createDetached(this.activeDocument, 'div');
                fileHeader.className = 'context-file-menu-section-header';
                fileHeader.textContent = 'Files';
                container.appendChild(fileHeader);

                matchingFiles.forEach((file, index) => {
                    const item = createDetached(this.activeDocument, 'div');
                    item.className = 'context-file-menu-item';

                    const iconSpan = item.createSpan();
                    setIcon(iconSpan, this.getFileTypeIcon(file.name));
                    item.appendText(` ${file.basename}`);

                    
                    item.setAttribute('data-option-type', 'file');
                    item.setAttribute('data-file-path', file.path);

                    
                    if (index === 0) {
                        item.classList.add('selected');
                        
                        window.setTimeout(() => { this.updateContextMenuPreview(item).catch(console.error); }, 100);
                    }

                    item.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.handleFileSelection(file);
                    });

                    
                    item.addEventListener('mouseenter', () => {
                        
                        const allItems = container.querySelectorAll('.context-file-menu-item');
                        allItems.forEach(i => i.classList.remove('selected'));
                        
                        item.classList.add('selected');
                        
                        this.updateContextMenuPreview(item).catch(console.error);
                    });

                    container.appendChild(item);
                });
            } else {
                const noResults = createDetached(this.activeDocument, 'div');
                noResults.className = 'context-file-menu-item';
                noResults.textContent = 'No matches found';
                noResults.addClass('nl-opacity-05');
                container.appendChild(noResults);
            }
        }
    }

    /**
     * Handles selection of a feature prefix
     * Places prefix at the start of the query
     */
    private handlePrefixSelection(opt: PrefixOption) {
        
        const atIndex = this.contextMenuAtIndex;

        this.closeContextMenu();

        
        if (opt.action === 'modal' && opt.modalType === 'youtube') {
            new YouTubeURLModal(this.app, (url) => {
                void (async () => {
                    this.selectedFiles.add(url);

                    
                    const shouldSaveTranscript = this.settings.saveYoutubeTranscripts ?? true;

                    if (!shouldSaveTranscript) {
                        
                        try {
                            new Notice('Fetching YouTube transcript...');
                            const ytService = new YouTubeChatService(this.settings, this.rateLimitManager);
                            const [transcript, videoTitle] = await Promise.all([
                                ytService.getTranscriptOnly(url),
                                ytService.getVideoTitle(url)
                            ]);

                            
                            this.youtubeTranscriptCache.set(url, { transcript, videoTitle });
                            new Notice('YouTube transcript fetched successfully');
                        } catch (error: unknown) {
                            new Notice(`Failed to fetch transcript: ${error instanceof Error ? error.message : 'Unknown error'}`);
                            
                            this.selectedFiles.delete(url);
                        }
                    }

                    this.renderFileCapsules(this.inputContainer.querySelector('.context-capsule-display') as HTMLElement);
                })();
            }).open();

            
            if (this.queryInput && atIndex !== -1) {
                const value = this.queryInput.value;
                const before = value.substring(0, atIndex);
                
                const afterAt = value.substring(atIndex + 1);
                const spaceIndex = afterAt.search(/\s/);
                const searchEndIndex = spaceIndex === -1 ? value.length : atIndex + 1 + spaceIndex;
                const after = value.substring(searchEndIndex);
                this.queryInput.value = (before + after).trim();
            }
            return;
        }

        
        if (opt.action === 'modal' && opt.modalType === 'webpage') {
            new WebPageURLModal(this.app, (urls) => {
                urls.forEach(url => this.selectedFiles.add(url));
                this.renderFileCapsules(this.inputContainer.querySelector('.context-capsule-display') as HTMLElement);
                new Notice(`${urls.length} web page(s) added to context`);
            }).open();

            
            if (this.queryInput && atIndex !== -1) {
                const value = this.queryInput.value;
                const before = value.substring(0, atIndex);
                
                const afterAt = value.substring(atIndex + 1);
                const spaceIndex = afterAt.search(/\s/);
                const searchEndIndex = spaceIndex === -1 ? value.length : atIndex + 1 + spaceIndex;
                const after = value.substring(searchEndIndex);
                this.queryInput.value = (before + after).trim();
            }
            return;
        }

        
        if (opt.action === 'prefix' && opt.value === '@mcp ') {
            
            if (this.queryInput && atIndex !== -1) {
                const value = this.queryInput.value;
                const before = value.substring(0, atIndex);
                const afterAt = value.substring(atIndex + 1);
                const spaceIndex = afterAt.search(/\s/);
                const searchEndIndex = spaceIndex === -1 ? value.length : atIndex + 1 + spaceIndex;
                const after = value.substring(searchEndIndex);
                this.queryInput.value = (before + after).trim();
            }

            if (!this.settings.mcpEnabled) {
                new Notice('MCP support is disabled. Enable it in settings.');
                return;
            }

            const availableServers = (this.settings.mcpServers || []).filter((s) => !s.disabled);
            if (availableServers.length === 0) {
                new Notice('No MCP servers configured. Please add servers in settings.');
                return;
            }

            const modal = new MCPServerSelectionModal(
                this.app,
                this.plugin.mcpService,
                availableServers,
                (selection) => {
                    
                    this.pendingMCPSelection = selection;
                    
                    const serverNames = selection.selectedServers
                        .map((id: string) => this.settings.mcpServers.find((s) => s.id === id)?.name)
                        .filter(Boolean)
                        .join(', ');
                    const capsuleDisplay = this.inputContainer?.querySelector('.context-capsule-display') as HTMLElement;
                    if (capsuleDisplay) {
                        
                        capsuleDisplay.querySelectorAll('.mcp-capsule').forEach(el => el.remove());
                        const mcpCapsule = capsuleDisplay.createDiv({ cls: 'capsule-file-tag mcp-capsule' });
                        const icon = mcpCapsule.createSpan({ cls: 'capsule-icon' });
                        icon.textContent = '🔌';
                        const label = mcpCapsule.createSpan({ cls: 'capsule-label' });
                        label.textContent = serverNames || 'MCP';
                        mcpCapsule.setAttr('title', `MCP: ${serverNames}`);
                        mcpCapsule.addEventListener('click', () => {
                            mcpCapsule.remove();
                            this.pendingMCPSelection = null;
                            const capsuleContainer = capsuleDisplay.parentElement;
                            if (capsuleContainer?.classList.contains('context-capsule-container') && capsuleDisplay.children.length === 0) {
                                capsuleContainer.classList.remove('has-content');
                            }
                        });
                        
                        const capsuleContainer = capsuleDisplay.parentElement;
                        if (capsuleContainer?.classList.contains('context-capsule-container')) {
                            capsuleContainer.classList.add('has-content');
                        }
                    }
                    this.queryInput.focus();
                },
                this.plugin.settings.mcpAutoConnect ?? true
            );
            modal.open();
            return;
        }

        if (opt.action === 'prefix' && (opt.value === '@vault ' || opt.value === '@flash ' || opt.value === '@web ')) {
            const mode = opt.value.trim();
            
            if (this.queryInput && atIndex !== -1) {
                const value = this.queryInput.value;
                const before = value.substring(0, atIndex);
                const afterAt = value.substring(atIndex + 1);
                const spaceIndex = afterAt.search(/\s/);
                const searchEndIndex = spaceIndex === -1 ? value.length : atIndex + 1 + spaceIndex;
                const after = value.substring(searchEndIndex);
                this.queryInput.value = (before + after).trim();
            }

            const capsuleDisplay = this.inputContainer?.querySelector('.context-capsule-display') as HTMLElement;
            if (capsuleDisplay) {
                if (mode === '@vault' || mode === '@flash') {
                    capsuleDisplay.querySelectorAll('.vault-capsule, .flash-capsule').forEach(el => el.remove());
                    this.activeSearchModes.delete('@vault');
                    this.activeSearchModes.delete('@flash');
                }
                
                if (mode === '@web') {
                    capsuleDisplay.querySelectorAll('.web-capsule').forEach(el => el.remove());
                    this.activeSearchModes.delete('@web');
                }

                this.activeSearchModes.add(mode);
                const modeClass = `${mode.substring(1)}-capsule`;
                
                const capsule = capsuleDisplay.createDiv({ cls: `capsule-file-tag ${modeClass}` });
                const label = capsule.createSpan({ cls: 'capsule-label' });
                label.textContent = mode;
                capsule.setAttr('title', `Search Mode: ${mode}`);
                
                capsule.addEventListener('click', () => {
                    capsule.remove();
                    this.activeSearchModes.delete(mode);
                    const capsuleContainer = capsuleDisplay.parentElement;
                    if (capsuleContainer?.classList.contains('context-capsule-container') && capsuleDisplay.children.length === 0) {
                        capsuleContainer.classList.remove('has-content');
                    }
                });
                
                const capsuleContainer = capsuleDisplay.parentElement;
                if (capsuleContainer?.classList.contains('context-capsule-container')) {
                    capsuleContainer.classList.add('has-content');
                }
            }
            
            this.queryInput.focus();
            this.queryInput.selectionStart = this.queryInput.value.length;
            this.queryInput.selectionEnd = this.queryInput.value.length;
            return;
        }

        
        if (this.queryInput && atIndex !== -1) {
            const value = this.queryInput.value;
            const before = value.substring(0, atIndex);

            
            const afterAt = value.substring(atIndex + 1);
            const spaceIndex = afterAt.search(/\s/);
            const searchEndIndex = spaceIndex === -1 ? value.length : atIndex + 1 + spaceIndex;
            const after = value.substring(searchEndIndex);

            
            const restOfQuery = (before + after).trim();

            
            this.queryInput.value = opt.value + restOfQuery;

            this.queryInput.focus();

            
            this.queryInput.selectionStart = this.queryInput.value.length;
            this.queryInput.selectionEnd = this.queryInput.value.length;
        }
    }

    /**
     * Handles selection of a file
     * Adds file as context capsule and replaces @ with filename inline
     */
    private handleFileSelection(file: TFile) {
        
        const atIndex = this.contextMenuAtIndex;

        this.closeContextMenu();

        
        this.selectedFiles.add(file.path);
        this.renderFileCapsules(this.inputContainer.querySelector('.context-capsule-display') as HTMLElement);

        
        if (this.queryInput && atIndex !== -1) {
            const value = this.queryInput.value;
            const before = value.substring(0, atIndex);

            
            const afterAt = value.substring(atIndex + 1);
            const spaceIndex = afterAt.search(/\s/);
            const searchEndIndex = spaceIndex === -1 ? value.length : atIndex + 1 + spaceIndex;
            const after = value.substring(searchEndIndex);

            
            const newValue = before + `@${file.basename} ` + after;

            this.queryInput.value = newValue;
            this.queryInput.focus();

            
            const newCursorPos = before.length + file.basename.length + 2; 
            this.queryInput.selectionStart = newCursorPos;
            this.queryInput.selectionEnd = newCursorPos;
        }
    }

    /**
     * Updates the preview box for the currently selected file in context menu
     */
    private async updateContextMenuPreview(item: HTMLElement) {
        const optionType = item.getAttribute('data-option-type');

        
        if (optionType !== 'file') {
            if (this.contextMenuPreviewEl) {
                this.contextMenuPreviewEl.addClass('nl-display-none');
            }
            return;
        }

        const filePath = item.getAttribute('data-file-path');
        if (!filePath) return;

        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;

        try {
            
            const content = isExtractable(file.name)
                ? await extractTextFromFile(this.app, file)
                : await this.app.vault.read(file);

            
            if (!this.contextMenuPreviewEl) {
                this.contextMenuPreviewEl = createDetached(this.activeDocument, 'div');
                this.contextMenuPreviewEl.className = 'context-file-preview';
                this.activeDocument.body.appendChild(this.contextMenuPreviewEl);
            }

            
            this.contextMenuPreviewEl.empty();

            
            const header = this.contextMenuPreviewEl.createDiv({ cls: 'context-file-preview-header' });
            header.textContent = file.basename;

            
            const contentDiv = this.contextMenuPreviewEl.createDiv({ cls: 'context-file-preview-content' });
            const lines = content.split('\n').slice(0, 15);
            let previewText = lines.join('\n');

            if (previewText.length > 500) {
                previewText = previewText.substring(0, 500) + '\n\n...';
            } else if (content.split('\n').length > 15) {
                previewText += '\n\n...';
            }

            
            const comp = new Component();
            await MarkdownRenderer.render(
                this.app,
                previewText,
                contentDiv,
                file.path,
                comp
            );
            comp.unload();

            
            if (this.contextMenuEl) {
                const menuRect = this.contextMenuEl.getBoundingClientRect();
                const previewHeight = 250; 

                this.contextMenuPreviewEl.addClass('nl-position-fixed');
                this.contextMenuPreviewEl.setCssProps({ '--preview-left':  `${menuRect.left}px` });
                this.contextMenuPreviewEl.setCssProps({ '--preview-bottom':  `${window.innerHeight - menuRect.top + 8}px` });
                this.contextMenuPreviewEl.setCssProps({ '--preview-width':  `${Math.max(menuRect.width, 400)}px` });
                this.contextMenuPreviewEl.setCssProps({ '--preview-max-height':  `${previewHeight}px` });
                this.contextMenuPreviewEl.addClass('nl-display-block');
            }
        } catch {
                        if (this.contextMenuPreviewEl) {
                this.contextMenuPreviewEl.addClass('nl-display-none');
            }
        }
    }

    private handleContextMenuOutsideClick = (e: MouseEvent) => {
        if (this.contextMenuEl && !this.contextMenuEl.contains(e.target as Node)) {
            this.closeContextMenu();
        }
    };

    private renderContextMenuOptions(container: HTMLElement, filter: string) {
        container.empty();
        const files = Array.from(this.selectedFiles);
        const maxVisible = 3;
        
        if (this.contextMenuOpenFromMore && files.length > maxVisible) {
            const remaining = files.slice(maxVisible);
            const remHeader = createDetached(this.activeDocument, 'div');
            remHeader.className = 'context-file-menu-section-header';
            remHeader.textContent = 'Added files';
            container.appendChild(remHeader);
            remaining.forEach(path => {
                const item = createDetached(this.activeDocument, 'div');
                item.className = 'context-file-menu-item added';

                
                const isYouTubeUrl = /^https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be)\//i.test(path);
                const isWebUrl = /^https?:\/\//.test(path) && !isYouTubeUrl;

                if (isYouTubeUrl) {
                    item.setText('▶️ YouTube');
                } else if (isWebUrl) {
                    try {
                        const url = new URL(path);
                        item.setText(`🌐 ${url.hostname.replace('www.', '')}`);
                    } catch {
                        item.setText('🌐 Web');
                    }
                } else {
                    const file = this.app.vault.getAbstractFileByPath(path);
                    if (!file) return;

                    
                    if (file instanceof TFile) {
                        const iconSpan = item.createSpan();
                        setIcon(iconSpan, this.getFileTypeIcon(file.name));
                        item.appendText(` ${file.basename}`);
                    } else {
                        item.textContent = file.name;
                    }
                }

                item.title = path;
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.selectedFiles.delete(path);
                    this.renderFileCapsules(this.inputContainer.querySelector('.context-capsule-display') as HTMLElement);
                    this.renderContextMenuOptions(container, filter);
                });
                container.appendChild(item);
            });
            
            const divider = createDetached(this.activeDocument, 'div');
            divider.className = 'context-file-menu-divider';
            container.appendChild(divider);
        }
        
        let allFiles = this.app.vault.getFiles();
        if (filter) {
            allFiles = allFiles.filter(f => f.path.toLowerCase().includes(filter.toLowerCase()));
        }
        const recentFiles = allFiles
            .slice()
            .sort((a, b) => b.stat.mtime - a.stat.mtime)
            .slice(0, filter ? allFiles.length : 5); 
        const recHeader = createDetached(this.activeDocument, 'div');
        recHeader.className = 'context-file-menu-section-header';
        recHeader.textContent = 'Recent files';
        container.appendChild(recHeader);
        recentFiles.forEach(file => {
            
            if (this.selectedFiles.has(file.path)) return;
            const item = createDetached(this.activeDocument, 'div');
            item.className = 'context-file-menu-item';
            const iconSpan = item.createSpan();
            setIcon(iconSpan, this.getFileTypeIcon(file.name));
            item.appendText(` ${file.basename}`);
            item.title = file.path;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selectedFiles.add(file.path);
                this.renderFileCapsules(this.inputContainer.querySelector('.context-capsule-display') as HTMLElement);
                this.closeContextMenu();
            });
            container.appendChild(item);
        });
        
        const divider2 = createDetached(this.activeDocument, 'div');
        divider2.className = 'context-file-menu-divider';
        container.appendChild(divider2);
        
        if (!this.contextMenuOpenFromMore) {
            const prefixOptions: PrefixOption[] = [
                { label: '@flash', value: '@flash ', action: 'prefix', description: 'Fast BM25 keyword search', hasToggle: true },
                { label: '@vault', value: '@vault ', action: 'prefix', hasToggle: true },
                { label: '@web', value: '@web ', action: 'prefix' },
                { label: '@mcp', value: '@mcp ', action: 'prefix', description: 'Use MCP servers and tools', hasToggle: true },
                { label: '@create', value: '@create ', action: 'prefix', description: 'Create files (canvas/excalidraw/markdown)' },
                
                { label: '@webpage', value: '@webpage', action: 'modal', modalType: 'webpage' },
                { label: '@youtube', value: '@youtube', action: 'modal', modalType: 'youtube' }
            ];
            prefixOptions.forEach(opt => {
                const item = createDetached(this.activeDocument, 'div');
                item.className = 'context-file-menu-item';

                
                if (opt.hasToggle && opt.value === '@vault ') {
                    const labelSpan = createDetached(this.activeDocument, 'span');
                    labelSpan.textContent = opt.label;
                    item.appendChild(labelSpan);

                    const toggleContainer = createDetached(this.activeDocument, 'div');
                    toggleContainer.className = 'vault-citation-toggle-container';
                    toggleContainer.addClass('nl-css-text-rem-13');

                    
                    const toggleLabel = createDetached(this.activeDocument, 'span');
                    toggleLabel.textContent = 'Citations';
                    toggleLabel.addClass('nl-css-text-rem-14');

                    const toggleSwitch = createDetached(this.activeDocument, 'input');
                    toggleSwitch.type = 'checkbox';
                    toggleSwitch.className = 'vault-citation-toggle';
                    toggleSwitch.checked = this.vaultInlineCitationsEnabled;
                    toggleSwitch.addEventListener('click', (e) => {
                        e.stopPropagation(); 
                    });
                    toggleSwitch.addEventListener('change', (e) => {
                        e.stopPropagation();
                        this.vaultInlineCitationsEnabled = toggleSwitch.checked;
                        new Notice(`Vault citations ${this.vaultInlineCitationsEnabled ? 'enabled' : 'disabled'}`);
                    });

                    toggleContainer.appendChild(toggleLabel);
                    toggleContainer.appendChild(toggleSwitch);
                    item.appendChild(toggleContainer);

                    item.addClass('nl-css-text-rem-15');
                } else if (opt.hasToggle && opt.value === '@flash ') {
                    
                    const labelSpan = createDetached(this.activeDocument, 'span');
                    labelSpan.textContent = opt.label;
                    item.appendChild(labelSpan);

                    const toggleContainer = createDetached(this.activeDocument, 'div');
                    toggleContainer.className = 'flash-citation-toggle-container';
                    toggleContainer.addClass('nl-css-text-rem-16');

                    const toggleLabel = createDetached(this.activeDocument, 'span');
                    toggleLabel.textContent = 'Citations';
                    toggleLabel.addClass('nl-css-text-rem-17');

                    const toggleSwitch = createDetached(this.activeDocument, 'input');
                    toggleSwitch.type = 'checkbox';
                    toggleSwitch.className = 'flash-citation-toggle';
                    toggleSwitch.checked = this.flashInlineCitationsEnabled;
                    toggleSwitch.addEventListener('click', (e) => {
                        e.stopPropagation(); 
                    });
                    toggleSwitch.addEventListener('change', (e) => {
                        e.stopPropagation();
                        this.flashInlineCitationsEnabled = toggleSwitch.checked;
                        new Notice(`Flash citations ${this.flashInlineCitationsEnabled ? 'enabled' : 'disabled'}`);
                    });

                    toggleContainer.appendChild(toggleLabel);
                    toggleContainer.appendChild(toggleSwitch);
                    item.appendChild(toggleContainer);

                    item.addClass('nl-css-text-rem-18');
                    /* TEMPORARILY DISABLED - @agent mode
                    } else if (opt.hasToggle && opt.value === '@agent ') {
                        
                        const labelContainer = this.activeDocument.createElement('div');
                        labelContainer.addClass('nl-css-text-rem-19');
                        
                        const labelSpan = this.activeDocument.createElement('span');
                        labelSpan.textContent = opt.label;
                        labelContainer.appendChild(labelSpan);
                        
                        
                        if (opt.badge) {
                            const badgeSpan = this.activeDocument.createElement('span');
                            badgeSpan.className = 'feature-badge beta-badge';
                            badgeSpan.textContent = opt.badge;
                            badgeSpan.addClass('nl-css-text-rem-20');
                            labelContainer.appendChild(badgeSpan);
                        }
                        
                        item.appendChild(labelContainer);
                        
                        const toggleContainer = this.activeDocument.createElement('div');
                        toggleContainer.className = 'agent-ratelimit-toggle-container';
                        toggleContainer.addClass('nl-css-text-rem-21');
                        
                        const toggleLabel = this.activeDocument.createElement('span');
                        toggleLabel.textContent = 'Rate Limit';
                        toggleLabel.addClass('nl-css-text-rem-22');
                        
                        const toggleSwitch = this.activeDocument.createElement('input');
                        toggleSwitch.type = 'checkbox';
                        toggleSwitch.className = 'agent-ratelimit-toggle';
                        toggleSwitch.checked = this.agentRateLimitEnabled;
                        toggleSwitch.addEventListener('click', (e) => {
                            e.stopPropagation(); 
                        });
                        toggleSwitch.addEventListener('change', (e) => {
                            e.stopPropagation();
                            this.agentRateLimitEnabled = toggleSwitch.checked;
                            new Notice(`Rate limiting ${this.agentRateLimitEnabled ? 'enabled' : 'disabled'} for Agent`);
                        });
                        
                        toggleContainer.appendChild(toggleLabel);
                        toggleContainer.appendChild(toggleSwitch);
                        item.appendChild(toggleContainer);
                        
                        item.addClass('nl-css-text-rem-23');
                    */ 
                } else if (opt.hasToggle && opt.value === '@mcp ') {
                    
                    const labelSpan = createDetached(this.activeDocument, 'span');
                    labelSpan.textContent = opt.label;
                    item.appendChild(labelSpan);

                    const toggleContainer = createDetached(this.activeDocument, 'div');
                    toggleContainer.className = 'mcp-ratelimit-toggle-container';
                    toggleContainer.addClass('nl-css-text-rem-24');

                    const toggleLabel = createDetached(this.activeDocument, 'span');
                    toggleLabel.textContent = 'Delay Limit';
                    toggleLabel.addClass('nl-css-text-rem-25');

                    const toggleSwitch = createDetached(this.activeDocument, 'input');
                    toggleSwitch.type = 'checkbox';
                    toggleSwitch.className = 'mcp-ratelimit-toggle';
                    toggleSwitch.checked = this.mcpRateLimitEnabled;
                    toggleSwitch.addEventListener('click', (e) => {
                        e.stopPropagation(); 
                    });
                    toggleSwitch.addEventListener('change', (e) => {
                        e.stopPropagation();
                        this.mcpRateLimitEnabled = toggleSwitch.checked;
                        new Notice(`Rate limiting ${this.mcpRateLimitEnabled ? 'enabled' : 'disabled'} for MCP`);
                    });

                    toggleContainer.appendChild(toggleLabel);
                    toggleContainer.appendChild(toggleSwitch);
                    item.appendChild(toggleContainer);

                    item.addClass('nl-css-text-remaining-17');
                } else {
                    item.textContent = opt.label;
                }

                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.closeContextMenu();

                    
                    if (opt.action === 'modal' && opt.modalType === 'youtube') {
                        new YouTubeURLModal(this.app, (url) => {
                            this.selectedFiles.add(url);
                            this.renderFileCapsules(this.inputContainer.querySelector('.context-capsule-display') as HTMLElement);
                            new Notice('YouTube video added to context');
                        }).open();
                        return;
                    }

                    
                    if (opt.action === 'modal' && opt.modalType === 'webpage') {
                        new WebPageURLModal(this.app, (urls) => {
                            urls.forEach(url => this.selectedFiles.add(url));
                            this.renderFileCapsules(this.inputContainer.querySelector('.context-capsule-display') as HTMLElement);
                            new Notice(`${urls.length} web page(s) added to context`);
                        }).open();
                        return;
                    }

                    
                    if (opt.action === 'prefix' && opt.value === '@mcp ') {
                        if (!this.settings.mcpEnabled) {
                            new Notice('MCP support is disabled. Enable it in settings.');
                            return;
                        }
const availableServers = (this.settings.mcpServers || []).filter((s) => !s.disabled);
                        if (availableServers.length === 0) {
                            new Notice('No MCP servers configured. Please add servers in settings.');
                            return;
                        }
                        const modal = new MCPServerSelectionModal(
                            this.app,
                            this.plugin.mcpService,
                            availableServers,
                            (selection) => {
                                this.pendingMCPSelection = selection;
                                const serverNames = selection.selectedServers
.map((id: string) => this.settings.mcpServers.find((s) => s.id === id)?.name)
                                    .filter(Boolean)
                                    .join(', ');
                                const capsuleDisplay = this.inputContainer?.querySelector('.context-capsule-display') as HTMLElement;
                                if (capsuleDisplay) {
                                    capsuleDisplay.querySelectorAll('.mcp-capsule').forEach(el => el.remove());
                                    const mcpCapsule = capsuleDisplay.createDiv({ cls: 'capsule-file-tag mcp-capsule' });
                                    const icon = mcpCapsule.createSpan({ cls: 'capsule-icon' });
                                    icon.textContent = '🔌';
                                    const label = mcpCapsule.createSpan({ cls: 'capsule-label' });
                                    label.textContent = serverNames || 'MCP';
                                    mcpCapsule.setAttr('title', `MCP: ${serverNames}`);
                                    mcpCapsule.addEventListener('click', () => {
                                        mcpCapsule.remove();
                                        this.pendingMCPSelection = null;
                                        const capsuleContainer = capsuleDisplay.parentElement;
                                        if (capsuleContainer?.classList.contains('context-capsule-container') && capsuleDisplay.children.length === 0) {
                                            capsuleContainer.classList.remove('has-content');
                                        }
                                    });
                                    const capsuleContainer = capsuleDisplay.parentElement;
                                    if (capsuleContainer?.classList.contains('context-capsule-container')) {
                                        capsuleContainer.classList.add('has-content');
                                    }
                                }
                                this.queryInput.focus();
                            },
                            this.plugin.settings.mcpAutoConnect ?? true
                        );
                        modal.open();
                        return;
                    }

                    if (opt.action === 'prefix' && (opt.value === '@vault ' || opt.value === '@flash ' || opt.value === '@web ')) {
                        this.handlePrefixSelection(opt);
                        return;
                    }

                    
                    if (this.queryInput) {
                        if (opt.value === '!') {
                            this.queryInput.value = '!' + this.queryInput.value;
                        } else {
                            this.queryInput.value = opt.value + this.queryInput.value;
                        }
                        this.queryInput.focus();
                    }
                });
                container.appendChild(item);
            });
        }
    }

    /**
     * Get file type icon based on file extension using Obsidian's icon system
     */
    private getFileTypeIcon(fileName: string): string {
        const extension = fileName.split('.').pop()?.toLowerCase() || '';

        
        const iconMap: { [key: string]: string } = {
            
            'pdf': 'file-text',

            
            'doc': 'file-text',
            'docx': 'file-text',
            'txt': 'file-text',
            'rtf': 'file-text',

            
            'xlsx': 'sheet',
            'xls': 'sheet',
            'csv': 'sheet',
            'ods': 'sheet',

            
            'ppt': 'presentation',
            'pptx': 'presentation',
            'odp': 'presentation',

            
            'png': 'image',
            'jpg': 'image',
            'jpeg': 'image',
            'gif': 'image',
            'bmp': 'image',
            'svg': 'image',
            'webp': 'image',
            'tiff': 'image',
            'ico': 'image',
            'heic': 'image',
            'heif': 'image',

            
            'mp3': 'audio-file',
            'wav': 'audio-file',
            'flac': 'audio-file',
            'aac': 'audio-file',
            'm4a': 'audio-file',
            'ogg': 'audio-file',

            
            'mp4': 'video',
            'avi': 'video',
            'mkv': 'video',
            'mov': 'video',
            'wmv': 'video',
            'flv': 'video',
            'webm': 'video',

            
            'js': 'code',
            'ts': 'code',
            'py': 'code',
            'java': 'code',
            'cpp': 'code',
            'c': 'code',
            'html': 'code',
            'css': 'code',
            'json': 'code',
            'xml': 'code',
            'yml': 'code',
            'yaml': 'code',

            
            'zip': 'archive',
            'rar': 'archive',
            '7z': 'archive',
            'tar': 'archive',
            'gz': 'archive',

            
            'md': 'document',
            'markdown': 'document',

            
            'default': 'file'
        };

        return iconMap[extension] || iconMap['default'];
    }

    /**
     * Show multi-trigger examples modal
     */
    private showMultiTriggerExamples() {
        const modal = new Modal(this.app);
        modal.titleEl.setText('Multi-Trigger Query Examples');

        const { contentEl } = modal;
        contentEl.addClass('multi-trigger-examples-modal');

        const intro = contentEl.createDiv({ cls: 'examples-intro' });
        intro.createEl('p', { 
            text: 'You can combine multiple triggers in a single query to orchestrate complex workflows. The AI will execute them intelligently in sequence.',
            cls: 'nl-margin-bottom-16px nl-color-var--text-muted'
        });

        const examples = [
            {
                title: '📚 Research → Synthesize → Document',
                query: '@vault search AI models @web recent developments in AI @create comprehensive document',
                description: 'Search your vault, find recent web information, and create a comprehensive document with all findings.'
            },
            {
                title: '🔍 Multi-Source Investigation',
                query: '@vault machine learning notes @web latest ML breakthroughs 2024 provide detailed comparison',
                description: 'Gather information from your personal notes and the web, then synthesize a detailed comparison.'
            },
            {
                title: '✏️ Smart File Editing',
                query: '@vault meeting notes @create summary with action items',
                description: 'Create a structured summary from your meeting notes with clear action items.'
            },
            {
                title: '📝 Comprehensive Knowledge Base',
                query: '@vault quantum computing @web quantum computing breakthroughs @create detailed reference document in folder "Research"',
                description: 'Combine vault knowledge and web research to create a comprehensive reference document in a specific folder.'
            },
            {
                title: '🎯 Deep Multi-Source Research',
                query: '@vault neural networks history @web current deep learning trends @create comprehensive analysis with timeline',
                description: 'Use vault and web sources together for thorough research.'
            }
        ];

        examples.forEach(example => {
            const exampleCard = contentEl.createDiv({ cls: 'example-card' });

            const titleEl = exampleCard.createDiv({ cls: 'example-card-title' });
            titleEl.createEl("strong", { text: example.title });

            const descEl = exampleCard.createDiv({ cls: 'example-desc' });
            descEl.textContent = example.description;

            const queryEl = exampleCard.createDiv({ cls: 'example-query' });
            queryEl.textContent = example.query;
            queryEl.title = 'Click to use this example';

            queryEl.addEventListener('click', () => {
                this.queryInput.value = example.query;
                this.queryInput.focus();
                modal.close();
                new Notice('Example loaded! Press Enter to execute.');
            });
        });

        const footer = contentEl.createDiv({ cls: 'examples-footer' });
                const tipsTitle = footer.createEl("p"); tipsTitle.createEl("strong", { text: "💡 Tips:" }); const tipsList = footer.createEl("ul", { cls: "tips-list" }); tipsList.createEl("li", { text: "Triggers execute in intelligent order: data gathering → processing → actions" }); tipsList.createEl("li", { text: "Results from each trigger are shared with subsequent triggers" }); tipsList.createEl("li", { text: "You can use the same trigger multiple times if needed" }); tipsList.createEl("li", { text: "Watch the live timeline to see progress for each step" });

        modal.open();
    }

    private async openSessionHistoryModal() {
        this.sessionHistoryModal = openSessionHistoryModal({
            app: this.app,
            aiChatSessionManager: this.aiChatSessionManager,
            activeViewType: 'chat',
            onLoadChatSession: async (id) => {
                await this.loadAIChatSession(id);
            },
            onLoadAgentSession: async (id) => {
                await this.loadAIChatSession(id);
            },
        });
    }

    private openSystemInstructionsModal() {
        new SystemInstructionsModal(
            this.app,
            this.currentSystemInstructions,
            this.settings,
            async () => await this.plugin.saveSettings(),
            (instructions: string, icon?: string) => {
                this.currentSystemInstructions = instructions;
                
                const btn = $q<HTMLElement>(this.containerEl, '.header-system-instructions-btn');
                if (btn) {
                    if (instructions) {
                        btn.addClass('has-instructions');
                        
                        if (icon) {
                            btn.empty();
                            setIcon(btn, icon);
                            btn.setAttribute('data-collection-icon', icon);
                        } else {
                            
                            btn.removeAttribute('data-collection-icon');
                            setIcon(btn, 'wrench');
                        }
                    } else {
                        btn.removeClass('has-instructions');
                        btn.removeAttribute('data-collection-icon');
                        setIcon(btn, 'wrench');
                    }
                }
                
                if (this.currentSessionId) {
                    void this.saveCurrentSession();
                }
                new Notice(instructions ? 'System instructions saved' : 'System instructions cleared');
            }
        ).open();
    }

    private async loadAIChatSession(sessionId: string) {
        // Cross-view guardrail: block if the session is open in an Agent view
        const agentLeaves = this.app.workspace.getLeavesOfType('NEXUS_LM_AGENT');
        for (const leaf of agentLeaves) {
            const view = leaf.view as { currentSessionId?: string | null } | null;
            if (view?.currentSessionId === sessionId) {
                new Notice('This session is already open in the Agent view.');
                return;
            }
        }

        const existingLeaf = this.findLeafWithSession(sessionId);
        if (existingLeaf && existingLeaf !== this.leaf) {
            
            this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
            new Notice('This chat session is already open in another tab');
            return;
        }

        const session = await this.aiChatSessionManager.loadSession(sessionId);
        if (session) {

            this.responses = session.messages.map((m) => {
                return {
                question: m.question,
                answer: m.answer,
                context: m.context || [],
                timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
                sources: m.sources || [],
                webResults: (m.webResults || []) as unknown as WebSearchResult[],


                id: m.id,
                sessionId: m.sessionId,
                fileActionIds: m.fileActionIds,
                fileActionData: m.fileActionData as { [actionId: string]: FileActionData } | undefined,

                modelName: m.modelName,
                totalTokens: m.totalTokens,
                responseTimeMs: m.responseTimeMs,

                agentSteps: m.agentSteps,
                isAgentResponse: m.isAgentResponse,
                vaultAnswer: m.vaultAnswer,
                vaultResults: m.vaultResults,


                fileOperations: m.fileOperations || [],

                mcpTools: (m.mcpTools || []) as Response['mcpTools'],

                searchMode: m.searchMode as Response['searchMode'],

                vaultIndexName: m.vaultIndexName,

                summary: m.summary,
                keywords: m.keywords,
                lessons: m.lessons,
                importance: m.importance,
                stepsCount: m.stepsCount,
                success: m.success,
                artifacts: m.artifacts
            }});

            this.currentSessionId = sessionId;
            this.currentSessionType = session.sessionType ?? (session.messages?.some(m => m.isAgentResponse) ? 'agent' : 'chat');
            this.currentSessionCreatedAt = session.createdAt || Date.now();

            
            this.updateContextBar();

            
            this.currentSystemInstructions = session.systemInstructions || '';
            
            const btn = $q<HTMLElement>(this.containerEl, '.header-system-instructions-btn');
            if (btn) {
                if (this.currentSystemInstructions) {
                    btn.addClass('has-instructions');
                    
                    const matchedItem = this.settings.savedSystemInstructions?.find(
                        (s: { name: string; instructions: string; icon?: string }) => s.instructions === this.currentSystemInstructions
                    );
                    if (matchedItem?.icon) {
                        btn.empty();
                        setIcon(btn, matchedItem.icon);
                        btn.setAttribute('data-collection-icon', matchedItem.icon);
                    } else {
                        
                        btn.removeAttribute('data-collection-icon');
                        setIcon(btn, 'wrench');
                    }
                } else {
                    btn.removeClass('has-instructions');
                    btn.removeAttribute('data-collection-icon');
                    setIcon(btn, 'wrench');
                }
            }

            
            this.activeFileActions.clear();

            
            if (this.contentContainer) {
                this.contentContainer.empty();
                this.renderingRestoredSession = true;
                this.responses.forEach((r, index) => {
                    this.renderRestoredResponse(r);
                });
                this.renderingRestoredSession = false;
                this.updateNavRail();
                this.updateJumpButton();
            }
        } else {
            // No action needed for this case
        }
    }


    private renderRestoredResponse(r: Response) {
        const responseEl = this.contentContainer.createDiv({ cls: 'response-item' });

        
        if (this.settings.chatWallpaperEnabled && this.settings.chatWallpaperPath) {
            responseEl.classList.add('liquid-glass-active');
        }

        
        const questionEl = responseEl.createDiv({ cls: 'response-question' });
        
        
        if (this.settings.chatWallpaperEnabled && this.settings.chatWallpaperPath) {
            questionEl.classList.add('liquid-glass-active');
        }
        
        const questionSpan = questionEl.createSpan();
        questionSpan.textContent = r.question;
        questionSpan.classList.add('user-question-dynamic-color');
        this.createQuestionActions(questionEl, r.question);

        
        const answerEl = responseEl.createDiv({ cls: 'response-answer' });

        
        if (r.fileActionIds && r.fileActionIds.length > 0) {

            
            const messageEl = answerEl.createDiv({ cls: 'ai-message' });
            void MarkdownRenderer.render(this.app, r.answer, messageEl, '', this);

            
            const capsulesContainer = answerEl.createDiv({ cls: 'file-action-capsules' });

            
            for (const actionId of r.fileActionIds) {
                this.restoreFileActionCapsule(actionId, capsulesContainer, r);
            }
        } else {
            
            void MarkdownRenderer.render(this.app, r.answer, answerEl, '', this);
            
            this.wrapTablesInScrollContainers(answerEl);
            
            this.enableMarkdownInteractivity(answerEl);
            
            this.enhanceCodeBlocks(answerEl, r.question);
        }

        
        if (r.sources && r.sources.length > 0) {
            this.addSourcesToResponseElement(responseEl, r.sources);
        }

        
        if (r.webResults && r.webResults.length > 0) {
            this.addWebResultsToResponseElement(responseEl, r.webResults);
        }

        
        if (r.mcpTools && r.mcpTools.length > 0) {
            this.addMCPToolsToResponseElement(responseEl, r.mcpTools);
        }

        
        this.addResponseMetadata(responseEl, r);

        this.createResponseActions(responseEl, r.question, r.answer);
    }


    private restoreFileActionCapsule(actionId: string, container: HTMLElement, response: Response) {

        
        const savedActionData = response.fileActionData?.[actionId] as FileActionSaveData | undefined;

        
        let type: 'edit' | 'create' = savedActionData?.type || 'create';
        let fileName = savedActionData?.fileName || 'Unknown File';

        
        if (!savedActionData) {
            const isCreate = response.question.includes('create') || response.question.startsWith('@create') || response.question.toLowerCase().includes('file');

            if (isCreate) {
                type = 'create';
                const folderMatch = response.question.match(/folder["\s]+([^"]+)/i) ||
                    response.question.match(/in\s+([A-Za-z\s]+)/i);
                fileName = folderMatch ? folderMatch[1].trim() : 'New Files';
            }
        }

        
        const capsule = container.createDiv({ cls: `file-action-capsule ${type}-capsule historical` });

        
        const actionState: FileActionState = {
            id: actionId,
            type: type,
            fileName: fileName,
            status: (savedActionData?.status || 'completed') as FileActionState['status'],
            element: capsule,
            data: savedActionData ? this.reconstructActionData(savedActionData) || undefined : undefined,
            isApplied: savedActionData?.isApplied || false,
            originalFileContent: savedActionData?.editData?.originalContent
        };

        this.activeFileActions.set(actionId, actionState);

        
        const icon = capsule.createDiv({ cls: 'file-action-icon' });
        setIcon(icon, type === "edit" ? "edit" : "file-plus");

        
        const nameEl = capsule.createDiv({ cls: 'file-action-name' });
        nameEl.textContent = fileName;

        
        const statusEl = capsule.createDiv({ cls: 'file-action-status historical' });

        
        const acceptBtn = statusEl.createDiv({ cls: 'file-action-btn accept-btn' });
        setIcon(acceptBtn, "check");
        acceptBtn.title = 'Recreate/Reapply this action';

        const rejectBtn = statusEl.createDiv({ cls: 'file-action-btn reject-btn' });
        setIcon(rejectBtn, "x");
        rejectBtn.title = 'Mark as rejected';

        
        actionState.status = 'completed';

        acceptBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void this.handleHistoricalFileAction(actionId, 'accept', response);
        });

        rejectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void this.handleHistoricalFileAction(actionId, 'reject', response);
        });

        
        capsule.addEventListener('click', () => {
            this.openFileActionModal(actionId);
        });

        
        capsule.addClass('nl-display-flex');
    }

    private reconstructActionData(savedActionData: FileActionSaveData): FileActionResult | null {
        if (savedActionData.type === 'edit' && savedActionData.editData) {
            const editData = savedActionData.editData;
            const filePath = editData.filePath;
            const file = filePath ? this.app.vault.getAbstractFileByPath(filePath) : null;

            return {
                type: 'edit',
                editData: {
                    filePath: filePath,
                    originalContent: editData.originalContent || '',
                    editedContent: editData.editedContent || '',
                    editPrompt: editData.editPrompt || ''
                },
                file: file || { path: filePath, basename: filePath?.split('/').pop() || 'Unknown' },
                originalContent: editData.originalContent || '',
                editedContent: editData.editedContent || '',
                editPrompt: editData.editPrompt || ''
            };
        } else if (savedActionData.type === 'create' && savedActionData.createData) {
            const createData = savedActionData.createData;
            return {
                type: 'create',
                createData: {
                    folderName: createData.folderName || 'New Files',
                    creationPrompt: createData.creationPrompt || '',
                    files: Array.isArray(createData.files) ? createData.files : []
                },
                folderName: createData.folderName || 'New Files',
                creationPrompt: createData.creationPrompt || '',
                files: Array.isArray(createData.files) ? createData.files : []
            };
        }
        return null;
    }

    private async handleHistoricalFileAction(actionId: string, action: 'accept' | 'reject', response: Response) {
        const actionState = this.activeFileActions.get(actionId);
        if (!actionState) return;

        if (action === 'accept') {
            
            if (actionState.isApplied) {
                new Notice(`Action already applied for "${actionState.fileName}"`);
                return;
            }

            
            if (actionState.type === 'create') {
                
                const creationPrompt = response.question.replace(/^@create\s*/, '').trim() || response.question;

                
                const folderMatch = response.question.match(/folder["\s]+([^"]+)/i) ||
                    response.question.match(/in\s+([A-Za-z\s]+)/i);
                const targetFolder = folderMatch ? folderMatch[1].trim() : undefined;

                
                actionState.status = 'processing';
                this.updateFileActionButtons(actionId);

                
                void this.processFileCreate(actionId, creationPrompt, targetFolder, []);

                new Notice(`Recreating files based on: "${response.question.substring(0, 50)}..."`);

                
                

            }
        } else if (action === 'reject') {
            
            if (actionState.isApplied) {
                if (actionState.type === 'create' && actionState.data) {
                    
                    try {
                        await this.deleteFilesFromPlan(actionState.data as FileCreationPlan);
                        actionState.isApplied = false;
                        new Notice(`Deleted created files from "${actionState.data.folderName}". Click accept to recreate.`);
                    } catch (err) {
                        new Notice('Error deleting files: ' + (err instanceof Error ? err.message : String(err)));
                        return;
                    }
                }
            }

            
            actionState.status = 'rejected';
            if (actionState.element) {
                actionState.element.classList.remove('accepted');
                actionState.element.classList.add('rejected');
            }

            if (!actionState.isApplied) {
                new Notice(`Action rejected for "${actionState.fileName}"`);
            }

            
            this.updateFileActionButtons(actionId);
        }
    }

    async onClose() {
        
        await this.saveCurrentSession();
        this.currentSessionId = null;
    }

    
    createFileActionCapsule(type: 'edit' | 'create', fileName: string, data?: FileActionResult): string {
        const actionId = `file-action-${++this.fileActionCounter}`;

        const actionState: FileActionState = {
            id: actionId,
            type,
            fileName,
            status: 'processing',
            element: null as unknown as HTMLElement,
            data
        };

        this.activeFileActions.set(actionId, actionState);
        return actionId;
    }

    addFileActionToChat(actionId: string, message: string) {
        const actionState = this.activeFileActions.get(actionId);
        if (!actionState) return;

        
        const responseContainer = this.contentContainer.createDiv({ cls: 'ai-response-container' });

        
        const messageEl = responseContainer.createDiv({ cls: 'ai-message' });
        void MarkdownRenderer.render(this.app, message, messageEl, '', this);

        
        const capsulesContainer = responseContainer.createDiv({ cls: 'file-action-capsules' });

        
        const capsule = capsulesContainer.createDiv({ cls: `file-action-capsule ${actionState.type}-capsule` });
        actionState.element = capsule;

        
        const icon = capsule.createDiv({ cls: 'file-action-icon' });
        setIcon(icon, actionState.type === 'edit' ? 'edit' : 'file-plus');

        
        const nameEl = capsule.createDiv({ cls: 'file-action-name' });
        if (actionState.fileName && actionState.fileName.includes('[[') && actionState.fileName.includes(']]')) {
            void MarkdownRenderer.render(this.app, actionState.fileName, nameEl, '', this);
        } else {
            nameEl.textContent = actionState.fileName;
        }

        capsule.createDiv({ cls: 'file-action-status' });


        
        capsule.createDiv({ cls: 'file-action-status' });
        this.updateFileActionStatus(actionId, 'processing');

        
        capsule.addEventListener('click', () => {
            this.openFileActionModal(actionId);
        });

        
        this.contentContainer.scrollTop = this.contentContainer.scrollHeight;
    }

    updateFileActionStatus(actionId: string, status: 'processing' | 'completed' | 'failed' | 'accepted' | 'rejected', error?: string) {
        const actionState = this.activeFileActions.get(actionId);
        if (!actionState) return;

        actionState.status = status;
        if (error) actionState.error = error;

        
        if (!actionState.element) return;

        const statusEl = actionState.element.querySelector('.file-action-status') as HTMLElement;
        if (!statusEl) return;

        statusEl.empty();

        switch (status) {
            case 'processing':
                statusEl.createDiv({ cls: 'file-action-spinner' });
                statusEl.className = 'file-action-status processing';
                break;
            case 'completed':
            case 'accepted':
            case 'rejected':
                
                this.updateFileActionButtons(actionId);
                actionState.element.classList.add('clickable');
                break;
            case 'failed':
                statusEl.createDiv({ cls: "file-action-error", text: "⚠️", attr: { title: error || "Failed" } });
                statusEl.className = 'file-action-status failed';
                break;
        }
    }

    openFileActionModal(actionId: string) {
        const actionState = this.activeFileActions.get(actionId);
        if (!actionState) {
                        new Notice('Cannot open modal: action not found');
            return;
        }

        
        if (!actionState.data) {
            new Notice(`${actionState.type === 'edit' ? 'Edit' : 'Create'} data not available. Please regenerate the action by clicking Accept.`);
            return;
        }

        if (actionState.type === 'create') {
            const data = actionState.data;
            const isCanvas = data && data.nodes && data.edges;
            const isExcalidraw = actionState.isExcalidraw;

            
            if (!isCanvas && !isExcalidraw && (!data.folderName || !Array.isArray(data.files))) {
                                new Notice('Error: Invalid file creation plan. Cannot open create modal.');
                return;
            }

            
            import('../tools/fileCreateTool').then(mod => {
                if (mod.FileCreationReviewModal) {
                    try {
                        new mod.FileCreationReviewModal(this.app, data as unknown as FileCreationPlan, this.plugin.settings, (acceptedPlan: unknown) => {
                            void this.acceptFileAction(actionId, acceptedPlan as FileActionResult);
                        }).open();
                    } catch (modalError) {
                                                new Notice('Failed to create create modal: ' + (modalError instanceof Error ? modalError.message : 'Unknown error'));
                    }
                } else {
                                        new Notice('Create modal not available. Please accept or reject the changes.');
                }
            }).catch(() => {
                                new Notice('Failed to open create modal. Please accept or reject the changes.');
            });
        }
    }

    async acceptFileAction(actionId: string, data?: FileActionResult) {
        const actionState = this.activeFileActions.get(actionId);
        if (!actionState) return;

        
        if (actionState.isApplied) {
            new Notice(`Action already applied for "${actionState.fileName}"`);
            return;
        }

        
        actionState.status = 'accepted';
        if (actionState.element) {
            actionState.element.classList.remove('rejected');
            actionState.element.classList.add('accepted');
        }

        
        if (actionState.type === 'create' && (data || actionState.data)) {
            const plan = data || actionState.data;

            
            if (!actionState.data || data) {
                actionState.data = plan;
            }

            try {
                
                if (plan && plan.nodes && Array.isArray(plan.nodes)) {
                    
                    const targetFolder = plan.folderName || 'New Files';
                    await this.createCanvasFile(targetFolder, plan as CanvasData);
                    actionState.isApplied = true;
                    new Notice(`Created canvas file in folder: ${targetFolder}`);
                } else if (actionState.isExcalidraw || (plan && plan.type === 'excalidraw')) {
                    
                    const targetFolder = actionState.fileName || 'New Files';
                    await this.createExcalidrawFile(targetFolder, plan as ExcalidrawData);
                    actionState.isApplied = true;
                    new Notice(`Created Excalidraw diagram in folder: ${targetFolder}`);
                } else {
                    
                    await this.createFilesFromPlan(plan as FileCreationPlan);
                    actionState.isApplied = true;
                    new Notice(`Created ${plan?.files?.length || 0} file(s) in folder: ${plan?.folderName || 'Unknown'}. Click reject to delete.`);
                }
            } catch (err) {
                new Notice('Error creating files: ' + (err instanceof Error ? err.message : String(err)));
                return;
            }
        }

        
        this.updateFileActionButtons(actionId);

        
        await this.saveCurrentSession();
    }

    async rejectFileAction(actionId: string) {
            const actionState = this.activeFileActions.get(actionId);
            if (!actionState) return;

            
            if (actionState.isApplied) {
                if (actionState.type === 'create' && actionState.data) {
                    try {
                        
                        if (actionState.data && actionState.data.nodes && Array.isArray(actionState.data.nodes)) {
                            
                            const folderPath = actionState.data.folderName || 'New Files';
                            await this.deleteCanvasFile(folderPath);
                            actionState.isApplied = false;
                            new Notice(`Deleted canvas file from "${folderPath}". Click accept to recreate.`);
                        } else if (actionState.isExcalidraw || (actionState.data && actionState.data.type === 'excalidraw')) {
                            
                            const folderPath = actionState.fileName || 'New Files';
                            await this.deleteExcalidrawFile(folderPath);
                            actionState.isApplied = false;
                            new Notice(`Deleted Excalidraw file from "${folderPath}". Click accept to recreate.`);
                        } else {
                            
                        await this.deleteFilesFromPlan(actionState.data as FileCreationPlan);
                            actionState.isApplied = false;
                            new Notice(`Deleted created files from "${actionState.data.folderName}". Click accept to recreate.`);
                        }
                    } catch (err) {
                        new Notice('Error deleting files: ' + (err instanceof Error ? err.message : String(err)));
                        return;
                    }
                }
            }

            
            actionState.status = 'rejected';
            if (actionState.element) {
                actionState.element.classList.remove('accepted');
                actionState.element.classList.add('rejected');
            }

            if (!actionState.isApplied) {
                new Notice(`Action rejected for "${actionState.fileName}"`);
            }

            
            this.updateFileActionButtons(actionId);

            
            await this.saveCurrentSession();
        }

    private async deleteCanvasFile(folderPath: string): Promise<void> {
        
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) return;

        const files = this.app.vault.getFiles();
        for (const file of files) {
            if (file.path.startsWith(folderPath) && file.extension === 'canvas') {
                await this.app.fileManager.trashFile(file);
                break; 
            }
        }
    }

    private async deleteExcalidrawFile(folderPath: string): Promise<void> {
        
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) return;

        const files = this.app.vault.getFiles();
        for (const file of files) {
            if (file.path.startsWith(folderPath) && file.extension === 'md' && file.basename.includes('diagram')) {
                await this.app.fileManager.trashFile(file);
                break;
            }
        }
    }

    private updateFileActionButtons(actionId: string) {
        const actionState = this.activeFileActions.get(actionId);
        if (!actionState) return;

        
        if (!actionState.element) return;

        const statusEl = actionState.element.querySelector('.file-action-status') as HTMLElement;
        if (!statusEl) return;

        statusEl.empty();

        
        const acceptBtn = statusEl.createDiv({ cls: 'file-action-btn accept-btn' });
        setIcon(acceptBtn, "check");
        acceptBtn.title = actionState.status === 'accepted' ? 'Reapply' : 'Accept';

        const rejectBtn = statusEl.createDiv({ cls: 'file-action-btn reject-btn' });
        setIcon(rejectBtn, "x");
        rejectBtn.title = actionState.status === 'rejected' ? 'Keep Rejected' : 'Reject/Undo';

        
        if (actionState.status === 'accepted') {
            acceptBtn.classList.add('active');
            rejectBtn.classList.remove('active');
        } else if (actionState.status === 'rejected') {
            acceptBtn.classList.remove('active');
            rejectBtn.classList.add('active');
        }

        acceptBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void this.acceptFileAction(actionId);
        });

        rejectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void this.rejectFileAction(actionId);
        });

        statusEl.className = `file-action-status ${actionState.status}`;
    }

    private async deleteFilesFromPlan(plan: FileCreationPlan): Promise<void> {
        if (!plan || !plan.folderName || !Array.isArray(plan.files)) {
            throw new Error('Invalid file creation plan for deletion');
        }

        
        for (const fileInfo of plan.files) {
            if (!fileInfo.name) continue;

            const fileName = `${fileInfo.name}.${fileInfo.extension || 'md'}`;
            const filePath = normalizePath(`${plan.folderName}/${fileName}`);

            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file) {
                await this.app.fileManager.trashFile(file);
            }
        }

        
        try {
            const abstractFile = this.app.vault.getAbstractFileByPath(plan.folderName);
            if (abstractFile instanceof TFolder) {
                const folder = abstractFile;
                const folderChildren = folder.children;
                if (folderChildren && folderChildren.length === 0) {
                    await this.app.fileManager.trashFile(folder);
                }
            }
        } catch {
            // Vault operation failed - safe to ignore
        }
    }

    async processFileCreate(actionId: string, prompt: string, targetFolder?: string, contextFiles: ContextFile[] = [], autoSelectedModel: ModelSelection | null = null) {
        try {
            const actionState = this.activeFileActions.get(actionId);
            if (!actionState) return;

            const chatHistory = this.getChatHistory();

            
            const context = {
                userPrompt: prompt,
                targetFolder,
                contextFiles,
                webSearchEnabled: this.webEnabled,
                webSearchService: this.webSearchService,
                settings: this.settings,
                chatHistory
            };

            
            const initialPlan = await this.executeWithFallback(
                async () => await this.getInitialFileStructure(context),
                autoSelectedModel,
                'File Structure Planning'
            );

            if (!initialPlan || initialPlan.files.length === 0) {
                throw new Error('No files to create based on your request.');
            }

            
            const enhancedPlan = await this.generateDetailedFileContent(initialPlan, context, autoSelectedModel);

            
            actionState.data = enhancedPlan;

            
            this.updateFileActionStatus(actionId, 'completed');

            
            
            if (actionState.element && actionState.element.classList.contains('historical')) {
                
                await this.acceptFileAction(actionId, enhancedPlan);
            }

        } catch (error) {
                        this.updateFileActionStatus(actionId, 'failed', error instanceof Error ? error.message : 'Unknown error');
        }
    }

    private generateUniquePath(folderPath: string, baseName: string, extension: string): string {
        let fileName = baseName;
        let filePath = normalizePath(`${folderPath}/${fileName}.${extension}`);
        
        const existingFile = this.app.vault.getAbstractFileByPath(filePath);
        if (existingFile) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            fileName = `${baseName}-${timestamp}`;
            filePath = normalizePath(`${folderPath}/${fileName}.${extension}`);
        }
        
        return filePath;
    }

    async processCanvasCreate(actionId: string, prompt: string, targetFolder?: string, contextFiles: ContextFile[] = [], autoSelectedModel: ModelSelection | null = null) {
        try {
            const actionState = this.activeFileActions.get(actionId);
            if (!actionState) return;

            const chatHistory = this.getChatHistory();
            const context = {
                userPrompt: prompt,
                targetFolder,
                contextFiles,
                webSearchEnabled: this.webEnabled,
                webSearchService: this.webSearchService,
                settings: this.settings,
                chatHistory
            };

            
            const markdown = await this.executeWithFallback(
                async () => await this.generateDiagramMarkdown(context, 'canvas'),
                autoSelectedModel,
                'Canvas Outline Generation'
            );

            
            const canvasJSON = processDiagramContent(markdown, 'canvas');
            const canvasData = JSON.parse(canvasJSON) as CanvasParseResult;

            
            const folder = targetFolder || 'New Files';
            const fullPath = this.generateUniquePath(folder, 'canvas', 'canvas');
            
            
            canvasData.folderName = folder;
            canvasData.targetPath = fullPath;
            actionState.data = canvasData;
            actionState.fileName = `[[${fullPath}]]`;
            if (actionState.element) {
                const nameEl = actionState.element.querySelector('.file-action-name') as HTMLElement;
                if (nameEl) {
                    nameEl.empty();
                    void MarkdownRenderer.render(this.app, actionState.fileName, nameEl, '', this);
                }
            }

            
            this.updateFileActionStatus(actionId, 'completed');



            
            if (actionState.element && actionState.element.classList.contains('historical')) {
                await this.acceptFileAction(actionId, canvasData);
            }

        } catch (error) {
                        this.updateFileActionStatus(actionId, 'failed', error instanceof Error ? error.message : 'Unknown error');
        }
    }

    async processExcalidrawCreate(actionId: string, prompt: string, targetFolder?: string, contextFiles: ContextFile[] = [], autoSelectedModel: ModelSelection | null = null) {
        try {
            const actionState = this.activeFileActions.get(actionId);
            if (!actionState) return;

            const chatHistory = this.getChatHistory();
            const context = {
                userPrompt: prompt,
                targetFolder,
                contextFiles,
                webSearchEnabled: this.webEnabled,
                webSearchService: this.webSearchService,
                settings: this.settings,
                chatHistory
            };

            
            const markdown = await this.executeWithFallback(
                async () => await this.generateDiagramMarkdown(context, 'excalidraw'),
                autoSelectedModel,
                'Excalidraw Outline Generation'
            );

            
            const excalidrawJSON = processDiagramContent(markdown, 'excalidraw');
            const excalidrawData = JSON.parse(excalidrawJSON) as ExcalidrawParseResult;

            
            const folder = targetFolder || 'New Files';
            const fullPath = this.generateUniquePath(folder, 'diagram', 'excalidraw.md');

            
            excalidrawData.folderName = folder;
            excalidrawData.targetPath = fullPath;
            actionState.data = excalidrawData as unknown as FileActionResult;
            actionState.isExcalidraw = true;

            
            actionState.fileName = `[[${fullPath}]]`;
            if (actionState.element) {
                const nameEl = actionState.element.querySelector('.file-action-name') as HTMLElement;
                if (nameEl) {
                    nameEl.empty();
                    void MarkdownRenderer.render(this.app, actionState.fileName, nameEl, '', this);
                }
            }

            
            this.updateFileActionStatus(actionId, 'completed');

            
            if (actionState.element && actionState.element.classList.contains('historical')) {
                await this.acceptFileAction(actionId, excalidrawData as unknown as FileActionResult);
            }

        } catch (error) {
                        this.updateFileActionStatus(actionId, 'failed', error instanceof Error ? error.message : 'Unknown error');
        }
    }

    private async generateDiagramMarkdown(context: DiagramGenerationContext, type: 'canvas' | 'excalidraw'): Promise<string> {
        const provider = context.settings.provider;
        let apiKey: string = '';

        if (provider === 'groq') {
            apiKey = context.settings.groqApiKey;
            if (!apiKey || !context.settings.model) {
                throw new Error(`${type} creation requires a valid Groq API key and model in settings.`);
            }
        } else if (provider === 'openrouter') {
            apiKey = context.settings.openRouterApiKey;
            if (!apiKey || !context.settings.model) {
                throw new Error(`${type} creation requires a valid OpenRouter API key and model in settings.`);
            }
        } else if (provider === 'ollama') {
            if (context.settings.ollamaMode === 'cloud' && !context.settings.ollamaApiKey) {
                throw new Error(`${type} creation requires a valid Ollama API key for cloud mode in settings.`);
            }
            if (!context.settings.model) {
                throw new Error(`${type} creation requires a valid Ollama model in settings.`);
            }
        } else if (provider === 'nvidia') {
            apiKey = context.settings.nvidiaApiKey;
            if (!apiKey || !context.settings.model) {
                throw new Error(`${type} creation requires a valid NVIDIA API key and model in settings.`);
            }
        } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
            if (!context.settings.model) {
                throw new Error(`${type} creation requires a valid model in settings.`);
            }
        } else {
            apiKey = context.settings.geminiApiKey || context.settings.apiKey;
            if (!apiKey || !context.settings.model) {
                throw new Error(`${type} creation requires a valid Gemini API key and model in settings.`);
            }
        }

        let contextInfo = '';
        if (context.contextFiles.length > 0) {
            contextInfo = `\n\nCONTEXT FILES PROVIDED:\n${context.contextFiles.map((f: ContextFile) => `- ${f.basename}:\n${f.content.substring(0, 1500)}`).join('\n\n')}`;
        }

        const systemPrompt = `You are an expert at creating hierarchical diagram outlines.
Generate a structured Markdown outline representing the diagram.
Use headings (# ## ###) to indicate hierarchy and logical flow.

### LAYOUT SELECTION
Decide the best layout for the information:
1. **TREE** (Default): For standard hierarchies and mind maps. (Add "LAYOUT: TREE" at the top)
2. **TIMELINE**: For sequences of events, histories, or step-by-step processes. (Add "LAYOUT: TIMELINE" at the top)
3. **SIDEWAYS** (Brace Map): For part-whole relationships or when horizontal space is preferred. (Add "LAYOUT: SIDEWAYS" at the top)

Example:
LAYOUT: TREE
# Primary Topic
## Subtopic 1
### Detail A

IMPORTANT RULES:
1. **OUTLINE ONLY**: Return ONLY the Markdown outline.
2. **NO JSON**: Do NOT output JSON, code blocks, or coordinates.
3. **NO EXPLANATIONS**: Do NOT include any meta-commentary or explanations.
4. **HIERARCHY**: Use clear heading levels to represent nodes and sub-nodes.${contextInfo}`;

        const userPrompt = `Create a ${type} diagram outline for: ${context.userPrompt}`;

        let aiText: string;

        if (provider === 'groq') {
            const { GroqService } = await import('../services/groqService');
            const groqService = new GroqService(apiKey);
            const convertedHistory = (context.chatHistory || []).map((h: ChatHistoryEntry) => ({
                role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
                content: h.parts[0].text
            }));
            aiText = await groqService.generateContent(
                context.settings.model,
                [
                    { role: 'system', content: systemPrompt },
                    ...convertedHistory,
                    { role: 'user', content: userPrompt }
                ],
                { temperature: 0.3 }
            );
        } else if (provider === 'openrouter') {
            const { OpenRouterService } = await import('../services/openRouterService');
            const openRouterService = new OpenRouterService(apiKey);
            const convertedHistory = (context.chatHistory || []).map((h: ChatHistoryEntry) => ({
                role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
                content: h.parts[0].text
            }));
            aiText = await openRouterService.generateContent(
                context.settings.model,
                [
                    { role: 'system', content: systemPrompt },
                    ...convertedHistory,
                    { role: 'user', content: userPrompt }
                ],
                { temperature: 0.3 }
            );
        } else if (provider === 'ollama') {
            const { OllamaService } = await import('../services/ollamaService');
            const ollamaService = new OllamaService(context.settings.ollamaBaseUrl, context.settings.ollamaApiKey);
            const convertedHistory = (context.chatHistory || []).map((h: ChatHistoryEntry) => ({
                role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
                content: h.parts[0].text
            }));
            aiText = await ollamaService.generateContent(
                context.settings.model,
                [
                    { role: 'system', content: systemPrompt },
                    ...convertedHistory,
                    { role: 'user', content: userPrompt }
                ],
                { temperature: 0.3 }
            );
        } else if (provider === 'nvidia') {
            const { NvidiaService } = await import('../services/nvidiaService');
            const nvidiaService = new NvidiaService(apiKey);
            const convertedHistory = (context.chatHistory || []).map((h: ChatHistoryEntry) => ({
                role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
                content: h.parts[0].text
            }));
            aiText = await nvidiaService.generateContent(
                context.settings.model,
                [
                    { role: 'system', content: systemPrompt },
                    ...convertedHistory,
                    { role: 'user', content: userPrompt }
                ],
                { temperature: 0.3 }
            );
        } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
            const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
            const convertedHistory = (context.chatHistory || []).map((h: ChatHistoryEntry) => ({
                role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
                content: h.parts[0].text
            }));
            const response = await unifiedProvider.generateContent(
                context.settings.model,
                [
                    { role: 'system', content: systemPrompt },
                    ...convertedHistory,
                    { role: 'user', content: userPrompt }
                ],
                {
                    temperature: 0.3,
                    maxTokens: 8192,
                    topP: getModelTopP(this.settings.model, this.settings)
                }
            );
            aiText = response.text;
        } else {
            const { GoogleGenerativeAI } = await import('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: context.settings.model });
            const chat = model.startChat({ history: context.chatHistory || [] });
            const result = await chat.sendMessage(systemPrompt + '\n\n' + userPrompt);
            aiText = (this.extractGeminiAnswerTextFromResponse(result.response) || result.response.text()).trim();
        }

        return aiText;
    }

    private async getInitialFileStructure(context: DiagramGenerationContext): Promise<FileCreationPlan | null> {
        
        const provider = context.settings.provider;
        let apiKey: string = '';

        if (provider === 'groq') {
            apiKey = context.settings.groqApiKey;
            if (!apiKey || !context.settings.model) {
                throw new Error('File creation requires a valid Groq API key and model in settings.');
            }
        } else if (provider === 'openrouter') {
            apiKey = context.settings.openRouterApiKey;
            if (!apiKey || !context.settings.model) {
                throw new Error('File creation requires a valid OpenRouter API key and model in settings.');
            }
        } else if (provider === 'ollama') {
            
            if (context.settings.ollamaMode === 'cloud' && !context.settings.ollamaApiKey) {
                throw new Error('File creation requires a valid Ollama API key for cloud mode in settings.');
            }
            if (!context.settings.model) {
                throw new Error('File creation requires a valid Ollama model in settings.');
            }
        } else if (provider === 'nvidia') {
            apiKey = context.settings.nvidiaApiKey;
            if (!apiKey || !context.settings.model) {
                throw new Error('File creation requires a valid NVIDIA API key and model in settings.');
            }
        } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
            if (!context.settings.model) {
                throw new Error('File creation requires a valid model in settings.');
            }
        } else {
            apiKey = context.settings.geminiApiKey || context.settings.apiKey;
            if (!apiKey || !context.settings.model) {
                throw new Error('File creation requires a valid Gemini API key and model in settings.');
            }
        }

        
        let contextInfo = '';
            if (context.contextFiles.length > 0) {
                contextInfo = `\n\nCONTEXT FILES PROVIDED:\n${context.contextFiles.map((f: ContextFile) => `- ${f.basename}: ${f.content.substring(0, 200)}...`).join('\n')}`;
            }

            if (context.webSearchEnabled) {
                contextInfo += '\n\nWEB SEARCH ENABLED: Content will be enhanced with web research.';
            }

            
            let systemPrompt = `You are an expert file and folder organizer for Obsidian. Create an initial file structure plan. Consider the conversation context when planning files.

IMPORTANT RULES:
1. **FOLDER**: ${context.targetFolder ? `Use EXACT folder: "${context.targetFolder}"` : 'Create descriptive folder name'}
2. **FILES**: Analyze the request and determine what files are needed
3. **DESCRIPTIONS**: For each file, provide a brief description of what content it should contain
4. **EXTENSIONS**: Always use "md" for Obsidian notes
5. **CONTEXT**: Consider previous conversation when planning file structure

JSON FORMAT (MANDATORY):
{
  "folderName": "folder-name",
  "files": [
    {
      "name": "filename-without-extension",
      "description": "Brief description of what this file should contain",
      "content": "PLACEHOLDER - will be generated later",
      "extension": "md"
    }
  ]
}

CRITICAL:
❌ NO markdown code blocks
❌ NO explanations outside JSON
✅ START with { and END with }
✅ Use double quotes only
✅ Include description field for each file${contextInfo}`;

            const userPrompt = `User request: ${context.userPrompt}`;

            if (context.targetFolder) {
                systemPrompt += `\n\nUSER SELECTED FOLDER: "${context.targetFolder}" - Use this as folderName.`;
            }

            let aiText: string;

            if (provider === 'groq') {
                const { GroqService } = await import('../services/groqService');
                const groqService = new GroqService(apiKey);
                
                const convertedHistory = (context.chatHistory || []).map((h: ChatHistoryEntry) => ({
                    role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
                    content: h.parts[0].text
                }));
                const structureMessages = [
                    { role: 'system' as const, content: systemPrompt },
                    ...convertedHistory,
                    { role: 'user' as const, content: userPrompt }
                ];
                aiText = await groqService.generateContent(
                    context.settings.model,
                    structureMessages,
                    { temperature: getModelTemperature(this.settings.model, this.settings), topP: getModelTopP(this.settings.model, this.settings) }
                );
            } else if (provider === 'openrouter') {
                const { OpenRouterService } = await import('../services/openRouterService');
                const openRouterService = new OpenRouterService(apiKey);
                
                const convertedHistory = (context.chatHistory || []).map((h: ChatHistoryEntry) => ({
                    role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
                    content: h.parts[0].text
                }));
                aiText = await openRouterService.generateContent(
                    context.settings.model,
                    [
                        { role: 'system', content: systemPrompt },
                        ...convertedHistory,
                        { role: 'user', content: userPrompt }
                    ],
                    { temperature: getModelTemperature(this.settings.model, this.settings), topP: getModelTopP(this.settings.model, this.settings) }
                );
            } else if (provider === 'ollama') {
                const { OllamaService } = await import('../services/ollamaService');
                const ollamaService = new OllamaService(
                    context.settings.ollamaBaseUrl,
                    context.settings.ollamaApiKey
                );
                
                const convertedHistory = (context.chatHistory || []).map((h: ChatHistoryEntry) => ({
                    role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
                    content: h.parts[0].text
                }));
                aiText = await ollamaService.generateContent(
                    context.settings.model,
                    [
                        { role: 'system', content: systemPrompt },
                        ...convertedHistory,
                        { role: 'user', content: userPrompt }
                    ],
                    {
                        temperature: getModelTemperature(this.settings.model, this.settings),
                        topP: getModelTopP(this.settings.model, this.settings),
                        think: (context.settings.model || '').toLowerCase().includes('gpt-oss')
                            ? (context.settings.ollamaGptOssThinkingLevel || 'medium')
                            : !!context.settings.ollamaThinkingEnabled
                    }
                );
            } else if (provider === 'nvidia') {
                const { NvidiaService } = await import('../services/nvidiaService');
                const nvidiaService = new NvidiaService(apiKey);
                const convertedHistory = (context.chatHistory || []).map((h: ChatHistoryEntry) => ({
                    role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
                    content: h.parts[0].text
                }));
                aiText = await nvidiaService.generateContent(
                    context.settings.model,
                    [
                        { role: 'system', content: systemPrompt },
                        ...convertedHistory,
                        { role: 'user', content: userPrompt }
                    ],
                    { temperature: getModelTemperature(this.settings.model, this.settings), maxTokens: 8192, topP: getModelTopP(this.settings.model, this.settings) }
                );
            } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
                const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
                const convertedHistory = (context.chatHistory || []).map((h: ChatHistoryEntry) => ({
                    role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
                    content: h.parts[0].text
                }));
                const response = await unifiedProvider.generateContent(
                    context.settings.model,
                    [
                        { role: 'system', content: systemPrompt },
                        ...convertedHistory,
                        { role: 'user', content: userPrompt }
                    ],
                    {
                        temperature: getModelTemperature(this.settings.model, this.settings),
                        maxTokens: 8192,
                        topP: getModelTopP(this.settings.model, this.settings)
                    }
                );
                aiText = response.text;
            } else {
                
                const { GoogleGenerativeAI } = await import('@google/generative-ai');
                const genAI = new GoogleGenerativeAI(apiKey);
                const model = genAI.getGenerativeModel({ model: context.settings.model });
                const geminiThinkingConfig = getGeminiThinkingConfig(context.settings.model, this.settings);

                const chat = model.startChat({
                    history: context.chatHistory || [],
                    generationConfig: {
                        temperature: getModelTemperature(this.settings.model, this.settings),
                        topK: 40,
                        topP: getModelTopP(this.settings.model, this.settings),
                        ...(geminiThinkingConfig || {}),
                    }
                });

                const result = await chat.sendMessage(systemPrompt + '\n\n' + userPrompt);
                aiText = (this.extractGeminiAnswerTextFromResponse(result.response) || result.response.text()).trim();
            }

            if (!aiText || aiText.length === 0) {
                throw new Error('Empty AI response');
            }


            const plan = this.extractAndValidateJSON(aiText);
            if (!plan) {
                                throw new Error('Failed to parse file structure plan.');
            }

            return plan;
    }

    private async generateDetailedFileContent(initialPlan: FileCreationPlan, context: DiagramGenerationContext, autoSelectedModel: ModelSelection | null = null): Promise<FileCreationPlan> {
        const enhancedFiles = [];

        for (let i = 0; i < initialPlan.files.length; i++) {
            const file = initialPlan.files[i];

            try {
                
                const enhancedContent = await this.executeWithFallback(
                    async () => await this.generateSingleFileContent(file, context),
                    autoSelectedModel,
                    `File Content Generation (${file.name})`,
                    true
                );
                enhancedFiles.push({
                    ...file,
                    content: enhancedContent
                });
            } catch {
                                 
                enhancedFiles.push({
                    ...file,
                    content: `# ${file.name}\n\n${file.description || 'Content will be added here.'}\n\n*Note: Detailed content generation failed. Please edit manually.*`
                });
            }
        }

        return {
            ...initialPlan,
            files: enhancedFiles
        };
    }

    private async generateSingleFileContent(file: { name: string; extension?: string; description?: string }, context: DiagramGenerationContext): Promise<string> {
        
        const provider = context.settings.provider;
        let apiKey: string = '';

        if (provider === 'groq') {
            apiKey = context.settings.groqApiKey;
            if (!apiKey) throw new Error('Invalid AI settings');
        } else if (provider === 'openrouter') {
            apiKey = context.settings.openRouterApiKey;
            if (!apiKey) throw new Error('Invalid AI settings');
        } else if (provider === 'ollama') {
            
            if (context.settings.ollamaMode === 'cloud' && !context.settings.ollamaApiKey) {
                throw new Error('Invalid AI settings - Ollama cloud mode requires API key');
            }
        } else if (provider === 'nvidia') {
            apiKey = context.settings.nvidiaApiKey;
            if (!apiKey) throw new Error('Invalid AI settings');
        } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
            // Already validated or doesn't need specific key check here
        } else {
            apiKey = context.settings.geminiApiKey || context.settings.apiKey;
            if (!apiKey) throw new Error('Invalid AI settings');
        }

        
        let systemPrompt = `You are an expert content writer creating detailed, high-quality markdown content for Obsidian. Consider the conversation context when creating content.

TASK: Create comprehensive content for a file named "${file.name}.${file.extension}"
DESCRIPTION: ${file.description || 'Create relevant content based on the user request'}

CONTENT REQUIREMENTS:
✅ Write detailed, well-structured markdown
✅ Use proper headings (# ## ###)
✅ Include relevant examples, lists, and formatting
✅ Make content substantial (minimum 200 words unless it's a simple note)
✅ Focus specifically on this file's purpose
✅ Consider conversation context when creating content
${context.webSearchEnabled ? '✅ Include web search citations in format [🔗](URL)' : ''}

CONTEXT PROVIDED:`;

        
        if (context.contextFiles.length > 0) {
            systemPrompt += `\n\nRELEVANT CONTEXT FILES:\n${context.contextFiles.map((f: ContextFile) => `- ${f.basename}: ${f.content.substring(0, 300)}...`).join('\n')}`;
        }

        systemPrompt += `\n\nORIGINAL USER REQUEST: ${context.userPrompt}

IMPORTANT: Return ONLY the markdown content for this specific file. Do not include explanations or meta-commentary.`;

        const userPrompt = `Create detailed markdown content for "${file.name}" file.`;

        let content: string;

        if (provider === 'groq') {
            const { GroqService } = await import('../services/groqService');
            const groqService = new GroqService(apiKey);
            
            const convertedHistory = (context.chatHistory || []).map((h: ChatHistoryEntry) => ({
                role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
                content: h.parts[0].text
            }));
            const contentMessages = [
                { role: 'system' as const, content: systemPrompt },
                ...convertedHistory,
                { role: 'user' as const, content: userPrompt }
            ];
            content = await groqService.generateContent(
                context.settings.model,
                contentMessages,
                { temperature: getModelTemperature(this.settings.model, this.settings), topP: getModelTopP(this.settings.model, this.settings) }
            );
        } else if (provider === 'openrouter') {
            const { OpenRouterService } = await import('../services/openRouterService');
            const openRouterService = new OpenRouterService(apiKey);
            
            const convertedHistory = (context.chatHistory || []).map((h: ChatHistoryEntry) => ({
                role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
                content: h.parts[0].text
            }));
            content = await openRouterService.generateContent(
                context.settings.model,
                [
                    { role: 'system', content: systemPrompt },
                    ...convertedHistory,
                    { role: 'user', content: userPrompt }
                ],
                { temperature: getModelTemperature(this.settings.model, this.settings), topP: getModelTopP(this.settings.model, this.settings) }
            );
        } else if (provider === 'ollama') {
            const { OllamaService } = await import('../services/ollamaService');
            const ollamaService = new OllamaService(
                context.settings.ollamaBaseUrl,
                context.settings.ollamaApiKey
            );
            
            const convertedHistory = (context.chatHistory || []).map((h: ChatHistoryEntry) => ({
                role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
                content: h.parts[0].text
            }));
            content = await ollamaService.generateContent(
                context.settings.model,
                [
                    { role: 'system', content: systemPrompt },
                    ...convertedHistory,
                    { role: 'user', content: userPrompt }
                ],
                {
                    temperature: getModelTemperature(this.settings.model, this.settings),
                    topP: getModelTopP(this.settings.model, this.settings),
                    think: (context.settings.model || '').toLowerCase().includes('gpt-oss')
                        ? (context.settings.ollamaGptOssThinkingLevel || 'medium')
                        : !!context.settings.ollamaThinkingEnabled
                }
            );
        } else if (provider === 'nvidia') {
            const { NvidiaService } = await import('../services/nvidiaService');
            const nvidiaService = new NvidiaService(apiKey);
            const convertedHistory = (context.chatHistory || []).map((h: ChatHistoryEntry) => ({
                role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
                content: h.parts[0].text
            }));
            content = await nvidiaService.generateContent(
                context.settings.model,
                [
                    { role: 'system', content: systemPrompt },
                    ...convertedHistory,
                    { role: 'user', content: userPrompt }
                ],
                { temperature: getModelTemperature(this.settings.model, this.settings), maxTokens: 8192, topP: getModelTopP(this.settings.model, this.settings) }
            );
        } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
            const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
            const convertedHistory = (context.chatHistory || []).map((h: ChatHistoryEntry) => ({
                role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
                content: h.parts[0].text
            }));
            const response = await unifiedProvider.generateContent(
                context.settings.model,
                [
                    { role: 'system', content: systemPrompt },
                    ...convertedHistory,
                    { role: 'user', content: userPrompt }
                ],
                {
                    temperature: getModelTemperature(this.settings.model, this.settings),
                    maxTokens: 8192,
                    topP: getModelTopP(this.settings.model, this.settings)
                }
            );
            content = response.text;
        } else {
            
            const { GoogleGenerativeAI } = await import('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(apiKey);

            
            const modelConfig = { model: context.settings.model } as unknown as import('@google/generative-ai').ModelParams;
            if (context.webSearchEnabled && context.webSearchService) {
                modelConfig.tools = [context.webSearchService.getGoogleSearchToolConfig()] as unknown as import('@google/generative-ai').Tool[];
            }

            const model = genAI.getGenerativeModel(modelConfig);

            const chat = model.startChat({
                history: context.chatHistory || [],
                generationConfig: {
                    temperature: getModelTemperature(this.settings.model, this.settings),
                    topK: 40,
                    topP: getModelTopP(this.settings.model, this.settings),
                    ...(getGeminiThinkingConfig(context.settings.model, this.settings) || {}),
                }
            });

            const result = await chat.sendMessage(systemPrompt + '\n\n' + userPrompt);
            content = (this.extractGeminiAnswerTextFromResponse(result.response) || result.response.text()).trim();
        }

        if (!content) {
            throw new Error('No content generated');
        }

        return content;
    }

    private extractAndValidateJSON(aiText: string): FileCreationPlan | null {

        
        const strategies = [
            
            (text: string) => {
                let cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
                return this.cleanAndParseJSON(cleaned);
            },

            
            (text: string) => {
                const firstBrace = text.indexOf('{');
                const lastBrace = text.lastIndexOf('}');
                if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                    const jsonStr = text.substring(firstBrace, lastBrace + 1);
                    return this.cleanAndParseJSON(jsonStr);
                }
                return null;
            },

            
            (text: string) => {
                const matches = text.match(/\{[\s\S]*\}/g);
                if (matches) {
                    for (const match of matches) {
                        const result = this.cleanAndParseJSON(match);
                        if (result) return result;
                    }
                }
                return null;
            },

            
            (text: string) => {
                const lines = text.split('\n');
                let jsonLines: string[] = [];
                let inJson = false;
                let braceCount = 0;

                for (const line of lines) {
                    if (line.trim().startsWith('{')) {
                        inJson = true;
                        braceCount = 0;
                    }

                    if (inJson) {
                        jsonLines.push(line);
                        braceCount += (line.match(/\{/g) || []).length;
                        braceCount -= (line.match(/\}/g) || []).length;

                        if (braceCount === 0 && line.includes('}')) {
                            break;
                        }
                    }
                }

                if (jsonLines.length > 0) {
                    return this.cleanAndParseJSON(jsonLines.join('\n'));
                }
                return null;
            }
        ];

        
        for (let i = 0; i < strategies.length; i++) {
            try {
                const result = strategies[i](aiText);
                if (result) {
                    return result;
                }
            } catch {
                // Skip failed strategy, continue with next
            }
        }

                return null;
    }

    private cleanAndParseJSON(jsonStr: string): FileCreationPlan | null {
        if (!jsonStr || !jsonStr.trim()) return null;

        
        let cleaned = jsonStr.trim();

        
        cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

        
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
            cleaned = cleaned.substring(firstBrace, lastBrace + 1);
        }

        
        try {
            const parsed = JSON.parse(cleaned) as FileCreationPlan;

            
            if (parsed && typeof parsed === 'object' && parsed.folderName && Array.isArray(parsed.files)) {
                
                parsed.files = parsed.files.map((file: { name?: string; description?: string; content?: string; extension?: string }) => ({
                    name: file.name || 'Untitled',
                    description: file.description || '',
                    content: file.content || '# New File\n\nContent not generated.',
                    extension: file.extension || 'md'
                }));

                return parsed;
            }
        } catch {
            

            try {
                
                let aggressiveCleaned = cleaned;

                
                aggressiveCleaned = aggressiveCleaned.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');

                
                const parsed = JSON.parse(aggressiveCleaned) as FileCreationPlan;

                if (parsed && typeof parsed === 'object' && parsed.folderName && Array.isArray(parsed.files)) {
                    parsed.files = parsed.files.map((file: { name?: string; description?: string; content?: string; extension?: string }) => ({
                        name: file.name || 'Untitled',
                        description: file.description || '',
                        content: file.content || '# New File\n\nContent not generated.',
                        extension: file.extension || 'md'
                    }));

                    return parsed;
                }
            } catch {
                // Failed to parse - keep previous value
            }        }

        return null;
    }

    private fixJSONSyntaxError(jsonStr: string, errorMsg: string): string | null {
        try {
            
            const posMatch = errorMsg.match(/position (\d+)/);
            if (!posMatch) return null;

            const position = parseInt(posMatch[1]);
            const beforeError = jsonStr.substring(0, position);
            const afterError = jsonStr.substring(position);

            
            if (errorMsg.includes("Expected ',' or '}'")) {
                
                if (beforeError.endsWith('"') && afterError.startsWith('\n')) {
                    return beforeError + ',' + afterError;
                }
                if (!beforeError.endsWith('"') && !beforeError.endsWith(',')) {
                    return beforeError + '"' + afterError;
                }
            }

            return null;
        } catch {
            return null;
        }
    }

    private createFallbackPlan(prompt: string, targetFolder?: string): FileCreationPlan {
        
        const folderName = targetFolder || 'New Files';
        const fileName = this.extractFileNameFromPrompt(prompt) || 'New File';

        return {
            folderName: folderName,
            files: [{
                name: fileName,
                content: `# ${fileName}\n\nCreated based on: ${prompt}\n\n*Note: This file was created using a fallback method due to AI response parsing issues. Please edit the content as needed.*`,
                extension: 'md'
            }]
        };
    }

    private extractFileNameFromPrompt(prompt: string): string {
        
        const words = prompt.toLowerCase().split(/\s+/);
        const meaningfulWords = words.filter(word =>
            word.length > 2 &&
            !['create', 'make', 'new', 'file', 'files', 'for', 'the', 'and', 'with', 'about'].includes(word)
        );

        if (meaningfulWords.length > 0) {
            return meaningfulWords.slice(0, 3).map(word =>
                word.charAt(0).toUpperCase() + word.slice(1)
            ).join(' ');
        }

        return 'New File';
    }

    private async createFilesFromPlan(plan: FileCreationPlan): Promise<void> {
        if (!plan || !plan.folderName || !Array.isArray(plan.files)) {
            throw new Error('Invalid file creation plan');
        }

        
        const folderPath = plan.folderName;
        const folder = this.app.vault.getAbstractFileByPath(folderPath);

        if (!folder) {
            await this.app.vault.createFolder(folderPath);
        }

        
        for (const fileInfo of plan.files) {
            if (!fileInfo.name || !fileInfo.content) {
                                continue;
            }

            let finalContent = fileInfo.content;

            
            if (fileInfo.templatePath) {
                const templateFile = this.app.vault.getAbstractFileByPath(fileInfo.templatePath);
                if (templateFile instanceof TFile) {
                    try {
                        const templateContent = await this.app.vault.read(templateFile);
                        finalContent = templateContent + '\n\n' + finalContent;
                    } catch {
                        // File may not exist or be accessible - safe to ignore
                    }
                }
            }

            const fileName = `${fileInfo.name}.${fileInfo.extension || 'md'}`;
            const filePath = normalizePath(`${folderPath}/${fileName}`);

            
            const existingFile = this.app.vault.getAbstractFileByPath(filePath);
            if (existingFile) {
                
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const uniqueFileName = `${fileInfo.name}-${timestamp}.${fileInfo.extension || 'md'}`;
                const uniqueFilePath = normalizePath(`${folderPath}/${uniqueFileName}`);
                await this.app.vault.create(uniqueFilePath, finalContent);
            } else {
                await this.app.vault.create(filePath, finalContent);
            }
        }
    }

    private async createCanvasFile(folderPath: string, canvasData: CanvasData): Promise<void> {
        if (!canvasData || !canvasData.nodes || !Array.isArray(canvasData.nodes)) {
            throw new Error('Invalid canvas data: missing nodes array.');
        }

        
        const finalPath = canvasData.targetPath || this.generateUniquePath(folderPath, 'canvas', 'canvas');
        const finalFolder = finalPath.substring(0, finalPath.lastIndexOf('/'));

        
        const folder = this.app.vault.getAbstractFileByPath(finalFolder);
        if (!folder) {
            await this.app.vault.createFolder(finalFolder);
        }

        
        const jsonContent = JSON.stringify({
            nodes: canvasData.nodes,
            edges: canvasData.edges || []
        }, null, 2);

        await this.app.vault.create(finalPath, jsonContent);
    }

    private async createExcalidrawFile(folderPath: string, excalidrawData: ExcalidrawData): Promise<void> {
        if (!excalidrawData || !excalidrawData.elements || !Array.isArray(excalidrawData.elements)) {
            throw new Error('Invalid Excalidraw data: missing elements array.');
        }

        
        const finalPath = excalidrawData.targetPath || this.generateUniquePath(folderPath, 'diagram', 'excalidraw.md');
        const finalFolder = finalPath.substring(0, finalPath.lastIndexOf('/'));

        const folder = this.app.vault.getAbstractFileByPath(finalFolder);
        if (!folder) {
            await this.app.vault.createFolder(finalFolder);
        }

        
        const excalidrawName = finalPath.split('/').pop()?.replace('.excalidraw.md', '') || 'Diagram';

        const jsonContent = JSON.stringify({
            type: excalidrawData.type || 'excalidraw',
            version: excalidrawData.version || 2,
            source: excalidrawData.source || 'https://excalidraw.com',
            elements: excalidrawData.elements,
            appState: excalidrawData.appState || {
                theme: 'light',
                viewBackgroundColor: '#ffffff'
            },
            files: excalidrawData.files || {}
        }, null, 2);

        const markdownContent = `---
excalidraw-plugin: raw
---

# ${excalidrawName}

## Drawing
\`\`\`json
${jsonContent}
\`\`\`
%%
`;

        await this.app.vault.create(finalPath, markdownContent);
    }

    addFileActionCapsuleToContainer(actionId: string, container: HTMLElement) {
        const actionState = this.activeFileActions.get(actionId);
        if (!actionState) return;

        
        const capsule = container.createDiv({ cls: `file-action-capsule ${actionState.type}-capsule` });
        actionState.element = capsule;

        
        const icon = capsule.createDiv({ cls: 'file-action-icon' });
        setIcon(icon, actionState.type === 'edit' ? 'edit' : 'file-plus');

        
        const nameEl = capsule.createDiv({ cls: 'file-action-name' });
        if (actionState.fileName && actionState.fileName.includes('[[') && actionState.fileName.includes(']]')) {
            void MarkdownRenderer.render(this.app, actionState.fileName, nameEl, '', this);
        } else {
            nameEl.textContent = actionState.fileName;
        }
        
        capsule.createDiv({ cls: 'file-action-status' });

        
        this.updateFileActionStatus(actionId, actionState.status, actionState.error);

        
        capsule.addEventListener('click', () => {
            this.openFileActionModal(actionId);
        });
    }

    addFileActionResponse(question: string, message: string, actionIds: string[]) {
        
        const newResponse: Response = {
            id: Date.now().toString(),
            question: question,
            answer: message,
            context: [], 
            timestamp: new Date(),
            sessionId: this.currentSessionId || 'default',
            fileActionIds: actionIds 
        };
        this.responses.push(newResponse);
        this.updateContextBar();

        
        const responseEl = this.contentContainer.createDiv({ cls: 'response-item' });

        
        const questionEl = responseEl.createDiv({ cls: 'response-question' });
        const questionTextEl = questionEl.createSpan();
        questionTextEl.textContent = question;
        this.createQuestionActions(questionEl, question);

        
        const answerEl = responseEl.createDiv({ cls: 'response-answer' });

        
        const messageEl = answerEl.createDiv({ cls: 'ai-message' });
        void MarkdownRenderer.render(this.app, message, messageEl, '', this);

        
        const capsulesContainer = answerEl.createDiv({ cls: 'file-action-capsules' });

        
        for (const actionId of actionIds) {
            this.addFileActionCapsuleToContainer(actionId, capsulesContainer);
        }

        
        this.createResponseActions(responseEl, question, message);

        
        this.contentContainer.scrollTo({
            top: this.contentContainer.scrollHeight,
            behavior: 'smooth'
        });

        
        void this.saveCurrentSession();
        this.updateNavRail();
        this.updateJumpButton();
    }

    /**
     * Process a @mcp query with selected MCP servers
     */
    private async processMCPQuery(
        query: string,
        selection: { selectedServers: string[]; selectedResources: Map<string, string[]>; selectedTools: Map<string, string[]>; autoToolSelection?: Map<string, boolean> },
        autoSelectedModel: ModelSelection | null = null,
        enableRateLimit: boolean = true
    ): Promise<void> {
        this.isProcessing = true;
        this.setSendButtonState(this.stopKnowDeepBtn, 'stop');
        const startTime = Date.now();

        
        const multimodalInputs: MultimodalInput[] = [];
        if (this.selectedFiles.size > 0) {
            for (const path of Array.from(this.selectedFiles)) {
                if (!/^https?:\/\//.test(path)) {
                    const file = this.app.vault.getAbstractFileByPath(path);
                    if (file instanceof TFile && isMultimodalSupported(file.name)) {
                        try {
                            const data = await processFileForMultimodal(this.app, file);
                            if (data) multimodalInputs.push(data);
                        } catch {
                            // File may not exist or be accessible - safe to ignore
                        }
                    }
                }
            }
        }

        
        const { responseEl: progressResponseEl, progressEl: progressEl } = this.addResponse(
            query,
            '',
            [],
            [],
            undefined,
            undefined,
            { initialProgressText: 'Understanding your request...' }
        );
        this.currentProgressResponseEl = progressResponseEl;
        this.currentProgressEl = progressEl;

        
        await this.sleep(500);

        
        const progressMessages = [
            'Understanding your request...',
            'Planning tool execution...',
            'Executing tools...',
            'Processing results...',
            'Synthesizing answer...'
        ];
        let messageIndex = 1;
        const progressInterval = window.setInterval(() => {
            if (messageIndex < progressMessages.length && this.currentProgressEl) {
                this.updateResponseProgress(this.currentProgressResponseEl!, this.currentProgressEl, progressMessages[messageIndex]);
                messageIndex++;
            }
        }, 1500);

        try {
            
            this.mcpToolCallingService.resetSession();

            
            new Notice('Processing MCP query...');
                        
            
            let mcpContext = '';
            const mcpSources: Array<{ server: string; resource?: string }> = [];
            const mcpTools: Array<{ server: string; tool: string }> = [];

            
            let fileContext = '';
            if (this.selectedFiles.size > 0) {
                const fileContents: string[] = [];
                for (const path of Array.from(this.selectedFiles)) {
                    if (/^https?:\/\//.test(path)) continue; 
                    const fileOrFolder = this.app.vault.getAbstractFileByPath(path);
                    if (fileOrFolder instanceof TFile) {
                        try {
                            const content = await this.app.vault.read(fileOrFolder);
                            fileContents.push(`--- File: ${fileOrFolder.basename} ---\n${content}\n`);
                        } catch {
                            // File may not exist or be accessible - safe to ignore
                        }
                    } else if (fileOrFolder instanceof TFolder) {
                        const allFiles = fileOrFolder.children.filter((c): c is TFile => c instanceof TFile);
                        for (const file of allFiles) {
                            try {
                                const content = await this.app.vault.read(file);
                                fileContents.push(`--- File: ${file.basename} ---\n${content}\n`);
                            } catch {
                                // File may not exist or be accessible - safe to ignore
                            }
                        }
                    }
                }
                fileContext = fileContents.filter(Boolean).join('\n');
                if (fileContext) {
                    this.updateProcessingMessageAndSnippet('Reading context files...');
                }
            }

            
            for (const serverId of selection.selectedServers) {
                const server = this.settings.mcpServers.find(s => s.id === serverId);
                if (!server) {
                                        continue;
                }

                                const resourceUris = selection.selectedResources.get(serverId) || [];
                const selectedToolNames = selection.selectedTools?.get(serverId) || [];

                if (resourceUris.length > 0) {
                                        mcpContext += `\n\n=== Resources from ${server.name} ===\n`;

                    for (const uri of resourceUris) {
                        try {
                            const resourceData = (await this.plugin.mcpService.readResource(serverId, uri)) as MCPResourceReadResult;
                            mcpContext += `\n--- ${uri} ---\n`;

                            if (resourceData.contents) {
                                for (const content of resourceData.contents) {
                                    if (content.text) {
                                        mcpContext += content.text + '\n';
                                    } else if (content.blob) {
                                        mcpContext += `[Binary content: ${content.mimeType || 'unknown'}]\n`;
                                    }
                                }
                            }

                            mcpSources.push({ server: server.name, resource: uri });
                        } catch {
                                                        mcpContext += `[Error reading resource: ${uri}]\n`;
                        }
                    }
                } else {
                    
                    
                    const allTools = this.plugin.mcpService.getServerTools(serverId);
                    const tools = selectedToolNames.length > 0
                        ? allTools.filter(t => selectedToolNames.includes(t.name))
                        : allTools;

                                        tools.forEach(tool => {
                        mcpTools.push({ server: server.name, tool: tool.name });
                    });
                }
            }

                        
            
            const serverNames = selection.selectedServers
                .map(id => this.settings.mcpServers.find(s => s.id === id)?.name)
                .filter(Boolean)
                .join(', ');

            
            const capsuleDisplay = this.inputContainer?.querySelector('.context-capsule-display') as HTMLElement;
            if (capsuleDisplay) {
                
                capsuleDisplay.querySelectorAll('.mcp-capsule').forEach(el => el.remove());
                const mcpCapsule = capsuleDisplay.createDiv({ cls: 'capsule-file-tag mcp-capsule' });
                const icon = mcpCapsule.createSpan({ cls: 'capsule-icon' });
                icon.textContent = '🔌';
                const label = mcpCapsule.createSpan({ cls: 'capsule-label' });
                label.textContent = serverNames || 'MCP';
                mcpCapsule.setAttr('title', `MCP: ${serverNames}`);
                mcpCapsule.addEventListener('click', () => {
                    mcpCapsule.remove();
                    this.pendingMCPSelection = null;
                    const capsuleContainer = capsuleDisplay.parentElement;
                    if (capsuleContainer?.classList.contains('context-capsule-container') && capsuleDisplay.children.length === 0) {
                        capsuleContainer.classList.remove('has-content');
                    }
                });
            }

            
            const fileContextSection = fileContext ? `\n\n=== Context Files ===\n${fileContext}` : '';
            const enhancedQuery = `${query}${fileContextSection}\n\nMCP Context:\n${mcpContext}`;

                                    
            
            const formattedMCPTools = this.mcpToolCallingService.formatToolsForAI(
                selection.selectedServers,
                selection.selectedTools
            );
            
            
            
            const serverGroups = new Map<string, Record<string, unknown>[]>();
            for (const serverId of selection.selectedServers) {
                const serverConfig = this.settings.mcpServers.find(s => s.id === serverId);
                if (!serverConfig) continue;
                const serverTools = this.mcpToolCallingService.formatToolsForAI(
                    [serverId],
                    selection.selectedTools
                );
                if (serverTools.length > 0) {
                    serverGroups.set(serverConfig.name, serverTools);
                }
            }
            
            
            
            
            
            const isAutoToolMode = selection.selectedServers.every(serverId =>
                selection.autoToolSelection?.get(serverId) !== false
            );
            
            
            const calledTools: Array<{ server: string; tool: string }> = [];

            
                const result = await this.basicChatService.processMCPQuery(
                    query,
                    enhancedQuery,
                    mcpContext,
                    this.getChatHistory(),
                    this.updateProcessingUI.bind(this),
                    this.updateProcessingMessageAndSnippet.bind(this),
                    formattedMCPTools,
                    async (toolCall: Record<string, unknown>): Promise<Record<string, unknown>> => {
                        
                        if (!this.isProcessing || this.currentAbortController?.signal.aborted) {
                            throw new DOMException('Processing stopped by user', 'AbortError');
                        }
                        
                                                const toolResult = await this.mcpToolCallingService.executeToolCall(toolCall);
                        
                        if (toolResult.toolName && toolResult.serverName && toolResult.serverName !== 'unknown') {
                            const alreadyTracked = calledTools.some(
                                t => t.server === toolResult.serverName && t.tool === toolResult.toolName
                            );
                            if (!alreadyTracked) {
                                calledTools.push({ server: toolResult.serverName, tool: toolResult.toolName });
                            }
                        }
                        return toolResult as unknown as Record<string, unknown>;
                    },
                    autoSelectedModel,
                    isAutoToolMode,
                    serverGroups,
                    enableRateLimit,
                    multimodalInputs,
                    this.currentAbortController?.signal
                );

                                
                
                if (!this.isProcessing) {
                    window.clearInterval(progressInterval);
                    if (this.currentProgressResponseEl && this.currentProgressEl) {
                        this.finalizeResponse(
                            this.currentProgressResponseEl,
                            this.currentProgressEl,
                            query,
                            'Processing stopped by user.',
                            [],
                            [],
                            {
 modelName: this.settings.model }
                        );
                        this.currentProgressResponseEl = null;
                        this.currentProgressEl = null;
                    }
                    return;
                }

                if (!result.answer || result.answer.trim().length === 0) {
                                                            throw new Error('AI returned empty response. Possible causes:\n' +
                        '1. API key not configured or invalid\n' +
                        '2. Model does not support tool calling (try using a Groq model)\n' +
                        '3. Context too large for the model\n' +
                        '4. MCP tools not properly formatted\n' +
                        'See plugin settings and provider documentation for guidance.');
                }

                
                this.finalizeResponse(
                    progressResponseEl,
                    progressEl!,
                    query,
                    result.answer,
                    mcpSources.map(s => ({
                        path: s.resource || s.server,
                        relevance: 1.0
                    })),
                    [],
                    {
                        modelName: result.modelName || this.settings.model,
                        totalTokens: result.totalTokens,
                        responseTimeMs: Date.now() - startTime
                    },
                    calledTools.length > 0 ? calledTools : undefined
                );

                
                void this.saveCurrentSession();
            } catch (error) {
            
            window.clearInterval(progressInterval);
            
            const isAbortError = error instanceof DOMException && error.name === 'AbortError';
            if (!isAbortError) {
                // Intentionally empty
            }

            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            
            if (!this.isProcessing || isAbortError) {
                if (this.currentProgressResponseEl && this.currentProgressEl) {
                    this.finalizeResponse(
                        this.currentProgressResponseEl,
                        this.currentProgressEl,
                        query,
                        'Processing stopped by user.',
                        [],
                        [],
                        { modelName: this.settings.model }
                    );
                    this.currentProgressResponseEl = null;
                    this.currentProgressEl = null;
                }
                return;
            }

            
            if (this.isProcessing) {
                new Notice(`MCP Error: ${errorMessage.split('\n')[0]}`);
                if (this.currentProgressResponseEl && this.currentProgressEl) {
                    this.finalizeResponse(
                        this.currentProgressResponseEl,
                        this.currentProgressEl,
                        query,
                        `**MCP query failed:** ${errorMessage.split('\n')[0]}`,
                        [],
                        [],
                        { modelName: this.settings.model }
                    );
                } else {
                    this.addResponse(
                        query,
                        `**MCP query failed:** ${errorMessage.split('\n')[0]}`,
                        [], [],
                        { modelName: this.settings.model }
                    );
                }
            }
        } finally {
            
            window.clearInterval(progressInterval);
            this.isProcessing = false;
            this.setSendButtonState(this.stopKnowDeepBtn, 'send');
            
            this.currentProgressResponseEl = null;
            this.currentProgressEl = null;
        }
    }

    private escapeRegex(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
}

/**
 * CodeCanvasModal — full-screen overlay for visualizing code execution/rendering.
 *
 * - JS/TS/HTML/CSS: split editor + interactive output (iframe with full sandbox)
 * - Mermaid/Markdown/Dataview: live preview via Obsidian's MarkdownRenderer
 * - JSON: formatted, syntax-highlighted view
 */
export class CodeCanvasModal extends Modal {
    private code: string;
    private language: string;
    private onSave?: (newCode: string) => void;
    private onUpdate?: (newCode: string) => void;
    public onCloseCallback?: () => void;
    get activeDocument() { return this.containerEl.ownerDocument; }

    constructor(app: App, code: string, language: string, onSave?: (newCode: string) => void, onUpdate?: (newCode: string) => void) {
        super(app);
        this.code = code;
        this.language = language;
        this.onSave = onSave;
        this.onUpdate = onUpdate;
    }

    public updateCode(newCode: string) {
        this.code = newCode;
        const codeArea = this.contentEl.querySelector('.code-canvas-editor') as HTMLTextAreaElement;
        if (codeArea) {
            codeArea.value = newCode;
            
            codeArea.dispatchEvent(new Event('input'));
        }
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        modalEl.addClass('code-canvas-modal');
        contentEl.addClass('code-canvas-content');
        contentEl.empty();

        const lang = this.language.toLowerCase();
        const isRender = isRenderable(lang);

        
        const header = contentEl.createDiv({ cls: 'code-canvas-header' });
        const title = header.createDiv({ cls: 'code-canvas-title' });
        const titleIcon = title.createSpan({ cls: 'code-canvas-title-icon' });
        setIcon(titleIcon, isRender ? 'eye' : 'code-2');
        title.createSpan({ text: `Canvas — ${this.language}` });

        const headerActions = header.createDiv({ cls: 'code-canvas-header-actions' });

        const copyBtn = headerActions.createEl('button', { cls: 'code-canvas-btn' });
        copyBtn.setAttribute('aria-label', 'Copy code');
        setIcon(copyBtn, 'copy');
        copyBtn.addEventListener('click', () => {
            void navigator.clipboard.writeText(this.code);
            setIcon(copyBtn, 'check');
            window.setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
        });

        const closeBtn = headerActions.createEl('button', { cls: 'code-canvas-btn' });
        closeBtn.setAttribute('aria-label', 'Close canvas');
        setIcon(closeBtn, 'x');
        closeBtn.addEventListener('click', () => this.close());

        
        const body = contentEl.createDiv({ cls: 'code-canvas-body' });

        if (isRender || lang === 'json') {
            this.buildRenderLayout(body, lang, headerActions);
        } else {
            this.buildExecLayout(body, lang, headerActions);
        }
    }

    
    private buildRenderLayout(body: HTMLElement, lang: string, headerActions: HTMLElement) {
        
        const outputPanel = body.createDiv({ cls: 'code-canvas-panel code-canvas-output-panel code-canvas-full' });
        const outputPanelHeader = outputPanel.createDiv({ cls: 'code-canvas-panel-header' });
        outputPanelHeader.createSpan({ text: 'Preview' });

        const clearBtn = outputPanelHeader.createEl('button', { cls: 'code-canvas-btn' });
        clearBtn.setAttribute('aria-label', 'Clear preview');
        setIcon(clearBtn, 'trash-2');
        clearBtn.addEventListener('click', () => { previewArea.empty(); });

        const previewArea = outputPanel.createDiv({ cls: 'code-canvas-output code-canvas-render-area' });

        
        const codePanel = body.createDiv({ cls: 'code-canvas-panel code-canvas-code-panel code-canvas-hidden' });
        const codePanelHeader = codePanel.createDiv({ cls: 'code-canvas-panel-header' });
        codePanelHeader.createSpan({ text: 'Code' });

        const refreshBtn = codePanelHeader.createEl('button', { cls: 'code-canvas-run-btn' });
        const refreshIcon = refreshBtn.createSpan();
        setIcon(refreshIcon, 'refresh-cw');
        refreshBtn.createSpan({ text: 'Render' });
        refreshBtn.setAttribute('aria-label', 'Render preview');

        const saveBtn = codePanelHeader.createEl('button', { cls: 'code-canvas-run-btn code-canvas-save-btn' });
        const saveIcon = saveBtn.createSpan();
        setIcon(saveIcon, 'save');
        saveBtn.createSpan({ text: 'Save' });
        saveBtn.setAttribute('aria-label', 'Save changes to response');
        saveBtn.addClass('nl-display-none');

        const codeArea = codePanel.createEl('textarea', { cls: 'code-canvas-editor' });
        codeArea.value = this.code;
        codeArea.spellcheck = false;

        
        const codeToggleBtn = headerActions.createEl('button', { cls: 'code-canvas-btn code-canvas-view-code-btn' });
        codeToggleBtn.setAttribute('aria-label', 'Toggle code editor');
        setIcon(codeToggleBtn, 'code-2');
        let codeVisible = false;
        codeToggleBtn.addEventListener('click', () => {
            codeVisible = !codeVisible;
            if (codeVisible) {
                codePanel.removeClass('code-canvas-hidden');
                outputPanel.removeClass('code-canvas-full');
                codeToggleBtn.addClass('is-active');
            } else {
                codePanel.addClass('code-canvas-hidden');
                outputPanel.addClass('code-canvas-full');
                codeToggleBtn.removeClass('is-active');
            }
        });
        
        headerActions.insertBefore(codeToggleBtn, headerActions.firstChild);

        
        const render = async () => {
            previewArea.empty();
            const code = codeArea.value;

            if (lang === 'json') {
                const result = await executeCode(code, 'json');
                if (result.isHtml && result.htmlContent) {
                    const iframe = createDetached(this.activeDocument, 'iframe');
                    iframe.className = 'code-exec-iframe code-canvas-iframe';
                    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
                    iframe.srcdoc = result.htmlContent;
                    previewArea.addClass('nl-padding-0');
                    previewArea.appendChild(iframe);
                    const onMsg = (e: MessageEvent) => {
                        const data = e.data as unknown as Partial<IframeResizeMessage>;
                        if (data?.iframeHeight) {
                            iframe.setCssProps({ '--iframe-height':  data.iframeHeight + 'px' });
                            window.removeEventListener('message', onMsg);
                        }
                    };
                    window.addEventListener('message', onMsg);
                } else if (result.isMarkdown && result.markdownContent) {
                    previewArea.addClass('nl-padding-');
                    { const _comp = new Component();
                    void MarkdownRenderer.render(this.app, result.markdownContent, previewArea, '', _comp);
                    _comp.load(); }
                } else if (!result.success) {
                    previewArea.createEl('pre', { cls: 'code-exec-output-text', text: `Error: ${result.error}` });
                }
                return;
            }

            const fenced = lang === 'markdown' || lang === 'md'
                ? code
                : wrapInMarkdownFence(code, lang);
            { const _comp = new Component();
            void MarkdownRenderer.render(this.app, fenced, previewArea, '', _comp);
            _comp.load(); }
        };

        refreshBtn.addEventListener('click', () => void render());

        let debounceTimer: number;
        codeArea.addEventListener('input', () => {
            window.clearTimeout(debounceTimer);
            debounceTimer = window.setTimeout(() => void render(), 600);
            saveBtn.toggleClass('nl-display-none', !(codeArea.value !== this.code));
            if (this.onUpdate) this.onUpdate(codeArea.value);
        });

        saveBtn.addEventListener('click', () => {
            const newCode = codeArea.value;
            if (this.onSave) this.onSave(newCode);
            this.code = newCode;
            saveBtn.addClass('nl-display-none');
            setIcon(saveIcon, 'check');
            window.setTimeout(() => setIcon(saveIcon, 'save'), 1500);
        });

        void render();
    }

    
    private buildExecLayout(body: HTMLElement, lang: string, headerActions: HTMLElement) {
        
        const outputPanel = body.createDiv({ cls: 'code-canvas-panel code-canvas-output-panel code-canvas-full' });
        const outputPanelHeader = outputPanel.createDiv({ cls: 'code-canvas-panel-header' });
        outputPanelHeader.createSpan({ text: 'Output' });

        const clearBtn = outputPanelHeader.createEl('button', { cls: 'code-canvas-btn' });
        clearBtn.setAttribute('aria-label', 'Clear output');
        setIcon(clearBtn, 'trash-2');
        clearBtn.addEventListener('click', () => {
            outputArea.empty();
            outputArea.classList.remove('has-error');
        });

        const outputArea = outputPanel.createDiv({ cls: 'code-canvas-output' });

        
        const codePanel = body.createDiv({ cls: 'code-canvas-panel code-canvas-code-panel code-canvas-hidden' });
        const codePanelHeader = codePanel.createDiv({ cls: 'code-canvas-panel-header' });
        codePanelHeader.createSpan({ text: 'Code' });

        const runBtn = codePanelHeader.createEl('button', { cls: 'code-canvas-run-btn' });
        const runIcon = runBtn.createSpan();
        setIcon(runIcon, 'play');
        runBtn.createSpan({ text: 'Run' });
        runBtn.setAttribute('aria-label', 'Run code');

        const saveBtn = codePanelHeader.createEl('button', { cls: 'code-canvas-run-btn code-canvas-save-btn' });
        const saveIcon = saveBtn.createSpan();
        setIcon(saveIcon, 'save');
        saveBtn.createSpan({ text: 'Save' });
        saveBtn.setAttribute('aria-label', 'Save changes to response');
        saveBtn.addClass('nl-display-none');

        const codeArea = codePanel.createEl('textarea', { cls: 'code-canvas-editor' });
        codeArea.value = this.code;
        codeArea.spellcheck = false;

        
        const codeToggleBtn = headerActions.createEl('button', { cls: 'code-canvas-btn code-canvas-view-code-btn' });
        codeToggleBtn.setAttribute('aria-label', 'Toggle code editor');
        setIcon(codeToggleBtn, 'code-2');
        let codeVisible = false;
        codeToggleBtn.addEventListener('click', () => {
            codeVisible = !codeVisible;
            if (codeVisible) {
                codePanel.removeClass('code-canvas-hidden');
                outputPanel.removeClass('code-canvas-full');
                codeToggleBtn.addClass('is-active');
            } else {
                codePanel.addClass('code-canvas-hidden');
                outputPanel.addClass('code-canvas-full');
                codeToggleBtn.removeClass('is-active');
            }
        });
        headerActions.insertBefore(codeToggleBtn, headerActions.firstChild);

        
        const run = async () => {
            const code = codeArea.value;
            outputArea.empty();
            outputArea.classList.remove('has-error');

            const spinner = outputArea.createSpan({ cls: 'code-exec-spinner' });
            setIcon(spinner, 'loader');

            const result = await executeCode(code, lang);
            outputArea.empty();

            if (result.isHtml && result.htmlContent) {
                const iframe = createDetached(this.activeDocument, 'iframe');
                iframe.className = 'code-exec-iframe code-canvas-iframe';
                iframe.setAttribute('sandbox',
                    'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-modals allow-popups'
                );
                iframe.srcdoc = result.htmlContent;
                outputArea.appendChild(iframe);
                const onMsg = (e: MessageEvent) => {
                    const data = e.data as unknown as Partial<IframeResizeMessage>;
                    if (data?.iframeHeight && iframe.isConnected) {
                        iframe.setCssProps({ '--iframe-height':  data.iframeHeight + 'px' });
                        window.removeEventListener('message', onMsg);
                    }
                };
                window.addEventListener('message', onMsg);
            } else if (result.isMarkdown && result.markdownContent) {
                outputArea.classList.add('code-canvas-render-area');
                { const _comp = new Component();
                void MarkdownRenderer.render(this.app, result.markdownContent, outputArea, '', _comp);
                _comp.load(); }
            } else if (result.success) {
                const pre = outputArea.createEl('pre', { cls: 'code-exec-output-text' });
                pre.textContent = result.output;
            } else {
                outputArea.classList.add('has-error');
                const pre = outputArea.createEl('pre', { cls: 'code-exec-output-text' });
                pre.textContent = `Error: ${result.error}`;
                if (result.output) pre.textContent += `\n\n${result.output}`;
            }
        };

        runBtn.addEventListener('click', () => void run());

        codeArea.addEventListener('input', () => {
            saveBtn.toggleClass('nl-display-none', !(codeArea.value !== this.code));
            if (this.onUpdate) this.onUpdate(codeArea.value);
        });

        saveBtn.addEventListener('click', () => {
            const newCode = codeArea.value;
            if (this.onSave) this.onSave(newCode);
            this.code = newCode;
            saveBtn.addClass('nl-display-none');
            setIcon(saveIcon, 'check');
            window.setTimeout(() => setIcon(saveIcon, 'save'), 1500);
        });

        
        if (lang === 'html' || lang === 'css' || lang === 'svg') {
            void run();
            let debounceTimer: number;
            codeArea.addEventListener('input', () => {
                window.clearTimeout(debounceTimer);
                debounceTimer = window.setTimeout(() => { run().catch(console.error); }, 800);
            });
        }
    }

    onClose() {
        if (this.onCloseCallback) this.onCloseCallback();
        this.contentEl.empty();
    }
}
