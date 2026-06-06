import { App, PluginSettingTab, Setting, Notice, Modal, setIcon, TFile, TFolder, Platform } from 'obsidian';
import { MCPRegistryModal } from './modals/mcpRegistryModal';
import { ModelLatencyModal } from './modals/modelLatencyModal';
import { CustomProviderModal } from './modals/customProviderModal';
import { MCPRegistryEntry } from './mcp/mcpRegistry';
import { validateNvidiaApiKey } from './services/nvidiaService';

// Move Provider type directly into settings.ts
export type Provider = 'gemini' | 'groq' | 'openrouter' | 'opencode' | 'ollama' | 'nvidia' | (string & {});

export interface CustomModel {
  provider: Provider;
  id: string;
  name: string;
  tokenLimit?: number; // Context window size (max tokens per request) - used for context bar display
  requestLimit?: number; // DEPRECATED: Use RateLimitManager with API headers instead
  rank?: number; // Ranking for model priority
  enabled?: boolean; // Whether the model is enabled/visible in selection
  temperature?: number; // Temperature setting for this model (0.0-2.0, default: 0.7)
  topP?: number; // Top P setting for this model (0.0-1.0, default: 0.95)
  lastVerified?: number; // Timestamp of last successful/failed verification
  verificationStatus?: 'verified' | 'failed' | 'unverified'; // Status of verification
  verificationError?: string; // Error message if verification failed
  verificationLatency?: number; // Latency in milliseconds from last verification
  isNew?: boolean; // Whether the model is newly discovered and needs verification
  isFree?: boolean; // Whether the model is free to use (for OpenRouter/etc)
  capabilities?: string[]; // Capabilities of the model (e.g., 'vision', 'thinking')
}

export interface SavedSystemInstruction {
  name: string;
  instructions: string;
  icon?: string; // Lucide icon name chosen by user
}

export interface MCPServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'sse'; // Transport type
  command?: string; // For stdio transport
  args?: string[]; // For stdio transport
  streamUrl?: string; // Optional: local HTTP/SSE endpoint for stdio servers that also expose streaming (e.g. http://localhost:3000/sse)
  url?: string; // For SSE transport (HTTP/HTTPS)
  apiKey?: string; // Optional API key for SSE transport
  env?: Record<string, string>;
  disabled: boolean;
  autoToolSelection?: boolean; // If true, AI decides which tools to use; if false, user manually selects tools
}

export interface CustomProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  enableEmbeddings?: boolean;
}

export interface FeedFolder {
  id: string;
  name: string;
  color: string;
  isCollapsed: boolean;
}

export interface AISettings {
  savedFeeds: { url: string; name: string; color: string; enabled: boolean; folderId?: string; }[];
  feedFolders: FeedFolder[];
  visitedEntries: string[];
  apiKey: string;           // Deprecated, kept for backward compatibility
  geminiApiKey: string;     // Google Gemini API key
  groqApiKey: string;       // Groq API key
  openRouterApiKey: string; // OpenRouter API key
  openCodeApiKey: string;   // OpenCode API key
  ollamaApiKey: string;     // Ollama API key (optional, for remote instances)
  nvidiaApiKey: string;     // NVIDIA API key
  ollamaBaseUrl: string;    // Ollama base URL (default: http://localhost:11434)
  ollamaMode: 'local' | 'cloud'; // Ollama mode toggle (local or cloud)
  provider: Provider;
  model: string;
  // Feature-specific model selections
  aiChatModel: string;
  aiChatProvider: Provider;
  aiTutorModel: string;
  aiTutorProvider: Provider;
  notebookModel: string;
  notebookProvider: Provider;
  saveDirectory: string;
  queryBarHotkey: string;
  chatContextSize: number;  // Added this setting
  rateLimitSeconds: number;  // New setting for API call rate limiting
  // New embedding settings
  embeddingModel: string;
  lastIndexTime: number;
  indexPath: string;
  excludedFolders: string[];  // New setting for excluded folders
  excludedFiles: string[];    // New setting for excluded files
  pdfOutputDirectory: string; // Added PDF output directory
  // DEPRECATED: Use RateLimitManager with API response headers instead
  // Kept for backward compatibility and as fallback when API headers are unavailable
  modelTokenLimits: Record<string, number>;
  embeddingFolderPath: string;
  bookmarkedEntries: any[]; // New setting for bookmarked feed entries; type fixed from ParsedFeedEntry to any
  customModels: CustomModel[]; // New setting for custom models
  modelCache: { // Cache for dynamically fetched models
    gemini?: CustomModel[];
    geminiEmbeddings?: CustomEmbeddingModel[];
    openrouter?: CustomModel[];
    openrouterEmbeddings?: CustomEmbeddingModel[];
    opencode?: CustomModel[];
    ollama?: CustomModel[];
    ollamaEmbeddings?: CustomEmbeddingModel[];
    nvidia?: CustomModel[];
    nvidiaEmbeddings?: CustomEmbeddingModel[];
    groq?: CustomModel[];
    customProviders?: Record<string, CustomModel[]>;
    customProviderEmbeddings?: Record<string, CustomEmbeddingModel[]>;
    lastFetched?: number;
  };
  googleGroundingEnabled: boolean; // New setting for Google Search grounding
  enableThinkingMode: boolean; // New setting for thinking mode
  gemini25ThinkingMode: 'off' | 'dynamic' | 'low' | 'medium' | 'high'; // Gemini 2.5 thinking budget preset
  gemini3ThinkingLevel: 'minimal' | 'low' | 'high'; // Gemini 3.x thinking level
  ollamaThinkingEnabled: boolean; // Header brain toggle for Ollama non-GPT-OSS models
  ollamaGptOssThinkingLevel: 'low' | 'medium' | 'high'; // Header brain level for Ollama GPT-OSS models
  groqThinkingLevel: 'low' | 'medium' | 'high'; // Header brain level for Groq GPT-OSS models
  aiChatHistoryEnabled: boolean; // Enable AI chat session history
  googleCustomSearchApiKey?: string; // Google Custom Search API Key
  googleCustomSearchEngineId?: string; // Google Custom Search Engine ID
  customEmbeddingModels: CustomEmbeddingModel[]; // New setting for custom embedding models
  savedSystemInstructions: SavedSystemInstruction[]; // Saved system instructions collection
  maxVaultSearchResults: number; // Maximum number of vault search results (1-25)
  autoModeEnabled: boolean; // Enable automatic model selection
  showAutoSelectionReason: boolean; // Show reason for auto-selected model
  // BM25 field boost settings
  bm25TitleBoost: number; // Boost for title matches (default: 3.0)
  bm25HeadingBoost: number; // Boost for heading matches (default: 2.0)
  bm25TagBoost: number; // Boost for tag matches (default: 1.5)
  // Index composition tracking
  embeddingIndexedFiles: number; // Number of files with embeddings
  bm25IndexedFiles: number; // Number of files with BM25 index
  // YouTube processing settings
  youtubeProcessingMode: 'transcript' | 'gemini-native'; // YouTube video processing mode
  saveYoutubeTranscripts: boolean; // Toggle to save YouTube transcripts as files
  youtubeTranscriptFolder: string; // Default folder for saving YouTube transcripts
  // Index management
  indexConfigurations: Array<{
    id: string;
    type: 'embedding' | 'bm25';
    name: string;
    model?: string;
    enabled: boolean;
    fileCount: number;
    lastUpdated: number;
    isBuilding?: boolean;
    buildProgress?: number;
    buildError?: string;
    excludedFolders?: string[]; // Per-index folder exclusions (embedding only)
    excludedFiles?: string[];   // Per-index file exclusions (embedding only)
  }>;
  selectedEmbeddingIndexId: string | null;
  selectedBM25IndexId: string | null;
  // Code execution settings
  codeExecutionAutoMode: boolean; // Auto-execute code blocks and auto-fix errors
  // Template settings
  templateFolder: string; // Folder where templates are stored
  // MCP settings
  mcpServers: MCPServerConfig[]; // MCP server configurations
  mcpEnabled: boolean; // Enable MCP support
  mcpAutoConnect: boolean; // Auto-connect MCP servers on app load (if false, user connects manually)
  mcpPrereqsChecked: { node?: boolean; uvx?: boolean }; // Tracks which prereqs have been confirmed installed
  // Wallpaper settings
  chatWallpaperPath: string | null; // Path to wallpaper image for AI chat section
  chatWallpaperOpacity: number; // Opacity of the wallpaper (0-1)
  chatWallpaperResponseOpacity: number; // Opacity of response card with liquid glass (0-1)
  chatWallpaperHeaderOpacity: number; // Opacity of header/input with liquid glass (0-1)
  chatWallpaperEnabled: boolean; // Whether wallpaper is enabled
  customProviders: CustomProviderConfig[]; // New setting for custom providers
  savedConceptMaps: any[];
  savedSlideshows: any[];
}

