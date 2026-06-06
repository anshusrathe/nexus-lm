import { ItemView, WorkspaceLeaf, TFile, ButtonComponent, Notice, MarkdownRenderer, Component, Modal, Setting, setIcon, normalizePath, Platform } from 'obsidian';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AISettings, Provider, getModelsGroupedByProvider, getModelDisplayName, getProviderForModel } from '../settings';
import { DirectorySuggester } from '../utils/directorySuggester';
import { NotebookManager, Notebook } from '../managers/notebookManager'; 
import { NotebookFormModal } from '../modals/notebookModals'; 
import { VIEW_TYPE_NOTEBOOK_CHAT } from './notebookChatView';
import { TokenEstimator } from '../utils/tokenEstimator'; 
import AIPlugin from '../main'; 


import { QnAManager, QASettingsModal as QnASettingsModal, Question as QnAQuestion, QASettings as QnASettings } from '../tools/createQnA';
import { MCQManager, MCQSettingsModal as MCQModal, MCQ as MCQItem, MCQSettings as MCQSett } from '../tools/createMCQs';
import { ConceptMapManager, ConceptMapModal, SavedConceptMap } from '../tools/createConceptMaps';
import { SlideManager, SlideshowSettingsModal, SavedSlideshow, SlideshowVoiceSettingsModal } from '../tools/createSlides';
import { MultimodalInput, processFileForMultimodal, isMultimodalSupported, getFileIcon, isTextFile } from '../utils/multimodalUtils';

interface OpenAIErrorResponse {
  error: {
    message: string;
  };
}

interface Question {
  text: string;
  answer?: string;
  feedback?: string;
  relevanceScore?: number;
}

interface MCQOption {
  text: string;
  isCorrect: boolean;
}

interface MCQ {
  question: string;
  options: MCQOption[];
  selectedOption?: number;
}

interface MCQResult {
  correctAttempts: number;
  incorrectAttempts: number;
  marks: number;
  accuracy: number;
}

interface MindmapNode {
  content: string;
  children?: MindmapNode[];
}

interface QASettings {
  numQuestions: number;
  filename: string;
  saveDirectory: string;
  customPrompt: string;
}

interface MCQSettings {
  numMCQs: number;
  filename: string;
  saveDirectory: string;
  customPrompt: string;
  correctMarks: number;
  incorrectMarks: number;
}

export class NoteSuggester {
  private input!: HTMLInputElement;
  private suggestions!: HTMLDivElement;
  private files: TFile[];
  private suggestionsVisible: boolean = false;
  private selectedPaths: string[] = [];
  private onSelect: (paths: string[]) => void;
  private selectedNotesContainer!: HTMLElement;

  private multimodalEnabled: boolean = false;

  constructor(
    private app: any,
    private container: HTMLElement,
    onSelect: (paths: string[]) => void,
    multimodalEnabled: boolean = false
  ) {
    this.multimodalEnabled = multimodalEnabled;
    this.files = this.getAvailableFiles();
    this.onSelect = onSelect;
    this.setupInputField();
  }

  private getAvailableFiles(): TFile[] {
    if (this.multimodalEnabled) {
      
      return this.app.vault.getFiles().filter((file: TFile) => 
        file.extension === 'md' || isMultimodalSupported(file.name)
      );
    }
    return this.app.vault.getMarkdownFiles();
  }

  public setMultimodalEnabled(enabled: boolean) {
    this.multimodalEnabled = enabled;
    this.files = this.getAvailableFiles();
  }

  private setupInputField() {
    const inputContainer = this.container.createDiv({ cls: 'note-input-container' });
    this.input = inputContainer.createEl('input', {
      type: 'text',
      placeholder: 'Type to search notes...'
    });
    this.suggestions = inputContainer.createDiv({ cls: 'note-suggestions' });
    this.suggestions.hide();

    
    this.selectedNotesContainer = this.container.createDiv({ cls: 'selected-notes-container' });

    this.input.addEventListener('input', () => this.onInputChange());
    this.input.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.input.addEventListener('blur', () => {
      
      setTimeout(() => this.suggestions.hide(), 100);
    });
    this.input.addEventListener('focus', () => {
      
      if (this.input.value.trim()) {
        this.onInputChange();
      }
    });
    this.updateInputDisplay();
  }

  private onInputChange() {
    const value = this.input.value;
    
    
    if (value.includes('[[')) {
      const searchText = value.split('[[').pop() || '';
      this.showSuggestions(searchText);
      return;
    }
    
    
    
    const parts = value.split(',');
    const currentSearch = parts[parts.length - 1].trim();
    
    if (currentSearch.length > 0) {
      this.showSuggestions(currentSearch);
    } else if (value.trim().length === 0) {
      
      this.showSuggestions('');
    } else {
      this.suggestions.hide();
      this.suggestionsVisible = false;
    }
  }

  private showSuggestions(searchText: string) {
    this.suggestions.empty();
    this.suggestionsVisible = true;

    const matchedFiles = this.files.filter(file => 
      file.basename.toLowerCase().includes(searchText.toLowerCase()) ||
      file.name.toLowerCase().includes(searchText.toLowerCase())
    );

    matchedFiles.forEach(file => {
      const suggestion = this.suggestions.createDiv({ cls: 'note-suggestion' });
      suggestion.setText(file.basename);
      
      if (this.selectedPaths.includes(file.path)) {
        suggestion.addClass('selected');
      }

      suggestion.addEventListener('mousedown', (e) => {
        e.preventDefault();
      });

      suggestion.onClickEvent(() => {
        this.toggleNote(file);
        this.suggestions.hide();
        this.suggestionsVisible = false;
      });
    });

    if (matchedFiles.length > 0) {
      this.suggestions.show();
    } else {
      this.suggestions.hide();
    }
  }

  toggleNote(file: TFile) {
    const idx = this.selectedPaths.indexOf(file.path);
    if (idx !== -1) {
      this.selectedPaths.splice(idx, 1);
    } else {
      this.selectedPaths.push(file.path);
    }
    
    this.updateInputDisplay();
    this.onSelect(this.selectedPaths);
  }

  private onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      this.suggestions.hide();
      this.suggestionsVisible = false;
    } else if (event.key === 'Enter' && this.suggestionsVisible) {
      
      event.preventDefault();
      const firstSuggestion = this.suggestions.querySelector('.note-suggestion');
      if (firstSuggestion) {
        const noteName = firstSuggestion.textContent;
        const matchedFile = this.files.find(f => f.basename === noteName);
        if (matchedFile) {
          this.toggleNote(matchedFile);
          this.suggestions.hide();
          this.suggestionsVisible = false;
        }
      }
    }
  }

  clear() {
    this.selectedPaths = [];
    this.input.value = '';
  }

  
  setInitialSelectedPaths(paths: string[]) {
    this.selectedPaths = [...paths];
    this.updateInputDisplay();
  }

  
  public updateInputDisplay() {
    
    if (!this.selectedNotesContainer) return;
    this.selectedNotesContainer.empty();
    this.selectedPaths.forEach(path => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file && file instanceof TFile) {
        const noteChip = this.selectedNotesContainer.createDiv({ cls: 'note-chip' });
        noteChip.createSpan({ text: file.basename, cls: 'note-chip-text' });
        const removeBtn = new ButtonComponent(noteChip)
          .setClass('note-chip-remove')
          .setIcon('x')
          .setTooltip('Remove')
          .onClick(() => {
            this.toggleNote(file);
          });
      }
    });
    this.onSelect(this.selectedPaths); 
    
    this.input.value = '';
  }

  public updatePlaceholder() {
    if (this.input) {
      this.input.placeholder = 'Type to search notes...';
    }
  }
}


export class FolderSuggester {
  private input!: HTMLInputElement;
  private suggestions!: HTMLDivElement;
  private folders: string[];
  private suggestionsVisible: boolean = false;
  private selectedFolders: string[] = [];
  private onSelect: (folders: string[]) => void;
  private selectedFoldersContainer!: HTMLElement;

  constructor(
    private app: any,
    private container: HTMLElement,
    onSelect: (folders: string[]) => void
  ) {
    this.folders = this.getAvailableFolders();
    this.onSelect = onSelect;
    this.setupInputField();
  }

  private getAvailableFolders(): string[] {
    const allFolders = this.app.vault.getAllLoadedFiles()
      .filter((f: any) => f.children !== undefined) 
      .map((f: any) => f.path)
      .filter((path: string) => path !== '' && !path.startsWith('.'));
    return allFolders;
  }

  private setupInputField() {
    const inputContainer = this.container.createDiv({ cls: 'folder-input-container' });
    this.input = inputContainer.createEl('input', {
      type: 'text',
      placeholder: 'Type to search folders...'
    });
    this.suggestions = inputContainer.createDiv({ cls: 'folder-suggestions' });
    this.suggestions.hide();

    
    this.selectedFoldersContainer = this.container.createDiv({ cls: 'selected-folders-container' });

    this.input.addEventListener('input', () => this.onInputChange());
    this.input.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.input.addEventListener('blur', () => {
      setTimeout(() => this.suggestions.hide(), 100);
    });
    this.input.addEventListener('focus', () => {
      if (this.input.value.trim()) {
        this.onInputChange();
      }
    });
    
  }

  private onInputChange() {
    const value = this.input.value.trim();
    
    if (value.length > 0) {
      this.showSuggestions(value);
    } else {
      this.showSuggestions('');
    }
  }

  private showSuggestions(searchText: string) {
    this.suggestions.empty();
    this.suggestionsVisible = true;

    const matchedFolders = this.folders.filter(folder => 
      folder.toLowerCase().includes(searchText.toLowerCase())
    );

    matchedFolders.forEach(folder => {
      const suggestion = this.suggestions.createDiv({ cls: 'folder-suggestion' });
      suggestion.setText(folder);
      
      if (this.selectedFolders.includes(folder)) {
        suggestion.addClass('selected');
      }

      suggestion.addEventListener('mousedown', (e) => {
        e.preventDefault();
      });

      suggestion.onClickEvent(() => {
        this.toggleFolder(folder);
        this.suggestions.hide();
        this.suggestionsVisible = false;
      });
    });

    if (matchedFolders.length > 0) {
      this.suggestions.show();
    } else {
      this.suggestions.hide();
    }
  }

  toggleFolder(folder: string) {
    const idx = this.selectedFolders.indexOf(folder);
    if (idx !== -1) {
      this.selectedFolders.splice(idx, 1);
    } else {
      this.selectedFolders.push(folder);
    }
    this.updateInputDisplay();
    this.onSelect(this.selectedFolders);
  }

  private onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      this.suggestions.hide();
      this.suggestionsVisible = false;
    } else if (event.key === 'Enter' && this.suggestionsVisible) {
      event.preventDefault();
      const firstSuggestion = this.suggestions.querySelector('.folder-suggestion');
      if (firstSuggestion) {
        const folderPath = firstSuggestion.textContent;
        if (folderPath) {
          this.toggleFolder(folderPath);
          this.suggestions.hide();
          this.suggestionsVisible = false;
        }
      }
    }
  }

  clear() {
    this.selectedFolders = [];
    this.input.value = '';
  }

  setInitialSelectedFolders(folders: string[]) {
    this.selectedFolders = [...folders];
    this.updateInputDisplay();
  }

  public updateInputDisplay() {
    if (!this.selectedFoldersContainer) return;
    this.selectedFoldersContainer.empty();
    this.selectedFolders.forEach(folder => {
      const folderChip = this.selectedFoldersContainer.createDiv({ cls: 'folder-chip' });
      folderChip.createSpan({ text: folder, cls: 'folder-chip-text' });
      const removeBtn = new ButtonComponent(folderChip)
        .setClass('folder-chip-remove')
        .setIcon('x')
        .setTooltip('Remove')
        .onClick(() => {
          this.toggleFolder(folder);
        });
    });
    this.onSelect(this.selectedFolders);
    this.input.value = '';
  }
}

