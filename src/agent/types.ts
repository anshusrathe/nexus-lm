import type { App, TFile } from 'obsidian';

export type ToolCategory = 'vault-native' | 'mcp' | 'cli' | 'plugin';

export type ApprovalMode = 'all' | 'writes-only' | 'never';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface AgentConfig {
  maxSteps: number;
  approvalMode: ApprovalMode;
  denyList: string[];
  enableCLI: boolean;
  enablePluginDiscovery: boolean;
  enableMCP: boolean;
  enableSkills?: boolean;
  enabledSkills?: string[];
  enableAutoModelChain?: boolean;
  canDelegate?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: Record<string, unknown>;
  needsApproval: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Gemini 3.x thought signature — must be echoed back on the functionCall part in history. */
  thoughtSignature?: string;
}

export interface ToolResult {
  toolCallId: string;
  success: boolean;
  content: string;
  error?: string;
  retryCount?: number;
}

export interface AgentStep {
  stepNumber: number;
  thought: string;
  toolCall: ToolCall | null;
  toolResult: ToolResult | null;
  status: StepStatus;
  timestamp: number;
  approvalId?: string | null;
}

export interface AgentSession {
  id: string;
  startedAt: number;
  updatedAt: number;
  task: string;
  steps: AgentStep[];
  finalAnswer: string | null;
  confidence: number | null;
  config: AgentConfig;
  scratchpad?: string;
}

export interface FileEditDiffLine {
  type: 'added' | 'removed';
  content: string;
}

export interface FileEditDiff {
  path: string;
  additions: number;
  removals: number;
  diffLines: FileEditDiffLine[];
  cliCommand?: string;
}

export type AgentEventCallback = (event: AgentEvent) => void;

export interface AgentEvent {
  type: 'step' | 'thought' | 'tool_call' | 'tool_result' | 'tool_progress' | 'error' | 'final_answer' | 'answer_chunk' | 'subagent_started' | 'subagent_step' | 'subagent_result' | 'pending_approval' | 'approval_resolved' | 'model_status';
  data: Record<string, unknown>;
  timestamp: number;
}

export interface AgentDependencies {
  app: App;
  settings: {
    maxSteps: number;
    approvalMode: ApprovalMode;
    denyList: string[];
    enableCLI: boolean;
    enablePluginDiscovery: boolean;
    provider: string;
    model: string;
    apiKey: string;
    [key: string]: unknown;
  };
  searchVaultBM25: (query: string, limit: number) => Promise<Array<{ path: string; content: string; lineStart?: number; lineEnd?: number; similarity?: number }>>;
  searchEmbeddingIndexes: (query: string, indexIds: string[], limit: number) => Promise<Array<{
    path: string;
    content: string;
    similarity: number;
    chunkIndex?: number;
    indexName: string;
  }>>;
  onEvent: AgentEventCallback;
  getActiveFile: () => TFile | null;
  getSetting: (key: string) => unknown;
}
