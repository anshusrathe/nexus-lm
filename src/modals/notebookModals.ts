import { App, Modal, Setting, ButtonComponent, Notice, TFile } from 'obsidian';
import { Notebook, NotebookMode } from '../managers/notebookManager';
import { NoteSuggester, FolderSuggester } from '../views/view'; // Import FolderSuggester
import AIPlugin from '../main';

interface NotebookFormSettings {
  name: string;
  sourcePaths: string[];
  sourceFolders: string[];
  customInstruction: string;
  webSources: { url: string; name: string }[];
  feedSources: { url: string; name: string; durationDays: number }[];
  inlineCitation: boolean;
  mode: NotebookMode;
}

export class NotebookFormModal extends Modal {
  private notebook: Notebook | null;
  private onSubmit: (settings: NotebookFormSettings) => void;
  private plugin: AIPlugin;

  private notebookName: string;
  private selectedSourcePaths: string[];
  private selectedSourceFolders: string[];
  private customInstruction: string;
  private webSources: { url: string; name: string }[];
  private feedSources: { url: string; name: string; durationDays: number }[];
  private inlineCitation: boolean;
  private mode: NotebookMode;

  private noteSuggester: NoteSuggester | undefined;
  private folderSuggester: FolderSuggester | undefined;

  constructor(
    app: App,
    plugin: AIPlugin,
    notebook: Notebook | null, // null for creation, Notebook object for editing
    onSubmit: (settings: NotebookFormSettings) => void,
    initialSourcePaths?: string[] // Optional: paths to pre-select
  ) {
    super(app);
    this.plugin = plugin;
    this.notebook = notebook;
    this.onSubmit = onSubmit;

    this.notebookName = notebook ? notebook.name : '';
    this.selectedSourcePaths = notebook ? notebook.sourcePaths : initialSourcePaths || [];
    this.selectedSourceFolders = notebook && Array.isArray(notebook.sourceFolders) ? [...notebook.sourceFolders] : [];
    this.customInstruction = notebook && typeof notebook.customInstruction === 'string' ? notebook.customInstruction : '';
    this.webSources = notebook && Array.isArray(notebook.webSources) ? [...notebook.webSources] : [];
    this.feedSources = notebook && Array.isArray(notebook.feedSources) ? [...notebook.feedSources] : [];
    this.inlineCitation = notebook && notebook.inlineCitation !== undefined ? notebook.inlineCitation : true;
    this.mode = notebook && notebook.mode ? notebook.mode : 'cag';

    this.modalEl.addClass('notebook-form-modal');
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // Create a scrollable container for the modal content
    const scrollableContainer = contentEl.createDiv({ cls: 'notebook-form-scrollable-container' });

    scrollableContainer.createEl('h2', { text: this.notebook ? 'Edit Notebook' : 'Create New Notebook' });

    new Setting(scrollableContainer)
      .setName('Notebook Name')
      .setDesc('Enter a name for your notebook.')
      .addText(text => text
        .setPlaceholder('My Project Notebook')
        .setValue(this.notebookName)
        .onChange(value => {
          this.notebookName = value.trim();
        }));

    // --- Inline Citation Toggle (moved before Custom Instruction) ---
    new Setting(scrollableContainer)
      .setName('Inline Citation')
      .setDesc('Enable inline citations in notebook responses')
      .addToggle(toggle => toggle
        .setValue(this.inlineCitation)
        .onChange(value => {
          this.inlineCitation = value;
        }));
    // ---

    // Custom Instruction Section
    scrollableContainer.createEl('h3', { text: 'Custom Instruction' });
    const customInstructionBox = scrollableContainer.createEl('textarea', {
      cls: 'notebook-custom-instruction-box',
      text: this.customInstruction,
      placeholder: 'Provide custom instructions for the AI (optional)...',
    });
    customInstructionBox.addEventListener('input', (e) => {
      this.customInstruction = (e.target as HTMLTextAreaElement).value;
    });

    scrollableContainer.createEl('h3', { text: 'Select Source Notes' });
    const noteSuggesterContainer = scrollableContainer.createDiv({ cls: 'notebook-note-suggester-container' });

    // Always get the latest source paths for edit/create
    let initialPaths: string[] = [];
    if (this.notebook) {
      initialPaths = Array.isArray(this.notebook.sourcePaths) ? this.notebook.sourcePaths : [];
    } else if (this.selectedSourcePaths) {
      initialPaths = this.selectedSourcePaths;
    }

    // Initialize NoteSuggester
    this.noteSuggester = new NoteSuggester(
      this.app,
      noteSuggesterContainer,
      (paths: string[]) => {
        this.selectedSourcePaths = paths;
      }
    );
    this.noteSuggester.setInitialSelectedPaths(initialPaths);

    // --- Add Source Folders Section ---
    scrollableContainer.createEl('h3', { text: 'Add Source Folders' });
    const folderDescription = scrollableContainer.createEl('p', { 
      cls: 'folder-description',
      text: 'Select folders to automatically include all their files as sources. New files added to these folders will be available when you reopen the notebook.'
    });
    const folderSuggesterContainer = scrollableContainer.createDiv({ cls: 'notebook-folder-suggester-container' });

    // Initialize FolderSuggester
    this.folderSuggester = new FolderSuggester(
      this.app,
      folderSuggesterContainer,
      (folders: string[]) => {
        this.selectedSourceFolders = folders;
      }
    );
    this.folderSuggester.setInitialSelectedFolders(this.selectedSourceFolders);

    // --- Add Web Context Section ---
    scrollableContainer.createEl('h3', { text: 'Add Web Context' });
    const webContextContainer = scrollableContainer.createDiv({ cls: 'web-context-container' });
    const webList = webContextContainer.createDiv({ cls: 'web-context-list' });
    const addRow = webContextContainer.createDiv({ cls: 'web-context-add-row' });
    const urlInput = addRow.createEl('input', { type: 'text', placeholder: 'Enter webpage URL...' });
    const nameInput = addRow.createEl('input', { type: 'text', placeholder: 'Set a name for this URL...' });
    const addBtn = addRow.createEl('button', { text: 'Add', cls: 'add-web-context-btn' });
    const renderWebList = () => {
      webList.empty();
      this.webSources.forEach((src, idx) => {
        const row = webList.createDiv({ cls: 'web-context-row' });
        row.createSpan({ text: src.name, cls: 'web-context-name' });
        // --- MAKE URL CLICKABLE ---
        const urlLink = document.createElement('a');
        urlLink.href = src.url;
        urlLink.textContent = src.url;
        urlLink.target = '_blank';
        urlLink.rel = 'noopener noreferrer';
        row.appendChild(urlLink);
        const removeBtn = row.createEl('button', { text: '✕', cls: 'remove-web-context-btn' });
        removeBtn.onclick = () => {
          this.webSources.splice(idx, 1);
          renderWebList();
        };
      });
    };
    renderWebList();
    addBtn.onclick = () => {
      const url = urlInput.value.trim();
      const name = nameInput.value.trim();
      if (!url || !name) {
        new Notice('Both URL and name are required.');
        return;
      }
      this.webSources.push({ url, name });
      urlInput.value = '';
      nameInput.value = '';
      renderWebList();
    };
    // ---

    // --- Add Feed Sources Section ---
    scrollableContainer.createEl('h3', { text: 'Add Feed Sources' });
    const feedDescription = scrollableContainer.createEl('p', {
      cls: 'feed-description',
      text: 'Select RSS/Atom feeds from your saved feeds. Recent entries (based on duration) will be added as web sources.'
    });
    const feedContextContainer = scrollableContainer.createDiv({ cls: 'feed-context-container' });
    const feedList = feedContextContainer.createDiv({ cls: 'feed-context-list' });
    const feedAddRow = feedContextContainer.createDiv({ cls: 'feed-context-add-row' });
    
    // Dropdown for saved feeds
    const feedSelect = feedAddRow.createEl('select', { cls: 'feed-select-dropdown' });
    feedSelect.createEl('option', { text: 'Select a feed...', value: '' });
    
    // Populate with saved feeds
    const savedFeeds = this.plugin.settings.savedFeeds || [];
    savedFeeds.forEach(feed => {
      feedSelect.createEl('option', { text: feed.name, value: feed.url });
    });
    
    // Duration dropdown
    const durationSelect = feedAddRow.createEl('select', { cls: 'duration-select-dropdown' });
    durationSelect.createEl('option', { text: 'Last 24 hours', value: '1' });
    durationSelect.createEl('option', { text: 'Last 3 days', value: '3' });
    durationSelect.createEl('option', { text: 'Last 7 days', value: '7' });
    durationSelect.createEl('option', { text: 'Last 10 days', value: '10' });
    
    const feedAddBtn = feedAddRow.createEl('button', { text: 'Add Feed', cls: 'add-feed-context-btn' });
    
    const renderFeedList = () => {
      feedList.empty();
      this.feedSources.forEach((src, idx) => {
        const row = feedList.createDiv({ cls: 'feed-context-row' });
        row.createSpan({ text: src.name, cls: 'feed-context-name' });
        row.createSpan({ text: `(${src.durationDays} day${src.durationDays > 1 ? 's' : ''})`, cls: 'feed-context-duration' });
        const removeBtn = row.createEl('button', { text: '✕', cls: 'remove-feed-context-btn' });
        removeBtn.onclick = () => {
          this.feedSources.splice(idx, 1);
          renderFeedList();
        };
      });
    };
    
    renderFeedList();
    
    feedAddBtn.onclick = () => {
      const selectedUrl = feedSelect.value;
      const selectedDuration = parseInt(durationSelect.value);
      
      if (!selectedUrl) {
        new Notice('Please select a feed.');
        return;
      }
      
      // Find the feed name
      const selectedFeed = savedFeeds.find(f => f.url === selectedUrl);
      if (!selectedFeed) {
        new Notice('Feed not found.');
        return;
      }
      
      // Check if already added
      if (this.feedSources.some(f => f.url === selectedUrl)) {
        new Notice('This feed is already added.');
        return;
      }
      
      this.feedSources.push({
        url: selectedUrl,
        name: selectedFeed.name,
        durationDays: selectedDuration
      });
      
      feedSelect.value = '';
      renderFeedList();
    };
    // ---

    // Create button container outside the scrollable area
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());

    new ButtonComponent(buttonContainer)
      .setButtonText(this.notebook ? 'Save Notebook' : 'Create Notebook')
      .setCta()
      .onClick(() => {
        if (!this.notebookName) {
          new Notice('Notebook name cannot be empty.');
          return;
        }
        this.onSubmit({
          name: this.notebookName,
          sourcePaths: this.selectedSourcePaths,
          sourceFolders: this.selectedSourceFolders,
          customInstruction: this.customInstruction,
          webSources: this.webSources,
          feedSources: this.feedSources,
          inlineCitation: this.inlineCitation,
          mode: this.mode,
        });
        this.close();
      });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
} 