export const VIEW_TYPE_NEXUS_TUTOR = 'NEXUS_TUTOR_VIEW';

export class AITutorView extends ItemView {
  private container: HTMLElement;
  private settings: AISettings;
  private plugin: AIPlugin;
  private noteSuggester!: NoteSuggester;
  private state: {
    questions: Question[];
    mcqs: MCQ[];
    mcqResult?: MCQResult;
    selectedFiles: Set<string>;
    qaSessionSettings?: QASettings;
    mcqSessionSettings?: MCQSettings;
    savedConceptMaps: SavedConceptMap[];
    savedSlideshows: SavedSlideshow[];
  } = { questions: [], mcqs: [], selectedFiles: new Set(), savedConceptMaps: [], savedSlideshows: [] };

  
  private contextBarContainer!: HTMLElement;
  private contextProgressBar!: HTMLElement;
  private contextLabel!: HTMLElement;

  
  private startConceptMapButton!: ButtonComponent;

  
  private manualResearchSection?: HTMLElement;
  private urlInputsContainer?: HTMLElement;
  private addUrlButton?: ButtonComponent;
  private directorySuggester?: DirectorySuggester;
  private selectedDirectory: string = '';

  private notebookManager: NotebookManager;

  
  private qaManager: QnAManager;
  private mcqManager: MCQManager;
  private conceptMapManager: ConceptMapManager;
  private slideManager: SlideManager;

  private timerInterval?: number;
  private timerEndTime?: number;
  private timerContainer?: HTMLElement;
  private timerActive: boolean = false;
  private timerType: 'mcq' | 'qna' | null = null;
  private timerNoticeShown: boolean = false;

  private _mcqTestSubmitted: boolean = false;
  private _mcqSubmitBtn?: ButtonComponent;
  private _mcqProgressDialog?: HTMLElement;
  private _mcqEvaluationInProgress: boolean = false;

  constructor(leaf: WorkspaceLeaf, settings: AISettings, plugin: AIPlugin) {
    super(leaf);
    this.settings = settings;
    this.plugin = plugin;
    this.container = this.contentEl.createDiv();
    this.notebookManager = new NotebookManager(this.app);
    
    
    this.qaManager = new QnAManager(this.app, this.settings);
    this.mcqManager = new MCQManager(this.app, this.settings);
    this.conceptMapManager = new ConceptMapManager(this.app, this.settings);
    this.slideManager = new SlideManager(this.app, this.settings);
    
    
    this.loadSavedConceptMaps();
    this.loadSavedSlideshows();
  }

  getViewType() { return VIEW_TYPE_NEXUS_TUTOR; }
  getDisplayText() { return 'Nexus Tutor'; }
  getIcon(): string {
    return 'graduation-cap';
  }

  private validateSettings(): boolean {
    const provider = this.settings.aiTutorProvider || this.settings.provider;
    let apiKey: string;
    if (provider === 'groq') {
      apiKey = this.settings.groqApiKey;
    } else if (provider === 'openrouter') {
      apiKey = this.settings.openRouterApiKey;
    } else if (provider === 'ollama') {
      if (this.settings.ollamaMode === 'cloud' && !this.settings.ollamaApiKey) {
        new Notice('Please set your Ollama API key in settings for cloud mode');
        return false;
      }
      return true;
    } else if (provider === 'nvidia') {
      apiKey = this.settings.nvidiaApiKey;
    } else if (provider === 'opencode') {
      apiKey = this.settings.openCodeApiKey;
    } else if (this.settings.customProviders?.some((p: any) => p.id === provider)) {
      const cp = this.settings.customProviders.find((p: any) => p.id === provider);
      apiKey = cp?.apiKey || '';
    } else {
      apiKey = this.settings.geminiApiKey || this.settings.apiKey;
    }

    if (!apiKey) {
      new Notice('Please set your API key in settings');
      return false;
    }
    if (provider === 'gemini' && apiKey.length < 20) {
      new Notice('Invalid Gemini API key format');
      return false;
    }
    return true;
  }

  async onOpen() {
    await this.notebookManager.loadNotebooks();
    this.renderInitial();
  }

  renderInitial() {
    this.container.empty();
    
    const mainContainer = this.container.createDiv({ cls: 'notes-selection' });
    mainContainer.createEl('h3', { text: 'Select Notes to Study' });
    
    
    const modelContainer = mainContainer.createDiv({ cls: 'model-container' });
    new ButtonComponent(modelContainer)
      .setButtonText(getModelDisplayName(this.settings.aiTutorModel || this.settings.model, this.settings))
      .setClass('model-select-btn')
      .onClick(() => this.showModelMenu());
    
    
    this.contextBarContainer = mainContainer.createDiv({ cls: 'context-bar-container tutor-context-bar' });
    this.contextProgressBar = this.contextBarContainer.createDiv({ cls: 'context-progress-bar' });
    this.contextLabel = this.contextBarContainer.createDiv({ cls: 'context-label' });
    
    this.noteSuggester = new NoteSuggester(
      this.app,
      mainContainer,
      (selectedPaths) => {
        
        this.state.selectedFiles = new Set(selectedPaths);

        const startQAButton = this.container.querySelector('.start-qa-button') as HTMLElement;
        const startMCQButton = this.container.querySelector('.start-mcq-button') as HTMLElement;
        const startConceptMapButton = this.container.querySelector('.start-conceptmap-button') as HTMLElement;
        const startSlidesButton = this.container.querySelector('.start-slides-button') as HTMLElement;
        
        if (startQAButton) {
          startQAButton.style.display = selectedPaths.length > 0 ? 'grid' : 'none';
        }
        if (startMCQButton) {
          startMCQButton.style.display = selectedPaths.length > 0 ? 'grid' : 'none';
        }
        if (startConceptMapButton) {
          startConceptMapButton.style.display = selectedPaths.length > 0 ? 'grid' : 'none';
        }
        if (startSlidesButton) {
          startSlidesButton.style.display = selectedPaths.length > 0 ? 'grid' : 'none';
        }
        
        
        this.updateContextBar();
      },
      false 
    );

    const buttonContainer = this.container.createDiv({ cls: 'button-container' });
    
    
    const spinnerContainer = buttonContainer.createDiv({ cls: 'spinner-container' });
    const loadingSpinner = spinnerContainer.createDiv({ cls: 'loading-spinner' });

    
    const startQAButton = new ButtonComponent(buttonContainer)
      .setIcon('message-circle-question-mark')
      .setTooltip('Start Q&A Session')
      .onClick(async () => {
        if (this.noteSuggester && this.validateSettings()) {
          const selectedPaths = this.noteSuggester['selectedPaths'];
          if (selectedPaths.length === 0) {
            new Notice('Please select at least one note');
            return;
          }
          
          new QASettingsModal(this.app, this.settings, new Set(selectedPaths), async (settings) => {
            await this.generateQuestions(selectedPaths, settings);
          }).open();
        }
      });
    
    startQAButton.buttonEl.addClass('start-qa-button');
    startQAButton.buttonEl.style.display = 'none';

    
    const startMCQButton = new ButtonComponent(buttonContainer)
      .setIcon('list-checks')
      .setTooltip('Start MCQs')
      .onClick(async () => {
        if (this.noteSuggester && this.validateSettings()) {
          const selectedPaths = [...this.noteSuggester['selectedPaths']];
          if (selectedPaths.length === 0) {
            new Notice('Please select at least one note');
            return;
          }
          
          new MCQSettingsModal(this.app, this.settings, new Set(selectedPaths), async (settings) => {
            await this.generateMCQs(selectedPaths, settings);
          }).open();
        }
      });
    
    startMCQButton.buttonEl.addClass('start-mcq-button');
    startMCQButton.buttonEl.style.display = 'none';

    
    if (!Platform.isMobile) {
      this.startConceptMapButton = new ButtonComponent(buttonContainer)
        .setIcon('network')
        .setTooltip('Create Concept Map')
        .onClick(async () => {
          if (this.noteSuggester && this.validateSettings()) {
            const selectedPaths = [...this.noteSuggester['selectedPaths']];
            if (selectedPaths.length === 0) {
              new Notice('Please select at least one note');
              return;
            }
            
            new ConceptMapModal(this.app, async (name) => {
              await this.generateConceptMap(selectedPaths, name);
            }).open();
          }
        });
      
      this.startConceptMapButton.buttonEl.addClass('start-conceptmap-button');
      this.startConceptMapButton.buttonEl.style.display = 'none';
    }

    
    let startSlidesButton: ButtonComponent | null = null;
    if (!Platform.isMobile) {
      startSlidesButton = new ButtonComponent(buttonContainer)
        .setIcon('presentation')
        .setTooltip('Create Slides')
        .onClick(async () => {
          if (this.noteSuggester && this.validateSettings()) {
            const selectedPaths = [...this.noteSuggester['selectedPaths']];
            if (selectedPaths.length === 0) {
              new Notice('Please select at least one note');
              return;
            }
            
            new SlideshowSettingsModal(this.app, this.settings, new Set(selectedPaths), async (settings) => {
              await this.generateSlideshow(selectedPaths, settings);
            }).open();
          }
        });
      
      startSlidesButton.buttonEl.addClass('start-slides-button');
      startSlidesButton.buttonEl.style.display = 'none';
    }

    
    const notebooksSection = this.container.createDiv({ cls: 'notebooks-section' });

    
    const notebooksHeader = notebooksSection.createDiv({ cls: 'notebooks-header' });
    notebooksHeader.createEl('h3', { text: 'Your Notebooks' });
    new ButtonComponent(notebooksHeader)
      .setButtonText('')
      .setIcon('plus-circle')
      .setClass('add-notebook-button')
      .onClick(() => this.handleCreateNewNotebook());

    const notebooksListContainer = notebooksSection.createDiv({ cls: 'notebooks-list-container' });
    this.renderNotebooks(notebooksListContainer);

    
    if (!Platform.isMobile) {
      const savedVisualsSection = this.container.createDiv({ cls: 'saved-visuals-section' });
      const savedVisualsHeader = savedVisualsSection.createDiv({ cls: 'saved-visuals-header' });
      savedVisualsHeader.createEl('h3', { text: 'Saved Visuals' });
      
      
      const searchContainer = savedVisualsHeader.createDiv({ cls: 'visuals-search-container' });
      const searchInput = searchContainer.createEl('input', {
        type: 'text',
        placeholder: 'Search visuals...',
        cls: 'visuals-search-input'
      });
      
      const savedVisualsContainer = savedVisualsSection.createDiv({ cls: 'saved-visuals-container' });
      this.renderSavedVisuals(savedVisualsContainer);
      
      
      searchInput.addEventListener('input', () => {
        const query = searchInput.value.toLowerCase().trim();
        this.renderSavedVisuals(savedVisualsContainer, query);
      });
    }
    
    
    this.updateContextBar();
  }

