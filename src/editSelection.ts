import { App, Modal, Editor, Notice, ButtonComponent, Setting, MarkdownView, EditorPosition } from 'obsidian';
import { AISettings } from './settings';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GroqService, ChatMessage, GroqApiError } from './services/groqService';
import { UnifiedProviderManager, UnifiedMessage } from './services/unifiedProviderManager';
import { OllamaService } from './services/ollamaService';
import { OpenRouterService } from './services/openRouterService';
import { NvidiaService } from './services/nvidiaService';

/**
 * Modal for editing selected text in the editor
 */
export class EditSelectionModal extends Modal {
    private queryInput!: HTMLTextAreaElement;
    private settings: AISettings;
    private editor: Editor;
    private view: MarkdownView;
    private selectedText: string;
    private selectionFrom: EditorPosition;
    private selectionTo: EditorPosition;

    constructor(app: App, settings: AISettings, editor: Editor, view: MarkdownView, selectedText: string, selectionFrom: EditorPosition, selectionTo: EditorPosition) {
        super(app);
        this.settings = settings;
        this.editor = editor;
        this.view = view;
        this.selectedText = selectedText;
        this.selectionFrom = selectionFrom;
        this.selectionTo = selectionTo;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('edit-selection-modal');

        // Title
        contentEl.createEl('h2', { text: 'Edit Selection' });

        // Show selected text preview
        const previewContainer = contentEl.createDiv({ cls: 'edit-selection-preview' });
        previewContainer.createEl('div', { text: 'Selected text:', cls: 'edit-selection-preview-label' });
        const previewBox = previewContainer.createDiv({ cls: 'edit-selection-preview-box' });
        previewBox.textContent = this.selectedText.length > 200 
            ? this.selectedText.substring(0, 200) + '...' 
            : this.selectedText;

        // Query input area
        const inputContainer = contentEl.createDiv({ cls: 'edit-selection-input-container' });
        inputContainer.createEl('div', { text: 'What would you like to do with this text?', cls: 'edit-selection-input-label' });
        
        this.queryInput = inputContainer.createEl('textarea', {
            cls: 'edit-selection-query-input',
            attr: {
                placeholder: 'e.g., "Make it more concise", "Fix grammar", "Translate to Spanish", etc.',
                rows: '4'
            }
        });

        // Auto-focus the input
        this.queryInput.focus();

        // Model selection button (display only)
        const modelContainer = contentEl.createDiv({ cls: 'edit-selection-model-container' });
        const modelButton = modelContainer.createEl('button', {
            cls: 'edit-selection-model-button',
            text: `Model: ${this.settings.model}`
        });
        modelButton.disabled = true;

        // Proceed button
        const buttonContainer = contentEl.createDiv({ cls: 'edit-selection-button-container' });
        
        const proceedButton = new ButtonComponent(buttonContainer)
            .setButtonText('Proceed')
            .setCta()
            .onClick(async () => {
                await this.handleProceed();
            });

        const cancelButton = new ButtonComponent(buttonContainer)
            .setButtonText('Cancel')
            .onClick(() => {
                this.close();
            });

        // Handle Enter key with Ctrl/Cmd
        this.queryInput.addEventListener('keydown', async (e: KeyboardEvent) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                await this.handleProceed();
            }
        });
    }

    private async handleProceed() {
        const query = this.queryInput.value.trim();
        if (!query) {
            new Notice('Please enter a query');
            return;
        }

        this.close();
        
        // Process the edit
        await processSelectionEdit(
            this.app,
            this.settings,
            this.editor,
            this.view,
            this.selectedText,
            query,
            this.selectionFrom,
            this.selectionTo
        );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Process the selection edit by calling AI and showing inline diff
 */
async function processSelectionEdit(
    app: App,
    settings: AISettings,
    editor: Editor,
    view: MarkdownView,
    selectedText: string,
    query: string,
    selectionFrom: EditorPosition,
    selectionTo: EditorPosition
) {
    // Show loading notice
    const loadingNotice = new Notice('Generating edit...', 0);

    try {
        // Call AI to get edited text
        const editedText = await getAIEditForSelection(query, selectedText, settings);

        loadingNotice.hide();

        if (editedText === selectedText) {
            new Notice('No changes suggested by AI.');
            return;
        }

        // Show inline diff in the editor
        showInlineDiff(editor, view, selectedText, editedText, selectionFrom, selectionTo);

    } catch (err) {
        loadingNotice.hide();
        // Handle Groq API errors with user-friendly messages
        if (err instanceof GroqApiError) {
            new Notice(err.message);
        } else {
            new Notice('Error generating edit: ' + (err instanceof Error ? err.message : String(err)));
        }
    }
}

/**
 * Call AI to generate edited text
 */
async function getAIEditForSelection(query: string, selectedText: string, settings: AISettings): Promise<string> {
    const systemPrompt = `You are an expert text editor. Edit the following text according to the user's instruction. Return ONLY the edited text, nothing else. Do not include explanations, comments, or markdown formatting unless the user specifically asks for it.`;
    const userPrompt = `Instruction: ${query}\n\nText to edit:\n${selectedText}`;

    if (settings.provider === 'groq') {
        // Groq provider routing
        if (!settings.groqApiKey || !settings.model) {
            throw new Error('AI editing requires a valid Groq API key and model in settings.');
        }

        const groqService = new GroqService(settings.groqApiKey);
        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];

        const result = await groqService.generateContent(settings.model, messages);
        const trimmedResult = result.trim();
        if (trimmedResult && trimmedResult.length > 0) {
            return trimmedResult;
        }
        return selectedText;
    } else if (settings.provider === 'gemini') {
        // Explicit Gemini provider
        if (!settings.apiKey || !settings.model) {
            throw new Error('AI editing requires a valid Gemini API key and model in settings.');
        }

        const genAI = new GoogleGenerativeAI(settings.geminiApiKey || settings.apiKey);
        const model = genAI.getGenerativeModel({ model: settings.model });
        
        const result = await model.generateContent({
            contents: [
                { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }
            ]
        });
        
        const aiText = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (aiText && aiText.length > 0) {
            return aiText;
        }
        
        return selectedText;
    } else if (settings.provider === 'ollama') {
        // Hardcoded Ollama provider
        if (!settings.model) {
            throw new Error('AI editing requires a model selected for Ollama.');
        }

        const ollamaService = new OllamaService(settings.ollamaBaseUrl, settings.ollamaApiKey);
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];

        const result = await ollamaService.generateContent(settings.model, messages as unknown as SafeAny);
        const trimmedResult = result.trim();
        if (trimmedResult && trimmedResult.length > 0) {
            return trimmedResult;
        }
        return selectedText;
    } else if (settings.provider === 'openrouter') {
        // Hardcoded OpenRouter provider
        if (!settings.openRouterApiKey || !settings.model) {
            throw new Error('AI editing requires an OpenRouter API key and model.');
        }

        const openRouterService = new OpenRouterService(settings.openRouterApiKey);
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];

        const result = await openRouterService.generateContent(settings.model, messages as unknown as SafeAny);
        const trimmedResult = result.trim();
        if (trimmedResult && trimmedResult.length > 0) {
            return trimmedResult;
        }
        return selectedText;
    } else if (settings.provider === 'nvidia') {
        // Hardcoded Nvidia provider
        if (!settings.nvidiaApiKey || !settings.model) {
            throw new Error('AI editing requires an NVIDIA API key and model.');
        }

        const nvidiaService = new NvidiaService(settings.nvidiaApiKey);
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];

        const result = await nvidiaService.generateContent(settings.model, messages as unknown as SafeAny);
        const trimmedResult = result.trim();
        if (trimmedResult && trimmedResult.length > 0) {
            return trimmedResult;
        }
        return selectedText;
    } else if (UnifiedProviderManager.getInstance().hasProvider(settings.provider)) {
        // Unified provider routing (OpenRouter, Ollama, Nvidia, etc.)
        const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(settings.provider);
        if (!unifiedProvider) {
            throw new Error(`Unified provider ${settings.provider} not found.`);
        }

        const messages: UnifiedMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];

        const response = await unifiedProvider.generateContent(settings.model, messages);
        const trimmedText = response.text?.trim();
        if (trimmedText && trimmedText.length > 0) {
            return trimmedText;
        }
        return selectedText;
    } else {
        throw new Error(`Unsupported AI provider: ${settings.provider}. Please select Gemini, Groq, or a configured unified provider.`);
    }
}

