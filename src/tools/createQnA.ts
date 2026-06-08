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

export interface Question {
  text: string;
  answer?: string;
  feedback?: string;
  relevanceScore?: number;
}

export interface QASettings {
  numQuestions: number;
  filename: string;
  saveDirectory: string;
  customPrompt: string;
}

export class QnAManager {
  private settings: AISettings;
  private app: SafeAny;

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

  async generateQuestions(notePaths: string[], qaSettings: QASettings = { numQuestions: 5, filename: 'AI-Tutor-Q&A-Session', saveDirectory: '', customPrompt: '' }, onProgress?: (percentage: number, status: string) => void): Promise<Question[]> {
    if (!this.validateSettings()) {
      throw new Error('Invalid settings');
    }

    onProgress?.(10, 'Reading selected notes...');

    let questions: string[] = [];

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

    onProgress?.(60, 'Generating questions with AI...');

    if (provider === 'gemini') {
      try {
        const genAI = new GoogleGenerativeAI(this.getApiKey());
        const model = genAI.getGenerativeModel({ model: modelId });
        
        const prompt = `Analyze the provided content carefully and generate exactly ${qaSettings.numQuestions} comprehensive study questions. Follow these requirements exactly:\n\n1. Content Coverage:\n   - Each question MUST cover different key concepts from the content\n   - Questions should require understanding of relationships between multiple concepts\n   - Ensure all major topics from the content are addressed across the ${qaSettings.numQuestions} questions\n   - Questions should test deep understanding, not just recall\n\n2. Question Structure:\n   - Make each question detailed and specific\n   - Use **bold** for key terms and concepts\n   - Include relevant context in the questions\n   - Questions should encourage critical thinking and analysis\n\n3. Formatting Requirements:\n   - Use consistent markdown formatting throughout\n   - Each question should be on its own line\n   - NO numbering, NO bullet points, NO prefixes (e.g., "Question 1:", "- ").\n   - NO introductory text or explanatory notes (e.g., "Here are your questions:").\n   - Ensure proper placement of markdown symbols.\n\nExample of desired output format for 2 questions:\nHow does **X** interact with **Y**?\nWhat are the implications of **Z** on **A**?\n\n${qaSettings.customPrompt ? `Additional context for question generation: ${qaSettings.customPrompt}\n\n` : ''}${formattedContent ? `Here are the notes to analyze:\n\n${formattedContent}\n\n` : ''}Generate exactly ${qaSettings.numQuestions} comprehensive questions now:`;

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
            maxOutputTokens: 2048,
          },
        });

        const response = await result.response;
        onProgress?.(90, 'Parsing and formatting response...');
        questions = response.text()
          .split('\n')
          .map(line => line.trim())
          .filter(line => 
            line.length > 0 && 
            !line.toLowerCase().includes('here are') &&
            !line.toLowerCase().includes('questions:') &&
            !line.match(/^\d+[\.\)]/) &&
            !line.match(/^[a-zA-Z]\.\s/) &&
            !line.match(/^[-*+]\s/)
          )
          .slice(0, qaSettings.numQuestions);

        if (questions.length < qaSettings.numQuestions) {
          throw new Error('Please change the AI model and try again');
        }

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Gemini API error: ${errorMessage}`);
      }
    } else if (provider === 'groq') {
      try {
        const groqService = new GroqService(this.getApiKey());
        const systemPrompt = `You are an expert tutor who creates comprehensive study questions. Follow these requirements exactly:
1. Generate exactly ${qaSettings.numQuestions} questions that cover the entire content.
2. Each question must:
   - Cover different key concepts.
   - Test deep understanding.
   - Use proper markdown formatting.
   - Include key terms in **bold**.
   - Be specific and detailed.
