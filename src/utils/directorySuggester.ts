import { App, TFolder } from 'obsidian';

export class DirectorySuggester {
    private input!: HTMLInputElement;
    private suggestionsEl!: HTMLDivElement;
    private folders: TFolder[];
    private suggestionsVisible: boolean = false;
    private onSelect: (path: string) => void;

    constructor(
        private app: App,
        private container: HTMLElement,
        onSelect: (path: string) => void,
        initialPath: string = ''
    ) {
        this.folders = app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder) as TFolder[];
        this.onSelect = onSelect;
        this.setupInputField(initialPath);
    }

    private setupInputField(initialPath: string) {
        const inputContainer = this.container.createDiv({ cls: 'directory-input-container' });
        this.input = inputContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search or type folder path...'
        });
        this.input.value = initialPath;
        this.suggestionsEl = inputContainer.createDiv({ cls: 'directory-suggestions' });
        this.suggestionsEl.hide();

        this.input.addEventListener('input', () => this.onInputChange());
        this.input.addEventListener('focus', () => this.onInputChange());
        this.input.addEventListener('blur', () => {
            setTimeout(() => this.suggestionsEl.hide(), 100);
        });

        if (initialPath) {
            setTimeout(() => this.onInputChange(), 0);
        }
    }

    private onInputChange() {
        const value = this.input.value.toLowerCase();
        this.suggestionsEl.empty();
        this.suggestionsVisible = true;

        const matchedFolders = this.folders.filter(folder =>
            folder.path.toLowerCase().includes(value)
        );

        matchedFolders.sort((a, b) => a.path.localeCompare(b.path));

        if (matchedFolders.length === 0 && value.length > 0) {
            this.suggestionsEl.hide();
            return;
        }

        matchedFolders.forEach(folder => {
            const suggestion = this.suggestionsEl.createDiv({ cls: 'directory-suggestion' });
            suggestion.setText(folder.path);

            suggestion.addEventListener('mousedown', (e) => {
                e.preventDefault();
            });

            suggestion.onClickEvent(() => {
                this.selectDirectory(folder.path);
            });
        });

        if (matchedFolders.length > 0) {
            this.suggestionsEl.show();
        } else {
            this.suggestionsEl.hide();
        }
    }

    private selectDirectory(path: string) {
        this.input.value = path;
        this.onSelect(path);
        this.suggestionsEl.hide();
        this.suggestionsVisible = false;
    }

    getValue(): string {
        return this.input.value.trim();
    }

    refreshFolders() {
        this.folders = this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder) as TFolder[];
    }
}
