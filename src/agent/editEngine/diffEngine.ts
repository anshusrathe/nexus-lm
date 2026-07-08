import { normalizePath, type App, TFile } from 'obsidian';
import type { EditOperation, EditVerification, HashLine } from '../types';
import { computeLineHash, parseLineRef, verifyLineHash } from './hashReader';

interface DiffResult {
  original: string[];
  modified: string[];
  changedLines: number[];
}

function readFileLines(app: App, path: string): Promise<string[]> {
  const normalized = normalizePath(path);
  const file = app.vault.getAbstractFileByPath(normalized);
  if (!(file instanceof TFile)) {
    return Promise.reject(new Error(`File not found: ${path}`));
  }
  return app.vault.read(file).then((content: string) => content.split('\n'));
}

function writeFileLines(app: App, path: string, lines: string[]): Promise<void> {
  const normalized = normalizePath(path);
  const file = app.vault.getAbstractFileByPath(normalized);
  if (!(file instanceof TFile)) {
    return Promise.reject(new Error(`File not found: ${path}`));
  }
  return app.vault.modify(file, lines.join('\n'));
}

export function verifyEdit(
  lines: string[],
  lineRef: string
): EditVerification {
  const ref = parseLineRef(lineRef);
  if (!ref) {
    return { valid: false, reason: `Invalid line reference: ${lineRef}` };
  }

  const index = ref.lineNumber - 1;
  if (index < 0 || index >= lines.length) {
    return { valid: false, reason: `Line ${ref.lineNumber} out of range (file has ${lines.length} lines)` };
  }

  const currentLine = lines[index];
  const currentHash = computeLineHash(ref.lineNumber, currentLine);
  if (currentHash !== ref.hash) {
    return {
      valid: false,
      reason: `Hash mismatch at line ${ref.lineNumber}: expected "${ref.hash}", got "${currentHash}"`,
      currentHash,
      expectedHash: ref.hash,
    };
  }

  return { valid: true };
}

function applyReplace(lines: string[], lineRef: string, newContent: string): string[] {
  const ref = parseLineRef(lineRef);
  if (!ref) return lines;
  const index = ref.lineNumber - 1;
  const newLines = [...lines];
  const replacementLines = newContent.split('\n');
  newLines.splice(index, 1, ...replacementLines);
  return newLines;
}

function applyInsert(lines: string[], lineRef: string, newContent: string): string[] {
  const ref = parseLineRef(lineRef);
  if (!ref) return lines;
  const index = ref.lineNumber - 1;
  const newLines = [...lines];
  const insertionLines = newContent.split('\n');
  newLines.splice(index, 0, ...insertionLines);
  return newLines;
}

function applyDelete(lines: string[], lineRef: string): string[] {
  const ref = parseLineRef(lineRef);
  if (!ref) return lines;
  const index = ref.lineNumber - 1;
  const newLines = [...lines];
  newLines.splice(index, 1);
  return newLines;
}

export function applyEdit(lines: string[], operation: EditOperation): { lines: string[]; result: DiffResult } {
  const verification = verifyEdit(lines, operation.lineRef);
  if (!verification.valid) {
    throw new Error(verification.reason ?? 'Edit verification failed');
  }

  let modifiedLines: string[];
  switch (operation.type) {
    case 'replace':
      modifiedLines = applyReplace(lines, operation.lineRef, operation.newContent);
      break;
    case 'insert':
      modifiedLines = applyInsert(lines, operation.lineRef, operation.newContent);
      break;
    case 'delete':
      modifiedLines = applyDelete(lines, operation.lineRef);
      break;
    default:
      throw new Error(`Unknown edit type: ${operation.type}`);
  }

  const changedLines: number[] = [];
  for (let i = 0; i < Math.max(lines.length, modifiedLines.length); i++) {
    if (lines[i] !== modifiedLines[i]) {
      changedLines.push(i + 1);
    }
  }

  return {
    lines: modifiedLines,
    result: { original: lines, modified: modifiedLines, changedLines },
  };
}

export async function executeEdit(
  app: App,
  operation: EditOperation
): Promise<DiffResult> {
  const lines = await readFileLines(app, operation.path);
  const { lines: newLines, result } = applyEdit(lines, operation);
  await writeFileLines(app, operation.path, newLines);
  return result;
}

export async function executeBatchEdits(
  app: App,
  operations: EditOperation[]
): Promise<DiffResult[]> {
  const results: DiffResult[] = [];
  const sorted = [...operations].sort(
    (a, b) => (parseLineRef(b.lineRef)?.lineNumber ?? 0) - (parseLineRef(a.lineRef)?.lineNumber ?? 0)
  );

  let currentLines: string[] | null = null;
  let currentPath = '';
  const pending: EditOperation[] = [];

  for (const op of sorted) {
    if (op.path !== currentPath && pending.length > 0) {
      if (currentLines) {
        await writeFileLines(app, currentPath, currentLines);
      }
      pending.length = 0;
      currentLines = null;
    }

    if (!currentLines || op.path !== currentPath) {
      currentPath = op.path;
      currentLines = await readFileLines(app, currentPath);
    }

    const { lines: modified, result } = applyEdit(currentLines, op);
    currentLines = modified;
    pending.push(op);
    results.push(result);
  }

  if (currentPath && currentLines) {
    await writeFileLines(app, currentPath, currentLines);
  }

  return results;
}

export function formatDiff(result: DiffResult): string {
  const lines: string[] = [];
  for (const lineNum of result.changedLines) {
    const origLine = result.original[lineNum - 1] ?? '';
    const newLine = result.modified[lineNum - 1] ?? '';
    if (origLine !== newLine) {
      if (newLine === undefined) {
        lines.push(`- L${lineNum}: ${origLine}`);
      } else if (origLine === undefined) {
        lines.push(`+ L${lineNum}: ${newLine}`);
      } else {
        lines.push(`- L${lineNum}: ${origLine}`);
        lines.push(`+ L${lineNum}: ${newLine}`);
      }
    }
  }
  return lines.join('\n');
}
