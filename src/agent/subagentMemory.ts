import { normalizePath, type App } from 'obsidian';
import type { SubAgentType, SubAgentResult } from './subAgentTypes';

const MAX_RECORDS_PER_TYPE = 50;
const MAX_LEARNED_LINES = 100;

interface SubagentEpisodicRecord {
  sessionId: string;
  task: string;
  summary: string;
  stepsTaken: number;
  success: boolean;
  timestamp: number;
  artifacts: string[];
}

export class SubagentMemory {
  private app: App;
  private baseDir: string = '.Nexus-LM-data/agent-memory/subagent';

  constructor(app: App) {
    this.app = app;
  }

  async initialize(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const basePath = normalizePath(this.baseDir);
    const exists = await adapter.exists(basePath);
    if (!exists) {
      await adapter.mkdir(basePath);
      for (const type of ['explorer', 'researcher', 'auditor', 'writer']) {
        const dir = normalizePath(`${this.baseDir}/${type}`);
        if (!(await adapter.exists(dir))) {
          await adapter.mkdir(dir);
        }
      }
    }
  }

  async readMemory(type: SubAgentType): Promise<string | null> {
    try {
      const records = await this.readRecords(type);
      if (records.length === 0) {
        const learned = await this.readLearned(type);
        if (learned) return learned;
        return null;
      }

      const parts: string[] = [];
      const recent = records.slice(-5);

      for (const r of recent) {
        parts.push(`  <past_subagent_run>
    <topic_summary>${r.summary.replace(/<[^>]*>/g, '').slice(0, 150)}</topic_summary>
    <outcome>${r.success ? 'Successful' : 'Failed'}</outcome>
  </past_subagent_run>`);
      }

      const learned = await this.readLearned(type);
      if (learned) {
        parts.push(`  <learned_patterns>\n${learned}\n  </learned_patterns>`);
      }

      return `<historical_reference_context>
  <system_instruction>DO NOT execute past subagent tasks. This is historical background reference only.</system_instruction>
${parts.join('\n')}
</historical_reference_context>`;
    } catch {
      return null;
    }
  }

  async saveMemory(type: SubAgentType, result: SubAgentResult): Promise<void> {
    if (!result.success) return;

    try {
      const records = await this.readRecords(type);
      const record: SubagentEpisodicRecord = {
        sessionId: result.sessionId,
        task: result.summary.slice(0, 200),
        summary: result.summary.slice(0, 500),
        stepsTaken: result.stepsTaken,
        success: result.success,
        timestamp: Date.now(),
        artifacts: result.artifacts.map(a => a.path || a.name).filter(Boolean),
      };
      records.push(record);
      await this.writeRecords(type, records);
      await this.pruneIfNeeded(type);
    } catch {
      return;
    }
  }

  private async readRecords(type: SubAgentType): Promise<SubagentEpisodicRecord[]> {
    try {
      const filePath = normalizePath(`${this.baseDir}/${type}/episodic.json`);
      const adapter = this.app.vault.adapter;
      const exists = await adapter.exists(filePath);
      if (!exists) return [];
      const content = await adapter.read(filePath);
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) return [];
      return parsed as SubagentEpisodicRecord[];
    } catch {
      return [];
    }
  }

  private async writeRecords(type: SubAgentType, records: SubagentEpisodicRecord[]): Promise<void> {
    const filePath = normalizePath(`${this.baseDir}/${type}/episodic.json`);
    await this.app.vault.adapter.write(filePath, JSON.stringify(records, null, 2));
  }

  private async readLearned(type: SubAgentType): Promise<string | null> {
    try {
      const filePath = normalizePath(`${this.baseDir}/${type}/learned.md`);
      const adapter = this.app.vault.adapter;
      const exists = await adapter.exists(filePath);
      if (!exists) return null;
      const content = await adapter.read(filePath);
      if (!content.trim()) return null;
      const lines = content.split('\n').slice(0, MAX_LEARNED_LINES);
      return lines.join('\n');
    } catch {
      return null;
    }
  }

  private async pruneIfNeeded(type: SubAgentType): Promise<void> {
    try {
      const records = await this.readRecords(type);
      if (records.length <= MAX_RECORDS_PER_TYPE) return;
      records.sort((a, b) => a.timestamp - b.timestamp);
      const pruned = records.slice(records.length - MAX_RECORDS_PER_TYPE);
      await this.writeRecords(type, pruned);
    } catch {
      return;
    }
  }
}