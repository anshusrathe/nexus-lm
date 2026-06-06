import { ButtonComponent, Notice, MarkdownRenderer, Component, Modal, Setting, TFile, requestUrl } from 'obsidian';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AISettings, getModelTemperature, getModelTopP } from '../settings';
import { DirectorySuggester } from '../utils/directorySuggester';
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

export interface MCQOption {
  text: string;
  isCorrect: boolean;
}

export interface MCQ {
  question: string;
  options: MCQOption[];
  selectedOption?: number;
}

export interface MCQResult {
  correctAttempts: number;
  incorrectAttempts: number;
  marks: number;
  accuracy: number;
}

export interface MCQSettings {
  numMCQs: number;
  filename: string;
  saveDirectory: string;
  customPrompt: string;
  correctMarks: number;
  incorrectMarks: number;
}

export class MCQManager {
  private settings: AISettings;
  private app: any;

  constructor(app: any, settings: AISettings) {
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

  async generateMCQs(notePaths: string[], mcqSettings: MCQSettings = { numMCQs: 20, filename: 'AI-Tutor-MCQ-Session', saveDirectory: '', customPrompt: '', correctMarks: 1, incorrectMarks: 0 }, onProgress?: (percentage: number, status: string) => void): Promise<MCQ[]> {
    if (!this.validateSettings()) {
      throw new Error('Invalid settings');
    }

    onProgress?.(10, 'Reading selected notes...');

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

    onProgress?.(30, 'Preparing content for AI...');

    const formattedContent = textContents.length > 0 
      ? textContents.map((note, index) => (
          `# Note ${index + 1}: ${note.title}\n\n${note.content}`
        )).join('\n\n---\n\n')
      : '';

    const provider = this.settings.aiTutorProvider || this.settings.provider;
    const modelId = this.settings.aiTutorModel || this.settings.model;

    onProgress?.(60, 'Generating MCQs with AI...');

    if (provider === 'gemini') {
      try {
        const genAI = new GoogleGenerativeAI(this.getApiKey());
        const model = genAI.getGenerativeModel({ model: modelId });
        
        const prompt = `Generate exactly ${mcqSettings.numMCQs} multiple-choice questions (MCQs) based on the provided content. Follow these requirements exactly:\n\n1. Content Coverage:\n   - Each MCQ must cover key concepts from different parts of the content\n   - Questions should test understanding, not just recall\n   - Ensure comprehensive coverage of the material\n   - Number of MCQs MUST be exactly ${mcqSettings.numMCQs}\n
2. MCQ Structure:\n   - Each MCQ must have exactly 4 options\n   - Only one option should be correct\n   - Options should be realistic and plausible\n   - Do not use any bold formatting in options\n   - Format each MCQ as:\n     Q: [question]\n     A: [correct option]\n     B: [option]\n     C: [option]\n     D: [option]\n     CORRECT: [A/B/C/D]\n
3. Difficulty:\n   - Mix easy, medium, and difficult questions\n   - Make distractors plausible but clearly incorrect\n   - Ensure questions are unambiguous\n   - Keep option lengths similar within each question\n
${mcqSettings.customPrompt ? `Additional context for MCQ generation: ${mcqSettings.customPrompt}\n\n` : ''}${formattedContent ? `Here's the content:\n\n${formattedContent}\n\n` : ''}Generate exactly ${mcqSettings.numMCQs} MCQs now:`;

        // Build message parts with multimodal inputs
        const messageParts: any[] = [{ text: prompt }];
        
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

        const response = await result.response;
        onProgress?.(90, 'Parsing and formatting response...');
        const mcqs = this.parseMCQs(response.text());
        
        if (mcqs.length === 0) {
          throw new Error('Failed to generate valid MCQs');
        }

        return mcqs.slice(0, mcqSettings.numMCQs);

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Gemini API error: ${errorMessage}`);
      }
    } else if (provider === 'groq') {
      try {
        const groqService = new GroqService(this.getApiKey());
        const systemPrompt = `You are an expert at creating multiple-choice questions. Generate MCQs following these rules:
1. Each MCQ must:
   - Have exactly 4 options
   - Have one correct answer
   - Use clear, plain text (no formatting)
   - Avoid bold formatting in options
2. Format each MCQ as:
   Q: [question]
   A: [correct option]
   B: [option]
   C: [option]
   D: [option]
   CORRECT: [A/B/C/D]
3. Generate exactly ${mcqSettings.numMCQs} MCQs based on content length.
4. Ensure comprehensive content coverage
${mcqSettings.customPrompt ? `Additional context: ${mcqSettings.customPrompt}` : ''}`;

        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: formattedContent }
        ];

        const responseText = await groqService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 8192, topP: getModelTopP(modelId, this.settings) }
        );

        const mcqs = this.parseMCQs(responseText);
        
        if (mcqs.length === 0) {
          throw new Error('Failed to generate valid MCQs');
        }

        return mcqs.slice(0, mcqSettings.numMCQs);

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Groq API error: ${errorMessage}`);
      }
    } else if (provider === 'openrouter') {
      try {
        const openRouterService = new OpenRouterService(this.getApiKey());
        const systemPrompt = `You are an expert at creating multiple-choice questions. Generate MCQs following these rules:
1. Each MCQ must:
   - Have exactly 4 options
   - Have one correct answer
   - Use clear, plain text (no formatting)
   - Avoid bold formatting in options
2. Format each MCQ as:
   Q: [question]
   A: [correct option]
   B: [option]
   C: [option]
   D: [option]
   CORRECT: [A/B/C/D]
3. Generate exactly ${mcqSettings.numMCQs} MCQs based on content length.
4. Ensure comprehensive content coverage
${mcqSettings.customPrompt ? `Additional context: ${mcqSettings.customPrompt}` : ''}`;

        const messages: OpenRouterChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: formattedContent }
        ];

        const responseText = await openRouterService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 8192, topP: getModelTopP(modelId, this.settings) }
        );

        const mcqs = this.parseMCQs(responseText);
        
        if (mcqs.length === 0) {
          throw new Error('Failed to generate valid MCQs');
        }

        return mcqs.slice(0, mcqSettings.numMCQs);

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`OpenRouter API error: ${errorMessage}`);
      }
    } else if (provider === 'ollama') {
      try {
        const ollamaService = new OllamaService(this.settings.ollamaBaseUrl, this.getApiKey());
        const systemPrompt = `You are an expert at creating multiple-choice questions. Generate MCQs following these rules:
1. Each MCQ must:
   - Have exactly 4 options
   - Have one correct answer
   - Use clear, plain text (no formatting)
   - Avoid bold formatting in options
2. Format each MCQ as:
   Q: [question]
   A: [correct option]
   B: [option]
   C: [option]
   D: [option]
   CORRECT: [A/B/C/D]
3. Generate exactly ${mcqSettings.numMCQs} MCQs based on content length.
4. Ensure comprehensive content coverage
${mcqSettings.customPrompt ? `Additional context: ${mcqSettings.customPrompt}` : ''}`;

        const messages: OllamaChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: formattedContent }
        ];

        const responseText = await ollamaService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 8192, topP: getModelTopP(modelId, this.settings) }
        );

        const mcqs = this.parseMCQs(responseText);
        
        if (mcqs.length === 0) {
          throw new Error('Failed to generate valid MCQs');
        }

        return mcqs.slice(0, mcqSettings.numMCQs);

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Ollama API error: ${errorMessage}`);
      }
    } else if (provider === 'nvidia') {
      try {
        const nvidiaService = new NvidiaService(this.getApiKey());
        const systemPrompt = `You are an expert at creating multiple-choice questions. Generate MCQs following these rules:
