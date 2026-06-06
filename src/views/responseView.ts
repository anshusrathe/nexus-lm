import { App, ItemView, WorkspaceLeaf, ButtonComponent, Notice, MarkdownRenderer, TFile, Component, SuggestModal, ToggleComponent, TFolder, Modal, Setting, setIcon, normalizePath, requestUrl, Platform } from 'obsidian';
import { decode } from '@msgpack/msgpack';
import { OramaWorkerManager } from '../utils/oramaWorkerManager';
import { AISettings, Provider, getModelsGroupedByProvider, getModelDisplayName as getModelDisplayNameFromSettings, getProviderForModel, getProviderForEmbeddingModel, SavedSystemInstruction, getGeminiThinkingConfig, getModelTemperature, getModelTopP } from '../settings';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { TokenEstimator, TaskType } from '../utils/tokenEstimator';
import { ModelSelector, ModelSelection } from '../modelSelector';
import AIPlugin from '../main';
import { WebSearchService, SearchResult as WebSearchResult } from '../services/webSearch';
import { VaultSearchAgent, VaultSearchResult } from '../managers/vaultSearchAgent';
import { BasicChatService } from '../services/basicChatService';
import { OllamaService } from '../services/ollamaService';
import { extractTextFromImage } from '../utils/utils';
import { UnifiedProviderManager } from '../services/unifiedProviderManager';
import { AIChatSessionManager, AIChatSessionMeta, AIChatSession } from '../managers/aiChatSessionManager';
import { YouTubeChatService } from '../services/youtubeChatService';
import { YouTubeTranscriptModal } from '../modals/youtubeTranscriptModal';
import { handleFileCreationPrompt, processDiagramContent } from '../tools/fileCreateTool';
import { MultimodalInput, processFileForMultimodal, isTextFile, isImageFile, isPDFFile, isAudioFile, isVideoFile, isMultimodalSupported, getFileIcon, extractImagesFromMarkdown } from '../utils/multimodalUtils';
import { RateLimitManager } from '../utils/rateLimitManager';
import { GeminiService } from '../services/geminiService';
import { GeminiFileAPIService } from '../services/geminiFileAPI';
import { MCPServerSelectionModal, MCPServerSelection } from '../modals/mcpServerSelectionModal';
import { MCPToolCallingService, sanitizeServerName } from '../mcp/mcpToolCalling';
import { executeCode, detectLanguage, isExecutable, isRenderable, isEnhanceable, wrapInMarkdownFence } from '../tools/codeExecutor';
import { SaveNoteModal } from '../modals/saveNoteModal';

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
    fileActionData?: { [actionId: string]: any }; 
    
    modelName?: string; 
    totalTokens?: number; 
    responseTimeMs?: number; 
    
    mcpTools?: Array<{
        server: string;
        tool: string;
    }>;
    
    searchMode?: 'vault' | 'flash';
    
    vaultIndexName?: string;
    
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

interface FileActionState {
    id: string;
    type: 'edit' | 'create';
    fileName: string;
    status: 'processing' | 'completed' | 'failed' | 'accepted' | 'rejected';
    element: HTMLElement;
    data?: any; 
    error?: string;
    isApplied?: boolean; 
    originalFileContent?: string; 
    isExcalidraw?: boolean; 
}

