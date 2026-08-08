import { ItemView, WorkspaceLeaf, setIcon, Notice, ButtonComponent, TFile } from 'obsidian';
import { mount, unmount } from 'svelte';
import AgentTrace from './AgentTrace.svelte';
import type { AgentEvent, ToolCall, ToolDefinition } from '../agent/types';
import { buildProviderTools, normalizeToolCalls } from '../agent/nativeToolCall';
import type { AgentContextItem } from './agentTraceTypes';

import { UnifiedProviderManager } from '../services/unifiedProviderManager';
import { AISettings, getModelsGroupedByProvider, getModelDisplayName, getGeminiThinkingConfig } from '../settings';
import type AIPlugin from '../main';
import { AIChatSessionManager, type AIChatSession } from '../managers/aiChatSessionManager';
import { ModelSelector, type ModelSelection } from '../modelSelector';
import { TokenEstimator, TaskType } from '../utils/tokenEstimator';
import { RateLimitManager } from '../utils/rateLimitManager';
import { PartialStreamError } from '../utils/streamingUtils';
import { extractTextFromFile, isExtractable } from '../utils/localFileExtractor';
import { openSessionHistoryModal } from '../modals/sessionHistoryModal';

export const VIEW_TYPE_AGENT = 'NEXUS_LM_AGENT';

interface AgentTaskTurn {
  id: string;
  task: string;
  events: AgentEvent[];
  answer: string | null;
  startedAt: number;
  completedAt: number | null;
  modelId?: string;
  modelProvider?: string;
  contextItems?: AgentContextItem[];
}

interface AgentViewState {
  isRunning: boolean;
  stepCount: number;
  startTime: number;
  currentThought: string;
}

interface AgentTraceHandle {
  updateTrace: (state: {
    completedTurns: Array<{ task: string; events: AgentEvent[]; answer: string | null; modelId?: string; modelProvider?: string; startedAt?: number; completedAt?: number; contextItems?: AgentContextItem[] }>;
    currentTask: string;
    currentEvents: AgentEvent[];
    isRunning: boolean;
    modelNames: string[];
    turnElapsedTimes: string[];
    currentStartTime?: number;
    onRevertTurn?: (turnIndex: number, newTask: string) => void;
    currentContextItems?: AgentContextItem[];
  }) => void;
}

export class AgentView extends ItemView {
  private plugin: AIPlugin;
  private traceComponent: ReturnType<typeof mount> | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLElement | null = null;
  private statusBarEl: HTMLElement | null = null;
  private agentSelectedFiles: Set<string> = new Set();
  private agentSelectedEmbeddingIndexes: Set<string> = new Set();
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
  private thinkingBtnEl: HTMLElement | null = null;
  private sessionManager: AIChatSessionManager;
  private currentSessionId: string | null = null;
  private currentSessionCreatedAt: number | null = null;
  private currentSessionType: 'chat' | 'agent' | null = null;
  private chatTurnIds: Set<string> = new Set();
  private currentModelId: string = '';
  private currentModelProvider: string = '';
  private toolCallIdCounter: number = 0;
  private currentTurnContext: AgentContextItem[] = [];
  private finalStreamTimer: number | null = null;
  private traceContainerEl: HTMLElement | null = null;
  private navRailEl: HTMLElement | null = null;
  private navListEl: HTMLElement | null = null;
  private navOpenTimer: number | null = null;
  private jumpBtnEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: AIPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.turns = [];
    this.currentTurnEvents = [];
    this.sessionManager = new AIChatSessionManager(this.app);
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
    if (event.type === 'answer_chunk') {
      const existingChunk = this.currentTurnEvents.find(e => e.type === 'answer_chunk');
      if (existingChunk) {
        existingChunk.data = event.data;
        existingChunk.timestamp = event.timestamp;
      } else {
        this.currentTurnEvents.push({
          type: event.type,
          data: event.data,
          timestamp: event.timestamp,
        });
      }
    } else {
      this.currentTurnEvents.push({
        type: event.type,
        data: event.data,
        timestamp: event.timestamp,
      });
    }

    if (event.type === 'step') {
      const stepData = event.data as { step: number; status: string; thought: string; toolName: string | null };
      this.state.stepCount = stepData.step;
      this.state.currentThought = stepData.thought;
    }
    if (event.type === 'thought') {
      const thoughtData = event.data as { thought?: string; text?: string };
      this.state.currentThought = thoughtData.thought || thoughtData.text || '';
    }

