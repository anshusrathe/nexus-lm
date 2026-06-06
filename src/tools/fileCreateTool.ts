import { App, Modal, TFile, Notice, ButtonComponent, MarkdownRenderer, Component, TFolder, normalizePath, Setting } from 'obsidian';
import { AISettings, DEFAULT_SETTINGS, getModelTemperature, getModelTopP, getGeminiThinkingConfig } from '../settings';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { WebSearchService } from '../services/webSearch';
import { GroqService, ChatMessage, GroqApiError } from '../services/groqService';
import { UnifiedProviderManager, UnifiedMessage } from '../services/unifiedProviderManager';

interface FileCreationPlan {
  folderName: string;
  files: Array<{
    name: string;
    content: string;
    extension: string;
    description?: string; // Brief description for content generation
    templatePath?: string; // Selected template path
  }>;
}

interface DiagramNode {
    id: string;
    text: string;
    level: number;
    children: DiagramNode[];
    parent?: DiagramNode;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    layoutType?: 'tree' | 'timeline' | 'sideways';
}

interface DiagramEdge {
    id: string;
    from: string;
    to: string;
}

interface EnhancedFileCreationContext {
  userPrompt: string;
  targetFolder?: string;
  contextFiles: Array<{ path: string; content: string; basename: string }>;
  webSearchEnabled: boolean;
  webSearchService?: WebSearchService;
  settings: AISettings;
  chatHistory: any[];
  progressCallback?: (message: string, snippet?: string) => void;
}

/**
 * Modal to review and accept/reject file creation plan suggested by AI.
 */
export class FileCreationReviewModal extends Modal {
  private plan: FileCreationPlan;
  private onAccept: (plan: FileCreationPlan) => void;
  private fileStates: boolean[]; // true = accept, false = reject
  private settings: AISettings;
  private selectedTemplates: string[]; // Store template path for each file

  constructor(app: App, plan: FileCreationPlan, settings: AISettings, onAccept: (plan: FileCreationPlan) => void) {
    super(app);
    this.plan = plan;
    this.onAccept = onAccept;
    this.settings = settings;
    const files = Array.isArray(plan.files) ? plan.files : [];
    this.fileStates = files.map(() => true); // default: accept all files
    this.selectedTemplates = files.map(() => ''); // default: no template
  }

  onOpen() {
    // Apply the same modal styling as agent file operations
    this.modalEl.addClass('file-op-preview-modal');
    this.renderPlan();
  }

  private renderSpecializedPlan(type: 'Canvas' | 'Excalidraw') {
    const { contentEl } = this;
    const plan = this.plan as any;
    const folderName = plan.folderName || 'New Files';
    const targetPath = plan.targetPath;

    const header = contentEl.createDiv({ cls: 'file-preview-header' });
    header.createEl('h2', { text: `Create ${type}: ${folderName}` });

    const messageContainer = contentEl.createDiv({ cls: 'file-preview-scroll-container' });
    messageContainer.style.display = 'flex';
    messageContainer.style.flexDirection = 'column';
    messageContainer.style.alignItems = 'center';
    messageContainer.style.justifyContent = 'center';
    messageContainer.style.padding = '40px 20px';
    messageContainer.style.textAlign = 'center';

    messageContainer.createEl('div', {
      text: '📄',
      cls: 'file-preview-icon',
      attr: { style: 'font-size: 48px; margin-bottom: 20px;' }
    });

    messageContainer.createEl('p', {
      text: `These file types don't support preview. Please accept the file creation to continue.`,
      cls: 'file-preview-message'
    });

    if (targetPath) {
        const pathInfo = messageContainer.createEl('p', { cls: 'file-preview-path-info' });
        pathInfo.style.marginTop = '15px';
        pathInfo.style.fontWeight = 'bold';
        pathInfo.createSpan({ text: 'Target Path: ' });
        const linkSpan = pathInfo.createSpan();
        MarkdownRenderer.render(this.app, `[[${targetPath}]]`, linkSpan, '', this as any);
    }

    const footer = contentEl.createDiv({ cls: 'file-preview-footer' });
    new ButtonComponent(footer)
      .setButtonText(`Create ${type} File`)
      .setCta()
      .onClick(() => {
        this.onAccept(this.plan);
        this.close();
      });

    const cancelBtn = new ButtonComponent(footer)
      .setButtonText('Cancel')
      .onClick(() => {
        this.close();
      });
    cancelBtn.buttonEl.style.marginLeft = '10px';
  }

