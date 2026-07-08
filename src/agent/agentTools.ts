import { normalizePath, TFile, TFolder, type App } from 'obsidian';
import type { AgentDependencies } from './types';
import type { ToolHandler } from './toolRegistry';
import { replaceContent, applyMultiEdit, type MultiEditOp } from './editEngine';

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
  return app.vault.read(file);
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

async function searchContent(deps: AgentDependencies, query: string, limit: number): Promise<string> {
  const results = await deps.searchVaultBM25(query, limit);
  const matched = results.map(r => ({
    path: r.path,
    content: r.content,
  }));
  console.log('[NexusAgent::search_vault] BM25 search:', {
    query,
    limit,
    resultCount: results.length,
    paths: results.map(r => r.path),
    contentLengths: results.map(r => r.content.length),
  });
  return JSON.stringify(matched);
}

function createNote(app: App, path: string, content: string): Promise<string> {
  const normalized = normalizePath(path);
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
      description: 'Read file content from the vault. Supports full content, line range (offset/limit), or anchor-based context reading.',
      category: 'vault-native',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative file path' },
          offset: { type: 'number', description: 'Line number to start from (1-indexed). When set, returns only the specified range with line numbers.' },
          limit: { type: 'number', description: 'Maximum number of lines to return (used with offset). Default: 2000 when offset is set.' },
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

      const offset = args.offset !== undefined ? Number(args.offset) : 0;
      if (offset > 0) {
        const limit = Number(args.limit ?? 2000);
        const ranged = readLineRange(content, offset, limit);
        const result: FileReadResult & { totalLines: number } = {
          path, content: ranged, lineCount: Math.min(limit, allLines.length - offset + 1), totalLines: allLines.length
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
      description: 'Search vault files by keyword in headings, content, tags, and frontmatter. Returns matched file paths with relevant content passages.',
      category: 'vault-native',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results', default: 10 },
        },
        required: ['query'],
      },
      needsApproval: false,
    },
    execute: async (args: Record<string, unknown>, deps: AgentDependencies): Promise<string> => {
      const query = String(args.query ?? '');
      const limit = Number(args.limit ?? 10);
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
      description: 'Create a new note in the vault',
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
        return JSON.stringify({ path, error: result.error, matched: false, matchCount: result.matchCount });
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
          edits: { type: 'string', description: 'JSON array of edit operations. Each operation has: type ("replace"|"insert"|"delete"), oldString (for replace/delete), newString (for replace/insert), insertAt ("start"|"end"|"before"|"after"), anchor (for before/after insert). Example: [{"type":"replace","oldString":"old text","newString":"new text"}]' },
        },
        required: ['path', 'edits'],
      },
      needsApproval: true,
    },
    execute: async (args: Record<string, unknown>, deps: AgentDependencies): Promise<string> => {
      const path = String(args.path ?? '');
      let edits: MultiEditOp[];

      try {
        const parsed = JSON.parse(String(args.edits ?? '[]'));
        edits = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return JSON.stringify({ path, error: 'Invalid edits JSON. Must be a valid JSON array of edit operations.' });
      }

      if (edits.length === 0) {
        return JSON.stringify({ path, error: 'No edits provided.' });
      }

      const currentContent = await readFileContent(deps.app, path);
      const result = applyMultiEdit(currentContent, edits);

      if (!result.success || result.result === undefined) {
        return JSON.stringify({ path, error: result.error || 'multi_edit failed', steps: result.steps });
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

  return [readTool, searchTool, listTool, createTool, editTool, multiEditTool, backlinksTool, tagsTool];
}