/**
 * Show inline diff in the editor with accept/reject buttons
 */
function showInlineDiff(
    editor: Editor,
    view: MarkdownView,
    originalText: string,
    editedText: string,
    selectionFrom: EditorPosition,
    selectionTo: EditorPosition
) {
    // Create unique ID for this diff
    const diffId = `edit-diff-${Date.now()}`;
    
    // Create the HTML structure for the diff
    const diffHtml = createInlineDiffWidget(originalText, editedText, diffId);
    
    // Insert a marker at the selection position
    const marker = `[DIFF_${diffId}]`;
    editor.replaceRange(marker, selectionFrom, selectionTo);
    
    // Inject the diff widget as a floating overlay
    injectFloatingDiffWidget(view, diffId, diffHtml, editor, originalText, editedText, marker, selectionFrom);
}

/**
 * Create the inline diff widget HTML structure
 */
function createInlineDiffWidget(originalText: string, editedText: string, diffId: string): HTMLElement {
    const wrapper = document.createElement('div');
    
    // Add header
    const header = wrapper.createDiv({ cls: 'edit-selection-diff-header' });
    header.createEl('h3', { text: 'Review AI Edit', cls: 'edit-selection-diff-title' });
    header.createEl('p', { 
        text: 'Compare the original and edited versions. Accept to apply changes or Reject to keep original. Press ESC to cancel.',
        cls: 'edit-selection-diff-subtitle' 
    });
    
    const container = wrapper.createDiv({ cls: 'edit-selection-diff-container' });
    container.setAttribute('data-diff-id', diffId);
    
    // Deletion box (red)
    const deletionBox = container.createDiv({ cls: 'edit-selection-diff-deletion' });
    const deletionContent = deletionBox.createDiv({ cls: 'edit-selection-diff-content' });
    deletionContent.textContent = originalText;
    
    // Button container
    const buttonContainer = container.createDiv({ cls: 'edit-selection-diff-buttons' });
    
    const acceptBtn = buttonContainer.createEl('button', {
        cls: 'edit-selection-accept-btn',
        text: '✓ Accept Changes'
    });
    
    const rejectBtn = buttonContainer.createEl('button', {
        cls: 'edit-selection-reject-btn',
        text: '✗ Reject Changes'
    });
    
    // Addition box (green)
    const additionBox = container.createDiv({ cls: 'edit-selection-diff-addition' });
    const additionContent = additionBox.createDiv({ cls: 'edit-selection-diff-content' });
    additionContent.textContent = editedText;
    
    return wrapper;
}