export const DEFAULT_SETTINGS: AISettings = {
  apiKey: '',              // Deprecated, kept for backward compatibility
  geminiApiKey: '',        // Google Gemini API key
  groqApiKey: '',          // Groq API key
  openRouterApiKey: '',    // OpenRouter API key
  openCodeApiKey: '',      // OpenCode API key
  ollamaApiKey: '',        // Ollama API key (optional, for remote instances)
  nvidiaApiKey: '',        // NVIDIA API key
  ollamaBaseUrl: 'http://localhost:11434', // Default Ollama base URL
  ollamaMode: 'local',     // Default to local mode
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  // Feature-specific model selections (default to main model)
  aiChatModel: 'gemini-2.5-flash',
  aiChatProvider: 'gemini',
  aiTutorModel: 'gemini-2.5-flash',
  aiTutorProvider: 'gemini',
  notebookModel: 'gemini-2.5-flash',
  notebookProvider: 'gemini',
  saveDirectory: '/',
  queryBarHotkey: '',
  chatContextSize: 3,  // Default value
  rateLimitSeconds: 25, // Default to 25 seconds
  // Default embedding settings
  embeddingModel: 'text-embedding-004',
  lastIndexTime: 0,
  indexPath: '.Nexus-LM-data/vault-embeddings/embeddings.bin',
  excludedFolders: [],  // Default to empty array
  excludedFiles: [],    // Default to empty array
  pdfOutputDirectory: '/', // Default value for PDF output directory
  // Default model token limits (per minute input tokens) - Add your models and limits here
  modelTokenLimits: {
    'gemini-2.5-flash': 1000000, // Example limit (check actual API docs)
  },
  embeddingFolderPath: 'ai-tutor-data',
  savedFeeds: [],
  feedFolders: [],
  visitedEntries: [],
  bookmarkedEntries: [], // Default value for bookmarked entries
  savedConceptMaps: [],
  savedSlideshows: [],
customModels: [
    // Gemini models
    { provider: 'gemini', id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tokenLimit: 2500000, requestLimit: 10, enabled: true },
    { provider: 'gemini', id: 'gemini-flash-lite- latest', name: 'Gemini Flash Lite', tokenLimit: 2500000, requestLimit: 10, enabled: true },
    // Groq models
    { provider: 'groq', id: 'groq/compound', name: 'Groq Compound', tokenLimit: 70000, requestLimit: 30, enabled: true },
    { provider: 'groq', id: 'groq/compound-mini', name: 'Groq Compound Mini', tokenLimit: 70000, requestLimit: 30, enabled: true },
    { provider: 'groq', id: 'meta-llama/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick 17B', tokenLimit: 6000, requestLimit: 30, enabled: true },
    { provider: 'groq', id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant', tokenLimit: 6000, requestLimit: 30, enabled: true },
    { provider: 'groq', id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', tokenLimit: 12000, requestLimit: 30, enabled: true },
    { provider: 'groq', id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B', tokenLimit: 30000, requestLimit: 30, enabled: true },
    { provider: 'groq', id: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2 Instruct', tokenLimit: 10000, requestLimit: 60, enabled: true },
    { provider: 'groq', id: 'moonshotai/kimi-k2-instruct-0905', name: 'Kimi K2 Instruct 0905', tokenLimit: 10000, requestLimit: 60, enabled: true },
    { provider: 'groq', id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B', tokenLimit: 8000, requestLimit: 30, enabled: true },
    { provider: 'groq', id: 'openai/gpt-oss-20b', name: 'GPT OSS 20B', tokenLimit: 8000, requestLimit: 30, enabled: true },
    { provider: 'groq', id: 'openai/gpt-oss-safeguard-20b', name: 'GPT OSS Safeguard 20B', tokenLimit: 8000, requestLimit: 30, enabled: true },
    { provider: 'groq', id: 'qwen/qwen3-32b', name: 'Qwen3 32B', tokenLimit: 6000, requestLimit: 60, enabled: true },
  ],
  modelCache: {},
  googleGroundingEnabled: true, // Default to true
  enableThinkingMode: true, // Default to false
  gemini25ThinkingMode: 'dynamic',
  gemini3ThinkingLevel: 'high',
  ollamaThinkingEnabled: false,
  ollamaGptOssThinkingLevel: 'medium',
  groqThinkingLevel: 'medium',
  aiChatHistoryEnabled: true, // Default to on
  googleCustomSearchApiKey: '',
  googleCustomSearchEngineId: '',
  customEmbeddingModels: [
    // Default Gemini embedding model
    { provider: 'gemini', id: 'text-embedding-004', name: 'Gemini Embedding 004', contextWindow: 2048, enabled: true },
    // OpenRouter embedding models
    { provider: 'openrouter', id: 'openai/text-embedding-3-small', name: 'OpenAI Text Embedding 3 Small', dimensions: 1536, contextWindow: 8192, enabled: true, requestsPerMinute: 3000 },
    { provider: 'openrouter', id: 'openai/text-embedding-3-large', name: 'OpenAI Text Embedding 3 Large', dimensions: 3072, contextWindow: 8192, enabled: true, requestsPerMinute: 3000 },
    { provider: 'openrouter', id: 'sentence-transformers/paraphrase-minilm-l6-v2', name: 'Paraphrase MiniLM L6 v2', dimensions: 384, contextWindow: 512, enabled: true, requestsPerMinute: 1000 },
    { provider: 'openrouter', id: 'sentence-transformers/all-minilm-l12-v2', name: 'All MiniLM L12 v2', dimensions: 384, contextWindow: 512, enabled: true, requestsPerMinute: 1000 },
    { provider: 'openrouter', id: 'qwen/qwen3-embedding-0.6b', name: 'Qwen3 Embedding 0.6B', dimensions: 768, contextWindow: 8192, enabled: true, requestsPerMinute: 1000 },
    // Ollama embedding models
    { provider: 'ollama', id: 'nomic-embed-text', name: 'Nomic Embed Text', dimensions: 768, contextWindow: 8192, enabled: true, requestsPerMinute: 1000 },
    { provider: 'ollama', id: 'mxbai-embed-large', name: 'MixedBread AI Embed Large', dimensions: 1024, contextWindow: 512, enabled: true, requestsPerMinute: 1000 },
    { provider: 'ollama', id: 'all-minilm', name: 'All MiniLM (Ollama)', dimensions: 384, contextWindow: 256, enabled: true, requestsPerMinute: 1000 },
    // NVIDIA NIM embedding models
    { provider: 'nvidia', id: 'nvidia/nv-embedqa-e5-v5', name: 'NVIDIA NV-Embed QA E5 V5', dimensions: 1024, contextWindow: 512, enabled: true, requestsPerMinute: 1000 },
    { provider: 'nvidia', id: 'nvidia/llama-nemotron-embed-1b-v2', name: 'NVIDIA Llama Nemotron Embed 1B', dimensions: 1024, contextWindow: 8192, enabled: true, requestsPerMinute: 1000 },
    { provider: 'nvidia', id: 'nvidia/llama-3.2-nv-embedqa-1b-v2', name: 'NVIDIA Llama 3.2 Embed QA 1B', dimensions: 768, contextWindow: 8192, enabled: true, requestsPerMinute: 1000 }
  ], // Default value for custom embedding models
  savedSystemInstructions: [], // Default value for saved system instructions
  maxVaultSearchResults: 8, // Default to 8 results
  autoModeEnabled: false, // Default to manual model selection
  showAutoSelectionReason: true, // Default to showing selection reason
  // BM25 field boost defaults
  bm25TitleBoost: 3.0,
  bm25HeadingBoost: 2.0,
  bm25TagBoost: 1.5,
  // Index composition defaults
  embeddingIndexedFiles: 0,
  bm25IndexedFiles: 0,
  // YouTube processing defaults
  youtubeProcessingMode: 'transcript', // Default to transcript mode (faster)
  saveYoutubeTranscripts: true, // Default to saving transcripts
  youtubeTranscriptFolder: 'YouTube Transcripts', // Default folder for transcripts
  // Index management defaults
  indexConfigurations: [
    {
      id: 'default-embedding',
      type: 'embedding',
      name: 'Default Embedding Index',
      model: 'text-embedding-004',
      enabled: true,
      fileCount: 0,
      lastUpdated: 0
    },
    {
      id: 'default-bm25',
      type: 'bm25',
      name: 'Default BM25 Index',
      enabled: true,
      fileCount: 0,
      lastUpdated: 0
    }
  ],
  selectedEmbeddingIndexId: 'default-embedding',
  selectedBM25IndexId: 'default-bm25',
  // Code execution defaults
  codeExecutionAutoMode: false, // Default to manual (user-triggered) mode
  // Template defaults
  templateFolder: '',
  // MCP defaults
  mcpServers: [],
  mcpEnabled: true,
  mcpAutoConnect: true, // Default: auto-connect on app load
  mcpPrereqsChecked: {},
  chatWallpaperPath: null,
  chatWallpaperOpacity: 0.5,
  chatWallpaperResponseOpacity: 0.25,
  chatWallpaperHeaderOpacity: 0.2,
  chatWallpaperEnabled: false,
  customProviders: [],
};

export interface CustomEmbeddingModel {
  id: string;
  name: string;
  dimensions?: number; // Optional dimensions for the embedding model
  contextWindow?: number; // Maximum input tokens supported by the model
  provider: Provider; // Add provider field
  enabled?: boolean; // Whether the embedding model is enabled/visible in selection
  requestsPerMinute?: number; // Rate limit for API requests per minute (internal use)
  lastVerified?: number; // Timestamp of last successful/failed verification
  verificationStatus?: 'verified' | 'failed' | 'unverified'; // Status of verification
  verificationError?: string; // Error message if verification failed
  isNew?: boolean; // Whether the model is newly discovered and needs verification
  isFree?: boolean; // Whether the model is free to use (for OpenRouter/etc)
}

/**
 * Validates a Groq API key.
 * Groq API keys must start with "gsk_" prefix and have a minimum length of 20 characters.
 * @param key - The API key to validate
 * @returns true if the key is valid, false otherwise
 */
export function validateGroqApiKey(key: string): boolean {
  if (!key) return false;
  if (!key.startsWith('gsk_')) return false;
  if (key.length < 20) return false;
  return true;
}

/**
 * Validates a Gemini API key.
 * Gemini API keys must have a minimum length of 20 characters.
 * @param key - The API key to validate
 * @returns true if the key is valid, false otherwise
 */
export function validateGeminiApiKey(key: string): boolean {
  if (!key) return false;
  if (key.length < 20) return false;
  return true;
}

/**
 * Validates an OpenRouter API key.
 * OpenRouter API keys must start with "sk-or-" prefix and have a minimum length of 20 characters.
 * @param key - The API key to validate
 * @returns true if the key is valid, false otherwise
 */
export function validateOpenRouterApiKey(key: string): boolean {
  if (!key) return false;
  if (!key.startsWith('sk-or-')) return false;
  if (key.length < 20) return false;
  return true;
}

/**
 * Validates an OpenCode API key.
 * @param key - The API key to validate
 * @returns true if the key is valid, false otherwise
 */
export function validateOpenCodeApiKey(key: string): boolean {
  if (!key) return false;
  if (key.length < 10) return false;
  return true;
}

/**
 * Validates an Ollama base URL.
 * Ollama base URL should be a valid HTTP/HTTPS URL.
 * @param url - The base URL to validate
 * @returns true if the URL is valid, false otherwise
 */
export function validateOllamaBaseUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch {
    return false;
  }
}


/**
 * Interface for a model option in the model menu
 */
export interface ModelOption {
  id: string;
  name: string;
  provider: Provider;
  capabilities?: string[];
}

/**
 * Interface for a group of models by provider
 */
export interface ModelMenuGroup {
  provider: Provider;
  label: string;
  models: ModelOption[];
}

/**
 * Gets all models grouped by provider.
 * Only includes models that the user has added and enabled in settings.
 * For Gemini, includes default model as fallback if no custom models are configured.
 * 
 * @param settings - The AI settings containing custom models
 * @returns An array of model groups, each containing models for a specific provider
 */
export function getModelsGroupedByProvider(settings: AISettings): ModelMenuGroup[] {
  const groups: ModelMenuGroup[] = [];

  // Gemini models group - only user-configured models
  const geminiCustomModels = settings.customModels
    .filter(m => m.provider === 'gemini' && m.enabled !== false)
    .map(m => ({ id: m.id, name: m.name, provider: m.provider as Provider, capabilities: m.capabilities }));

  if (geminiCustomModels.length > 0) {
    groups.push({
      provider: 'gemini',
      label: 'Google Gemini',
      models: geminiCustomModels
    });
  }

  // Groq models group - only user-configured models (no defaults)
  const groqModels: ModelOption[] = settings.customModels
    .filter(m => m.provider === 'groq' && m.enabled !== false)
    .map(m => ({ id: m.id, name: m.name, provider: m.provider as Provider }));
  
  if (groqModels.length > 0) {
    groups.push({
      provider: 'groq',
      label: 'Groq',
      models: groqModels
    });
  }

  // OpenRouter models group - only user-configured models (no defaults)
  const openRouterModels: ModelOption[] = settings.customModels
    .filter(m => m.provider === 'openrouter' && m.enabled !== false)
    .map(m => ({ id: m.id, name: m.name, provider: m.provider as Provider }));
  
  if (openRouterModels.length > 0) {
    groups.push({
      provider: 'openrouter',
      label: 'OpenRouter',
      models: openRouterModels
    });
  }

  // Ollama models group - only user-configured models (no defaults)
  const ollamaModels: ModelOption[] = settings.customModels
    .filter(m => m.provider === 'ollama' && m.enabled !== false)
    .map(m => ({ id: m.id, name: m.name, provider: m.provider as Provider, capabilities: m.capabilities }));
  
  if (ollamaModels.length > 0) {
    groups.push({
      provider: 'ollama',
      label: 'Ollama',
      models: ollamaModels
    });
  }

  // OpenCode models group - only user-configured models (no defaults)
  const openCodeModels: ModelOption[] = settings.customModels
    .filter(m => m.provider === 'opencode' && m.enabled !== false)
    .map(m => ({ id: m.id, name: m.name, provider: m.provider as Provider }));
  
  if (openCodeModels.length > 0) {
    groups.push({
      provider: 'opencode',
      label: 'OpenCode Zen',
      models: openCodeModels
    });
  }

  // NVIDIA models group - only user-configured models (no defaults)
  const nvidiaModels: ModelOption[] = settings.customModels
    .filter(m => m.provider === 'nvidia' && m.enabled !== false)
    .map(m => ({ id: m.id, name: m.name, provider: m.provider as Provider }));
  
  if (nvidiaModels.length > 0) {
    groups.push({
      provider: 'nvidia',
      label: 'NVIDIA',
      models: nvidiaModels
    });
  }

  // Add custom providers
  if (settings.customProviders) {
    settings.customProviders.forEach(cp => {
      const customModels: ModelOption[] = settings.customModels
        .filter(m => m.provider === cp.id && m.enabled !== false)
        .map(m => ({ id: m.id, name: m.name, provider: m.provider as Provider }));
      
      if (customModels.length > 0) {
        groups.push({
          provider: cp.id as Provider,
          label: cp.name,
          models: customModels
        });
      }
    });
  }

  return groups;
}

/**
 * Gets the display name for a model ID.
 * Searches through default models and custom models.
 *
 * @param modelId - The model ID to look up
 * @param settings - The AI settings containing custom models
 * @param provider - Optional: The provider to ensure the correct model instance is found
 * @returns The display name for the model, or the model ID if not found
 */
export function getModelDisplayName(modelId: string, settings: AISettings, provider?: Provider): string {
  // Handle deprecated model IDs - redirect to current model
  const deprecatedModels: Record<string, string> = {
    'gemini-2.0-flash': 'gemini-2.5-flash',
    'gemini-2.0-flash-exp': 'gemini-2.5-flash',
    'gemini-2.0-flash-thinking': 'gemini-2.5-flash'
  };

  const actualModelId = deprecatedModels[modelId] || modelId;

  // Check custom models - prioritize provider if specified
  const customModel = provider
    ? settings.customModels.find(m => m.id === actualModelId && m.provider === provider)
    : settings.customModels.find(m => m.id === actualModelId);

  if (customModel) return customModel.name;

  // Return the ID if no name found
  return actualModelId;
}
/**
 * Gets the provider for a given model ID.
 * Searches through default models and custom models.
 * 
 * @param modelId - The model ID to look up
 * @param settings - The AI settings containing custom models
 * @param preferredProvider - Optional: The provider to prioritize if multiple match
 * @returns The provider for the model, or the current provider setting if not found
 */
export function getProviderForModel(modelId: string, settings: AISettings, preferredProvider?: Provider): Provider {
  // 1. If a preferred provider is specified, try to find an enabled model there first
  if (preferredProvider) {
    const exactMatch = settings.customModels.find(m => 
      m.id === modelId && 
      m.provider === preferredProvider && 
      m.enabled !== false
    );
    if (exactMatch) return exactMatch.provider;
  }

  // 2. Check enabled custom models
  const customModel = settings.customModels.find(m => m.id === modelId && m.enabled !== false);
  if (customModel) return customModel.provider;

  // Fallback: If no enabled model found, check disabled custom models
  const disabledModel = settings.customModels.find(m => m.id === modelId);
  if (disabledModel) return disabledModel.provider;

  // Return current provider if model not found
  return settings.provider;
}

/**
 * Gets the provider for a given embedding model ID.
 * Searches through custom embedding models and default embedding models.
 * 
 * @param modelId - The embedding model ID to look up
 * @param settings - The AI settings containing custom embedding models
 * @returns The provider for the embedding model, or 'gemini' if not found
 */
export function getProviderForEmbeddingModel(modelId: string, settings: AISettings): Provider {
  // 1. Check custom embedding models in settings
  const customModel = settings.customEmbeddingModels?.find(m => m.id === modelId);
  if (customModel) return customModel.provider;

  // 2. Check default embedding models in DEFAULT_SETTINGS
  const defaultModel = DEFAULT_SETTINGS.customEmbeddingModels.find(m => m.id === modelId);
  if (defaultModel) return defaultModel.provider;

  // 3. Fallback for common model ID patterns if not explicitly found
  if (modelId.startsWith('nvidia/')) return 'nvidia';
  if (modelId.startsWith('openai/')) return 'openrouter';
  if (modelId.startsWith('google/') || modelId.startsWith('gemini-')) return 'gemini';

  // Default to gemini
  return 'gemini';
}

/**
 * Validates an API key based on the provider.
 * @param key - The API key to validate
 * @param provider - The provider type ('gemini', 'groq', 'openrouter', or 'ollama')
 * @returns true if the key is valid for the given provider, false otherwise
 */
export function validateApiKey(key: string, provider: Provider): boolean {
  if (provider === 'groq') {
    return validateGroqApiKey(key);
  }
  if (provider === 'openrouter') {
    return validateOpenRouterApiKey(key);
  }
  if (provider === 'opencode') {
    return validateOpenCodeApiKey(key);
  }
  if (provider === 'ollama') {
    // Ollama API key is optional (for remote instances)
    return true;
  }
  if (provider === 'nvidia') {
    return validateNvidiaApiKey(key);
  }
  if (provider === 'gemini') {
    return validateGeminiApiKey(key);
  }
  // For custom providers or any other provider, just ensure it's not empty
  return key.length > 0;
}

/**
 * Gets the temperature setting for a model.
 * Returns the model's custom temperature if set, otherwise returns the default (0.7).
 * @param modelId - The model ID to look up
 * @param settings - The AI settings containing custom models
 * @param provider - Optional: The provider to ensure the correct model instance is found
 * @returns The temperature value for the model
 */
export function getModelTemperature(modelId: string, settings: AISettings, provider?: Provider): number {
  const customModel = provider 
    ? settings.customModels.find(m => m.id === modelId && m.provider === provider)
    : settings.customModels.find(m => m.id === modelId);
  return customModel?.temperature ?? 0.7;
}

/**
 * Gets the top_p setting for a model.
 * Returns the model's custom top_p if set, otherwise returns the default (0.95).
 * @param modelId - The model ID to look up
 * @param settings - The AI settings containing custom models
 * @param provider - Optional: The provider to ensure the correct model instance is found
 * @returns The top_p value for the model
 */
export function getModelTopP(modelId: string, settings: AISettings, provider?: Provider): number {
  const customModel = provider 
    ? settings.customModels.find(m => m.id === modelId && m.provider === provider)
    : settings.customModels.find(m => m.id === modelId);
  return customModel?.topP ?? 0.95;
}

function isGemini25Model(modelId: string): boolean {
  return modelId.startsWith('gemini-2.5');
}

function isGemini3Model(modelId: string): boolean {
  return modelId.startsWith('gemini-3');
}

export function getGeminiThinkingConfig(modelId: string, settings: AISettings): { thinkingConfig: any } | undefined {
  if (!settings.enableThinkingMode || !modelId.startsWith('gemini')) return undefined;

  if (isGemini25Model(modelId)) {
    const mode = settings.gemini25ThinkingMode || 'dynamic';
    if (mode === 'off') return { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } };
    if (mode === 'low') return { thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } };
    if (mode === 'medium') return { thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } };
    if (mode === 'high') return { thinkingConfig: { thinkingBudget: 24576, includeThoughts: true } };
    return { thinkingConfig: { thinkingBudget: -1, includeThoughts: true } };
  }

  if (isGemini3Model(modelId)) {
    return { thinkingConfig: { thinkingLevel: settings.gemini3ThinkingLevel || 'high', includeThoughts: true } };
  }

  return undefined;
}

/**
 * Returns a safe max_tokens value for a Groq (or similar TPM-limited) request.
 *
 * tokenLimit in customModels IS the TPM ceiling (tokens per minute) for the model.
 * The API enforces input+output staying within this limit itself — we must not
 * pre-subtract input tokens or add buffers on top of it. TPM is the only filter.
 *
 * @param modelId - The model ID to look up
 * @param settings - The AI settings containing custom models with tokenLimit
 * @param messages - Unused, kept for API compatibility
 * @param defaultMax - The desired max output tokens (default 8192)
 * @param provider - Optional: The provider to ensure the correct model instance is found
 * @returns tokenLimit if configured, otherwise defaultMax
 */
export function getSafeMaxTokens(
  modelId: string,
  settings: AISettings,
  messages: { role: string; content: string }[],
  defaultMax: number = 8192,
  provider?: Provider
): number {
  const customModel = provider
    ? settings.customModels?.find(m => m.id === modelId && m.provider === provider)
    : settings.customModels?.find(m => m.id === modelId);
  const tokenLimit = customModel?.tokenLimit;

  // If no token limit configured, return the default
  if (!tokenLimit || tokenLimit <= 0) return defaultMax;

  // TPM is the only filter — return the lesser of defaultMax and tokenLimit.
  // No input-token subtraction or overhead buffers: the API enforces the limit itself.
  return Math.min(defaultMax, tokenLimit);
}

/**
 * Migrates settings from older versions to the current format.
 * This function handles backward compatibility for existing users.
 * 
 * Migration logic:
 * - If apiKey exists but geminiApiKey is empty, and provider is 'gemini' (or not set),
 *   migrate apiKey to geminiApiKey
 * - If apiKey exists but groqApiKey is empty, and provider is 'groq',
 *   migrate apiKey to groqApiKey
 * - If customModels is empty, populate with default models
 * 
 * @param settings - The settings object to migrate
 * @returns The migrated settings object with a flag indicating if migration occurred
 */
export function migrateSettings(settings: AISettings): { settings: AISettings; migrated: boolean } {
  let migrated = false;
  
  // Ensure provider has a valid value (default to 'gemini' for backward compatibility)
  const validProviders: Provider[] = ['gemini', 'groq', 'openrouter', 'opencode', 'ollama', 'nvidia'];
  if (!settings.provider || !validProviders.includes(settings.provider)) {
    settings.provider = 'gemini';
    migrated = true;
  }
  
  // Migrate legacy apiKey to provider-specific key
  if (settings.apiKey && settings.apiKey.length > 0) {
    // If provider is gemini and geminiApiKey is not set, migrate
    if (settings.provider === 'gemini' && (!settings.geminiApiKey || settings.geminiApiKey.length === 0)) {
      settings.geminiApiKey = settings.apiKey;
      migrated = true;
    }
    // If provider is groq and groqApiKey is not set, migrate
    else if (settings.provider === 'groq' && (!settings.groqApiKey || settings.groqApiKey.length === 0)) {
      settings.groqApiKey = settings.apiKey;
      migrated = true;
    }
    // If provider is openrouter and openRouterApiKey is not set, migrate
    else if (settings.provider === 'openrouter' && (!settings.openRouterApiKey || settings.openRouterApiKey.length === 0)) {
      settings.openRouterApiKey = settings.apiKey;
      migrated = true;
    }
  }
  
  // Ensure all API key fields exist (for very old settings)
  if (settings.geminiApiKey === undefined) {
    settings.geminiApiKey = '';
    migrated = true;
  }
  if (settings.groqApiKey === undefined) {
    settings.groqApiKey = '';
    migrated = true;
  }
  if (settings.openRouterApiKey === undefined) {
    settings.openRouterApiKey = '';
    migrated = true;
  }
  if (settings.nvidiaApiKey === undefined) {
    settings.nvidiaApiKey = '';
    migrated = true;
  }
  
// Populate default models if customModels is empty or undefined (Gemini + Groq only)
  if (!settings.customModels || settings.customModels.length === 0) {
    settings.customModels = DEFAULT_SETTINGS.customModels;
    migrated = true;
  }

  // Initialize modelCache if not present
  if (!settings.modelCache) {
    settings.modelCache = {};
    migrated = true;
  }

  // Initialize customProviders if not present
  if (!settings.customProviders) {
    settings.customProviders = [];
    migrated = true;
  }
  
  // Populate default embedding models and merge new ones
  if (!settings.customEmbeddingModels || settings.customEmbeddingModels.length === 0) {
    settings.customEmbeddingModels = DEFAULT_SETTINGS.customEmbeddingModels;
    migrated = true;
  } else {
    // Merge missing default models into existing list
    const existingModelIds = new Set(settings.customEmbeddingModels.map(m => m.id));
    const newModels = DEFAULT_SETTINGS.customEmbeddingModels.filter(m => !existingModelIds.has(m.id));
    if (newModels.length > 0) {
      settings.customEmbeddingModels = [...settings.customEmbeddingModels, ...newModels];
      migrated = true;
    }
  }

  // Add requestsPerMinute to existing embedding models if missing
  if (settings.customEmbeddingModels && settings.customEmbeddingModels.length > 0) {
    // Known context windows for default embedding models
    const knownContextWindows: Record<string, number> = {
      'text-embedding-004': 2048,
      'openai/text-embedding-3-small': 8192,
      'openai/text-embedding-3-large': 8192,
      'sentence-transformers/paraphrase-minilm-l6-v2': 512,
      'sentence-transformers/all-minilm-l12-v2': 512,
      'qwen/qwen3-embedding-0.6b': 8192,
      'nomic-embed-text': 8192,
      'mxbai-embed-large': 512,
      'all-minilm': 256,
      'nvidia/nv-embedqa-e5-v5': 512,
      'nvidia/llama-nemotron-embed-1b-v2': 8192,
      'nvidia/llama-3.2-nv-embedqa-1b-v2': 8192,
    };
    settings.customEmbeddingModels.forEach((model: CustomEmbeddingModel) => {
      if (model.requestsPerMinute === undefined) {
        model.requestsPerMinute = 1500; // Default to 1500 RPM
        migrated = true;
      }
      // Add provider field to existing embedding models (backward compatibility)
      if (model.provider === undefined) {
        model.provider = 'gemini'; // Default to gemini for existing models
        migrated = true;
      }
      // Add contextWindow for known models if missing
      if (model.contextWindow === undefined && knownContextWindows[model.id]) {
        model.contextWindow = knownContextWindows[model.id];
        migrated = true;
      }
    });
  }
  
  // Migrate ollamaMode for existing users
  if (settings.ollamaMode === undefined) {
    // Detect mode based on current URL
    if (settings.ollamaBaseUrl && settings.ollamaBaseUrl.includes('ollama.com')) {
      settings.ollamaMode = 'cloud';
    } else {
      settings.ollamaMode = 'local';
    }
    migrated = true;
  }
  
  // Migrate to feature-specific model selections
  if (!settings.aiChatModel || !settings.aiTutorModel || !settings.notebookModel) {
    // Use current model/provider as default for all features
    settings.aiChatModel = settings.model || 'gemini-2.5-flash';
    settings.aiChatProvider = settings.provider || 'gemini';
    settings.aiTutorModel = settings.model || 'gemini-2.5-flash';
    settings.aiTutorProvider = settings.provider || 'gemini';
    settings.notebookModel = settings.model || 'gemini-2.5-flash';
    settings.notebookProvider = settings.provider || 'gemini';
    migrated = true;
  }
  
  // Ensure ollamaBaseUrl exists
  if (!settings.ollamaBaseUrl) {
    settings.ollamaBaseUrl = 'http://localhost:11434';
    migrated = true;
  }
  
  // Ensure ollamaApiKey exists
  if (settings.ollamaApiKey === undefined) {
    settings.ollamaApiKey = '';
    migrated = true;
  }

  // Initialize feedFolders and migrate existing feeds if necessary
  if (!settings.feedFolders || settings.feedFolders.length === 0) {
    settings.feedFolders = [
      { id: 'general', name: 'General', color: '#abcdef', isCollapsed: false }
    ];
    migrated = true;
  }

  // Ensure all saved feeds have a folderId
  if (settings.savedFeeds && settings.savedFeeds.length > 0) {
    settings.savedFeeds.forEach(feed => {
      if (!feed.folderId) {
        feed.folderId = 'general';
        migrated = true;
      }
    });
  }

  // Ensure Ollama thinking UI state fields exist
  if (settings.ollamaThinkingEnabled === undefined) {
    // Default to disabled for Ollama unless user explicitly enables it.
    settings.ollamaThinkingEnabled = false;
    migrated = true;
  }
  if (settings.ollamaGptOssThinkingLevel === undefined) {
    settings.ollamaGptOssThinkingLevel = 'medium';
    migrated = true;
  }
  if (settings.groqThinkingLevel === undefined) {
    settings.groqThinkingLevel = 'medium';
    migrated = true;
  }

  if (settings.gemini25ThinkingMode === undefined) {
    settings.gemini25ThinkingMode = 'dynamic';
    migrated = true;
  }
  if (settings.gemini3ThinkingLevel === undefined) {
    settings.gemini3ThinkingLevel = 'high';
    migrated = true;
  }
  
  // Migrate deprecated gemini-2.0-flash to gemini-2.5-flash
  const deprecatedModels: Record<string, string> = {
    'gemini-2.0-flash': 'gemini-2.5-flash',
    'gemini-2.0-flash-exp': 'gemini-2.5-flash',
    'gemini-2.0-flash-thinking': 'gemini-2.5-flash'
  };
  
  // Update main model
  if (settings.model && deprecatedModels[settings.model]) {
    settings.model = deprecatedModels[settings.model];
    migrated = true;
  }
  
  // Update feature-specific models
  if (settings.aiChatModel && deprecatedModels[settings.aiChatModel]) {
    settings.aiChatModel = deprecatedModels[settings.aiChatModel];
    migrated = true;
  }
  
  if (settings.aiTutorModel && deprecatedModels[settings.aiTutorModel]) {
    settings.aiTutorModel = deprecatedModels[settings.aiTutorModel];
    migrated = true;
  }
  
  if (settings.notebookModel && deprecatedModels[settings.notebookModel]) {
    settings.notebookModel = deprecatedModels[settings.notebookModel];
    migrated = true;
  }
  
  return { settings, migrated };
}

export class AISettingTab extends PluginSettingTab {
  private expandedSections: Set<string> = new Set();
  constructor(
    app: App,
    private plugin: any  // Change type to any to break circular dependency
  ) {
    super(app, plugin);
  }

  validateApiKey(key: string, provider: Provider): boolean {
    return validateApiKey(key, provider);
  }

  validatePath(path: string): boolean {
    if (!path) return false;
    // Remove leading/trailing slashes and spaces
    path = path.trim().replace(/^\/+|\/+$/g, '');
    return path.length > 0 && !path.includes('..') && !path.includes('\\\\');
  }

  hasApiKeyForProvider(provider: Provider): boolean {
    if (provider === 'groq') {
      return !!this.plugin.settings.groqApiKey && this.plugin.settings.groqApiKey.length > 0;
    } else if (provider === 'openrouter') {
      return !!this.plugin.settings.openRouterApiKey && this.plugin.settings.openRouterApiKey.length > 0;
    } else if (provider === 'opencode') {
      return !!this.plugin.settings.openCodeApiKey && this.plugin.settings.openCodeApiKey.length > 0;
    } else if (provider === 'ollama') {
      // Ollama doesn't require API key for local instances, always return true
      return true;
    } else if (provider === 'nvidia') {
      return !!this.plugin.settings.nvidiaApiKey && this.plugin.settings.nvidiaApiKey.length > 0;
    } else if (this.plugin.settings.customProviders?.some((p: any) => p.id === provider)) {
      const cp = this.plugin.settings.customProviders.find((p: any) => p.id === provider);
      return !!cp?.apiKey && cp.apiKey.length > 0;
    } else {
      return !!this.plugin.settings.geminiApiKey && this.plugin.settings.geminiApiKey.length > 0;
    }
  }

  private currentTab: string = 'basic';

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    
    // Create tab navigation
    const tabNav = containerEl.createDiv({ cls: 'settings-tab-nav' });
    
    const tabs = [
      { id: 'basic', label: 'Basic' },
      { id: 'vault', label: 'Vault chat' },
      { id: 'tools', label: 'Tools' },
      { id: 'misc', label: 'Miscellaneous' },
      { id: 'support', label: '\u2764\uFE0F Support' }
    ];

    tabs.forEach(tab => {
      const tabBtn = tabNav.createEl('button', {
        cls: `settings-tab-btn ${this.currentTab === tab.id ? 'active' : ''}`,
        text: tab.label
      });
      
      tabBtn.addEventListener('click', () => {
        this.currentTab = tab.id;
        this.display();
      });
    });

    // Create tab content container
    const tabContent = containerEl.createDiv({ cls: 'settings-tab-content' });

    // Render the active tab
    switch (this.currentTab) {
      case 'basic':
        this.renderBasicTab(tabContent);
        break;
      case 'vault':
        this.renderVaultSearchTab(tabContent);
        break;
      case 'tools':
        this.renderToolsTab(tabContent);
        break;
      case 'misc':
        this.renderMiscTab(tabContent);
        break;
      case 'support':
        this.renderSupportTab(tabContent);
        break;
    }
  }

  private renderBasicTab(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('API configuration').setHeading();

    new Setting(containerEl)
      .setName('AI provider')
      .setDesc('Select the AI provider to use for generating responses')
      .addDropdown(drop => {
        drop.addOption('gemini', 'Google Gemini')
           .addOption('groq', 'Groq')
           .addOption('openrouter', 'OpenRouter')
           .addOption('opencode', 'OpenCode Zen')
           .addOption('ollama', 'Ollama')
           .addOption('nvidia', 'NVIDIA');
        
        // Add custom providers to the dropdown
        if (this.plugin.settings.customProviders) {
          this.plugin.settings.customProviders.forEach((p: CustomProviderConfig) => {
            drop.addOption(p.id, p.name);
          });
        }

        drop.setValue(this.plugin.settings.provider)
           .onChange(async val => {
             this.plugin.settings.provider = val as Provider;
             // Default Ollama to Cloud mode when selected as provider
             if (val === 'ollama') {
               this.plugin.settings.ollamaMode = 'cloud';
               this.plugin.settings.ollamaBaseUrl = 'https://ollama.com';
             }
             this.display(); // Refresh to update model options and API key field
             await this.plugin.saveSettings();

             // Refresh models from providers when provider is changed
             await this.plugin.refreshModelsFromProviders();
           });
      });

    // Provider-specific API key input
    const currentProvider = this.plugin.settings.provider;
    let apiKeyPlaceholder: string;
    let apiKeyDesc: string;
    let currentApiKey: string;

    if (currentProvider === 'groq') {
      apiKeyPlaceholder = 'gsk_...';
      apiKeyDesc = 'Enter your Groq API key (starts with gsk_)';
      currentApiKey = this.plugin.settings.groqApiKey;
    } else if (currentProvider === 'openrouter') {
      apiKeyPlaceholder = 'sk-or-...';
      apiKeyDesc = 'Enter your OpenRouter API key (starts with sk-or-)';
      currentApiKey = this.plugin.settings.openRouterApiKey;
    } else if (currentProvider === 'opencode') {
      apiKeyPlaceholder = 'Enter OpenCode Zen API key';
      apiKeyDesc = 'Enter your OpenCode Zen API key';
      currentApiKey = this.plugin.settings.openCodeApiKey;
    } else if (currentProvider === 'ollama') {
      apiKeyPlaceholder = 'Required for cloud API';
      apiKeyDesc = 'Enter your Ollama API key. Required for cloud models and web search/fetch features. Optional for local models (chat only).';
      currentApiKey = this.plugin.settings.ollamaApiKey;
    } else if (currentProvider === 'nvidia') {
      apiKeyPlaceholder = 'nvapi-...';
      apiKeyDesc = 'Enter your NVIDIA API key (starts with nvapi-)';
      currentApiKey = this.plugin.settings.nvidiaApiKey;
    } else if (this.plugin.settings.customProviders?.some((p: CustomProviderConfig) => p.id === currentProvider)) {
      const cp = this.plugin.settings.customProviders.find((p: CustomProviderConfig) => p.id === currentProvider)!;
      apiKeyPlaceholder = 'Enter API key';
      apiKeyDesc = `Enter your ${cp.name} API key`;
      currentApiKey = cp.apiKey;
    } else {
      apiKeyPlaceholder = 'Enter Google AI Studio key';
      apiKeyDesc = 'Enter your Google AI Studio API key';
      currentApiKey = this.plugin.settings.geminiApiKey;
    }

    const providerDisplayName = currentProvider === 'groq' ? 'Groq' : 
                                currentProvider === 'openrouter' ? 'OpenRouter' : 
                                currentProvider === 'opencode' ? 'OpenCode Zen' :
                                currentProvider === 'ollama' ? 'Ollama' :
                                currentProvider === 'nvidia' ? 'NVIDIA' : 
                                (this.plugin.settings.customProviders?.find((p: CustomProviderConfig) => p.id === currentProvider)?.name || 'Google Gemini');

    const apiSetting = new Setting(containerEl)
      .setName(`${providerDisplayName} API key`)
      .setDesc(apiKeyDesc)
      .addText(text => {
        text.setPlaceholder(apiKeyPlaceholder)
           .setValue(currentApiKey)
           .onChange(async val => {
              // Allow empty string for deletion
              if (val === '' || this.validateApiKey(val, this.plugin.settings.provider)) {
                // Store in provider-specific field
                if (this.plugin.settings.provider === 'groq') {
                  this.plugin.settings.groqApiKey = val;
                } else if (this.plugin.settings.provider === 'openrouter') {
                  this.plugin.settings.openRouterApiKey = val;
                } else if (this.plugin.settings.provider === 'opencode') {
                  this.plugin.settings.openCodeApiKey = val;
                } else if (this.plugin.settings.provider === 'ollama') {                  this.plugin.settings.ollamaApiKey = val;
                } else if (this.plugin.settings.provider === 'nvidia') {
                  this.plugin.settings.nvidiaApiKey = val;
                } else if (this.plugin.settings.customProviders?.some((p: CustomProviderConfig) => p.id === this.plugin.settings.provider)) {
                  const cp = this.plugin.settings.customProviders.find((p: CustomProviderConfig) => p.id === this.plugin.settings.provider)!;
                  cp.apiKey = val;
                } else {
                  this.plugin.settings.geminiApiKey = val;
                }
                
await this.plugin.saveSettings();
 if (val === '') {
   new Notice('API key deleted successfully');

   // Depopulate models if API key is removed
   const provider = this.plugin.settings.provider;

   // Initialize modelCache if it doesn't exist
   if (!this.plugin.settings.modelCache) {
       this.plugin.settings.modelCache = {};
   }

   // Chat Models: Gemini, Opencode, Openrouter, Ollama, Nvidia, Groq
   if (true) {
       // Force filter ALL models for this provider regardless of status
       this.plugin.settings.customModels = this.plugin.settings.customModels.filter((m: CustomModel) => m.provider !== provider);

       // Clear from cache to prevent immediate re-population
       if (provider === 'gemini') this.plugin.settings.modelCache.gemini = [];
       if (provider === 'openrouter') this.plugin.settings.modelCache.openrouter = [];
       if (provider === 'opencode') this.plugin.settings.modelCache.opencode = [];
       if (provider === 'ollama') this.plugin.settings.modelCache.ollama = [];
       if (provider === 'nvidia') this.plugin.settings.modelCache.nvidia = [];
       if (provider === 'groq') this.plugin.settings.modelCache.groq = [];
   }

   // Embedding Models: Gemini, Openrouter, Nvidia, Opencode (Except Ollama)
   if (provider !== 'ollama') {
       // Force filter ALL embedding models for this provider
       this.plugin.settings.customEmbeddingModels = this.plugin.settings.customEmbeddingModels.filter((m: CustomEmbeddingModel) => m.provider !== provider);

       // Clear from cache
       if (provider === 'gemini') this.plugin.settings.modelCache.geminiEmbeddings = [];
       if (provider === 'openrouter') this.plugin.settings.modelCache.openrouterEmbeddings = [];
       if (provider === 'nvidia') this.plugin.settings.modelCache.nvidiaEmbeddings = [];
   }

   // Save the cleared models/cache
   await this.plugin.saveSettings();
 } else {
   new Notice('API key saved successfully');
 }                 // Refresh models from providers when API key is updated
                 await this.plugin.refreshModelsFromProviders();
                 // Refresh display to update model enable/disable states
                 this.display();
              } else {
                let errorMsg: string;
                if (this.plugin.settings.provider === 'groq') {
                  errorMsg = 'Invalid Groq API key format. Key must start with "gsk_" and be at least 20 characters.';
                } else if (this.plugin.settings.provider === 'openrouter') {
                  errorMsg = 'Invalid OpenRouter API key format. Key must start with "sk-or-" and be at least 20 characters.';
                } else if (this.plugin.settings.provider === 'nvidia') {
                  errorMsg = 'Invalid NVIDIA API key format. Key must be at least 20 characters.';
                } else {
                  errorMsg = 'Invalid API key format. Key must be at least 20 characters.';
                }
                new Notice(errorMsg);
              }
            });
        text.inputEl.type = 'password';
      });

    // Add API key creation link beneath the input field
    let apiKeyUrl = '';
    if (currentProvider === 'groq') apiKeyUrl = 'https://console.groq.com/keys';
    else if (currentProvider === 'openrouter') apiKeyUrl = 'https://openrouter.ai/keys';
    else if (currentProvider === 'opencode') apiKeyUrl = 'https://opencode.ai/zen';
    else if (currentProvider === 'ollama') apiKeyUrl = 'https://ollama.com/settings';
    else if (currentProvider === 'nvidia') apiKeyUrl = 'https://build.nvidia.com/settings/api-keys';
    else apiKeyUrl = 'https://aistudio.google.com/app/apikey';

    // Style the control element to stack items vertically and align to the right
    apiSetting.controlEl.setCssStyles({
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end'
    });

    const linkContainer = apiSetting.controlEl.createDiv({
      cls: 'setting-item-description'
    });
    
    linkContainer.setCssStyles({
      maxWidth: '200px',
      textAlign: 'right',
      marginTop: '4px',
      lineHeight: '1.2',
      whiteSpace: 'normal',
      wordBreak: 'break-word'
    });

    linkContainer.createEl('a', {
      text: `Get your Free ${providerDisplayName} API key here`,
      href: apiKeyUrl
    });

    // Ollama mode toggle and base URL setting (only show for Ollama provider)
    if (currentProvider === 'ollama') {
      // Mode toggle
      new Setting(containerEl)
        .setName('Ollama mode')
        .setDesc('Switch between local instance and cloud API')
        .addDropdown(drop =>
          drop.addOption('local', 'Local Instance')
             .addOption('cloud', 'Cloud API')
             .setValue(this.plugin.settings.ollamaMode || 'local')
             .onChange(async val => {
               this.plugin.settings.ollamaMode = val as 'local' | 'cloud';
               
               // Auto-update the base URL when mode changes
               if (val === 'cloud') {
                 this.plugin.settings.ollamaBaseUrl = 'https://ollama.com';
               } else {
                 this.plugin.settings.ollamaBaseUrl = 'http://localhost:11434';
               }
               
               await this.plugin.saveSettings();
               this.display(); // Refresh to update URL field
               new Notice(`Switched to ${val === 'cloud' ? 'Cloud' : 'Local'} mode`);
               
               // Refresh models from providers when mode/URL changes
               await this.plugin.refreshModelsFromProviders();
             })
        );
      
      // Base URL with reset button
      const urlSetting = new Setting(containerEl)
        .setName('Ollama base URL')
        .setDesc('The endpoint URL for your Ollama instance');
      
      urlSetting.addText(text => {
        const defaultUrl = this.plugin.settings.ollamaMode === 'cloud' 
          ? 'https://ollama.com' 
          : 'http://localhost:11434';
        
        text.setPlaceholder(defaultUrl)
           .setValue(this.plugin.settings.ollamaBaseUrl)
           .onChange(async val => {
             if (val === '' || validateOllamaBaseUrl(val)) {
               this.plugin.settings.ollamaBaseUrl = val || defaultUrl;
               await this.plugin.saveSettings();
               new Notice('Ollama base URL saved successfully');
               
               // Refresh models from providers when URL is manually updated
               await this.plugin.refreshModelsFromProviders();
             } else {
               new Notice('Invalid URL format. Please enter a valid HTTP/HTTPS URL.');
             }
           });
      });
      
      // Add reset button
      urlSetting.addButton(button => {
        button.setButtonText('Reset')
              .setTooltip('Reset to default URL for current mode')
              .onClick(async () => {
                const defaultUrl = this.plugin.settings.ollamaMode === 'cloud' 
                  ? 'https://ollama.com' 
                  : 'http://localhost:11434';
                
                this.plugin.settings.ollamaBaseUrl = defaultUrl;
                await this.plugin.saveSettings();
                this.display(); // Refresh to show updated URL
                new Notice(`Reset to default ${this.plugin.settings.ollamaMode} URL`);
                
                // Refresh models from providers after reset
                await this.plugin.refreshModelsFromProviders();
              });
      });
      
      // Add info about current mode
      const modeInfo = this.plugin.settings.ollamaMode === 'cloud'
        ? 'Cloud mode: Requires API key. Streaming is simulated for better compatibility.'
        : 'Local mode: No API key needed. Full streaming support available.';
      
      containerEl.createEl('p', {
        text: modeInfo,
        cls: 'setting-item-description'
      });
    }

    // Section for custom providers
    this.renderCustomProvidersSection(containerEl);

    // Section for custom models table
    this.createCustomModelsTable(containerEl);

    // Section for custom embedding models table
    this.createCustomEmbeddingModelsTable(containerEl);
  }

  private renderCustomProvidersSection(containerEl: HTMLElement): void {
    const headerEl = new Setting(containerEl)
      .setName('Custom providers')
      .setHeading();

    headerEl.addExtraButton(btn => {
      btn.setIcon('plus')
        .setTooltip('Add new custom provider')
        .onClick(() => {
          new CustomProviderModal(this.app, async (provider) => {
            this.plugin.settings.customProviders.push(provider);
            await this.plugin.saveSettings();
            await this.plugin.refreshModelsFromProviders();
            this.display();
            new Notice(`Added custom provider: ${provider.name}`);
          }).open();
        });
    });

    if (this.plugin.settings.customProviders.length === 0) {
      containerEl.createEl('p', {
        text: 'No custom providers added. Click the + button to add one (e.g., Together AI, DeepSeek, vLLM).',
        cls: 'setting-item-description'
      });
      return;
    }

    const tableContainer = containerEl.createDiv({ cls: 'index-table-container' });
    const tableEl = tableContainer.createEl('table', { cls: 'index-table' });
    const theadEl = tableEl.createEl('thead');
    const headerRow = theadEl.createEl('tr');
    headerRow.createEl('th', { text: 'Name' });
    headerRow.createEl('th', { text: 'Base URL' });
    headerRow.createEl('th', { text: 'Actions' });

    const tbodyEl = tableEl.createEl('tbody');
    for (const provider of this.plugin.settings.customProviders) {
      const row = tbodyEl.createEl('tr');
      row.createEl('td').setText(provider.name);
      row.createEl('td').setText(provider.baseUrl);
      
      const actionsCell = row.createEl('td', { cls: 'index-actions-cell' });
      
      const editBtn = actionsCell.createEl('button', { cls: 'index-action-btn' });
      setIcon(editBtn, 'pencil');
      editBtn.addEventListener('click', () => {
        new CustomProviderModal(this.app, async (updatedProvider) => {
          const index = this.plugin.settings.customProviders.findIndex((p: CustomProviderConfig) => p.id === provider.id);
          if (index !== -1) {
            this.plugin.settings.customProviders[index] = updatedProvider;
            await this.plugin.saveSettings();
            await this.plugin.refreshModelsFromProviders();
            this.display();
            new Notice(`Updated custom provider: ${updatedProvider.name}`);
          }
        }, provider).open();
      });

      const deleteBtn = actionsCell.createEl('button', { cls: 'index-action-btn index-delete-btn' });
      setIcon(deleteBtn, 'trash-2');
      deleteBtn.addEventListener('click', async () => {
        const confirmed = confirm(`Are you sure you want to delete the provider "${provider.name}"? This may affect models using this provider.`);
        if (confirmed) {
          this.plugin.settings.customProviders = this.plugin.settings.customProviders.filter((p: CustomProviderConfig) => p.id !== provider.id);
          await this.plugin.saveSettings();
          await this.plugin.refreshModelsFromProviders();
          this.display();
          new Notice(`Deleted custom provider: ${provider.name}`);
        }
      });
    }
  }

  private renderVaultSearchTab(containerEl: HTMLElement): void {
      // Add index management section
      new Setting(containerEl).setName('Index management').setHeading();

      // Run change detection silently (result used by AI chat indicator, not displayed here)
      this.checkIndexChanges();

      // Render index management inline (no modal)
      this.renderIndexManagement(containerEl);

      // Render advanced search settings below index management
      this.renderVaultSearchAdvancedSettings(containerEl);
    }

  private renderVaultSearchAdvancedSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Search results').setHeading();

    new Setting(containerEl)
      .setName('Max vault search results')
      .setDesc('Maximum number of results to return from @vault and @flash searches (5-25). Higher values provide more context but may be limited by token budget.')
      .addSlider(slider => slider
        .setLimits(1, 25, 1)
        .setValue(this.plugin.settings.maxVaultSearchResults)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxVaultSearchResults = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName('BM25 boost').setHeading();
    containerEl.createEl('p', {
      text: 'Adjust how much weight is given to matches in different parts of your notes. Higher values = more important.',
      cls: 'setting-item-description'
    });

    new Setting(containerEl)
      .setName('Title boost')
      .setDesc('Weight for matches in note titles (default: 3.0)')
      .addSlider(slider => slider
        .setLimits(1.0, 5.0, 0.5)
        .setValue(this.plugin.settings.bm25TitleBoost)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.bm25TitleBoost = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Heading boost')
      .setDesc('Weight for matches in headings (default: 2.0)')
      .addSlider(slider => slider
        .setLimits(1.0, 4.0, 0.5)
        .setValue(this.plugin.settings.bm25HeadingBoost)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.bm25HeadingBoost = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Tag boost')
      .setDesc('Weight for matches in tags (default: 1.5)')
      .addSlider(slider => slider
        .setLimits(1.0, 3.0, 0.5)
        .setValue(this.plugin.settings.bm25TagBoost)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.bm25TagBoost = value;
          await this.plugin.saveSettings();
        }));
  }
  /**
   * Renders the index management section inline (no modal).
   */
  private renderIndexManagement(containerEl: HTMLElement): void {
    // Description
    containerEl.createEl('p', {
      text: 'Select one embedding index and one BM25 index for hybrid search. For flash search (@flash), BM25 index must be checked.',
      cls: 'index-modal-description'
    });

    // Embedding Indexes Section
    this.renderIndexSection(containerEl, 'embedding');

    // BM25 Indexes Section
    this.renderIndexSection(containerEl, 'bm25');
  }

  private renderIndexSection(containerEl: HTMLElement, type: 'embedding' | 'bm25'): void {
    const sectionEl = containerEl.createDiv({ cls: 'index-section' });

    const headerEl = sectionEl.createDiv({ cls: 'index-section-header' });
    const headerSetting = new Setting(headerEl).setName(type === 'embedding' ? 'Embedding indexes' : 'BM25 indexes').setHeading();
    
    // Ensure the setting item takes full width and has no extra padding
    headerSetting.settingEl.style.width = '100%';
    headerSetting.settingEl.style.borderTop = 'none';
    headerSetting.settingEl.style.padding = '0';

    if (type === 'embedding') {
      headerSetting.addButton(btn => {
        btn.setButtonText('+')
           .setTooltip('Add new embedding index')
           .onClick(() => this.showAddIndexDialog('embedding'));
        btn.buttonEl.addClass('mod-cta');
        // Add some horizontal padding to make the plus look better
        btn.buttonEl.style.padding = '0 10px';
      });
    }

    const indexesOfType = this.plugin.settings.indexConfigurations.filter((i: any) => i.type === type);

    if (indexesOfType.length === 0) {
      sectionEl.createEl('p', {
        text: `No ${type} indexes found. Create one to get started.`,
        cls: 'index-empty-message'
      });
      return;
    }

    const tableContainer = sectionEl.createDiv({ cls: 'index-table-container' });
    const tableEl = tableContainer.createEl('table', { 
      cls: type === 'embedding' ? 'index-table index-table-embedding' : 'index-table index-table-bm25'
    });
    const theadEl = tableEl.createEl('thead');
    const headerRow = theadEl.createEl('tr');
    headerRow.createEl('th', { text: '' }); // Select
    headerRow.createEl('th', { text: 'Name' });
    if (type === 'embedding') {
      headerRow.createEl('th', { text: 'Model' });
    }
    headerRow.createEl('th', { text: 'Files' });
    headerRow.createEl('th', { text: 'Status' });
    headerRow.createEl('th', { text: '' }); // Actions

    const tbodyEl = tableEl.createEl('tbody');

    for (const index of indexesOfType) {
      const row = tbodyEl.createEl('tr', { attr: { 'data-index-id': index.id } });

      // Checkbox cell
      const checkboxCell = row.createEl('td', { cls: 'index-checkbox-cell' });
      const checkbox = checkboxCell.createEl('input', { type: 'checkbox' });
      checkbox.checked = type === 'embedding'
        ? this.plugin.settings.selectedEmbeddingIndexId === index.id
        : this.plugin.settings.selectedBM25IndexId === index.id;
      checkbox.disabled = index.isBuilding || false;

      checkbox.addEventListener('change', async () => {
        if (type === 'embedding') {
          this.plugin.settings.selectedEmbeddingIndexId = checkbox.checked ? index.id : null;
        } else {
          this.plugin.settings.selectedBM25IndexId = checkbox.checked ? index.id : null;
        }

        // Update enabled status for all indexes
        for (const config of this.plugin.settings.indexConfigurations) {
          if (config.type === type) {
            config.enabled = config.id === index.id && checkbox.checked;
          }
        }

        await this.plugin.saveSettings();
        
        // Proactively load the index so the user sees the restoration progress
        if (checkbox.checked) {
          await this.plugin.embeddingsManager.loadIndex(index.id);
        }

        this.display(); // Refresh to update checkboxes
        new Notice('Index selection saved');
      });

      // Name cell
      const nameCell = row.createEl('td', { cls: 'index-name-cell', attr: { title: index.name } });
      nameCell.setText(index.name);

      // Model cell (only for embedding)
      if (type === 'embedding') {
        const modelText = index.model || 'Unknown';
        const modelCell = row.createEl('td', { cls: 'index-model-cell', attr: { title: modelText } });
        modelCell.setText(modelText);
      }

      // Files cell
      const filesCell = row.createEl('td', { cls: 'index-files-cell' });
      
      // Calculate total files in vault for percentage
      // BM25 indexes everything (no exclusions); embedding respects per-index exclusions
      const allFiles = this.app.vault.getMarkdownFiles();
      let totalFiles: number;
      if (type === 'bm25') {
        // BM25 indexes the whole vault — no exclusions
        totalFiles = allFiles.length;
      } else {
        // Embedding: use per-index exclusions if set, else global exclusions
        const perIndexExcludedFolders: string[] = index.excludedFolders || [];
        const perIndexExcludedFiles: string[] = index.excludedFiles || [];
        totalFiles = allFiles.filter(file => {
          const inExcludedFolder = perIndexExcludedFolders.some(folder => {
            // Root sentinel: only match files with no subfolder (no '/' in path)
            if (folder === '') return !file.path.includes('/');
            const nf = folder.startsWith('/') ? folder : '/' + folder;
            const np = file.path.startsWith('/') ? file.path : '/' + file.path;
            return np.startsWith(nf + '/') || np === nf;
          });
          if (inExcludedFolder) return false;
          const inExcludedFile = perIndexExcludedFiles.some(ef => {
            const ne = ef.startsWith('/') ? ef.slice(1) : ef;
            const np = file.path.startsWith('/') ? file.path.slice(1) : file.path;
            return np === ne;
          });
          return !inExcludedFile;
        }).length;
      }
      
      const completionPercentage = totalFiles > 0 ? Math.round((index.fileCount / totalFiles) * 100) : 0;
      
      // Show "X/Y files (Z%)" format
      filesCell.setText(`${index.fileCount}/${totalFiles} (${completionPercentage}%)`);

      // Status cell (includes last updated, progress percentage, and error)
      const statusCell = row.createEl('td', { cls: 'index-status-cell' });

      if (index.buildError) {
        // Show error message with partial completion indicator
        const errorDiv = statusCell.createDiv({ cls: 'index-error-message' });
        if (completionPercentage > 0 && completionPercentage < 100) {
          errorDiv.setText(`Partial (${completionPercentage}%)`);
          errorDiv.setAttribute('title', `Error: ${index.buildError}\nPartial index available with ${index.fileCount}/${totalFiles} files`);
        } else {
          errorDiv.setText(`Error: ${index.buildError}`);
        }
      } else if (index.isBuilding && index.buildProgress !== undefined) {
        // Show progress percentage only when actively building
        statusCell.setText(`${index.buildProgress || 0}%`);
        statusCell.addClass('index-building-progress');
      } else {
        // Show last updated with completion status
        if (index.lastUpdated > 0) {
          const date = new Date(index.lastUpdated);
          const timeStr = date.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });
          // Full date for tooltip
          const fullDateStr = date.toLocaleString();
          
          // Add partial indicator if not 100% complete
          if (completionPercentage > 0 && completionPercentage < 100) {
            statusCell.setText(`${timeStr} (Partial)`);
            statusCell.setAttribute('title', `${fullDateStr}\nPartial index: ${completionPercentage}% complete`);
            statusCell.addClass('index-partial');
          } else {
            statusCell.setText(timeStr);
            statusCell.setAttribute('title', fullDateStr);
          }
        } else {
          statusCell.setText('Not built');
          statusCell.addClass('index-not-built');
          statusCell.setAttribute('title', 'Index not yet built');
        }
      }

      // Actions cell
      const actionsCell = row.createEl('td', { cls: 'index-actions-cell' });

      // Build button
      const buildBtn = actionsCell.createEl('button', {
        cls: 'index-action-btn',
        attr: { 'aria-label': index.isBuilding ? 'Pause building' : 'Build index' }
      });
      
      if (index.isBuilding) {
        setIcon(buildBtn, 'pause');
      } else {
        setIcon(buildBtn, 'wrench');
      }

      if (index.isBuilding) {
        // AUTO-ATTACH: If the index is already building in background (e.g. settings tab was closed and reopened),
        // we automatically start the UI update loop to sync progress.
        // But first, verify if it's ACTUALLY building in the manager to prevent accidental restarts.
        if (!this.plugin.embeddingsManager.isIndexBuilding(index.id)) {
                    index.isBuilding = false;
          index.buildProgress = 0;
          this.display(); // Refresh to fix UI state
          return;
        }

        buildBtn.addClass('building');
        
        // We use a small timeout to ensure the DOM is fully ready.
        setTimeout(async () => {
          try {
            // Re-attach to the build process
            await this.buildIndex(index, (progress: number, fileStatus?: string) => {
              index.buildProgress = progress;
              statusCell.setText(`${progress}%`);
              if (fileStatus) {
                filesCell.setText(`${fileStatus} (${progress}%)`);
              }
            });
            index.buildProgress = 0;
          } catch (error) {
            const err = error as Error;
            if (err.message !== 'PAUSED') {
              index.buildError = err.message;
            }
          } finally {
            index.isBuilding = false;
            if (this.containerEl.isShown()) {
               this.display();
            }
          }
        }, 50);
      }

      buildBtn.addEventListener('click', async () => {
        if (index.isBuilding) {
          // Pause requested
          this.plugin.embeddingsManager.pauseIndexBuild(index.id);
          setIcon(buildBtn, 'loader-2');
          buildBtn.querySelector('svg')?.addClass('spin'); // Show spinner while waiting for background to acknowledge
          buildBtn.setAttribute('aria-label', 'Pausing...');
          buildBtn.addClass('pausing'); // Use a CSS class for styling if needed
          return;
        }

        // Start build
        index.isBuilding = true;
        index.buildProgress = index.buildProgress || 0;
        index.buildError = undefined;
        
        // Update button to show pause option
        buildBtn.addClass('building');
        setIcon(buildBtn, 'pause');
        buildBtn.setAttribute('aria-label', 'Pause building');
        
        // Replace status cell content with progress percentage
        statusCell.empty();
        statusCell.setText(`${index.buildProgress}%`);
        statusCell.addClass('index-building-progress');

        try {
          await this.buildIndex(index, (progress: number, fileStatus?: string) => {
                        index.buildProgress = progress;
            // Update progress percentage in real-time
            statusCell.setText(`${progress}%`);
            
            // Update file status in real-time if provided
            if (fileStatus) {
              filesCell.setText(`${fileStatus} (${progress}%)`);
            }
          });
          
          // Reset build progress after completion
          index.buildProgress = 0;
          new Notice(`${index.name} built successfully`);
        } catch (error) {
          const err = error as Error;
          if (err.message === 'PAUSED') {
            new Notice(`${index.name} build paused`);
          } else {
            index.buildError = err.message;
            new Notice(`Failed to build ${index.name}: ${err.message}`);
          }
        } finally {
          index.isBuilding = false;
          // Refresh to show final state (timestamp or paused state)
          this.display();
        }
      });

      // Delete button (only for embedding indexes, BM25 must always exist)
      if (type === 'embedding') {
        // Triple-dot exclusions button
        const dotsBtn = actionsCell.createEl('button', {
          cls: 'index-action-btn index-exclusions-btn',
          attr: { 'aria-label': 'Edit exclusions' }
        });
        setIcon(dotsBtn, 'more-vertical');
        dotsBtn.disabled = index.isBuilding || false;
        dotsBtn.addEventListener('click', () => {
          this.showIndexExclusionsDialog(index);
        });
        const deleteBtn = actionsCell.createEl('button', {
          cls: 'index-action-btn index-delete-btn',
          attr: { 'aria-label': 'Delete index' }
        });
        setIcon(deleteBtn, 'trash-2');
        deleteBtn.disabled = index.isBuilding || false;

        deleteBtn.addEventListener('click', async () => {
          const confirmed = confirm(`Are you sure you want to delete the index "${index.name}"? This will also permanently delete the index file from your vault.`);
          if (!confirmed) return;

          const indexToRemove = this.plugin.settings.indexConfigurations.findIndex((i: any) => i.id === index.id);
          if (indexToRemove !== -1) {
            // Physically delete the file from disk first
            await this.plugin.embeddingsManager.deleteIndexFile(index.id);

            this.plugin.settings.indexConfigurations.splice(indexToRemove, 1);

            if (this.plugin.settings.selectedEmbeddingIndexId === index.id) {
              this.plugin.settings.selectedEmbeddingIndexId = null;
            }

            if (this.plugin.settings.selectedBM25IndexId === index.id) {
              this.plugin.settings.selectedBM25IndexId = null;
            }

            await this.plugin.saveSettings();
            this.display();
            new Notice(`${index.name} and its data file deleted`);
          }
        });

      }
    }
  }

  private showAddIndexDialog(type: 'embedding' | 'bm25'): void {
    const dialogEl = this.containerEl.createDiv({ cls: 'index-add-dialog' });
    new Setting(dialogEl).setName(`Add new ${type === 'embedding' ? 'embedding' : 'BM25'} index`).setHeading();

    let indexName = '';
    let selectedModel = '';
    const pendingExcludedFolders: string[] = [];
    const pendingExcludedFiles: string[] = [];

    new Setting(dialogEl)
      .setName('Index name')
      .setDesc('Enter a name for this index')
      .addText(text => text
        .setPlaceholder('e.g., Gemini 004 Index')
        .onChange(value => { indexName = value; })
      );

    if (type === 'embedding') {
      new Setting(dialogEl)
        .setName('Embedding model')
        .setDesc('Select the embedding model to use')
        .addDropdown(dropdown => {
          for (const model of this.plugin.settings.customEmbeddingModels) {
            if (model.enabled) {
              dropdown.addOption(model.id, model.name);
            }
          }
          dropdown.onChange(value => { selectedModel = value; });
          selectedModel = dropdown.getValue();
        });

      // Exclusions section
      const exclSection = dialogEl.createDiv({ cls: 'index-dialog-exclusions' });
      exclSection.createEl('p', { text: 'Exclusions', cls: 'index-dialog-exclusions-title' });

      this.renderExclusionsPicker(exclSection, pendingExcludedFolders, pendingExcludedFiles);
    }

    const buttonContainer = dialogEl.createDiv({ cls: 'index-dialog-buttons' });

    const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => { dialogEl.remove(); });

    const createBtn = buttonContainer.createEl('button', { text: 'Create', cls: 'mod-cta' });
    createBtn.addEventListener('click', async () => {
      if (!indexName.trim()) {
        new Notice('Please enter an index name');
        return;
      }

      const newIndex: any = {
        id: `${type}-${Date.now()}`,
        type,
        name: indexName,
        model: type === 'embedding' ? selectedModel : undefined,
        enabled: false,
        fileCount: 0,
        lastUpdated: 0,
        excludedFolders: type === 'embedding' ? [...pendingExcludedFolders] : undefined,
        excludedFiles: type === 'embedding' ? [...pendingExcludedFiles] : undefined,
      };

      this.plugin.settings.indexConfigurations.push(newIndex);
      await this.plugin.saveSettings();
      dialogEl.remove();
      this.display();
      new Notice(`${indexName} created. Click the build button to index your vault.`);
    });
  }

  /** Opens a dialog to edit exclusions for an existing embedding index. */
  private showIndexExclusionsDialog(index: any): void {
    const dialogEl = this.containerEl.createDiv({ cls: 'index-add-dialog' });
    new Setting(dialogEl).setName(`Exclusions — ${index.name}`).setHeading();

    // Work on copies; commit only on Save
    const pendingFolders: string[] = [...(index.excludedFolders || [])];
    const pendingFiles: string[] = [...(index.excludedFiles || [])];

    this.renderExclusionsPicker(dialogEl, pendingFolders, pendingFiles);

    const buttonContainer = dialogEl.createDiv({ cls: 'index-dialog-buttons' });

    const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => { dialogEl.remove(); });

    const saveBtn = buttonContainer.createEl('button', { text: 'Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', async () => {
      index.excludedFolders = [...pendingFolders];
      index.excludedFiles = [...pendingFiles];
      await this.plugin.saveSettings();
      dialogEl.remove();
      this.display();
      new Notice('Exclusions saved.');
    });
  }

  private renderExclusionsPicker(
    containerEl: HTMLElement,
    pendingFolders: string[],
    pendingFiles: string[]
  ): void {
    const pickerEl = containerEl.createDiv({ cls: 'index-exclusions-picker' });

    // ── Search bar ──────────────────────────────────────────────────────────
    const searchWrapper = pickerEl.createDiv({ cls: 'index-excl-search-wrapper' });
    const searchInput = searchWrapper.createEl('input', {
      type: 'text',
      cls: 'index-excl-search',
      attr: { placeholder: 'Search files to exclude…' }
    });
    // Results rendered inline (not absolute) to avoid clipping inside scrollable modal
    const searchResults = pickerEl.createDiv({ cls: 'index-excl-search-results' });
    searchResults.style.display = 'none';

    const allMdFiles = this.app.vault.getMarkdownFiles().map(f => f.path).sort();

    const renderSearchResults = (query: string) => {
      searchResults.empty();
      if (!query.trim()) { searchResults.style.display = 'none'; return; }
      const matches = allMdFiles.filter(p => p.toLowerCase().includes(query.toLowerCase())).slice(0, 20);
      if (matches.length === 0) { searchResults.style.display = 'none'; return; }
      searchResults.style.display = 'block';
      for (const path of matches) {
        const item = searchResults.createDiv({ cls: 'index-excl-search-item' });
        const cb = item.createEl('input', { type: 'checkbox' });
        cb.checked = pendingFiles.includes(path);
        const label = item.createEl('span', { cls: 'index-excl-search-label' });
        label.setText(path);
        if (pendingFiles.includes(path)) label.addClass('index-excl-struck');
        cb.addEventListener('change', () => {
          if (cb.checked) {
            if (!pendingFiles.includes(path)) pendingFiles.push(path);
            label.addClass('index-excl-struck');
          } else {
            const i = pendingFiles.indexOf(path);
            if (i > -1) pendingFiles.splice(i, 1);
            label.removeClass('index-excl-struck');
          }
          renderExcludedSummary();
        });
      }
    };

    searchInput.addEventListener('input', () => renderSearchResults(searchInput.value));

    // ── Folder list ─────────────────────────────────────────────────────────
    const folderListEl = pickerEl.createDiv({ cls: 'index-excl-folder-list' });

    // Use vault.getAllFolders() for reliable folder enumeration
    const allFolders = (this.app.vault as any).getAllFolders
      ? (this.app.vault as any).getAllFolders().map((f: any) => f.path).filter((p: string) => p !== '').sort()
      : this.app.vault.getAllLoadedFiles()
          .filter((f: any) => f.children !== undefined && f.path !== '')
          .map((f: any) => f.path)
          .sort();

    const renderFolderList = () => {
      folderListEl.empty();

      // ── Select All ────────────────────────────────────────────────────────
      const allPaths = ['', ...allFolders];
      if (allPaths.length > 0) {
        const selectAllItem = folderListEl.createDiv({ cls: 'index-excl-folder-item' });
        const selectAllCb = selectAllItem.createEl('input', { type: 'checkbox' });
        selectAllCb.checked = allPaths.every(p => pendingFolders.includes(p));
        const selectAllLabel = selectAllItem.createEl('span', { cls: 'index-excl-folder-label', text: 'Select All' });
        selectAllLabel.style.fontWeight = 'bold';

        selectAllCb.addEventListener('change', () => {
          if (selectAllCb.checked) {
            for (const p of allPaths) {
              if (!pendingFolders.includes(p)) pendingFolders.push(p);
            }
          } else {
            for (const p of allPaths) {
              const i = pendingFolders.indexOf(p);
              if (i > -1) pendingFolders.splice(i, 1);
            }
          }
          renderFolderList();
          renderExcludedSummary();
        });
      }

      // ── Vault root entry (files at the top level with no subfolder) ──────
      const rootItem = folderListEl.createDiv({ cls: 'index-excl-folder-item' });
      const rootCb = rootItem.createEl('input', { type: 'checkbox' });
      rootCb.checked = pendingFolders.includes('');
      const rootLabel = rootItem.createEl('span', { cls: 'index-excl-folder-label index-excl-root-label' });
      rootLabel.setText('/ (vault root)');
      if (pendingFolders.includes('')) rootLabel.addClass('index-excl-struck');
      rootCb.addEventListener('change', () => {
        if (rootCb.checked) {
          if (!pendingFolders.includes('')) pendingFolders.push('');
          rootLabel.addClass('index-excl-struck');
        } else {
          const i = pendingFolders.indexOf('');
          if (i > -1) pendingFolders.splice(i, 1);
          rootLabel.removeClass('index-excl-struck');
        }
        renderExcludedSummary();
      });

      if (allFolders.length === 0) return;

      for (const folder of allFolders) {
        const item = folderListEl.createDiv({ cls: 'index-excl-folder-item' });
        const cb = item.createEl('input', { type: 'checkbox' });
        cb.checked = pendingFolders.includes(folder);
        const label = item.createEl('span', { cls: 'index-excl-folder-label' });
        label.setText(folder);
        if (pendingFolders.includes(folder)) label.addClass('index-excl-struck');
        cb.addEventListener('change', () => {
          if (cb.checked) {
            if (!pendingFolders.includes(folder)) pendingFolders.push(folder);
            label.addClass('index-excl-struck');
          } else {
            const i = pendingFolders.indexOf(folder);
            if (i > -1) pendingFolders.splice(i, 1);
            label.removeClass('index-excl-struck');
          }
          renderExcludedSummary();
        });
      }
    };

    renderFolderList();

    // ── Excluded summary ────────────────────────────────────────────────────
    const summaryEl = pickerEl.createDiv({ cls: 'index-excl-summary' });

    const renderExcludedSummary = () => {
      summaryEl.empty();
      if (pendingFolders.length === 0 && pendingFiles.length === 0) return;
      summaryEl.createEl('p', { text: 'Excluded:', cls: 'index-excl-summary-title' });
      for (const f of pendingFolders) {
        const row = summaryEl.createDiv({ cls: 'index-excl-summary-item' });
        row.createEl('span', { text: `📁 ${f === '' ? '/ (vault root)' : f}`, cls: 'index-excl-struck' });
        const rm = row.createEl('span', { cls: 'index-excl-remove', text: '×' });
        rm.addEventListener('click', () => {
          const i = pendingFolders.indexOf(f);
          if (i > -1) pendingFolders.splice(i, 1);
          renderFolderList();
          renderExcludedSummary();
        });
      }
      for (const f of pendingFiles) {
        const row = summaryEl.createDiv({ cls: 'index-excl-summary-item' });
        row.createEl('span', { text: `📄 ${f}`, cls: 'index-excl-struck' });
        const rm = row.createEl('span', { cls: 'index-excl-remove', text: '×' });
        rm.addEventListener('click', () => {
          const i = pendingFiles.indexOf(f);
          if (i > -1) pendingFiles.splice(i, 1);
          // Re-render search results to uncheck the removed file if still visible
          renderSearchResults(searchInput.value);
          renderExcludedSummary();
        });
      }
    };

    renderExcludedSummary();
  }

  private async buildIndex(indexConfig: any, progressCallback: (progress: number, fileStatus?: string) => void): Promise<void> {
    if (!indexConfig) {
      throw new Error('Index not found');
    }

    // Check if using Ollama embedding model and ensure local mode
    if (indexConfig.type === 'embedding' && indexConfig.model) {
      const embeddingModel = this.plugin.settings.customEmbeddingModels.find(
        (m: CustomEmbeddingModel) => m.id === indexConfig.model
      );
      
      if (embeddingModel && embeddingModel.provider === 'ollama') {
        // Check if in cloud mode
        if (this.plugin.settings.ollamaMode === 'cloud') {
          // Auto-switch to local mode
          this.plugin.settings.ollamaMode = 'local';
          this.plugin.settings.ollamaBaseUrl = 'http://localhost:11434';
          await this.plugin.saveSettings();
          
          new Notice('⚠️ Ollama embedding models are only available locally. Automatically switched to Local mode.', 8000);
        }
        
        // Check if Ollama is accessible and model is available
        try {
          const baseUrl = this.plugin.settings.ollamaBaseUrl || 'http://localhost:11434';
          const response = await fetch(`${baseUrl}/api/tags`);
          
          if (!response.ok) {
            throw new Error('Ollama not accessible');
          }
          
          const data = await response.json();
          const availableModels = data.models?.map((m: any) => m.name) || [];
          
          // Check if the model is pulled
          if (!availableModels.includes(indexConfig.model)) {
            new Notice(
              `⚠️ Model "${indexConfig.model}" not found locally.\n\n` +
              `Please pull it first:\n` +
              `ollama pull ${indexConfig.model}\n\n` +
              `Then try building the index again.`,
              15000
            );
            throw new Error(`Model "${indexConfig.model}" not found. Run: ollama pull ${indexConfig.model}`);
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes('not found')) {
            throw error; // Re-throw model not found error
          }
          
          // Ollama connection error
          new Notice(
            `⚠️ Cannot connect to Ollama.\n\n` +
            `Please ensure Ollama is running:\n` +
            `1. Start Ollama: ollama serve\n` +
            `2. Pull the model: ollama pull ${indexConfig.model}\n` +
            `3. Try building the index again.`,
            15000
          );
          throw new Error('Cannot connect to Ollama. Please ensure Ollama is running (ollama serve)');
        }
      }
    }

    indexConfig.isBuilding = true;
    indexConfig.buildProgress = 0;
    indexConfig.buildError = undefined;

    try {
      if (indexConfig.type === 'embedding') {
        // Build embedding index only
        await this.plugin.embeddingsManager.buildEmbeddingIndex(
          indexConfig.model || this.plugin.settings.embeddingModel,
          (status: string) => {
            
            // Parse progress from status string
            // Format: EMBEDDINGS:percentage:processed/total
            const match = status.match(/EMBEDDINGS:(\d+)(?::(\d+\/\d+))?/);
            if (match) {
              const progress = parseInt(match[1]);
              const fileStatus = match[2];
              indexConfig.buildProgress = progress;
                            progressCallback(progress, fileStatus);
            }

            if (status === 'PAUSED') {
              throw new Error('PAUSED');
            }

            // Check for errors
            const errorMatch = status.match(/ERROR:embeddings:(.+)/);
            if (errorMatch) {
              indexConfig.buildError = errorMatch[1];
              throw new Error(errorMatch[1]);
            }
          },
          indexConfig.id // Pass the index ID so it uses the correct file
        );
      } else if (indexConfig.type === 'bm25') {
        // Build BM25 index only
        await this.plugin.embeddingsManager.buildBM25Index((status: string) => {
          // Parse progress from status string
          // Format: BM25:percentage:processed/total
          const match = status.match(/BM25:(\d+)(?::(\d+\/\d+))?/);
          if (match) {
            const progress = parseInt(match[1]);
            const fileStatus = match[2];
            indexConfig.buildProgress = progress;
            progressCallback(progress, fileStatus);
          }

          if (status === 'PAUSED') {
            throw new Error('PAUSED');
          }
        }, indexConfig.id);
      }

      // Update index metadata
      const allFiles = this.app.vault.getMarkdownFiles();
      let nonExcludedFiles: TFile[];
      if (indexConfig.type === 'embedding') {
        nonExcludedFiles = allFiles.filter(file =>
          !this.plugin.embeddingsManager.isFileExcluded(file.path, indexConfig.id)
        );
      } else {
        nonExcludedFiles = allFiles;
      }
      
      // Get actual file count from the index based on type
      let indexedFileCount: number;
      if (indexConfig.type === 'embedding') {
        indexedFileCount = await this.plugin.embeddingsManager.getEmbeddedFileCount(indexConfig.id);
      } else {
        indexedFileCount = await this.plugin.embeddingsManager.getBM25FileCount(indexConfig.id);
      }
      
      // Include empty files in the count for an accurate total
      indexConfig.fileCount = indexedFileCount;
      indexConfig.lastUpdated = Date.now();

      await this.plugin.saveSettings();
    } catch (error) {
      const err = error as Error;
      indexConfig.buildError = err.message;
      
      // Even on error, update with partial progress
      try {
        let indexedFileCount: number;
        if (indexConfig.type === 'embedding') {
          indexedFileCount = await this.plugin.embeddingsManager.getEmbeddedFileCount(indexConfig.id);
        } else {
          indexedFileCount = await this.plugin.embeddingsManager.getBM25FileCount(indexConfig.id);
        }
        
        indexConfig.fileCount = indexedFileCount;
        indexConfig.lastUpdated = Date.now();
        await this.plugin.saveSettings();
      } catch (metadataError) {
              }
      
      throw error;
    } finally {
      indexConfig.isBuilding = false;
    }
  }

  private renderToolsTab(containerEl: HTMLElement): void {
    // MCP server configuration (Top) — desktop only
    if (!Platform.isMobile) {
      new Setting(containerEl).setName('MCP server configuration').setHeading();
      containerEl.createEl('p', { 
        text: 'Configure Model Context Protocol (MCP) servers to extend AI capabilities with external tools and resources. Use @mcp in chat to access MCP tools.',
        cls: 'setting-item-description'
      });

      this.renderMCPPrerequisites(containerEl);

      new Setting(containerEl)
        .setName('Enable MCP support')
        .setDesc('Enable Model Context Protocol integration for AI chat')
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.mcpEnabled ?? true)
          .onChange(async (value) => {
            this.plugin.settings.mcpEnabled = value;
            await this.plugin.saveSettings();
            new Notice(`MCP support ${value ? 'enabled' : 'disabled'}`);
            this.display(); // Refresh to show/hide MCP servers
          }));

      if (this.plugin.settings.mcpEnabled) {
        new Setting(containerEl)
          .setName('Auto-connect servers on startup')
          .setDesc('When enabled, MCP servers connect automatically when the app loads. When disabled, servers must be connected manually from the server selection modal.')
          .addToggle(toggle => toggle
            .setValue(this.plugin.settings.mcpAutoConnect ?? true)
            .onChange(async (value) => {
              this.plugin.settings.mcpAutoConnect = value;
              await this.plugin.saveSettings();
              new Notice(`MCP auto-connect ${value ? 'enabled' : 'disabled'}`);
            }));

        this.renderMCPServersTable(containerEl);
      }
    }

    // Code Execution and Canvas (Below MCP)
    new Setting(containerEl).setName('Code execution and canvas').setHeading();
    containerEl.createEl('p', {
      text: 'Control how code blocks in AI responses are executed. Supported languages: JavaScript, TypeScript, HTML, CSS, Python.',
      cls: 'setting-item-description'
    });

    new Setting(containerEl)
      .setName('Auto-execute code blocks')
      .setDesc('When enabled, code blocks are executed automatically and errors are fixed without user interaction. When disabled, a run toggle appears on each code block — you control when to run and when to repair errors.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.codeExecutionAutoMode ?? false)
        .onChange(async (value) => {
          this.plugin.settings.codeExecutionAutoMode = value;
          await this.plugin.saveSettings();
          new Notice(`Code execution: ${value ? 'auto mode' : 'manual mode'}`);
        }));

    // Advanced rate limit (Bottom)
    new Setting(containerEl).setName('Delay limit').setHeading();
    containerEl.createEl('p', {
      text: 'Configure delay limiting for MCP queries to prevent API rate limit errors.',
      cls: 'setting-item-description'
    });

    new Setting(containerEl)
      .setName('Delay Duration')
      .setDesc('Delay in seconds between API calls for multi-step processes (5-60 seconds). Very low values may cause rate limit errors or poor responses in manual model selection mode. Default: 25 seconds.')      .addSlider(slider => slider
        .setLimits(5, 60, 1)
        .setValue(this.plugin.settings.rateLimitSeconds)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.rateLimitSeconds = value;
          await this.plugin.saveSettings();
        }));
  }

  private renderMiscTab(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Miscellaneous').setHeading();

    // YouTube video processing
    new Setting(containerEl).setName('YouTube video processing').setHeading();
    
    new Setting(containerEl)
      .setName('YouTube processing mode')
      .setDesc('Choose how YouTube videos are processed')
      .addDropdown(drop =>
        drop.addOption('transcript', '📝 Transcript (Recommended: Fast)')
           .addOption('gemini-native', '🎥 Gemini Native (Slow)')
           .setValue(this.plugin.settings.youtubeProcessingMode || 'transcript')
           .onChange(async val => {
             this.plugin.settings.youtubeProcessingMode = val as 'transcript' | 'gemini-native';
             await this.plugin.saveSettings();
             new Notice(`YouTube processing mode set to: ${val === 'transcript' ? 'Transcript' : 'Gemini Native'}`);
           })
      );

    // Add explanation for each mode
    const modeExplanation = containerEl.createDiv({ cls: 'setting-item-description youtube-mode-explanation' });
    modeExplanation.createEl('strong', { text: 'Mode descriptions:' });
    modeExplanation.createEl('br');
    modeExplanation.createEl('span', { text: '• ' });
    modeExplanation.createEl('strong', { text: 'Transcript (recommended):' });
    modeExplanation.createEl('span', { text: ' Extracts video transcript and sends to your selected AI model. Works with Gemini, Groq, and OpenRouter. Faster and more cost-effective. Automatically detects available languages.' });
    modeExplanation.createEl('br');
    modeExplanation.createEl('span', { text: '• ' });
    modeExplanation.createEl('strong', { text: 'Gemini Native:' });
    modeExplanation.createEl('span', { text: " Uses Gemini's multimodal API to analyze video directly (audio + visual). Requires Gemini API key. Best for videos without transcripts or when visual analysis is needed." });

    // Save YouTube transcripts toggle
    const folderSetting = new Setting(containerEl)
      .setName('Default transcript folder')
      .setDesc('Default folder where YouTube transcripts will be saved')
      .addText(text =>
        text.setPlaceholder('YouTube Transcripts')
           .setValue(this.plugin.settings.youtubeTranscriptFolder || 'YouTube Transcripts')
           .onChange(async val => {
             const normalizedPath = val.trim().replace(/^\/+|\/+$/g, '');
             this.plugin.settings.youtubeTranscriptFolder = normalizedPath || 'YouTube Transcripts';
             await this.plugin.saveSettings();
           })
      );

    new Setting(containerEl)
      .setName('Save YouTube transcripts')
      .setDesc('When enabled, transcripts are saved as files in your vault. When disabled, transcripts are used internally as context only.')
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.saveYoutubeTranscripts ?? true)
           .onChange(async val => {
             this.plugin.settings.saveYoutubeTranscripts = val;
             await this.plugin.saveSettings();
             // Show/hide folder setting based on toggle
             folderSetting.settingEl.style.display = val ? '' : 'none';
             new Notice(`YouTube transcripts will ${val ? 'be saved as files' : 'be used internally only'}`);
           })
      );

    // Initially hide/show folder setting based on current toggle value
    folderSetting.settingEl.style.display = (this.plugin.settings.saveYoutubeTranscripts ?? true) ? '' : 'none';

    // Add PDF output directory setting
    new Setting(containerEl).setName('File output').setHeading();
    
    new Setting(containerEl)
      .setName('PDF output directory')
      .setDesc('Specify the directory where PDFs text-extracted files will be saved')
      .addText(text =>
        text.setPlaceholder('/path/to/pdfs')
           .setValue(this.plugin.settings.pdfOutputDirectory)
           .onChange(async val => {
             const normalizedPath = val.trim().replace(/^\/+|\/+$/g, '');
if (this.validatePath(normalizedPath)) {
                this.plugin.settings.pdfOutputDirectory = normalizedPath;
                await this.plugin.saveSettings();
                new Notice('PDF output directory updated');
              } else {
                Notice;
                new Notice('Invalid directory path');
              }
            })
       );

    new Setting(containerEl)
      .setName('Template folder')
      .setDesc('Select the folder that contains your note templates to be able to save responses and AI created files in your preferred template')
      .addDropdown(drop => {
        const folders = this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder) as TFolder[];
        drop.addOption('', 'None');
        folders.forEach(folder => {
          drop.addOption(folder.path, folder.path);
        });
        drop.setValue(this.plugin.settings.templateFolder)
          .onChange(async (val) => {
            this.plugin.settings.templateFolder = val;
            await this.plugin.saveSettings();
            new Notice('Template folder updated');
          });
      });

    // Wallpaper section
    new Setting(containerEl).setName('Wallpaper').setHeading();

    // Wallpaper enable toggle
    new Setting(containerEl)
      .setName('Enable wallpaper')
      .setDesc('Show wallpaper image in AI chat background')
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.chatWallpaperEnabled ?? false)
          .onChange(async val => {
            this.plugin.settings.chatWallpaperEnabled = val;
            await this.plugin.saveSettings();
            new Notice(`Wallpaper ${val ? 'enabled' : 'disabled'}`);
          })
      );

    // Wallpaper opacity slider
    new Setting(containerEl)
      .setName('Wallpaper opacity')
      .setDesc(`Opacity level: ${Math.round((this.plugin.settings.chatWallpaperOpacity ?? 0.5) * 100)}%`)
      .addSlider(slider =>
        slider.setValue(this.plugin.settings.chatWallpaperOpacity ?? 0.5)
          .setLimits(0.1, 1, 0.05)
          .onChange(async val => {
            this.plugin.settings.chatWallpaperOpacity = val;
            await this.plugin.saveSettings();
            // Update the desc to show new value
            const descEl = containerEl.querySelector('.wallpaper-opacity-setting .setting-item-description');
            if (descEl) {
              descEl.textContent = `Opacity level: ${Math.round(val * 100)}%`;
            }
          })
      );
    // Add class for updating description
    const opacitySetting = containerEl.lastChild;
    if (opacitySetting instanceof HTMLElement) {
      opacitySetting.classList.add('wallpaper-opacity-setting');
    }

    // Response card opacity slider
    new Setting(containerEl)
      .setName('Response card opacity')
      .setDesc(`Opacity level: ${Math.round((this.plugin.settings.chatWallpaperResponseOpacity ?? 0.25) * 100)}%`)
      .addSlider(slider =>
        slider.setValue(this.plugin.settings.chatWallpaperResponseOpacity ?? 0.25)
          .setLimits(0.1, 1, 0.05)
          .onChange(async val => {
            this.plugin.settings.chatWallpaperResponseOpacity = val;
            await this.plugin.saveSettings();
            // Update live - find all response views and update wallpaper
            const viewType = 'ai-tutor-response';
            this.app.workspace.getLeavesOfType(viewType).forEach(leaf => {
              const view = leaf.view as any;
              if (view && typeof view.updateWallpaper === 'function') {
                view.updateWallpaper();
              }
            });
            new Notice(`Response opacity updated to ${Math.round(val * 100)}%`);
          })
      );
    const responseOpacitySetting = containerEl.lastChild;
    if (responseOpacitySetting instanceof HTMLElement) {
      responseOpacitySetting.classList.add('response-opacity-setting');
    }

    // Header/Input Area Opacity Slider
    new Setting(containerEl)
      .setName('Header & input area opacity')
      .setDesc(`Opacity level: ${Math.round((this.plugin.settings.chatWallpaperHeaderOpacity ?? 0.2) * 100)}%`)
      .addSlider(slider =>
        slider.setValue(this.plugin.settings.chatWallpaperHeaderOpacity ?? 0.2)
          .setLimits(0.1, 1, 0.05)
          .onChange(async val => {
            this.plugin.settings.chatWallpaperHeaderOpacity = val;
            await this.plugin.saveSettings();
            // Update live - find all response views and update wallpaper
            const viewType = 'ai-tutor-response';
            this.app.workspace.getLeavesOfType(viewType).forEach(leaf => {
              const view = leaf.view as any;
              if (view && typeof view.updateWallpaper === 'function') {
                view.updateWallpaper();
              }
            });
            new Notice(`Header/Input opacity updated to ${Math.round(val * 100)}%`);
          })
      );
    const headerOpacitySetting = containerEl.lastChild;
    if (headerOpacitySetting instanceof HTMLElement) {
      headerOpacitySetting.classList.add('header-opacity-setting');
    }
  }

  private renderSupportTab(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Support').setHeading();

    const intro = containerEl.createDiv({ cls: 'support-tab-content' });

    const p1 = intro.createEl('p');
    p1.appendText('If you find the plugin valuable, you can support its maintenance and development at ');
    p1.createEl('a', {
      text: 'ko-fi.com/anshusrathe',
      href: 'https://ko-fi.com/anshusrathe',
      attr: { target: '_blank', rel: 'noopener' }
    });
    p1.appendText('.');

    intro.createEl('p', {
      text: 'If you encounter any bugs or have suggestions for improvements, please create an issue.'
    });

    intro.createEl('p', {
      text: 'Any ideas or support are highly appreciated!'
    });

    const btnWrap = intro.createDiv({ cls: 'support-kofi-btn' });
    const kofiLink = btnWrap.createEl('a', {
      href: 'https://ko-fi.com/Y8Y71ZF5G3',
      attr: { target: '_blank', rel: 'noopener' }
    });
    kofiLink.createEl('img', {
      attr: {
        src: 'https://storage.ko-fi.com/cdn/kofi4.png?v=6',
        height: '36',
        style: 'border:0px;height:36px;',
        alt: 'Buy Me a Coffee at ko-fi.com',
        border: '0'
      }
    });
  }

  private createCustomModelsTable(containerEl: HTMLElement) {
    const providers: { id: Provider; name: string }[] = [
      { id: 'gemini', name: 'Google Gemini' },
      { id: 'groq', name: 'Groq' },
      { id: 'openrouter', name: 'OpenRouter' },
      { id: 'opencode', name: 'OpenCode Zen' },
      { id: 'ollama', name: 'Ollama' },
      { id: 'nvidia', name: 'NVIDIA' },
      ...this.plugin.settings.customProviders.map((p: any) => ({ id: p.id as Provider, name: p.name }))
    ];
    containerEl.createEl('h3', { text: 'Custom AI models' });
    
    // Top-level description and Reset button
    const headerControls = containerEl.createDiv({ cls: 'model-table-header-controls' });
    headerControls.createEl('p', { 
      text: 'Configure custom models for each provider. Enable/disable models to control which appear in the model selector.',
      cls: 'setting-item-description'
    });
    
    providers.forEach(providerInfo => {
      const hasKey = this.hasApiKeyForProvider(providerInfo.id);
      const providerModels = this.plugin.settings.customModels.filter((m: CustomModel) => m.provider === providerInfo.id);
      
      const isExpanded = this.expandedSections.has(providerInfo.id);
      const section = containerEl.createDiv({ cls: `provider-section ${isExpanded ? 'expanded' : ''}` });
      const header = section.createDiv({ cls: 'provider-section-header' });
      
      const headerLeft = header.createDiv({ cls: 'provider-header-left' });
      headerLeft.createSpan({ cls: 'provider-chevron', text: isExpanded ? '▼' : '▶' });
      headerLeft.createSpan({ cls: 'provider-title', text: providerInfo.name });
      
      const indicator = headerLeft.createSpan({ 
        cls: `api-key-indicator ${hasKey ? 'success' : 'missing'}`,
        text: hasKey ? '✓' : '○' 
      });
      indicator.setAttribute('title', hasKey ? 'API Key Configured' : 'API Key Not Configured');

      const modelCount = headerLeft.createSpan({ 
        cls: 'provider-model-count', 
        text: `${providerModels.length} models` 
      });
      modelCount.style.color = 'var(--text-muted)';
      modelCount.style.fontSize = '0.85em';

      // Header Right: Verification Button / Spinner / Status
      const headerRight = header.createDiv({ cls: 'provider-header-right' });
      
      if (this.plugin.verifyingProviders.has(providerInfo.id)) {
        headerRight.createDiv({ cls: 'model-verification-spinner' });
        headerRight.createSpan({ text: 'Verifying...', cls: 'verification-status-text' });
      } else {
        const hasUnverified = providerModels.some((m: CustomModel) => m.isNew || !m.lastVerified || m.verificationStatus === 'unverified');
        if (hasUnverified && providerModels.length > 0 && hasKey) {
          const verifyBtn = headerRight.createEl('button', { 
            text: 'Verify models', 
            cls: 'mod-cta verification-btn' 
          });
          verifyBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Don't collapse/expand
            this.plugin.verifyProviderModels(providerInfo.id, () => {
              // Refresh UI when complete if still in settings
              this.display();
            });
            this.display(); // Refresh immediately to show spinner
          });
        } else if (providerModels.length > 0 && hasKey) {
          // Show latency flash icon if there are models with latency data
          const hasLatencyData = providerModels.some((m: CustomModel) => m.verificationLatency !== undefined);
          if (hasLatencyData) {
            const latencyBtn = headerRight.createDiv({ 
              cls: 'clickable-icon latency-flash-btn',
              attr: { title: 'View model latencies' } 
            });
            setIcon(latencyBtn, 'zap');
            latencyBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              new ModelLatencyModal(this.app, providerInfo.name, providerModels).open();
            });
          }

          // Show enabled count with green dot when verification is done
          const enabledCount = providerModels.filter((m: CustomModel) => m.enabled).length;
          const statusContainer = headerRight.createDiv({ cls: 'verification-status-text' });
          statusContainer.createSpan({ cls: 'model-status-dot model-status-verified status-dot-small' });
          statusContainer.createSpan({ text: `Enabled: ${enabledCount}` });
        }
      }

      const content = section.createDiv({ cls: 'provider-section-content' });
      
      header.addEventListener('click', () => {
        const expanded = section.classList.toggle('expanded');
        if (expanded) {
          this.expandedSections.add(providerInfo.id);
        } else {
          this.expandedSections.delete(providerInfo.id);
        }
        header.querySelector('.provider-chevron')!.textContent = expanded ? '▼' : '▶';
      });

      if (!hasKey && providerInfo.id !== 'ollama') {
        const infoDiv = content.createDiv({ cls: 'api-key-info provider-specific api-key-warning' });
        infoDiv.setText(`⚠️ API key for ${providerInfo.name} is not configured. Models below will be disabled.`);
      }

      const table = content.createEl('table', { cls: 'custom-models-table' });
      const thead = table.createEl('thead');
      const headerRow = thead.createEl('tr');
      headerRow.createEl('th', { text: 'Model ID' });
      headerRow.createEl('th', { text: 'Display name' });
      headerRow.createEl('th', { text: 'Token limit/min' });
      headerRow.createEl('th', { text: 'Settings' });
      headerRow.createEl('th', { text: 'Enabled' });

      const tbody = table.createEl('tbody');
      providerModels.forEach((model: CustomModel) => {
        this.createModelRowSimple(tbody, model);
      });

      if (providerModels.length === 0) {
        const emptyRow = tbody.createEl('tr');
        emptyRow.createEl('td', { 
          text: 'No models added for this provider.',
          attr: { colspan: '5' }
        }).style.textAlign = 'center';
      }

      const addBtnContainer = content.createDiv({ cls: 'provider-add-button-container' });
      const addButton = addBtnContainer.createEl('button', { 
        text: `+ Add ${providerInfo.name} model`,
        cls: 'mod-cta'
      });
      addButton.addEventListener('click', () => this.addNewModelRow(containerEl, providerInfo.id));
    });
  }

  private createModelRowSimple(tbody: HTMLElement, model: CustomModel) {
    const row = tbody.createEl('tr', { cls: 'model-row' });

    // Model ID cell
    const idCell = row.createEl('td', { cls: 'model-id-cell' });

    // Status Icon (Dot)
    const statusDot = idCell.createSpan({ cls: 'model-status-dot' });
    if (model.verificationStatus === 'verified') {
      statusDot.setAttribute('title', `Verified: ${new Date(model.lastVerified || 0).toLocaleString()}`);
      statusDot.classList.add('model-status-verified');
    } else if (model.verificationStatus === 'failed') {
      statusDot.setAttribute('title', `Failed: ${model.verificationError || 'Unknown error'}`);
      statusDot.classList.add('model-status-failed');
    } else {
      statusDot.setAttribute('title', 'Unverified');
      statusDot.classList.add('model-status-unverified');
    }

    const idInput = idCell.createEl('input', {
      type: 'text',
      value: model.id,
      cls: 'model-input-wide',
      attr: { placeholder: 'e.g., gemini-2.5-flash' }
    });
    idInput.addEventListener('change', async () => {
      model.id = idInput.value;
      model.verificationStatus = 'unverified'; // Reset status when ID changes
      model.isNew = true;
      await this.plugin.saveSettings();
      this.display(); // Refresh to show unverified status
    });

    // Model Name cell
    const nameCell = row.createEl('td');
    const nameInput = nameCell.createEl('input', {
      type: 'text',
      value: model.name,
      cls: 'model-input-wide',
      attr: { placeholder: 'Display Name' }
    });

    if (model.isNew) {
      const badge = nameCell.createSpan({ text: 'NEW', cls: 'model-new-badge' });
      badge.setAttribute('title', 'Newly discovered or modified model');
    }

    nameInput.addEventListener('change', async () => {
      model.name = nameInput.value;
      await this.plugin.saveSettings();
    });
    // Token Limit cell
    const tokenCell = row.createEl('td');
    const tokenInput = tokenCell.createEl('input', { 
      type: 'number',
      value: model.tokenLimit?.toString() || '',
      cls: 'model-input-number',
      attr: { min: '0', placeholder: 'Optional' }
    });
    tokenInput.addEventListener('change', async () => {
      const limit = parseInt(tokenInput.value);
      model.tokenLimit = isNaN(limit) ? undefined : limit;
      await this.plugin.saveSettings();
    });

    // Settings button cell (three-dot icon)
    const settingsCell = row.createEl('td', { cls: 'cell-center' });
    const settingsBtn = settingsCell.createEl('button', { 
      cls: 'model-settings-btn',
      attr: { title: 'Configure temperature and top_p' }
    });
    setIcon(settingsBtn, 'more-vertical');
    settingsBtn.addEventListener('click', () => {
      this.openModelSettingsModal(model);
    });

    // Enabled checkbox cell
    const enabledCell = row.createEl('td', { cls: 'cell-center' });
    const enabledCheckbox = enabledCell.createEl('input', { 
      type: 'checkbox'
    });
    
    // Check if API key exists for this provider
    const hasApiKey = this.hasApiKeyForProvider(model.provider);
    
    // Disable checkbox if no API key
    if (!hasApiKey && model.provider !== 'ollama') {
      enabledCheckbox.disabled = true;
      enabledCheckbox.checked = false;
      model.enabled = false;
      enabledCell.setAttribute('title', `API key required for ${model.provider}`);
    } else {
      enabledCheckbox.checked = model.enabled !== false;
    }
    
    enabledCheckbox.addEventListener('change', async () => {
      // Double-check API key exists before allowing enable
      if (enabledCheckbox.checked && !this.hasApiKeyForProvider(model.provider) && model.provider !== 'ollama') {
        enabledCheckbox.checked = false;
        const providerName = model.provider === 'groq' ? 'Groq' : 
                            model.provider === 'openrouter' ? 'OpenRouter' : 
                            model.provider === 'opencode' ? 'OpenCode Zen' :
                            model.provider === 'ollama' ? 'Ollama' :
                            model.provider === 'nvidia' ? 'NVIDIA' : 'Google Gemini';
        new Notice(`Cannot enable model: ${providerName} API key is not configured`);
        return;
      }
      
      model.enabled = enabledCheckbox.checked;
      await this.plugin.saveSettings();
      this.display(); // Refresh to update enabled count in header
    });

    // Delete button (appears on hover) - added AFTER all cells
    const deleteBtn = row.createEl('span', { 
      cls: 'row-delete-btn',
      attr: { title: 'Delete model' }
    });
    setIcon(deleteBtn, 'x');
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const modelIndex = this.plugin.settings.customModels.findIndex((m: CustomModel) => m.id === model.id && m.provider === model.provider);
      if (modelIndex > -1) {
        this.plugin.settings.customModels.splice(modelIndex, 1);
        await this.plugin.saveSettings();
        this.display();
        new Notice(`Model '${model.name || model.id}' deleted`);
      }
    });
  }

  private addNewModelRow(container: HTMLElement, provider?: Provider) {
    const newModel: CustomModel = {
      provider: provider || this.plugin.settings.provider,
      id: '',
      name: '',
      enabled: true,
      isNew: true,
      verificationStatus: 'unverified'
    };
    
    this.plugin.settings.customModels.push(newModel);
    this.plugin.saveSettings();
    this.display(); // Refresh to show new row
  }

  private openModelSettingsModal(model: CustomModel) {
    const modal = document.createElement('div');
    modal.className = 'model-settings-modal-container is-visible'; // Add is-visible class
    
    const modalBg = modal.createDiv({ cls: 'model-settings-modal-bg' });
    const modalContent = modal.createDiv({ cls: 'model-settings-modal' });
    
    // Modal header
    const modalHeader = modalContent.createDiv({ cls: 'model-settings-modal-title' });
    modalHeader.setText(`Model settings: ${model.name || model.id}`);
    
    // Modal body
    const modalBody = modalContent.createDiv({ cls: 'model-settings-modal-content' });
    
    // Temperature slider
    const tempContainer = modalBody.createDiv({ cls: 'model-settings-slider-container' });
    tempContainer.createEl('label', { text: 'Temperature' });
    const tempValue = tempContainer.createEl('span', { 
      cls: 'model-settings-slider-value',
      text: (model.temperature ?? 0.7).toFixed(2)
    });
    const tempSlider = tempContainer.createEl('input', {
      type: 'range',
      cls: 'model-settings-slider',
      attr: {
        min: '0',
        max: '2',
        step: '0.01',
        value: (model.temperature ?? 0.7).toString()
      }
    });
    const tempDesc = tempContainer.createEl('div', { 
      cls: 'setting-item-description',
      text: 'Controls randomness. Lower values make output more focused and deterministic. (0.0-2.0)'
    });
    
    tempSlider.addEventListener('input', () => {
      tempValue.setText(parseFloat(tempSlider.value).toFixed(2));
    });
    
    // Top P slider
    const topPContainer = modalBody.createDiv({ cls: 'model-settings-slider-container' });
    topPContainer.createEl('label', { text: 'Top P' });
    const topPValue = topPContainer.createEl('span', { 
      cls: 'model-settings-slider-value',
      text: (model.topP ?? 0.95).toFixed(2)
    });
    const topPSlider = topPContainer.createEl('input', {
      type: 'range',
      cls: 'model-settings-slider',
      attr: {
        min: '0',
        max: '1',
        step: '0.01',
        value: (model.topP ?? 0.95).toString()
      }
    });
    const topPDesc = topPContainer.createEl('div', { 
      cls: 'setting-item-description',
      text: 'Controls diversity via nucleus sampling. Lower values make output more focused. (0.0-1.0)'
    });
    
    topPSlider.addEventListener('input', () => {
      topPValue.setText(parseFloat(topPSlider.value).toFixed(2));
    });
    
    // Modal footer with buttons
    const modalFooter = modalContent.createDiv({ cls: 'model-settings-modal-button-container' });
    
    const resetBtn = modalFooter.createEl('button', { 
      text: 'Reset to defaults',
      cls: 'mod-warning'
    });
    resetBtn.addEventListener('click', () => {
      tempSlider.value = '0.7';
      tempValue.setText('0.70');
      topPSlider.value = '0.95';
      topPValue.setText('0.95');
    });
    
    const cancelBtn = modalFooter.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      document.body.removeChild(modal);
    });
    
    const saveBtn = modalFooter.createEl('button', { 
      text: 'Save',
      cls: 'mod-cta'
    });
    saveBtn.addEventListener('click', async () => {
      model.temperature = parseFloat(tempSlider.value);
      model.topP = parseFloat(topPSlider.value);
      await this.plugin.saveSettings();
      document.body.removeChild(modal);
      new Notice('Model settings saved');
    });
    
    // Close modal on background click
    modalBg.addEventListener('click', () => {
      document.body.removeChild(modal);
    });
    
    // Add modal to body
    document.body.appendChild(modal);
  }

  private createCustomEmbeddingModelsTable(containerEl: HTMLElement) {
    const providers: { id: Provider; name: string }[] = [
      { id: 'gemini', name: 'Google Gemini' },
      { id: 'openrouter', name: 'OpenRouter' },
      { id: 'ollama', name: 'Ollama' },
      { id: 'nvidia', name: 'NVIDIA' },
      ...this.plugin.settings.customProviders
        .filter((p: any) => p.enableEmbeddings)
        .map((p: any) => ({ id: p.id as Provider, name: p.name }))
    ];

    containerEl.createEl('h3', { text: 'Custom embedding models' });
    
    containerEl.createEl('p', { 
      text: 'Configure custom embedding models for each provider.',
      cls: 'setting-item-description'
    });

    providers.forEach(providerInfo => {
      const hasKey = this.hasApiKeyForProvider(providerInfo.id);
      const providerModels = this.plugin.settings.customEmbeddingModels.filter((m: CustomEmbeddingModel) => m.provider === providerInfo.id);
      
      const isExpanded = this.expandedSections.has(providerInfo.id);
      const section = containerEl.createDiv({ cls: `provider-section ${isExpanded ? 'expanded' : ''}` });
      const header = section.createDiv({ cls: 'provider-section-header' });
      
      const headerLeft = header.createDiv({ cls: 'provider-header-left' });
      headerLeft.createSpan({ cls: 'provider-chevron', text: isExpanded ? '▼' : '▶' });
      headerLeft.createSpan({ cls: 'provider-title', text: providerInfo.name });
      
      const indicator = headerLeft.createSpan({ 
        cls: `api-key-indicator ${hasKey ? 'success' : 'missing'}`,
        text: hasKey ? '✓' : '○' 
      });
      indicator.setAttribute('title', hasKey ? 'API Key Configured' : 'API Key Not Configured');

      const modelCount = headerLeft.createSpan({ 
        cls: 'provider-model-count', 
        text: `${providerModels.length} models` 
      });
      modelCount.style.color = 'var(--text-muted)';
      modelCount.style.fontSize = '0.85em';

      // Header Right: Verification Button / Spinner / Status
      const headerRight = header.createDiv({ cls: 'provider-header-right' });

      // Exclude Ollama from verification as requested
      if (providerInfo.id !== 'ollama') {
        if (this.plugin.verifyingEmbeddingProviders.has(providerInfo.id)) {
          headerRight.createDiv({ cls: 'model-verification-spinner' });
          headerRight.createSpan({ text: 'Verifying...', cls: 'verification-status-text' });
        } else {
          const hasUnverified = providerModels.some((m: CustomEmbeddingModel) => m.isNew || !m.lastVerified || m.verificationStatus === 'unverified');
          if (hasUnverified && providerModels.length > 0 && hasKey) {
            const verifyBtn = headerRight.createEl('button', {
              text: 'Verify models',
              cls: 'mod-cta verification-btn'
            });
            verifyBtn.addEventListener('click', (e) => {
              e.stopPropagation(); // Don't collapse/expand
              this.plugin.verifyProviderEmbeddingModels(providerInfo.id, () => {
                // Refresh UI when complete if still in settings
                this.display();
              });
              this.display(); // Refresh immediately to show spinner
            });
          } else if (providerModels.length > 0 && hasKey) {
            // Show enabled count with green dot when verification is done
            const enabledCount = providerModels.filter((m: CustomEmbeddingModel) => m.enabled).length;
            const statusContainer = headerRight.createDiv({ cls: 'verification-status-text' });
            statusContainer.createSpan({ cls: 'model-status-dot model-status-verified status-dot-small' });
            statusContainer.createSpan({ text: `Enabled: ${enabledCount}` });
          }
        }
      }

      const content = section.createDiv({ cls: 'provider-section-content' });
      
      header.addEventListener('click', () => {
        const expanded = section.classList.toggle('expanded');
        if (expanded) {
          this.expandedSections.add(providerInfo.id);
        } else {
          this.expandedSections.delete(providerInfo.id);
        }
        header.querySelector('.provider-chevron')!.textContent = expanded ? '▼' : '▶';
      });

      if (!hasKey && providerInfo.id !== 'ollama') {
        const infoDiv = content.createDiv({ cls: 'api-key-info provider-specific api-key-warning' });
        infoDiv.setText(`⚠️ API key for ${providerInfo.name} is not configured. Embedding models below will be disabled.`);
      }

      const table = content.createEl('table', { cls: 'custom-embedding-models-table' });
      const thead = table.createEl('thead');
      const headerRow = thead.createEl('tr');
      headerRow.createEl('th', { text: 'Model ID' });
      headerRow.createEl('th', { text: 'Display name' });
      headerRow.createEl('th', { text: 'Context Window' });
      headerRow.createEl('th', { text: 'Enabled' });

      const tbody = table.createEl('tbody');
      providerModels.forEach((model: CustomEmbeddingModel) => {
        this.createEmbeddingModelRowSimple(tbody, model);
      });

      if (providerModels.length === 0) {
        const emptyRow = tbody.createEl('tr');
        emptyRow.createEl('td', { 
          text: 'No embedding models added for this provider.',
          attr: { colspan: '4' }
        }).style.textAlign = 'center';
      }

      const addBtnContainer = content.createDiv({ cls: 'provider-add-button-container' });
      const addButton = addBtnContainer.createEl('button', { 
        text: `+ Add ${providerInfo.name} embedding model`,
        cls: 'mod-cta'
      });
      addButton.addEventListener('click', () => this.addNewEmbeddingModelRow(containerEl, providerInfo.id));
    });
  }

  private createEmbeddingModelRowSimple(tbody: HTMLElement, model: CustomEmbeddingModel) {
    const row = tbody.createEl('tr', { cls: 'model-row' });

    // Model ID cell
    const idCell = row.createEl('td', { cls: 'model-id-cell' });

    // Status Icon (Dot)
    const statusDot = idCell.createSpan({ cls: 'model-status-dot' });
    if (model.verificationStatus === 'verified') {
      statusDot.setAttribute('title', `Verified: ${new Date(model.lastVerified || 0).toLocaleString()}`);
      statusDot.classList.add('model-status-verified');
    } else if (model.verificationStatus === 'failed') {
      statusDot.setAttribute('title', `Failed: ${model.verificationError || 'Unknown error'}`);
      statusDot.classList.add('model-status-failed');
    } else {
      statusDot.setAttribute('title', 'Unverified');
      statusDot.classList.add('model-status-unverified');
    }

    const idInput = idCell.createEl('input', { 
      type: 'text',
      value: model.id,
      cls: 'model-input-wide',
      attr: { placeholder: 'e.g., text-embedding-004' }
    });
    idInput.addEventListener('change', async () => {
      model.id = idInput.value;
      model.verificationStatus = 'unverified'; // Reset status when ID changes
      model.isNew = true;
      await this.plugin.saveSettings();
      this.display(); // Refresh to update dots
    });

    // Display Name cell
    const nameCell = row.createEl('td');
    const nameInput = nameCell.createEl('input', { 
      type: 'text',
      value: model.name,
      cls: 'model-input-wide',
      attr: { placeholder: 'Display Name' }
    });

    if (model.isNew) {
      const badge = nameCell.createSpan({ text: 'NEW', cls: 'model-new-badge' });
      badge.setAttribute('title', 'Newly discovered or modified model');
    }

    nameInput.addEventListener('change', async () => {
      model.name = nameInput.value;
      await this.plugin.saveSettings();
    });

    // Context Window cell (read-only display)
    const contextWindowCell = row.createEl('td');
    const contextWindowText = model.contextWindow
      ? `${model.contextWindow.toLocaleString()} tokens`
      : '—';
    contextWindowCell.createSpan({ text: contextWindowText, cls: 'model-context-window' });

    // Enabled checkbox
    const enabledCell = row.createEl('td', { cls: 'cell-center' });
    const enabledCheckbox = enabledCell.createEl('input', { type: 'checkbox' });
    
    const hasApiKey = this.hasApiKeyForProvider(model.provider);
    const isOllamaLocal = model.provider === 'ollama' && this.plugin.settings.ollamaMode === 'local';
    
    if (!hasApiKey && !isOllamaLocal) {
      enabledCheckbox.disabled = true;
      enabledCheckbox.checked = false;
      model.enabled = false;
    } else {
      enabledCheckbox.checked = model.enabled !== false;
    }

    enabledCheckbox.addEventListener('change', async () => {
      model.enabled = enabledCheckbox.checked;
      await this.plugin.saveSettings();
      this.display(); // Refresh to update enabled count in header
    });

    // Delete button
    const deleteBtn = row.createEl('span', { 
      cls: 'row-delete-btn',
      attr: { title: 'Delete embedding model' }
    });
    setIcon(deleteBtn, 'x');
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const modelIndex = this.plugin.settings.customEmbeddingModels.indexOf(model);
      if (modelIndex > -1) {
        this.plugin.settings.customEmbeddingModels.splice(modelIndex, 1);
        await this.plugin.saveSettings();
        this.display();
      }
    });
  }

  private addNewEmbeddingModelRow(container: HTMLElement, provider?: Provider) {
    const newModel: CustomEmbeddingModel = {
      provider: provider || this.plugin.settings.provider,
      id: '',
      name: '',
      enabled: true
    };
    
    this.plugin.settings.customEmbeddingModels.push(newModel);
    this.plugin.saveSettings();
    this.display(); // Refresh to show new row
  }

  /**
   * Creates the exclusion settings UI with folder and file autocomplete.
   */
  private createExclusionSettings(containerEl: HTMLElement) {
    const exclusionContainer = containerEl.createDiv({ cls: 'exclusion-settings-container' });
    
    // Folder exclusion input with autocomplete
    const folderSection = exclusionContainer.createDiv({ cls: 'exclusion-input-section' });
    folderSection.createEl('label', { text: 'Exclude Folders', cls: 'exclusion-label' });
    
    const folderInputWrapper = folderSection.createDiv({ cls: 'autocomplete-wrapper' });
    const folderInput = folderInputWrapper.createEl('input', {
      type: 'text',
      cls: 'exclusion-input',
      attr: { placeholder: 'Type folder name to exclude...' }
    });
    const folderSuggestions = folderInputWrapper.createDiv({ cls: 'autocomplete-suggestions' });
    
    // Get all folders from vault, excluding already excluded ones
    const allFolders = this.app.vault.getAllLoadedFiles()
      .filter(f => (f as any).children !== undefined)
      .map(f => f.path)
      .filter(path => !this.plugin.settings.excludedFolders?.includes(path));
    
    this.setupAutocomplete(folderInput, folderSuggestions, allFolders, async (selected) => {
      if (!this.plugin.settings.excludedFolders.includes(selected)) {
        this.plugin.settings.excludedFolders.push(selected);
        await this.plugin.saveSettings();
        this.display();
        new Notice(`Folder '${selected}' excluded from indexing`);
      }
    });

    // File exclusion input with autocomplete
    const fileSection = exclusionContainer.createDiv({ cls: 'exclusion-input-section' });
    fileSection.createEl('label', { text: 'Exclude Files', cls: 'exclusion-label' });
    
    const fileInputWrapper = fileSection.createDiv({ cls: 'autocomplete-wrapper' });
    const fileInput = fileInputWrapper.createEl('input', {
      type: 'text',
      cls: 'exclusion-input',
      attr: { placeholder: 'Type file name to exclude...' }
    });
    const fileSuggestions = fileInputWrapper.createDiv({ cls: 'autocomplete-suggestions' });
    
    // Get all markdown and PDF files from vault, excluding already excluded ones
    const allFiles = this.app.vault.getFiles()
      .filter(f => f.extension === 'md' || f.extension === 'pdf')
      .map(f => f.path)
      .filter(path => !this.plugin.settings.excludedFiles?.includes(path));
    
    this.setupAutocomplete(fileInput, fileSuggestions, allFiles, async (selected) => {
      if (!this.plugin.settings.excludedFiles) {
        this.plugin.settings.excludedFiles = [];
      }
      if (!this.plugin.settings.excludedFiles.includes(selected)) {
        this.plugin.settings.excludedFiles.push(selected);
        await this.plugin.saveSettings();
        this.display();
        new Notice(`File '${selected}' excluded from indexing`);
      }
    });

    // Collapsible section to show current exclusions
    const exclusionsDisplay = exclusionContainer.createDiv({ cls: 'exclusions-display' });
    const exclusionsHeader = exclusionsDisplay.createDiv({ cls: 'exclusions-header' });
    const toggleIcon = exclusionsHeader.createEl('span', { cls: 'exclusions-toggle-icon', text: '▶' });
    exclusionsHeader.createEl('span', { text: 'View Excluded Items', cls: 'exclusions-title' });
    
    const exclusionsContent = exclusionsDisplay.createDiv({ cls: 'exclusions-content collapsed' });
    
    // Toggle collapse
    exclusionsHeader.addEventListener('click', () => {
      const isCollapsed = exclusionsContent.classList.contains('collapsed');
      exclusionsContent.classList.toggle('collapsed');
      toggleIcon.textContent = isCollapsed ? '▼' : '▶';
    });

    // Excluded folders list
    const foldersListSection = exclusionsContent.createDiv({ cls: 'exclusion-list-section' });
    foldersListSection.createEl('h5', { text: 'Excluded Folders' });
    const foldersList = foldersListSection.createDiv({ cls: 'exclusion-list' });
    
    const excludedFolders: string[] = this.plugin.settings.excludedFolders || [];
    if (excludedFolders.length === 0) {
      foldersList.createEl('span', { text: 'No folders excluded', cls: 'no-exclusions' });
    } else {
      excludedFolders.forEach((folder: string) => {
        const item = foldersList.createDiv({ cls: 'exclusion-item' });
        item.createEl('span', { text: folder, cls: 'exclusion-item-text' });
        const removeBtn = item.createEl('span', { cls: 'exclusion-remove-btn', text: '×' });
        removeBtn.addEventListener('click', async () => {
          const idx = this.plugin.settings.excludedFolders.indexOf(folder);
          if (idx > -1) {
            this.plugin.settings.excludedFolders.splice(idx, 1);
            await this.plugin.saveSettings();
            this.display();
            new Notice(`Folder '${folder}' removed from exclusions`);
          }
        });
      });
    }

    // Excluded files list
    const filesListSection = exclusionsContent.createDiv({ cls: 'exclusion-list-section' });
    filesListSection.createEl('h5', { text: 'Excluded Files' });
    const filesList = filesListSection.createDiv({ cls: 'exclusion-list' });
    
    const excludedFiles: string[] = this.plugin.settings.excludedFiles || [];
    if (excludedFiles.length === 0) {
      filesList.createEl('span', { text: 'No files excluded', cls: 'no-exclusions' });
    } else {
      excludedFiles.forEach((file: string) => {
        const item = filesList.createDiv({ cls: 'exclusion-item' });
        item.createEl('span', { text: file, cls: 'exclusion-item-text' });
        const removeBtn = item.createEl('span', { cls: 'exclusion-remove-btn', text: '×' });
        removeBtn.addEventListener('click', async () => {
          const idx = this.plugin.settings.excludedFiles.indexOf(file);
          if (idx > -1) {
            this.plugin.settings.excludedFiles.splice(idx, 1);
            await this.plugin.saveSettings();
            this.display();
            new Notice(`File '${file}' removed from exclusions`);
          }
        });
      });
    }
  }

  /**
   * Sets up autocomplete functionality for an input element.
   */
  private setupAutocomplete(
    input: HTMLInputElement, 
    suggestionsEl: HTMLElement, 
    items: string[], 
    onSelect: (item: string) => void
  ) {
    let selectedIndex = -1;

    input.addEventListener('input', () => {
      const query = input.value.toLowerCase().trim();
      suggestionsEl.empty();
      selectedIndex = -1;

      if (query.length === 0) {
        suggestionsEl.style.display = 'none';
        return;
      }

      const matches = items
        .filter(item => item.toLowerCase().includes(query))
        .slice(0, 10); // Limit to 10 suggestions

      if (matches.length === 0) {
        suggestionsEl.style.display = 'none';
        return;
      }

      suggestionsEl.style.display = 'block';
      matches.forEach((match, idx) => {
        const suggestion = suggestionsEl.createDiv({ cls: 'autocomplete-suggestion' });
        suggestion.textContent = match;
        suggestion.addEventListener('click', () => {
          onSelect(match);
          input.value = '';
          suggestionsEl.style.display = 'none';
        });
        suggestion.addEventListener('mouseenter', () => {
          selectedIndex = idx;
          this.updateSuggestionHighlight(suggestionsEl, selectedIndex);
        });
      });
    });

    input.addEventListener('keydown', (e) => {
      const suggestions = suggestionsEl.querySelectorAll('.autocomplete-suggestion');
      if (suggestions.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1);
        this.updateSuggestionHighlight(suggestionsEl, selectedIndex);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        this.updateSuggestionHighlight(suggestionsEl, selectedIndex);
      } else if (e.key === 'Enter' && selectedIndex >= 0) {
        e.preventDefault();
        const selected = suggestions[selectedIndex] as HTMLElement;
        onSelect(selected.textContent || '');
        input.value = '';
        suggestionsEl.style.display = 'none';
      } else if (e.key === 'Escape') {
        suggestionsEl.style.display = 'none';
      }
    });

    input.addEventListener('blur', () => {
      // Delay to allow click on suggestion
      setTimeout(() => {
        suggestionsEl.style.display = 'none';
      }, 200);
    });
  }

  private updateSuggestionHighlight(suggestionsEl: HTMLElement, selectedIndex: number) {
    const suggestions = suggestionsEl.querySelectorAll('.autocomplete-suggestion');
    suggestions.forEach((s, idx) => {
      s.classList.toggle('selected', idx === selectedIndex);
    });
  }

  /**
   * Runs detectChanges() silently — result is consumed by the AI chat
   * index status dot, not displayed in the settings UI.
   */
  private async checkIndexChanges(): Promise<void> {
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (!this.plugin.embeddingsManager || typeof this.plugin.embeddingsManager.detectChanges !== 'function') {
        return;
      }
      // Pass the selected embedding index ID so detectChanges reads the correct file
      const selectedId = this.plugin.settings.selectedEmbeddingIndexId;
      if (selectedId) {
        await this.plugin.embeddingsManager.detectChanges(selectedId);
      }
    } catch (error) {
          }
  }


  private renderMCPPrerequisites(containerEl: HTMLElement): void {
    const checked = this.plugin.settings.mcpPrereqsChecked ?? {};

    // If both are already confirmed, show nothing
    if (checked.node && checked.uvx) return;

    const prereqs: Array<{
      key: 'node' | 'uvx';
      label: string;
      cmd: string;
      installUrl: string;
      installLabel: string;
      note: string;
    }> = [
      {
        key: 'node',
        label: 'Node.js',
        cmd: 'node --version',
        installUrl: 'https://nodejs.org/en/download',
        installLabel: 'Download Node.js',
        note: 'Required for all stdio MCP servers (npx commands).',
      },
      {
        key: 'uvx',
        label: 'uv / uvx',
        cmd: 'uvx --version',
        installUrl: 'https://docs.astral.sh/uv/getting-started/installation/',
        installLabel: 'Install uv',
        note: 'Required for Python-based MCP servers (uvx commands).',
      },
    ];

    const wrapper = containerEl.createDiv({ cls: 'mcp-prereq-wrapper' });
    wrapper.createEl('p', {
      text: 'MCP Prerequisites — check that the required runtimes are installed on this machine:',
      cls: 'mcp-prereq-heading',
    });

    const row = wrapper.createDiv({ cls: 'mcp-prereq-row' });

    prereqs.forEach(({ key, label, cmd, installUrl, installLabel, note }) => {
      if (checked[key]) return; // already confirmed — skip

      const card = row.createDiv({ cls: 'mcp-prereq-card' });
      card.createEl('strong', { text: label });
      card.createEl('p', { text: note, cls: 'mcp-prereq-note' });

      const statusEl = card.createDiv({ cls: 'mcp-prereq-status' });

      const checkBtn = card.createEl('button', {
        text: `Check ${label}`,
        cls: 'mcp-prereq-btn',
      });

      checkBtn.addEventListener('click', async () => {
        checkBtn.disabled = true;
        checkBtn.textContent = 'Checking…';
        statusEl.textContent = '';
        statusEl.className = 'mcp-prereq-status';

        try {
          if (Platform.isMobile) {
            new Notice('Prerequisite check is only available on desktop.');
            checkBtn.disabled = false;
            checkBtn.textContent = `Check ${label}`;
            return;
          }
          // Use Node's child_process — available in Electron/Obsidian desktop
          const { execSync } = (window as any).require('child_process') as typeof import('child_process');
          const version = execSync(cmd, { timeout: 5000, encoding: 'utf8' }).trim();

          statusEl.textContent = `✅ Installed — ${version}`;
          statusEl.classList.add('mcp-prereq-ok');
          checkBtn.textContent = `✓ ${label} found`;

          // Persist so the card disappears on next settings open
          if (!this.plugin.settings.mcpPrereqsChecked) {
            this.plugin.settings.mcpPrereqsChecked = {};
          }
          this.plugin.settings.mcpPrereqsChecked[key] = true;
          await this.plugin.saveSettings();

          // Fade out and remove the card after a short delay
          setTimeout(() => {
            card.style.transition = 'opacity 0.4s';
            card.style.opacity = '0';
            setTimeout(() => {
              card.remove();
              // If all cards gone, remove the whole wrapper
              if (row.children.length === 0) wrapper.remove();
            }, 420);
          }, 1200);

        } catch {
          statusEl.textContent = `❌ Not found`;
          statusEl.classList.add('mcp-prereq-missing');
          checkBtn.textContent = `Check ${label}`;
          checkBtn.disabled = false;

          // Show install link
          if (!card.querySelector('.mcp-prereq-install-link')) {
            const linkRow = card.createDiv({ cls: 'mcp-prereq-install-link' });
            linkRow.createEl('span', { text: 'Not installed — ' });
            const a = linkRow.createEl('a', { text: `${installLabel} ↗`, cls: 'mcp-prereq-link' });
            a.href = installUrl;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
          }
        }
      });
    });
  }

  private renderMCPServersTable(containerEl: HTMLElement): void {
    const servers = this.plugin.settings.mcpServers || [];

    // Create table container
    const tableContainer = containerEl.createDiv({ cls: 'mcp-servers-table-container modern-table' });
    
    // Create table
    const table = tableContainer.createEl('table', { cls: 'mcp-servers-table' });
    
    // Create header
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    
    headerRow.createEl('th', { text: 'Name' });
    headerRow.createEl('th', { text: 'Transport' });
    headerRow.createEl('th', { text: 'Command/URL' });
    headerRow.createEl('th', { text: 'Arguments/Auth' });
    headerRow.createEl('th', { text: 'Status' });
    headerRow.createEl('th', { text: 'Actions' });

    // Create body
    const tbody = table.createEl('tbody');
    
    // Add existing servers
    servers.forEach((server: MCPServerConfig, index: number) => {
      this.createMCPServerRow(tbody, server, index);
    });

    // If no servers, show empty state
    if (servers.length === 0) {
      const emptyRow = tbody.createEl('tr');
      const emptyCell = emptyRow.createEl('td', { 
        text: 'No MCP servers configured. Click "Add MCP Server" to get started.',
        attr: { colspan: '6' }
      });
      emptyCell.style.textAlign = 'center';
      emptyCell.style.fontStyle = 'italic';
      emptyCell.style.color = 'var(--text-muted)';
    }
    
    // Add new server button
    const buttonContainer = tableContainer.createDiv({ cls: 'mcp-table-buttons' });
    const addButton = buttonContainer.createEl('button', { 
      text: '+ Add MCP Server',
      cls: 'mod-cta'
    });
    addButton.addEventListener('click', () => this.addNewMCPServer(tableContainer));
  }

  private createMCPServerRow(tbody: HTMLElement, server: MCPServerConfig, index: number): void {
    const row = tbody.createEl('tr');
    
    // Name cell
    const nameCell = row.createEl('td');
    nameCell.setText(server.name);
    
    // Transport cell
    const transportCell = row.createEl('td');
    transportCell.setText(server.transport.toUpperCase());
    transportCell.style.fontWeight = '600';
    transportCell.style.fontSize = '0.85em';
    
    // Command/URL cell
    const commandCell = row.createEl('td');
    if (server.transport === 'stdio') {
      commandCell.setText(server.command || '');
    } else {
      commandCell.setText(server.url || '');
    }
    commandCell.style.fontFamily = 'monospace';
    commandCell.style.fontSize = '0.9em';
    commandCell.style.wordBreak = 'break-all';
    commandCell.style.whiteSpace = 'normal';
    
    // Arguments cell
    const argsCell = row.createEl('td');
    if (server.transport === 'stdio') {
      argsCell.setText(server.args?.join(' ') || '');
    } else {
      argsCell.setText(server.apiKey ? '🔑 API Key Set' : '-');
    }
    argsCell.style.fontFamily = 'monospace';
    argsCell.style.fontSize = '0.9em';
    argsCell.style.wordBreak = 'break-all';
    argsCell.style.whiteSpace = 'normal';
    
    // Status cell
    const statusCell = row.createEl('td');
    const statusBadge = statusCell.createEl('span', { 
      cls: `mcp-status-badge ${server.disabled ? 'disabled' : 'enabled'}`,
      text: server.disabled ? 'Disabled' : 'Enabled'
    });
    
    // Actions cell
    const actionsCell = row.createEl('td');
    actionsCell.style.display = 'flex';
    actionsCell.style.gap = '8px';
    
    // Edit button
    const editBtn = actionsCell.createEl('button', { 
      cls: 'mcp-action-btn',
      attr: { 'aria-label': 'Edit server' }
    });
    setIcon(editBtn, 'pencil');
    editBtn.addEventListener('click', () => this.editMCPServer(index));
    
    // Toggle button
    const toggleBtn = actionsCell.createEl('button', { 
      cls: 'mcp-action-btn',
      attr: { 'aria-label': server.disabled ? 'Enable server' : 'Disable server' }
    });
    setIcon(toggleBtn, server.disabled ? 'play' : 'pause');
    toggleBtn.addEventListener('click', async () => {
      const wasDisabled = this.plugin.settings.mcpServers[index].disabled;
      this.plugin.settings.mcpServers[index].disabled = !wasDisabled;
      await this.plugin.saveSettings();

      // If enabling and auto-connect is on, start the server immediately
      if (wasDisabled && (this.plugin.settings.mcpAutoConnect ?? true)) {
        const srv = this.plugin.settings.mcpServers[index];
        this.plugin.mcpService.connectServer(srv).catch((err: unknown) => {
                    new Notice(`Failed to connect to MCP server ${srv.name}`);
        });
      }

      // If disabling, disconnect the server
      if (!wasDisabled) {
        const srv = this.plugin.settings.mcpServers[index];
        this.plugin.mcpService.disconnectServer(srv.id).catch((err: unknown) => {
                  });
      }

      this.display();
    });
    
    // Delete button
    const deleteBtn = actionsCell.createEl('button', { 
      cls: 'mcp-action-btn mcp-delete-btn',
      attr: { 'aria-label': 'Delete server' }
    });
    setIcon(deleteBtn, 'trash-2');
    deleteBtn.addEventListener('click', async () => {
      if (confirm(`Delete MCP server "${server.name}"?`)) {
        this.plugin.settings.mcpServers.splice(index, 1);
        await this.plugin.saveSettings();
        this.display();
      }
    });
  }

  private addNewMCPServer(container: HTMLElement): void {
    const modal = new MCPServerModal(this.app, async (server: MCPServerConfig) => {
      if (!this.plugin.settings.mcpServers) {
        this.plugin.settings.mcpServers = [];
      }
      this.plugin.settings.mcpServers.push(server);
      await this.plugin.saveSettings();

      // If auto-connect is on and server is enabled, connect immediately
      if ((this.plugin.settings.mcpAutoConnect ?? true) && !server.disabled) {
        this.plugin.mcpService.connectServer(server).catch((err: unknown) => {
                    new Notice(`Failed to connect to MCP server ${server.name}`);
        });
      }

      this.display();
    });
    modal.open();
  }

  private editMCPServer(index: number): void {
    const server = this.plugin.settings.mcpServers[index];
    const modal = new MCPServerModal(this.app, async (updatedServer: MCPServerConfig) => {
      this.plugin.settings.mcpServers[index] = updatedServer;
      await this.plugin.saveSettings();
      this.display();
    }, server);
    modal.open();
  }
}

