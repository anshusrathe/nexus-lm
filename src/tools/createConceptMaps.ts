import { Notice, Modal, Setting, TFile, ButtonComponent, MarkdownRenderer, normalizePath, setIcon, Component, requestUrl } from 'obsidian';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AISettings, getModelTemperature, getModelTopP } from '../settings';
import { GroqService, ChatMessage } from '../services/groqService';
import { OpenRouterService, ChatMessage as OpenRouterChatMessage } from '../services/openRouterService';
import { OllamaService, ChatMessage as OllamaChatMessage } from '../services/ollamaService';
import { NvidiaService, ChatMessage as NvidiaChatMessage } from '../services/nvidiaService';
import { MultimodalInput, processFileForMultimodal, isTextFile } from '../utils/multimodalUtils';
import { UnifiedProviderManager } from '../services/unifiedProviderManager';

interface OpenAIErrorResponse {
  error: {
    message: string;
  };
}

export interface ConceptMapData {
  noteName: string;
  innerCircle: Array<{ label: string; id: string }>;
  outerCircle: Array<{ label: string; id: string }>;
  relations: Array<{ from: string; to: string; reason: string }>;
  themes: Array<{ nodes: string[]; reason: string }>;
}

export interface SavedConceptMap {
  filePath: string;
  id: string;
  name: string;
  timestamp: number;
}

export class ConceptMapManager {
  private settings: AISettings;
  private app: SafeAny;
  private clickedNodeId: string | null = null;
  private clickedThemeIdx: number | null = null;
  private themeNodeOverlay: HTMLElement | null = null;
  private holdTimer: SafeAny = null;
  private isHolding: boolean = false;
  private firedThemeNode: SVGElement | null = null;
  private zoomAnchorX: number | null = null;
  private zoomAnchorY: number | null = null;
  private mouseMoveTimeout: SafeAny = null;

  constructor(app: SafeAny, settings: AISettings) {
    this.app = app;
    this.settings = settings;
  }

  private validateSettings(): boolean {
    const provider = this.settings.aiTutorProvider || this.settings.provider;
    let apiKey: string;
    if (provider === 'groq') {
      apiKey = this.settings.groqApiKey;
    } else if (provider === 'openrouter') {
      apiKey = this.settings.openRouterApiKey;
    } else if (provider === 'ollama') {
      // Ollama doesn't require API key for local mode
      if (this.settings.ollamaMode === 'cloud' && !this.settings.ollamaApiKey) {
        new Notice('Please set your Ollama API key in settings for cloud mode');
        return false;
      }
      return true;
    } else if (provider === 'nvidia') {
      apiKey = this.settings.nvidiaApiKey;
    } else {
      apiKey = this.settings.geminiApiKey || this.settings.apiKey;
    }
    
    if (!apiKey) {
      new Notice('Please set your API key in settings');
      return false;
    }
    if (provider === 'gemini' && apiKey.length < 20) {
      new Notice('Invalid Gemini API key format');
      return false;
    }
    if (provider === 'groq' && (!apiKey.startsWith('gsk_') || apiKey.length < 20)) {
      new Notice('Invalid Groq API key format');
      return false;
    }
    if (provider === 'openrouter' && (!apiKey.startsWith('sk-or-') || apiKey.length < 20)) {
      new Notice('Invalid OpenRouter API key format');
      return false;
    }
    if (provider === 'nvidia' && (!apiKey || apiKey.length < 20)) {
      new Notice('Invalid NVIDIA API key format');
      return false;
    }
    return true;
  }

  private getApiKey(): string {
    const provider = this.settings.aiTutorProvider || this.settings.provider;
    if (provider === 'groq') {
      return this.settings.groqApiKey;
    } else if (provider === 'openrouter') {
      return this.settings.openRouterApiKey;
    } else if (provider === 'ollama') {
      return this.settings.ollamaApiKey || '';
    } else if (provider === 'nvidia') {
      return this.settings.nvidiaApiKey;
    }
    return this.settings.geminiApiKey || this.settings.apiKey;
  }

