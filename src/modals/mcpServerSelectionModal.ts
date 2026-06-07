import { App, Modal, Setting, Notice, setIcon } from 'obsidian';
import { MCPServerConfig } from '../settings';

export interface MCPServerSelection {
    selectedServers: string[];
    selectedResources: Map<string, string[]>;
    selectedTools: Map<string, string[]>;
    autoToolSelection?: Map<string, boolean>;
}

export class MCPServerSelectionModal extends Modal {
    private selectedServers = new Set<string>();
    private selectedResources = new Map<string, string[]>();
    private selectedTools = new Map<string, string[]>();
    private autoToolSelection = new Map<string, boolean>();
    private serverCheckboxes = new Map<string, HTMLInputElement>();
    private autoToolCheckboxes = new Map<string, HTMLInputElement>();
    private resourceContainers = new Map<string, HTMLElement>();
    private toolContainers = new Map<string, HTMLElement>();
    private submitBtn: HTMLButtonElement | null = null;
    private mcpService: SafeAny;
    private availableServers: MCPServerConfig[];
    private onSubmit: (selection: MCPServerSelection) => void;
    private mcpAutoConnect: boolean;

    constructor(app: App, mcpService: SafeAny, availableServers: MCPServerConfig[], onSubmit: (selection: MCPServerSelection) => void, mcpAutoConnect = true) {
        super(app);
        this.mcpService = mcpService;
        this.availableServers = availableServers.filter(s => !s.disabled);
        this.onSubmit = onSubmit;
        this.mcpAutoConnect = mcpAutoConnect;
    }

    private updateSubmitLabel() {
        if (!this.submitBtn) return;
        const count = this.selectedServers.size;
        this.submitBtn.textContent = count === 0
            ? 'Use Selected Servers'
            : count === 1
                ? 'Use 1 Server'
                : `Use ${count} Servers`;
    }

