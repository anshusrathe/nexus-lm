import { normalizePath, requestUrl, type App } from 'obsidian';
import type { ToolHandler } from './toolRegistry';

export interface FeedEntry {
  title: string;
  url: string;
  publishedDate: string;
  timestamp: number;
  author: string;
  snippet: string;
}

export interface SavedFeedItem {
  name: string;
  url: string;
  category?: string;
  color?: string;
  enabled?: boolean;
  folderId?: string;
}

const SAVED_FEEDS_DIR = '.Nexus-LM-data/saved-feeds';
const SAVED_FEEDS_FILE = '.Nexus-LM-data/saved-feeds/feeds.json';

const DEFAULT_FEEDS_JSON: SavedFeedItem[] = [
  { name: 'ArXiv AI Preprints', url: 'https://rss.arxiv.org/rss/cs.AI', category: 'Research', enabled: true, color: '#abcdef', folderId: 'general' },
  { name: 'Hacker News', url: 'https://news.ycombinator.com/rss', category: 'News', enabled: true, color: '#abcdef', folderId: 'general' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'Tech', enabled: true, color: '#abcdef', folderId: 'general' },
];

export async function syncSavedFeedsJson(
  app: App,
  savedFeeds: SavedFeedItem[]
): Promise<void> {
  try {
    const adapter = app.vault.adapter;
    const dirPath = normalizePath(SAVED_FEEDS_DIR);
    if (!(await adapter.exists(dirPath))) {
      await adapter.mkdir(dirPath);
    }
    const filePath = normalizePath(SAVED_FEEDS_FILE);
    const jsonContent = JSON.stringify(savedFeeds, null, 2);
    await adapter.write(filePath, jsonContent);
  } catch (err) {
    console.error('[syncSavedFeedsJson] Failed to sync feeds JSON:', err);
  }
}

async function ensureSavedFeedsJson(
  app: App,
  pluginFeeds?: SavedFeedItem[]
): Promise<{ filePath: string; feeds: SavedFeedItem[] }> {
  const adapter = app.vault.adapter;
  const dirPath = normalizePath(SAVED_FEEDS_DIR);
  if (!(await adapter.exists(dirPath))) {
    await adapter.mkdir(dirPath);
  }
  const filePath = normalizePath(SAVED_FEEDS_FILE);
  let feeds: SavedFeedItem[] = [];

  if (await adapter.exists(filePath)) {
    try {
      const content = await adapter.read(filePath);
      feeds = JSON.parse(content) as SavedFeedItem[];
      if (!Array.isArray(feeds)) {
        feeds = [];
      }
    } catch {
      feeds = [];
    }
  }

  if (feeds.length === 0) {
    feeds = pluginFeeds && pluginFeeds.length > 0 ? pluginFeeds : DEFAULT_FEEDS_JSON;
    await adapter.write(filePath, JSON.stringify(feeds, null, 2));
  }

  return { filePath, feeds };
}

