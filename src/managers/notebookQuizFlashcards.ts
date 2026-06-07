import { App, Notice, MarkdownRenderer, Component, setIcon } from 'obsidian';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AISettings, getModelTemperature, getModelTopP } from '../settings';
import { GroqService, ChatMessage } from '../services/groqService';
import { OpenRouterService, ChatMessage as OpenRouterChatMessage } from '../services/openRouterService';
import { OllamaService, ChatMessage as OllamaChatMessage } from '../services/ollamaService';
import { NvidiaService, ChatMessage as NvidiaChatMessage } from '../services/nvidiaService';
import { RateLimitManager } from '../utils/rateLimitManager';
import { GeminiService } from '../services/geminiService';
import { UnifiedProviderManager } from '../services/unifiedProviderManager';



export interface NotebookMCQOption {
  text: string;
  isCorrect: boolean;
}

export interface NotebookMCQ {
  id: string;
  question: string;
  options: NotebookMCQOption[];
  selectedOption?: number;
  isAnswered: boolean;
  isCorrect?: boolean;
}

export interface NotebookFlashcard {
  id: string;
  front: string;
  back: string;
}

export interface QuizState {
  mcqs: NotebookMCQ[];
  query: string;
  timestamp: number;
}

export interface FlashcardState {
  flashcards: NotebookFlashcard[];
  currentIndex: number;
  query: string;
  timestamp: number;
  recallMap?: Record<string, 'red' | 'orange' | 'green'>;
  filter?: 'red' | 'orange' | 'green' | 'all';
}



export class NotebookQuizGenerator {
  private settings: AISettings;
  private app: App;
  private rateLimitManager: RateLimitManager;
  private provider: string;
  private model: string;

  constructor(app: App, settings: AISettings, rateLimitManager: RateLimitManager, provider?: string, model?: string) {
    this.app = app;
    this.settings = settings;
    this.rateLimitManager = rateLimitManager;
    this.provider = provider || this.settings.provider;
    this.model = model || this.settings.model;
  }

  private getApiKey(): string {
    if (this.provider === 'groq') {
      return this.settings.groqApiKey;
    } else if (this.provider === 'openrouter') {
      return this.settings.openRouterApiKey;
    } else if (this.provider === 'ollama') {
      return this.settings.ollamaApiKey || '';
    } else if (this.provider === 'nvidia') {
      return this.settings.nvidiaApiKey;
    }
    return this.settings.geminiApiKey || this.settings.apiKey;
  }

