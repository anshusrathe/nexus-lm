import { App, Modal } from 'obsidian';
import { MCPRegistryEntry, MCPEnvVarSpec, MCPPathSpec, MCP_REGISTRY } from '../mcp/mcpRegistry';

/**
 * Substitutes all pathSpec placeholders in an entry's args array.
 * All paths come from the resolvedPaths map (user-provided values from the wizard).
 * The isVaultPath flag is only used to pre-fill the input as a convenience —
 * the user's actual typed value is always used here, never auto-substituted.
 */
export function resolvePathArgs(
  entry: MCPRegistryEntry,
  app: App,
  resolvedPaths: Record<string, string> = {}
): string[] {
  if (!entry.args || !entry.pathSpecs?.length) return entry.args ?? [];

  return entry.args.map(arg => {
    const spec = entry.pathSpecs!.find(s => s.argPlaceholder === arg);
    if (!spec) return arg;
    // Always use the user-provided value; fall back to placeholder if nothing was entered
    return resolvedPaths[spec.argPlaceholder] || arg;
  });
}

/**
 * MCPRegistryModal
 * Lets users browse a curated catalog of popular MCP servers and auto-fill
 * the Add MCP Server form — including guided prompts for required env vars.
 */
export class MCPRegistryModal extends Modal {
  private onSelect: (entry: MCPRegistryEntry, resolvedEnv: Record<string, string>, resolvedArgs?: string[]) => void;
  private searchQuery = '';
  private listContainer!: HTMLElement;