3. Questions should encourage critical thinking and analysis.
4. Use consistent markdown formatting.
5. Return only the questions, one per line.
6. NO numbering, NO bullet points, NO prefixes (e.g., "Question 1:", "- ").
Example output for 2 questions:
How does **X** interact with **Y**?
What are the implications of **Z** on **A**?
${qaSettings.customPrompt ? `Additional context: ${qaSettings.customPrompt}` : ''}`;

        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: formattedContent }
        ];

        const responseText = await groqService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 2048, topP: getModelTopP(modelId, this.settings) }
        );

        questions = responseText
          .split(/\n+/)
          .filter((q: string) => 
            q.trim().length > 0 &&
            !q.match(/^\d+[\.\)]/) &&
            !q.match(/^[a-zA-Z]\.\s/) &&
            !q.match(/^[-*+]\s/)
          )
          .map((q: string) => q.replace(/^\d+[\.\)]\s*/, '').trim());

        if (questions.length < qaSettings.numQuestions) {
          throw new Error('Please change the AI model and try again');
        }

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Groq API error: ${errorMessage}`);
      }
    } else if (provider === 'openrouter') {
      try {
        const openRouterService = new OpenRouterService(this.getApiKey());
        const systemPrompt = `You are an expert tutor who creates comprehensive study questions. Follow these requirements exactly:
1. Generate exactly ${qaSettings.numQuestions} questions that cover the entire content.
2. Each question must:
   - Cover different key concepts.
   - Test deep understanding.
   - Use proper markdown formatting.
   - Include key terms in **bold**.
   - Be specific and detailed.
3. Questions should encourage critical thinking and analysis.
4. Use consistent markdown formatting.
5. Return only the questions, one per line.
6. NO numbering, NO bullet points, NO prefixes (e.g., "Question 1:", "- ").
Example output for 2 questions:
How does **X** interact with **Y**?
What are the implications of **Z** on **A**?
${qaSettings.customPrompt ? `Additional context: ${qaSettings.customPrompt}` : ''}`;

        const messages: OpenRouterChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: formattedContent }
        ];

        const responseText = await openRouterService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 2048, topP: getModelTopP(modelId, this.settings) }
        );

        questions = responseText
          .split(/\n+/)
          .filter((q: string) => 
            q.trim().length > 0 &&
            !q.match(/^\d+[\.\)]/) &&
            !q.match(/^[a-zA-Z]\.\s/) &&
            !q.match(/^[-*+]\s/)
          )
          .map((q: string) => q.replace(/^\d+[\.\)]\s*/, '').trim());

        if (questions.length < qaSettings.numQuestions) {
          throw new Error('Please change the AI model and try again');
        }

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`OpenRouter API error: ${errorMessage}`);
      }
    } else if (provider === 'ollama') {
      try {
        const ollamaService = new OllamaService(this.settings.ollamaBaseUrl, this.getApiKey());
        const systemPrompt = `You are an expert tutor who creates comprehensive study questions. Follow these requirements exactly:
1. Generate exactly ${qaSettings.numQuestions} questions that cover the entire content.
2. Each question must:
   - Cover different key concepts.
   - Test deep understanding.
   - Use proper markdown formatting.
   - Include key terms in **bold**.
   - Be specific and detailed.
3. Questions should encourage critical thinking and analysis.
4. Use consistent markdown formatting.
5. Return only the questions, one per line.
6. NO numbering, NO bullet points, NO prefixes (e.g., "Question 1:", "- ").
Example output for 2 questions:
How does **X** interact with **Y**?
What are the implications of **Z** on **A**?
${qaSettings.customPrompt ? `Additional context: ${qaSettings.customPrompt}` : ''}`;

        const messages: OllamaChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: formattedContent }
        ];

        const responseText = await ollamaService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 2048, topP: getModelTopP(modelId, this.settings) }
        );

        questions = responseText
          .split(/\n+/)
          .filter((q: string) => 
            q.trim().length > 0 &&
            !q.match(/^\d+[\.\)]/) &&
            !q.match(/^[a-zA-Z]\.\s/) &&
            !q.match(/^[-*+]\s/)
          )
          .map((q: string) => q.replace(/^\d+[\.\)]\s*/, '').trim());

        if (questions.length < qaSettings.numQuestions) {
          throw new Error('Please change the AI model and try again');
        }

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Ollama API error: ${errorMessage}`);
      }
    } else if (provider === 'nvidia') {
      try {
        const nvidiaService = new NvidiaService(this.getApiKey());
        const systemPrompt = `You are an expert tutor who creates comprehensive study questions. Follow these requirements exactly:
1. Generate exactly ${qaSettings.numQuestions} questions that cover the entire content.
2. Each question must:
   - Cover different key concepts.
   - Test deep understanding.
   - Use proper markdown formatting.
   - Include key terms in **bold**.
   - Be specific and detailed.