  async generateMCQs(context: string, query: string): Promise<NotebookMCQ[]> {
    const prompt = `Based on the following content, generate multiple-choice questions.

USER REQUEST: "${query}"

CONTENT:
${context}

CRITICAL GROUNDING REQUIREMENT:
- You MUST generate questions ONLY from the content provided above
- Do NOT use any external knowledge or information from your training data
- Do NOT create questions about concepts not explicitly covered in the content
- Every question and answer must be directly traceable to the provided content

INSTRUCTIONS:
- If the user specifies a number of questions, generate that many
- If the user asks to "cover the content entirely" or similar, generate enough questions to comprehensively test all key concepts (typically 1-2 questions per major topic/concept)
- If no specific count is mentioned, generate 5 questions as default
- Focus on the most important concepts and facts from the content

REQUIREMENTS:
1. Each question must have exactly 4 options (A, B, C, D)
2. Only ONE option should be correct
3. Questions should test understanding of the content
4. Make distractors plausible but clearly incorrect
5. Format EXACTLY as shown below:

Q: [question text]
A: [option A text]
B: [option B text]
C: [option C text]
D: [option D text]
CORRECT: [A/B/C/D]

Generate the MCQs now:`;

    let responseText = '';

    if (this.provider === 'gemini') {
      const geminiService = new GeminiService(
        this.getApiKey(),
        (headers) => this.rateLimitManager.updateFromHeaders('gemini', this.model, headers)
      );
      
      const quizTemperature = Math.min(getModelTemperature(this.model, this.settings), 0.3);
      responseText = await geminiService.generateContentWithHeaders(
        this.model,
        prompt,
        { temperature: quizTemperature, maxOutputTokens: 4096 }
      );
    } else if (this.provider === 'groq') {
      const groqService = new GroqService(
        this.getApiKey(),
        (headers) => this.rateLimitManager.updateFromHeaders('groq', this.model, headers)
      );
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are an expert quiz generator. Generate MCQs in the exact format specified. You MUST only use information from the provided content - do not use any external knowledge.' },
        { role: 'user', content: prompt }
      ];
      
      const quizTemperature = Math.min(getModelTemperature(this.model, this.settings), 0.3);
      responseText = await groqService.generateContent(this.model, messages, { temperature: quizTemperature, topP: getModelTopP(this.model, this.settings) });
    } else if (this.provider === 'openrouter') {
      const openRouterService = new OpenRouterService(
        this.getApiKey(),
        (headers) => this.rateLimitManager.updateFromHeaders('openrouter', this.model, headers)
      );
      const messages: OpenRouterChatMessage[] = [
        { role: 'system', content: 'You are an expert quiz generator. Generate MCQs in the exact format specified. You MUST only use information from the provided content - do not use any external knowledge.' },
        { role: 'user', content: prompt }
      ];
      
      const quizTemperature = Math.min(getModelTemperature(this.model, this.settings), 0.3);
      responseText = await openRouterService.generateContent(this.model, messages, { temperature: quizTemperature, maxTokens: 4096, topP: getModelTopP(this.model, this.settings) });
    } else if (this.provider === 'ollama') {
      const ollamaService = new OllamaService(
        this.settings.ollamaBaseUrl,
        this.getApiKey(),
        (headers) => this.rateLimitManager.updateFromHeaders('ollama', this.model, headers)
      );
      const messages: OllamaChatMessage[] = [
        { role: 'system', content: 'You are an expert quiz generator. Generate MCQs in the exact format specified. You MUST only use information from the provided content - do not use any external knowledge.' },
        { role: 'user', content: prompt }
      ];
      
      const quizTemperature = Math.min(getModelTemperature(this.model, this.settings), 0.3);
      responseText = await ollamaService.generateContent(this.model, messages, { temperature: quizTemperature, maxTokens: 4096, topP: getModelTopP(this.model, this.settings) });
    } else if (this.provider === 'nvidia') {
      const nvidiaService = new NvidiaService(
        this.getApiKey(),
        (headers) => this.rateLimitManager.updateFromHeaders('nvidia', this.model, headers)
      );
      const messages: NvidiaChatMessage[] = [
        { role: 'system', content: 'You are an expert quiz generator. Generate MCQs in the exact format specified. You MUST only use information from the provided content - do not use any external knowledge.' },
        { role: 'user', content: prompt }
      ];
      
      const quizTemperature = Math.min(getModelTemperature(this.model, this.settings), 0.3);
      responseText = await nvidiaService.generateContent(this.model, messages, { temperature: quizTemperature, maxTokens: 4096, topP: getModelTopP(this.model, this.settings) });
    } else if (UnifiedProviderManager.getInstance().hasProvider(this.provider)) {
      const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(this.provider)!;
      const quizTemperature = Math.min(getModelTemperature(this.model, this.settings), 0.3);
      const response = await unifiedProvider.generateContent(
        this.model,
        [
          { role: 'system', content: 'You are an expert quiz generator. Generate MCQs in the exact format specified. You MUST only use information from the provided content - do not use any external knowledge.' },
          { role: 'user', content: prompt }
        ],
        { temperature: quizTemperature, maxTokens: 4096, topP: getModelTopP(this.model, this.settings) }
      );
      responseText = response.text;
    }

    return this.parseMCQs(responseText);
  }

  private parseMCQs(text: string): NotebookMCQ[] {
    const mcqs: NotebookMCQ[] = [];
    const mcqRegex = /Q:\s*(.*?)\nA:\s*(.*?)\nB:\s*(.*?)\nC:\s*(.*?)\nD:\s*(.*?)\nCORRECT:\s*([ABCD])/gi;
    
    let match;
    let index = 0;
    while ((match = mcqRegex.exec(text)) !== null) {
      const [_, question, optA, optB, optC, optD, correct] = match;
      const correctIndex = correct.toUpperCase().trim().charCodeAt(0) - 'A'.charCodeAt(0);
      
      mcqs.push({
        id: `mcq-${Date.now()}-${index}`,
        question: question.trim(),
        options: [
          { text: optA.trim(), isCorrect: correctIndex === 0 },
          { text: optB.trim(), isCorrect: correctIndex === 1 },
          { text: optC.trim(), isCorrect: correctIndex === 2 },
          { text: optD.trim(), isCorrect: correctIndex === 3 }
        ],
        isAnswered: false
      });
      index++;
    }

    return mcqs;
  }
}



export class NotebookFlashcardGenerator {
  private settings: AISettings;
  private app: App;
  private rateLimitManager: RateLimitManager;
  private provider: string;
  private model: string;

  constructor(app: App, settings: AISettings, rateLimitManager: RateLimitManager, provider?: string, model?: string) {
    this.app = app;
    this.settings = settings;
    this.rateLimitManager = rateLimitManager;
    this.provider = provider || this.settings.provider;
    this.model = model || this.settings.model;
  }

  private getApiKey(): string {
    if (this.provider === 'groq') {
      return this.settings.groqApiKey;
    } else if (this.provider === 'openrouter') {
      return this.settings.openRouterApiKey;
    } else if (this.provider === 'ollama') {
      return this.settings.ollamaApiKey || '';
    } else if (this.provider === 'nvidia') {
      return this.settings.nvidiaApiKey;
    }
    return this.settings.geminiApiKey || this.settings.apiKey;
  }

