/**
 * Token Estimator - Estimates token usage for queries
 * Uses character-based heuristic: 1 token ≈ 4 characters
 */

export enum TaskType {
  BASIC_CHAT = 'basic_chat',
  VAULT_SEARCH = 'vault_search',
  FLASH_SEARCH = 'flash_search',
  WEB_SEARCH = 'web_search',
  MULTIMODAL = 'multimodal',
  DEEP_REASONING = 'deep_reasoning',
  CODE_GENERATION = 'code_generation',
  MCP_TOOL_CALLING = 'mcp_tool_calling',
  YOUTUBE_QUERY = 'youtube_query',
  WEBPAGE_FETCH = 'webpage_fetch',
}

export class TokenEstimator {
  /**
   * Estimates total tokens needed for a task
   * @param query - User query
   * @param vaultContext - Vault context (if any)
   * @param chatHistory - Chat history
   * @param taskType - Type of task
   * @returns Estimated token count
   */
  estimate(
    query: string,
    vaultContext: string = '',
    chatHistory: any[] = [],
    taskType: TaskType = TaskType.BASIC_CHAT
  ): number {
    let total = 0;
    
    // Query tokens
    total += this.countTokens(query);
    
    // Context tokens
    total += this.countTokens(vaultContext);
    
    // Chat history tokens
    for (const msg of chatHistory) {
      total += this.countTokens(this.extractContent(msg));
    }
    
    // System prompt tokens (estimated)
    total += 200;
    
    // Expected output tokens (varies by task)
    total += this.estimateOutputTokens(taskType);
    
    // Add 20% safety margin
    return Math.ceil(total * 1.2);
  }
  
  /**
   * Estimates output tokens based on task type
   */
  private estimateOutputTokens(taskType: TaskType): number {
    switch (taskType) {
      case TaskType.BASIC_CHAT:
        return 500;
      case TaskType.VAULT_SEARCH:
        return 1000;
      case TaskType.FLASH_SEARCH:
        return 500;
      case TaskType.WEB_SEARCH:
        return 1500;
      case TaskType.DEEP_REASONING:
        return 3000;
      case TaskType.CODE_GENERATION:
        return 2000;
      case TaskType.MULTIMODAL:
        return 1000;
      case TaskType.MCP_TOOL_CALLING:
        // MCP queries involve planning + multi-tool execution + synthesis
        // Reserve extra budget for tool results flowing back into context
        return 4000;
      default:
        return 1000;
    }
  }
  
  /**
   * Counts tokens using improved character-based heuristic
   * More accurate approximation considering word boundaries
   * Average: 1 token ≈ 3.5 characters for English text
   */
  private countTokens(text: string): number {
    if (!text) return 0;
    
    // More accurate estimation:
    // - Count words (each word is roughly 1 token)
    // - Add punctuation and special characters
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const wordTokens = words.length;
    
    // Add extra tokens for long words (>10 chars often split into multiple tokens)
    const longWordBonus = words.filter(w => w.length > 10).length * 0.5;
    
    // Add tokens for special characters and punctuation
    const specialChars = (text.match(/[^\w\s]/g) || []).length * 0.3;
    
    return Math.ceil(wordTokens + longWordBonus + specialChars);
  }
  
  /**
   * Extracts content from a message object
   */
  private extractContent(msg: any): string {
    if (typeof msg === 'string') return msg;
    if (msg.content) return msg.content;
    if (msg.parts && Array.isArray(msg.parts)) {
      return msg.parts.map((p: any) => p.text || '').join(' ');
    }
    return '';
  }
  
  /**
   * Classifies task type based on context.
   * @param query - User query text
   * @param vaultContext - Vault context string (if any)
   * @param webEnabled - Whether web search is active
   * @param hasMultimodal - Whether multimodal input is present
   * @param mcpEnabled - Whether MCP tool calling is active for this query
   */
  static classifyTask(
    query: string,
    vaultContext: string,
    webEnabled: boolean,
    hasMultimodal: boolean,
    mcpEnabled: boolean = false
  ): TaskType {
    // Multimodal takes priority
    if (hasMultimodal) {
      return TaskType.MULTIMODAL;
    }

    // MCP tool calling — needs extra token budget for planning + tool results + synthesis
    if (mcpEnabled) {
      return TaskType.MCP_TOOL_CALLING;
    }

    // Web search
    if (webEnabled) {
      return TaskType.WEB_SEARCH;
    }

    // Vault search with significant context
    if (vaultContext && vaultContext.length > 5000) {
      return TaskType.VAULT_SEARCH;
    }

    const q = query.toLowerCase();

    // ── Code generation ──────────────────────────────────────────────────────
    // Broader keyword set: imperative verbs + language/tool names
    const codeKeywords = [
      'code', 'function', 'class', 'debug', 'implement', 'algorithm',
      'script', 'program', 'refactor', 'fix the bug', 'write a', 'build a',
      'create a', 'typescript', 'javascript', 'python', 'java', 'bash',
      'shell', 'sql', 'regex', 'api', 'endpoint', 'component', 'module',
      'compile', 'syntax', 'variable', 'loop', 'array', 'object', 'method',
      'interface', 'type error', 'import', 'export', 'async', 'await',
      'promise', 'callback', 'test', 'unit test', 'mock', 'lint'
    ];
    if (codeKeywords.some(kw => q.includes(kw))) {
      return TaskType.CODE_GENERATION;
    }

    // ── Deep reasoning ───────────────────────────────────────────────────────
    // Question structures and analytical verbs that signal multi-step reasoning
    const reasoningKeywords = [
      'analyze', 'analyse', 'compare', 'explain why', 'reasoning', 'evaluate',
      'what is the difference', 'pros and cons', 'trade-off', 'tradeoff',
      'how does', 'why does', 'what causes', 'implications of', 'impact of',
      'critically', 'assess', 'justify', 'argue', 'debate', 'hypothesis',
      'in depth', 'deep dive', 'step by step', 'walk me through',
      'break down', 'elaborate', 'discuss', 'review', 'audit'
    ];
    if (reasoningKeywords.some(kw => q.includes(kw))) {
      return TaskType.DEEP_REASONING;
    }

    // Long queries tend to need more reasoning capacity
    if (query.split(/\s+/).length > 60) {
      return TaskType.DEEP_REASONING;
    }

    // Default to basic chat
    return TaskType.BASIC_CHAT;
  }
}
