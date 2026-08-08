export interface ReplaceResult {
  result: string;
  matched: boolean;
  matchCount: number;
  error?: string;
}

export interface MultiEditOp {
  type: 'replace' | 'insert' | 'delete';
  oldString?: string;
  newString?: string;
  insertAt?: 'start' | 'end' | 'before' | 'after';
  anchor?: string;
}

export interface MultiEditStep {
  success: boolean;
  error?: string;
}

export interface MultiEditResult {
  success: boolean;
  result?: string;
  steps?: MultiEditStep[];
  error?: string;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function findSimilarity(a: string, b: string): number {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1.0;
  const cost = levenshtein(normalizeNewlines(longer), normalizeNewlines(shorter));
  return 1.0 - cost / longer.length;
}

function levenshtein(a: string, b: string): number {
  const an = a.length;
  const bn = b.length;
  const matrix: number[] = [];
  for (let i = 0; i <= bn; i++) matrix[i] = i;
  for (let i = 1; i <= an; i++) {
    let prev = i;
    for (let j = 1; j <= bn; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(
        matrix[j] + 1,
        prev + 1,
        matrix[j - 1] + cost
      );
      matrix[j - 1] = prev;
      prev = val;
    }
    matrix[bn] = prev;
  }
  return matrix[bn];
}

function exactReplacer(text: string): string[] {
  return [text];
}

function lineTrimmedReplacer(text: string): string[] {
  const lines = text.split('\n');
  const trimmed = lines.map(l => l.trimEnd()).join('\n');
  if (trimmed === text) return [];
  return [trimmed];
}

function blockAnchorReplacer(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length < 3) return [];
  const firstLine = lines[0].trim();
  const lastLine = lines[lines.length - 1].trim();
  if (!firstLine || !lastLine) return [];
  return [`${firstLine}\n...\n${lastLine}`];
}

function whitespaceNormalizedReplacer(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized === text) return [];
  return [normalized];
}

function indentationFlexibleReplacer(text: string): string[] {
  const lines = text.split('\n');
  const trimmed = lines.map(l => l.trimStart()).join('\n');
  if (trimmed === text) return [];
  return [trimmed];
}

interface ReplacerCandidate {
  search: string;
  replacerName: string;
}

function collectCandidates(oldString: string): ReplacerCandidate[] {
  const seen = new Set<string>();
  const candidates: ReplacerCandidate[] = [];

  const tryAdd = (search: string, name: string) => {
    const key = normalizeNewlines(search);
    if (key && !seen.has(key)) {
      seen.add(key);
      candidates.push({ search: key, replacerName: name });
    }
  };

  for (const search of exactReplacer(oldString)) tryAdd(search, 'exact');
  for (const search of lineTrimmedReplacer(oldString)) tryAdd(search, 'lineTrimmed');
  for (const search of blockAnchorReplacer(oldString)) tryAdd(search, 'blockAnchor');
  for (const search of whitespaceNormalizedReplacer(oldString)) tryAdd(search, 'whitespaceNormalized');
  for (const search of indentationFlexibleReplacer(oldString)) tryAdd(search, 'indentationFlexible');

  return candidates;
}

function locateAll(content: string, search: string): number[] {
  const positions: number[] = [];
  const normalizedContent = normalizeNewlines(content);
  const normalizedSearch = normalizeNewlines(search);
  let pos = -1;
  while ((pos = normalizedContent.indexOf(normalizedSearch, pos + 1)) !== -1) {
    positions.push(pos);
  }
  return positions;
}

function extractContext(content: string, pos: number, length: number, radius: number = 40): string {
  const start = Math.max(0, pos - radius);
  const end = Math.min(content.length, pos + length + radius);
  const lines = normalizeNewlines(content).substring(start, end).split('\n');
  return lines.length > 6
    ? lines.slice(0, 3).join('\n') + '\n...\n' + lines.slice(-3).join('\n')
    : lines.join('\n');
}

export function replaceContent(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false
): ReplaceResult {
  if (!oldString) {
    return { result: content, matched: false, matchCount: 0, error: 'oldString must not be empty' };
  }
  if (oldString === newString) {
    return { result: content, matched: false, matchCount: 0, error: 'oldString and newString are identical' };
  }

  const normalizedContent = normalizeNewlines(content);
  const candidates = collectCandidates(oldString);
  let bestSimilarity = 0;
  let bestContext = '';

  for (const { search, replacerName } of candidates) {
    const positions = locateAll(normalizedContent, search);

    if (positions.length === 0) {
      const sim = findSimilarity(search, normalizedContent);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestContext = extractContext(normalizedContent, 0, Math.min(search.length, 100));
      }
      continue;
    }

    if (replaceAll) {
      const result = normalizedContent.replaceAll(search, newString);
      return { result, matched: true, matchCount: positions.length };
    }

    if (positions.length === 1) {
      const pos = positions[0];
      const result = normalizedContent.substring(0, pos) + newString + normalizedContent.substring(pos + search.length);
      return { result, matched: true, matchCount: 1 };
    }

    const contextLines = positions.map((p, idx) => {
      const ctx = extractContext(normalizedContent, p, search.length);
      return `  Match #${idx + 1} at position ${p}:\n${ctx}`;
    }).join('\n\n');

    return {
      result: content,
      matched: false,
      matchCount: positions.length,
      error: `Found ${positions.length} matches for oldString (replacer: ${replacerName}). Provide more surrounding context to disambiguate:\n${contextLines}`
    };
  }

  const suggestion = bestSimilarity > 0.3
    ? ` Closest match (${(bestSimilarity * 100).toFixed(0)}% similar):\n${bestContext}`
    : '';

  return {
    result: content,
    matched: false,
    matchCount: 0,
    error: `Could not find oldString in the file.${suggestion}`
  };
}

