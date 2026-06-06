import { App, Modal, setIcon } from 'obsidian';
import { AISettings } from '../settings';
import { EmbeddingsManager } from '../managers/embeddingsManager';

interface IndexConfig {
    id: string;
    type: 'embedding' | 'bm25';
    name: string;
    model?: string;
    enabled: boolean;
    fileCount: number;
    lastUpdated: number;
}

export class IndexStatusModal extends Modal {
    private settings: AISettings;
    private embeddingsManager: EmbeddingsManager;

    // All indexes split by type
    private embeddingIndexes: IndexConfig[] = [];
    private bm25Indexes: IndexConfig[] = [];

    // Navigation state
    private allEntries: { type: 'embedding' | 'bm25'; config: IndexConfig }[] = [];
    private currentIdx: number = 0;

    // DOM refs for navigation
    private navLabel!: HTMLElement;
    private prevBtn!: HTMLButtonElement;
    private nextBtn!: HTMLButtonElement;
    private contentArea!: HTMLElement;

    constructor(app: App, settings: AISettings, embeddingsManager: EmbeddingsManager) {
        super(app);
        this.settings = settings;
        this.embeddingsManager = embeddingsManager;
        this.modalEl.addClass('index-status-modal');
    }

    onOpen() {
        const configs: IndexConfig[] = this.settings.indexConfigurations || [];
        this.embeddingIndexes = configs.filter(c => c.type === 'embedding');
        this.bm25Indexes = configs.filter(c => c.type === 'bm25');

        // Build ordered navigation list: embeddings first, then BM25
        this.allEntries = [
            ...this.embeddingIndexes.map(c => ({ type: 'embedding' as const, config: c })),
            ...this.bm25Indexes.map(c => ({ type: 'bm25' as const, config: c })),
        ];

        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('index-status-modal-content');

        if (this.allEntries.length === 0) {
            contentEl.createEl('p', {
                text: 'No index configurations found. Create an index in Settings → Index Management.',
                cls: 'index-status-empty'
            });
            return;
        }

        this.buildHeader(contentEl);
        this.contentArea = contentEl.createDiv({ cls: 'index-status-body' });
        this.renderPage(this.findSelectedIndex());
    }

    onClose() {
        this.contentEl.empty();
    }

    // ── Find the currently selected index from settings ──────────────────────

    private findSelectedIndex(): number {
        if (this.settings.selectedEmbeddingIndexId) {
            const idx = this.allEntries.findIndex(
                e => e.config.id === this.settings.selectedEmbeddingIndexId
            );
            if (idx !== -1) return idx;
        }
        if (this.settings.selectedBM25IndexId) {
            const idx = this.allEntries.findIndex(
                e => e.config.id === this.settings.selectedBM25IndexId
            );
            if (idx !== -1) return idx;
        }
        return 0;
    }

    // ── Header with navigation ──────────────────────────────────────────────

    private buildHeader(parent: HTMLElement) {
        const header = parent.createDiv({ cls: 'index-status-header' });

        // Left: nav controls
        const nav = header.createDiv({ cls: 'index-status-nav' });

        this.prevBtn = nav.createEl('button', { cls: 'index-status-nav-btn', attr: { 'aria-label': 'Previous index' } });
        setIcon(this.prevBtn, 'chevron-left');
        this.prevBtn.addEventListener('click', () => this.navigate(-1));

        this.navLabel = nav.createSpan({ cls: 'index-status-nav-label' });

        this.nextBtn = nav.createEl('button', { cls: 'index-status-nav-btn', attr: { 'aria-label': 'Next index' } });
        setIcon(this.nextBtn, 'chevron-right');
        this.nextBtn.addEventListener('click', () => this.navigate(1));

        // Right: title
        header.createDiv({ cls: 'index-status-title', text: 'Index Status' });
    }

    private navigate(delta: number) {
        const next = this.currentIdx + delta;
        if (next < 0 || next >= this.allEntries.length) return;
        this.renderPage(next);
    }

    // ── Page renderer ───────────────────────────────────────────────────────

    private renderPage(idx: number) {
        this.currentIdx = idx;
        const entry = this.allEntries[idx];

        // Update nav label & button states
        this.navLabel.textContent = `${idx + 1} / ${this.allEntries.length}`;
        this.prevBtn.disabled = idx === 0;
        this.nextBtn.disabled = idx === this.allEntries.length - 1;

        // Clear and rebuild content area
        this.contentArea.empty();
        this.contentArea.createDiv({ cls: 'index-status-loading', text: 'Loading…' });

        // Async load then render
        this.loadAndRender(entry.config, entry.type);
    }

