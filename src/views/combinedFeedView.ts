import { ItemView, WorkspaceLeaf, App, Setting, ButtonComponent, Notice, ExtraButtonComponent } from 'obsidian';
import AIPlugin from '../main';
import { parseFeed, ParsedFeed, ParsedFeedEntry } from '../parsing/feedParsing';
import { getFaviconUrl } from '../utils/utils';

export const VIEW_TYPE_COMBINED_FEED = 'AI_COMBINED_FEED_VIEW';

export class CombinedFeedView extends ItemView {
    plugin: AIPlugin;
    private allEntries: ParsedFeedEntry[] = []; 
    private displayedEntries: ParsedFeedEntry[] = []; 
    private entriesContainer: HTMLElement | undefined; 
    private loadingIndicator: HTMLElement | undefined; 
    private sortButton: ExtraButtonComponent | undefined; 
    private currentSort: 'newestFirst' | 'oldestFirst' | null = 'newestFirst'; 

    constructor(leaf: WorkspaceLeaf, plugin: AIPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.icon = 'list-end'; 
    }

    getViewType(): string {
        return VIEW_TYPE_COMBINED_FEED;
    }

    getDisplayText(): string {
        return 'All Saved Feeds';
    }

    
    async setState(state: SafeAny, result: SafeAny): Promise<void> {
        
        await super.setState(state, result);
        
    }

    getState(): SafeAny {
        
        return super.getState();
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('combined-feed-view-container');

        
         const headerActions = container.createDiv({ cls: 'view-header-actions' });

        
        new ExtraButtonComponent(headerActions)
             .setIcon('refresh-ccw') 
             .setTooltip('Refresh feeds')
             .onClick(() => this.fetchAndRenderCombinedFeeds());

        
        this.sortButton = new ExtraButtonComponent(headerActions)
             .setIcon('sort-desc') 
             .setTooltip('Sort by date (Newest First)')
             .onClick(() => this.toggleSortOrder());

        
        this.loadingIndicator = container.createEl('p', {
            text: 'Loading feeds...',
            cls: 'loading-indicator'
        });

        
        this.entriesContainer = container.createDiv({ cls: 'combined-entries-list' });

        
        this.fetchAndRenderCombinedFeeds();
    }

    
    private async fetchAndRenderCombinedFeeds(): Promise<void> {
        if (this.loadingIndicator) {
            this.loadingIndicator.setCssProps({ 'display':  'block' }); 
            this.entriesContainer?.empty(); 
        }

        const savedFeeds = this.plugin.settings.savedFeeds;
        this.allEntries = []; 

        if (savedFeeds.length === 0) {
            this.allEntries = [];
        } else {
            
            const enabledFeeds = savedFeeds.filter(feed => feed.enabled !== false);
            if (enabledFeeds.length === 0) {
                this.allEntries = [];
            } else {
                const fetchPromises = enabledFeeds.map(feed => parseFeed(feed.url, feed.name));
                const results = await Promise.all(fetchPromises);

                
                results.forEach(feedData => {
                    if (feedData && feedData.entries) {
                        this.allEntries.push(...feedData.entries);
                    }
                });
            }
        }

        if (this.loadingIndicator) {
             this.loadingIndicator.setCssProps({ 'display':  'none' }); 
        }

        
        this.sortEntries(this.currentSort);
        this.renderEntries();
    }

    
    private sortEntries(order: 'newestFirst' | 'oldestFirst' | null): void {
        if (!order || this.allEntries.length === 0) {
            this.displayedEntries = [...this.allEntries]; 
            return;
        }

        
        this.displayedEntries = [...this.allEntries].sort((a, b) => {
             const dateA = a.pubDate ? new Date(a.pubDate).getTime() : 0; 
             const dateB = b.pubDate ? new Date(b.pubDate).getTime() : 0;

             if (order === 'newestFirst') {
                 return dateB - dateA; 
             } else { 
                 return dateA - dateB; 
             }
        });
    }

    
    private toggleSortOrder(): void {
        if (this.currentSort === 'newestFirst') {
            this.currentSort = 'oldestFirst';
             this.sortButton?.setIcon('sort-asc').setTooltip('Sort by date (Oldest First)'); 
        } else {
            this.currentSort = 'newestFirst';
            this.sortButton?.setIcon('sort-desc').setTooltip('Sort by date (Newest First)'); 
        }
        this.sortEntries(this.currentSort);
        this.renderEntries();
    }

    
    private renderEntries(): void {
        if (!this.entriesContainer) {
                          return;
        }

        this.entriesContainer.empty(); 

        if (!this.displayedEntries || this.displayedEntries.length === 0) {
             this.entriesContainer.createEl('p', { text: 'No entries found from saved feeds.', cls: 'no-entries-message' });
             return;
        }

        this.displayedEntries.forEach(entry => {
            const card = this.entriesContainer!.createDiv({ cls: 'feed-entry-card' });

            
            if (entry.feedName) {
                const savedFeed = this.plugin.settings.savedFeeds.find(f => f.name === entry.feedName);
                if (savedFeed && savedFeed.folderId) {
                    const folder = this.plugin.settings.feedFolders.find(f => f.id === savedFeed.folderId);
                    if (folder && folder.color) {
                        card.style.setProperty('--card-folder-color', folder.color);
                    }
                }
            }

            

             
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
            
            if (entry.link && this.plugin.isEntryVisited(entry.link)) {
                 titleEl.addClass('visited-entry-title');
            }

            
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
                           titleEl.addClass('visited-entry-title');
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

            
            const bookmarkButton = new ExtraButtonComponent(actionsContainer)
                .setIcon(this.plugin.isEntryBookmarked(entry) ? 'bookmark-check' : 'bookmark') 
                .setTooltip(this.plugin.isEntryBookmarked(entry) ? 'Remove bookmark' : 'Bookmark this entry'); 

            bookmarkButton.onClick(() => {
                if (this.plugin.isEntryBookmarked(entry)) {
                    this.plugin.removeBookmark(entry);
                } else {
                    this.plugin.addBookmark(entry);
                }
                
                bookmarkButton.setIcon(this.plugin.isEntryBookmarked(entry) ? 'bookmark-check' : 'bookmark')
                              .setTooltip(this.plugin.isEntryBookmarked(entry) ? 'Remove bookmark' : 'Bookmark this entry');
            });
            

        });
    }

    async onClose() {
        
    }
}
