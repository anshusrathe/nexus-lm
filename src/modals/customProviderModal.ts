import { App, Modal, Setting, ButtonComponent, Notice } from 'obsidian';
import { CustomProviderConfig } from '../settings';

export class CustomProviderModal extends Modal {
    private provider: CustomProviderConfig;
    private onSubmit: (provider: CustomProviderConfig) => void;
    private isEdit: boolean;

    constructor(app: App, onSubmit: (provider: CustomProviderConfig) => void, initialProvider?: CustomProviderConfig) {
        super(app);
        this.onSubmit = onSubmit;
        this.isEdit = !!initialProvider;
        this.provider = initialProvider ? { ...initialProvider } : {
            id: '',
            name: '',
            baseUrl: '',
            apiKey: ''
        };
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        
        contentEl.createEl('h2', { text: this.isEdit ? 'Edit Custom Provider' : 'Add Custom Provider' });

        new Setting(contentEl)
            .setName('Provider Name')
            .setDesc('A friendly name for this provider (e.g., Together AI)')
            .addText(text => text
                .setPlaceholder('Enter name')
                .setValue(this.provider.name)
                .onChange(value => {
                    this.provider.name = value;
                    if (!this.isEdit) {
                        // Generate ID from name if it's a new provider
                        this.provider.id = value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                    }
                }));

        if (this.isEdit) {
            new Setting(contentEl)
                .setName('Provider ID')
                .setDesc('The unique identifier for this provider')
                .addText(text => text
                    .setValue(this.provider.id)
                    .setDisabled(true));
        }

        new Setting(contentEl)
            .setName('Base URL')
            .setDesc('The API base URL (e.g., https://api.together.xyz/v1)')
            .addText(text => text
                .setPlaceholder('https://api.example.com/v1')
                .setValue(this.provider.baseUrl)
                .onChange(value => {
                    this.provider.baseUrl = value;
                }));

        new Setting(contentEl)
            .setName('API Key')
            .setDesc('Your API key for this provider')
            .addText(text => {
                text.setPlaceholder('Enter API key')
                    .setValue(this.provider.apiKey)
                    .onChange(value => {
                        this.provider.apiKey = value;
                    });
                text.inputEl.type = 'password';
            });

        new Setting(contentEl)
            .setName('Enable Embeddings')
            .setDesc('Enable vector embeddings for this provider (requires /embeddings endpoint)')
            .addToggle(toggle => toggle
                .setValue(!!this.provider.enableEmbeddings)
                .onChange(value => {
                    this.provider.enableEmbeddings = value;
                }));

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        buttonContainer.setCssStyles({
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '10px',
            marginTop: '20px'
        });

        new ButtonComponent(buttonContainer)
            .setButtonText('Cancel')
            .onClick(() => this.close());

        new ButtonComponent(buttonContainer)
            .setButtonText(this.isEdit ? 'Save Changes' : 'Add Provider')
            .setCta()
            .onClick(() => {
                if (!this.provider.name.trim()) {
                    new Notice('Provider name cannot be empty.');
                    return;
                }
                if (!this.provider.baseUrl.trim()) {
                    new Notice('Base URL cannot be empty.');
                    return;
                }
                if (!this.provider.id.trim()) {
                    new Notice('Provider ID cannot be empty.');
                    return;
                }
                this.onSubmit(this.provider);
                this.close();
            });
    }
}
