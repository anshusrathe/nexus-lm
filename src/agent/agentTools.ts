import { normalizePath, TFile, TFolder, type App } from 'obsidian';
import type { AgentDependencies } from './types';
import type { ToolHandler } from './toolRegistry';
import { replaceContent, applyMultiEdit, type MultiEditOp } from './editEngine';
import { extractTextFromFile } from '../utils/localFileExtractor';

interface FileReadResult {
  path: string;
  content: string;
  lineCount: number;
}

interface FileListEntry {
  path: string;
  basename: string;
  extension: string;
  isFolder: boolean;
}

function readFileContent(app: App, path: string): Promise<string> {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFile)) {
    return Promise.reject(new Error(`File not found: ${path}`));
  }
  return extractTextFromFile(app, file);
}

function listVaultFiles(app: App, folderPath: string): FileListEntry[] {
  const folder = app.vault.getAbstractFileByPath(normalizePath(folderPath));
  const children = folder instanceof TFolder ? folder.children : app.vault.getRoot().children;
  const results: FileListEntry[] = [];
  for (const child of children) {
    results.push({
      path: child.path,
      basename: child instanceof TFile ? child.basename : child.name,
      extension: child instanceof TFile ? child.extension : '',
      isFolder: child instanceof TFolder,
    });
  }
  return results;
}

interface RecentFileEntry {
  path: string;
  basename: string;
  extension: string;
  lastModified: string;
  lastModifiedMs: number;
  created: string;
  sizeBytes: number;
}

function listRecentFiles(app: App, days: number, folderPath: string, limit: number): RecentFileEntry[] {
  const effectiveDays = Math.max(1, days);
  const cutoffMs = Date.now() - (effectiveDays * 24 * 60 * 60 * 1000);
  const normalizedFolder = folderPath && folderPath !== '/' ? normalizePath(folderPath) : '';
  const allFiles = app.vault.getFiles();
  const matched: RecentFileEntry[] = [];

  for (const file of allFiles) {
    if (normalizedFolder && !file.path.startsWith(normalizedFolder)) {
      continue;
    }
    const mtime = file.stat.mtime;
    if (mtime >= cutoffMs) {
      matched.push({
        path: file.path,
        basename: file.basename,
        extension: file.extension,
        lastModified: new Date(mtime).toISOString(),
        lastModifiedMs: mtime,
        created: new Date(file.stat.ctime).toISOString(),
        sizeBytes: file.stat.size,
      });
    }
  }

  matched.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
  const effectiveLimit = Math.min(50, Math.max(1, limit));
  return matched.slice(0, effectiveLimit);
}

async function searchContent(deps: AgentDependencies, query: string, limit: number): Promise<string> {
  const effectiveLimit = Math.min(15, Math.max(1, limit));
  const results = await deps.searchVaultBM25(query, effectiveLimit);
  const matched = results.map(r => {
    let rawText = r.content;
    if (rawText.length > 1500) {
      rawText = rawText.substring(0, 1500) + '\n... [snippet truncated]';
    }
    let formattedContent = rawText;
    if (r.lineStart !== undefined && r.lineStart > 0) {
      const lines = rawText.split('\n');
      formattedContent = lines.map((line, i) => `${r.lineStart! + i}: ${line}`).join('\n');
    }
    return {
      path: r.path,
      score: r.similarity !== undefined ? Number(r.similarity.toFixed(2)) : undefined,
      startLine: r.lineStart,
      endLine: r.lineEnd,
      content: formattedContent,
    };
  });

  // Hard-cap total JSON output to max 6,000 characters to prevent LLM context flood
  while (matched.length > 1 && JSON.stringify(matched).length > 6000) {
    matched.pop(); // Remove lower-scoring matches
  }

  const output = JSON.stringify(matched);
  console.log('[NexusAgent::search_vault] BM25 search:', {
    query,
    limit,
    resultCount: matched.length,
    totalOutputLength: output.length,
    paths: matched.map(m => m.path),
  });
  console.log('[NexusAgent::search_vault] Agent received result content:', matched);
  return output;
}

