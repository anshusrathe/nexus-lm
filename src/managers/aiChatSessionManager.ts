import { App, Notice, normalizePath } from 'obsidian';

export interface AIChatSessionMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  matchCount?: number; // Number of messages matching search query
}

export interface AIChatSession {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
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
    webResults?: any[];
    quickSearchResults?: any[];
    // File action data for persistence
    fileActionData?: {
      [actionId: string]: {
        type: 'edit' | 'create';
        fileName: string;
        status: 'processing' | 'completed' | 'failed' | 'accepted' | 'rejected';
        isApplied: boolean;
        // For edit actions
        editData?: {
          filePath: string;
          originalContent: string;
          editedContent: string;
          editPrompt: string;
        };
        // For create actions
        createData?: {
          folderName: string;
          creationPrompt: string;
          files: Array<{
            name: string;
            extension: string;
            content: string;
          }>;
        };
      };
    };
  }[];
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
              const session = JSON.parse(json);
              name = session.name || id;
              createdAt = session.createdAt || createdAt;
              updatedAt = session.updatedAt || updatedAt;
            } catch {}
            return { id, name, createdAt, updatedAt };
          })
      );
    } catch (e) {
      // Directory may not exist yet
      return [];
    }
  }

  async listSessionsLazy(limit: number = 20, offset: number = 0, searchQuery: string = ''): Promise<{ sessions: AIChatSessionMeta[], total: number }> {
    try {
      const files = await this.app.vault.adapter.list(this.baseDir);
      const sessionFiles = (files.files || []).filter(f => f.endsWith('.json'));
      
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
            
            try {
              const json = await this.app.vault.adapter.read(f);
              const session = JSON.parse(json);
              name = session.name || id;
              createdAt = session.createdAt || createdAt;
              updatedAt = session.updatedAt || updatedAt;
              
              // Search in session name, ID, and all message content
              const query = searchQuery.toLowerCase();
              matchFound = name.toLowerCase().includes(query) || 
                          id.toLowerCase().includes(query);
              
              // If not found in name/id, search through all messages
              if (!matchFound && session.messages && Array.isArray(session.messages)) {
                matchFound = session.messages.some((msg: any) => {
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
                matchCount = session.messages.filter((msg: any) => {
                  const questionMatch = msg.question && msg.question.toLowerCase().includes(query);
                  const answerMatch = msg.answer && msg.answer.toLowerCase().includes(query);
                  return questionMatch || answerMatch;
                }).length;
              }
            } catch {}
            
            // Only return sessions that match the search
            return matchFound ? { id, name, createdAt, updatedAt, matchCount } : null;
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
            try {
              const json = await this.app.vault.adapter.read(f);
              const session = JSON.parse(json);
              name = session.name || id;
              createdAt = session.createdAt || createdAt;
              updatedAt = session.updatedAt || updatedAt;
            } catch {}
            return { id, name, createdAt, updatedAt };
          })
        );
        
        return { sessions, total };
      }
    } catch (e) {
      return { sessions: [], total: 0 };
    }
  }

  async loadSession(sessionId: string): Promise<AIChatSession | null> {
    const file = this.getSessionFile(sessionId);
    try {
      const exists = await this.app.vault.adapter.exists(file);
      if (!exists) return null;
      const json = await this.app.vault.adapter.read(file);
      return JSON.parse(json);
    } catch (e) {
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