export function createSavedFeedsTool(app: App, plugin?: any): ToolHandler {
  return {
    definition: {
      name: 'saved_feeds',
      description: 'SEARCH AND PROVIDE saved RSS/Atom feeds stored in vault data directory (.Nexus-LM-data/saved-feeds/feeds.json). Returns saved feed names, URLs, categories, and enabled statuses. Tool name: saved_feeds (underscore). Use this tool FIRST to find saved feed URLs.',
      category: 'plugin',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional keyword to search saved feed names, URLs, categories, or folder IDs.',
          },
          action: {
            type: 'string',
            enum: ['search', 'add'],
            default: 'search',
            description: "'search' to list/filter saved feeds, or 'add' to save a new feed to feeds.json.",
          },
          name: {
            type: 'string',
            description: 'Feed name (required when action is "add").',
          },
          url: {
            type: 'string',
            description: 'Feed URL (required when action is "add").',
          },
          category: {
            type: 'string',
            description: 'Optional category (e.g. "Research", "News") when action is "add".',
          },
        },
      },
      needsApproval: false,
    },
    execute: async (args, deps) => {
      deps.onEvent({
        type: 'tool_call',
        data: { toolName: 'saved_feeds', args },
        timestamp: Date.now(),
      });

      const action = String(args.action ?? 'search').toLowerCase();
      const query = String(args.query ?? '').toLowerCase().trim();
      const pluginFeeds = plugin?.settings?.savedFeeds as SavedFeedItem[] | undefined;
      const { filePath, feeds } = await ensureSavedFeedsJson(app, pluginFeeds);

      if (action === 'add') {
        const feedName = String(args.name ?? '').trim();
        const feedUrl = cleanUrl(String(args.url ?? ''));
        const category = String(args.category ?? 'General').trim();

        if (!feedName || !feedUrl) {
          return 'Error: Both "name" and "url" are required when adding a feed.';
        }
        if (!feedUrl.startsWith('http://') && !feedUrl.startsWith('https://')) {
          return `Error: Invalid feed URL "${feedUrl}". Must start with http:// or https://.`;
        }

        const newFeed: SavedFeedItem = {
          name: feedName,
          url: feedUrl,
          category,
          color: '#abcdef',
          enabled: true,
          folderId: 'general',
        };

        const existingIndex = feeds.findIndex((f) => f.url === feedUrl);
        if (existingIndex >= 0) {
          feeds[existingIndex] = { ...feeds[existingIndex], ...newFeed };
        } else {
          feeds.push(newFeed);
        }

        await syncSavedFeedsJson(app, feeds);

        if (plugin?.settings?.savedFeeds) {
          const pIndex = plugin.settings.savedFeeds.findIndex((f: any) => f.url === feedUrl);
          if (pIndex >= 0) {
            plugin.settings.savedFeeds[pIndex] = { ...plugin.settings.savedFeeds[pIndex], ...newFeed };
          } else {
            plugin.settings.savedFeeds.push({
              url: feedUrl,
              name: feedName,
              color: '#abcdef',
              enabled: true,
              folderId: 'general',
            });
          }
          if (typeof plugin.saveSettings === 'function') {
            await plugin.saveSettings();
          }
        }

        return `Successfully saved feed "${feedName}" (${feedUrl}) to ${filePath} and updated Feed View UI.\n\n` + JSON.stringify(newFeed, null, 2);
      }

      let resultFeeds = feeds;
      if (query) {
        resultFeeds = feeds.filter((f) => {
          const matchName = f.name.toLowerCase().includes(query);
          const matchUrl = f.url.toLowerCase().includes(query);
          const matchCat = (f.category || '').toLowerCase().includes(query);
          const matchFolder = (f.folderId || '').toLowerCase().includes(query);
          return matchName || matchUrl || matchCat || matchFolder;
        });
      }

      if (resultFeeds.length === 0) {
        return query
          ? `No saved feeds found matching "${query}" in ${filePath}. Total feeds in storage: ${feeds.length}.`
          : `No saved feeds currently stored in ${filePath}.`;
      }

      let output = `Saved Feeds from ${filePath} (${resultFeeds.length} feeds found):\n\n`;
      resultFeeds.forEach((f, idx) => {
        output += `[${idx + 1}] ${f.name}\n`;
        output += `    URL: ${f.url}\n`;
        output += `    Category: ${f.category || 'General'}\n\n`;
      });
      output += `JSON Data:\n` + JSON.stringify(resultFeeds, null, 2);
      return output;
    },
  };
}

