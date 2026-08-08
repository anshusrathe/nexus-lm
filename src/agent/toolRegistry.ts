import type { ToolDefinition, ToolCall, ToolResult, ToolCategory, AgentDependencies } from './types';

export type { ToolDefinition } from './types';

export interface ToolHandler {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, deps: AgentDependencies) => Promise<string>;
}

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 8000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyError(error: string): 'transient' | 'permanent' | 'unknown' {
  const lower = error.toLowerCase();

  const transientPatterns = [
    'timeout', 'etimedout', 'econnreset', 'econnrefused', 'socket hang up',
    'fetch failed', 'network', 'request failed',
    '429', 'rate limit', 'too many requests', 'throttl',
    '503', 'service unavailable', '502', 'bad gateway', '500', 'internal server error',
  ];
  for (const pattern of transientPatterns) {
    if (lower.includes(pattern)) return 'transient';
  }

  const permanentPatterns = [
    '401', '403', 'unauthorized', 'forbidden', 'permission denied',
    'not found', 'does not exist', 'no such file',
    'invalid api key', 'authentication',
  ];
  for (const pattern of permanentPatterns) {
    if (lower.includes(pattern)) return 'permanent';
  }

  return 'unknown';
}

export class ToolRegistry {
  private handlers: Map<string, ToolHandler> = new Map();

  register(handler: ToolHandler): void {
    this.handlers.set(handler.definition.name, handler);
  }

  registerBatch(handlers: ToolHandler[]): void {
    for (const handler of handlers) {
      this.handlers.set(handler.definition.name, handler);
    }
  }

  get(name: string): ToolHandler | null {
    return this.handlers.get(name) ?? null;
  }

  getAll(category?: ToolCategory): ToolHandler[] {
    const all = Array.from(this.handlers.values());
    if (category) {
      return all.filter((h) => h.definition.category === category);
    }
    return all;
  }

  getDefinitions(category?: ToolCategory): ToolDefinition[] {
    return this.getAll(category).map((h) => h.definition);
  }

  async execute(toolCall: ToolCall, deps: AgentDependencies): Promise<ToolResult> {
    let lastResult: ToolResult | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const errorType = classifyError(lastResult?.error ?? '');
        if (errorType !== 'transient') {
          return lastResult!;
        }

        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
        const jitter = Math.random() * 0.5 * delay;
        await sleep(delay + jitter);
      }

      lastResult = await this.executeOnce(toolCall, deps);

      if (lastResult.success) {
        if (attempt > 0) {
          lastResult.retryCount = attempt;
        }
        return lastResult;
      }
    }

    return lastResult!;
  }

  private async executeOnce(toolCall: ToolCall, deps: AgentDependencies): Promise<ToolResult> {
    const handler = this.handlers.get(toolCall.name);
    if (!handler) {
      return {
        toolCallId: toolCall.id,
        success: false,
        content: '',
        error: `Tool "${toolCall.name}" not found in registry`,
      };
    }

    if (handler.definition.needsApproval) {
      deps.onEvent({
        type: 'tool_call',
        data: { toolName: toolCall.name, args: toolCall.arguments },
        timestamp: Date.now(),
      });
    }

    try {
      const content = await handler.execute(toolCall.arguments, deps);
      const structuredFailure = getStructuredFailure(content);
      if (structuredFailure) {
        return {
          toolCallId: toolCall.id,
          success: false,
          content,
          error: structuredFailure,
        };
      }
      return {
        toolCallId: toolCall.id,
        success: true,
        content,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        toolCallId: toolCall.id,
        success: false,
        content: '',
        error: message,
      };
    }
  }

  removeTool(name: string): boolean {
    return this.handlers.delete(name);
  }

  clear(): void {
    this.handlers.clear();
  }
}

function getStructuredFailure(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return null;

  try {
    const value = JSON.parse(trimmed) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.success === false || typeof record.error === 'string') {
      return String(record.error || record.message || 'Tool reported an unsuccessful result');
    }
  } catch {
    // Plain-text tool output is valid and does not use the structured contract.
  }
  return null;
}
