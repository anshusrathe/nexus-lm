import type { ToolDefinition, ToolCall, ToolResult, ToolCategory, AgentDependencies } from './types';

export type { ToolDefinition } from './types';

export interface ToolHandler {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, deps: AgentDependencies) => Promise<string>;
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