  async generateFlashcards(context: string, query: string): Promise<NotebookFlashcard[]> {
    const prompt = `Based on the following content, generate flashcards for study.

USER REQUEST: "${query}"

CONTENT:
${context}

CRITICAL GROUNDING REQUIREMENT:
- You MUST generate flashcards ONLY from the content provided above
- Do NOT use any external knowledge or information from your training data
- Do NOT create flashcards about concepts not explicitly covered in the content
- Every flashcard must be directly traceable to the provided content

INSTRUCTIONS:
- If the user specifies a number of flashcards, generate that many
- If the user asks to "cover the content entirely" or similar, generate enough flashcards to cover all key terms, concepts, and facts (typically 1-2 cards per important concept)
- If no specific count is mentioned, generate 10 flashcards as default
- Focus on the most important and testable information

REQUIREMENTS:
1. Each flashcard should have a clear question/term on the front
2. The back should have a concise but complete answer/definition
3. Focus on key concepts, definitions, and important facts
4. Format EXACTLY as shown below:

FRONT: [question or term]
BACK: [answer or definition]
---

Generate the flashcards now:`;

    let responseText = '';

    if (this.provider === 'gemini') {
      const geminiService = new GeminiService(
        this.getApiKey(),
        (headers) => this.rateLimitManager.updateFromHeaders('gemini', this.model, headers)
      );
      
      const flashcardTemperature = Math.min(getModelTemperature(this.model, this.settings), 0.3);
      responseText = await geminiService.generateContentWithHeaders(
        this.model,
        prompt,
        { temperature: flashcardTemperature, maxOutputTokens: 4096 }
      );
    } else if (this.provider === 'groq') {
      const groqService = new GroqService(
        this.getApiKey(),
        (headers) => this.rateLimitManager.updateFromHeaders('groq', this.model, headers)
      );
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are an expert flashcard creator. Generate flashcards in the exact format specified. You MUST only use information from the provided content - do not use any external knowledge.' },
        { role: 'user', content: prompt }
      ];
      
      const flashcardTemperature = Math.min(getModelTemperature(this.model, this.settings), 0.3);
      responseText = await groqService.generateContent(this.model, messages, { temperature: flashcardTemperature, topP: getModelTopP(this.model, this.settings) });
    } else if (this.provider === 'openrouter') {
      const openRouterService = new OpenRouterService(
        this.getApiKey(),
        (headers) => this.rateLimitManager.updateFromHeaders('openrouter', this.model, headers)
      );
      const messages: OpenRouterChatMessage[] = [
        { role: 'system', content: 'You are an expert flashcard creator. Generate flashcards in the exact format specified. You MUST only use information from the provided content - do not use any external knowledge.' },
        { role: 'user', content: prompt }
      ];
      
      const flashcardTemperature = Math.min(getModelTemperature(this.model, this.settings), 0.3);
      responseText = await openRouterService.generateContent(this.model, messages, { temperature: flashcardTemperature, maxTokens: 4096, topP: getModelTopP(this.model, this.settings) });
    } else if (this.provider === 'ollama') {
      const ollamaService = new OllamaService(
        this.settings.ollamaBaseUrl,
        this.getApiKey(),
        (headers) => this.rateLimitManager.updateFromHeaders('ollama', this.model, headers)
      );
      const messages: OllamaChatMessage[] = [
        { role: 'system', content: 'You are an expert flashcard creator. Generate flashcards in the exact format specified. You MUST only use information from the provided content - do not use any external knowledge.' },
        { role: 'user', content: prompt }
      ];
      
      const flashcardTemperature = Math.min(getModelTemperature(this.model, this.settings), 0.3);
      responseText = await ollamaService.generateContent(this.model, messages, { temperature: flashcardTemperature, maxTokens: 4096, topP: getModelTopP(this.model, this.settings) });
    } else if (this.provider === 'nvidia') {
      const nvidiaService = new NvidiaService(
        this.getApiKey(),
        (headers) => this.rateLimitManager.updateFromHeaders('nvidia', this.model, headers)
      );
      const messages: NvidiaChatMessage[] = [
        { role: 'system', content: 'You are an expert flashcard creator. Generate flashcards in the exact format specified. You MUST only use information from the provided content - do not use any external knowledge.' },
        { role: 'user', content: prompt }
      ];
      
      const flashcardTemperature = Math.min(getModelTemperature(this.model, this.settings), 0.3);
      responseText = await nvidiaService.generateContent(this.model, messages, { temperature: flashcardTemperature, maxTokens: 4096, topP: getModelTopP(this.model, this.settings) });
    } else if (UnifiedProviderManager.getInstance().hasProvider(this.provider)) {
      const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(this.provider)!;
      const flashcardTemperature = Math.min(getModelTemperature(this.model, this.settings), 0.3);
      const response = await unifiedProvider.generateContent(
        this.model,
        [
          { role: 'system', content: 'You are an expert flashcard creator. Generate flashcards in the exact format specified. You MUST only use information from the provided content - do not use any external knowledge.' },
          { role: 'user', content: prompt }
        ],
        { temperature: flashcardTemperature, maxTokens: 4096, topP: getModelTopP(this.model, this.settings) }
      );
      responseText = response.text;
    }

