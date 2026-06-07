import { MCPService, MCPTool } from './mcpService';

export interface MCPToolCall {
    serverId: string;
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
}

export interface MCPToolResult {
    toolName: string;
    serverName: string;
    success: boolean;
    content: string;
    error?: string;
}

/**
 * Sanitize server name to be compatible with AI model tool naming requirements.
 * Replaces spaces and special characters with underscores, then collapses
 * consecutive underscores and trims leading/trailing underscores.
 * This prevents the separator `__` from appearing inside the sanitized name,
 * which would break the `split('__')` parsing in executeToolCall.
 * @param serverName The original server name (may contain spaces/parens/etc.)
 * @returns Sanitized server name safe for use in tool names
 */
export function sanitizeServerName(serverName: string): string {
    return serverName
        .replace(/[^a-zA-Z0-9]+/g, '_')  // replace runs of non-alphanumeric chars with a single _
        .replace(/^_+|_+$/g, '');          // trim leading/trailing underscores
}

/**
 * MCP Tool Calling Service
 * Handles formatting tools for AI models and executing tool calls
 */
export class MCPToolCallingService {
    constructor(private mcpService: MCPService) {}

    /**
     * Deduplication registry: tracks tool calls that have already been executed
     * in the current query session. Key = "<sanitizedServer>__<toolName>__<argsHash>"
     * Value = the result, so duplicate calls return the cached result instantly.
     *
     * Call resetSession() at the start of each new MCP query to clear the registry.
     */
    private executedToolRegistry: Map<string, MCPToolResult> = new Map();

    /** Call this at the start of each new MCP query to clear dedup state. */
    resetSession(): void {
        this.executedToolRegistry.clear();
    }

    /** Stable hash of tool arguments for deduplication key. */
    private hashArgs(args: Record<string, unknown>): string {
        try {
            return JSON.stringify(args, Object.keys(args || {}).sort());
        } catch {
            return String(args);
        }
    }
    /**
     * Format MCP tools for AI model consumption (OpenAI/Anthropic function calling format)
     * @param serverIds Array of server IDs to get tools from
     * @param selectedTools Optional map of serverId -> tool names to filter which tools to include
     */
    formatToolsForAI(serverIds: string[], selectedTools?: Map<string, string[]>): Record<string, unknown>[] {
        const tools: Record<string, unknown>[] = [];

        for (const serverId of serverIds) {
            const serverTools = this.mcpService.getServerTools(serverId);
            const serverConfig = this.mcpService.getConnectedServerById(serverId);
            
            if (!serverConfig) continue;

            // Filter tools if selectedTools is provided
            const selectedToolNames = selectedTools?.get(serverId) || [];
            const toolsToFormat = selectedToolNames.length > 0
                ? serverTools.filter(t => selectedToolNames.includes(t.name))
                : serverTools;

            for (const tool of toolsToFormat) {
                // Sanitize server name to avoid whitespace in tool names
                const sanitizedServerName = sanitizeServerName(serverConfig.name);
                
                tools.push({
                    type: 'function',
                    function: {
                        name: `${sanitizedServerName}__${tool.name}`,
                        description: tool.description || `Tool from ${serverConfig.name}`,
                        parameters: tool.inputSchema || {
                            type: 'object',
                            properties: {},
                            required: []
                        }
                    }
                });
            }
        }

        return tools;
    }

    /**
     * Parse tool call from AI response and execute it.
     * Deduplication: if the exact same tool+args combination has already been
     * executed in this session, the cached result is returned immediately without
     * re-invoking the MCP server. This prevents duplicate executions when a
     * fallback model re-requests a tool that already ran.
     */
    async executeToolCall(toolCall: Record<string, SafeAny>): Promise<MCPToolResult> {
        try {
            // Parse the tool name to extract server and tool.
            // Format: <sanitizedServerName>__<toolName>
            const fullToolName = (toolCall.function?.name as string | undefined) || (toolCall.name as string | undefined) || '';
            const separatorIdx = fullToolName.indexOf('__');
            
            if (separatorIdx === -1) {
                throw new Error(`Invalid tool name format: ${fullToolName}`);
            }

            const sanitizedServerName = fullToolName.substring(0, separatorIdx);
            const toolName = fullToolName.substring(separatorIdx + 2);

            // Parse arguments early so we can build the dedup key
            const args = typeof toolCall.function?.arguments === 'string'
                ? JSON.parse(toolCall.function.arguments)
                : toolCall.function?.arguments || toolCall.arguments || {};

            // ── Deduplication check ──────────────────────────────────────────
            const dedupKey = `${sanitizedServerName}__${toolName}__${this.hashArgs(args)}`;
            const cached = this.executedToolRegistry.get(dedupKey);
            if (cached) {
                                return cached;
            }
            
            // Find the server ID by matching sanitized name
            const connectedServers = this.mcpService.getConnectedServers();
            const server = connectedServers.find(s => {
                return sanitizeServerName(s.name) === sanitizedServerName;
            });
            
            if (!server) {
                throw new Error(`Server ${sanitizedServerName} not found or not connected`);
            }

            
            // Execute the tool
            const result = await this.mcpService.invokeTool(server.id, toolName, args) as Record<string, unknown>;

            // Format the result
            let content = '';
            if (result.content && Array.isArray(result.content)) {
                for (const item of result.content as Record<string, unknown>[]) {
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

            const toolResult: MCPToolResult = {
                toolName,
                serverName: server.name,
                success: !result.isError,
                content: content.trim() || JSON.stringify(result),
                error: result.isError ? content : undefined
            };

            // Store in dedup registry for this session
            this.executedToolRegistry.set(dedupKey, toolResult);

            return toolResult;

        } catch (error) {
            const fullToolName = (toolCall.function?.name as string | undefined) || (toolCall.name as string | undefined) || 'unknown';
            return {
                toolName: fullToolName,
                serverName: 'unknown',
                success: false,
                content: '',
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Format tool results for AI model
     */
    formatToolResultForAI(toolCallId: string, result: MCPToolResult): Record<string, unknown> {
        return {
            tool_call_id: toolCallId,
            role: 'tool',
            name: `${sanitizeServerName(result.serverName)}__${result.toolName}`,
            content: result.success 
                ? result.content 
                : `Error: ${result.error || 'Tool execution failed'}`
        };
    }

    /**
     * Get a formatted description of available tools for context
     */
    getToolsDescription(serverIds: string[]): string {
        let description = '# Available MCP Tools\n\n';
        description += 'You have access to the following tools. To use them, make function calls with the appropriate parameters.\n\n';

        for (const serverId of serverIds) {
            const serverTools = this.mcpService.getServerTools(serverId);
            const serverName = this.mcpService.getServerName(serverId);
            
            if (!serverName || serverTools.length === 0) continue;

            description += `## ${serverName}\n\n`;

            for (const tool of serverTools) {
                description += `### ${tool.name}\n`;
                description += `${tool.description || 'No description available'}\n\n`;
                
                if (tool.inputSchema?.properties) {
                    description += '**Parameters:**\n';
                    for (const [param, schema] of Object.entries(tool.inputSchema.properties as Record<string, unknown>)) {
                        const paramSchema = schema as Record<string, unknown>;
                        const required = (tool.inputSchema.required as string[] | undefined)?.includes(param) ? ' (required)' : '';
                        description += `- \`${param}\`${required}: ${paramSchema.description || paramSchema.type || 'any'}\n`;
                    }
                    description += '\n';
                }
            }
        }

        return description;
    }
}
