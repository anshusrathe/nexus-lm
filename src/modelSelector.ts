import { AISettings, CustomModel, Provider } from './settings';
import { TaskType } from './utils/tokenEstimator';
import { validateNvidiaApiKey } from './services/nvidiaService';
import { UnifiedProviderManager } from './services/unifiedProviderManager';

export interface TaskRequirements {
  supportsWebSearch?: boolean;
  supportsMultimodal?: boolean;
  supportsThinking?: boolean;
  /** Set true when the query will use MCP tool calling — filters to tool-capable models */
  supportsMCPToolCalling?: boolean;
}

export interface ModelSelection {
  provider: Provider;
  modelId: string;
  modelName: string;
  reason: string;
  fallbacks: Array<{
    provider: Provider;
    modelId: string;
    modelName: string;
  }>;
}

export interface ModelCapability {
  model: CustomModel;
  actualTPM: number; // TPM from settings.tokenLimit
}

export class ModelSelector {
  private settings: AISettings;
  
  constructor(settings: AISettings) {
    this.settings = settings;
  }
  
  /**
   * Gets TPM from settings (tokenLimit) - this is the source of truth
   * RateLimitManager is NOT used for model selection as it provides unreliable values
   */
  private getActualTPM(model: CustomModel): number {
    // ALWAYS use configured tokenLimit from settings
    const configuredTPM = model.tokenLimit || 0;
    
    if (configuredTPM > 0) {
      // Use configured TPM from settings
    } else {
          }
    
    return configuredTPM;
  }

