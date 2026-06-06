/**
 * Model Discovery Service - Fetches available models from provider APIs
 * 
 * Dynamically discovers models from OpenRouter, Ollama Cloud, and Nvidia NIM.
 * This service populates the custom model table with up-to-date model lists.
 */

import { requestUrl } from 'obsidian';
import { CustomModel, CustomEmbeddingModel, Provider, AISettings } from '../settings';
import { validateOpenRouterApiKey } from './openRouterService';
import { validateNvidiaApiKey } from './nvidiaService';

export interface DiscoveredModel {
  id: string;
  name: string;
  tokenLimit: number;
  isFree?: boolean;
  capabilities?: string[];
}

/**
 * Verifies if a model is actually accessible with the current API key.
 * Performs a minimal "ping" request (max_tokens: 1).
 */
export async function verifyModel(model: CustomModel, settings: AISettings): Promise<{ success: boolean; error?: string; latency?: number }> {
  const provider = model.provider;
  let url = '';
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: any = {};

  if (provider === 'gemini') {
    const key = settings.geminiApiKey || settings.apiKey;
    if (!key) return { success: false, error: 'Missing API key' };
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${key}`;
    body = {
      contents: [{ parts: [{ text: "." }] }],
      generationConfig: { maxOutputTokens: 1 }
    };
  } else if (provider === 'openrouter') {
    if (!settings.openRouterApiKey) return { success: false, error: 'Missing API key' };
    url = 'https://openrouter.ai/api/v1/chat/completions';
    headers['Authorization'] = `Bearer ${settings.openRouterApiKey}`;
    body = {
      model: model.id,
      messages: [{ role: 'user', content: '.' }],
      max_tokens: 1
    };
  } else if (provider === 'groq') {
    if (!settings.groqApiKey) return { success: false, error: 'Missing API key' };
    url = 'https://api.groq.com/openai/v1/chat/completions';
    headers['Authorization'] = `Bearer ${settings.groqApiKey}`;
    body = {
      model: model.id,
      messages: [{ role: 'user', content: '.' }],
      max_tokens: 1
    };
  } else if (provider === 'nvidia') {
    if (!settings.nvidiaApiKey) return { success: false, error: 'Missing API key' };
    url = 'https://integrate.api.nvidia.com/v1/chat/completions';
    headers['Authorization'] = `Bearer ${settings.nvidiaApiKey}`;
    body = {
      model: model.id,
      messages: [{ role: 'user', content: '.' }],
      max_tokens: 1
    };
  } else if (provider === 'ollama') {
    url = `${settings.ollamaBaseUrl || 'http://localhost:11434'}/api/chat`;
    if (settings.ollamaApiKey) headers['Authorization'] = `Bearer ${settings.ollamaApiKey}`;
    body = {
      model: model.id,
      messages: [{ role: 'user', content: '.' }],
      stream: false,
      options: { num_predict: 1 }
    };
  } else if (provider === 'opencode') {
    if (!settings.openCodeApiKey) return { success: false, error: 'Missing API key' };
    url = 'https://opencode.ai/zen/v1/chat/completions';
    headers['Authorization'] = `Bearer ${settings.openCodeApiKey}`;
    body = {
      model: model.id,
      messages: [{ role: 'user', content: '.' }],
      max_tokens: 1
    };
  } else {
    // Check if it's a custom provider
    const customProvider = settings.customProviders?.find(cp => cp.id === provider);
    if (customProvider) {
      url = `${customProvider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      if (customProvider.apiKey) {
        headers['Authorization'] = `Bearer ${customProvider.apiKey}`;
      }
      body = {
        model: model.id,
        messages: [{ role: 'user', content: '.' }],
        max_tokens: 1
      };
    }
  }

  if (!url) return { success: true }; // Skip unknown providers

  try {
    const startTime = performance.now();
    const requestPromise = requestUrl({
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      throw: false
    });

    // Add a 10s timeout to verification requests
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error('Request timed out')), 10000)
    );

    const response = await Promise.race([requestPromise, timeoutPromise]);
    const endTime = performance.now();
    const latency = Math.round(endTime - startTime);

    if (response.status === 200 || response.status === 201) {
      return { success: true, latency };
    } else {
      let errorMsg = `API Error ${response.status}`;
      try {
        const data = response.json;
        errorMsg = data.error?.message || data.message || errorMsg;
      } catch {}
      return { success: false, error: errorMsg };
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown network error' };
  }
}

