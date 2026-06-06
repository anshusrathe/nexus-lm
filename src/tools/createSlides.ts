import { App, Modal, Notice, TFile, ButtonComponent, MarkdownRenderer, Component, ToggleComponent, setIcon, normalizePath, Setting } from 'obsidian';
import { AISettings } from '../settings';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GroqService, ChatMessage } from '../services/groqService';
import { OpenRouterService, ChatMessage as OpenRouterChatMessage } from '../services/openRouterService';
import { OllamaService, ChatMessage as OllamaChatMessage } from '../services/ollamaService';
import { NvidiaService, ChatMessage as NvidiaChatMessage } from '../services/nvidiaService';
import { UnifiedProviderManager } from '../services/unifiedProviderManager';

export interface SavedSlideshow {
  id: string;
  name: string;
  filePath: string;
  timestamp: number;
  type: 'zen';
}

interface SlideSettings {
  name: string;
  type: 'zen';
  preferredVoice?: string;
  voiceRate?: number;
  voicePitch?: number;
}

// ================================================================================
// ZEN MODE INTERFACES - Audio-narrated slideshow with visual outline
// ================================================================================

interface ZenHeadingNode {
  level: 1 | 2 | 3 | 4 | 5;
  text: string;
  narration: string;
  children: ZenHeadingNode[];
}

interface ZenSlideData {
  slideNumber: number;
  titleNode: ZenHeadingNode;
}

interface ZenSlideshowData {
  name: string;
  slides: ZenSlideData[];
  timestamp: number;
  preferredVoice?: string;
  voiceRate?: number;
  voicePitch?: number;
}

export class SlideManager {
  private app: App;
  private settings: AISettings;

  constructor(app: App, settings: AISettings) {
    this.app = app;
    this.settings = settings;
  }