  /**
   * Selects the best model for a task with fallback chain
   * Uses actual API limits and progressive fallback strategy
   * @param taskType - Type of task
   * @param estimatedTokens - Estimated tokens needed
   * @param requirements - Special requirements
   * @returns Selected model info with fallbacks
   */
  selectModel(
    taskType: TaskType,
    estimatedTokens: number,
    requirements: TaskRequirements = {}
  ): ModelSelection {
    
    // Get all enabled models
    let availableModels = this.settings.customModels.filter(m => m.enabled !== false);
    
    // Filter out models from providers without valid API keys or availability
    const unavailableProviders: Provider[] = [];
    availableModels = availableModels.filter(model => {
      const hasValidAuth = this.hasValidProviderAuth(model.provider);
      if (!hasValidAuth && !unavailableProviders.includes(model.provider)) {
        unavailableProviders.push(model.provider);
      }
      return hasValidAuth;
    });
    
    // Notify user about unavailable providers
    if (unavailableProviders.length > 0) {
      const providerMessages = unavailableProviders.map(provider => {
        return this.getProviderSetupMessage(provider);
      }).join('\n');
          }

    // STRICT 7K TPM FLOOR — no model below this threshold enters any auto chain,
    // regardless of task type. Applied before capability filtering so all modes
    // (web, vault, flash, create, MCP, etc.) are uniformly protected.
    const MIN_GLOBAL_TPM = 7000;
    const beforeFloor = availableModels.length;
    availableModels = availableModels.filter(m => this.getActualTPM(m) >= MIN_GLOBAL_TPM);
    const excludedCount = beforeFloor - availableModels.length;
    if (excludedCount > 0) {
          }
    
    if (availableModels.length === 0) {
      // Fallback to current model if no models available
      const fallbackReason = unavailableProviders.length > 0
        ? `No models available. Please configure API keys:\n${unavailableProviders.map(p => this.getProviderSetupMessage(p)).join('\n')}`
        : 'Using current model (no auto-mode models configured)';
      
      return {
        provider: this.settings.provider,
        modelId: this.settings.model,
        modelName: this.settings.model,
        reason: fallbackReason,
        fallbacks: []
      };
    }
    
    // Filter by requirements (web search, multimodal, MCP tool calling, etc.)
    let capable = this.filterByCapabilities(availableModels, requirements);
    
    if (capable.length === 0) {
      // No models meet requirements
      if (requirements.supportsWebSearch) {
        // Web search is required but no capable models found
                return {
          provider: this.settings.provider,
          modelId: this.settings.model,
          modelName: this.settings.model,
          reason: 'No web-search capable models available. Enable models from: Gemini (all models), Ollama (all models with @web prefix), or Groq (Compound/Compound-mini)',
          fallbacks: []
        };
      }
      if (requirements.supportsMultimodal) {
        // Multimodal is required but no capable models found
                return {
          provider: this.settings.provider,
          modelId: this.settings.model,
          modelName: this.settings.model,
          reason: 'No multimodal-capable models available. Enable vision models from: Gemini (Flash/Pro), OpenRouter (vision models), or Ollama (llava, etc.)',
          fallbacks: []
        };
      }
      if (requirements.supportsMCPToolCalling) {
              }
      // For other requirements, use any available model
      capable = availableModels;
    }

    // Strict Multimodal Routing: If Gemini is available for a multimodal task, use ONLY Gemini
    if (requirements.supportsMultimodal) {
      const geminiModels = capable.filter(m => m.provider === 'gemini');
      if (geminiModels.length > 0) {
        capable = geminiModels;
      }
    }
    
    // Get actual TPM for all capable models
    let modelsWithActualTPM: ModelCapability[] = capable.map(model => ({
      model,
      actualTPM: this.getActualTPM(model)
    }));

    // Helper to sort models by TPM descending (no latency — verificationLatency is a
    // stale snapshot that doesn't reflect real-time API conditions).
    const sortByTPMOnly = (a: ModelCapability, b: ModelCapability) => {
      if (a.actualTPM !== b.actualTPM) return b.actualTPM - a.actualTPM;
      return a.model.id.localeCompare(b.model.id);
    };

    // SELECTION:
    // 1. Initial sort by TPM ascending (standard baseline)
    const allSortedCandidates = [...modelsWithActualTPM].sort((a: ModelCapability, b: ModelCapability) => {
      if (a.actualTPM !== b.actualTPM) return a.actualTPM - b.actualTPM;
      return a.model.id.localeCompare(b.model.id);
    });

    const SAFETY_MARGIN = 1.2;
    const requiredTPM = estimatedTokens * SAFETY_MARGIN;
    
    // CAPABLE MODELS: Those that can handle the estimated payload
    const capableEnough = modelsWithActualTPM
      .filter((m: ModelCapability) => m.actualTPM >= requiredTPM)
      .sort(sortByTPMOnly);

    // DETERMINING THE PRIMARY MODEL (SELECTED)
    // For biased tasks, we favor specific providers but still respect TPM within them.
    const isBasicBiased = taskType === TaskType.BASIC_CHAT || 
                          taskType === TaskType.VAULT_SEARCH || 
                          taskType === TaskType.FLASH_SEARCH || 
                          taskType === TaskType.YOUTUBE_QUERY ||
                          taskType === TaskType.CODE_GENERATION ||
                          taskType === TaskType.MULTIMODAL;
    
    const isWebBiased = taskType === TaskType.WEB_SEARCH || 
                        taskType === TaskType.WEBPAGE_FETCH;

    const isMcpBiased = taskType === TaskType.MCP_TOOL_CALLING;

    const isBiasedTask = isBasicBiased || isWebBiased || isMcpBiased;

    let selected: ModelCapability;

    if (capableEnough.length > 0) {
      // If we have models that meet the TPM threshold, pick the fastest one among them
      selected = capableEnough[0];
    } else {
      // Fallback: If NO model meets TPM threshold, use the largest one we have
      selected = [...modelsWithActualTPM].sort((a: ModelCapability, b: ModelCapability) => b.actualTPM - a.actualTPM)[0];
    }
    
    let providerOrder: Provider[] = ['groq', 'opencode', 'ollama', 'gemini', 'openrouter', 'nvidia'];
    
    if (isWebBiased) {
      providerOrder = ['ollama', 'gemini', 'groq'];
    } else if (isMcpBiased) {
      providerOrder = [
        'ollama', 'gemini', 'openrouter', 'opencode',
        ...((this.settings.customProviders || []).map(p => p.id as Provider)),
        'nvidia', 'groq'
      ];
    }

    if (isBiasedTask) {
      // For biased tasks, try to find a capable model from the preferred providers in order
      for (const provider of providerOrder) {
        let providerCandidates = capableEnough.filter((m: ModelCapability) => m.model.provider === provider);
        
        if (provider === 'openrouter') {
          providerCandidates = providerCandidates.filter((m: ModelCapability) => 
            m.model.id === 'openrouter/free' || m.model.id === 'openrouter/auto'
          );
        }

        if (providerCandidates.length > 0) {
          // capableEnough is already sorted by TPM
          selected = providerCandidates[0];
          break;
        }
      }
    }

    // BUILD GLOBAL PROGRESSIVE FALLBACK CHAIN
    // We unify all models into a single global pool to ensure we never "de-escalate" 
    // to a lower TPM model just because it belongs to the same provider.
    const fallbacks: Array<{ provider: Provider; modelId: string; modelName: string }> = [];

    // 1. Primary Fallbacks: Models that meet the TPM threshold, sorted globally by TPM
    const primaryFallbacks = modelsWithActualTPM
      .filter((m: ModelCapability) => m.model.id !== selected.model.id && m.actualTPM >= requiredTPM)
      .sort(sortByTPMOnly);

    // 2. Secondary Fallbacks: Models that don't meet the TPM threshold (last resort), 
    // sorted primarily by highest capacity (TPM) to give the best chance of success.
    const secondaryFallbacks = modelsWithActualTPM
      .filter((m: ModelCapability) => m.model.id !== selected.model.id && m.actualTPM < requiredTPM)
      .sort((a, b) => b.actualTPM - a.actualTPM);

    // Combine them into the final chain (max 10)
    const globalChain = [...primaryFallbacks, ...secondaryFallbacks];

    for (const m of globalChain) {
      if (fallbacks.length >= 10) break;
      fallbacks.push({ provider: m.model.provider, modelId: m.model.id, modelName: m.model.name });
    }

    return {
      provider: selected.model.provider,
      modelId: selected.model.id,
      modelName: selected.model.name,
      reason: this.explainSelection(selected.model, taskType, estimatedTokens, selected.actualTPM),
      fallbacks
    };
  }
  
