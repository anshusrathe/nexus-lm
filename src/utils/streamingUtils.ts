import { requestUrl } from 'obsidian';

export interface StreamChunk {
  content?: string;
  thinking?: string;
  done: boolean;
}

export type LineStreamParser = (line: string) => StreamChunk;

export interface StreamCallbacks {
  onChunk: (text: string) => void;
  onThinking?: (text: string) => void;
}

function yieldToUI(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
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

  const parsedBody = JSON.parse(body);
  parsedBody.stream = false;
  const nonStreamBody = JSON.stringify(parsedBody);

  const response = await requestUrl({ url, method, headers, body: nonStreamBody, throw: false });

  if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

  if (response.status >= 400) {
    const errorData = typeof response.json === 'object' ? response.json : {};
    const msg = errorData.error?.message || `Request failed with status ${response.status}`;
    throw new Error(`API error (${response.status}): ${msg}`);
  }

  const data = response.json;

  let fullContent = '';
  let thinkingText = '';

  if (responseFormat === 'ollama') {
    fullContent = data.message?.content || '';
    thinkingText = data.message?.thinking || '';
  } else {
    const message = data.choices?.[0]?.message;
    fullContent = message?.content || '';
    thinkingText = message?.reasoning || message?.reasoning_content || '';
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

  const response = await fetch(url, {
    method: 'POST',
    signal: abortSignal,
    headers,
    body
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`API error (${response.status}): ${errorText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body is not readable');

  const decoder = new TextDecoder();
  let buffer = '';

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
        if (chunk.done) return;
        if (chunk.thinking && callbacks.onThinking) callbacks.onThinking(chunk.thinking);
        if (chunk.content) callbacks.onChunk(chunk.content);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function createSSEParser(): LineStreamParser {
  return (line: string): StreamChunk => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) return { done: false };
    if (trimmed === 'data: [DONE]') return { done: true };
    try {
      const parsed = JSON.parse(trimmed.slice(6));
      const delta = parsed.choices?.[0]?.delta;
      return {
        content: delta?.content || undefined,
        thinking: delta?.reasoning || delta?.reasoning_content || undefined,
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
      const data = JSON.parse(trimmed);
      return {
        content: data.message?.content || undefined,
        thinking: data.message?.thinking || undefined,
        done: data.done || false
      };
    } catch {
      return { done: false };
    }
  };
}