    this.state = {
      isRunning: this.state.isRunning,
      stepCount: this.state.stepCount,
      startTime: this.state.startTime,
      currentThought: this.state.currentThought,
    };
    this.updateUI();
    this.syncTraceComponent();
  }

  setRunning(running: boolean): void {
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
    this.currentTurnContext = [];
    if (this.plugin.agentOrchestrator) {
      this.plugin.agentOrchestrator.clearSession();
    }
    this.agentSelectedFiles.clear();
    this.agentSelectedEmbeddingIndexes.clear();
    this.currentSessionId = null;
    this.currentSessionCreatedAt = null;
    this.currentSessionType = null;
    this.chatTurnIds.clear();
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
      this.currentSessionCreatedAt = now;
    }

    const session: AIChatSession = {
      id: this.currentSessionId,
      name: sessionName,
      createdAt: this.currentSessionCreatedAt ?? now,
      updatedAt: now,
      sessionType: this.currentSessionType ?? 'agent',
      messages: this.turns.map(t => {
        if (this.chatTurnIds.has(t.id)) {
          return {
            question: t.task,
            answer: t.answer || '',
            timestamp: t.startedAt,
            id: t.id,
            modelName: t.modelId,
            modelProvider: t.modelProvider,
            context: t.contextItems?.map(item => item.type === 'file' ? item.path || item.name : `index:${item.name}`),
          };
        }
        const cleanTask = (t.task || '').replace(/\n+/g, ' ').replace(/^(New task:\s*)+/i, '').trim();
        const summary = cleanTask.length > 150 ? cleanTask.substring(0, 147) + '...' : cleanTask;
        const keywords = this.plugin.agentMemory ? this.plugin.agentMemory.extractKeywords(t.task, t.answer ?? undefined) : [];

        const extractedLessons: string[] = [];
        const fullText = (t.answer || '') + ' ' + (t.events || []).map(e => String((e as unknown as Record<string, unknown>).thought || '')).join(' ');
        const matches = fullText.matchAll(/<lesson>([\s\S]*?)<\/lesson>/gi);
        for (const match of matches) {
          const text = match[1].trim();
          if (text && !extractedLessons.includes(text)) {
            extractedLessons.push(text.slice(0, 200));
          }
        }
        if (extractedLessons.length === 0 && keywords.length > 0 && t.answer && t.completedAt !== null) {
          const topTopics = keywords.slice(0, 5).join(', ');
          extractedLessons.push(`Topics covered: ${topTopics}`);
        }

        return {
          question: t.task,
          answer: t.answer || '',
          timestamp: t.startedAt,
          id: t.id,
          agentSteps: t.events as unknown[],
          isAgentResponse: true,
          modelName: t.modelId,
          modelProvider: t.modelProvider,
          completedAt: t.completedAt ?? undefined,
          context: t.contextItems?.map(item => item.type === 'file' ? item.path || item.name : `index:${item.name}`),
          summary,
          keywords,
          lessons: extractedLessons,
          importance: Math.min(1.0, 0.4 + extractedLessons.length * 0.2 + (t.completedAt !== null ? 0.2 : 0)),
          stepsCount: (t.events || []).filter(e => (e as unknown as Record<string, unknown>).type === 'step').length || 1,
          success: t.completedAt !== null,
        };
      }),
    };

    await this.sessionManager.saveSession(session);
  }

  private async openAgentSessionHistory(): Promise<void> {
    openSessionHistoryModal({
      app: this.app,
      aiChatSessionManager: this.sessionManager,
      activeViewType: 'agent',
      onLoadChatSession: async (id) => {
        await this.loadAgentSession(id);
      },
      onLoadAgentSession: async (id) => {
        await this.loadAgentSession(id);
      },
    });
  }

  private async loadAgentSession(sessionId: string): Promise<void> {
    // Cross-view guardrail: block if the session is open in an AI Chat view
    const chatLeaves = this.app.workspace.getLeavesOfType('NEXUS_CHAT_VIEW');
    for (const leaf of chatLeaves) {
      const view = leaf.view as { currentSessionId?: string | null } | null;
      if (view?.currentSessionId === sessionId) {
        new Notice('This session is already open in the AI Chat view.');
        return;
      }
    }

    const session = await this.sessionManager.loadSession(sessionId);
    if (!session) {
      new Notice('Session not found.');
      return;
    }

    this.currentSessionId = session.id;
    this.currentSessionCreatedAt = session.createdAt;
    this.currentSessionType = session.sessionType ?? (session.messages?.some(m => m.isAgentResponse) ? 'agent' : 'chat');
    this.chatTurnIds.clear();
    this.turns = [];
    this.currentTurnEvents = [];
    this.currentTask = '';
    this.currentTurnId = null;

    for (const msg of session.messages) {
      const turnId = msg.id || `restored_${msg.timestamp}`;
      if (msg.isAgentResponse) {
        const events = (msg.agentSteps || []) as AgentEvent[];
        this.turns.push({
          id: turnId,
          task: msg.question,
          events,
          answer: msg.answer,
          startedAt: msg.timestamp,
          completedAt: msg.completedAt ?? msg.timestamp,
          modelId: msg.modelName,
          modelProvider: msg.modelProvider,
          contextItems: Array.isArray(msg.context)
            ? msg.context.map(value => {
              const raw = String(value);
              return raw.startsWith('index:')
                ? { type: 'embedding-index' as const, name: raw.slice(6) }
                : { type: 'file' as const, name: raw.split('/').pop() || raw, path: raw };
            })
            : undefined,
        });
      } else {
        this.chatTurnIds.add(turnId);
        this.turns.push({
          id: turnId,
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
    this.currentSessionCreatedAt = null;
    this.currentSessionType = null;
    this.chatTurnIds.clear();
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
    this.renderAgentContextList(listContainer, '');

    searchInput.addEventListener('input', () => {
      this.renderAgentContextList(listContainer, searchInput.value);
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

    const files = this.app.vault.getFiles().filter(file => isExtractable(file.name));
    const matchingFiles = files.filter(file =>
      file.basename.toLowerCase().includes(lowerSearch) ||
      file.path.toLowerCase().includes(lowerSearch)
    ).slice(0, 15);

    if (matchingFiles.length === 0) {
      const noResults = container.createDiv({ cls: 'context-file-menu-item nl-opacity-05' });
      noResults.textContent = 'No matches found';
    } else {
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
  }

  private renderAgentContextList(container: HTMLElement, searchTerm: string): void {
    this.renderAgentFileList(container, searchTerm);

    const indexes = (this.plugin.settings.indexConfigurations || [])
      .filter(index => index.type === 'embedding')
      .filter(index => {
        const term = searchTerm.toLowerCase();
        return !term || index.name.toLowerCase().includes(term);
      });

    const section = container.createDiv({ cls: 'context-file-menu-section' });
    section.createEl('hr', { cls: 'menu-separator' });
    section.createEl('div', {
      text: 'Embedding indexes',
      cls: 'context-file-menu-section-header',
    });

    if (indexes.length === 0) {
      section.createDiv({ cls: 'context-file-menu-item nl-opacity-05', text: 'No embedding indexes found' });
      return;
    }

    indexes.forEach(index => {
      const item = section.createDiv({ cls: 'context-file-menu-item' });
      const checkbox = item.createEl('input', { type: 'checkbox' });
      checkbox.checked = this.agentSelectedEmbeddingIndexes.has(index.id);
      checkbox.setAttr('aria-label', `Use embedding index ${index.name}`);
      item.createSpan({ text: ` ${index.name}` });
      item.createSpan({ text: ` (${index.fileCount || 0} files)`, cls: 'nl-color-var--text-muted' });

      item.addEventListener('click', (event) => {
        event.stopPropagation();
        if (this.agentSelectedEmbeddingIndexes.has(index.id)) {
          this.agentSelectedEmbeddingIndexes.delete(index.id);
          checkbox.checked = false;
        } else {
          this.agentSelectedEmbeddingIndexes.add(index.id);
          checkbox.checked = true;
        }
        this.renderAgentFileCapsules();
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
      if (files.length > 0 || this.agentSelectedEmbeddingIndexes.size > 0) {
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

    Array.from(this.agentSelectedEmbeddingIndexes).forEach(indexId => {
      const index = this.plugin.settings.indexConfigurations?.find(item => item.id === indexId);
      if (!index) return;
      const tag = container.createDiv({ cls: 'capsule-file-tag' });
      const icon = tag.createSpan({ cls: 'capsule-icon' });
      setIcon(icon, 'database');
      tag.createSpan({ cls: 'capsule-label', text: index.name });
      tag.setAttr('title', `Embedding index: ${index.name}`);
      tag.addEventListener('click', () => {
        this.agentSelectedEmbeddingIndexes.delete(indexId);
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
    this.timerInterval = window.setInterval(() => {
      this.updateStatusBar();
    }, 500);
  }

  private stopTimer(): void {
    if (this.timerInterval !== null) {
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
    if (!this.statusTextEl || !this.state.isRunning) return;
    const elapsed = this.formatElapsed(Date.now() - this.state.startTime);
    const activity = this.state.currentThought || 'Working';
    this.statusTextEl.textContent = `${activity} - ${elapsed}`;
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
    if (this.inputEl) {
      this.inputEl.disabled = this.state.isRunning;
    }
    if (this.state.isRunning) {
      this.updateStatusBar();
    }
  }

  private formatElapsedMmSs(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const sec = (totalSec % 60).toString().padStart(2, '0');
    return `${min}:${sec}`;
  }

  private syncTraceComponent(): void {
    if (this.traceComponent) {
      const el = this.traceComponent as unknown as AgentTraceHandle;
      el.updateTrace({        isRunning: this.state.isRunning,
        completedTurns: this.turns.map(t => ({
          task: t.task,
          events: t.events,
          answer: t.answer,
          modelId: t.modelId,
          modelProvider: t.modelProvider,
          startedAt: t.startedAt,
          completedAt: t.completedAt ?? undefined,
          contextItems: t.contextItems,
        })),
        currentTask: this.currentTask,
        currentEvents: [...this.currentTurnEvents],
        currentStartTime: this.state.startTime,
        currentContextItems: [...this.currentTurnContext],
        modelNames: this.turns.map(t =>
          t.modelId ? getModelDisplayName(t.modelId, this.plugin.settings, t.modelProvider as any) : ''
        ),
        turnElapsedTimes: this.turns.map(t => t.startedAt && t.completedAt ? this.formatElapsedMmSs(t.completedAt - t.startedAt) : ''),
        onRevertTurn: async (turnIndex: number, newTask: string) => {
          const revertedTurns = this.turns.slice(turnIndex);
          this.turns.splice(turnIndex);
          const orchestrator = this.plugin.agentOrchestrator;
          if (orchestrator) {
            orchestrator.clearScratchpad();
            for (const turn of revertedTurns) {
              if (turn.id) {
                await orchestrator.deleteEpisodicMemory(turn.id);
              }
            }
          }
          if (this.inputEl) this.inputEl.value = newTask;
          await this.handleSend();
        },
      });
    }
    this.updateNavRail();
    this.updateJumpButton();
  }

  private setNavOpen(open: boolean): void {
    if (this.navOpenTimer !== null) {
      window.clearTimeout(this.navOpenTimer);
      this.navOpenTimer = null;
    }
    this.navRailEl?.toggleClass('is-open', open);
  }

  private scheduleNavClose(): void {
    if (this.navOpenTimer !== null) {
      window.clearTimeout(this.navOpenTimer);
    }
    this.navOpenTimer = window.setTimeout(() => this.setNavOpen(false), 220);
  }

  private truncateQuery(text: string): string {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return '';
    const words = cleaned.split(' ');
    const trimmed = words.slice(0, 5).join(' ');
    const truncated = trimmed.length > 34 ? trimmed.slice(0, 34).replace(/\s+\S*$/, '') : trimmed;
    const shortened = truncated.length < cleaned.length ? `${truncated.replace(/[.,;:]+$/, '')}…` : truncated;
    return shortened || cleaned.slice(0, 34) + '…';
  }

  private updateNavRail(): void {
    if (!this.navRailEl || !this.navListEl) return;
    this.navListEl.empty();
    const items: Array<{ index: number; label: string; isRunning: boolean }> = [];
    this.turns.forEach((t, i) => {
      items.push({ index: i, label: this.truncateQuery(t.task), isRunning: false });
    });
    if (this.currentTask) {
      items.push({ index: this.turns.length, label: this.truncateQuery(this.currentTask), isRunning: true });
    }
    this.navRailEl.toggleClass('is-hidden', items.length === 0);
    for (const item of items) {
      const row = this.navListEl.createDiv({ cls: 'agent-nav-rail-item' });
      const dot = row.createDiv({ cls: 'agent-nav-rail-item-dot' });
      if (item.isRunning) dot.setAttr('data-running', 'true');
      const labelEl = row.createDiv({ cls: 'agent-nav-rail-item-text' });
      labelEl.setText(item.label);
      labelEl.setAttr('title', this.turns[item.index]?.task ?? this.currentTask ?? item.label);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        this.scrollToTurn(item.index);
      });
    }
  }

  private scrollToTurn(index: number): void {
    const container = this.traceContainerEl;
    if (!container) return;
    const target = container.querySelector(`[data-agent-turn-index="${index}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  private updateJumpButton(): void {
    const btn = this.jumpBtnEl;
    const container = this.traceContainerEl;
    if (!btn || !container) return;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    const hasMessages = this.turns.length > 0 || Boolean(this.currentTask);
    btn.toggleClass('is-visible', hasMessages && !atBottom && container.scrollHeight > container.clientHeight);
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

  private updateThinkingButtonLabel(): void {
    if (!this.thinkingBtnEl) return;
    const provider = this.getActiveProviderId();
    const modelId = this.getActiveModelId();
    const settings = this.plugin.settings;
    let label = 'Thinking off';
    if (provider === 'gemini') {
      if (modelId.startsWith('gemini-2.5')) {
        label = settings.enableThinkingMode ? `Gemini 2.5: ${settings.gemini25ThinkingMode || 'dynamic'}` : 'Thinking off';
      } else if (modelId.startsWith('gemini-3')) {
        label = settings.enableThinkingMode ? `Gemini 3: ${settings.gemini3ThinkingLevel || 'high'}` : 'Thinking off';
      } else {
        label = settings.enableThinkingMode ? 'Thinking on' : 'Thinking off';
      }
    } else if (provider === 'groq' && /gpt-oss/i.test(modelId)) {
      label = `Groq: ${settings.groqThinkingLevel || 'medium'}`;
    } else if (provider === 'ollama') {
      const isGptOss = modelId.toLowerCase().includes('gpt-oss');
      if (isGptOss) {
        label = `Ollama: ${settings.ollamaGptOssThinkingLevel || 'medium'}`;
      } else {
        label = settings.ollamaThinkingEnabled ? 'Thinking on' : 'Thinking off';
      }
    } else if (provider === 'openrouter' || provider === 'nvidia') {
      label = 'Thinking (passive)';
    }
    this.thinkingBtnEl.setAttr('title', label);
    this.thinkingBtnEl.setAttr('aria-label', label);
  }

  private async handleThinkingButtonClick(): Promise<void> {
    const provider = this.getActiveProviderId();
    const modelId = this.getActiveModelId();
    const settings = this.plugin.settings;

    if (provider === 'gemini') {
      if (modelId.startsWith('gemini-2.5')) {
        this.showGemini25ThinkingMenu();
        return;
      }
      if (modelId.startsWith('gemini-3')) {
        this.showGemini3ThinkingMenu();
        return;
      }
      settings.enableThinkingMode = !settings.enableThinkingMode;
      await this.plugin.saveSettings();
      this.updateThinkingButtonLabel();
      return;
    }

    if (provider === 'groq' && /gpt-oss/i.test(modelId)) {
      this.showLevelThinkingMenu('groq');
      return;
    }

    if (provider === 'ollama') {
      const isGptOss = modelId.toLowerCase().includes('gpt-oss');
      if (isGptOss) {
        this.showLevelThinkingMenu('ollama');
        return;
      }
      settings.ollamaThinkingEnabled = !settings.ollamaThinkingEnabled;
      await this.plugin.saveSettings();
      this.updateThinkingButtonLabel();
      return;
    }

    new Notice('Thinking settings are provider-specific. OpenAI, Anthropic (via OpenRouter), and Nvidia support thinking passively.');
  }

  private showLevelThinkingMenu(target: 'groq' | 'ollama'): void {
    const existing = this.containerEl.querySelector('.ollama-thinking-menu');
    if (existing) { existing.remove(); return; }
    if (!this.thinkingBtnEl) return;

    const menuEl = this.containerEl.createDiv({ cls: 'ollama-thinking-menu' });
    const levels: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
    const current = target === 'groq' ? this.plugin.settings.groqThinkingLevel : this.plugin.settings.ollamaGptOssThinkingLevel;

    levels.forEach(level => {
      const item = menuEl.createDiv({ cls: 'ollama-thinking-menu-item' });
      item.textContent = level.charAt(0).toUpperCase() + level.slice(1);
      if ((current || 'medium') === level) item.addClass('selected');
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (target === 'groq') {
          this.plugin.settings.groqThinkingLevel = level;
        } else {
          this.plugin.settings.ollamaGptOssThinkingLevel = level;
        }
        await this.plugin.saveSettings();
        menuEl.remove();
        this.updateThinkingButtonLabel();
      });
    });

    const btnRect = this.thinkingBtnEl.getBoundingClientRect();
    const containerRect = this.containerEl.getBoundingClientRect();
    menuEl.addClass('nl-position-absolute');
    menuEl.setCssProps({ '--menu-top': `${btnRect.bottom - containerRect.top + 4}px` });
    menuEl.setCssProps({ '--menu-right': `${containerRect.right - btnRect.right}px` });

    const closeHandler = (e: MouseEvent) => {
      if (!menuEl.contains(e.target as Node) && !(e.target as Element).closest('.header-ollama-thinking-btn')) {
        menuEl.remove();
        this.containerEl.ownerDocument.removeEventListener('click', closeHandler);
      }
    };
    window.setTimeout(() => this.containerEl.ownerDocument.addEventListener('click', closeHandler), 0);
  }

  private showGemini25ThinkingMenu(): void {
    const existing = this.containerEl.querySelector('.ollama-thinking-menu');
    if (existing) { existing.remove(); return; }
    if (!this.thinkingBtnEl) return;

    const menuEl = this.containerEl.createDiv({ cls: 'ollama-thinking-menu' });
    const options: Array<{ id: AISettings['gemini25ThinkingMode']; label: string }> = [
      { id: 'off', label: 'Off' },
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'dynamic', label: 'Dynamic' },
    ];
    const selected = this.plugin.settings.enableThinkingMode ? (this.plugin.settings.gemini25ThinkingMode || 'dynamic') : 'off';

    options.forEach(option => {
      const item = menuEl.createDiv({ cls: 'ollama-thinking-menu-item' });
      item.textContent = option.label;
      if (selected === option.id) item.addClass('selected');
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (option.id === 'off') {
          this.plugin.settings.enableThinkingMode = false;
        } else {
          this.plugin.settings.enableThinkingMode = true;
          this.plugin.settings.gemini25ThinkingMode = option.id as AISettings['gemini25ThinkingMode'];
        }
        await this.plugin.saveSettings();
        menuEl.remove();
        this.updateThinkingButtonLabel();
      });
    });

    const btnRect = this.thinkingBtnEl.getBoundingClientRect();
    const containerRect = this.containerEl.getBoundingClientRect();
    menuEl.addClass('nl-position-absolute');
    menuEl.setCssProps({ '--menu-top': `${btnRect.bottom - containerRect.top + 4}px` });
    menuEl.setCssProps({ '--menu-right': `${containerRect.right - btnRect.right}px` });

    const closeHandler = (e: MouseEvent) => {
      if (!menuEl.contains(e.target as Node) && !(e.target as Element).closest('.header-ollama-thinking-btn')) {
        menuEl.remove();
        this.containerEl.ownerDocument.removeEventListener('click', closeHandler);
      }
    };
    window.setTimeout(() => this.containerEl.ownerDocument.addEventListener('click', closeHandler), 0);
  }

  private showGemini3ThinkingMenu(): void {
    const existing = this.containerEl.querySelector('.ollama-thinking-menu');
    if (existing) { existing.remove(); return; }
    if (!this.thinkingBtnEl) return;

    const menuEl = this.containerEl.createDiv({ cls: 'ollama-thinking-menu' });
    const options: Array<{ id: AISettings['gemini3ThinkingLevel']; label: string }> = [
      { id: 'minimal', label: 'Minimal' },
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
    ];
    const selected = this.plugin.settings.enableThinkingMode ? (this.plugin.settings.gemini3ThinkingLevel || 'high') : 'off';

    options.forEach(option => {
      const item = menuEl.createDiv({ cls: 'ollama-thinking-menu-item' });
      item.textContent = option.label;
      if (selected === option.id) item.addClass('selected');
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        this.plugin.settings.enableThinkingMode = true;
        this.plugin.settings.gemini3ThinkingLevel = option.id as AISettings['gemini3ThinkingLevel'];
        await this.plugin.saveSettings();
        menuEl.remove();
        this.updateThinkingButtonLabel();
      });
    });

    const btnRect = this.thinkingBtnEl.getBoundingClientRect();
    const containerRect = this.containerEl.getBoundingClientRect();
    menuEl.addClass('nl-position-absolute');
    menuEl.setCssProps({ '--menu-top': `${btnRect.bottom - containerRect.top + 4}px` });
    menuEl.setCssProps({ '--menu-right': `${containerRect.right - btnRect.right}px` });

    const closeHandler = (e: MouseEvent) => {
      if (!menuEl.contains(e.target as Node) && !(e.target as Element).closest('.header-ollama-thinking-btn')) {
        menuEl.remove();
        this.containerEl.ownerDocument.removeEventListener('click', closeHandler);
      }
    };
    window.setTimeout(() => this.containerEl.ownerDocument.addEventListener('click', closeHandler), 0);
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
          if (this.thinkingBtnEl) {
            const isDropdown = (model.provider === 'gemini' && (model.id.startsWith('gemini-2.5') || model.id.startsWith('gemini-3'))) ||
              (model.provider === 'groq' && /gpt-oss/i.test(model.id)) ||
              (model.provider === 'ollama' && model.id.toLowerCase().includes('gpt-oss'));
            this.thinkingBtnEl.toggleClass('has-dropdown', isDropdown);
          }
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

  private togglePlugCallout(anchorEl: HTMLElement): void {
    const existing = this.containerEl.querySelector('.agent-plug-callout');
    if (existing) {
      existing.remove();
      return;
    }

    const calloutEl = this.containerEl.createDiv({ cls: 'agent-plug-callout' });

    const header = calloutEl.createDiv({ cls: 'agent-plug-callout-header' });
    header.createEl('span', { text: 'Agent Capabilities' });
    const closeBtn = header.createEl('button', { cls: 'close-btn' });
    setIcon(closeBtn, 'x');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      calloutEl.remove();
    });

    const body = calloutEl.createDiv({ cls: 'agent-plug-callout-body' });

    // --- Left Half: MCPs ---
    const leftHalf = body.createDiv({ cls: 'agent-plug-half agent-plug-left' });
    leftHalf.createDiv({ cls: 'agent-plug-section-title', text: 'MCP Servers' });

    const mcpListContainer = leftHalf.createDiv({ cls: 'agent-plug-list' });

    const mcpEnabledGlobal = this.plugin.settings.mcpEnabled !== false;
    const allMcpServers = this.plugin.settings.mcpServers || [];
    const enabledSettingsMcps = mcpEnabledGlobal ? allMcpServers.filter(s => !s.disabled) : [];

    if (enabledSettingsMcps.length === 0) {
      mcpListContainer.createDiv({ cls: 'agent-plug-empty', text: 'No enabled MCP servers' });
    } else {
      for (const server of enabledSettingsMcps) {
        const item = mcpListContainer.createEl('label', { cls: 'agent-plug-item' });
        const checkbox = item.createEl('input', { type: 'checkbox' });

        const isChecked = this.plugin.settings.agentEnabledMCPs === undefined
          ? true
          : this.plugin.settings.agentEnabledMCPs.includes(server.id);

        checkbox.checked = isChecked;

        item.createEl('span', { text: server.name });

        checkbox.addEventListener('change', async (e) => {
          e.stopPropagation();
          if (this.plugin.settings.agentEnabledMCPs === undefined) {
            this.plugin.settings.agentEnabledMCPs = enabledSettingsMcps.map(s => s.id);
          }

          if (checkbox.checked) {
            if (!this.plugin.settings.agentEnabledMCPs.includes(server.id)) {
              this.plugin.settings.agentEnabledMCPs.push(server.id);
            }
          } else {
            this.plugin.settings.agentEnabledMCPs = this.plugin.settings.agentEnabledMCPs.filter(id => id !== server.id);
          }

          this.plugin.settings.agentEnableMCP = true;
          await this.plugin.saveSettings();
          this.plugin.refreshAgentMCPTools();
        });
      }
    }

    // --- Right Half: Skills ---
    const rightHalf = body.createDiv({ cls: 'agent-plug-half agent-plug-right' });
    rightHalf.createDiv({ cls: 'agent-plug-section-title', text: 'Enabled Skills' });

    const skillListContainer = rightHalf.createDiv({ cls: 'agent-plug-list' });

    const skillsEnabledGlobal = this.plugin.settings.agentSkillsEnabled !== false;
    const enabledSkills = (skillsEnabledGlobal && this.plugin.skillRegistry)
      ? this.plugin.skillRegistry.getEnabled()
      : [];

    if (enabledSkills.length === 0) {
      skillListContainer.createDiv({ cls: 'agent-plug-empty', text: 'No enabled skills' });
    } else {
      for (const skill of enabledSkills) {
        const item = skillListContainer.createDiv({ cls: 'agent-plug-item agent-plug-skill-item' });
        const iconSpan = item.createSpan({ cls: 'agent-plug-skill-icon' });
        setIcon(iconSpan, 'zap');
        item.createSpan({ text: skill.metadata.name, cls: 'agent-plug-skill-name' });
      }
    }

    // Positioning
    const btnRect = anchorEl.getBoundingClientRect();
    const containerRect = this.containerEl.getBoundingClientRect();
    let leftPos = btnRect.left - containerRect.left;
    if (leftPos + 440 > containerRect.width) {
      leftPos = Math.max(8, containerRect.width - 448);
    }

    calloutEl.setCssProps({
      '--callout-top': `${btnRect.bottom - containerRect.top + 4}px`,
      '--callout-left': `${leftPos}px`,
    });

    // Dismiss on click outside
    const closeHandler = (e: MouseEvent) => {
      if (!calloutEl.contains(e.target as Node) && !anchorEl.contains(e.target as Node)) {
        calloutEl.remove();
        this.containerEl.ownerDocument.removeEventListener('click', closeHandler);
      }
    };
    window.setTimeout(() => this.containerEl.ownerDocument.addEventListener('click', closeHandler), 0);
  }

  async onOpen(): Promise<void> {
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

    const plugBtn = headerLeft.createDiv({ cls: 'agent-view-header-btn' });
    setIcon(plugBtn, 'plug');
    plugBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePlugCallout(plugBtn);
    });
    plugBtn.setAttr('aria-label', 'Agent capabilities (MCP & Skills)');

    const newSessionBtn = headerLeft.createDiv({ cls: 'agent-view-header-btn' });
    setIcon(newSessionBtn, 'plus');
    newSessionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.startNewAgentSession();
    });
    newSessionBtn.setAttr('aria-label', 'New session');

    const headerRight = headerEl.createDiv({ cls: 'agent-view-header-right' });

    this.thinkingBtnEl = headerRight.createDiv({ cls: 'header-ollama-thinking-btn' });
    setIcon(this.thinkingBtnEl, 'brain');
    this.thinkingBtnEl.addClass('nl-cursor-pointer');
    this.thinkingBtnEl.setAttr('tabindex', '0');
    const thinkProvider = this.getActiveProviderId();
    const thinkModelId = this.getActiveModelId();
    if ((thinkProvider === 'gemini' && (thinkModelId.startsWith('gemini-2.5') || thinkModelId.startsWith('gemini-3'))) ||
        (thinkProvider === 'groq' && /gpt-oss/i.test(thinkModelId)) ||
        (thinkProvider === 'ollama' && thinkModelId.toLowerCase().includes('gpt-oss'))) {
      this.thinkingBtnEl.addClass('has-dropdown');
    }
    this.updateThinkingButtonLabel();
    this.thinkingBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.handleThinkingButtonClick();
    });

    this.modelBtn = new ButtonComponent(headerRight)
      .setButtonText(this.getModelButtonText())
      .setClass('header-model-btn')
      .onClick(() => this.showModelMenu());

    const traceContainer = contentEl.createDiv({ cls: 'agent-view-trace' });
    this.traceContainerEl = traceContainer;
    const inputContainer = contentEl.createDiv({ cls: 'chat-input-container' });

    const navRail = contentEl.createDiv({ cls: 'agent-nav-rail' });
    this.navRailEl = navRail;
    const navBar = navRail.createDiv({ cls: 'agent-nav-rail-bar' });
    navBar.setAttr('aria-label', 'Session questions navigation');
    navBar.addEventListener('click', (e) => {
      e.stopPropagation();
      navRail.addClass('is-open');
    });
    navRail.addEventListener('mouseenter', () => this.setNavOpen(true));
    navRail.addEventListener('mouseleave', () => this.scheduleNavClose());
    document.addEventListener('click', (e) => {
      if (this.navRailEl && !this.navRailEl.contains(e.target as Node)) {
        this.setNavOpen(false);
      }
    });
    const navPopover = navRail.createDiv({ cls: 'agent-nav-rail-popover' });
    this.navListEl = navPopover.createDiv({ cls: 'agent-nav-rail-list' });

    const jumpBtn = inputContainer.createDiv({ cls: 'agent-jump-bottom-btn' });
    this.jumpBtnEl = jumpBtn;
    setIcon(jumpBtn, 'arrow-down');
    jumpBtn.setAttr('aria-label', 'Scroll to bottom');
    jumpBtn.setAttr('tabindex', '0');
    jumpBtn.addEventListener('click', () => {
      if (this.traceContainerEl) {
        this.traceContainerEl.scrollTo({ top: this.traceContainerEl.scrollHeight, behavior: 'smooth' });
      }
    });
    traceContainer.addEventListener('scroll', () => this.updateJumpButton());

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

    this.traceComponent = mount(AgentTrace, {
      target: traceContainer,
      props: {
        completedTurns: [],
        currentTask: '',
        currentEvents: [],
        isRunning: false,
        app: this.app,
        turnElapsedTimes: [],
        onApprove: (approvalId: string) => {
          this.plugin.agentOrchestrator?.resolveApproval(approvalId, true);
        },
        onRevert: (approvalId: string) => {
          void this.plugin.agentOrchestrator?.revertOperation(approvalId);
        },
      },
    });

    this.updateUI();
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
    this.currentTurnContext = [];
    this.inputEl.value = '';

    const selectedFiles = new Set(this.agentSelectedFiles);
    const selectedEmbeddingIndexes = new Set(this.agentSelectedEmbeddingIndexes);
    this.currentTurnContext = [
      ...Array.from(selectedFiles).map(path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return {
          type: 'file' as const,
          name: file instanceof TFile ? file.basename : path.split('/').pop() || path,
          path,
          extension: file instanceof TFile ? file.extension : undefined,
        };
      }),
      ...Array.from(selectedEmbeddingIndexes).map(indexId => {
        const index = this.plugin.settings.indexConfigurations?.find(item => item.id === indexId);
        return { type: 'embedding-index' as const, name: index?.name || indexId };
      }),
    ];
    this.agentSelectedFiles.clear();
    this.agentSelectedEmbeddingIndexes.clear();
    if (this.agentCapsuleDisplay) {
      this.agentCapsuleDisplay.empty();
      const capsuleContainer = this.agentCapsuleDisplay.parentElement;
      if (capsuleContainer) {
        capsuleContainer.removeClass('has-content');
      }
    }

    this.state.stepCount = 0;
    this.state.currentThought = 'Starting agent execution...';

    const fileContext = await this.extractSelectedFileContext(selectedFiles);
    const taskPrompt = this.buildTaskPrompt(task);
    this.setRunning(true);

    this.runAgentTask(taskPrompt, selectedEmbeddingIndexes, task, fileContext).finally(() => {
      if (this.state.isRunning) {
        this.setRunning(false);
      }
    });
  }

  private async extractSelectedFileContext(selectedFiles: ReadonlySet<string>): Promise<string | undefined> {
    if (selectedFiles.size === 0) return undefined;

    const parts: string[] = [];
    for (const path of selectedFiles) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        try {
          const content = await extractTextFromFile(this.app, file);
          parts.push(`--- File: ${file.path} ---\n${content}`);
        } catch {
          parts.push(`--- File: ${file.path} ---\n[Could not read file]`);
        }
      }
    }
    if (parts.length === 0) return undefined;
    return `Context from selected files:\n${parts.join('\n\n')}`;
  }

  private buildTaskPrompt(task: string): string {
    if (/^\s*continue\s*$/i.test(task.trim())) return task;
    const previousTurns = this.turns.filter(t => t.answer);
    if (previousTurns.length === 0) return `New task: ${task}`;

    const summary = previousTurns.map((t, i) =>
      `Task ${i + 1}: ${t.task}\nResult: ${t.answer!.substring(0, 1000)}`
    ).join('\n\n');

    return `Previous conversation context:\n${summary}\n\nNew task: ${task}`;
  }

  private getAgentThinkingOptions(providerId: string, modelId: string): Record<string, unknown> {
    const settings = this.plugin.settings;
    switch (providerId) {
      case 'gemini': {
        const config = getGeminiThinkingConfig(modelId, settings);
        return config ? { thinkingConfig: config.thinkingConfig } : {};
      }
      case 'groq': {
        if (/gpt-oss/i.test(modelId)) {
          return { thinkingLevel: settings.groqThinkingLevel || 'medium' };
        }
        return {};
      }
      case 'ollama': {
        const isGptOss = modelId.toLowerCase().includes('gpt-oss');
        if (isGptOss) {
          return { think: settings.ollamaGptOssThinkingLevel || 'medium' };
        }
        return { think: !!settings.ollamaThinkingEnabled };
      }
      default:
        return {};
    }
  }

  private async callProvider(
    providerId: string,
    modelId: string,
    messages: Array<Record<string, unknown>>,
    onToken?: (chunk: string) => void,
    onThinking?: (thinking: string) => void,
    tools?: ToolDefinition[]
  ): Promise<{ content: string; finishReason?: string; toolCalls?: ToolCall[]; thinking?: string }> {
    const thinkingAcc: { value: string } = { value: '' };
    const res = await this.callProviderImpl(providerId, modelId, messages, onToken, onThinking, tools, thinkingAcc);
    return {
      content: res.content,
      finishReason: res.finishReason,
      toolCalls: res.toolCalls,
      thinking: thinkingAcc.value.length > 0 ? thinkingAcc.value : undefined,
    };
  }

  private async callProviderImpl(
    providerId: string,
    modelId: string,
    messages: Array<Record<string, unknown>>,
    onToken?: (chunk: string) => void,
    onThinking?: (thinking: string) => void,
    tools?: ToolDefinition[],
    thinkingAcc?: { value: string }
  ): Promise<{ content: string; finishReason?: string; toolCalls?: ToolCall[] }> {
    const providerTools = tools && tools.length > 0 ? buildProviderTools(tools) : undefined;
    const plainMessages = messages.map((m) => ({
      role: (m.role as 'system' | 'user' | 'assistant') || 'user',
      content: String(m.content ?? ''),
    }));

    const baseOpts = { temperature: 0.3, maxTokens: 8192 };
    const thinkingOpts = this.getAgentThinkingOptions(providerId, modelId);

    let accumulatedThinking = '';

    const emitThinking = (chunk: string) => {
      accumulatedThinking += chunk;
      if (thinkingAcc) thinkingAcc.value += chunk;
      onThinking?.(chunk);
    };

    switch (providerId) {
      case 'gemini': {
        const { GeminiService } = await import('../services/geminiService');
        const svc = new GeminiService(this.plugin.settings.geminiApiKey || this.plugin.settings.apiKey);
        if (providerTools) {
          const geminiOpts: Record<string, unknown> = { temperature: 0.3, maxOutputTokens: 8192, ...thinkingOpts };
          const res = await svc.generateContentWithToolsOnce(
            modelId,
            messages as unknown as Parameters<typeof svc.generateContentWithToolsOnce>[1],
            providerTools as unknown as Parameters<typeof svc.generateContentWithToolsOnce>[2],
            geminiOpts as Parameters<typeof svc.generateContentWithToolsOnce>[3]
          );
          if (res.thinking) emitThinking(res.thinking);
          return {
            content: res.content,
            finishReason: res.finishReason,
            toolCalls: normalizeToolCalls(res.toolCalls, 'gemini'),
          };
        }
        const prompt = plainMessages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
        const geminiOpts: Record<string, unknown> = { temperature: 0.3, maxOutputTokens: 8192, ...thinkingOpts };

        // Capture thinking from streaming via candidates[0].content.parts where thought === true
        const captureGeminiThinking = (chunk: unknown) => {
          try {
            const c = chunk as { candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> };
            const parts = c.candidates?.[0]?.content?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.thought === true && typeof part.text === 'string') {
                  emitThinking(part.text);
                }
              }
            }
          } catch { /* best effort */ }
        };

        if (onToken) {
          let accumulated = '';
          let geminiFinishReason: string | undefined;
          const { GoogleGenerativeAI } = await import('@google/generative-ai');
          const genAI = new GoogleGenerativeAI(this.plugin.settings.geminiApiKey || this.plugin.settings.apiKey);
          const modelInstance = genAI.getGenerativeModel({ model: modelId, generationConfig: geminiOpts as Record<string, unknown> });
          const streamResult = await modelInstance.generateContentStream(prompt, { signal: geminiOpts.abortSignal as AbortSignal | undefined });
          for await (const chunk of streamResult.stream) {
            captureGeminiThinking(chunk);
            const c = chunk as { candidates?: Array<{ finishReason?: string }> };
            if (c.candidates?.[0]?.finishReason) geminiFinishReason = c.candidates[0].finishReason;
            const text = chunk.text();
            if (!text) continue;
            accumulated += text;
            onToken(accumulated);
          }
          const result = accumulatedThinking ? `<thinking>${accumulatedThinking}</thinking>\n${accumulated}` : accumulated;
          return { content: result, finishReason: geminiFinishReason };
        }
        let geminiFinishReason: string | undefined;
        const result = await svc.generateContentWithHeaders(modelId, prompt, geminiOpts, undefined, (reason) => { geminiFinishReason = reason; });
        const content = accumulatedThinking ? `<thinking>${accumulatedThinking}</thinking>\n${result}` : result;
        return { content, finishReason: geminiFinishReason };
      }

      case 'groq': {
        const { GroqService } = await import('../services/groqService');
        const svc = new GroqService(this.plugin.settings.groqApiKey);
        const groqOpts = { ...baseOpts, ...thinkingOpts } as Record<string, unknown>;
        if (providerTools) {
          const res = await svc.generateContentWithToolsOnce(
            modelId,
            messages as unknown as Parameters<typeof svc.generateContentWithToolsOnce>[1],
            providerTools,
            groqOpts as Parameters<typeof svc.generateContentWithToolsOnce>[3]
          );
          if (res.thinking) emitThinking(res.thinking);
          return {
            content: res.content,
            finishReason: res.finishReason,
            toolCalls: normalizeToolCalls(res.toolCalls, 'openai'),
          };
        }
        let groqFinishReason: string | undefined;
        if (onToken) {
          let accumulated = '';
          // Use generateContentStreamEvents for thinking support (captures reasoning_content from GPT-OSS models)
          await svc.generateContentStreamEvents(modelId, plainMessages, (evt) => {
            if (evt.type === 'content') {
              accumulated += evt.text;
              onToken(accumulated);
            } else if (evt.type === 'thinking') {
              emitThinking(evt.text);
            }
          }, groqOpts, (reason) => { groqFinishReason = reason; });
          const result = accumulatedThinking ? `<thinking>${accumulatedThinking}</thinking>\n${accumulated}` : accumulated;
          return { content: result, finishReason: groqFinishReason };
        }
        const result = await svc.generateContent(modelId, plainMessages, groqOpts, (reason) => { groqFinishReason = reason; });
        const content = accumulatedThinking ? `<thinking>${accumulatedThinking}</thinking>\n${result}` : result;
        return { content, finishReason: groqFinishReason };
      }

      case 'openrouter': {
        const { OpenRouterService } = await import('../services/openRouterService');
        const svc = new OpenRouterService(this.plugin.settings.openRouterApiKey);
        if (providerTools) {
          const res = await svc.generateContentWithToolsOnce(
            modelId,
            messages as unknown as Parameters<typeof svc.generateContentWithToolsOnce>[1],
            providerTools,
            baseOpts as Parameters<typeof svc.generateContentWithToolsOnce>[3]
          );
          if (res.thinking) emitThinking(res.thinking);
          return {
            content: res.content,
            finishReason: res.finishReason,
            toolCalls: normalizeToolCalls(res.toolCalls, 'openai'),
          };
        }
        let orFinishReason: string | undefined;
        if (onToken) {
          let accumulated = '';
          const result = await svc.generateContentStream(modelId, plainMessages, baseOpts, (chunk: string) => {
            accumulated += chunk;
            onToken(accumulated);
          }, (thinking: string) => { emitThinking(thinking); }, (reason) => { orFinishReason = reason; });
          const content = accumulatedThinking ? `<thinking>${accumulatedThinking}</thinking>\n${result}` : result;
          return { content, finishReason: orFinishReason };
        }
        const result = await svc.generateContent(modelId, plainMessages, baseOpts, (reason) => { orFinishReason = reason; });
        return { content: result, finishReason: orFinishReason };
      }

      case 'ollama': {
        const { OllamaService } = await import('../services/ollamaService');
        const svc = new OllamaService(this.plugin.settings.ollamaBaseUrl, this.plugin.settings.ollamaApiKey);
        const ollamaOpts = { ...baseOpts, ...thinkingOpts } as Record<string, unknown>;
        if (providerTools) {
          const ollamaMessages = messages.map((m) => ({
            role: m.role as string,
            content: typeof m.content === 'string' ? m.content : '',
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.name ? { tool_name: String(m.name) } : {}),
          }));
          const res = await svc.generateContentWithToolsOnce(
            modelId,
            ollamaMessages as unknown as Parameters<typeof svc.generateContentWithToolsOnce>[1],
            providerTools as unknown as Parameters<typeof svc.generateContentWithToolsOnce>[2],
            ollamaOpts as Parameters<typeof svc.generateContentWithToolsOnce>[3]
          );
          if (res.thinking) emitThinking(res.thinking);
          return {
            content: res.content,
            finishReason: res.finishReason,
            toolCalls: normalizeToolCalls(res.toolCalls, 'ollama'),
          };
        }
        let ollamaFinishReason: string | undefined;
        if (onToken) {
          let accumulated = '';
          await svc.generateContentStreamEvents(modelId, plainMessages, (evt) => {
            if (evt.type === 'content') {
              accumulated += evt.text;
              onToken(accumulated);
            } else if (evt.type === 'thinking') {
              emitThinking(evt.text);
            }
          }, ollamaOpts, (reason) => { ollamaFinishReason = reason; });
          const result = accumulatedThinking ? `<thinking>${accumulatedThinking}</thinking>\n${accumulated}` : accumulated;
          return { content: result, finishReason: ollamaFinishReason };
        }
        const result = await svc.generateContent(modelId, plainMessages, ollamaOpts, (reason) => { ollamaFinishReason = reason; });
        const content = accumulatedThinking ? `<thinking>${accumulatedThinking}</thinking>\n${result}` : result;
        return { content, finishReason: ollamaFinishReason };
      }

      case 'nvidia': {
        const { NvidiaService } = await import('../services/nvidiaService');
        const svc = new NvidiaService(this.plugin.settings.nvidiaApiKey);
        if (providerTools) {
          const res = await svc.generateContentWithToolsOnce(
            modelId,
            messages as unknown as Parameters<typeof svc.generateContentWithToolsOnce>[1],
            providerTools as unknown as Parameters<typeof svc.generateContentWithToolsOnce>[2],
            baseOpts as Parameters<typeof svc.generateContentWithToolsOnce>[3]
          );
          if (res.thinking) emitThinking(res.thinking);
          return {
            content: res.content,
            finishReason: res.finishReason,
            toolCalls: normalizeToolCalls(res.toolCalls, 'openai'),
          };
        }
        let nvidiaFinishReason: string | undefined;
        if (onToken) {
          let accumulated = '';
          const result = await svc.generateContentStream(modelId, plainMessages, baseOpts, (chunk: string) => {
            accumulated += chunk;
            onToken(accumulated);
          }, (thinking: string) => { emitThinking(thinking); }, (reason) => { nvidiaFinishReason = reason; });
          const content = accumulatedThinking ? `<thinking>${accumulatedThinking}</thinking>\n${result}` : result;
          return { content, finishReason: nvidiaFinishReason };
        }
        const result = await svc.generateContent(modelId, plainMessages, baseOpts, (reason) => { nvidiaFinishReason = reason; });
        return { content: result, finishReason: nvidiaFinishReason };
      }

      default: {
        const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(providerId);
        if (!unifiedProvider) {
          throw new Error(`AI provider "${providerId}" is not available. Configure API keys in Settings.`);
        }
        if (providerTools && unifiedProvider.generateContentWithToolsOnce) {
          const res = await unifiedProvider.generateContentWithToolsOnce(
            modelId,
            messages as unknown as Parameters<NonNullable<typeof unifiedProvider.generateContentWithToolsOnce>>[1],
            providerTools,
            baseOpts as Parameters<NonNullable<typeof unifiedProvider.generateContentWithToolsOnce>>[3]
          );
          if (res.thinking) emitThinking(res.thinking);
          return {
            content: res.content,
            finishReason: res.finishReason,
            toolCalls: normalizeToolCalls(res.toolCalls, 'openai'),
          };
        }
        if (onToken && unifiedProvider.streamContent) {
          let accumulated = '';
          const res = await unifiedProvider.streamContent(modelId, plainMessages, (chunk: string) => {
            accumulated += chunk;
            onToken(accumulated);
          }, baseOpts, (thinking: string) => { emitThinking(thinking); });
          const content = accumulatedThinking ? `<thinking>${accumulatedThinking}</thinking>\n${res.text || accumulated}` : (res.text || accumulated);
          return { content, finishReason: res.finishReason };
        }
        const res = await unifiedProvider.generateContent(modelId, plainMessages, baseOpts);
        if (onToken) onToken(res.text || '');
        return { content: res.text || '', finishReason: res.finishReason };
      }
    }
  }

  private parseToolCalls(text: string): ToolCall[] {
    const results: ToolCall[] = [];
    const seen = new Set<string>();

    const actionRegex = /ACTION:\s*([\w-]+)\s*\(/g;
    let actionMatch: RegExpExecArray | null;
    while ((actionMatch = actionRegex.exec(text)) !== null) {
      const name = actionMatch[1];
      const bodyStart = actionMatch.index + actionMatch[0].length;
      const bodyEnd = findClosingParenthesis(text, bodyStart);
      if (bodyEnd < 0) continue;
      const args = parseActionArguments(text.slice(bodyStart, bodyEnd));
      if (!args) continue;
      actionRegex.lastIndex = bodyEnd + 1;

      const key = `${name}:${JSON.stringify(args)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        id: `tc_${Date.now()}_${++this.toolCallIdCounter}`,
        name,
        arguments: args,
      });
    }

    const toolCallBlockRegex = /<tool_call>([\s\S]*?)<\/tool>/g;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = toolCallBlockRegex.exec(text)) !== null) {
      const block = blockMatch[1];

      const nameMatch = block.match(/<tool_name>([\s\S]*?)<\/tool_name>/);
      if (!nameMatch) continue;
      const name = nameMatch[1].trim();
      if (!name) continue;

      let args: Record<string, unknown> | null = null;

      const paramsMatch = block.match(/<parameters>([\s\S]*?)<\/parameters>/);
      if (paramsMatch) {
        try {
          const parsed = JSON.parse(paramsMatch[1].trim());
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            args = parsed;
          }
        } catch { /* not JSON, try arg_key/arg_value */ }
      }

      if (!args) {
        const argPairs: Record<string, unknown> = {};
        const argPairRegex = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
        let pairMatch: RegExpExecArray | null;
        while ((pairMatch = argPairRegex.exec(block)) !== null) {
          let value: unknown = pairMatch[2].trim();
          try { value = JSON.parse(value as string); } catch { /* keep as string */ }
          argPairs[pairMatch[1].trim()] = value;
        }
        if (Object.keys(argPairs).length > 0) args = argPairs;
      }

      if (!args) continue;

      const key = `${name}:${JSON.stringify(args)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        id: `tc_${Date.now()}_${++this.toolCallIdCounter}`,
        name,
        arguments: args,
      });
    }

    return results;
  }

  private completeCurrentTurn(answer: string | null): void {
    if (!this.currentTurnId) return;
    const session = this.plugin.agentOrchestrator?.getSession();
    const turnSessionId = session?.id || this.currentTurnId;
    this.turns.push({
      id: turnSessionId,
      task: this.currentTask,
      events: [...this.currentTurnEvents],
      answer,
      startedAt: this.state.startTime,
      completedAt: Date.now(),
      modelId: this.currentModelId || undefined,
      modelProvider: this.currentModelProvider || undefined,
      contextItems: this.currentTurnContext.length > 0 ? [...this.currentTurnContext] : undefined,
    });
    this.currentTurnId = null;
    this.currentTurnEvents = [];
    this.currentTask = '';
    void this.saveCurrentAgentSession();
  }

  private buildStreamPlan(fullText: string): Array<{ text: string; delay: number }> {
    const len = fullText.length;
    const plan: Array<{ text: string; delay: number }> = [];
    if (len === 0) return plan;
    const totalMs = Math.max(500, Math.min(2600, 650 + len * 1.3));
    let pos = 0;
    let chunkSize = Math.max(4, Math.round(len * 0.025));
    const capSize = Math.max(40, Math.round(len * 0.1));
    while (pos < len) {
      let size = Math.min(chunkSize, len - pos);
      if (size < len - pos && size > 14) {
        const window = fullText.slice(pos, pos + size);
        const space = window.lastIndexOf(' ');
        if (space > 7) size = space + 1;
      }
      plan.push({ text: fullText.slice(0, pos + size), delay: 0 });
      pos += size;
      chunkSize = Math.min(chunkSize * 1.55, capSize);
    }
    const perChunk = totalMs / plan.length;
    for (const step of plan) {
      step.delay = Math.max(8, Math.round(perChunk * (0.7 + Math.random() * 0.6)));
    }
    return plan;
  }

  private streamFinalAnswerSmoothly(text: string): Promise<void> {
    const self = this;
    if (!this.currentTurnId || !text) return Promise.resolve();
    const lastChunk = [...this.currentTurnEvents].reverse().find(e => e.type === 'answer_chunk');
    const streamed = lastChunk ? String((lastChunk.data as { text?: unknown })?.text ?? '') : '';
    if (streamed.length >= text.length) return Promise.resolve();

    const plan = this.buildStreamPlan(text);
    const start = Date.now();
    let index = 0;
    let accumulated = 0;

    return new Promise<void>((resolve) => {
      const tick = (): void => {
        if (self.finalStreamTimer !== null) {
          window.clearTimeout(self.finalStreamTimer);
          self.finalStreamTimer = null;
        }
        if (!self.currentTurnId) { resolve(); return; }
        if (index >= plan.length) { resolve(); return; }
        const elapsed = Date.now() - start;
        if (elapsed > accumulated + 300) {
          self.addEvent({ type: 'answer_chunk', data: { text }, timestamp: Date.now() });
          resolve();
          return;
        }
        self.addEvent({ type: 'answer_chunk', data: { text: plan[index].text }, timestamp: Date.now() });
        index++;
        if (index >= plan.length) { resolve(); return; }
        accumulated += plan[index].delay;
        self.finalStreamTimer = window.setTimeout(tick, plan[index].delay);
      };
      tick();
    });
  }

  private buildAgentModelChain(task: string): ModelSelection | null {
    if (!this.plugin.settings.agentAutoModelChain) return null;

    const selector = new ModelSelector(this.plugin.settings);
    const estimator = new TokenEstimator();
    const estimatedTokens = estimator.estimate(task, '', [], TaskType.MCP_TOOL_CALLING);

    return selector.selectModel(TaskType.MCP_TOOL_CALLING, estimatedTokens, {
      supportsMCPToolCalling: true,
    });
  }

  private estimateAgentTokens(messages: Array<Record<string, unknown>>): number {
    let total = 0;
    for (const msg of messages) {
      const content = msg.content;
      if (typeof content === 'string') {
        total += Math.ceil(content.length / 4);
      }
    }
    return Math.max(total, 100);
  }

  private async runAgentTask(
    task: string,
    attachedEmbeddingIndexes: ReadonlySet<string> = this.agentSelectedEmbeddingIndexes,
    initialSemanticQuery: string = task,
    fileContext?: string,
  ): Promise<void> {
    const orchestrator = this.plugin.agentOrchestrator;
    if (!orchestrator) {
      const msg = 'Agent orchestrator not initialized';
      this.addEvent({ type: 'error', data: { error: msg }, timestamp: Date.now() });
      this.completeCurrentTurn(msg);
      return;
    }

    const userProvider = this.getActiveProviderId();
    const userModel = this.getActiveModelId();
    const modelChain = this.buildAgentModelChain(task);

    let primaryProvider: string;
    let primaryModel: string;
    let fallbacks: Array<{ provider: string; modelId: string; modelName: string }>;

    if (userModel && modelChain) {
      primaryProvider = userProvider;
      primaryModel = userModel;
      fallbacks = [
        { provider: modelChain.provider, modelId: modelChain.modelId, modelName: modelChain.modelName },
        ...modelChain.fallbacks,
      ];
    } else if (modelChain) {
      primaryProvider = modelChain.provider;
      primaryModel = modelChain.modelId;
      fallbacks = modelChain.fallbacks;
    } else {
      primaryProvider = userProvider;
      primaryModel = userModel;
      fallbacks = [];
    }

    if (!primaryModel) {
      const msg = 'No model selected. Select a model from the header dropdown.';
      new Notice(msg);
      this.addEvent({ type: 'error', data: { error: msg }, timestamp: Date.now() });
      this.completeCurrentTurn(msg);
      return;
    }

    this.currentModelId = primaryModel;
    this.currentModelProvider = primaryProvider;

    const self = this;
    let providerCalls = 0;
    const providerCall = async (messages: Array<Record<string, unknown>>, onToken?: (chunk: string) => void, onThinking?: (thinking: string) => void, tools?: ToolDefinition[]): Promise<{
      content?: string;
      toolCalls?: ToolCall[];
      finishReason?: string;
      thinking?: string;
    }> => {
      providerCalls++;

      const allModels: Array<{ provider: string; modelId: string }> = [
        { provider: primaryProvider, modelId: primaryModel },
        ...fallbacks,
      ];

      const isMidway = providerCalls > 1;
      let lastError: Error | null = null;

      for (let i = 0; i < allModels.length; i++) {
        const { provider, modelId } = allModels[i];
        try {
          const estimatedTokens = self.estimateAgentTokens(messages);
          if (modelChain) {
            await RateLimitManager.getInstance().waitForClearance(provider, modelId, estimatedTokens);
          }

          const { content: text, finishReason, toolCalls: nativeToolCalls, thinking } = await self.callProvider(provider, modelId, messages, onToken, onThinking, tools);

          if (modelChain) {
            RateLimitManager.getInstance().recordApiCall(provider, modelId, estimatedTokens);
          }

          self.currentModelId = modelId;
          self.currentModelProvider = provider;

          const resolvedContent = text || '';
          const hasContent = resolvedContent.trim().length > 0;
          const usingNative = tools && tools.length > 0;
          const toolCalls = usingNative
            ? (nativeToolCalls && nativeToolCalls.length > 0
                ? nativeToolCalls
                : (/ACTION:\s*[\w-]+\s*\(/.test(resolvedContent) ? self.parseToolCalls(resolvedContent) : []))
            : self.parseToolCalls(resolvedContent);

          if (!hasContent && toolCalls.length === 0) {
            throw new Error('Model ' + provider + '/' + modelId + ' returned empty content');
          }

          self.addEvent({
            type: 'model_status',
            data: { status: '', isMidway, autoModelEnabled: Boolean(modelChain) },
            timestamp: Date.now(),
          });

          return { content: resolvedContent, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, finishReason, thinking };
        } catch (error: unknown) {
          if (error instanceof PartialStreamError) throw error;
          lastError = error instanceof Error ? error : new Error(String(error));

          const autoModelEnabled = Boolean(self.plugin.settings.agentAutoModelChain);
          const hasNextModel = i < allModels.length - 1;

          const statusMsg = (autoModelEnabled && hasNextModel)
            ? 'your selected model failed, trying the next model'
            : 'your selected model failed, try with a better one';

          self.addEvent({
            type: 'model_status',
            data: {
              status: statusMsg,
              isMidway,
              autoModelEnabled: autoModelEnabled && hasNextModel,
              failedModel: modelId,
            },
            timestamp: Date.now(),
          });
        }
      }

      throw lastError || new Error('All models in the auto-model chain failed.');
    };

    const onToken = (chunk: string) => {
      if (self.currentTurnId) {
        let cleanText = String(chunk || '');
        self.addEvent({ type: 'answer_chunk', data: { text: cleanText }, timestamp: Date.now() });
      }
    };

    try {
      const isContinueCmd = /^\s*continue\s*$/i.test(task.trim());
      const result = await orchestrator.runAgent(task, providerCall, onToken, {
        attachedEmbeddingIndexIds: Array.from(attachedEmbeddingIndexes),
        initialSemanticQuery,
        originalTask: isContinueCmd
          ? (this.turns.length > 0 ? this.turns[this.turns.length - 1].task || task : task)
          : task,
        fileContext,
      });
      if (this.currentTurnId) {
        await this.streamFinalAnswerSmoothly(result);
        const session = orchestrator.getSession();
        this.addEvent({
          type: 'final_answer',
          data: { answer: result, confidence: session?.confidence ?? null },
          timestamp: Date.now(),
        });
      }
      this.completeCurrentTurn(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg !== 'All models in the auto-model chain failed.') {
        new Notice(`Agent error: ${msg}`);
      }
      if (this.currentTurnId) {
        this.addEvent({ type: 'error', data: { error: msg }, timestamp: Date.now() });
      }
      this.completeCurrentTurn(`Error: ${msg}`);
    }
  }

  private handleStop(): void {
    if (this.finalStreamTimer !== null) {
      window.clearTimeout(this.finalStreamTimer);
      this.finalStreamTimer = null;
    }
    if (this.plugin.agentOrchestrator) {
      this.plugin.agentOrchestrator.abort();
    }
    this.setRunning(false);
    if (this.currentTurnId) {
      const lastChunkEvent = [...this.currentTurnEvents].reverse().find(e => e.type === 'answer_chunk');
      const streamedText = lastChunkEvent?.data?.text ? String(lastChunkEvent.data.text).trim() : '';

      const finalAnswerText = streamedText
        ? `${streamedText}\n\n*(Agent execution stopped by user.)*`
        : 'Agent execution stopped by user.';

      this.addEvent({
        type: 'final_answer',
        data: { answer: finalAnswerText },
        timestamp: Date.now(),
      });
      this.completeCurrentTurn(finalAnswerText);
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

function findClosingParenthesis(text: string, start: number): number {
  let quote = '';
  let escaped = false;
  let nested = 0;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(' || char === '[' || char === '{') {
      nested++;
    } else if (char === ']' || char === '}') {
      nested = Math.max(0, nested - 1);
    } else if (char === ')' && nested === 0) {
      return i;
    } else if (char === ')') {
      nested--;
    }
  }
  return -1;
}

function parseActionArguments(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  const args: Record<string, unknown> = {};
  const pairPattern = /([\w-]+)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[[\s\S]*?\]|\{[\s\S]*?\}|[^,\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pairPattern.exec(trimmed)) !== null) {
    const raw = match[2];
    try {
      args[match[1]] = raw.startsWith("'")
        ? raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\n/g, '\n')
        : JSON.parse(raw);
    } catch {
      args[match[1]] = raw;
    }
  }
  return Object.keys(args).length > 0 ? args : null;
}