  /**
   * Filters models by capabilities
   */
  private filterByCapabilities(
    models: CustomModel[],
    requirements: TaskRequirements
  ): CustomModel[] {
    return models.filter(model => {
      // Web search requirement - STRICT filtering
      if (requirements.supportsWebSearch) {
        const supportsWeb = this.modelSupportsWebSearch(model);
        if (!supportsWeb) return false;
      }
      
      // Multimodal requirement
      if (requirements.supportsMultimodal) {
        const supportsMultimodal = this.modelSupportsMultimodal(model);
        if (!supportsMultimodal) return false;
      }

      // MCP tool calling — filter to models that support function/tool calling
      if (requirements.supportsMCPToolCalling) {
        const supportsTool = this.modelSupportsMCPToolCalling(model);
        if (!supportsTool) return false;
      }
      
      return true;
    });
  }
  
  /**
   * Checks if model supports web search
   */
  private modelSupportsWebSearch(model: CustomModel): boolean {
    // Gemini models support web search via grounding
    if (model.provider === 'gemini') return true;
    
    // Ollama models support web search via @web prefix
    if (model.provider === 'ollama') return true;
    
    // Groq Compound models support web search
    // Updated to match the exact model IDs used in the plugin
    if (model.provider === 'groq') {
      const webSearchModels = [
        'groq/compound',
        'groq/compound-mini'
      ];
      return webSearchModels.some(m => model.id.toLowerCase().includes(m.toLowerCase()));
    }
    
    // OpenRouter: no web search support
    return false;
  }
  