  private renderNotebooks(container: HTMLElement) {
    container.empty();
    const notebooks = this.notebookManager.getNotebooks();

    if (notebooks.length === 0) {
      container.createEl('p', { text: 'No notebooks created yet.', cls: 'no-notebooks-message' });
      return;
    }

    notebooks.forEach(notebook => {
      const card = container.createDiv({ cls: 'notebook-card' });
      
      
      const nameContainer = card.createDiv({ cls: 'notebook-name-container' });
      nameContainer.createEl('span', { text: notebook.name, cls: 'notebook-name' });

      
      card.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.notebook-action-button')) return;
        this.handleLoadNotebook(notebook);
      });

      const actions = card.createDiv({ cls: 'notebook-actions' });

      
      new ButtonComponent(actions)
        .setIcon('edit')
        .setTooltip('Edit Notebook')
        .setClass('notebook-action-button')
        .onClick(() => this.handleEditNotebook(notebook));

      
      new ButtonComponent(actions)
        .setIcon('trash')
        .setTooltip('Delete Notebook')
        .setClass('notebook-action-button')
        .onClick(() => this.handleDeleteNotebook(notebook.id));
    });
  }

  private async invalidateNotebookCache(notebookId: string) {
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      if (leaf.view && leaf.view.getViewType && leaf.view.getViewType() === VIEW_TYPE_NOTEBOOK_CHAT) {
        const view: any = leaf.view;
        if (view.notebook && view.notebook.id === notebookId && typeof view.externalInvalidateContextCache === 'function') {
          view.externalInvalidateContextCache();
        }
      }
    });
  }

  private handleCreateNewNotebook() {
    new NotebookFormModal(this.app, this.plugin, null, (settings) => {
      const notebook = this.notebookManager.addNotebook(settings.name, Array.from(settings.sourcePaths), settings.customInstruction, settings.webSources, settings.inlineCitation, settings.mode, settings.sourceFolders, settings.feedSources);
      this.invalidateNotebookCache(notebook.id);
      this.renderInitial();
    }).open();
  }

  private async handleEditNotebook(notebook: Notebook) {
    
    const notebooks = this.notebookManager.getNotebooks();
    const latestNotebook = notebooks.find(nb => nb.id === notebook.id);
    
    if (!latestNotebook) {
      new Notice('Notebook not found.');
      return;
    }
    
    new NotebookFormModal(this.app, this.plugin, latestNotebook, async (settings) => {
      await this.notebookManager.updateNotebook(latestNotebook.id, settings.name, Array.from(settings.sourcePaths), settings.customInstruction, settings.webSources, settings.inlineCitation, settings.mode, settings.sourceFolders, settings.feedSources);
      
      await this.notebookManager.loadNotebooks();
      this.invalidateNotebookCache(latestNotebook.id);
      this.renderInitial();
    }).open();
  }

  private handleDeleteNotebook(notebookId: string) {
    if (confirm('Are you sure you want to delete this notebook?')) {
      
      (document.activeElement as HTMLElement)?.blur();
      this.notebookManager.deleteNotebook(notebookId);
      this.invalidateNotebookCache(notebookId);
      this.renderInitial();
    }
  }

  private handleLoadNotebook(notebook: Notebook) {
    
    const notebooks = this.notebookManager.getNotebooks();
    const latestNotebook = notebooks.find(nb => nb.id === notebook.id);
    
    if (!latestNotebook) {
      new Notice('Notebook not found.');
      return;
    }
    
    const sourceCount = (latestNotebook.sourcePaths?.length || 0) + (latestNotebook.sourceFolders?.length || 0);
    
    
    const existingLeaf = this.findLeafWithNotebook(latestNotebook.id);
    if (existingLeaf) {
      this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
      new Notice(`Notebook "${latestNotebook.name}" is already open in another tab.`);
      return;
    }

    new Notice(`Loading notebook: ${latestNotebook.name} with ${sourceCount} source(s).`);
    this.app.workspace.getLeaf(true).setViewState({
      type: VIEW_TYPE_NOTEBOOK_CHAT,
      active: true,
      state: { notebook: latestNotebook },
    });
  }

  /**
   * Find if a notebook is already open in another tab
   */
  private findLeafWithNotebook(notebookId: string): WorkspaceLeaf | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTEBOOK_CHAT);
    for (const leaf of leaves) {
      const viewState = leaf.getViewState();
      const notebook = (viewState.state as any)?.notebook;
      if (notebook?.id === notebookId) {
        return leaf;
      }
    }
    return null;
  }

  private async showModelMenu() {
    const menu = this.containerEl.querySelector('.model-select-menu');
    if (menu) {
      menu.remove();
      return;
    }

    const modelBtn = this.containerEl.querySelector('.model-select-btn') as HTMLElement;
    if (!modelBtn) return;

    const menuEl = this.containerEl.createDiv({ cls: 'model-select-menu' });
    
    
    const searchContainer = menuEl.createDiv({ 
      cls: 'model-search-container',
      attr: { style: 'position: sticky; top: 0; background: var(--background-primary); z-index: 2; padding: 8px; border-bottom: 1px solid var(--background-modifier-border);' }
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

    
    const modelGroups = getModelsGroupedByProvider(this.settings);

    
    modelGroups.forEach((group, groupIndex) => {
      
      const headerEl = menuEl.createDiv({ cls: 'model-select-menu-header' });
      headerEl.textContent = group.label;

      const groupItems: HTMLElement[] = [];
      const headerObj = { headerEl, items: groupItems, separatorEl: undefined as HTMLElement | undefined };
      headersToFilter.push(headerObj);

      
      group.models.forEach(model => {
        const option = menuEl.createDiv({ cls: 'model-select-menu-item' });
        groupItems.push(option);
        itemsToFilter.push({ itemEl: option, name: model.name.toLowerCase() });

        if ((this.settings.aiTutorModel || this.settings.model) === model.id) {
          option.classList.add('selected');
        }
        option.textContent = model.name;
        option.addEventListener('click', async () => {
          
          this.settings.aiTutorModel = model.id;
          this.settings.aiTutorProvider = model.provider;
          
          this.settings.model = model.id;
          this.settings.provider = model.provider;
          if (modelBtn) modelBtn.textContent = model.name;
          menuEl.remove();
          await this.plugin.saveSettings();
          
          
          this.updateContextBar();
        });
      });

      
      if (groupIndex < modelGroups.length - 1) {
        const separator = menuEl.createDiv({ cls: 'model-select-menu-separator' });
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
    
    
    menuEl.style.right = `${containerRect.right - btnRect.right}px`;
    menuEl.style.top = `${btnRect.bottom - containerRect.top + 5}px`;
    
    
    const closeHandler = (e: MouseEvent) => {
      if (!menuEl.contains(e.target as Node) && 
          !(e.target as Element).closest('.model-select-btn')) {
        menuEl.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
  }

  private async updateContextBar() {
    if (!this.contextBarContainer) return;

    
    
    let maxTokens = 0;
    
    
    const modelId = this.settings.aiTutorModel || this.settings.model;
    const provider = getProviderForModel(modelId, this.settings);
    const customModel = this.settings.customModels.find(m => 
      m.id === modelId && 
      m.provider === provider
    );
    if (customModel && customModel.tokenLimit && customModel.tokenLimit > 0) {
      maxTokens = customModel.tokenLimit;
    } else {
      
      const provider = getProviderForModel(this.settings.aiTutorModel || this.settings.model, this.settings);
      if (provider === 'groq') {
        maxTokens = 1000000; 
      } else {
        maxTokens = 1000000; 
      }
    }

    this.contextBarContainer.style.display = 'flex';

    let currentTokens = 0;
    const tokenEstimator = new TokenEstimator();

    
    const selectedPaths = Array.from(this.state.selectedFiles);
    for (const path of selectedPaths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        try {
          const content = await this.app.vault.read(file);
          currentTokens += tokenEstimator['countTokens'](content);
        } catch (e) {
                  }
      }
    }

    const percentage = Math.min(100, (currentTokens / maxTokens) * 100);

    
    this.contextProgressBar.style.transition = 'width 0.3s ease-out';
    this.contextProgressBar.style.width = `${percentage}%`;
    
    
    this.contextLabel.setText(`${currentTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${percentage.toFixed(1)}%)`);

    
    this.contextProgressBar.removeClass('low-usage', 'medium-usage', 'high-usage', 'over-usage');
    if (percentage < 50) {
      this.contextProgressBar.addClass('low-usage');
    } else if (percentage < 80) {
      this.contextProgressBar.addClass('medium-usage');
    } else if (percentage <= 100) {
      this.contextProgressBar.addClass('high-usage');
    } else {
      this.contextProgressBar.addClass('over-usage'); 
    }
    
    
    if (percentage >= 80) {
      new Notice('⚠️ Token usage is at or above 80% of the model\'s TPM limit. This may fail due to rate limit errors. Please consider switching to a model with a higher TPM limit or reducing the number of sources.', 8000);
    }
  }

  
  async generateQuestions(notePaths: string[], qaSettings: QASettings) {
    try {
      
      this.state.qaSessionSettings = qaSettings;

      
      const selectedNotesContainer = this.noteSuggester?.['selectedNotesContainer'] as HTMLElement;
      
      
      const startButtons = this.container.querySelectorAll('.start-qa-button, .start-mcq-button, .start-conceptmap-button') as NodeListOf<HTMLElement>;
      startButtons.forEach(btn => btn.style.pointerEvents = 'none');

      
      const progressContainer = document.createElement('div');
      progressContainer.className = 'qna-inline-progress';
      
      const progressHeader = progressContainer.createDiv({ cls: 'inline-progress-header' });
      const iconEl = progressHeader.createSpan({ cls: 'progress-icon' });
      setIcon(iconEl, 'message-circle-question-mark');
      progressHeader.createSpan({ text: ' Generating Questions: ' });
      progressHeader.createEl('strong', { text: qaSettings.filename });
      
      const progressBarContainer = progressContainer.createDiv({ cls: 'inline-progress-bar-container' });
      const progressBar = progressBarContainer.createDiv({ cls: 'inline-progress-bar' });
      const progressFill = progressBar.createDiv({ cls: 'inline-progress-fill' });
      
      const progressText = progressContainer.createDiv({ cls: 'inline-progress-text' });
      progressText.textContent = 'Initializing...';
      
      const progressPercentage = progressContainer.createDiv({ cls: 'inline-progress-percentage' });
      progressPercentage.textContent = '0%';

      
      if (selectedNotesContainer && selectedNotesContainer.parentElement) {
        selectedNotesContainer.parentElement.insertBefore(progressContainer, selectedNotesContainer.nextSibling);
      } else {
        
        const mainContainer = this.container.querySelector('.notes-selection') as HTMLElement;
        if (mainContainer) {
          mainContainer.appendChild(progressContainer);
        }
      }

      const questions = await this.qaManager.generateQuestions(
        notePaths, 
        qaSettings,
        (percentage, status) => {
          progressFill.style.width = `${percentage}%`;
          progressText.textContent = status;
          progressPercentage.textContent = `${percentage}%`;
        }
      );
      this.state.questions = questions;

      
      progressContainer.remove();
      startButtons.forEach(btn => btn.style.pointerEvents = '');

      this.renderQA();
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Error: ${errorMessage}`);
      
      
      const startButtons = this.container.querySelectorAll('.start-qa-button, .start-mcq-button, .start-conceptmap-button') as NodeListOf<HTMLElement>;
      startButtons.forEach(btn => btn.style.pointerEvents = '');
      
      
      const progressContainer = this.container.querySelector('.qna-inline-progress');
      if (progressContainer) {
        progressContainer.remove();
      }
    }
  }

  renderQA() {
    this.container.empty();
    this.renderTimer('qna');
    
    this.state.questions.forEach((q, i) => {
      const questionContainer = this.container.createDiv({ cls: 'question-container' });
      
      
      const questionEl = questionContainer.createDiv();
      this.renderMarkdown(`**Q${i + 1}:** ${q.text}`, questionEl);

      
      const answerSection = questionContainer.createDiv({ cls: 'answer-section' });
      const answer = answerSection.createEl('textarea');
      answer.rows = 3;
      answer.style.width = '100%';
      answer.style.marginBottom = '10px';
      answer.value = q.answer || '';
      
      answer.disabled = this.timerActive && this.timerType === 'qna' && !this.timerEndTime;
      if (answer.disabled) {
        answer.addEventListener('mousedown', (e) => {
          new Notice('session time over!');
          e.preventDefault();
        });
        answer.addEventListener('focus', (e) => {
          new Notice('session time over!');
          e.preventDefault();
        });
        answer.addEventListener('keydown', (e) => {
          new Notice('session time over!');
          e.preventDefault();
        });
      }
      answer.addEventListener('change', () => {
        this.state.questions[i].answer = answer.value;
      });

      
      new ButtonComponent(answerSection)
        .setButtonText('Evaluate Answer')
        .onClick(() => this.evaluateAnswer(i));

      
      if (q.feedback) {
        const feedbackSection = questionContainer.createDiv({ cls: 'feedback-section' });
        this.renderMarkdown(q.feedback, feedbackSection);
      }
    });

    
    const controlsSection = this.container.createDiv({ cls: 'controls-section' });
    
    new ButtonComponent(controlsSection)
      .setButtonText('Save Session')
      .onClick(() => this.saveResults());

    new ButtonComponent(controlsSection)
      .setButtonText('Start New Session')
      .onClick(() => {
        
        (document.activeElement as HTMLElement)?.blur();
        this.renderInitial();
      });
  }

  async evaluateAnswer(questionIndex: number) {
    const question = this.state.questions[questionIndex];
    if (!question.answer) {
      new Notice('Please provide an answer first');
          return;
        }

    const questionContainer = this.container.querySelectorAll('.question-container')[questionIndex];
    const existingFeedback = questionContainer.querySelector('.feedback-section');
    if (existingFeedback) {
      existingFeedback.remove();
    }

    const feedbackSection = questionContainer.createDiv({ cls: 'feedback-section' });
    const analyzingText = feedbackSection.createEl('p', { text: 'Analyzing...' });

    try {
      const { feedback, relevanceScore } = await this.qaManager.evaluateAnswer(question);

      
      analyzingText.remove();

      
      const progressContainer = feedbackSection.createDiv({ cls: 'relevance-progress-container' });
      const progressBar = progressContainer.createDiv({ cls: 'relevance-progress-bar' });
      const progressLabel = progressContainer.createDiv({ cls: 'relevance-progress-label' });
      
      
      progressBar.style.width = `${relevanceScore}%`;
      progressLabel.setText(`Relevance Score: ${relevanceScore}%`);

      
      progressBar.removeClass('high-relevance', 'medium-relevance', 'low-relevance');
      if (relevanceScore >= 80) {
        progressBar.addClass('high-relevance');
      } else if (relevanceScore >= 50) {
        progressBar.addClass('medium-relevance');
      } else {
        progressBar.addClass('low-relevance');
      }

      
      this.state.questions[questionIndex].feedback = feedback;
      this.state.questions[questionIndex].relevanceScore = relevanceScore;
      const feedbackContent = feedbackSection.createDiv({ cls: 'feedback-content' });
      await this.renderMarkdown(feedback, feedbackContent);
    } catch (error: unknown) {
      feedbackSection.empty();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      feedbackSection.createEl('p', { text: `Error getting feedback: ${errorMessage}` });
    }
  }

  
  async generateMCQs(notePaths: string[], mcqSettings: MCQSettings) {
    try {

      this.state.mcqSessionSettings = mcqSettings;


      const selectedNotesContainer = this.noteSuggester?.['selectedNotesContainer'] as HTMLElement;


      const startButtons = this.container.querySelectorAll('.start-qa-button, .start-mcq-button, .start-conceptmap-button') as NodeListOf<HTMLElement>;
      startButtons.forEach(btn => btn.style.pointerEvents = 'none');


      const progressContainer = document.createElement('div');
      progressContainer.className = 'mcq-inline-progress';

      const progressHeader = progressContainer.createDiv({ cls: 'inline-progress-header' });
      const iconEl = progressHeader.createSpan({ cls: 'progress-icon' });
      setIcon(iconEl, 'list-todo');
      progressHeader.createSpan({ text: ' Generating MCQs: ' });
      progressHeader.createEl('strong', { text: mcqSettings.filename });

      const progressBarContainer = progressContainer.createDiv({ cls: 'inline-progress-bar-container' });
      const progressBar = progressBarContainer.createDiv({ cls: 'inline-progress-bar' });
      const progressFill = progressBar.createDiv({ cls: 'inline-progress-fill' });

      const progressText = progressContainer.createDiv({ cls: 'inline-progress-text' });
      progressText.textContent = 'Initializing...';

      const progressPercentage = progressContainer.createDiv({ cls: 'inline-progress-percentage' });
      progressPercentage.textContent = '0%';


      if (selectedNotesContainer && selectedNotesContainer.parentElement) {
        selectedNotesContainer.parentElement.insertBefore(progressContainer, selectedNotesContainer.nextSibling);
      } else {

        const mainContainer = this.container.querySelector('.notes-selection') as HTMLElement;
        if (mainContainer) {
          mainContainer.appendChild(progressContainer);
        }
      }

      const mcqs = await this.mcqManager.generateMCQs(
        notePaths, 
        mcqSettings,
        (percentage, status) => {
          progressFill.style.width = `${percentage}%`;
          progressText.textContent = status;
          progressPercentage.textContent = `${percentage}%`;
        }
      );
      this.state.mcqs = mcqs;


      progressContainer.remove();
      startButtons.forEach(btn => btn.style.pointerEvents = '');

      this.renderMCQs();

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Error: ${errorMessage}`);


      const startButtons = this.container.querySelectorAll('.start-qa-button, .start-mcq-button, .start-conceptmap-button') as NodeListOf<HTMLElement>;
      startButtons.forEach(btn => btn.style.pointerEvents = '');


      const progressContainer = this.container.querySelector('.mcq-inline-progress');
      if (progressContainer) {
        progressContainer.remove();
      }
    }
  }

  renderMCQs() {
    this.container.empty();
    this.renderTimer('mcq');

    
    this.container.createEl('h2', { text: 'Multiple Choice Questions' });

    
    this.state.mcqs.forEach((mcq, i) => {
      const mcqContainer = this.container.createDiv({ cls: 'mcq-container' });
      
      
      const questionEl = mcqContainer.createDiv();
      this.renderMarkdown(`Q${i + 1}: ${mcq.question}`, questionEl);

      
      const optionsTable = mcqContainer.createEl('table', { cls: 'mcq-options-table' });
      mcq.options.forEach((option, j) => {
        const optionRow = optionsTable.createEl('tr', { cls: 'mcq-option-row' });
        
        
        const checkboxCell = optionRow.createEl('td', { cls: 'mcq-checkbox-cell' });
        const checkbox = checkboxCell.createEl('input', { type: 'checkbox' });
        
        
        const textCell = optionRow.createEl('td', { cls: 'mcq-text-cell' });
        const optionText = textCell.createSpan({ cls: 'mcq-option-text' });
        this.renderMarkdown(`${String.fromCharCode(65 + j)}. ${option.text}`, optionText);

        checkbox.addEventListener('change', (e) => {
          const target = e.target as HTMLInputElement;
          
          
          optionsTable.querySelectorAll('input[type="checkbox"]').forEach((cb: Element) => {
            if (cb !== target) {
              (cb as HTMLInputElement).checked = false;
            }
          });

          
          const allRows = optionsTable.querySelectorAll('.mcq-option-row');
          allRows.forEach(row => row.classList.remove('selected'));
          
          if (target.checked) {
            this.state.mcqs[i].selectedOption = j;
            optionRow.classList.add('selected');
          } else {
            this.state.mcqs[i].selectedOption = undefined;
            optionRow.classList.remove('selected');
          }
        });
      });
    });

    
    const controlsSection = this.container.createDiv({ cls: 'controls-section' });
    const submitBtn = new ButtonComponent(controlsSection)
      .setButtonText('Submit Answers')
      .onClick(() => {
        if (this._mcqTestSubmitted) {
          new Notice('Test already submitted!');
          return;
        }
        this.evaluateMCQs();
      });
    this._mcqSubmitBtn = submitBtn;

    new ButtonComponent(controlsSection)
      .setButtonText('Save Session')
      .onClick(() => this.saveResults());

    new ButtonComponent(controlsSection)
      .setButtonText('Start New Session')
      .onClick(() => {
        
        (document.activeElement as HTMLElement)?.blur();
        this.renderInitial();
      });
  }

  evaluateMCQs() {
    if (this._mcqTestSubmitted) return;
    this._mcqTestSubmitted = true;
    this._mcqEvaluationInProgress = true;
    
    
    this.showMCQProgressDialog();
    
    
    if (this.timerActive && this.timerType === 'mcq') {
      this.timerActive = false;
      this.timerEndTime = undefined;
      this.timerInterval && window.clearInterval(this.timerInterval);
      if (this.timerContainer) {
        const timerDisplay = this.timerContainer.querySelector('.timer-countdown') as HTMLElement;
        if (timerDisplay) timerDisplay.textContent = '00:00';
      }
    }
    
    if (this._mcqSubmitBtn) {
      this._mcqSubmitBtn.buttonEl.setAttr('disabled', 'true');
      this._mcqSubmitBtn.onClick(() => {
        new Notice('Test already submitted!');
      });
    }

    try {
      const correctMarks = this.state.mcqSessionSettings?.correctMarks ?? 1;
      const incorrectMarks = this.state.mcqSessionSettings?.incorrectMarks ?? 0;
      const { result, incorrectAnswers } = this.mcqManager.evaluateMCQs(this.state.mcqs, correctMarks, incorrectMarks);
      this.state.mcqResult = result;

      
      this.state.mcqs.forEach((mcq, i) => {
        const mcqContainer = this.container.querySelectorAll('.mcq-container')[i];
        const optionsTable = mcqContainer.querySelector('.mcq-options-table');
      
      if (optionsTable) {
        const optionRows = optionsTable.querySelectorAll('.mcq-option-row');
        
        
        const correctOptionIndex = mcq.options.findIndex(opt => opt.isCorrect);
        
        
        optionRows[correctOptionIndex].classList.add('correct');

        if (mcq.selectedOption !== undefined) {
          optionRows[mcq.selectedOption].classList.remove('selected');

          const selectedOption = mcq.options[mcq.selectedOption];

          if (!selectedOption.isCorrect) {
            
            optionRows[mcq.selectedOption].classList.add('incorrect');
          }
        }

        
        optionsTable.querySelectorAll('input[type="checkbox"]').forEach((cb: Element) => {
          (cb as HTMLInputElement).disabled = true;
        });
      }
    });

      
      Promise.all(
        incorrectAnswers.map(async (wrong) => {
          const mcq = this.state.mcqs[wrong.questionNumber - 1];
          const correctOption = mcq.options.find(opt => opt.isCorrect);
          if (correctOption) {
            wrong.explanation = await this.mcqManager.getAnswerExplanation(mcq.question, correctOption.text);
          }
          return wrong;
        })
      ).then((answersWithExplanations) => {
        this.hideMCQProgressDialog();
        this._mcqEvaluationInProgress = false;
        this.renderMCQResults(answersWithExplanations);
      }).catch((error) => {
                this.showMCQEvaluationError(error);
      });
    } catch (error) {
            this.showMCQEvaluationError(error);
    }
  }

  private showMCQProgressDialog() {
    
    this.hideMCQProgressDialog();
    
    
    const controlsSection = this.container.querySelector('.controls-section') as HTMLElement;
    if (!controlsSection) {
            return;
    }
    
    
    const dialog = document.createElement('div');
    dialog.className = 'mcq-progress-dialog mcq-progress-inline';
    
    
    const content = dialog.createDiv({ cls: 'mcq-progress-content' });
    
    
    const header = content.createDiv({ cls: 'mcq-progress-header' });
    const icon = header.createDiv({ cls: 'mcq-progress-icon' });
    icon.setText('⏳');
    header.createDiv({ cls: 'mcq-progress-title', text: 'Evaluating Test' });
    
    
    const progressContainer = content.createDiv({ cls: 'mcq-progress-bar-container' });
    const progressBar = progressContainer.createDiv({ cls: 'mcq-progress-bar' });
    const progressFill = progressBar.createDiv({ cls: 'mcq-progress-fill' });
    
    
    const statusText = content.createDiv({ cls: 'mcq-progress-status' });
    statusText.textContent = 'Calculating scores and generating explanations...';
    
    
    controlsSection.parentNode?.insertBefore(dialog, controlsSection.nextSibling);
    this._mcqProgressDialog = dialog;
    
    
    let progress = 0;
    const progressInterval = setInterval(() => {
      progress += Math.random() * 15;
      if (progress > 90) progress = 90;
      progressFill.style.width = `${progress}%`;
    }, 200);
    
    
    (dialog as any)._progressInterval = progressInterval;
  }
  
  private hideMCQProgressDialog() {
    if (this._mcqProgressDialog) {
      
      const interval = (this._mcqProgressDialog as any)._progressInterval;
      if (interval) {
        clearInterval(interval);
      }
      
      this._mcqProgressDialog.remove();
      this._mcqProgressDialog = undefined;
    }
  }
  
  private showMCQEvaluationError(error: any) {
    this.hideMCQProgressDialog();
    this._mcqEvaluationInProgress = false;
    
    
    this._mcqTestSubmitted = false;
    if (this._mcqSubmitBtn) {
      this._mcqSubmitBtn.buttonEl.removeAttribute('disabled');
      this._mcqSubmitBtn.onClick(() => {
        if (this._mcqTestSubmitted) {
          new Notice('Test already submitted!');
          return;
        }
        this.evaluateMCQs();
      });
    }
    
    
    const overlay = document.createElement('div');
    overlay.className = 'mcq-error-overlay';
    
    
    const dialog = document.createElement('div');
    dialog.className = 'mcq-error-dialog';
    
    
    const content = dialog.createDiv({ cls: 'mcq-error-content' });
    
    
    const header = content.createDiv({ cls: 'mcq-error-header' });
    const icon = header.createDiv({ cls: 'mcq-error-icon' });
    icon.setText('⚠️');
    header.createDiv({ cls: 'mcq-error-title', text: 'Evaluation Failed' });
    
    
    const message = content.createDiv({ cls: 'mcq-error-message' });
    message.textContent = 'There was an error evaluating your test. Please try again.';
    
    
    if (error && error.message) {
      const details = content.createDiv({ cls: 'mcq-error-details' });
      details.textContent = `Error: ${error.message}`;
    }
    
    
    const buttons = content.createDiv({ cls: 'mcq-error-buttons' });
    
    const retryBtn = new ButtonComponent(buttons)
      .setButtonText('Re-check')
      .setCta()
      .onClick(() => {
        overlay.remove();
        this.evaluateMCQs();
      });
    
    const cancelBtn = new ButtonComponent(buttons)
      .setButtonText('Cancel')
      .onClick(() => {
        overlay.remove();
      });
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    
    
    new Notice('Test evaluation failed. Please try again.');
  }

  private renderMCQResults(incorrectAnswers: Array<{
    questionNumber: number;
    wrongOption: string;
    correctOption: string;
    explanation?: string;
  }>) {
    if (!this.state.mcqResult) return;

    const result = this.state.mcqResult;
    const resultContainer = this.container.createDiv({ cls: 'mcq-result-section' });
    
    
    resultContainer.createEl('h3', { text: 'Results' });
    const table = resultContainer.createEl('table', { cls: 'mcq-result-table' });
    
    const headers = table.createEl('tr');
    headers.createEl('th', { text: 'Metric' });
    headers.createEl('th', { text: 'Value' });

    const marksRow = table.createEl('tr');
    marksRow.createEl('td', { text: 'Total Marks' });
    marksRow.createEl('td', { text: `${result.marks.toFixed(2)} / ${this.state.mcqs.length * 2}` });

    const correctRow = table.createEl('tr');
    correctRow.createEl('td', { text: 'Correct Attempts' });
    correctRow.createEl('td', { text: `${result.correctAttempts} (+${result.correctAttempts * 2} marks)` });

    const incorrectRow = table.createEl('tr');
    incorrectRow.createEl('td', { text: 'Incorrect Attempts' });
    incorrectRow.createEl('td', { text: `${result.incorrectAttempts} (-${(result.incorrectAttempts * 0.66).toFixed(2)} marks)` });

    const accuracyRow = table.createEl('tr');
    accuracyRow.createEl('td', { text: 'Accuracy' });
    const accuracyCell = accuracyRow.createEl('td');
    
    
    let accuracyClass = '';
    if (result.accuracy >= 85) accuracyClass = 'accuracy-high';
    else if (result.accuracy >= 75) accuracyClass = 'accuracy-good';
    else if (result.accuracy >= 65) accuracyClass = 'accuracy-medium';
    else accuracyClass = 'accuracy-low';
    
    accuracyCell.createEl('span', {
      text: `${result.accuracy.toFixed(1)}%`,
      cls: accuracyClass
    });

    
    if (incorrectAnswers.length > 0) {
      const explanationsSection = resultContainer.createDiv({ cls: 'explanations-section' });
      explanationsSection.createEl('h3', { text: 'Answer Explanations' });

      incorrectAnswers.forEach((wrong) => {
        const explanationDiv = explanationsSection.createDiv({ cls: 'explanation-item' });
        
        
        const header = explanationDiv.createDiv({ cls: 'explanation-header' });
        header.createSpan({ text: `Question ${wrong.questionNumber} - ` });
        header.createSpan({ 
          text: wrong.wrongOption,
          cls: 'option-text wrong-option'
        });
        header.createSpan({ text: ' → ' });
        header.createSpan({ 
          text: wrong.correctOption,
          cls: 'option-text correct-option'
        });
        
        if (wrong.explanation) {
          const explanationText = explanationDiv.createDiv({ cls: 'explanation-text' });
          this.renderMarkdown(wrong.explanation, explanationText);
        }
      });
    }
  }

  
  async generateConceptMap(notePaths: string[], name: string) {
    try {
      
      const selectedNotesContainer = this.noteSuggester?.['selectedNotesContainer'] as HTMLElement;
      
      
      const startButtons = this.container.querySelectorAll('.start-qa-button, .start-mcq-button, .start-conceptmap-button') as NodeListOf<HTMLElement>;
      startButtons.forEach(btn => btn.style.pointerEvents = 'none');

      
      const progressContainer = document.createElement('div');
      progressContainer.className = 'concept-map-inline-progress';
      
      const progressHeader = progressContainer.createDiv({ cls: 'inline-progress-header' });
      const iconEl = progressHeader.createSpan({ cls: 'progress-icon' });
      setIcon(iconEl, 'network');
      progressHeader.createSpan({ text: ' Creating Concept Map: ' });
      progressHeader.createEl('strong', { text: name });
      
      const progressBarContainer = progressContainer.createDiv({ cls: 'inline-progress-bar-container' });
      const progressBar = progressBarContainer.createDiv({ cls: 'inline-progress-bar' });
      const progressFill = progressBar.createDiv({ cls: 'inline-progress-fill' });
      
      const progressText = progressContainer.createDiv({ cls: 'inline-progress-text' });
      progressText.textContent = 'Initializing...';
      
      const progressPercentage = progressContainer.createDiv({ cls: 'inline-progress-percentage' });
      progressPercentage.textContent = '0%';

      
      if (selectedNotesContainer && selectedNotesContainer.parentElement) {
        selectedNotesContainer.parentElement.insertBefore(progressContainer, selectedNotesContainer.nextSibling);
      } else {
        
        const mainContainer = this.container.querySelector('.notes-selection') as HTMLElement;
        if (mainContainer) {
          mainContainer.appendChild(progressContainer);
        }
      }

      
      const conceptMapData = await this.conceptMapManager.generateConceptMap(
        notePaths,
        (percentage, status) => {
          progressFill.style.width = `${percentage}%`;
          progressText.textContent = status;
          progressPercentage.textContent = `${percentage}%`;
        }
      );

      
      const filePath = await this.conceptMapManager.saveConceptMap(conceptMapData, name);
      
      
      const savedMap: SavedConceptMap = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: name,
        timestamp: Date.now(),
        filePath: filePath
      };
      this.state.savedConceptMaps.push(savedMap);
      this.saveSavedConceptMaps();

      
      await this.conceptMapManager.openConceptMapVisualization(conceptMapData, name);

      new Notice('Concept Map created successfully!');
      
      
      progressContainer.remove();
      startButtons.forEach(btn => btn.style.pointerEvents = '');
      this.renderInitial();

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Error: ${errorMessage}`);
      
      
      const startButtons = this.container.querySelectorAll('.start-qa-button, .start-mcq-button, .start-conceptmap-button') as NodeListOf<HTMLElement>;
      startButtons.forEach(btn => btn.style.pointerEvents = '');
      
      
      const progressContainer = this.container.querySelector('.concept-map-inline-progress');
      if (progressContainer) {
        progressContainer.remove();
      }
    }
  }

  
  async generateSlideshow(notePaths: string[], settings: any) {
    try {
      
      const selectedNotesContainer = this.noteSuggester?.['selectedNotesContainer'] as HTMLElement;
      
      
      const startButtons = this.container.querySelectorAll('.start-qa-button, .start-mcq-button, .start-conceptmap-button, .start-slides-button') as NodeListOf<HTMLElement>;
      startButtons.forEach(btn => btn.style.pointerEvents = 'none');

      
      const progressContainer = document.createElement('div');
      progressContainer.className = 'slideshow-inline-progress';
      
      const progressHeader = progressContainer.createDiv({ cls: 'inline-progress-header' });
      const iconEl = progressHeader.createSpan({ cls: 'progress-icon' });
      setIcon(iconEl, 'presentation');
      progressHeader.createSpan({ text: ' Creating Zen Slideshow: ' });
      progressHeader.createEl('strong', { text: settings.name });
      
      const progressBarContainer = progressContainer.createDiv({ cls: 'inline-progress-bar-container' });
      const progressBar = progressBarContainer.createDiv({ cls: 'inline-progress-bar' });
      const progressFill = progressBar.createDiv({ cls: 'inline-progress-fill' });
      
      const progressText = progressContainer.createDiv({ cls: 'inline-progress-text' });
      progressText.textContent = 'Initializing...';
      
      const progressPercentage = progressContainer.createDiv({ cls: 'inline-progress-percentage' });
      progressPercentage.textContent = '0%';

      
      if (selectedNotesContainer && selectedNotesContainer.parentElement) {
        selectedNotesContainer.parentElement.insertBefore(progressContainer, selectedNotesContainer.nextSibling);
      } else {
        const mainContainer = this.container.querySelector('.notes-selection') as HTMLElement;
        if (mainContainer) {
          mainContainer.appendChild(progressContainer);
        }
      }

      
      progressFill.style.width = '0%';
      progressFill.style.transition = 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)';

      let filePath: string;

      
      const zenData = await this.slideManager.generateZenSlideshow(
        notePaths,
        settings,
        (message: string) => {
          let percentage = 0;
          if (message.includes('Reading notes')) {
            percentage = 10;
          } else if (message.includes('Generating')) {
            percentage = 40;
          } else if (message.includes('Structuring')) {
            percentage = 70;
          } else if (message.includes('Finalizing')) {
            percentage = 95;
          }
          
          progressFill.style.width = `${percentage}%`;
          progressText.textContent = message;
          progressPercentage.textContent = `${percentage}%`;
        }
      );

      
      filePath = await this.slideManager.saveZenSlideshow(zenData);
      
      
      const savedSlideshow: SavedSlideshow = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: settings.name,
        timestamp: Date.now(),
        filePath: filePath,
        type: 'zen'
      };
      this.state.savedSlideshows.push(savedSlideshow);
      this.saveSavedSlideshows();

      
      progressFill.style.width = '100%';
      progressText.textContent = 'Complete!';
      progressPercentage.textContent = '100%';

      
      await this.slideManager.openZenSlideshowVisualization(zenData);

      new Notice('Zen slideshow created successfully!');
      
      
      setTimeout(() => {
        progressContainer.remove();
        startButtons.forEach(btn => btn.style.pointerEvents = '');
        this.renderInitial();
      }, 1000);

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Error: ${errorMessage}`);
      
      
      const startButtons = this.container.querySelectorAll('.start-qa-button, .start-mcq-button, .start-conceptmap-button, .start-slides-button') as NodeListOf<HTMLElement>;
      startButtons.forEach(btn => btn.style.pointerEvents = '');
      
      
      const progressContainer = this.container.querySelector('.slideshow-inline-progress');
      if (progressContainer) {
        progressContainer.remove();
      }
    }
  }

  
  private loadSavedConceptMaps() {
    const saved = localStorage.getItem('ai-tutor-saved-concept-maps');
    if (saved) {
      try {
        this.state.savedConceptMaps = JSON.parse(saved);
      } catch (e) {
        this.state.savedConceptMaps = [];
      }
    }
  }

  private saveSavedConceptMaps() {
    localStorage.setItem('ai-tutor-saved-concept-maps', JSON.stringify(this.state.savedConceptMaps));
  }

  private loadSavedSlideshows() {
    const saved = localStorage.getItem('ai-tutor-saved-slideshows');
    if (saved) {
      try {
        this.state.savedSlideshows = JSON.parse(saved);
      } catch (e) {
        this.state.savedSlideshows = [];
      }
    }
  }

  private saveSavedSlideshows() {
    localStorage.setItem('ai-tutor-saved-slideshows', JSON.stringify(this.state.savedSlideshows));
  }

  private renderSavedVisuals(container: HTMLElement, searchQuery: string = '') {
    container.empty();

    const totalVisuals = this.state.savedConceptMaps.length + this.state.savedSlideshows.length;

    if (totalVisuals === 0) {
      container.createEl('p', { text: 'No saved visuals yet.', cls: 'no-visuals-message' });
      return;
    }

    
    const filteredConceptMaps = searchQuery 
      ? this.state.savedConceptMaps.filter(cm => cm.name.toLowerCase().includes(searchQuery))
      : this.state.savedConceptMaps;
    
    const filteredSlideshows = searchQuery
      ? this.state.savedSlideshows.filter(ss => ss.name.toLowerCase().includes(searchQuery))
      : this.state.savedSlideshows;

    const filteredTotal = filteredConceptMaps.length + filteredSlideshows.length;

    if (filteredTotal === 0) {
      container.createEl('p', { text: `No visuals found matching "${searchQuery}"`, cls: 'no-visuals-message' });
      return;
    }

    
    filteredConceptMaps.forEach(conceptMap => {
      const card = container.createDiv({ cls: 'visual-card' });
      
      const cardContent = card.createDiv({ cls: 'visual-card-content' });
      const nameContainer = cardContent.createDiv({ cls: 'visual-name-container' });
      
      
      const iconEl = nameContainer.createDiv({ cls: 'visual-icon' });
      setIcon(iconEl, 'network');
      
      
      const nameEl = nameContainer.createEl('span', { cls: 'visual-name' });
      if (searchQuery) {
        this.highlightText(nameEl, conceptMap.name, searchQuery);
      } else {
        nameEl.textContent = conceptMap.name;
      }
      
      const timestamp = new Date(conceptMap.timestamp).toLocaleDateString();
      cardContent.createEl('span', { text: timestamp, cls: 'visual-date' });

      
      card.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.visual-action-button')) return;
        this.openSavedConceptMap(conceptMap);
      });

      const actions = card.createDiv({ cls: 'visual-actions' });

      
      new ButtonComponent(actions)
        .setIcon('edit')
        .setTooltip('Rename')
        .setClass('visual-action-button')
        .onClick(() => this.renameSavedConceptMap(conceptMap));

      
      new ButtonComponent(actions)
        .setIcon('trash')
        .setTooltip('Delete')
        .setClass('visual-action-button')
        .onClick(() => this.deleteSavedConceptMap(conceptMap.id));
    });

    
    filteredSlideshows.forEach(slideshow => {
      const card = container.createDiv({ cls: 'visual-card' });
      
      const cardContent = card.createDiv({ cls: 'visual-card-content' });
      const nameContainer = cardContent.createDiv({ cls: 'visual-name-container' });
      
      
      const iconEl = nameContainer.createDiv({ cls: 'visual-icon' });
      setIcon(iconEl, 'presentation');
      
      
      const nameEl = nameContainer.createEl('span', { cls: 'visual-name' });
      if (searchQuery) {
        this.highlightText(nameEl, slideshow.name, searchQuery);
      } else {
        nameEl.textContent = slideshow.name;
      }
      
      const timestamp = new Date(slideshow.timestamp).toLocaleDateString();
      const typeLabel = 'Zen';
      cardContent.createEl('span', { text: `${timestamp} • ${typeLabel}`, cls: 'visual-date' });

      
      card.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.visual-action-button')) return;
        this.openSavedSlideshow(slideshow);
      });

      const actions = card.createDiv({ cls: 'visual-actions' });

      
      new ButtonComponent(actions)
        .setIcon('edit')
        .setTooltip('Rename')
        .setClass('visual-action-button')
        .onClick(() => this.renameSavedSlideshow(slideshow));

      
      new ButtonComponent(actions)
        .setIcon('mic')
        .setTooltip('Change Voice')
        .setClass('visual-action-button')
        .onClick(() => this.changeSlideshowVoice(slideshow));

      
      new ButtonComponent(actions)
        .setIcon('trash')
        .setTooltip('Delete')
        .setClass('visual-action-button')
        .onClick(() => this.deleteSavedSlideshow(slideshow.id));
    });
  }

  
  private highlightText(element: HTMLElement, text: string, query: string) {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const index = lowerText.indexOf(lowerQuery);
    
    if (index === -1) {
      element.textContent = text;
      return;
    }
    
    const before = text.substring(0, index);
    const match = text.substring(index, index + query.length);
    const after = text.substring(index + query.length);
    
    if (before) element.appendChild(document.createTextNode(before));
    const highlight = element.createEl('mark', { text: match, cls: 'search-highlight' });
    if (after) element.appendChild(document.createTextNode(after));
  }

  private async openSavedConceptMap(conceptMap: SavedConceptMap) {
    try {
      
      
      const fileExists = await this.app.vault.adapter.exists(conceptMap.filePath);
      
      if (!fileExists) {
        new Notice(`Concept map file not found at: ${conceptMap.filePath}`);
                return;
      }
      
      
      let file: TFile | null = this.app.vault.getAbstractFileByPath(conceptMap.filePath) as TFile | null;
      
      
      if (!file) {
        await new Promise(resolve => setTimeout(resolve, 200));
        file = this.app.vault.getAbstractFileByPath(conceptMap.filePath) as TFile | null;
      }
      
      
      if (!file) {
        const allFiles = this.app.vault.getFiles();
        file = allFiles.find(f => f.path === conceptMap.filePath) || null;
      }
      
      
      if (!file || !(file instanceof TFile)) {
        
        const content = await this.app.vault.adapter.read(conceptMap.filePath);
        
        
        const conceptMapData = this.parseConceptMapFromMarkdown(content, conceptMap.name);
        await this.conceptMapManager.openConceptMapVisualization(conceptMapData, conceptMap.name);
        return;
      }
      
      
      const content = await this.app.vault.read(file);
      
      
      const conceptMapData = this.parseConceptMapFromMarkdown(content, conceptMap.name);
      
      
      await this.conceptMapManager.openConceptMapVisualization(conceptMapData, conceptMap.name);
    } catch (error) {
      new Notice('Error opening concept map');
          }
  }

  private parseConceptMapFromMarkdown(content: string, defaultName: string): any {
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    const conceptMapData: any = {
      noteName: defaultName,
      innerCircle: [],
      outerCircle: [],
      relations: [],
      themes: []
    };

    let currentSection: 'none' | 'inner' | 'outer' | 'relations' | 'themes' = 'none';

    for (const line of lines) {
      if (line.startsWith('# ')) {
        conceptMapData.noteName = line.substring(2).trim();
        continue;
      }
      if (line.startsWith('## Inner Circle')) {
        currentSection = 'inner';
        continue;
      }
      if (line.startsWith('### Outer Circle')) {
        currentSection = 'outer';
        continue;
      }
      if (line.startsWith('#### Relations')) {
        currentSection = 'relations';
        continue;
      }
      if (line.startsWith('##### Themes')) {
        currentSection = 'themes';
        continue;
      }

      if (line.startsWith('- ')) {
        const content = line.substring(2).trim();
        
        if (currentSection === 'inner') {
          const match = content.match(/^(.+?)\s+\[([A-Z])\]$/);
          if (match) {
            conceptMapData.innerCircle.push({ label: match[1].trim(), id: match[2] });
          }
        } else if (currentSection === 'outer') {
          const match = content.match(/^(.+?)\s+\[(\d+)\]$/);
          if (match) {
            conceptMapData.outerCircle.push({ label: match[1].trim(), id: match[2] });
          }
        } else if (currentSection === 'relations') {
          const match = content.match(/^\[([A-Z\d]+)\]<->\[([A-Z\d]+)\]\s*:\s*(.+)$/);
          if (match) {
            conceptMapData.relations.push({ from: match[1], to: match[2], reason: match[3].trim() });
          }
        } else if (currentSection === 'themes') {
          const themeMatch = content.match(/^(.+?)\s*:\s*(.+)$/);
          if (themeMatch) {
            const nodesPart = themeMatch[1];
            const reason = themeMatch[2].trim();
            const nodeMatches = nodesPart.matchAll(/\[([A-Z\d]+)\]/g);
            const nodes: string[] = [];
            for (const m of nodeMatches) {
              nodes.push(m[1]);
            }
            if (nodes.length > 0) {
              conceptMapData.themes.push({ nodes, reason });
            }
          }
        }
      }
    }

    return conceptMapData;
  }

  private renameSavedConceptMap(conceptMap: SavedConceptMap) {
    const modal = new Modal(this.app);
    modal.contentEl.createEl('h2', { text: 'Rename Concept Map' });
    
    let newName = conceptMap.name;
    new Setting(modal.contentEl)
      .setName('New Name')
      .addText(text => text
        .setValue(conceptMap.name)
        .onChange(value => { newName = value; }));
    
    const buttonContainer = modal.contentEl.createDiv({ cls: 'modal-button-container' });
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => modal.close());
    
    new ButtonComponent(buttonContainer)
      .setButtonText('Rename')
      .setCta()
      .onClick(() => {
        if (newName.trim()) {
          conceptMap.name = newName.trim();
          this.saveSavedConceptMaps();
          this.renderInitial();
          modal.close();
        }
      });
    
    modal.open();
  }

  private deleteSavedConceptMap(id: string) {
    if (confirm('Are you sure you want to delete this concept map from the saved list?')) {
      
      (document.activeElement as HTMLElement)?.blur();
      this.state.savedConceptMaps = this.state.savedConceptMaps.filter(cm => cm.id !== id);
      this.saveSavedConceptMaps();
      this.renderInitial();
    }
  }

  
  private async openSavedSlideshow(slideshow: SavedSlideshow) {
    try {
      const fileExists = await this.app.vault.adapter.exists(slideshow.filePath);

      if (!fileExists) {
        new Notice(`Slideshow file not found at: ${slideshow.filePath}`);
        return;
      }

      
      const zenData = await this.slideManager.loadZenSlideshow(slideshow.filePath);
      await this.slideManager.openZenSlideshowVisualization(zenData);
    } catch (error) {

      new Notice('Error opening slideshow');
          }
  }

  private renameSavedSlideshow(slideshow: SavedSlideshow) {
    const modal = new Modal(this.app);
    modal.contentEl.createEl('h2', { text: 'Rename Slideshow' });
    
    let newName = slideshow.name;
    new Setting(modal.contentEl)
      .setName('New Name')
      .addText(text => text
        .setValue(slideshow.name)
        .onChange(value => { newName = value; }));
    
    const buttonContainer = modal.contentEl.createDiv({ cls: 'modal-button-container' });
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => modal.close());
    
    new ButtonComponent(buttonContainer)
      .setButtonText('Rename')
      .setCta()
      .onClick(() => {
        if (newName.trim()) {
          slideshow.name = newName.trim();
          this.saveSavedSlideshows();
          this.renderInitial();
          modal.close();
        }
      });
    
    modal.open();
  }

  private async changeSlideshowVoice(slideshow: SavedSlideshow) {
    try {
      const fileExists = await this.app.vault.adapter.exists(slideshow.filePath);
      if (!fileExists) {
        new Notice(`Slideshow file not found at: ${slideshow.filePath}`);
        return;
      }
      
      const zenData = await this.slideManager.loadZenSlideshow(slideshow.filePath);
      
      new SlideshowVoiceSettingsModal(this.app, zenData, async (updatedSettings) => {
        zenData.preferredVoice = updatedSettings.preferredVoice;
        zenData.voiceRate = updatedSettings.voiceRate;
        zenData.voicePitch = updatedSettings.voicePitch;
        
        await this.slideManager.saveZenSlideshow(zenData, slideshow.filePath);
        new Notice('Slideshow voice updated successfully');
      }).open();
      
    } catch (error) {
      new Notice('Error loading slideshow voice settings');
          }
  }

  private deleteSavedSlideshow(id: string) {
    if (confirm('Are you sure you want to delete this slideshow from the saved list?')) {
      (document.activeElement as HTMLElement)?.blur();
      this.state.savedSlideshows = this.state.savedSlideshows.filter(s => s.id !== id);
      this.saveSavedSlideshows();
      this.renderInitial();
    }
  }

  
  private async renderMarkdown(content: string, container: HTMLElement) {
    await MarkdownRenderer.renderMarkdown(content, container, '.', new Component());
  }

  async saveResults() {
    try {
      if (this.state.questions.length === 0 && this.state.mcqs.length === 0) {
        new Notice('No content to save');
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      let filename = `AI-Tutor-Session-${timestamp}.md`;
      let dir = this.settings.saveDirectory?.trim() || '';

      
      const qaSessionSettings = this.state.qaSessionSettings;
      if (qaSessionSettings) {
        filename = `${qaSessionSettings.filename}.md`;
        dir = qaSessionSettings.saveDirectory;
      }
      
      const mcqSessionSettings = this.state.mcqSessionSettings;
      if (mcqSessionSettings) {
        filename = `${mcqSessionSettings.filename}.md`;
        dir = mcqSessionSettings.saveDirectory;
      }

      const filePath = normalizePath(dir ? `${dir}/${filename}` : filename);

      
      if (dir) {
        const dirPath = this.app.vault.getAbstractFileByPath(dir);
        if (!dirPath) {
          try {
            await this.app.vault.createFolder(dir);
          } catch (error) {
            new Notice(`Failed to create directory: ${dir}`);
            return;
          }
        }
      }

      const lines: string[] = [];
      lines.push('# AI Tutor Session');
      lines.push(`Date: ${new Date().toLocaleString()}\n`);

      
      if (this.state.questions.length > 0) {
        lines.push('## Q&A Section\n');
        this.state.questions.forEach((q, i) => {
          lines.push(`### Question ${i + 1}`);
          lines.push(q.text);
          if (q.answer) {
            lines.push('\n#### Your Answer');
            lines.push(q.answer);
          }
          if (q.feedback) {
            lines.push('\n#### Feedback');
            lines.push(`Score: ${q.relevanceScore}%`);
            lines.push(q.feedback);
          }
          lines.push('\n---\n');
        });
      }

      
      if (this.state.mcqs.length > 0) {
        
        if (this.state.mcqResult) {
          lines.unshift('---');
          lines.unshift(`Accuracy: ${this.state.mcqResult.accuracy.toFixed(1)}%`);
          lines.unshift('Type: MCQ');
          lines.unshift(`Test_Date: ${new Date().toLocaleDateString()}`);
          lines.unshift('---\n');
        }

        lines.push('## Multiple Choice Questions\n');
        
        
        if (this.state.mcqResult) {
          lines.push('### Results Summary');
          lines.push(`- Total Score: ${this.state.mcqResult.marks.toFixed(2)} / ${this.state.mcqs.length * 2}`);
          lines.push(`- Correct Answers: ${this.state.mcqResult.correctAttempts} (+${this.state.mcqResult.correctAttempts * 2} marks)`);
          lines.push(`- Incorrect Answers: ${this.state.mcqResult.incorrectAttempts} (-${(this.state.mcqResult.incorrectAttempts * 0.66).toFixed(2)} marks)`);
          lines.push(`- Accuracy: ${this.state.mcqResult.accuracy.toFixed(1)}%\n`);
        }

        
        this.state.mcqs.forEach((mcq, i) => {
          lines.push(`### Question ${i + 1}`);
          lines.push(mcq.question + '\n');
          
          mcq.options.forEach((opt, j) => {
            const prefix = String.fromCharCode(65 + j);
            const selected = mcq.selectedOption === j ? ' ✓' : '';
            const correct = opt.isCorrect ? ' ✅' : '';
            lines.push(`${prefix}. ${opt.text}${selected}${correct}`);
          });
          lines.push('\n---\n');
        });
      }

      await this.app.vault.create(filePath, lines.join('\n'));
      new Notice(`Saved to ${filePath}`);

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Error saving results: ${errorMessage}`);
    }
  }

  async onClose() {
    
    this.hideMCQProgressDialog();
    
    
    const errorOverlays = document.body.querySelectorAll('.mcq-error-overlay');
    errorOverlays.forEach(overlay => overlay.remove());
    
    
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = undefined;
    }
    
    
     if (this.directorySuggester) {
         
     }
  }

  private handleDragOver(event: DragEvent, dropZoneEl: HTMLElement) {
    event.preventDefault();
    dropZoneEl.addClass('drag-over');
  }

  private handleDragLeave(event: DragEvent, dropZoneEl: HTMLElement) {
    event.preventDefault();
    dropZoneEl.removeClass('drag-over');
  }

  private async handleFileDrop(event: DragEvent) {
    event.preventDefault();
    const dropZone = this.container.querySelector('.notebook-drop-zone') as HTMLElement;
    dropZone.removeClass('drag-over');

    const droppedPaths: Set<string> = new Set();

    
    if (event.dataTransfer?.items) {
      for (let i = 0; i < event.dataTransfer.items.length; i++) {
        const item = event.dataTransfer.items[i];
        if (item.kind === 'file') {
          
          const filePath = event.dataTransfer.getData('text/plain');
          if (filePath) {
            
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
              droppedPaths.add(file.path);
            } else {
              
              
              
            }
          }
        } else if (item.kind === 'string' && item.type === 'text/plain') {
          
          const textData = event.dataTransfer.getData('text/plain');
          const file = this.app.vault.getAbstractFileByPath(textData);
          if (file instanceof TFile) {
            droppedPaths.add(file.path);
          }
        }
      }
    } else if (event.dataTransfer?.files) {
      
      for (let i = 0; i < event.dataTransfer.files.length; i++) {
        const file = event.dataTransfer.files[i];
        
        
        
        
        new Notice(`Direct file drop (may not be from vault): ${file.name}`);
      }
    }

    if (droppedPaths.size > 0) {
      new NotebookFormModal(this.app, this.plugin, null, (settings) => {
        
        this.notebookManager.addNotebook(settings.name, Array.from(settings.sourcePaths), settings.customInstruction, settings.webSources, settings.inlineCitation, settings.mode, settings.sourceFolders, settings.feedSources);
        this.renderInitial();
      }, Array.from(droppedPaths)).open(); 
    } else {
      new Notice('No valid notes dropped or recognized.');
     }
  }

  
  private renderTimer(type: 'mcq' | 'qna') {
    
    this.timerContainer?.remove();
    this.timerContainer = this.container.createDiv({ cls: 'timer-fixed-container' });
    this.timerContainer.style.position = 'sticky';
    this.timerContainer.style.top = '0';
    this.timerContainer.style.right = '0';
    this.timerContainer.style.display = 'flex';
    this.timerContainer.style.justifyContent = 'flex-end';
    this.timerContainer.style.alignItems = 'center';
    this.timerContainer.style.zIndex = '10';
    this.timerContainer.style.background = 'var(--background-primary, #fff)';
    this.timerContainer.style.padding = '8px 16px 0 0';
    this.timerContainer.style.gap = '8px';

    
    const timerIcon = this.timerContainer.createSpan({ cls: 'lucide-timer', attr: { 'aria-label': 'Set timer' } });
    setIcon(timerIcon, 'timer');
    timerIcon.style.cursor = 'pointer';
    timerIcon.title = 'Set timer';

    
    const timerDisplay = this.timerContainer.createSpan({ cls: 'timer-countdown' });
    timerDisplay.style.fontWeight = 'bold';
    timerDisplay.style.fontSize = '1.1em';
    timerDisplay.style.marginLeft = '8px';
    timerDisplay.style.display = 'none';

    timerIcon.onclick = () => {
      if (this.timerActive) return; 
      new TimerModal(this.app, (ms) => {
        this.startTimer(ms, type, timerDisplay);
      }).open();
    };
    this.container.prepend(this.timerContainer);
  }

  private startTimer(ms: number, type: 'mcq' | 'qna', timerDisplay: HTMLElement) {
    this.timerActive = true;
    this.timerType = type;
    this.timerNoticeShown = false;
    this.timerEndTime = Date.now() + ms;
    timerDisplay.style.display = '';
    this.updateTimerDisplay(timerDisplay);
    this.timerInterval && window.clearInterval(this.timerInterval);
    this.timerInterval = window.setInterval(() => {
      this.updateTimerDisplay(timerDisplay);
      if (this.timerEndTime && Date.now() >= this.timerEndTime) {
        this.endTimer();
      }
    }, 1000);
  }

  private updateTimerDisplay(timerDisplay: HTMLElement) {
    if (!this.timerEndTime) return;
    const remaining = Math.max(0, this.timerEndTime - Date.now());
    const min = Math.floor(remaining / 60000);
    const sec = Math.floor((remaining % 60000) / 1000);
    timerDisplay.textContent = `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }

  private endTimer() {
    if (!this.timerActive) return;
    this.timerActive = false;
    this.timerEndTime = undefined;
    this.timerInterval && window.clearInterval(this.timerInterval);
    if (this.timerType === 'mcq') {
      this.evaluateMCQs();
      if (!this.timerNoticeShown) {
        new Notice('session time over!');
        this.timerNoticeShown = true;
      }
      
      if (this._mcqSubmitBtn) {
        this._mcqSubmitBtn.buttonEl.setAttr('disabled', 'true');
        this._mcqSubmitBtn.onClick(() => {
          new Notice('Test already submitted!');
        });
      }
    } else if (this.timerType === 'qna') {
      
      this.container.querySelectorAll('textarea').forEach((ta: Element) => {
        (ta as HTMLTextAreaElement).disabled = true;
        ta.addEventListener('mousedown', (e) => {
          new Notice('session time over!');
          e.preventDefault();
        });
        ta.addEventListener('focus', (e) => {
          new Notice('session time over!');
          e.preventDefault();
        });
        ta.addEventListener('keydown', (e) => {
          new Notice('session time over!');
          e.preventDefault();
        });
      });
    }
  }
}

class QASettingsModal extends Modal {
    private initialSelectedPaths: Set<string>;
    private onSubmit: (settings: QASettings) => void;
    private settings: AISettings;

    private numQuestions: number = 5;
    private filename: string = 'AI-Tutor-Q&A-Session';
    private saveDirectory: string;
    private customPrompt: string = '';

    constructor(app: any, pluginSettings: AISettings, initialSelectedPaths: Set<string>, onSubmit: (settings: QASettings) => void) {
        super(app);
        this.initialSelectedPaths = initialSelectedPaths;
        this.onSubmit = onSubmit;
        this.settings = pluginSettings;
        this.saveDirectory = this.settings.saveDirectory?.trim() || '';
        this.modalEl.addClass('qa-settings-modal');
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Q&A Generation Settings' });

        new Setting(contentEl)
            .setName('Number of Questions')
            .setDesc('Set the number of questions to generate for the Q&A session.')
            .addText(text => text
                .setPlaceholder('e.g., 10')
                .setValue(this.numQuestions.toString())
                .onChange(value => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.numQuestions = num;
                    } else {
                        new Notice('Please enter a valid number greater than 0.');
                    }
                }));

        new Setting(contentEl)
            .setName('Session Filename')
            .setDesc('Enter the filename for the saved Q&A session (e.g., MyStudySession).')
            .addText(text => text
                .setPlaceholder('AI-Tutor-Q&A-Session')
                .setValue(this.filename)
                .onChange(value => {
                    this.filename = value.trim();
                }));

        let directoryInput: HTMLInputElement;
        new Setting(contentEl)
            .setName('Save Directory')
            .setDesc('Optional: Directory to save the session. Defaults to settings directory.')
            .addText(text => {
                text.setPlaceholder('e.g., Daily Notes/Study')
                    .setValue(this.saveDirectory)
                    .onChange(value => {
                        this.saveDirectory = value.trim();
                    });
                new DirectorySuggester(this.app, text.inputEl, (path) => {
                    this.saveDirectory = path;
                    text.inputEl.value = path;
                }, this.saveDirectory);
            });

        new Setting(contentEl)
            .setName('Custom Prompt (Optional)')
            .setDesc('Provide additional instructions or context for the AI when generating questions.')
            .addTextArea(text => text
                .setPlaceholder('e.g., Focus on advanced concepts and interdisciplinary connections.')
                .setValue(this.customPrompt)
                .onChange(value => {
                    this.customPrompt = value;
                }));

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        new ButtonComponent(buttonContainer)
            .setButtonText('Cancel')
            .onClick(() => this.close());

        new ButtonComponent(buttonContainer)
            .setButtonText('Generate Q&A')
            .setCta()
            .onClick(() => {
                if (!this.filename) {
                    new Notice('Filename is mandatory.');
                    return;
                }
                if (this.numQuestions <= 0) {
                    new Notice('Number of questions must be greater than 0.');
                    return;
                }
                this.onSubmit({
                    numQuestions: this.numQuestions,
                    filename: this.filename,
                    saveDirectory: this.saveDirectory,
                    customPrompt: this.customPrompt
                });
                this.close();
            });
    }
}