  async generateConceptMap(
    notePaths: string[],
    progressCallback?: (percentage: number, status: string) => void
  ): Promise<ConceptMapData> {
    if (!this.validateSettings()) {
      throw new Error('Invalid settings');
    }

    progressCallback?.(10, 'Reading file contents...');

    // Separate text files from multimodal files
    const textContents: { title: string; content: string }[] = [];
    const multimodalInputs: MultimodalInput[] = [];

    await Promise.all(
      notePaths.map(async path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file || !(file instanceof TFile)) return;
        
        // Check if it's a text file (markdown, txt, etc.)
        if (file.extension === 'md' || isTextFile(file.name)) {
          const content = await this.app.vault.read(file);
          textContents.push({
            title: file.basename,
            content: content.trim()
          });
        } else if (provider === 'gemini') {
          // Process multimodal files for Gemini
          const multimodalData = await processFileForMultimodal(this.app, file);
          if (multimodalData) {
            multimodalInputs.push(multimodalData);
          }
        }
      })
    );
    
    if (textContents.length === 0 && multimodalInputs.length === 0) {
      throw new Error('No valid files selected');
    }

    const formattedContent = textContents.length > 0 
      ? textContents
          .map((note) => `# ${note.title}\n\n${note.content}`)
          .join('\n\n---\n\n')
      : '';

    progressCallback?.(30, 'Analyzing note content with AI...');

    const prompt = `You are an expert educational concept mapper specializing in uncovering deep, non-obvious connections between ideas. Your goal is to create a concept map that reveals MEANINGFUL and INSIGHTFUL relationships that learners might miss on their own.

**CRITICAL GUIDELINES:**

1. **Core Concepts (Inner Circle)**: Identify all the FUNDAMENTAL concepts that are the theoretical/conceptual pillars of this content. These should be abstract, principle-based ideas, not surface-level topics, NEVER BOLDEN ANY OF THE CORE CONCEPTS TEXT.

2. **Applications & Extensions (Outer Circle)**: Find all the specific applications, connections or related phenomena that CONCRETELY demonstrate or extend the core concepts. Act as the best research assistant of the user and provide the connections of the fundamental concepts that the user may miss, NEVER BOLDEN ANY TEXT HERE AS WELL.

3. **Deep Meaningful Relations**: This is THE MOST IMPORTANT part. For EVERY connection you create:
   - ❌ AVOID generic descriptions like "related to", "uses", "connects", "part of"
   - ✅ EXPLAIN the specific mechanism, principle, or insight that creates the connection
   - ✅ Reveal WHY this relationship matters for understanding
   - ✅ Show counterintuitive or subtle connections that aren't immediately obvious
   - ✅ Use phrases like "enables", "constrains", "reveals", "challenges", "depends on"
   - ✅ Make each relation teach something valuable

4. **Rich Thematic Grouping** [MANDATORY]: You MUST identify themes intelligently that:
   - Span multiple nodes across BOTH inner and outer circles
   - Represent overarching patterns, principles, or frameworks
   - Help organize the conceptual landscape meaningfully
   - Don't force the nodes unnecesarily into a theme, each theme should connect nodes that share a deeper conceptual unity
   - Themes are HOW users discover the structure of knowledge

**EXAMPLES OF GOOD VS BAD RELATIONS:**

❌ BAD (generic): "Photosynthesis <-> Chloroplast : Chloroplasts are where photosynthesis happens"
✅ GOOD (insightful): "Photosynthesis <-> Chloroplast : The double membrane structure creates isolated compartments that maintain the proton gradient essential for ATP synthesis, demonstrating how cellular architecture enables energy transformation"

❌ BAD: "Machine Learning <-> Neural Networks : Neural networks use machine learning"
✅ GOOD: "Machine Learning <-> Neural Networks : Neural networks achieve learning through gradient descent optimization, which reveals how iterative error correction can approximate complex non-linear functions without explicit programming"

**Output Format** (strictly follow this):

# [Note Title Here]

## Inner Circle
- [Core Concept 1] [A]
- [Core Concept 2] [B]
- [Core Concept 3] [C]
(Continue as needed)

### Outer Circle
- [Application/Example 1] [1]
- [Application/Example 2] [2]
- [Application/Example 3] [3]
(Continue as needed)

#### Relations
IMPORTANT: Create all the existing meaningful relations only. Connect:
- Core concepts to each other (show interdependencies)
- Core concepts to applications (show how principles manifest)
- Applications to each other (show parallel patterns)
- Unexpected cross-domain connections

- [A]<->[B] : [Detailed explanation of the specific mechanism/principle connecting them]
- [A]<->[1] : [Explain how the application demonstrates or extends the concept]
- [B]<->[2] : [Another deep connection with specific insight]
(Continue with OTHER meaningful connections WITHOUT REPEATING ANY OF THE CONNECTIONS. Make sure YOU DON'T REPEAT ANY OF THE CONNECTIONS)

##### Themes
IMPORTANT: Create themes that group related concepts:
- [A]--[B]--[1] : [Explanation of the unifying principle or pattern connecting these nodes]
- [C]--[3]--[4] : [Another thematic framework explaining how these relate]
(MUST include themes with clear explanations, DON'T include the notations [A], [B], [C], etc. or [1], [2], [3], etc. in the EXPLANATION of a theme)

**Technical Requirements:**
- Use [A], [B], [C], etc. for inner circle (uppercase letters)
- Use [1], [2], [3], etc. for outer circle (numbers)
- Relations format: [X]<->[Y] : explanation
- Themes format: [X]--[Y]--[Z] : explanation
- Every relation MUST have detailed explanation (minimum 10 words)
- Ensure all referenced IDs exist in the circles

**Content to analyze:**

${formattedContent || '(See attached files for content to analyze)'}

Generate a comprehensive concept map with DEEP, MEANINGFUL connections now:`;

    let responseText = '';
    let isComplete = false;
    let continuationAttempts = 0;
    const maxContinuations = 3;

    const provider = this.settings.aiTutorProvider || this.settings.provider;
    const modelId = this.settings.aiTutorModel || this.settings.model;

    // Initial generation
    if (provider === 'gemini') {
      try {
        const genAI = new GoogleGenerativeAI(this.getApiKey());
        const model = genAI.getGenerativeModel({ model: modelId });
        
        // Build message parts with multimodal inputs
        const messageParts: SafeAny[] = [{ text: prompt }];
        
        // Add multimodal inputs (images, PDFs, audio, video) for inline data
        const inlineInputs = multimodalInputs.filter(input => input.type === 'inline' && input.data);
        for (const input of inlineInputs) {
          messageParts.push({
            inlineData: {
              mimeType: input.mimeType,
              data: input.data!
            }
          });
        }
        
        const result = await model.generateContent({
          contents: [{ role: "user", parts: messageParts }],
          generationConfig: {
            temperature: getModelTemperature(modelId, this.settings),
            topK: 40,
            topP: getModelTopP(modelId, this.settings),
            maxOutputTokens: 8192,
          },
        });

        responseText = result.response.text();
        
        // Check if response seems complete (has all required sections)
        isComplete = this.checkResponseComplete(responseText);
        
        // If incomplete, try continuation
        while (!isComplete && continuationAttempts < maxContinuations) {
          continuationAttempts++;
          progressCallback?.(50 + continuationAttempts * 5, `Continuing generation (${continuationAttempts}/${maxContinuations})...`);
          
          // Detect what's missing and create targeted prompt
          const missingSections = this.detectMissingSections(responseText);
          const continuePrompt = this.buildContinuationPrompt(responseText, missingSections);
          
          const continueResult = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: continuePrompt }]}],
            generationConfig: {
              temperature: getModelTemperature(modelId, this.settings),
              topK: 40,
              topP: getModelTopP(modelId, this.settings),
              maxOutputTokens: 8192,
            },
          });
          
          const continuation = continueResult.response.text();
          // Smart append: avoid duplicate section headers
          const cleanContinuation = this.cleanContinuation(responseText, continuation);
          responseText += '\n' + cleanContinuation;
          isComplete = this.checkResponseComplete(responseText);
        }

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Gemini API error: ${errorMessage}`);
      }
    } else if (provider === 'groq') {
      try {
        const groqService = new GroqService(this.getApiKey());
        const systemPrompt = 'You are an expert at creating concept maps from educational content.';
        
        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ];

        responseText = await groqService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 8192, topP: getModelTopP(modelId, this.settings) }
        );

        // Check if response seems complete (has all required sections)
        isComplete = this.checkResponseComplete(responseText);
        
        // If incomplete, try continuation
        while (!isComplete && continuationAttempts < maxContinuations) {
          continuationAttempts++;
          progressCallback?.(50 + continuationAttempts * 5, `Continuing generation (${continuationAttempts}/${maxContinuations})...`);
          
          // Detect what's missing and create targeted prompt
          const missingSections = this.detectMissingSections(responseText);
          const continuePrompt = this.buildContinuationPrompt(responseText, missingSections);
          
          const continuationMessages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'assistant', content: responseText },
            { role: 'user', content: continuePrompt }
          ];
          
          const continuation = await groqService.generateContent(
            modelId,
            continuationMessages,
            { temperature: getModelTemperature(modelId, this.settings), maxTokens: 8192, topP: getModelTopP(modelId, this.settings) }
          );
          
          // Smart append: avoid duplicate section headers
          const cleanContinuation = this.cleanContinuation(responseText, continuation);
          responseText += '\n' + cleanContinuation;
          isComplete = this.checkResponseComplete(responseText);
        }

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Groq API error: ${errorMessage}`);
      }
    } else if (provider === 'openrouter') {
      try {
        const openRouterService = new OpenRouterService(this.getApiKey());
        const systemPrompt = 'You are an expert at creating concept maps from educational content.';
        
        const messages: OpenRouterChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ];

        responseText = await openRouterService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 8192, topP: getModelTopP(modelId, this.settings) }
        );

        // Check if response seems complete (has all required sections)
        isComplete = this.checkResponseComplete(responseText);
        
        // If incomplete, try continuation
        while (!isComplete && continuationAttempts < maxContinuations) {
          continuationAttempts++;
          progressCallback?.(50 + continuationAttempts * 5, `Continuing generation (${continuationAttempts}/${maxContinuations})...`);
          
          // Detect what's missing and create targeted prompt
          const missingSections = this.detectMissingSections(responseText);
          const continuePrompt = this.buildContinuationPrompt(responseText, missingSections);
          
          const continuationMessages: OpenRouterChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'assistant', content: responseText },
            { role: 'user', content: continuePrompt }
          ];
          
          const continuation = await openRouterService.generateContent(
            modelId,
            continuationMessages,
            { temperature: getModelTemperature(modelId, this.settings), maxTokens: 8192, topP: getModelTopP(modelId, this.settings) }
          );
          
          // Smart append: avoid duplicate section headers
          const cleanContinuation = this.cleanContinuation(responseText, continuation);
          responseText += '\n' + cleanContinuation;
          isComplete = this.checkResponseComplete(responseText);
        }

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`OpenRouter API error: ${errorMessage}`);
      }
    } else if (provider === 'ollama') {
      try {
        const ollamaService = new OllamaService(this.settings.ollamaBaseUrl, this.getApiKey());
        const systemPrompt = 'You are an expert at creating concept maps from educational content.';
        
        const messages: OllamaChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ];

        responseText = await ollamaService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 8192, topP: getModelTopP(modelId, this.settings) }
        );

        // Check if response seems complete (has all required sections)
        isComplete = this.checkResponseComplete(responseText);
        
        // If incomplete, try continuation
        while (!isComplete && continuationAttempts < maxContinuations) {
          continuationAttempts++;
          progressCallback?.(50 + continuationAttempts * 5, `Continuing generation (${continuationAttempts}/${maxContinuations})...`);
          
          // Detect what's missing and create targeted prompt
          const missingSections = this.detectMissingSections(responseText);
          const continuePrompt = this.buildContinuationPrompt(responseText, missingSections);
          
          const continuationMessages: OllamaChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'assistant', content: responseText },
            { role: 'user', content: continuePrompt }
          ];
          
          const continuation = await ollamaService.generateContent(
            modelId,
            continuationMessages,
            { temperature: getModelTemperature(modelId, this.settings), maxTokens: 8192, topP: getModelTopP(modelId, this.settings) }
          );
          
          // Smart append: avoid duplicate section headers
          const cleanContinuation = this.cleanContinuation(responseText, continuation);
          responseText += '\n' + cleanContinuation;
          isComplete = this.checkResponseComplete(responseText);
        }

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Ollama API error: ${errorMessage}`);
      }
    } else if (provider === 'nvidia') {
      try {
        const nvidiaService = new NvidiaService(this.getApiKey());
        const messages: NvidiaChatMessage[] = [
          { role: 'system', content: 'You are an expert at creating concept maps from educational content.' },
          { role: 'user', content: prompt }
        ];
        
        let responseText = await nvidiaService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 4096, topP: getModelTopP(modelId, this.settings) }
        );

        let continuationAttempts = 0;
        let isComplete = this.checkResponseComplete(responseText);

        while (!isComplete && continuationAttempts < maxContinuations) {
          continuationAttempts++;
          progressCallback?.(50 + continuationAttempts * 5, `Continuing generation (${continuationAttempts}/${maxContinuations})...`);
          
          const missingSections = this.detectMissingSections(responseText);
          const continuePrompt = this.buildContinuationPrompt(responseText, missingSections);
          
          messages.push({ role: 'assistant', content: responseText });
          messages.push({ role: 'user', content: continuePrompt });
          
          const continuedText = await nvidiaService.generateContent(
            modelId,
            messages,
            { temperature: getModelTemperature(modelId, this.settings), maxTokens: 4096, topP: getModelTopP(modelId, this.settings) }
          );
          
          responseText += '\n' + continuedText;
          isComplete = this.checkResponseComplete(responseText);
        }

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`NVIDIA API error: ${errorMessage}`);
      }
    } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
      try {
        const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
        const systemPrompt = 'You are an expert at creating concept maps from educational content.';
        
        const response = await unifiedProvider.generateContent(
          modelId,
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
          ],
          {
            temperature: getModelTemperature(modelId, this.settings),
            maxTokens: 8192,
            topP: getModelTopP(modelId, this.settings)
          }
        );
        
        responseText = response.text;
        
        // Check if response seems complete (has all required sections)
        isComplete = this.checkResponseComplete(responseText);
        
        // If incomplete, try continuation
        while (!isComplete && continuationAttempts < maxContinuations) {
          continuationAttempts++;
          progressCallback?.(50 + continuationAttempts * 5, `Continuing generation (${continuationAttempts}/${maxContinuations})...`);
          
          // Detect what's missing and create targeted prompt
          const missingSections = this.detectMissingSections(responseText);
          const continuePrompt = this.buildContinuationPrompt(responseText, missingSections);
          
          const continuation = await unifiedProvider.generateContent(
            modelId,
            [
              { role: 'system', content: systemPrompt },
              { role: 'assistant', content: responseText },
              { role: 'user', content: continuePrompt }
            ],
            {
              temperature: getModelTemperature(modelId, this.settings),
              maxTokens: 8192,
              topP: getModelTopP(modelId, this.settings)
            }
          );
          
          // Smart append: avoid duplicate section headers
          const cleanContinuation = this.cleanContinuation(responseText, continuation.text);
          responseText += '\n' + cleanContinuation;
          isComplete = this.checkResponseComplete(responseText);
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`${provider} API error: ${errorMessage}`);
      }
    } else {
      try {
        const messages = [
          {
            role: 'system',
            content: 'You are an expert at creating concept maps from educational content.'
          },
          { role: 'user', content: prompt }
        ];
        
        let resp = await requestUrl({
          url: 'https://api.openai.com/v1/chat/completions',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.getApiKey()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: modelId,
            messages: messages,
            max_tokens: 4096
          })
        });

        const data = resp.json;
        responseText = data.choices[0].message.content;
        let finishReason = data.choices[0].finish_reason;
        
        // If truncated due to length, continue
        while (finishReason === 'length' && continuationAttempts < maxContinuations) {
          continuationAttempts++;
          progressCallback?.(50 + continuationAttempts * 5, `Continuing generation (${continuationAttempts}/${maxContinuations})...`);
          
          // Detect what's missing and create targeted prompt
          const missingSections = this.detectMissingSections(responseText);
          const continuePrompt = this.buildContinuationPrompt(responseText, missingSections);
          
          messages.push(
            { role: 'assistant', content: responseText },
            { role: 'user', content: continuePrompt }
          );
          
          resp = await requestUrl({
            url: 'https://api.openai.com/v1/chat/completions',
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.getApiKey()}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: modelId,
              messages: messages,
              max_tokens: 4096
            })
          });
          
          const continuationData = resp.json;
          const continuation = continuationData.choices[0].message.content;
          finishReason = continuationData.choices[0].finish_reason;
          // Smart append: avoid duplicate section headers
          const cleanContinuation = this.cleanContinuation(responseText, continuation);
          responseText += '\n' + cleanContinuation;
        }

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`OpenAI API error: ${errorMessage}`);
      }
    }

    if (!responseText) {
      throw new Error('Failed to generate concept map content');
    }

    progressCallback?.(70, 'Parsing concept map structure...');

    // Parse the response
    const defaultTitle = textContents.length > 0 ? textContents[0].title : (multimodalInputs.length > 0 ? multimodalInputs[0].fileName : 'Concept Map');
    const conceptMapData = this.parseConceptMapResponse(responseText, defaultTitle);
    
    progressCallback?.(100, 'Concept map generated successfully!');

    return conceptMapData;
  }

  private parseConceptMapResponse(responseText: string, defaultTitle: string): ConceptMapData {
    const lines = responseText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    const conceptMapData: ConceptMapData = {
      noteName: defaultTitle,
      innerCircle: [],
      outerCircle: [],
      relations: [],
      themes: []
    };

    // Track seen IDs and content to prevent duplicates
    const seenInnerIds = new Set<string>();
    const seenOuterIds = new Set<string>();
    const seenRelations = new Set<string>();
    const seenThemes = new Set<string>();

    let currentSection: 'none' | 'inner' | 'outer' | 'relations' | 'themes' = 'none';

    for (const line of lines) {
      // Check for section headers
      if (line.startsWith('# ')) {
        conceptMapData.noteName = line.substring(2).trim();
        continue;
      }
      if (line.startsWith('## Inner Circle')) {
        currentSection = 'inner';
        continue;
      }
      if (line.startsWith('### Outer Circle')) {
        currentSection = 'outer';
        continue;
      }
      if (line.startsWith('#### Relations')) {
        currentSection = 'relations';
        continue;
      }
      if (line.startsWith('##### Themes')) {
        currentSection = 'themes';
        continue;
      }

      // Parse content based on current section
      if (line.startsWith('- ')) {
        const content = line.substring(2).trim();
        
        if (currentSection === 'inner') {
          // Parse: "Concept Name [A]"
          const match = content.match(/^(.+?)\s+\[([A-Z])\]$/);
          if (match) {
            const id = match[2];
            const label = match[1].trim();
            
            // Only add if not seen before (check both ID and normalized label)
            const normalizedLabel = label.toLowerCase().replace(/\s+/g, ' ');
            if (!seenInnerIds.has(id) && !seenInnerIds.has(normalizedLabel)) {
              conceptMapData.innerCircle.push({ label, id });
              seenInnerIds.add(id);
              seenInnerIds.add(normalizedLabel);
            }
          }
        } else if (currentSection === 'outer') {
          // Parse: "Application Name [1]"
          const match = content.match(/^(.+?)\s+\[(\d+)\]$/);
          if (match) {
            const id = match[2];
            const label = match[1].trim();
            
            // Only add if not seen before (check both ID and normalized label)
            const normalizedLabel = label.toLowerCase().replace(/\s+/g, ' ');
            if (!seenOuterIds.has(id) && !seenOuterIds.has(normalizedLabel)) {
              conceptMapData.outerCircle.push({ label, id });
              seenOuterIds.add(id);
              seenOuterIds.add(normalizedLabel);
            }
          }
        } else if (currentSection === 'relations') {
          // Parse: "[A]<->[B] : Reason"
          const match = content.match(/^\[([A-Z\d]+)\]<->\[([A-Z\d]+)\]\s*:\s*(.+)$/);
          if (match) {
            const from = match[1];
            const to = match[2];
            const reason = match[3].trim();
            
            // Create unique key for relation (bidirectional - A<->B same as B<->A)
            const relationKey1 = `${from}<->${to}`;
            const relationKey2 = `${to}<->${from}`;
            
            // Only add if not seen before
            if (!seenRelations.has(relationKey1) && !seenRelations.has(relationKey2)) {
              conceptMapData.relations.push({ from, to, reason });
              seenRelations.add(relationKey1);
              seenRelations.add(relationKey2);
            }
          }
        } else if (currentSection === 'themes') {
          // Parse: "[A]--[B]--[1] : Reason"
          const themeMatch = content.match(/^(.+?)\s*:\s*(.+)$/);
          if (themeMatch) {
            const nodesPart = themeMatch[1];
            const reason = themeMatch[2].trim();
            
            // Extract all node IDs from the pattern [X]--[Y]--[Z]
            const nodeMatches = nodesPart.matchAll(/\[([A-Z\d]+)\]/g);
            const nodes: string[] = [];
            for (const m of nodeMatches) {
              nodes.push(m[1]);
            }
            
            if (nodes.length > 0) {
              // Create unique key for theme (sorted nodes)
              const themeKey = nodes.slice().sort().join('--');
              
              // Only add if not seen before
              if (!seenThemes.has(themeKey)) {
                conceptMapData.themes.push({ nodes, reason });
                seenThemes.add(themeKey);
              }
            }
          }
        }
      }
    }

    // Post-processing: Remove orphaned nodes and validate relations
    const allValidIds = new Set([
      ...conceptMapData.innerCircle.map(n => n.id),
      ...conceptMapData.outerCircle.map(n => n.id)
    ]);

    // Filter relations to only include those with valid node IDs
    conceptMapData.relations = conceptMapData.relations.filter(rel => 
      allValidIds.has(rel.from) && allValidIds.has(rel.to)
    );

    // Filter themes to only include those with all valid node IDs
    conceptMapData.themes = conceptMapData.themes.filter(theme =>
      theme.nodes.every(nodeId => allValidIds.has(nodeId))
    );

    return conceptMapData;
  }

  private detectMissingSections(responseText: string): string[] {
    const missing: string[] = [];
    
    if (!responseText.includes('## Inner Circle')) {
      missing.push('inner');
    }
    if (!responseText.includes('### Outer Circle')) {
      missing.push('outer');
    }
    if (!responseText.includes('#### Relations')) {
      missing.push('relations');
    } else {
      // Check if there are enough relations
      const relationMatches = responseText.match(/\[[A-Z\d]+\]<->\[[A-Z\d]+\]/g);
      if (!relationMatches || relationMatches.length < 5) {
        missing.push('more-relations');
      }
    }
    
    if (!responseText.includes('##### Themes')) {
      missing.push('themes');
    } else {
      // Check if there are actual theme entries
      const themeMatches = responseText.match(/\[[A-Z\d]+\]--\[[A-Z\d]+\]/g);
      if (!themeMatches || themeMatches.length < 2) {
        missing.push('more-themes');
      }
    }
    
    return missing;
  }

  private buildContinuationPrompt(existingText: string, missingSections: string[]): string {
    if (missingSections.length === 0) {
      return 'Continue from where you left off and complete the concept map.';
    }
    
    let prompt = 'The concept map is incomplete. ';
    
    if (missingSections.includes('inner')) {
      prompt += 'Add the ## Inner Circle section with core concepts. ';
    }
    if (missingSections.includes('outer')) {
      prompt += 'Add the ### Outer Circle section with applications and examples. ';
    }
    if (missingSections.includes('relations')) {
      prompt += 'Add the #### Relations section with detailed connections between nodes. ';
    }
    if (missingSections.includes('more-relations')) {
      prompt += 'Add MORE relations (at least 10 total) with deep, meaningful explanations. ';
    }
    if (missingSections.includes('themes')) {
      prompt += 'Add the ##### Themes section. This is CRITICAL and MANDATORY. ';
    }
    if (missingSections.includes('more-themes')) {
      prompt += 'Add MORE themes (at least 3 total) that group related nodes with clear explanations. ';
    }
    
    prompt += '\n\n**IMPORTANT FOR THEMES:**\n';
    prompt += '- Themes MUST follow this format: [A]--[B]--[1] : Explanation\n';
    prompt += '- Each theme should connect 3-4 nodes from different circles or same circle based on common theme, FIND THE COMMON THEMES FROM AMONG THE NODES ALWAYS and CONNECT THE NODES HAVING THE SAME THEME\n';
    prompt += '- Explain the unifying principle or pattern\n';
    prompt += '- Do NOT include node IDs like [A], [B] in the explanation text\n';
    prompt += '- Example: [A]--[C]--[2]--[D] : These concepts share a common foundation in information processing\n\n';
    
    prompt += 'Continue from the existing structure:\n\n';
    prompt += existingText;
    prompt += '\n\n[CONTINUE WITH MISSING SECTIONS]';
    
    return prompt;
  }

  private cleanContinuation(existingText: string, continuation: string): string {
    // Remove duplicate section headers that might appear in continuation
    const sectionHeaders = [
      '# ',
      '## Inner Circle',
      '### Outer Circle',
      '#### Relations',
      '##### Themes'
    ];
    
    const lines = continuation.split('\n');
    const cleanedLines: string[] = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Check if this is a duplicate section header
      let isDuplicateHeader = false;
      for (const header of sectionHeaders) {
        if (trimmed.startsWith(header) && existingText.includes(trimmed)) {
          isDuplicateHeader = true;
          break;
        }
      }
      
      // Only add if not a duplicate header
      if (!isDuplicateHeader) {
        cleanedLines.push(line);
      }
    }
    
    return cleanedLines.join('\n');
  }

  private checkResponseComplete(responseText: string): boolean {
    // Check if response has all required sections
    const hasInnerCircle = responseText.includes('## Inner Circle');
    const hasOuterCircle = responseText.includes('### Outer Circle');
    const hasRelations = responseText.includes('#### Relations');
    const hasThemes = responseText.includes('##### Themes');
    
    // Check if there are actual relations (at least 5)
    const relationMatches = responseText.match(/\[[A-Z\d]+\]<->\[[A-Z\d]+\]/g);
    const hasEnoughRelations = relationMatches ? relationMatches.length >= 5 : false;
    
    // Check if there are actual themes (at least 2)
    const themeMatches = responseText.match(/\[[A-Z\d]+\]--\[[A-Z\d]+\]/g);
    const hasEnoughThemes = themeMatches ? themeMatches.length >= 2 : false;
    
    return hasInnerCircle && hasOuterCircle && hasRelations && hasThemes && hasEnoughRelations && hasEnoughThemes;
  }

  async saveConceptMap(conceptMapData: ConceptMapData, name: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `ConceptMap-${name}-${timestamp}.md`;
    // Always save to master data folder to hide internal structure
    const dir = '.Nexus-LM-data/tutor-conceptmaps';
    const filePath = normalizePath(`${dir}/${filename}`);

    
    // Create parent directory first if needed
    const parentDir = '.Nexus-LM-data';
    const parentDirPath = this.app.vault.getAbstractFileByPath(parentDir);
    if (!parentDirPath) {
      try {
                await this.app.vault.adapter.mkdir(parentDir);
      } catch (error) {
                // Continue anyway, it might already exist
      }
    }

    // Create subdirectory if needed
    const dirPath = this.app.vault.getAbstractFileByPath(dir);
    if (!dirPath) {
      try {
                await this.app.vault.adapter.mkdir(dir);
      } catch (error) {
                throw new Error(`Failed to create directory: ${dir}`);
      }
    }

    // Generate markdown content
    const content = this.generateMarkdownContent(conceptMapData);

    // Save the concept map file
    await this.app.vault.create(filePath, content);
        return filePath;
  }

  private generateMarkdownContent(data: ConceptMapData): string {
    const lines: string[] = [];
    
    lines.push(`# ${data.noteName}`);
    lines.push('');
    lines.push('## Inner Circle');
    data.innerCircle.forEach(node => {
      lines.push(`- ${node.label} [${node.id}]`);
    });
    lines.push('');
    lines.push('### Outer Circle');
    data.outerCircle.forEach(node => {
      lines.push(`- ${node.label} [${node.id}]`);
    });
    lines.push('');
    lines.push('#### Relations');
    data.relations.forEach(rel => {
      lines.push(`- [${rel.from}]<->[${rel.to}] : ${rel.reason}`);
    });
    lines.push('');
    lines.push('##### Themes');
    data.themes.forEach(theme => {
      const nodeStr = theme.nodes.map(n => `[${n}]`).join('--');
      lines.push(`- ${nodeStr} : ${theme.reason}`);
    });
    
    return lines.join('\n');
  }

  async openConceptMapVisualization(conceptMapData: ConceptMapData, name: string) {
    // Open the concept map in a modal with interactive visualization
    const modal = new ConceptMapVisualizationModal(this.app, conceptMapData, name);
    modal.open();
  }

  renderConceptMapSVG(data: ConceptMapData): SVGElement {
    const width = 1600;
    const height = 1200;
    const centerX = width / 2;
    const centerY = height / 2;
    const innerRadius = 250;
    const outerRadius = 480;

    // Define theme colors for highlighting
    const themeColors = [
      { glow: '#9333ea', label: 'rgba(147, 51, 234, 0.9)' },
      { glow: '#3b82f6', label: 'rgba(59, 130, 246, 0.9)' },
      { glow: '#10b981', label: 'rgba(16, 185, 129, 0.9)' },
      { glow: '#f59e0b', label: 'rgba(245, 158, 11, 0.9)' },
      { glow: '#ef4444', label: 'rgba(239, 68, 68, 0.9)' },
      { glow: '#ec4899', label: 'rgba(236, 72, 153, 0.9)' },
    ];

    // Default node color (consistent for all nodes initially)
    const defaultNodeColor = '#7c3aed';

    // Create SVG element
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', width.toString());
    svg.setAttribute('height', height.toString());
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.addClass('nl-background-var--background-primary');

    // Add styles
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `
      .concept-circle { fill: none; stroke: rgba(100, 100, 100, 0.5); stroke-width: 2.5; transition: opacity 0.3s; }
      .concept-node { cursor: pointer; transition: opacity 0.3s; }
      .concept-node-circle { transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1); }
      .concept-node-circle.highlighted { filter: drop-shadow(0 0 8px currentColor) brightness(1.3); }
      .concept-node-circle.faded { opacity: 0.15; }
      .concept-node-circle.clicked { filter: drop-shadow(0 0 10px currentColor) brightness(1.4); transform: scale(1.2); }
      .concept-node-circle[data-no-theme="true"] { fill: none; stroke-width: 2; }
      .concept-node-circle[data-no-theme="true"].highlighted { filter: drop-shadow(0 0 8px currentColor); stroke-width: 2.5; }
      .concept-node-circle[data-no-theme="true"].clicked { filter: drop-shadow(0 0 10px currentColor); transform: scale(1.2); stroke-width: 2.5; }
      .concept-node-text { fill: var(--text-normal); font-size: 14px; font-family: var(--font-interface); font-weight: 600; transition: opacity 0.3s; text-shadow: 0 0 3px var(--background-primary); }
      .concept-node-text.faded { opacity: 0.15; }
      .concept-center-text { fill: var(--text-normal); font-size: 15px; font-weight: 700; text-anchor: middle; font-family: var(--font-interface); transition: opacity 0.3s; opacity: 0.8; text-shadow: 0 0 4px var(--background-primary); }
      .concept-relation-line { stroke: rgba(150, 150, 150, 0.4); stroke-width: 1.5; fill: none; transition: opacity 0.3s; }
      .concept-relation-line.faded { opacity: 0.1; }
      .concept-relation-line.highlighted { opacity: 1; stroke: rgba(150, 150, 150, 0.8); stroke-width: 2; }
      .concept-relation-node { fill: var(--background-secondary); stroke: rgba(150, 150, 150, 0.6); cursor: pointer; stroke-width: 2; transition: opacity 0.3s; }
      .concept-relation-node.faded { opacity: 0.1; }
      .concept-relation-node.highlighted { opacity: 1; }
      .concept-theme-info { position: absolute; background: var(--background-secondary); border: 2px solid var(--interactive-accent); padding: 12px 16px; border-radius: 8px; font-size: 13px; max-width: 350px; pointer-events: none; z-index: 1000; box-shadow: 0 4px 12px rgba(0,0,0,0.2); font-weight: 500; }
      .concept-tooltip { position: absolute; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); padding: 8px 12px; border-radius: 4px; font-size: 12px; max-width: 300px; pointer-events: none; z-index: 1000; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
    `;
    svg.appendChild(style);

    // Add defs
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.appendChild(defs);

    // Build theme map (node ID -> theme index)
    const nodeThemeMap = new Map<string, number>();
    data.themes.forEach((theme, themeIdx) => {
      theme.nodes.forEach(nodeId => {
        if (!nodeThemeMap.has(nodeId)) {
          nodeThemeMap.set(nodeId, themeIdx);
        }
      });
    });

    // Calculate node positions with even distribution (no clustering)
    const innerPositions = this.calculateEvenNodePositions(
      data.innerCircle,
      innerRadius,
      centerX,
      centerY
    );
    const outerPositions = this.calculateEvenNodePositions(
      data.outerCircle,
      outerRadius,
      centerX,
      centerY
    );

    // Draw inner circle
    const innerCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    innerCircle.setAttribute('class', 'concept-circle');
    innerCircle.setAttribute('cx', centerX.toString());
    innerCircle.setAttribute('cy', centerY.toString());
    innerCircle.setAttribute('r', innerRadius.toString());
    svg.appendChild(innerCircle);

    // Draw outer circle
    const outerCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    outerCircle.setAttribute('class', 'concept-circle');
    outerCircle.setAttribute('cx', centerX.toString());
    outerCircle.setAttribute('cy', centerY.toString());
    outerCircle.setAttribute('r', outerRadius.toString());
    svg.appendChild(outerCircle);

    // Draw center text (note name) with wrapping
    this.drawCenterText(svg, data.noteName, centerX, centerY);

    // No theme circles - themes revealed on hover

    // Collect relation node positions for overlap avoidance
    const relationNodePositions: Array<{ x: number; y: number }> = [];

    // Draw relations (connections between nodes) with improved curvature
    data.relations.forEach(relation => {
      const fromNode = innerPositions.find((p: { id: string }) => p.id === relation.from) || outerPositions.find((p: { id: string }) => p.id === relation.from);
      const toNode = innerPositions.find((p: { id: string }) => p.id === relation.to) || outerPositions.find((p: { id: string }) => p.id === relation.to);
      
      if (fromNode && toNode) {
        // Calculate control point for curved path that avoids center
        const dx = toNode.x - fromNode.x;
        const dy = toNode.y - fromNode.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        // Calculate perpendicular offset to curve the line away from center
        const midX = (fromNode.x + toNode.x) / 2;
        const midY = (fromNode.y + toNode.y) / 2;
        
        // Vector from center to midpoint
        const centerToMidX = midX - centerX;
        const centerToMidY = midY - centerY;
        const centerDist = Math.sqrt(centerToMidX * centerToMidX + centerToMidY * centerToMidY);
        
        // Curve outward (away from center) with adaptive curvature
        const curveFactor = Math.min(distance * 0.3, 80);
        const controlX = midX + (centerToMidX / centerDist) * curveFactor;
        const controlY = midY + (centerToMidY / centerDist) * curveFactor;
        
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const d = `M ${fromNode.x} ${fromNode.y} Q ${controlX} ${controlY} ${toNode.x} ${toNode.y}`;
        path.setAttribute('class', 'concept-relation-line');
        path.setAttribute('d', d);
        path.setAttribute('data-from', relation.from);
        path.setAttribute('data-to', relation.to);
        svg.appendChild(path);
        
        // Calculate point on the quadratic curve for relation node (at t=0.5)
        const t = 0.5;
        const curveX = (1-t)*(1-t)*fromNode.x + 2*(1-t)*t*controlX + t*t*toNode.x;
        const curveY = (1-t)*(1-t)*fromNode.y + 2*(1-t)*t*controlY + t*t*toNode.y;
        
        // Store relation node position for text overlap avoidance
        relationNodePositions.push({ x: curveX, y: curveY });
        
        // Draw relation node on the curve
        const relNode = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        relNode.setAttribute('class', 'concept-relation-node');
        relNode.setAttribute('cx', curveX.toString());
        relNode.setAttribute('cy', curveY.toString());
        relNode.setAttribute('r', '6');
        relNode.setAttribute('data-reason', relation.reason);
        relNode.setAttribute('data-from', relation.from);
        relNode.setAttribute('data-to', relation.to);
        
        // Add relation node hover interaction (works even in clicked state)
        relNode.addEventListener('mouseenter', (e: MouseEvent) => {
          // Store clicked state temporarily
          const wasClicked = this.clickedNodeId;
          if (!wasClicked) {
            // Normal hover - highlight relation
            this.highlightRelation(svg, relation.from, relation.to, relation.reason, e.clientX, e.clientY);
          } else {
            // Clicked state - show relation tooltip avoiding joined nodes
            this.showRelationTooltip(relation.reason, '#888', svg, relation.from, relation.to, e.clientX, e.clientY);
          }
        });
        relNode.addEventListener('mouseleave', () => {
          if (!this.clickedNodeId) {
            // Only clear if no node is clicked
            this.clearHighlight(svg);
          } else {
            // Just hide tooltip, keep clicked state
            this.hideThemeInfo();
          }
        });
        
        svg.appendChild(relNode);
      }
    });

    // Collect all text positions for overlap detection
    const textPositions: Array<{ x: number; y: number; width: number; height: number; label: string }> = [];
    
    // Collect all node positions (for text overlap with other nodes)
    const allNodePositions: Array<{ x: number; y: number }> = [
      ...innerPositions.map(p => ({ x: p.x, y: p.y })),
      ...outerPositions.map(p => ({ x: p.x, y: p.y }))
    ];

    // Draw inner circle nodes (all same color initially)
    innerPositions.forEach((pos: { id: string; x: number; y: number; label: string }) => {
      const themeIdx = nodeThemeMap.get(pos.id) ?? -1;
      const themeColor = themeIdx >= 0 ? themeColors[themeIdx % themeColors.length] : null;
      this.drawInteractiveNode(svg, pos.x, pos.y, pos.label, pos.id, 'inner', defaultNodeColor, themeIdx, themeColor, textPositions, relationNodePositions, allNodePositions, centerX, centerY, data.themes, nodeThemeMap, themeColors, data.relations);
    });

    // Draw outer circle nodes (all same color initially)
    outerPositions.forEach((pos: { id: string; x: number; y: number; label: string }) => {
      const themeIdx = nodeThemeMap.get(pos.id) ?? -1;
      const themeColor = themeIdx >= 0 ? themeColors[themeIdx % themeColors.length] : null;
      this.drawInteractiveNode(svg, pos.x, pos.y, pos.label, pos.id, 'outer', defaultNodeColor, themeIdx, themeColor, textPositions, relationNodePositions, allNodePositions, centerX, centerY, data.themes, nodeThemeMap, themeColors, data.relations);
    });

    // Add click handler to SVG background to clear selection
    svg.addEventListener('click', (e) => {
      if (this.clickedNodeId) {
        this.clickedNodeId = null;
        this.clearHighlight(svg);
      }
      // Clear theme click state
      if (this.clickedThemeIdx !== null) {
        this.clickedThemeIdx = null;
        this.clearThemeOverlay();
        this.clearHighlight(svg);
      }
    });

    return svg;
  }

  private calculateImprovedNodePositions(
    innerCircle: Array<{ label: string; id: string }>,
    outerCircle: Array<{ label: string; id: string }>,
    innerRadius: number,
    outerRadius: number,
    centerX: number,
    centerY: number,
    themes: Array<{ nodes: string[]; reason: string }>
  ): {
    innerPositions: Array<{ x: number; y: number; label: string; id: string }>;
    outerPositions: Array<{ x: number; y: number; label: string; id: string }>;
    nodeThemeMap: Map<string, number>;
  } {
    const nodeThemeMap = new Map<string, number>();
    
    // First pass: Map each node to its theme
    themes.forEach((theme, themeIdx) => {
      theme.nodes.forEach(nodeId => {
        if (!nodeThemeMap.has(nodeId)) {
          nodeThemeMap.set(nodeId, themeIdx);
        }
      });
    });

    // Group nodes by theme for both circles
    const themeGroups: Map<number, { inner: string[]; outer: string[] }> = new Map();
    const ungroupedInner: string[] = [];
    const ungroupedOuter: string[] = [];
    
    // Group inner circle nodes
    innerCircle.forEach(node => {
      const themeIdx = nodeThemeMap.get(node.id);
      if (themeIdx !== undefined) {
        if (!themeGroups.has(themeIdx)) {
          themeGroups.set(themeIdx, { inner: [], outer: [] });
        }
        themeGroups.get(themeIdx)!.inner.push(node.id);
      } else {
        ungroupedInner.push(node.id);
      }
    });
    
    // Group outer circle nodes
    outerCircle.forEach(node => {
      const themeIdx = nodeThemeMap.get(node.id);
      if (themeIdx !== undefined) {
        if (!themeGroups.has(themeIdx)) {
          themeGroups.set(themeIdx, { inner: [], outer: [] });
        }
        themeGroups.get(themeIdx)!.outer.push(node.id);
      } else {
        ungroupedOuter.push(node.id);
      }
    });

    // Calculate angular space needed for each theme
    const themeAngles: Map<number, number> = new Map();
    let totalAngularSpace = 0;
    
    themeGroups.forEach((group, themeIdx) => {
      // Each theme gets space proportional to the max of inner/outer nodes
      const maxNodes = Math.max(group.inner.length, group.outer.length);
      const angularSpace = maxNodes * (2 * Math.PI / (innerCircle.length + outerCircle.length));
      themeAngles.set(themeIdx, angularSpace);
      totalAngularSpace += angularSpace;
    });
    
    // Position nodes theme by theme
    const innerPositions: Array<{ x: number; y: number; label: string; id: string }> = [];
    const outerPositions: Array<{ x: number; y: number; label: string; id: string }> = [];
    
    let currentAngle = -Math.PI / 2; // Start at top
    
    // Place themed groups with nodes clustered together
    Array.from(themeGroups.entries()).forEach(([themeIdx, group]) => {
      const themeAngle = themeAngles.get(themeIdx) || 0;
      const baseAngle = currentAngle + themeAngle / 2;
      
      // Place inner circle nodes for this theme
      const innerCount = group.inner.length;
      if (innerCount > 0) {
        const innerAngleStep = innerCount > 1 ? themeAngle / (innerCount + 1) : 0;
        group.inner.forEach((nodeId, idx) => {
          const node = innerCircle.find(n => n.id === nodeId);
          if (node) {
            const angle = baseAngle - themeAngle/2 + (idx + 1) * innerAngleStep;
            const x = centerX + innerRadius * Math.cos(angle);
            const y = centerY + innerRadius * Math.sin(angle);
            innerPositions.push({ x, y, label: node.label, id: node.id });
          }
        });
      }
      
      // Place outer circle nodes for this theme
      const outerCount = group.outer.length;
      if (outerCount > 0) {
        const outerAngleStep = outerCount > 1 ? themeAngle / (outerCount + 1) : 0;
        group.outer.forEach((nodeId, idx) => {
          const node = outerCircle.find(n => n.id === nodeId);
          if (node) {
            const angle = baseAngle - themeAngle/2 + (idx + 1) * outerAngleStep;
            const x = centerX + outerRadius * Math.cos(angle);
            const y = centerY + outerRadius * Math.sin(angle);
            outerPositions.push({ x, y, label: node.label, id: node.id });
          }
        });
      }
      
      currentAngle += themeAngle;
    });
    
    // Place ungrouped nodes
    const remainingAngle = 2 * Math.PI - totalAngularSpace;
    const ungroupedTotalNodes = ungroupedInner.length + ungroupedOuter.length;
    
    if (ungroupedTotalNodes > 0) {
      const ungroupedAngleStep = remainingAngle / ungroupedTotalNodes;
      
      ungroupedInner.forEach((nodeId) => {
        const node = innerCircle.find(n => n.id === nodeId);
        if (node) {
          const x = centerX + innerRadius * Math.cos(currentAngle);
          const y = centerY + innerRadius * Math.sin(currentAngle);
          innerPositions.push({ x, y, label: node.label, id: node.id });
          currentAngle += ungroupedAngleStep;
        }
      });
      
      ungroupedOuter.forEach((nodeId) => {
        const node = outerCircle.find(n => n.id === nodeId);
        if (node) {
          const x = centerX + outerRadius * Math.cos(currentAngle);
          const y = centerY + outerRadius * Math.sin(currentAngle);
          outerPositions.push({ x, y, label: node.label, id: node.id });
          currentAngle += ungroupedAngleStep;
        }
      });
    }
    
    return { innerPositions, outerPositions, nodeThemeMap };
  }

  private drawNode(
    svg: SVGElement,
    x: number,
    y: number,
    label: string,
    type: 'inner' | 'outer',
    color: string,
    textPositions: Array<{ x: number; y: number; width: number; height: number; label: string }>,
    centerX: number,
    centerY: number
  ) {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'concept-node');
    
    // Draw circle with themed color
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('class', 'concept-node-circle');
    circle.setAttribute('cx', x.toString());
    circle.setAttribute('cy', y.toString());
    circle.setAttribute('r', '8');
    circle.setAttribute('fill', color);
    group.appendChild(circle);
    
    // Calculate text position with overlap avoidance
    const angle = Math.atan2(y - centerY, x - centerX);
    
    // Try different offsets to avoid overlap
    let textOffset = 20;
    let textX = x + Math.cos(angle) * textOffset;
    let textY = y + Math.sin(angle) * textOffset;
    
    // Estimate text dimensions (rough approximation)
    const charWidth = 7;
    const textWidth = label.length * charWidth;
    const textHeight = 14;
    
    // Check for overlaps and adjust if needed
    let attempts = 0;
    const maxAttempts = 5;
    while (attempts < maxAttempts) {
      let hasOverlap = false;
      
      for (const existing of textPositions) {
        const dx = Math.abs(textX - existing.x);
        const dy = Math.abs(textY - existing.y);
        
        if (dx < (textWidth + existing.width) / 2 + 5 && dy < (textHeight + existing.height) / 2 + 5) {
          hasOverlap = true;
          break;
        }
      }
      
      if (!hasOverlap) {
        break;
      }
      
      // Try increasing offset
      attempts++;
      textOffset += 8;
      textX = x + Math.cos(angle) * textOffset;
      textY = y + Math.sin(angle) * textOffset;
    }
    
    // Store this text position
    textPositions.push({ x: textX, y: textY, width: textWidth, height: textHeight, label });
    
    // Create text element
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('class', 'concept-node-text');
    text.setAttribute('x', textX.toString());
    text.setAttribute('y', textY.toString());
    text.setAttribute('text-anchor', x > centerX ? 'start' : 'end');
    text.setAttribute('dominant-baseline', 'middle');
    text.textContent = label;
    group.appendChild(text);
    
    svg.appendChild(group);
  }

  private tooltipEl?: HTMLElement;

  private showTooltip(event: MouseEvent, text: string, svg: SVGElement) {
    this.hideTooltip();
    
    const tooltip = document.createElement('div');
    tooltip.className = 'concept-tooltip';
    tooltip.textContent = text;
    document.body.appendChild(tooltip);
    this.tooltipEl = tooltip;
    
    // Position tooltip
    const rect = (event.target as Element).getBoundingClientRect();
    tooltip.setCssProps({ 'left':  `${rect.left + window.scrollX}px` });
    tooltip.setCssProps({ 'top':  `${rect.bottom + window.scrollY + 5}px` });
  }

  private hideTooltip() {
    if (this.tooltipEl) {
      this.tooltipEl.remove();
      this.tooltipEl = undefined;
    }
  }

  private calculateEvenNodePositions(
    nodes: Array<{ label: string; id: string }>,
    radius: number,
    centerX: number,
    centerY: number
  ): Array<{ x: number; y: number; label: string; id: string }> {
    const positions: Array<{ x: number; y: number; label: string; id: string }> = [];
    const totalNodes = nodes.length;
    const angleStep = (2 * Math.PI) / totalNodes;
    let currentAngle = -Math.PI / 2; // Start at top

    nodes.forEach(node => {
      const x = centerX + radius * Math.cos(currentAngle);
      const y = centerY + radius * Math.sin(currentAngle);
      positions.push({ x, y, label: node.label, id: node.id });
      currentAngle += angleStep;
    });

    return positions;
  }

  private drawInteractiveNode(
    svg: SVGElement,
    x: number,
    y: number,
    label: string,
    nodeId: string,
    type: 'inner' | 'outer',
    color: string,
    themeIdx: number,
    themeColor: SafeAny,
    textPositions: Array<{ x: number; y: number; width: number; height: number; label: string }>,
    relationNodePositions: Array<{ x: number; y: number }>,
    allNodePositions: Array<{ x: number; y: number }>,
    centerX: number,
    centerY: number,
    themes: Array<{ nodes: string[]; reason: string }>,
    nodeThemeMap: Map<string, number>,
    themeColors: Array<SafeAny>,
    relations: Array<{ from: string; to: string; reason: string }>
  ) {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'concept-node');
    group.setAttribute('data-node-id', nodeId);
    
    // Draw circle with default color
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('class', 'concept-node-circle');
    circle.setAttribute('cx', x.toString());
    circle.setAttribute('cy', y.toString());
    circle.setAttribute('r', '8');
    
    // Make nodes without themes hollow (stroke only, no fill)
    if (themeIdx >= 0) {
      // Color nodes belonging to a theme with the theme's glow color
      const nodeColor = themeColor ? themeColor.glow : color;
      circle.setAttribute('fill', nodeColor);
      circle.setAttribute('data-theme-idx', themeIdx.toString());
      circle.setAttribute('data-theme-color', themeColor.glow);
    } else {
      // Hollow style for nodes without themes
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', color);
      circle.setAttribute('stroke-width', '2');
      circle.setAttribute('data-no-theme', 'true');
    }
    
    circle.setAttribute('data-node-id', nodeId);
    group.appendChild(circle);
    
    // Calculate text position with comprehensive overlap avoidance
    const angle = Math.atan2(y - centerY, x - centerX);
    
    // Try different offsets to avoid overlap
    let textOffset = 20;
    let textX = x + Math.cos(angle) * textOffset;
    let textY = y + Math.sin(angle) * textOffset;
    
    // Estimate text dimensions (rough approximation)
    const charWidth = 7;
    const textWidth = label.length * charWidth;
    const textHeight = 14;
    
    // Check for overlaps and adjust if needed
    let attempts = 0;
    const maxAttempts = 8;
    while (attempts < maxAttempts) {
      let hasOverlap = false;
      
      // Check overlap with existing text
      for (const existing of textPositions) {
        const dx = Math.abs(textX - existing.x);
        const dy = Math.abs(textY - existing.y);
        
        if (dx < (textWidth + existing.width) / 2 + 5 && dy < (textHeight + existing.height) / 2 + 5) {
          hasOverlap = true;
          break;
        }
      }
      
      // Check overlap with relation nodes
      if (!hasOverlap) {
        for (const relNode of relationNodePositions) {
          const dist = Math.sqrt((textX - relNode.x) ** 2 + (textY - relNode.y) ** 2);
          if (dist < 25) { // Min distance from relation nodes
            hasOverlap = true;
            break;
          }
        }
      }
      
      // Check overlap with other circle nodes (not the current node)
      if (!hasOverlap) {
        for (const otherNode of allNodePositions) {
          if (Math.abs(otherNode.x - x) < 1 && Math.abs(otherNode.y - y) < 1) continue; // Skip self
          const dist = Math.sqrt((textX - otherNode.x) ** 2 + (textY - otherNode.y) ** 2);
          if (dist < 20) { // Min distance from other nodes
            hasOverlap = true;
            break;
          }
        }
      }
      
      if (!hasOverlap) {
        break;
      }
      
      // Try increasing offset
      attempts++;
      textOffset += 10;
      textX = x + Math.cos(angle) * textOffset;
      textY = y + Math.sin(angle) * textOffset;
    }
    
    // Store this text position
    textPositions.push({ x: textX, y: textY, width: textWidth, height: textHeight, label });
    
    // Create text element
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('class', 'concept-node-text');
    text.setAttribute('x', textX.toString());
    text.setAttribute('y', textY.toString());
    text.setAttribute('text-anchor', x > centerX ? 'start' : 'end');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('data-node-id', nodeId);
    text.textContent = label;
    group.appendChild(text);
    
    // Add hover interaction for theme highlighting
    group.addEventListener('mouseenter', (e: MouseEvent) => {
      // Only highlight theme if no node is clicked
      if (!this.clickedNodeId && themeIdx >= 0) {
        this.highlightTheme(svg, themeIdx, themes[themeIdx].reason, themeColor.glow, nodeThemeMap, e.clientX, e.clientY);
      }
    });
    
    // Add MOUSEDOWN to start hold timer for theme nodes
    group.addEventListener('mousedown', (e) => {
      if (themeIdx >= 0) {
        // Start hold timer for theme nodes
        this.isHolding = false;
        
        // Visual feedback: start pulsing/scaling immediately
        const circle = group.querySelector('.concept-node-circle') as SVGElement;
        if (circle) {
          circle.addClass('nl-transform-scale11');
          circle.addClass('nl-transition-remaining-1');
          circle.setCssProps({ 'filter':  `drop-shadow(0 0 12px ${themeColor.glow}) brightness(1.4)` });
        }
        
        this.holdTimer = setTimeout(() => {
          this.isHolding = true;
          // Store the fired node for later restoration
          this.firedThemeNode = circle;
          
          // Prevent the subsequent click event globally (capturing phase)
          const preventNextClick = (clickEvent: Event) => {
            clickEvent.stopPropagation();
            clickEvent.preventDefault();
            document.removeEventListener('click', preventNextClick, true);
          };
          document.addEventListener('click', preventNextClick, true);
          
          // Show theme overlay after holding for 500ms
          this.clickedThemeIdx = themeIdx;
          this.showThemeNodeOverlay(svg, themeIdx, themes[themeIdx].reason, themeColor.glow, nodeThemeMap);
          
          // Extra scale on trigger
          if (circle) {
            circle.addClass('nl-transform-scale12');
          }
        }, 500);
      }
    });
    
    // Add MOUSEUP to clear hold timer
    group.addEventListener('mouseup', (e) => {
      if (this.holdTimer) {
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
      }
      
      // Only reset if overlay is NOT showing
      // If overlay is showing (isHolding = true), keep the node fired until overlay closes
      const circle = group.querySelector('.concept-node-circle') as SVGElement;
      if (circle && !this.isHolding) {
        circle.addClass('nl-transform-');
        circle.addClass('nl-filter-');
        circle.addClass('nl-transition-rem-1');
      }
    });
    
    // Add MOUSELEAVE to cancel hold
    group.addEventListener('mouseleave', (e) => {
      if (this.holdTimer) {
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
      }
      
      // Reset scale and filter
      const circle = group.querySelector('.concept-node-circle') as SVGElement;
      if (circle && !this.isHolding) {
        circle.addClass('nl-transform-');
        circle.addClass('nl-filter-');
        circle.addClass('nl-transition-rem-2');
      }
      
      // Only clear if no node or theme is clicked
      if (!this.clickedNodeId && this.clickedThemeIdx === null) {
        this.clearHighlight(svg);
      }
    });
    
    // Add DOUBLE-CLICK interaction to show connections
    group.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      
      // Clear hold timer if it's running
      if (this.holdTimer) {
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
      }
      
      // Reset isHolding flag
      this.isHolding = false;
      
      if (this.clickedNodeId === nodeId) {
        // Double-clicking same node again - deselect
        this.clickedNodeId = null;
        this.clearHighlight(svg);
      } else {
        // Double-clicking new node - show connections
        this.clickedNodeId = nodeId;
        this.highlightConnections(svg, nodeId, relations);
      }
    });
    
    svg.appendChild(group);
  }

  private themeInfoEl?: HTMLElement;

  private highlightTheme(
    svg: SVGElement,
    themeIdx: number,
    themeReason: string,
    glowColor: string,
    nodeThemeMap: Map<string, number>,
    mouseX?: number,
    mouseY?: number
  ) {
    // Hover only shows glow, no text box, no auto-zoom
    // Fade everything first
    const allNodes = svg.querySelectorAll('.concept-node-circle');
    const allTexts = svg.querySelectorAll('.concept-node-text');
    const allRelations = svg.querySelectorAll('.concept-relation-line');
    const allRelationNodes = svg.querySelectorAll('.concept-relation-node');
    const centerText = svg.querySelector('.concept-center-text');
    const circles = svg.querySelectorAll('.concept-circle');

    allNodes.forEach(node => node.classList.add('faded'));
    allTexts.forEach(text => text.classList.add('faded'));
    allRelations.forEach(rel => rel.classList.add('faded'));
    allRelationNodes.forEach(node => node.classList.add('faded'));
    if (centerText) centerText.classList.add('faded');
    circles.forEach(circle => (circle as SVGElement).addClass('nl-opacity-03'));

    // Highlight nodes in the same theme
    allNodes.forEach(node => {
      const nodeThemeIdxStr = node.getAttribute('data-theme-idx');
      if (nodeThemeIdxStr && parseInt(nodeThemeIdxStr) === themeIdx) {
        node.classList.remove('faded');
        node.classList.add('highlighted');
        // Apply glow color
        (node as SVGElement).setCssProps({ 'color':  glowColor });
        
        // Also highlight the text
        const nodeId = node.getAttribute('data-node-id');
        if (nodeId) {
          const textEl = svg.querySelector(`.concept-node-text[data-node-id="${nodeId}"]`);
          if (textEl) {
            textEl.classList.remove('faded');
          }
        }
      }
    });

    // Hover does NOT show text box - only glow effect
    // Text box will only appear on click
  }

  private highlightRelation(
    svg: SVGElement,
    fromId: string,
    toId: string,
    reason: string,
    mouseX?: number,
    mouseY?: number
  ) {
    // Fade everything
    const allNodes = svg.querySelectorAll('.concept-node-circle');
    const allTexts = svg.querySelectorAll('.concept-node-text');
    const allRelations = svg.querySelectorAll('.concept-relation-line');
    const allRelationNodes = svg.querySelectorAll('.concept-relation-node');
    const centerText = svg.querySelector('.concept-center-text');
    const circles = svg.querySelectorAll('.concept-circle');

    allNodes.forEach(node => node.classList.add('faded'));
    allTexts.forEach(text => text.classList.add('faded'));
    allRelations.forEach(rel => rel.classList.add('faded'));
    allRelationNodes.forEach(node => node.classList.add('faded'));
    if (centerText) centerText.classList.add('faded');
    circles.forEach(circle => (circle as SVGElement).addClass('nl-opacity-03'));

    // Highlight only the connected nodes
    [fromId, toId].forEach(nodeId => {
      const nodeEl = svg.querySelector(`.concept-node-circle[data-node-id="${nodeId}"]`);
      const textEl = svg.querySelector(`.concept-node-text[data-node-id="${nodeId}"]`);
      if (nodeEl) {
        nodeEl.classList.remove('faded');
        nodeEl.classList.add('highlighted');
      }
      if (textEl) {
        textEl.classList.remove('faded');
      }
    });

    // Highlight the relation line
    const relationLine = svg.querySelector(`.concept-relation-line[data-from="${fromId}"][data-to="${toId}"]`);
    if (relationLine) {
      relationLine.classList.remove('faded');
      relationLine.classList.add('highlighted');
    }

    // Highlight the relation node
    const relationNode = svg.querySelector(`.concept-relation-node[data-from="${fromId}"][data-to="${toId}"]`);
    if (relationNode) {
      relationNode.classList.remove('faded');
      relationNode.classList.add('highlighted');
    }

    // Show tooltip for relation avoiding joined nodes
    if (mouseX !== undefined && mouseY !== undefined) {
      this.showRelationTooltip(reason, '#888', svg, fromId, toId, mouseX, mouseY);
    } else {
      this.showThemeInfo(reason, '#888', mouseX, mouseY, svg);
    }
  }

  private clearHighlight(svg: SVGElement) {
    // Remove all faded, highlighted, and clicked classes
    const allNodes = svg.querySelectorAll('.concept-node-circle');
    const allTexts = svg.querySelectorAll('.concept-node-text');
    const allRelations = svg.querySelectorAll('.concept-relation-line');
    const allRelationNodes = svg.querySelectorAll('.concept-relation-node');
    const centerText = svg.querySelector('.concept-center-text');
    const circles = svg.querySelectorAll('.concept-circle');

    allNodes.forEach(node => {
      node.classList.remove('faded', 'highlighted', 'clicked');
      (node as SVGElement).addClass('nl-color-');
    });
    allTexts.forEach(text => text.classList.remove('faded'));
    allRelations.forEach(rel => rel.classList.remove('faded', 'highlighted'));
    allRelationNodes.forEach(node => node.classList.remove('faded', 'highlighted'));
    if (centerText) centerText.classList.remove('faded');
    circles.forEach(circle => (circle as SVGElement).addClass('nl-opacity-'));

    // Hide theme info
    this.hideThemeInfo();
  }

  private svgContainerEl?: HTMLElement;

  private showThemeInfo(text: string, borderColor: string, mouseX?: number, mouseY?: number, svg?: SVGElement) {
    this.hideThemeInfo();
    
    const infoBox = document.createElement('div');
    infoBox.className = 'concept-theme-info';
    
    // Render markdown content
    this.renderMarkdownTooltip(text, infoBox);
    
    infoBox.setCssProps({ 'border-color':  borderColor });
    
    // Find the SVG container (modal body)
    const container = this.svgContainerEl || document.querySelector('.concept-map-svg-wrapper') as HTMLElement;
    if (!container) {
      document.body.appendChild(infoBox);
      this.themeInfoEl = infoBox;
      return;
    }
    
    container.appendChild(infoBox);
    this.themeInfoEl = infoBox;
    
    // Position dynamically inside the container
    const containerRect = container.getBoundingClientRect();
    const boxRect = infoBox.getBoundingClientRect();
    
    let left = 0;
    let top = 0;
    
    if (mouseX !== undefined && mouseY !== undefined) {
      // Position near mouse, but adjusted to stay inside container
      const relativeX = mouseX - containerRect.left;
      const relativeY = mouseY - containerRect.top;
      
      // Try positions: right-bottom, left-bottom, right-top, left-top
      const positions = [
        { x: relativeX + 15, y: relativeY + 15 }, // bottom-right of cursor
        { x: relativeX - boxRect.width - 15, y: relativeY + 15 }, // bottom-left
        { x: relativeX + 15, y: relativeY - boxRect.height - 15 }, // top-right
        { x: relativeX - boxRect.width - 15, y: relativeY - boxRect.height - 15 }, // top-left
      ];
      
      // Find first position that fits in container and avoids nodes
      let bestPos = positions[0];
      for (const pos of positions) {
        if (pos.x >= 10 && pos.x + boxRect.width <= containerRect.width - 10 &&
            pos.y >= 10 && pos.y + boxRect.height <= containerRect.height - 10 &&
            !this.checkTooltipNodeOverlap(pos, boxRect, svg, containerRect)) {
          bestPos = pos;
          break;
        }
      }
      
      // If no position avoids overlap, use the one with least overlap
      if (this.checkTooltipNodeOverlap(bestPos, boxRect, svg, containerRect)) {
        bestPos = this.findLeastOverlapPosition(positions, boxRect, svg, containerRect);
      }
      
      left = bestPos.x;
      top = bestPos.y;
    } else {
      // Fallback: center top of container
      left = (containerRect.width - boxRect.width) / 2;
      top = 20;
    }
    
    // Apply position
    infoBox.addClass('nl-position-absolute');
    infoBox.setCssProps({ 'left':  `${left}px` });
    infoBox.setCssProps({ 'top':  `${top}px` });
  }

  private hideThemeInfo() {
    if (this.themeInfoEl) {
      this.themeInfoEl.remove();
      this.themeInfoEl = undefined;
    }
  }

  private renderMarkdownTooltip(text: string, container: HTMLElement) {
    container.empty();
    // Use Obsidian's MarkdownRenderer for safe rendering
    MarkdownRenderer.render(this.app, text, container, '', null as SafeAny);
  }

  private checkTooltipNodeOverlap(
    position: { x: number; y: number },
    boxRect: DOMRect,
    svg?: SVGElement,
    containerRect?: DOMRect
  ): boolean {
    if (!svg || !containerRect) return false;

    const tooltipRect = {
      left: position.x,
      top: position.y,
      right: position.x + boxRect.width,
      bottom: position.y + boxRect.height
    };

    // Get all visible nodes in the SVG
    const nodes = svg.querySelectorAll('.concept-node-circle, .concept-relation-node');
    
    for (const node of nodes) {
      const nodeRect = (node as SVGElement).getBoundingClientRect();
      const relativeNodeRect = {
        left: nodeRect.left - containerRect.left,
        top: nodeRect.top - containerRect.top,
        right: nodeRect.right - containerRect.left,
        bottom: nodeRect.bottom - containerRect.top
      };

      // Add padding around nodes
      const padding = 20;
      const expandedNodeRect = {
        left: relativeNodeRect.left - padding,
        top: relativeNodeRect.top - padding,
        right: relativeNodeRect.right + padding,
        bottom: relativeNodeRect.bottom + padding
      };

      // Check overlap
      if (!(tooltipRect.right < expandedNodeRect.left ||
            tooltipRect.left > expandedNodeRect.right ||
            tooltipRect.bottom < expandedNodeRect.top ||
            tooltipRect.top > expandedNodeRect.bottom)) {
        return true; // Overlap detected
      }
    }

    return false;
  }

  private findLeastOverlapPosition(
    positions: Array<{ x: number; y: number }>,
    boxRect: DOMRect,
    svg?: SVGElement,
    containerRect?: DOMRect
  ): { x: number; y: number } {
    let bestPos = positions[0];
    let minOverlapArea = Infinity;

    for (const pos of positions) {
      const overlapArea = this.calculateOverlapArea(pos, boxRect, svg, containerRect);
      if (overlapArea < minOverlapArea) {
        minOverlapArea = overlapArea;
        bestPos = pos;
      }
    }

    return bestPos;
  }

  private calculateOverlapArea(
    position: { x: number; y: number },
    boxRect: DOMRect,
    svg?: SVGElement,
    containerRect?: DOMRect
  ): number {
    if (!svg || !containerRect) return 0;

    const tooltipRect = {
      left: position.x,
      top: position.y,
      right: position.x + boxRect.width,
      bottom: position.y + boxRect.height
    };

    let totalOverlap = 0;
    const nodes = svg.querySelectorAll('.concept-node-circle, .concept-relation-node');
    
    for (const node of nodes) {
      const nodeRect = (node as SVGElement).getBoundingClientRect();
      const relativeNodeRect = {
        left: nodeRect.left - containerRect.left,
        top: nodeRect.top - containerRect.top,
        right: nodeRect.right - containerRect.left,
        bottom: nodeRect.bottom - containerRect.top
      };

      const padding = 20;
      const expandedNodeRect = {
        left: relativeNodeRect.left - padding,
        top: relativeNodeRect.top - padding,
        right: relativeNodeRect.right + padding,
        bottom: relativeNodeRect.bottom + padding
      };

      // Calculate overlap area
      const overlapLeft = Math.max(tooltipRect.left, expandedNodeRect.left);
      const overlapTop = Math.max(tooltipRect.top, expandedNodeRect.top);
      const overlapRight = Math.min(tooltipRect.right, expandedNodeRect.right);
      const overlapBottom = Math.min(tooltipRect.bottom, expandedNodeRect.bottom);

      if (overlapLeft < overlapRight && overlapTop < overlapBottom) {
        totalOverlap += (overlapRight - overlapLeft) * (overlapBottom - overlapTop);
      }
    }

    return totalOverlap;
  }

  private autoZoomForThemeVisibility(
    svg: SVGElement,
    themeIdx: number,
    nodeThemeMap: Map<string, number>
  ): boolean {
    // Find the modal instance to access zoom methods
    const modal = document.querySelector('.concept-map-modal');
    if (!modal) return false;

    // Get all nodes belonging to this theme
    const themeNodeIds: string[] = [];
    nodeThemeMap.forEach((idx, nodeId) => {
      if (idx === themeIdx) {
        themeNodeIds.push(nodeId);
      }
    });

    if (themeNodeIds.length === 0) return false;

    // Get container and current viewport
    const container = document.querySelector('.concept-map-svg-wrapper') as HTMLElement;
    if (!container) return false;

    const containerRect = container.getBoundingClientRect();
    
    // Find bounding box of all theme nodes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasVisibleNodes = false;

    themeNodeIds.forEach(nodeId => {
      const nodeEl = svg.querySelector(`.concept-node-circle[data-node-id="${nodeId}"]`) as SVGElement;
      if (nodeEl) {
        const nodeRect = nodeEl.getBoundingClientRect();
        const relativeRect = {
          left: nodeRect.left - containerRect.left,
          top: nodeRect.top - containerRect.top,
          right: nodeRect.right - containerRect.left,
          bottom: nodeRect.bottom - containerRect.top
        };

        minX = Math.min(minX, relativeRect.left);
        minY = Math.min(minY, relativeRect.top);
        maxX = Math.max(maxX, relativeRect.right);
        maxY = Math.max(maxY, relativeRect.bottom);
        hasVisibleNodes = true;
      }
    });

    if (!hasVisibleNodes) return false;

    // Enhanced visibility check: nodes must be in viewport OR centered
    const padding = 80;
    const viewportRect = {
      left: padding,
      top: padding,
      right: containerRect.width - padding,
      bottom: containerRect.height - padding
    };

    // Check if all theme nodes are visible and reasonably centered
    const allNodesVisible = minX >= viewportRect.left && maxX <= viewportRect.right &&
                           minY >= viewportRect.top && maxY <= viewportRect.bottom;
    
    // Also check if nodes are reasonably centered (not too far to edges)
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const viewportCenterX = containerRect.width / 2;
    const viewportCenterY = containerRect.height / 2;
    const maxDistanceFromCenter = Math.min(containerRect.width, containerRect.height) * 0.3;
    
    const reasonablyCentered = Math.abs(centerX - viewportCenterX) < maxDistanceFromCenter &&
                              Math.abs(centerY - viewportCenterY) < maxDistanceFromCenter;

    if (!allNodesVisible || !reasonablyCentered) {
      // Calculate required zoom level to fit all nodes
      const themeWidth = maxX - minX + 2 * padding;
      const themeHeight = maxY - minY + 2 * padding;
      
      const scaleX = containerRect.width / themeWidth;
      const scaleY = containerRect.height / themeHeight;
      const targetZoom = Math.min(scaleX, scaleY, 1.0); // Don't zoom in, only out

      // Find the modal instance through the DOM
      const modalEl = modal.closest('.modal') as HTMLElement;
      const modalInstance = (modalEl as SafeAny)?._modalInstance || 
                           (window as SafeAny).activeConceptMapModal;
      
      if (modalInstance && modalInstance.zoomLevel > targetZoom) {
        // Smoothly zoom out to fit theme
        modalInstance.zoomLevel = targetZoom;
        modalInstance.panOffset = { x: 0, y: 0 }; // Reset pan
        modalInstance.updateTransform();
        modalInstance.updateZoomDisplay();

        // Center on theme nodes
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        
        // Adjust pan to center on theme
        modalInstance.panOffset.x = -centerX + containerRect.width / (2 * targetZoom);
        modalInstance.panOffset.y = -centerY + containerRect.height / (2 * targetZoom);
        modalInstance.updateTransform();
        
        return true; // Auto-zoom was applied
      }
    }
    
    return false; // No auto-zoom needed
  }

  private showThemeNodeOverlay(
    svg: SVGElement,
    themeIdx: number,
    themeReason: string,
    glowColor: string,
    nodeThemeMap: Map<string, number>
  ) {
    // Clear any existing overlay
    this.clearThemeOverlay();
    
    // Get container
    const container = document.querySelector('.concept-map-svg-wrapper') as HTMLElement;
    if (!container) return;
    
    const containerRect = container.getBoundingClientRect();
    
    // Get all nodes in this theme
    const themeNodeIds: string[] = [];
    nodeThemeMap.forEach((idx, nodeId) => {
      if (idx === themeIdx) {
        themeNodeIds.push(nodeId);
      }
    });
    
    if (themeNodeIds.length === 0) return;
    
    // Get node labels
    const themeNodeLabels: Array<{id: string, label: string}> = [];
    themeNodeIds.forEach(nodeId => {
      const nodeEl = svg.querySelector(`.concept-node-text[data-node-id="${nodeId}"]`) as SVGElement;
      if (nodeEl) {
        themeNodeLabels.push({
          id: nodeId,
          label: nodeEl.textContent || ''
        });
      }
    });
    
    // Create overlay container
    const overlay = document.createElement('div');
    overlay.className = 'theme-overlay-container';
    overlay.setCssProps({ 'css-text':  `
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      display: flex;
      gap: 40px;
      align-items: center;
      z-index: 2000;
      pointer-events: auto;
      animation: themeOverlayFadeIn 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    ` });
    
    // Create theme box (left side)
    const themeBox = document.createElement('div');
    themeBox.className = 'theme-overlay-box';
    themeBox.setCssProps({ 'css-text':  `
      background: var(--background-secondary);
      border: 3px solid ${glowColor};
      border-radius: 16px;
      padding: 24px 32px;
      min-width: 300px;
      max-width: 450px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
      animation: themeBoxSlideIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
    ` });
    
    // Render markdown in theme box
    this.renderMarkdownTooltip(themeReason, themeBox);
    
    // Create nodes column (right side)
    const nodesColumn = document.createElement('div');
    nodesColumn.className = 'theme-overlay-nodes';
    nodesColumn.setCssProps({ 'css-text':  `
      display: flex;
      flex-direction: column;
      gap: 12px;
      animation: themeNodesSlideIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
      animation-delay: 0.1s;
      opacity: 0;
      animation-fill-mode: forwards;
    ` });
    
    themeNodeLabels.forEach((node, index) => {
      const nodeItem = document.createElement('div');
      nodeItem.setCssProps({ 'css-text':  `
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 16px;
        font-weight: 600;
        color: var(--text-normal);
        padding: 12px 20px;
        background: var(--background-primary);
        border-radius: 8px;
        border: 2px solid ${glowColor};
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        animation: nodeItemPop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        animation-delay: ${0.15 + index * 0.05}s;
        opacity: 0;
        animation-fill-mode: forwards;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      ` });
      
      const bullet = document.createElement('div');
      bullet.setCssProps({ 'css-text':  `
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: ${glowColor};
        flex-shrink: 0;
      ` });
      
      const label = document.createElement('span');
      label.textContent = node.label;
      
      nodeItem.appendChild(bullet);
      nodeItem.appendChild(label);
      nodesColumn.appendChild(nodeItem);
      
      // Add hover effect
      nodeItem.addEventListener('mouseenter', () => {
        nodeItem.addClass('nl-transform-translateX5px');
        nodeItem.addClass('nl-box-shadow-rem-3');
      });
      nodeItem.addEventListener('mouseleave', () => {
        nodeItem.addClass('nl-transform-translateX0');
        nodeItem.addClass('nl-box-shadow-rem-4');
      });
    });
    
    overlay.appendChild(themeBox);
    overlay.appendChild(nodesColumn);
    container.appendChild(overlay);
    this.themeNodeOverlay = overlay;
    
    // Prevent clicks on overlay from closing it
    overlay.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    
    // Fade everything else in the SVG
    svg.addClass('nl-opacity-01');
    svg.addClass('nl-filter-blur3px');
    svg.addClass('nl-transition-rem-5');
  }

  // Public method to check if theme overlay is active
  public hasActiveThemeOverlay(): boolean {
    return this.clickedThemeIdx !== null;
  }
  
  // Public method to clear theme overlay from external callers
  public closeThemeOverlay() {
    if (this.clickedThemeIdx !== null) {
      this.clickedThemeIdx = null;
      this.clearThemeOverlay();
    }
  }

  private clearThemeOverlay() {
    if (this.themeNodeOverlay) {
      this.themeNodeOverlay.addClass('nl-animation-themeOverlayFadeOut03sease');
      setTimeout(() => {
        this.themeNodeOverlay?.remove();
        this.themeNodeOverlay = null;
      }, 300);
    }
    
    // Restore SVG visibility
    const svg = document.querySelector('.concept-map-svg-wrapper svg') as SVGElement;
    if (svg) {
      svg.addClass('nl-opacity-1');
      svg.addClass('nl-filter-none');
    }
    
    // Reset the fired theme node back to its original state
    if (this.firedThemeNode) {
      this.firedThemeNode.addClass('nl-transform-');
      this.firedThemeNode.addClass('nl-filter-');
      this.firedThemeNode.addClass('nl-transition-rem-6');
      this.firedThemeNode = null;
    }
    
    // Reset holding state
    this.isHolding = false;
  }

  private showThemeInfoForAutoZoom(
    text: string, 
    borderColor: string, 
    svg: SVGElement, 
    themeIdx: number, 
    nodeThemeMap: Map<string, number>
  ) {
    this.hideThemeInfo();
    
    const infoBox = document.createElement('div');
    infoBox.className = 'concept-theme-info';
    
    // Render markdown content
    this.renderMarkdownTooltip(text, infoBox);
    infoBox.setCssProps({ 'border-color':  borderColor });
    
    // Find the SVG container
    const container = document.querySelector('.concept-map-svg-wrapper') as HTMLElement;
    if (!container) {
      document.body.appendChild(infoBox);
      this.themeInfoEl = infoBox;
      return;
    }
    
    container.appendChild(infoBox);
    this.themeInfoEl = infoBox;
    
    // Get all theme node positions to avoid overlap
    const themeNodeIds: string[] = [];
    nodeThemeMap.forEach((idx, nodeId) => {
      if (idx === themeIdx) {
        themeNodeIds.push(nodeId);
      }
    });
    
    // Find optimal position that avoids ALL theme nodes
    const containerRect = container.getBoundingClientRect();
    const boxRect = infoBox.getBoundingClientRect();
    
    // Generate candidate positions around the viewport
    const positions = [
      { x: 20, y: 20 }, // top-left
      { x: containerRect.width - boxRect.width - 20, y: 20 }, // top-right
      { x: 20, y: containerRect.height - boxRect.height - 20 }, // bottom-left
      { x: containerRect.width - boxRect.width - 20, y: containerRect.height - boxRect.height - 20 }, // bottom-right
      { x: (containerRect.width - boxRect.width) / 2, y: 20 }, // top-center
      { x: (containerRect.width - boxRect.width) / 2, y: containerRect.height - boxRect.height - 20 }, // bottom-center
      { x: 20, y: (containerRect.height - boxRect.height) / 2 }, // left-center
      { x: containerRect.width - boxRect.width - 20, y: (containerRect.height - boxRect.height) / 2 }, // right-center
    ];
    
    // Find position with least overlap with theme nodes
    let bestPosition = positions[0];
    let minOverlap = Infinity;
    
    for (const pos of positions) {
      let overlapArea = 0;
      
      for (const nodeId of themeNodeIds) {
        const nodeEl = svg.querySelector(`.concept-node-circle[data-node-id="${nodeId}"]`) as SVGElement;
        if (nodeEl) {
          const nodeRect = nodeEl.getBoundingClientRect();
          const relativeNodeRect = {
            left: nodeRect.left - containerRect.left,
            top: nodeRect.top - containerRect.top,
            right: nodeRect.right - containerRect.left,
            bottom: nodeRect.bottom - containerRect.top
          };
          
          // Add generous padding around theme nodes
          const padding = 40;
          const expandedNodeRect = {
            left: relativeNodeRect.left - padding,
            top: relativeNodeRect.top - padding,
            right: relativeNodeRect.right + padding,
            bottom: relativeNodeRect.bottom + padding
          };
          
          // Calculate overlap
          const overlapLeft = Math.max(pos.x, expandedNodeRect.left);
          const overlapTop = Math.max(pos.y, expandedNodeRect.top);
          const overlapRight = Math.min(pos.x + boxRect.width, expandedNodeRect.right);
          const overlapBottom = Math.min(pos.y + boxRect.height, expandedNodeRect.bottom);
          
          if (overlapLeft < overlapRight && overlapTop < overlapBottom) {
            overlapArea += (overlapRight - overlapLeft) * (overlapBottom - overlapTop);
          }
        }
      }
      
      if (overlapArea < minOverlap) {
        minOverlap = overlapArea;
        bestPosition = pos;
      }
    }
    
    // Apply the best position
    infoBox.addClass('nl-position-absolute');
    infoBox.setCssProps({ 'left':  `${bestPosition.x}px` });
    infoBox.setCssProps({ 'top':  `${bestPosition.y}px` });
    infoBox.addClass('nl-z-index-1000');
  }

  private showRelationTooltip(
    text: string,
    borderColor: string,
    svg: SVGElement,
    fromNodeId: string,
    toNodeId: string,
    mouseX: number,
    mouseY: number
  ) {
    this.hideThemeInfo();
    
    const infoBox = document.createElement('div');
    infoBox.className = 'concept-theme-info';
    
    // Render markdown content
    this.renderMarkdownTooltip(text, infoBox);
    infoBox.setCssProps({ 'border-color':  borderColor });
    
    // Find the SVG container
    const container = document.querySelector('.concept-map-svg-wrapper') as HTMLElement;
    if (!container) {
      document.body.appendChild(infoBox);
      this.themeInfoEl = infoBox;
      return;
    }
    
    container.appendChild(infoBox);
    this.themeInfoEl = infoBox;
    
    // Get positions of the two joined nodes to avoid them
    const containerRect = container.getBoundingClientRect();
    const boxRect = infoBox.getBoundingClientRect();
    
    const fromNode = svg.querySelector(`.concept-node-circle[data-node-id="${fromNodeId}"]`) as SVGElement;
    const toNode = svg.querySelector(`.concept-node-circle[data-node-id="${toNodeId}"]`) as SVGElement;
    
    const nodesToAvoid: Array<{left: number, top: number, right: number, bottom: number}> = [];
    
    if (fromNode) {
      const nodeRect = fromNode.getBoundingClientRect();
      nodesToAvoid.push({
        left: nodeRect.left - containerRect.left - 30,
        top: nodeRect.top - containerRect.top - 30,
        right: nodeRect.right - containerRect.left + 30,
        bottom: nodeRect.bottom - containerRect.top + 30
      });
    }
    
    if (toNode) {
      const nodeRect = toNode.getBoundingClientRect();
      nodesToAvoid.push({
        left: nodeRect.left - containerRect.left - 30,
        top: nodeRect.top - containerRect.top - 30,
        right: nodeRect.right - containerRect.left + 30,
        bottom: nodeRect.bottom - containerRect.top + 30
      });
    }
    
    // Position near mouse but avoid the joined nodes
    const relativeX = mouseX - containerRect.left;
    const relativeY = mouseY - containerRect.top;
    
    // Try positions around the cursor
    const positions = [
      { x: relativeX + 15, y: relativeY + 15 }, // bottom-right
      { x: relativeX - boxRect.width - 15, y: relativeY + 15 }, // bottom-left
      { x: relativeX + 15, y: relativeY - boxRect.height - 15 }, // top-right
      { x: relativeX - boxRect.width - 15, y: relativeY - boxRect.height - 15 }, // top-left
      { x: relativeX, y: relativeY + 30 }, // directly below
      { x: relativeX, y: relativeY - boxRect.height - 30 }, // directly above
      { x: relativeX + 30, y: relativeY }, // directly right
      { x: relativeX - boxRect.width - 30, y: relativeY }, // directly left
    ];
    
    // Find position with no overlap with joined nodes
    let bestPosition = positions[0];
    let foundNonOverlapping = false;
    
    for (const pos of positions) {
      // Check if this position fits in container
      if (pos.x < 10 || pos.x + boxRect.width > containerRect.width - 10 ||
          pos.y < 10 || pos.y + boxRect.height > containerRect.height - 10) {
        continue;
      }
      
      // Check if this position overlaps with any joined node
      let overlaps = false;
      const tooltipRect = {
        left: pos.x,
        top: pos.y,
        right: pos.x + boxRect.width,
        bottom: pos.y + boxRect.height
      };
      
      for (const nodeRect of nodesToAvoid) {
        if (!(tooltipRect.right < nodeRect.left ||
              tooltipRect.left > nodeRect.right ||
              tooltipRect.bottom < nodeRect.top ||
              tooltipRect.top > nodeRect.bottom)) {
          overlaps = true;
          break;
        }
      }
      
      if (!overlaps) {
        bestPosition = pos;
        foundNonOverlapping = true;
        break;
      }
    }
    
    // If no non-overlapping position found, use the first valid position
    if (!foundNonOverlapping) {
      for (const pos of positions) {
        if (pos.x >= 10 && pos.x + boxRect.width <= containerRect.width - 10 &&
            pos.y >= 10 && pos.y + boxRect.height <= containerRect.height - 10) {
          bestPosition = pos;
          break;
        }
      }
    }
    
    // Apply position
    infoBox.addClass('nl-position-absolute');
    infoBox.setCssProps({ 'left':  `${bestPosition.x}px` });
    infoBox.setCssProps({ 'top':  `${bestPosition.y}px` });
    infoBox.addClass('nl-z-index-1000');
  }

  private drawCenterText(svg: SVGElement, text: string, centerX: number, centerY: number) {
    const maxWidth = 120;
    const lineHeight = 16;
    
    // Wrap text into multiple lines if needed
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';
    
    words.forEach(word => {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const estimatedWidth = testLine.length * 7.5; // Rough char width estimate
      
      if (estimatedWidth > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    });
    
    if (currentLine) {
      lines.push(currentLine);
    }
    
    // Limit to 3 lines max
    const displayLines = lines.slice(0, 3);
    if (lines.length > 3) {
      displayLines[2] = displayLines[2].substring(0, 15) + '...';
    }
    
    // Calculate starting Y position (centered vertically)
    const totalHeight = displayLines.length * lineHeight;
    let startY = centerY - totalHeight / 2 + lineHeight / 2;
    
    // Draw each line
    displayLines.forEach((line, idx) => {
      const textEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      textEl.setAttribute('class', 'concept-center-text');
      textEl.setAttribute('x', centerX.toString());
      textEl.setAttribute('y', (startY + idx * lineHeight).toString());
      textEl.textContent = line;
      svg.appendChild(textEl);
    });
  }

  private highlightConnections(
    svg: SVGElement,
    nodeId: string,
    relations: Array<{ from: string; to: string; reason: string }>
  ) {
    // Find all relations involving this node
    const connectedRelations = relations.filter(
      rel => rel.from === nodeId || rel.to === nodeId
    );
    
    if (connectedRelations.length === 0) {
      // No connections - just highlight this node
      this.clearHighlight(svg);
      const nodeEl = svg.querySelector(`.concept-node-circle[data-node-id="${nodeId}"]`);
      if (nodeEl) {
        nodeEl.classList.add('clicked');
      }
      return;
    }
    
    // Fade everything first
    const allNodes = svg.querySelectorAll('.concept-node-circle');
    const allTexts = svg.querySelectorAll('.concept-node-text');
    const allRelations = svg.querySelectorAll('.concept-relation-line');
    const allRelationNodes = svg.querySelectorAll('.concept-relation-node');
    const centerText = svg.querySelector('.concept-center-text');
    const circles = svg.querySelectorAll('.concept-circle');

    allNodes.forEach(node => node.classList.add('faded'));
    allTexts.forEach(text => text.classList.add('faded'));
    allRelations.forEach(rel => rel.classList.add('faded'));
    allRelationNodes.forEach(node => node.classList.add('faded'));
    if (centerText) centerText.classList.add('faded');
    circles.forEach(circle => (circle as SVGElement).addClass('nl-opacity-03'));

    // Collect all connected node IDs
    const connectedNodeIds = new Set<string>([nodeId]);
    connectedRelations.forEach(rel => {
      connectedNodeIds.add(rel.from);
      connectedNodeIds.add(rel.to);
    });

    // Highlight the clicked node with special style
    const clickedNode = svg.querySelector(`.concept-node-circle[data-node-id="${nodeId}"]`);
    if (clickedNode) {
      clickedNode.classList.remove('faded');
      clickedNode.classList.add('clicked');
    }
    const clickedText = svg.querySelector(`.concept-node-text[data-node-id="${nodeId}"]`);
    if (clickedText) {
      clickedText.classList.remove('faded');
    }

    // Highlight all connected nodes
    connectedNodeIds.forEach(id => {
      if (id === nodeId) return; // Skip clicked node (already handled)
      
      const nodeEl = svg.querySelector(`.concept-node-circle[data-node-id="${id}"]`);
      const textEl = svg.querySelector(`.concept-node-text[data-node-id="${id}"]`);
      if (nodeEl) {
        nodeEl.classList.remove('faded');
        nodeEl.classList.add('highlighted');
      }
      if (textEl) {
        textEl.classList.remove('faded');
      }
    });

    // Highlight all connecting relations
    connectedRelations.forEach(rel => {
      const relationLine = svg.querySelector(`.concept-relation-line[data-from="${rel.from}"][data-to="${rel.to}"]`);
      if (relationLine) {
        relationLine.classList.remove('faded');
        relationLine.classList.add('highlighted');
      }

      const relationNode = svg.querySelector(`.concept-relation-node[data-from="${rel.from}"][data-to="${rel.to}"]`);
      if (relationNode) {
        relationNode.classList.remove('faded');
        relationNode.classList.add('highlighted');
      }
    });

    // Show info about connections
    const connectionCount = connectedRelations.length;
    // Position at top center of container for connection count
    this.showThemeInfo(
      `${connectionCount} connection${connectionCount > 1 ? 's' : ''} from this node`,
      '#7c3aed'
    );
  }
}