  /**
   * Checks if model supports multimodal
   */
  private modelSupportsMultimodal(model: CustomModel): boolean {
    // Gemini models generally support multimodal
    if (model.provider === 'gemini') {
      const id = model.id.toLowerCase();
      // Exclude obvious non-multimodal models (embeddings, etc.)
      if (id.includes('embed') || id.includes('aqa')) return false;
      return true;
    }
    
    // OpenRouter: check for vision models
    if (model.provider === 'openrouter') {
      const multimodalKeywords = ['vision', 'vl', 'multimodal', 'qwen-2.5-vl'];
      return multimodalKeywords.some(kw => model.id.toLowerCase().includes(kw));
    }
    
    // Ollama: check for vision models
    if (model.provider === 'ollama') {
      const multimodalKeywords = ['llava', 'vision', 'vl', 'minicpm', 'bakllava'];
      return multimodalKeywords.some(kw => model.id.toLowerCase().includes(kw));
    }
    
    // Groq: limited multimodal support
    return false;
  }
  
  /**
   * Checks if model supports MCP tool/function calling.
   * Groq, Gemini, and OpenRouter all support the OpenAI function-calling format.
   * Ollama supports it for models that have tool-calling capability.
   * Models with 'embed', 'embedding', 'prompt-guard', 'scout', 'distill', or 'guard' in their name are excluded.
   */
  private modelSupportsMCPToolCalling(model: CustomModel): boolean {
    const id = model.id.toLowerCase();
    const name = model.name.toLowerCase();

    // Exclusion list for models that technically support the API but are unfit for orchestration
    const exclusionKeywords = [
      'embed', 'embedding', 'prompt-guard', 'scout', 'distill', 
      'guard', 'shield', 'speculative', 'tiny', '1b', '3b'
    ];
    if (exclusionKeywords.some(kw => id.includes(kw) || name.includes(kw))) {
      return false;
    }

    // Groq: all chat models support function calling
    if (model.provider === 'groq') return true;

    // Gemini: all generative models support function calling
    if (model.provider === 'gemini') return true;

    // OpenRouter: passes through to underlying model — assume supported
    if (model.provider === 'openrouter') return true;

    // OpenCode: OpenAI-compatible, typically supports tool calling
    if (model.provider === 'opencode') return true;

    // Ollama: only models that explicitly support tool calling
    if (model.provider === 'ollama') {
      const toolCapableKeywords = [
        'llama3', 'llama-3', 'mistral', 'mixtral', 'qwen', 'qwen2',
        'command-r', 'hermes', 'functionary', 'nexusraven', 'gorilla',
        'phi3', 'phi-3', 'gemma2', 'gemma-2', 'deepseek'
      ];
      return toolCapableKeywords.some(kw => id.includes(kw));
    }

    // Unified/OpenAI-compatible providers (including custom) typically support tool calling
    if (UnifiedProviderManager.getInstance().hasProvider(model.provider)) {
      return true;
    }

    return false;
  }

  /**
   * Explains why a model was selected
   * Now includes actual TPM information
   */
  private explainSelection(
    model: CustomModel,
    taskType: TaskType,
    estimatedTokens: number,
    actualTPM: number
  ): string {
    const ratio = actualTPM > 0 ? actualTPM / estimatedTokens : 0;
    
    // Format tokens for display
    const tokensStr = estimatedTokens > 1000 
      ? `${(estimatedTokens / 1000).toFixed(1)}K` 
      : estimatedTokens.toString();
    
    const tpmStr = actualTPM > 1000
      ? `${(actualTPM / 1000).toFixed(0)}K`
      : actualTPM.toString();
    
    // Task-specific reasons with actual TPM info
    if (taskType === TaskType.BASIC_CHAT && ratio > 10) {
      return `Simple query (${tokensStr} tokens) - using efficient model (${tpmStr} TPM available)`;
    }
    
    if (taskType === TaskType.VAULT_SEARCH) {
      return `Large context (${tokensStr} tokens) - selected model with ${tpmStr} TPM`;
    }
    
    if (taskType === TaskType.FLASH_SEARCH) {
      return `Fast BM25 search (${tokensStr} tokens) - selected model with ${tpmStr} TPM`;
    }
    
    if (taskType === TaskType.WEB_SEARCH) {
      return `Web search enabled - using model with grounding (${tpmStr} TPM)`;
    }
    
    if (taskType === TaskType.WEBPAGE_FETCH) {
      return `Webpage fetch mode - using model with ${tpmStr} TPM`;
    }
    
    if (taskType === TaskType.MULTIMODAL) {
      return `Multimodal input - using vision-capable model (${tpmStr} TPM)`;
    }
    
    if (taskType === TaskType.MCP_TOOL_CALLING) {
      return `MCP tool calling (${tokensStr} tokens) - using tool-capable model with ${tpmStr} TPM`;
    }

    if (ratio < 2) {
      return `High token requirement (${tokensStr} tokens) - using model with ${tpmStr} TPM`;
    }
    
    return `Optimal for ${tokensStr} tokens (${tpmStr} TPM available)`;
  }
  
