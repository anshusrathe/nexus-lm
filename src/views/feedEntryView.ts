import { ItemView, WorkspaceLeaf, ExtraButtonComponent } from 'obsidian';
import AIPlugin from '../main';
import { ParsedFeed } from '../parsing/feedParsing';

export const VIEW_TYPE_NEXUS_FEED_ENTRIES = 'NEXUS_FEED_ENTRIES_VIEW';

interface FeedEntryViewState {
    feedData?: ParsedFeed;
}

export class FeedEntryView extends ItemView {
    plugin: AIPlugin;
    private feedData: ParsedFeed | null = null;
    private entriesContainer: HTMLElement | undefined; 

    constructor(leaf: WorkspaceLeaf, plugin: AIPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.icon = 'list'; 
    }

    getViewType(): string {
        return VIEW_TYPE_NEXUS_FEED_ENTRIES;
    }

    getDisplayText(): string {
        
        
        const title = this.feedData?.title || 'Feed Entries';
        return title.length > 30 ? title.substring(0, 30) + '...' : title;
    }

    
    async setState(state: Record<string, unknown>, result: import('obsidian').ViewStateResult): Promise<void> {
        const feedState = state as FeedEntryViewState;
        if (feedState && feedState.feedData) {
            this.feedData = feedState.feedData;
            
             if (this.entriesContainer) {
                 this.renderEntries();
             } else {
                 // Intentionally empty
             }

        } else {
            
            this.feedData = null;
             const container = this.containerEl.children[1] as HTMLElement; 
             container.empty(); 
             container.createEl('p', { text: 'No feed data loaded.', cls: 'no-entries-message' });
             container.addClass('nl-text-align-center');
             container.addClass('nl-color-var--text-muted');
        }
        await super.setState(state, result);
    }

    getState(): Record<string, unknown> {
        
        
        
        const state = super.getState();
        
        delete state.feedData;
        return state;
    }


    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1] as HTMLElement; 
        container.empty();
        container.addClass('feed-entries-view-container'); 

        
        this.entriesContainer = container.createDiv({ cls: 'feed-entries-list' });

        
        if (this.feedData) {
            this.renderEntries();
        } else {
            
            
            
            if (!this.entriesContainer.hasChildNodes()) { 
                this.entriesContainer.createEl('p', { text: 'Load a feed from the "Nexus Feed" view to see entries here.', cls: 'no-entries-message' });
                 
            }
        }
    }

    
    private renderEntries(): void {
        
        if (!this.entriesContainer) {
                          return; 
        }

        this.entriesContainer.empty(); 

        if (!this.feedData || !this.feedData.entries || this.feedData.entries.length === 0) {
            
            this.entriesContainer.createEl('p', { text: 'No entries found in this feed.', cls: 'no-entries-message' });
            
            return;
        }

        
        let feedColor = 'var(--background-secondary)';
        const savedFeed = this.plugin.settings.savedFeeds.find(f => 
            f.name === this.feedData?.title || 
            (this.feedData?.link && f.url === this.feedData.link)
        );
        if (savedFeed && savedFeed.folderId) {
            const folder = this.plugin.settings.feedFolders.find(f => f.id === savedFeed.folderId);
            if (folder && folder.color) {
                feedColor = folder.color;
            }
        }

        this.feedData.entries.forEach(entry => {
            const card = this.entriesContainer!.createDiv({ cls: 'feed-entry-card' }); 
            card.style.setProperty('--card-folder-color', feedColor);


            
            const thumbnailContainer = card.createDiv({ cls: 'feed-entry-thumbnail' });
            if (entry.thumbnail) {
                 
                 try {
                     new URL(entry.thumbnail); 
                     thumbnailContainer.createEl('img', {
                         attr: { src: entry.thumbnail, alt: entry.title || 'Feed entry thumbnail' }
                     });
                 } catch {
                      
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
                metadataLine.createSpan({ text: entry.author, cls: 'entry-author' });
            }

            if (entry.pubDate) {
                try {
                    const date = new Date(entry.pubDate);
                    if (!isNaN(date.getTime())) {
                        metadataLine.createSpan({ 
                            text: date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }), 
                            cls: 'entry-date' 
                        });
                    }
                } catch {
                  // Failed to parse - keep previous value
                }
            } else if (!entry.author) {
                
                metadataLine.createSpan({ text: 'No Date', cls: 'entry-date' });
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

            
            const bookmarkButton = new ExtraButtonComponent(actionsContainer)
                .setIcon(this.plugin.isEntryBookmarked(entry) ? 'bookmark-fill' : 'bookmark') 
                .setTooltip(this.plugin.isEntryBookmarked(entry) ? 'Remove bookmark' : 'Bookmark this entry'); 

            bookmarkButton.onClick(() => {
                if (this.plugin.isEntryBookmarked(entry)) {
                    this.plugin.removeBookmark(entry);
                } else {
                    this.plugin.addBookmark(entry);
                }
                
                bookmarkButton.setIcon(this.plugin.isEntryBookmarked(entry) ? 'bookmark-fill' : 'bookmark')
                              .setTooltip(this.plugin.isEntryBookmarked(entry) ? 'Remove bookmark' : 'Bookmark this entry');
            });
        });
    }

    async onClose() {
        
    }
}