export function createSearchFeedsTool(): ToolHandler {
  return {
    definition: {
      name: 'search_feeds',
      description: 'FETCH AND SEARCH entries from an RSS/Atom/JSON feed URL over network. Returns entry titles, URLs, published dates (ISO standardized), authors, and snippets. Allows filtering by keyword query, date range (startDate/endDate in YYYY-MM-DD), limit, and chronological sorting. Tool name: search_feeds (underscore).',
      category: 'plugin',
      inputSchema: {
        type: 'object',
        properties: {
          feedUrl: {
            type: 'string',
            description: 'Full RSS/Atom feed URL (e.g. https://rss.arxiv.org/rss/cs.AI).',
          },
          query: {
            type: 'string',
            description: 'Optional keyword query to filter entries by title or summary.',
          },
          startDate: {
            type: 'string',
            description: 'Optional start date filter (Format: YYYY-MM-DD). Entries published before this date are excluded.',
          },
          endDate: {
            type: 'string',
            description: 'Optional end date filter (Format: YYYY-MM-DD). Entries published after this date are excluded.',
          },
          limit: {
            type: 'number',
            default: 5,
            description: 'Maximum number of entries to return (1-20). Default 5.',
          },
          sort: {
            type: 'string',
            enum: ['desc', 'asc'],
            default: 'desc',
            description: "'desc' (newest first) or 'asc' (oldest first). Default 'desc'.",
          },
        },
        required: ['feedUrl'],
      },
      needsApproval: false,
    },
    execute: async (args, deps) => {
      deps.onEvent({
        type: 'tool_call',
        data: { toolName: 'search_feeds', args },
        timestamp: Date.now(),
      });

      const feedUrl = cleanUrl(String(args.feedUrl ?? ''));
      const query = String(args.query ?? '').toLowerCase().trim();
      const startDateStr = String(args.startDate ?? '').trim();
      const endDateStr = String(args.endDate ?? '').trim();
      const limit = Math.max(1, Math.min(20, Number(args.limit ?? 5)));
      const sort = String(args.sort ?? 'desc').toLowerCase();

      if (!feedUrl.startsWith('http://') && !feedUrl.startsWith('https://')) {
        return `Invalid feed URL "${feedUrl}". URL must start with http:// or https://.`;
      }

      let responseText = '';
      try {
        const response = await requestUrl({
          url: feedUrl,
          method: 'GET',
          headers: {
            'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml, application/json',
            'User-Agent': 'Mozilla/5.0 (Obsidian Feed Reader)',
          },
        });
        responseText = response.text;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Failed to fetch feed from ${feedUrl}: ${msg}`;
      }

      const entries = parseFeedEntries(responseText);

      if (entries.length === 0) {
        return `No entries could be parsed from feed URL: ${feedUrl}`;
      }

      let startTs = NaN;
      let endTs = NaN;
      if (startDateStr) {
        const d = new Date(startDateStr.includes('T') ? startDateStr : `${startDateStr}T00:00:00.000Z`);
        startTs = d.getTime();
      }
      if (endDateStr) {
        const d = new Date(endDateStr.includes('T') ? endDateStr : `${endDateStr}T23:59:59.999Z`);
        endTs = d.getTime();
      }

      let filtered = entries.filter((item) => {
        if (!isNaN(startTs) && item.timestamp > 0 && item.timestamp < startTs) {
          return false;
        }
        if (!isNaN(endTs) && item.timestamp > 0 && item.timestamp > endTs) {
          return false;
        }
        if (query) {
          const matchTitle = item.title.toLowerCase().includes(query);
          const matchSnippet = item.snippet.toLowerCase().includes(query);
          if (!matchTitle && !matchSnippet) return false;
        }
        return true;
      });

      filtered.sort((a, b) => {
        if (sort === 'asc') {
          return a.timestamp - b.timestamp;
        }
        return b.timestamp - a.timestamp;
      });

      filtered = filtered.slice(0, limit);

      if (filtered.length === 0) {
        return `No feed entries matched your filter criteria for "${feedUrl}". Total parsed entries: ${entries.length}.`;
      }

      let output = `Feed entries for "${feedUrl}" (${filtered.length} entries shown):\n\n`;
      filtered.forEach((entry, idx) => {
        output += `[${idx + 1}] ${entry.title}\n`;
        output += `    URL: ${entry.url}\n`;
        output += `    Date: ${entry.publishedDate}\n`;
        if (entry.author) output += `    Author: ${entry.author}\n`;
        if (entry.snippet) output += `    Excerpt: ${entry.snippet.slice(0, 300)}...\n`;
        output += `\n`;
      });
      output += `JSON Data:\n` + JSON.stringify(filtered, null, 2);
      return output;
    },
  };
}

export function createFeedTools(app: App, plugin?: any): ToolHandler[] {
  return [
    createSavedFeedsTool(app, plugin),
    createSearchFeedsTool(),
  ];
}

function cleanUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  let cleaned = rawUrl.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');
  cleaned = cleaned.replace(/<[^>]*>/g, '');
  return cleaned.trim().replace(/^[\s\r\n]+|[\s\r\n]+$/g, '');
}

function cleanText(rawText: string): string {
  if (!rawText) return '';
  let cleaned = rawText.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');
  cleaned = stripHtml(cleaned);
  return cleaned;
}

function parseFeedEntries(xmlOrJsonText: string): FeedEntry[] {
  const entries: FeedEntry[] = [];

  if (xmlOrJsonText.trim().startsWith('{')) {
    try {
      const parsedJson = JSON.parse(xmlOrJsonText) as Record<string, unknown>;
      if (Array.isArray(parsedJson.items)) {
        for (const item of parsedJson.items as Array<Record<string, unknown>>) {
          const title = cleanText(String(item.title ?? 'Untitled'));
          const url = cleanUrl(String(item.url ?? item.id ?? ''));
          const rawDate = String(item.date_published ?? item.date_modified ?? '');
          const dObj = rawDate ? new Date(rawDate) : null;
          const timestamp = dObj && !isNaN(dObj.getTime()) ? dObj.getTime() : 0;
          const publishedDate = dObj && !isNaN(dObj.getTime()) ? dObj.toISOString() : (rawDate || 'Unknown Date');
          const authorObj = item.author as Record<string, unknown> | undefined;
          const author = cleanText(typeof item.author === 'string' ? item.author : String(authorObj?.name ?? ''));
          const snippet = cleanText(String(item.summary ?? item.content_text ?? ''));

          if (title || url) {
            entries.push({ title, url, publishedDate, timestamp, author, snippet });
          }
        }
        return entries;
      }
    } catch {
      // Fallback to XML DOM parsing
    }
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlOrJsonText, 'text/xml');

    const atomEntries = doc.querySelectorAll('entry');
    if (atomEntries.length > 0) {
      atomEntries.forEach((el) => {
        const title = cleanText(el.querySelector('title')?.textContent || 'Untitled');
        const linkEl = el.querySelector('link[rel="alternate"]') || el.querySelector('link');
        const url = cleanUrl(linkEl?.getAttribute('href') || linkEl?.textContent || '');
        const rawDate = el.querySelector('published')?.textContent?.trim() ||
                        el.querySelector('updated')?.textContent?.trim() || '';
        const dObj = rawDate ? new Date(rawDate) : null;
        const timestamp = dObj && !isNaN(dObj.getTime()) ? dObj.getTime() : 0;
        const publishedDate = dObj && !isNaN(dObj.getTime()) ? dObj.toISOString() : (rawDate || 'Unknown Date');
        const author = cleanText(el.querySelector('author name')?.textContent ||
                                el.querySelector('author')?.textContent || '');
        const rawSummary = el.querySelector('summary')?.textContent ||
                           el.querySelector('content')?.textContent || '';
        const snippet = cleanText(rawSummary);

        entries.push({ title, url, publishedDate, timestamp, author, snippet });
      });
      return entries;
    }

    const rssItems = doc.querySelectorAll('item');
    rssItems.forEach((el) => {
      const title = cleanText(el.querySelector('title')?.textContent || 'Untitled');
      const url = cleanUrl(el.querySelector('link')?.textContent ||
                           el.querySelector('guid')?.textContent || '');
      const rawDate = el.querySelector('pubDate')?.textContent?.trim() ||
                      el.getElementsByTagName('dc:date')[0]?.textContent?.trim() ||
                      el.querySelector('date')?.textContent?.trim() || '';
      const dObj = rawDate ? new Date(rawDate) : null;
      const timestamp = dObj && !isNaN(dObj.getTime()) ? dObj.getTime() : 0;
      const publishedDate = dObj && !isNaN(dObj.getTime()) ? dObj.toISOString() : (rawDate || 'Unknown Date');
      const author = cleanText(el.getElementsByTagName('dc:creator')[0]?.textContent ||
                              el.querySelector('author')?.textContent ||
                              el.querySelector('managingEditor')?.textContent || '');
      const rawDesc = el.querySelector('description')?.textContent ||
                      el.getElementsByTagName('content:encoded')[0]?.textContent || '';
      const snippet = cleanText(rawDesc);

      entries.push({ title, url, publishedDate, timestamp, author, snippet });
    });
  } catch {
    // Return whatever entries were parsed
  }

  return entries;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