/**
 * Verifies if an embedding model is actually accessible with the current API key.
 * Performs a minimal embedding request.
 */
export async function verifyEmbeddingModel(model: CustomEmbeddingModel, settings: AISettings): Promise<{ success: boolean; error?: string }> {
  const provider = model.provider;
  let url = '';
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: any = {};

  if (provider === 'gemini') {
    const key = settings.geminiApiKey || settings.apiKey;
    if (!key) return { success: false, error: 'Missing API key' };
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:embedContent?key=${key}`;
    body = {
      content: { parts: [{ text: "ping" }] }
    };
  } else if (provider === 'openrouter') {
    if (!settings.openRouterApiKey) return { success: false, error: 'Missing API key' };
    url = 'https://openrouter.ai/api/v1/embeddings';
    headers['Authorization'] = `Bearer ${settings.openRouterApiKey}`;
    body = {
      model: model.id,
      input: "ping"
    };
  } else if (provider === 'nvidia') {
    if (!settings.nvidiaApiKey) return { success: false, error: 'Missing API key' };
    url = 'https://integrate.api.nvidia.com/v1/embeddings';
    headers['Authorization'] = `Bearer ${settings.nvidiaApiKey}`;
    body = {
      model: model.id,
      input: ["ping"],
      input_type: "query"
    };
  } else if (provider === 'ollama') {
    return { success: true }; // Skip verification for Ollama local
  } else {
    // Check if it's a custom provider
    const customProvider = settings.customProviders?.find(cp => cp.id === provider);
    if (customProvider && customProvider.enableEmbeddings) {
      url = `${customProvider.baseUrl.replace(/\/+$/, '')}/embeddings`;
      if (customProvider.apiKey) {
        headers['Authorization'] = `Bearer ${customProvider.apiKey}`;
      }
      body = {
        model: model.id,
        input: "ping"
      };
    }
  }

  if (!url) return { success: true }; // Skip unknown providers

  try {
    const requestPromise = requestUrl({
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      throw: false
    });

    // Add a 10s timeout to verification requests
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error('Request timed out')), 10000)
    );

    const response = await Promise.race([requestPromise, timeoutPromise]);

    if (response.status === 200 || response.status === 201) {
      return { success: true };
    } else {
      let errorMsg = `API Error ${response.status}`;
      try {
        const data = response.json;
        errorMsg = data.error?.message || data.message || errorMsg;
      } catch {}
      return { success: false, error: errorMsg };
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown network error' };
  }
}


export interface ModelDiscoveryResult {
  provider: 'openrouter' | 'ollama' | 'nvidia' | 'gemini' | 'opencode' | 'groq' | string;
  models: DiscoveredModel[];
  embeddingModels?: DiscoveredModel[];
  error?: string;
}

export interface GroqModelResponse {
  data: Array<{
    id: string;
    context_window?: number;
    active?: boolean;
  }>;
}

export interface OpenRouterModelResponse {
  data: Array<{
    id: string;
    name: string;
    context_length: number | null;
    architecture?: {
      modality?: string;
      output_modalities?: string[];
    };
    pricing?: {
      prompt: string | number;
      completion: string | number;
    };
  }>;
}

export interface GeminiModelResponse {
  models: Array<{
    name: string;
    displayName: string;
    inputTokenLimit: number;
    supportedGenerationMethods: string[];
    thinking?: boolean;
  }>;
}

export interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model?: string;
    details?: {
      format?: string;
      family?: string;
      families?: string[];
      parameter_size?: string;
      quantization_level?: string;
    };
    model_info?: Record<string, number>;
  }>;
}

export interface NvidiaModelsResponse {
  data: Array<{
    id: string;
    max_model_len?: number;
    max_model_length?: number;
    context_window?: number;
    context_length?: number;
    type?: string;
    task?: string;
    tags?: string[];
    metadata?: {
      max_model_len?: number;
      max_model_length?: number;
      context_window?: number;
      context_length?: number;
    };
  }>;
}

/**
 * Converts a model ID to a human-readable display name.
 * Example: "meta/llama-3.1-8b-instruct" -> "Meta Llama 3.1 8b Instruct"
 */
function formatModelName(id: string): string {
  // Handle Gemini names like "models/gemini-1.5-flash"
  const cleanId = id.startsWith('models/') ? id.substring(7) : id;
  return cleanId
    .replace(/[/:\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

/**
 * Fetches available models from Google Gemini API.
 */
async function fetchGeminiModels(apiKey: string): Promise<ModelDiscoveryResult> {
  if (!apiKey) {
    return { provider: 'gemini', models: [], error: 'Missing API key' };
  }

  try {
    const response = await requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      },
      throw: false
    });

    if (response.status >= 400) {
      return { provider: 'gemini', models: [], error: `API error: ${response.status}` };
    }

    const data = response.json as GeminiModelResponse;
    const models: DiscoveredModel[] = (data.models || [])
      .filter(m => m.supportedGenerationMethods.includes('generateContent'))
      .map(m => {
        const capabilities: string[] = [];
        if (m.thinking === true) {
          capabilities.push('thinking');
        }
        return {
          id: m.name.startsWith('models/') ? m.name.substring(7) : m.name,
          name: m.displayName || formatModelName(m.name),
          tokenLimit: m.inputTokenLimit || 32000,
          capabilities
        };
      });

    const embeddingModels: DiscoveredModel[] = (data.models || [])
      .filter(m => m.supportedGenerationMethods.includes('embedContent'))
      .map(m => ({
        id: m.name.startsWith('models/') ? m.name.substring(7) : m.name,
        name: m.displayName || formatModelName(m.name),
        tokenLimit: m.inputTokenLimit || 32000
      }));

    return { provider: 'gemini', models, embeddingModels };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { provider: 'gemini', models: [], error: message };
  }
}

/**
 * Fetches available models from OpenRouter API.
 */
async function fetchOpenRouterModels(apiKey: string): Promise<ModelDiscoveryResult> {
  if (!apiKey || !validateOpenRouterApiKey(apiKey)) {
    return { provider: 'openrouter', models: [], error: 'Invalid or missing API key' };
  }

  try {
    // Fetch regular chat models
    const response = await requestUrl({
      url: 'https://openrouter.ai/api/v1/models',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      throw: false
    });

    if (response.status >= 400) {
      return { provider: 'openrouter', models: [], error: `API error: ${response.status}` };
    }

    const data = response.json as OpenRouterModelResponse;
    const models: DiscoveredModel[] = (data.data || [])
      .filter(m => m.id && m.context_length)
      .map(m => ({
        id: m.id,
        name: formatModelName(m.id),
        tokenLimit: m.context_length || 0,
        isFree: m.pricing && (m.pricing.prompt === "0" || m.pricing.prompt === 0) && (m.pricing.completion === "0" || m.pricing.completion === 0)
      }));

    // Fetch dedicated embedding models
    let embeddingModels: DiscoveredModel[] = [];
    try {
      const embedResponse = await requestUrl({
        url: 'https://openrouter.ai/api/v1/embeddings/models',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        throw: false
      });

      if (embedResponse.status === 200) {
        const embedData = embedResponse.json as OpenRouterModelResponse;
        embeddingModels = (embedData.data || [])
          .filter(m => m.id)
          .map(m => ({
            id: m.id,
            name: formatModelName(m.id),
            tokenLimit: m.context_length || 0,
            isFree: m.pricing && (m.pricing.prompt === "0" || m.pricing.prompt === 0) && (m.pricing.completion === "0" || m.pricing.completion === 0)
          }));
      }
    } catch (e) {
          }

    return { provider: 'openrouter', models, embeddingModels };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { provider: 'openrouter', models: [], error: message };
  }
}

/**
 * Fetches available models from Ollama API (local or cloud).
 * Uses /api/tags for list and keyword heuristics for embedding models.
 */
async function fetchOllamaModels(baseUrl: string, apiKey?: string): Promise<ModelDiscoveryResult> {
  if (!baseUrl) {
    return { provider: 'ollama', models: [], error: 'No base URL configured' };
  }

  // Normalize base URL
  const normalizedUrl = baseUrl.replace(/\/$/, '');

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const listResponse = await requestUrl({
      url: `${normalizedUrl}/api/tags`,
      method: 'GET',
      headers,
      throw: false
    });

    if (listResponse.status >= 400) {
      return { provider: 'ollama', models: [], error: `API error: ${listResponse.status}` };
    }

    const listData = listResponse.json as OllamaTagsResponse;
    if (!listData.models || listData.models.length === 0) {
      return { provider: 'ollama', models: [] };
    }

    const models: DiscoveredModel[] = [];
    const embeddingModels: DiscoveredModel[] = [];

    // Fetch all models and their details in parallel for better performance
    // Use Promise.all to fetch the exact context length from /api/show for each model
    await Promise.all((listData.models || []).map(async (modelInfo) => {
      const modelId = modelInfo.name || modelInfo.model;
      if (!modelId) return;

      let tokenLimit = 32000; // Default fallback
      let capabilities: string[] = [];

      try {
        const showResponse = await requestUrl({
          url: `${normalizedUrl}/api/show`,
          method: 'POST',
          headers,
          body: JSON.stringify({ name: modelId }),
          throw: false
        });

        if (showResponse.status === 200) {
          const showData = showResponse.json as { 
            model_info?: Record<string, any>; 
            details?: { family?: string; families?: string[] };
            capabilities?: string[];
          };
          
          if (showData.capabilities && Array.isArray(showData.capabilities)) {
            capabilities = showData.capabilities;
          }

          // Fallback for vision capability detection from model details
          if (showData.details?.families && Array.isArray(showData.details.families)) {
            if (showData.details.families.includes('clip') && !capabilities.includes('vision')) {
              capabilities.push('vision');
            }
          }

          if (showData.model_info) {
            // Context length is often stored as <family>.context_length or general.context_length
            const family = showData.details?.family || 'llama';
            const contextKey = `${family}.context_length`;
            tokenLimit = showData.model_info[contextKey] || showData.model_info['general.context_length'] || 32000;
          }
        }
      } catch (e) {
              }

      models.push({
        id: modelId,
        name: formatModelName(modelId),
        tokenLimit,
        capabilities
      });
    }));

    return { provider: 'ollama', models, embeddingModels };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { provider: 'ollama', models: [], error: message };
  }
}

/**
 * Extracts the token limit from an NVIDIA API model entry using
 * a cascading check over known field locations across different NIM API versions.
 */
function extractNvidiaTokenLimit(m: NvidiaModelsResponse['data'][0]): number | null {
  return m.max_model_len ?? m.max_model_length ?? m.context_window ?? m.context_length ??
         m.metadata?.max_model_len ?? m.metadata?.max_model_length ??
         m.metadata?.context_window ?? m.metadata?.context_length ?? null;
}

/**
 * Maps known model name patterns to their context window size.
 * Used as a fallback when the API response doesn't include context length.
 */
const NVIDIA_CONTEXT_MAP: Record<string, number> = {
  // NVIDIA Nemotron family
  'nvidia/nemotron-3-nano-30b-a3b': 256000,
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': 256000,
  'nvidia/nemotron-3-super-120b-a12b': 1000000,
  'nvidia/nemotron-nano-9b-v2': 128000,
  'nvidia/nemotron-nano-12b-v2-vl': 128000,
  'nvidia/llama-3.3-nemotron-super-49b-v1.5': 131072,
  // Llama family
  'meta/llama-3.1-8b-instruct': 131072,
  'meta/llama-3.1-70b-instruct': 131072,
  'meta/llama-3.1-405b-instruct': 131072,
  'meta/llama-3.2-3b-instruct': 131072,
  'meta/llama-3.2-11b-instruct': 131072,
  'meta/llama-3.2-90b-instruct': 131072,
  'meta/llama-3.3-70b-instruct': 131072,
  'meta/llama-4-scout-17b-16e-instruct': 1048576,
  'meta/llama-4-maverick-17b-128e-instruct': 1048576,
  // Mistral family
  'mistralai/mistral-large-2411': 131072,
  'mistralai/mistral-large-2407': 131072,
  'mistralai/mistral-small-24b-instruct-2501': 131072,
  'mistralai/mistral-7b-instruct-v0.3': 32768,
  'mistralai/ministral-3b-2501': 131072,
  'mistralai/ministral-8b-2501': 131072,
  'mistralai/codestral-2505': 256000,
  'mistralai/pixtral-large-2411': 131072,
  // Google Gemma
  'google/gemma-2-2b-it': 8192,
  'google/gemma-2-9b-it': 8192,
  'google/gemma-2-27b-it': 8192,
  'google/gemma-3-4b-it': 32768,
  'google/gemma-3-12b-it': 32768,
  'google/gemma-3-27b-it': 32768,
  // DeepSeek
  'deepseek-ai/deepseek-v3-2412': 65536,
  'deepseek-ai/deepseek-r1-distill-llama-70b': 131072,
  // Qwen
  'qwen/qwen-2.5-7b-instruct': 32768,
  'qwen/qwen-2.5-14b-instruct': 32768,
  'qwen/qwen-2.5-32b-instruct': 32768,
  'qwen/qwen-2.5-72b-instruct': 32768,
  'qwen/qwen-2.5-coder-32b-instruct': 32768,
  // Microsoft
  'microsoft/phi-3-mini-4k-instruct': 4096,
  'microsoft/phi-3-medium-4k-instruct': 4096,
  'microsoft/phi-3.5-mini-instruct': 32768,
  'microsoft/phi-4': 16384,
  // NVIDIA Embedding
  'nvidia/nv-embedqa-e5-v5': 512,
  'nvidia/nv-embedqa-mistral-7b-v2': 32768,
  'nvidia/llama-nemotron-embed-1b-v2': 4096,
  'nvidia/llama-3.2-nv-embedqa-1b-v2': 8192,
};

/**
 * Infers a reasonable context window from a model ID using name-pattern heuristics.
 * Used as a last-resort fallback when API response and NGC catalog both fail.
 */
function inferContextWindow(modelId: string, isEmbedding: boolean): number {
  if (isEmbedding) return 512;
  const id = modelId.toLowerCase();
  if (id.includes('1m') || id.includes('1000000') || id.includes('1048576')) return 1000000;
  if (id.includes('256k') || id.includes('262144')) return 256000;
  if (id.includes('131072') || id.includes('128k')) return 131072;
  if (id.includes('65536') || id.includes('64k')) return 65536;
  if (id.includes('32768') || id.includes('32k')) return 32768;
  if (id.includes('16384') || id.includes('16k')) return 16384;
  if (id.includes('8192') || id.includes('8k')) return 8192;
  if (id.includes('4096') || id.includes('4k')) return 4096;
  return 128000;
}

/**
 * Fetches available models from Nvidia NIM API.
 * Uses the /v1/models endpoint which is OpenAI-compatible.
 * Falls back to NGC catalog API and model-name heuristics when context length is missing.
 */
async function fetchNvidiaModels(apiKey: string): Promise<ModelDiscoveryResult> {
  if (!apiKey || !validateNvidiaApiKey(apiKey)) {
    return { provider: 'nvidia', models: [], error: 'Invalid or missing API key' };
  }

  try {
    const response = await requestUrl({
      url: 'https://integrate.api.nvidia.com/v1/models',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      throw: false
    });

    if (response.status >= 400) {
      return { provider: 'nvidia', models: [], error: `API error: ${response.status}` };
    }

    const data = response.json as NvidiaModelsResponse;
    const models: DiscoveredModel[] = [];
    const embeddingModels: DiscoveredModel[] = [];

    // Debug: log the first few model entries from the raw response to inspect available fields
    if (data.data && data.data.length > 0) {
      const samples = data.data.slice(0, 3);
      for (const sample of samples) {
              }
    }

    for (const m of data.data || []) {
      if (!m.id) continue;

      const isEmbedding = 
        m.type === 'embedding' || 
        m.task?.includes('embedding') || 
        m.tags?.includes('embedding') ||
        m.id.toLowerCase().includes('embed');

      let tokenLimit = extractNvidiaTokenLimit(m);

      if (tokenLimit === null) {
        tokenLimit = NVIDIA_CONTEXT_MAP[m.id] ?? null;
      }

      if (tokenLimit === null) {
        tokenLimit = inferContextWindow(m.id, isEmbedding);
      }

      const modelObj = {
        id: m.id,
        name: formatModelName(m.id),
        tokenLimit
      };

      if (isEmbedding) {
        embeddingModels.push(modelObj);
      } else {
        models.push(modelObj);
      }
    }

    return { provider: 'nvidia', models, embeddingModels };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { provider: 'nvidia', models: [], error: message };
  }
}

/**
 * Fetches available models from Groq API.
 */
async function fetchGroqModels(apiKey: string): Promise<ModelDiscoveryResult> {
  if (!apiKey) {
    return { provider: 'groq', models: [], error: 'Missing API key' };
  }

  try {
    const listResponse = await requestUrl({
      url: 'https://api.groq.com/openai/v1/models',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      throw: false
    });

    if (listResponse.status >= 400) {
      return { provider: 'groq', models: [], error: `API error: ${listResponse.status}` };
    }

    const listData = listResponse.json as GroqModelResponse;
    const rawModels = (listData.data || []).filter(m => m.id && m.active !== false);
    
    const models: DiscoveredModel[] = [];

    // Fetch exact TPM limits for each model in parallel
    await Promise.all(rawModels.map(async (m) => {
      let tokenLimit = m.context_window || 8192; // Default fallback

      try {
        const pingResponse = await requestUrl({
          url: 'https://api.groq.com/openai/v1/chat/completions',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: m.id,
            messages: [{ role: 'user', content: '.' }],
            max_tokens: 1
          }),
          throw: false
        });

        // Extract x-ratelimit-limit-tokens header (from success or 429)
        const tpmHeader = pingResponse.headers['x-ratelimit-limit-tokens'];
        if (tpmHeader) {
          const parsedTPM = parseInt(tpmHeader);
          if (!isNaN(parsedTPM)) {
            tokenLimit = parsedTPM;
          }
        }
      } catch (e) {
              }

      models.push({
        id: m.id,
        name: formatModelName(m.id),
        tokenLimit
      });
    }));

    return { provider: 'groq', models };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { provider: 'groq', models: [], error: message };
  }
}

/**
 * Fetches available models from OpenCode Zen API.
 */
async function fetchOpenCodeModels(apiKey: string): Promise<ModelDiscoveryResult> {
  if (!apiKey) {
    return { provider: 'opencode', models: [], error: 'Missing API key' };
  }

  try {
    const response = await requestUrl({
      url: 'https://opencode.ai/zen/v1/models',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      throw: false
    });

    if (response.status >= 400) {
      return { provider: 'opencode', models: [], error: `API error: ${response.status}` };
    }

    const data = response.json as any;
    const models: DiscoveredModel[] = (data.data || [])
      .filter((m: any) => m.id)
      .map((m: any) => ({
        id: m.id,
        name: formatModelName(m.id),
        tokenLimit: extractGenericTokenLimit(m) ?? inferContextWindow(m.id, false)
      }));

    return { provider: 'opencode', models };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { provider: 'opencode', models: [], error: message };
  }
}

export interface ModelDiscoveryConfig {
  openRouterApiKey: string;
  openCodeApiKey: string;
  ollamaApiKey: string;
  ollamaBaseUrl: string;
  nvidiaApiKey: string;
  geminiApiKey: string;
  groqApiKey: string;
  customProviders?: Array<{
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
  }>;
}

/**
 * Extracts the token limit from a generic OpenAI-compatible API model entry
 * using a cascading check over known field locations across different providers.
 */
function extractGenericTokenLimit(m: Record<string, any>): number | null {
  return m.context_window ?? m.max_model_len ?? m.context_length ?? m.max_model_length ??
         m.metadata?.context_window ?? m.metadata?.max_model_len ??
         m.metadata?.context_length ?? m.metadata?.max_model_length ?? null;
}

/**
 * Fetches available models from a custom OpenAI-compatible provider.
 */
async function fetchCustomProviderModels(provider: { id: string; name: string; baseUrl: string; apiKey?: string; enableEmbeddings?: boolean }): Promise<ModelDiscoveryResult> {
  if (!provider.baseUrl) {
    return { provider: provider.id, models: [], error: 'No base URL configured' };
  }

  // Normalize base URL
  const normalizedUrl = provider.baseUrl.replace(/\/$/, '');

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const response = await requestUrl({
      url: `${normalizedUrl}/models`,
      method: 'GET',
      headers,
      throw: false
    });

    if (response.status >= 400) {
      return { provider: provider.id, models: [], error: `API error: ${response.status}` };
    }

    const data = response.json as { data: any[] };
    if (!data.data || !Array.isArray(data.data)) {
      return { provider: provider.id, models: [] };
    }

    const models: DiscoveredModel[] = [];
    const embeddingModels: DiscoveredModel[] = [];

    data.data.forEach(m => {
      if (!m.id) return;

      const modelIdLower = m.id.toLowerCase();
      const isEmbedding = 
        m.type === 'embedding' || 
        modelIdLower.includes('embed') ||
        modelIdLower.includes('text-embedding');

      const capabilities: string[] = [];
      // Detection heuristics for vision-capable models
      if (
        modelIdLower.includes('vision') || 
        modelIdLower.includes('llava') || 
        modelIdLower.includes('-vl') || 
        modelIdLower.includes('pixtral') || 
        modelIdLower.includes('qwen2-vl') ||
        modelIdLower.includes('gpt-4o') ||
        modelIdLower.includes('gemini') ||
        modelIdLower.includes('claude-3')
      ) {
        capabilities.push('vision');
      }

      const tokenLimit = extractGenericTokenLimit(m) ?? inferContextWindow(m.id, isEmbedding);

      const modelObj = {
        id: m.id,
        name: formatModelName(m.id),
        tokenLimit,
        capabilities: capabilities.length > 0 ? capabilities : undefined
      };

      if (isEmbedding && provider.enableEmbeddings) {
        embeddingModels.push(modelObj);
      } else {
        models.push(modelObj);
      }
    });

    return { provider: provider.id, models, embeddingModels };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { provider: provider.id, models: [], error: message };
  }
}

/**
 * Discovers models from all configured providers.
 * Returns results for each provider independently.
 */
export async function discoverModels(config: ModelDiscoveryConfig): Promise<ModelDiscoveryResult[]> {
  const results: ModelDiscoveryResult[] = [];

  if (config.geminiApiKey) {
    const result = await fetchGeminiModels(config.geminiApiKey);
    results.push(result);
  }

  if (config.openRouterApiKey) {
    const result = await fetchOpenRouterModels(config.openRouterApiKey);
    results.push(result);
  }

  if (config.openCodeApiKey) {
    const result = await fetchOpenCodeModels(config.openCodeApiKey);
    results.push(result);
  }

  if (config.ollamaBaseUrl) {
    // Fetch models for Ollama (handles both local and cloud based on baseUrl)
    const result = await fetchOllamaModels(config.ollamaBaseUrl, config.ollamaApiKey);
    results.push(result);
  }

  if (config.nvidiaApiKey) {
    const result = await fetchNvidiaModels(config.nvidiaApiKey);
    results.push(result);
  }

  if (config.groqApiKey) {
    const result = await fetchGroqModels(config.groqApiKey);
    results.push(result);
  }

  if (config.customProviders && config.customProviders.length > 0) {
    for (const provider of config.customProviders) {
      const result = await fetchCustomProviderModels(provider);
      results.push(result);
    }
  }

  return results;
}

/**
 * Converts discovery results to CustomModel format.
 */
export function toCustomModels(result: ModelDiscoveryResult): CustomModel[] | any[] {
  return result.models.map(m => ({
    provider: result.provider,
    id: m.id,
    name: m.name,
    tokenLimit: m.tokenLimit,
    contextWindow: m.tokenLimit,
    capabilities: m.capabilities,
    enabled: true,
    isNew: true,
    isFree: m.isFree,
    verificationStatus: 'unverified'
  }));
}