    return this.parseFlashcards(responseText);
  }

  private parseFlashcards(text: string): NotebookFlashcard[] {
    const flashcards: NotebookFlashcard[] = [];
    const cardRegex = /FRONT:\s*(.*?)\nBACK:\s*(.*?)(?:\n---|$)/gis;
    
    let match;
    let index = 0;
    while ((match = cardRegex.exec(text)) !== null) {
      const [_, front, back] = match;
      flashcards.push({
        id: `fc-${Date.now()}-${index}`,
        front: front.trim(),
        back: back.trim()
      });
      index++;
    }

    return flashcards;
  }
}



export function triggerConfetti(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  
  const colors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#ffeaa7', '#dfe6e9', '#fd79a8', '#a29bfe'];
  const confettiCount = 30;
  
  for (let i = 0; i < confettiCount; i++) {
    const confetti = document.createElement('div');
    confetti.className = 'quiz-confetti';
    confetti.setCssProps({
      '--confetti-bg': colors[Math.floor(Math.random() * colors.length)],
      '--confetti-left': `${centerX}px`,
      '--confetti-top': `${centerY}px`,
      '--confetti-radius': Math.random() > 0.5 ? '50%' : '0'
    });
    
    document.body.appendChild(confetti);
    
    const angle = (Math.PI * 2 * i) / confettiCount;
    const velocity = 150 + Math.random() * 100;
    const vx = Math.cos(angle) * velocity;
    const vy = Math.sin(angle) * velocity - 100;
    
    let x = 0, y = 0, rotation = 0;
    const gravity = 400;
    const startTime = performance.now();
    
    function animate(currentTime: number) {
      const elapsed = (currentTime - startTime) / 1000;
      x = vx * elapsed;
      y = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      rotation = elapsed * 360;
      
      confetti.setCssProps({
        '--confetti-transform': `translate(${x}px, ${y}px) rotate(${rotation}deg)`,
        '--confetti-opacity': String(Math.max(0, 1 - elapsed / 1.5))
      });
      
      if (elapsed < 1.5) {
        requestAnimationFrame(animate);
      } else {
        confetti.remove();
      }
    }
    
    requestAnimationFrame(animate);
  }
}



export class QuizExplanationGenerator {
  private settings: AISettings;
  private rateLimitManager: RateLimitManager;

  constructor(settings: AISettings, rateLimitManager: RateLimitManager) {
    this.settings = settings;
    this.rateLimitManager = rateLimitManager;
  }

  private getApiKey(): string {
    if (this.settings.provider === 'groq') {
      return this.settings.groqApiKey;
    } else if (this.settings.provider === 'openrouter') {
      return this.settings.openRouterApiKey;
    } else if (this.settings.provider === 'ollama') {
      return this.settings.ollamaApiKey || '';
    } else if (this.settings.provider === 'nvidia') {
      return this.settings.nvidiaApiKey;
    }
    return this.settings.geminiApiKey || this.settings.apiKey;
  }

  async generateExplanation(
    question: string,
    options: NotebookMCQOption[],
    correctOptionIndex: number,
    selectedOptionIndex: number | undefined,
    context: string
  ): Promise<string> {
    const correctOption = options[correctOptionIndex];
    const selectedOption = selectedOptionIndex !== undefined ? options[selectedOptionIndex] : null;
    const isCorrect = selectedOptionIndex === correctOptionIndex;
    const hasAnswered = selectedOptionIndex !== undefined;

    let prompt: string;

    if (!hasAnswered) {
      
      prompt = `Based STRICTLY on the following source content, explain why the correct answer is correct.

SOURCE CONTENT:
${context}

QUESTION: ${question}

OPTIONS:
${options.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt.text}`).join('\n')}

CORRECT ANSWER: ${String.fromCharCode(65 + correctOptionIndex)}. ${correctOption.text}

INSTRUCTIONS:
- Explain why "${correctOption.text}" is the correct answer
- Base your explanation STRICTLY on the source content provided
- Be concise but thorough
- Do not mention information not found in the source content

Provide the explanation:`;
    } else if (isCorrect) {
      
      prompt = `Based STRICTLY on the following source content, explain why the correct answer is correct.

SOURCE CONTENT:
${context}

QUESTION: ${question}

OPTIONS:
${options.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt.text}`).join('\n')}

CORRECT ANSWER: ${String.fromCharCode(65 + correctOptionIndex)}. ${correctOption.text}

INSTRUCTIONS:
- Explain why "${correctOption.text}" is the correct answer
- Base your explanation STRICTLY on the source content provided
- Be concise but thorough
- Do not mention information not found in the source content

Provide the explanation:`;
    } else {
      
      prompt = `Based STRICTLY on the following source content, explain why the user's chosen answer is wrong and why the correct answer is correct.

SOURCE CONTENT:
${context}

QUESTION: ${question}

OPTIONS:
${options.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt.text}`).join('\n')}

