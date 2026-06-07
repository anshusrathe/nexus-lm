import { App, Modal, Notice, Setting, TFolder } from 'obsidian';

export class YouTubeTranscriptModal extends Modal {
    private fileName: string;
    private folderPath: string;
    private defaultFolder: string;
    private onSubmit: (fileName: string, folderPath: string) => void;
    private videoTitle: string;
    private submitted: boolean = false;

    constructor(
        app: App,
        defaultFolder: string,
        videoTitle: string,
        onSubmit: (fileName: string, folderPath: string) => void
    ) {
        super(app);
        this.defaultFolder = defaultFolder;
        this.videoTitle = videoTitle;
        this.onSubmit = onSubmit;
        
        // Generate default filename from video title
        const sanitizedTitle = this.sanitizeFileName(videoTitle);
        this.fileName = `${sanitizedTitle}-transcript.md`;
        this.folderPath = defaultFolder;
    }

    private sanitizeFileName(title: string): string {
        // Remove invalid characters and limit length
        return title
            .replace(/[\\/:*?"<>|]/g, '-')
            .replace(/\s+/g, '-')
            .substring(0, 100);
    }

    private getAllFolders(): string[] {
        const folders: string[] = ['/'];
        const allFolders = this.app.vault.getAllLoadedFiles()
            .filter(f => f instanceof TFolder) as TFolder[];
        
        allFolders.forEach(folder => {
            folders.push(folder.path);
        });
        
        return folders.sort();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        
        contentEl.createEl('h2', { text: 'Save YouTube Transcript' });
        
        contentEl.createEl('p', {
            text: 'The transcript will be saved as a markdown file and automatically added to your context.',
            cls: 'setting-item-description'
        });

        // File name setting
        new Setting(contentEl)
            .setName('File Name')
            .setDesc('Name for the transcript file (without extension)')
            .addText(text => {
                text.setValue(this.fileName.replace('.md', ''))
                    .onChange(value => {
                        this.fileName = value.endsWith('.md') ? value : `${value}.md`;
                    });
                text.inputEl.setCssProps({ 'width':  '100%' });
            });

        // Folder selection setting
        const folders = this.getAllFolders();
        new Setting(contentEl)
            .setName('Save Location')
            .setDesc('Folder where the transcript will be saved')
            .addDropdown(dropdown => {
                folders.forEach(folder => {
                    dropdown.addOption(folder, folder === '/' ? 'Root' : folder);
                });
                dropdown.setValue(this.folderPath)
                    .onChange(value => {
                        this.folderPath = value;
                    });
            });

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        
        const saveButton = buttonContainer.createEl('button', {
            text: 'Save & Add to Context',
            cls: 'mod-cta'
        });
        saveButton.addEventListener('click', () => {
            if (!this.fileName || this.fileName.trim() === '') {
                new Notice('Please enter a file name');
                return;
            }
            this.submitted = true;
            this.onSubmit(this.fileName, this.folderPath);
            this.close();
        });

        const cancelButton = buttonContainer.createEl('button', {
            text: 'Cancel'
        });
        cancelButton.addEventListener('click', () => {
            this.close();
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        
        // If modal was closed without submitting, we don't call onSubmit
        // The promise in responseView will handle this via the overridden onClose
    }
}