async function getOutline(app: App, path: string): Promise<string> {
  const normalized = normalizePath(path);
  const file = app.vault.getAbstractFileByPath(normalized);
  if (!(file instanceof TFile)) {
    return JSON.stringify({ error: `File not found: ${path}` });
  }
  const content = await app.vault.read(file);
  const lines = content.split('\n');
  const outline: Array<{ line: number; level: number; heading: string }> = [];
  lines.forEach((lineText, idx) => {
    const match = lineText.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      outline.push({
        line: idx + 1,
        level: match[1].length,
        heading: match[2].trim()
      });
    }
  });
  return JSON.stringify({ path: normalized, outline, totalLines: lines.length });
}

async function grepVault(deps: AgentDependencies, query: string, targetPath?: string, caseSensitive: boolean = false): Promise<string> {
  if (!query || query.trim() === '') {
    return JSON.stringify({ error: 'Query parameter is required' });
  }

  const flags = caseSensitive ? 'g' : 'gi';
  let regex: RegExp;
  try {
    regex = new RegExp(query, flags);
  } catch {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(escaped, flags);
  }

  let filesToSearch: TFile[] = [];
  if (targetPath && targetPath !== '/' && targetPath !== '') {
    const normalized = normalizePath(targetPath);
    const item = deps.app.vault.getAbstractFileByPath(normalized);
    if (item instanceof TFile) {
      filesToSearch = [item];
    } else {
      filesToSearch = deps.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(normalized));
    }
  } else {
    filesToSearch = deps.app.vault.getMarkdownFiles();
  }

  const matches: Array<{ path: string; line: number; content: string }> = [];
  const maxTotalMatches = 50;

  for (const file of filesToSearch) {
    if (matches.length >= maxTotalMatches) break;
    try {
      const content = await deps.app.vault.read(file);
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          matches.push({
            path: file.path,
            line: i + 1,
            content: lines[i].substring(0, 300)
          });
          if (matches.length >= maxTotalMatches) break;
        }
      }
    } catch {
      // ignore
    }
  }

  return JSON.stringify({ query, matchCount: matches.length, matches });
}

function createNote(app: App, path: string, content: string): Promise<string> {
  const normalized = normalizePath(path);
  const folder = normalized.substring(0, normalized.lastIndexOf('/'));
  if (folder) {
    const existing = app.vault.getAbstractFileByPath(folder);
    if (!existing) {
      app.vault.createFolder(folder);
    }
  }
  return app.vault.create(normalized, content).then((file) => file.path);
}

function modifyNote(app: App, path: string, content: string): Promise<string> {
  const normalized = normalizePath(path);
  const file = app.vault.getAbstractFileByPath(normalized);
  if (!(file instanceof TFile)) {
    return Promise.reject(new Error(`File not found: ${path}`));
  }
  return app.vault.modify(file, content).then(() => path);
}

function getBacklinks(app: App, path: string): string {
  const resolvedCache = app.metadataCache.getCache(path);
  const links = resolvedCache?.links ?? [];
  return JSON.stringify(links.map((l) => ({ link: l.link, position: l.position })));
}

function getTags(app: App): string {
  const files = app.vault.getMarkdownFiles();
  const tagCounts: Record<string, number> = {};
  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;
    const tags = cache.tags ?? [];
    for (const tag of tags) {
      const tagName = tag.tag.replace(/^#/, '');
      tagCounts[tagName] = (tagCounts[tagName] ?? 0) + 1;
    }
  }
  return JSON.stringify(tagCounts);
}

function readLineRange(content: string, offset: number, limit: number): string {
  const lines = content.split('\n');
  const startIdx = Math.max(0, offset - 1);
  const endIdx = Math.min(lines.length, startIdx + limit);
  const selected = lines.slice(startIdx, endIdx);
  return selected.map((line, i) => `${startIdx + i + 1}: ${line}`).join('\n');
}

