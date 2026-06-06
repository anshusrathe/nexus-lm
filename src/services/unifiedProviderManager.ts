
export interface UnifiedMessage {
    role: 'system' | 'user' | 'assistant';
    content: string | Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }>;
}

export interface UnifiedGenerationOptions {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    stopSequences?: string[];
    thinkingLevel?: 'low' | 'medium' | 'high';
    abortSignal?: AbortSignal;
}

export interface UnifiedResponse {
    text: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}

export abstract class BaseProvider {
    abstract readonly id: string;
    abstract readonly name: string;

    abstract generateContent(
        modelId: string,
        messages: UnifiedMessage[],
        options?: UnifiedGenerationOptions,
        onThinking?: (text: string) => void
    ): Promise<UnifiedResponse>;

    abstract streamContent?(
        modelId: string,
        messages: UnifiedMessage[],
        onChunk: (chunk: string) => void,
        options?: UnifiedGenerationOptions,
        onThinking?: (text: string) => void
    ): Promise<UnifiedResponse>;

    generateContentWithTools?(
        modelId: string,
        messages: UnifiedMessage[],
        tools: any[],
        options?: UnifiedGenerationOptions & { toolChoice?: string },
        executeToolCallback?: (toolCall: any) => Promise<any>,
        onThinking?: (text: string) => void
    ): Promise<{ content: string; totalTokens?: number }>;
}

export class UnifiedProviderManager {
    private static instance: UnifiedProviderManager;
    private providers: Map<string, BaseProvider> = new Map();

    private constructor() {}

    static getInstance(): UnifiedProviderManager {
        if (!UnifiedProviderManager.instance) {
            UnifiedProviderManager.instance = new UnifiedProviderManager();
        }
        return UnifiedProviderManager.instance;
    }

    registerProvider(provider: BaseProvider) {
        this.providers.set(provider.id, provider);
    }

    unregisterProvider(id: string) {
        this.providers.delete(id);
    }

    getProvider(id: string): BaseProvider | undefined {
        return this.providers.get(id);
    }

    hasProvider(id: string): boolean {
        return this.providers.has(id);
    }

    getAllProviders(): BaseProvider[] {
        return Array.from(this.providers.values());
    }
}
