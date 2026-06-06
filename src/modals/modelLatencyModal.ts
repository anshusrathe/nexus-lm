import { App, Modal, setIcon } from 'obsidian';
import { CustomModel } from '../settings';

/**
 * Modal to display models for a specific provider sorted by their last verification latency.
 */
export class ModelLatencyModal extends Modal {
  private providerId: string;
  private models: CustomModel[];

  constructor(app: App, providerId: string, models: CustomModel[]) {
    super(app);
    this.providerId = providerId;
    this.models = models;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
    // Header
    const headerContainer = contentEl.createDiv({ cls: 'latency-modal-header' });
    const title = headerContainer.createEl('h2', { text: `Model Latencies: ${this.providerId}` });
    
    // Sort and filter models
    const latencyModels = this.models
      .filter(m => m.verificationStatus === 'verified' && m.verificationLatency !== undefined)
      .sort((a, b) => (a.verificationLatency || 0) - (b.verificationLatency || 0));

    if (latencyModels.length === 0) {
      contentEl.createEl('p', { text: 'No verified models with latency data available for this provider. Please run "Verify models" first.' });
      return;
    }

    // Info description
    contentEl.createEl('p', { 
        text: 'Models are ranked from fastest to slowest based on the Time-To-First-Token (TTFT) recorded during the last verification.',
        cls: 'latency-modal-description'
    });

    const table = contentEl.createEl('table', { cls: 'latency-table' });
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    headerRow.createEl('th', { text: 'Rank' });
    headerRow.createEl('th', { text: 'Model Name' });
    headerRow.createEl('th', { text: 'Model ID' });
    headerRow.createEl('th', { text: 'Latency (TTFT)' });

    const tbody = table.createEl('tbody');
    latencyModels.forEach((model, index) => {
      const row = tbody.createEl('tr');
      
      // Rank with optional gold/silver/bronze icons
      const rankCell = row.createEl('td', { cls: 'latency-rank-cell' });
      if (index === 0) {
          const iconSpan = rankCell.createSpan({ cls: 'latency-rank-icon rank-1' });
          setIcon(iconSpan, 'award');
          rankCell.appendText(' 1');
      } else {
          rankCell.setText((index + 1).toString());
      }
      
      row.createEl('td', { text: model.name, cls: 'latency-model-name' });
      row.createEl('td', { text: model.id, cls: 'latency-model-id' });
      
      const latencyCell = row.createEl('td', { 
          text: `${model.verificationLatency}ms`, 
          cls: 'latency-value-cell' 
      });

      // Color coding based on latency
      if ((model.verificationLatency || 0) < 500) {
          latencyCell.addClass('latency-fast');
      } else if ((model.verificationLatency || 0) < 1500) {
          latencyCell.addClass('latency-medium');
      } else {
          latencyCell.addClass('latency-slow');
      }
    });

    // Close button
    const buttonContainer = contentEl.createDiv({ cls: 'latency-modal-buttons' });
    const closeBtn = buttonContainer.createEl('button', { text: 'Close' });
    closeBtn.addEventListener('click', () => this.close());
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
