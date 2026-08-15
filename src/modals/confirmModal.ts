import { App, Modal, ButtonComponent } from 'obsidian';

export class ConfirmModal extends Modal {
    private message: string;
    private onConfirm: () => void;
    private onCancel?: () => void;

    constructor(app: App, message: string, onConfirm: () => void, onCancel?: () => void) {
        super(app);
        this.message = message;
        this.onConfirm = onConfirm;
        this.onCancel = onCancel;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('p', { text: this.message });

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        new ButtonComponent(buttonContainer)
            .setButtonText('Cancel')
            .onClick(() => {
                this.onCancel?.();
                this.close();
            });
        new ButtonComponent(buttonContainer)
            .setButtonText('Confirm')
            .setCta()
            .onClick(() => {
                this.onConfirm();
                this.close();
            });
    }

    onClose() {
        this.contentEl.empty();
    }
}

export function showConfirm(app: App, message: string): Promise<boolean> {
    return new Promise((resolve) => {
        new ConfirmModal(
            app,
            message,
            () => resolve(true),
            () => resolve(false)
        ).open();
    });
}
