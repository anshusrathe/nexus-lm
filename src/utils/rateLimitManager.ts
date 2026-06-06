/**
 * Rate Limit Manager - Centralized rate limiting based on API response headers
 * 
 * This manager tracks rate limits dynamically from API response headers rather than
 * relying on manually configured settings. It supports multiple providers (Gemini, Groq, OpenRouter)
 * and maintains separate tracking for each model.
 */

export interface RateLimitInfo {
    tokensPerMinute: number;
    requestsPerMinute: number;
    remainingTokens: number;
    remainingRequests: number;
    resetTime: number; // Timestamp when limits reset
}

export interface RateLimitState {
    currentTokenCount: number;
    currentRequestCount: number;
    lastResetTime: number;
    limits: RateLimitInfo | null;
}

/**
 * Centralized rate limit manager that extracts limits from API headers
 */
export class RateLimitManager {
    private static instance: RateLimitManager;
    
    // Track rate limits per provider-model combination
    private rateLimits: Map<string, RateLimitState> = new Map();
    
    // Default fallback limits if headers are not available
    private static readonly DEFAULT_LIMITS: Record<string, RateLimitInfo> = {
        'gemini': {
            tokensPerMinute: 1000000,
            requestsPerMinute: 1500,
            remainingTokens: 1000000,
            remainingRequests: 1500,
            resetTime: Date.now() + 60000
        },
        'groq': {
            tokensPerMinute: 6000,
            requestsPerMinute: 30,
            remainingTokens: 6000,
            remainingRequests: 30,
            resetTime: Date.now() + 60000
        },
        'openrouter': {
            tokensPerMinute: 100000,
            requestsPerMinute: 200,
            remainingTokens: 100000,
            remainingRequests: 200,
            resetTime: Date.now() + 60000
        }
    };
    
    private constructor() {}
    
    static getInstance(): RateLimitManager {
        if (!RateLimitManager.instance) {
            RateLimitManager.instance = new RateLimitManager();
        }
        return RateLimitManager.instance;
    }
    
    /**
     * Get a unique key for provider-model combination
     */
    private getKey(provider: string, model: string): string {
        return `${provider}:${model}`;
    }
    
    /**
     * Parse rate limit headers from Gemini API response
     */
    private parseGeminiHeaders(headers: Headers): Partial<RateLimitInfo> {
        const info: Partial<RateLimitInfo> = {};
        
        // Gemini uses these header names (based on API documentation)
        const tokensLimit = headers.get('x-ratelimit-limit-tokens-per-minute');
        const tokensRemaining = headers.get('x-ratelimit-remaining-tokens-per-minute');
        const requestsLimit = headers.get('x-ratelimit-limit-requests-per-minute');
        const requestsRemaining = headers.get('x-ratelimit-remaining-requests-per-minute');
        
        if (tokensLimit) info.tokensPerMinute = parseInt(tokensLimit);
        if (tokensRemaining) info.remainingTokens = parseInt(tokensRemaining);
        if (requestsLimit) info.requestsPerMinute = parseInt(requestsLimit);
        if (requestsRemaining) info.remainingRequests = parseInt(requestsRemaining);
        
        return info;
    }
    
    /**
     * Parse rate limit headers from Groq API response
     * Note: Groq provides per-day limits, but we store them as-is for accurate tracking
     */
    private parseGroqHeaders(headers: Headers): Partial<RateLimitInfo> {
        const info: Partial<RateLimitInfo> = {};
        
        // Groq uses these header names
        const tokensLimit = headers.get('x-ratelimit-limit-tokens');
        const tokensRemaining = headers.get('x-ratelimit-remaining-tokens');
        const requestsLimit = headers.get('x-ratelimit-limit-requests');
        const requestsRemaining = headers.get('x-ratelimit-remaining-requests');
        const resetTime = headers.get('x-ratelimit-reset-tokens');
        
        // Store the actual values from headers (these are per-day for Groq)
        if (tokensLimit) info.tokensPerMinute = parseInt(tokensLimit);
        if (tokensRemaining) info.remainingTokens = parseInt(tokensRemaining);
        if (requestsLimit) info.requestsPerMinute = parseInt(requestsLimit);
        if (requestsRemaining) info.remainingRequests = parseInt(requestsRemaining);
        if (resetTime) info.resetTime = parseInt(resetTime) * 1000; // Convert to ms
        
        return info;
    }
    
