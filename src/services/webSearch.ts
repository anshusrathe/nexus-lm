import { GoogleGenerativeAI } from '@google/generative-ai';
import { requestUrl } from 'obsidian';
import { AISettings } from '../settings';

export interface SearchResult {
    title: string;
    link: string;
    snippet: string;
    content?: string[];
    date?: string;
}

// Define a callback type for snippet updates during web search
type WebSearchSnippetCallback = (message: string, snippet?: string) => void;

export class WebSearchService {
    // Constructor no longer needs API keys or maxUrlsToVisit as grounding is handled by Gemini directly.
    constructor() {}

    // This method is maintained to satisfy existing calls in other files, but its functionality
    // is now a no-op as the actual web search for grounding is performed by the Gemini model.
    async searchWeb(query: string, isRecentQuery: boolean = false, snippetCallback?: WebSearchSnippetCallback): Promise<SearchResult[]> {
        if (snippetCallback) {
            snippetCallback('Enabling Google Search grounding...', `Grounding for "${query}"`);
        }
        // Return an empty array as results will come from Gemini's grounding metadata.
        return Promise.resolve([]);
    }

    // New method to provide the Google Search tool configuration for Gemini API.
    public getGoogleSearchToolConfig(): any {
        return {
            googleSearch: {}, // This object enables Google Search grounding for the Gemini model.
        };
    }

    async googleCustomSearch(query: string, settings: AISettings): Promise<SearchResult[]> {
        const apiKey = settings.googleCustomSearchApiKey;
        const cx = settings.googleCustomSearchEngineId;
        if (!apiKey || !cx) {
            throw new Error('Google Custom Search API Key and Engine ID must be set in settings.');
        }
        const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${apiKey}&cx=${cx}`;
        const response = await requestUrl({ url });
        const data = response.json;
        if (!data.items) return [];
        return data.items.map((item: any) => ({
            title: item.title,
            link: item.link,
            snippet: item.snippet,
        }));
    }
}
