import { normalizePath, type App } from 'obsidian';

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'what', 'when', 'where', 'which', 'who', 'whom',
  'about', 'than', 'then', 'they', 'them', 'their', 'there', 'these', 'those',
  'have', 'has', 'had', 'been', 'being', 'some', 'such', 'into', 'over', 'also',
  'very', 'just', 'each', 'more', 'most', 'only', 'other', 'than', 'then', 'after',
  'before', 'between', 'through', 'during', 'without', 'within', 'across', 'along',
  'because', 'could', 'should', 'would', 'might', 'must', 'shall', 'will', 'does',
  'done', 'doing', 'make', 'made', 'making', 'take', 'took', 'taken', 'taking',
  'note', 'notes', 'file', 'files', 'using', 'used', 'need', 'like', 'well', 'back', 'even',
  'still', 'already', 'yet', 'while', 'since', 'until', 'upon', 'via', 'vault', 'plugin',
  'task', 'check', 'show', 'find', 'search', 'how', 'want', 'can', 'heavy', 'provide',
  'answer', 'thought', 'new', 'would', 'should', 'please', 'help', 'give', 'get',
  'are', 'the', 'any', 'all', 'core', 'main', 'model', 'models', 'system', 'systems',
  'overview', 'structure', 'section', 'company', 'assessment', 'detail', 'detailed'
]);

const ACRONYMS: Record<string, string[]> = {
  'gqa': ['grouped query attention', 'grouped-query attention'],
  'mha': ['multi head attention', 'multi-head attention'],
  'mqa': ['multi query attention', 'multi-query attention'],
  'rope': ['rotary positional embeddings', 'rotary positional embedding'],
  'kv': ['key value', 'kv cache', 'key-value'],
  'dpo': ['direct preference optimization'],
  'rlhf': ['reinforcement learning human feedback'],
  'lora': ['low rank adaptation', 'low-rank adaptation'],
  'qlora': ['quantized lora'],
  'rmsnorm': ['root mean square normalization'],
  'swiglu': ['swish gated linear unit'],
  'moe': ['mixture of experts'],
  'bpe': ['byte pair encoding'],
  'bess': ['battery energy storage system'],
};

const MIN_RELEVANCE_SCORE = 5.0;
const MAX_RECORDS = 500;
const LEARNED_MAX_LINES = 200;
const LEARNED_MAX_BYTES = 25600;

export interface EpisodicRecord {
  id: string;
  sessionId: string;
  task: string;
  summary: string;
  steps: number;
  success: boolean;
  timestamp: number;
  keywords: string[];
  lessons: string[];
  importance: number;
  artifacts: string[];
}

export interface MemorySearchResult {
  record: EpisodicRecord;
  score: number;
  type: 'episodic';
}

export class AgentMemory {
  private app: App;
  private baseDir: string = '.Nexus-LM-data/agent-memory';
  private maxRecords: number = MAX_RECORDS;

  constructor(app: App, maxRecords?: number) {
    this.app = app;
    if (maxRecords) this.maxRecords = maxRecords;
  }

  async initialize(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const basePath = normalizePath(this.baseDir);
    const exists = await adapter.exists(basePath);
    if (!exists) {
      await adapter.mkdir(basePath);
    }
  }