3. Questions should encourage critical thinking and analysis.
4. Use consistent markdown formatting.
5. Return only the questions, one per line.
6. NO numbering, NO bullet points, NO prefixes (e.g., "Question 1:", "- ").
Example output for 2 questions:
How does **X** interact with **Y**?
What are the implications of **Z** on **A**?
${qaSettings.customPrompt ? `Additional context: ${qaSettings.customPrompt}` : ''}`;

        const messages: NvidiaChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: formattedContent }
        ];

        const responseText = await nvidiaService.generateContent(
          modelId,
          messages,
          { temperature: getModelTemperature(modelId, this.settings), maxTokens: 2048, topP: getModelTopP(modelId, this.settings) }
        );

        questions = responseText
          .split(/\n+/)
          .filter((q: string) => 
            q.trim().length > 0 &&
            !q.match(/^\d+[\.\)]/) &&
            !q.match(/^[a-zA-Z]\.\s/) &&
            !q.match(/^[-*+]\s/)
          )
          .map((q: string) => q.replace(/^\d+[\.\)]\s*/, '').trim());

        if (questions.length < qaSettings.numQuestions) {
          throw new Error('Please change the AI model and try again');
        }

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`NVIDIA API error: ${errorMessage}`);
      }
    } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
      try {
        const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
        const systemPrompt = `You are an expert tutor who creates comprehensive study questions. Follow these requirements exactly:
1. Generate exactly ${qaSettings.numQuestions} questions that cover the entire content.
2. Each question must:
   - Cover different key concepts.
   - Test deep understanding.
   - Use proper markdown formatting.
   - Include key terms in **bold**.
   - Be specific and detailed.
