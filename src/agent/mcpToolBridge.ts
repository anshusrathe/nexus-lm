import type { ToolHandler, ToolDefinition } from './toolRegistry';
import type { AgentDependencies, ToolCategory } from './types';
import { sanitizeServerName } from '../mcp/mcpToolCalling';
import type { MCPService } from '../mcp/mcpService';

function convertMCPSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
  return inputSchema && typeof inputSchema === 'object'
    ? inputSchema
    : { type: 'object', properties: {}, required: [] };
}

function buildMCPToolHandler(
  serverId: string,
  serverName: string,
  toolName: string,
  description: string,
  inputSchema: Record<string, unknown>,
  mcpService: MCPService
): ToolHandler {
  const prefixedName = `${sanitizeServerName(serverName)}__${toolName}`;
  const definition: ToolDefinition = {
    name: prefixedName,
    description: description || `MCP tool: ${toolName} (${serverName})`,
    category: 'mcp',
    inputSchema: convertMCPSchema(inputSchema),
    needsApproval: true,
  };

  return {
    definition,
    execute: async (args: Record<string, unknown>, _deps: AgentDependencies): Promise<string> => {
      const rawResult = await mcpService.invokeTool(serverId, toolName, args) as Record<string, unknown>;
      let content = '';
      if (rawResult.content && Array.isArray(rawResult.content)) {
        for (const item of rawResult.content as Record<string, unknown>[]) {
          if (item.type === 'text') {
            content += (item.text as string || '') + '\n';
          } else if (item.type === 'image') {
            content += `[Image: ${item.mimeType as string | undefined}]\n`;
          } else if (item.type === 'resource') {
            const resource = item.resource as Record<string, unknown> | undefined;
            content += `[Resource: ${resource?.uri as string | undefined}]\n`;
          }
        }
      }
      return (content.trim() || JSON.stringify(rawResult));
    },
  };
}

export function registerMCPTools(
  registry: { registerBatch: (handlers: ToolHandler[]) => void; getAll: (category?: ToolCategory) => ToolHandler[] },
  mcpService: MCPService
): void {
  const connectedServers = mcpService.getConnectedServers() as Array<{ id: string; name: string }>;
  const existingMCP = new Set(
    (registry.getAll('mcp') as ToolHandler[]).map((h: ToolHandler) => h.definition.name)
  );

  const newHandlers: ToolHandler[] = [];
  for (const server of connectedServers) {
    const serverTools = mcpService.getServerTools(server.id) as Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
    for (const tool of serverTools) {
      const prefixed = `${sanitizeServerName(server.name)}__${tool.name}`;
      if (existingMCP.has(prefixed)) continue;
      newHandlers.push(
        buildMCPToolHandler(server.id, server.name, tool.name, tool.description ?? '', tool.inputSchema ?? {}, mcpService)
      );
    }
  }

  if (newHandlers.length > 0) {
    registry.registerBatch(newHandlers);
  }
}