export function applyMultiEdit(content: string, edits: MultiEditOp[]): MultiEditResult {
  if (!edits || edits.length === 0) {
    return { success: false, error: 'No edits provided' };
  }

  const currentContent = normalizeNewlines(content);
  const steps: MultiEditStep[] = [];
  let workingContent = currentContent;

  const editableEdits = edits.map((edit, idx) => {
    if (edit.type === 'replace') {
      if (!edit.oldString) {
        steps[idx] = { success: false, error: 'replace operation requires oldString' };
        return null;
      }
      if (edit.newString === undefined) {
        steps[idx] = { success: false, error: 'replace operation requires newString' };
        return null;
      }
    } else if (edit.type === 'delete') {
      if (!edit.oldString) {
        steps[idx] = { success: false, error: 'delete operation requires oldString' };
        return null;
      }
    } else if (edit.type === 'insert') {
      if (edit.newString === undefined) {
        steps[idx] = { success: false, error: 'insert operation requires newString' };
        return null;
      }
    }
    return edit;
  });

  for (let i = 0; i < edits.length; i++) {
    const edit = editableEdits[i];
    if (!edit) continue;

    if (edit.type === 'replace') {
      const result = replaceContent(workingContent, edit.oldString!, edit.newString!, false);
      if (result.matched) {
        workingContent = result.result;
        steps[i] = { success: true };
      } else {
        steps[i] = { success: false, error: result.error || 'replace failed' };
        return { success: false, result: content, steps, error: `Edit #${i + 1} (replace) failed: ${result.error}` };
      }
    } else if (edit.type === 'delete') {
      const result = replaceContent(workingContent, edit.oldString!, '', false);
      if (result.matched) {
        workingContent = result.result;
        steps[i] = { success: true };
      } else {
        steps[i] = { success: false, error: result.error || 'delete failed' };
        return { success: false, result: content, steps, error: `Edit #${i + 1} (delete) failed: ${result.error}` };
      }
    } else if (edit.type === 'insert') {
      const insertAt = edit.insertAt || 'end';
      const anchor = edit.anchor;
      const newContent = edit.newString!;

      if (insertAt === 'start') {
        workingContent = newContent + (workingContent.startsWith('\n') ? '' : '\n') + workingContent;
        steps[i] = { success: true };
      } else if (insertAt === 'end') {
        workingContent = workingContent + (workingContent.endsWith('\n') ? '' : '\n') + newContent;
        steps[i] = { success: true };
      } else if ((insertAt === 'before' || insertAt === 'after') && anchor) {
        const anchorPos = workingContent.indexOf(anchor);
        if (anchorPos === -1) {
          steps[i] = { success: false, error: `Anchor text not found: "${anchor.substring(0, 80)}"` };
          return { success: false, result: content, steps, error: `Edit #${i + 1} (insert) failed: anchor not found` };
        }
        if (insertAt === 'before') {
          workingContent = workingContent.substring(0, anchorPos) + newContent + '\n' + workingContent.substring(anchorPos);
        } else {
          const afterPos = anchorPos + anchor.length;
          workingContent = workingContent.substring(0, afterPos) + '\n' + newContent + workingContent.substring(afterPos);
        }
        steps[i] = { success: true };
      } else {
        steps[i] = { success: false, error: 'insert requires insertAt and anchor for before/after mode' };
        return { success: false, result: content, steps, error: `Edit #${i + 1} (insert) failed: missing parameters` };
      }
    }
  }

  return { success: true, result: workingContent, steps };
}

/**
 * Compute a line-level diff between original and modified content using LCS.
 * Preserves line ordering and produces an interleaved diff with added/removed lines.
 */
export function computeLineDiff(
  origLines: string[],
  modLines: string[]
): { additions: number; removals: number; diffLines: Array<{ type: 'added' | 'removed'; content: string }> } {
  // Build LCS table
  const m = origLines.length;
  const n = modLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (origLines[i - 1] === modLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find diff
  const diffLines: Array<{ type: 'added' | 'removed'; content: string }> = [];
  let i = m, j = n;
  const temp: Array<{ type: 'added' | 'removed'; content: string }> = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origLines[i - 1] === modLines[j - 1]) {
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      temp.push({ type: 'added' as const, content: modLines[j - 1] });
      j--;
    } else {
      temp.push({ type: 'removed' as const, content: origLines[i - 1] });
      i--;
    }
  }

  // Reverse to get chronological order
  for (let k = temp.length - 1; k >= 0; k--) {
    diffLines.push(temp[k]);
  }

  // Collapse adjacent same-type lines
  const collapsed: Array<{ type: 'added' | 'removed'; content: string }> = [];
  for (const line of diffLines) {
    if (collapsed.length > 0 && collapsed[collapsed.length - 1].type === line.type) {
      collapsed[collapsed.length - 1].content += '\n' + line.content;
    } else {
      collapsed.push({ ...line });
    }
  }

  const removals = collapsed.filter(l => l.type === 'removed').length;
  const additions = collapsed.filter(l => l.type === 'added').length;

  return { additions, removals, diffLines: collapsed };
}