/**
 * Parse a shell-like argument string into an array of arguments.
 * Handles double-quoted strings (preserving spaces inside them) and
 * unquoted tokens split on whitespace.
 * Examples:
 *   '-y @antv/mcp-server-chart'          → ['-y', '@antv/mcp-server-chart']
 *   '-y "E:\\My Vault Folder"'           → ['-y', 'E:\\My Vault Folder']
 *   '--path "C:\\Program Files\\app"'    → ['--path', 'C:\\Program Files\\app']
 */
function parseArgsString(argsStr: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];

    if (inQuote) {
      if (ch === '\\' && i + 1 < argsStr.length && argsStr[i + 1] === quoteChar) {
        // Escaped quote inside quoted string
        current += quoteChar;
        i++;
      } else if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) args.push(current);
  return args;
}

// MCP Server Configuration Modal
class MCPServerModal extends Modal {
  private onSubmit: (server: MCPServerConfig) => void;
  private existingServer?: MCPServerConfig;
  
  private nameInput!: HTMLInputElement;
  private transportSelect!: HTMLSelectElement;
  private commandInput!: HTMLInputElement;
  private argsInput!: HTMLInputElement;
  private streamUrlInput!: HTMLInputElement;
  private urlInput!: HTMLInputElement;
  private apiKeyInput!: HTMLInputElement;
  private envInput!: HTMLTextAreaElement;
  private stdioContainer!: HTMLElement;
  private sseContainer!: HTMLElement;
  private fieldsContainer!: HTMLElement;
  private schemaContainer!: HTMLElement;
  private schemaInput!: HTMLTextAreaElement;
  private isSchemaView = false;

