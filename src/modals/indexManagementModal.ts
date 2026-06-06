import { App, Modal, Setting, Notice, setIcon } from 'obsidian';
import { AISettings, CustomEmbeddingModel } from '../settings';

export interface IndexConfig {
    id: string;
    type: 'embedding' | 'bm25';
    name: string;
    model?: string; // For embedding indexes
    enabled: boolean;
    fileCount: number;
    lastUpdated: number;
    isBuilding?: boolean;
    buildProgress?: number; // 0-100
    buildError?: string; // Error message if build failed
}

export class IndexManagementModal extends Modal {
    private settings: AISettings;
    private indexes: IndexConfig[];
    private onSave: (selectedEmbedding: string | null, selectedBM25: string | null) => void;
    private onBuildIndex: (indexId: string, progressCallback: (progress: number) => void) => Promise<void>;
    private selectedEmbeddingId: string | null = null;
    private selectedBM25Id: string | null = null;

    constructor(
        app: App,
        settings: AISettings,
        indexes: IndexConfig[],
        onSave: (selectedEmbedding: string | null, selectedBM25: string | null) => void,
        onBuildIndex: (indexId: string, progressCallback: (progress: number) => void) => Promise<void>
    ) {
        super(app);
        this.settings = settings;
        this.indexes = indexes;
        this.onSave = onSave;
        this.onBuildIndex = onBuildIndex;

        // Reset any stale building states
        for (const index of this.indexes) {
            if (index.isBuilding) {
                index.isBuilding = false;
                index.buildProgress = 0;
            }
        }

        // Set currently selected indexes
        const currentEmbedding = indexes.find(i => i.type === 'embedding' && i.enabled);
        const currentBM25 = indexes.find(i => i.type === 'bm25' && i.enabled);
        this.selectedEmbeddingId = currentEmbedding?.id || null;
        this.selectedBM25Id = currentBM25?.id || null;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('index-management-modal');

        contentEl.createEl('h2', { text: 'Manage Search Indexes' });

        contentEl.createEl('p', {
            text: 'Select one embedding index and one BM25 index for hybrid search. For flash search (@flash), BM25 index must be checked.',
            cls: 'index-modal-description'
        });

        // Create scrollable container for content
        const scrollContainer = contentEl.createDiv({ cls: 'index-modal-scroll-container' });

        // Embedding Indexes Section
        this.renderIndexSection(scrollContainer, 'embedding');

        // BM25 Indexes Section
        this.renderIndexSection(scrollContainer, 'bm25');

        // Add new index button
        this.renderAddIndexButton(scrollContainer);

        // Action buttons (outside scroll container)
        this.renderActionButtons(contentEl);
    }