function readByAnchor(content: string, anchor: string, contextLines: number): string {
  const lines = content.split('\n');
  const lowerAnchor = anchor.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(lowerAnchor)) {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length, i + contextLines + 1);
      const selected = lines.slice(start, end);
      return selected.map((line, idx) => `${start + idx + 1}: ${line}`).join('\n');
    }
  }
  return '';
}

export function createVaultNativeTools(): ToolHandler[] {
  const readTool: ToolHandler = {
    definition: {
      name: 'read_file',
      description: 'Read file content from the vault. Supports reading exact line ranges (startLine/endLine or offset/limit), full content, or anchor-based context reading.',
      category: 'vault-native',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative file path' },
          startLine: { type: 'number', description: 'Line number to start reading from (1-indexed). Pass startLine from search_vault.' },
          endLine: { type: 'number', description: 'Line number to end reading at (1-indexed). Pass endLine from search_vault.' },
          offset: { type: 'number', description: 'Deprecated alias for startLine (1-indexed line number to start from).' },
          limit: { type: 'number', description: 'Maximum number of lines to return. Automatically calculated if endLine is provided.' },
          anchor: { type: 'string', description: 'Text to search for. Returns surrounding context with line numbers.' },
          contextLines: { type: 'number', description: 'Lines of context before and after the anchor match. Default: 5.' },
        },
        required: ['path'],
      },
      needsApproval: false,
    },
    execute: async (args: Record<string, unknown>, deps: AgentDependencies): Promise<string> => {
      const path = String(args.path ?? '');
      const content: string = await readFileContent(deps.app, path);
      const allLines = content.split('\n');

      const anchor = String(args.anchor ?? '');
      if (anchor) {
        const contextLines = Number(args.contextLines ?? 5);
        const anchored = readByAnchor(content, anchor, contextLines);
        if (anchored) {
          return JSON.stringify({ path, anchor, content: anchored, lineCount: allLines.length });
        }
        return JSON.stringify({ path, anchor, error: 'Anchor text not found', lineCount: allLines.length });
      }

      const startLine = args.startLine !== undefined
        ? Number(args.startLine)
        : (args.offset !== undefined ? Number(args.offset) : 0);

      const endLine = args.endLine !== undefined ? Number(args.endLine) : 0;

      if (startLine > 0) {
        let limit = Number(args.limit ?? 2000);
        if (endLine >= startLine) {
          limit = endLine - startLine + 1;
        }
        const ranged = readLineRange(content, startLine, limit);
        const result: FileReadResult & { totalLines: number; startLine: number; endLine: number } = {
          path,
          content: ranged,
          lineCount: Math.min(limit, allLines.length - startLine + 1),
          totalLines: allLines.length,
          startLine,
          endLine: Math.min(allLines.length, startLine + limit - 1),
        };
        return JSON.stringify(result);
      }

      const result: FileReadResult = { path, content, lineCount: allLines.length };
      return JSON.stringify(result);
    },
  };

  const searchTool: ToolHandler = {
    definition: {
      name: 'search_vault',
      description: 'Search vault files by keyword in headings, content, tags, and frontmatter. Returns top relevance-ranked passages with BM25 scores (score), line-numbered text, and startLine/endLine parameters. Prioritize high-scoring matches for reading via read_file(path, startLine, endLine).',
      category: 'vault-native',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max passage results to return (range 1–15, default: 5)', default: 5 },
        },
        required: ['query'],
      },
      needsApproval: false,
    },
    execute: async (args: Record<string, unknown>, deps: AgentDependencies): Promise<string> => {
      const query = String(args.query ?? '');
      const limit = Math.min(15, Math.max(1, Number(args.limit ?? 5)));
      return searchContent(deps, query, limit);
    },
  };

  const listTool: ToolHandler = {
    definition: {
      name: 'list_files',
      description: 'List files and folders in a vault directory',
      category: 'vault-native',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder path (default: root)', default: '/' },
        },
        required: [],
      },
      needsApproval: false,
    },
    execute: async (args: Record<string, unknown>, deps: AgentDependencies): Promise<string> => {
      const folderPath = String(args.path ?? '/');
      const entries = listVaultFiles(deps.app, folderPath);
      return JSON.stringify(entries);
    },
  };

  const createTool: ToolHandler = {
    definition: {
      name: 'create_note',
      description: 'Create a new note in the vault. Parent folders are created automatically if they do not exist.',
      category: 'vault-native',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative path for the new note' },
          content: { type: 'string', description: 'Note content' },
        },
        required: ['path', 'content'],
      },
      needsApproval: true,
    },
    execute: async (args: Record<string, unknown>, deps: AgentDependencies): Promise<string> => {
      const path = String(args.path ?? '');
      const content = String(args.content ?? '');
      const createdPath: string = await createNote(deps.app, path, content);
      return JSON.stringify({ path: createdPath, action: 'created' });
    },
  };

  const editTool: ToolHandler = {
    definition: {
      name: 'edit_note',
      description: 'Edit a note using precision search/replace. Finds the exact oldString in the file and replaces it with newString. The file outside the replaced text is never touched. For appending content, use insertAt="end".',
      category: 'vault-native',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative file path' },
          oldString: { type: 'string', description: 'Exact text to find in the file. Must match the existing content including whitespace and indentation.' },
          newString: { type: 'string', description: 'Replacement text' },
          replaceAll: { type: 'boolean', description: 'Replace all occurrences instead of just the first one. Default: false.' },
          insertAt: { type: 'string', description: 'Insert mode: "start" or "end" to add content without replacing. When set, oldString is ignored.' },
        },
        required: ['path', 'newString'],
      },
      needsApproval: true,
    },
    execute: async (args: Record<string, unknown>, deps: AgentDependencies): Promise<string> => {
      const path = String(args.path ?? '');
      const newString = String(args.newString ?? '');
      const oldString = String(args.oldString ?? '');
      const replaceAll = args.replaceAll === true;
      const insertAt = String(args.insertAt ?? '');

      const currentContent = await readFileContent(deps.app, path);

      if (insertAt === 'start' || insertAt === 'end') {
        const sep = insertAt === 'start'
          ? (currentContent.startsWith('\n') ? '' : '\n')
          : (currentContent.endsWith('\n') ? '' : '\n');
        const modified = insertAt === 'start'
          ? newString + sep + currentContent
          : currentContent + sep + newString;
        await modifyNote(deps.app, path, modified);
        return JSON.stringify({ path, action: 'modified', method: `insert_${insertAt}` });
      }

      const result = replaceContent(currentContent, oldString, newString, replaceAll);
      if (!result.matched) {
        throw new Error(`Edit failed: the oldString was not found in the file. ${result.error ?? 'No match for the provided text.'}`);
      }

      await modifyNote(deps.app, path, result.result);
      return JSON.stringify({ path, action: 'modified', method: 'precision_replace', matchCount: result.matchCount });
    },
  };

  const multiEditTool: ToolHandler = {
    definition: {
      name: 'multi_edit',
      description: 'Apply multiple edit operations to a file atomically. Supports replace, insert, and delete operations. All edits are applied in one pass; if any fails, none are written.',
      category: 'vault-native',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative file path' },
          edits: { type: 'string', description: 'Array of edit operations (JSON string or native array). Each operation has: type ("replace"|"insert"|"delete"), oldString (for replace/delete), newString (for replace/insert), insertAt ("start"|"end"|"before"|"after"), anchor (for before/after insert). Example: [{"type":"replace","oldString":"old text","newString":"new text"}]' },
        },
        required: ['path', 'edits'],
      },
      needsApproval: true,
    },
    execute: async (args: Record<string, unknown>, deps: AgentDependencies): Promise<string> => {
      const path = String(args.path ?? '');
      let edits: MultiEditOp[];

      const rawEdits = args.edits;
      if (Array.isArray(rawEdits)) {
        edits = rawEdits;
      } else {
        try {
          const parsed = JSON.parse(String(rawEdits ?? '[]'));
          edits = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return JSON.stringify({ path, error: 'Invalid edits. Must be a JSON string or native array of edit operations.' });
        }
      }

      if (edits.length === 0) {
        return JSON.stringify({ path, error: 'No edits provided.' });
      }

      const currentContent = await readFileContent(deps.app, path);
      const result = applyMultiEdit(currentContent, edits);

      if (!result.success || result.result === undefined) {
        throw new Error(`Multi-edit failed: ${result.error ?? 'Unknown error'}`);
      }

      await modifyNote(deps.app, path, result.result);
      return JSON.stringify({ path, action: 'modified', method: 'multi_edit', editCount: edits.length, steps: result.steps });
    },
  };

  const backlinksTool: ToolHandler = {
    definition: {
      name: 'get_backlinks',
      description: 'Get backlinks for a file',
      category: 'vault-native',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Vault-relative file path' } },
        required: ['path'],
      },
      needsApproval: false,
    },
    execute: async (args: Record<string, unknown>, deps: AgentDependencies): Promise<string> => {
      const path = String(args.path ?? '');
      return getBacklinks(deps.app, path);
    },
  };

  const tagsTool: ToolHandler = {
    definition: {
      name: 'get_tags',
      description: 'Get all tags in the vault with counts',
      category: 'vault-native',
      inputSchema: { type: 'object', properties: {}, required: [] },
      needsApproval: false,
    },
    execute: async (_args: Record<string, unknown>, deps: AgentDependencies): Promise<string> => {
      return getTags(deps.app);
    },
  };

  const recentFilesTool: ToolHandler = {
    definition: {
      name: 'list_recent_files',
      description: 'List vault files created or modified within a specified time range (past N days) sorted by most recently modified first. Use this tool FIRST when answering open-ended temporal queries like "What did we do recently?", "What notes were updated this week?", or "Summarize recent work" where specific search keywords are unknown.',
      category: 'vault-native',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Number of past days to look back for modified files (default: 7)', default: 7 },
          folderPath: { type: 'string', description: 'Vault-relative folder path to filter by (default: root)', default: '/' },
          limit: { type: 'number', description: 'Max files to return (range 1–50, default: 20)', default: 20 },
        },
        required: [],
      },
      needsApproval: false,
    },
    execute: async (args: Record<string, unknown>, deps: AgentDependencies): Promise<string> => {
      const days = Number(args.days ?? 7);
      const folderPath = String(args.folderPath ?? '/');
      const limit = Number(args.limit ?? 20);
      const results = listRecentFiles(deps.app, days, folderPath, limit);
      return JSON.stringify(results);
    },
  };

  const outlineTool: ToolHandler = {
    definition: {
      name: 'get_outline',
      description: 'Extract Markdown headings (#, ##, ###) with exact line numbers from a file. Use this tool when working with large documents/notes to see section headings and jump directly to specific line ranges via read_file.',
      category: 'vault-native',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative file path' },
        },
        required: ['path'],
      },
      needsApproval: false,
    },
    execute: async (args: Record<string, unknown>, deps: AgentDependencies): Promise<string> => {
      const path = String(args.path ?? '');
      return getOutline(deps.app, path);
    },
  };

  const grepTool: ToolHandler = {
    definition: {
      name: 'grep_vault',
      description: 'Search vault files for exact string or regex pattern matches line-by-line. Returns matching file paths, line numbers, and line snippets. Use this tool for exact phrase matches, code symbols, section titles, or technical terms.',
      category: 'vault-native',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Exact text or regex pattern to search for' },
          path: { type: 'string', description: 'Vault-relative file or folder path to filter search scope (default: root)', default: '/' },
          caseSensitive: { type: 'boolean', description: 'Whether search is case-sensitive (default: false)', default: false },
        },
        required: ['query'],
      },
      needsApproval: false,
    },
    execute: async (args: Record<string, unknown>, deps: AgentDependencies): Promise<string> => {
      const query = String(args.query ?? '');
      const path = String(args.path ?? '/');
      const caseSensitive = Boolean(args.caseSensitive ?? false);
      return grepVault(deps, query, path, caseSensitive);
    },
  };

  return [readTool, searchTool, grepTool, outlineTool, listTool, recentFilesTool, createTool, editTool, multiEditTool, backlinksTool, tagsTool];
}