3. Questions should encourage critical thinking and analysis.
4. Use consistent markdown formatting.
5. Return only the questions, one per line.
6. NO numbering, NO bullet points, NO prefixes (e.g., "Question 1:", "- ").
Example output for 2 questions:
How does **X** interact with **Y**?
What are the implications of **Z** on **A**?
${qaSettings.customPrompt ? `Additional context: ${qaSettings.customPrompt}` : ''}`;

        const response = await unifiedProvider.generateContent(
          modelId,
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: formattedContent }
          ],
          {
            temperature: getModelTemperature(modelId, this.settings),
            maxTokens: 2048,
            topP: getModelTopP(modelId, this.settings)
          }
        );

        questions = response.text
          .split(/\n+/)
          .filter((q: string) => 
            q.trim().length > 0 &&
            !q.match(/^\d+[\.\)]/) &&
            !q.match(/^[a-zA-Z]\.\s/) &&
            !q.match(/^[-*+]\s/)
          )
          .map((q: string) => q.replace(/^\d+[\.\)]\s*/, '').trim());

        if (questions.length < qaSettings.numQuestions) {
          throw new Error('Please change the AI model and try again');
        }
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
            model: this.settings.model,
            messages: [
              {
                role: 'system',
                content: `You are an expert tutor who creates comprehensive study questions. Follow these requirements exactly:\n                  1. Generate exactly ${qaSettings.numQuestions} questions that cover the entire content.\n                  2. Each question must:\n                     - Cover different key concepts.\n                     - Test deep understanding.\n                     - Use proper markdown formatting.\n                     - Include key terms in **bold**.\n                     - Be specific and detailed.\n                  3. Questions should encourage critical thinking and analysis.\n                  4. Use consistent markdown formatting.\n                  5. Return only the questions, one per line.\n                  6. NO numbering, NO bullet points, NO prefixes (e.g., "Question 1:", "- ").\n                  Example output for 2 questions:\n                  How does **X** interact with **Y**?\n                  What are the implications of **Z** on **A**?\n                  ${qaSettings.customPrompt ? `Additional context: ${qaSettings.customPrompt}` : ''}`
              },
              { role: 'user', content: formattedContent }
            ]
          })
        });
        
        const data = resp.json;
        questions = (data.choices[0].message.content || '')
          .split(/\n+/)
          .filter((q: string) => 
            q.trim().length > 0 &&
            !q.match(/^\d+[\.\)]/) &&
            !q.match(/^[a-zA-Z]\.\s/) &&
            !q.match(/^[-*+]\s/)
          )
          .map((q: string) => q.replace(/^\d+[\.\)]\s*/, '').trim());
        
        if (questions.length < qaSettings.numQuestions) {
          throw new Error('Please change the AI model and try again');
        }
        
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`OpenAI API error: ${errorMessage}`);
      }
    }

    if (questions.length === 0) {
      throw new Error('No questions were generated. Please try again.');
    }

    return questions.map((q: string) => ({ text: q }));
  }

  async evaluateAnswer(question: Question): Promise<{ feedback: string; relevanceScore: number }> {
    if (!this.validateSettings()) {
      throw new Error('Invalid settings');
    }

    let feedback = '';
    let relevanceScore = 0;

    const evaluationPrompt = `Question: ${question.text}\n\nStudent's answer: ${question.answer}\n\nTask 1: Calculate a relevance score between 0 and 100 based on how well the answer addresses the key concepts and demonstrates understanding. Return only the number.\n\nTask 2: Provide constructive feedback using markdown formatting. Include what was correct and what could be improved. Format your response with proper markdown for emphasis and structure.\n\nRespond in this exact format:\nSCORE: [number]\n---\n[feedback]`;

    const provider = this.settings.aiTutorProvider || this.settings.provider;
    const modelId = this.settings.aiTutorModel || this.settings.model;

    if (provider === 'gemini') {
      const genAI = new GoogleGenerativeAI(this.getApiKey());
      const model = genAI.getGenerativeModel({ model: modelId });
      const result = await model.generateContent(evaluationPrompt);
      const response = await result.response;
      const responseText = response.text();
      
      // Extract score and feedback
      const scoreMatch = responseText.match(/SCORE:\s*(\d+)/);
      if (scoreMatch) {
        relevanceScore = Math.min(100, Math.max(0, parseInt(scoreMatch[1])));
      }
      feedback = responseText.split('---')[1]?.trim() || responseText;
    } else if (provider === 'groq') {
      const groqService = new GroqService(this.getApiKey());
      const systemPrompt = `You are an expert tutor evaluating student answers. For each answer:
1. Calculate a relevance score (0-100) based on how well it addresses key concepts
2. Provide constructive feedback with specific suggestions
3. Format your response exactly as:
SCORE: [number]
---
[markdown formatted feedback]`;

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Question: ${question.text}\n\nStudent's answer: ${question.answer}` }
      ];

      const responseText = await groqService.generateContent(
        modelId,
        messages,
        { temperature: getModelTemperature(modelId, this.settings), maxTokens: 2048, topP: getModelTopP(modelId, this.settings) }
      );

      const scoreMatch = responseText.match(/SCORE:\s*(\d+)/);
      if (scoreMatch) {
        relevanceScore = Math.min(100, Math.max(0, parseInt(scoreMatch[1])));
      }
      feedback = responseText.split('---')[1]?.trim() || responseText;
    } else if (provider === 'openrouter') {
      const openRouterService = new OpenRouterService(this.getApiKey());
      const systemPrompt = `You are an expert tutor evaluating student answers. For each answer:
1. Calculate a relevance score (0-100) based on how well it addresses key concepts
2. Provide constructive feedback with specific suggestions
3. Format your response exactly as:
SCORE: [number]
---
[markdown formatted feedback]`;

      const messages: OpenRouterChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Question: ${question.text}\n\nStudent's answer: ${question.answer}` }
      ];

      const responseText = await openRouterService.generateContent(
        modelId,
        messages,
        { temperature: getModelTemperature(modelId, this.settings), maxTokens: 2048, topP: getModelTopP(modelId, this.settings) }
      );

      const scoreMatch = responseText.match(/SCORE:\s*(\d+)/);
      if (scoreMatch) {
        relevanceScore = Math.min(100, Math.max(0, parseInt(scoreMatch[1])));
      }
      feedback = responseText.split('---')[1]?.trim() || responseText;
    } else if (provider === 'ollama') {
      const ollamaService = new OllamaService(this.settings.ollamaBaseUrl, this.getApiKey());
      const systemPrompt = `You are an expert tutor evaluating student answers. For each answer:
1. Calculate a relevance score (0-100) based on how well it addresses key concepts
2. Provide constructive feedback with specific suggestions
3. Format your response exactly as:
SCORE: [number]
---
[markdown formatted feedback]`;

      const messages: OllamaChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Question: ${question.text}\n\nStudent's answer: ${question.answer}` }
      ];

      const responseText = await ollamaService.generateContent(
        modelId,
        messages,
        { temperature: getModelTemperature(modelId, this.settings), maxTokens: 2048, topP: getModelTopP(modelId, this.settings) }
      );

      const scoreMatch = responseText.match(/SCORE:\s*(\d+)/);
      if (scoreMatch) {
        relevanceScore = Math.min(100, Math.max(0, parseInt(scoreMatch[1])));
      }
      feedback = responseText.split('---')[1]?.trim() || responseText;
    } else if (provider === 'nvidia') {
      const nvidiaService = new NvidiaService(this.getApiKey());
      const systemPrompt = `You are an expert tutor evaluating student answers. For each answer:
1. Calculate a relevance score (0-100) based on how well it addresses key concepts
2. Provide constructive feedback with specific suggestions
3. Format your response exactly as:
SCORE: [number]
---
[markdown formatted feedback]`;

      const messages: NvidiaChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Question: ${question.text}\n\nStudent's answer: ${question.answer}` }
      ];

      const responseText = await nvidiaService.generateContent(
        modelId,
        messages,
        { temperature: getModelTemperature(modelId, this.settings), maxTokens: 2048, topP: getModelTopP(modelId, this.settings) }
      );

      const scoreMatch = responseText.match(/SCORE:\s*(\d+)/);
      if (scoreMatch) {
        relevanceScore = Math.min(100, Math.max(0, parseInt(scoreMatch[1])));
      }
      feedback = responseText.split('---')[1]?.trim() || responseText;
    } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
      const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
      const systemPrompt = `You are an expert tutor evaluating student answers. For each answer:
1. Calculate a relevance score (0-100) based on how well it addresses key concepts
2. Provide constructive feedback with specific suggestions
3. Format your response exactly as:
SCORE: [number]
---
[markdown formatted feedback]`;

      const response = await unifiedProvider.generateContent(
        modelId,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Question: ${question.text}\n\nStudent's answer: ${question.answer}` }
        ],
        {
          temperature: getModelTemperature(modelId, this.settings),
          maxTokens: 2048,
          topP: getModelTopP(modelId, this.settings)
        }
      );

      const responseText = response.text;
      const scoreMatch = responseText.match(/SCORE:\s*(\d+)/);
      if (scoreMatch) {
        relevanceScore = Math.min(100, Math.max(0, parseInt(scoreMatch[1])));
      }
      feedback = responseText.split('---')[1]?.trim() || responseText;
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
              content: `You are an expert tutor evaluating student answers. For each answer:
              1. Calculate a relevance score (0-100) based on how well it addresses key concepts
              2. Provide constructive feedback with specific suggestions
              3. Format your response exactly as:
              SCORE: [number]
              ---
              [markdown formatted feedback]`
            },
            {
              role: 'user',
              content: `Question: ${question.text}\n\nStudent's answer: ${question.answer}`
            }
          ]
        })
      });

      const responseText = resp.json.choices[0].message.content;
      const scoreMatch = responseText.match(/SCORE:\s*(\d+)/);
      if (scoreMatch) {
        relevanceScore = Math.min(100, Math.max(0, parseInt(scoreMatch[1])));
      }
      feedback = responseText.split('---')[1]?.trim() || responseText;
    }

    return { feedback, relevanceScore };
  }

  async renderMarkdown(content: string, container: HTMLElement) {
    { const _comp = new Component();
    await MarkdownRenderer.renderMarkdown(content, container, '.', _comp);
    _comp.load(); }
  }
}

