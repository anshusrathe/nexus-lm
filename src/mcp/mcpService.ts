import { Notice, requestUrl, Platform } from 'obsidian';


const child_process = (!Platform.isMobile && (window as unknown as any).require) ? (window as unknown as any).require('child_process') : null;
const spawn = child_process?.spawn;
type ChildProcess = import('child_process').ChildProcess; 

function spawnMCPProcess(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv
): ChildProcess {
    
    
    
    function quoteCmdArg(arg: string): string {
        
        arg = arg.replace(/(\\+)(?=")/g, '$1$1');
        arg = arg.replace(/(\\+)$/g, '$1$1');
        
        arg = arg.replace(/"/g, '\\"');
        return `"${arg}"`;
    }

    const isWindows = process.platform === 'win32';

    if (isWindows) {
        
        
        const tokens = [command, ...args].map(t =>
            (t.includes(' ') || t.includes('"') || t.includes('&') || t.includes('|') || t.includes('>') || t.includes('<'))
                ? quoteCmdArg(t)
                : t
        );
        const cmdString = tokens.join(' ');

        
        
        
        
        
        const shell = process.env.ComSpec || 'cmd.exe';
        return spawn(shell, ['/d', '/s', '/c', `"${cmdString}"`], {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            windowsVerbatimArguments: true,
        });
    } else {
        
        
        function quoteShArg(arg: string): string {
            return `'${arg.replace(/'/g, "'\\''")}'`;
        }
        const tokens = [command, ...args].map(t =>
            t.includes(' ') || t.includes("'") || t.includes('"') ? quoteShArg(t) : t
        );
        return spawn('sh', ['-c', tokens.join(' ')], {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
        });
    }
}

export interface MCPServerConfig {
    id: string;
    name: string;
    transport: 'stdio' | 'sse';
    command?: string;
    args?: string[];
    streamUrl?: string; 
    url?: string;
    apiKey?: string;
    env?: Record<string, string>;
    disabled: boolean;
}

export interface MCPTool {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
}

export interface MCPResource {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}

interface MCPServerConnection {
    config: MCPServerConfig;
    process?: ChildProcess; 
    eventSource?: unknown; 
    tools: MCPTool[];
    resources: MCPResource[];
    connected: boolean;
    messageId: number;
    pendingRequests: Map<number, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
    }>;
    buffer: string;
    
    
    exitError?: Error;
}

export class MCPService {
    private servers: Map<string, MCPServerConnection> = new Map();
    private initializationPromises: Map<string, Promise<void>> = new Map();

    /**
     * Connect to an MCP server
     */
    async connectServer(config: MCPServerConfig): Promise<void> {
        if (this.servers.has(config.id)) {
                        return;
        }

        
        const existingPromise = this.initializationPromises.get(config.id);
        if (existingPromise) {
            return existingPromise;
        }

        const initPromise = this._connectServerInternal(config);
        this.initializationPromises.set(config.id, initPromise);

        try {
            await initPromise;
        } finally {
            this.initializationPromises.delete(config.id);
        }
    }

    private async _connectServerInternal(config: MCPServerConfig): Promise<void> {
                
        if (config.transport === 'stdio') {
            return this._connectStdio(config);
        } else if (config.transport === 'sse') {
            return this._connectSSE(config);
        } else {
            throw new Error(`Unsupported transport type: ${config.transport}`);
        }
    }

    /**
     * Connect via stdio (spawn process)
     */
    private async _connectStdio(config: MCPServerConfig): Promise<void> {
        const command = config.command;
        if (!command) {
            throw new Error('Command is required for stdio transport');
        }

        
        if (config.streamUrl) {
            return this._connectStdioWithStreamUrl(config, command);
        }

        
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (err?: Error) => {
                if (settled) return;
                settled = true;
                if (err) reject(err);
                else resolve();
            };

            try {
                
                
                
                
                const displayCmd = [command, ...(config.args || [])].map(a =>
                    a.includes(' ') ? `"${a}"` : a
                ).join(' ');
                
                const childProcess: ChildProcess = spawnMCPProcess(
                    command,
                    config.args || [],
                    { ...process.env, ...config.env }
                );

                const connection: MCPServerConnection = {
                    config,
                    process: childProcess,
                    tools: [],
                    resources: [],
                    connected: false, 
                    messageId: 0,
                    pendingRequests: new Map(),
                    buffer: '',
                    exitError: undefined,
                };

                this.servers.set(config.id, connection);

                
                let stderrAccum = '';

                childProcess.stdout?.on('data', (data: Buffer) => {
                                        this.handleServerMessage(config.id, data.toString());
                });

                childProcess.stderr?.on('data', (data: Buffer) => {
                    const text = data.toString();
                    stderrAccum += text;
                                    });

                childProcess.on('exit', (code: number | null) => {
                                        connection.connected = false;
                    this.servers.delete(config.id);

                    
                    const hint = stderrAccum.trim().split('\n').filter(l => !l.startsWith('npm warn')).slice(-3).join(' | ');
                    const exitError = new Error(
                        `MCP server "${config.name}" exited (code ${code})${hint ? ': ' + hint : ''}`
                    );

                    
                    
                    
                    connection.exitError = exitError;

                    
                    for (const pending of connection.pendingRequests.values()) {
                        pending.reject(exitError);
                    }
                    connection.pendingRequests.clear();

                    
                    settle(exitError);
                });
                childProcess.on('error', (error: Error) => {
                                        connection.connected = false;
                    for (const pending of connection.pendingRequests.values()) {
                        pending.reject(error);
                    }
                    connection.pendingRequests.clear();
                    settle(error);
                });

                
                
                
                
                this.initializeConnection(config.id)
                    .then(() => {
                        connection.connected = true; 
                                                settle();
                    })
                    .catch((error) => {
                        connection.connected = false;
                        settle(error);
                    });

            } catch (error) {
                                reject(error);
            }
        });
    }

    /**
     * Spawn a stdio process that also exposes a local HTTP/SSE endpoint.
     * Polls the endpoint until it responds, then initializes via HTTP.
     */
    private async _connectStdioWithStreamUrl(config: MCPServerConfig, command: string): Promise<void> {
        
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (err?: Error) => {
                if (settled) return;
                settled = true;
                if (err) reject(err);
                else resolve();
            };

            try {
                const childProcess: ChildProcess = spawnMCPProcess(
                    command,
                    config.args || [],
                    { ...process.env, ...config.env }
                );

                
                let stderrAccum = '';

                childProcess.stdout?.on('data', (data: Buffer) => {
                                    });

                childProcess.stderr?.on('data', (data: Buffer) => {
                    const text = data.toString();
                    stderrAccum += text;
                                    });

                childProcess.on('error', (error: Error) => {
                                        settle(error);
                });

                childProcess.on('exit', (code: number | null) => {
                                        const conn = this.servers.get(config.id);
                    if (conn) {
                        conn.connected = false;
                        
                        const hint = stderrAccum.trim().split('\n').filter(l => !l.startsWith('npm warn')).slice(-3).join(' | ');
                        const exitError = new Error(
                            `MCP server "${config.name}" exited (code ${code})${hint ? ': ' + hint : ''}`
                        );
                        for (const pending of conn.pendingRequests.values()) {
                            pending.reject(exitError);
                        }
                        conn.pendingRequests.clear();
                        this.servers.delete(config.id);
                    }
                    if (!settled) {
                        const hint = stderrAccum.trim().split('\n').filter(l => !l.startsWith('npm warn')).slice(-3).join(' | ');
                        settle(new Error(`Process exited (code ${code}) before HTTP endpoint was ready. stderr: ${hint}`));
                    }
                });

                
                const connection: MCPServerConnection = {
                    config,
                    process: childProcess,
                    tools: [],
                    resources: [],
                    connected: false, 
                    messageId: 0,
                    pendingRequests: new Map(),
                    buffer: ''
                };
                this.servers.set(config.id, connection);

                
                this._pollStreamUrl(config.streamUrl!, 15000, 400)
                    .then(() => {
                        if (settled) return Promise.resolve(); 
                        
                        return this.initializeConnection(config.id);
                    })
                    .then(() => {
                        if (!settled) {
                            connection.connected = true; 
                                                        settle();
                        }
                    })
                    .catch((err: Error) => {
                        connection.connected = false;
                        settle(err);
                    });

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Poll a URL with HEAD/GET requests until it returns any HTTP response
     * (even 4xx counts — the server is up). Rejects after `timeoutMs`.
     */
    private async _pollStreamUrl(url: string, timeoutMs: number, intervalMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        let lastError = '';

        while (Date.now() < deadline) {
            try {
                const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2000) });
                
                                return;
            } catch (e: unknown) {
                lastError = e instanceof Error ? e.message : String(e);
                
            }
            await new Promise(r => setTimeout(r, intervalMs));
        }

        throw new Error(`streamUrl ${url} did not become reachable within ${timeoutMs}ms. Last error: ${lastError}`);
    }

    /**
     * Connect via SSE (HTTP/HTTPS)
     */
    private async _connectSSE(config: MCPServerConfig): Promise<void> {
        if (!config.url) {
            throw new Error('URL is required for SSE transport');
        }

        return new Promise((resolve, reject) => {
            try {
                
                
                const connection: MCPServerConnection = {
                    config,
                    tools: [],
                    resources: [],
                    connected: true, 
                    messageId: 0,
                    pendingRequests: new Map(),
                    buffer: ''
                };

                this.servers.set(config.id, connection);

                
                this.initializeConnection(config.id)
                    .then(() => {
                                                resolve();
                    })
                    .catch((error) => {
                        
                        connection.connected = false;
                        reject(error);
                    });

            } catch (error) {
                                reject(error);
            }
        });
    }

    /**
     * Handle incoming messages from MCP server
     */
    private handleServerMessage(serverId: string, data: string): void {
        const connection = this.servers.get(serverId);
        if (!connection) return;

        connection.buffer += data;

        
        const lines = connection.buffer.split('\n');
        connection.buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.trim()) continue;

            try {
                const message = JSON.parse(line);
                
                if (message.id !== undefined && connection.pendingRequests.has(message.id)) {
                    const request = connection.pendingRequests.get(message.id)!;
                    connection.pendingRequests.delete(message.id);

                    if (message.error) {
                        request.reject(new Error(message.error.message || 'MCP request failed'));
                    } else {
                        request.resolve(message.result);
                    }
                }
            } catch (error) {
                            }
        }
    }

    /**
     * Send JSON-RPC request to MCP server
     */
    private async sendRequest(serverId: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
        const connection = this.servers.get(serverId);
        if (!connection) {
            throw new Error(`MCP server ${serverId} not connected`);
        }
        
        
        

        
        
        if (connection.exitError) {
            throw connection.exitError;
        }

        
        return new Promise((resolve, reject) => {
            const id = ++connection.messageId;
            const request = {
                jsonrpc: '2.0',
                id,
                method,
                params: params || {}
            };

            connection.pendingRequests.set(id, { resolve, reject });

            if (connection.config.transport === 'stdio') {
                if (connection.config.streamUrl) {
                    this.sendSSERequest(connection, request, connection.config.streamUrl)
                        .then(response => {
                            connection.pendingRequests.delete(id);
                            resolve(response);
                        })
                        .catch(error => {
                            connection.pendingRequests.delete(id);
                            reject(error);
                        });
                    return;
                }
                
                const requestStr = JSON.stringify(request) + '\n';
                connection.process?.stdin?.write(requestStr);
            } else if (connection.config.transport === 'sse') {
                this.sendSSERequest(connection, request)
                    .then(response => {
                        connection.pendingRequests.delete(id);
                        resolve(response);
                    })
                    .catch(error => {
                        connection.pendingRequests.delete(id);
                        reject(error);
                    });
                return;
            }

            
            
            const timeoutMs = method === 'initialize' ? 60000 : 30000;
            setTimeout(() => {
                if (connection.pendingRequests.has(id)) {
                    connection.pendingRequests.delete(id);
                    reject(new Error(
                        `MCP request timeout for "${method}" on "${connection.config.name}" ` +
                        `after ${timeoutMs / 1000}s. The server process may still be starting up ` +
                        `(npx cold-start) or may have crashed silently.`
                    ));
                }
            }, timeoutMs);
        });
    }

    /**
     * Send request via SSE/Streamable HTTP (HTTP POST).
     *
     * Streamable HTTP (MCP spec 2025-03-26) works as follows:
     *   1. POST the JSON-RPC request to the server URL.
     *   2. The server may respond with:
     *      a. A plain JSON response (application/json) — stateless mode.
     *      b. An SSE stream (text/event-stream) — streaming mode.
     *      c. A 307/302 redirect to a session-specific endpoint — session mode.
     *
     * The old "SSE transport" (pre-2025) required a GET to /sse first to get a
     * session endpoint, then POST to that endpoint.  Many remote MCP servers
     * (including mcp.excalidraw.com) have migrated to Streamable HTTP, which
     * is why a plain POST to the root URL was failing with "Failed to fetch" —
     * the server was rejecting the request or the CORS preflight was failing
     * because the Accept header or method didn't match what the server expected.
     *
     * @param urlOverride - use this URL instead of config.url (for stdio+streamUrl mode)
     */
    private async sendSSERequest(connection: MCPServerConnection, request: Record<string, unknown>, urlOverride?: string): Promise<unknown> {
        const config = connection.config;
        const url = urlOverride || config.url;
        if (!url) {
            throw new Error('URL not configured for SSE transport');
        }

        
        let effectiveUrl = url;
        if (url.includes('mcp.exa.ai') && config.apiKey) {
            const separator = url.includes('?') ? '&' : '?';
            effectiveUrl = `${url}${separator}exaApiKey=${encodeURIComponent(config.apiKey)}`;
        }

        
        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'MCP-Protocol-Version': '2025-03-26',
            };

            if (config.apiKey && !url.includes('mcp.exa.ai')) {
                
                if (url.includes('composio.dev')) {
                    headers['x-api-key'] = config.apiKey;
                } else {
                    headers['Authorization'] = `Bearer ${config.apiKey}`;
                }
            } else if (!config.apiKey && config.env) {
                
                const apiKeyEntry = Object.entries(config.env).find(([k]) =>
                    k.toLowerCase().includes('api_key') || k.toLowerCase().includes('apikey') || k.toLowerCase().includes('token')
                );
                if (apiKeyEntry) {
                    headers['Authorization'] = `Bearer ${apiKeyEntry[1]}`;
                }
            }

            
            const response = await requestUrl({
                url: effectiveUrl,
                method: 'POST',
                headers,
                body: JSON.stringify(request),
                throw: false,
            });

            if (response.status >= 400) {
                                throw new Error(`HTTP ${response.status} - ${response.text}`);
            }

            const contentType = response.headers['content-type'] || '';

            
            if (contentType.includes('text/event-stream')) {
                                return this.parseSSEBody(response.text, request.id as number, config.name);
            }

            
            if (contentType.includes('application/json')) {
                const result = response.json;
                                if (result.error) {
                    throw new Error(result.error.message || 'MCP request failed');
                }
                return result.result;
            }

            throw new Error(`Unexpected content type: ${contentType}`);
        } catch (error) {
                        throw error;
        }
    }

    /**
     * Parse an SSE response body (received as a complete string via requestUrl).
     * Extracts the JSON-RPC result matching the given requestId.
     */
    private parseSSEBody(body: string, requestId: number, serverName: string): unknown {
        let result: unknown = null;
        let hasError = false;
        let errorObj: Record<string, unknown> | null = null;

        const lines = body.split('\n');
        let currentEvent = '';
        let currentData = '';

        for (const line of lines) {
            if (line.startsWith('event:')) {
                currentEvent = line.substring(6).trim();
            } else if (line.startsWith('data:')) {
                currentData = line.substring(5).trim();
            } else if (line === '') {
                if (currentEvent === 'message' && currentData) {
                    try {
                        const message = JSON.parse(currentData);
                                                if (message.id === requestId) {
                            if (message.error) {
                                hasError = true;
                                errorObj = message.error;
                            } else {
                                result = message.result;
                            }
                        }
                    } catch (parseError) {
                                            }
                }
                currentEvent = '';
                currentData = '';
            }
        }

        if (hasError && errorObj) {
            const msg = (errorObj.message as string | undefined) || `MCP Error (code ${errorObj.code})`;
            throw new Error(msg);
        }
        if (result === null) {
            throw new Error('No response received from SSE stream');
        }
        return result;
    }

    /**
     * Initialize MCP connection (handshake and capability discovery)
     */
    private async initializeConnection(serverId: string): Promise<void> {
        const connection = this.servers.get(serverId);
        if (!connection) throw new Error(`Server ${serverId} not found`);

        try {
            
            await this.sendRequest(serverId, 'initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {
                    tools: {},
                    resources: {}
                },
                clientInfo: {
                    name: 'nexus-lm',
                    version: '1.0.0'
                }
            });

            

            
            await this.discoverTools(serverId);

            
            await this.discoverResources(serverId);

                    } catch (error) {
                        this.disconnectServer(serverId);
            throw error;
        }
    }

    /**
     * Discover available tools from MCP server
     */
    private async discoverTools(serverId: string): Promise<void> {
        const connection = this.servers.get(serverId);
        if (!connection) return;

        try {
            const result = await this.sendRequest(serverId, 'tools/list') as Record<string, unknown>;
            connection.tools = (result.tools as MCPTool[]) || [];
                    } catch (error) {
                        connection.tools = [];
        }
    }

    /**
     * Discover available resources from MCP server
     */
    private async discoverResources(serverId: string): Promise<void> {
        const connection = this.servers.get(serverId);
        if (!connection) return;

        try {
            const result = await this.sendRequest(serverId, 'resources/list') as Record<string, unknown>;
            connection.resources = (result.resources as MCPResource[]) || [];
                    } catch (error) {
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('Method not found') || errorMessage.includes('-32601')) {
                                connection.resources = [];
            } else {
                                connection.resources = [];
            }
        }
    }

    /**
     * Get all tools from a specific server
     */
    getServerTools(serverId: string): MCPTool[] {
        const connection = this.servers.get(serverId);
        return connection?.tools || [];
    }

    /**
     * Get all resources from a specific server
     */
    getServerResources(serverId: string): MCPResource[] {
        const connection = this.servers.get(serverId);
        return connection?.resources || [];
    }

    /**
     * Invoke a tool on a specific MCP server
     */
    async invokeTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
        const connection = this.servers.get(serverId);
        if (!connection || !connection.connected) {
            throw new Error(`MCP server ${serverId} not connected`);
        }

        
        try {
            const result = await this.sendRequest(serverId, 'tools/call', {
                name: toolName,
                arguments: args
            });

                        return result;
        } catch (error) {
                        throw error;
        }
    }

    /**
     * Read a resource from a specific MCP server
     */
    async readResource(serverId: string, uri: string): Promise<unknown> {
        const connection = this.servers.get(serverId);
        if (!connection || !connection.connected) {
            throw new Error(`MCP server ${serverId} not connected`);
        }

        
        try {
            const result = await this.sendRequest(serverId, 'resources/read', {
                uri
            });

                        return result;
        } catch (error) {
                        throw error;
        }
    }

    /**
     * Disconnect from an MCP server
     */
    async disconnectServer(serverId: string): Promise<void> {
        const connection = this.servers.get(serverId);
        if (!connection) return;

        
        try {
            if (connection.process) {
                connection.process.kill();
            }
            if (connection.eventSource) {
                (connection.eventSource as unknown as any).close();
            }
        } catch (error) {
                    }

        this.servers.delete(serverId);
    }

    /**
     * Disconnect from all MCP servers
     */
    async disconnectAll(): Promise<void> {
        const serverIds = Array.from(this.servers.keys());
        await Promise.all(serverIds.map(id => this.disconnectServer(id)));
    }

    /**
     * Get the name of a specific server
     */
    getServerName(serverId: string): string | null {
        const connection = this.servers.get(serverId);
        return connection?.config.name || null;
    }

    /**
     * Get a connected server config by its ID
     */
    getConnectedServerById(serverId: string): MCPServerConfig | null {
        const connection = this.servers.get(serverId);
        return (connection && connection.connected) ? connection.config : null;
    }

    /**
     * Check if a server is connected
     */
    isServerConnected(serverId: string): boolean {
        const connection = this.servers.get(serverId);
        return connection?.connected || false;
    }

    /**
     * Get all connected servers
     */
    getConnectedServers(): MCPServerConfig[] {
        return Array.from(this.servers.values())
            .filter(conn => conn.connected)
            .map(conn => conn.config);
    }
}
