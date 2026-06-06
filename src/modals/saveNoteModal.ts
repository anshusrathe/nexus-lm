import { App, Modal, Setting, TFile, TFolder, ButtonComponent, Notice, normalizePath } from 'obsidian';
import { AISettings } from '../settings';

export class SaveNoteModal extends Modal {
    private fileName: string;
    private directory: string;
    private templatePath: string | null = null;
    private onSubmit: (fileName: string, directory: string, templatePath: string | null) => void;
    private pluginSettings: AISettings;

    constructor(app: App, defaultFileName: string, defaultDirectory: string, settings: AISettings, onSubmit: (fileName: string, directory: string, templatePath: string | null) => void) {
        super(app);
        this.fileName = defaultFileName;
        this.directory = defaultDirectory;
        this.onSubmit = onSubmit;
        this.pluginSettings = settings;
        this.modalEl.addClass('save-note-modal');
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('save-note-modal-content');

        contentEl.createEl('h2', { text: 'Save Note' });

        new Setting(contentEl)
            .setName('File Name')
            .setDesc('Enter the name for your note file (e.g., My AI Chat.md)')
            .addText(text => text
                .setPlaceholder('Enter file name')
                .setValue(this.fileName)
                .onChange(value => {
                    this.fileName = value;
                }));

        new Setting(contentEl)
            .setName('Directory')
            .setDesc('Enter the directory to save the note in (e.g., AI-Tutor or Notes/AI-Tutor)')
            .addText(text => text
                .setPlaceholder('AI-Tutor')
                .setValue(this.directory)
                .onChange(value => {
                    this.directory = value;
                }));

        // Template selection
        if (this.pluginSettings.templateFolder) {
            new Setting(contentEl)
                .setName('Template')
                .setDesc('Select a template for your new note')
                .addDropdown(drop => {
                    drop.addOption('', 'None');
                    
                    const templateFolder = this.app.vault.getAbstractFileByPath(this.pluginSettings.templateFolder);
                    if (templateFolder instanceof TFolder) {
                        const templates = templateFolder.children.filter(f => f instanceof TFile && f.extension === 'md') as TFile[];
                        templates.forEach(template => {
                            drop.addOption(template.path, template.name);
                        });
                    }
                    
                    drop.setValue('')
                        .onChange(value => {
                            this.templatePath = value || null;
                        });
                });
        }

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        new ButtonComponent(buttonContainer)
            .setButtonText('Cancel')
            .onClick(() => this.close());

        new ButtonComponent(buttonContainer)
            .setButtonText('Save')
            .setCta()
            .onClick(() => {
                const normalizedDir = this.directory.trim().replace(/^\/+|\/+$/g, '');
                const fileNameWithExt = this.fileName.endsWith('.md') ? this.fileName : `${this.fileName}.md`;

                if (!fileNameWithExt.trim()) {
                    new Notice('File name cannot be empty.');
                    return;
                }
                if (!this.validatePath(normalizedDir) && normalizedDir !== '') {
                    new Notice('Invalid directory path.');
                    return;
                }
                this.onSubmit(fileNameWithExt, normalizedDir, this.templatePath);
                this.close();
            });
    }

    private validatePath(path: string): boolean {
        // Simple validation: should not contain '..' or invalid characters
        if (path.includes('..') || /[<>:"|?*\x00-\x1F]/g.test(path)) {
            return false;
        }
        return true;
    }
}