class MCQSettingsModal extends Modal {
  private initialSelectedPaths: Set<string>;
  private onSubmit: (settings: MCQSettings) => void;
  private settings: AISettings;

  private numMCQs: number = 20;
  private filename: string = 'AI-Tutor-MCQ-Session';
  private saveDirectory: string;
  private customPrompt: string = '';
  private correctMarks: number = 1;
  private incorrectMarks: number = 0;

  constructor(app: any, pluginSettings: AISettings, initialSelectedPaths: Set<string>, onSubmit: (settings: MCQSettings) => void) {
    super(app);
    this.initialSelectedPaths = initialSelectedPaths;
    this.onSubmit = onSubmit;
    this.settings = pluginSettings;
    this.saveDirectory = this.settings.saveDirectory?.trim() || '';
    this.modalEl.addClass('mcq-settings-modal');
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'MCQ Generation Settings' });

    new Setting(contentEl)
      .setName('Number of MCQs')
      .setDesc('Set the maximum number of multiple-choice questions to generate.')
      .addText(text => text
        .setPlaceholder('e.g., 15')
        .setValue(this.numMCQs.toString())
        .onChange(value => {
          const num = parseInt(value);
          if (!isNaN(num) && num > 0) {
            this.numMCQs = num;
          } else {
            new Notice('Please enter a valid number greater than 0.');
          }
        }));

    new Setting(contentEl)
      .setName('Session Filename')
      .setDesc('Enter the filename for the saved MCQ session (e.g., MyMCQSession).')
      .addText(text => text
        .setPlaceholder('AI-Tutor-MCQ-Session')
        .setValue(this.filename)
        .onChange(value => {
          this.filename = value.trim();
        }));

    new Setting(contentEl)
      .setName('Save Directory')
      .setDesc('Optional: Directory to save the session. Defaults to settings directory.')
      .addText(text => {
        text.setPlaceholder('e.g., Daily Notes/Study')
          .setValue(this.saveDirectory)
          .onChange(value => {
            this.saveDirectory = value.trim();
          });
        new DirectorySuggester(this.app, text.inputEl, (path) => {
          this.saveDirectory = path;
          text.inputEl.value = path;
        }, this.saveDirectory);
      });

    new Setting(contentEl)
      .setName('Custom Prompt (Optional)')
      .setDesc('Provide additional instructions or context for the AI when generating MCQs.')
      .addTextArea(text => text
        .setPlaceholder('e.g., Include questions on historical context and future implications.')
        .setValue(this.customPrompt)
        .onChange(value => {
          this.customPrompt = value;
        }));

    
    contentEl.createEl('h3', { text: 'Marking Scheme' });
    
    new Setting(contentEl)
      .setName('Marks for Correct Answer')
      .setDesc('Points awarded for each correct answer.')
      .addText(text => text
        .setPlaceholder('1')
        .setValue(this.correctMarks.toString())
        .onChange(value => {
          const num = parseFloat(value);
          if (!isNaN(num) && num >= 0) {
            this.correctMarks = num;
          } else {
            new Notice('Please enter a valid positive number.');
          }
        }));

    new Setting(contentEl)
      .setName('Marks for Incorrect Answer')
      .setDesc('Points deducted for each incorrect answer. Use 0 for no negative marking.')
      .addText(text => text
        .setPlaceholder('0')
        .setValue(this.incorrectMarks.toString())
        .onChange(value => {
          const num = parseFloat(value);
          if (!isNaN(num) && num >= 0) {
            this.incorrectMarks = num;
          } else {
            new Notice('Please enter a valid positive number or 0.');
          }
        }));

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());

    new ButtonComponent(buttonContainer)
      .setButtonText('Generate MCQs')
      .setCta()
      .onClick(() => {
        if (!this.filename) {
          new Notice('Filename is mandatory.');
          return;
        }
        if (this.numMCQs <= 0) {
          new Notice('Number of MCQs must be greater than 0.');
          return;
        }
        this.onSubmit({
          numMCQs: this.numMCQs,
          filename: this.filename,
          saveDirectory: this.saveDirectory,
          customPrompt: this.customPrompt,
          correctMarks: this.correctMarks,
          incorrectMarks: this.incorrectMarks
        });
        this.close();
      });
  }
}

