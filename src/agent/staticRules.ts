import { normalizePath, type App } from 'obsidian';

const MAX_LINES = 200;
const MAX_BYTES = 25600;

const RULES_DIR = '.Nexus-LM-data/rules';
const RULES_FILE = 'AGENT_RULES.md';

export interface StaticRulesResult {
  content: string | null;
  source: 'file' | null;
}

export class StaticRules {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  async initialize(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const dirPath = normalizePath(RULES_DIR);
    const exists = await adapter.exists(dirPath);
    if (!exists) {
      await adapter.mkdir(dirPath);
    }
  }

  async readAll(): Promise<StaticRulesResult> {
    const content = await this.readRulesFile();
    if (!content) {
      return { content: null, source: null };
    }
    return { content: this.truncate(content), source: 'file' };
  }

  private async readRulesFile(): Promise<string | null> {
    try {
      const filePath = normalizePath(`${RULES_DIR}/${RULES_FILE}`);
      const adapter = this.app.vault.adapter;
      const exists = await adapter.exists(filePath);
      if (!exists) return null;
      const content = await adapter.read(filePath);
      if (!content.trim()) return null;
      return content;
    } catch {
      return null;
    }
  }

  private truncate(content: string): string {
    const lines = content.split('\n');
    if (lines.length <= MAX_LINES) {
      if (content.length <= MAX_BYTES) return content;
      return content.slice(0, MAX_BYTES) + '\n\n[...truncated at 25KB...]';
    }
    return lines.slice(0, MAX_LINES).join('\n') + '\n\n[...truncated at 200 lines...]';
  }
}
