import type { HashLine } from '../types';

function xxHash32(input: string, seed: number = 0): number {
  let h32: number = seed;
  const len = input.length;
  for (let i = 0; i < len; i++) {
    const ch = input.charCodeAt(i);
    h32 = Math.imul(h32 ^ ch, 0x85ebca6b);
    h32 = (h32 ^ (h32 >>> 13)) & 0xffffffff;
  }
  h32 = Math.imul(h32 ^ (h32 >>> 16), 0x85ebca6b);
  h32 = (h32 ^ (h32 >>> 13)) & 0xffffffff;
  h32 = Math.imul(h32 ^ (h32 >>> 16), 0x9e3779b9);
  h32 = (h32 ^ (h32 >>> 16)) >>> 0;
  return h32;
}

const HASH_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function encodeHash(hash: number): string {
  const first = HASH_ALPHABET[hash % 62];
  const second = HASH_ALPHABET[(hash >>> 6) % 62];
  return first + second;
}

export function computeLineHash(lineNumber: number, content: string): string {
  const seed = lineNumber * 2654435761;
  const combined = content + '\n' + String(lineNumber);
  const hash = xxHash32(combined, seed);
  return encodeHash(hash);
}

export function hashLines(lines: string[], startLine: number = 1): HashLine[] {
  const result: HashLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = startLine + i;
    const content = lines[i];
    result.push({
      lineNumber,
      hash: computeLineHash(lineNumber, content),
      content,
    });
  }
  return result;
}

export function verifyLineHash(line: HashLine): boolean {
  const computed = computeLineHash(line.lineNumber, line.content);
  return computed === line.hash;
}

export function parseLineRef(ref: string): { lineNumber: number; hash: string } | null {
  const parts = ref.split('#');
  if (parts.length !== 2) return null;
  const lineNumber = parseInt(parts[0], 10);
  if (isNaN(lineNumber)) return null;
  return { lineNumber, hash: parts[1] };
}