  constructor(
    app: App,
    onSelect: (entry: MCPRegistryEntry, resolvedEnv: Record<string, string>, resolvedArgs?: string[]) => void
  ) {
    super(app);
    this.onSelect = onSelect;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mcp-registry-modal');

    contentEl.createEl('h2', { text: '🔌 MCP Server Catalog' });
    contentEl.createEl('p', {
      text: 'Pick a server from the catalog and we\'ll auto-fill the configuration for you.',
      cls: 'mcp-registry-subtitle',
    });

    // Search bar
    const searchRow = contentEl.createDiv({ cls: 'mcp-registry-search-row' });
    const searchInput = searchRow.createEl('input', {
      type: 'text',
      placeholder: 'Search servers...',
      cls: 'mcp-registry-search',
    });
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value.toLowerCase();
      this.renderList();
    });

    // Server list
    this.listContainer = contentEl.createDiv({ cls: 'mcp-registry-list' });
    this.renderList();

    // Footer
    const footer = contentEl.createDiv({ cls: 'mcp-registry-footer' });
    footer.createEl('span', {
      text: 'Don\'t see your server? Use "Add MCP Server" to configure it manually.',
      cls: 'mcp-registry-footer-text',
    });
  }

  private renderList(): void {
    this.listContainer.empty();

    const filtered = MCP_REGISTRY.filter(entry => {
      const matchesSearch =
        !this.searchQuery ||
        entry.name.toLowerCase().includes(this.searchQuery) ||
        entry.description.toLowerCase().includes(this.searchQuery) ||
        entry.category.toLowerCase().includes(this.searchQuery);
      return matchesSearch;
    });

    if (filtered.length === 0) {
      this.listContainer.createEl('p', {
        text: 'No servers match your search.',
        cls: 'mcp-registry-empty',
      });
      return;
    }

    filtered.forEach(entry => {
      const card = this.listContainer.createDiv({ cls: 'mcp-registry-card' });

      const cardHeader = card.createDiv({ cls: 'mcp-registry-card-header' });
      cardHeader.createEl('span', { text: entry.name, cls: 'mcp-registry-card-name' });
      const badge = cardHeader.createEl('span', {
        text: entry.transport.toUpperCase(),
        cls: `mcp-registry-badge mcp-badge-${entry.transport}`,
      });
      const catBadge = cardHeader.createEl('span', {
        text: entry.category,
        cls: 'mcp-registry-badge mcp-badge-category',
      });

      card.createEl('p', { text: entry.description, cls: 'mcp-registry-card-desc' });

      // Show command preview for stdio
      if (entry.transport === 'stdio' && entry.command) {
        const cmdPreview = [entry.command, ...(entry.args || [])].join(' ');
        card.createEl('code', { text: cmdPreview, cls: 'mcp-registry-cmd-preview' });
      }

      // Path requirements indicator
      if (entry.pathSpecs && entry.pathSpecs.some(p => p.isVaultPath)) {
        const vaultHint = card.createDiv({ cls: 'mcp-registry-env-hint' });
        vaultHint.createEl('span', { text: '📁 Vault path: ', cls: 'mcp-registry-env-hint-label' });
        vaultHint.createEl('span', { text: 'auto-filled from your current vault', cls: 'mcp-registry-env-hint-keys' });
      } else if (entry.pathSpecs && entry.pathSpecs.length > 0) {
        const pathHint = card.createDiv({ cls: 'mcp-registry-env-hint' });
        pathHint.createEl('span', { text: '📂 Needs path: ', cls: 'mcp-registry-env-hint-label' });
        pathHint.createEl('span', {
          text: entry.pathSpecs.map(p => p.label).join(', '),
          cls: 'mcp-registry-env-hint-keys',
        });
      }

      // Env var requirements indicator
      if (entry.envVarSpecs && entry.envVarSpecs.length > 0) {
        const required = entry.envVarSpecs.filter(e => e.required);
        const hint = card.createDiv({ cls: 'mcp-registry-env-hint' });
        hint.createEl('span', {
          text: `🔑 Requires ${required.length} API key${required.length !== 1 ? 's' : ''}: `,
          cls: 'mcp-registry-env-hint-label',
        });
        hint.createEl('span', {
          text: required.map(e => e.label).join(', '),
          cls: 'mcp-registry-env-hint-keys',
        });
      } else if (!entry.pathSpecs?.length) {
        card.createEl('span', { text: '✓ No API key needed', cls: 'mcp-registry-no-key' });
      }

      const needsWizard = (entry.envVarSpecs && entry.envVarSpecs.length > 0) ||
                          (entry.pathSpecs && entry.pathSpecs.length > 0);

      const addBtn = card.createEl('button', { text: 'Configure →', cls: 'mod-cta mcp-registry-add-btn' });
      addBtn.addEventListener('click', () => {
        this.close();
        this.openEnvVarWizard(entry);
      });

      if (entry.docsUrl) {
        const docsLink = card.createEl('a', { text: 'Docs ↗', cls: 'mcp-registry-docs-link' });
        docsLink.href = entry.docsUrl;
        docsLink.target = '_blank';
        docsLink.rel = 'noopener noreferrer';
      }
    });
  }

  /**
   * Opens a guided wizard to collect required env vars and path args before auto-filling the form.
   */
  private openEnvVarWizard(entry: MCPRegistryEntry): void {
    const wizard = new MCPEnvVarWizard(this.app, entry, (resolvedEnv, resolvedArgs) => {
      this.onSelect(entry, resolvedEnv, resolvedArgs);
    });
    wizard.open();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * MCPEnvVarWizard
 * Guides the user through filling in required environment variables AND
 * path arguments for a specific MCP server.
 * Vault paths are auto-detected and shown as read-only with an override option.
 */
class MCPEnvVarWizard extends Modal {
  private entry: MCPRegistryEntry;
  private onComplete: (env: Record<string, string>, resolvedArgs: string[]) => void;
  private envInputs: Map<string, HTMLInputElement> = new Map();
  private pathInputs: Map<string, HTMLInputElement> = new Map(); // argPlaceholder -> input

  constructor(
    app: App,
    entry: MCPRegistryEntry,
    onComplete: (env: Record<string, string>, resolvedArgs: string[]) => void
  ) {
    super(app);
    this.entry = entry;
    this.onComplete = onComplete;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mcp-env-wizard');

    contentEl.createEl('h2', { text: `Configure: ${this.entry.name}` });
    contentEl.createEl('p', {
      text: 'Review the settings below before adding this server.',
      cls: 'mcp-wizard-subtitle',
    });

    // ── Path fields ────────────────────────────────────────────────────────
    const pathSpecs = this.entry.pathSpecs || [];
    if (pathSpecs.length > 0) {
      contentEl.createEl('h3', { text: 'Paths', cls: 'mcp-wizard-section-title' });

      const vaultPath = (this.app.vault.adapter as any).basePath as string | undefined;

      pathSpecs.forEach((spec: MCPPathSpec) => {
        const fieldGroup = contentEl.createDiv({ cls: 'mcp-wizard-field' });

        const labelRow = fieldGroup.createDiv({ cls: 'mcp-wizard-label-row' });
        labelRow.createEl('label', { text: spec.label, cls: 'mcp-wizard-label' });
        if (!spec.required) {
          labelRow.createEl('span', { text: ' (optional)', cls: 'mcp-wizard-optional' });
        }
        if (spec.isVaultPath) {
          labelRow.createEl('span', { text: ' — auto-filled', cls: 'mcp-wizard-auto-badge' });
        }

        fieldGroup.createEl('p', { text: spec.description, cls: 'mcp-wizard-desc' });

        if (spec.isFilePath && spec.fileExtension) {
          fieldGroup.createEl('p', {
            text: `Expected file type: ${spec.fileExtension}`,
            cls: 'mcp-wizard-desc mcp-wizard-desc-hint',
          });
        }

        const autoValue = spec.isVaultPath && vaultPath ? vaultPath : '';
        const input = fieldGroup.createEl('input', {
          type: 'text',
          placeholder: spec.isVaultPath ? (vaultPath || '/path/to/your/vault') : spec.argPlaceholder,
          cls: 'mcp-wizard-input mcp-wizard-path-input',
          attr: { 'data-placeholder': spec.argPlaceholder },
        });
        input.value = autoValue;

        if (spec.isVaultPath && autoValue) {
          input.classList.add('mcp-wizard-input-autofilled');
          const note = fieldGroup.createEl('span', {
            text: '✓ Detected from your current vault. Edit if needed.',
            cls: 'mcp-wizard-autofill-note',
          });
        }

        this.pathInputs.set(spec.argPlaceholder, input);
      });
    }

    // ── Env var fields ─────────────────────────────────────────────────────
    const envSpecs = this.entry.envVarSpecs || [];
    if (envSpecs.length > 0) {
      contentEl.createEl('h3', { text: 'Credentials', cls: 'mcp-wizard-section-title' });

      envSpecs.forEach((spec: MCPEnvVarSpec) => {
        const fieldGroup = contentEl.createDiv({ cls: 'mcp-wizard-field' });

        const labelRow = fieldGroup.createDiv({ cls: 'mcp-wizard-label-row' });
        const label = labelRow.createEl('label', {
          text: spec.label,
          cls: 'mcp-wizard-label',
        });
        if (!spec.required) {
          labelRow.createEl('span', { text: ' (optional)', cls: 'mcp-wizard-optional' });
        }

        fieldGroup.createEl('p', { text: spec.description, cls: 'mcp-wizard-desc' });

        if (spec.link) {
          const linkRow = fieldGroup.createDiv({ cls: 'mcp-wizard-link-row' });
          linkRow.createEl('span', { text: '→ ' });
          const a = linkRow.createEl('a', { text: 'Get your key here ↗', cls: 'mcp-wizard-link' });
          a.href = spec.link;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        }

        const isSecret = spec.key.toLowerCase().includes('secret') ||
                         spec.key.toLowerCase().includes('token') ||
                         spec.key.toLowerCase().includes('key');
        const input = fieldGroup.createEl('input', {
          type: isSecret ? 'password' : 'text',
          placeholder: spec.placeholder,
          cls: 'mcp-wizard-input',
          attr: { 'data-key': spec.key },
        });
        label.setAttribute('for', `mcp-wizard-${spec.key}`);
        input.id = `mcp-wizard-${spec.key}`;
        this.envInputs.set(spec.key, input);
      });
    }

    // ── Buttons ────────────────────────────────────────────────────────────
    const btnRow = contentEl.createDiv({ cls: 'mcp-wizard-buttons' });

    const backBtn = btnRow.createEl('button', { text: '← Back to Catalog' });
    backBtn.addEventListener('click', () => {
      this.close();
      const registry = new MCPRegistryModal(this.app, (_entry, resolvedEnv, resolvedArgs) => {
        this.onComplete(resolvedEnv, resolvedArgs ?? []);
      });
      registry.open();
    });

    const confirmBtn = btnRow.createEl('button', { text: 'Add Server', cls: 'mod-cta' });
    confirmBtn.addEventListener('click', () => this.handleConfirm());
  }

  private handleConfirm(): void {
    // Validate & collect env vars
    const env: Record<string, string> = { ...(this.entry.staticEnv || {}) };
    for (const spec of (this.entry.envVarSpecs || [])) {
      const input = this.envInputs.get(spec.key);
      const value = input?.value.trim() || '';
      if (spec.required && !value) {
        this.markError(input, `${spec.label} is required.`);
        return;
      }
      if (value) {
        // Apply valueTemplate if defined (e.g. wrap a raw token into a JSON header string)
        env[spec.key] = spec.valueTemplate
          ? spec.valueTemplate.replace('{{value}}', value)
          : value;
      }
    }

    // Validate & collect path args
    const resolvedPaths: Record<string, string> = {};
    for (const spec of (this.entry.pathSpecs || [])) {
      const input = this.pathInputs.get(spec.argPlaceholder);
      const value = input?.value.trim() || '';
      if (spec.required && !value) {
        this.markError(input, `${spec.label} is required.`);
        return;
      }
      if (value) resolvedPaths[spec.argPlaceholder] = value;
    }

    const resolvedArgs = resolvePathArgs(this.entry, this.app, resolvedPaths);
    this.onComplete(env, resolvedArgs);
    this.close();
  }

  private markError(input: HTMLInputElement | undefined, message: string): void {
    if (!input) return;
    input.focus();
    input.classList.add('mcp-wizard-input-error');
    const existing = input.parentElement?.querySelector('.mcp-wizard-error');
    if (!existing) {
      const err = document.createElement('span');
      err.className = 'mcp-wizard-error';
      err.textContent = message;
      input.insertAdjacentElement('afterend', err);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
