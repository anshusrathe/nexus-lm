import { ItemView, WorkspaceLeaf, setIcon, Notice, ButtonComponent, TFile } from 'obsidian';
import { mount, unmount } from 'svelte';
import AgentTrace from './AgentTrace.svelte';
import type { AgentEvent, ToolCall } from '../agent/types';
import { parseToolCallsFromText } from '../agent/toolCallParser';
import { UnifiedProviderManager } from '../services/unifiedProviderManager';
import { getModelsGroupedByProvider, getModelDisplayName } from '../settings';
import type AIPlugin from '../main';
import { AIChatSessionManager, type AIChatSession } from '../managers/aiChatSessionManager';

export const VIEW_TYPE_AGENT = 'NEXUS_LM_AGENT';

interface AgentTaskTurn {
  id: string;
  task: string;
  events: AgentEvent[];
  answer: string | null;
  startedAt: number;
  completedAt: number | null;
}

interface AgentViewState {
  isRunning: boolean;
  stepCount: number;
  startTime: number;
  currentThought: string;
}

interface AgentTraceHandle {
  completedTurns: Array<{ task: string; events: AgentEvent[]; answer: string | null }>;
  currentTask: string;
  currentEvents: AgentEvent[];
  isRunning: boolean;
}

export class AgentView extends ItemView {
  private plugin: AIPlugin;
  private traceComponent: ReturnType<typeof mount> | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLElement | null = null;
  private statusBarEl: HTMLElement | null = null;
  private agentSelectedFiles: Set<string> = new Set();
  private agentCapsuleDisplay: HTMLElement | null = null;
  private agentContextMenuEl: HTMLElement | null = null;
  private statusSpinnerEl: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;
  private state: AgentViewState = { isRunning: false, stepCount: 0, startTime: 0, currentThought: '' };
  private turns: AgentTaskTurn[] = [];
  private currentTurnEvents: AgentEvent[] = [];
  private currentTurnId: string | null = null;
  private currentTask: string = '';
  private timerInterval: number | null = null;
  private modelBtn: ButtonComponent | null = null;
  private sessionManager: AIChatSessionManager;
  private currentSessionId: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: AIPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.turns = [];
    this.currentTurnEvents = [];
    this.sessionManager = new AIChatSessionManager(this.app);
    console.log('[AgentView] CONSTRUCTOR called');
  }

  getViewType(): string {
    return VIEW_TYPE_AGENT;
  }

  getDisplayText(): string {
    return 'Agent';
  }

  getIcon(): string {
    return 'bot';
  }

  addEvent(event: AgentEvent): void {
    console.log('[AgentView] addEvent type=' + event.type, 'data=', event.data, 'ts=', event.timestamp);
    this.currentTurnEvents.push({
      type: event.type,
      data: event.data,
      timestamp: event.timestamp,
    });

    if (event.type === 'step') {
      const stepData = event.data as { step: number; status: string; thought: string; toolName: string | null };
      this.state.stepCount = stepData.step;
      this.state.currentThought = stepData.thought;
    }
    if (event.type === 'thought') {
      const thoughtData = event.data as { thought: string };
      this.state.currentThought = thoughtData.thought;
    }

    this.state = {
      isRunning: this.state.isRunning,
      stepCount: this.state.stepCount,
      startTime: this.state.startTime,
      currentThought: this.state.currentThought,
    };
    console.log('[AgentView] addEvent -> currentTurnEvents.length=' + this.currentTurnEvents.length + ', isRunning=' + this.state.isRunning);
    this.updateUI();
    this.syncTraceComponent();
  }

  setRunning(running: boolean): void {
    console.log('[AgentView] setRunning(' + running + '), prev=' + this.state.isRunning);
    this.state = { ...this.state, isRunning: running };
    if (running) {
      this.state.startTime = Date.now();
      this.startTimer();
    } else {
      this.stopTimer();
    }
    this.updateUI();
    this.syncTraceComponent();
  }

  clearEvents(): void {
    this.currentTask = '';
    this.currentTurnId = null;
    this.currentTurnEvents = [];
    this.turns = [];
    this.agentSelectedFiles.clear();
    if (this.agentCapsuleDisplay) {
      this.agentCapsuleDisplay.empty();
      const capsuleContainer = this.agentCapsuleDisplay.parentElement;
      if (capsuleContainer) {
        capsuleContainer.removeClass('has-content');
      }
    }
    this.state = { isRunning: false, stepCount: 0, startTime: 0, currentThought: '' };
    this.updateUI();
    this.syncTraceComponent();
  }

  private async saveCurrentAgentSession(): Promise<void> {
    if (this.turns.length === 0) return;
    const first = this.turns[0]?.task || 'Agent Session';
    const sessionName = first.split(/\s+/).slice(0, 20).join(' ');
    const now = Date.now();

    if (!this.currentSessionId) {
      this.currentSessionId = now.toString();
    }

    const session: AIChatSession = {
      id: this.currentSessionId,
      name: sessionName,
      createdAt: now,
      updatedAt: now,
      messages: this.turns.map(t => ({
        question: t.task,
        answer: t.answer || '',
        timestamp: t.startedAt,
        id: t.id,
        agentSteps: t.events as unknown[],
        isAgentResponse: true,
      })),
    };

    await this.sessionManager.saveSession(session);
  }

  private async openAgentSessionHistory(): Promise<void> {
    const existing = this.containerEl.querySelector('.agent-session-history-modal');
    if (existing) { existing.remove(); return; }

    const modal = this.containerEl.createDiv({ cls: 'ai-chat-session-history-modal' });

    const header = modal.createDiv({ cls: 'modal-header' });
    header.createEl('span', { text: 'Agent Sessions' });

    const closeBtn = header.createEl('button', { cls: 'close-btn' });
    setIcon(closeBtn, 'x');
    closeBtn.addEventListener('click', () => modal.remove());

    const searchContainer = modal.createDiv({ cls: 'session-search-container' });
    const searchInput = searchContainer.createEl('input', {
      type: 'text', cls: 'session-search-input', placeholder: 'Search sessions...',
    });

    const listContainer = modal.createDiv({ cls: 'session-list' });

    const renderSessions = async (query: string) => {
      listContainer.empty();
      const pageSize = 50;
      const { sessions, total } = await this.sessionManager.listSessionsLazy(pageSize, 0, query);
      if (sessions.length === 0) {
        const empty = listContainer.createDiv({ cls: 'no-sessions-message' });
        empty.textContent = query ? 'No matching sessions found.' : 'No saved sessions. Start an agent task to create one.';
        return;
      }

      for (const meta of sessions) {
        const card = listContainer.createDiv({ cls: 'session-card' });
        const info = card.createDiv({ cls: 'session-info' });
        info.createDiv({ cls: 'session-name', text: meta.name });

        const dateStr = new Date(meta.updatedAt).toLocaleDateString(undefined, {
          month: 'short', day: 'numeric', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        info.createDiv({ cls: 'session-date', text: dateStr });

        if (meta.matchCount !== undefined && meta.matchCount > 0) {
          card.createDiv({ cls: 'match-indicator', text: `${meta.matchCount} match${meta.matchCount > 1 ? 'es' : ''}` });
        }

        const deleteBtn = card.createDiv({ cls: 'delete-session-btn' });
        setIcon(deleteBtn, 'trash-2');
        deleteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await this.sessionManager.deleteSession(meta.id);
          await renderSessions(searchInput.value);
        });

        card.addEventListener('click', async () => {
          await this.loadAgentSession(meta.id);
          modal.remove();
        });
      }

      if (total > pageSize) {
        const pagination = listContainer.createDiv({ cls: 'session-pagination' });
        pagination.createEl('span', { text: `${sessions.length} of ${total} sessions` });
      }
    };

    searchInput.addEventListener('input', () => {
      void renderSessions(searchInput.value);
    });

    void renderSessions('');

    modal.style.cssText = 'display: flex; flex-direction: column;';

    this.containerEl.appendChild(modal);
  }

  private async loadAgentSession(sessionId: string): Promise<void> {
    const session = await this.sessionManager.loadSession(sessionId);
    if (!session) {
      new Notice('Session not found.');
      return;
    }

    this.currentSessionId = session.id;
    this.turns = [];
    this.currentTurnEvents = [];
    this.currentTask = '';
    this.currentTurnId = null;

    for (const msg of session.messages) {
      if (msg.isAgentResponse) {
        const events = (msg.agentSteps || []) as AgentEvent[];
        this.turns.push({
          id: msg.id || `restored_${msg.timestamp}`,
          task: msg.question,
          events,
          answer: msg.answer,
          startedAt: msg.timestamp,
          completedAt: msg.timestamp,
        });
      } else {
        this.turns.push({
          id: msg.id || `restored_${msg.timestamp}`,
          task: msg.question,
          events: [],
          answer: msg.answer,
          startedAt: msg.timestamp,
          completedAt: msg.timestamp,
        });
      }
    }

    this.state = { isRunning: false, stepCount: 0, startTime: 0, currentThought: '' };
    this.updateUI();
    this.syncTraceComponent();
  }

  private startNewAgentSession(): void {
    if (this.turns.length > 0) {
      void this.saveCurrentAgentSession();
    }
    this.currentSessionId = null;
    this.currentTask = '';
    this.currentTurnId = null;
    this.currentTurnEvents = [];
    this.turns = [];
    this.agentSelectedFiles.clear();
    if (this.agentCapsuleDisplay) {
      this.agentCapsuleDisplay.empty();
      const capsuleContainer = this.agentCapsuleDisplay.parentElement;
      if (capsuleContainer) {
        capsuleContainer.removeClass('has-content');
      }
    }
    if (this.inputEl) {
      this.inputEl.value = '';
    }
    this.state = { isRunning: false, stepCount: 0, startTime: 0, currentThought: '' };
    this.updateUI();
    this.syncTraceComponent();
  }

  private openAgentFileMenu(anchorEl: HTMLElement): void {
    this.closeAgentFileMenu();

    const menu = this.containerEl.ownerDocument.createElement('div');
    menu.className = 'context-file-menu';

    const rect = anchorEl.getBoundingClientRect();
    menu.addClass('nl-position-fixed');
    menu.setCssProps({ '--menu-left': `${rect.left}px` });
    menu.addClass('nl-z-index-9999');
    menu.addClass('nl-min-width-260px');

    const searchInput = menu.createEl('input', {
      type: 'text',
      cls: 'context-file-menu-search',
      placeholder: 'Search files by name...',
    });

    const listContainer = menu.createDiv({ cls: 'context-file-menu-list' });
    this.renderAgentFileList(listContainer, '');

    searchInput.addEventListener('input', () => {
      this.renderAgentFileList(listContainer, searchInput.value);
    });

    window.setTimeout(() => {
      const closeHandler = (e: MouseEvent) => {
        if (!menu.contains(e.target as Node)) {
          menu.remove();
          this.containerEl.ownerDocument.removeEventListener('mousedown', closeHandler, true);
        }
      };
      this.containerEl.ownerDocument.addEventListener('mousedown', closeHandler, true);
    }, 0);

    this.containerEl.ownerDocument.body.appendChild(menu);

    menu.setCssProps({ '--menu-top': `${rect.top - menu.offsetHeight - 8}px` });
    this.agentContextMenuEl = menu;
  }

  private closeAgentFileMenu(): void {
    if (this.agentContextMenuEl) {
      this.agentContextMenuEl.remove();
      this.agentContextMenuEl = null;
    }
  }

  private renderAgentFileList(container: HTMLElement, searchTerm: string): void {
    container.empty();
    const lowerSearch = searchTerm.toLowerCase();

    const files = this.app.vault.getMarkdownFiles();
    const matchingFiles = files.filter(file =>
      file.basename.toLowerCase().includes(lowerSearch) ||
      file.path.toLowerCase().includes(lowerSearch)
    ).slice(0, 15);

    if (matchingFiles.length === 0) {
      const noResults = container.createDiv({ cls: 'context-file-menu-item nl-opacity-05' });
      noResults.textContent = 'No matches found';
      return;
    }

    matchingFiles.forEach((file, index) => {
      const item = container.createDiv({ cls: 'context-file-menu-item' });
      const iconSpan = item.createSpan();
      setIcon(iconSpan, this.getFileTypeIcon(file.name));
      item.appendText(` ${file.basename}`);

      if (index === 0) {
        item.classList.add('selected');
      }

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleAgentFileSelect(file);
      });
    });
  }

  private getFileTypeIcon(filename: string): string {
    if (filename.endsWith('.md')) return 'file-text';
    if (filename.endsWith('.png') || filename.endsWith('.jpg') || filename.endsWith('.jpeg') || filename.endsWith('.gif') || filename.endsWith('.svg')) return 'image';
    if (filename.endsWith('.pdf')) return 'file';
    if (filename.endsWith('.canvas')) return 'layout-dashboard';
    return 'file';
  }

  private handleAgentFileSelect(file: TFile): void {
    this.closeAgentFileMenu();
    this.agentSelectedFiles.add(file.path);
    this.renderAgentFileCapsules();
    this.inputEl?.focus();
  }

  private renderAgentFileCapsules(): void {
    const container = this.agentCapsuleDisplay;
    if (!container) return;

    container.empty();
    const files = Array.from(this.agentSelectedFiles);
    const maxVisible = 3;

    const capsuleContainer = container.parentElement;
    if (capsuleContainer) {
      if (files.length > 0) {
        capsuleContainer.classList.add('has-content');
      } else {
        capsuleContainer.classList.remove('has-content');
      }
    }

    files.slice(0, maxVisible).forEach(path => {
      const tag = container.createDiv({ cls: 'capsule-file-tag' });
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file) return;

      if (file instanceof TFile) {
        const icon = tag.createSpan({ cls: 'capsule-icon' });
        setIcon(icon, this.getFileTypeIcon(file.name));
        const label = tag.createSpan({ cls: 'capsule-label' });
        label.textContent = file.basename;
        tag.setAttr('title', path);
      }

      tag.addEventListener('click', () => {
        this.agentSelectedFiles.delete(path);
        this.renderAgentFileCapsules();
      });
    });

    if (files.length > maxVisible) {
      const moreTag = container.createDiv({ cls: 'capsule-file-tag' });
      moreTag.textContent = `+${files.length - maxVisible}`;
    }
  }

  private startTimer(): void {
    this.stopTimer();
    console.log('[AgentView] startTimer');
    this.timerInterval = window.setInterval(() => {
      this.updateStatusBar();
    }, 500);
  }

  private stopTimer(): void {
    if (this.timerInterval !== null) {
      console.log('[AgentView] stopTimer');
      window.clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  private formatElapsed(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
  }

  private updateStatusBar(): void {
    if (!this.statusTextEl) {
      console.log('[AgentView] updateStatusBar SKIP - statusTextEl null');
      return;
    }
    const elapsed = Date.now() - this.state.startTime;
    const elapsedStr = this.formatElapsed(elapsed);
    const stepInfo = this.state.stepCount > 0 ? `Step ${this.state.stepCount}` : 'Starting';
    const thoughtPreview = this.state.currentThought
      ? `\u00B7 ${this.state.currentThought.substring(0, 60)}${this.state.currentThought.length > 60 ? '...' : ''}`
      : '';
    const text = `${stepInfo} \u00B7 ${elapsedStr} ${thoughtPreview}`;
    this.statusTextEl.textContent = text;
  }

  private updateUI(): void {
    if (this.sendBtn) {
      if (this.state.isRunning) {
        setIcon(this.sendBtn, 'square');
        this.sendBtn.setAttr('data-state', 'stop');
      } else {
        setIcon(this.sendBtn, 'arrow-up');
        this.sendBtn.setAttr('data-state', 'send');
      }
    }
    if (this.statusBarEl) {
      this.statusBarEl.style.display = this.state.isRunning ? 'flex' : 'none';
    }
    if (this.inputEl) {
      this.inputEl.disabled = this.state.isRunning;
    }
    if (this.state.isRunning) {
      this.updateStatusBar();
    }
  }

  private syncTraceComponent(): void {
    if (this.traceComponent) {
      const el = this.traceComponent as unknown as AgentTraceHandle;
      el.completedTurns = this.turns.map(t => ({
        task: t.task,
        events: t.events,
        answer: t.answer,
      }));
      el.currentTask = this.currentTask;
      el.currentEvents = [...this.currentTurnEvents];
      el.isRunning = this.state.isRunning;
    }
  }

  private getActiveProviderId(): string {
    return this.plugin.settings.aiChatProvider || this.plugin.settings.provider || 'gemini';
  }

  private getActiveModelId(): string {
    return this.plugin.settings.aiChatModel || this.plugin.settings.model || '';
  }

  private getModelButtonText(): string {
    const modelId = this.getActiveModelId();
    if (!modelId) return 'Select model';
    return getModelDisplayName(modelId, this.plugin.settings, this.getActiveProviderId());
  }

  private showModelMenu(): void {
    const existing = this.containerEl.querySelector('.model-select-menu');
    if (existing) { existing.remove(); return; }

    const menuEl = this.containerEl.createDiv({ cls: 'model-select-menu' });
    const modelBtnEl = this.modelBtn?.buttonEl;
    if (!modelBtnEl) return;

    const searchContainer = menuEl.createDiv({ cls: 'model-search-container' });
    const searchInput = searchContainer.createEl('input', {
      type: 'text', placeholder: 'Search models...', cls: 'model-search-input'
    });

    const modelList = menuEl.createDiv({ cls: 'model-list' });
    const modelGroups = getModelsGroupedByProvider(this.plugin.settings);
    const activeProvider = this.getActiveProviderId();
    const activeModel = this.getActiveModelId();

    let allItems: HTMLElement[] = [];

    for (const group of modelGroups) {
      const headerEl = modelList.createDiv({ cls: 'model-select-menu-header' });
      headerEl.createEl('span', { text: group.label });

      for (const model of group.models) {
        const item = modelList.createDiv({ cls: 'model-select-menu-item' });
        item.createEl('span', { text: model.name });
        if (model.provider === activeProvider && model.id === activeModel) {
          item.addClass('selected');
        }
        item.addEventListener('click', () => {
          this.plugin.settings.aiChatModel = model.id;
          this.plugin.settings.aiChatProvider = model.provider;
          this.plugin.settings.model = model.id;
          this.plugin.settings.provider = model.provider;
          this.modelBtn?.setButtonText(model.name);
          menuEl.remove();
          void this.plugin.saveSettings();
        });
        allItems.push(item);
      }
    }

    if (allItems.length === 0) {
      modelList.createEl('p', {
        text: 'No models available. Configure API keys in Settings.',
        cls: 'model-list-empty'
      });
    }

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase();
      for (const item of allItems) {
        item.style.display = item.textContent?.toLowerCase().includes(q) ? '' : 'none';
      }
      for (const header of modelList.querySelectorAll('.model-select-menu-header')) {
        const hdr = header as HTMLElement;
        const next = hdr.nextElementSibling as HTMLElement | null;
        hdr.style.display = (next && next.style.display !== 'none') ? '' : 'none';
      }
    });

    const btnRect = modelBtnEl.getBoundingClientRect();
    const containerRect = this.containerEl.getBoundingClientRect();
    menuEl.addClass('nl-position-absolute');
    menuEl.setCssProps({
      '--menu-top': `${btnRect.bottom - containerRect.top + 4}px`,
      '--menu-right': `${containerRect.right - btnRect.right}px`
    });

    window.setTimeout(() => {
      const closeHandler = (e: MouseEvent) => {
        if (!menuEl.contains(e.target as Node) && !(e.target as Element).closest('.header-model-btn')) {
          menuEl.remove();
          this.containerEl.ownerDocument.removeEventListener('click', closeHandler);
        }
      };
      this.containerEl.ownerDocument.addEventListener('click', closeHandler);
    }, 0);
  }

  async onOpen(): Promise<void> {
    console.log('[AgentView] onOpen START');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('agent-view');

    const headerEl = contentEl.createDiv({ cls: 'agent-view-header' });
    const headerLeft = headerEl.createDiv({ cls: 'agent-view-header-left' });

    const historyBtn = headerLeft.createDiv({ cls: 'agent-view-header-btn' });
    setIcon(historyBtn, 'history');
    historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.openAgentSessionHistory();
    });
    historyBtn.setAttr('aria-label', 'Session history');

    const newSessionBtn = headerLeft.createDiv({ cls: 'agent-view-header-btn' });
    setIcon(newSessionBtn, 'plus');
    newSessionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.startNewAgentSession();
    });
    newSessionBtn.setAttr('aria-label', 'New session');

    const headerRight = headerEl.createDiv({ cls: 'agent-view-header-right' });

    this.modelBtn = new ButtonComponent(headerRight)
      .setButtonText(this.getModelButtonText())
      .setClass('header-model-btn')
      .onClick(() => this.showModelMenu());

    this.statusBarEl = contentEl.createDiv({ cls: 'agent-view-status-bar' });
    this.statusBarEl.style.display = 'none';
    this.statusSpinnerEl = this.statusBarEl.createEl('span', { cls: 'agent-view-status-spinner' });
    setIcon(this.statusSpinnerEl, 'loader-pinwheel');
    this.statusTextEl = this.statusBarEl.createEl('span', { cls: 'agent-view-status-text' });

    const traceContainer = contentEl.createDiv({ cls: 'agent-view-trace' });
    this.traceComponent = mount(AgentTrace, {
      target: traceContainer,
      props: {
        completedTurns: [],
        currentTask: '',
        currentEvents: [],
        isRunning: false,
        app: this.app,
      },
    });

    const inputContainer = contentEl.createDiv({ cls: 'chat-input-container' });

    const capsuleContainer = inputContainer.createDiv({ cls: 'context-capsule-container' });
    this.agentCapsuleDisplay = capsuleContainer.createDiv({ cls: 'context-capsule-display' });

    const inputRow = inputContainer.createDiv({ cls: 'input-row-container' });

    const leftControls = inputRow.createDiv({ cls: 'input-left-controls' });
    const capsuleBtn = leftControls.createDiv({ cls: 'context-menu-btn' });
    setIcon(capsuleBtn, 'plus');
    capsuleBtn.setAttr('aria-label', 'Add files as context');
    capsuleBtn.setAttr('tabindex', '0');
    capsuleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openAgentFileMenu(capsuleBtn);
    });

    this.inputEl = inputRow.createEl('textarea', {
      cls: 'query-input-new',
      placeholder: 'Enter a task for the agent...',
    });
    this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.handleSend();
      }
    });

    this.sendBtn = inputRow.createDiv({ cls: 'send-button-new' });
    setIcon(this.sendBtn, 'arrow-up');
    this.sendBtn.setAttr('data-state', 'send');
    this.sendBtn.setAttr('aria-label', 'Send task');
    this.sendBtn.setAttr('tabindex', '0');
    this.sendBtn.addEventListener('click', () => this.handleSendClick());

    this.updateUI();
    console.log('[AgentView] onOpen END - traceComponent=' + (this.traceComponent ? 'mounted' : 'null'));
  }

  private handleSendClick(): void {
    const state = this.sendBtn?.getAttribute('data-state');
    if (state === 'stop') {
      this.handleStop();
    } else {
      void this.handleSend();
    }
  }

  private async handleSend(): Promise<void> {
    if (!this.inputEl) return;
    const task = this.inputEl.value.trim();
    if (!task) return;
    if (this.state.isRunning) return;

    const turnId = Date.now().toString();
    this.currentTurnId = turnId;
    this.currentTask = task;
    this.currentTurnEvents = [];
    this.inputEl.value = '';

    this.agentSelectedFiles.clear();
    if (this.agentCapsuleDisplay) {
      this.agentCapsuleDisplay.empty();
      const capsuleContainer = this.agentCapsuleDisplay.parentElement;
      if (capsuleContainer) {
        capsuleContainer.removeClass('has-content');
      }
    }

    this.state.stepCount = 0;
    this.state.currentThought = 'Starting agent execution...';

    const enrichedTask = await this.buildEnrichedTask(task);
    this.setRunning(true);

    this.runAgentTask(enrichedTask).finally(() => {
      if (this.state.isRunning) {
        this.setRunning(false);
      }
    });
  }

  private async buildEnrichedTask(task: string): Promise<string> {
    let fileContext = '';
    if (this.agentSelectedFiles.size > 0) {
      const parts: string[] = [];
      for (const path of this.agentSelectedFiles) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          try {
            const content = await this.app.vault.read(file);
            parts.push(`--- File: ${file.path} ---\n${content}`);
          } catch {
            parts.push(`--- File: ${file.path} ---\n[Could not read file]`);
          }
        }
      }
      if (parts.length > 0) {
        fileContext = `Context from selected files:\n${parts.join('\n\n')}\n\n`;
      }
    }

    const previousTurns = this.turns.filter(t => t.answer);
    if (previousTurns.length === 0) return `${fileContext}New task: ${task}`;

    const summary = previousTurns.map((t, i) =>
      `Task ${i + 1}: ${t.task}\nResult: ${t.answer!.substring(0, 1000)}`
    ).join('\n\n');

    return `${fileContext}Previous conversation context:\n${summary}\n\nNew task: ${task}`;
  }

  private async callProvider(
    providerId: string,
    modelId: string,
    messages: Array<Record<string, unknown>>,
    onToken?: (chunk: string) => void
  ): Promise<string> {
    const plainMessages = messages.map((m) => ({
      role: (m.role as 'system' | 'user' | 'assistant') || 'user',
      content: String(m.content ?? ''),
    }));

    const opts = { temperature: 0.3, maxTokens: 4096 };

    switch (providerId) {
      case 'gemini': {
        const { GeminiService } = await import('../services/geminiService');
        const svc = new GeminiService(this.plugin.settings.geminiApiKey || this.plugin.settings.apiKey);
        const prompt = plainMessages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
        const geminiOpts = { temperature: 0.3, maxOutputTokens: 4096 };
        const result = await svc.generateContentWithHeaders(modelId, prompt, geminiOpts);
        if (onToken) onToken(result);
        return result;
      }

      case 'groq': {
        const { GroqService } = await import('../services/groqService');
        const svc = new GroqService(this.plugin.settings.groqApiKey);
        if (onToken) {
          let accumulated = '';
          const result = await svc.generateContentStream(modelId, plainMessages, opts, (chunk: string) => {
            accumulated += chunk;
            onToken(accumulated);
          });
          return result;
        }
        return await svc.generateContent(modelId, plainMessages, opts);
      }

      case 'openrouter': {
        const { OpenRouterService } = await import('../services/openRouterService');
        const svc = new OpenRouterService(this.plugin.settings.openRouterApiKey);
        if (onToken) {
          let accumulated = '';
          return await svc.generateContentStream(modelId, plainMessages, opts, (chunk: string) => {
            accumulated += chunk;
            onToken(accumulated);
          });
        }
        return await svc.generateContent(modelId, plainMessages, opts);
      }

      case 'ollama': {
        const { OllamaService } = await import('../services/ollamaService');
        const svc = new OllamaService(this.plugin.settings.ollamaBaseUrl, this.plugin.settings.ollamaApiKey);
        if (onToken) {
          let accumulated = '';
          await svc.generateContentStreamEvents(modelId, plainMessages, (evt) => {
            if (evt.type === 'content') {
              accumulated += evt.text;
              onToken(accumulated);
            }
          }, opts);
          return accumulated;
        }
        return await svc.generateContent(modelId, plainMessages, opts);
      }

      case 'nvidia': {
        const { NvidiaService } = await import('../services/nvidiaService');
        const svc = new NvidiaService(this.plugin.settings.nvidiaApiKey);
        if (onToken) {
          let accumulated = '';
          return await svc.generateContentStream(modelId, plainMessages, opts, (chunk: string) => {
            accumulated += chunk;
            onToken(accumulated);
          });
        }
        return await svc.generateContent(modelId, plainMessages, opts);
      }

      default: {
        const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(providerId);
        if (!unifiedProvider) {
          throw new Error(`AI provider "${providerId}" is not available. Configure API keys in Settings.`);
        }
        if (onToken && unifiedProvider.streamContent) {
          let accumulated = '';
          const res = await unifiedProvider.streamContent(modelId, plainMessages, (chunk: string) => {
            accumulated += chunk;
            onToken(accumulated);
          }, opts);
          return res.text || accumulated;
        }
        const res = await unifiedProvider.generateContent(modelId, plainMessages, opts);
        if (onToken) onToken(res.text || '');
        return res.text || '';
      }
    }
  }

  private parseToolCalls(text: string): ToolCall[] {
    const parsed = parseToolCallsFromText(text);
    const toolCalls: ToolCall[] = parsed.map((p) => ({
      id: `tc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      name: p.name,
      arguments: p.arguments,
    }));
    console.log('[AgentView] parseToolCalls found ' + toolCalls.length + ' tool calls');
    return toolCalls;
  }

  private completeCurrentTurn(answer: string | null): void {
    if (!this.currentTurnId) return;
    this.turns.push({
      id: this.currentTurnId,
      task: this.currentTask,
      events: [...this.currentTurnEvents],
      answer,
      startedAt: this.state.startTime,
      completedAt: Date.now(),
    });
    this.currentTurnId = null;
    this.currentTurnEvents = [];
    this.currentTask = '';
  }

  private async runAgentTask(task: string): Promise<void> {
    console.log('[AgentView] runAgentTask START task="' + task.substring(0, 80) + '..."');
    const orchestrator = this.plugin.agentOrchestrator;
    if (!orchestrator) {
      const msg = 'Agent orchestrator not initialized';
      console.log('[AgentView] runAgentTask FAIL - orchestrator null');
      this.addEvent({ type: 'error', data: { error: msg }, timestamp: Date.now() });
      this.completeCurrentTurn(msg);
      return;
    }

    const providerId = this.getActiveProviderId();
    const modelId = this.getActiveModelId();
    console.log('[AgentView] runAgentTask provider=' + providerId + ' model=' + modelId);

    if (!modelId) {
      const msg = 'No model selected. Select a model from the header dropdown.';
      new Notice(msg);
      console.log('[AgentView] runAgentTask FAIL - no model');
      this.addEvent({ type: 'error', data: { error: msg }, timestamp: Date.now() });
      this.completeCurrentTurn(msg);
      return;
    }

    const self = this;
    let providerCalls = 0;
    const providerCall = async (messages: Array<Record<string, unknown>>, onToken?: (chunk: string) => void): Promise<{
      content?: string;
      toolCalls?: ToolCall[];
    }> => {
      providerCalls++;
      console.log('[AgentView] providerCall #' + providerCalls + ' messages=' + messages.length);
      const text = await self.callProvider(providerId, modelId, messages, onToken);
      const toolCalls = self.parseToolCalls(text);
      return { content: text, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
    };

    const onToken = (chunk: string) => {
      if (self.currentTurnId) {
        self.addEvent({ type: 'answer_chunk', data: { text: chunk }, timestamp: Date.now() });
      }
    };

    try {
      console.log('[AgentView] runAgentTask calling orchestrator.runAgent()');
      const result = await orchestrator.runAgent(task, providerCall, onToken);
      console.log('[AgentView] runAgentTask orchestrator returned, result length=' + result.length);
      if (this.currentTurnId) {
        this.addEvent({
          type: 'final_answer',
          data: { answer: result },
          timestamp: Date.now(),
        });
      }
      this.completeCurrentTurn(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log('[AgentView] runAgentTask CAUGHT error:', msg);
      new Notice(`Agent error: ${msg}`);
      if (this.currentTurnId) {
        this.addEvent({ type: 'error', data: { error: msg }, timestamp: Date.now() });
      }
      this.completeCurrentTurn(`Error: ${msg}`);
    }
    console.log('[AgentView] runAgentTask END (total provider calls: ' + providerCalls + ')');
  }

  private handleStop(): void {
    console.log('[AgentView] handleStop');
    if (this.plugin.agentOrchestrator) {
      this.plugin.agentOrchestrator.abort();
    }
    this.setRunning(false);
    if (this.currentTurnId) {
      this.addEvent({
        type: 'final_answer',
        data: { answer: 'Agent execution stopped by user.' },
        timestamp: Date.now(),
      });
      this.completeCurrentTurn('Agent execution stopped by user.');
    }
  }

  async onClose(): Promise<void> {
    this.stopTimer();
    this.closeAgentFileMenu();
    if (this.turns.length > 0) {
      await this.saveCurrentAgentSession();
    }
    if (this.traceComponent) {
      unmount(this.traceComponent);
      this.traceComponent = null;
    }
    this.contentEl.empty();
  }
}