USER'S ANSWER: ${String.fromCharCode(65 + selectedOptionIndex!)}. ${selectedOption!.text}
CORRECT ANSWER: ${String.fromCharCode(65 + correctOptionIndex)}. ${correctOption.text}

INSTRUCTIONS:
- First, briefly explain why "${selectedOption!.text}" is incorrect
- Then, explain why "${correctOption.text}" is the correct answer
- Base your explanation STRICTLY on the source content provided
- Be concise but thorough
- Do not mention information not found in the source content

Provide the explanation:`;
    }

    let responseText = '';

    if (this.settings.provider === 'gemini') {
      const geminiService = new GeminiService(
        this.getApiKey(),
        (headers) => this.rateLimitManager.updateFromHeaders('gemini', this.settings.model, headers)
      );
      responseText = await geminiService.generateContentWithHeaders(
        this.settings.model,
        prompt,
        { temperature: getModelTemperature(this.settings.model, this.settings), maxOutputTokens: 1024 }
      );
    } else if (this.settings.provider === 'groq') {
      const groqService = new GroqService(
        this.getApiKey(),
        (headers) => this.rateLimitManager.updateFromHeaders('groq', this.settings.model, headers)
      );
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are an expert educator providing clear, concise explanations based strictly on provided source material.' },
        { role: 'user', content: prompt }
      ];
      responseText = await groqService.generateContent(this.settings.model, messages, { temperature: getModelTemperature(this.settings.model, this.settings), topP: getModelTopP(this.settings.model, this.settings) });
    } else if (this.settings.provider === 'openrouter') {
      const openRouterService = new OpenRouterService(
        this.getApiKey(),
        (headers) => this.rateLimitManager.updateFromHeaders('openrouter', this.settings.model, headers)
      );
      const messages: OpenRouterChatMessage[] = [
        { role: 'system', content: 'You are an expert educator providing clear, concise explanations based strictly on provided source material.' },
        { role: 'user', content: prompt }
      ];
      responseText = await openRouterService.generateContent(this.settings.model, messages, { temperature: getModelTemperature(this.settings.model, this.settings), maxTokens: 1024, topP: getModelTopP(this.settings.model, this.settings) });
    } else if (this.settings.provider === 'ollama') {
      const ollamaService = new OllamaService(
        this.settings.ollamaBaseUrl,
        this.getApiKey(),
        (headers) => this.rateLimitManager.updateFromHeaders('ollama', this.settings.model, headers)
      );
      const messages: OllamaChatMessage[] = [
        { role: 'system', content: 'You are an expert educator providing clear, concise explanations based strictly on provided source material.' },
        { role: 'user', content: prompt }
      ];
      responseText = await ollamaService.generateContent(this.settings.model, messages, { temperature: getModelTemperature(this.settings.model, this.settings), maxTokens: 1024, topP: getModelTopP(this.settings.model, this.settings) });
    } else if (this.settings.provider === 'nvidia') {
      const nvidiaService = new NvidiaService(
        this.getApiKey(),
        (headers) => this.rateLimitManager.updateFromHeaders('nvidia', this.settings.model, headers)
      );
      const messages: NvidiaChatMessage[] = [
        { role: 'system', content: 'You are an expert educator providing clear, concise explanations based strictly on provided source material.' },
        { role: 'user', content: prompt }
      ];
      responseText = await nvidiaService.generateContent(this.settings.model, messages, { temperature: getModelTemperature(this.settings.model, this.settings), maxTokens: 1024, topP: getModelTopP(this.settings.model, this.settings) });
    } else if (UnifiedProviderManager.getInstance().hasProvider(this.settings.provider)) {
      const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(this.settings.provider)!;
      const response = await unifiedProvider.generateContent(
        this.settings.model,
        [
          { role: 'system', content: 'You are an expert educator providing clear, concise explanations based strictly on provided source material.' },
          { role: 'user', content: prompt }
        ],
        { temperature: getModelTemperature(this.settings.model, this.settings), maxTokens: 1024, topP: getModelTopP(this.settings.model, this.settings) }
      );
      responseText = response.text;
    }

    return responseText;
  }
}



export class QuizRenderer {
  private app: App;
  private container: HTMLElement;
  private state: QuizState;
  private onStateChange: (state: QuizState) => void;
  private settings?: AISettings;
  private getContext?: (question: string) => Promise<string>;
  private explanationCache: Map<string, string> = new Map();
  private rateLimitManager?: RateLimitManager;

  constructor(
    app: App, 
    container: HTMLElement, 
    state: QuizState, 
    onStateChange: (state: QuizState) => void,
    settings?: AISettings,
    getContext?: (question: string) => Promise<string>,
    rateLimitManager?: RateLimitManager
  ) {
    this.app = app;
    this.container = container;
    this.state = state;
    this.onStateChange = onStateChange;
    this.settings = settings;
    this.getContext = getContext;
    this.rateLimitManager = rateLimitManager;
  }

  render() {
    this.container.empty();
    this.container.addClass('notebook-quiz-box');
    
    
    const header = this.container.createDiv({ cls: 'quiz-box-header' });
    header.createEl('h4', { text: '📝 Quiz', cls: 'quiz-box-title' });
    
    const refreshBtn = header.createEl('button', { cls: 'quiz-refresh-btn' });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.title = 'Refresh Quiz';
    refreshBtn.onclick = () => {
      
      this.state.mcqs.forEach(mcq => {
        mcq.selectedOption = undefined;
        mcq.isAnswered = false;
        mcq.isCorrect = undefined;
      });
      this.onStateChange(this.state);
      this.render();
    };
    
    
    const questionsContainer = this.container.createDiv({ cls: 'quiz-questions-container' });
    
    this.state.mcqs.forEach((mcq, qIndex) => {
      const questionDiv = questionsContainer.createDiv({ cls: 'quiz-question-item' });
      questionDiv.setAttribute('data-mcq-id', mcq.id);
      
      
      const questionText = questionDiv.createDiv({ cls: 'quiz-question-text' });
      questionText.createEl('span', { text: `${qIndex + 1}. `, cls: 'quiz-question-number' });
      const questionContent = questionText.createEl('span', { cls: 'quiz-question-content' });
      
      { const _comp = new Component();
      MarkdownRenderer.render(this.app, mcq.question, questionContent, '', _comp);
      _comp.load(); }
      
      
      const optionsDiv = questionDiv.createDiv({ cls: 'quiz-options' });
      
      mcq.options.forEach((option, optIndex) => {
        const optionLabel = optionsDiv.createEl('label', { cls: 'quiz-option-label' });
        
        
        let optionClass = '';
        if (mcq.isAnswered) {
          if (option.isCorrect) {
            optionClass = 'correct';
          } else if (mcq.selectedOption === optIndex && !option.isCorrect) {
            optionClass = 'incorrect';
          }
        }
        if (optionClass) optionLabel.addClass(optionClass);
        
        const checkbox = optionLabel.createEl('input', { type: 'checkbox', cls: 'quiz-option-checkbox' });
        checkbox.checked = mcq.selectedOption === optIndex;
        checkbox.disabled = mcq.isAnswered;
        
        const optionText = optionLabel.createEl('span', { cls: 'quiz-option-text' });
        optionText.createEl('span', { text: `${String.fromCharCode(65 + optIndex)}. `, cls: 'quiz-option-letter' });
        
        const optionContent = optionText.createEl('span', { cls: 'quiz-option-content' });
        { const _comp = new Component();
        MarkdownRenderer.render(this.app, option.text, optionContent, '', _comp);
        _comp.load(); }
        
        if (!mcq.isAnswered) {
          checkbox.onchange = () => {
            
            const otherCheckboxes = optionsDiv.querySelectorAll('.quiz-option-checkbox');
            otherCheckboxes.forEach((cb, idx) => {
              if (idx !== optIndex) (cb as HTMLInputElement).checked = false;
            });
            
            if (checkbox.checked) {
              mcq.selectedOption = optIndex;
              mcq.isAnswered = true;
              mcq.isCorrect = option.isCorrect;
              
              this.onStateChange(this.state);
              
              if (option.isCorrect) {
                triggerConfetti(questionDiv);
              }
              
              
              this.render();
            }
          };
        }
      });

      
      if (this.settings && this.getContext) {
        const explainContainer = questionDiv.createDiv({ cls: 'quiz-explain-container' });
        const explainBtn = explainContainer.createEl('button', { cls: 'quiz-explain-btn' });
        setIcon(explainBtn, 'help-circle');
        explainBtn.createEl('span', { text: 'Explain' });

        
        const explanationBox = explainContainer.createDiv({ cls: 'quiz-explanation-box hidden' });
        
        explainBtn.onclick = async () => {
          
          const cacheKey = `${mcq.id}-${mcq.selectedOption ?? 'none'}`;
          
          if (this.explanationCache.has(cacheKey)) {
            
            explanationBox.empty();
            this.renderExplanationContent(explanationBox, this.explanationCache.get(cacheKey)!);
            explanationBox.removeClass('hidden');
            return;
          }
          
          
          explainBtn.disabled = true;
          explainBtn.addClass('loading');
          
          explainBtn.empty();
          setIcon(explainBtn, 'loader-2');
          explainBtn.querySelector('svg')?.addClass('spin');
          explainBtn.createEl('span', { text: 'Generating...' });
          
          try {
            
            const context = await this.getContext!(mcq.question);
            const generator = new QuizExplanationGenerator(this.settings!, this.rateLimitManager!);
            
            
            const correctOptionIndex = mcq.options.findIndex(opt => opt.isCorrect);
            
            const explanation = await generator.generateExplanation(
              mcq.question,
              mcq.options,
              correctOptionIndex,
              mcq.selectedOption,
              context
            );
            
            
            this.explanationCache.set(cacheKey, explanation);
            
            
            explanationBox.empty();
            this.renderExplanationContent(explanationBox, explanation);
            explanationBox.removeClass('hidden');
            
          } catch (error) {
            explanationBox.empty();
            explanationBox.createEl('p', { text: 'Failed to generate explanation. Please try again.', cls: 'quiz-explanation-error' });
            explanationBox.removeClass('hidden');
          } finally {
            explainBtn.disabled = false;
            explainBtn.removeClass('loading');
            explainBtn.empty();
            setIcon(explainBtn, 'help-circle');
            explainBtn.createEl('span', { text: 'Explain' });
          }
        };
      }
    });
    
    
    const answeredCount = this.state.mcqs.filter(m => m.isAnswered).length;
    const correctCount = this.state.mcqs.filter(m => m.isCorrect).length;
    
    if (answeredCount > 0) {
      const scoreDiv = this.container.createDiv({ cls: 'quiz-score-summary' });
      scoreDiv.createEl('span', { 
        text: `Score: ${correctCount}/${answeredCount} (${Math.round(correctCount/answeredCount*100)}%)`,
        cls: 'quiz-score-text'
      });
    }
  }

  private renderExplanationContent(container: HTMLElement, explanation: string) {
    
    const header = container.createDiv({ cls: 'quiz-explanation-header' });
    header.createEl('span', { text: '💡 Explanation', cls: 'quiz-explanation-title' });
    
    const copyBtn = header.createEl('button', { cls: 'quiz-explanation-copy-btn' });
    setIcon(copyBtn, 'copy');
    copyBtn.createEl('span', { text: 'Copy' });
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(explanation);
        copyBtn.empty();
        setIcon(copyBtn, 'check');
        copyBtn.createEl('span', { text: 'Copied!' });
        copyBtn.addClass('copied');
        setTimeout(() => {
          copyBtn.empty();
          setIcon(copyBtn, 'copy');
          copyBtn.createEl('span', { text: 'Copy' });
          copyBtn.removeClass('copied');
        }, 2000);
      } catch (err) {
        
      }
    };
    
    
    const contentDiv = container.createDiv({ cls: 'quiz-explanation-content' });
    { const _comp = new Component();
    MarkdownRenderer.render(this.app, explanation, contentDiv, '', _comp);
    _comp.load(); }
  }
}



export class FlashcardRenderer {
  private app: App;
  private container: HTMLElement;
  private state: FlashcardState;
  private onStateChange: (state: FlashcardState) => void;
  private isFlipped: boolean = false;

  constructor(app: App, container: HTMLElement, state: FlashcardState, onStateChange: (state: FlashcardState) => void) {
    this.app = app;
    this.container = container;
    this.state = state;
    this.onStateChange = onStateChange;
    
    
    if (!this.state.recallMap) this.state.recallMap = {};
    if (!this.state.filter) this.state.filter = 'all';
  }

  render() {
    this.container.empty();
    this.container.addClass('notebook-flashcard-box');
    
    
    const header = this.container.createDiv({ cls: 'flashcard-box-header' });
    header.createEl('h4', { text: '🎴 Flashcards', cls: 'flashcard-box-title' });
    
    
    const headerActions = header.createDiv({ cls: 'flashcard-header-actions' });

    
    const filterContainer = headerActions.createDiv({ cls: 'flashcard-filter-container' });
    const filterBtn = filterContainer.createEl('button', { cls: 'flashcard-filter-btn' });
    setIcon(filterBtn, 'filter');
    filterBtn.title = 'Filter Flashcards';
    
    const filterDropdown = filterContainer.createEl('select', { cls: 'flashcard-filter-select' });
    ['all', 'green', 'orange', 'red'].forEach(opt => {
      const option = filterDropdown.createEl('option', { value: opt, text: opt.charAt(0).toUpperCase() + opt.slice(1) });
      if (this.state.filter === opt) option.selected = true;
    });

    filterDropdown.onchange = () => {
      this.state.filter = filterDropdown.value as FlashcardState['filter'];
      this.state.currentIndex = 0; 
      this.onStateChange(this.state);
      this.render();
    };

    
    const refreshBtn = headerActions.createEl('button', { cls: 'flashcard-refresh-btn' });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.title = 'Reset Progress';
    refreshBtn.onclick = () => {
      this.state.recallMap = {};
      this.state.currentIndex = 0;
      this.onStateChange(this.state);
      this.render();
    };

    
    const visibleCards = this.state.flashcards.filter(card => {
      if (!this.state.filter || this.state.filter === 'all') return true;
      return this.state.recallMap?.[card.id] === this.state.filter;
    });

    
    if (visibleCards.length === 0) {
      this.container.createDiv({ cls: 'flashcard-empty-message', text: 'No cards match the selected filter.' });
      return;
    }

    
    if (this.state.currentIndex >= visibleCards.length) {
      this.state.currentIndex = visibleCards.length - 1;
    }

    const counterSpan = header.createEl('span', { 
      text: `${this.state.currentIndex + 1} / ${visibleCards.length}`,
      cls: 'flashcard-counter'
    });
    
    
    const stackContainer = this.container.createDiv({ cls: 'flashcard-stack-container' });
    
    
    const stackCount = Math.min(3, visibleCards.length - this.state.currentIndex);
    for (let i = stackCount - 1; i >= 0; i--) {
      if (i > 0) {
        const stackCard = stackContainer.createDiv({ cls: 'flashcard-stack-card' });
        stackCard.setCssProps({
          '--stack-transform': `translateY(${i * 4}px) scale(${1 - i * 0.02})`,
          '--stack-z-index': String(stackCount - i)
        });
      }
    }
    
    
    const currentCard = visibleCards[this.state.currentIndex];
    if (currentCard) {
      const cardWrapper = stackContainer.createDiv({ cls: 'flashcard-wrapper' });
      const card = cardWrapper.createDiv({ cls: `flashcard-card ${this.isFlipped ? 'flipped' : ''}` });
      
      
      const frontSide = card.createDiv({ cls: 'flashcard-side flashcard-front' });
      frontSide.createDiv({ cls: 'flashcard-label', text: 'Question' });
      const frontContent = frontSide.createDiv({ cls: 'flashcard-content' });
      
      { const _comp = new Component();
      MarkdownRenderer.render(this.app, currentCard.front, frontContent, '', _comp);
      _comp.load(); }
      frontSide.createDiv({ cls: 'flashcard-hint', text: 'Click to flip' });
      
      
      const backSide = card.createDiv({ cls: 'flashcard-side flashcard-back' });
      backSide.createDiv({ cls: 'flashcard-label', text: 'Answer' });
      const backContent = backSide.createDiv({ cls: 'flashcard-content' });
      
      { const _comp = new Component();
      MarkdownRenderer.render(this.app, currentCard.back, backContent, '', _comp);
      _comp.load(); }
      backSide.createDiv({ cls: 'flashcard-hint', text: 'Click to flip' });
      
      
      card.onclick = () => {
        this.isFlipped = !this.isFlipped;
        card.classList.toggle('flipped', this.isFlipped);
      };
    }

    
    const recallContainer = this.container.createDiv({ cls: 'flashcard-recall-container' });
    const currentStatus = this.state.recallMap?.[currentCard.id];

    [
      { id: 'red', label: 'Nothing', icon: '🔴' },
      { id: 'orange', label: 'Partial', icon: '🟠' },
      { id: 'green', label: 'Mastered', icon: '🟢' }
    ].forEach(status => {
      const btn = recallContainer.createEl('button', { 
        cls: `flashcard-recall-btn ${status.id} ${currentStatus === status.id ? 'active' : ''}` 
      });
      btn.createSpan({ text: status.icon });
      btn.appendText(` ${status.label}`);
      btn.onclick = () => {
        if (!this.state.recallMap) this.state.recallMap = {};
        this.state.recallMap[currentCard.id] = status.id as 'red' | 'orange' | 'green';
        this.onStateChange(this.state);
        this.render(); 
      };
    });
    
    
    const navContainer = this.container.createDiv({ cls: 'flashcard-nav-container' });
    
    const prevBtn = navContainer.createEl('button', { cls: 'flashcard-nav-btn prev-btn' });
    setIcon(prevBtn, 'chevron-left');
    prevBtn.disabled = this.state.currentIndex === 0;
    prevBtn.onclick = () => {
      if (this.state.currentIndex > 0) {
        this.state.currentIndex--;
        this.isFlipped = false;
        this.onStateChange(this.state);
        this.render();
      }
    };
    
    const nextBtn = navContainer.createEl('button', { cls: 'flashcard-nav-btn next-btn' });
    setIcon(nextBtn, 'chevron-right');
    nextBtn.disabled = this.state.currentIndex >= visibleCards.length - 1;
    nextBtn.onclick = () => {
      if (this.state.currentIndex < visibleCards.length - 1) {
        this.state.currentIndex++;
        this.isFlipped = false;
        this.onStateChange(this.state);
        this.render();
      }
    };
  }
}