  private renderPlan() {
    const { contentEl } = this;
    contentEl.empty();
    
    const plan = this.plan as any;
    const isCanvas = plan && plan.nodes && plan.edges;
    const isExcalidraw = plan && (plan.type === 'excalidraw' || (plan.elements && !Array.isArray(plan.files)));

    if (isCanvas || isExcalidraw) {
      this.renderSpecializedPlan(isCanvas ? 'Canvas' : 'Excalidraw');
      return;
    }

    const files = Array.isArray(this.plan.files) ? this.plan.files : [];

    // Create header matching agent style
    const header = contentEl.createDiv({ cls: 'file-preview-header' });
    header.createEl('h2', { text: `Preview: ${this.plan.folderName}` });
    header.createEl('p', { 
      text: `${files.length} file(s) will be created`,
      cls: 'file-preview-subtitle'
    });
    
    // Create scrollable content area
    const scrollContainer = contentEl.createDiv({ cls: 'file-preview-scroll-container' });
    
    // Show each file with accept/reject controls
    files.forEach((file, idx) => {
      const fileSection = scrollContainer.createDiv({ cls: 'file-preview-section' });
      
      // File header with name and controls
      const fileHeader = fileSection.createDiv({ cls: 'file-preview-file-header' });
      
      const fileNameContainer = fileHeader.createDiv({ cls: 'file-preview-file-name-container' });
      fileNameContainer.createSpan({ 
        text: `📄 ${file.name}.${file.extension}`,
        cls: 'file-preview-file-name'
      });
      
      // Add accept/reject controls
      const controls = fileHeader.createDiv({ cls: 'file-preview-controls' });
      const acceptBtn = controls.createEl('button', { 
        text: this.fileStates[idx] ? '✓ Accepted' : 'Accept', 
        cls: this.fileStates[idx] ? 'file-accept-btn active' : 'file-accept-btn'
      });
      const rejectBtn = controls.createEl('button', { 
        text: this.fileStates[idx] ? 'Reject' : '✗ Rejected', 
        cls: this.fileStates[idx] ? 'file-reject-btn' : 'file-reject-btn active'
      });
      
      acceptBtn.onclick = () => {
        this.fileStates[idx] = true;
        this.renderPlan();
      };
      rejectBtn.onclick = () => {
        this.fileStates[idx] = false;
        this.renderPlan();
      };

      // Template Selection Dropdown for Markdown files
      if (this.fileStates[idx] && file.extension === 'md' && this.settings.templateFolder) {
        const templateFolder = this.app.vault.getAbstractFileByPath(this.settings.templateFolder);
        if (templateFolder instanceof TFolder) {
          const templates = templateFolder.children.filter(f => f instanceof TFile && f.extension === 'md') as TFile[];
          if (templates.length > 0) {
            const templateSetting = new Setting(fileSection)
              .setName('Template')
              .setDesc('Select a template for this note')
              .addDropdown((drop) => {
                drop.addOption('', 'None');
                templates.forEach(t => {
                  drop.addOption(t.path, t.name);
                });
                drop.setValue(this.selectedTemplates[idx])
                  .onChange((val: string) => {
                    this.selectedTemplates[idx] = val;
                  });
              });
            // Style adjustment for the preview modal
            templateSetting.settingEl.addClass('file-preview-template-setting');
          }
        }
      }
      
      // Content preview - only show if accepted
      if (this.fileStates[idx]) {
        const contentPreview = fileSection.createDiv({ cls: 'file-content-preview' });
        if (file.extension === 'md') {
          // Render markdown content
          const component = new Component();
          MarkdownRenderer.renderMarkdown(file.content, contentPreview, '', component);
        } else {
          // Show as code block
          const codeBlock = contentPreview.createEl('pre');
          codeBlock.createEl('code', { text: file.content });
        }
      } else {
        // Show rejected message
        const rejectedMsg = fileSection.createDiv({ cls: 'file-content-preview' });
        rejectedMsg.createEl('p', { 
          text: 'This file will not be created.',
          cls: 'file-rejected-message'
        });
      }
      
      // Add separator between files
      if (idx < files.length - 1) {
        scrollContainer.createDiv({ cls: 'file-preview-separator' });
      }
    });
    
    // Footer with actions
    const footer = contentEl.createDiv({ cls: 'file-preview-footer' });
    
    const acceptedCount = this.fileStates.filter(state => state).length;
    const buttonText = acceptedCount > 0 ? `Create ${acceptedCount} File(s)` : 'No Files Selected';
    
    new ButtonComponent(footer)
      .setButtonText(buttonText)
      .setCta()
      .setDisabled(acceptedCount === 0)
      .onClick(async () => {
        const acceptedFiles = files
          .filter((_, idx) => this.fileStates[idx])
          .map((file, fIdx) => {
            // Find original index in files to get correct template
            const originalIdx = files.indexOf(file);
            return {
              ...file,
              templatePath: this.selectedTemplates[originalIdx] || undefined
            };
          });

        const acceptedPlan = {
          ...this.plan,
          files: acceptedFiles
        };
        this.onAccept(acceptedPlan);
        this.close();
      });
    new ButtonComponent(footer)
      .setButtonText('Cancel')
      .onClick(() => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Main entry point for file creation via AI prompt.
 * @param app Obsidian app instance
 * @param prompt User's creation instruction
 * @param settings The plugin's AI settings
 * @param targetFolder Optional target folder path where files should be created
 * @param contextFiles Optional context files from capsules
 * @param webSearchEnabled Whether web search is enabled
 * @param webSearchService Web search service instance
 * @param progressCallback Optional callback for progress updates
 */
export async function handleFileCreationPrompt(
  app: App, 
  prompt: string, 
  settings: AISettings, 
  targetFolder?: string,
  contextFiles: Array<{ path: string; content: string; basename: string }> = [],
  webSearchEnabled: boolean = false,
  webSearchService?: WebSearchService,
  chatHistory: any[] = [],
  progressCallback?: (message: string, snippet?: string) => void
) {
  // Add spinner to top right of the workspace
  let spinner: HTMLElement | null = null;
  try {
    // Try to find the file view header or fallback to workspace container
    const workspace = document.querySelector('.workspace') || document.body;
    spinner = document.createElement('div');
    spinner.className = 'loading-spinner visible';
    spinner.style.position = 'fixed';
    spinner.style.top = '18px';
    spinner.style.right = '32px';
    spinner.style.zIndex = '9999';
    workspace.appendChild(spinner);

    // Create enhanced context for file creation
    const context: EnhancedFileCreationContext = {
      userPrompt: prompt,
      targetFolder,
      contextFiles,
      webSearchEnabled,
      webSearchService,
      settings,
      chatHistory,
      progressCallback
    };

    // Step 1: Get initial file structure plan
    const initialPlan = await getInitialFileStructure(context);
    
    if (!initialPlan || initialPlan.files.length === 0) {
      if (spinner) spinner.remove();
      new Notice('No files to create based on your request.');
      return;
    }

    // Step 2: Generate detailed content for each file
    const enhancedPlan = await generateDetailedFileContent(initialPlan, context, app);

    if (spinner) spinner.remove();

    new FileCreationReviewModal(app, enhancedPlan, settings, async (acceptedPlan) => {
      await createFilesFromPlan(app, acceptedPlan);
      new Notice(`Created ${acceptedPlan.files.length} file(s) in folder: ${acceptedPlan.folderName}`);
    }).open();
  } catch (err) {
    if (spinner) spinner.remove();
    new Notice('Error creating files: ' + (err instanceof Error ? err.message : String(err)));
  }
}

/**
 * Step 1: Get initial file structure and descriptions
 */
async function getInitialFileStructure(context: EnhancedFileCreationContext): Promise<FileCreationPlan> {
  const isGroq = context.settings.provider === 'groq';
  const isOpenRouter = context.settings.provider === 'openrouter';
  const isOllama = context.settings.provider === 'ollama';
  const isGemini = context.settings.provider === 'gemini';
  
  // Validate settings based on provider
  if (isGroq) {
    if (!context.settings.groqApiKey || !context.settings.model) {
      new Notice('File creation requires a valid Groq API key and model in settings.');
      throw new Error('Invalid AI settings');
    }
  } else if (isOpenRouter) {
    if (!context.settings.openRouterApiKey || !context.settings.model) {
      new Notice('File creation requires a valid OpenRouter API key and model in settings.');
      throw new Error('Invalid AI settings');
    }
  } else if (isOllama) {
    if (context.settings.ollamaMode === 'cloud' && !context.settings.ollamaApiKey) {
      new Notice('File creation requires a valid Ollama API key for cloud mode in settings.');
      throw new Error('Invalid AI settings');
    }
    if (!context.settings.model) {
      new Notice('File creation requires a valid Ollama model in settings.');
      throw new Error('Invalid AI settings');
    }
  } else if (UnifiedProviderManager.getInstance().hasProvider(context.settings.provider)) {
    if (!context.settings.model) {
      new Notice('File creation requires a valid model in settings.');
      throw new Error('Invalid AI settings');
    }
  } else if (!context.settings.apiKey || !context.settings.model) {
    new Notice('File creation requires a valid Gemini API key and model in settings.');
    throw new Error('Invalid AI settings');
  }
  
  try {
    // Build context information
    let contextInfo = '';
    if (context.contextFiles.length > 0) {
      contextInfo = `\n\nCONTEXT FILES PROVIDED:\n${context.contextFiles.map(f => `- ${f.basename}: ${f.content.substring(0, 200)}...`).join('\n')}`;
    }
    
    if (context.webSearchEnabled) {
      contextInfo += '\n\nWEB SEARCH ENABLED: Content will be enhanced with web research.';
    }

    // System prompt for initial file structure
    let systemPrompt = `You are an expert file and folder organizer for Obsidian. Create an initial file structure plan.

IMPORTANT RULES:
1. **FOLDER**: ${context.targetFolder ? `Use EXACT folder: "${context.targetFolder}"` : 'Create descriptive folder name'}
2. **FILES**: Analyze the request and determine what files are needed
3. **DESCRIPTIONS**: For each file, provide a brief description of what content it should contain
4. **EXTENSIONS**: Always use "md" for Obsidian notes

JSON FORMAT (MANDATORY):
{
  "folderName": "folder-name",
  "files": [
    {
      "name": "filename-without-extension",
      "description": "Brief description of what this file should contain",
      "content": "PLACEHOLDER - will be generated later",
      "extension": "md"
    }
  ]
}

CRITICAL:
❌ NO markdown code blocks
❌ NO explanations outside JSON
✅ START with { and END with }
✅ Use double quotes only
✅ Include description field for each file${contextInfo}`;

    const userPrompt = `User request: ${context.userPrompt}`;
    
    if (context.targetFolder) {
      systemPrompt += `\n\nUSER SELECTED FOLDER: "${context.targetFolder}" - Use this as folderName.`;
    }

    let aiText: string;

    if (isGroq) {
      // Use Groq for file structure generation
      const groqService = new GroqService(context.settings.groqApiKey);
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];
      aiText = await groqService.generateContent(context.settings.model, messages, {
        temperature: getModelTemperature(context.settings.model, context.settings),
        topP: getModelTopP(context.settings.model, context.settings)
      });
    } else if (isOpenRouter) {
      // Use OpenRouter for file structure generation
      const { OpenRouterService } = await import('../services/openRouterService');
      const openRouterService = new OpenRouterService(context.settings.openRouterApiKey);
      aiText = await openRouterService.generateContent(
        context.settings.model,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        { temperature: getModelTemperature(context.settings.model, context.settings), topP: getModelTopP(context.settings.model, context.settings) }
      );
    } else if (isOllama) {
      // Use Ollama for file structure generation
      const { OllamaService } = await import('../services/ollamaService');
      const ollamaService = new OllamaService(
        context.settings.ollamaBaseUrl,
        context.settings.ollamaApiKey
      );
      aiText = await ollamaService.generateContent(
        context.settings.model,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        { temperature: getModelTemperature(context.settings.model, context.settings), topP: getModelTopP(context.settings.model, context.settings) }
      );
    } else if (UnifiedProviderManager.getInstance().hasProvider(context.settings.provider)) {
      const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(context.settings.provider)!;
      const convertedHistory: UnifiedMessage[] = (context.chatHistory || []).map((h: any) => ({
        role: (h.role === 'model' ? 'assistant' : h.role) as 'user' | 'assistant' | 'system',
        content: h.parts[0].text
      }));
      const response = await unifiedProvider.generateContent(
        context.settings.model,
        [
          { role: 'system', content: systemPrompt },
          ...convertedHistory,
          { role: 'user', content: userPrompt }
        ],
        {
          temperature: getModelTemperature(context.settings.model, context.settings),
          maxTokens: 8192,
          topP: getModelTopP(context.settings.model, context.settings)
        }
      );
      aiText = response.text;
    } else {
      // Use Gemini (default)
      const genAI = new GoogleGenerativeAI(context.settings.geminiApiKey || context.settings.apiKey);
      const model = genAI.getGenerativeModel({ 
        model: context.settings.model,
        ...getGeminiThinkingConfig(context.settings.model, context.settings)
      });
      
      const result = await model.generateContent({
        contents: [
          { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }
        ],
        generationConfig: {
          temperature: getModelTemperature(context.settings.model, context.settings),
          topK: 40,
          topP: getModelTopP(context.settings.model, context.settings),
        }
      });
      
      aiText = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    }

    if (!aiText || aiText.length === 0) {
      throw new Error('Empty AI response');
    }
    
        
    const plan = extractAndValidateJSON(aiText);
    if (!plan) {
            throw new Error('Failed to parse file structure plan.');
    }
    
        return plan;
  } catch (err) {
    if (err instanceof GroqApiError) {
      new Notice('Groq API error: ' + err.message);
    } else {
      new Notice('Failed to create file structure: ' + (err instanceof Error ? err.message : String(err)));
    }
    throw err;
  }
}

/**
 * Step 2: Generate detailed content for each file with web search and context
 */
async function generateDetailedFileContent(
  initialPlan: FileCreationPlan, 
  context: EnhancedFileCreationContext, 
  app: App
): Promise<FileCreationPlan> {
  const enhancedFiles = [];
  
  for (let i = 0; i < initialPlan.files.length; i++) {
    const file = initialPlan.files[i];
        
    try {
      // Generate detailed content for this specific file
      const enhancedContent = await generateSingleFileContent(file, context, app);
      enhancedFiles.push({
        ...file,
        content: enhancedContent
      });
    } catch (err) {
            // Handle Groq API errors specifically
      if (err instanceof GroqApiError) {
        new Notice(`Groq API error for ${file.name}: ${err.message}`);
      }
      // Use fallback content
      enhancedFiles.push({
        ...file,
        content: `# ${file.name}\n\n${file.description || 'Content will be added here.'}\n\n*Note: Detailed content generation failed. Please edit manually.*`
      });
    }
  }
  
  return {
    ...initialPlan,
    files: enhancedFiles
  };
}

/**
 * Generate detailed content for a single file using PageIndex retrieval
 */
async function generateSingleFileContent(
  file: { name: string; description?: string; extension: string },
  context: EnhancedFileCreationContext,
  app: App
): Promise<string> {
  const isGroq = context.settings.provider === 'groq';
  const isOpenRouter = context.settings.provider === 'openrouter';
  const isOllama = context.settings.provider === 'ollama';
  
  // Validate settings based on provider
  if (isGroq) {
    if (!context.settings.groqApiKey) {
      throw new Error('Invalid AI settings');
    }
  } else if (isOpenRouter) {
    if (!context.settings.openRouterApiKey) {
      throw new Error('Invalid AI settings');
    }
  } else if (isOllama) {
    if (context.settings.ollamaMode === 'cloud' && !context.settings.ollamaApiKey) {
      throw new Error('Invalid AI settings');
    }
  } else if (UnifiedProviderManager.getInstance().hasProvider(context.settings.provider)) {
    // Validated
  } else if (!context.settings.apiKey) {
    throw new Error('Invalid AI settings');
  }

  // Use PageIndex retrieval for context files instead of arbitrary 500-char limit
  let contextContent = '';
  
  if (context.contextFiles.length > 0) {
    contextContent = `\n\nREFERENCE FILES:\n${context.contextFiles.map(f => 
      `--- ${f.basename} ---\n${f.content.substring(0, 500)}...`
    ).join('\n\n')}`;
  }

  // Build comprehensive prompt for this specific file
  let systemPrompt = `You are an expert content writer creating detailed, high-quality markdown content for Obsidian.

TASK: Create comprehensive content for a file named "${file.name}.${file.extension}"
DESCRIPTION: ${file.description || 'Create relevant content based on the user request'}

CONTENT REQUIREMENTS:
✅ Write detailed, well-structured markdown
✅ Use proper headings (# ## ###)
✅ Include relevant examples, lists, and formatting
✅ Make content substantial (minimum 200 words unless it's a simple note)
✅ Focus specifically on this file's purpose
${context.webSearchEnabled ? '✅ Include web search citations in format [🔗](URL)' : ''}
✅ Base content on the provided vault sections (if any)

CONTEXT PROVIDED:${contextContent}

ORIGINAL REQUEST: ${context.userPrompt}`;
  
  let userPrompt = `Create detailed markdown content for "${file.name}" file. ${file.description ? `Focus on: ${file.description}` : ''}`;
  
  // Add web search query if enabled
  if (context.webSearchEnabled) {
    const searchQuery = `${file.name} ${file.description || context.userPrompt}`.trim();
    userPrompt += ` Search for: ${searchQuery}`;
  }

  if (isGroq) {
    // Use Groq for content generation
    const groqService = new GroqService(context.settings.groqApiKey);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    const content = await groqService.generateContent(context.settings.model, messages, {
      temperature: getModelTemperature(context.settings.model, context.settings),
      topP: getModelTopP(context.settings.model, context.settings)
    });
    
    if (!content) {
      throw new Error('Empty content generated');
    }
    
    return content;
  } else if (isOpenRouter) {
    // Use OpenRouter for content generation
    const { OpenRouterService } = await import('../services/openRouterService');
    const openRouterService = new OpenRouterService(context.settings.openRouterApiKey);
    const content = await openRouterService.generateContent(
      context.settings.model,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      { temperature: getModelTemperature(context.settings.model, context.settings), topP: getModelTopP(context.settings.model, context.settings) }
    );
    
    if (!content) {
      throw new Error('Empty content generated');
    }
    
    return content;
  } else if (isOllama) {
    // Use Ollama for content generation
    const { OllamaService } = await import('../services/ollamaService');
    const ollamaService = new OllamaService(
      context.settings.ollamaBaseUrl,
      context.settings.ollamaApiKey
    );
    const content = await ollamaService.generateContent(
      context.settings.model,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      { temperature: getModelTemperature(context.settings.model, context.settings), topP: getModelTopP(context.settings.model, context.settings) }
    );
    
    if (!content) {
      throw new Error('Empty content generated');
    }
    
    return content;
  } else if (UnifiedProviderManager.getInstance().hasProvider(context.settings.provider)) {
    const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(context.settings.provider)!;
    const response = await unifiedProvider.generateContent(
      context.settings.model,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      {
        temperature: getModelTemperature(context.settings.model, context.settings),
        maxTokens: 8192,
        topP: getModelTopP(context.settings.model, context.settings)
      }
    );
    
    if (!response.text) {
      throw new Error('Empty content generated');
    }
    
    return response.text;
  } else {
    // Use Gemini (default)
    const genAI = new GoogleGenerativeAI(context.settings.geminiApiKey || context.settings.apiKey);
    
    // Configure model with web search if enabled
    const modelConfig: any = { model: context.settings.model };
    if (context.webSearchEnabled && context.webSearchService) {
      modelConfig.tools = [context.webSearchService.getGoogleSearchToolConfig()];
    }
    
    const model = genAI.getGenerativeModel(modelConfig);
    
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }],
      generationConfig: {
        temperature: getModelTemperature(context.settings.model, context.settings),
        topK: 40,
        topP: getModelTopP(context.settings.model, context.settings),
      }
    });
    
    const content = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!content) {
      throw new Error('Empty content generated');
    }
    
    return content;
  }
}

