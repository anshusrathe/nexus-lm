import { TFile } from 'obsidian';
import type {
  AgentConfig, AgentDependencies, AgentSession, AgentStep,
  ToolCall, ToolResult, StepStatus, FileEditDiff, FileEditDiffLine,
  ToolDefinition,
} from './types';
import { ToolRegistry } from './toolRegistry';
import { SafetyLayer } from './safetyLayer';
import { SkillRegistry } from './skills/skillRegistry';

import { PromptBuilder } from './promptBuilder';
import { ContextManager } from './contextManager';
import { SubAgentManager } from './subAgentManager';
import type { SubAgentType, SubAgentStep, SubAgentResult } from './subAgentTypes';
import { SubAgentSession } from './subAgentSession';
import { computeLineDiff } from './editEngine';
import { AgentMemory } from './agentMemory';
import { AgentMetrics } from './metrics';
import { StaticRules } from './staticRules';
import { parseTemporal, formatTemporalForMemory, type TemporalContext } from './temporalParser';
import { classifyIntent, extractRawQuery, type IntentClassification, type ToolStrategy } from './intentClassifier';
import { toOpenAIFormat, buildToolResultMessage } from './nativeToolCall';

const MAX_STEPS_DEFAULT = 25;
const COMPLEX_TASK_THRESHOLD = 8;
const HARD_SAFETY_STEP_CAP = 200;
export const SUBAGENT_HARD_SAFETY_STEP_CAP = 500;

function summarizeSemanticSearch(
  args: Record<string, unknown>,
  result: ToolResult | null,
): { query: string; resultCount: number; indexes: string[] } {
  const fallback = {
    query: String(args.query ?? ''),
    resultCount: 0,
    indexes: [],
  };
  if (!result?.success) return fallback;

  try {
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    return {
      query: typeof parsed.query === 'string' ? parsed.query : fallback.query,
      resultCount: typeof parsed.resultCount === 'number' ? parsed.resultCount : 0,
      indexes: Array.isArray(parsed.indexes)
        ? parsed.indexes.filter((index): index is string => typeof index === 'string')
        : [],
    };
  } catch {
    return fallback;
  }
}

interface ToolCallSignature {
  name: string;
  argsKey: string;
}

const MAX_CONSECUTIVE_LOOPS_BEFORE_SHUTDOWN = 5;
const CONSECUTIVE_LOOP_SOFT_ESCALATION = 2;

export interface AgentRunContext {
  attachedEmbeddingIndexIds?: string[];
  initialSemanticQuery?: string;
  originalTask?: string;
  fileContext?: string;
}

const CONTINUATION_SYSTEM_PROMPT = 'You are a text-completion engine. A previously generated answer was cut off mid-generation. Your ONLY job is to produce the remaining continuation of that text, exactly as it would have continued. Rules: (1) Output ONLY the continuation text — no preamble, no explanation, no "Here is..." introductions. (2) Do NOT restart, redo, or re-verify the original request. (3) Do NOT call any tools, search anything, or take any action. (4) Do NOT repeat any text already written. (5) Match the existing formatting, language, tone, and structure. If the answer was already naturally complete, state "The answer is already complete."';

export class AgentOrchestrator {
  private registry: ToolRegistry;
  private safetyLayer: SafetyLayer;
  private skillRegistry: SkillRegistry | null;
  private subAgentManager: SubAgentManager;
  private deps: AgentDependencies;
  private config: AgentConfig;
  private currentSession: AgentSession | null = null;
  private abortFlag: boolean = false;
  private callHistory: ToolCallSignature[] = [];
  private promptBuilder: PromptBuilder;
  private contextManager: ContextManager;
  private compactedSinceLastTurn: number = 0;
  private currentProviderCall: ((messages: Array<Record<string, unknown>>, onToken?: (chunk: string) => void, onThinking?: (thinking: string) => void, tools?: ToolDefinition[]) => Promise<{
    content?: string;
    toolCalls?: ToolCall[];
    finishReason?: string;
    thinking?: string;
  }>) | null = null;
  private agentMemory: AgentMemory | null = null;
  private staticRulesReader: StaticRules | null = null;
  private cachedStaticRules: string | null = null;
  private failureContext: Map<string, number> = new Map();
  private consecutiveLoopBlocks: number = 0;
  private activeSkillNames: Set<string> = new Set();
  private requiresRuntimeGrounding: boolean = false;
  private successfulToolCalls: number = 0;
  private lastToolResult: ToolResult | null = null;
  private consecutiveWriteCount: number = 0;
  private reflectionInjected: boolean = false;
  private searchFallbackAttempts: Map<string, number> = new Map();
  private currentTemporalContext: TemporalContext | null = null;
  private currentIntent: IntentClassification | null = null;
  private revertibleOperations: Map<string, { filePath: string; originalContent: string; isCreate: boolean }> = new Map();
  private suppressedFinalAnswer: boolean = false;

  constructor(
    registry: ToolRegistry,
    safetyLayer: SafetyLayer,
    skillRegistryOrDeps: SkillRegistry | null | AgentDependencies,
    depsOrConfig?: AgentDependencies | AgentConfig,
    config?: AgentConfig
  ) {
    this.registry = registry;
    this.safetyLayer = safetyLayer;
    if (skillRegistryOrDeps && 'onEvent' in skillRegistryOrDeps) {
      this.skillRegistry = null;
      this.deps = skillRegistryOrDeps;
      this.config = depsOrConfig as AgentConfig;
    } else {
      this.skillRegistry = skillRegistryOrDeps;
      this.deps = depsOrConfig as AgentDependencies;
      this.config = config!;
    }
    this.promptBuilder = new PromptBuilder();
    this.contextManager = new ContextManager();
    this.subAgentManager = new SubAgentManager(registry, this.deps, 2);
  }

  updateConfig(config: AgentConfig): void {
    this.config = config;
    this.safetyLayer.updateConfig(config.denyList, config.approvalMode);
    if (config.enabledSkills) {
      this.skillRegistry?.setEnabledList(config.enabledSkills);
    }
  }

  abort(): void {
    this.abortFlag = true;
    this.subAgentManager.cancelAll();
  }

  getSession(): AgentSession | null {
    return this.currentSession;
  }

  clearSession(): void {
    this.currentSession = null;
  }

  resolveApproval(approvalId: string, approved: boolean): void {
    this.safetyLayer.resolveApproval(approvalId, approved);
  }

  async revertOperation(approvalId: string): Promise<boolean> {
    const op = this.revertibleOperations.get(approvalId);
    if (!op) return false;

    try {
      if (op.isCreate) {
        const file = this.deps.app.vault.getAbstractFileByPath(op.filePath);
        if (file) {
          await this.deps.app.fileManager.trashFile(file);
        }
      } else {
        const file = this.deps.app.vault.getAbstractFileByPath(op.filePath);
        if (file instanceof TFile) {
          await this.deps.app.vault.modify(file, op.originalContent);
        }
      }
      this.revertibleOperations.delete(approvalId);

      this.deps.onEvent({
        type: 'approval_resolved',
        data: {
          approvalId,
          approved: false,
          status: 'reverted',
        },
        timestamp: Date.now(),
      });

      return true;
    } catch (err) {
      console.error('[Orchestrator] revert failed:', err);
      return false;
    }
  }

