export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function scanArgsText(text: string, start: number): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  let i = start;
  const len = text.length;

  while (i < len) {
    while (i < len && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r' || text[i] === ',')) {
      i++;
    }
    if (i >= len) return null;
    if (text[i] === ')') return args;

    const keyStart = i;
    while (i < len && /\w/.test(text[i])) i++;
    if (i === keyStart) return null;
    const key = text.slice(keyStart, i);

    while (i < len && text[i] === ' ') i++;
    if (i >= len || text[i] !== '=') return null;
    i++;
    while (i < len && text[i] === ' ') i++;

    let value = '';
    if (text[i] === '"') {
      i++;
      while (i < len) {
        if (text[i] === '\\') {
          i++;
          if (i < len) {
            const esc = text[i];
            if (esc === 'n') value += '\n';
            else if (esc === 't') value += '\t';
            else if (esc === 'r') value += '\r';
            else value += esc;
            i++;
          }
        } else if (text[i] === '"') {
          i++;
          break;
        } else {
          value += text[i];
          i++;
        }
      }
    } else {
      while (i < len && text[i] !== ',' && text[i] !== ')' && text[i] !== ' ' && text[i] !== '\t' && text[i] !== '\n' && text[i] !== '\r') {
        value += text[i];
        i++;
      }
    }
    args[key] = value;
  }

  return null;
}

export function parseToolCallsFromText(text: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  const regex = /ACTION:\s*(\w+)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    const args = scanArgsText(text, match.index + match[0].length);
    if (args !== null) {
      results.push({ name, arguments: args });
    }
  }

  return results;
}
