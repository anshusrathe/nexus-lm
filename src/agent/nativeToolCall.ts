import type { ToolDefinition, ToolCall, ToolResult } from './types';

export function buildProviderTools(defs: ToolDefinition[]): Array<Record<string, unknown>> {
  return defs.map((def) => ({
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.inputSchema,
    },
  }));
}

export function normalizeToolCalls(
  raw: Array<Record<string, unknown>> | undefined,
  providerId: string
): ToolCall[] {
  if (!raw || raw.length === 0) return [];

  const results: ToolCall[] = [];
  for (let i = 0; i < raw.length; i++) {
    const rawCall = raw[i];

    if (providerId === 'gemini') {
      const fn = (rawCall.functionCall ?? rawCall.function) as Record<string, unknown> | undefined;
      if (!fn?.name) continue;
      // Gemini returns thoughtSignature at the PART level (sibling of functionCall),
      // never inside the functionCall object itself.
      const thoughtSignature = extractThoughtSignature(rawCall) ?? extractThoughtSignature(fn);
      results.push({
        id: String(rawCall.id ?? `call_${Date.now()}_${i}`),
        name: String(fn.name),
        arguments: toArgumentsObject(fn.args ?? fn.arguments),
        ...(thoughtSignature ? { thoughtSignature } : {}),
      });
      continue;
    }

    if (providerId === 'ollama') {
      const fn = (rawCall.function ?? rawCall.functionCall) as Record<string, unknown> | undefined;
      if (!fn?.name) continue;
      results.push({
        id: String(rawCall.id ?? `call_${Date.now()}_${i}`),
        name: String(fn.name),
        arguments: toArgumentsObject(fn.arguments ?? fn.args),
      });
      continue;
    }

    const fn = (rawCall.function ?? rawCall.functionCall) as Record<string, unknown> | undefined;
    if (!fn?.name) continue;
    results.push({
      id: String(rawCall.id ?? `call_${Date.now()}_${i}`),
      name: String(fn.name),
      arguments: toArgumentsObject(fn.arguments ?? fn.args),
    });
  }

  return results;
}

export function toOpenAIFormat(tc: ToolCall): Record<string, unknown> {
  return {
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments),
      ...(tc.thoughtSignature ? { thought_signature: tc.thoughtSignature } : {}),
    },
  };
}

export function buildToolResultMessage(tc: ToolCall, result: ToolResult): Record<string, unknown> {
  return {
    role: 'tool',
    tool_call_id: tc.id,
    name: tc.name,
    content: result.success ? result.content : `Error: ${result.error ?? 'Unknown error'}`,
  };
}

function toArgumentsObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function extractThoughtSignature(fn: Record<string, unknown>): string | undefined {
  const sig = fn.thought_signature ?? fn.thoughtSignature;
  return typeof sig === 'string' && sig.length > 0 ? sig : undefined;
}