  async runAgent(task: string, providerCall: (messages: Array<Record<string, unknown>>, onToken?: (chunk: string) => void, onThinking?: (thinking: string) => void, tools?: ToolDefinition[]) => Promise<{
    content?: string;
    toolCalls?: ToolCall[];
    finishReason?: string;
    thinking?: string;
  }>, onToken?: (chunk: string) => void, runContext: AgentRunContext = {}): Promise<string> {
    
    this.abortFlag = false;
    this.callHistory = [];
    this.failureContext.clear();
    this.consecutiveLoopBlocks = 0;
    this.compactedSinceLastTurn = 0;
    this.successfulToolCalls = 0;
    this.lastToolResult = null;
    this.consecutiveWriteCount = 0;
    this.reflectionInjected = false;
    this.searchFallbackAttempts.clear();
    this.activeSkillNames.clear();
    this.revertibleOperations.clear();
    this.suppressedFinalAnswer = false;
    AgentMetrics.getInstance().recordSessionStart();
    this.safetyLayer.setOnEvent(this.deps.onEvent);

    const sessionId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const existingScratchpad = this.currentSession?.scratchpad;

    this.currentSession = {
      id: sessionId,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      task,
      steps: [],
      finalAnswer: null,
      confidence: null,
      config: this.config,
      scratchpad: existingScratchpad,
    };

    // Handle "continue" command for truncated answer continuation
    const isContinue = /^\s*continue\s*$/i.test(task.trim());
    const originalTask = runContext.originalTask || task;
    if (isContinue && this.currentSession.scratchpad?.startsWith('## CONTINUATION_PENDING')) {
      const partial = this.currentSession.scratchpad.replace(/^## CONTINUATION_PENDING\n\n/, '');
      task = `The user asked: ${originalTask}\n\nThe answer was cut off mid-generation. Here is what was written so far:\n\n${partial}\n\nContinue writing the answer from exactly where it stopped. Output ONLY the remaining continuation text — no preamble, no repeated content, no closing remarks unless the content itself requires them.`;
      this.currentSession.scratchpad = '';
      this.addStep('Continuing truncated answer from scratchpad.', null, null, 'completed');
    }

    // Register skill tools if skills are enabled
    this.registerSkillTool();
    this.registerSkillActivationTools();
    this.registerSkillManagementTools();
    // Register delegate_to_* tools only if this agent is allowed to delegate
    if (this.config.canDelegate) {
      this.registerDelegateTool();
    }
    this.registerTodoTools();
    this.registerScratchpadTool();
    this.registerLearnedMemoryTool();
    const attachedEmbeddingIndexIds = [...new Set(runContext.attachedEmbeddingIndexIds ?? [])];
    this.registerAttachedIndexSearchTool(attachedEmbeddingIndexIds);

    // Build system prompt
    const allToolDefs = this.registry.getDefinitions();
    const toolDefs = this.filterRelevantTools(allToolDefs, task);
    

    // Build skill section
    const skillSection = this.buildSkillSection();

    // Inject relevant past experiences from memory
    const memoryContext = await this.buildMemoryContext(task);

    // Read static rules
    await this.refreshStaticRules();

    // Read learned memory
    let learnedMemoryContent: string | null = null;
    if (this.agentMemory) {
      try {
        learnedMemoryContent = await this.agentMemory.readLearned();
      } catch {
        learnedMemoryContent = null;
      }
    }

    const rawQuery = extractRawQuery(task);
    const { label, breakdown, requiresGrounding } = this.classifyComplexity(rawQuery);
    this.requiresRuntimeGrounding = requiresGrounding || attachedEmbeddingIndexIds.length > 0;

    // Parse temporal references from the raw query
    this.currentTemporalContext = parseTemporal(rawQuery);

    // Classify intent using only the user's actual query (not full conversation context)
    this.currentIntent = classifyIntent(task, rawQuery, attachedEmbeddingIndexIds.length > 0);
    const intentInfo = this.currentIntent;
    const strategy = intentInfo.strategy;
    

    const taskAnalysis = `Task profile: ${label.toUpperCase()}; intent=${intentInfo.taskType}; complexity=${intentInfo.complexity}; ${this.requiresRuntimeGrounding ? 'runtime grounding required' : 'direct answer allowed'} (${breakdown})`;
    

    const systemPrompt = isContinue
      ? CONTINUATION_SYSTEM_PROMPT
      : this.promptBuilder.buildPrompt({
          toolDefs,
          enableCLI: this.config.enableCLI,
          skillSection: skillSection || undefined,
          scratchpadContent: this.currentSession?.scratchpad?.replace(/^## CONTINUATION_PENDING\n\n/, ''),
          taskAnalysis,
          staticRules: this.cachedStaticRules ?? undefined,
          learnedMemory: learnedMemoryContent ?? undefined,
        });

    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: systemPrompt },
    ];
    if (!isContinue && memoryContext) {
      messages.push({ role: 'system', content: memoryContext });
    }
    if (!isContinue && this.currentTemporalContext.summary) {
      messages.push({ role: 'system', content: `[Temporal awareness]: ${formatTemporalForMemory(this.currentTemporalContext)}` });
      messages.push({ role: 'system', content: `[Temporal strategy]: The user query specifies a time window (${this.currentTemporalContext.summary}). For open-ended queries about recent activity or work (e.g. "What did we do?"), call 'list_recent_files' FIRST to inspect recently modified notes before reading or searching.` });
    }
    if (!isContinue && attachedEmbeddingIndexIds.length > 0) {
      const attachedIndexes = attachedEmbeddingIndexIds.map(id => {
        const index = this.deps.settings.indexConfigurations as Array<{ id: string; name?: string }> | undefined;
        return index?.find(item => item.id === id)?.name || id;
      });
      
      messages.push({
        role: 'system',
        content: `CRITICAL REQUIREMENT: The user has attached the following embedding database(s): ${attachedIndexes.join(', ')}. You MUST perform smart and deep searches in this index to squeeze out maximum information for the user's query semantically. You MUST use the exact tool name \`search_attached_indexes\` (with underscores). Do NOT use \`search_vault\` when an embedding database is attached. Formulate multiple focused keyword sub-queries if needed.`,
      });
    }
    if (!isContinue && runContext.fileContext) {
      messages.push({
        role: 'system',
        content: runContext.fileContext,
      });
    }
    if (!isContinue) {
      const youtubeUrlMatch = (rawQuery || task).match(/https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be)\/[^\s]+/i);
      if (youtubeUrlMatch) {
        const youtubeUrl = youtubeUrlMatch[0].replace(/[),.;:!?]+$/, '');
        messages.push({
          role: 'system',
          content: `YOUTUBE VIDEO DETECTED: The user provided a YouTube video URL (${youtubeUrl}). You MUST use the \`youtube_transcript\` tool with this exact URL to fetch the video transcript and answer the question from it. Do NOT use \`webfetch\` or \`web_search\` to read YouTube pages — they do not return the video transcript.`,
        });
      }
    }
    messages.push({ role: 'user', content: task });

    
    this.currentProviderCall = providerCall;
    const result = await this.runReActLoop(messages, providerCall, onToken, isContinue ? [] : toolDefs);
    await this.saveSessionToMemory();
    return result;
  }

  setAgentMemory(memory: AgentMemory): void {
    this.agentMemory = memory;
  }

  setStaticRulesReader(reader: StaticRules): void {
    this.staticRulesReader = reader;
  }

  async deleteEpisodicMemory(sessionId: string): Promise<boolean> {
    if (!this.agentMemory) return false;
    return await this.agentMemory.deleteEpisodic(sessionId);
  }

  clearScratchpad(): void {
    if (this.currentSession) {
      this.currentSession.scratchpad = '';
    }
  }

  private async readStaticRules(): Promise<string | null> {
    if (!this.staticRulesReader) return null;
    try {
      const result = await this.staticRulesReader.readAll();
      return result.content;
    } catch {
      return null;
    }
  }

  private async refreshStaticRules(): Promise<void> {
    this.cachedStaticRules = await this.readStaticRules();
  }

  private async buildMemoryContext(task: string): Promise<string | null> {
    if (!this.agentMemory) return null;

    try {
      const results = await this.agentMemory.searchAll(task, 3);
      if (results.length === 0) return null;

      const experiences = results.map((r) => {
        const e = r.record;
        const lessonsBlock = e.lessons && e.lessons.length > 0
          ? `\n    <learned_insights>\n${e.lessons.map(l => `      - ${l}`).join('\n')}\n    </learned_insights>`
          : '';
        const keywords = (e.keywords || []).slice(0, 8).join(', ');
        return `  <past_experience id="${e.sessionId}">
    <topic_summary>${e.summary.replace(/<[^>]*>/g, '')}</topic_summary>
    <domain_keywords>${keywords}</domain_keywords>${lessonsBlock}
  </past_experience>`;
      }).join('\n');

      return `<historical_reference_context>
  <system_instruction>
    CRITICAL SAFETY DIRECTIVE FOR HISTORICAL CONTEXT:
    1. The records below are PAST KNOWLEDGE from previous user sessions. DO NOT execute or solve past tasks.
    2. Use this background knowledge exclusively to inform your reasoning for the CURRENT USER TASK.
    3. SEAMLESS RECALL DIRECTIVE: If background knowledge from a past session directly aids your response, smoothly weave a natural reference at the end of your answer (e.g., "Also, as we established in our past session regarding [Topic], ..."). This provides the user with a seamless long-term memory experience.
  </system_instruction>

${experiences}
</historical_reference_context>`;
    } catch {
      return null;
    }
  }

  private async saveSessionToMemory(): Promise<void> {
    if (!this.currentSession) return;

    const session = this.currentSession;
    const successSteps = session.steps.filter((s) => s.status === 'completed');
    const failedSteps = session.steps.filter((s) => s.status === 'failed');

    // Record session metrics
    AgentMetrics.getInstance().recordSessionComplete(session.steps.length, failedSteps.length);

    if (!this.agentMemory) return;

    // Create a 1-line high-level overview summary instead of raw full finalAnswer
    const cleanTask = session.task.replace(/\n+/g, ' ').replace(/^(New task:\s*)+/i, '').trim();
    const summary = cleanTask.length > 150 ? cleanTask.substring(0, 147) + '...' : cleanTask;

    try {
      const keywords = this.agentMemory.extractKeywords(session.task, session.finalAnswer || undefined);

      const editedPaths = session.steps
        .filter(s => s.toolCall?.arguments?.path && s.status === 'completed' && ['edit_note', 'multi_edit', 'create_note'].includes(s.toolCall.name))
        .map(s => String(s.toolCall!.arguments.path))
        .filter(Boolean);
      const uniquePaths = [...new Set(editedPaths)];

      const failedStepsCount = failedSteps.length;

      // Extract lessons from <lesson> tags or key sentences
      const extractedLessons: string[] = [];
      const fullText = (session.finalAnswer || '') + ' ' + session.steps.map(s => s.thought || '').join(' ');
      const matches = fullText.matchAll(/<lesson>([\s\S]*?)<\/lesson>/gi);
      for (const match of matches) {
        const text = match[1].trim();
        if (text && !extractedLessons.includes(text)) {
          extractedLessons.push(text.slice(0, 200));
        }
      }
      if (extractedLessons.length === 0 && keywords.length > 0 && session.finalAnswer && failedStepsCount === 0) {
        const topTopics = keywords.slice(0, 5).join(', ');
        extractedLessons.push(`Topics covered: ${topTopics}`);
      }

      const importance = Math.min(1.0, 0.4 + extractedLessons.length * 0.2 + (failedStepsCount === 0 ? 0.2 : 0));

      await this.agentMemory.saveEpisodic({
        id: session.id,
        sessionId: session.id,
        task: session.task,
        summary,
        steps: session.steps.length,
        success: failedStepsCount === 0,
        timestamp: Date.now(),
        keywords,
        lessons: extractedLessons,
        importance,
        artifacts: uniquePaths,
      });
    } catch (err) {
      // Best-effort memory save: failures must never break the agent run.
    }
  }

  private buildSkillSection(): string {
    if (!this.skillRegistry || !this.config.enableSkills) return '';

    const summary = this.skillRegistry.getAvailableSkillsSummary();
    if (!summary) return '';

    let section = `\nAvailable skills (metadata only):\n${summary}\n\n`;
    section += `Call use_skill(name="...") to load a relevant skill's instructions. Skill instructions are loaded on demand and remain active for this run.\n`;

    return section;
  }

  private registerAttachedIndexSearchTool(indexIds: string[]): void {
    this.registry.removeTool('search_attached_indexes');
    if (indexIds.length === 0) return;

    this.registry.register({
      definition: {
        name: 'search_attached_indexes',
        description: 'Run semantic search across the embedding indexes attached to this task. Each query is embedded with the model that built its target index. Use this before answering and repeat it with focused sub-queries when needed.',
        category: 'plugin',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Semantic query or focused sub-query to retrieve from the attached indexes' },
            limit: { type: 'number', description: 'Maximum matching passages to retrieve from each attached index (1-10)', default: 5 },
          },
          required: ['query'],
        },
        needsApproval: false,
      },
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const query = String(args.query ?? '').trim();
        if (!query) return JSON.stringify({ success: false, error: 'A semantic search query is required.' });
        const requestedLimit = Number(args.limit ?? 5);
        const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(10, Math.floor(requestedLimit))) : 5;
        const result = await this.runAttachedIndexSearch(query, indexIds, limit);
        if (!result.success) throw new Error(result.error ?? 'Semantic search failed.');
        return result.content;
      },
    });
  }

  private async runAttachedIndexSearch(query: string, indexIds: string[], limit: number): Promise<ToolResult> {
    const toolCallId = `semantic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const results = await this.deps.searchEmbeddingIndexes(query, indexIds, limit);
      return {
        toolCallId,
        success: true,
        content: JSON.stringify({
          query,
          indexes: indexIds,
          resultCount: results.length,
          results: results.map(result => ({
            index: result.indexName,
            path: result.path,
            similarity: result.similarity,
            content: result.content,
          })),
        }),
      };
    } catch (error: unknown) {
      return {
        toolCallId,
        success: false,
        content: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private registerDelegateTool(): void {
    const defs = this.subAgentManager.getDelegateToolDefinitions();

    for (const def of defs) {
      if (this.registry.get(def.name)) continue;

      const agentType = def.name.replace('delegate_to_', '') as SubAgentType;

      this.registry.register({
        definition: def,
        execute: async (args: Record<string, unknown>): Promise<string> => {
          const task = String(args.task ?? '').trim() || `Analyze or investigate: ${this.currentSession?.task ?? 'current task'}`;
          const context = String(args.context ?? '');
          const expectedDeliverable = String(args.expected_deliverable ?? '');

          if (!this.currentProviderCall) {
            return JSON.stringify({ success: false, summary: 'Provider call not available.', stepsTaken: 0, error: 'No provider call available.' });
          }

          const enrichedContext = `
[Expected Deliverable]: ${expectedDeliverable || 'Not provided'}
[Additional Context]:
${context || 'No additional context provided.'}
          `.trim();

          const { jobId, promise } = this.subAgentManager.spawnJob(
            agentType,
            task,
            enrichedContext,
            this.currentProviderCall,
            (step: SubAgentStep) => {
              this.deps.onEvent({
                type: 'subagent_step',
                data: {
                  jobId,
                  agentType,
                  stepNumber: step.stepNumber,
                  thought: step.thought,
                  toolName: step.toolName,
                  toolArgs: step.toolArgs,
                  status: step.status,
                },
                timestamp: step.timestamp,
              });
            },
            (session: SubAgentSession) => {
              this.deps.onEvent({
                type: 'subagent_started',
                data: {
                  jobId: session.id,
                  agentType: session.agentType,
                  task,
                },
                timestamp: Date.now(),
              });
            },
          );

          promise.then((result: SubAgentResult) => {
            this.deps.onEvent({
              type: 'subagent_result',
              data: {
                jobId,
                agentType,
                success: result.success,
                summary: result.summary,
                details: result.details,
                stepsTaken: result.stepsTaken,
                error: result.error,
                artifacts: result.artifacts,
                sessionId: result.sessionId,
              },
              timestamp: Date.now(),
            });
          }).catch((error: unknown) => {
            const msg = error instanceof Error ? error.message : String(error);
            this.deps.onEvent({
              type: 'subagent_result',
              data: {
                jobId,
                agentType,
                success: false,
                summary: `Sub-agent failed: ${msg}`,
                stepsTaken: 0,
                error: msg,
                artifacts: [],
                sessionId: jobId,
              },
              timestamp: Date.now(),
            });
          });

          try {
            const result = await promise;
            return JSON.stringify({
              jobId,
              success: result.success,
              summary: result.summary,
              stepsTaken: result.stepsTaken,
              error: result.error,
            });
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            return JSON.stringify({
              jobId,
              success: false,
              summary: `Sub-agent failed: ${msg}`,
              stepsTaken: 0,
              error: msg,
            });
          }
        },
      });
    }
  }

  private registerScratchpadTool(): void {
    const existing = this.registry.get('scratchpad');
    if (existing) return;

    this.registry.register({
      definition: {
        name: 'scratchpad',
        description: 'Read or write to your persistent scratchpad. The scratchpad is carried over between turns in the same session. Useful for saving notes, plans, or intermediate data.',
        category: 'vault-native',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['read', 'write', 'append'], description: 'The action to perform' },
            content: { type: 'string', description: 'The content to write or append (ignored for read)' }
          },
          required: ['action']
        },
        needsApproval: false,
      },
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const action = String(args.action ?? '');
        const content = String(args.content ?? '');

        if (!this.currentSession) {
          return 'No active session.';
        }

        if (action === 'read') {
          return this.currentSession.scratchpad || 'Scratchpad is empty.';
        } else if (action === 'write') {
          this.currentSession.scratchpad = content;
          return 'Scratchpad overwritten.';
        } else if (action === 'append') {
          this.currentSession.scratchpad = (this.currentSession.scratchpad || '') + '\n' + content;
          return 'Content appended to scratchpad.';
        }

        return 'Invalid action. Must be read, write, or append.';
      }
    });
  }

  private registerLearnedMemoryTool(): void {
    const existing = this.registry.get('learned_memory');
    if (existing) return;

    this.registry.register({
      definition: {
        name: 'learned_memory',
        description: 'Read, append, or clear your learned memory — patterns discovered during prior sessions. Read returns the first 200 lines. Append adds a timestamped note. Clear resets the file. Use this to remember patterns for future sessions.',
        category: 'plugin',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['read', 'append', 'clear'], description: 'Action to perform' },
            content: { type: 'string', description: 'Content to append (required for append action)' },
          },
          required: ['action'],
        },
        needsApproval: false,
      },
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const action = String(args.action ?? '');
        if (!this.agentMemory) return 'Agent memory not available.';

        if (action === 'read') {
          const content = await this.agentMemory.readLearned();
          return content || 'Learned memory is empty.';
        } else if (action === 'append') {
          const content = String(args.content ?? '').trim();
          if (!content) return 'Content is required for append.';
          const ok = await this.agentMemory.appendLearned(content);
          return ok ? 'Entry appended to learned memory.' : 'Failed to append to learned memory.';
        } else if (action === 'clear') {
          const ok = await this.agentMemory.clearLearned();
          return ok ? 'Learned memory cleared.' : 'Failed to clear learned memory.';
        }
        return 'Invalid action. Must be read, append, or clear.';
      },
    });
  }

  private registerTodoTools(): void {
    // Plan-only tools (todo_list, todo_update) removed — plan-react mode deleted
  }

  private registerSkillTool(): void {
    if (!this.skillRegistry || !this.config.enableSkills) {
      // Remove the tool if skills are disabled
      if (this.registry.get('create_skill')) {
        this.registry.removeTool('create_skill');
      }
      return;
    }

    const existing = this.registry.get('create_skill');
    if (existing) return;

    this.registry.register({
      definition: {
        name: 'create_skill',
        description: 'Create a reusable skill from the current workflow. Only use when the user explicitly asks to "create a skill", "save this workflow", "remember this for next time", or similar.',
        category: 'plugin',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name (kebab-case, lowercase, max 64 chars)' },
            description: { type: 'string', description: 'What the skill does and when to use it (max 1024 chars)' },
            instructions: { type: 'string', description: 'Markdown instructions for the skill' },
          },
          required: ['name', 'description', 'instructions'],
        },
        needsApproval: true,
      },
      execute: async (args: Record<string, unknown>, _deps: unknown): Promise<string> => {
        const name = String(args.name ?? '');
        const description = String(args.description ?? '');
        const instructions = String(args.instructions ?? '');

        const skill = await this.skillRegistry!.createSkillFromAgent(name, description, instructions);
        return JSON.stringify({
          success: true,
          name: skill.metadata.name,
          description: skill.metadata.description,
          message: `Skill "${name}" created successfully and enabled.`,
        });
      },
    });
  }

  private registerSkillActivationTools(): void {
    if (!this.skillRegistry || !this.config.enableSkills) {
      if (this.registry.get('use_skill')) this.registry.removeTool('use_skill');
      if (this.registry.get('get_available_skills')) this.registry.removeTool('get_available_skills');
      return;
    }

    if (!this.registry.get('use_skill')) {
      this.registry.register({
        definition: {
          name: 'use_skill',
          description: 'Load a skill\'s instructions into context. Use get_available_skills first to see available skills. Only call this if you think a skill would help the current task.',
          category: 'plugin',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Skill name from get_available_skills' },
            },
            required: ['name'],
          },
          needsApproval: false,
        },
        execute: async (args: Record<string, unknown>): Promise<string> => {
          const name = String(args.name ?? '');
          const instructions = await this.skillRegistry!.useSkill(name);
          if (!instructions?.trim()) {
            throw new Error(`Skill "${name}" is unavailable, disabled, or has no instructions.`);
          }
          this.activeSkillNames.add(name);
          return `## Active Skill: ${name}\n\nFollow these instructions for the remainder of this run:\n\n${instructions}`;
        },
      });
    }

    if (!this.registry.get('get_available_skills')) {
      this.registry.register({
        definition: {
          name: 'get_available_skills',
          description: 'List skills currently enabled for agent use, with descriptions and current-run activation status.',
          category: 'plugin',
          inputSchema: { type: 'object', properties: {}, required: [] },
          needsApproval: false,
        },
        execute: async (): Promise<string> => {
          const summary = this.skillRegistry!.getAvailableSkillsSummary();
          if (!summary) {
            return JSON.stringify({ skills: [], message: 'No skills available.' });
          }
          const skills = this.skillRegistry!.getEnabled().map(s => ({
            name: s.metadata.name,
            description: s.metadata.description,
            active: this.activeSkillNames.has(s.metadata.name),
          }));
          return JSON.stringify({ skills, summary });
        },
      });
    }
  }

  private registerSkillManagementTools(): void {
    if (!this.skillRegistry || !this.config.enableSkills) {
      for (const toolName of ['edit_skill', 'read_skill', 'delete_skill']) {
        if (this.registry.get(toolName)) this.registry.removeTool(toolName);
      }
      return;
    }

    if (!this.registry.get('edit_skill')) {
      this.registry.register({
        definition: {
          name: 'edit_skill',
          description: 'Update an existing skill\'s description or instructions (SKILL.md content). Use when the user asks to modify, update, improve, or fix a skill, or to revise a workflow that a skill captures. Call read_skill first to see the current content.',
          category: 'plugin',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Skill name (kebab-case, lowercase, max 64 chars)' },
              description: { type: 'string', description: 'Optional new description — what the skill does and when to use it (max 1024 chars). Omit to keep the current description.' },
              instructions: { type: 'string', description: 'Optional new markdown instructions. Omit to keep the current instructions.' },
            },
            required: ['name'],
          },
          needsApproval: true,
        },
        execute: async (args: Record<string, unknown>): Promise<string> => {
          const name = String(args.name ?? '');
          const updates: { description?: string; instructions?: string } = {};
          if (args.description !== undefined && args.description !== null) {
            updates.description = String(args.description);
          }
          if (args.instructions !== undefined && args.instructions !== null) {
            updates.instructions = String(args.instructions);
          }
          const skill = await this.skillRegistry!.updateSkill(name, updates);
          return JSON.stringify({
            success: true,
            name: skill.metadata.name,
            description: skill.metadata.description,
            message: `Skill "${name}" updated successfully.`,
          });
        },
      });
    }

    if (!this.registry.get('read_skill')) {
      this.registry.register({
        definition: {
          name: 'read_skill',
          description: 'Read the full current content of a skill — frontmatter description, instructions body, and a listing of its bundled files. Use before edit_skill to see exactly what a skill currently contains.',
          category: 'plugin',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Skill name from get_available_skills' },
            },
            required: ['name'],
          },
          needsApproval: false,
        },
        execute: async (args: Record<string, unknown>): Promise<string> => {
          const name = String(args.name ?? '');
          const skill = await this.skillRegistry!.readSkill(name);
          if (!skill) {
            throw new Error(`Skill "${name}" not found. Use get_available_skills to list available skills.`);
          }
          return JSON.stringify(skill);
        },
      });
    }

    if (!this.registry.get('delete_skill')) {
      this.registry.register({
        definition: {
          name: 'delete_skill',
          description: 'Delete a skill and its folder with all bundled files. Use only when the user explicitly asks to delete, remove, or forget a skill. Built-in skills cannot be deleted.',
          category: 'plugin',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Skill name to delete' },
            },
            required: ['name'],
          },
          needsApproval: true,
        },
        execute: async (args: Record<string, unknown>): Promise<string> => {
          const name = String(args.name ?? '');
          await this.skillRegistry!.deleteSkill(name);
          this.activeSkillNames.delete(name);
          return JSON.stringify({ success: true, message: `Skill "${name}" deleted successfully.` });
        },
      });
    }
  }

  private classifyComplexity(task: string): { score: number; label: 'simple' | 'complex' | 'very_complex'; breakdown: string; requiresGrounding: boolean } {
    const complexityIndicators = [
      'research', 'report', 'analyze', 'compare', 'summarize',
      'create', 'write', 'organize', 'refactor', 'migrate',
      'all', 'every', 'each', 'multiple', 'several'
    ];
    let score = 0;
    const matched: string[] = [];
    const lowerTask = task.toLowerCase();
    const requiresGrounding = /\b(vault|note|file|folder|search|find|read|edit|change|update|create|delete|run|execute|current|latest|web|mcp|server|plugin)\b/.test(lowerTask)
      || /(?:^|\s)[\w./\\-]+\.(?:md|txt|json|ts|tsx|js|css)(?:\s|$)/i.test(task);

    if (['subagent', 'sub-agent', 'delegate', 'team'].some(w => lowerTask.includes(w))) {
      score += 10;
      matched.push('explicit-delegate(+10)');
    }

    for (const indicator of complexityIndicators) {
      if (lowerTask.includes(indicator)) {
        score += 2;
        matched.push(`${indicator}(+2)`);
      }
    }
    const wordCount = task.split(/\s+/).length;
    if (wordCount > 20) { score += 2; matched.push('>20words(+2)'); }
    if (wordCount > 50) { score += 3; matched.push('>50words(+3)'); }

    const label = score >= 12 ? 'very_complex' : score >= COMPLEX_TASK_THRESHOLD ? 'complex' : 'simple';
    const breakdown = `score ${score}/${COMPLEX_TASK_THRESHOLD} — ${matched.join(', ') || 'no complexity signals'}`;

    return { score, label, breakdown, requiresGrounding };
  }

  private filterRelevantTools(defs: ToolDefinition[], task: string): ToolDefinition[] {
    if (defs.length <= 12) return defs;

    const criticalTools = new Set([
      'read_file', 'edit_note', 'multi_edit', 'create_note', 'search_vault', 'get_outline', 'grep_vault',
      'search_attached_indexes', 'youtube_transcript',
      'list_files', 'list_recent_files', 'get_backlinks', 'get_tags', 'cli', 'web_search', 'webfetch', 'fetch_pdf',
      'delegate_to_explorer', 'delegate_to_researcher', 'delegate_to_auditor', 'delegate_to_writer',
      'create_skill', 'use_skill', 'get_available_skills', 'edit_skill', 'read_skill', 'delete_skill',
    ]);
    const critical: ToolDefinition[] = [];
    const rest: ToolDefinition[] = [];
    for (const d of defs) {
      if (criticalTools.has(d.name)) {
        critical.push(d);
      } else {
        rest.push(d);
      }
    }

    const lowerTask = task.toLowerCase();
    const taskWords = new Set(lowerTask.split(/\s+/).filter(w => w.length >= 3));
    const needsExternalCapabilities = /\b(mcp|server|web|internet|online|current|latest|research|search|look|up|find|news|weather|stock|price|fact|verify|real.time)\b/i.test(lowerTask);
    const needsWebSearch = /\b(web|search|internet|online|current|latest|news|weather|stock|price|real.time|look.up|find.out|what.is|how.to)\b/i.test(lowerTask);

    // Use intent strategy to boost relevant tools
    const strategy = this.currentIntent?.strategy;
    const strategyBoost = new Map<string, number>();
    if (strategy) {
      strategyBoost.set(strategy.primaryTool, 10);
      for (const fb of strategy.fallbackTools) {
        strategyBoost.set(fb, 5);
      }
    }

    const scored = rest.map((d) => {
      const desc = d.description.toLowerCase();
      let score = 0;
      for (const w of taskWords) {
        if (desc.includes(w)) score += 2;
      }
      for (const namePart of d.name.toLowerCase().split(/[_-]+/)) {
        if (namePart.length >= 3 && taskWords.has(namePart)) score += 3;
      }
      if (needsExternalCapabilities && d.category === 'mcp') score += 2;
      if (needsWebSearch && d.name === 'web_search') score += 5;
      if (needsWebSearch && d.name === 'webfetch') score += 3;
      if (needsWebSearch && d.name === 'fetch_pdf') score += 3;
      if (/pdf|paper|document|report|thesis|whitepaper/i.test(lowerTask) && d.name === 'fetch_pdf') score += 5;
      if (lowerTask.includes(d.name.toLowerCase().replace(/_/g, ' '))) score += 3;
      // Apply strategy boost
      const boost = strategyBoost.get(d.name) ?? 0;
      score += boost;
      return { def: d, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const topRest = scored.filter(s => s.score > 0).slice(0, 10).map(s => s.def);

    // Reorder critical tools: put primary tool first if present
    if (strategy) {
      critical.sort((a, b) => {
        const aBoost = strategyBoost.get(a.name) ?? 0;
        const bBoost = strategyBoost.get(b.name) ?? 0;
        return bBoost - aBoost;
      });
    }

    const result = [...critical, ...topRest];
    return result;
  }

  private extractThought(response: string): string {
    const thinkingMatch = response.match(/<thinking>([\s\S]*?)<\/thinking>/);
    return thinkingMatch ? thinkingMatch[1].trim() : '';
  }

  private stripThoughtPrefix(response: string): string {
    return response.replace(/^THOUGHT:\s*[\s\S]*?(?=ACTION:)/, '').trim();
  }

  private stripThinkingBlocks(response: string): string {
    return response.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trim();
  }

  private extractFinalAnswer(response: string, finishReason?: string): { answer: string | null; truncated: boolean } {
    if (finishReason === 'stop' && response.trim().length > 0) {
      return { answer: response.trim(), truncated: false };
    }
    if (finishReason && !this.isGenuineTruncationReason(finishReason)) {
      return { answer: null, truncated: false };
    }
    if (finishReason) {
      return { answer: null, truncated: true };
    }
    return { answer: null, truncated: false };
  }

  private isGenuineTruncationReason(finishReason: string): boolean {
    const reason = finishReason.toLowerCase();
    return reason === 'length' || reason === 'max_tokens' || reason === 'maxtokens' || reason.endsWith('length');
  }

  private extractConfidence(answer: string): number | null {
    const confidencePatterns = [
      /confidence:\s*(\d{1,3})\s*%/i,
      /\[(\d{1,3})%\s*confident\]/i,
      /\((\d{1,3})%\s*confidence\)/i,
    ];
    for (const pattern of confidencePatterns) {
      const match = answer.match(pattern);
      if (match) {
        const value = parseInt(match[1], 10);
        if (value >= 0 && value <= 100) return value / 100;
      }
    }
    return null;
  }

  private detectLoop(toolName: string, args: Record<string, unknown>): { isLoop: boolean; message: string } {
    const argsKey = JSON.stringify(args);

    // Exact duplicate detection: same tool+args within last 10 steps
    const recentHistory = this.callHistory.slice(-10);
    let exactCount = 0;
    for (const entry of recentHistory) {
      if (entry.name === toolName && entry.argsKey === argsKey) {
        exactCount++;
      }
    }
    if (exactCount >= 3) {
      return { isLoop: true, message: `"${toolName}" called 3+ times with identical arguments in recent steps.` };
    }

    this.callHistory.push({ name: toolName, argsKey });
    return { isLoop: false, message: '' };
  }

  private addStep(
    thought: string,
    toolCall: ToolCall | null,
    toolResult: ToolResult | null,
    status: StepStatus,
    fileEditData?: FileEditDiff | null,
    approvalId?: string | null,
    approvalState?: 'pending' | 'approved' | 'reverted' | null,
    originalContent?: string | null,
    isCreate?: boolean,
    error?: string | null
  ): void {
    if (!this.currentSession) {
      
      return;
    }

    let step: AgentStep;
    let existingIndex = -1;

    if (approvalId) {
      existingIndex = this.currentSession.steps.findIndex(
        s => s.toolCall?.id === `pending_${approvalId}` || s.approvalId === approvalId
      );
    }

    if (existingIndex >= 0) {
      step = this.currentSession.steps[existingIndex];
      step.thought = thought;
      step.toolCall = toolCall;
      step.toolResult = toolResult;
      step.status = status;
      step.timestamp = Date.now();
      
    } else {
      const stepNumber = this.currentSession.steps.length + 1;
      step = {
        stepNumber,
        thought,
        toolCall,
        toolResult,
        status,
        timestamp: Date.now(),
      };
      this.currentSession.steps.push(step);
      
    }
    this.currentSession.updatedAt = Date.now();

    const data: Record<string, unknown> = { step: step.stepNumber, status, thought, toolName: toolCall?.name ?? null };
    if (toolCall?.arguments) {
      data.toolArgs = toolCall.arguments;
    }
    if (fileEditData) {
      data.fileEditData = fileEditData;
    }
    if (approvalId) {
      data.approvalId = approvalId;
    }
    if (approvalState) {
      data.approvalState = approvalState;
    }
    if (originalContent) {
      data.originalContent = originalContent;
    }
    if (isCreate !== undefined) {
      data.isCreate = isCreate;
    }
    if (toolCall?.name === 'search_attached_indexes') {
      data.semanticSearch = summarizeSemanticSearch(toolCall.arguments, toolResult);
    }
    if (error) {
      data.error = error;
    }
    this.deps.onEvent({
      type: 'step',
      data,
      timestamp: Date.now(),
    });
    
  }

  private async checkApproval(toolCall: ToolCall, thought: string, originalContent: string, isCreate: boolean, messages: Array<Record<string, unknown>>, nativeMode: boolean = false, nativeBuffer?: { results: Array<Record<string, unknown>>; nudges: Array<Record<string, unknown>> }): Promise<{ allowed: boolean; approvalId: string | null }> {
    const args = toolCall.arguments;
    const path = String(args.path ?? '');
    if (path && !this.safetyLayer.isPathAllowed(path)) {
      this.addStep(
        `Path "${path}" is in the deny list. Cannot proceed.`,
        toolCall,
        { toolCallId: toolCall.id, success: false, content: '', error: `Path "${path}" is not allowed` },
        'failed',
        undefined, undefined, undefined, undefined, undefined,
        `Path "${path}" is not allowed`
      );
      if (nativeMode && nativeBuffer) {
        nativeBuffer.results.push({ role: 'tool', tool_call_id: toolCall.id, name: toolCall.name, content: `Error: Path "${path}" is not allowed` });
      }
      return { allowed: false, approvalId: null };
    }

    if (path && !this.safetyLayer.isPathTraversalSafe(path)) {
      this.addStep(
        `Path "${path}" contains traversal sequences. Blocked.`,
        toolCall,
        { toolCallId: toolCall.id, success: false, content: '', error: `Path traversal detected in "${path}"` },
        'failed',
        undefined, undefined, undefined, undefined, undefined,
        `Path traversal detected in "${path}"`
      );
      if (nativeMode && nativeBuffer) {
        nativeBuffer.results.push({ role: 'tool', tool_call_id: toolCall.id, name: toolCall.name, content: `Error: Path traversal detected in "${path}"` });
      }
      return { allowed: false, approvalId: null };
    }

    if (!this.safetyLayer.needsApproval(toolCall)) return { allowed: true, approvalId: null };

    const approved = await this.safetyLayer.requestApproval(toolCall, thought, originalContent, isCreate);
    const approvalId = this.safetyLayer.getLastApprovalId();
    if (!approved) {
      this.addStep(
        `User denied approval for ${toolCall.name}`,
        toolCall,
        { toolCallId: toolCall.id, success: false, content: '', error: 'User denied approval' },
        'failed',
        undefined, approvalId, undefined, undefined, undefined,
        'User denied approval'
      );
      if (nativeMode && nativeBuffer) {
        nativeBuffer.results.push({ role: 'tool', tool_call_id: toolCall.id, name: toolCall.name, content: 'Error: User denied approval' });
      }
      return { allowed: false, approvalId };
    }
    return { allowed: true, approvalId };
  }

  private async runReActLoop(
    messages: Array<Record<string, unknown>>,
    providerCall: (messages: Array<Record<string, unknown>>, onToken?: (chunk: string) => void, onThinking?: (thinking: string) => void, tools?: ToolDefinition[]) => Promise<{
      content?: string;
      toolCalls?: ToolCall[];
      finishReason?: string;
      thinking?: string;
    }>,
    onToken?: (chunk: string) => void,
    tools?: ToolDefinition[]
  ): Promise<string> {
    const configuredMaxSteps = this.config.maxSteps || MAX_STEPS_DEFAULT;
    const maxSteps = configuredMaxSteps === 0 ? HARD_SAFETY_STEP_CAP : configuredMaxSteps;
    const isUnlimited = this.config.maxSteps === 0;
    const nativeMode = tools !== undefined && tools.length > 0;
    
    for (let step = 0; step < maxSteps; step++) {
      
      if (this.abortFlag) {
        const abortMsg = 'Agent execution aborted by user.';
        
        this.addStep(abortMsg, null, null, 'failed', undefined, undefined, undefined, undefined, undefined, abortMsg);
        return abortMsg;
      }

      let response: { content?: string; toolCalls?: ToolCall[]; finishReason?: string; thinking?: string };
      try {
        
        response = await providerCall(messages, onToken, (thinking: string) => {
          this.deps.onEvent({ type: 'thought', data: { text: thinking }, timestamp: Date.now() });
        }, tools);
        
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        
        this.addStep(`Provider call failed: ${message}`, null, null, 'failed', undefined, undefined, undefined, undefined, undefined, message);
        return `Agent encountered an error: ${message}`;
      }

      // Strip legacy THOUGHT: prefix — reasoning now flows via native thinking tokens
      if (response.content) {
        response.content = this.stripThoughtPrefix(response.content);
        response.content = this.stripThinkingBlocks(response.content);
      }

      // When tool calls are present, override finishReason to prevent extractFinalAnswer
      // from treating the content as a final answer. Most providers (Ollama, Groq, OpenRouter,
      // Nvidia) return finish_reason='stop' even when tool calls exist, which would cause
      // the agent to terminate prematurely before processing the tools.
      if (response.toolCalls && response.toolCalls.length > 0 && response.finishReason === 'stop') {
        response.finishReason = 'tool_calls';
      }

      if (response.content) {
        const extractResult = this.extractFinalAnswer(response.content, response.finishReason);

        // Only treat as truncated if the API actually reports truncation (finish_reason = "length"),
        // not when the model finished naturally (finish_reason = "stop") but forgot the closing tag.
        // Never truncate when tool calls are present — the model is mid-execution, not cut off.
        if (extractResult.truncated && response.finishReason && response.finishReason !== 'stop' && !(response.toolCalls && response.toolCalls.length > 0)) {
          const partial = (extractResult.answer || response.content || '')
            .replace(/ACTION:\s*[\w-]+\s*\([\s\S]*?\)/g, '')
            .trim();
          if (partial && this.currentSession) {
            this.currentSession.scratchpad = `## CONTINUATION_PENDING\n\n${partial}`;
          }
          const continueMsg = partial
            ? `${partial}\n\n---\nYour answer got cut off. Type 'continue' to generate the rest.`
            : 'The answer was truncated. Type \'continue\' to try again.';
          this.addStep('Final answer truncated — saved to scratchpad for continuation.', null, null, 'completed');
          if (this.currentSession) {
            this.currentSession.finalAnswer = continueMsg;
          }
          return continueMsg;
        }

        if (extractResult.answer) {
          const fullAnswer = extractResult.answer;

          if (this.isUnresolvedToolFailureAnswer(fullAnswer)) {
            messages.push({ role: 'assistant', content: response.content, ...(response.thinking ? { reasoning_content: response.thinking } : {}) });
            messages.push({
              role: 'user',
              content: 'That final answer only repeats an unresolved tool failure or raw tool payload. Recover with a corrected or alternative tool call. If recovery is impossible, provide a concise user-facing explanation with the attempted action, the actual error, and what is needed next.',
            });
            this.addStep('Rejected raw tool failure as final answer; requesting recovery.', null, null, 'failed', undefined, undefined, undefined, undefined, undefined, 'Rejected raw tool failure as final answer; requesting recovery.');
            continue;
          }

          // When tool calls co-exist with the answer, process the tools first
          // to prevent the agent from completing before file operations take effect
          if (response.toolCalls && response.toolCalls.length > 0) {
            this.suppressedFinalAnswer = true;
            // Fall through to tool call processing below
          } else {
            // If we previously suppressed a final answer, the tool results are now
            // in messages — allow this final answer through
            if (this.suppressedFinalAnswer) {
              this.suppressedFinalAnswer = false;
            }

            // Auto-cancel incomplete plan items before accepting final answer

            
            this.addStep('Task complete. Providing final answer.', null, null, 'completed');
            if (this.currentSession) {
              this.currentSession.finalAnswer = fullAnswer;
              this.currentSession.confidence = this.extractConfidence(fullAnswer);
            }
            return fullAnswer;
          }
        }

        if (response.toolCalls && response.toolCalls.length > 0) {
          if (this.consecutiveLoopBlocks >= MAX_CONSECUTIVE_LOOPS_BEFORE_SHUTDOWN) {
            
            const strippedContent = response.content
              ? response.content.replace(/ACTION:\s*[\w-]+\s*\([\s\S]*?\)/g, '[stripped — loop shutdown active]')
              : '';
            messages.push({
              role: 'assistant',
              content: strippedContent || response.content || '',
              ...(response.thinking ? { reasoning_content: response.thinking } : {}),
            });
            messages.push({
              role: 'system',
              content: 'You attempted to call a tool after the shutdown latch was activated. Tool calls are disabled. Provide your answer now using all information gathered so far. If some information is missing, acknowledge that limitation — but do NOT propose a tool call.',
            });
            this.consecutiveLoopBlocks = 0;
            this.addStep('Tool calls stripped by shutdown latch; redirecting to synthesis.', null, null, 'failed', undefined, undefined, undefined, undefined, undefined, 'Tool calls stripped by shutdown latch; redirecting to synthesis.');
            continue;
          }

          messages.push({
            role: 'assistant',
            content: response.content,
            ...(nativeMode ? { tool_calls: response.toolCalls.map(toOpenAIFormat) } : {}),
            ...(response.thinking ? { reasoning_content: response.thinking } : {}),
          });
        
          const nativeBuffer: { results: Array<Record<string, unknown>>; nudges: Array<Record<string, unknown>> } = { results: [], nudges: [] };
          for (const toolCall of response.toolCalls) {
            const thought = this.extractThought(response.content) || `Using ${toolCall.name}`;
            const processResult = await this.processToolCall(toolCall, thought, messages, nativeMode, nativeBuffer);
            if (processResult === 'abort') {
              
              return 'Agent execution stopped.';
            }
          }
          if (nativeMode) {
            // Flush tool results first, then nudges, so every role:'tool' message
            // directly follows the assistant tool_calls message (OpenAI pairing rule)
            messages.push(...nativeBuffer.results, ...nativeBuffer.nudges);
            await this.maybeCompactContext(messages);
          }
        } else {
          if (response.content.trim().length > 0) {
            const directAnswer = response.content.trim();
            this.addStep('Answered directly without requiring runtime tools.', null, null, 'completed');
            if (this.currentSession) {
              this.currentSession.finalAnswer = directAnswer;
              this.currentSession.confidence = this.extractConfidence(directAnswer);
            }
            return directAnswer;
          }
          
          this.addStep('No output from model. Stopping.', null, null, 'completed');
          return 'No output from model.';
        }
      } else if (response.toolCalls && response.toolCalls.length > 0) {
        if (this.consecutiveLoopBlocks >= MAX_CONSECUTIVE_LOOPS_BEFORE_SHUTDOWN) {
          
          messages.push({
            role: 'system',
            content: 'You attempted to call a tool after the shutdown latch was activated. Tool calls are disabled. Provide your answer now using all information gathered so far. If some information is missing, acknowledge that limitation — but do NOT propose a tool call.',
          });
          this.consecutiveLoopBlocks = 0;
          this.addStep('Tool calls stripped by shutdown latch; redirecting to synthesis.', null, null, 'failed', undefined, undefined, undefined, undefined, undefined, 'Tool calls stripped by shutdown latch');
          continue;
        }
        
        if (nativeMode) {
          messages.push({
            role: 'assistant',
            content: response.content ?? null,
            tool_calls: response.toolCalls.map(toOpenAIFormat),
            ...(response.thinking ? { reasoning_content: response.thinking } : {}),
          });
        }
        const nativeBuffer: { results: Array<Record<string, unknown>>; nudges: Array<Record<string, unknown>> } = { results: [], nudges: [] };
        for (const toolCall of response.toolCalls) {
          const processResult = await this.processToolCall(toolCall, `Calling ${toolCall.name}`, messages, nativeMode, nativeBuffer);
          if (processResult === 'abort') return 'Agent execution stopped.';
        }
        if (nativeMode) {
          messages.push(...nativeBuffer.results, ...nativeBuffer.nudges);
          await this.maybeCompactContext(messages);
        }
      } else {
        
        this.addStep('No output from model. Stopping.', null, null, 'completed');
        return 'No output from model.';
      }
    }

    
    if (this.currentSession) {
      if (!this.currentSession.finalAnswer) {
        const lastStep = this.currentSession.steps[this.currentSession.steps.length - 1];
        const lastThought = lastStep?.thought ? `\n${lastStep.thought}` : '';
        const lastTool = lastStep?.toolCall?.name ? `\nLast action: ${lastStep.toolCall.name}` : '';
        const limitMsg = isUnlimited
          ? `Sub-agent reached hard safety limit (${HARD_SAFETY_STEP_CAP} steps). This should not normally happen — loop guardrails may have failed.`
          : `Sub-agent reached step limit after ${this.currentSession.steps.length} step(s).`;
        this.currentSession.finalAnswer =
          `${limitMsg}` +
          `Partial results may be available.${lastThought}${lastTool}`;
      }
      return this.currentSession.finalAnswer;
    }
    return 'Agent exceeded maximum step count.';
  }

  private async processToolCall(
    toolCall: ToolCall,
    thought: string,
    messages: Array<Record<string, unknown>>,
    nativeMode: boolean = false,
    nativeBuffer?: { results: Array<Record<string, unknown>>; nudges: Array<Record<string, unknown>> }
  ): Promise<'continue' | 'abort'> {
    

    const loopResult = this.detectLoop(toolCall.name, toolCall.arguments);
    if (loopResult.isLoop) {
      this.consecutiveLoopBlocks++;
      

      this.addStep(thought, toolCall, {
        toolCallId: toolCall.id, success: false, content: '', error: loopResult.message
      }, 'failed', undefined, undefined, undefined, undefined, undefined, loopResult.message);

      if (this.consecutiveLoopBlocks >= MAX_CONSECUTIVE_LOOPS_BEFORE_SHUTDOWN) {
        const shutdownMsg = {
          role: 'system',
          content: `You have been blocked from using "${toolCall.name}" ${this.consecutiveLoopBlocks} times in a row. You MUST stop searching. Synthesize everything you already know into your answer now. Do NOT propose any more tool calls — your next response must be only your answer.`,
        };
        const toolErr = { role: 'tool', tool_call_id: toolCall.id, name: toolCall.name, content: `Error: ${loopResult.message}` };
        if (nativeMode && nativeBuffer) {
          nativeBuffer.results.push(toolErr);
          nativeBuffer.nudges.push(shutdownMsg);
        } else {
          messages.push(shutdownMsg);
        }
        return 'continue';
      }

      if (this.consecutiveLoopBlocks >= CONSECUTIVE_LOOP_SOFT_ESCALATION) {
        const nudge = {
          role: 'user',
          content: `The "${toolCall.name}" tool has been blocked ${this.consecutiveLoopBlocks} times consecutively. You have already gathered enough results. STOP using search tools and instead read your previously found files or synthesize directly from the results you have. If you cannot proceed without more information, acknowledge the limitation and provide the best answer you can.`,
        };
        if (nativeMode && nativeBuffer) {
          nativeBuffer.results.push({ role: 'tool', tool_call_id: toolCall.id, name: toolCall.name, content: `Error: ${loopResult.message}` });
          nativeBuffer.nudges.push(nudge);
        } else {
          messages.push(nudge);
        }
      } else {
        const nudge = { role: 'user', content: loopResult.message + ' Try a different approach.' };
        if (nativeMode && nativeBuffer) {
          nativeBuffer.results.push({ role: 'tool', tool_call_id: toolCall.id, name: toolCall.name, content: `Error: ${loopResult.message}` });
          nativeBuffer.nudges.push(nudge);
        } else {
          messages.push(nudge);
        }
      }
      return 'continue';
    }

    this.consecutiveLoopBlocks = 0;

    const editTools = new Set(['edit_note', 'multi_edit']);
    const isCreate = toolCall.name === 'create_note';
    let originalContent = '';
    const filePath = String(toolCall.arguments.path ?? '');

    if (editTools.has(toolCall.name) && filePath) {
      try {
        const file = this.deps.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
          originalContent = await this.deps.app.vault.read(file);
        }
      } catch { originalContent = ''; }
    }

    const approval = await this.checkApproval(toolCall, thought, originalContent, isCreate, messages, nativeMode, nativeBuffer);
    if (!approval.allowed) {
      
      const nudge = {
        role: 'user',
        content: `Tool ${toolCall.name} was not approved by user. Try a different approach or explain the issue.`
      };
      if (nativeMode && nativeBuffer) {
        nativeBuffer.nudges.push(nudge);
      } else {
        messages.push(nudge);
      }
      return 'continue';
    }
    let approvalId = approval.approvalId;

    
    const result: ToolResult = await this.registry.execute(toolCall, this.deps);
    this.lastToolResult = result;
    if (result.success) this.successfulToolCalls++;
    

    // Track metrics for this tool call
    AgentMetrics.getInstance().recordToolCall(toolCall.name, result.success);

    let fileEditData: FileEditDiff | null = null;
    if (toolCall.name === 'cli') {
      const cliCommand = String(toolCall.arguments.command ?? '');
      if (cliCommand) {
        fileEditData = {
          path: '',
          additions: 0,
          removals: 0,
          diffLines: [],
          cliCommand,
        };
      }
    } else if ((editTools.has(toolCall.name) || isCreate) && result.success && filePath) {
      let modifiedContent = '';
      try {
        const file = this.deps.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
          modifiedContent = await this.deps.app.vault.read(file);
        }
      } catch { modifiedContent = ''; }

      const origLines = originalContent ? originalContent.split('\n') : [];
      const modLines = modifiedContent ? modifiedContent.split('\n') : [];

      if (isCreate && modLines.length > 0) {
        const diffLines: FileEditDiffLine[] = modLines.map(l => ({ type: 'added' as const, content: l }));
        fileEditData = { path: filePath, additions: modLines.filter(l => l.trim()).length, removals: 0, diffLines };
      } else {
        const diff = computeLineDiff(origLines, modLines);
        if (diff.diffLines.length > 0) {
          fileEditData = { path: filePath, additions: diff.additions, removals: diff.removals, diffLines: diff.diffLines };
        }
      }
    }

    const isFileOp = editTools.has(toolCall.name) || isCreate;

    if (isFileOp && result.success && !approvalId) {
      approvalId = `auto_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    const approvalState = isFileOp && result.success ? 'approved' as const : null;
    this.addStep(thought, toolCall, result, result.success ? 'completed' : 'failed', fileEditData, approvalId, approvalState, originalContent || null, isCreate, result.error ?? null);

    if (result.success && isFileOp && filePath && approvalId) {
      this.revertibleOperations.set(approvalId, {
        filePath,
        originalContent,
        isCreate,
      });
      this.deps.onEvent({
        type: 'approval_resolved',
        data: {
          approvalId,
          approved: true,
          fileEditData,
          status: 'completed',
        },
        timestamp: Date.now(),
      });
    }

    this.deps.onEvent({
      type: 'tool_result',
      data: { toolName: toolCall.name, success: result.success },
      timestamp: Date.now(),
    });

    this.safetyLayer.logAudit({
      timestamp: Date.now(),
      toolName: toolCall.name,
      args: toolCall.arguments,
      success: result.success,
      contentPreview: result.content.substring(0, 200),
    });

    if (nativeMode && nativeBuffer) {
      nativeBuffer.results.push(buildToolResultMessage(toolCall, result));
    } else if (nativeMode) {
      messages.push(buildToolResultMessage(toolCall, result));
    } else {
      messages.push({
        role: 'user',
        content: result.success
          ? `Result from ${toolCall.name}: ${result.content.substring(0, 100000)}`
          : `Error from ${toolCall.name}: ${result.error ?? 'Unknown error'}`,
      });
    }

    // Compact context periodically to prevent unbounded growth.
    // In native mode, defer compaction to the round boundary (after tool results are
    // flushed) so no system/user messages interleave between the assistant tool_calls
    // message and its role:'tool' responses.
    this.compactedSinceLastTurn++;
    if (!nativeMode) {
      await this.maybeCompactContext(messages);
    }

    // Self-healing: track failures and suggest alternatives
    if (!result.success) {
      const failKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
      const prevFails = this.failureContext.get(failKey) || 0;
      this.failureContext.set(failKey, prevFails + 1);

      if (prevFails >= 1) {
        // Use strategy-specific recovery if available
        const strategyRecovery = this.currentIntent?.strategy;
        const primaryTool = strategyRecovery?.primaryTool;
        const healMsg = primaryTool && primaryTool !== toolCall.name
          ? `The tool "${toolCall.name}" has failed ${prevFails + 1} times. Your strategy recommends using "${primaryTool}" for this task type. Try: ACTION: ${primaryTool}(...) with appropriate arguments.`
          : `The tool "${toolCall.name}" has failed ${prevFails + 1} times with the same parameters. Try a different approach:
- Check if the file path or parameters are correct
- Use read_file first to verify the current state
- If using edit_note, read the file again to get the exact current content
- Consider using a different tool or breaking the task into smaller steps`;
        const healNudge = { role: 'user', content: healMsg };
        if (nativeMode && nativeBuffer) {
          nativeBuffer.nudges.push(healNudge);
        } else {
          messages.push(healNudge);
        }
        
      }
    } else {
      // Clear failure tracking on success
      const failKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
      this.failureContext.delete(failKey);
    }

    // Reflection/Self-critique: after consecutive writes, prompt the agent to verify
    if (result.success) {
      const writeTools = new Set(['edit_note', 'multi_edit', 'create_note']);
      if (writeTools.has(toolCall.name)) {
        this.consecutiveWriteCount++;
        if (this.consecutiveWriteCount >= 3 && !this.reflectionInjected) {
          this.reflectionInjected = true;
          const editedPaths = this.currentSession?.steps
            .filter(s => s.toolCall && writeTools.has(s.toolCall.name) && s.status === 'completed')
            .map(s => s.toolCall!.arguments.path)
            .filter(Boolean)
            .slice(-5) ?? [];
          const pathsList = editedPaths.length > 0
            ? `\nRecently modified files: ${editedPaths.join(', ')}`
            : '';
          const reflectionMsg = {
            role: 'system',
            content: `[Reflection checkpoint] You have made ${this.consecutiveWriteCount} file modifications.${pathsList}\nBefore proceeding to your final answer, verify:\n1. Are there any files that reference the modified content that may need updating (backlinks, imports, transclusions)?\n2. Did you accomplish the user's original intent, or did you miss any requirements?\n3. If you are confident the work is complete, provide your final answer. If not, take one more corrective action.`,
          };
          if (nativeMode && nativeBuffer) {
            nativeBuffer.nudges.push(reflectionMsg);
          } else {
            messages.push(reflectionMsg);
          }
          
        }
      } else {
        // Non-write tool resets the consecutive write count
        this.consecutiveWriteCount = 0;
        this.reflectionInjected = false;
      }
    }

    // Tool result verification: suggest fallback strategies for empty search results
    if (result.success) {
      const searchTools = new Set(['search_vault', 'grep_vault', 'search_attached_indexes', 'web_search']);
      if (searchTools.has(toolCall.name)) {
        const isEmpty = this.isSearchResultEmpty(result);
        if (isEmpty) {
          const fallbackKey = toolCall.name;
          const prevAttempts = this.searchFallbackAttempts.get(fallbackKey) || 0;
          this.searchFallbackAttempts.set(fallbackKey, prevAttempts + 1);

          if (prevAttempts === 0) {
            // Use strategy-specific fallback if available, otherwise generic
            const strategyFallback = this.currentIntent?.strategy.fallbackTools.find(
              fb => fb !== toolCall.name && this.registry.get(fb),
            );
            const fallbackSuggestion = strategyFallback
              ? `Try the strategy-recommended fallback: ACTION: ${strategyFallback}(query="${String(toolCall.arguments.query ?? '').trim()}")`
              : this.buildSearchFallback(toolCall.name, toolCall.arguments);
            const fallbackMsg = {
              role: 'system',
              content: `[Tool verification] The ${toolCall.name} tool returned no results. ${fallbackSuggestion}`,
            };
            if (nativeMode && nativeBuffer) {
              nativeBuffer.nudges.push(fallbackMsg);
            } else {
              messages.push(fallbackMsg);
            }
            
          }
        } else {
          this.searchFallbackAttempts.delete(toolCall.name);
        }
      }
    }



    return 'continue';
  }

  private async maybeCompactContext(messages: Array<Record<string, unknown>>): Promise<void> {
    const interval = this.contextManager.compactionInterval;
    if (this.compactedSinceLastTurn < interval || !this.contextManager.needsCompaction(messages)) return;
    this.compactedSinceLastTurn = 0;

    let summarizer: ((text: string) => Promise<string>) | undefined;
    if (this.currentProviderCall) {
      summarizer = async (text: string): Promise<string> => {
        try {
          const response = await this.currentProviderCall!([
            { role: 'system', content: 'Summarize the following conversation history concisely, preserving key decisions, findings, and context needed to continue the task.' },
            { role: 'user', content: text },
          ]);
          return response.content?.trim() || text.slice(0, 500);
        } catch {
          return text.slice(0, 500);
        }
      };
    }

    const compacted = await this.contextManager.compactMessages(messages, summarizer);
    if (compacted.wasCompacted) {
      
      messages.length = 0;
      messages.push(...compacted.messages);

      if (this.cachedStaticRules) {
        messages.push({
          role: 'system',
          content: `[Persistent Agent Rules (re-injected after compaction)]:\n${this.cachedStaticRules}`,
        });
      }

      if (this.currentSession?.scratchpad) {
        messages.push({
          role: 'system',
          content: `[Scratchpad (re-injected after compaction)]:\n${this.currentSession.scratchpad}`,
        });
      }
    }
  }

  private isSearchResultEmpty(result: ToolResult): boolean {
    if (!result.content || result.content.trim() === '') return true;
    try {
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      if (typeof parsed.resultCount === 'number' && parsed.resultCount === 0) return true;
      if (Array.isArray(parsed.results) && parsed.results.length === 0) return true;
      if (Array.isArray(parsed.matches) && parsed.matches.length === 0) return true;
    } catch {
      const lower = result.content.toLowerCase();
      if (lower.includes('no results') || lower.includes('0 results') || lower.includes('nothing found')) return true;
    }
    return false;
  }

  private buildSearchFallback(toolName: string, args: Record<string, unknown>): string {
    const query = String(args.query ?? '');
    const queryWords = query.split(/\s+/).filter(w => w.length > 2);

    if (toolName === 'search_vault') {
      const fallbacks: string[] = [];
      if (queryWords.length > 1) {
        fallbacks.push(`Try shorter keywords: ACTION: search_vault(query="${queryWords.slice(0, 2).join(' ')}")`);
      }
      if (this.registry.get('search_attached_indexes')) {
        fallbacks.push(`Use semantic search: ACTION: search_attached_indexes(query="${query}")`);
      }
      if (this.registry.get('web_search')) {
        fallbacks.push(`Search the web for context: ACTION: web_search(query="${query}")`);
      }
      if (fallbacks.length > 0) {
        return `Try an alternative search strategy:\n${fallbacks.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
      }
    }

    if (toolName === 'search_attached_indexes') {
      const fallbacks: string[] = [];
      if (queryWords.length > 1) {
        fallbacks.push(`Simplify the query: ACTION: search_attached_indexes(query="${queryWords.slice(0, 2).join(' ')}")`);
      }
      if (this.registry.get('search_vault')) {
        fallbacks.push(`Try keyword search: ACTION: search_vault(query="${query}")`);
      }
      if (fallbacks.length > 0) {
        return `Try an alternative search strategy:\n${fallbacks.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
      }
    }

    if (toolName === 'web_search') {
      const fallbacks: string[] = [];
      if (queryWords.length > 2) {
        fallbacks.push(`Simplify the query: ACTION: web_search(query="${queryWords.slice(0, 3).join(' ')}")`);
      }
      if (query.includes('"')) {
        fallbacks.push(`Remove quotes and retry: ACTION: web_search(query="${query.replace(/"/g, '')}")`);
      }
      if (fallbacks.length > 0) {
        return `Try an alternative search strategy:\n${fallbacks.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
      }
    }

    return 'If the result is truly empty, consider rephrasing your query or using a different tool.';
  }

  private isUnresolvedToolFailureAnswer(answer: string): boolean {
    if (!this.lastToolResult || this.lastToolResult.success) return false;
    const normalized = answer.trim();
    const error = this.lastToolResult.error?.trim() ?? '';
    const content = this.lastToolResult.content.trim();
    if (normalized === error || normalized === content || normalized === `Error: ${error}`) return true;
    if (!normalized.startsWith('{')) return false;
    const parsed = parseJsonRecord(normalized);
    return parsed?.success === false || typeof parsed?.error === 'string';
  }
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
