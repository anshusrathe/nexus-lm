import type { App, TFile } from 'obsidian';

export type AgentMode = 'react' | 'plan-react';

export type ToolCategory = 'vault-native' | 'mcp' | 'cli' | 'plugin';

export type ApprovalMode = 'all' | 'writes-only' | 'never';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface AgentConfig {
  maxSteps: number;
  defaultMode: AgentMode;
  approvalMode: ApprovalMode;
  denyList: string[];
  enableCLI: boolean;
  enablePluginDiscovery: boolean;
  enableMCP: boolean;
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
}

export interface ToolResult {
  toolCallId: string;
  success: boolean;
  content: string;
  error?: string;
}

export interface AgentStep {
  stepNumber: number;
  thought: string;
  toolCall: ToolCall | null;
  toolResult: ToolResult | null;
  status: StepStatus;
  timestamp: number;
}

export interface AgentSession {
  id: string;
  startedAt: number;
  updatedAt: number;
  task: string;
  steps: AgentStep[];
  finalAnswer: string | null;
  config: AgentConfig;
}

export interface MemoryEntry {
  id: string;
  content: string;
  type: 'working' | 'episodic' | 'semantic';
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface EditOperation {
  path: string;
  lineRef: string;
  newContent: string;
  type: 'replace' | 'insert' | 'delete';
}

export interface EditVerification {
  valid: boolean;
  reason?: string;
  currentHash?: string;
  expectedHash?: string;
}

export interface FileOutlineNode {
  name: string;
  type: 'heading' | 'function' | 'class' | 'block' | 'section';
  lineStart: number;
  lineEnd: number;
  hash: string;
  children: FileOutlineNode[];
  depth: number;
}

export interface HashLine {
  lineNumber: number;
  hash: string;
  content: string;
}

export interface VaultFileRef {
  path: string;
  basename: string;
  extension: string;
}

export interface SearchResult {
  path: string;
  content: string;
  similarity: number;
}

export type AgentEventCallback = (event: AgentEvent) => void;

export interface AgentEvent {
  type: 'step' | 'thought' | 'tool_call' | 'tool_result' | 'error' | 'final_answer' | 'plan' | 'answer_chunk';
  data: Record<string, unknown>;
  timestamp: number;
}

export interface AgentDependencies {
  app: App;
  settings: {
    maxSteps: number;
    defaultMode: AgentMode;
    approvalMode: ApprovalMode;
    denyList: string[];
    enableCLI: boolean;
    enablePluginDiscovery: boolean;
    provider: string;
    model: string;
    apiKey: string;
    [key: string]: unknown;
  };
  searchVaultBM25: (query: string, limit: number) => Promise<Array<{ path: string; content: string }>>;
  onEvent: AgentEventCallback;
  getActiveFile: () => TFile | null;
  getSetting: (key: string) => unknown;
}