export class QASettingsModal extends Modal {
  private initialSelectedPaths: Set<string>;
  private onSubmit: (settings: QASettings) => void;
  private settings: AISettings;

  private numQuestions: number = 5;
  private filename: string = 'AI-Tutor-Q&A-Session';
  private saveDirectory: string;
  private customPrompt: string = '';

  constructor(app: SafeAny, pluginSettings: AISettings, initialSelectedPaths: Set<string>, onSubmit: (settings: QASettings) => void) {
    super(app);
    this.initialSelectedPaths = initialSelectedPaths;
    this.onSubmit = onSubmit;
    this.settings = pluginSettings;
    this.saveDirectory = this.settings.saveDirectory?.trim() || '';
    this.modalEl.addClass('qa-settings-modal');
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Q&A Generation Settings' });

    new Setting(contentEl)
      .setName('Number of Questions')
      .setDesc('Set the number of questions to generate for the Q&A session.')
      .addText(text => text
        .setPlaceholder('e.g., 10')
        .setValue(this.numQuestions.toString())
        .onChange(value => {
          const num = parseInt(value);
          if (!isNaN(num) && num > 0) {
            this.numQuestions = num;
          } else {
            new Notice('Please enter a valid number greater than 0.');
          }
        }));

    new Setting(contentEl)
      .setName('Session Filename')
      .setDesc('Enter the filename for the saved Q&A session (e.g., MyStudySession).')
      .addText(text => text
        .setPlaceholder('AI-Tutor-Q&A-Session')
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
      .setDesc('Provide additional instructions or context for the AI when generating questions.')
      .addTextArea(text => text
        .setPlaceholder('e.g., Focus on advanced concepts and interdisciplinary connections.')
        .setValue(this.customPrompt)
        .onChange(value => {
          this.customPrompt = value;
        }));

    new Setting(contentEl)
      .setName('Selected Notes')
      .setDesc('Notes that will be used for Q&A generation.')
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
      .setButtonText('Generate Q&A')
      .setCta()
      .onClick(() => {
        if (!this.filename) {
          new Notice('Filename is mandatory.');
          return;
        }
        if (this.numQuestions <= 0) {
          new Notice('Number of questions must be greater than 0.');
          return;
        }
        this.onSubmit({
          numQuestions: this.numQuestions,
          filename: this.filename,
          saveDirectory: this.saveDirectory,
          customPrompt: this.customPrompt
        });
        this.close();
      });
  }
} 