/**
 * Provider Health Manager
 *
 * Centralized manager for tracking LLM provider and model availability,
 * classifying runtime errors (Provider-level vs Model-level), managing circuit breaker cooldowns,
 * and maintaining moving-average latency metrics for dynamic routing.
 */

export type ErrorDomain = 'PROVIDER_LEVEL' | 'MODEL_LEVEL' | 'UNKNOWN';

export interface ClassifiedError {
  domain: ErrorDomain;
  reason: string;
  statusCode?: number;
}

export class ProviderHealthManager {
  private static instance: ProviderHealthManager;

  // Track cooldown expiration timestamps (ms)
  private providerCooldowns: Map<string, number> = new Map();
  private modelCooldowns: Map<string, number> = new Map();

  // Track consecutive failure counts
  private providerFailureCounts: Map<string, number> = new Map();

  // Track Exponential Moving Average (EMA) latency per model key ("provider:modelId")
  private modelLatencies: Map<string, number> = new Map();

  private constructor() {}

  public static getInstance(): ProviderHealthManager {
    if (!ProviderHealthManager.instance) {
      ProviderHealthManager.instance = new ProviderHealthManager();
    }
    return ProviderHealthManager.instance;
  }

  private getModelKey(provider: string, modelId: string): string {
    return `${provider}:${modelId}`;
  }

  /**
   * Inspects error object/message to determine if failure is at Provider level or Model level.
   */
  public classifyError(error: unknown): ClassifiedError {
    if (!error) {
      return { domain: 'UNKNOWN', reason: 'Unknown error' };
    }

    const errObj = error as Record<string, unknown>;
    const message = String(errObj.message || error).toLowerCase();
    const status = (typeof errObj.status === 'number' ? errObj.status : undefined) ||
                   (typeof errObj.statusCode === 'number' ? errObj.statusCode : undefined) ||
                   (typeof errObj.code === 'number' ? errObj.code : undefined);

    // Extract status code embedded in error text if not directly on object
    let extractedStatus = status;
    if (!extractedStatus) {
      const match = message.match(/\b(401|403|404|422|429|500|502|503|504)\b/);
      if (match) {
        extractedStatus = parseInt(match[1], 10);
      }
    }

    // 1. Provider-level auth & quota/credits errors (401, 403, 429, OpenRouter credits, Ollama sub)
    if (extractedStatus === 401 || extractedStatus === 403 ||
        message.includes('unauthorized') || message.includes('invalid api key') || message.includes('invalid key') ||
        message.includes('authentication') || message.includes('requires more credits') || message.includes('can only afford') ||
        message.includes('requires a subscription') || message.includes('insufficient credits')) {
      return { domain: 'PROVIDER_LEVEL', reason: 'Provider auth / quota / credit depletion error', statusCode: 401 };
    }

    if (extractedStatus === 429 || message.includes('rate limit') || message.includes('quota exceeded') || message.includes('too many requests') || message.includes('resource_exhausted')) {
      return { domain: 'PROVIDER_LEVEL', reason: 'Provider quota or rate limit exceeded', statusCode: 429 };
    }

    // 2. Provider-level server outages & network errors (500, 502, 503, 504, connection errors, Electron net errors)
    if (extractedStatus === 500 || extractedStatus === 502 || extractedStatus === 503 || extractedStatus === 504 ||
        message.includes('overloaded') || message.includes('service unavailable') || message.includes('bad gateway') ||
        message.includes('econnrefused') || message.includes('etimedout') || message.includes('fetch failed') ||
        message.includes('network error') || message.includes('timeout') || message.includes('net::err_') ||
        message.includes('err_connection_refused') || message.includes('max_instances') || message.includes('unexpected end of json input')) {
      return { domain: 'PROVIDER_LEVEL', reason: `Provider service outage / connection failure (${extractedStatus || 'network'})`, statusCode: extractedStatus };
    }

    // 3. Model Output Token Cap Error (too_many_tokens, 400 cap error) -> MODEL_LEVEL Session Disable
    if (message.includes('too_many_tokens') || message.includes('too many tokens') || message.includes('max output length') || message.includes('maximum output length') || message.includes('tokens must be less than')) {
      return { domain: 'MODEL_LEVEL', reason: 'Model max output token cap exceeded (session blacklisted)', statusCode: 400 };
    }

    // 4. Model-level errors (404 Not Found, 400 Context Length, formatting errors, 422 extra inputs)
    if (extractedStatus === 404 || message.includes('not found') || message.includes('model_not_found') || message.includes('does not exist')) {
      return { domain: 'MODEL_LEVEL', reason: 'Model not found or deprecated', statusCode: 404 };
    }

    if (extractedStatus === 400 || message.includes('context length') || message.includes('maximum context') || message.includes('prompt is too long') || message.includes('token limit')) {
      return { domain: 'MODEL_LEVEL', reason: 'Model context window exceeded', statusCode: 400 };
    }

    if (extractedStatus === 422 || message.includes('extra_forbidden') || message.includes('extra inputs are not permitted') || message.includes('unsupported') || message.includes('empty content') || message.includes('failed to parse') || message.includes('tool') || message.includes('function call')) {
      return { domain: 'MODEL_LEVEL', reason: 'Model schema or tool format error' };
    }

    // Default fallback
    return { domain: 'UNKNOWN', reason: message.slice(0, 150), statusCode: extractedStatus };
  }

