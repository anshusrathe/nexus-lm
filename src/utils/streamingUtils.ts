import { Platform, requestUrl } from 'obsidian';
import { nativeFetch } from './fetchHelper';

export interface StreamChunk {
  content?: string;
  thinking?: string;
  done: boolean;
  finishReason?: string;
}

export type LineStreamParser = (line: string) => StreamChunk;

export interface StreamCallbacks {
  onChunk: (text: string) => void;
  onThinking?: (text: string) => void;
  onFinish?: (finishReason: string) => void;
}

export class PartialStreamError extends Error {
  constructor(cause: unknown) {
    super(`Stream interrupted after content was received: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PartialStreamError';
  }
}

function yieldToUI(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0));
}

/**
 * Simulated streaming via requestUrl.
 *
 * Sends a NON-STREAMING request (stream: false) to the API so we always get
 * a clean JSON response back (no SSE parsing issues across transports).
 * Then splits the response text into chunks and emits them progressively
 * with yieldToUI() between each so the Obsidian UI thread can paint.
 *
 * This is the cross-platform fallback when true fetch-streaming is blocked
 * by CORS (the common case on desktop Obsidian renderer).
 */
export async function simulatedStream(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal,
  responseFormat?: 'openai' | 'ollama'
): Promise<Record<string, string>> {
  if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const parsedBody = JSON.parse(body) as { stream?: boolean; [key: string]: unknown };
  parsedBody.stream = false;
  const nonStreamBody = JSON.stringify(parsedBody);

  const response = await requestUrl({ url, method, headers, body: nonStreamBody, throw: false });

  if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

  if (response.status >= 400) {
    let errorData: { error?: { message?: string } } = {};
    let rawText = '';
    try {
      const j: unknown = response.json;
      if (j && typeof j === 'object') errorData = j;
    } catch {
      rawText = typeof response.text === 'string' ? response.text : '';
    }
    const msg = errorData.error?.message || rawText.slice(0, 500) || `Request failed with status ${response.status}`;
    throw new Error(`API error (${response.status}): ${msg}`);
  }

  let data: StreamingResponseData;
  try {
    const j: unknown = response.json;
    if (!j || typeof j !== 'object') throw new Error('not an object');
    data = j;
  } catch {
    throw new Error(`API error (${response.status}): Non-JSON response: ${(typeof response.text === 'string' ? response.text : '').slice(0, 500) || 'empty body'}`);
  }

  let fullContent = '';
  let thinkingText = '';
  let finishReason: string | undefined;

  if (responseFormat === 'ollama') {
    fullContent = data.message?.content || '';
    thinkingText = data.message?.thinking || '';
    finishReason = data.done ? 'stop' : 'length';
  } else {
    finishReason = data.choices?.[0]?.finish_reason;
    const message = data.choices?.[0]?.message;
    fullContent = message?.content || '';
    const messageWithReasoning = message as unknown as Record<string, unknown>;
    thinkingText = (messageWithReasoning.reasoning as string) || (messageWithReasoning.reasoning_content as string) || '';
  }

  if (thinkingText && callbacks.onThinking) {
    callbacks.onThinking(thinkingText);
    await yieldToUI();
  }

  if (fullContent) {
    const sentences = fullContent.match(/[^.!?]*[.!?]+|[^.!?]+$/g) || [fullContent];
    for (let i = 0; i < sentences.length; i++) {
      if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      callbacks.onChunk(sentences[i]);
      await yieldToUI();
    }
  }

  if (finishReason && callbacks.onFinish) {
    callbacks.onFinish(finishReason);
  }

  return response.headers;
}

/**
 * True streaming via native fetch() + ReadableStream.
 * Works on mobile Obsidian and for providers with permissive CORS.
 * Always parses the wire format (SSE or NDJSON) via the provided parser.
 */
export async function fetchStream(
  url: string,
  headers: Record<string, string>,
  body: string,
  parser: LineStreamParser,
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal
): Promise<void> {
  if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

  let emitted = false;
  const trackedCallbacks: StreamCallbacks = {
    onChunk: text => { emitted = true; callbacks.onChunk(text); },
    onThinking: callbacks.onThinking
      ? text => { emitted = true; callbacks.onThinking?.(text); }
      : undefined,
  };

  try {
    await fetchReadableStream(url, headers, body, parser, trackedCallbacks, abortSignal);
    return;
  } catch (error) {
    if (emitted) throw new PartialStreamError(error);
    if (!Platform.isDesktopApp) throw error;
  }

  try {
    await desktopNodeStream(url, headers, body, parser, trackedCallbacks, abortSignal);
  } catch (error) {
    if (emitted) throw new PartialStreamError(error);
    throw error;
  }
}

async function fetchReadableStream(
  url: string,
  headers: Record<string, string>,
  body: string,
  parser: LineStreamParser,
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal
): Promise<void> {
  const response = await nativeFetch(url, { method: 'POST', signal: abortSignal, headers, body });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`API error (${response.status}): ${errorText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body is not readable');

  const decoder = new TextDecoder();
  let buffer = '';
  let lastFinishReason: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const chunk = parser(line);
        if (chunk.finishReason) lastFinishReason = chunk.finishReason;
        if (chunk.done) {
          if (lastFinishReason && callbacks.onFinish) callbacks.onFinish(lastFinishReason);
          return;
        }
        if (chunk.thinking && callbacks.onThinking) callbacks.onThinking(chunk.thinking);
        if (chunk.content) callbacks.onChunk(chunk.content);
      }
    }
    if (lastFinishReason && callbacks.onFinish) callbacks.onFinish(lastFinishReason);
  } finally {
    reader.releaseLock();
  }
}