    /**
     * Parse rate limit headers from OpenRouter API response
     */
    private parseOpenRouterHeaders(headers: Headers): Partial<RateLimitInfo> {
        const info: Partial<RateLimitInfo> = {};
        
        // OpenRouter uses similar headers to OpenAI
        const tokensLimit = headers.get('x-ratelimit-limit-tokens');
        const tokensRemaining = headers.get('x-ratelimit-remaining-tokens');
        const requestsLimit = headers.get('x-ratelimit-limit-requests');
        const requestsRemaining = headers.get('x-ratelimit-remaining-requests');
        const resetTime = headers.get('x-ratelimit-reset-requests');
        
        if (tokensLimit) info.tokensPerMinute = parseInt(tokensLimit);
        if (tokensRemaining) info.remainingTokens = parseInt(tokensRemaining);
        if (requestsLimit) info.requestsPerMinute = parseInt(requestsLimit);
        if (requestsRemaining) info.remainingRequests = parseInt(requestsRemaining);
        if (resetTime) info.resetTime = parseInt(resetTime) * 1000; // Convert to ms
        
        return info;
    }
    
    /**
     * Parse rate limit headers from OpenAI-compatible APIs (like NVIDIA or OpenCode)
     */
    private parseOpenAICompatibleHeaders(headers: Headers): Partial<RateLimitInfo> {
        const info: Partial<RateLimitInfo> = {};
        
        // OpenAI-compatible headers
        const tokensLimit = headers.get('x-ratelimit-limit-tokens');
        const tokensRemaining = headers.get('x-ratelimit-remaining-tokens');
        const requestsLimit = headers.get('x-ratelimit-limit-requests');
        const requestsRemaining = headers.get('x-ratelimit-remaining-requests');
        const resetTime = headers.get('x-ratelimit-reset-requests');
        
        if (tokensLimit) info.tokensPerMinute = parseInt(tokensLimit);
        if (tokensRemaining) info.remainingTokens = parseInt(tokensRemaining);
        if (requestsLimit) info.requestsPerMinute = parseInt(requestsLimit);
        if (requestsRemaining) info.remainingRequests = parseInt(requestsRemaining);
        if (resetTime) {
            // Some providers use seconds, some use timestamps.
            // If it's a small number, assume seconds.
            const val = parseFloat(resetTime);
            if (val < 10000000) {
                info.resetTime = Date.now() + (val * 1000);
            } else {
                info.resetTime = val * 1000;
            }
        }
        
        return info;
    }
    
    /**
     * Update rate limits from API response headers
     */
    updateFromHeaders(provider: string, model: string, headers: Headers): void {
        const key = this.getKey(provider, model);
        
        let parsedInfo: Partial<RateLimitInfo>;
        
        switch (provider.toLowerCase()) {
            case 'gemini':
                parsedInfo = this.parseGeminiHeaders(headers);
                break;
            case 'groq':
                parsedInfo = this.parseGroqHeaders(headers);
                break;
            case 'openrouter':
                parsedInfo = this.parseOpenRouterHeaders(headers);
                break;
            case 'opencode':
            case 'nvidia':
                // These are OpenAI-compatible and typically use standard OpenAI rate limit headers
                // For now, we'll use a generic OpenAI header parser if it exists, or just return empty
                parsedInfo = this.parseOpenAICompatibleHeaders(headers);
                break;
            default:
                                return;
        }
        
        // Get existing state or create new one
        let state = this.rateLimits.get(key);
        if (!state) {
            state = {
                currentTokenCount: 0,
                currentRequestCount: 0,
                lastResetTime: Date.now(),
                limits: null
            };
        }
        
        // Update limits with parsed info
        if (Object.keys(parsedInfo).length > 0) {
            state.limits = {
                tokensPerMinute: parsedInfo.tokensPerMinute || state.limits?.tokensPerMinute || RateLimitManager.DEFAULT_LIMITS[provider]?.tokensPerMinute || 100000,
                requestsPerMinute: parsedInfo.requestsPerMinute || state.limits?.requestsPerMinute || RateLimitManager.DEFAULT_LIMITS[provider]?.requestsPerMinute || 60,
                remainingTokens: parsedInfo.remainingTokens ?? state.limits?.remainingTokens ?? 0,
                remainingRequests: parsedInfo.remainingRequests ?? state.limits?.remainingRequests ?? 0,
                resetTime: parsedInfo.resetTime || Date.now() + 60000
            };
            
                    }
        
        this.rateLimits.set(key, state);
    }
    
