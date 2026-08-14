export type SubAgentType = 'explorer' | 'researcher' | 'auditor' | 'writer';

export type SubAgentSessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

export type SubAgentExecutionState = 'starting' | 'thinking' | 'using_tool' | 'waiting_approval' | 'done' | 'error';

export interface SubAgentConfig {
  type: SubAgentType;
  label: string;
  description: string;
  toolAllowList: string[];
  toolDenyList: string[];
  maxSteps: number;
  modelPreference?: string;
  promptPrefix: string;
  canDelegate: boolean;
}

export interface SubAgentArtifact {
  name: string;
  type: 'note' | 'search_result' | 'web_result' | 'summary' | 'diff' | 'error';
  content: string;
  path?: string;
}

export interface SubAgentResult {
  success: boolean;
  summary: string;
  details?: string;
  error?: string;
  stepsTaken: number;
  artifacts: SubAgentArtifact[];
  sessionId: string;
  tokenEstimate?: number;
}

export interface SubAgentStep {
  stepNumber: number;
  thought: string;
  toolName: string | null;
  toolArgs: Record<string, unknown> | null;
  status: string;
  timestamp: number;
  toolProgress?: string;
}

export const SUB_AGENT_CONFIGS: Record<SubAgentType, SubAgentConfig> = {
  explorer: {
    type: 'explorer',
    label: 'Explorer',
    description: 'Read-only vault exploration and codebase analysis.',
    toolAllowList: ['read_file', 'search_vault', 'get_outline', 'grep_vault', 'list_files', 'list_recent_files', 'get_backlinks', 'get_tags'],
    toolDenyList: ['edit_note', 'multi_edit', 'create_note', 'cli', 'web_search', 'webfetch'],
    maxSteps: 0,
    promptPrefix: 'You are an Explorer agent. Your job is to explore the vault and find information. You have READ-ONLY access to the vault. Do NOT modify any files. Return a structured summary of your findings.',
    canDelegate: false,
  },
  researcher: {
    type: 'researcher',
    label: 'Researcher',
    description: 'Web research and information gathering via web_search, saved_feeds, search_feeds, and vault search.',
    toolAllowList: ['web_search', 'webfetch', 'fetch_pdf', 'saved_feeds', 'search_feeds', 'read_file', 'search_vault', 'get_outline', 'grep_vault', 'list_recent_files'],
    toolDenyList: ['edit_note', 'multi_edit', 'create_note', 'cli'],
    maxSteps: 0,
    promptPrefix: 'You are a Researcher agent. Your PRIMARY job is to search the web for information using the web_search tool. You have READ-ONLY access to the vault — do NOT modify any files.\n\nHOW TO USE WEB SEARCH:\n- Tool name: web_search (with underscore)\n- Format: ACTION: web_search(query="your search query here")\n- ALWAYS call web_search when you need current, real-time, or online information\n- NEVER make up answers for current events, news, weather, facts, or anything that requires real-time data\n- If the first search doesn\'t give enough results, try different queries or use webfetch to read specific URLs\n- For PDF URLs (ending in .pdf), use fetch_pdf instead — webfetch cannot read raw PDFs: ACTION: fetch_pdf(url="https://example.com/paper.pdf", pageFrom=1, pageTo=10)\n- Search the web FIRST, then fall back to vault search only if needed for local context',
    canDelegate: false,
  },
  auditor: {
    type: 'auditor',
    label: 'Auditor',
    description: 'Quality gate that reviews changes, diffs, and tool results for correctness and safety.',
    toolAllowList: ['read_file', 'search_vault', 'get_outline', 'grep_vault', 'list_files', 'list_recent_files'],
    toolDenyList: ['edit_note', 'multi_edit', 'create_note', 'cli', 'web_search', 'webfetch'],
    maxSteps: 0,
    promptPrefix: 'You are an Auditor agent. Your job is to review changes and verify correctness. You have READ-ONLY access. Return a structured summary of your review, including whether changes are APPROVED or REJECTED with specific issues found.',
    canDelegate: false,
  },
  writer: {
    type: 'writer',
    label: 'Writer',
    description: 'Focused file creation and editing.',
    toolAllowList: ['read_file', 'edit_note', 'multi_edit', 'create_note'],
    toolDenyList: ['cli', 'web_search', 'webfetch', 'search_vault', 'list_files'],
    maxSteps: 0,
    promptPrefix: 'You are a Writer agent. Your job is to create and edit vault files. You have WRITE access but should use it carefully. Make precise edits and verify your changes by reading the file afterward. Return a structured summary of what was created or changed.',
    canDelegate: false,
  },
};