async function desktopNodeStream(
  url: string,
  headers: Record<string, string>,
  body: string,
  parser: LineStreamParser,
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal
): Promise<void> {
  const nodeRequire = (window as unknown as { require?: NodeRequire }).require;
  if (!nodeRequire) throw new Error('Desktop streaming transport is unavailable');
  const target = new URL(url);
  const transport = nodeRequire(target.protocol === 'http:' ? 'http' : 'https') as typeof import('https');

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let lastFinishReason: string | undefined;
    const callOnFinish = () => {
      if (lastFinishReason && callbacks.onFinish) callbacks.onFinish(lastFinishReason);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener('abort', abort);
      callOnFinish();
      error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve();
    };
    const request = transport.request(target, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
    }, response => {
      if ((response.statusCode ?? 500) >= 400) {
        let errorBody = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { errorBody += String(chunk); });
        response.on('end', () => finish(new Error(`API error (${response.statusCode}): ${errorBody}`)));
        return;
      }
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += String(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const parsed = parser(line);
          if (parsed.finishReason) lastFinishReason = parsed.finishReason;
          if (parsed.thinking && callbacks.onThinking) callbacks.onThinking(parsed.thinking);
          if (parsed.content) callbacks.onChunk(parsed.content);
          if (parsed.done) {
            callOnFinish();
            response.destroy();
            finish();
            return;
          }
        }
      });
      response.on('end', () => finish());
      response.on('error', finish);
    });
    const abort = () => {
      request.destroy(new DOMException('Aborted', 'AbortError'));
      finish(new DOMException('Aborted', 'AbortError'));
    };
    abortSignal?.addEventListener('abort', abort, { once: true });
    request.on('error', finish);
    request.write(body);
    request.end();
  });
}

export function createSSEParser(): LineStreamParser {
  return (line: string): StreamChunk => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) return { done: false };
    if (trimmed === 'data: [DONE]') return { done: true };
    try {
      const parsed = JSON.parse(trimmed.slice(6)) as SSEChoiceDelta;
      const choice = parsed.choices?.[0];
      const delta = choice?.delta;
      return {
        content: delta?.content || undefined,
        thinking: delta?.reasoning || delta?.reasoning_content || undefined,
        finishReason: choice?.finish_reason || undefined,
        done: false
      };
    } catch {
      return { done: false };
    }
  };
}

export function createOllamaParser(): LineStreamParser {
  return (line: string): StreamChunk => {
    const trimmed = line.trim();
    if (!trimmed) return { done: false };
    try {
      const data = JSON.parse(trimmed) as OllamaStreamChunk;
      return {
        content: data.message?.content || undefined,
        thinking: data.message?.thinking || undefined,
        done: data.done || false,
        finishReason: data.done ? 'stop' : undefined
      };
    } catch {
      return { done: false };
    }
  };
}
