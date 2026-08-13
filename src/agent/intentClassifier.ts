import type { SubAgentType } from './subAgentTypes';

export type IntentType =
  | 'search_vault'
  | 'search_web'
  | 'search_feeds'
  | 'youtube'
  | 'research'
  | 'write'
  | 'edit'
  | 'compare'
  | 'analyze'
  | 'manage'
  | 'code'
  | 'general';

export interface ToolStrategy {
  primaryTool: string;
  fallbackTools: string[];
  needsSubagent: boolean;
  subagentType?: SubAgentType;
  subagentCount: number;
  parallelBranches: number;
  readBeforeWrite: boolean;
  verifyAfterWrite: boolean;
}

export interface IntentClassification {
  taskType: IntentType;
  intents: IntentType[];
  strategy: ToolStrategy;
  complexity: 'simple' | 'complex' | 'very_complex';
  requiresWeb: boolean;
  requiresVault: boolean;
  requiresWrite: boolean;
  breakdown: string;
}

const SEARCH_VAULT_PATTERNS = [
  /\b(search|find|look|locate|discover|explore)\b.*\b(note|file|folder|vault|document|content)\b/i,
  /\b(note|file|folder|vault|document)\b.*\b(search|find|look|locate)\b/i,
  /\bwhat\b.*\b(note|file|doc)\b/i,
  /\bwhere\b.*\b(is|are|can)\b/i,
  /\bbacklink|tag|folder|path\b/i,
  /\b(show|list|get|display)\b.*\b(all|every|my)\b/i,
];

const SEARCH_WEB_PATTERNS = [
  /\b(search|find|look|check|verify|research)\b.*\b(web|online|internet|website|url)\b/i,
  /\b(what|how|when|where|who|why)\b.*\b(is|are|was|were|does|do|did)\b.*\b(current|latest|recent|today|now|news)\b/i,
  /\b(weather|stock|price|score|news|update)\b/i,
  /\b(google|bing|search engine)\b/i,
  /\breal[\s-]time\b/i,
];

const SEARCH_FEED_PATTERNS = [
  /\b(feed|feeds|rss|atom|saved_feeds|search_feeds)\b/i,
  /\b(saved|my|check|fetch|search|read)\b.*\b(feed|feeds|rss|atom|subscriptions)\b/i,
  /\b(articles|posts|entries)\b.*\b(from|in|on)\b.*\b(feed|rss|atom)\b/i,
];

const YOUTUBE_PATTERNS = [
  /https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be)\//i,
  /\b(youtube|video)\b.*\b(transcript|summary|summarize|summarise|watch|video)\b/i,
];

const RESEARCH_PATTERNS = [
  /\b(research|investigate|analyze|compare|contrast|evaluate|assess|review)\b/i,
  /\b(deep[\s-]dive|comprehensive|thorough|detailed|in[\s-]depth)\b/i,
  /\b(summary|summarize|overview|synthesis|report)\b/i,
  /\b(pros?\s+and\s+cons|trade[\s-]off|implications?|impact)\b/i,
];

const WRITE_PATTERNS = [
  /\b(create|write|draft|compose|generate|build)\b.*\b(note|file|document|report|article|summary)\b/i,
  /\b(add|insert|append|prepend)\b.*\b(to|in|into)\b/i,
  /\b(make|produce|produce|prepare)\b.*\b(note|doc|file|report)\b/i,
  /\b(save|store|export)\b.*\b(as|to|into)\b/i,
];

const EDIT_PATTERNS = [
  /\b(edit|modify|update|change|revise|fix|correct|repair)\b/i,
  /\b(replace|rename|move|reorganize)\b/i,
  /\b(multi[\s-]edit|bulk[\s-]edit|batch)\b/i,
  /\b(add|remove|delete)\b.*\b(from|to|in)\b/i,
];

const COMPARE_PATTERNS = [
  /\b(compare|contrast|difference|versus|vs\.?|differ)\b/i,
  /\b(which|what)\b.*\bbetter\b/i,
  /\b(pros?\s+and\s+cons)\b/i,
];

const ANALYZE_PATTERNS = [
  /\b(analyze|analyse|examine|inspect|study|investigate)\b/i,
  /\b(explain|elaborate|discuss|interpret)\b/i,
  /\b(why|how)\b.*\b(does|do|did|is|are|was|were)\b/i,
  /\b(implications?|consequences?|effects?|impact)\b/i,
];

const MANAGE_PATTERNS = [
  /\b(organize|sort|arrange|group|categorize|tag|label)\b/i,
  /\b(delete|remove|archive|clean|tidy)\b/i,
  /\b(move|rename|restructure|reorganize)\b/i,
  /\b(import|export|backup|sync)\b/i,
];

