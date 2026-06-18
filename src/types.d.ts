declare module 'web-worker:*' {
    const WorkerFactory: new () => Worker;
    export default WorkerFactory;
}

// ===== PDF.js Type Declarations (ambient for Window augmentation) =====
interface PdfjsLib {
    getDocument(data: { data: ArrayBuffer }): { promise: Promise<PdfDocumentProxy> };
    GlobalWorkerOptions: { workerSrc: string };
}

interface PdfDocumentProxy {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfPageProxy>;
    getOutline(): Promise<PdfOutlineItem[] | null>;
    getDestination(destString: string): Promise<(PdfPageProxy | number)[]>;
    getPageIndex(ref: { num: number; gen: number }): Promise<number>;
}

interface PdfPageProxy {
    getViewport(params: { scale: number }): { width: number; height: number };
    getTextContent(): Promise<{ items: PdfTextItem[] }>;
    render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
}

interface PdfTextItem {
    str: string;
    transform: number[];
    width: number;
    height: number;
    fontName: string;
}

interface PdfOutlineItem {
    title: string;
    dest?: string | unknown[];
    items: PdfOutlineItem[];
}

// ===== Orama Worker Types =====
interface OramaWorkerPayload {
    schema?: Record<string, string>;
    data?: ArrayBuffer | Array<Record<string, unknown>>;
    query?: string;
    limit?: number;
    instanceId?: string;
    compressed?: boolean;
    compress?: boolean;
    params?: Record<string, unknown>;
    docId?: string;
    path?: string;
    metadata?: Record<string, unknown>;
    documents?: Array<Record<string, unknown>>;
    document?: Record<string, unknown>;
}

interface OramaWorkerResponse {
    success: boolean;
    instanceId?: string;
    id?: string;
    payload?: unknown;
    error?: string;
}

// ===== API Response Types =====
interface OpenRouterCreditsResponse {
    data?: { total_credits?: number; total_usage?: number };
}

interface GeminiErrorResponse {
    error?: { message?: string; status?: string; code?: number };
}

interface GroqChatCompletionChoice {
    index: number;
    message?: { role?: string; content?: string; reasoning_content?: string; reasoning?: string };
    finish_reason?: string;
}

interface GroqChatCompletionResponse {
    id?: string;
    choices?: GroqChatCompletionChoice[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    model?: string;
}

interface OpenAIChatCompletionChoice {
    index: number;
    message?: { role?: string; content?: string; tool_calls?: unknown[] };
    finish_reason?: string;
}

interface OpenAIChatCompletionResponse {
    id?: string;
    choices?: OpenAIChatCompletionChoice[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    model?: string;
}

interface OllamaGenerateResponse {
    model?: string;
    response?: string;
    done?: boolean;
    message?: { role?: string; content?: string };
    context?: number[];
    total_duration?: number;
    eval_count?: number;
    eval_duration?: number;
}

interface NvidiaChatCompletionResponse {
    id?: string;
    choices?: Array<{
        index?: number;
        message?: { role?: string; content?: string; tool_calls?: unknown[] };
        finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    model?: string;
}

interface OramaMetadata {
    model?: string;
    fileCount?: number;
    lastUpdated?: number;
    [key: string]: unknown;
}

interface OramaSearchResult {
    id: string;
    score: number;
    [key: string]: unknown;
}

interface McpToolDefinition {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

interface McpToolCallResult {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
}

interface YouTubeTranscriptSegment {
    text: string;
    start: number;
    duration: number;
}

interface WebSearchResultItem {
    title: string;
    link: string;
    snippet?: string;
    content?: string;
    date?: string;
}

interface CodeExecutorResult {
    stdout?: string;
    stderr?: string;
    error?: string;
    exitCode?: number;
}

interface FileActionData {
    filePath?: string;
    action?: string;
    content?: string;
    [key: string]: unknown;
}

interface ContextSource {
    path: string;
    relevance?: number;
    [key: string]: unknown;
}

// ===== JSON-RPC Types (MCP) =====
interface JSONRPCResponse {
    id?: number | string;
    error?: { code?: number; message?: string; data?: unknown };
    result?: unknown;
}

// ===== Streaming Types =====
interface SSEChoiceDelta {
    choices?: Array<{
        delta?: { content?: string; reasoning?: string; reasoning_content?: string };
        message?: { content?: string; role?: string; tool_calls?: unknown[] };
    }>;
}

interface OllamaStreamChunk {
    message?: { content?: string; thinking?: string };
    done?: boolean;
}

interface StreamingResponseData {
    message?: { content?: string; thinking?: string };
    choices?: Array<{
        delta?: { content?: string; reasoning?: string; reasoning_content?: string };
        message?: { content?: string; role?: string; tool_calls?: unknown[] };
    }>;
    done?: boolean;
}

// ===== Canvas/Excalidraw Parse Types =====
interface CanvasParseResult {
    nodes?: unknown[];
    edges?: unknown[];
    targetPath?: string;
    folderName: string;
}

interface ExcalidrawParseResult {
    elements?: unknown[];
    type?: string;
    version?: number;
    source?: string;
    appState?: Record<string, unknown>;
    files?: Record<string, unknown>;
    targetPath?: string;
    folderName: string;
}

// ===== MCP Config Types =====
interface MCPSchemaInput {
    mcpServers?: Record<string, Partial<MCPServerConfig>>;
    transport?: string;
    command?: string;
    url?: string;
    args?: string | string[];
    streamUrl?: string;
    apiKey?: string;
    env?: Record<string, string>;
}

interface MCPServerConfig {
    id?: string;
    name?: string;
    disabled?: boolean;
    transport?: string;
    command?: string;
    url?: string;
    args?: string[];
    streamUrl?: string;
    apiKey?: string;
    env?: Record<string, string>;
    [key: string]: unknown;
}

// ===== Gemini Extended Types =====
interface GeminiPartExtended {
    text?: string;
    thought?: boolean;
    functionCall?: { name?: string; args?: Record<string, unknown> };
}

interface ExtendedGroundingMetadata {
    groundingSupports?: Array<{
        segment?: { startIndex?: number; endIndex?: number };
        segmentIndices?: number[];
        support?: Array<{ chunkIndex?: number; text?: string }>;
    }>;
    groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
}

// ===== Provider Types =====
interface BaseChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: unknown[];
    images?: string[];
}

interface ProviderTool {
    type: string;
    function: { name: string; description?: string; parameters?: Record<string, unknown> };
    [key: string]: unknown;
}

interface GeminiStartChatConfig {
    history?: unknown[];
    generationConfig?: Record<string, unknown>;
    tools?: unknown[];
}

// ===== Tool Argument Types =====
interface ToolSelectionArgs {
    selected_tools?: unknown[];
}

interface WebSearchToolArgs {
    results?: unknown[];
}

// ===== Notebook Types =====
interface NotebookContextCache {
    context: string;
    noteMeta: Array<{ path: string; mtime: number }>;
    sourcePaths: string[];
}

interface QueryExpansionResult {
    subQueries?: string[];
    keyTerms?: string[];
    paraphrases?: string[];
}

// ===== Temporal Filter Types =====
interface TemporalFilterInput {
    hasTime?: boolean;
    startDate?: string;
    endDate?: string;
    cleanQuery?: string;
}

// ===== Window augmentation for pdfjsLib and concept maps =====
interface Window {
    pdfjsLib?: PdfjsLib;
    activeConceptMapModal?: unknown;
    require?: NodeRequire;
}

// ===== Ollama Tags Response =====
interface OllamaTagsResponse {
    models?: Array<{ name: string; size?: number; modified_at?: string }>;
}