/**
 * Fixes common JSON formatting issues that AI might produce.
 */
function fixCommonJSONIssues(text: string): string {
  let fixed = text;
  
  // Remove trailing commas before closing braces/brackets
  fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
  
  // Replace single quotes with double quotes (but be careful with content)
  // Only do this outside of already double-quoted strings
  fixed = fixed.replace(/'([^']*?)'/g, (match, content) => {
    // If this looks like a property or simple value, convert to double quotes
    return `"${content}"`;
  });
  
  // Remove any leading/trailing text that's not part of JSON
  const firstBrace = fixed.indexOf('{');
  const lastBrace = fixed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    fixed = fixed.substring(firstBrace, lastBrace + 1);
  }
  
  return fixed;
}

/**
 * Extracts and validates JSON from AI response with multiple fallback strategies.
 */
function extractAndValidateJSON(aiText: string): FileCreationPlan | null {
  // Strategy 1: Remove markdown code blocks
  let cleanedText = aiText.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
  
  // Fix common JSON formatting issues
  cleanedText = fixCommonJSONIssues(cleanedText);
  
  // Strategy 2: Try direct parse first (cleanest response)
  try {
    const plan = JSON.parse(cleanedText);
    if (isValidPlan(plan)) {
      return sanitizePlan(plan);
    }
  } catch (e) {
    // Continue to next strategy
  }
  
  // Strategy 3: Extract JSON object using balanced brace matching
  const jsonStr = extractJSONObject(cleanedText);
  if (jsonStr) {
    try {
      const plan = JSON.parse(jsonStr);
      if (isValidPlan(plan)) {
        return sanitizePlan(plan);
      }
    } catch (e) {
      // Continue to next strategy
    }
  }
  
  // Strategy 4: Try the original text with simpler regex
  const simpleMatch = aiText.match(/\{[\s\S]*\}/);
  if (simpleMatch) {
    try {
      const plan = JSON.parse(simpleMatch[0]);
      if (isValidPlan(plan)) {
        return sanitizePlan(plan);
      }
    } catch (e) {
      // Continue to next strategy
    }
  }
  
  // Strategy 5: Try to find multiple JSON objects and use the most complete one
  const allMatches = findAllJSONObjects(aiText);
  for (const match of allMatches) {
    try {
      const plan = JSON.parse(match);
      if (isValidPlan(plan)) {
        return sanitizePlan(plan);
      }
    } catch (e) {
      continue;
    }
  }
  
  return null;
}

