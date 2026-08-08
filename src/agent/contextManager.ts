export interface ContextManagerConfig {
  maxContextTokens: number;
  keepRecentTurns: number;
  compactionThreshold: number;
  maxSummarizerInputChars: number;
  compactionInterval: number;
  maxMessagesBeforeCompact: number;
}

const DEFAULT_CONFIG: ContextManagerConfig = {
  maxContextTokens: 12000,
  keepRecentTurns: 5,
  compactionThreshold: 0.6,
  maxSummarizerInputChars: 8000,
  compactionInterval: 3,
  maxMessagesBeforeCompact: 50,
};

export interface CompactResult {
  messages: Array<Record<string, unknown>>;
  wasCompacted: boolean;
  summaryText: string | null;
}

export class ContextManager {
  private config: ContextManagerConfig;

  constructor(config?: Partial<ContextManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get compactionInterval(): number {
    return this.config.compactionInterval;
  }

  updateConfig(config: Partial<ContextManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  estimateTokens(messages: Array<Record<string, unknown>>): number {
    let total = 0;
    for (const msg of messages) {
      const content = this.extractContent(msg);
      total += this.countTokens(content);
    }
    return total;
  }

  needsCompaction(messages: Array<Record<string, unknown>>): boolean {
    const estimated = this.estimateTokens(messages);
    const threshold = this.config.maxContextTokens * this.config.compactionThreshold;
    const nonSystemCount = messages.filter(m => m.role !== 'system').length;
    return estimated >= threshold || nonSystemCount >= this.config.maxMessagesBeforeCompact;
  }

  async compactMessages(
    messages: Array<Record<string, unknown>>,
    summarizer?: (text: string) => Promise<string>
  ): Promise<CompactResult> {
    if (!this.needsCompaction(messages)) {
      return { messages, wasCompacted: false, summaryText: null };
    }

    // Preserve system messages EXCEPT dynamic historical reference context (which should be evicted on compaction)
    const systemMessages = messages.filter(m => {
      if (m.role !== 'system') return false;
      const content = typeof m.content === 'string' ? m.content : '';
      return !content.includes('<historical_reference_context>');
    });
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    if (nonSystemMessages.length <= this.config.keepRecentTurns) {
      return { messages, wasCompacted: false, summaryText: null };
    }

    const keepCount = Math.min(this.config.keepRecentTurns, nonSystemMessages.length);
    let keepStart = nonSystemMessages.length - keepCount;

    // Never split a tool round: if the keep-window starts on a role:'tool'
    // message, its matching assistant(tool_calls) turn was cut out of history.
    // Extend the window backward to include it — otherwise the next request
    // carries orphaned tool results that OpenAI-compatible providers reject
    // ("No tool call found for function call output with call_id ...") and
    // Gemini rejects ("function response turn must come immediately after a
    // function call turn").
    while (keepStart > 0 && nonSystemMessages[keepStart]?.role === 'tool') {
      keepStart--;
    }

    const toCompact = nonSystemMessages.slice(0, keepStart);
    const recentMessages = nonSystemMessages.slice(keepStart);

    // Build text from messages to compact
    const compactText = toCompact
      .map((m) => {
        const role = m.role as string || 'user';
        const content = this.extractContent(m);
        return `[${role}]: ${content}`;
      })
      .join('\n\n');

    let summaryText: string;
    if (summarizer && compactText.length > 0) {
      const truncated = compactText.length > this.config.maxSummarizerInputChars
        ? compactText.slice(0, this.config.maxSummarizerInputChars) + '...'
        : compactText;
      try {
        summaryText = await summarizer(truncated);
      } catch {
        summaryText = this.fallbackSummary(compactText);
      }
    } else {
      summaryText = this.fallbackSummary(compactText);
    }

    const compactedMessages: Array<Record<string, unknown>> = [
      ...systemMessages,
      {
        role: 'system',
        content: `[Previous conversation summary]:\n${summaryText}`,
      },
      ...recentMessages,
    ];

    return { messages: compactedMessages, wasCompacted: true, summaryText };
  }

  private fallbackSummary(text: string): string {
    const maxLines = 30;
    const lines = text.split('\n');
    if (lines.length <= maxLines) {
      return text.slice(0, 1500);
    }
    // Keep first and last N lines as a basic extractive summary
    const head = lines.slice(0, 10).join('\n');
    const tail = lines.slice(-10).join('\n');
    return `${head}\n\n[... ${lines.length - 20} lines omitted ...]\n\n${tail}`;
  }

  private extractContent(msg: Record<string, unknown>): string {
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (content && Array.isArray(content)) {
      return (content as Array<Record<string, unknown>>)
        .map((p) => (p.text as string) || '')
        .join(' ');
    }
    return '';
  }

  private countTokens(text: string): number {
    if (!text) return 0;
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    const wordTokens = words.length;
    const longWordBonus = words.filter((w) => w.length > 10).length * 0.5;
    const specialChars = (text.match(/[^\w\s]/g) || []).length * 0.3;
    return Math.ceil(wordTokens + longWordBonus + specialChars);
  }
}
