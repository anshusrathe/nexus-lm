import { ItemView, WorkspaceLeaf, App, TextComponent, ButtonComponent, Setting, Notice, ExtraButtonComponent, Modal, Menu } from 'obsidian';
import AIPlugin from '../main'; 
import { parseFeed, ParsedFeed } from '../parsing/feedParsing'; 
import { VIEW_TYPE_NEXUS_FEED_ENTRIES } from './feedEntryView'; 

export const VIEW_TYPE_NEXUS_FEED = 'NEXUS_FEED_VIEW';

class FolderModal extends Modal {
    private name: string = '';
    private color: string = '#abcdef';
    private onSubmit: (name: string, color: string) => void;

    constructor(app: App, onSubmit: (name: string, color: string) => void, initialName = '', initialColor = '#abcdef') {
        super(app);
        this.onSubmit = onSubmit;
        this.name = initialName;
        this.color = initialColor;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: this.name ? 'Rename Folder' : 'Create New Folder' });

        new Setting(contentEl)
            .setName('Folder Name')
            .addText(text => text
                .setValue(this.name)
                .onChange(value => this.name = value));

        new Setting(contentEl)
            .setName('Folder Color')
            .addText(text => {
                text.inputEl.type = 'color';
                text.setValue(this.color)
                    .onChange(value => this.color = value);
            });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Submit')
                .setCta()
                .onClick(() => {
                    if (this.name.trim()) {
                        this.onSubmit(this.name.trim(), this.color);
                        this.close();
                    } else {
                        new Notice('Please enter a folder name.');
                    }
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class RenameModal extends Modal {
    private name: string;
    private onSubmit: (name: string) => void;

    constructor(app: App, initialName: string, onSubmit: (name: string) => void) {
        super(app);
        this.name = initialName;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Rename' });

        new Setting(contentEl)
            .setName('New Name')
            .addText(text => text
                .setValue(this.name)
                .onChange(value => this.name = value));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Rename')
                .setCta()
                .onClick(() => {
                    if (this.name.trim()) {
                        this.onSubmit(this.name.trim());
                        this.close();
                    } else {
                        new Notice('Please enter a name.');
                    }
                }));
    }

    onClose() {
        this.contentEl.empty();
    }
}

export class FeedView extends ItemView {
    plugin: AIPlugin;
    private feedUrlInput!: TextComponent;
    private feedNameInput!: TextComponent;
    private feedFolderSelection!: string;
    private savedFeedsContainer!: HTMLElement; 

    constructor(leaf: WorkspaceLeaf, plugin: AIPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.icon = 'rss'; 
        this.feedFolderSelection = this.plugin.settings.feedFolders[0]?.id || 'general';
    }

    getViewType(): string {
        return VIEW_TYPE_NEXUS_FEED;
    }

    getDisplayText(): string {
        return 'Nexus Feed';
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('feed-view-container');

        
        const addFeedSection = container.createDiv({ cls: 'feed-section add-new-feed' });
        addFeedSection.createEl('h2', { text: 'Add New Feed' });

        
        new Setting(addFeedSection)
            .setName('RSS Feed URL')
            .addText(text => {
                this.feedUrlInput = text; 
                text.setPlaceholder('Enter URL here...');
                
            });

        
        new Setting(addFeedSection)
            .setName('Feed Name')
            .addText(text => {
                this.feedNameInput = text; 
                text.setPlaceholder('Name your feed...');
                
            });

        
        new Setting(addFeedSection)
            .setName('Folder')
            .setDesc('Select the folder to save the feed in')
            .addDropdown(dropdown => {
                this.plugin.settings.feedFolders.forEach(folder => {
                    dropdown.addOption(folder.id, folder.name);
                });
                dropdown.setValue(this.feedFolderSelection);
                dropdown.onChange(value => {
                    this.feedFolderSelection = value;
                });
            });

        
        const addFeedButtons = addFeedSection.createDiv({ cls: 'feed-buttons' });

        
        new ButtonComponent(addFeedButtons)
            .setButtonText('Fetch')
            .setCta() 
            .onClick(async () => {
                const url = this.feedUrlInput.getValue().trim();
                const name = this.feedNameInput.getValue().trim();
                if (!url) {
                    new Notice('Please enter a feed or website URL.');
                    return;
                }
                new Notice(`Fetching feed from ${url}...`);
                const feedData = await parseFeed(url, name); 
                if (feedData) {
                    new Notice(`Successfully fetched "${feedData.title || 'Feed'}".`);
                    
                    await this.plugin.activateView('feed-entries', undefined, feedData);
                } else {
                    
                     new Notice('Failed to fetch or parse feed.');
                }
            });

        
        new ButtonComponent(addFeedButtons)
            .setButtonText('Save')
            .onClick(async () => {
                const url = this.feedUrlInput.getValue().trim();
                const name = this.feedNameInput.getValue().trim();

                if (!url) {
                    new Notice('Please enter a feed or website URL to save.');
                    return;
                }
                 if (!name) {
                    new Notice('Please enter a name for the feed.');
                    return;
                 }

                
                 try {
                     new URL(url);
                 } catch (e) {
                     new Notice('Please enter a valid URL.');
                     return;
                 }


                
                if (this.plugin.settings.savedFeeds.some(feed => feed.url === url)) {
                    new Notice('This feed URL is already saved.');
                    return;
                }

                
                this.plugin.settings.savedFeeds.push({
                     url: url,
                     name: name,
                     color: '#abcdef', 
                     enabled: true, 
                     folderId: this.feedFolderSelection
                });

                
                await this.plugin.saveSettings();
                new Notice(`Feed "${name}" saved.`);

                
                this.renderSavedFeeds();

                
                this.feedUrlInput.setValue('');
                this.feedNameInput.setValue('');
            });


        
        const combinedFeedCard = container.createDiv({ cls: 'feed-section combined-feed-card' });
        const combinedFeedButton = combinedFeedCard.createDiv({ cls: 'combined-feed-button' });
        combinedFeedButton.createEl('h3', { text: 'Combined Feed View' });
        combinedFeedButton.createEl('p', { text: 'View all entries from selected feeds', cls: 'combined-feed-description' });
        
        combinedFeedButton.onClickEvent(async () => {
            await this.plugin.activateView('combined-feed');
        });

        
        const savedFeedsSection = container.createDiv({ cls: 'feed-section saved-feeds' });
        const savedFeedsHeader = savedFeedsSection.createDiv({ cls: 'feed-section-header-row' });
        savedFeedsHeader.createEl('h2', { text: 'Saved Feeds' });

        
        new ExtraButtonComponent(savedFeedsHeader)
            .setIcon('folder-plus')
            .setTooltip('Create new folder')
            .onClick(() => {
                new FolderModal(this.app, async (name, color) => {
                    const id = `folder-${Date.now()}`;
                    this.plugin.settings.feedFolders.push({ id, name, color, isCollapsed: false });
                    await this.plugin.saveSettings();
                    this.renderSavedFeeds();
                    
                    this.onOpen(); 
                }).open();
            });

        this.savedFeedsContainer = savedFeedsSection.createDiv({ cls: 'saved-feeds-list' }); 

        
        this.renderSavedFeeds();
    }

    
    private renderSavedFeeds(): void {
        this.savedFeedsContainer.empty(); 

        const { feedFolders, savedFeeds } = this.plugin.settings;

        if (feedFolders.length === 0 && savedFeeds.length === 0) {
            this.savedFeedsContainer.createEl('p', { text: 'No feeds or folders saved yet.', cls: 'no-feeds-message' });
            return;
        }

        feedFolders.forEach((folder, folderIndex) => {
            const folderCard = this.savedFeedsContainer.createDiv({ cls: 'feed-folder-card' });
            folderCard.setCssProps({ 'border-color':  folder.color });
            
            const folderHeader = folderCard.createDiv({ cls: 'feed-folder-header' });
            const folderName = folderHeader.createEl('h3', { text: folder.name });

            
            folderCard.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                const menu = new Menu();
                menu.addItem((item) => {
                    item.setTitle('Rename/Recolor Folder')
                        .setIcon('pencil')
                        .onClick(() => {
                            new FolderModal(this.app, async (newName, newColor) => {
                                folder.name = newName;
                                folder.color = newColor;
                                await this.plugin.saveSettings();
                                this.renderSavedFeeds();
                                this.onOpen(); 
                            }, folder.name, folder.color).open();
                        });
                });
                menu.addItem((item) => {
                    item.setTitle('Delete Folder')
                        .setIcon('trash')
                        .onClick(async () => {
                            if (confirm(`Are you sure you want to delete the folder "${folder.name}" and all its feeds?`)) {
                                this.plugin.settings.savedFeeds = this.plugin.settings.savedFeeds.filter(f => f.folderId !== folder.id);
                                this.plugin.settings.feedFolders.splice(folderIndex, 1);
                                await this.plugin.saveSettings();
                                this.renderSavedFeeds();
                                this.onOpen(); 
                            }
                        });
                });
                menu.showAtMouseEvent(event);
            });

            
            folderHeader.addEventListener('click', async () => {
                folder.isCollapsed = !folder.isCollapsed;
                await this.plugin.saveSettings();
                this.renderSavedFeeds();
            });

            if (!folder.isCollapsed) {
                const folderContent = folderCard.createDiv({ cls: 'feed-folder-content' });
                const folderFeeds = savedFeeds.filter(f => f.folderId === folder.id);

                if (folderFeeds.length === 0) {
                    folderContent.createEl('p', { text: 'Empty folder', cls: 'empty-folder-msg' });
                } else {
                    folderFeeds.forEach((feed) => {
                        const feedItem = folderContent.createDiv({ cls: 'feed-list-item' });
                        
                        
                        const checkbox = feedItem.createEl('input', {
                            type: 'checkbox',
                            attr: { checked: feed.enabled !== false ? 'checked' : null }
                        });
                        checkbox.onchange = async (event) => {
                            feed.enabled = (event.target as HTMLInputElement).checked;
                            await this.plugin.saveSettings();
                        };

                        
                        const link = feedItem.createEl('a', { text: feed.name, cls: 'feed-text-link' });
                        link.addEventListener('click', async (e) => {
                            e.preventDefault();
                            new Notice(`Loading feed "${feed.name}"...`);
                            const feedData = await parseFeed(feed.url, feed.name);
                            if (feedData) {
                                await this.plugin.activateView('feed-entries', undefined, feedData);
                            }
                        });

                        
                        feedItem.addEventListener('contextmenu', (event) => {
                            event.preventDefault();
                            const menu = new Menu();
                            menu.addItem((item) => {
                                item.setTitle('Rename Feed')
                                    .setIcon('pencil')
                                    .onClick(() => {
                                        new RenameModal(this.app, feed.name, async (newName) => {
                                            feed.name = newName;
                                            await this.plugin.saveSettings();
                                            this.renderSavedFeeds();
                                        }).open();
                                    });
                            });
                            menu.addItem((item) => {
                                item.setTitle('Delete Feed')
                                    .setIcon('trash')
                                    .onClick(async () => {
                                        if (confirm(`Are you sure you want to delete the feed "${feed.name}"?`)) {
                                            this.plugin.settings.savedFeeds = this.plugin.settings.savedFeeds.filter(f => f !== feed);
                                            await this.plugin.saveSettings();
                                            this.renderSavedFeeds();
                                        }
                                    });
                            });
                            menu.showAtMouseEvent(event);
                        });
                    });
                }
            }
        });
    }

    async onClose() {
        
    }
}
