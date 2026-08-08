import type { AgentDependencies, ToolCall, ToolDefinition } from './types';
import type {
  SubAgentType, SubAgentSessionStatus, SubAgentExecutionState,
  SubAgentResult, SubAgentStep, SubAgentConfig,
} from './subAgentTypes';
import { SUB_AGENT_CONFIGS } from './subAgentTypes';
import { ToolRegistry } from './toolRegistry';
import { SafetyLayer } from './safetyLayer';
import { AgentOrchestrator, SUBAGENT_HARD_SAFETY_STEP_CAP } from './agentOrchestrator';

export class SubAgentSession {
  readonly id: string;
  readonly parentSessionId: string;
  readonly agentType: SubAgentType;
  readonly config: SubAgentConfig;
  readonly createdAt: number;

  status: SubAgentSessionStatus = 'idle';
  executionState: SubAgentExecutionState = 'starting';
  stepNumber: number = 0;
  result: SubAgentResult | null = null;
  error: string | null = null;
  startedAt: number = 0;
  completedAt: number = 0;

  readonly steps: SubAgentStep[] = [];
  readonly messages: Array<Record<string, unknown>> = [];
  readonly abortController: AbortController;
  readonly onStep: ((step: SubAgentStep) => void) | null;

  private orchestrator: AgentOrchestrator | null = null;
  private completionResolve: ((result: SubAgentResult) => void) | null = null;

  constructor(
    id: string,
    parentSessionId: string,
    agentType: SubAgentType,
    onStep?: (step: SubAgentStep) => void,
  ) {
    this.id = id;
    this.parentSessionId = parentSessionId;
    this.agentType = agentType;
    this.config = SUB_AGENT_CONFIGS[agentType];
    this.createdAt = Date.now();
    this.abortController = new AbortController();
    this.onStep = onStep ?? null;
  }

  get isRunning(): boolean {
    return this.status === 'running';
  }

  get isDone(): boolean {
    return this.status === 'completed' || this.status === 'failed' || this.status === 'cancelled';
  }

  get elapsedMs(): number {
    if (!this.startedAt) return 0;
    const end = this.completedAt || Date.now();
    return end - this.startedAt;
  }

  addStep(thought: string, toolName: string | null, toolArgs: Record<string, unknown> | null, status: string): void {
    this.stepNumber++;
    const step: SubAgentStep = {
      stepNumber: this.stepNumber,
      thought,
      toolName,
      toolArgs,
      status,
      timestamp: Date.now(),
    };
    this.steps.push(step);
    if (this.onStep) {
      this.onStep(step);
    }
  }

  waitForCompletion(): Promise<SubAgentResult> {
    if (this.isDone && this.result) {
      return Promise.resolve(this.result);
    }
    return new Promise<SubAgentResult>((resolve) => {
      this.completionResolve = resolve;
    });
  }

  setResult(result: SubAgentResult): void {
    this.result = result;
    this.completedAt = Date.now();
    this.status = result.success ? 'completed' : 'failed';
    this.executionState = 'done';
    if (this.completionResolve) {
      this.completionResolve(result);
      this.completionResolve = null;
    }
  }

  setError(error: string): void {
    this.error = error;
    this.completedAt = Date.now();
    this.status = 'failed';
    this.executionState = 'error';
    this.result = {
      success: false,
      summary: `Sub-agent ${this.agentType} failed: ${error}`,
      error,
      stepsTaken: this.steps.length,
      artifacts: [],
      sessionId: this.id,
    };
    if (this.completionResolve) {
      this.completionResolve(this.result);
      this.completionResolve = null;
    }
  }

  cancel(): void {
    if (this.isDone) return;
    this.abortController.abort();
    this.status = 'cancelled';
    this.executionState = 'error';
    this.completedAt = Date.now();
    if (this.orchestrator) {
      this.orchestrator.abort();
    }
    this.result = {
      success: false,
      summary: `Sub-agent ${this.agentType} was cancelled.`,
      error: 'Cancelled by user.',
      stepsTaken: this.steps.length,
      artifacts: [],
      sessionId: this.id,
    };
    if (this.completionResolve) {
      this.completionResolve(this.result);
      this.completionResolve = null;
    }
  }