1. Each MCQ must:
   - Have exactly 4 options
   - Have one correct answer
   - Use clear, plain text (no formatting)
   - Avoid bold formatting in options
2. Format each MCQ as:
   Q: [question]
   A: [correct option]
   B: [option]
   C: [option]
   D: [option]
   CORRECT: [A/B/C/D]
3. Generate exactly ${mcqSettings.numMCQs} MCQs based on content length.
4. Ensure comprehensive content coverage
${mcqSettings.customPrompt ? `Additional context: ${mcqSettings.customPrompt}` : ''}`;

        const messages: NvidiaChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: formattedContent }
        ];

        const responseText = await nvidiaService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 8192, topP: getModelTopP(modelId, this.settings) }
        );

        const mcqs = this.parseMCQs(responseText);
        
        if (mcqs.length === 0) {
          throw new Error('Failed to generate valid MCQs');
        }

        return mcqs.slice(0, mcqSettings.numMCQs);

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`NVIDIA API error: ${errorMessage}`);
      }
    } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
      try {
        const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
        const systemPrompt = `You are an expert at creating multiple-choice questions. Generate MCQs following these rules:
1. Each MCQ must:
   - Have exactly 4 options
   - Have one correct answer
   - Use clear, plain text (no formatting)
   - Avoid bold formatting in options