const CODE_PATTERNS = [
  /\b(code|function|class|debug|implement|refactor|script|program)\b/i,
  /\b(typescript|javascript|python|java|bash|shell|sql|regex)\b/i,
  /\b(api|endpoint|component|module|interface|type)\b/i,
  /\b(fix\s+the\s+bug|write\s+a|build\s+a|create\s+a)\b/i,
  /\b(compile|syntax|import|export|async|await|promise|callback)\b/i,
];

function detectIntents(task: string): IntentType[] {
  const intents: IntentType[] = [];
  const lower = task.toLowerCase();

  if (SEARCH_FEED_PATTERNS.some(p => p.test(task))) intents.push('search_feeds');
  if (YOUTUBE_PATTERNS.some(p => p.test(task))) intents.push('youtube');
  if (SEARCH_VAULT_PATTERNS.some(p => p.test(task))) intents.push('search_vault');
  if (SEARCH_WEB_PATTERNS.some(p => p.test(task))) intents.push('search_web');
  if (RESEARCH_PATTERNS.some(p => p.test(task))) intents.push('research');
  if (WRITE_PATTERNS.some(p => p.test(task))) intents.push('write');
  if (EDIT_PATTERNS.some(p => p.test(task))) intents.push('edit');
  if (COMPARE_PATTERNS.some(p => p.test(task))) intents.push('compare');
  if (ANALYZE_PATTERNS.some(p => p.test(task))) intents.push('analyze');
  if (MANAGE_PATTERNS.some(p => p.test(task))) intents.push('manage');
  if (CODE_PATTERNS.some(p => p.test(task))) intents.push('code');

  // Fallback: if nothing matched, treat as general
  if (intents.length === 0) intents.push('general');

  // "research" implies both search_vault and search_web
  if (intents.includes('research')) {
    if (!intents.includes('search_vault')) intents.push('search_vault');
    if (!intents.includes('search_web')) intents.push('search_web');
  }

  return [...new Set(intents)];
}

function pickPrimaryIntent(intents: IntentType[]): IntentType {
  const priority: IntentType[] = [
    'youtube', 'search_feeds', 'search_web', 'research', 'compare', 'search_vault', 'analyze',
    'code', 'write', 'edit', 'manage', 'general',
  ];
  for (const p of priority) {
    if (intents.includes(p)) return p;
  }
  return 'general';
}

