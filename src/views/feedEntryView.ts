import { ItemView, WorkspaceLeaf, App, Setting, ButtonComponent, Notice, ExtraButtonComponent } from 'obsidian';
import AIPlugin from '../main';
import { ParsedFeed, ParsedFeedEntry } from '../parsing/feedParsing'; 

export const VIEW_TYPE_NEXUS_FEED_ENTRIES = 'NEXUS_FEED_ENTRIES_VIEW';

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

    
    async setState(state: SafeAny, result: SafeAny): Promise<void> {
        
        if (state && state.feedData) {
            this.feedData = state.feedData as ParsedFeed;
            
             if (this.entriesContainer) { 
                 this.renderEntries();
             } else {
                 
                 
                              }

        } else {
            
            this.feedData = null;
             const container = this.containerEl.children[1] as HTMLElement; 
             container.empty(); 
             container.createEl('p', { text: 'No feed data loaded.', cls: 'no-entries-message' });
             container.setCssProps({ 'text-align':  'center' });
             container.setCssProps({ 'color':  'var(--text-muted)' });
        }
        await super.setState(state, result);
    }

    getState(): SafeAny {
        
        
        
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