    private renderIndexSection(containerEl: HTMLElement, type: 'embedding' | 'bm25') {
        const sectionEl = containerEl.createDiv({ cls: 'index-section' });

        const headerEl = sectionEl.createDiv({ cls: 'index-section-header' });
        headerEl.createEl('h3', { text: type === 'embedding' ? 'Embedding Indexes' : 'BM25 Indexes' });

        const indexesOfType = this.indexes.filter(i => i.type === type);

        if (indexesOfType.length === 0) {
            sectionEl.createEl('p', {
                text: `No ${type} indexes found. Create one to get started.`,
                cls: 'index-empty-message'
            });
            return;
        }

        const tableContainer = sectionEl.createDiv({ cls: 'index-table-container' });
        const tableEl = tableContainer.createEl('table', { cls: 'index-table' });
        const theadEl = tableEl.createEl('thead');
        const headerRow = theadEl.createEl('tr');
        headerRow.createEl('th', { text: '' }); // Select
        headerRow.createEl('th', { text: 'Name' });
        if (type === 'embedding') {
            headerRow.createEl('th', { text: 'Model' });
        }
        headerRow.createEl('th', { text: 'Files' });
        headerRow.createEl('th', { text: 'Status' });
        headerRow.createEl('th', { text: '' }); // Actions

        const tbodyEl = tableEl.createEl('tbody');

        for (const index of indexesOfType) {
            const row = tbodyEl.createEl('tr', { attr: { 'data-index-id': index.id } });

            // Checkbox cell
            const checkboxCell = row.createEl('td', { cls: 'index-checkbox-cell' });
            const checkbox = checkboxCell.createEl('input', { type: 'checkbox' });
            checkbox.checked = type === 'embedding'
                ? this.selectedEmbeddingId === index.id
                : this.selectedBM25Id === index.id;
            checkbox.disabled = index.isBuilding || false;

            checkbox.addEventListener('change', () => {
                if (type === 'embedding') {
                    this.selectedEmbeddingId = checkbox.checked ? index.id : null;
                    this.refreshCheckboxes('embedding', index.id);
                } else {
                    this.selectedBM25Id = checkbox.checked ? index.id : null;
                    this.refreshCheckboxes('bm25', index.id);
                }
            });

            // Name cell
            const nameCell = row.createEl('td', { cls: 'index-name-cell', attr: { title: index.name } });
            nameCell.setText(index.name);

            // Model cell (only for embedding)
            if (type === 'embedding') {
                const modelText = index.model || 'Unknown';
                const modelCell = row.createEl('td', { cls: 'index-model-cell', attr: { title: modelText } });
                modelCell.setText(modelText);
            }

            // Files cell
            const filesCell = row.createEl('td', { cls: 'index-files-cell' });
            filesCell.setText(index.fileCount.toString());

            // Status cell (includes last updated, progress bar, and error)
            const statusCell = row.createEl('td', { cls: 'index-status-cell' });

            if (index.buildError) {
                // Show error message
                const errorDiv = statusCell.createDiv({ cls: 'index-error-message' });
                errorDiv.setText(`Error: ${index.buildError}`);
            } else if (index.isBuilding) {
                // Show progress bar
                const progressContainer = statusCell.createDiv({ cls: 'index-progress-container' });
                const progressBar = progressContainer.createDiv({ cls: 'index-progress-bar' });
                const progressFill = progressBar.createDiv({ cls: 'index-progress-fill' });
                progressFill.style.width = `${index.buildProgress || 0}%`;
                const progressText = progressContainer.createDiv({ cls: 'index-progress-text' });
                progressText.setText(`${index.buildProgress || 0}%`);
            } else {
                // Show last updated
                if (index.lastUpdated > 0) {
                    const date = new Date(index.lastUpdated);
                    const timeStr = date.toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                    // Full date for tooltip
                    const fullDateStr = date.toLocaleString();
                    statusCell.setText(timeStr);
                    statusCell.setAttribute('title', fullDateStr);
                } else {
                    statusCell.setText('Not built');
                    statusCell.addClass('index-not-built');
                    statusCell.setAttribute('title', 'Index not yet built');
                }
            }

            // Actions cell
            const actionsCell = row.createEl('td', { cls: 'index-actions-cell' });

            // Build button
            const buildBtn = actionsCell.createEl('button', {
                cls: 'index-action-btn',
                attr: { 'aria-label': 'Build index' }
            });
            if (index.isBuilding) {
                setIcon(buildBtn, 'loader-2');
                buildBtn.addClass('building');
            } else {
                setIcon(buildBtn, 'wrench');
            }
            buildBtn.disabled = index.isBuilding || false;

            buildBtn.addEventListener('click', async () => {
                index.isBuilding = true;
                index.buildProgress = 0;
                index.buildError = undefined;
                this.onOpen(); // Refresh to show progress

                try {
                    await this.onBuildIndex(index.id, (progress: number) => {
                                                index.buildProgress = progress;
                        // Update progress bar in real-time
                        const row = this.contentEl.querySelector(`tr[data-index-id="${index.id}"]`);
                        if (row) {
                            const progressFill = row.querySelector('.index-progress-fill') as HTMLElement;
                            const progressText = row.querySelector('.index-progress-text') as HTMLElement;
                            if (progressFill && progressText) {
                                                                progressFill.style.width = `${progress}%`;
                                progressText.setText(`${progress}%`);
                            } else {
                                                            }
                        } else {
                                                    }
                    });
                    index.buildProgress = 100;
                    new Notice(`${index.name} built successfully`);
                } catch (error) {
                    const err = error as Error;
                    index.buildError = err.message;
                    new Notice(`Failed to build ${index.name}: ${err.message}`);
                } finally {
                    index.isBuilding = false;
                    this.onOpen(); // Refresh to show final state
                }
            });

            // Delete button
            const deleteBtn = actionsCell.createEl('button', {
                cls: 'index-action-btn index-delete-btn',
                attr: { 'aria-label': 'Delete index' }
            });
            setIcon(deleteBtn, 'trash-2');
            deleteBtn.disabled = index.isBuilding || false;

            deleteBtn.addEventListener('click', () => {
                const indexToRemove = this.indexes.findIndex(i => i.id === index.id);
                if (indexToRemove !== -1) {
                    this.indexes.splice(indexToRemove, 1);

                    if (type === 'embedding' && this.selectedEmbeddingId === index.id) {
                        this.selectedEmbeddingId = null;
                    } else if (type === 'bm25' && this.selectedBM25Id === index.id) {
                        this.selectedBM25Id = null;
                    }

                    this.onOpen();
                    new Notice(`${index.name} deleted`);
                }
            });
        }
    }