export class ConceptMapModal extends Modal {
  private onConfirm: (name: string) => void;
  private conceptMapName: string = '';

  constructor(app: SafeAny, onConfirm: (name: string) => void) {
    super(app);
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Create Concept Map' });

    new Setting(contentEl)
      .setName('Concept Map Name')
      .setDesc('Enter a name for your concept map')
      .addText(text => text
        .setPlaceholder('e.g., Biology Chapter 3')
        .setValue(this.conceptMapName)
        .onChange(value => {
          this.conceptMapName = value;
        }));

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());

    new ButtonComponent(buttonContainer)
      .setButtonText('Confirm')
      .setCta()
      .onClick(() => {
        if (!this.conceptMapName.trim()) {
          new Notice('Please enter a name for the concept map');
          return;
        }
        this.onConfirm(this.conceptMapName.trim());
        this.close();
      });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class ConceptMapVisualizationModal extends Modal {
  private conceptMapData: ConceptMapData;
  private name: string;
  private manager: ConceptMapManager;
  private zoomLevel: number = 1;
  private svgContainer: HTMLElement | null = null;
  private zoomLevelDisplay: HTMLElement | null = null;
  private svgWrapper: HTMLElement | null = null;
  private panOffset = { x: 0, y: 0 };
  private isPanning = false;
  private lastPanPoint = { x: 0, y: 0 };
  private zoomAnchorX: number | null = null;
  private zoomAnchorY: number | null = null;
  private mouseMoveTimeout: SafeAny = null;
  private helpContainer: HTMLElement | null = null;
  
  // Mobile touch properties
  private touches: Touch[] = [];
  private lastTouchDistance: number = 0;
  private lastTapTime: number = 0;
  private lastTapTarget: HTMLElement | null = null;
  private longPressTimeout: SafeAny = null;
  private activeNode: HTMLElement | null = null;
  private isNodeHighlighted: boolean = false;

  constructor(app: SafeAny, conceptMapData: ConceptMapData, name: string) {
    super(app);
    this.conceptMapData = conceptMapData;
    this.name = name;
    this.manager = new ConceptMapManager(app, {} as AISettings); // Manager only for SVG rendering
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    
    // Add modal class for styling and store reference for auto-zoom
    modalEl.addClass('concept-map-modal');
    (window as SafeAny).activeConceptMapModal = this;

    // Create body
    const body = contentEl.createDiv({ cls: 'concept-map-modal-body' });
    
    // Create infinite canvas wrapper
    const svgWrapper = body.createDiv({ cls: 'concept-map-svg-wrapper infinite-canvas' });
    this.svgWrapper = svgWrapper;
    this.svgContainer = svgWrapper.createDiv({ cls: 'concept-map-svg-container' });
    
    // Render the SVG
    const svg = this.manager.renderConceptMapSVG(this.conceptMapData);
    this.svgContainer.appendChild(svg);
    
    // Set up infinite canvas behavior
    this.setupInfiniteCanvas(svgWrapper);

    // Create zoom controls
    const zoomControls = body.createDiv({ cls: 'concept-map-zoom-controls' });
    
    const zoomOutBtn = zoomControls.createEl('button', { text: '−' });
    zoomOutBtn.addEventListener('click', () => this.zoom(-0.1));
    
    this.zoomLevelDisplay = zoomControls.createDiv({ cls: 'concept-map-zoom-level' });
    this.updateZoomDisplay();
    
    const zoomInBtn = zoomControls.createEl('button', { text: '+' });
    zoomInBtn.addEventListener('click', () => this.zoom(0.1));
    
    // Add center button
    const centerBtn = zoomControls.createEl('button', { text: '⌂', cls: 'center-map-btn' });
    centerBtn.title = 'Center Map';
    centerBtn.addEventListener('click', () => this.centerMap());

    // Add help button
    const helpBtn = zoomControls.createEl('button', { cls: 'concept-map-help-btn' });
    helpBtn.title = 'How to use';
    setIcon(helpBtn, 'help-circle');
    helpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleHelp();
    });

