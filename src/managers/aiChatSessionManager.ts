import { App, Notice, normalizePath } from 'obsidian';

export interface AIChatSessionMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sessionType?: 'chat' | 'agent';
  matchCount?: number; // Number of messages matching search query
}

export interface AIChatSession {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sessionType?: 'chat' | 'agent';
  systemInstructions?: string; // Custom system instructions for this session
  messages: { 
    question: string; 
    answer: string; 
    timestamp: number;
    // Extended properties for file actions and other data
    id?: string;
    sessionId?: string;
    fileActionIds?: string[];
    context?: string[];
    sources?: Array<{ path: string; relevance: number; }>;
    webResults?: Record<string, unknown>[];
    quickSearchResults?: Record<string, unknown>[];
    modelName?: string;
    modelProvider?: string;
    completedAt?: number;
    totalTokens?: number;
    responseTimeMs?: number;
    mcpTools?: Record<string, unknown>[];
    searchMode?: string;
    vaultIndexName?: string;
    isQuickSearch?: boolean;
    // Agent and vault fields
    agentSteps?: unknown[];
    isAgentResponse?: boolean;
    vaultAnswer?: string;
    vaultResults?: Array<{ path: string; score: number }>;
    fileOperations?: unknown[];
    // File action data for persistence
    fileActionData?: Record<string, unknown>;
    // Unified Episodic memory & summary fields
    summary?: string;
    keywords?: string[];
    lessons?: string[];
    importance?: number;
    stepsCount?: number;
    success?: boolean;
    artifacts?: string[];
  }[];
  scratchpad?: string;
}

export class AIChatSessionManager {
  private app: App;
  private baseDir: string = '.Nexus-LM-data/ai-chat-history';

  constructor(app: App) {
    this.app = app;
  }

  private getSessionFile(sessionId: string): string {
    return normalizePath(`${this.baseDir}/${sessionId}.json`);
  }

  pruneOlderTurnTraces(session: AIChatSession): void {
    if (!session.messages || session.messages.length <= 1) return;
    // Keep Turn N-1 (the immediate last turn) 100% intact, and preserve execution traces while ensuring metadata, summary & lessons.
    for (let i = 0; i < session.messages.length - 1; i++) {
      const msg = session.messages[i];
      if (!msg.summary && msg.question) {
        const cleanQ = msg.question.replace(/\n+/g, ' ').replace(/^(New task:\s*)+/i, '').trim();
        msg.summary = cleanQ.length > 150 ? cleanQ.substring(0, 147) + '...' : cleanQ;
      }
    }
  }

  async listSessions(): Promise<AIChatSessionMeta[]> {
    try {
      const files = await this.app.vault.adapter.list(this.baseDir);
      return await Promise.all(
        (files.files || [])
          .filter(f => f.endsWith('.json'))
          .map(async f => {
            const id = f.split('/').pop()?.replace('.json', '') || '';
            let name = id;
            let createdAt = Date.now();
            let updatedAt = Date.now();
            try {
              const json = await this.app.vault.adapter.read(f);
              const session = JSON.parse(json) as AIChatSession;
              name = session.name || id;
              createdAt = session.createdAt || createdAt;
              updatedAt = session.updatedAt || updatedAt;
            } catch { // Intentionally ignored
            }
            return { id, name, createdAt, updatedAt };
          })
      );
    } catch {
      // Directory may not exist yet
      return [];
    }
  }