  constructor(app: App, onSubmit: (server: MCPServerConfig) => void, existingServer?: MCPServerConfig) {
    super(app);
    this.onSubmit = onSubmit;
    this.existingServer = existingServer;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    const titleRow = contentEl.createDiv({ cls: 'mcp-modal-title-row' });
    titleRow.createEl('h2', { text: this.existingServer ? 'Edit MCP Server' : 'Add MCP Server' });

    const titleButtons = titleRow.createDiv({ cls: 'mcp-modal-title-buttons', attr: { style: 'display: flex; gap: 8px;' } });

    // Schema View Toggle
    const schemaToggleBtn = titleButtons.createEl('button', {
      text: '📄 Schema View',
      cls: 'mcp-schema-view-toggle',
    });
    schemaToggleBtn.addEventListener('click', () => {
      this.isSchemaView = !this.isSchemaView;
      schemaToggleBtn.toggleClass('is-active', this.isSchemaView);
      this.updateViewMode();
    });

    // Browse Catalog button (only shown when adding a new server)
    if (!this.existingServer) {
      const browseBtn = titleButtons.createEl('button', {
        text: '🔌 Browse Catalog',
        cls: 'mcp-browse-catalog-btn',
      });
      browseBtn.addEventListener('click', () => {
        this.close();
        const registry = new MCPRegistryModal(this.app, (entry: MCPRegistryEntry, resolvedEnv: Record<string, string>, resolvedArgs?: string[]) => {
          // Re-open this modal and auto-fill from the registry entry
          const modal = new MCPServerModal(this.app, this.onSubmit);
          modal.open();
          modal.autofillFromRegistry(entry, resolvedEnv, resolvedArgs);
        });
        registry.open();
      });
    }

    // Fields Container
    this.fieldsContainer = contentEl.createDiv('mcp-fields-container');

    // Name
    new Setting(this.fieldsContainer)
      .setName('Server Name')
      .setDesc('A friendly name for this MCP server')
      .addText(text => {
        this.nameInput = text.inputEl;
        text.setPlaceholder('My MCP Server')
          .setValue(this.existingServer?.name || '');
      });
    
    // Transport Type
    new Setting(this.fieldsContainer)
      .setName('Transport Type')
      .setDesc('Choose how to connect to the MCP server')
      .addDropdown(dropdown => {
        this.transportSelect = dropdown.selectEl;
        dropdown.addOption('stdio', 'stdio (Local Process)')
          .addOption('sse', 'SSE (HTTP/HTTPS)')
          .setValue(this.existingServer?.transport || 'stdio')
          .onChange((value) => {
            this.updateTransportFields(value as 'stdio' | 'sse');
          });
      });
    
    // stdio fields container
    this.stdioContainer = this.fieldsContainer.createDiv({ cls: 'mcp-transport-fields' });
    
    // Command
    new Setting(this.stdioContainer)
      .setName('Command')
      .setDesc('The command to execute (e.g., uvx, node, python)')
      .addText(text => {
        this.commandInput = text.inputEl;
        text.setPlaceholder('uvx')
          .setValue(this.existingServer?.command || '');
      });
    
    // Arguments
    new Setting(this.stdioContainer)
      .setName('Arguments')
      .setDesc('Space-separated command arguments')
      .addText(text => {
        this.argsInput = text.inputEl;
        text.setPlaceholder('mcp-server-package@latest')
          .setValue(this.existingServer?.args?.join(' ') || '');
      });

    // Streaming URL (optional, for stdio servers that also expose a local HTTP/SSE endpoint)
    const streamUrlInfo = this.stdioContainer.createDiv({ cls: 'mcp-stream-url-info' });
    streamUrlInfo.createSpan({ text: 'ℹ️', cls: 'mcp-stream-url-info-icon' });
    const infoText = streamUrlInfo.createSpan();
    infoText.appendText('Some stdio servers (e.g. ');
    infoText.createEl('code', { text: 'mcp-proxy' });
    infoText.appendText(', certain Python/Node servers) also expose a local HTTP endpoint for streaming. If the server\'s docs mention a ');
    infoText.createEl('code', { text: 'localhost' });
    infoText.appendText(' URL or ');
    infoText.createEl('code', { text: '--port' });
    infoText.appendText(' flag, enter it below.');

    new Setting(this.stdioContainer)
      .setName('Streaming URL (Optional)')
      .setDesc('Local HTTP/SSE endpoint the process listens on — e.g. http://localhost:3000/sse. Leave blank if the server communicates only via stdin/stdout.')
      .addText(text => {
        this.streamUrlInput = text.inputEl;
        text.setPlaceholder('http://localhost:3000/sse')
          .setValue(this.existingServer?.streamUrl || '');
      });
    
    // SSE fields container
    this.sseContainer = this.fieldsContainer.createDiv({ cls: 'mcp-transport-fields' });
    
    // URL
    new Setting(this.sseContainer)
      .setName('Server URL')
      .setDesc('The HTTP/HTTPS endpoint for the MCP server')
      .addText(text => {
        this.urlInput = text.inputEl;
        text.setPlaceholder('https://api.example.com/mcp')
          .setValue(this.existingServer?.url || '');
      });
    
    // API Key
    new Setting(this.sseContainer)
      .setName('API Key (Optional)')
      .setDesc('Authentication key for the MCP server')
      .addText(text => {
        this.apiKeyInput = text.inputEl;
        text.setPlaceholder('your-api-key')
          .setValue(this.existingServer?.apiKey || '');
        text.inputEl.type = 'password';
      });
    
    // Environment variables (shared)
    new Setting(this.fieldsContainer)
      .setName('Environment Variables (Optional)')
      .setDesc('JSON object of environment variables (e.g., {"API_KEY": "value"})')
      .addTextArea(text => {
        this.envInput = text.inputEl;
        text.setPlaceholder('{"API_KEY": "your-key"}')
          .setValue(this.existingServer?.env ? JSON.stringify(this.existingServer.env, null, 2) : '');
        text.inputEl.rows = 4;
      });

    // Schema Container
    this.schemaContainer = contentEl.createDiv({ cls: 'mcp-schema-container' });
    this.schemaContainer.createEl('p', { 
      text: 'Paste a raw MCP server configuration JSON. It can be a full "mcpServers" dictionary or a single server object.',
      cls: 'setting-item-description'
    });
    this.schemaInput = this.schemaContainer.createEl('textarea', {
      cls: 'mcp-schema-textarea',
      attr: { rows: '12', placeholder: '{\n  "command": "npx",\n  "args": ["@modelcontextprotocol/server-everything"]\n}' }
    });
    
    // Initialize visibility
    this.updateTransportFields(this.existingServer?.transport || 'stdio');
    this.updateViewMode();
    
    // Buttons
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    buttonContainer.style.display = 'flex';
    buttonContainer.style.justifyContent = 'flex-end';
    buttonContainer.style.gap = '8px';
    buttonContainer.style.marginTop = '16px';
    
    const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());
    
