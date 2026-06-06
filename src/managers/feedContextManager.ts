import { App, Modal, ButtonComponent, Notice } from 'obsidian';
import { AISettings } from '../settings';
import { parseFeed, ParsedFeedEntry } from '../parsing/feedParsing';

export interface FeedMeta {
  url: string;
  name: string;
  color?: string;
}

export class FeedSelectModal extends Modal {
  private feeds: FeedMeta[];
  private onDone: (feeds: FeedMeta[]) => void;
  private selectedFeeds: Set<string> = new Set();

  constructor(app: App, feeds: FeedMeta[], onDone: (feeds: FeedMeta[]) => void) {
    super(app);
    this.feeds = feeds;
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('session-select-modal');
    contentEl.createEl('h2', { text: 'Select Feed for Context' });

    this.feeds.forEach(feed => {
      const item = contentEl.createDiv({ cls: 'session-item' });
      const checkbox = item.createEl('input', { type: 'checkbox', value: feed.url });
      const label = item.createEl('label', { text: feed.name });
      checkbox.onchange = () => {
        if (checkbox.checked) this.selectedFeeds.add(feed.url);
        else this.selectedFeeds.delete(feed.url);
      };
      label.onclick = () => {
        checkbox.checked = !checkbox.checked;
        if (checkbox.checked) this.selectedFeeds.add(feed.url);
        else this.selectedFeeds.delete(feed.url);
      };
    });

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());
    new ButtonComponent(buttonContainer)
      .setButtonText('Done')
      .setCta()
      .onClick(() => {
        const selected = this.feeds.filter(f => this.selectedFeeds.has(f.url));
        this.onDone(selected);
        this.close();
      });
  }
}

export class FeedEntrySelectModal extends Modal {
  private entries: ParsedFeedEntry[];
  private onDone: (selectedUrls: string[]) => void;
  private onBack: () => void;
  private selectedUrls: Set<string> = new Set();
  private searchInputEl: HTMLInputElement | null = null;
  private entryItems: Array<{ entry: ParsedFeedEntry; itemEl: HTMLElement }> = [];

  constructor(app: App, entries: ParsedFeedEntry[], onDone: (selectedUrls: string[]) => void, onBack: () => void) {
    super(app);
    this.entries = entries;
    this.onDone = onDone;
    this.onBack = onBack;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('session-select-modal');
    contentEl.createEl('h2', { text: 'Select Feed Entries for Context' });

    // --- Search Bar ---
    const searchBarContainer = contentEl.createDiv({ cls: 'feed-entry-search-bar-container' });
    this.searchInputEl = searchBarContainer.createEl('input', {
      type: 'text',
      placeholder: 'Search entries by title...'
    });
    this.searchInputEl.addClass('feed-entry-search-input');
    this.searchInputEl.addEventListener('input', () => this.filterEntries());

    // --- SCROLLABLE ENTRIES LIST ---
    const entriesListContainer = contentEl.createDiv({ cls: 'feed-entries-scrollable-container' });
    this.entryItems = [];
    this.entries.forEach(entry => {
      if (!entry.title || !entry.link) return;
      const item = entriesListContainer.createDiv({ cls: 'feed-entry-card' });
      // Title
      const titleEl = item.createEl('div', { text: entry.title, cls: 'entry-title' });
      // Metadata Line (Author and Date)
      const metadataLine = item.createDiv({ cls: 'entry-metadata-line' });
      if (entry.author) {
        metadataLine.createEl('span', { text: entry.author, cls: 'entry-author' });
      }
      if (entry.pubDate) {
        metadataLine.createEl('span', { text: this.formatDate(entry.pubDate), cls: 'entry-date' });
      } else if (!entry.author) {
        metadataLine.createEl('span', { text: 'No Date', cls: 'entry-date' });
      }
      // Checkbox
      const checkbox = item.createEl('input', { type: 'checkbox', value: entry.link });
      checkbox.style.marginRight = '8px';
      checkbox.onchange = () => {
        if (checkbox.checked) this.selectedUrls.add(entry.link!);
        else this.selectedUrls.delete(entry.link!);
      };
      // Clicking the card toggles the checkbox
      item.onclick = (e) => {
        if ((e.target as HTMLElement).tagName !== 'INPUT') {
          checkbox.checked = !checkbox.checked;
          if (checkbox.checked) this.selectedUrls.add(entry.link!);
          else this.selectedUrls.delete(entry.link!);
        }
      };
      // Store for filtering
      this.entryItems.push({ entry, itemEl: item });
    });

    // --- BUTTON CONTAINER OUTSIDE SCROLL ---
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container feed-entry-modal-buttons' });
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => {
        this.close();
        this.onBack();
      });
    new ButtonComponent(buttonContainer)
      .setButtonText('Done')
      .setCta()
      .onClick(() => {
        this.onDone(Array.from(this.selectedUrls));
        this.close();
      });
  }

  filterEntries() {
    if (!this.searchInputEl) return;
    const query = this.searchInputEl.value.toLowerCase();
    this.entryItems.forEach(({ entry, itemEl }) => {
      const match = entry.title?.toLowerCase().includes(query);
      itemEl.style.display = match ? '' : 'none';
    });
  }

  // Helper to format date nicely
  private formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
}

// Fetches and returns all entry URLs from the given feed
export async function getFeedEntryUrls(feed: FeedMeta): Promise<string[]> {
  const parsed = await parseFeed(feed.url, feed.name);
  if (!parsed) {
    new Notice('Failed to fetch or parse the selected feed.');
    return [];
  }
  // Filter out entries without a valid link
  return parsed.entries.map(entry => entry.link).filter((url): url is string => !!url);
}

// Augments a user query with the feed entry URLs as context
export function augmentQueryWithFeedUrls(userQuery: string, entryUrls: string[]): string {
  if (!entryUrls.length) return userQuery;
  // You can adjust the format as needed for your context system
  return `${userQuery}\n[FEED_ENTRY_URLS]: ${entryUrls.join(' ')}`;
}

// Extracts the feed URL from a FeedMeta object
export function extractFeedUrl(feed: FeedMeta): string {
  return feed.url;
}

// Augments a user query with the feed URL as context
export function augmentQueryWithFeedUrl(userQuery: string, feedUrl: string): string {
  // You can adjust the format as needed for your context system
  return `${userQuery}\n[FEED_URL]: ${feedUrl}`;
}

export async function getFeedEntries(feed: FeedMeta): Promise<ParsedFeedEntry[]> {
  const parsed = await parseFeed(feed.url, feed.name);
  if (!parsed) return [];
  return parsed.entries.filter(e => !!e.title && !!e.link);
} 