2. Format each MCQ as:
   Q: [question]
   A: [correct option]
   B: [option]
   C: [option]
   D: [option]
   CORRECT: [A/B/C/D]
3. Generate exactly ${mcqSettings.numMCQs} MCQs based on content length.
4. Ensure comprehensive content coverage
${mcqSettings.customPrompt ? `Additional context: ${mcqSettings.customPrompt}` : ''}`;

        const response = await unifiedProvider.generateContent(
          modelId,
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: formattedContent }
          ],
          {
            temperature: getModelTemperature(modelId, this.settings),
            topP: getModelTopP(modelId, this.settings),
            maxTokens: 8192
          }
        );

        const mcqs = this.parseMCQs(response.text);
        if (mcqs.length === 0) {
          throw new Error('Failed to generate valid MCQs');
        }
        return mcqs.slice(0, mcqSettings.numMCQs);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`${provider} API error: ${errorMessage}`);
      }
    } else {
      try {
        const resp = await requestUrl({
          url: 'https://api.openai.com/v1/chat/completions',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.getApiKey()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: modelId,
            messages: [
              {
                role: 'system',
                content: `You are an expert at creating multiple-choice questions. Generate MCQs following these rules:\n                  1. Each MCQ must:\n                     - Have exactly 4 options\n                     - Have one correct answer\n                     - Use clear, plain text (no formatting)\n                     - Avoid bold formatting in options\n                  2. Format each MCQ as:\n                     Q: [question]\n                     A: [correct option]\n                     B: [option]\n                     C: [option]\n                     D: [option]\n                     CORRECT: [A/B/C/D]\n                  3. Generate exactly ${mcqSettings.numMCQs} MCQs based on content length.\n                  4. Ensure comprehensive content coverage\n                  ${mcqSettings.customPrompt ? `Additional context: ${mcqSettings.customPrompt}` : ''}`
              },
              { role: 'user', content: formattedContent }
            ]
          })
        });

        const mcqs = this.parseMCQs(resp.json.choices[0].message.content);
        
        if (mcqs.length === 0) {
          throw new Error('Failed to generate valid MCQs');
        }

        return mcqs.slice(0, mcqSettings.numMCQs);

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`OpenAI API error: ${errorMessage}`);
      }
    }
  }

  private parseMCQs(text: string): MCQ[] {
    const mcqs: MCQ[] = [];
    const mcqRegex = /Q:\s*([^\n]+)\nA:\s*([^\n]+)\nB:\s*([^\n]+)\nC:\s*([^\n]+)\nD:\s*([^\n]+)\nCORRECT:\s*([ABCD])/g;
    
    let match;
    while ((match = mcqRegex.exec(text)) !== null) {
      const [_, question, optA, optB, optC, optD, correct] = match;
      const correctIndex = correct.charCodeAt(0) - 'A'.charCodeAt(0);
      
      mcqs.push({
        question: question.trim(),
        options: [
          { text: optA.trim(), isCorrect: correctIndex === 0 },
          { text: optB.trim(), isCorrect: correctIndex === 1 },
          { text: optC.trim(), isCorrect: correctIndex === 2 },
          { text: optD.trim(), isCorrect: correctIndex === 3 }
        ]
      });
    }

    return mcqs;
  }

  async getAnswerExplanation(question: string, correctOption: string): Promise<string> {
    try {
      const provider = this.settings.aiTutorProvider || this.settings.provider;
      const modelId = this.settings.aiTutorModel || this.settings.model;

      if (provider === 'gemini') {
        const genAI = new GoogleGenerativeAI(this.getApiKey());
        const model = genAI.getGenerativeModel({ model: modelId });
        const result = await model.generateContent(
          `Given this MCQ question and its correct answer, provide a brief explanation (max 2 sentences) for why this is the correct answer:\n\nQuestion: ${question}\nCorrect Answer: ${correctOption}`
        );
        return result.response.text().trim();
      } else if (provider === 'groq') {
        const groqService = new GroqService(this.getApiKey());
        const messages: ChatMessage[] = [
          { role: 'system', content: 'Provide a brief explanation (max 2 sentences) for why the given answer is correct.' },
          { role: 'user', content: `Question: ${question}\nCorrect Answer: ${correctOption}` }
        ];
        const responseText = await groqService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 256, topP: getModelTopP(modelId, this.settings) }
        );
        return responseText.trim();
      } else if (provider === 'openrouter') {
        const openRouterService = new OpenRouterService(this.getApiKey());
        const messages: OpenRouterChatMessage[] = [
          { role: 'system', content: 'Provide a brief explanation (max 2 sentences) for why the given answer is correct.' },
          { role: 'user', content: `Question: ${question}\nCorrect Answer: ${correctOption}` }
        ];
        const responseText = await openRouterService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 256, topP: getModelTopP(modelId, this.settings) }
        );
        return responseText.trim();
      } else if (provider === 'ollama') {
        const ollamaService = new OllamaService(this.settings.ollamaBaseUrl, this.getApiKey());
        const messages: OllamaChatMessage[] = [
          { role: 'system', content: 'Provide a brief explanation (max 2 sentences) for why the given answer is correct.' },
          { role: 'user', content: `Question: ${question}\nCorrect Answer: ${correctOption}` }
        ];
        const responseText = await ollamaService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 256, topP: getModelTopP(modelId, this.settings) }
        );
        return responseText.trim();
      } else if (provider === 'nvidia') {
        const nvidiaService = new NvidiaService(this.getApiKey());
        const messages: NvidiaChatMessage[] = [
          { role: 'system', content: 'Provide a brief explanation (max 2 sentences) for why the given answer is correct.' },
          { role: 'user', content: `Question: ${question}\nCorrect Answer: ${correctOption}` }
        ];
        const responseText = await nvidiaService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 256, topP: getModelTopP(modelId, this.settings) }
        );
        return responseText.trim();
      } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
        const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
        const response = await unifiedProvider.generateContent(
          modelId,
          [
            { role: 'system', content: 'Provide a brief explanation (max 2 sentences) for why the given answer is correct.' },
            { role: 'user', content: `Question: ${question}\nCorrect Answer: ${correctOption}` }
          ],
          {
            temperature: getModelTemperature(modelId, this.settings),
            maxTokens: 256,
            topP: getModelTopP(modelId, this.settings)
          }
        );
        return response.text.trim();
      } else {
        const resp = await requestUrl({
          url: 'https://api.openai.com/v1/chat/completions',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.getApiKey()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: modelId,
            messages: [
              {
                role: 'system',
                content: 'Provide a brief explanation (max 2 sentences) for why the given answer is correct.'
              },
              {
                role: 'user',
                content: `Question: ${question}\nCorrect Answer: ${correctOption}`
              }
            ]
          })
        });
        return resp.json.choices[0].message.content.trim();
      }
    } catch (error) {
            return 'Explanation unavailable';
    }
  }

  evaluateMCQs(mcqs: MCQ[], correctMarks: number = 1, incorrectMarks: number = 0): { result: MCQResult; incorrectAnswers: Array<{ questionNumber: number; wrongOption: string; correctOption: string; explanation?: string }> } {
    let correctAttempts = 0;
    let incorrectAttempts = 0;
    let attemptedQuestions = 0;
    const incorrectAnswers: Array<{
      questionNumber: number;
      wrongOption: string;
      correctOption: string;
      explanation?: string;
    }> = [];

    mcqs.forEach((mcq, i) => {
      const correctOptionIndex = mcq.options.findIndex(opt => opt.isCorrect);
      
      if (mcq.selectedOption !== undefined) {
        attemptedQuestions++;
        const selectedOption = mcq.options[mcq.selectedOption];

        if (!selectedOption.isCorrect) {
          incorrectAttempts++;
          incorrectAnswers.push({
            questionNumber: i + 1,
            wrongOption: String.fromCharCode(65 + mcq.selectedOption),
            correctOption: String.fromCharCode(65 + correctOptionIndex)
          });
        } else {
          correctAttempts++;
        }
      }
    });

    const marks = (correctAttempts * correctMarks) - (incorrectAttempts * Math.abs(incorrectMarks));
    const accuracy = attemptedQuestions > 0 ? (correctAttempts / attemptedQuestions) * 100 : 0;

    const result: MCQResult = {
      correctAttempts,
      incorrectAttempts,
      marks: Math.max(0, marks),
      accuracy
    };

    return { result, incorrectAnswers };
  }

  async renderMarkdown(content: string, container: HTMLElement) {
    { const _comp = new Component();
    await MarkdownRenderer.renderMarkdown(content, container, '.', _comp);
    _comp.load(); }
  }
}

export class MCQSettingsModal extends Modal {
  private initialSelectedPaths: Set<string>;
  private onSubmit: (settings: MCQSettings) => void;
  private settings: AISettings;

  private numMCQs: number = 20;
  private filename: string = 'AI-Tutor-MCQ-Session';
  private saveDirectory: string;
  private customPrompt: string = '';
  private correctMarks: number = 1;
  private incorrectMarks: number = 0;

  constructor(app: any, pluginSettings: AISettings, initialSelectedPaths: Set<string>, onSubmit: (settings: MCQSettings) => void) {
    super(app);
    this.initialSelectedPaths = initialSelectedPaths;
    this.onSubmit = onSubmit;
    this.settings = pluginSettings;
    this.saveDirectory = this.settings.saveDirectory?.trim() || '';
    this.modalEl.addClass('mcq-settings-modal');
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'MCQ Generation Settings' });

    new Setting(contentEl)
      .setName('Number of MCQs')
      .setDesc('Set the maximum number of multiple-choice questions to generate.')
      .addText(text => text
        .setPlaceholder('e.g., 15')
        .setValue(this.numMCQs.toString())
        .onChange(value => {
          const num = parseInt(value);
          if (!isNaN(num) && num > 0) {
            this.numMCQs = num;
          } else {
            new Notice('Please enter a valid number greater than 0.');
          }
        }));

    new Setting(contentEl)
      .setName('Session Filename')
      .setDesc('Enter the filename for the saved MCQ session (e.g., MyMCQSession).')
      .addText(text => text
        .setPlaceholder('AI-Tutor-MCQ-Session')
        .setValue(this.filename)
        .onChange(value => {
          this.filename = value.trim();
        }));

    new Setting(contentEl)
      .setName('Save Directory')
      .setDesc('Optional: Directory to save the session. Defaults to settings directory.')
      .addText(text => {
        text.setPlaceholder('e.g., Daily Notes/Study')
          .setValue(this.saveDirectory)
          .onChange(value => {
            this.saveDirectory = value.trim();
          });
        new DirectorySuggester(this.app, text.inputEl, (path) => {
          this.saveDirectory = path;
          text.inputEl.value = path;
        }, this.saveDirectory);
      });

    new Setting(contentEl)
      .setName('Custom Prompt (Optional)')
      .setDesc('Provide additional instructions or context for the AI when generating MCQs.')
      .addTextArea(text => text
        .setPlaceholder('e.g., Include questions on historical context and future implications.')
        .setValue(this.customPrompt)
        .onChange(value => {
          this.customPrompt = value;
        }));

    // Marking Scheme section
    contentEl.createEl('h3', { text: 'Marking Scheme' });
    
    new Setting(contentEl)
      .setName('Marks for Correct Answer')
      .setDesc('Points awarded for each correct answer.')
      .addText(text => text
        .setPlaceholder('1')
        .setValue(this.correctMarks.toString())
        .onChange(value => {
          const num = parseFloat(value);
          if (!isNaN(num) && num >= 0) {
            this.correctMarks = num;
          } else {
            new Notice('Please enter a valid positive number.');
          }
        }));

    new Setting(contentEl)
      .setName('Marks for Incorrect Answer')
      .setDesc('Points deducted for each incorrect answer. Use 0 for no negative marking.')
      .addText(text => text
        .setPlaceholder('0')
        .setValue(this.incorrectMarks.toString())
        .onChange(value => {
          const num = parseFloat(value);
          if (!isNaN(num) && num >= 0) {
            this.incorrectMarks = num;
          } else {
            new Notice('Please enter a valid positive number or 0.');
          }
        }));

    new Setting(contentEl)
      .setName('Selected Notes')
      .setDesc('Notes that will be used for MCQ generation.')
      .addTextArea(text => {
        text
          .setValue(Array.from(this.initialSelectedPaths).map(path => {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
              return file.basename;
            } else {
              return path; // Fallback to path if not a TFile
            }
          }).join('\n'))
          .setDisabled(true) // Make it read-only
          .inputEl.addClass('selected-notes-textarea');
      });

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());

    new ButtonComponent(buttonContainer)
      .setButtonText('Generate MCQs')
      .setCta()
      .onClick(() => {
        if (!this.filename) {
          new Notice('Filename is mandatory.');
          return;
        }
        if (this.numMCQs <= 0) {
          new Notice('Number of MCQs must be greater than 0.');
          return;
        }
        this.onSubmit({
          numMCQs: this.numMCQs,
          filename: this.filename,
          saveDirectory: this.saveDirectory,
          customPrompt: this.customPrompt,
          correctMarks: this.correctMarks,
          incorrectMarks: this.incorrectMarks
        });
        this.close();
      });
  }
} 