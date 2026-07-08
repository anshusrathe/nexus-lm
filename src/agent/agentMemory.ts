import { normalizePath, type App, TFile } from 'obsidian';
import type { MemoryEntry } from './types';

interface EpisodicRecord {
  id: string;
  sessionId: string;
  task: string;
  summary: string;
  steps: number;
  success: boolean;
  timestamp: number;
}

interface VaultMemory {
  path: string;
  content: string;
  tags: string[];
  lastAccessed: number;
}

export class AgentMemory {
  private app: App;
  private baseDir: string = '.Nexus-LM-data/agent-memory';
  private workingMemory: Map<string, unknown> = new Map();
  private episodicMemory: EpisodicRecord[] = [];

  constructor(app: App) {
    this.app = app;
  }

  async initialize(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(normalizePath(this.baseDir));
    if (!exists) {
      await adapter.mkdir(normalizePath(this.baseDir));
      await adapter.mkdir(normalizePath(`${this.baseDir}/episodic`));
      await adapter.mkdir(normalizePath(`${this.baseDir}/semantic`));
    }
  }

  setWorking(key: string, value: unknown): void {
    this.workingMemory.set(key, value);
  }

  getWorking(key: string): unknown {
    return this.workingMemory.get(key);
  }

  clearWorking(): void {
    this.workingMemory.clear();
  }

  async saveEpisodic(record: EpisodicRecord): Promise<string> {
    const fileName = `session_${record.sessionId}.json`;
    const filePath = normalizePath(`${this.baseDir}/episodic/${fileName}`);
    await this.app.vault.adapter.write(filePath, JSON.stringify(record, null, 2));
    this.episodicMemory.push(record);
    return filePath;
  }

  async listEpisodic(limit: number = 20): Promise<EpisodicRecord[]> {
    try {
      const dirPath = normalizePath(`${this.baseDir}/episodic`);
      const files = await this.app.vault.adapter.list(dirPath);
      const jsonFiles = files.files.filter((f) => f.endsWith('.json'));

      const sorted = jsonFiles.sort();
      const recent = sorted.slice(-limit);

      const records: EpisodicRecord[] = [];
      for (const filePath of recent) {
        try {
          const content = await this.app.vault.adapter.read(filePath);
          const parsed = JSON.parse(content) as EpisodicRecord;
          records.push(parsed);
        } catch {
          continue;
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  async searchEpisodic(query: string): Promise<EpisodicRecord[]> {
    const all = await this.listEpisodic(100);
    const lowerQuery = query.toLowerCase();
    return all.filter(
      (r) =>
        r.task.toLowerCase().includes(lowerQuery) ||
        r.summary.toLowerCase().includes(lowerQuery)
    );
  }

  async saveSemantic(path: string, content: string, tags: string[]): Promise<void> {
    const fileName = path.replace(/\//g, '_').replace(/\./g, '_') + '.json';
    const filePath = normalizePath(`${this.baseDir}/semantic/${fileName}`);
    const entry: VaultMemory = { path, content, tags, lastAccessed: Date.now() };
    await this.app.vault.adapter.write(filePath, JSON.stringify(entry, null, 2));
  }

  async searchSemantic(query: string, limit: number = 10): Promise<VaultMemory[]> {
    try {
      const dirPath = normalizePath(`${this.baseDir}/semantic`);
      const files = await this.app.vault.adapter.list(dirPath);
      const jsonFiles = files.files.filter((f) => f.endsWith('.json')).slice(0, limit);

      const results: VaultMemory[] = [];
      const lowerQuery = query.toLowerCase();
      for (const filePath of jsonFiles) {
        try {
          const content = await this.app.vault.adapter.read(filePath);
          const parsed = JSON.parse(content) as VaultMemory;
          if (
            parsed.content.toLowerCase().includes(lowerQuery) ||
            parsed.tags.some((t) => t.toLowerCase().includes(lowerQuery))
          ) {
            results.push(parsed);
          }
        } catch {
          continue;
        }
      }
      return results;
    } catch {
      return [];
    }
  }
}
