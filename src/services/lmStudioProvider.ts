import { CustomOpenAIProvider } from './customOpenAIProvider';

/**
 * LmStudioProvider - Native provider integration for LM Studio's
 * OpenAI-compatible local server.
 *
 * LM Studio exposes the standard OpenAI endpoints at `http://<host>:<port>/v1`:
 *   - GET  /v1/models                 (list loaded/downloaded models)
 *   - POST /v1/chat/completions       (chat, streaming, tools, vision)
 *   - POST /v1/embeddings             (embedding models)
 *
 * No API key is required by default; an optional API token (LM Studio >= 0.4.0)
 * is passed through as `Authorization: Bearer <token>` when configured.
 *
 * Because this extends CustomOpenAIProvider, it automatically inherits:
 *   - native tool calling (generateContentWithTools / ...WithToolsOnce)
 *   - token streaming with CORS-safe fallback (fetchStream -> simulatedStream)
 *   - thinking/reasoning_content passthrough
 *   - rate limiting and usage accounting
 *
 * Registering it in the UnifiedProviderManager (see src/main.ts) makes it
 * available end-to-end to every AI feature in the plugin: chat, agent, sub-
 * agents, notebooks, YouTube, concept maps, MCQs, QnA, slides, file creation,
 * temporal filtering, edit selection and vault search.
 */
export class LmStudioProvider extends CustomOpenAIProvider {
    constructor(baseUrl: string, apiToken: string = '') {
        super('lmstudio', 'LM Studio', baseUrl, apiToken);
    }
}