    // Add scroll-based zoom at anchored position (like Obsidian Graph view)
    svgWrapper.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      
      // Set zoom anchor on first scroll if not set
      if (this.zoomAnchorX === null || this.zoomAnchorY === null) {
        this.zoomAnchorX = e.clientX;
        this.zoomAnchorY = e.clientY;
      }
      
      // Zoom at the anchored position
      this.zoomAtCursor(delta, this.zoomAnchorX, this.zoomAnchorY, svgWrapper);
    }, { passive: false });
    
    // Reset zoom anchor when mouse moves
    svgWrapper.addEventListener('mousemove', (e) => {
      // Clear existing timeout
      if (this.mouseMoveTimeout) {
        clearTimeout(this.mouseMoveTimeout);
      }
      
      // Set timeout to reset anchor after movement stops
      this.mouseMoveTimeout = setTimeout(() => {
        this.zoomAnchorX = null;
        this.zoomAnchorY = null;
      }, 100);
    });
    
    // Add click handler to wrapper to clear overlay when clicking outside
    svgWrapper.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      
      // Only clear if clicking on wrapper or SVG background, not on overlay
      if (!target.closest('.theme-overlay-container')) {
        if (this.manager.hasActiveThemeOverlay()) {
          this.manager.closeThemeOverlay();
        }
      }
    });
  }

  private zoom(delta: number) {
    this.zoomLevel = Math.max(0.1, Math.min(5, this.zoomLevel + delta)); // Extended zoom range
    this.updateTransform();
    this.updateZoomDisplay();
  }

  private zoomAtCursor(delta: number, clientX: number, clientY: number, wrapper: HTMLElement) {
    if (!this.svgContainer) return;

    const oldZoom = this.zoomLevel;
    const newZoom = Math.max(0.3, Math.min(3, oldZoom + delta));
    
    if (oldZoom === newZoom) return;

    // Get cursor position relative to wrapper
    const rect = wrapper.getBoundingClientRect();
    const cursorX = clientX - rect.left;
    const cursorY = clientY - rect.top;

    // Get current scroll position
    const scrollLeft = wrapper.scrollLeft;
    const scrollTop = wrapper.scrollTop;

    // Calculate cursor position in content space
    const contentX = (scrollLeft + cursorX) / oldZoom;
    const contentY = (scrollTop + cursorY) / oldZoom;

    // Update zoom
    this.zoomLevel = newZoom;
    this.svgContainer.setCssProps({ 'transform':  `scale(${this.zoomLevel})` });
    
    // Calculate new scroll position to keep cursor at same content position
    const newScrollLeft = contentX * newZoom - cursorX;
    const newScrollTop = contentY * newZoom - cursorY;

    wrapper.scrollLeft = newScrollLeft;
    wrapper.scrollTop = newScrollTop;

    this.updateZoomDisplay();
  }

  private updateZoomDisplay() {
    if (this.zoomLevelDisplay) {
      this.zoomLevelDisplay.textContent = `${Math.round(this.zoomLevel * 100)}%`;
    }
  }

  private updateTransform() {
    if (this.svgContainer) {
      this.svgContainer.setCssProps({ 'transform':  `scale(${this.zoomLevel}) translate(${this.panOffset.x}px, ${this.panOffset.y}px)` });
    }
  }

  private setupInfiniteCanvas(wrapper: HTMLElement) {
    // Enable panning with mouse drag
    wrapper.addEventListener('mousedown', (e) => {
      if (e.button === 0) { // Left mouse button
        this.isPanning = true;
        this.lastPanPoint = { x: e.clientX, y: e.clientY };
        wrapper.addClass('nl-cursor-grabbing');
        e.preventDefault();
      }
    });

    wrapper.addEventListener('mousemove', (e) => {
      if (this.isPanning) {
        const deltaX = e.clientX - this.lastPanPoint.x;
        const deltaY = e.clientY - this.lastPanPoint.y;
        
        this.panOffset.x += deltaX / this.zoomLevel;
        this.panOffset.y += deltaY / this.zoomLevel;
        
        this.updateTransform();
        
        this.lastPanPoint = { x: e.clientX, y: e.clientY };
      }
    });

    wrapper.addEventListener('mouseup', () => {
      this.isPanning = false;
      wrapper.addClass('nl-cursor-default');
    });

    wrapper.addEventListener('mouseleave', () => {
      this.isPanning = false;
      wrapper.addClass('nl-cursor-default');
    });

    // Set initial cursor
    wrapper.addClass('nl-cursor-default');

    // Prevent context menu on right click
    wrapper.addEventListener('contextmenu', (e) => e.preventDefault());
    
    // Add mobile touch controls
    this.setupMobileTouchControls(wrapper);
  }

  private centerMap() {
    // Reset zoom and pan to center the map
    this.zoomLevel = 1;
    this.panOffset = { x: 0, y: 0 };
    this.updateTransform();
    this.updateZoomDisplay();
    
    // Center scroll position
    if (this.svgWrapper) {
      const rect = this.svgWrapper.getBoundingClientRect();
      this.svgWrapper.scrollLeft = (this.svgWrapper.scrollWidth - rect.width) / 2;
      this.svgWrapper.scrollTop = (this.svgWrapper.scrollHeight - rect.height) / 2;
    }
  }

  private toggleHelp() {
    if (this.helpContainer) {
      if (this.helpContainer.style.display === 'none') {
        this.helpContainer.addClass('nl-display-block');
      } else {
        this.helpContainer.addClass('nl-display-none');
      }
      return;
    }

    const body = this.contentEl.querySelector('.concept-map-modal-body');
    if (!body) return;

    this.helpContainer = body.createDiv({ cls: 'concept-map-help-container' });
    
    const helpContent = `
> [!info] How to use the Concept Map
> The concept map strips down a topic into its core components, applications, how all of these are related and a broader thematic classification.
> 
> - The nodes in the inner circle are the core topics;
> - The nodes in the outer circle are the application based / peripheral topics;
> - The node on the connecting lines explains the why of connection;
> - Hollow nodes (if any) are standalone or general topics devoid of thematic belonging.
> 
> **Instructions:**
> - <span style="color: var(--text-accent);">Click and hold a node's text to know the theme it belongs to, click anywhere to exit themes view;</span>
> - <span style="color: var(--text-accent);">Double click a node's text to know the nodes its connected to.</span>
> - <span style="color: var(--text-accent);">Hover over the node on the connecting lines to explore the why.</span>
    `.trim();

    { const _comp = new Component();
    MarkdownRenderer.renderMarkdown(helpContent, this.helpContainer, '', _comp);
    _comp.load(); }
  }

  private setupMobileTouchControls(wrapper: HTMLElement) {
    // Touch start - handle single touch, double tap, and long press
    wrapper.addEventListener('touchstart', (e) => {
      this.touches = Array.from(e.touches);
      
      if (this.touches.length === 1) {
        const touch = this.touches[0];
        const target = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement;
        
        // Handle double tap detection
        const currentTime = Date.now();
        const timeDiff = currentTime - this.lastTapTime;
        
        if (timeDiff < 300 && this.lastTapTarget === target && this.isNodeElement(target)) {
          // Double tap detected on a node
          this.handleDoubleTap(target);
          e.preventDefault();
          return;
        }
        
        this.lastTapTime = currentTime;
        this.lastTapTarget = target;
        
        // Start long press timer for nodes
        if (this.isNodeElement(target)) {
          this.longPressTimeout = setTimeout(() => {
            this.handleLongPress(target);
          }, 500); // 500ms for long press
        }
        
        // Start panning
        this.isPanning = true;
        this.lastPanPoint = { x: touch.clientX, y: touch.clientY };
        
      } else if (this.touches.length === 2) {
        // Two finger pinch - calculate initial distance
        this.lastTouchDistance = this.getTouchDistance(this.touches[0], this.touches[1]);
        this.isPanning = false;
      }
      
      // Clear long press timeout if multiple touches
      if (this.touches.length > 1 && this.longPressTimeout) {
        clearTimeout(this.longPressTimeout);
        this.longPressTimeout = null;
      }
    }, { passive: false });

    // Touch move - handle panning and pinch zoom
    wrapper.addEventListener('touchmove', (e) => {
      e.preventDefault(); // Prevent scrolling
      
      this.touches = Array.from(e.touches);
      
      // Clear long press timeout on move
      if (this.longPressTimeout) {
        clearTimeout(this.longPressTimeout);
        this.longPressTimeout = null;
      }
      
      if (this.touches.length === 1 && this.isPanning) {
        // Single finger panning
        const touch = this.touches[0];
        const deltaX = touch.clientX - this.lastPanPoint.x;
        const deltaY = touch.clientY - this.lastPanPoint.y;
        
        this.panOffset.x += deltaX / this.zoomLevel;
        this.panOffset.y += deltaY / this.zoomLevel;
        
        this.updateTransform();
        this.lastPanPoint = { x: touch.clientX, y: touch.clientY };
        
      } else if (this.touches.length === 2) {
        // Two finger pinch zoom
        const currentDistance = this.getTouchDistance(this.touches[0], this.touches[1]);
        const distanceDiff = currentDistance - this.lastTouchDistance;
        
        if (Math.abs(distanceDiff) > 5) { // Threshold to prevent jittery zoom
          const zoomDelta = distanceDiff * 0.01; // Adjust sensitivity
          const centerX = (this.touches[0].clientX + this.touches[1].clientX) / 2;
          const centerY = (this.touches[0].clientY + this.touches[1].clientY) / 2;
          
          this.zoomAtCursor(zoomDelta, centerX, centerY, wrapper);
          this.lastTouchDistance = currentDistance;
        }
      }
    }, { passive: false });

    // Touch end - handle single tap and cleanup
    wrapper.addEventListener('touchend', (e) => {
      this.touches = Array.from(e.touches);
      
      // Clear long press timeout
      if (this.longPressTimeout) {
        clearTimeout(this.longPressTimeout);
        this.longPressTimeout = null;
      }
      
      // Handle single tap (only if no remaining touches and was not a double tap)
      if (this.touches.length === 0 && this.lastTapTarget) {
        const timeSinceLastTap = Date.now() - this.lastTapTime;
        if (timeSinceLastTap > 300) { // Not a double tap
          setTimeout(() => {
            if (Date.now() - this.lastTapTime > 250) { // Ensure no double tap occurred
              this.handleSingleTap(this.lastTapTarget!);
            }
          }, 250);
        }
      }
      
      // Reset panning
      if (this.touches.length === 0) {
        this.isPanning = false;
      }
      
      // Update touch distance for remaining touches
      if (this.touches.length === 2) {
        this.lastTouchDistance = this.getTouchDistance(this.touches[0], this.touches[1]);
      }
    }, { passive: false });

    // Touch cancel - cleanup
    wrapper.addEventListener('touchcancel', () => {
      this.touches = [];
      this.isPanning = false;
      if (this.longPressTimeout) {
        clearTimeout(this.longPressTimeout);
        this.longPressTimeout = null;
      }
    });
  }

  private getTouchDistance(touch1: Touch, touch2: Touch): number {
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private isNodeElement(element: HTMLElement): boolean {
    // Check if element is a concept map node (circle, text, or connection)
    return element.tagName === 'circle' || 
           element.tagName === 'text' || 
           (element.tagName === 'g' && element.classList.contains('node')) ||
           element.closest('g.node') !== null;
  }

  private handleSingleTap(target: HTMLElement) {
    if (this.isNodeElement(target)) {
      // Show tooltip for the node
      this.showNodeTooltip(target);
    } else {
      // Tap on empty space - clear any active states
      this.clearActiveStates();
    }
  }

  private handleDoubleTap(target: HTMLElement) {
    if (this.isNodeElement(target)) {
      // Toggle node connections highlight
      this.toggleNodeConnections(target);
    }
  }

  private handleLongPress(target: HTMLElement) {
    if (this.isNodeElement(target)) {
      // Show thematic overlay
      this.showThematicOverlay(target);
    }
  }

  private showNodeTooltip(target: HTMLElement) {
    // Get node information from the target element
    const nodeText = target.textContent || target.getAttribute('data-node-text') || '';
    const nodeId = target.getAttribute('data-node-id') || target.closest('[data-node-id]')?.getAttribute('data-node-id');
    
    if (!nodeText && !nodeId) return;
    
    // Create tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'mobile-node-tooltip';
    tooltip.setCssProps({ 'css-text':  `
      position: fixed;
      background: var(--background-secondary);
      color: var(--text-normal);
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid var(--background-modifier-border);
      font-size: 14px;
      z-index: 3000;
      pointer-events: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      max-width: 200px;
      word-wrap: break-word;
    ` });
    
    tooltip.textContent = nodeText;
    document.body.appendChild(tooltip);
    
    // Position tooltip near the touch point
    const rect = target.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    
    let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
    let top = rect.top - tooltipRect.height - 10;
    
    // Adjust if tooltip goes off screen
    if (left < 10) left = 10;
    if (left + tooltipRect.width > window.innerWidth - 10) {
      left = window.innerWidth - tooltipRect.width - 10;
    }
    if (top < 10) {
      top = rect.bottom + 10;
    }
    
    tooltip.setCssProps({ 'left':  `${left}px` });
    tooltip.setCssProps({ 'top':  `${top}px` });
    
    // Auto-hide tooltip after 3 seconds
    setTimeout(() => {
      tooltip.remove();
    }, 3000);
  }

  private toggleNodeConnections(target: HTMLElement) {
    if (this.activeNode === target && this.isNodeHighlighted) {
      // Restore normal state
      this.clearActiveStates();
    } else {
      // Highlight this node and its connections
      this.clearActiveStates();
      this.activeNode = target;
      this.isNodeHighlighted = true;
      this.highlightNodeConnections(target);
    }
  }

  private highlightNodeConnections(target: HTMLElement) {
    if (!this.svgContainer) return;
    
    const svg = this.svgContainer.querySelector('svg');
    if (!svg) return;
    
    // Get the node ID from the target element
    const nodeId = target.getAttribute('data-node-id') || 
                   target.closest('[data-node-id]')?.getAttribute('data-node-id') ||
                   target.textContent?.trim();
    
    if (!nodeId) return;
    
    // Dim all elements first
    const allElements = svg.querySelectorAll('circle, text, line, path');
    allElements.forEach(el => {
      (el as SVGElement).addClass('nl-opacity-03');
      (el as SVGElement).addClass('nl-filter-grayscale07');
    });
    
    // Find and highlight the selected node
    const nodeElements = svg.querySelectorAll(`[data-node-id="${nodeId}"], text`);
    nodeElements.forEach(el => {
      const element = el as SVGElement;
      if (element.textContent?.trim() === nodeId || element.getAttribute('data-node-id') === nodeId) {
        element.addClass('nl-opacity-1');
        element.addClass('nl-filter-none');
        element.addClass('nl-stroke-ff6b6b');
        element.addClass('nl-stroke-width-3');
        
        // Add pulsing animation
        element.addClass('nl-animation-pulse2sinfinite');
      }
    });
    
    // Find and highlight connected lines/paths
    const connections = svg.querySelectorAll('line, path');
    connections.forEach(connection => {
      const conn = connection as SVGElement;
      // Check if this connection involves the selected node
      // This is a simplified approach - you might need to adjust based on your SVG structure
      const connectedToNode = conn.getAttribute('data-from') === nodeId || 
                             conn.getAttribute('data-to') === nodeId ||
                             conn.classList.contains(`connection-${nodeId}`);
      
      if (connectedToNode) {
        conn.addClass('nl-opacity-1');
        conn.addClass('nl-filter-none');
        conn.addClass('nl-stroke-4ecdc4');
        conn.addClass('nl-stroke-width-2');
      }
    });
    
    // Add visual feedback overlay
    const overlay = document.createElement('div');
    overlay.className = 'mobile-node-highlight-overlay';
    overlay.setCssProps({ 'css-text':  `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--background-secondary);
      color: var(--text-normal);
      padding: 8px 16px;
      border-radius: 20px;
      border: 1px solid var(--accent-color);
      font-size: 12px;
      z-index: 2500;
      pointer-events: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    ` });
    overlay.textContent = `Connections for: ${nodeId}`;
    document.body.appendChild(overlay);
    
    // Store overlay for cleanup
    this.activeNode = target;
    (target as SafeAny)._highlightOverlay = overlay;
  }

  private showThematicOverlay(target: HTMLElement) {
    // Get node information
    const nodeText = target.textContent?.trim() || target.getAttribute('data-node-text') || '';
    const nodeId = target.getAttribute('data-node-id') || nodeText;
    
    if (!nodeId) return;
    
    // Find the theme index for this node (simplified approach)
    // In a real implementation, you'd need to map nodes to their themes
    let themeIdx = 0;
    let themeReason = `Thematic context for "${nodeId}"`;
    let glowColor = '#4ecdc4';
    
    // Try to find existing theme data from the concept map data
    if (this.conceptMapData && this.conceptMapData.themes) {
      const themes = this.conceptMapData.themes;
      for (let i = 0; i < themes.length; i++) {
        if (themes[i].nodes && themes[i].nodes.includes(nodeId)) {
          themeIdx = i;
          themeReason = themes[i].reason || themeReason;
          // Use theme color if available
          const themeColors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3'];
          glowColor = themeColors[i % themeColors.length];
          break;
        }
      }
    }
    
    // Use the existing thematic overlay functionality
    if (this.svgContainer) {
      const svg = this.svgContainer.querySelector('svg') as SVGElement;
      if (svg) {
        // Create a simple node theme map for the overlay
        const nodeThemeMap = new Map<string, number>();
        nodeThemeMap.set(nodeId, themeIdx);
        
        // Since showThemeNodeOverlay is private, we'll create a simple overlay instead
        this.createSimpleThematicOverlay(nodeId, themeReason, glowColor);
      }
    }
  }

  private createSimpleThematicOverlay(nodeId: string, themeReason: string, glowColor: string) {
    // Clear any existing thematic overlays
    const existingOverlay = document.querySelector('.mobile-thematic-overlay');
    if (existingOverlay) {
      existingOverlay.remove();
    }
    
    // Create thematic overlay
    const overlay = document.createElement('div');
    overlay.className = 'mobile-thematic-overlay';
    overlay.setCssProps({ 'css-text':  `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: var(--background-secondary);
      color: var(--text-normal);
      padding: 20px;
      border-radius: 12px;
      border: 2px solid ${glowColor};
      max-width: 300px;
      z-index: 3000;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      animation: fadeInScale 0.3s ease;
    ` });
    
    const title = document.createElement('h3');
    title.setCssProps({ 'css-text':  `
      margin: 0 0 12px 0;
      color: ${glowColor};
      font-size: 16px;
      text-align: center;
    ` });
    title.textContent = nodeId;
    
    const content = document.createElement('p');
    content.setCssProps({ 'css-text':  `
      margin: 0;
      font-size: 14px;
      line-height: 1.4;
    ` });
    content.textContent = themeReason;
    
    const closeButton = document.createElement('button');
    closeButton.setCssProps({ 'css-text':  `
      position: absolute;
      top: 8px;
      right: 8px;
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 18px;
      cursor: pointer;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    ` });
    closeButton.textContent = '×';
    closeButton.addEventListener('click', () => overlay.remove());
    
    overlay.appendChild(closeButton);
    overlay.appendChild(title);
    overlay.appendChild(content);
    document.body.appendChild(overlay);
    
    // Auto-close after 5 seconds
    setTimeout(() => {
      if (overlay.parentNode) {
        overlay.remove();
      }
    }, 5000);
  }

  private clearActiveStates() {
    this.activeNode = null;
    this.isNodeHighlighted = false;
    
    // Clear node connection highlights
    if (this.svgContainer) {
      const svg = this.svgContainer.querySelector('svg');
      if (svg) {
        const allElements = svg.querySelectorAll('circle, text, line, path');
        allElements.forEach(el => {
          const element = el as SVGElement;
          element.addClass('nl-opacity-');
          element.addClass('nl-filter-');
          element.addClass('nl-stroke-');
          element.addClass('nl-stroke-width-');
          element.addClass('nl-animation-');
        });
      }
    }
    
    // Clear highlight overlay
    if (this.activeNode && (this.activeNode as SafeAny)._highlightOverlay) {
      (this.activeNode as SafeAny)._highlightOverlay.remove();
    }
    
    // Clear mobile overlays
    const highlightOverlay = document.querySelector('.mobile-node-highlight-overlay');
    if (highlightOverlay) {
      highlightOverlay.remove();
    }
    
    const thematicOverlay = document.querySelector('.mobile-thematic-overlay');
    if (thematicOverlay) {
      thematicOverlay.remove();
    }
    
    const tooltips = document.querySelectorAll('.mobile-node-tooltip');
    tooltips.forEach(tooltip => tooltip.remove());
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    // Clean up global reference
    (window as SafeAny).activeConceptMapModal = null;
  }
}
