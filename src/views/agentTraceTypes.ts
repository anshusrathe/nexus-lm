import type { AgentEvent, FileEditDiff, StepStatus } from '../agent/types';

export interface AgentContextItem {
  type: 'file' | 'embedding-index';
  name: string;
  path?: string;
  extension?: string;
}

export interface AgentTraceTurn {
  task: string;
  events: AgentEvent[];
  answer: string | null;
  modelId?: string;
  modelProvider?: string;
  startedAt?: number;
  completedAt?: number;
  contextItems?: AgentContextItem[];
}

export interface TraceStep {
  stepNumber: number;
  thought: string;
  toolName: string | null;
  toolArgs: Record<string, unknown> | null;
  toolProgress: string;
  status: StepStatus;
  timestamp: number;
  fileEditData: FileEditDiff | null;
  semanticSearch: { query: string; resultCount: number; indexes: string[] } | null;
  approvalId: string | null;
  approvalState: 'pending' | 'approved' | 'reverted' | null;
  originalContent: string | null;
  isCreate: boolean;
  error: string | null;
}

export interface TraceSubAgentResult {
  success: boolean;
  summary: string;
  details?: string;
  error?: string;
  stepsTaken: number;
}

export interface TraceSubAgent {
  jobId: string;
  agentType: string;
  task: string;
  steps: TraceStep[];
  result: TraceSubAgentResult | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

export interface PendingAction {
  toolName: string;
  toolArgs: Record<string, unknown> | null;
}

export interface ModelStatusInfo {
  status: string;
  isMidway: boolean;
  autoModelEnabled: boolean;
}

export interface TraceTimelineItem {
  id: string;
  kind: 'thought' | 'step' | 'pending_action' | 'subagent';
  thought?: string;
  step?: TraceStep;
  action?: PendingAction;
  jobId?: string;
  timestamp: number;
}

export interface AdaptedTrace {
  steps: TraceStep[];
  subAgents: TraceSubAgent[];
  thoughts: string;
  pendingActions: PendingAction[];
  streamingText: string;
  finalAnswer: string | null;
  error: string | null;
  modelStatus: ModelStatusInfo | null;
  timeline: TraceTimelineItem[];
}

export function adaptTrace(events: AgentEvent[]): AdaptedTrace {
  const steps: TraceStep[] = [];
  const subAgents = new Map<string, TraceSubAgent>();
  const timeline: TraceTimelineItem[] = [];
  let currentStep: TraceStep | null = null;
  let streamingText = '';
  let thoughts = '';
  let finalAnswer: string | null = null;
  let error: string | null = null;
  let modelStatus: ModelStatusInfo | null = null;
  let currentThoughtItem: TraceTimelineItem | null = null;
  let thoughtItemCounter = 0;

  const pushThought = (text: string, timestamp: number): void => {
    if (currentThoughtItem) {
      currentThoughtItem.thought += text;
      currentThoughtItem.timestamp = timestamp;
    } else {
      currentThoughtItem = { id: `thought-${++thoughtItemCounter}`, kind: 'thought', thought: text, timestamp };
      timeline.push(currentThoughtItem);
    }
  };

  const pushStep = (step: TraceStep): void => {
    currentThoughtItem = null;
    timeline.push({ id: `step-${step.stepNumber}`, kind: 'step', step, timestamp: step.timestamp });
  };

  const getSubAgent = (jobId: string): TraceSubAgent => {
    let session = subAgents.get(jobId);
    if (!session) {
      session = { jobId, agentType: 'agent', task: '', steps: [], result: null, status: 'running' };
      subAgents.set(jobId, session);
    }
    return session;
  };

  for (const event of events) {
    switch (event.type) {
      case 'model_status': {
        const statusStr = String(event.data.status ?? '');
        if (statusStr) {
          modelStatus = {
            status: statusStr,
            isMidway: Boolean(event.data.isMidway),
            autoModelEnabled: Boolean(event.data.autoModelEnabled),
          };
        } else {
          modelStatus = null;
        }
        break;
      }
      case 'step': {
        modelStatus = null;
        const approvalId = event.data.approvalId ? String(event.data.approvalId) : null;
        const stepToolName = event.data.toolName ? String(event.data.toolName) : null;
        let existing = approvalId ? steps.find(s => s.approvalId === approvalId && (s.toolName === stepToolName || !s.toolName || !stepToolName)) : null;

        if (existing) {
          existing.thought = String(event.data.thought ?? existing.thought);
          existing.toolName = event.data.toolName ? String(event.data.toolName) : existing.toolName;
          existing.toolArgs = isRecord(event.data.toolArgs) ? event.data.toolArgs : existing.toolArgs;
          existing.status = normalizeStepStatus(event.data.status);
          existing.timestamp = event.timestamp;
          existing.fileEditData = isFileEditDiff(event.data.fileEditData) ? event.data.fileEditData : existing.fileEditData;
          existing.semanticSearch = isSemanticSearch(event.data.semanticSearch) ? event.data.semanticSearch : existing.semanticSearch;
          if (approvalId) existing.approvalId = approvalId;
          if (event.data.approvalState) existing.approvalState = normalizeApprovalState(event.data.approvalState);
          if (event.data.originalContent) existing.originalContent = String(event.data.originalContent);
          if (event.data.isCreate !== undefined) existing.isCreate = Boolean(event.data.isCreate);
          if (event.data.error) existing.error = String(event.data.error);
          currentStep = existing;
        } else {
          const requestedNumber = Number(event.data.step ?? steps.length + 1);
          const stepNumber = steps.some(step => step.stepNumber === requestedNumber)
            ? Math.max(0, ...steps.map(step => step.stepNumber)) + 1
            : requestedNumber;
          currentStep = {
            stepNumber,
            thought: String(event.data.thought ?? ''),
            toolName: event.data.toolName ? String(event.data.toolName) : null,
            toolArgs: isRecord(event.data.toolArgs) ? event.data.toolArgs : null,
            toolProgress: '',
            status: normalizeStepStatus(event.data.status),
            timestamp: event.timestamp,
            fileEditData: isFileEditDiff(event.data.fileEditData) ? event.data.fileEditData : null,
            semanticSearch: isSemanticSearch(event.data.semanticSearch) ? event.data.semanticSearch : null,
            approvalId,
            approvalState: normalizeApprovalState(event.data.approvalState),
            originalContent: event.data.originalContent ? String(event.data.originalContent) : null,
            isCreate: Boolean(event.data.isCreate),
            error: event.data.error ? String(event.data.error) : null,
          };
          steps.push(currentStep);
          pushStep(currentStep);
        }
        break;
      }
      case 'pending_approval': {
        const approvalId = String(event.data.approvalId ?? '');
        const existing = steps.find(s => s.approvalId === approvalId);
        if (existing) {
          existing.approvalState = 'pending';
        } else {
          const requestedNumber = steps.length + 1;
          const stepNumber = steps.some(step => step.stepNumber === requestedNumber)
            ? Math.max(0, ...steps.map(step => step.stepNumber)) + 1
            : requestedNumber;
          currentStep = {
            stepNumber,
            thought: String(event.data.thought ?? ''),
            toolName: event.data.toolName ? String(event.data.toolName) : null,
            toolArgs: isRecord(event.data.toolArgs) ? event.data.toolArgs : null,
            toolProgress: '',
            status: 'pending',
            timestamp: event.timestamp,
            fileEditData: null,
            semanticSearch: null,
            approvalId,
            approvalState: 'pending',
            originalContent: event.data.originalContent ? String(event.data.originalContent) : null,
            isCreate: Boolean(event.data.isCreate),
            error: null,
          };
          steps.push(currentStep);
          pushStep(currentStep);
        }
        break;
      }
      case 'approval_resolved': {
        const resolvedId = String(event.data.approvalId ?? '');
        const resolved = steps.find(s => s.approvalId === resolvedId);
        if (resolved) {
          const approved = Boolean(event.data.approved);
          resolved.approvalState = approved ? 'approved' : 'reverted';
          if (approved && event.data.fileEditData && isFileEditDiff(event.data.fileEditData)) {
            resolved.fileEditData = event.data.fileEditData;
          }
          if (!approved) {
            resolved.fileEditData = null;
          }
          if (event.data.status) {
            resolved.status = normalizeStepStatus(event.data.status);
          }
        }
        break;
      }
      case 'tool_progress':
        if (currentStep) currentStep.toolProgress += String(event.data.chunk ?? '');
        break;
      case 'thought':
        thoughts += String(event.data.text ?? '');
        pushThought(String(event.data.text ?? ''), event.timestamp);
        break;
      case 'answer_chunk':
        streamingText = String(event.data.text ?? '');
        break;
      case 'final_answer':
        finalAnswer = String(event.data.answer ?? '') || null;
        break;
      case 'error':
        error = String(event.data.error ?? 'Agent execution failed.');
        break;
      case 'subagent_started': {
        const session = getSubAgent(String(event.data.jobId ?? ''));
        session.agentType = String(event.data.agentType ?? 'agent');
        session.task = String(event.data.task ?? '');
        currentThoughtItem = null;
        timeline.push({ id: `sub-${session.jobId}`, kind: 'subagent', jobId: session.jobId, timestamp: event.timestamp });
        break;
      }
      case 'subagent_step': {
        const session = getSubAgent(String(event.data.jobId ?? ''));
        session.agentType = String(event.data.agentType ?? session.agentType);
        session.steps.push({
          stepNumber: Number(event.data.stepNumber ?? session.steps.length + 1),
          thought: String(event.data.thought ?? ''),
          toolName: event.data.toolName ? String(event.data.toolName) : null,
          toolArgs: isRecord(event.data.toolArgs) ? event.data.toolArgs : null,
          toolProgress: '',
          status: normalizeStepStatus(event.data.status),
          timestamp: event.timestamp,
          fileEditData: null,
          semanticSearch: null,
          approvalId: null,
          approvalState: null,
          originalContent: null,
          isCreate: false,
          error: null,
        });
        break;
      }
      case 'subagent_result': {
        const session = getSubAgent(String(event.data.jobId ?? ''));
        session.agentType = String(event.data.agentType ?? session.agentType);
        session.result = {
          success: Boolean(event.data.success),
          summary: String(event.data.summary ?? ''),
          details: event.data.details ? String(event.data.details) : undefined,
          error: event.data.error ? String(event.data.error) : undefined,
          stepsTaken: Number(event.data.stepsTaken ?? session.steps.length),
        };
        session.status = session.result.success ? 'completed' : 'failed';
        break;
      }
    }
  }

  const pendingActions = extractPendingActions(streamingText, steps);
  streamingText = stripMarkup(streamingText);

  const lastTimestamp = timeline.length > 0 ? timeline[timeline.length - 1].timestamp : 0;
  pendingActions.forEach((action, i) => {
    timeline.push({ id: `pending-${i}`, kind: 'pending_action', action, timestamp: lastTimestamp });
  });

  return {
    steps,
    subAgents: [...subAgents.values()],
    thoughts,
    pendingActions,
    streamingText,
    finalAnswer,
    error,
    modelStatus,
    timeline,
  };
}

function normalizeStepStatus(status: unknown): StepStatus {
  const value = String(status ?? 'pending');
  return ['pending', 'running', 'completed', 'failed', 'skipped'].includes(value)
    ? value as StepStatus
    : 'pending';
}

function normalizeApprovalState(state: unknown): 'pending' | 'approved' | 'reverted' | null {
  if (state === 'pending' || state === 'approved' || state === 'reverted') return state;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileEditDiff(value: unknown): value is FileEditDiff {
  return isRecord(value)
    && typeof value.path === 'string'
    && Array.isArray(value.diffLines)
    && typeof value.additions === 'number'
    && typeof value.removals === 'number';
}

function isSemanticSearch(value: unknown): value is { query: string; resultCount: number; indexes: string[] } {
  return isRecord(value)
    && typeof value.query === 'string'
    && typeof value.resultCount === 'number'
    && Array.isArray(value.indexes)
    && value.indexes.every(item => typeof item === 'string');
}

function extractPendingActions(streamingText: string, steps: TraceStep[]): PendingAction[] {
  if (!streamingText) return [];
  const pending: PendingAction[] = [];
  const regex = /ACTION:\s*([\w-]+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(streamingText)) !== null) {
    const toolName = match[1];
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findClosingParenthesis(streamingText, bodyStart);
    const toolArgs = bodyEnd >= 0 ? parseActionArguments(streamingText.slice(bodyStart, bodyEnd)) : null;
    const alreadyCompleted = steps.some(s => s.toolName === toolName && argsMatch(s.toolArgs, toolArgs));
    if (!alreadyCompleted) {
      pending.push({ toolName, toolArgs });
    }
  }
  return pending;
}

function stripMarkup(text: string): string {
  if (!text) return '';
  let result = text;
  let stripped = '';
  let i = 0;
  while (i < result.length) {
    const actionIdx = result.indexOf('ACTION:', i);
    if (actionIdx === -1) {
      stripped += result.slice(i);
      break;
    }
    stripped += result.slice(i, actionIdx);
    const parenStart = result.indexOf('(', actionIdx);
    if (parenStart === -1 || parenStart - actionIdx > 40) {
      break;
    }
    const parenEnd = findClosingParenthesis(result, parenStart + 1);
    if (parenEnd === -1) {
      break;
    }
    i = parenEnd + 1;
  }
  return stripped.trim();
}

function argsMatch(a: Record<string, unknown> | null, b: Record<string, unknown> | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

function findClosingParenthesis(text: string, start: number): number {
  let quote = '';
  let escaped = false;
  let nested = 0;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; }
    else if (char === '(' || char === '[' || char === '{') { nested++; }
    else if (char === ']' || char === '}') { nested = Math.max(0, nested - 1); }
    else if (char === ')' && nested === 0) { return i; }
    else if (char === ')') { nested--; }
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
    } catch { return null; }
  }
  const args: Record<string, unknown> = {};
  const pairPattern = /([\w-]+)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[[\s\S]*?\]|\{[\s\S]*?\}|[^,\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pairPattern.exec(trimmed)) !== null) {
    const raw = m[2];
    try {
      args[m[1]] = raw.startsWith("'")
        ? raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\n/g, '\n')
        : JSON.parse(raw);
    } catch { args[m[1]] = raw; }
  }
  return Object.keys(args).length > 0 ? args : null;
}