  extractKeywords(text: string, answer?: string): string[] {
    const scored = new Map<string, number>();

    const addTopic = (topic: string, weight: number) => {
      const clean = topic.replace(/[*_#`[\]()]/g, '').trim();
      if (clean.length < 3) return;
      const lower = clean.toLowerCase();
      if (STOPWORDS.has(lower)) return;
      const words = lower.split(/\s+/).filter(w => w.length >= 2 && !STOPWORDS.has(w));
      if (words.length === 0) return;

      scored.set(clean, (scored.get(clean) || 0) + weight);
    };

    if (answer) {
      const headingRegex = /^#{1,4}\s+(.+)$/gm;
      let match: RegExpExecArray | null;
      while ((match = headingRegex.exec(answer)) !== null) {
        const headingText = match[1].replace(/^\d+[\.\)]\s*/, '').trim();
        if (headingText && headingText.length <= 60) {
          addTopic(headingText, 5);
        }
      }

      const boldRegex = /\*\*([^*]{3,40})\*\*/g;
      while ((match = boldRegex.exec(answer)) !== null) {
        const boldTerm = match[1].trim();
        if (boldTerm && !boldTerm.includes('\n')) {
          addTopic(boldTerm, 4);
        }
      }
    }

    const lowerTask = text.toLowerCase();
    const rawTokens = lowerTask.split(/\W+/);
    const validWords = rawTokens.filter(w => w.length >= 3 && !STOPWORDS.has(w));

    for (const w of validWords) {
      const weight = w.length >= 6 ? 2 : 1;
      addTopic(w, weight);
    }

    for (let i = 0; i < rawTokens.length - 1; i++) {
      const w1 = rawTokens[i];
      const w2 = rawTokens[i + 1];
      if (w1.length >= 3 && w2.length >= 3 && !STOPWORDS.has(w1) && !STOPWORDS.has(w2)) {
        addTopic(`${w1} ${w2}`, 2);
      }
    }

    return [...scored.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([word]) => word);
  }

  async saveEpisodic(record: EpisodicRecord): Promise<string> {
    try {
      const chatDir = normalizePath('.Nexus-LM-data/ai-chat-history');
      if (await this.app.vault.adapter.exists(chatDir)) {
        const files = await this.app.vault.adapter.list(chatDir);
        for (const fp of files.files) {
          if (fp.includes(record.sessionId)) {
            const json = await this.app.vault.adapter.read(fp);
            const session = JSON.parse(json) as import('../managers/aiChatSessionManager').AIChatSession;
            if (session && session.messages && session.messages.length > 0) {
              const lastMsg = session.messages[session.messages.length - 1];
              lastMsg.summary = record.summary;
              lastMsg.keywords = record.keywords;
              lastMsg.lessons = record.lessons;
              lastMsg.importance = record.importance;
              lastMsg.stepsCount = record.steps;
              lastMsg.success = record.success;
              lastMsg.artifacts = record.artifacts;
              await this.app.vault.adapter.write(fp, JSON.stringify(session, null, 2));
              return fp;
            }
          }
        }
      }
    } catch (err) {
      console.log('[AgentMemory] error updating unified memory session:', err);
    }
    return '';
  }

  async deleteEpisodic(sessionId: string): Promise<boolean> {
    try {
      const dirPath = normalizePath(`${this.baseDir}/episodic`);
      if (!(await this.app.vault.adapter.exists(dirPath))) return false;

      const files = await this.app.vault.adapter.list(dirPath);
      let deleted = false;

      for (const filePath of files.files) {
        if (filePath.includes(sessionId)) {
          await this.app.vault.adapter.remove(filePath);
          deleted = true;
        }
      }
      return deleted;
    } catch (err) {
      console.log('[AgentMemory] error deleting episodic memory:', err);
      return false;
    }
  }

  async listEpisodic(limit: number = 20): Promise<EpisodicRecord[]> {
    const records: EpisodicRecord[] = [];
    try {
      // 1. Read from unified session files (.Nexus-LM-data/ai-chat-history/)
      const chatDir = normalizePath('.Nexus-LM-data/ai-chat-history');
      if (await this.app.vault.adapter.exists(chatDir)) {
        const chatFiles = await this.app.vault.adapter.list(chatDir);
        const jsonFiles = chatFiles.files.filter((f) => f.endsWith('.json'));
        const recent = jsonFiles.sort().slice(-limit);

        for (const filePath of recent) {
          try {
            const content = await this.app.vault.adapter.read(filePath);
            const session = JSON.parse(content) as import('../managers/aiChatSessionManager').AIChatSession;
            if (session && session.messages && session.messages.length > 0) {
              for (const msg of session.messages) {
                const task = msg.question || '';
                const summary = msg.summary || (msg.answer ? msg.answer.slice(0, 150) : task);
                if (task) {
                  records.push({
                    id: msg.id || session.id,
                    sessionId: session.id,
                    task,
                    summary,
                    steps: msg.stepsCount || (msg.agentSteps ? msg.agentSteps.length : 1),
                    success: msg.success !== false,
                    timestamp: msg.timestamp || session.updatedAt || Date.now(),
                    keywords: msg.keywords || this.extractKeywords(task),
                    lessons: msg.lessons || [],
                    importance: msg.importance ?? 0.5,
                    artifacts: msg.artifacts || [],
                  });
                }
              }
            }
          } catch {
            continue;
          }
        }
      }

      // 2. Also read legacy episodic files if they exist
      const dirPath = normalizePath(`${this.baseDir}/episodic`);
      if (await this.app.vault.adapter.exists(dirPath)) {
        const files = await this.app.vault.adapter.list(dirPath);
        const jsonFiles = files.files.filter((f) => f.endsWith('.json'));
        const recent = jsonFiles.sort().slice(-limit);
        for (const filePath of recent) {
          try {
            const content = await this.app.vault.adapter.read(filePath);
            const parsed = JSON.parse(content) as EpisodicRecord;
            if (!parsed.lessons) parsed.lessons = [];
            if (parsed.importance === undefined) parsed.importance = parsed.success ? 0.5 : 0;
            if (!parsed.artifacts) parsed.artifacts = [];
            records.push(parsed);
          } catch {
            continue;
          }
        }
      }
      return records;
    } catch {
      return records;
    }
  }

  async searchEpisodic(query: string, limit: number = 5): Promise<MemorySearchResult[]> {
    const all = await this.listEpisodic(50);
    const lowerQuery = query.toLowerCase();
    const rawTerms = lowerQuery.split(/\W+/).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
    if (rawTerms.length === 0) return [];

    // Expand query terms with acronyms
    const queryTerms = new Set<string>(rawTerms);
    for (const term of rawTerms) {
      if (ACRONYMS[term]) {
        for (const exp of ACRONYMS[term]) {
          queryTerms.add(exp);
          for (const word of exp.split(/\W+/)) {
            if (word.length >= 3 && !STOPWORDS.has(word)) queryTerms.add(word);
          }
        }
      }
    }

    const scored: MemorySearchResult[] = [];
    const seenKeys = new Set<string>();

    for (const record of all) {
      let keywordScore = 0;
      const lessonsText = (record.lessons || []).join(' ').toLowerCase();
      const keywordsText = (record.keywords || []).join(' ').toLowerCase();
      const taskText = record.task.toLowerCase();

      for (const term of queryTerms) {
        if (keywordsText.includes(term)) {
          keywordScore += 5;
        }
        if (lessonsText.includes(term)) {
          keywordScore += 4;
        }
        if (taskText.includes(term)) {
          keywordScore += 2;
        }
      }

      const score = (() => {
        if (keywordScore <= 0) return 0;
        let s = keywordScore;
        const ageHours = (Date.now() - record.timestamp) / (1000 * 60 * 60);
        if (ageHours < 24) s += 2;
        else if (ageHours < 168) s += 1;
        s += (record.importance || 0.5) * 3;
        return s;
      })();

      // Require a strict minimum score threshold to prevent low-relevance memory injection
      if (score >= MIN_RELEVANCE_SCORE) {
        const dedupKey = `${record.task.slice(0, 40)}|${record.summary.slice(0, 40)}`;
        if (seenKeys.has(dedupKey)) {
          const existing = scored.find(s => s.record.task === record.task);
          if (existing && existing.score < score) {
            existing.score = score;
            existing.record = record;
          }
          continue;
        }
        seenKeys.add(dedupKey);
        scored.push({ record, score, type: 'episodic' });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async searchAll(query: string, limit: number = 5): Promise<MemorySearchResult[]> {
    return this.searchEpisodic(query, limit);
  }

  private async autoPrune(): Promise<void> {
    try {
      const dirPath = normalizePath(`${this.baseDir}/episodic`);
      const adapter = this.app.vault.adapter;
      const files = await adapter.list(dirPath);
      const jsonFiles = files.files.filter((f) => f.endsWith('.json'));
      if (jsonFiles.length <= this.maxRecords) return;

      const recordsWithPaths: Array<{ path: string; importance: number; timestamp: number }> = [];
      for (const fp of jsonFiles) {
        try {
          const content = await adapter.read(fp);
          const parsed = JSON.parse(content) as EpisodicRecord;
          recordsWithPaths.push({
            path: fp,
            importance: parsed.importance ?? (parsed.success ? 0.5 : 0),
            timestamp: parsed.timestamp ?? 0,
          });
        } catch {
          recordsWithPaths.push({ path: fp, importance: 0, timestamp: 0 });
        }
      }

      recordsWithPaths.sort((a, b) => {
        const impDiff = a.importance - b.importance;
        if (impDiff !== 0) return impDiff;
        return a.timestamp - b.timestamp;
      });

      const toRemove = recordsWithPaths.slice(0, recordsWithPaths.length - this.maxRecords);
      for (const r of toRemove) {
        try {
          await adapter.remove(r.path);
        } catch {
          continue;
        }
      }
    } catch {
      return;
    }
  }

  async readLearned(): Promise<string | null> {
    try {
      const filePath = normalizePath(`${this.baseDir}/learned/MEMORY.md`);
      const adapter = this.app.vault.adapter;
      const exists = await adapter.exists(filePath);
      if (!exists) return null;
      const content = await adapter.read(filePath);
      if (!content.trim()) return null;
      const lines = content.split('\n').slice(0, LEARNED_MAX_LINES);
      let result = lines.join('\n');
      if (result.length > LEARNED_MAX_BYTES) {
        result = result.slice(0, LEARNED_MAX_BYTES) + '\n[...truncated at 25KB...]';
      }
      if (lines.length > result.split('\n').length) {
        result += '\n[...truncated at 200 lines...]';
      }
      return result;
    } catch {
      return null;
    }
  }

  async appendLearned(entry: string): Promise<boolean> {
    try {
      const dirPath = normalizePath(`${this.baseDir}/learned`);
      const adapter = this.app.vault.adapter;
      const dirExists = await adapter.exists(dirPath);
      if (!dirExists) {
        await adapter.mkdir(dirPath);
      }
      const filePath = normalizePath(`${this.baseDir}/learned/MEMORY.md`);
      const now = new Date().toISOString().split('T')[0];
      const line = `- [${now}] ${entry}`;

      const exists = await adapter.exists(filePath);
      if (!exists) {
        await adapter.write(filePath, `# Learned Memory\n\nPatterns and discoveries from agent sessions.\n\n${line}\n`);
        return true;
      }

      const current = await adapter.read(filePath);
      const updated = current.trimEnd() + `\n${line}\n`;
      const totalLines = updated.split('\n').length;

      if (totalLines > LEARNED_MAX_LINES + 50) {
        const lines = updated.split('\n');
        const kept = lines.slice(0, LEARNED_MAX_LINES);
        kept.push('', '[...pruned: too many entries. Agent should prune learned memory.]');
        await adapter.write(filePath, kept.join('\n'));
      } else {
        await adapter.write(filePath, updated);
      }
      return true;
    } catch {
      return false;
    }
  }

  async clearLearned(): Promise<boolean> {
    try {
      const filePath = normalizePath(`${this.baseDir}/learned/MEMORY.md`);
      const adapter = this.app.vault.adapter;
      const exists = await adapter.exists(filePath);
      if (!exists) return true;
      await adapter.write(filePath, '# Learned Memory\n\n(cleared)\n');
      return true;
    } catch {
      return false;
    }
  }
}