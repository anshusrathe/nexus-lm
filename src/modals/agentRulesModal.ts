import { App, Modal, normalizePath } from 'obsidian';

const RULES_DIR = '.Nexus-LM-data/rules';
const RULES_FILE = 'AGENT_RULES.md';

/**
 * Modal to display and edit AGENT_RULES.md in real time.
 */
export class AgentRulesModal extends Modal {
  private textareaEl: HTMLTextAreaElement | null = null;

  constructor(app: App) {
    super(app);
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('agent-rules-modal');

    // Header
    const headerContainer = contentEl.createDiv({ cls: 'agent-rules-modal-header' });
    headerContainer.createEl('h2', { text: 'Agent rules (AGENT_RULES.md)' });
    contentEl.createEl('p', {
      text: 'Set custom behavior instructions for the agent. Changes are saved automatically in real-time.',
      cls: 'setting-item-description'
    });

    const textareaContainer = contentEl.createDiv({ cls: 'agent-rules-textarea-container' });
    this.textareaEl = textareaContainer.createEl('textarea', {
      cls: 'agent-rules-textarea',
      attr: {
        placeholder: 'Enter agent rules here...',
        rows: '15'
      }
    });
    this.textareaEl.style.width = '100%';
    this.textareaEl.style.minHeight = '300px';
    this.textareaEl.style.resize = 'vertical';
    this.textareaEl.style.fontFamily = 'var(--font-monospace)';
    this.textareaEl.style.padding = '10px';
    this.textareaEl.style.boxSizing = 'border-box';

    // Load initial rules content
    const initialContent = await this.readRulesFile();
    this.textareaEl.value = initialContent;

    // Save changes in real time on input
    this.textareaEl.addEventListener('input', () => {
      void this.saveRulesFile(this.textareaEl?.value || '');
    });

    // Close button
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    buttonContainer.style.marginTop = '15px';
    const closeBtn = buttonContainer.createEl('button', { text: 'Close', cls: 'mod-cta' });
    closeBtn.addEventListener('click', () => this.close());
  }

  private async readRulesFile(): Promise<string> {
    try {
      const filePath = normalizePath(`${RULES_DIR}/${RULES_FILE}`);
      const adapter = this.app.vault.adapter;
      const exists = await adapter.exists(filePath);
      if (!exists) return '';
      return await adapter.read(filePath);
    } catch {
      return '';
    }
  }

  private async saveRulesFile(content: string): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      const dirPath = normalizePath(RULES_DIR);
      const filePath = normalizePath(`${RULES_DIR}/${RULES_FILE}`);
      if (!(await adapter.exists(dirPath))) {
        await adapter.mkdir(dirPath);
      }
      await adapter.write(filePath, content);
    } catch (err) {
      console.error('Failed to save AGENT_RULES.md', err);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