    const saveBtn = buttonContainer.createEl('button', { text: 'Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => this.handleSubmit());
  }

  private updateViewMode(): void {
    if (this.isSchemaView) {
      this.fieldsContainer.style.display = 'none';
      this.schemaContainer.style.display = 'block';
      
      // Try to populate schema from fields if empty or just switched
      const currentConfig = this.getCurrentConfigFromFields();
      if (currentConfig) {
        // Strip out ID and disabled state for cleaner schema view
        const { id, disabled, name, ...schemaFields } = currentConfig as any;
        this.schemaInput.value = JSON.stringify(schemaFields, null, 2);
      }
    } else {
      this.fieldsContainer.style.display = 'block';
      this.schemaContainer.style.display = 'none';
      
      // Try to populate fields from schema if schema was edited
      this.syncFieldsFromSchema();
    }
  }

  private syncFieldsFromSchema(): void {
    const rawValue = this.schemaInput.value.trim();
    if (!rawValue) return;

    try {
      let parsed = JSON.parse(rawValue);
      
      // Handle the case where someone pastes the full "mcpServers" object
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        const keys = Object.keys(parsed.mcpServers);
        if (keys.length > 0) {
          if (this.nameInput && !this.nameInput.value) this.nameInput.value = keys[0];
          parsed = parsed.mcpServers[keys[0]];
        }
      }

      if (parsed.transport) {
        this.transportSelect.value = parsed.transport;
        this.updateTransportFields(parsed.transport);
      } else if (parsed.command) {
        this.transportSelect.value = 'stdio';
        this.updateTransportFields('stdio');
      } else if (parsed.url) {
        this.transportSelect.value = 'sse';
        this.updateTransportFields('sse');
      }

      if (this.transportSelect.value === 'stdio') {
        if (parsed.command) this.commandInput.value = parsed.command;
        if (parsed.args) {
          this.argsInput.value = Array.isArray(parsed.args) 
            ? parsed.args.map((a: string) => a.includes(' ') ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ')
            : parsed.args;
        }
        if (parsed.streamUrl) this.streamUrlInput.value = parsed.streamUrl;
      } else {
        if (parsed.url) this.urlInput.value = parsed.url;
        if (parsed.apiKey) this.apiKeyInput.value = parsed.apiKey;
      }

      if (parsed.env && typeof parsed.env === 'object') {
        this.envInput.value = JSON.stringify(parsed.env, null, 2);
      }
    } catch (e) {
      // Silently fail if JSON is invalid during switch
    }
  }

  private getCurrentConfigFromFields(): Partial<MCPServerConfig> | null {
    if (!this.transportSelect) return null;
    const transport = this.transportSelect.value as 'stdio' | 'sse';
    const config: any = { transport };
    
    if (this.nameInput.value) config.name = this.nameInput.value;
    
    if (transport === 'stdio') {
      if (this.commandInput.value) config.command = this.commandInput.value;
      if (this.argsInput.value) config.args = parseArgsString(this.argsInput.value);
      if (this.streamUrlInput.value) config.streamUrl = this.streamUrlInput.value;
    } else {
      if (this.urlInput.value) config.url = this.urlInput.value;
      if (this.apiKeyInput.value) config.apiKey = this.apiKeyInput.value;
    }
    
    const envStr = this.envInput.value.trim();
    if (envStr) {
      try {
        config.env = JSON.parse(envStr);
      } catch (e) {}
    }
    
    return config;
  }

  private updateTransportFields(transport: 'stdio' | 'sse'): void {
    if (transport === 'stdio') {
      this.stdioContainer.style.display = 'block';
      this.sseContainer.style.display = 'none';
    } else {
      this.stdioContainer.style.display = 'none';
      this.sseContainer.style.display = 'block';
    }
  }

  private handleSubmit(): void {
    if (this.isSchemaView) {
      this.syncFieldsFromSchema();
    }

    const name = this.nameInput.value.trim();
    const transport = this.transportSelect.value as 'stdio' | 'sse';
    const envStr = this.envInput.value.trim();
    
    if (!name) {
      new Notice('Name is required');
      return;
    }
    
    let env: Record<string, string> | undefined;
    if (envStr) {
      try {
        env = JSON.parse(envStr);
      } catch (error) {
        new Notice('Invalid JSON for environment variables');
        return;
      }
    }
    
    const server: MCPServerConfig = {
      id: this.existingServer?.id || `mcp-${Date.now()}`,
      name,
      transport,
      env,
      disabled: this.existingServer?.disabled || false
    };
    
    if (transport === 'stdio') {
      const command = this.commandInput.value.trim();
      const argsStr = this.argsInput.value.trim();
      
      if (!command) {
        new Notice('Command is required for stdio transport');
        return;
      }
      
      server.command = command;
      server.args = argsStr ? parseArgsString(argsStr) : [];

      const streamUrl = this.streamUrlInput.value.trim();
      if (streamUrl) {
        if (!streamUrl.startsWith('http://') && !streamUrl.startsWith('https://')) {
          new Notice('Streaming URL must start with http:// or https://');
          return;
        }
        server.streamUrl = streamUrl;
      }
    } else if (transport === 'sse') {
      const url = this.urlInput.value.trim();
      
      if (!url) {
        new Notice('URL is required for SSE transport');
        return;
      }
      
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        new Notice('URL must start with http:// or https://');
        return;
      }
      
      server.url = url;
      server.apiKey = this.apiKeyInput.value.trim() || undefined;
    }
    
    this.onSubmit(server);
    this.close();
  }

