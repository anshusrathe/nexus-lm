import { App, Notice, TFile, normalizePath } from 'obsidian';

export type NotebookMode = 'cag' | 'rag';

export interface Notebook {
  id: string;
  name: string;
  sourcePaths: string[]; 
  sourceFolders?: string[]; 
  webSources?: { url: string; name: string }[]; 
  feedSources?: { url: string; name: string; durationDays: number }[]; 
  createdAt: number; 
  updatedAt: number; 
  customInstruction?: string; 
  inlineCitation?: boolean; 
  mode?: NotebookMode; 
  contextLength?: number; 
}

export class NotebookManager {
  private app: App;
  private filePath: string;
  private notebooks: Notebook[] = [];

  constructor(app: App) {
    this.app = app;
    this.filePath = normalizePath(`.Nexus-LM-data/notebooks/notebooks.json`); 
  }

  async loadNotebooks(): Promise<void> {
    try {
      const fileExists = await this.app.vault.adapter.exists(this.filePath);
      if (fileExists) {
        const jsonString = await this.app.vault.adapter.read(this.filePath);
        this.notebooks = JSON.parse(jsonString);
      } else {
        
        await this.saveNotebooks();
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      new Notice(`Failed to load notebooks: ${errorMessage}`);
      this.notebooks = []; 
    }
  }

  async saveNotebooks(): Promise<void> {
    try {
      
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
      const dirExists = await this.app.vault.adapter.exists(dir);
      if (!dirExists) {
        await this.app.vault.adapter.mkdir(dir);
      }
      const jsonString = JSON.stringify(this.notebooks, null, 2);
      await this.app.vault.adapter.write(this.filePath, jsonString);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      new Notice(`Failed to save notebooks: ${errorMessage}`);
    }
  }

  getNotebooks(): Notebook[] {
    return this.notebooks;
  }

  addNotebook(name: string, sourcePaths: string[], customInstruction?: string, webSources?: { url: string; name: string }[], inlineCitation?: boolean, mode?: NotebookMode, sourceFolders?: string[], feedSources?: { url: string; name: string; durationDays: number }[]): Notebook {
    const newNotebook: Notebook = {
      id: Date.now().toString(), 
      name,
      sourcePaths,
      sourceFolders: sourceFolders || [],
      webSources: webSources || [],
      feedSources: feedSources || [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      customInstruction: customInstruction || '',
      inlineCitation: inlineCitation !== undefined ? inlineCitation : true, 
      mode: mode || 'cag', 
      contextLength: 0, 
    };
    this.notebooks.push(newNotebook);
    this.saveNotebooks();
    new Notice(`Notebook "${name}" created.`);
    return newNotebook;
  }

  async updateNotebook(id: string, name: string, sourcePaths: string[], customInstruction?: string, webSources?: { url: string; name: string }[], inlineCitation?: boolean, mode?: NotebookMode, sourceFolders?: string[], feedSources?: { url: string; name: string; durationDays: number }[]): Promise<void> {
    const index = this.notebooks.findIndex(nb => nb.id === id);
    if (index !== -1) {
      this.notebooks[index] = {
        ...this.notebooks[index],
        name,
        sourcePaths,
        sourceFolders: sourceFolders !== undefined ? sourceFolders : this.notebooks[index].sourceFolders || [],
        webSources: webSources || [],
        feedSources: feedSources !== undefined ? feedSources : this.notebooks[index].feedSources || [],
        updatedAt: Date.now(),
        customInstruction: customInstruction !== undefined ? customInstruction : this.notebooks[index].customInstruction || '',
        inlineCitation: inlineCitation !== undefined ? inlineCitation : this.notebooks[index].inlineCitation !== undefined ? this.notebooks[index].inlineCitation : true,
        mode: mode !== undefined ? mode : this.notebooks[index].mode || 'cag',
        contextLength: 0, 
      };
      await this.saveNotebooks();
    }
  }

  deleteNotebook(id: string): void {
    const index = this.notebooks.findIndex(nb => nb.id === id);
    if (index !== -1) {
      const deletedNotebook = this.notebooks.splice(index, 1)[0];
      this.saveNotebooks();
      new Notice(`Notebook "${deletedNotebook.name}" deleted.`);
    }
  }
}



export interface NotebookChatSessionMeta {
  id: string; 
  name: string; 
  createdAt: number;
  updatedAt: number;
}

export interface NotebookChatSession {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  messages: { role: 'user' | 'assistant'; content: string; sourceMapping?: string[] }[];
}

export class NotebookChatHistoryManager {
  private app: App;
  private baseDir: string;

  constructor(app: App) {
    this.app = app;
    this.baseDir = `.Nexus-LM-data/notebook-chat-history`;
  }

  private getNotebookDir(notebookId: string): string {
    return normalizePath(`${this.baseDir}/${notebookId}`);
  }

  private getSessionFile(notebookId: string, sessionId: string): string {
    return normalizePath(`${this.getNotebookDir(notebookId)}/${sessionId}.json`);
  }

  async listSessions(notebookId: string): Promise<NotebookChatSessionMeta[]> {
    const dir = this.getNotebookDir(notebookId);
    try {
      const files = await this.app.vault.adapter.list(dir);
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
          return {
            id,
              name,
              createdAt,
              updatedAt,
          };
          })
      );
    } catch (e) {
      
      return [];
    }
  }

  async loadSession(notebookId: string, sessionId: string): Promise<NotebookChatSession | null> {
    const file = this.getSessionFile(notebookId, sessionId);
    try {
      const exists = await this.app.vault.adapter.exists(file);
      if (!exists) return null;
      const json = await this.app.vault.adapter.read(file);
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  async saveSession(notebookId: string, session: NotebookChatSession): Promise<void> {
    const dir = this.getNotebookDir(notebookId);
    const file = this.getSessionFile(notebookId, session.id);
    try {
      const dirExists = await this.app.vault.adapter.exists(dir);
      if (!dirExists) {
        await this.app.vault.adapter.mkdir(dir);
      }
      session.updatedAt = Date.now();
      await this.app.vault.adapter.write(file, JSON.stringify(session, null, 2));
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      new Notice(`Failed to save chat session: ${errorMessage}`);
    }
  }

  async createSession(notebookId: string, name?: string): Promise<NotebookChatSession> {
    let sessionName = name || new Date().toLocaleString();
    
    let id = sessionName.trim().replace(/[^a-zA-Z0-9-_]/g, '_');
    if (!id || id === '_') id = Date.now().toString();
    const now = Date.now();
    const session: NotebookChatSession = {
      id,
      name: sessionName,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    await this.saveSession(notebookId, session);
    return session;
  }
} 