function buildStrategy(primaryIntent: IntentType, intents: IntentType[], task: string, hasAttachedIndexes: boolean = false): ToolStrategy {
  const lower = task.toLowerCase();

  switch (primaryIntent) {
    case 'youtube': {
      return {
        primaryTool: 'youtube_transcript',
        fallbackTools: ['web_search', 'webfetch'],
        needsSubagent: false,
        subagentCount: 0,
        parallelBranches: 1,
        readBeforeWrite: false,
        verifyAfterWrite: false,
      };
    }

    case 'search_feeds': {
      return {
        primaryTool: 'saved_feeds',
        fallbackTools: ['search_feeds', 'webfetch', 'web_search'],
        needsSubagent: false,
        subagentCount: 0,
        parallelBranches: 1,
        readBeforeWrite: false,
        verifyAfterWrite: false,
      };
    }

    case 'search_vault': {
      const hasSemantic = hasAttachedIndexes || /\b(similar|semantic|embedding|related|concept)\b/i.test(task);
      const primaryTool = hasSemantic ? 'search_attached_indexes' : 'search_vault';
      const fallbackTools = hasSemantic
        ? ['search_vault', 'grep_vault', 'get_outline', 'list_files']
        : ['grep_vault', 'get_outline', 'search_attached_indexes', 'list_files'];
      return {
        primaryTool,
        fallbackTools,
        needsSubagent: false,
        subagentCount: 0,
        parallelBranches: 1,
        readBeforeWrite: false,
        verifyAfterWrite: false,
      };
    }

    case 'search_web': {
      const needsVaultContext = intents.includes('search_vault');
      const needsParallel = needsVaultContext;
      return {
        primaryTool: 'web_search',
        fallbackTools: ['search_vault', 'grep_vault', 'get_outline', 'webfetch', 'fetch_pdf'],
        needsSubagent: needsParallel,
        subagentType: 'researcher',
        subagentCount: 1,
        parallelBranches: needsParallel ? 2 : 1,
        readBeforeWrite: false,
        verifyAfterWrite: false,
      };
    }

    case 'research': {
      // Research always benefits from parallel vault + web exploration
      return {
        primaryTool: hasAttachedIndexes ? 'search_attached_indexes' : 'search_vault',
        fallbackTools: hasAttachedIndexes ? ['search_vault', 'grep_vault', 'get_outline', 'web_search', 'webfetch', 'fetch_pdf'] : ['grep_vault', 'get_outline', 'web_search', 'search_attached_indexes', 'webfetch', 'fetch_pdf'],
        needsSubagent: true,
        subagentType: 'researcher',
        subagentCount: 1,
        parallelBranches: 2, // vault search + web search
        readBeforeWrite: false,
        verifyAfterWrite: false,
      };
    }

    case 'write': {
      return {
        primaryTool: 'create_note',
        fallbackTools: hasAttachedIndexes ? ['search_attached_indexes', 'edit_note', 'read_file'] : ['edit_note', 'read_file'],
        needsSubagent: false,
        subagentCount: 0,
        parallelBranches: 1,
        readBeforeWrite: false,
        verifyAfterWrite: true,
      };
    }

    case 'edit': {
      const isBulk = /\b(bulk|batch|multi|all|every|multiple|several)\b/i.test(task);
      return {
        primaryTool: 'edit_note',
        fallbackTools: hasAttachedIndexes ? ['search_attached_indexes', 'multi_edit', 'read_file'] : ['multi_edit', 'read_file'],
        needsSubagent: isBulk,
        subagentType: isBulk ? 'writer' : undefined,
        subagentCount: isBulk ? 1 : 0,
        parallelBranches: 1,
        readBeforeWrite: true,
        verifyAfterWrite: true,
      };
    }

    case 'compare': {
      return {
        primaryTool: 'read_file',
        fallbackTools: ['search_vault', 'get_backlinks'],
        needsSubagent: false,
        subagentCount: 0,
        parallelBranches: 1,
        readBeforeWrite: false,
        verifyAfterWrite: false,
      };
    }

    case 'analyze': {
      return {
        primaryTool: 'read_file',
        fallbackTools: ['search_vault', 'get_backlinks', 'get_tags'],
        needsSubagent: false,
        subagentCount: 0,
        parallelBranches: 1,
        readBeforeWrite: false,
        verifyAfterWrite: false,
      };
    }

    case 'manage': {
      return {
        primaryTool: 'edit_note',
        fallbackTools: ['multi_edit', 'read_file', 'list_files'],
        needsSubagent: false,
        subagentCount: 0,
        parallelBranches: 1,
        readBeforeWrite: true,
        verifyAfterWrite: false,
      };
    }

    case 'code': {
      return {
        primaryTool: 'cli',
        fallbackTools: ['read_file', 'edit_note'],
        needsSubagent: false,
        subagentCount: 0,
        parallelBranches: 1,
        readBeforeWrite: true,
        verifyAfterWrite: true,
      };
    }

    default: {
      return {
        primaryTool: hasAttachedIndexes ? 'search_attached_indexes' : 'search_vault',
        fallbackTools: hasAttachedIndexes ? ['search_vault', 'web_search', 'read_file'] : ['web_search', 'read_file'],
        needsSubagent: false,
        subagentCount: 0,
        parallelBranches: 1,
        readBeforeWrite: false,
        verifyAfterWrite: false,
      };
    }
  }
}

function computeComplexity(intents: IntentType[], task: string): 'simple' | 'complex' | 'very_complex' {
  let score = 0;
  const wordCount = task.split(/\s+/).length;

  if (intents.length >= 3) score += 4;
  else if (intents.length >= 2) score += 2;

  if (intents.includes('research')) score += 3;
  if (intents.includes('compare')) score += 2;
  if (intents.includes('edit') && /\b(bulk|batch|all|every)\b/i.test(task)) score += 3;
  if (wordCount > 30) score += 2;
  if (wordCount > 60) score += 3;

  if (score >= 8) return 'very_complex';
  if (score >= 4) return 'complex';
  return 'simple';
}

export function extractRawQuery(fullTask: string): string {
  const newTaskMatch = fullTask.match(/New task:\s*([\s\S]*)$/i);
  if (newTaskMatch) return newTaskMatch[1].trim();
  return fullTask;
}

export function classifyIntent(task: string, rawQuery?: string, hasAttachedIndexes: boolean = false): IntentClassification {
  const textForClassification = rawQuery || task;
  const intents = detectIntents(textForClassification);
  const taskType = pickPrimaryIntent(intents);
  const strategy = buildStrategy(taskType, intents, textForClassification, hasAttachedIndexes);
  const complexity = computeComplexity(intents, textForClassification);

  const requiresWeb = intents.includes('search_web') || intents.includes('research');
  const requiresVault = intents.includes('search_vault') || intents.includes('research')
    || intents.includes('edit') || intents.includes('write') || intents.includes('compare')
    || intents.includes('analyze') || intents.includes('manage');
  const requiresWrite = intents.includes('write') || intents.includes('edit') || intents.includes('manage');

  const breakdown = `primary=${taskType}; intents=[${intents.join(',')}]; complexity=${complexity}; web=${requiresWeb}; vault=${requiresVault}; write=${requiresWrite}`;

  return {
    taskType,
    intents,
    strategy,
    complexity,
    requiresWeb,
    requiresVault,
    requiresWrite,
    breakdown,
  };
}
