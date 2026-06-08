import { ItemView, WorkspaceLeaf, App, ButtonComponent, Notice, ExtraButtonComponent } from 'obsidian';
import AIPlugin from '../main';
import { ParsedFeedEntry } from '../parsing/feedParsing';
import { getFaviconUrl } from '../utils/utils';

export const VIEW_TYPE_BOOKMARKS = 'AI_BOOKMARKS_VIEW';

export class BookmarkView extends ItemView {
    plugin: AIPlugin;
    private entriesContainer: HTMLElement | undefined;

    constructor(leaf: WorkspaceLeaf, plugin: AIPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.icon = 'bookmark'; 
    }

    getViewType(): string {
        return VIEW_TYPE_BOOKMARKS;
    }

    getDisplayText(): string {
        return 'Bookmarks';
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('bookmark-view-container');

        container.createEl('h2', { text: 'Your Bookmarked Entries' });

        this.entriesContainer = container.createDiv({ cls: 'bookmark-entries-list' });

        this.renderBookmarkedEntries();
    }

    private renderBookmarkedEntries(): void {
        if (!this.entriesContainer) {
                        return;
        }

        this.entriesContainer.empty();

        const bookmarkedEntries = this.plugin.settings.bookmarkedEntries;

        if (!bookmarkedEntries || bookmarkedEntries.length === 0) {
            this.entriesContainer.createEl('p', { text: 'No bookmarked entries yet. Bookmark items from your feeds to see them here.', cls: 'no-entries-message' });
            return;
        }

        bookmarkedEntries.forEach(entry => {
            const card = this.entriesContainer!.createDiv({ cls: 'feed-entry-card' });

            

            
            const thumbnailContainer = card.createDiv({ cls: 'feed-entry-thumbnail' });
            if (entry.thumbnail) {
                try {
                    new URL(entry.thumbnail);
                    thumbnailContainer.createEl('img', {
                        attr: { src: entry.thumbnail, alt: entry.title || 'Feed entry thumbnail' }
                    });
                } catch (e) {
                                        thumbnailContainer.createDiv({ text: entry.contentSnippet || 'No description available.', cls: 'feed-entry-description-placeholder' });
                }
            } else {
                thumbnailContainer.createDiv({ text: entry.contentSnippet || 'No description available.', cls: 'feed-entry-description-placeholder' });
            }

            const content = card.createDiv({ cls: 'feed-entry-content' });

            
            const titleEl = content.createEl('h3', { text: entry.title || 'No Title' });
            

            
            const metadataLine = content.createDiv({ cls: 'entry-metadata-line' });
            
            if (entry.author) {
                metadataLine.createEl('span', { text: entry.author, cls: 'entry-author' });
            }

            if (entry.pubDate) {
                try {
                    const date = new Date(entry.pubDate);
                    if (!isNaN(date.getTime())) {
                        metadataLine.createEl('span', { 
                            text: date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }), 
                            cls: 'entry-date' 
                        });
                    }
                } catch (e) {
                                    }
            } else if (!entry.author) {
                metadataLine.createEl('span', { text: 'No Date', cls: 'entry-date' });
            }

            
            if (entry.link) {
                const linkContainer = content.createDiv({ cls: 'entry-link' });
                linkContainer.createEl('a', {
                    text: 'Read More...', 
                    href: entry.link,
                    attr: { target: '_blank', rel: 'noopener noreferrer' }
                }).onClickEvent((event) => {
                    
                    if (entry.link) {
                        this.plugin.markEntryVisited(entry.link);
                    }
                });
            } else {
                content.createEl('p', { text: 'No link available.', cls: 'entry-link entry-link-missing' });
            }

            
            
            const actionsContainer = content.createDiv({ cls: 'entry-actions' });

            
            if (entry.feedName) {
                const feedNameEl = actionsContainer.createEl('p', { cls: 'entry-feed-name' });
                
                
                if (entry.link) {
                    const faviconUrl = getFaviconUrl(entry.link);
                    if (faviconUrl) {
                        feedNameEl.createEl('img', { 
                            attr: { src: faviconUrl, alt: 'Source logo' },
                            cls: 'entry-feed-logo'
                        });
                    }
                }
                
                feedNameEl.createEl('strong', { text: entry.feedName });
            }

            
            new ExtraButtonComponent(actionsContainer)
                .setIcon('bookmark-x') 
                .setTooltip('Remove bookmark')
                .onClick(async () => {
                    if (confirm(`Are you sure you want to remove "${entry.title || 'this entry'}" from bookmarks?`)) {
                        this.plugin.removeBookmark(entry);
                        new Notice('Bookmark removed!');
                        this.renderBookmarkedEntries(); 
                    }
                });

            
        });
    }

    async onClose() {
        
    }
} 