  async listSessionsLazy(limit: number = 20, offset: number = 0, searchQuery: string = '', sessionType?: 'chat' | 'agent'): Promise<{ sessions: AIChatSessionMeta[], total: number }> {
    try {
      const files = await this.app.vault.adapter.list(this.baseDir);
      let sessionFiles = (files.files || []).filter(f => f.endsWith('.json'));
      if (sessionType) {
        const matches = await Promise.all(sessionFiles.map(async path => {
          try {
            const session = JSON.parse(await this.app.vault.adapter.read(path)) as AIChatSession;
            const inferredType = session.sessionType ?? (session.messages?.some(message => message.isAgentResponse) ? 'agent' : 'chat');
            return inferredType === sessionType;
          } catch {
            return false;
          }
        }));
        sessionFiles = sessionFiles.filter((_, index) => matches[index]);
      }
      
      // Sort by file modification time (most recent first) without reading all files
      const fileStats = await Promise.all(
        sessionFiles.map(async f => {
          const stat = await this.app.vault.adapter.stat(f);
          return { path: f, mtime: stat?.mtime || 0 };
        })
      );
      
      fileStats.sort((a, b) => b.mtime - a.mtime);
      
      // Read all files to get names and content for searching (but only if search query exists)
      if (searchQuery) {
        const allSessionsWithNull: (AIChatSessionMeta | null)[] = await Promise.all(
          fileStats.map(async ({ path: f }): Promise<AIChatSessionMeta | null> => {
            const id = f.split('/').pop()?.replace('.json', '') || '';
            let name = id;
            let createdAt = Date.now();
            let updatedAt = Date.now();
            let matchFound = false;
            let matchCount = 0;
            
            let sType: 'chat' | 'agent' = 'chat';
            try {
              const json = await this.app.vault.adapter.read(f);
              const session = JSON.parse(json) as AIChatSession;
              name = session.name || id;
              createdAt = session.createdAt || createdAt;
              updatedAt = session.updatedAt || updatedAt;
              sType = session.sessionType ?? (session.messages?.some(msg => (msg as any).isAgentResponse) ? 'agent' : 'chat');
              
              // Search in session name, ID, and all message content
              const query = searchQuery.toLowerCase();
              matchFound = name.toLowerCase().includes(query) || 
                          id.toLowerCase().includes(query);
              
              // If not found in name/id, search through all messages
              if (!matchFound && session.messages && Array.isArray(session.messages)) {
                matchFound = session.messages.some((msg: { question: string, answer: string }) => {
                  const questionMatch = msg.question && msg.question.toLowerCase().includes(query);
                  const answerMatch = msg.answer && msg.answer.toLowerCase().includes(query);
                  if (questionMatch || answerMatch) {
                    matchCount++;
                    return true;
                  }
                  return false;
                });
              } else if (matchFound) {
                // Match found in name/id
                matchCount = -1; // Special value to indicate name match
              }
              
              // Count all matching messages for display
              if (matchFound && matchCount === 0 && session.messages && Array.isArray(session.messages)) {
                matchCount = session.messages.filter((msg: { question: string, answer: string }) => {
                  const questionMatch = msg.question && msg.question.toLowerCase().includes(query);
                  const answerMatch = msg.answer && msg.answer.toLowerCase().includes(query);
                  return questionMatch || answerMatch;
                }).length;
              }
            } catch { // Intentionally ignored
            }
            
            // Only return sessions that match the search
            return matchFound ? { id, name, createdAt, updatedAt, sessionType: sType, matchCount } : null;
          })
        );
        
        // Filter out null values (non-matching sessions)
        const allSessions: AIChatSessionMeta[] = allSessionsWithNull.filter((s): s is AIChatSessionMeta => s !== null);
        
        const total = allSessions.length;
        const sessions = allSessions.slice(offset, offset + limit);
        return { sessions, total };
      } else {
        // No search query - use optimized pagination
        const total = sessionFiles.length;
        const pageFiles = fileStats.slice(offset, offset + limit);
        const sessions = await Promise.all(
          pageFiles.map(async ({ path: f }) => {
            const id = f.split('/').pop()?.replace('.json', '') || '';
            let name = id;
            let createdAt = Date.now();
            let updatedAt = Date.now();
            let sType: 'chat' | 'agent' = 'chat';
            try {
              const json = await this.app.vault.adapter.read(f);
              const session = JSON.parse(json) as AIChatSession;
              name = session.name || id;
              createdAt = session.createdAt || createdAt;
              updatedAt = session.updatedAt || updatedAt;
              sType = session.sessionType ?? (session.messages?.some(msg => (msg as any).isAgentResponse) ? 'agent' : 'chat');
            } catch { // Intentionally ignored
            }
            return { id, name, createdAt, updatedAt, sessionType: sType };
          })
        );
        
        return { sessions, total };
      }
    } catch {
      return { sessions: [], total: 0 };
    }
  }

  async loadSession(sessionId: string): Promise<AIChatSession | null> {
    const file = this.getSessionFile(sessionId);
    try {
      const exists = await this.app.vault.adapter.exists(file);
      if (!exists) return null;
      const json = await this.app.vault.adapter.read(file);
      return JSON.parse(json) as AIChatSession;
    } catch {
      return null;
    }
  }

  async saveSession(session: AIChatSession): Promise<void> {
    const dir = this.baseDir;
    const file = this.getSessionFile(session.id);
    try {
      const dirExists = await this.app.vault.adapter.exists(dir);
      if (!dirExists) {
        await this.app.vault.adapter.mkdir(dir);
      }
      this.pruneOlderTurnTraces(session);
      session.updatedAt = Date.now();
      await this.app.vault.adapter.write(file, JSON.stringify(session, null, 2));
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      new Notice(`Failed to save AI chat session: ${errorMessage}`);
    }
  }

  async createSession(name?: string): Promise<AIChatSession> {
    let sessionName = name || new Date().toLocaleString();
    let id = sessionName.trim().replace(/[^a-zA-Z0-9-_]/g, '_');
    if (!id || id === '_') id = Date.now().toString();
    const now = Date.now();
    const session: AIChatSession = {
      id,
      name: sessionName,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    await this.saveSession(session);
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const file = this.getSessionFile(sessionId);
    try {
      await this.app.vault.adapter.remove(file);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      new Notice(`Failed to delete AI chat session: ${errorMessage}`);
    }
  }
}