  /**
   * Records failure, sets cooldowns based on error classification, and returns classification.
   */
  public recordFailure(provider: string, modelId: string, error: unknown): ClassifiedError {
    const classification = this.classifyError(error);
    const now = Date.now();
    const modelKey = this.getModelKey(provider, modelId);

    const prevFailures = (this.providerFailureCounts.get(provider) || 0) + 1;
    this.providerFailureCounts.set(provider, prevFailures);

    if (classification.reason.includes('session blacklisted')) {
      // 24-hour session cooldown for models that exceed output token limits
      this.modelCooldowns.set(modelKey, now + 86400000);
    } else if (classification.domain === 'PROVIDER_LEVEL' || prevFailures >= 2) {
      // Set provider cooldown: 5 minutes for Auth/Credits errors, 60 seconds for Quota/Outage
      const cooldownMs = classification.statusCode === 401 || classification.statusCode === 403 ? 300000 : 60000;
      this.providerCooldowns.set(provider, now + cooldownMs);
      classification.domain = 'PROVIDER_LEVEL';
    } else {
      // Set model cooldown for 60 seconds
      this.modelCooldowns.set(modelKey, now + 60000);
    }

    return classification;
  }

  /**
   * Records success, resets failure counts, and updates EMA latency metric.
   */
  public recordSuccess(provider: string, modelId: string, latencyMs: number): void {
    const modelKey = this.getModelKey(provider, modelId);
    this.providerFailureCounts.delete(provider);
    this.providerCooldowns.delete(provider);
    this.modelCooldowns.delete(modelKey);

    if (latencyMs > 0 && latencyMs < 120000) {
      const currentEma = this.modelLatencies.get(modelKey);
      if (currentEma === undefined) {
        this.modelLatencies.set(modelKey, latencyMs);
      } else {
        const newEma = Math.round((currentEma * 0.7) + (latencyMs * 0.3));
        this.modelLatencies.set(modelKey, newEma);
      }
    }
  }

  /**
   * Checks if provider is healthy (not currently cooling down).
   */
  public isProviderHealthy(provider: string): boolean {
    const cooldownUntil = this.providerCooldowns.get(provider);
    if (!cooldownUntil) return true;
    if (Date.now() >= cooldownUntil) {
      this.providerCooldowns.delete(provider);
      return true;
    }
    return false;
  }

  /**
   * Checks if specific model is healthy (neither provider nor model is cooling down).
   */
  public isModelHealthy(provider: string, modelId: string): boolean {
    if (!this.isProviderHealthy(provider)) return false;
    const modelKey = this.getModelKey(provider, modelId);
    const cooldownUntil = this.modelCooldowns.get(modelKey);
    if (!cooldownUntil) return true;
    if (Date.now() >= cooldownUntil) {
      this.modelCooldowns.delete(modelKey);
      return true;
    }
    return false;
  }

  /**
   * Gets EMA latency for a model or default fallback (1000ms).
   */
  public getModelLatency(provider: string, modelId: string): number {
    const key = this.getModelKey(provider, modelId);
    return this.modelLatencies.get(key) ?? 1000;
  }

  /**
   * Clears active cooldowns for fresh user session.
   */
  public resetSessionHealth(): void {
    this.providerCooldowns.clear();
    this.modelCooldowns.clear();
    this.providerFailureCounts.clear();
  }
}