    private uncheckAuto(serverId: string) {
        const autoCb = this.autoToolCheckboxes.get(serverId);
        if (autoCb && autoCb.checked) {
            autoCb.checked = false;
            this.autoToolSelection.set(serverId, false);
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('mcp-server-selection-modal');

        contentEl.createEl('h2', { text: 'Select MCP Servers' });
        contentEl.createEl('p', {
            text: 'Select one or more MCP servers to use for this query. You can also pick specific resources or tools from each server.',
            cls: 'mcp-modal-description'
        });

        if (this.availableServers.length === 0) {
            contentEl.createEl('p', {
                text: 'No MCP servers configured or enabled. Please configure servers in settings.',
                cls: 'mcp-no-servers'
            });
            const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
            const closeBtn = buttonContainer.createEl('button', { text: 'Close', cls: 'mod-cta' });
            closeBtn.addEventListener('click', () => this.close());
            return;
        }

        const serverList = contentEl.createDiv({ cls: 'mcp-server-list' });
        this.availableServers.forEach(server => {
            const serverItem = serverList.createDiv({ cls: 'mcp-server-item' });
            const serverHeader = serverItem.createDiv({ cls: 'mcp-server-header' });
            const checkboxContainer = serverHeader.createDiv({ cls: 'mcp-checkbox-container' });
            const checkbox = checkboxContainer.createEl('input', { type: 'checkbox' });
            checkbox.id = `mcp-server-${server.id}`;
            this.serverCheckboxes.set(server.id, checkbox);

            const label = checkboxContainer.createEl('label', {
                text: server.name,
                attr: { for: `mcp-server-${server.id}` }
            });
            label.addClass('mcp-server-label');

            const isConnected = this.mcpService.isServerConnected(server.id);
            const statusBadge = serverHeader.createEl('span', {
                cls: `mcp-status-badge ${isConnected ? 'connected' : 'disconnected'}`,
                text: isConnected ? '● Connected' : '○ Disconnected'
            });

            if (!this.mcpAutoConnect && !isConnected) {
                const connectBtn = serverHeader.createEl('button', {
                    cls: 'mcp-connect-btn',
                    attr: { 'aria-label': 'Connect to server', title: 'Connect to this MCP server' }
                });
                setIcon(connectBtn, 'link');
                connectBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    connectBtn.disabled = true;
                    setIcon(connectBtn, 'loader-2');
                    connectBtn.addClass('mcp-connect-btn--loading');
                    try {
                        await this.mcpService.connectServer(server);
                        statusBadge.className = 'mcp-status-badge connected';
                        statusBadge.textContent = '● Connected';
                        connectBtn.remove();
                        this.loadServerResources(server.id, this.resourceContainers.get(server.id)!);
                        this.loadServerTools(server.id, this.toolContainers.get(server.id)!);
                    } catch (err) {
                                                connectBtn.disabled = false;
                        connectBtn.removeClass('mcp-connect-btn--loading');
                        setIcon(connectBtn, 'refresh-cw');
                        connectBtn.addClass('mcp-connect-btn--error');
                        const errorDiv = serverHeader.createEl('span', { cls: 'mcp-connect-error', text: `Failed to connect` });
                        setTimeout(() => errorDiv.remove(), 4000);
                    }
                });
            }

            const autoToolContainer = serverHeader.createDiv({ cls: 'mcp-auto-tool-container' });
            const autoToolCheckbox = autoToolContainer.createEl('input', {
                type: 'checkbox',
                attr: { id: `mcp-auto-tool-${server.id}` }
            });
            autoToolCheckbox.checked = server.autoToolSelection !== false;
            this.autoToolSelection.set(server.id, autoToolCheckbox.checked);
            this.autoToolCheckboxes.set(server.id, autoToolCheckbox);
            autoToolContainer.createEl('label', {
                text: 'Auto tool selection',
                attr: { for: `mcp-auto-tool-${server.id}`, title: 'Let the AI decide which tools to use' }
            });

            const details = serverItem.createEl('details', { cls: 'mcp-server-details' });
            const summary = details.createEl('summary', { text: 'Resources & Tools' });

            const resourcesSection = details.createDiv({ cls: 'mcp-section' });
            resourcesSection.createEl('h4', { text: 'Resources' });
            const resourceContainer = resourcesSection.createDiv({ cls: 'mcp-item-container' });
            this.resourceContainers.set(server.id, resourceContainer);

            const toolsSection = details.createDiv({ cls: 'mcp-section' });
            toolsSection.createEl('h4', { text: 'Tools' });
            const toolContainer = toolsSection.createDiv({ cls: 'mcp-item-container' });
            this.toolContainers.set(server.id, toolContainer);

            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    this.selectedServers.add(server.id);
                } else {
                    this.selectedServers.delete(server.id);
                }
                this.updateSubmitLabel();
            });

            autoToolCheckbox.addEventListener('change', () => {
                this.autoToolSelection.set(server.id, autoToolCheckbox.checked);
            });

            if (isConnected) {
                this.loadServerResources(server.id, resourceContainer);
                this.loadServerTools(server.id, toolContainer);
            } else {
                resourceContainer.createEl('p', { text: 'Connect to see resources', cls: 'mcp-connect-hint' });
                toolContainer.createEl('p', { text: 'Connect to see tools', cls: 'mcp-connect-hint' });
            }
        });

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        this.submitBtn = buttonContainer.createEl('button', { text: 'Use Selected Servers', cls: 'mod-cta' });
        this.submitBtn.addEventListener('click', () => {
            const selection: MCPServerSelection = {
                selectedServers: Array.from(this.selectedServers),
                selectedResources: this.selectedResources,
                selectedTools: this.selectedTools,
                autoToolSelection: this.autoToolSelection
            };
            this.onSubmit(selection);
            this.close();
        });
        this.updateSubmitLabel();
    }

    private loadServerResources(serverId: string, container: HTMLElement) {
        container.empty();
        try {
            const resources = this.mcpService.getServerResources(serverId);
            if (!resources || resources.length === 0) {
                container.createEl('p', { text: 'No resources available', cls: 'mcp-empty-hint' });
                return;
            }
            resources.forEach((resource: SafeAny) => {
                const item = container.createDiv({ cls: 'mcp-selectable-item' });
                const cb = item.createEl('input', { type: 'checkbox' });
                const id = `resource-${serverId}-${resource.uri}`;
                cb.id = id;
                item.createEl('label', { text: resource.name || resource.uri, attr: { for: id } });
                cb.addEventListener('change', () => {
                    const current = this.selectedResources.get(serverId) || [];
                    if (cb.checked) {
                        this.selectedResources.set(serverId, [...current, resource.uri]);
                        this.uncheckAuto(serverId);
                        const serverCb = this.serverCheckboxes.get(serverId);
                        if (serverCb && !serverCb.checked) {
                            serverCb.checked = true;
                            serverCb.dispatchEvent(new Event('change'));
                        }
                    } else {
                        this.selectedResources.set(serverId, current.filter((u: string) => u !== resource.uri));
                    }
                });
            });
        } catch (err) {
            container.createEl('p', { text: 'Error loading resources', cls: 'mcp-error-hint' });
        }
    }

    private loadServerTools(serverId: string, container: HTMLElement) {
        container.empty();
        try {
            const tools = this.mcpService.getServerTools(serverId);
            if (!tools || tools.length === 0) {
                container.createEl('p', { text: 'No tools available', cls: 'mcp-empty-hint' });
                return;
            }
            tools.forEach((tool: SafeAny) => {
                const item = container.createDiv({ cls: 'mcp-selectable-item' });
                const cb = item.createEl('input', { type: 'checkbox' });
                const id = `tool-${serverId}-${tool.name}`;
                cb.id = id;
                item.createEl('label', { text: tool.name, attr: { for: id, title: tool.description || '' } });
                cb.addEventListener('change', () => {
                    const current = this.selectedTools.get(serverId) || [];
                    if (cb.checked) {
                        this.selectedTools.set(serverId, [...current, tool.name]);
                        this.uncheckAuto(serverId);
                        const serverCb = this.serverCheckboxes.get(serverId);
                        if (serverCb && !serverCb.checked) {
                            serverCb.checked = true;
                            serverCb.dispatchEvent(new Event('change'));
                        }
                    } else {
                        this.selectedTools.set(serverId, current.filter((n: string) => n !== tool.name));
                    }
                });
            });
        } catch (err) {
            container.createEl('p', { text: 'Error loading tools', cls: 'mcp-error-hint' });
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