  /**
   * Auto-fills the form from a registry entry + resolved env vars collected by the wizard.
   * Called after the user picks a server from the catalog.
   */
  autofillFromRegistry(entry: MCPRegistryEntry, resolvedEnv: Record<string, string>, resolvedArgs?: string[]): void {
    // Wait one tick for the modal DOM to be ready
    setTimeout(() => {
      if (this.nameInput) this.nameInput.value = entry.name;

      // Set transport
      if (this.transportSelect) {
        this.transportSelect.value = entry.transport;
        this.updateTransportFields(entry.transport);
      }

      if (entry.transport === 'stdio') {
        if (this.commandInput && entry.command) this.commandInput.value = entry.command;
        // Use resolvedArgs (with substituted paths) if provided, otherwise fall back to entry.args
        const argsToUse = resolvedArgs ?? entry.args ?? [];
        // Quote any arg that contains spaces so the round-trip through parseArgsString is lossless
        if (this.argsInput) this.argsInput.value = argsToUse
          .map(a => a.includes(' ') ? `"${a.replace(/"/g, '\\"')}"` : a)
          .join(' ');
      } else if (entry.transport === 'sse') {
        if (this.urlInput && entry.url) this.urlInput.value = entry.url;

        // If the registry entry has an API key env var spec, extract it from
        // resolvedEnv and populate the dedicated API key input instead of
        // leaving it buried in the env JSON blob.
        const apiKeySpec = (entry.envVarSpecs || []).find(s =>
          s.key.toLowerCase().includes('api_key') || s.key.toLowerCase().includes('apikey') || s.key.toLowerCase().includes('token')
        );
        if (apiKeySpec && resolvedEnv[apiKeySpec.key] && this.apiKeyInput) {
          this.apiKeyInput.value = resolvedEnv[apiKeySpec.key];
          // Remove it from the env blob so it isn't duplicated
          delete resolvedEnv[apiKeySpec.key];
        }
      }

      // Merge static env + resolved env from wizard
      const mergedEnv = { ...(entry.staticEnv || {}), ...resolvedEnv };
      if (this.envInput && Object.keys(mergedEnv).length > 0) {
        this.envInput.value = JSON.stringify(mergedEnv, null, 2);
      }
    }, 50);
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}