/**
 * Extracts a JSON object using balanced brace matching.
 */
function extractJSONObject(text: string): string | null {
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;
  
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  
  for (let i = firstBrace; i < text.length; i++) {
    const char = text[i];
    
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    
    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }
    
    if (!inString) {
      if (char === '{') depth++;
      if (char === '}') {
        depth--;
        if (depth === 0) {
          return text.substring(firstBrace, i + 1);
        }
      }
    }
  }
  
  return null;
}

/**
 * Finds all potential JSON objects in text.
 */
function findAllJSONObjects(text: string): string[] {
  const objects: string[] = [];
  let searchStart = 0;
  
  while (searchStart < text.length) {
    const braceIndex = text.indexOf('{', searchStart);
    if (braceIndex === -1) break;
    
    const obj = extractJSONObject(text.substring(braceIndex));
    if (obj) {
      objects.push(obj);
      searchStart = braceIndex + obj.length;
    } else {
      searchStart = braceIndex + 1;
    }
  }
  
  // Sort by completeness (has more properties = better)
  return objects.sort((a, b) => b.length - a.length);
}

/**
 * Validates that the plan has the required structure.
 */
function isValidPlan(plan: any): boolean {
  if (!plan || typeof plan !== 'object') return false;
  if (!plan.folderName || typeof plan.folderName !== 'string') return false;
  if (!Array.isArray(plan.files)) return false;
  if (plan.files.length === 0) return false;
  
  // Check each file has required fields
  for (const file of plan.files) {
    if (!file.name || typeof file.name !== 'string') return false;
    if (!file.content || typeof file.content !== 'string') return false;
    // extension is optional, will be set to 'md' by default
  }
  
  return true;
}