  async execute(
    task: string,
    contextSummary: string,
    mainRegistry: ToolRegistry,
    mainDeps: AgentDependencies,
    providerCall: (messages: Array<Record<string, unknown>>, onToken?: (chunk: string) => void, onThinking?: (thinking: string) => void, tools?: ToolDefinition[]) => Promise<{
      content?: string;
      toolCalls?: ToolCall[];
      finishReason?: string;
      thinking?: string;
    }>,
  ): Promise<SubAgentResult> {
    if (this.isRunning || this.isDone) {
      return this.result ?? {
        success: false,
        summary: 'Session already completed or running.',
        error: 'Session already completed or running.',
        stepsTaken: 0,
        artifacts: [],
        sessionId: this.id,
      };
    }

    this.status = 'running';
    this.startedAt = Date.now();
    this.executionState = 'thinking';

    const subRegistry = this.buildFilteredRegistry(mainRegistry);
    const subSafety = new SafetyLayer(mainDeps.app, mainDeps.settings.denyList, 'never');

    const isolatedDeps: AgentDependencies = {
      ...mainDeps,
      onEvent: (event) => {
        if (event.type === 'step') {
          const thought = String(event.data.thought ?? '');
          const toolName = event.data.toolName ? String(event.data.toolName) : null;
          const toolArgs = event.data.toolArgs && typeof event.data.toolArgs === 'object'
            ? event.data.toolArgs as Record<string, unknown>
            : null;
          const status = String(event.data.status ?? 'running');
          this.addStep(thought, toolName, toolArgs, status);
        }
      },
    };

    this.orchestrator = new AgentOrchestrator(
      subRegistry,
      subSafety,
      null,
      isolatedDeps,
      {
        maxSteps: SUBAGENT_HARD_SAFETY_STEP_CAP,
        approvalMode: 'never',
        denyList: mainDeps.settings.denyList,
        enableCLI: false,
        enablePluginDiscovery: false,
        enableMCP: false,
        enableSkills: false,
        enabledSkills: [],
        enableAutoModelChain: false,
        canDelegate: false,
      }
    );

    if (this.abortController.signal.aborted) {
      this.setError('Aborted before execution started.');
      return this.result!;
    }

    try {
      const now = new Date();
      const timeStr = now.toLocaleString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const timeBlock = `Current time: ${timeStr} (${tz})`;

      const enrichedTask = `${timeBlock}\n\n${this.config.promptPrefix}\n\nContext:\n${contextSummary}\n\nTask: ${task}\n\nIMPORTANT: Return your findings in a concise summary at the end.`;

      const result = await this.orchestrator.runAgent(enrichedTask, providerCall);
      const steps = this.steps.length;

      const exceededCap = result.includes('exceeded maximum step count') ||
                          result.includes('reached step limit') ||
                          result.includes('reached hard safety limit');
      const hasPartialWork = steps > 0;

      const subResult: SubAgentResult = {
        success: !exceededCap || hasPartialWork,
        summary: result,
        stepsTaken: steps,
        artifacts: [],
        sessionId: this.id,
        details: exceededCap
          ? `Sub-agent hit step limit after ${steps} steps. Partial results included.`
          : undefined,
      };

      this.setResult(subResult);
      return subResult;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (this.abortController.signal.aborted) {
        this.setError('Cancelled.');
        return this.result!;
      }
      this.setError(msg);
      return this.result!;
    }
  }

  private buildFilteredRegistry(mainRegistry: ToolRegistry): ToolRegistry {
    const subRegistry = new ToolRegistry();
    const allDefs = mainRegistry.getDefinitions();

    for (const def of allDefs) {
      if (this.config.toolDenyList.includes(def.name)) continue;
      if (def.name.startsWith('delegate_to_')) continue;

      if (this.config.toolAllowList.length > 0) {
        const isMCPForResearcher = this.agentType === 'researcher' && def.category === 'mcp';
        if (!isMCPForResearcher && !this.config.toolAllowList.includes(def.name)) continue;
      }

      const handler = mainRegistry.get(def.name);
      if (handler) {
        subRegistry.register(handler);
      }
    }

    return subRegistry;
  }
}
