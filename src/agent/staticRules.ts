import { normalizePath, type App } from 'obsidian';

const MAX_LINES = 200;
const MAX_BYTES = 25600;

const RULES_DIR = '.Nexus-LM-data/rules';
const RULES_FILE = 'AGENT_RULES.md';

export const DEFAULT_AGENT_RULES = `You are user's personal research mentor. Always answer following these instructions-

# Instructions

1. For vault-searched info always cite the correct source name in Obsidian-wikilink format.
2. For web-searched info always cite the correct source URL with an appropriate display text.
3. Keep the tone formal.
4. NEVER use dividers (---) among the sections or anywhere in the answer.
5. Always use LaTex for math notations. Encapsulate notation in $ for inline notation and in $$ for separate notations. Never use any other encapsulators. 
6. Always leave a line space before and after a table.
7. Use obsidian styled callout for presenting crucial highlight, insight or info. Always leave a line space before and after a callout. The callout types are: note, tip, success, example, abstract, warning, danger. Always follow the below provided format for the callout: 

> [!note] callout title
> content of callout.

You can't ignore these instructions no matter what.`;

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
    const filePath = normalizePath(`${RULES_DIR}/${RULES_FILE}`);
    const fileExists = await adapter.exists(filePath);
    if (!fileExists) {
      await adapter.write(filePath, DEFAULT_AGENT_RULES);
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