/**
 * Inject the diff widget as a floating overlay
 */
function injectFloatingDiffWidget(
    view: MarkdownView,
    diffId: string,
    diffHtml: HTMLElement,
    editor: Editor,
    originalText: string,
    editedText: string,
    marker: string,
    markerPosition: EditorPosition
) {
    // Use the document that the view belongs to (important for pop-out windows)
    const viewDoc = view.containerEl.doc;
    
    // Create overlay container
    const overlay = viewDoc.createElement('div');
    overlay.addClass('edit-selection-diff-overlay');
    overlay.addClass('nexus-overlay');
    overlay.setAttribute('data-diff-id', diffId);
    
    // Add the diff widget to the overlay
    overlay.appendChild(diffHtml);
    
    // Add backdrop
    const backdrop = viewDoc.createElement('div');
    backdrop.addClass('edit-selection-diff-backdrop');
    backdrop.addClass('nexus-backdrop');
    
    // Append to view's document body
    viewDoc.body.appendChild(backdrop);
    viewDoc.body.appendChild(overlay);
    
    // Setup button handlers
    const acceptBtn = diffHtml.querySelector('.edit-selection-accept-btn') as HTMLButtonElement;
    const rejectBtn = diffHtml.querySelector('.edit-selection-reject-btn') as HTMLButtonElement;
    
    const cleanup = () => {
        overlay.remove();
        backdrop.remove();
    };
    
    if (acceptBtn) {
        acceptBtn.onclick = () => {
            acceptDiffEdit(editor, editedText, marker, overlay);
            cleanup();
        };
    }
    
    if (rejectBtn) {
        rejectBtn.onclick = () => {
            rejectDiffEdit(editor, originalText, marker, overlay);
            cleanup();
        };
    }
    
    // Click backdrop to reject
    backdrop.onclick = () => {
        rejectDiffEdit(editor, originalText, marker, overlay);
        cleanup();
        new Notice('Edit cancelled');
    };
    
    // Escape key to reject
    const escapeHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            rejectDiffEdit(editor, originalText, marker, overlay);
            cleanup();
            viewDoc.removeEventListener('keydown', escapeHandler);
            new Notice('Edit cancelled');
        }
    };
    viewDoc.addEventListener('keydown', escapeHandler);
    
    // Auto cleanup after 60 seconds
    setTimeout(() => {
        if (overlay.parentElement) {
            const currentContent = editor.getValue();
            if (currentContent.includes(marker)) {
                rejectDiffEdit(editor, originalText, marker, overlay);
                cleanup();
                viewDoc.removeEventListener('keydown', escapeHandler);
                new Notice('Edit timed out - changes rejected');
            }
        }
    }, 60000);
}

/**
 * Accept the diff edit
 */
function acceptDiffEdit(editor: Editor, editedText: string, marker: string, widgetEl: HTMLElement) {
    const content = editor.getValue();
    const newContent = content.replace(marker, editedText);
    editor.setValue(newContent);
    widgetEl.remove();
    new Notice('Edit accepted');
}

/**
 * Reject the diff edit
 */
function rejectDiffEdit(editor: Editor, originalText: string, marker: string, widgetEl: HTMLElement) {
    const content = editor.getValue();
    const newContent = content.replace(marker, originalText);
    editor.setValue(newContent);
    widgetEl.remove();
    new Notice('Edit rejected');
}

/**
 * Main entry point for the edit selection feature
 */
export function openEditSelectionModal(app: App, settings: AISettings) {
    // Get active markdown view and editor
    const activeView = app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
        new Notice('No active markdown file');
        return;
    }

    const editor = activeView.editor;
    const selection = editor.getSelection();
    
    if (!selection || selection.trim().length === 0) {
        new Notice('Please select some text first');
        return;
    }

    // Get selection positions
    const from = editor.getCursor('from');
    const to = editor.getCursor('to');

    // Open the modal
    new EditSelectionModal(app, settings, editor, activeView, selection, from, to).open();
}