    /**
     * Get current rate limit state for a provider-model combination
     */
    getState(provider: string, model: string): RateLimitState {
        const key = this.getKey(provider, model);
        let state = this.rateLimits.get(key);
        
        if (!state) {
            // Initialize with default limits
            const defaultLimits = RateLimitManager.DEFAULT_LIMITS[provider] || RateLimitManager.DEFAULT_LIMITS['gemini'];
            state = {
                currentTokenCount: 0,
                currentRequestCount: 0,
                lastResetTime: Date.now(),
                limits: { ...defaultLimits }
            };
            this.rateLimits.set(key, state);
        }
        
        // Check if we need to reset counters (1 minute has passed)
        const now = Date.now();
        if (now - state.lastResetTime >= 60000) {
            state.currentTokenCount = 0;
            state.currentRequestCount = 0;
            state.lastResetTime = now;
            if (state.limits) {
                state.limits.remainingTokens = state.limits.tokensPerMinute;
                state.limits.remainingRequests = state.limits.requestsPerMinute;
            }
        }
        
        return state;
    }
    
    /**
     * Calculate how long to wait before making an API call
     * @returns Delay in milliseconds (0 if no wait needed)
     */
    calculateDelay(provider: string, model: string, estimatedTokens: number): number {
        const state = this.getState(provider, model);
        
        if (!state.limits) {
            return 0; // No limits known yet
        }
        
        const now = Date.now();
        const oneMinute = 60 * 1000;
        
        let delayNeeded = 0;
        
        // Check token limit
        if (state.currentTokenCount + estimatedTokens > state.limits.tokensPerMinute) {
            const timeElapsed = now - state.lastResetTime;
            const timeLeft = oneMinute - timeElapsed;
            delayNeeded = Math.max(delayNeeded, timeLeft);
        }
        
        // Check request limit
        if (state.currentRequestCount + 1 > state.limits.requestsPerMinute) {
            const timeElapsed = now - state.lastResetTime;
            const timeLeft = oneMinute - timeElapsed;
            delayNeeded = Math.max(delayNeeded, timeLeft);
        }
        
        return Math.max(0, delayNeeded);
    }
    
    /**
     * Wait for rate limit clearance before making an API call
     */
    async waitForClearance(provider: string, model: string, estimatedTokens: number): Promise<void> {
        const delay = this.calculateDelay(provider, model, estimatedTokens);
        
        if (delay > 0) {
            const waitSeconds = Math.ceil(delay / 1000);
                        await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    /**
     * Record that an API call was made
     */
    recordApiCall(provider: string, model: string, tokensUsed: number): void {
        const state = this.getState(provider, model);
        state.currentTokenCount += tokensUsed;
        state.currentRequestCount += 1;
        
            }
    
    /**
     * Get available token budget for content
     */
    getAvailableTokenBudget(provider: string, model: string, reserveRatio: number = 0.3): number {
        const state = this.getState(provider, model);
        
        if (!state.limits) {
            return 50000; // Conservative default
        }
        
        const now = Date.now();
        const timeElapsed = now - state.lastResetTime;
        const tokensPerSecond = state.limits.tokensPerMinute / 60;
        const tokensAvailableNow = Math.floor(tokensPerSecond * (timeElapsed / 1000));
        const remainingTokens = Math.max(0, tokensAvailableNow - state.currentTokenCount);
        const availableForContent = remainingTokens * (1 - reserveRatio);
        
        return Math.floor(availableForContent);
    }
    
    /**
     * Clear all rate limit data (useful for testing or reset)
     */
    clear(): void {
        this.rateLimits.clear();
    }
}