class MindmapSettingsModal extends Modal {
  private initialSelectedPaths: Set<string>;
  private onSubmit: (settings: { customPrompt: string; saveDirectory: string }) => void;
  private settings: AISettings;

  private customPrompt: string = '';
  private saveDirectory: string;

  constructor(app: any, pluginSettings: AISettings, initialSelectedPaths: Set<string>, onSubmit: (settings: { customPrompt: string; saveDirectory: string }) => void) {
    super(app);
    this.initialSelectedPaths = initialSelectedPaths;
    this.onSubmit = onSubmit;
    this.settings = pluginSettings;
    this.saveDirectory = this.settings.saveDirectory?.trim() || '';
    this.modalEl.addClass('mindmap-settings-modal');
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Mindmap Generation Settings' });

    new Setting(contentEl)
      .setName('Custom Prompt (Optional)')
      .setDesc('Provide additional instructions or context for the AI when generating the mindmap.')
      .addTextArea(text => text
        .setPlaceholder('e.g., Focus on key concepts and their relationships, omitting minor details.')
        .setValue(this.customPrompt)
        .onChange(value => {
          this.customPrompt = value;
        }));
    
    new Setting(contentEl)
        .setName('Save Directory')
        .setDesc('Optional: Directory to save the mindmap. Defaults to settings directory.')
        .addText(text => {
            text.setPlaceholder('e.g., Daily Notes/Study')
                .setValue(this.saveDirectory)
                .onChange(value => {
                    this.saveDirectory = value.trim();
                });
            new DirectorySuggester(this.app, text.inputEl, (path) => {
                this.saveDirectory = path;
                text.inputEl.value = path;
            }, this.saveDirectory);
        });

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());

    new ButtonComponent(buttonContainer)
      .setButtonText('Generate Mindmap')
      .setCta()
      .onClick(() => {
        this.onSubmit({
          customPrompt: this.customPrompt,
          saveDirectory: this.saveDirectory
        });
        this.close();
      });
  }
}


class TimerModal extends Modal {
  private onSubmit: (ms: number) => void;
  constructor(app: any, onSubmit: (ms: number) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Set Time Limit' });
    const input = contentEl.createEl('input', { type: 'text', placeholder: 'mm:ss (e.g., 05:00)' });
    input.style.width = '100%';
    input.style.marginBottom = '10px';
    const submitBtn = contentEl.createEl('button', { text: 'Set Timer' });
    submitBtn.onclick = () => {
      const value = input.value.trim();
      const match = value.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) {
        new Notice('Please enter time as mm:ss');
        return;
      }
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      if (isNaN(min) || isNaN(sec)) {
        new Notice('Invalid time');
        return;
      }
      const ms = (min * 60 + sec) * 1000;
      this.onSubmit(ms);
      this.close();
    };
  }
}