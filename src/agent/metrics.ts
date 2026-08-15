export interface AgentMetricsData {
  sessionsRun: number;
  totalSteps: number;
  failedSteps: number;
  successfulSessions: number;
  toolCallCounts: Record<string, number>;
  toolFailureCounts: Record<string, number>;
  startTime: number;
}

export class AgentMetrics {
  private data: AgentMetricsData;
  private static instance: AgentMetrics;

  private constructor() {
    this.data = this.createFresh();
  }

  static getInstance(): AgentMetrics {
    if (!AgentMetrics.instance) {
      AgentMetrics.instance = new AgentMetrics();
    }
    return AgentMetrics.instance;
  }

  private createFresh(): AgentMetricsData {
    return {
      sessionsRun: 0,
      totalSteps: 0,
      failedSteps: 0,
      successfulSessions: 0,
      toolCallCounts: {},
      toolFailureCounts: {},
      startTime: Date.now(),
    };
  }

  recordSessionStart(): void {
    this.data.sessionsRun++;
  }

  recordSessionComplete(steps: number, failedSteps: number): void {
    this.data.totalSteps += steps;
    this.data.failedSteps += failedSteps;
    if (failedSteps === 0) {
      this.data.successfulSessions++;
    }
  }

  recordToolCall(toolName: string, success: boolean): void {
    this.data.toolCallCounts[toolName] = (this.data.toolCallCounts[toolName] || 0) + 1;
    if (!success) {
      this.data.toolFailureCounts[toolName] = (this.data.toolFailureCounts[toolName] || 0) + 1;
    }
  }
}