/**
 * Sanitizes and normalizes the plan.
 */
function sanitizePlan(plan: any): FileCreationPlan {
  // Clean the folder name to remove any unwanted characters
  plan.folderName = plan.folderName.replace(/[:;"'`]/g, '').trim();
  
  // Ensure all files have .md extension for Obsidian if no extension specified
  plan.files = plan.files.map((file: any) => {
    // Default to .md extension
    if (!file.extension || file.extension === '') {
      file.extension = 'md';
    }
    
    // Clean file name
    file.name = file.name.trim();
    
    // Ensure file names don't include extensions
    if (file.name.includes('.')) {
      const parts = file.name.split('.');
      if (parts.length > 1) {
        const ext = parts.pop();
        file.name = parts.join('.');
        // Only use the extension from filename if it wasn't already set
        if (!file.extension || file.extension === 'md') {
          file.extension = ext || 'md';
        }
      }
    }
    
    // Ensure extension doesn't have leading dot
    if (file.extension && file.extension.startsWith('.')) {
      file.extension = file.extension.substring(1);
    }
    
    return file;
  });
  
  return plan as FileCreationPlan;
}

/**
 * Parses Markdown into a hierarchical node tree for diagrams.
 */
function parseMarkdownToDiagramNodes(markdown: string): DiagramNode[] {
    const lines = markdown.split('\n');
    const rootNodes: DiagramNode[] = [];
    const stack: DiagramNode[] = [];

    let idCounter = 0;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Detect level: Headings (#) or Bullet points (- / *)
        let level = 0;
        let text = trimmed;

        const headingMatch = trimmed.match(/^(#+)\s+(.*)/);
        if (headingMatch) {
            level = headingMatch[1].length;
            text = headingMatch[2];
        } else {
            const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)/);
            if (listMatch) {
                // Approximate level based on indentation (2 spaces per level)
                level = Math.floor(listMatch[1].length / 2) + 1;
                text = listMatch[3];
            } else {
                // Default to current level or level 1
                level = stack.length > 0 ? stack[stack.length - 1].level : 1;
            }
        }

        const node: DiagramNode = {
            id: `node_${++idCounter}`,
            text: text,
            level: level,
            children: []
        };

        // Find parent
        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
            stack.pop();
        }

        if (stack.length > 0) {
            const parent = stack[stack.length - 1];
            node.parent = parent;
            parent.children.push(node);
        } else {
            rootNodes.push(node);
        }

        stack.push(node);
    }

    return rootNodes;
}

/**
 * Calculates a hierarchical tree layout for the nodes.
 */
function applyTreeLayout(roots: DiagramNode[], type: 'canvas' | 'excalidraw', layoutType: 'tree' | 'timeline' | 'sideways' = 'tree') {
    const nodes: any[] = [];
    const edges: any[] = [];
    
    // Layout Constants
    const config = {
        nodeWidth: type === 'canvas' ? 300 : 200,
        nodeHeight: type === 'canvas' ? 100 : 80,
        hGap: type === 'canvas' ? 50 : 100,
        vGap: type === 'canvas' ? 150 : 120
    };

    if (layoutType === 'timeline') {
        return applyTimelineLayout(roots, type, config);
    } else if (layoutType === 'sideways') {
        return applySidewaysLayout(roots, type, config);
    }

    // Default Tree Layout Logic
    function layoutSubtree(node: DiagramNode, xOffset: number, y: number): number {
        node.width = config.nodeWidth;
        node.height = config.nodeHeight;
        node.y = y;
        node.layoutType = layoutType;

        if (node.children.length === 0) {
            node.x = xOffset;
            return config.nodeWidth;
        }

        let totalWidth = 0;
        let childX = xOffset;
        for (const child of node.children) {
            const childSubtreeWidth = layoutSubtree(child, childX, y + config.vGap);
            totalWidth += childSubtreeWidth + config.hGap;
            childX += childSubtreeWidth + config.hGap;
        }

        totalWidth -= config.hGap; 
        node.x = xOffset + (totalWidth / 2) - (config.nodeWidth / 2);

        return Math.max(config.nodeWidth, totalWidth);
    }

    let xOffset = 0;
    for (const root of roots) {
        const rootWidth = layoutSubtree(root, xOffset, 0);
        xOffset += rootWidth + config.hGap * 2;
    }

    function flatten(node: DiagramNode) {
        nodes.push(node);
        for (const child of node.children) {
            edges.push({ 
                id: `edge_${node.id}_${child.id}`, 
                from: node.id, 
                to: child.id,
                hGap: config.hGap,
                vGap: config.vGap
            });
            flatten(child);
        }
    }
    roots.forEach(flatten);
    return { nodes, edges };
}

function applyTimelineLayout(roots: DiagramNode[], type: 'canvas' | 'excalidraw', config: any) {
    const nodes: any[] = [];
    const edges: any[] = [];
    const verticalOffset = 150;

    let currentX = 0;
    
    const timelineNodes: DiagramNode[] = [];
    function collectAll(nodesList: DiagramNode[]) {
        for (const n of nodesList) {
            timelineNodes.push(n);
            collectAll(n.children);
        }
    }
    collectAll(roots);

    timelineNodes.forEach((node, idx) => {
        node.width = config.nodeWidth;
        node.height = config.nodeHeight;
        node.x = currentX;
        node.y = idx % 2 === 0 ? 0 : verticalOffset;
        node.layoutType = 'timeline';
        
        nodes.push(node);
        if (idx > 0) {
            edges.push({
                id: `edge_timeline_${idx}`,
                from: timelineNodes[idx-1].id,
                to: node.id,
                hGap: config.hGap,
                vGap: verticalOffset
            });
        }
        currentX += config.nodeWidth + config.hGap;
    });

    return { nodes, edges };
}

function applySidewaysLayout(roots: DiagramNode[], type: 'canvas' | 'excalidraw', config: any) {
    const nodes: any[] = [];
    const edges: any[] = [];
    const sHGap = 150; // Special gap for sideways
    const sVGap = 40;

    function layoutSubtreeSideways(node: DiagramNode, x: number, yOffset: number): number {
        node.width = config.nodeWidth;
        node.height = config.nodeHeight;
        node.x = x;
        node.layoutType = 'sideways';

        if (node.children.length === 0) {
            node.y = yOffset;
            return config.nodeHeight;
        }

        let totalHeight = 0;
        let childY = yOffset;
        for (const child of node.children) {
            const childSubtreeHeight = layoutSubtreeSideways(child, x + config.nodeWidth + sHGap, childY);
            totalHeight += childSubtreeHeight + sVGap;
            childY += childSubtreeHeight + sVGap;
        }

        totalHeight -= sVGap;
        node.y = yOffset + (totalHeight / 2) - (config.nodeHeight / 2);

        return Math.max(config.nodeHeight, totalHeight);
    }

    let yOffset = 0;
    for (const root of roots) {
        const rootHeight = layoutSubtreeSideways(root, 0, yOffset);
        yOffset += rootHeight + sVGap * 3;
    }

    function flatten(node: DiagramNode) {
        nodes.push(node);
        for (const child of node.children) {
            edges.push({ 
                id: `edge_${node.id}_${child.id}`, 
                from: node.id, 
                to: child.id,
                hGap: sHGap,
                vGap: sVGap
            });
            flatten(child);
        }
    }
    roots.forEach(flatten);
    return { nodes, edges };
}

/**
 * Converts the layout into Obsidian Canvas JSON format.
 */
function convertToCanvasJSON(layout: { nodes: any[], edges: any[] }): string {
    const canvasData = {
        nodes: layout.nodes.map(n => ({
            id: n.id,
            type: 'text',
            text: n.text,
            x: Math.round(n.x),
            y: Math.round(n.y),
            width: n.width,
            height: n.height
        })),
        edges: layout.edges.map(e => ({
            id: e.id,
            fromNode: e.from,
            fromSide: e.hGap > e.vGap ? 'right' : 'bottom',
            toNode: e.to,
            toSide: e.hGap > e.vGap ? 'left' : 'top'
        }))
    };
    return JSON.stringify(canvasData, null, 2);
}

/**
 * Converts the layout into Excalidraw JSON format.
 */
function convertToExcalidrawJSON(layout: { nodes: any[], edges: any[] }): string {
    const elements: any[] = [];
    const seed = Math.floor(Math.random() * 100000);

    layout.nodes.forEach((n, idx) => {
        const shapeId = `shape_${n.id}`;
        const textId = `text_${n.id}`;

        // Shape (Rectangle)
        elements.push({
            type: 'rectangle',
            id: shapeId,
            x: n.x,
            y: n.y,
            width: n.width,
            height: n.height,
            strokeColor: '#374151',
            backgroundColor: '#f3f4f6',
            fillStyle: 'solid',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 100,
            angle: 0,
            version: 1,
            versionNonce: seed + idx,
            isDeleted: false,
            seed: seed + idx,
            groupIds: [],
            roundness: { type: 3 }
        });

        // Text (Wrapped inside container)
        elements.push({
            type: 'text',
            id: textId,
            x: n.x + 10,
            y: n.y + 10,
            width: n.width - 20,
            height: n.height - 20,
            text: n.text,
            fontSize: 16,
            fontFamily: 1,
            textAlign: 'center',
            verticalAlign: 'middle',
            containerId: shapeId, 
            originalText: n.text,
            strokeColor: '#000000',
            backgroundColor: 'transparent',
            version: 1,
            versionNonce: seed + idx + 1000,
            isDeleted: false,
            seed: seed + idx + 1000,
            groupIds: []
        });
    });

    layout.edges.forEach((e, idx) => {
        const fromNode = layout.nodes.find(n => n.id === e.from);
        const toNode = layout.nodes.find(n => n.id === e.to);

        if (fromNode && toNode) {
            let startX, startY, endX, endY, points;

            if (fromNode.layoutType === 'sideways') {
                // Sideways: Right of Parent to Left of Child
                startX = fromNode.x + fromNode.width;
                startY = fromNode.y + fromNode.height / 2;
                endX = toNode.x;
                endY = toNode.y + toNode.height / 2;
                const midX = e.hGap / 2;
                // Path: Right -> MidX -> Vertical to ChildY -> Right to ChildX
                points = [[0, 0], [midX, 0], [midX, endY - startY], [endX - startX, endY - startY]];
            } else if (fromNode.layoutType === 'timeline') {
                // Timeline: Right of Parent to Left of Child
                startX = fromNode.x + fromNode.width;
                startY = fromNode.y + fromNode.height / 2;
                endX = toNode.x;
                endY = toNode.y + toNode.height / 2;
                const midX = e.hGap / 2;
                points = [[0, 0], [midX, 0], [midX, endY - startY], [endX - startX, endY - startY]];
            } else {
                // Tree: Bottom of Parent to Top of Child
                startX = fromNode.x + fromNode.width / 2;
                startY = fromNode.y + fromNode.height;
                endX = toNode.x + toNode.width / 2;
                endY = toNode.y;
                const midY = (e.vGap - fromNode.height) / 2;
                // Path: Down -> MidY -> Horizontal to ChildX -> Down to ChildY
                points = [[0, 0], [0, midY], [endX - startX, midY], [endX - startX, endY - startY]];
            }

            elements.push({
                type: 'arrow',
                id: e.id,
                x: startX,
                y: startY,
                points: points,
                strokeColor: '#374151',
                strokeWidth: 2,
                endArrowhead: 'arrow',
                version: 1,
                versionNonce: seed + idx + 2000,
                isDeleted: false,
                seed: seed + idx + 2000,
                groupIds: [],
                startBinding: { elementId: `shape_${fromNode.id}`, focus: 0, gap: 1 },
                endBinding: { elementId: `shape_${toNode.id}`, focus: 0, gap: 1 }
            });
        }
    });

    const excalidraw = {
        type: 'excalidraw',
        version: 2,
        source: 'https://excalidraw.com',
        elements: elements,
        appState: { theme: 'light', viewBackgroundColor: '#ffffff' },
        files: {}
    };

    return JSON.stringify(excalidraw, null, 2);
}

/**
 * Orchestrates the conversion of Markdown content to the target diagram format.
 */
export function processDiagramContent(content: string, type: 'canvas' | 'excalidraw'): string {
    // Detect desired layout from content if possible
    let layout: 'tree' | 'timeline' | 'sideways' = 'tree';
    if (content.includes('LAYOUT: TIMELINE')) layout = 'timeline';
    else if (content.includes('LAYOUT: SIDEWAYS') || content.includes('LAYOUT: BRACE')) layout = 'sideways';

    const cleanContent = content.replace(/LAYOUT: (TIMELINE|SIDEWAYS|BRACE)/g, '').trim();
    const roots = parseMarkdownToDiagramNodes(cleanContent);
    const layoutResult = applyTreeLayout(roots, type, layout);
    
    if (type === 'canvas') {
        return convertToCanvasJSON(layoutResult);
    } else {
        return convertToExcalidrawJSON(layoutResult);
    }
}

/**
 * Creates files and folders based on the accepted plan.
 */
async function createFilesFromPlan(app: App, plan: FileCreationPlan): Promise<void> {
  try {
    // Create the folder
    const folderPath = plan.folderName;
    let folder: TFolder;
    
    try {
      folder = await app.vault.createFolder(folderPath);
    } catch (folderError) {
      // Folder might already exist, try to get it
      const existingFolder = app.vault.getAbstractFileByPath(folderPath);
      if (existingFolder instanceof TFolder) {
        folder = existingFolder;
      } else {
        throw folderError;
      }
    }

    // Create files in the folder
    for (const file of plan.files) {
      let finalContent = file.content;
      
      // Apply template if selected
      if (file.templatePath) {
        const templateFile = app.vault.getAbstractFileByPath(file.templatePath);
        if (templateFile instanceof TFile) {
          try {
            const templateContent = await app.vault.read(templateFile);
            finalContent = templateContent + '\n\n' + finalContent;
          } catch (readError) {
                      }
        }
      }

      const filePath = normalizePath(`${folderPath}/${file.name}.${file.extension}`);
      await app.vault.create(filePath, finalContent);
    }
  } catch (err) {
    new Notice('Failed to create files: ' + (err instanceof Error ? err.message : String(err)));
    throw err;
  }
} 