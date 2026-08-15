import type { ToolDefinition, ToolCall, AgentDependencies } from './types';
import { ToolRegistry } from './toolRegistry';
import { SubAgentType, SubAgentResult } from './subAgentTypes';
import { SubAgentSession } from './subAgentSession';
import type { SubAgentStep } from './subAgentTypes';
interface QueuedJob {
  id: string;
  type: SubAgentType;
  task: string;
  contextSummary: string;
  providerCall: ProviderCall;
  resolve: (result: SubAgentResult) => void;
  reject: (error: unknown) => void;
  startedAt: number;
}

type ProviderCall = (messages: Array<Record<string, unknown>>, onToken?: (chunk: string) => void, onThinking?: (thinking: string) => void, tools?: ToolDefinition[]) => Promise<{
  content?: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  thinking?: string;
}>;

export class SubAgentManager {
  private mainRegistry: ToolRegistry;
  private mainDeps: AgentDependencies;
  private activeSessions: Map<string, SubAgentSession> = new Map();
  private jobQueue: QueuedJob[] = [];
  private activeCount: number = 0;
  private maxConcurrent: number = 2;

  constructor(
    mainRegistry: ToolRegistry,
    mainDeps: AgentDependencies,
    maxConcurrent: number = 2,
  ) {
    this.mainRegistry = mainRegistry;
    this.mainDeps = mainDeps;
    this.maxConcurrent = maxConcurrent;
  }

  updateMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
  }

  spawnJob(
    type: SubAgentType,
    task: string,
    contextSummary: string,
    providerCall: ProviderCall,
    onStep?: (step: SubAgentStep) => void,
    onStarted?: (session: SubAgentSession) => void,
  ): { jobId: string; promise: Promise<SubAgentResult> } {
    const sessionId = `sub_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const session = new SubAgentSession(sessionId, 'parent', type, onStep);

    const promise = new Promise<SubAgentResult>((resolve, reject) => {
      const job: QueuedJob = {
        id: sessionId,
        type,
        task,
        contextSummary,
        providerCall,
        resolve,
        reject,
        startedAt: Date.now(),
      };

      this.activeSessions.set(sessionId, session);
      this.jobQueue.push(job);
      void this.processQueue();

      if (onStarted) {
        onStarted(session);
      }
    });

    return { jobId: sessionId, promise };
  }

  async awaitJob(jobId: string): Promise<SubAgentResult> {
    const session = this.activeSessions.get(jobId);
    if (!session) {
      return {
        success: false,
        summary: `Sub-agent job "${jobId}" not found.`,
        error: `No active or completed job with id "${jobId}"`,
        stepsTaken: 0,
        artifacts: [],
        sessionId: jobId,
      };
    }

    // Use the promise-based completion mechanism instead of polling
    const result = await session.waitForCompletion();
    return result;
  }

  getJobStatus(jobId: string): {
    status: string;
    stepsSoFar: number;
    elapsedMs: number;
    executionState: string;
    agentType: SubAgentType | null;
  } {
    const session = this.activeSessions.get(jobId);
    if (!session) {
      return { status: 'not_found', stepsSoFar: 0, elapsedMs: 0, executionState: 'unknown', agentType: null };
    }
    return {
      status: session.status,
      stepsSoFar: session.steps.length,
      elapsedMs: session.elapsedMs,
      executionState: session.executionState,
      agentType: session.agentType,
    };
  }

  getSession(jobId: string): SubAgentSession | null {
    return this.activeSessions.get(jobId) ?? null;
  }

  getActiveSessions(): SubAgentSession[] {
    return Array.from(this.activeSessions.values()).filter(s => s.isRunning);
  }

  cancelJob(jobId: string): boolean {
    const session = this.activeSessions.get(jobId);
    if (!session) return false;
    session.cancel();
    this.jobQueue = this.jobQueue.filter(j => j.id !== jobId);
    this.activeCount = Math.max(0, this.activeCount - 1);
    void this.processQueue();
    return true;
  }

  cancelAll(): void {
    for (const session of this.activeSessions.values()) {
      session.cancel();
    }
    this.jobQueue = [];
    this.activeCount = 0;
  }

  getDelegateToolDefinitions(): ToolDefinition[] {
    const agentTypes: SubAgentType[] = ['explorer', 'researcher', 'auditor', 'writer'];
    const descriptions: Record<SubAgentType, string> = {
      explorer: 'Delegate vault exploration to this sub-agent. It searches notes, explores code structure, finds content by keywords, and gathers context across files. Read-only — cannot modify files.',
      researcher: 'Delegate web research to this sub-agent. It searches the web for current information, fetches API docs, verifies facts, and gathers external references. Has web search plus vault read access.',
      auditor: 'Delegate review and quality checks to this sub-agent. It reviews code, analyzes diffs, assesses quality, and detects bugs. Read-only — returns structured feedback with specific findings.',
      writer: 'Delegate file creation and editing to this sub-agent. It writes notes, makes bulk edits, generates structured content, and creates templates. Has write access.',
    };

    return agentTypes.map(type => ({
      name: `delegate_to_${type}`,
      description: descriptions[type],
      category: 'plugin' as const,
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The specific task for the sub-agent to perform. Be detailed and specific.',
          },
          context: {
            type: 'string',
            description: 'Relevant context from the main conversation that the sub-agent needs to know',
          },
          expected_deliverable: {
            type: 'string',
            description: 'What the sub-agent should produce: a summary, a note, reviewed output, etc.',
          },
        },
        required: ['task'],
      },
      needsApproval: false,
    }));
  }

  private async processQueue(): Promise<void> {
    while (this.activeCount < this.maxConcurrent && this.jobQueue.length > 0) {
      const job = this.jobQueue.shift()!;
      this.activeCount++;

      const session = this.activeSessions.get(job.id);
      if (!session || session.isDone) {
        this.activeCount--;
        continue;
      }

      session.execute(
        job.task,
        job.contextSummary,
        this.mainRegistry,
        this.mainDeps,
        job.providerCall,
      )
        .then((result) => {
          job.resolve(result);
        })
        .catch((error) => {
          job.reject(error);
        })
        .finally(() => {
          this.activeCount = Math.max(0, this.activeCount - 1);
          void this.processQueue();
        });
    }
  }
}