type PauseResumeTimerCallback = (pause: boolean) => void;

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
        el.createEl("div", { text: file.path });
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
        const folders = this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder) as TFolder[];
        return folders.filter((folder: TFolder) =>
            folder.path.toLowerCase().includes(query.toLowerCase())
        );
    }

    renderSuggestion(folder: TFolder, el: HTMLElement) {
        el.createEl("div", { text: folder.path + '/' });
    }

    onChooseSuggestion(folder: TFolder) {
        const value = this.queryInput.value;
        const beforeCursor = value.slice(0, this.cursorPosition - 1);
        const afterCursor = value.slice(this.cursorPosition);

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
        el.createEl("div", { text: file.path });
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
                text.inputEl.style.width = '100%';
                
                setTimeout(() => text.inputEl.focus(), 50);
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
                if (!/^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|live\/)|youtu\.be\/)/.test(url)) {
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
        const { contentEl } = this;
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
                setTimeout(() => input.focus(), 50);
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

        
        setTimeout(() => this.textarea.focus(), 50);

        
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

        setTimeout(() => nameInput.focus(), 50);

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
                itemContent.createEl('span', { text: saved.name, cls: 'collections-item-name' });
                itemContent.createEl('span', {
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
                editIconBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    this.showIconPickerForItem(index, iconEl, collectionsModal);
                });

                
                const deleteBtn = itemEl.createEl('button', {
                    cls: 'collections-item-delete',
                    attr: { 'aria-label': 'Delete' }
                });
                setIcon(deleteBtn, 'x');
                deleteBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    this.settings.savedSystemInstructions.splice(index, 1);
                    await this.saveSettingsCallback();
                    new Notice(`Deleted "${saved.name}"`);
                    
                    this.showCollectionsModal();
                    collectionsModal.close();
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
        setTimeout(() => searchInput.focus(), 50);

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
    private selectedFilesDisplay!: HTMLElement;
    private plugin: AIPlugin;
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
    private answerRenderTimeout: any | null = null;

    
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
                
                const viewWithSession = view as any;
                if (viewWithSession.currentSessionId === sessionId) {
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
            fileTagsScrollWrapper.style.display = 'none';
            if (toggleBtn) {
                toggleBtn.empty();
                toggleBtn.createSpan({ text: '▶', attr: { style: 'font-size:18px;user-select:none;' } });
            }
        } else {
            fileTagsScrollWrapper.style.display = '';
            if (toggleBtn) {
                toggleBtn.empty();
                toggleBtn.createSpan({ text: '▼', attr: { style: 'font-size:18px;user-select:none;' } });
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
        this.headerSection = headerSection;

        
        if (this.settings.chatWallpaperEnabled && this.settings.chatWallpaperPath) {
            headerSection.classList.add('liquid-glass-active');
        }

        
        const headerLeftControls = headerSection.createDiv({ cls: 'header-left-controls' });

        
        if (this.settings.aiChatHistoryEnabled) {
            const historyBtn = headerLeftControls.createDiv({ cls: 'header-history-btn' });
            setIcon(historyBtn, 'history');
            historyBtn.style.cursor = 'pointer';
            historyBtn.setAttr('aria-label', 'View chat history');
            historyBtn.setAttr('tabindex', '0');
            historyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openSessionHistoryModal();
            });
        }

        
        const dbIndexBtn = headerLeftControls.createDiv({ cls: 'header-db-index-btn header-history-btn' });
        setIcon(dbIndexBtn, 'database-zap');
        dbIndexBtn.setAttr('aria-label', 'Change embedding index');
        dbIndexBtn.setAttr('tabindex', '0');
        dbIndexBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showEmbeddingIndexMenu(dbIndexBtn);
        });

        
        const systemInstructionsBtn = headerLeftControls.createDiv({ cls: 'header-system-instructions-btn' });
        setIcon(systemInstructionsBtn, 'wrench');
        systemInstructionsBtn.style.cursor = 'pointer';
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
        newChatBtn.style.cursor = 'pointer';
        newChatBtn.setAttr('aria-label', 'Start new chat');
        newChatBtn.setAttr('tabindex', '0');
        newChatBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.startNewSession();
        });


        
        const headerRightControls = headerSection.createDiv({ cls: 'header-right-controls' });

        
        const headerModelBtn = new ButtonComponent(headerRightControls)
            .setButtonText(this.getModelButtonText())
            .setClass('header-model-btn')
            .onClick(() => this.showModelMenu());

        this.renderOllamaThinkingButton(headerRightControls);

        
        const ellipsisBtn = headerRightControls.createDiv({ cls: 'header-ellipsis-btn' });
        setIcon(ellipsisBtn, 'more-vertical');
        ellipsisBtn.style.cursor = 'pointer';
        ellipsisBtn.setAttr('aria-label', 'Menu options');
        ellipsisBtn.setAttr('tabindex', '0');
        ellipsisBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showHeaderMenu(ellipsisBtn);
        });

        this.contentContainer = wrapper.createDiv({ cls: 'responses-container' });

        
        this.inputContainer = wrapper.createDiv({ cls: 'chat-input-container' });

        
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
        capsuleBtn.style.cursor = 'pointer';
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
        sendBtn.style.cursor = 'pointer';
        sendBtn.setAttr('aria-label', 'Send message');
        sendBtn.setAttr('tabindex', '0');
        sendBtn.setAttr('data-state', 'send'); 

        sendBtn.addEventListener('click', async () => {
            const currentState = sendBtn.getAttribute('data-state');

            if (currentState === 'send') {
                
                const query = this.queryInput.value;
                if (query.trim()) {
                    this.loadingSpinner.classList.add('visible');
                    try {
                        await this.processQuery(query);
                        this.loadingSpinner.classList.remove('visible');
                        this.queryInput.value = '';
                        this.adjustTextareaHeight();
                    } catch (error) {
                        this.loadingSpinner.classList.remove('visible');
                        
                        if (error instanceof Error && error.message.startsWith('PRESERVE_INPUT:')) {
                            
                                                    } else {
                            
                            this.queryInput.value = '';
                            
                            throw error;
                        }
                        this.adjustTextareaHeight();
                    }
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
            'Use prefix @webpage (with Gemini & Ollama)...',
            'Use prefix @vault for semantic vault search...',
            'Use prefix @flash for faster vault search via keyword...',
            'Use prefix @web for web searched answers...',
            'Use prefix @mcp to use MCP servers and tools...'
        ];
        let promptIndex = 0;
        let placeholderInterval: any = null;
        let isInputActive = false;
        const setNextPlaceholder = () => {
            if (!isInputActive && document.activeElement !== this.queryInput) {
                promptIndex = (promptIndex + 1) % prompts.length;
                if (this.queryInput.value.trim() === '') {
                    this.queryInput.setAttribute('placeholder', prompts[promptIndex]);
                }
            }
        };
        placeholderInterval = setInterval(setNextPlaceholder, 3500);
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
            isInputActive = (document.activeElement === this.queryInput && this.queryInput.value.trim() !== '');
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

        this.queryInput.addEventListener('keydown', async (e) => {
            
            if (this.contextMenuEl && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();

                const items = Array.from(this.contextMenuEl.querySelectorAll('.context-file-menu-item:not([style*="opacity: 0.5"])')) as HTMLElement[];
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

                
                await this.updateContextMenuPreview(items[currentIndex]);

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

            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const query = this.queryInput.value;
                if (query.trim()) {
                    this.loadingSpinner.classList.add('visible');
                    try {
                        await this.processQuery(query);
                        this.loadingSpinner.classList.remove('visible');
                        this.queryInput.value = '';
                        this.adjustTextareaHeight();
                    } catch (error) {
                        this.loadingSpinner.classList.remove('visible');
                        
                        if (error instanceof Error && error.message.startsWith('PRESERVE_INPUT:')) {
                            
                                                    } else {
                            
                            this.queryInput.value = '';
                            
                            throw error;
                        }
                        this.adjustTextareaHeight();
                    }
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
            parent.style.minHeight = parent.clientHeight + 'px';
        }

        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';

        
        if (parent) {
            parent.style.minHeight = '';
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
        requestAnimationFrame(() => {
            if (!nameSpan.parentElement) return;
            
            // Fixed available width: button width (130px) minus padding and icon
            // Icon is ~14px + 4px gap. Padding is 8px each side.
            const maxAllowedWidth = 96; // 130 - 16 - 18
            const currentWidth = nameSpan.scrollWidth;

            if (currentWidth > maxAllowedWidth) {
                const ratio = maxAllowedWidth / currentWidth;
                nameSpan.style.transform = `scale(${ratio})`;
                nameSpan.style.width = `${currentWidth}px`; // Force span to maintain its natural width so scale works
                nameSpan.style.marginLeft = `${(maxAllowedWidth - currentWidth) / 2}px`; // Center the scaled text
                nameSpan.style.marginRight = `${(maxAllowedWidth - currentWidth) / 2}px`;
            } else {
                nameSpan.style.transform = 'none';
                nameSpan.style.width = 'auto';
                nameSpan.style.margin = '0';
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
        
        if (this.settings.autoModeEnabled) return;

        const activeProvider = this.getActiveChatProvider();
        if (activeProvider !== 'ollama' && activeProvider !== 'gemini' && activeProvider !== 'groq') return;
        const currentModelId = this.getActiveChatModelId();
        
        
        const groqGptOssRegex = /^openai\/gpt-oss(-safeguard)?-(20b|120b)$/i;
        const isGroqGptOss = activeProvider === 'groq' && groqGptOssRegex.test(currentModelId);
        
        
        if (activeProvider === 'groq' && !isGroqGptOss) return;
        
        
        if (activeProvider === 'ollama') {
            const ollamaModel = this.settings.customModels.find(m => m.provider === 'ollama' && m.id === currentModelId);
            if (!ollamaModel?.capabilities?.includes('thinking')) return;
        }

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
        brainBtn.style.cursor = 'pointer';
        brainBtn.setAttr('aria-label', `${activeProvider === 'gemini' ? 'Gemini' : activeProvider === 'groq' ? 'Groq' : 'Ollama'} thinking controls`);
        brainBtn.setAttr('tabindex', '0');
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

        brainBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.handleOllamaThinkingControlClick(brainBtn);
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
            item.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (activeProvider === 'groq') {
                    this.settings.groqThinkingLevel = level;
                } else {
                    this.settings.ollamaGptOssThinkingLevel = level;
                }
                await this.plugin.saveSettings();
                menuEl.remove();
                this.updateHeader();
            });
        });

        const btnRect = anchorEl.getBoundingClientRect();
        const containerRect = this.containerEl.getBoundingClientRect();
        menuEl.style.position = 'absolute';
        menuEl.style.top = `${btnRect.bottom - containerRect.top + 4}px`;
        menuEl.style.right = `${containerRect.right - btnRect.right}px`;

        const closeHandler = (e: MouseEvent) => {
            if (!menuEl.contains(e.target as Node) &&
                !(e.target as Element).closest('.header-ollama-thinking-btn')) {
                menuEl.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
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
            item.addEventListener('click', async (e) => {
                e.stopPropagation();
                this.settings.gemini25ThinkingMode = option.id;
                this.settings.enableThinkingMode = option.id !== 'off';
                await this.plugin.saveSettings();
                menuEl.remove();
                this.updateHeader();
            });
        });

        const btnRect = anchorEl.getBoundingClientRect();
        const containerRect = this.containerEl.getBoundingClientRect();
        menuEl.style.position = 'absolute';
        menuEl.style.top = `${btnRect.bottom - containerRect.top + 4}px`;
        menuEl.style.right = `${containerRect.right - btnRect.right}px`;
        const closeHandler = (e: MouseEvent) => {
            if (!menuEl.contains(e.target as Node) &&
                !(e.target as Element).closest('.header-ollama-thinking-btn')) {
                menuEl.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
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
            item.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (option.id === 'off') {
                    this.settings.enableThinkingMode = false;
                } else {
                    this.settings.gemini3ThinkingLevel = option.id;
                    this.settings.enableThinkingMode = true;
                }
                await this.plugin.saveSettings();
                menuEl.remove();
                this.updateHeader();
            });
        });

        const btnRect = anchorEl.getBoundingClientRect();
        const containerRect = this.containerEl.getBoundingClientRect();
        menuEl.style.position = 'absolute';
        menuEl.style.top = `${btnRect.bottom - containerRect.top + 4}px`;
        menuEl.style.right = `${containerRect.right - btnRect.right}px`;
        const closeHandler = (e: MouseEvent) => {
            if (!menuEl.contains(e.target as Node) &&
                !(e.target as Element).closest('.header-ollama-thinking-btn')) {
                menuEl.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
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
        menuEl.style.position = 'absolute';
        menuEl.style.top = `${rect.bottom - containerRect.top + 5}px`;
        menuEl.style.left = `${rect.left - containerRect.left}px`;
        menuEl.style.zIndex = '1000';
        menuEl.style.minWidth = '250px';
        menuEl.style.maxHeight = '400px';
        menuEl.style.overflowY = 'auto';
        menuEl.style.backgroundColor = 'var(--background-primary)';
        menuEl.style.border = '1px solid var(--background-modifier-border)';
        menuEl.style.borderRadius = '6px';
        menuEl.style.boxShadow = 'var(--shadow-s)';
        menuEl.style.padding = '4px';

        const indexConfigs = this.settings.indexConfigurations || [];
        const embeddingIndexes = indexConfigs.filter(config => config.type === 'embedding');

        if (embeddingIndexes.length === 0) {
            const emptyMsg = menuEl.createDiv({ cls: 'model-select-menu-item' });
            emptyMsg.createSpan({ text: 'No embedding indexes found' });
            emptyMsg.style.cursor = 'default';
        } else {
            embeddingIndexes.forEach((index, idx) => {
                const itemEl = menuEl.createDiv({ cls: 'model-select-menu-item' });
                itemEl.style.display = 'flex';
                itemEl.style.flexDirection = 'column';
                itemEl.style.padding = '8px 12px';
                itemEl.style.gap = '2px';

                if (this.settings.selectedEmbeddingIndexId === index.id) {
                    itemEl.classList.add('selected');
                }

                
                const topRow = itemEl.createDiv();
                topRow.style.display = 'flex';
                topRow.style.justifyContent = 'space-between';
                topRow.style.alignItems = 'center';
                topRow.style.width = '100%';

                const leftInfo = topRow.createDiv();
                leftInfo.style.display = 'flex';
                leftInfo.style.alignItems = 'center';
                leftInfo.style.gap = '8px';

                const nameSpan = leftInfo.createSpan();
                nameSpan.textContent = index.name;
                nameSpan.style.fontWeight = 'var(--font-semibold)';

                const countSpan = leftInfo.createSpan();
                countSpan.textContent = `(${index.fileCount || 0} files)`;
                countSpan.style.fontSize = '0.8em';
                countSpan.style.color = 'var(--text-muted)';

                const checkbox = topRow.createEl('input', { type: 'checkbox' });
                checkbox.checked = this.settings.selectedEmbeddingIndexId === index.id;
                checkbox.style.pointerEvents = 'none'; 

                
                const bottomRow = itemEl.createDiv();
                const modelSpan = bottomRow.createSpan();
                modelSpan.textContent = index.model || 'Unknown model';
                modelSpan.style.fontSize = '0.85em';
                modelSpan.style.color = 'var(--text-muted)';

                itemEl.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const oldId = this.settings.selectedEmbeddingIndexId;
                    this.settings.selectedEmbeddingIndexId = index.id;
                    await this.plugin.saveSettings();
                    menuEl.remove();
                    
                    
                    if (oldId !== index.id) {
                        await this.plugin.embeddingsManager.loadIndex(index.id);
                    }
                    
                    new Notice(`Selected embedding index: ${index.name}`);
                });

                
                if (idx < embeddingIndexes.length - 1) {
                    menuEl.createEl('hr', { cls: 'menu-separator' });
                }
            });
        }

        
        const closeHandler = (e: MouseEvent) => {
            if (!menuEl.contains(e.target as Node) && !anchorEl.contains(e.target as Node)) {
                menuEl.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
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
        toggleCheckbox.addEventListener('change', async () => {
            this.settings.autoModeEnabled = toggleCheckbox.checked;
            await this.plugin.saveSettings();

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
        });

        
        menuEl.createEl('hr', { cls: 'menu-separator-full' });

        
        const searchContainer = menuEl.createDiv({ 
            cls: 'model-search-container',
            attr: { style: `position: sticky; top: 0; background: var(--background-primary); z-index: 2; padding: 8px; border-bottom: 1px solid var(--background-modifier-border);${this.settings.autoModeEnabled ? ' display: none;' : ''}` }
        });
        const searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search models...',
            cls: 'model-search-input',
            attr: { style: 'width: 100%; box-sizing: border-box;' }
        });
        searchInput.addEventListener('keydown', (e) => e.stopPropagation());
        setTimeout(() => searchInput.focus(), 100);

        const itemsToFilter: { itemEl: HTMLElement, name: string }[] = [];
        const headersToFilter: { headerEl: HTMLElement, items: HTMLElement[], separatorEl?: HTMLElement }[] = [];

        
        const modelList = menuEl.createDiv({ cls: 'model-list' });
        if (this.settings.autoModeEnabled) {
            modelList.classList.add('disabled');
        }

        
        const modelGroups = getModelsGroupedByProvider(this.settings);

        
        modelGroups.forEach((group, groupIndex) => {
            
            const headerEl = modelList.createDiv({ cls: 'model-select-menu-header' });
            headerEl.style.display = 'flex';
            headerEl.style.justifyContent = 'space-between';
            headerEl.style.alignItems = 'center';
            headerEl.style.paddingRight = '8px';

            const headerTitle = headerEl.createSpan();
            headerTitle.textContent = group.label === 'Google Gemini' ? 'Gemini' : group.label;

            
            const modalitiesContainer = headerEl.createSpan({ cls: 'provider-modalities' });
            modalitiesContainer.style.display = 'flex';
            modalitiesContainer.style.gap = '4px';
            modalitiesContainer.style.alignItems = 'center';

            const addModalityIcon = (iconName: string) => {
                const iconEl = modalitiesContainer.createSpan();
                setIcon(iconEl, iconName);
                const svg = iconEl.querySelector('svg');
                if (svg) {
                    svg.style.opacity = '0.7';
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
                iconsContainer.style.display = 'flex';
                iconsContainer.style.gap = '4px';
                iconsContainer.style.alignItems = 'center';

                
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

                option.addEventListener('click', async () => {
                    
                    this.settings.aiChatModel = model.id;
                    this.settings.aiChatProvider = model.provider;
                    
                    this.settings.model = model.id;
                    this.settings.provider = model.provider;
                    if (modelBtn) modelBtn.textContent = model.name;
                    menuEl.remove();
                    await this.plugin.saveSettings();
                    
                    this.updateContextBar();
                    
                    this.updateHeader();
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
                obj.itemEl.style.display = obj.name.includes(query) ? '' : 'none';
            });
            headersToFilter.forEach(headerObj => {
                const hasVisibleItems = headerObj.items.some(item => item.style.display !== 'none');
                headerObj.headerEl.style.display = hasVisibleItems ? '' : 'none';
                if (headerObj.separatorEl) headerObj.separatorEl.style.display = hasVisibleItems ? '' : 'none';
            });
        });

        const btnRect = modelBtn.getBoundingClientRect();
        const containerRect = this.containerEl.getBoundingClientRect();

        
        menuEl.style.position = 'absolute';
        menuEl.style.top = `${btnRect.bottom - containerRect.top + 4}px`;
        menuEl.style.right = `${containerRect.right - btnRect.right}px`;

        const closeHandler = (e: MouseEvent) => {
            if (!menuEl.contains(e.target as Node) &&
                !(e.target as Element).closest('.header-model-btn')) {
                menuEl.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
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

        
        setTimeout(() => {
            indicator.style.opacity = '0';
            setTimeout(() => indicator.remove(), 300);
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

            
            const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
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

        } catch (error) {
                        
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
                    this.settings.provider = model.provider as Provider;
                    this.settings.model = model.modelId;

                    const result = await apiCall();

                    
                    let isBlank = false;
                    if (typeof result === 'string' && result.trim() === '') {
                        isBlank = true;
                    } else if (result && typeof result === 'object') {
                        
                        const r = result as any;
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
                    const errorMsg = error instanceof Error ? error.message.toLowerCase() : '';
                    
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
    private isErrorResponse(result: any, operationName: string): string | false {
        
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
            
            if (result.answer) textToCheck = result.answer.toLowerCase();
            else if (result.response) textToCheck = result.response.toLowerCase();
            else if (result.content) textToCheck = result.content.toLowerCase();
            else if (result.text) textToCheck = result.text.toLowerCase();
            else if (result.message) textToCheck = result.message.toLowerCase();
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
            this.saveSession();
            menuEl.remove();
        });

        
        const historyToggleOption = menuEl.createDiv({ cls: 'header-menu-item header-menu-toggle' });
        setIcon(historyToggleOption, 'history');
        historyToggleOption.createSpan({ text: 'Chat History' });
        const historyToggle = historyToggleOption.createEl('input', { type: 'checkbox' });
        historyToggle.checked = this.settings.aiChatHistoryEnabled;
        historyToggle.addEventListener('change', async () => {
            this.settings.aiChatHistoryEnabled = historyToggle.checked;
            await this.plugin.saveSettings();
            
            this.updateHeader();
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
        contextSlider.addEventListener('input', async () => {
            this.settings.chatContextSize = parseInt(contextSlider.value);
            contextLabel.textContent = `Context: ${this.settings.chatContextSize} ${this.settings.chatContextSize === 1 ? 'exchange' : 'exchanges'}`;
            await this.plugin.saveSettings();
            this.updateContextBar();
        });

        
        const wallpaperOption = menuEl.createDiv({ cls: 'header-menu-item' });
        const hasWallpaper = !!this.settings.chatWallpaperPath;
        setIcon(wallpaperOption, 'image');
        wallpaperOption.createSpan({ text: hasWallpaper ? 'Remove Wallpaper' : 'Add Wallpaper' });
        wallpaperOption.addEventListener('click', async () => {
            menuEl.remove();
            if (hasWallpaper) {
                this.settings.chatWallpaperPath = null;
                await this.plugin.saveSettings();
                this.updateWallpaper();
                new Notice('Wallpaper removed');
            } else {
                this.pickWallpaperImage();
            }
        });

        const btnRect = ellipsisBtn.getBoundingClientRect();
        menuEl.style.position = 'absolute';
        menuEl.style.top = `${btnRect.bottom + 4}px`;
        menuEl.style.right = '10px';

        const closeHandler = (e: MouseEvent) => {
            if (!menuEl.contains(e.target as Node) &&
                !(e.target as Element).closest('.header-ellipsis-btn')) {
                menuEl.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
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

        const pickerEl = document.createElement('div');
        pickerEl.className = 'wallpaper-picker';
        pickerEl.style.position = 'absolute';
        pickerEl.style.zIndex = '1000';
        pickerEl.style.background = 'var(--background-primary, #ffffff)';
        pickerEl.style.border = '1px solid var(--border-color, #e0e0e0)';
        pickerEl.style.borderRadius = '8px';
        pickerEl.style.padding = '8px';
        pickerEl.style.maxHeight = '300px';
        pickerEl.style.overflowY = 'auto';
        pickerEl.style.minWidth = '250px';
        pickerEl.classList.add('wallpaper-picker-shadow');
        pickerEl.style.color = 'var(--text-normal, #000000)';

        const btnRect = this.containerEl.querySelector('.header-ellipsis-btn')?.getBoundingClientRect();
        if (btnRect) {
            pickerEl.style.top = `${btnRect.bottom + 4}px`;
            pickerEl.style.right = '10px';
        }

        const titleEl = pickerEl.createDiv({ cls: 'wallpaper-picker-title' });
        titleEl.textContent = 'Select Wallpaper Image';
        titleEl.style.fontWeight = 'bold';
        titleEl.style.marginBottom = '8px';
        titleEl.style.padding = '4px';
        titleEl.style.color = 'var(--text-normal, #000000)';

        for (const file of images) {
            const itemEl = pickerEl.createDiv({ cls: 'wallpaper-picker-item' });
            itemEl.textContent = file.path;
            itemEl.style.padding = '6px 8px';
            itemEl.style.cursor = 'pointer';
            itemEl.style.borderRadius = '4px';
            itemEl.style.color = 'var(--text-normal, #000000)';
            itemEl.style.background = 'transparent';
            itemEl.addEventListener('mouseenter', () => {
                itemEl.style.background = 'var(--hover-bg, #e0e0e0)';
            });
            itemEl.addEventListener('mouseleave', () => {
                itemEl.style.background = 'transparent';
            });
            itemEl.addEventListener('click', () => {
                pickerEl.remove();
                this.setWallpaper(file.path);
            });
        }

        document.body.appendChild(pickerEl);

        const closeHandler = (e: MouseEvent) => {
            if (!pickerEl.contains(e.target as Node)) {
                pickerEl.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
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
        const queryInput = container.querySelector('.query-input-new') as HTMLTextAreaElement | null;

        
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
        
        this.wallpaperEl.style.position = 'absolute';
        this.wallpaperEl.style.top = '0';
        this.wallpaperEl.style.left = '0';
        this.wallpaperEl.style.width = '100%';
        this.wallpaperEl.style.height = '100%';
        this.wallpaperEl.style.zIndex = '0';
        this.wallpaperEl.style.pointerEvents = 'none';
        this.wallpaperEl.style.display = 'block';
        this.wallpaperEl.style.overflow = 'hidden';

        const wallpaperOpacity = this.settings.chatWallpaperOpacity ?? 0.5;
        this.wallpaperEl.style.opacity = wallpaperOpacity.toString();
        
        
        const imgEl = this.wallpaperEl.createEl('img');
        imgEl.style.width = '100%';
        imgEl.style.height = '100%';
        imgEl.style.objectFit = 'cover';
        imgEl.style.pointerEvents = 'none';
        

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
                (headerSection as HTMLElement).style.background = `rgba(255, 255, 255, ${Math.min(0.95, headerGlassFactor)})`;
            } else if (headerSection) {
                headerSection.classList.remove('liquid-glass-active');
                (headerSection as HTMLElement).style.background = '';
            }
            
            if (inputContainer && headerGlassFactor > 0) {
                inputContainer.classList.add('liquid-glass-active');
                (inputContainer as HTMLElement).style.background = `rgba(255, 255, 255, ${Math.min(0.95, headerGlassFactor)})`;
            } else if (inputContainer) {
                inputContainer.classList.remove('liquid-glass-active');
                (inputContainer as HTMLElement).style.background = '';
            }
            
            if (responsesContainer && responseGlassFactor > 0) {
                responsesContainer.classList.add('liquid-glass-active');
            }

            
            responseItems.forEach((item) => {
                if (responseGlassFactor > 0) {
                    item.classList.add('liquid-glass-active');
                    (item as HTMLElement).style.background = `rgba(255, 255, 255, ${Math.min(0.95, responseGlassFactor)})`;
                    (item as HTMLElement).style.borderColor = `rgba(255, 255, 255, ${Math.min(0.5, responseGlassFactor)})`;
                } else {
                    item.classList.remove('liquid-glass-active');
                    (item as HTMLElement).style.background = '';
                    (item as HTMLElement).style.borderColor = '';
                }
            });

            
            if (queryInput && headerGlassFactor > 0) {
                queryInput.classList.add('liquid-glass-active');
queryInput.style.background = `rgba(255, 255, 255, ${Math.min(0.95, headerGlassFactor)})`;
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
        this.headerSection = headerSection;

        
        const headerLeftControls = headerSection.createDiv({ cls: 'header-left-controls' });

        
        if (this.settings.aiChatHistoryEnabled) {
            const historyBtn = headerLeftControls.createDiv({ cls: 'header-history-btn' });
            setIcon(historyBtn, 'history');
            historyBtn.style.cursor = 'pointer';
            historyBtn.setAttr('aria-label', 'View chat history');
            historyBtn.setAttr('tabindex', '0');
            historyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openSessionHistoryModal();
            });
        }

        
        const dbIndexBtn = headerLeftControls.createDiv({ cls: 'header-db-index-btn header-history-btn' });
        setIcon(dbIndexBtn, 'database-zap');
        dbIndexBtn.setAttr('aria-label', 'Change embedding index');
        dbIndexBtn.setAttr('tabindex', '0');
        dbIndexBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showEmbeddingIndexMenu(dbIndexBtn);
        });

        
        const systemInstructionsBtn = headerLeftControls.createDiv({ cls: 'header-system-instructions-btn' });
        setIcon(systemInstructionsBtn, 'wrench');
        systemInstructionsBtn.style.cursor = 'pointer';
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
        newChatBtn.style.cursor = 'pointer';
        newChatBtn.setAttr('aria-label', 'Start new chat');
        newChatBtn.setAttr('tabindex', '0');
        newChatBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.startNewSession();
        });


        
        const headerRightControls = headerSection.createDiv({ cls: 'header-right-controls' });

        
        const headerModelBtn = new ButtonComponent(headerRightControls)
            .setButtonText(this.getModelButtonText())
            .setClass('header-model-btn')
            .onClick(() => this.showModelMenu());

        this.renderOllamaThinkingButton(headerRightControls);

        
        const ellipsisBtn = headerRightControls.createDiv({ cls: 'header-ellipsis-btn' });
        setIcon(ellipsisBtn, 'more-vertical');
        ellipsisBtn.style.cursor = 'pointer';
        ellipsisBtn.setAttr('aria-label', 'Menu options');
        ellipsisBtn.setAttr('tabindex', '0');
        ellipsisBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showHeaderMenu(ellipsisBtn);
        });

        
        const firstChild = wrapper.firstChild;
        if (firstChild) {
            wrapper.insertBefore(headerSection, firstChild);
        } else {
            wrapper.appendChild(headerSection);
        }
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

            
            const isYouTubeUrl = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|live\/)|youtu\.be\/)/.test(path);
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
            if (child instanceof TFile && child.extension === 'md') {
                files.push(child);
            } else if (child instanceof TFolder) {
                files = files.concat(this.getAllFilesInFolder(child));
            }
        }
        return files;
    }

    private async sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
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
                const finalContentEl = this.currentProgressResponseEl.querySelector('.final-answer-content') as HTMLElement | null;
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
            (this.currentProgressResponseEl.querySelector('.thinking-content') as HTMLElement | null);

        if (!targetThinkingEl) return;

        
        if (!message.toLowerCase().includes('thinking')) return;
        if (!snippet) return;

        
        const container = this.currentThinkingContainerEl
            || (targetThinkingEl.closest('.thinking-container') as HTMLElement | null);
        if (container && container.classList.contains('collapsed')) {
            this.setThinkingCollapsed(container, false);
        }

        
        if (this.currentThinkingLabelEl) {
            this.currentThinkingLabelEl.removeClass('is-hidden');
        } else {
            const label = this.currentProgressResponseEl.querySelector('.thinking-label') as HTMLElement | null;
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
                MarkdownRenderer.render(this.app, textToRender, this.currentThinkingChunkEl, '', this);
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
                targetThinkingEl = this.currentProgressResponseEl.querySelector('.thinking-content') as HTMLElement | null;
            }

            if (targetThinkingEl) {
                
                const container = (targetThinkingEl.closest('.thinking-container') as HTMLElement | null)
                    || this.currentThinkingContainerEl;
                if (container && container.classList.contains('collapsed')) {
                    this.setThinkingCollapsed(container, false);
                }

                
                if (this.currentThinkingLabelEl) {
                    this.currentThinkingLabelEl.removeClass('is-hidden');
                } else {
                    const label = this.currentProgressResponseEl.querySelector('.thinking-label') as HTMLElement | null;
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
                        MarkdownRenderer.render(this.app, textToRender, this.currentThinkingChunkEl, '', this);
                    }

                    this.currentThinkingChunkEl = targetThinkingEl.createDiv({ cls: 'thinking-timeline-item' });
                    this.currentThinkingChunkText = '';
                }

                this.currentThinkingChunkText += snippet;
                this.currentThinkingChunkEl.textContent = this.currentThinkingChunkText;
            }
            return;
        }

        
        
        let finalContentEl = this.currentProgressResponseEl.querySelector('.final-answer-content') as HTMLElement | null;

        
        if (!finalContentEl) {
            const answerEl = this.currentProgressResponseEl.querySelector('.response-answer') as HTMLElement | null;
            if (answerEl) {
                finalContentEl = answerEl.querySelector('.final-answer-content') as HTMLElement | null;
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
                clearTimeout(this.answerRenderTimeout);
                this.answerRenderTimeout = null;
            }
            renderAnswer();
        } else if (!this.answerRenderTimeout) {
            this.answerRenderTimeout = setTimeout(renderAnswer, throttleInterval - (now - this.lastAnswerRenderTime));
        }

        
        this.contentContainer.scrollTo({
            top: this.contentContainer.scrollHeight,
            behavior: 'smooth'
        });
    }

    private setThinkingCollapsed(container: HTMLElement, collapsed: boolean) {
        if (collapsed) container.addClass('collapsed');
        else container.removeClass('collapsed');

        const chev = container.querySelector('.thinking-chevron') as HTMLElement | null;
        if (chev) chev.setText(collapsed ? '▸' : '▾');
    }

    private extractGeminiAnswerTextFromResponse(response: any): string {
        const parts = response?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) return response?.text?.() || '';
        return parts
            .filter((part: any) => typeof part?.text === 'string' && part.text.trim().length > 0 && part?.thought !== true)
            .map((part: any) => part.text)
            .join('');
    }

    private async performWebSearch(query: string): Promise<WebSearchResult[]> {
        try {
            return await this.webSearchService.searchWeb(query);
        } catch (error) {
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
            if (Platform.isMobile) {
                new Notice('MCP is not available on mobile devices');
                return;
            }
            query = query.replace(/^@mcp\s*/, '').trim();
            if (!query) {
                new Notice('Please provide a query after @mcp');
                return;
            }

            
            if (!this.settings.mcpEnabled) {
                new Notice('MCP support is disabled. Enable it in settings.');
                return;
            }

            
            const availableServers = (this.settings.mcpServers || []).filter(s => !s.disabled);
            if (availableServers.length === 0) {
                new Notice('No MCP servers configured. Please add servers in settings.');
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
                async (selection) => {
                    
                    const enableRateLimit = mcpAutoModel === null ? this.mcpRateLimitEnabled : false;
                    await this.processMCPQuery(query, selection, mcpAutoModel, enableRateLimit);
                },
                this.plugin.settings.mcpAutoConnect ?? true
            );
            modal.open();
            return;
        }

        
        if (this.pendingMCPSelection) {
            if (Platform.isMobile) {
                this.pendingMCPSelection = null;
                return;
            }
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

            
            const lowerPrompt = creationPrompt.toLowerCase();
            const isCanvasRequest = /\bcanvas\b/i.test(creationPrompt);
            const isExcalidrawRequest = /\bexcalidraw\b/i.test(creationPrompt);

            
            if (this.settings.autoModeEnabled && !autoSelectedModel) {
                autoSelectedModel = await this.performAutoModeSelection(query, '@create');
            }
            

            let targetFolder: string | undefined;
            let fileContext = '';

            
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
                                const content = await this.app.vault.read(fileOrFolder);
                                fileContents.push(`--- File: ${fileOrFolder.basename} ---\n${content}\n`);
                            } catch (e) {
                                                            }
                        }
                    }
                }

                fileContext = fileContents.filter(Boolean).join('\n');
            }

            
            if (!targetFolder) {
                const folderPatterns = [
                    /(?:in|to|inside)\s+(?:the\s+)?(?:folder|directory)\s+['"]([^'"]+)['"]/i,
                    /(?:in|to|inside)\s+(?:the\s+)?(?:folder|directory)\s+([\w\s\/\-]+?)(?=\s+(?:create|make|with|and|\.|$))/i,
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

            
            let webContext = '';
            if (this.webEnabled && this.webSearchService && creationPrompt) {
                try {
                    const webResults = await this.webSearchService.googleCustomSearch(creationPrompt, this.settings);
                    if (webResults && webResults.length > 0) {
                        webContext = '\n--- Google Search Results ---\n' + webResults.map(r => `Title: ${r.title}\nURL: ${r.link}\nSnippet: ${r.snippet}`).join('\n\n') + '\n';
                    }
                } catch (e) {
                    
                }
            }

            
            const contextFiles: Array<{ path: string; content: string; basename: string }> = [];

            if (this.selectedFiles.size > 0) {
                for (const path of Array.from(this.selectedFiles)) {
                    if (!/^https?:\/\//.test(path)) {
                        const fileOrFolder = this.app.vault.getAbstractFileByPath(path);
                        if (fileOrFolder instanceof TFile) {
                            try {
                                const content = await this.app.vault.read(fileOrFolder);
                                contextFiles.push({
                                    path: fileOrFolder.path,
                                    content: content,
                                    basename: fileOrFolder.basename
                                });
                            } catch (e) {
                                                            }
                        }
                    }
                }
            }

            const folderName = targetFolder || 'New Files';
            const actionId = this.createFileActionCapsule('create', folderName);

            
            if (isCanvasRequest) {
                const message = `I'll create a canvas file for you${targetFolder ? ` in the **${targetFolder}** folder` : ''}. Let me generate a visual layout for your content.`;
                this.processCanvasCreate(actionId, creationPrompt, targetFolder, contextFiles, autoSelectedModel);
                this.addFileActionResponse(creationPrompt, message, [actionId]);
            } else if (isExcalidrawRequest) {
                const message = `I'll create an Excalidraw diagram for you${targetFolder ? ` in the **${targetFolder}** folder` : ''}. Processing...`;
                this.processExcalidrawCreate(actionId, creationPrompt, targetFolder, contextFiles, autoSelectedModel);
                this.addFileActionResponse(creationPrompt, message, [actionId]);
            } else {
                const message = `I'll create files for you${targetFolder ? ` in the **${targetFolder}** folder` : ''}. Let me generate the content and structure.`;
                this.processFileCreate(actionId, creationPrompt, targetFolder, contextFiles, autoSelectedModel);
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

        let cleanQuery = isVaultWideSearch ? query.slice(7).trim() :
            isFlashSearch ? query.slice(7).trim() :
                query.trim();

        
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

            
            const youtubeUrlMatch = query.match(/https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|live\/)|youtu\.be\/)[^\s]+/);
            const youtubeUrlFromCapsule = contextUrls.find(url => /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|live\/)|youtu\.be\/)/.test(url));

            if (youtubeUrlMatch || youtubeUrlFromCapsule) {
                const youtubeUrl = youtubeUrlMatch ? youtubeUrlMatch[0] : youtubeUrlFromCapsule!;
                const isFromCapsule = !!youtubeUrlFromCapsule;
                const promptText = youtubeUrlMatch
                    ? query.replace(youtubeUrl, '').trim()
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
                    } catch (ytError: any) {
                        
                        if (progressResponseEl && progressEl) {
                            this.finalizeResponse(
                                progressResponseEl,
                                progressEl,
                                query,
                                `Error: ${ytError.message || 'Failed to process YouTube video.'}`,
                                [],
                                [],
                                { modelName: this.settings.model }
                            );
                        }
                        this.currentProgressResponseEl = null;
                        this.currentProgressEl = null;
                        
                        
                        if (!this.settings.autoModeEnabled) {
                            new Notice(ytError.message || 'Failed to process YouTube video.');
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
                            } catch (transcriptError: any) {
                                
                                if (!this.settings.autoModeEnabled) {
                                    new Notice(transcriptError.message || 'Failed to extract YouTube transcript.');
                                }
                                this.addResponse(query, `Error: ${transcriptError.message || 'Failed to extract YouTube transcript.'}`, [], [], { modelName: this.settings.model });
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

                                
                                

                            } catch (saveError: any) {
                                
                                if (!this.settings.autoModeEnabled) {
                                    new Notice(`Failed to save transcript: ${saveError.message}`);
                                }
                                this.isProcessing = false;
                                this.setSendButtonState(this.stopKnowDeepBtn, 'send');
                                return;
                            }

                        } catch (transcriptError: any) {
                            
                            
                            if (!this.settings.autoModeEnabled) {
                                new Notice(transcriptError.message || 'Failed to extract YouTube transcript.');
                            }
                            this.addResponse(query, `Error: ${transcriptError.message || 'Failed to extract YouTube transcript.'}`, [], [], { modelName: this.settings.model });
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
                        
                        if (/^https?:\/\/(www\.)?(youtube\.com(\/live\/|\/watch\?v=)?|youtu\.be)/.test(path)) {
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
                            const allFiles = fileOrFolder.children.filter(child => child instanceof TFile) as TFile[];

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
                                    }
                                } catch (readError) {
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

                                
                                return null;
                            } catch (readError) {
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
                if (this.settings.provider === 'ollama' && this.settings.ollamaApiKey) {
                    
                    this.updateProcessingUI(0.3, 1, `Fetching ${contextUrls.length} webpage(s) with Ollama...`);

                    try {
                        const ollamaService = new OllamaService(
                            this.settings.ollamaBaseUrl || 'http://localhost:11434',
                            this.settings.ollamaApiKey || '',
                            (headers) => this.rateLimitManager.updateFromHeaders('ollama', this.settings.model, headers)
                        );

                        const fetchedPages: Array<{ url: string; title: string; content: string }> = [];

                        for (const url of contextUrls) {
                            try {
                                const pageData = await ollamaService.webFetch(url);
                                fetchedPages.push({
                                    url: url,
                                    title: pageData.title,
                                    content: pageData.content
                                });
                                                            } catch (fetchError) {
                                                                const errorMsg = fetchError instanceof Error ? fetchError.message : 'Unknown error';
                                new Notice(`Failed to fetch ${url}: ${errorMsg}`);
                            }
                        }

                        if (fetchedPages.length > 0) {
                            
                            let webpageContext = '\n\n--- Web Pages ---\n\n';
                            fetchedPages.forEach((page, index) => {
                                webpageContext += `--- Web Page [${index + 1}]: ${page.title} (${page.url}) ---\n`;
                                webpageContext += `${page.content.substring(0, 5000)}\n\n`; 
                            });

                            vaultContext += webpageContext;
                            this.updateProcessingUI(0.4, 1, `Fetched ${fetchedPages.length} webpage(s). Processing...`);
                        } else {
                            new Notice('Failed to fetch any webpages. Continuing without webpage content.');
                        }
                    } catch (error) {
                                                const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                        new Notice(`Webpage fetch failed: ${errorMsg}. Continuing without webpage content.`);
                    }
                } else if (this.settings.provider === 'ollama' && !this.settings.ollamaApiKey) {
                    
                    new Notice('Ollama webpage fetch requires an API key. Please add your Ollama API key in settings. URLs will be included in the query instead.');
                    enhancedQuery = query + ' ' + contextUrls.join(' ');
                    cleanQuery = cleanQuery + ' ' + contextUrls.join(' ');
                } else {
                    
                    enhancedQuery = query + ' ' + contextUrls.join(' ');
                    cleanQuery = cleanQuery + ' ' + contextUrls.join(' '); 
                }
            }

                if (isVaultWideSearch || isFlashSearch || this.selectedFiles.size > 0 || contextUrls.length > 0) {
                    
                    const isVaultQuery = isVaultWideSearch || isFlashSearch || this.selectedFiles.size > 0;

                    
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
                                ? await (this.plugin as any).searchVaultBM25Only(cleanQuery, searchLimit)
                                : await (this.plugin as any).searchVault(cleanQuery, searchLimit);

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
                        } catch (error: any) {
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
                        const progressInterval = setInterval(() => {
                            if (messageIndex < progressMessages.length && this.currentProgressEl) {
                                this.updateResponseProgress(this.currentProgressResponseEl!, this.currentProgressEl, progressMessages[messageIndex]);
                                messageIndex++;
                            }
                        }, 1500);

                        
                        
                        
                        let chatHistory: any[] = [];
                        if (isVaultWideSearch) {
                            const fullChatHistory = this.getChatHistory();
                            
                            chatHistory = fullChatHistory.slice(-2);
                        } else {
                            
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

                        
                        clearInterval(progressInterval);

                        
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
                        const progressInterval = setInterval(() => {
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

                        
                        clearInterval(progressInterval);

                        
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

        } catch (error: any) {
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

                    
                    targetEl.style.backgroundColor = 'var(--text-accent)';
                    targetEl.style.opacity = '0.3';

                    
                    const backArrow = targetEl.querySelector('.footnote-backref') as HTMLElement;
                    if (backArrow) {
                        backArrow.style.color = 'var(--text-accent)';
                        backArrow.style.fontWeight = 'bold';
                        backArrow.style.transform = 'scale(1.3)';
                        backArrow.style.display = 'inline-block';
                        backArrow.style.transition = 'all 0.3s ease';
                        backArrow.style.textShadow = '0 0 8px var(--text-accent)';

                        setTimeout(() => {
                            backArrow.style.color = '';
                            backArrow.style.fontWeight = '';
                            backArrow.style.transform = '';
                            backArrow.style.textShadow = '';
                        }, 5000);
                    }

                    setTimeout(() => {
                        targetEl.style.backgroundColor = '';
                        targetEl.style.opacity = '';
                    }, 1000);
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
                    const tooltip = document.createElement('div');
                    tooltip.classList.add('footnote-tooltip');
                    tooltip.style.cssText = `
                        position: fixed;
                        background-color: var(--background-primary);
                        border: 1px solid var(--background-modifier-border);
                        border-radius: 4px;
                        padding: 8px 12px;
                        max-width: 300px;
                        z-index: 10000;
                        box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                        font-size: 0.9em;
                        pointer-events: none;
                    `;

                    
                    const text = targetEl.textContent?.replace(/↩/g, '').replace(/\[\^\d+\]:\s*/, '').trim() || '';
                    tooltip.textContent = text;

                    const rect = refLink.getBoundingClientRect();
                    tooltip.style.left = rect.left + 'px';
                    tooltip.style.top = (rect.bottom + 5) + 'px';

                    document.body.appendChild(tooltip);

                    const removeTooltip = () => {
                        if (tooltip.parentNode) {
                            tooltip.remove();
                        }
                    };

                    refLink.addEventListener('mouseleave', removeTooltip, { once: true });
                    setTimeout(removeTooltip, 5000); 
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
                    backArrow.style.cssText = 'margin-left: 0.25em; cursor: pointer; text-decoration: none;';

                    this.registerDomEvent(backArrow, 'click', (e: MouseEvent) => {
                        e.preventDefault();

                        
                        const fnNum = id.replace(/\D/g, '');
                        let refEl = container.querySelector(`sup a[href="#${id}"]`) as HTMLElement;
                        if (!refEl) {
                            refEl = container.querySelector(`a[href="#${id}"]`) as HTMLElement;
                        }
                        if (refEl) {
                            refEl = refEl.closest('sup') || refEl;
                        }

                        if (refEl) {
                            refEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            refEl.style.backgroundColor = 'var(--text-accent)';
                            refEl.style.opacity = '0.3';
                            setTimeout(() => {
                                refEl.style.backgroundColor = '';
                                refEl.style.opacity = '';
                            }, 500);
                        }
                    });

                    itemEl.appendChild(backArrow);
                }
            });
        });
    }

    private addSourcesToResponseElement(responseEl: HTMLElement, sources: Array<{ path: string; relevance: number }> = []) {
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
            sourcesContent.style.display = 'none'; 

            
            const extractYouTubeId = (url: string): string | null => {
                const patterns = [
                    /(?:youtube\.com\/(?:watch\?v=|live\/)|youtu\.be\/)([^&\s]+)/,
                    /youtube\.com\/embed\/([^&\s]+)/,
                    /youtube\.com\/v\/([^&\s]+)/
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

                
                const source = sources.find(s => s.path === path) as any;
                if (source && source.url) {
                    return source.url;
                }

                
                
                if (sourceContent) {
                    const sourceMatch = sourceContent.match(/Source:\s*(https?:\/\/[^\s\n]+)/);
                    if (sourceMatch) {
                        return sourceMatch[1];
                    }
                }

                
                if (source && (source as any).content) {
                    const sourceMatch = (source as any).content.match(/Source:\s*(https?:\/\/[^\s\n]+)/);
                    if (sourceMatch) {
                        return sourceMatch[1];
                    }
                }

                return null;
            };

            if (hasCitations) {
                
                const citationsList = sourcesContent.createEl('div', { cls: 'footnote-citations' });
                sources.forEach((source, idx) => {
                    const citationItem = citationsList.createDiv({ cls: 'citation-item' });
                    citationItem.setText(`[^${idx + 1}]: `);

                    if (isYouTubeSource(source.path)) {
                        
                        getYouTubeUrl(source.path, (source as any).content).then(url => {
                            if (url) {
                                const videoId = extractYouTubeId(url);
                                if (videoId) {
                                    const embedContainer = citationItem.createDiv({ cls: 'youtube-embed-container' });
                                    const iframe = embedContainer.createEl('iframe', {
                                        cls: 'youtube-embed',
                                        attr: {
                                            src: `https://www.youtube.com/embed/${videoId}`,
                                            frameborder: '0',
                                            allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
                                            allowfullscreen: 'true'
                                        }
                                    });
                                    const titleEl = embedContainer.createDiv({
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
                        sourceLink.addEventListener('click', async (e) => {
                            e.preventDefault();
                            const file = this.app.vault.getAbstractFileByPath(source.path);
                            if (file instanceof TFile) {
                                await this.app.workspace.getLeaf().openFile(file);
                            }
                        });
                    }
                });
            } else {
                
                const sourcesList = sourcesContent.createEl('ul');
                sources.forEach(source => {
                    const sourceItem = sourcesList.createEl('li');

                    if (isYouTubeSource(source.path)) {
                        
                        getYouTubeUrl(source.path, (source as any).content).then(url => {
                            if (url) {
                                const videoId = extractYouTubeId(url);
                                if (videoId) {
                                    const embedContainer = sourceItem.createDiv({ cls: 'youtube-embed-container' });
                                    const iframe = embedContainer.createEl('iframe', {
                                        cls: 'youtube-embed',
                                        attr: {
                                            src: `https://www.youtube.com/embed/${videoId}`,
                                            frameborder: '0',
                                            allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
                                            allowfullscreen: 'true'
                                        }
                                    });
                                    const titleEl = embedContainer.createDiv({
                                        cls: 'youtube-embed-title',
                                        text: source.path.replace('YouTube: ', '')
                                    });
                                }
                            }
                        });
                    } else {
                        const sourceLink = sourceItem.createEl('a', {
                            text: `${source.path}`,
                            cls: 'internal-link'
                        });
                        sourceLink.addEventListener('click', async (e) => {
                            e.preventDefault();
                            const file = this.app.vault.getAbstractFileByPath(source.path);
                            if (file instanceof TFile) {
                                await this.app.workspace.getLeaf().openFile(file);
                            }
                        });
                    }
                });
            }

            
            sourcesHeader.addEventListener('click', () => {
                const isCollapsed = sourcesContent.style.display === 'none';
                sourcesContent.style.display = isCollapsed ? 'block' : 'none';
                toggleIcon.setText(isCollapsed ? '▼' : '▶'); 
            });

            
            sourcesHeader.style.cursor = 'pointer';
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
            toolsContent.style.display = 'none'; 

            
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
                const isCollapsed = toolsContent.style.display === 'none';
                toolsContent.style.display = isCollapsed ? 'block' : 'none';
                toggleIcon.setText(isCollapsed ? '▼' : '▶'); 
            });

            
            toolsHeader.style.cursor = 'pointer';
        }
    }

    private addWebResultsToResponseElement(responseEl: HTMLElement, webResults: WebSearchResult[] = []) {
        if (webResults && webResults.length > 0) {
            const webSourcesEl = responseEl.createDiv({ cls: 'response-sources' });

            
            const sourcesHeader = webSourcesEl.createDiv({ cls: 'sources-header' });
            const toggleIcon = sourcesHeader.createSpan({ cls: 'sources-toggle-icon' });
            toggleIcon.setText('▶'); 
            const headerText = sourcesHeader.createEl('h6', { text: `Web Sources (${webResults.length})` });

            
            const sourcesContent = webSourcesEl.createDiv({ cls: 'sources-content' });
            sourcesContent.style.display = 'none'; 

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
                const isCollapsed = sourcesContent.style.display === 'none';
                sourcesContent.style.display = isCollapsed ? 'block' : 'none';
                toggleIcon.setText(isCollapsed ? '▼' : '▶');
            });

            
            sourcesHeader.style.cursor = 'pointer';
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
        const headerText = sourcesHeader.createEl('h6', { text: `Sources Referred (${totalSources})` });

        
        const sourcesContent = sourcesEl.createDiv({ cls: 'sources-content' });
        sourcesContent.style.display = 'none'; 

        
        const answerEl = responseEl.querySelector('.agent-final-answer-content') || responseEl.querySelector('.response-answer');
        const answerText = answerEl?.textContent || '';
        
        const hasCitations = /\[\^\d+\]/.test(answerText) || (vaultResults.length > 0 || webResults.length > 0);

        if (hasCitations) {
            
            const citationsList = sourcesContent.createEl('div', { cls: 'footnote-citations' });
            let citationIndex = 1;

            
            vaultResults.forEach((result, idx) => {
                const citationItem = citationsList.createDiv({ cls: 'citation-item' });
                citationItem.setText(`[^${citationIndex}]: `);

                const sourceLink = citationItem.createEl('a', {
                    text: `[[${result.path}]]`,
                    cls: 'internal-link'
                });
                sourceLink.addEventListener('click', async (e) => {
                    e.preventDefault();
                    const file = this.app.vault.getAbstractFileByPath(result.path);
                    if (file instanceof TFile) {
                        await this.app.workspace.getLeaf().openFile(file);
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
                link.addEventListener('click', async (e) => {
                    e.preventDefault();
                    const file = this.app.vault.getAbstractFileByPath(result.path);
                    if (file instanceof TFile) {
                        await this.app.workspace.getLeaf().openFile(file);
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
            const isCollapsed = sourcesContent.style.display === 'none';
            sourcesContent.style.display = isCollapsed ? 'block' : 'none';
            toggleIcon.setText(isCollapsed ? '▼' : '▶');
        });

        
        sourcesHeader.style.cursor = 'pointer';
    }




    private createResponseActions(responseEl: HTMLElement, question: string, answer: string) {
        const actionsContainer = responseEl.createDiv({ cls: 'response-actions' });

        
        if (this.settings.chatWallpaperEnabled && this.settings.chatWallpaperPath) {
            actionsContainer.classList.add('liquid-glass-active');
        }

        const deleteBtn = actionsContainer.createDiv({ cls: 'response-action-btn delete-response' });
        deleteBtn.setAttribute('aria-label', 'Delete response');
        setIcon(deleteBtn, 'trash-2');
        deleteBtn.addEventListener('click', () => {
            const index = this.responses.findIndex(r => r.question === question);
            if (index !== -1) {
                this.responses.splice(index, 1);
            }
            responseEl.remove();
            new Notice('Response deleted');
            
            this.updateContextBar();
            
            this.saveCurrentSession();
        });

        const regenerateBtn = actionsContainer.createDiv({ cls: 'response-action-btn regenerate-response' });
        regenerateBtn.setAttribute('aria-label', 'Regenerate response');
        setIcon(regenerateBtn, 'refresh-cw');
        regenerateBtn.addEventListener('click', async () => {
            const index = this.responses.findIndex(r => r.question === question);
            if (index !== -1) {
                this.responses.splice(index, 1);
            }
            responseEl.remove();
            
            this.updateContextBar();

            this.loadingSpinner.classList.add('visible');
            await this.processQuery(question);
            this.loadingSpinner.classList.remove('visible');
            this.adjustTextareaHeight();
            
        });

        const saveBtn = actionsContainer.createDiv({ cls: 'response-action-btn save-response' });
        saveBtn.setAttribute('aria-label', 'Save as note');
        setIcon(saveBtn, 'save');
        saveBtn.addEventListener('click', () => this.saveResponseAsNote(question));

        const copyBtn = actionsContainer.createDiv({ cls: 'response-action-btn copy-response' });
        copyBtn.setAttribute('aria-label', 'Copy response');
        setIcon(copyBtn, 'copy');
        copyBtn.addEventListener('click', () => {
            const responseToCopy = this.responses.find(r => r.question === question);
            if (responseToCopy) {
                navigator.clipboard.writeText(responseToCopy.answer);
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
                navigator.clipboard.writeText(cleanedText);
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
                navigator.clipboard.writeText(cleanedText);
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

        new SaveNoteModal(this.app, defaultFileName, defaultDirectory, this.plugin.settings, async (fileName, directory, templatePath) => {
            try {
                const filePath = directory ? normalizePath(`${directory}/${fileName}`) : fileName;

                if (directory) {
                    const dirPath = this.app.vault.getAbstractFileByPath(directory);
                    if (!dirPath) {
                        try {
                            await this.app.vault.createFolder(directory);
                        } catch (error: any) {
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
            } catch (error: any) {
                                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                new Notice(`Error saving response as note: ${errorMessage}`);
            }
        }).open();
    }

    async saveSession() {
        if (this.responses.length === 0) {
            new Notice('No responses to save');
            return;
        }

        const defaultFileName = `Chat-Session-${new Date().toLocaleString().replace(/[/:]/g, '-')}`;
        const defaultDirectory = this.plugin.settings.saveDirectory?.trim() || '';

        new SaveNoteModal(this.app, defaultFileName, defaultDirectory, this.plugin.settings, async (fileName, directory, templatePath) => {
            try {
                const filePath = directory ? normalizePath(`${directory}/${fileName}`) : fileName;

                if (directory) {
                    const dirPath = this.app.vault.getAbstractFileByPath(directory);
                    if (!dirPath) {
                        try {
                            await this.app.vault.createFolder(directory);
                        } catch (error: any) {
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
            } catch (error: any) {
                                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                new Notice(`Error saving chat session: ${errorMessage}`);
            }
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
            thinkingChevron.style.cursor = 'pointer';
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
                clearTimeout(this.answerRenderTimeout);
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
            MarkdownRenderer.render(this.app, answer, answerEl, '', this);

            
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

        
        this.saveCurrentSession();

        return { responseEl, progressEl, newResponse };
    }

    /**
     * Wraps all tables in the answer element with scrollable containers
     */
    private wrapTablesInScrollContainers(answerEl: HTMLElement) {
        const tables = answerEl.querySelectorAll('table');
        tables.forEach(table => {
            
            if (table.parentElement?.classList.contains('table-wrapper')) return;

            const wrapper = document.createElement('div');
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
            clearTimeout(this.answerRenderTimeout);
            this.answerRenderTimeout = null;
        }

        progressEl.remove();

        
        const answerEl = (responseEl.querySelector('.response-answer') as HTMLElement | null) || responseEl.createDiv({ cls: 'response-answer' });
        const finalContentEl =
            (answerEl.querySelector('.final-answer-content') as HTMLElement | null) ||
            answerEl.createDiv({ cls: 'final-answer-content' });

        finalContentEl.empty();
        finalContentEl.removeClass('generating-dots');
        MarkdownRenderer.render(this.app, answer, finalContentEl, '', this);

        
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

        
        
        const thinkingContainer = responseEl.querySelector('.thinking-container') as HTMLElement | null;
        if (thinkingContainer) {
            const thinkingContentEl = thinkingContainer.querySelector('.thinking-content') as HTMLElement | null;
            const thinkingText = (this.currentThinkingText || '').trim();

            
            if (this.currentThinkingChunkEl && this.currentThinkingChunkText.trim()) {
                const textToRender = this.currentThinkingChunkText;
                this.currentThinkingChunkEl.empty();
                MarkdownRenderer.render(this.app, textToRender, this.currentThinkingChunkEl, '', this);
            }

            
            
            this.setThinkingCollapsed(thinkingContainer, true);
        }

        
        const label = (responseEl.querySelector('.thinking-label') as HTMLElement | null) || this.currentThinkingLabelEl;
        if (label) label.addClass('is-hidden');

        
        this.currentThinkingEl = null;
        this.currentThinkingText = '';
        this.currentThinkingContainerEl = null;
        this.currentThinkingLabelEl = null;
        this.currentThinkingChunkEl = null;
        this.currentThinkingChunkText = '';
        this.lastThinkingTime = 0;

        
        this.saveCurrentSession();
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

        
        this.saveCurrentSession();
    }

    private enhanceCodeBlocks(answerEl: HTMLElement, question = '') {
        const preEls = answerEl.querySelectorAll('pre');
        preEls.forEach((pre) => {
            
            if (pre.parentElement?.classList.contains('code-block-wrapper')) return;

            const lang = detectLanguage(pre as HTMLElement);
            const executable = isExecutable(lang);
            const renderable = isRenderable(lang);

            
            const wrapper = document.createElement('div');
            wrapper.className = 'code-block-wrapper';
            pre.parentNode?.insertBefore(wrapper, pre);
            wrapper.appendChild(pre);

            const initialCode = pre.querySelector('code')?.textContent || '';
            wrapper.dataset.code = initialCode;

            
            const toolbar = document.createElement('div');
            toolbar.className = 'code-block-toolbar';

            
            if (lang !== 'unknown') {
                const badge = document.createElement('span');
                badge.className = 'code-lang-badge';
                badge.textContent = lang;
                toolbar.appendChild(badge);
            }

            const toolbarRight = document.createElement('div');
            toolbarRight.className = 'code-block-toolbar-right';

            
            const copyBtn = document.createElement('button');
            copyBtn.className = 'code-block-btn';
            copyBtn.setAttribute('aria-label', 'Copy code');
            setIcon(copyBtn, 'copy');
            copyBtn.addEventListener('click', () => {
                const code = wrapper.dataset.code || '';
                navigator.clipboard.writeText(code);
                setIcon(copyBtn, 'check');
                setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
            });
            toolbarRight.appendChild(copyBtn);

            
            const expandBtn = document.createElement('button');
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
                this.watchMermaidErrors(pre as HTMLElement, wrapper, question);
                return;
            }

            
            if (lang === 'json') {
                const outputEl = document.createElement('div');
                outputEl.className = 'code-exec-output hidden';
                wrapper.appendChild(outputEl);

                const autoMode = this.plugin.settings.codeExecutionAutoMode ?? false;

                if (autoMode) {
                    (pre as HTMLElement).style.display = 'none';
                    outputEl.classList.remove('hidden');
                    this.runCode(pre as HTMLElement, lang, outputEl, wrapper, false, question);
                    return;
                }

                const renderToggleRow = document.createElement('div');
                renderToggleRow.className = 'code-exec-toggle-row';

                const renderLabel = document.createElement('span');
                renderLabel.className = 'code-exec-label';
                renderLabel.textContent = 'Render visualization';

                const renderToggle = document.createElement('div');
                renderToggle.className = 'code-exec-toggle';
                renderToggle.setAttribute('role', 'switch');
                renderToggle.setAttribute('aria-checked', 'false');
                renderToggle.setAttribute('aria-label', 'Render visualization');

                const backBtn = document.createElement('button');
                backBtn.className = 'code-block-btn code-back-btn';
                backBtn.setAttribute('aria-label', 'Back to code');
                backBtn.style.display = 'none';
                setIcon(backBtn, 'code-2');
                backBtn.addEventListener('click', () => {
                    (pre as HTMLElement).style.display = '';
                    outputEl.classList.add('hidden');
                    outputEl.empty();
                    outputEl.className = 'code-exec-output hidden';
                    renderToggle.classList.remove('is-enabled');
                    renderToggle.setAttribute('aria-checked', 'false');
                    backBtn.style.display = 'none';
                });

                renderToggle.addEventListener('click', async () => {
                    if (renderToggle.classList.contains('is-enabled')) return;
                    renderToggle.classList.add('is-enabled');
                    renderToggle.setAttribute('aria-checked', 'true');
                    (pre as HTMLElement).style.display = 'none';
                    outputEl.classList.remove('hidden');
                    backBtn.style.display = '';
                    await this.runCode(pre as HTMLElement, lang, outputEl, wrapper, false, question);
                });

                renderToggleRow.appendChild(renderLabel);
                renderToggleRow.appendChild(renderToggle);
                renderToggleRow.appendChild(backBtn);
                wrapper.insertBefore(renderToggleRow, outputEl);
                return;
            }

            
            if (!executable) return;

            
            const outputEl = document.createElement('div');
            outputEl.className = 'code-exec-output hidden';
            
            wrapper.appendChild(outputEl);

            const autoMode = this.plugin.settings.codeExecutionAutoMode ?? false;

            if (autoMode) {
                
                (pre as HTMLElement).style.display = 'none';
                outputEl.classList.remove('hidden');
                this.runCode(pre as HTMLElement, lang, outputEl, wrapper, true, question);
            } else {
                
                const runToggleRow = document.createElement('div');
                runToggleRow.className = 'code-exec-toggle-row';

                const runLabel = document.createElement('span');
                runLabel.className = 'code-exec-label';
                runLabel.textContent = 'Run code';

                const runToggle = document.createElement('div');
                runToggle.className = 'code-exec-toggle';
                runToggle.setAttribute('role', 'switch');
                runToggle.setAttribute('aria-checked', 'false');
                runToggle.setAttribute('aria-label', 'Run code');

                
                const backBtn = document.createElement('button');
                backBtn.className = 'code-block-btn code-back-btn';
                backBtn.setAttribute('aria-label', 'Back to code');
                backBtn.style.display = 'none';
                setIcon(backBtn, 'code-2');
                backBtn.addEventListener('click', () => {
                    
                    (pre as HTMLElement).style.display = '';
                    outputEl.classList.add('hidden');
                    outputEl.empty();
                    outputEl.className = 'code-exec-output hidden';
                    
                    runToggle.classList.remove('is-enabled');
                    runToggle.setAttribute('aria-checked', 'false');
                    backBtn.style.display = 'none';
                    
                    wrapper.querySelector('.code-repair-toggle-row')?.remove();
                });

                runToggle.addEventListener('click', async () => {
                    if (runToggle.classList.contains('is-enabled')) return;
                    runToggle.classList.add('is-enabled');
                    runToggle.setAttribute('aria-checked', 'true');
                    
                    (pre as HTMLElement).style.display = 'none';
                    outputEl.classList.remove('hidden');
                    backBtn.style.display = '';
                    await this.runCode(pre as HTMLElement, lang, outputEl, wrapper, false, question);
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

        const spinner = document.createElement('span');
        spinner.className = 'code-exec-spinner';
        setIcon(spinner, 'loader');
        outputEl.appendChild(spinner);

        const result = await executeCode(code, lang);

        outputEl.classList.remove('code-exec-running');
        outputEl.empty();

        if (result.isHtml && result.htmlContent) {
            outputEl.classList.add('code-exec-success');
            const iframe = document.createElement('iframe');
            iframe.className = 'code-exec-iframe';
            iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-modals');
            iframe.srcdoc = result.htmlContent;
            outputEl.appendChild(iframe);
            
            const onMsg = (e: MessageEvent) => {
                if (e.data?.iframeHeight && iframe.isConnected) {
                    iframe.style.height = e.data.iframeHeight + 'px';
                    window.removeEventListener('message', onMsg);
                }
            };
            window.addEventListener('message', onMsg);
        } else if (result.isMarkdown && result.markdownContent) {
            outputEl.classList.add('code-exec-success');
            outputEl.style.fontFamily = 'var(--font-text)';
            outputEl.style.padding = '12px';
            MarkdownRenderer.render(this.app, result.markdownContent, outputEl, '', this);
        } else if (result.success) {
            outputEl.classList.add('code-exec-success');
            const outputPre = document.createElement('pre');
            outputPre.className = 'code-exec-output-text';
            outputPre.textContent = result.output;
            outputEl.appendChild(outputPre);
        } else {
            outputEl.classList.add('code-exec-error');
            const errorPre = document.createElement('pre');
            errorPre.className = 'code-exec-output-text';
            errorPre.textContent = `Error: ${result.error}`;
            if (result.output) {
                errorPre.textContent += `\n\n${result.output}`;
            }
            outputEl.appendChild(errorPre);

            if (autoFix) {
                this.triggerCodeRepair(code, lang, result.error || '', preEl, outputEl, wrapper, true, question);
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

            const repairRow = document.createElement('div');
            repairRow.className = 'code-exec-toggle-row mermaid-repair-row';

            const repairLabel = document.createElement('span');
            repairLabel.className = 'code-exec-label';
            repairLabel.textContent = 'Repair diagram';

            const repairBtn = document.createElement('button');
            repairBtn.className = 'code-block-btn';
            repairBtn.setAttribute('aria-label', 'Repair mermaid diagram');
            setIcon(repairBtn, 'wrench');

            repairBtn.addEventListener('click', async () => {
                repairRow.remove();
                await this.triggerMermaidRepair(originalCode, errorText, preEl, wrapper, question);
            });

            repairRow.appendChild(repairLabel);
            repairRow.appendChild(repairBtn);
            wrapper.appendChild(repairRow);
        };

        const checkForError = (root: HTMLElement): string | null => {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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

        
        setTimeout(() => observer.disconnect(), MAX_WAIT_MS);
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
        
        const loadingEl = document.createElement('div');
        loadingEl.className = 'code-exec-output code-exec-running';
        const spinner = document.createElement('span');
        spinner.className = 'code-exec-spinner';
        setIcon(spinner, 'loader');
        loadingEl.appendChild(spinner);
        const loadingText = document.createElement('span');
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

            
            const tempContainer = document.createElement('div');
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
        } catch (err: any) {
            loadingEl.remove();

            const errRow = document.createElement('div');
            errRow.className = 'code-exec-toggle-row mermaid-repair-row';
            const errLabel = document.createElement('span');
            errLabel.className = 'code-exec-label';
            errLabel.style.color = 'var(--text-error, #f44336)';
            errLabel.textContent = `Repair failed: ${err?.message || String(err)}`;
            const retryBtn = document.createElement('button');
            retryBtn.className = 'code-block-btn';
            retryBtn.setAttribute('aria-label', 'Retry repair');
            setIcon(retryBtn, 'refresh-cw');
            retryBtn.addEventListener('click', async () => {
                errRow.remove();
                await this.triggerMermaidRepair(code, error, preEl, wrapper, question);
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

        const repairRow = document.createElement('div');
        repairRow.className = 'code-exec-toggle-row code-repair-toggle-row';

        const repairLabel = document.createElement('span');
        repairLabel.className = 'code-exec-label';
        repairLabel.textContent = 'Repair code';

        const repairToggle = document.createElement('div');
        repairToggle.className = 'code-exec-toggle code-repair-toggle-switch';
        repairToggle.setAttribute('role', 'switch');
        repairToggle.setAttribute('aria-checked', 'false');
        repairToggle.setAttribute('aria-label', 'Repair code');

        repairToggle.addEventListener('click', async () => {
            repairToggle.classList.add('is-enabled');
            repairToggle.setAttribute('aria-checked', 'true');
            repairRow.remove();
            await this.triggerCodeRepair(code, lang, error, preEl, outputEl, wrapper, false, question);
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
        const spinner = document.createElement('span');
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
        } catch (err: any) {
            outputEl.classList.remove('code-exec-running');
            outputEl.classList.add('code-exec-error');
            outputEl.empty();
            const errPre = document.createElement('pre');
            errPre.className = 'code-exec-output-text';
            errPre.textContent = `Repair failed: ${err?.message || String(err)}`;
            outputEl.appendChild(errPre);

            if (!autoFix) {
                const currentCode = preEl.querySelector('code')?.textContent || code;
                this.addRepairToggle(currentCode, lang, err?.message || '', preEl, outputEl, wrapper, question);
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
            return response.json.choices[0].message.content;
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
            return response.json.choices[0].message.content;
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
        const toggleText = filesToggle.createSpan({ text: 'View non-indexed files' });

        const filesList = filesSection.createDiv({ cls: 'index-status-files-list' });
        const filesListInner = filesList.createDiv({ cls: 'index-status-files-list-inner' });
        filesListInner.createSpan({ text: 'Loading...', cls: 'index-status-files-loading' });

        let isExpanded = false;
        let filesLoaded = false;

        filesToggle.addEventListener('click', async (e) => {
            e.stopPropagation();
            isExpanded = !isExpanded;
            toggleIcon.classList.toggle('expanded', isExpanded);
            filesList.classList.toggle('expanded', isExpanded);

            
            if (isExpanded && !filesLoaded) {
                filesLoaded = true;
                await this.loadNonIndexedFiles(filesListInner, searchMode);
            }
        });

        const indexBtn = callout.createEl('button', {
            text: 'Index Now',
            cls: 'index-status-callout-btn'
        });

        
        const embeddingsManager = (this.plugin as any).embeddingsManager;
        if (embeddingsManager && typeof embeddingsManager.detectChanges === 'function') {
            
            const indexConfigs: any[] = this.settings.indexConfigurations || [];
            let targetIndexId: string | null = null;
            if (searchMode === 'flash') {
                const bm25Config = indexConfigs.find((c: any) => c.type === 'bm25' && c.enabled)
                    ?? indexConfigs.find((c: any) => c.type === 'bm25');
                targetIndexId = bm25Config?.id ?? null;
            } else {
                const embConfig = indexConfigs.find((c: any) => c.type === 'embedding' && c.enabled)
                    ?? indexConfigs.find((c: any) => c.type === 'embedding');
                targetIndexId = embConfig?.id ?? null;
            }

            if (targetIndexId) {
                embeddingsManager.detectChanges(targetIndexId).then((changes: { hasChanges: boolean }) => {
                    if (!changes.hasChanges) {
                        dotWrapper.remove();
                    }
                }).catch(() => {
                    
                });
            } else {
                
                dotWrapper.remove();
            }
        }

        let isIndexing = false;
        indexBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (isIndexing) return;
            isIndexing = true;
            indexBtn.disabled = true;
            indexBtn.textContent = 'Indexing…';

            
            const notice = new Notice('Incremental Indexing started…', 0);

            try {
                
                const indexConfigs: any[] = this.settings.indexConfigurations || [];

                if (searchMode === 'flash') {
                    
                    const bm25Config = indexConfigs.find((c: any) => c.type === 'bm25' && c.enabled)
                        ?? indexConfigs.find((c: any) => c.type === 'bm25');

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
                        const allMdFiles = this.app.vault.getMarkdownFiles();
                        const bm25FileCount = await embeddingsManager.getBM25FileCount(bm25Config.id);
                        bm25Config.fileCount = bm25FileCount;
                        bm25Config.lastUpdated = Date.now();
                        bm25Config.isBuilding = false;
                        bm25Config.buildProgress = 0;
                    }
                    
                    const allFiles = this.app.vault.getMarkdownFiles();
                    const bm25Count = bm25Config ? bm25Config.fileCount : 0;
                    this.settings.bm25IndexedFiles = allFiles.length > 0
                        ? Math.round((bm25Count / allFiles.length) * 100) : 0;

                } else {
                    
                    const embConfig = indexConfigs.find((c: any) => c.type === 'embedding' && c.enabled)
                        ?? indexConfigs.find((c: any) => c.type === 'embedding');

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
                        const allMdFiles = this.app.vault.getMarkdownFiles();
                        const nonExcluded = allMdFiles.filter((f: any) => !embeddingsManager.isFileExcluded(f.path, embConfig.id));
                        const embFileCount = await embeddingsManager.getEmbeddedFileCount(embConfig.id);
                        embConfig.fileCount = embFileCount;
                        embConfig.lastUpdated = Date.now();
                        embConfig.isBuilding = false;
                        embConfig.buildProgress = 0;
                    }
                    
                    const allFiles = this.app.vault.getMarkdownFiles();
                    const nonExcluded = allFiles.filter((f: any) => !embeddingsManager.isFileExcluded(f.path, embConfig?.id));
                    const embCount = embConfig ? embConfig.fileCount : 0;
                    this.settings.embeddingIndexedFiles = nonExcluded.length > 0
                        ? Math.round((embCount / nonExcluded.length) * 100) : 0;
                }

                await this.plugin.saveSettings();
                notice.setMessage('Incremental Indexing complete.');
                setTimeout(() => notice.hide(), 3000);

                
                dotWrapper.remove();

            } catch (err: any) {
                notice.setMessage(`Indexing failed: ${err?.message || 'Unknown error'}`);
                setTimeout(() => notice.hide(), 5000);
                indexBtn.disabled = false;
                indexBtn.textContent = 'Retry';
                isIndexing = false;

                
                const indexConfigs: any[] = this.settings.indexConfigurations || [];
                indexConfigs.forEach((c: any) => { c.isBuilding = false; });
            }
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

        
        document.addEventListener('click', () => {
            calloutVisible = false;
            callout.classList.remove('visible');
        }, { capture: true });
    }

    private async loadNonIndexedFiles(container: HTMLElement, searchMode: 'vault' | 'flash') {
        try {
            const embeddingsManager = (this.plugin as any).embeddingsManager;
            if (!embeddingsManager) {
                container.empty();
                container.createSpan({ text: 'Unable to load files', cls: 'index-status-files-loading' });
                return;
            }

            const indexConfigs: any[] = this.settings.indexConfigurations || [];

            
            let targetConfig: any = null;
            if (searchMode === 'flash') {
                targetConfig = indexConfigs.find((c: any) => c.type === 'bm25' && c.enabled)
                    ?? indexConfigs.find((c: any) => c.type === 'bm25');
            } else {
                targetConfig = indexConfigs.find((c: any) => c.type === 'embedding' && c.enabled)
                    ?? indexConfigs.find((c: any) => c.type === 'embedding');
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

                    const loadResponse = await OramaWorkerManager.getInstance().load(tempId, data, schema, true);
                    await OramaWorkerManager.getInstance().remove(tempId, ''); 

                    const docs = loadResponse?.documents || loadResponse?.metadata?.documents || [];
                    for (const doc of docs) {
                        if (doc.path && doc.path.endsWith('.md')) {
                            indexedFilePaths.add(doc.path);
                        }
                    }
                } catch { /* treat as empty */ }
            }

            
            
            const allFiles = this.app.vault.getMarkdownFiles();
            const includedFiles = isBM25
                ? allFiles
                : allFiles.filter((file: any) => !embeddingsManager.isFileExcluded(file.path, indexId));

            
            const nonIndexedFiles = includedFiles.filter((file: any) => !indexedFilePaths.has(file.path) && (file.stat?.size || 0) > 0);

            container.empty();

            if (nonIndexedFiles.length === 0) {
                container.createSpan({ text: 'All files are indexed!', cls: 'index-status-files-loading' });
            } else {
                const countText = container.createDiv();
                countText.createSpan({ text: `${nonIndexedFiles.length}`, cls: 'index-status-files-count' });
                countText.appendText(` file${nonIndexedFiles.length !== 1 ? 's' : ''} not indexed:`);

                nonIndexedFiles.sort((a: any, b: any) => a.path.localeCompare(b.path));

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
        } catch (error) {
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

            const session = {
                id: this.currentSessionId,
                name: sessionName,
                createdAt: now, 
                updatedAt: now,
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
                    webResults: r.webResults,
                    

                    fileActionData: r.fileActionIds ? this.getFileActionDataForSave(r.fileActionIds) : undefined,
                    
                    modelName: r.modelName,
                    totalTokens: r.totalTokens,
                    responseTimeMs: r.responseTimeMs,
                    
                    mcpTools: r.mcpTools,
                    
                    searchMode: r.searchMode,
                    
                    vaultIndexName: r.vaultIndexName
                }))
            };

            
            const responsesWithFileActions = this.responses.filter(r => r.fileActionIds && r.fileActionIds.length > 0);

            await this.aiChatSessionManager.saveSession(session);
        }
    }

    private getFileActionDataForSave(fileActionIds: string[]): { [actionId: string]: any } {
        const actionData: { [actionId: string]: any } = {};

        for (const actionId of fileActionIds) {
            const actionState = this.activeFileActions.get(actionId);
            if (actionState) {
                actionData[actionId] = {
                    type: actionState.type,
                    fileName: actionState.fileName,
                    status: actionState.status,
                    isApplied: actionState.isApplied || false,
                };

                
                if (actionState.type === 'edit' && actionState.data) {
                    actionData[actionId].editData = {
                        filePath: actionState.data.file?.path || '',
                        originalContent: actionState.data.originalContent || '',
                        editedContent: actionState.data.editedContent || '',
                        editPrompt: actionState.data.editPrompt || ''
                    };
                }

                
                if (actionState.type === 'create' && actionState.data) {
                    actionData[actionId].createData = {
                        folderName: actionState.data.folderName || '',
                        creationPrompt: actionState.data.creationPrompt || '',
                        files: actionState.data.files || []
                    };
                }
            }
        }

        return actionData;
    }

    private startNewSession() {
        
        this.responses = [];
        this.currentSessionId = null;
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

        
        const btn = this.containerEl.querySelector('.header-system-instructions-btn') as HTMLElement | null;
        if (btn) {
            btn.removeClass('has-instructions');
            btn.removeAttribute('data-collection-icon');
            
            setIcon(btn, 'wrench');
        }
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
                navigator.clipboard.writeText(question);
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
            textArea.style.height = 'auto';
            textArea.style.height = textArea.scrollHeight + 'px';
        };
        textArea.addEventListener('input', adjustHeight);
        setTimeout(adjustHeight, 0); 

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
        
        const menu = document.createElement('div');
        menu.className = 'context-file-menu';
        
        const rect = anchorEl.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.left = `${rect.left}px`;
        menu.style.zIndex = '9999';
        menu.style.minWidth = '260px';
        
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'context-file-menu-search';
        searchInput.placeholder = 'Search files directly by name, use / for folders';
        menu.appendChild(searchInput);
        this.contextMenuInput = searchInput;
        
        const listContainer = document.createElement('div');
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
                    searchInput as any, 
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
                    searchInput as any, 
                    curPos
                );
                modal.open();
                return;
            }
            this.renderContextMenuOptions(listContainer, val);
        });
        
        setTimeout(() => {
            document.addEventListener('mousedown', this.handleContextMenuOutsideClick, true);
        }, 0);
        document.body.appendChild(menu);
        
        const menuHeight = menu.offsetHeight;
        
        if (anchorEl.classList.contains('capsule-more-tag')) {
            menu.style.left = `${rect.right - menu.offsetWidth}px`;
        } else {
            menu.style.left = `${rect.left}px`;
        }
        menu.style.top = `${rect.top - menuHeight - 8}px`;
        this.contextMenuEl = menu;
    }

    private closeContextMenu = () => {
        if (this.contextMenuEl) {
            document.body.removeChild(this.contextMenuEl);
            this.contextMenuEl = null;
        }
        if (this.contextMenuPreviewEl) {
            document.body.removeChild(this.contextMenuPreviewEl);
            this.contextMenuPreviewEl = null;
        }
        document.removeEventListener('mousedown', this.handleContextMenuOutsideClick, true);
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

        const menu = document.createElement('div');
        menu.className = 'context-file-menu';

        
        const rect = anchorEl.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.left = `${rect.left}px`;
        menu.style.zIndex = '9999';
        menu.style.minWidth = '260px';

        
        const listContainer = document.createElement('div');
        listContainer.className = 'context-file-menu-list';
        menu.appendChild(listContainer);

        
        this.renderContextMenuOptionsFiltered(listContainer, searchTerm);

        
        setTimeout(() => {
            document.addEventListener('mousedown', this.handleContextMenuOutsideClick, true);
        }, 0);

        document.body.appendChild(menu);

        
        const menuHeight = menu.offsetHeight;
        menu.style.top = `${rect.top - menuHeight - 8}px`;

        this.contextMenuEl = menu;
    }

    /**
     * Renders context menu options filtered by search term
     * Shows feature prefixes first, then matching files
     */
    private renderContextMenuOptionsFiltered(container: HTMLElement, searchTerm: string) {
        container.empty();

        const lowerSearch = searchTerm.toLowerCase();

        
        const prefixOptions = [
            { label: '@flash', value: '@flash ', action: 'prefix', description: 'Fast BM25 keyword search', hasToggle: true },
            { label: '@vault', value: '@vault ', action: 'prefix', hasToggle: true },
            { label: '@web', value: '@web ', action: 'prefix' },
            ...(!Platform.isMobile ? [{ label: '@mcp', value: '@mcp ', action: 'prefix', description: 'Use MCP servers and tools' }] : []),
            { label: '@create', value: '@create ', action: 'prefix', description: 'Create files (canvas/excalidraw/markdown)' },
            
            { label: '@webpage', value: '@webpage', action: 'modal', modalType: 'webpage' },
            { label: '@youtube', value: '@youtube', action: 'modal', modalType: 'youtube' }
        ];

        
        const matchingPrefixes = prefixOptions.filter(opt =>
            opt.label.toLowerCase().includes(lowerSearch)
        );

        
        if (matchingPrefixes.length > 0) {
            matchingPrefixes.forEach((opt, index) => {
                const item = document.createElement('div');
                item.className = 'context-file-menu-item';

                
                if ('badge' in opt && (opt as any).badge) {
                    const labelSpan = document.createElement('span');
                    labelSpan.textContent = opt.label;

                    const badgeSpan = document.createElement('span');
                    badgeSpan.className = 'feature-badge beta-badge';
                    badgeSpan.textContent = (opt as any).badge;
                    badgeSpan.style.cssText = 'margin-left: 6px; padding: 2px 6px; font-size: 0.7em; background: var(--interactive-accent); color: var(--text-on-accent); border-radius: 3px; font-weight: 600;';

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
            const files = this.app.vault.getMarkdownFiles();
            const matchingFiles = files.filter(file =>
                file.basename.toLowerCase().includes(lowerSearch) ||
                file.path.toLowerCase().includes(lowerSearch)
            ).slice(0, 10); 

            if (matchingFiles.length > 0) {
                const fileHeader = document.createElement('div');
                fileHeader.className = 'context-file-menu-section-header';
                fileHeader.textContent = 'Files';
                container.appendChild(fileHeader);

                matchingFiles.forEach((file, index) => {
                    const item = document.createElement('div');
                    item.className = 'context-file-menu-item';

                    const iconSpan = item.createSpan();
                    setIcon(iconSpan, this.getFileTypeIcon(file.name));
                    item.appendText(` ${file.basename}`);

                    
                    item.setAttribute('data-option-type', 'file');
                    item.setAttribute('data-file-path', file.path);

                    
                    if (index === 0) {
                        item.classList.add('selected');
                        
                        setTimeout(() => this.updateContextMenuPreview(item), 100);
                    }

                    item.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.handleFileSelection(file);
                    });

                    
                    item.addEventListener('mouseenter', async () => {
                        
                        const allItems = container.querySelectorAll('.context-file-menu-item');
                        allItems.forEach(i => i.classList.remove('selected'));
                        
                        item.classList.add('selected');
                        
                        await this.updateContextMenuPreview(item);
                    });

                    container.appendChild(item);
                });
            } else {
                const noResults = document.createElement('div');
                noResults.className = 'context-file-menu-item';
                noResults.textContent = 'No matches found';
                noResults.style.opacity = '0.5';
                container.appendChild(noResults);
            }
        }
    }

    /**
     * Handles selection of a feature prefix
     * Places prefix at the start of the query
     */
    private handlePrefixSelection(opt: any) {
        
        const atIndex = this.contextMenuAtIndex;

        this.closeContextMenu();

        
        if (opt.action === 'modal' && opt.modalType === 'youtube') {
            new YouTubeURLModal(this.app, async (url) => {
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
                    } catch (error: any) {
                        new Notice(`Failed to fetch transcript: ${error.message}`);
                        
                        this.selectedFiles.delete(url);
                    }
                }

                this.renderFileCapsules(this.inputContainer.querySelector('.context-capsule-display') as HTMLElement);
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
            if (Platform.isMobile) return;
            
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

            const availableServers = (this.settings.mcpServers || []).filter((s: any) => !s.disabled);
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
                        .map((id: string) => this.settings.mcpServers.find((s: any) => s.id === id)?.name)
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
                this.contextMenuPreviewEl.style.display = 'none';
            }
            return;
        }

        const filePath = item.getAttribute('data-file-path');
        if (!filePath) return;

        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;

        try {
            
            const content = await this.app.vault.read(file);

            
            if (!this.contextMenuPreviewEl) {
                this.contextMenuPreviewEl = document.createElement('div');
                this.contextMenuPreviewEl.className = 'context-file-preview';
                document.body.appendChild(this.contextMenuPreviewEl);
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

            
            await MarkdownRenderer.renderMarkdown(
                previewText,
                contentDiv,
                file.path,
                new Component()
            );

            
            if (this.contextMenuEl) {
                const menuRect = this.contextMenuEl.getBoundingClientRect();
                const previewHeight = 250; 

                this.contextMenuPreviewEl.style.position = 'fixed';
                this.contextMenuPreviewEl.style.left = `${menuRect.left}px`;
                this.contextMenuPreviewEl.style.bottom = `${window.innerHeight - menuRect.top + 8}px`;
                this.contextMenuPreviewEl.style.width = `${Math.max(menuRect.width, 400)}px`;
                this.contextMenuPreviewEl.style.maxHeight = `${previewHeight}px`;
                this.contextMenuPreviewEl.style.display = 'block';
            }
        } catch (error) {
                        if (this.contextMenuPreviewEl) {
                this.contextMenuPreviewEl.style.display = 'none';
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
            const remHeader = document.createElement('div');
            remHeader.className = 'context-file-menu-section-header';
            remHeader.textContent = 'Added files';
            container.appendChild(remHeader);
            remaining.forEach(path => {
                const item = document.createElement('div');
                item.className = 'context-file-menu-item added';

                
const isYouTubeUrl = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|live\/)|youtu\.be\/)/.test(path);
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
            
            const divider = document.createElement('div');
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
        const recHeader = document.createElement('div');
        recHeader.className = 'context-file-menu-section-header';
        recHeader.textContent = 'Recent files';
        container.appendChild(recHeader);
        recentFiles.forEach(file => {
            
            if (this.selectedFiles.has(file.path)) return;
            const item = document.createElement('div');
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
        
        const divider2 = document.createElement('div');
        divider2.className = 'context-file-menu-divider';
        container.appendChild(divider2);
        
        if (!this.contextMenuOpenFromMore) {
            const prefixOptions = [
                { label: '@flash', value: '@flash ', action: 'prefix', description: 'Fast BM25 keyword search', hasToggle: true },
                { label: '@vault', value: '@vault ', action: 'prefix', hasToggle: true },
                { label: '@web', value: '@web ', action: 'prefix' },
                ...(!Platform.isMobile ? [{ label: '@mcp', value: '@mcp ', action: 'prefix', description: 'Use MCP servers and tools', hasToggle: true }] : []),
                { label: '@create', value: '@create ', action: 'prefix', description: 'Create files (canvas/excalidraw/markdown)' },
                
                { label: '@webpage', value: '@webpage', action: 'modal', modalType: 'webpage' },
                { label: '@youtube', value: '@youtube', action: 'modal', modalType: 'youtube' }
            ];
            prefixOptions.forEach(opt => {
                const item = document.createElement('div');
                item.className = 'context-file-menu-item';

                
                if (opt.hasToggle && opt.value === '@vault ') {
                    const labelSpan = document.createElement('span');
                    labelSpan.textContent = opt.label;
                    item.appendChild(labelSpan);

                    const toggleContainer = document.createElement('div');
                    toggleContainer.className = 'vault-citation-toggle-container';
                    toggleContainer.style.cssText = 'margin-left: auto; display: flex; align-items: center; gap: 10px;';

                    
                    const toggleLabel = document.createElement('span');
                    toggleLabel.textContent = 'Citations';
                    toggleLabel.style.cssText = 'font-size: 0.85em; color: var(--text-muted);';

                    const toggleSwitch = document.createElement('input');
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

                    item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 8px 12px;';
                } else if (opt.hasToggle && opt.value === '@flash ') {
                    
                    const labelSpan = document.createElement('span');
                    labelSpan.textContent = opt.label;
                    item.appendChild(labelSpan);

                    const toggleContainer = document.createElement('div');
                    toggleContainer.className = 'flash-citation-toggle-container';
                    toggleContainer.style.cssText = 'margin-left: auto; display: flex; align-items: center; gap: 6px;';

                    const toggleLabel = document.createElement('span');
                    toggleLabel.textContent = 'Citations';
                    toggleLabel.style.cssText = 'font-size: 0.85em; color: var(--text-muted);';

                    const toggleSwitch = document.createElement('input');
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

                    item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 8px 12px;';
                    /* TEMPORARILY DISABLED - @agent mode
                    } else if (opt.hasToggle && opt.value === '@agent ') {
                        
                        const labelContainer = document.createElement('div');
                        labelContainer.style.cssText = 'display: flex; align-items: center; gap: 6px;';
                        
                        const labelSpan = document.createElement('span');
                        labelSpan.textContent = opt.label;
                        labelContainer.appendChild(labelSpan);
                        
                        
                        if (opt.badge) {
                            const badgeSpan = document.createElement('span');
                            badgeSpan.className = 'feature-badge beta-badge';
                            badgeSpan.textContent = opt.badge;
                            badgeSpan.style.cssText = 'padding: 2px 6px; font-size: 0.7em; background: var(--interactive-accent); color: var(--text-on-accent); border-radius: 3px; font-weight: 600;';
                            labelContainer.appendChild(badgeSpan);
                        }
                        
                        item.appendChild(labelContainer);
                        
                        const toggleContainer = document.createElement('div');
                        toggleContainer.className = 'agent-ratelimit-toggle-container';
                        toggleContainer.style.cssText = 'margin-left: auto; display: flex; align-items: center; gap: 6px;';
                        
                        const toggleLabel = document.createElement('span');
                        toggleLabel.textContent = 'Rate Limit';
                        toggleLabel.style.cssText = 'font-size: 0.85em; color: var(--text-muted);';
                        
                        const toggleSwitch = document.createElement('input');
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
                        
                        item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 8px 12px;';
                    */ 
                } else if (opt.hasToggle && opt.value === '@mcp ') {
                    
                    const labelSpan = document.createElement('span');
                    labelSpan.textContent = opt.label;
                    item.appendChild(labelSpan);

                    const toggleContainer = document.createElement('div');
                    toggleContainer.className = 'mcp-ratelimit-toggle-container';
                    toggleContainer.style.cssText = 'margin-left: auto; display: flex; align-items: center; gap: 6px;';

                    const toggleLabel = document.createElement('span');
                    toggleLabel.textContent = 'Delay Limit';
                    toggleLabel.style.cssText = 'font-size: 0.85em; color: var(--text-muted);';

                    const toggleSwitch = document.createElement('input');
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

                    item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 8px 12px;';
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
                        if (Platform.isMobile) return;
                        if (!this.settings.mcpEnabled) {
                            new Notice('MCP support is disabled. Enable it in settings.');
                            return;
                        }
                        const availableServers = (this.settings.mcpServers || []).filter((s: any) => !s.disabled);
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
                                    .map((id: string) => this.settings.mcpServers.find((s: any) => s.id === id)?.name)
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
            attr: { style: 'margin-bottom: 16px; color: var(--text-muted);' }
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
        if (this.sessionHistoryModal) {
            this.sessionHistoryModal.remove();
            this.sessionHistoryModal = null;
        }
        const modal = document.createElement('div');
        modal.className = 'ai-chat-session-history-modal';
        
        modal.createDiv({ cls: 'modal-bg' });
        const modalContent = modal.createDiv({ cls: 'modal-content' });
        const modalHeader = modalContent.createDiv({ cls: 'modal-header' });
        modalHeader.createEl('h3', { text: 'AI Chat Sessions' });
        const closeBtn = modalHeader.createEl('button', { cls: 'close-btn', attr: { title: 'Close' } });
        setIcon(closeBtn, 'x');

        const searchContainer = modalContent.createDiv({ cls: 'session-search-container' });
        const searchInput = searchContainer.createEl('input', { 
            type: 'text', 
            cls: 'session-search-input', 
            placeholder: 'Search sessions by name or message content...' 
        }) as HTMLInputElement;
        const searchIcon = searchContainer.createSpan({ cls: 'search-icon', text: '🔍' });

        const sessionList = modalContent.createDiv({ cls: 'session-list' });
        const paginationDiv = modalContent.createDiv({ cls: 'session-pagination', attr: { style: 'display: none;' } });
        const prevBtn = paginationDiv.createEl('button', { cls: 'prev-page-btn', text: 'Previous' });
        const pageInfo = paginationDiv.createSpan({ cls: 'page-info' });
        const nextBtn = paginationDiv.createEl('button', { cls: 'next-page-btn', text: 'Next' });

        document.body.appendChild(modal);
        this.sessionHistoryModal = modal;

        closeBtn.addEventListener('click', () => {
            modal.remove();
            this.sessionHistoryModal = null;
        });

        let currentPage = 0;
        const pageSize = 20;
        let totalSessions = 0;
        let currentSearchQuery = '';
        let searchTimeout: NodeJS.Timeout | null = null;

        const loadPage = async (page: number, searchQuery: string = '') => {
            sessionList.empty();
            sessionList.createDiv({ cls: 'loading-sessions', text: 'Searching...' });
            const offset = page * pageSize;
            const { sessions, total } = await this.aiChatSessionManager.listSessionsLazy(pageSize, offset, searchQuery);
            totalSessions = total;

            sessionList.empty();
            if (sessions.length === 0) {
                if (searchQuery) {
                    const noSessions = sessionList.createDiv({ cls: 'no-sessions-message' });
                    noSessions.appendText(`No sessions found matching "${searchQuery}"`);
                    noSessions.createEl('br');
                    noSessions.createEl('small', { text: 'Searched in session names and all message content' });
                } else if (page === 0) {
                    sessionList.createDiv({ cls: 'no-sessions-message', text: 'No sessions yet.' });
                }
                paginationDiv.style.display = 'none';
            } else {
                
                const fragment = document.createDocumentFragment();
                sessions.forEach(meta => {
                    const card = document.createElement('div');
                    card.className = 'session-card';

                    const sessionInfo = card.createDiv({ cls: 'session-info' });
                    const nameSpan = sessionInfo.createSpan({ cls: 'session-name' });

                    
                    if (searchQuery) {
                        const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
                        const parts = meta.name.split(regex);
                        parts.forEach(part => {
                            if (part.toLowerCase() === searchQuery.toLowerCase()) {
                                nameSpan.createEl('mark', { text: part });
                            } else {
                                nameSpan.appendText(part);
                            }
                        });
                    } else {
                        nameSpan.textContent = meta.name;
                    }

                    
                    if (searchQuery && meta.matchCount !== undefined) {
                        if (meta.matchCount === -1) {
                            const matchIndicator = sessionInfo.createSpan({ 
                                cls: 'match-indicator name-match', 
                                text: '📝 Name match' 
                            });
                            matchIndicator.setAttr('title', 'Match found in session name');
                        } else if (meta.matchCount > 0) {
                            const plural = meta.matchCount === 1 ? 'message' : 'messages';
                            const matchIndicator = sessionInfo.createSpan({ 
                                cls: 'match-indicator content-match', 
                                text: `💬 ${meta.matchCount} ${plural}` 
                            });
                            matchIndicator.setAttr('title', `${meta.matchCount} ${plural} contain your search term`);
                        }
                    }

                    card.createSpan({ 
                        cls: 'session-date', 
                        text: new Date(meta.updatedAt).toLocaleString() 
                    });

                    card.addEventListener('click', async () => {
                        await this.loadAIChatSession(meta.id);
                        modal.remove();
                        this.sessionHistoryModal = null;
                    });
                    const deleteBtn = document.createElement('button');
                    deleteBtn.className = 'delete-session-btn';
                    setIcon(deleteBtn, 'trash-2');
                    deleteBtn.title = 'Delete session';
                    deleteBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await this.aiChatSessionManager.deleteSession(meta.id);
                        card.remove();
                        totalSessions--;
                        updatePagination();
                        
                        if (sessionList.querySelectorAll('.session-card').length === 0 && currentPage > 0) {
                            currentPage--;
                            await loadPage(currentPage, currentSearchQuery);
                        }
                    });
                    card.appendChild(deleteBtn);
                    fragment.appendChild(card);
                });
                sessionList.appendChild(fragment);

                
                if (totalSessions > pageSize) {
                    paginationDiv.style.display = 'flex';
                    updatePagination();
                } else {
                    paginationDiv.style.display = 'none';
                }
            }
        };

        const updatePagination = () => {
            const totalPages = Math.ceil(totalSessions / pageSize);
            const searchSuffix = currentSearchQuery ? ' (filtered)' : '';
            pageInfo.textContent = `Page ${currentPage + 1} of ${totalPages} (${totalSessions} sessions${searchSuffix})`;
            prevBtn.disabled = currentPage === 0;
            nextBtn.disabled = currentPage >= totalPages - 1;
        };

        
        searchInput.addEventListener('input', () => {
            if (searchTimeout) {
                clearTimeout(searchTimeout);
            }

            searchTimeout = setTimeout(async () => {
                currentSearchQuery = searchInput.value.trim();
                currentPage = 0; 
                await loadPage(currentPage, currentSearchQuery);
            }, 300); 
        });

        
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && searchInput.value) {
                e.stopPropagation();
                searchInput.value = '';
                currentSearchQuery = '';
                currentPage = 0;
                loadPage(currentPage, currentSearchQuery);
            }
        });

        prevBtn.addEventListener('click', async () => {
            if (currentPage > 0) {
                currentPage--;
                await loadPage(currentPage, currentSearchQuery);
            }
        });

        nextBtn.addEventListener('click', async () => {
            const totalPages = Math.ceil(totalSessions / pageSize);
            if (currentPage < totalPages - 1) {
                currentPage++;
                await loadPage(currentPage, currentSearchQuery);
            }
        });

        
        await loadPage(0);

        
        searchInput.focus();
    }

    private openSystemInstructionsModal() {
        new SystemInstructionsModal(
            this.app,
            this.currentSystemInstructions,
            this.settings,
            async () => await this.plugin.saveSettings(),
            (instructions: string, icon?: string) => {
                this.currentSystemInstructions = instructions;
                
                const btn = this.containerEl.querySelector('.header-system-instructions-btn') as HTMLElement | null;
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
                    this.saveCurrentSession();
                }
                new Notice(instructions ? 'System instructions saved' : 'System instructions cleared');
            }
        ).open();
    }

    private async loadAIChatSession(sessionId: string) {
        
        const existingLeaf = this.findLeafWithSession(sessionId);
        if (existingLeaf && existingLeaf !== this.leaf) {
            
            this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
            new Notice('This chat session is already open in another tab');
            return;
        }

        const session = await this.aiChatSessionManager.loadSession(sessionId);
        if (session) {

            this.responses = session.messages.map((m: any) => ({
                question: m.question,
                answer: m.answer,
                context: m.context || [],
                timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
                sources: m.sources || [],
                webResults: m.webResults || [],
                

                id: m.id,
                sessionId: m.sessionId,
                fileActionIds: m.fileActionIds,
                fileActionData: m.fileActionData,
                
                modelName: m.modelName,
                totalTokens: m.totalTokens,
                responseTimeMs: m.responseTimeMs,
                
                agentSteps: m.agentSteps,
                isAgentResponse: m.isAgentResponse,
                vaultAnswer: m.vaultAnswer,
                vaultResults: m.vaultResults,
                
                
                fileOperations: m.fileOperations || [],
                
                mcpTools: m.mcpTools || [],
                
                searchMode: m.searchMode,
                
                vaultIndexName: m.vaultIndexName
            }));

            this.currentSessionId = sessionId;

            
            this.updateContextBar();

            
            this.currentSystemInstructions = session.systemInstructions || '';
            
            const btn = this.containerEl.querySelector('.header-system-instructions-btn') as HTMLElement | null;
            if (btn) {
                if (this.currentSystemInstructions) {
                    btn.addClass('has-instructions');
                    
                    const matchedItem = this.settings.savedSystemInstructions?.find(
                        (s: any) => s.instructions === this.currentSystemInstructions
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
            }
        } else {
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
            MarkdownRenderer.render(this.app, r.answer, messageEl, '', this);

            
            const capsulesContainer = answerEl.createDiv({ cls: 'file-action-capsules' });

            
            for (const actionId of r.fileActionIds) {
                this.restoreFileActionCapsule(actionId, capsulesContainer, r);
            }
        } else {
            
            MarkdownRenderer.render(this.app, r.answer, answerEl, '', this);
            
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

        
        const savedActionData = response.fileActionData?.[actionId];

        
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
            status: savedActionData?.status || 'completed',
            element: capsule,
            data: savedActionData ? this.reconstructActionData(savedActionData) : null,
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
            this.handleHistoricalFileAction(actionId, 'accept', response);
        });

        rejectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleHistoricalFileAction(actionId, 'reject', response);
        });

        
        capsule.addEventListener('click', () => {
            this.openFileActionModal(actionId);
        });

        
        capsule.style.display = 'flex';
    }

    private reconstructActionData(savedActionData: any): any {
        if (savedActionData.type === 'edit' && savedActionData.editData) {
            
            const filePath = savedActionData.editData.filePath;
            const file = filePath ? this.app.vault.getAbstractFileByPath(filePath) : null;

            return {
                file: file || { path: filePath, basename: filePath?.split('/').pop() || 'Unknown' },
                originalContent: savedActionData.editData.originalContent || '',
                editedContent: savedActionData.editData.editedContent || '',
                editPrompt: savedActionData.editData.editPrompt || ''
            };
        } else if (savedActionData.type === 'create' && savedActionData.createData) {
            return {
                folderName: savedActionData.createData.folderName || 'New Files',
                creationPrompt: savedActionData.createData.creationPrompt || '',
                files: Array.isArray(savedActionData.createData.files) ? savedActionData.createData.files : []
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

                
                this.processFileCreate(actionId, creationPrompt, targetFolder, []);

                new Notice(`Recreating files based on: "${response.question.substring(0, 50)}..."`);

                
                

            }
        } else if (action === 'reject') {
            
            if (actionState.isApplied) {
                if (actionState.type === 'create' && actionState.data) {
                    
                    try {
                        await this.deleteFilesFromPlan(actionState.data);
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

    
    createFileActionCapsule(type: 'edit' | 'create', fileName: string, data?: any): string {
        const actionId = `file-action-${++this.fileActionCounter}`;

        const actionState: FileActionState = {
            id: actionId,
            type,
            fileName,
            status: 'processing',
            element: null as any, 
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
        MarkdownRenderer.render(this.app, message, messageEl, '', this);

        
        const capsulesContainer = responseContainer.createDiv({ cls: 'file-action-capsules' });

        
        const capsule = capsulesContainer.createDiv({ cls: `file-action-capsule ${actionState.type}-capsule` });
        actionState.element = capsule;

        
        const icon = capsule.createDiv({ cls: 'file-action-icon' });
        setIcon(icon, actionState.type === 'edit' ? 'edit' : 'file-plus');

        
        const nameEl = capsule.createDiv({ cls: 'file-action-name' });
        if ((actionState as any).fileName && (actionState as any).fileName.includes('[[') && (actionState as any).fileName.includes(']]')) {
            MarkdownRenderer.render(this.app, (actionState as any).fileName, nameEl, '', this);
        } else {
            nameEl.textContent = (actionState as any).fileName;
        }

        
        const statusEl = capsule.createDiv({ cls: 'file-action-status' });
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
                        new mod.FileCreationReviewModal(this.app, data, this.plugin.settings, (acceptedPlan: any) => {
                            this.acceptFileAction(actionId, acceptedPlan);
                        }).open();
                    } catch (modalError) {
                                                new Notice('Failed to create create modal: ' + (modalError instanceof Error ? modalError.message : 'Unknown error'));
                    }
                } else {
                                        new Notice('Create modal not available. Please accept or reject the changes.');
                }
            }).catch(err => {
                                new Notice('Failed to open create modal. Please accept or reject the changes.');
            });
        }
    }

    async acceptFileAction(actionId: string, data?: any) {
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
                    await this.createCanvasFile(targetFolder, plan);
                    actionState.isApplied = true;
                    new Notice(`Created canvas file in folder: ${targetFolder}`);
                } else if (actionState.isExcalidraw || (plan && plan.type === 'excalidraw')) {
                    
                    const targetFolder = actionState.fileName || 'New Files';
                    await this.createExcalidrawFile(targetFolder, plan);
                    actionState.isApplied = true;
                    new Notice(`Created Excalidraw diagram in folder: ${targetFolder}`);
                } else {
                    
                    await this.createFilesFromPlan(plan);
                    actionState.isApplied = true;
                    new Notice(`Created ${plan.files.length} file(s) in folder: ${plan.folderName}. Click reject to delete.`);
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
                            
                            await this.deleteFilesFromPlan(actionState.data);
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
                await this.app.vault.delete(file);
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
                await this.app.vault.delete(file);
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
            this.acceptFileAction(actionId);
        });

        rejectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.rejectFileAction(actionId);
        });

        statusEl.className = `file-action-status ${actionState.status}`;
    }

    private async deleteFilesFromPlan(plan: any): Promise<void> {
        if (!plan || !plan.folderName || !Array.isArray(plan.files)) {
            throw new Error('Invalid file creation plan for deletion');
        }

        
        for (const fileInfo of plan.files) {
            if (!fileInfo.name) continue;

            const fileName = `${fileInfo.name}.${fileInfo.extension || 'md'}`;
            const filePath = normalizePath(`${plan.folderName}/${fileName}`);

            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file) {
                await this.app.vault.delete(file);
            }
        }

        
        try {
            const folder = this.app.vault.getAbstractFileByPath(plan.folderName);
            if (folder && folder instanceof this.app.vault.adapter.constructor && 'children' in folder) {
                const folderChildren = (folder as any).children;
                if (folderChildren && folderChildren.length === 0) {
                    await this.app.vault.delete(folder);
                }
            }
        } catch (err) {
            
        }
    }

    async processFileCreate(actionId: string, prompt: string, targetFolder?: string, contextFiles: any[] = [], autoSelectedModel: ModelSelection | null = null) {
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

    async processCanvasCreate(actionId: string, prompt: string, targetFolder?: string, contextFiles: any[] = [], autoSelectedModel: ModelSelection | null = null) {
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
            const canvasData = JSON.parse(canvasJSON);

            
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
                    MarkdownRenderer.render(this.app, actionState.fileName, nameEl, '', this);
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

    async processExcalidrawCreate(actionId: string, prompt: string, targetFolder?: string, contextFiles: any[] = [], autoSelectedModel: ModelSelection | null = null) {
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
            const excalidrawData = JSON.parse(excalidrawJSON);

            
            const folder = targetFolder || 'New Files';
            const fullPath = this.generateUniquePath(folder, 'diagram', 'excalidraw.md');

            
            excalidrawData.folderName = folder;
            excalidrawData.targetPath = fullPath;
            actionState.data = excalidrawData;
            actionState.isExcalidraw = true;

            
            actionState.fileName = `[[${fullPath}]]`;
            if (actionState.element) {
                const nameEl = actionState.element.querySelector('.file-action-name') as HTMLElement;
                if (nameEl) {
                    nameEl.empty();
                    MarkdownRenderer.render(this.app, actionState.fileName, nameEl, '', this);
                }
            }

            
            this.updateFileActionStatus(actionId, 'completed');

            
            if (actionState.element && actionState.element.classList.contains('historical')) {
                await this.acceptFileAction(actionId, excalidrawData);
            }

        } catch (error) {
                        this.updateFileActionStatus(actionId, 'failed', error instanceof Error ? error.message : 'Unknown error');
        }
    }

    private async generateDiagramMarkdown(context: any, type: 'canvas' | 'excalidraw'): Promise<string> {
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
            contextInfo = `\n\nCONTEXT FILES PROVIDED:\n${context.contextFiles.map((f: any) => `- ${f.basename}:\n${f.content.substring(0, 1500)}`).join('\n\n')}`;
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
            const convertedHistory = (context.chatHistory || []).map((h: any) => ({
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
            const convertedHistory = (context.chatHistory || []).map((h: any) => ({
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
            const convertedHistory = (context.chatHistory || []).map((h: any) => ({
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
            const convertedHistory = (context.chatHistory || []).map((h: any) => ({
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
            const convertedHistory = (context.chatHistory || []).map((h: any) => ({
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

    private async getInitialFileStructure(context: any): Promise<any> {
        
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

        try {
            
            let contextInfo = '';
            if (context.contextFiles.length > 0) {
                contextInfo = `\n\nCONTEXT FILES PROVIDED:\n${context.contextFiles.map((f: any) => `- ${f.basename}: ${f.content.substring(0, 200)}...`).join('\n')}`;
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
                
                const convertedHistory = (context.chatHistory || []).map((h: any) => ({
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
                
                const convertedHistory = (context.chatHistory || []).map((h: any) => ({
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
                
                const convertedHistory = (context.chatHistory || []).map((h: any) => ({
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
                const convertedHistory = (context.chatHistory || []).map((h: any) => ({
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
                const convertedHistory = (context.chatHistory || []).map((h: any) => ({
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
        } catch (err) {
                        throw err;
        }
    }

    private async generateDetailedFileContent(initialPlan: any, context: any, autoSelectedModel: ModelSelection | null = null): Promise<any> {
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
            } catch (err) {
                                
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

    private async generateSingleFileContent(file: any, context: any): Promise<string> {
        
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
            systemPrompt += `\n\nRELEVANT CONTEXT FILES:\n${context.contextFiles.map((f: any) => `- ${f.basename}: ${f.content.substring(0, 300)}...`).join('\n')}`;
        }

        systemPrompt += `\n\nORIGINAL USER REQUEST: ${context.userPrompt}

IMPORTANT: Return ONLY the markdown content for this specific file. Do not include explanations or meta-commentary.`;

        const userPrompt = `Create detailed markdown content for "${file.name}" file.`;

        let content: string;

        if (provider === 'groq') {
            const { GroqService } = await import('../services/groqService');
            const groqService = new GroqService(apiKey);
            
            const convertedHistory = (context.chatHistory || []).map((h: any) => ({
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
            
            const convertedHistory = (context.chatHistory || []).map((h: any) => ({
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
            
            const convertedHistory = (context.chatHistory || []).map((h: any) => ({
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
            const convertedHistory = (context.chatHistory || []).map((h: any) => ({
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
            const convertedHistory = (context.chatHistory || []).map((h: any) => ({
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

            
            const modelConfig: any = { model: context.settings.model };
            if (context.webSearchEnabled && context.webSearchService) {
                modelConfig.tools = [context.webSearchService.getGoogleSearchToolConfig()];
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

    private extractAndValidateJSON(aiText: string): any {

        
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
            } catch (e) {
            }
        }

                return null;
    }

    private cleanAndParseJSON(jsonStr: string): any {
        if (!jsonStr || !jsonStr.trim()) return null;

        
        let cleaned = jsonStr.trim();

        
        cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

        
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
            cleaned = cleaned.substring(firstBrace, lastBrace + 1);
        }

        
        try {
            const parsed = JSON.parse(cleaned);

            
            if (parsed && typeof parsed === 'object' && parsed.folderName && Array.isArray(parsed.files)) {
                
                parsed.files = parsed.files.map((file: any) => ({
                    name: file.name || 'Untitled',
                    description: file.description || '',
                    content: file.content || '# New File\n\nContent not generated.',
                    extension: file.extension || 'md'
                }));

                return parsed;
            }
        } catch (e) {
            

            try {
                
                let aggressiveCleaned = cleaned;

                
                aggressiveCleaned = aggressiveCleaned.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');

                
                const parsed = JSON.parse(aggressiveCleaned);

                if (parsed && typeof parsed === 'object' && parsed.folderName && Array.isArray(parsed.files)) {
                    parsed.files = parsed.files.map((file: any) => ({
                        name: file.name || 'Untitled',
                        description: file.description || '',
                        content: file.content || '# New File\n\nContent not generated.',
                        extension: file.extension || 'md'
                    }));

                    return parsed;
                }
            } catch (secondError) {
            }
        }

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
        } catch (e) {
            return null;
        }
    }

    private createFallbackPlan(prompt: string, targetFolder?: string): any {
        
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

    private async createFilesFromPlan(plan: any): Promise<void> {
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
                    } catch (readError) {
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

    private async createCanvasFile(folderPath: string, canvasData: any): Promise<void> {
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

    private async createExcalidrawFile(folderPath: string, excalidrawData: any): Promise<void> {
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
        if ((actionState as any).fileName && (actionState as any).fileName.includes('[[') && (actionState as any).fileName.includes(']]')) {
            MarkdownRenderer.render(this.app, (actionState as any).fileName, nameEl, '', this);
        } else {
            nameEl.textContent = (actionState as any).fileName;
        }
        
        const statusEl = capsule.createDiv({ cls: 'file-action-status' });

        
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
        MarkdownRenderer.render(this.app, message, messageEl, '', this);

        
        const capsulesContainer = answerEl.createDiv({ cls: 'file-action-capsules' });

        
        for (const actionId of actionIds) {
            this.addFileActionCapsuleToContainer(actionId, capsulesContainer);
        }

        
        this.createResponseActions(responseEl, question, message);

        
        this.contentContainer.scrollTo({
            top: this.contentContainer.scrollHeight,
            behavior: 'smooth'
        });

        
        this.saveCurrentSession();
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
        if (Platform.isMobile) return;
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
                        } catch (e) {
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
        const progressInterval = setInterval(() => {
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
                        } catch (e) {
                                                    }
                    } else if (fileOrFolder instanceof TFolder) {
                        const allFiles = fileOrFolder.children.filter(c => c instanceof TFile) as TFile[];
                        for (const file of allFiles) {
                            try {
                                const content = await this.app.vault.read(file);
                                fileContents.push(`--- File: ${file.basename} ---\n${content}\n`);
                            } catch (e) {
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
                            const resourceData = await this.plugin.mcpService.readResource(serverId, uri);
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
                        } catch (error) {
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
            
            
            
            const serverGroups = new Map<string, any[]>();
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

            
            try {
                const result = await this.basicChatService.processMCPQuery(
                    query,
                    enhancedQuery,
                    mcpContext,
                    this.getChatHistory(),
                    this.updateProcessingUI.bind(this),
                    this.updateProcessingMessageAndSnippet.bind(this),
                    formattedMCPTools,
                    async (toolCall: any) => {
                        
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
                        return toolResult;
                    },
                    autoSelectedModel,
                    isAutoToolMode,
                    serverGroups,
                    enableRateLimit,
                    multimodalInputs,
                    this.currentAbortController?.signal
                );

                                
                
                if (!this.isProcessing) {
                    clearInterval(progressInterval);
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

                
                this.saveCurrentSession();
            } catch (aiError) {
                                throw aiError;
            }

        } catch (error) {
            
            clearInterval(progressInterval);
            
            const isAbortError = error instanceof DOMException && error.name === 'AbortError';
            if (!isAbortError) {
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
            
            clearInterval(progressInterval);
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

function escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * CodeCanvasModal — full-screen overlay for visualizing code execution/rendering.
 *
 * - JS/TS/HTML/CSS: split editor + interactive output (iframe with full sandbox)
 * - Mermaid/Markdown/Dataview: live preview via Obsidian's MarkdownRenderer
 * - JSON: formatted, syntax-highlighted view
 */
class CodeCanvasModal extends Modal {
    private code: string;
    private language: string;
    private onSave?: (newCode: string) => void;
    private onUpdate?: (newCode: string) => void;
    public onCloseCallback?: () => void;

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
        const isExec = isExecutable(lang);
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
            navigator.clipboard.writeText(this.code);
            setIcon(copyBtn, 'check');
            setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
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
        saveBtn.style.display = 'none';

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
                    const iframe = document.createElement('iframe');
                    iframe.className = 'code-exec-iframe code-canvas-iframe';
                    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
                    iframe.srcdoc = result.htmlContent;
                    previewArea.style.padding = '0';
                    previewArea.appendChild(iframe);
                    const onMsg = (e: MessageEvent) => {
                        if (e.data?.iframeHeight) {
                            iframe.style.height = e.data.iframeHeight + 'px';
                            window.removeEventListener('message', onMsg);
                        }
                    };
                    window.addEventListener('message', onMsg);
                } else if (result.isMarkdown && result.markdownContent) {
                    previewArea.style.padding = '';
                    await MarkdownRenderer.render(this.app, result.markdownContent, previewArea, '', new Component());
                } else if (!result.success) {
                    previewArea.createEl('pre', { cls: 'code-exec-output-text', text: `Error: ${result.error}` });
                }
                return;
            }

            const fenced = lang === 'markdown' || lang === 'md'
                ? code
                : wrapInMarkdownFence(code, lang);
            await MarkdownRenderer.render(this.app, fenced, previewArea, '', new Component());
        };

        refreshBtn.addEventListener('click', render);

        let debounceTimer: ReturnType<typeof setTimeout>;
        codeArea.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(render, 600);
            saveBtn.style.display = codeArea.value !== this.code ? '' : 'none';
            if (this.onUpdate) this.onUpdate(codeArea.value);
        });

        saveBtn.addEventListener('click', () => {
            const newCode = codeArea.value;
            if (this.onSave) this.onSave(newCode);
            this.code = newCode;
            saveBtn.style.display = 'none';
            setIcon(saveIcon, 'check');
            setTimeout(() => setIcon(saveIcon, 'save'), 1500);
        });

        render();
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
        saveBtn.style.display = 'none';

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
                const iframe = document.createElement('iframe');
                iframe.className = 'code-exec-iframe code-canvas-iframe';
                iframe.setAttribute('sandbox',
                    'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-modals allow-popups'
                );
                iframe.srcdoc = result.htmlContent;
                outputArea.appendChild(iframe);
                const onMsg = (e: MessageEvent) => {
                    if (e.data?.iframeHeight && iframe.isConnected) {
                        iframe.style.height = e.data.iframeHeight + 'px';
                        window.removeEventListener('message', onMsg);
                    }
                };
                window.addEventListener('message', onMsg);
            } else if (result.isMarkdown && result.markdownContent) {
                outputArea.classList.add('code-canvas-render-area');
                await MarkdownRenderer.render(this.app, result.markdownContent, outputArea, '', new Component());
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

        runBtn.addEventListener('click', run);

        codeArea.addEventListener('input', () => {
            saveBtn.style.display = codeArea.value !== this.code ? '' : 'none';
            if (this.onUpdate) this.onUpdate(codeArea.value);
        });

        saveBtn.addEventListener('click', () => {
            const newCode = codeArea.value;
            if (this.onSave) this.onSave(newCode);
            this.code = newCode;
            saveBtn.style.display = 'none';
            setIcon(saveIcon, 'check');
            setTimeout(() => setIcon(saveIcon, 'save'), 1500);
        });

        
        if (lang === 'html' || lang === 'css' || lang === 'svg') {
            run();
            let debounceTimer: ReturnType<typeof setTimeout>;
            codeArea.addEventListener('input', () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(run, 800);
            });
        }
    }

    onClose() {
        if (this.onCloseCallback) this.onCloseCallback();
        this.contentEl.empty();
    }
}