    private refreshCheckboxes(type: 'embedding' | 'bm25', selectedId: string) {
        // Re-render to update checkboxes
        this.onOpen();
    }

    private renderAddIndexButton(containerEl: HTMLElement) {
        const addSection = containerEl.createDiv({ cls: 'index-add-section' });

        new Setting(addSection)
            .setName('Add New Embedding Index')
            .setDesc('Create a new embedding index with a different model')
            .addButton(btn => btn
                .setButtonText('Add Embedding Index')
                .onClick(() => {
                    this.showAddIndexDialog('embedding');
                })
            );
    }

    private showAddIndexDialog(type: 'embedding' | 'bm25') {
        const dialogEl = this.contentEl.createDiv({ cls: 'index-add-dialog' });
        dialogEl.createEl('h3', { text: `Add New ${type === 'embedding' ? 'Embedding' : 'BM25'} Index` });

        let indexName = '';
        let selectedModel = '';

        new Setting(dialogEl)
            .setName('Index Name')
            .setDesc('Enter a name for this index')
            .addText(text => text
                .setPlaceholder('e.g., Gemini 004 Index')
                .onChange(value => {
                    indexName = value;
                })
            );

        if (type === 'embedding') {
            new Setting(dialogEl)
                .setName('Embedding Model')
                .setDesc('Select the embedding model to use')
                .addDropdown(dropdown => {
                    for (const model of this.settings.customEmbeddingModels) {
                        if (model.enabled) {
                            dropdown.addOption(model.id, model.name);
                        }
                    }
                    dropdown.onChange(value => {
                        selectedModel = value;
                    });
                    selectedModel = dropdown.getValue();
                });
        }

        const buttonContainer = dialogEl.createDiv({ cls: 'index-dialog-buttons' });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => {
            dialogEl.remove();
        });

        const createBtn = buttonContainer.createEl('button', { text: 'Create', cls: 'mod-cta' });
        createBtn.addEventListener('click', () => {
            if (!indexName.trim()) {
                new Notice('Please enter an index name');
                return;
            }

            const newIndex: IndexConfig = {
                id: `${type}-${Date.now()}`,
                type,
                name: indexName,
                model: type === 'embedding' ? selectedModel : undefined,
                enabled: false,
                fileCount: 0,
                lastUpdated: 0
            };

            this.indexes.push(newIndex);
            dialogEl.remove();
            this.onOpen();
            new Notice(`${indexName} created. Click the build button to index your vault.`);
        });
    }

    private renderActionButtons(containerEl: HTMLElement) {
        const buttonContainer = containerEl.createDiv({ cls: 'index-modal-buttons' });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => {
            this.close();
        });

        const saveBtn = buttonContainer.createEl('button', { text: 'Save', cls: 'mod-cta' });
        saveBtn.addEventListener('click', () => {
            this.onSave(this.selectedEmbeddingId, this.selectedBM25Id);
            this.close();
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