  /**
   * Checks if a provider has valid authentication configured
   */
  private hasValidProviderAuth(provider: Provider): boolean {
    switch (provider) {
      case 'gemini':
        return this.validateGeminiApiKey(this.settings.geminiApiKey);
      case 'groq':
        return this.validateGroqApiKey(this.settings.groqApiKey);
      case 'openrouter':
        return this.validateOpenRouterApiKey(this.settings.openRouterApiKey);
      case 'opencode':
        return this.validateOpenCodeApiKey(this.settings.openCodeApiKey);
      case 'ollama':
        return this.validateOllamaBaseUrl(this.settings.ollamaBaseUrl);
      case 'nvidia':
        return validateNvidiaApiKey(this.settings.nvidiaApiKey);
      default:
        // Check if it's a custom provider
        if (this.settings.customProviders && this.settings.customProviders.some(p => p.id === provider)) {
          return true;
        }
        return false;
    }
  }
  
  /**
   * Validates Gemini API key
   */
  private validateGeminiApiKey(key: string): boolean {
    if (!key) return false;
    if (key.length < 20) return false;
    return true;
  }
  
  /**
   * Validates Groq API key
   */
  private validateGroqApiKey(key: string): boolean {
    if (!key) return false;
    if (!key.startsWith('gsk_')) return false;
    if (key.length < 20) return false;
    return true;
  }
  
  /**
   * Validates OpenRouter API key
   */
  private validateOpenRouterApiKey(key: string): boolean {
    if (!key) return false;
    if (!key.startsWith('sk-or-')) return false;
    if (key.length < 20) return false;
    return true;
  }

  /**
   * Validates OpenCode API key
   */
  private validateOpenCodeApiKey(key: string): boolean {
    if (!key) return false;
    if (key.length < 10) return false;
    return true;
  }
  
  /**
   * Validates Ollama base URL
   */
  private validateOllamaBaseUrl(url: string): boolean {
    if (!url) return false;
    try {
      const parsedUrl = new URL(url);
      return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    } catch {
      return false;
    }
  }
  
  /**
   * Gets setup message for a provider
   */
  private getProviderSetupMessage(provider: Provider): string {
    switch (provider) {
      case 'gemini':
        return '• Gemini: Add your API key in Settings → AI Assistant → Basic Settings';
      case 'groq':
        return '• Groq: Add your API key (starts with "gsk_") in Settings → AI Assistant → Basic Settings';
      case 'openrouter':
        return '• OpenRouter: Add your API key (starts with "sk-or-") in Settings → AI Assistant → Basic Settings';
      case 'opencode':
        return '• OpenCode Zen: Add your API key in Settings → AI Assistant → Basic Settings';
      case 'ollama':
        return '• Ollama: Configure base URL in Settings → AI Assistant → Basic Settings (default: http://localhost:11434)';
      default:
        return `• ${provider}: Configure in Settings → AI Assistant → Basic Settings`;
    }
  }
}