  private validateSettings(): boolean {
    const provider = this.settings.aiTutorProvider || this.settings.provider;
    const model = this.settings.aiTutorModel || this.settings.model;
    
    if (!model) {
      new Notice('Please select an AI model in settings');
      return false;
    }

    let apiKey: string;
    
    if (provider === 'groq') {
      apiKey = this.settings.groqApiKey;
    } else if (provider === 'openrouter') {
      apiKey = this.settings.openRouterApiKey;
    } else if (provider === 'ollama') {
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

  async generateSlideshow(
    notePaths: string[],
    slideSettings: SlideSettings,
    onProgress?: (message: string) => void
  ): Promise<any> {
    // Legacy redirect to Zen mode
    return this.generateZenSlideshow(notePaths, slideSettings, onProgress);
  }

  private async callAI(prompt: string): Promise<string> {
    const apiKey = this.getApiKey();
    const provider = this.settings.aiTutorProvider || this.settings.provider;
    const modelId = this.settings.aiTutorModel || this.settings.model;

    if (provider === 'gemini') {
      return await this.callGemini(prompt, apiKey, modelId);
    } else if (provider === 'groq') {
      return await this.callGroq(prompt, apiKey, modelId);
    } else if (provider === 'openrouter') {
      return await this.callOpenRouter(prompt, apiKey, modelId);
    } else if (provider === 'ollama') {
      return await this.callOllama(prompt, apiKey, modelId);
    } else if (provider === 'nvidia') {
      return await this.callNvidia(prompt, apiKey, modelId);
    } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
      return await this.callUnified(prompt, provider, modelId);
    } else {
      throw new Error('Unsupported provider. Please select a valid provider in settings.');
    }
  }

  private async callUnified(prompt: string, provider: string, modelId: string): Promise<string> {
    try {
      const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
      const response = await unifiedProvider.generateContent(
        modelId,
        [{ role: 'user', content: prompt }],
        { temperature: 0.7, maxTokens: 8192 }
      );
      return response.text;
    } catch (error: any) {
            throw new Error(`${provider} API error: ${error.message || 'Unknown error'}`);
    }
  }

  private async callGemini(prompt: string, apiKey: string, modelId: string): Promise<string> {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: modelId });
      
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (error: any) {
            throw new Error(`Gemini API error: ${error.message || 'Unknown error'}`);
    }
  }

  private async callGroq(prompt: string, apiKey: string, modelId: string): Promise<string> {
    try {
      const groqService = new GroqService(apiKey);
      const messages: ChatMessage[] = [
        { role: 'user', content: prompt }
      ];
      
      const responseText = await groqService.generateContent(
        modelId,
        messages,
        { temperature: 0.7, maxTokens: 8192 }
      );
      return responseText;
    } catch (error: any) {
            throw new Error(`Groq API error: ${error.message || 'Unknown error'}`);
    }
  }

  private async callOpenRouter(prompt: string, apiKey: string, modelId: string): Promise<string> {
    try {
      const openRouterService = new OpenRouterService(apiKey);
      const messages: OpenRouterChatMessage[] = [
        { role: 'user', content: prompt }
      ];
      
      const responseText = await openRouterService.generateContent(
        modelId,
        messages,
        { temperature: 0.7, maxTokens: 8192 }
      );
      return responseText;
    } catch (error: any) {
            throw new Error(`OpenRouter API error: ${error.message || 'Unknown error'}`);
    }
  }

  private async callOllama(prompt: string, apiKey: string, modelId: string): Promise<string> {
    try {
      const ollamaService = new OllamaService(this.settings.ollamaBaseUrl, apiKey);
      const messages: OllamaChatMessage[] = [
        { role: 'user', content: prompt }
      ];
      
      const responseText = await ollamaService.generateContent(
        modelId,
        messages,
        { temperature: 0.7, maxTokens: 8192 }
      );
      return responseText;
    } catch (error: any) {
            throw new Error(`Ollama API error: ${error.message || 'Unknown error'}`);
    }
  }

  private async callNvidia(prompt: string, apiKey: string, modelId: string): Promise<string> {
    try {
      const nvidiaService = new NvidiaService(apiKey);
      const messages: NvidiaChatMessage[] = [
        { role: 'user', content: prompt }
      ];
      
      const responseText = await nvidiaService.generateContent(
        modelId,
        messages,
        { temperature: 0.7, maxTokens: 8192 }
      );
      return responseText;
    } catch (error: any) {
            throw new Error(`NVIDIA API error: ${error.message || 'Unknown error'}`);
    }
  }

  // ================================================================================
  // ZEN MODE IMPLEMENTATION - Audio-narrated slideshow
  // ================================================================================

  async generateZenSlideshow(
    notePaths: string[],
    slideSettings: SlideSettings,
    onProgress?: (message: string) => void
  ): Promise<ZenSlideshowData> {
    if (!this.validateSettings()) {
      throw new Error('Invalid settings');
    }

    onProgress?.('Reading notes...');
    
    // Read all notes
    let combinedContent = '';
    for (const path of notePaths) {
      const file = this.app.vault.getAbstractFileByPath(path) as TFile;
      if (file) {
        const content = await this.app.vault.read(file);
        combinedContent += `\n\n--- ${file.basename} ---\n\n${content}`;
      }
    }

    onProgress?.('Generating audio-narrated outline...');
        
    // Generate structured outline with AI
    const outlineText = await this.generateZenOutline(combinedContent, slideSettings.name);
        
    onProgress?.('Structuring slides...');
        
    // Parse outline into ZenSlideshowData
    const slidesData = this.parseZenOutline(outlineText);
        
    onProgress?.('Finalizing slideshow...');

    return {
      name: slideSettings.name,
      slides: slidesData,
      timestamp: Date.now(),
      preferredVoice: slideSettings.preferredVoice,
      voiceRate: slideSettings.voiceRate,
      voicePitch: slideSettings.voicePitch
    };
  }

  private async generateZenOutline(content: string, title: string): Promise<string> {
    const prompt = `You are creating a ZEN MODE audio-narrated slideshow presentation.

The user will see ONLY the headings (H1-H5) as a visual mind-map outline.
The narration text will ONLY be spoken by text-to-speech - NEVER displayed on screen.

CRITICAL: The narration must be a SMOOTH, UNIFIED narrative that flows like a lecture or story. Include TRANSITION SENTENCES that connect sections naturally.

FORMAT:
# ${title}
Opening narration that introduces the topic and transitions to the first section.

## Section Name
This section covers [topic]. Narration includes the heading name, explanation, AND a transition to the next topic.

### Subsection Name
This subsection explores [sub-topic]. Explanation with smooth flow to the next point.

#### Sub-subsection Name
Brief elaboration that connects to parent topic.

##### Deep Detail
Specific nuanced point with its own brief narration.

### Another Subsection
More details here with a natural transition sentence at the end.

## Next Section (Starts NEW SLIDE)
This section explores [new topic]. Opening narration that flows from the previous section's theme.

### Subsection under new section
Detailed explanation that builds on the section introduction.

---
RULES:
1. EVERY ## heading starts a NEW slide
2. H2 is the "root" node for each slide, with H3/H4/H5 as child nodes
3. EACH heading (H1-H5) MUST have narration - the heading text IS part of the narration
4. Narration should be 2-4 sentences per heading
5. Include TRANSITION sentences that connect sections (e.g., "Now let's explore...", "Building on this, we see...", "This connects to...")
6. Maximum heading depth is H5 (#####)
7. Every ## MUST have at least one ### child
8. NO markdown formatting in narration text
9. The narration should feel like ONE CONTINUOUS LECTURE, not disconnected bullet points
10. For complex topics, DO NOT cram all details into H3 narration. Instead, break them down into H4 and H5 headings with their own narration. The entire presentation should be woven in a single narrative thread.

Now create the ZEN outline from these notes:

${content}

Output ONLY the outline in the exact format shown above. No explanations or preamble.`;

    return await this.callAI(prompt);
  }

  private parseZenOutline(outlineText: string): ZenSlideData[] {
    const slides: ZenSlideData[] = [];
    const lines = outlineText.split('\n');
    
    let currentSlide: ZenSlideData | null = null;
    let currentH2Node: ZenHeadingNode | null = null;
    let currentH3Node: ZenHeadingNode | null = null;
    let currentH4Node: ZenHeadingNode | null = null;
    let currentNarration: string = '';
    let lastNode: ZenHeadingNode | null = null;
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      
      // Match heading patterns
      const h1Match = trimmedLine.match(/^#\s+(.+)$/);
      const h2Match = trimmedLine.match(/^##\s+(.+)$/);
      const h3Match = trimmedLine.match(/^###\s+(.+)$/);
      const h4Match = trimmedLine.match(/^####\s+(.+)$/);
      const h5Match = trimmedLine.match(/^#####\s+(.+)$/);
      
      const isHeading = !!(h1Match || h2Match || h3Match || h4Match || h5Match);
      
      // If we hit a new heading, save accumulated narration to the previous node
      if (isHeading) {
        if (lastNode) {
          lastNode.narration = currentNarration.trim();
        }
        currentNarration = '';
      }
      
      if (h1Match) {
        // Title slide
        currentSlide = {
          slideNumber: slides.length + 1,
          titleNode: {
            level: 1,
            text: h1Match[1],
            narration: '',
            children: []
          }
        };
        slides.push(currentSlide);
        lastNode = currentSlide.titleNode;
      } else if (h2Match) {
        // Create new slide
        currentSlide = {
          slideNumber: slides.length + 1,
          titleNode: {
            level: 2,
            text: h2Match[1],
            narration: '',
            children: []
          }
        };
        currentH2Node = currentSlide.titleNode;
        currentH3Node = null;
        currentH4Node = null;
        slides.push(currentSlide);
        lastNode = currentH2Node;
      } else if (h3Match && currentH2Node) {
        // New H3 under current H2
        currentH3Node = {
          level: 3,
          text: h3Match[1],
          narration: '',
          children: []
        };
        currentH2Node.children.push(currentH3Node);
        currentH4Node = null;
        lastNode = currentH3Node;
      } else if (h4Match && currentH3Node) {
        // New H4 under current H3
        currentH4Node = {
          level: 4,
          text: h4Match[1],
          narration: '',
          children: []
        };
        currentH3Node.children.push(currentH4Node);
        lastNode = currentH4Node;
      } else if (h5Match && currentH4Node) {
        // New H5 under current H4
        const h5Node: ZenHeadingNode = {
          level: 5,
          text: h5Match[1],
          narration: '',
          children: []
        };
        currentH4Node.children.push(h5Node);
        lastNode = h5Node;
      } else if (!isHeading) {
        // This is narration text - add to current narration
        currentNarration += ' ' + trimmedLine;
      }
    }
    
    // Don't forget to save the last narration
    if (lastNode) {
      lastNode.narration = currentNarration.trim();
    }
    
    // Ensure we have at least one slide
    if (slides.length === 0) {
      slides.push({
        slideNumber: 1,
        titleNode: {
          level: 1,
          text: 'Untitled',
          narration: '',
          children: []
        }
      });
    }
    
            return slides;
  }

  async saveZenSlideshow(zenData: ZenSlideshowData, existingPath?: string): Promise<string> {
    let filePath: string;
    
    if (existingPath) {
      filePath = existingPath;
    } else {
      const sanitizedName = zenData.name.replace(/[\\/:*?"<>|]/g, '-');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `ZenSlideshow-${sanitizedName}-${timestamp}.json`;
      
      const dir = '.Nexus-LM-data/tutor-slideshows';
      filePath = normalizePath(`${dir}/${filename}`);

      // Create parent directory first if needed
      const parentDir = '.Nexus-LM-data';
      const parentDirPath = this.app.vault.getAbstractFileByPath(parentDir);
      if (!parentDirPath) {
        try {
          await this.app.vault.adapter.mkdir(parentDir);
        } catch (error) {
                  }
      }

      // Create subdirectory if needed
      const dirPath = this.app.vault.getAbstractFileByPath(dir);
      if (!dirPath) {
        try {
          await this.app.vault.adapter.mkdir(dir);
        } catch (error) {
                  }
      }
    }
    
    const jsonContent = JSON.stringify(zenData, null, 2);
    
    try {
      await this.app.vault.adapter.write(filePath, jsonContent);
      if (!existingPath) {
        new Notice(`Zen slideshow saved: ${zenData.name}`);
      }
      return filePath;
    } catch (error) {
            throw error;
    }
  }

  async loadZenSlideshow(filePath: string): Promise<ZenSlideshowData> {
    try {
      const content = await this.app.vault.adapter.read(filePath);
      const zenData: ZenSlideshowData = JSON.parse(content);
      return zenData;
    } catch (error) {
            throw error;
    }
  }

  async openZenSlideshowVisualization(zenData: ZenSlideshowData) {
            new ZenSlideshowModal(this.app, zenData).open();
      }
}

export class SlideshowSettingsModal extends Modal {
  private settings: AISettings;
  private initialSelectedPaths: Set<string>;
  private onSubmit: (settings: SlideSettings) => void;
  private voiceSettingsContainer!: HTMLElement;
  private voiceSelectDropdown!: HTMLSelectElement;
  private testVoiceButton!: HTMLElement;
  private selectedVoiceName: string = '';
  private availableVoices: SpeechSynthesisVoice[] = [];
  private voiceRateSlider!: HTMLInputElement;
  private voicePitchSlider!: HTMLInputElement;
  private voiceRateValue!: HTMLElement;
  private voicePitchValue!: HTMLElement;
  private selectedVoiceRate: number = 0.95;
  private selectedVoicePitch: number = 1;

  constructor(
    app: App,
    pluginSettings: AISettings,
    initialSelectedPaths: Set<string>,
    onSubmit: (settings: SlideSettings) => void
  ) {
    super(app);
    this.settings = pluginSettings;
    this.initialSelectedPaths = initialSelectedPaths;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('slideshow-settings-modal');

    contentEl.createEl('h2', { text: 'Create Zen Slideshow' });

    // Name input
    new Setting(contentEl)
      .setName('Slideshow Name')
      .addText(text => text
        .setPlaceholder('My Presentation')
        .setValue('Slideshow')
        .onChange(value => {
          // Handled on submit
        }));

    // Type Description (Hardcoded to Zen)
    const typeDesc = contentEl.createDiv({ cls: 'type-description' });
    typeDesc.setText('Zen Mode: Audio-narrated presentation with visual outline. Narration plays automatically while headings glow.');

    // Voice settings section (always visible)
    this.voiceSettingsContainer = contentEl.createDiv({ cls: 'voice-settings-section' });
    
    // Voice selection setting
    const voiceSetting = new Setting(this.voiceSettingsContainer)
      .setName('Narration Voice')
      .setDesc('Select a natural-sounding voice for the narration.');

    const voiceSelectContainer = voiceSetting.controlEl.createDiv({ cls: 'voice-select-container' });
    
    this.voiceSelectDropdown = voiceSelectContainer.createEl('select', { cls: 'voice-select-dropdown' }) as HTMLSelectElement;
    this.voiceSelectDropdown.empty();
    this.voiceSelectDropdown.createEl('option', { text: 'Loading voices...', value: '' });
    
    this.testVoiceButton = voiceSelectContainer.createEl('button', { text: 'Test Voice', cls: 'voice-test-button' });
    
    // Voice Rate slider setting
    const rateSetting = new Setting(this.voiceSettingsContainer)
      .setName('Speed');
    
    this.voiceRateValue = rateSetting.controlEl.createSpan({ text: '0.95x', cls: 'voice-value-display' });
    rateSetting.addSlider(slider => slider
      .setLimits(0.5, 1.5, 0.05)
      .setValue(0.95)
      .onChange(value => {
        this.selectedVoiceRate = value;
        this.voiceRateValue.textContent = `${value.toFixed(2)}x`;
        this.updateTestVoice();
      }));
    
    // Voice Pitch slider setting
    const pitchSetting = new Setting(this.voiceSettingsContainer)
      .setName('Pitch');
    
    this.voicePitchValue = pitchSetting.controlEl.createSpan({ text: '1.00', cls: 'voice-value-display' });
    pitchSetting.addSlider(slider => slider
      .setLimits(0.5, 1.5, 0.05)
      .setValue(1)
      .onChange(value => {
        this.selectedVoicePitch = value;
        this.voicePitchValue.textContent = `${value.toFixed(2)}`;
        this.updateTestVoice();
      }));

    // Load available voices
    this.loadAvailableVoices();

    // Buttons
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());

    new ButtonComponent(buttonContainer)
      .setButtonText('Create')
      .setCta()
      .onClick(() => {
        const nameInput = contentEl.querySelector('.slideshow-settings-modal input[type="text"]') as HTMLInputElement;
        const name = nameInput?.value.trim() || 'Slideshow';
        
        this.onSubmit({
          name,
          type: 'zen',
          preferredVoice: this.selectedVoiceName || undefined,
          voiceRate: this.selectedVoiceRate,
          voicePitch: this.selectedVoicePitch
        });
        
        this.close();
      });
  }

  private loadAvailableVoices() {
    const synth = window.speechSynthesis;
    this.voiceSelectDropdown.empty();
    this.voiceSelectDropdown.createEl('option', { text: 'Loading voices...', value: '' });
    
    const loadVoicesNow = () => {
            const allVoices = synth.getVoices();
            
      if (allVoices.length === 0) {
        this.voiceSelectDropdown.empty();
        this.voiceSelectDropdown.createEl('option', { text: 'No voices available', value: '' });
        return;
      }
      
      this.availableVoices = allVoices.filter(v => v.lang.startsWith('en'));
      
      this.availableVoices.sort((a, b) => {
        const aIsNeural = this.isNeuralVoice(a);
        const bIsNeural = this.isNeuralVoice(b);
        const aIsGoogle = a.name.toLowerCase().includes('google');
        const bIsGoogle = b.name.toLowerCase().includes('google');
        const aIsCloud = !a.localService;
        const bIsCloud = !b.localService;
        
        if (aIsNeural && !bIsNeural) return -1;
        if (!aIsNeural && bIsNeural) return 1;
        if (aIsGoogle && !bIsGoogle) return -1;
        if (!aIsGoogle && bIsGoogle) return 1;
        if (aIsCloud && !bIsCloud) return -1;
        if (!aIsCloud && bIsCloud) return 1;
        return a.name.localeCompare(b.name);
      });
      
            this.populateVoiceDropdown();
    };
    
    synth.addEventListener('voiceschanged', loadVoicesNow);
    
    synth.onvoiceschanged = () => {
      loadVoicesNow();
    };
    
    setTimeout(() => {
      loadVoicesNow();
    }, 100);
    
    setTimeout(() => {
      loadVoicesNow();
    }, 500);
    
    setTimeout(() => {
      loadVoicesNow();
    }, 1500);
    
    setTimeout(() => {
      loadVoicesNow();
    }, 3000);
  }

  private isNeuralVoice(voice: SpeechSynthesisVoice): boolean {
    const name = voice.name.toLowerCase();
    return name.includes('neural') || 
           name.includes('google') && (name.includes('standard') || name.includes('wavenet')) ||
           name.includes('azure') ||
           name.includes('预置');
  }

  private populateVoiceDropdown() {
    this.voiceSelectDropdown.empty();
    
    if (this.availableVoices.length === 0) {
      this.voiceSelectDropdown.createEl('option', { text: 'No English voices available', value: '' });
      return;
    }
    
    let defaultVoice = this.availableVoices.find(v => v.default) || this.availableVoices[0];
    
    for (const voice of this.availableVoices) {
      const option = document.createElement('option');
      option.value = voice.name;
      option.textContent = this.formatVoiceName(voice);
      if (voice.default) {
        option.textContent += ' (Default)';
        defaultVoice = voice;
      }
      this.voiceSelectDropdown.appendChild(option);
    }
    
    this.selectedVoiceName = defaultVoice.name;
    this.voiceSelectDropdown.value = this.selectedVoiceName;
    
    this.voiceSelectDropdown.addEventListener('change', () => {
      this.selectedVoiceName = this.voiceSelectDropdown.value;
    });
    
    this.testVoiceButton.addEventListener('click', () => {
      this.testSelectedVoice();
    });
  }

  private formatVoiceName(voice: SpeechSynthesisVoice): string {
    let name = voice.name;
    
    if (name.toLowerCase().includes('google')) {
      name = name.replace(/Google /g, '').replace(/EN-US-/g, 'US ').replace(/USNeural/g, 'US Neural').replace(/Standard/g, '').replace(/Wavenet/g, 'Wavenet').replace(/--/g, '-').replace(/-/g, ' ');
      if (!name.includes('English')) name = 'English ' + name;
      name = name.trim();
      name += ' [Cloud]';
    } else if (name.toLowerCase().includes('neural')) {
      name = name.replace(/neural/gi, 'Neural');
      name += ' [Neural]';
    } else if (name.toLowerCase().includes('azure')) {
      name = name.replace(/Microsoft /g, '').replace(/Azure /g, '');
      name += ' [Cloud]';
    } else if (!voice.localService) {
      name += ' [Cloud]';
    }
    
    return name.substring(0, 50);
  }

  private testSelectedVoice() {
    const synth = window.speechSynthesis;
    synth.cancel();
    
    const testText = 'This is how your narration will sound. Select the voice that sounds most natural to you.';
    const utterance = new SpeechSynthesisUtterance(testText);
    
    const selectedVoice = this.availableVoices.find(v => v.name === this.selectedVoiceName);
    if (selectedVoice) {
      utterance.voice = selectedVoice;
    }
    
    utterance.rate = this.selectedVoiceRate;
    utterance.pitch = this.selectedVoicePitch;
    utterance.volume = 1;
    
    synth.speak(utterance);
  }

  private updateTestVoice() {
    this.testSelectedVoice();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    window.speechSynthesis.cancel();
  }
}

export class SlideshowVoiceSettingsModal extends Modal {
  private zenData: ZenSlideshowData;
  private onSubmit: (voiceSettings: { preferredVoice?: string; voiceRate: number; voicePitch: number }) => void;
  private voiceSettingsContainer!: HTMLElement;
  private voiceSelectDropdown!: HTMLSelectElement;
  private testVoiceButton!: HTMLElement;
  private selectedVoiceName: string = '';
  private availableVoices: SpeechSynthesisVoice[] = [];
  private voiceRateSlider!: HTMLInputElement;
  private voicePitchSlider!: HTMLInputElement;
  private voiceRateValue!: HTMLElement;
  private voicePitchValue!: HTMLElement;
  private selectedVoiceRate: number = 0.95;
  private selectedVoicePitch: number = 1;

  constructor(
    app: App,
    zenData: ZenSlideshowData,
    onSubmit: (voiceSettings: { preferredVoice?: string; voiceRate: number; voicePitch: number }) => void
  ) {
    super(app);
    this.zenData = zenData;
    this.onSubmit = onSubmit;
    this.selectedVoiceName = zenData.preferredVoice || '';
    this.selectedVoiceRate = zenData.voiceRate || 0.95;
    this.selectedVoicePitch = zenData.voicePitch || 1;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('slideshow-settings-modal');

    contentEl.createEl('h2', { text: `Voice Settings: ${this.zenData.name}` });

    this.voiceSettingsContainer = contentEl.createDiv({ cls: 'voice-settings-section' });
    
    // Voice selection setting
    const voiceSetting = new Setting(this.voiceSettingsContainer)
      .setName('Narration Voice')
      .setDesc('Select a natural-sounding voice for the narration.');

    const voiceSelectContainer = voiceSetting.controlEl.createDiv({ cls: 'voice-select-container' });
    
    this.voiceSelectDropdown = voiceSelectContainer.createEl('select', { cls: 'voice-select-dropdown' }) as HTMLSelectElement;
    this.voiceSelectDropdown.empty();
    this.voiceSelectDropdown.createEl('option', { text: 'Loading voices...', value: '' });
    
    this.testVoiceButton = voiceSelectContainer.createEl('button', { text: 'Test Voice', cls: 'voice-test-button' });
    
    // Voice Rate slider setting
    const rateSetting = new Setting(this.voiceSettingsContainer)
      .setName('Speed');
    
    this.voiceRateValue = rateSetting.controlEl.createSpan({ text: `${this.selectedVoiceRate.toFixed(2)}x`, cls: 'voice-value-display' });
    rateSetting.addSlider(slider => slider
      .setLimits(0.5, 1.5, 0.05)
      .setValue(this.selectedVoiceRate)
      .onChange(value => {
        this.selectedVoiceRate = value;
        this.voiceRateValue.textContent = `${value.toFixed(2)}x`;
        this.updateTestVoice();
      }));
    
    // Voice Pitch slider setting
    const pitchSetting = new Setting(this.voiceSettingsContainer)
      .setName('Pitch');
    
    this.voicePitchValue = pitchSetting.controlEl.createSpan({ text: this.selectedVoicePitch.toFixed(2), cls: 'voice-value-display' });
    pitchSetting.addSlider(slider => slider
      .setLimits(0.5, 1.5, 0.05)
      .setValue(this.selectedVoicePitch)
      .onChange(value => {
        this.selectedVoicePitch = value;
        this.voicePitchValue.textContent = `${value.toFixed(2)}`;
        this.updateTestVoice();
      }));

    this.loadAvailableVoices();

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());

    new ButtonComponent(buttonContainer)
      .setButtonText('Save Settings')
      .setCta()
      .onClick(() => {
        this.onSubmit({
          preferredVoice: this.selectedVoiceName || undefined,
          voiceRate: this.selectedVoiceRate,
          voicePitch: this.selectedVoicePitch
        });
        this.close();
      });
  }

  private loadAvailableVoices() {
    const synth = window.speechSynthesis;
    this.voiceSelectDropdown.empty();
    this.voiceSelectDropdown.createEl('option', { text: 'Loading voices...', value: '' });
    
    const loadVoicesNow = () => {
      const allVoices = synth.getVoices();
      if (allVoices.length === 0) return;
      
      this.availableVoices = allVoices.filter(v => v.lang.startsWith('en'));
      this.availableVoices.sort((a, b) => {
        const aIsNeural = this.isNeuralVoice(a);
        const bIsNeural = this.isNeuralVoice(b);
        if (aIsNeural && !bIsNeural) return -1;
        if (!aIsNeural && bIsNeural) return 1;
        return a.name.localeCompare(b.name);
      });
      
      this.populateVoiceDropdown();
    };
    
    synth.addEventListener('voiceschanged', loadVoicesNow);
    loadVoicesNow();
    setTimeout(loadVoicesNow, 100);
    setTimeout(loadVoicesNow, 500);
  }

  private isNeuralVoice(voice: SpeechSynthesisVoice): boolean {
    const name = voice.name.toLowerCase();
    return name.includes('neural') || 
           name.includes('google') && (name.includes('standard') || name.includes('wavenet')) ||
           name.includes('azure');
  }

  private populateVoiceDropdown() {
    this.voiceSelectDropdown.empty();
    
    if (this.availableVoices.length === 0) {
      this.voiceSelectDropdown.createEl('option', { text: 'No English voices available', value: '' });
      return;
    }
    
    for (const voice of this.availableVoices) {
      const option = document.createElement('option');
      option.value = voice.name;
      option.textContent = this.formatVoiceName(voice);
      this.voiceSelectDropdown.appendChild(option);
    }
    
    // Try to match current voice
    if (this.selectedVoiceName) {
      this.voiceSelectDropdown.value = this.selectedVoiceName;
    } else {
      const defaultVoice = this.availableVoices.find(v => v.default) || this.availableVoices[0];
      this.selectedVoiceName = defaultVoice.name;
      this.voiceSelectDropdown.value = this.selectedVoiceName;
    }
    
    this.voiceSelectDropdown.addEventListener('change', () => {
      this.selectedVoiceName = this.voiceSelectDropdown.value;
    });
    
    this.testVoiceButton.addEventListener('click', () => {
      this.testSelectedVoice();
    });
  }

  private formatVoiceName(voice: SpeechSynthesisVoice): string {
    let name = voice.name;
    if (name.toLowerCase().includes('google')) {
      name = name.replace(/Google /g, '').replace(/EN-US-/g, 'US ').replace(/USNeural/g, 'US Neural').trim() + ' [Cloud]';
    } else if (name.toLowerCase().includes('neural')) {
      name += ' [Neural]';
    } else if (!voice.localService) {
      name += ' [Cloud]';
    }
    return name.substring(0, 50);
  }

  private testSelectedVoice() {
    const synth = window.speechSynthesis;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance('This is how your narration will sound.');
    const selectedVoice = this.availableVoices.find(v => v.name === this.selectedVoiceName);
    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.rate = this.selectedVoiceRate;
    utterance.pitch = this.selectedVoicePitch;
    synth.speak(utterance);
  }

  private updateTestVoice() {
    // Optional: auto-test on slider change
  }

  onClose() {
    window.speechSynthesis.cancel();
    this.contentEl.empty();
  }
}

// ================================================================================
// ZEN SLIDESHOW MODAL - Audio-narrated presentation with visual outline
// ================================================================================

export class ZenSlideshowModal extends Modal {
  private zenData: ZenSlideshowData;
  private currentSlideIndex: number = 0;
  private currentNodeIndex: number = 0;
  private currentNode: ZenHeadingNode | null = null;
  private slideContainer!: HTMLElement;
  private synth: SpeechSynthesis;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private isPlaying: boolean = false;
  private isPaused: boolean = false;
  private voices: SpeechSynthesisVoice[] = [];
  private voicesLoaded: boolean = false;
  private navigationSequence: ZenHeadingNode[] = [];
  private currentNavIndex: number = 0;
  private preferredVoice: SpeechSynthesisVoice | null = null;
  private voiceRate: number = 0.95;
  private voicePitch: number = 1;

  constructor(app: App, zenData: ZenSlideshowData) {
    super(app);
    this.zenData = zenData;
    this.synth = window.speechSynthesis;
  }

  async onOpen() {
                
    const { contentEl, modalEl } = this;
    contentEl.empty();
    
        modalEl.addClass('slideshow-modal', 'zen-slideshow-modal');
    
    const body = contentEl.createDiv({ cls: 'slideshow-modal-body zen-modal-body' });
        
    this.slideContainer = body.createDiv({ cls: 'slideshow-slide-container zen-slide-container' });
        
    // Navigation Controls
    const controls = body.createDiv({ cls: 'slideshow-controls zen-controls' });
    
    const prevBtn = controls.createEl('button', { cls: 'slideshow-nav-btn zen-nav-btn' });
    setIcon(prevBtn, 'chevron-left');
    prevBtn.title = 'Previous';
    prevBtn.addEventListener('click', () => this.previousSlide());

    const pauseBtn = controls.createEl('button', { cls: 'slideshow-nav-btn zen-pause-btn' });
    setIcon(pauseBtn, 'pause');
    pauseBtn.title = 'Pause/Resume';
    pauseBtn.addEventListener('click', () => this.togglePause());

    const rewindBtn = controls.createEl('button', { cls: 'slideshow-nav-btn zen-rewind-btn' });
    setIcon(rewindBtn, 'skip-back');
    rewindBtn.title = 'Rewind to previous node';
    rewindBtn.addEventListener('click', () => this.rewindNode());

    const skipBtn = controls.createEl('button', { cls: 'slideshow-nav-btn zen-skip-btn' });
    setIcon(skipBtn, 'skip-forward');
    skipBtn.title = 'Skip to next node';
    skipBtn.addEventListener('click', () => this.skipToNext());

    const nextBtn = controls.createEl('button', { cls: 'slideshow-nav-btn zen-nav-btn' });
    setIcon(nextBtn, 'chevron-right');
    nextBtn.title = 'Next';
    nextBtn.addEventListener('click', () => this.nextSlide());

    // Narration status
    const ttsStatus = body.createDiv({ cls: 'zen-tts-status' });
    ttsStatus.id = 'zen-tts-status';

    // Progress wrapper (contains progression bar and counter)
    const progressWrapper = body.createDiv({ cls: 'zen-progress-wrapper' });
    
    const progressContainer = progressWrapper.createDiv({ cls: 'zen-progress-container' });
    const progressBar = progressContainer.createDiv({ cls: 'zen-progress-bar' });
    const progressFill = progressBar.createDiv({ cls: 'zen-progress-fill' });
    progressFill.id = 'zen-progress-fill';

    const slideCounter = progressWrapper.createDiv({ cls: 'slide-counter zen-counter' });
     // Force flush

    // Do async work in setTimeout to avoid blocking UI
    setTimeout(() => {
       // Force flush
      try {
        this.setupWheelNavigation(modalEl);
              } catch (e) {
              }
      
      this.initializeVoices().then(() => {
                return this.startPresentation();
      }).then(() => {
              }).catch(e => {
              });
    }, 10);
  }

  private setupWheelNavigation(modalEl: HTMLElement) {
        const wheelHandler = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY > 0) {
        this.skipToNext();
      } else if (e.deltaY < 0) {
        this.previousSlide();
      }
    };
    
        modalEl.addEventListener('wheel', wheelHandler, { passive: false });
        (this as any).wheelHandler = wheelHandler;
      }

  private async initializeVoices(): Promise<void> {
    return new Promise((resolve) => {
      const loadVoices = () => {
        this.voices = this.synth.getVoices();
        this.voicesLoaded = true;
        
        if (this.zenData.preferredVoice) {
          this.preferredVoice = this.voices.find(v => v.name === this.zenData.preferredVoice) || null;
        }
        
        if (this.zenData.voiceRate !== undefined) {
          this.voiceRate = this.zenData.voiceRate;
        }
        if (this.zenData.voicePitch !== undefined) {
          this.voicePitch = this.zenData.voicePitch;
        }
        
        resolve();
      };
      
      if (this.synth.getVoices().length > 0) {
        loadVoices();
        return;
      }

      const voiceLoadTimeout = setTimeout(loadVoices, 1000);

      this.synth.onvoiceschanged = () => {
        clearTimeout(voiceLoadTimeout);
        loadVoices();
      };
    });
  }

  private async startPresentation() {
        this.currentSlideIndex = 0;
    this.currentNavIndex = 0;
    this.buildNavigationSequence();
            
    if (this.navigationSequence.length > 0) {
      this.currentNode = this.navigationSequence[0];
          }
    
        await this.renderSlide();
        await this.narrateCurrentNode();
      }

  private buildNavigationSequence() {
    this.navigationSequence = [];
    for (const slide of this.zenData.slides) {
            this.navigationSequence.push(slide.titleNode);
      this.addChildrenToSequence(slide.titleNode);
    }
      }

  private addChildrenToSequence(node: ZenHeadingNode) {
    if (node.children) {
      for (const child of node.children) {
        this.navigationSequence.push(child);
        this.addChildrenToSequence(child);
      }
    }
  }

  private async renderSlide() {
                if (this.slideContainer) {
          }
    
    this.slideContainer.empty();
        
    const slide = this.zenData.slides[this.currentSlideIndex];
        if (!slide) {
            return;
    }

    const slideWrapper = this.slideContainer.createDiv({ cls: 'zen-slide-wrapper' });
        
    if (this.currentSlideIndex === 0) {
            await this.renderTitleSlide(slideWrapper, slide);
    } else {
            await this.renderContentSlide(slideWrapper, slide);
    }

    this.updateCounter();
    this.updateProgress();
          }

  private async renderTitleSlide(slideWrapper: HTMLElement, slide: ZenSlideData) {
    slideWrapper.addClass('zen-title-wrapper');
    const titleEl = slideWrapper.createDiv({ cls: 'zen-title-slide' });
    
    const heading = titleEl.createEl('h1', { text: slide.titleNode.text });
    heading.id = 'zen-active-heading';
    heading.classList.add('zen-heading-h1');
    
    const subtitleEl = titleEl.createDiv({ cls: 'zen-subtitle' });
    subtitleEl.setText('Press play to begin narration');
  }

  private async renderContentSlide(slideWrapper: HTMLElement, slide: ZenSlideData) {
    slideWrapper.addClass('zen-content-wrapper');
    
    const mindmapContainer = slideWrapper.createDiv({ cls: 'zen-mindmap-container' });
    const treeContainer = mindmapContainer.createDiv({ cls: 'zen-mindmap-tree' });
    
    const rootNode = this.renderMindmapNode(treeContainer, slide.titleNode, true);
    
    if (slide.titleNode.children && slide.titleNode.children.length > 0) {
      const connector = treeContainer.createDiv({ cls: 'zen-connector' });
      connector.setAttribute('data-branch-connector', 'true');
      
      const childrenContainer = treeContainer.createDiv({ cls: 'zen-children-branch' });
      this.renderMindmapChildren(childrenContainer, slide.titleNode.children);
    }
  }

  private renderMindmapNode(parent: HTMLElement, node: ZenHeadingNode, isRoot: boolean): HTMLElement {
    const nodeEl = parent.createEl('div', { 
      cls: `zen-node zen-node-h${node.level}`,
      attr: { 'data-level': node.level, 'data-node-id': this.getNodeId(node) }
    });
    
    const textEl = nodeEl.createDiv({ cls: 'zen-node-text' });
    textEl.setText(node.text);
    
    if (isRoot) {
      nodeEl.id = 'zen-active-heading';
    }
    
    return nodeEl;
  }

  private renderMindmapChildren(container: HTMLElement, children: ZenHeadingNode[]) {
    for (const child of children) {
      const branchItem = container.createDiv({ cls: 'zen-branch-item' });
      
      const nodeEl = this.renderMindmapNode(branchItem, child, false);
      
      if (child.children && child.children.length > 0) {
        const connector = branchItem.createDiv({ cls: 'zen-connector' });
        connector.setAttribute('data-branch-connector', 'true');
        connector.setAttribute('data-parent-node-id', this.getNodeId(child));
        
        const grandchildrenContainer = branchItem.createDiv({ cls: 'zen-children-branch' });
        this.renderMindmapChildren(grandchildrenContainer, child.children);
      }
    }
  }

  private getNodeId(node: ZenHeadingNode): string {
    return `node-${node.level}-${node.text.substring(0, 20).replace(/\s+/g, '-')}`;
  }

  private updateCounter() {
    const counter = this.slideContainer.parentElement?.querySelector('.zen-counter');
    if (counter) {
      counter.textContent = `${this.currentSlideIndex + 1} / ${this.zenData.slides.length}`;
    }
  }

  private updateProgress() {
    const progressFill = document.getElementById('zen-progress-fill');
    if (progressFill) {
      const totalNodes = this.navigationSequence.length;
      const progressPercent = (this.currentNavIndex / totalNodes) * 100;
      progressFill.style.width = `${progressPercent}%`;
    }
  }

  private async narrateCurrentNode() {
                    
    if (!this.currentNode || this.currentNavIndex >= this.navigationSequence.length) {
            this.handlePresentationEnd();
      return;
    }

    if (!('speechSynthesis' in window)) {
            new Notice('Text-to-Speech not supported in this browser');
      return;
    }

    this.synth.cancel();
    this.isPlaying = true;
    this.isPaused = false;

    let headingText = this.currentNode.text?.trim() || '';
    // Strip numerical prefixes like "1. ", "1.1 ", "1.1.2 " before narration
    headingText = headingText.replace(/^(?:\d+\.)+(?:\d+)?\s+/, '');
    const narrationText = this.currentNode.narration?.trim() || '';
    
    let fullNarration = '';
    if (headingText && narrationText) {
      fullNarration = `${headingText}. ${narrationText}`;
    } else if (headingText) {
      fullNarration = headingText;
    } else {
      fullNarration = narrationText;
    }
    
                
    if (!fullNarration) {
            this.handleNarrationEmpty();
      return;
    }

    const ttsStatus = document.getElementById('zen-tts-status');
    
    const sentences = fullNarration.match(/[^.!?]+[.!?]+/g) || [fullNarration];
    
    if (ttsStatus) {
      ttsStatus.textContent = sentences[0].trim();
    }

    const utterance = new SpeechSynthesisUtterance(fullNarration);
    
    let currentSentenceIndex = 0;
    
    utterance.onboundary = (event) => {
      if (!ttsStatus) return;
      
      if (event.name === 'sentence') {
        const charIndex = event.charIndex;
        let charCount = 0;
        
        for (let i = 0; i < sentences.length; i++) {
          charCount += sentences[i].length;
          if (charIndex < charCount) {
            if (i !== currentSentenceIndex) {
              currentSentenceIndex = i;
              ttsStatus.textContent = sentences[i].trim();
            }
            break;
          }
        }
      }
    };
    
    if (this.preferredVoice) {
      utterance.voice = this.preferredVoice;
    } else if (this.voicesLoaded && this.voices.length > 0) {
      const googleVoice = this.voices.find(v => v.name.toLowerCase().includes('google')) || 
                         this.voices.find(v => v.lang.startsWith('en'));
      if (googleVoice) {
        utterance.voice = googleVoice;
      }
    }

    utterance.rate = this.voiceRate;
    utterance.pitch = this.voicePitch;
    utterance.volume = 1;

    this.applyGlowToCurrentNode();
    
    utterance.onend = () => {
            if (this.currentUtterance !== utterance) {
                return;
      }
      this.isPlaying = false;
      this.handleNarrationEnd();
    };

    utterance.onerror = (e) => {
            if (this.currentUtterance !== utterance) {
                return;
      }
      this.isPlaying = false;
      this.handleNarrationError();
    };

    this.currentUtterance = utterance;
        this.synth.speak(utterance);
                  }

  private applyGlowToCurrentNode() {
    this.removeAllGlow();
    
    const nodeId = this.getNodeId(this.currentNode!);
    const nodeElement = (this.slideContainer.querySelector(`[data-node-id="${nodeId}"]`) || 
                       this.slideContainer.querySelector('#zen-active-heading')) as HTMLElement;
    
    if (nodeElement) {
      nodeElement.classList.add('zen-node-active');
      
      // Center the active node smoothly
      nodeElement.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      
      const currentNodeEl = this.slideContainer.querySelector(`[id="zen-active-heading"]`);
      if (currentNodeEl) {
        currentNodeEl.removeAttribute('id');
      }
      nodeElement.id = 'zen-active-heading';
      
      const connector = this.slideContainer.querySelector(`[data-branch-connector][data-parent-node-id="${nodeId}"]`);
      if (connector) {
        connector.classList.add('zen-connector-active');
      }
    }
  }

  private removeAllGlow() {
    const glowingNodes = this.slideContainer.querySelectorAll('.zen-node-active');
    glowingNodes.forEach(el => el.classList.remove('zen-node-active'));
    
    const glowingConnectors = this.slideContainer.querySelectorAll('.zen-connector-active');
    glowingConnectors.forEach(el => el.classList.remove('zen-connector-active'));
  }

  private handleNarrationEnd() {
    this.currentNavIndex++;
    
    if (this.currentNavIndex < this.navigationSequence.length) {
      this.currentNode = this.navigationSequence[this.currentNavIndex];
      
      // Check if we need to render a new slide (when moving between slides)
      const newSlideIndex = this.getSlideIndexForNavIndex(this.currentNavIndex);
      if (newSlideIndex !== this.currentSlideIndex) {
        this.currentSlideIndex = newSlideIndex;
        this.renderSlide();
      } else {
        this.updateActiveHeadingId();
      }
      
      this.updateProgress();
      
      setTimeout(() => {
        if (!this.isPaused) {
          this.narrateCurrentNode();
        }
      }, 500);
    } else {
      this.handlePresentationEnd();
    }
  }

  private getSlideIndexForNavIndex(navIndex: number): number {
    let nodeCount = 0;
    for (let i = 0; i < this.zenData.slides.length; i++) {
      const slide = this.zenData.slides[i];
      const slideNodeCount = 1 + this.countChildren(slide.titleNode);
      
      if (navIndex < nodeCount + slideNodeCount) {
        return i;
      }
      nodeCount += slideNodeCount;
    }
    return 0;
  }

  private handleNarrationError() {
    this.currentNavIndex++;
    
    if (this.currentNavIndex < this.navigationSequence.length) {
      this.currentNode = this.navigationSequence[this.currentNavIndex];
      this.updateActiveHeadingId();
      this.updateProgress();
      this.narrateCurrentNode();
    } else {
      this.handlePresentationEnd();
    }
  }

  private handleNarrationEmpty() {
    this.currentNavIndex++;
    
    if (this.currentNavIndex < this.navigationSequence.length) {
      this.currentNode = this.navigationSequence[this.currentNavIndex];
      this.updateActiveHeadingId();
      this.narrateCurrentNode();
    } else {
      this.handlePresentationEnd();
    }
  }

  private handlePresentationEnd() {
    const ttsStatus = document.getElementById('zen-tts-status');
    if (ttsStatus) {
      ttsStatus.textContent = 'Presentation complete!';
    }
    new Notice('Zen presentation complete!');
    this.isPlaying = false;
  }

  private updateActiveHeadingId() {
    const oldActive = this.slideContainer.querySelector('#zen-active-heading');
    if (oldActive) {
      oldActive.removeAttribute('id');
    }
    
    const nodeId = this.getNodeId(this.currentNode!);
    const newActive = this.slideContainer.querySelector(`[data-node-id="${nodeId}"]`);
    if (newActive) {
      newActive.id = 'zen-active-heading';
    }
  }

  private togglePause() {
    if (this.isPaused) {
      this.isPaused = false;
      this.updatePauseButtonDisplay(false);
      // If we paused during transition or there's nothing to resume
      if (!this.synth.speaking && !this.isPlaying) {
        this.narrateCurrentNode();
      } else {
        this.synth.resume();
      }
    } else {
      this.synth.pause();
      this.isPaused = true;
      this.updatePauseButtonDisplay(true);
    }
  }

  private updatePauseButtonDisplay(isPaused: boolean) {
    const pauseBtn = this.slideContainer.parentElement?.querySelector('.zen-pause-btn') as HTMLElement;
    if (pauseBtn) {
      pauseBtn.empty();
      setIcon(pauseBtn, isPaused ? 'play' : 'pause');
    }
  }

  private async rewindNode() {
        if (this.currentNavIndex > 0) {
      this.currentUtterance = null; // Prevent onend race condition
      this.synth.cancel();
      this.isPlaying = false;
      this.isPaused = false;
      this.updatePauseButtonDisplay(false);
      
      this.currentNavIndex--;
      this.currentNode = this.navigationSequence[this.currentNavIndex];
      
      // Check if we need to go to the previous slide
      const targetSlideIndex = this.getSlideIndexForNavIndex(this.currentNavIndex);
      
      if (targetSlideIndex !== this.currentSlideIndex) {
        this.currentSlideIndex = targetSlideIndex;
        await this.renderSlide();
      } else {
        this.updateActiveHeadingId();
        this.updateProgress();
      }
      
      if (!this.isPaused) {
        await this.narrateCurrentNode();
      }
    }
  }

  private async skipToNext() {
        this.currentUtterance = null; // Prevent onend race condition
    this.synth.cancel();
    this.isPlaying = false;
    this.isPaused = false;
    this.updatePauseButtonDisplay(false);
    
    this.handleNarrationEnd();
  }

  private async nextSlide() {
        if (this.currentSlideIndex < this.zenData.slides.length - 1) {
      this.currentUtterance = null; // Prevent onend race condition
      this.synth.cancel();
      this.isPlaying = false;
      this.currentSlideIndex++;
      
      // Calculate start of next slide
      this.currentNavIndex = 0;
      for (let i = 0; i < this.currentSlideIndex; i++) {
        this.currentNavIndex += 1 + this.countChildren(this.zenData.slides[i].titleNode);
      }
      
            
      if (this.currentNavIndex < this.navigationSequence.length) {
        this.currentNode = this.navigationSequence[this.currentNavIndex];
      }
      
      await this.renderSlide();
      if (!this.isPaused) {
        await this.narrateCurrentNode();
      }
    }
  }

  private countChildren(node: ZenHeadingNode): number {
    let count = node.children?.length || 0;
    if (node.children) {
      for (const child of node.children) {
        count += this.countChildren(child);
      }
    }
    return count;
  }

  private async previousSlide() {
        if (this.currentSlideIndex > 0) {
      this.currentUtterance = null; // Prevent onend race condition
      this.synth.cancel();
      this.isPlaying = false;
      this.isPaused = false;
      this.updatePauseButtonDisplay(false);
      
      this.currentSlideIndex--;
      
      // Calculate start of previous slide
      this.currentNavIndex = 0;
      for (let i = 0; i < this.currentSlideIndex; i++) {
        this.currentNavIndex += 1 + this.countChildren(this.zenData.slides[i].titleNode);
      }
      
            
      if (this.currentNavIndex < this.navigationSequence.length) {
        this.currentNode = this.navigationSequence[this.currentNavIndex];
      }
      
      await this.renderSlide();
      if (!this.isPaused) {
        await this.narrateCurrentNode();
      }
    }
  }

  onClose() {
        this.isPaused = true; 
    this.isPlaying = false;
    this.currentUtterance = null;

    if (this.synth) {
      // Chrome/Edge bug: sometimes cancel() doesn't work if paused
      this.synth.resume(); 
      this.synth.cancel();
    }
      }

  private countWordsUpToChar(text: string, charIndex: number): number {
    const textUpToIndex = text.substring(0, charIndex);
    return textUpToIndex.split(/\s+/).filter(w => w.length > 0).length;
  }
}