    private async loadAndRender(config: IndexConfig, type: 'embedding' | 'bm25') {
        const allVaultFiles = this.app.vault.getMarkdownFiles();

        // Non-excluded files for this index
        const includedFiles = allVaultFiles.filter(
            f => !this.embeddingsManager.isFileExcluded(f.path, type === 'embedding' ? config.id : undefined)
        );
        const totalIncluded = includedFiles.length;

        // Indexed files
        const indexedPaths = new Set(await this.embeddingsManager.getIndexedFilesForId(config.id));
        // Include empty/no-content files so the count matches total eligible files
        for (const f of includedFiles) {
            if (!indexedPaths.has(f.path) && (f.stat?.size || 0) === 0) {
                indexedPaths.add(f.path);
            }
        }
        const indexedCount = indexedPaths.size;

        // Non-indexed = included but not in index
        const nonIndexed = includedFiles
            .filter(f => !indexedPaths.has(f.path))
            .map(f => f.path)
            .sort();

        const pct = totalIncluded > 0 ? Math.round((indexedCount / totalIncluded) * 100) : 0;
        const isSelected =
            type === 'embedding'
                ? this.settings.selectedEmbeddingIndexId === config.id
                : this.settings.selectedBM25IndexId === config.id;

        // Clear loading state
        this.contentArea.empty();

        // ── Index identity card ──
        const card = this.contentArea.createDiv({ cls: 'index-status-card' });

        // Type badge + selected badge
        const badges = card.createDiv({ cls: 'index-status-badges' });
        badges.createSpan({
            cls: `index-status-badge index-status-badge-${type}`,
            text: type === 'embedding' ? 'Embedding' : 'BM25'
        });
        if (isSelected) {
            badges.createSpan({ cls: 'index-status-badge index-status-badge-selected', text: 'Active' });
        }

        card.createDiv({ cls: 'index-status-index-name', text: config.name });

        if (config.model) {
            card.createDiv({ cls: 'index-status-meta', text: `Model: ${config.model}` });
        }
        if (config.lastUpdated) {
            card.createDiv({
                cls: 'index-status-meta',
                text: `Last updated: ${new Date(config.lastUpdated).toLocaleString()}`
            });
        }

        // ── Progress bar ──
        const progressSection = this.contentArea.createDiv({ cls: 'index-status-progress-section' });
        const progressHeader = progressSection.createDiv({ cls: 'index-status-progress-header' });
        progressHeader.createSpan({ text: 'Coverage' });
        progressHeader.createSpan({ text: `${indexedCount} / ${totalIncluded} files (${pct}%)` });

        const track = progressSection.createDiv({ cls: 'index-status-progress-track' });
        const fill = track.createDiv({ cls: 'index-status-progress-fill' });
        fill.style.width = `${pct}%`;
        if (pct === 100) fill.addClass('index-status-progress-fill-complete');

        // ── Indexed files list ──
        const indexedSection = this.contentArea.createDiv({ cls: 'index-status-list-section' });
        const indexedHeader = indexedSection.createDiv({ cls: 'index-status-list-header' });
        indexedHeader.createSpan({ text: `Indexed (${indexedCount})` });

        if (indexedCount === 0) {
            indexedSection.createDiv({ cls: 'index-status-none-indexed', text: 'No files indexed yet' });
        } else {
            const indexedList = indexedSection.createDiv({ cls: 'index-status-file-list' });
            [...indexedPaths].sort().forEach(path => {
                indexedList.createDiv({ cls: 'index-status-file-row', text: path });
            });
        }

        // ── Non-indexed files list ──
        const listSection = this.contentArea.createDiv({ cls: 'index-status-list-section' });

        if (nonIndexed.length === 0) {
            listSection.createDiv({ cls: 'index-status-all-indexed', text: '✓ All included files are indexed' });
        } else {
            const listHeader = listSection.createDiv({ cls: 'index-status-list-header' });
            listHeader.createSpan({ text: `Not yet indexed (${nonIndexed.length})` });

            const fileList = listSection.createDiv({ cls: 'index-status-file-list' });
            nonIndexed.forEach(path => {
                fileList.createDiv({ cls: 'index-status-file-row', text: path });
            });
        }
    }
}
