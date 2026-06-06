/**
 * Temporal filtering utility for vault and flash search
 * Parses date-related phrases from queries and filters results by last modified date
 */
import { requestUrl } from 'obsidian';
import { UnifiedProviderManager } from '../services/unifiedProviderManager';

export interface TemporalQuery {
    cleanQuery: string;  // Query with temporal phrases removed
    startDate: number | null;  // Start timestamp (ms since epoch)
    endDate: number | null;    // End timestamp (ms since epoch)
    hasTemporalFilter: boolean;
}

/**
 * Use AI to intelligently extract temporal information from natural language queries.
 * This is more robust than regex patterns and handles diverse phrasings.
 * 
 * @param query The search query potentially containing temporal phrases
 * @param referenceDate The current date to use as reference (defaults to now)
 * @param settings AI settings with provider and API key information
 * @returns TemporalQuery object with cleaned query and date range
 */
export async function parseTemporalQuery(
    query: string, 
    referenceDate: Date = new Date(),
    settings?: any
): Promise<TemporalQuery> {
            
    // Try fast regex-based parsing first (covers common patterns like "this week", "yesterday", etc.)
    const regexResult = parseTemporalQueryRegex(query, referenceDate);
    if (regexResult.hasTemporalFilter) {
        return regexResult;
    }
    
    // Fall back to AI-based detection for complex natural language queries
    return await parseTemporalQueryAI(query, referenceDate, settings);
}

/**
 * Fast regex-based temporal parsing for common patterns.
 * Falls back to AI if no patterns match.
 */
function parseTemporalQueryRegex(query: string, referenceDate: Date): TemporalQuery {
    const lowerQuery = query.toLowerCase();
    let startDate: number | null = null;
    let endDate: number | null = null;
    let cleanQuery = query;
    
    // Log the reference date being used
            
    // Helper to get start of day
    const startOfDay = (date: Date): Date => {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        return d;
    };
    
    // Helper to get end of day
    const endOfDay = (date: Date): Date => {
        const d = new Date(date);
        d.setHours(23, 59, 59, 999);
        return d;
    };
    
    // Helper to get start of week (Monday)
    const startOfWeek = (date: Date): Date => {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
        d.setDate(diff);
        return startOfDay(d);
    };
    
    // Helper to get start of month
    const startOfMonth = (date: Date): Date => {
        const d = new Date(date);
        d.setDate(1);
        return startOfDay(d);
    };
    
    // Helper to get start of year
    const startOfYear = (date: Date): Date => {
        const d = new Date(date);
        d.setMonth(0, 1);
        return startOfDay(d);
    };
    
    // Pattern 1: "this week", "this month", "this year"
    if (lowerQuery.match(/\bthis\s+week\b/)) {
        startDate = startOfWeek(referenceDate).getTime();
        endDate = endOfDay(referenceDate).getTime();
        cleanQuery = cleanQuery.replace(/\bthis\s+week\b/gi, '').trim();
    } else if (lowerQuery.match(/\bthis\s+month\b/)) {
        startDate = startOfMonth(referenceDate).getTime();
        endDate = endOfDay(referenceDate).getTime();
        cleanQuery = cleanQuery.replace(/\bthis\s+month\b/gi, '').trim();
    } else if (lowerQuery.match(/\bthis\s+year\b/)) {
        startDate = startOfYear(referenceDate).getTime();
        endDate = endOfDay(referenceDate).getTime();
        cleanQuery = cleanQuery.replace(/\bthis\s+year\b/gi, '').trim();
    }
    
    // Pattern 2: "last week", "last month", "last year"
    else if (lowerQuery.match(/\blast\s+week\b/)) {
        const lastWeekStart = new Date(referenceDate);
        lastWeekStart.setDate(lastWeekStart.getDate() - 7);
        startDate = startOfWeek(lastWeekStart).getTime();
        const lastWeekEnd = new Date(startDate);
        lastWeekEnd.setDate(lastWeekEnd.getDate() + 6);
        endDate = endOfDay(lastWeekEnd).getTime();
        cleanQuery = cleanQuery.replace(/\blast\s+week\b/gi, '').trim();
    } else if (lowerQuery.match(/\blast\s+month\b/)) {
        const lastMonth = new Date(referenceDate);
        lastMonth.setMonth(lastMonth.getMonth() - 1);
        startDate = startOfMonth(lastMonth).getTime();
        const lastMonthEnd = new Date(lastMonth);
        lastMonthEnd.setMonth(lastMonthEnd.getMonth() + 1);
        lastMonthEnd.setDate(0); // Last day of previous month
        endDate = endOfDay(lastMonthEnd).getTime();
        cleanQuery = cleanQuery.replace(/\blast\s+month\b/gi, '').trim();
    } else if (lowerQuery.match(/\blast\s+year\b/)) {
        const lastYear = new Date(referenceDate);
        lastYear.setFullYear(lastYear.getFullYear() - 1);
        startDate = startOfYear(lastYear).getTime();
        const lastYearEnd = new Date(lastYear);
        lastYearEnd.setMonth(11, 31);
        endDate = endOfDay(lastYearEnd).getTime();
        cleanQuery = cleanQuery.replace(/\blast\s+year\b/gi, '').trim();
    }
    
    // Pattern 3: "since yesterday", "since last monday", etc.
    else if (lowerQuery.match(/\bsince\s+yesterday\b/)) {
        const yesterday = new Date(referenceDate);
        yesterday.setDate(yesterday.getDate() - 1);
        startDate = startOfDay(yesterday).getTime();
        endDate = endOfDay(referenceDate).getTime();
        cleanQuery = cleanQuery.replace(/\bsince\s+yesterday\b/gi, '').trim();
    } else if (lowerQuery.match(/\bsince\s+today\b/)) {
        startDate = startOfDay(referenceDate).getTime();
        endDate = endOfDay(referenceDate).getTime();
        cleanQuery = cleanQuery.replace(/\bsince\s+today\b/gi, '').trim();
    } else if (lowerQuery.match(/\bsince\s+(last\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/)) {
        const match = lowerQuery.match(/\bsince\s+(last\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
        if (match) {
            const dayName = match[2];
            const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
            const targetDay = daysOfWeek.indexOf(dayName);
            const currentDay = referenceDate.getDay();
            
            let daysAgo = currentDay - targetDay;
            if (daysAgo <= 0 || match[1]) { // "last" prefix or target day is in future
                daysAgo += 7;
            }
            
            const targetDate = new Date(referenceDate);
            targetDate.setDate(targetDate.getDate() - daysAgo);
            startDate = startOfDay(targetDate).getTime();
            endDate = endOfDay(referenceDate).getTime();
            cleanQuery = cleanQuery.replace(/\bsince\s+(last\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '').trim();
        }
    }
    
    // Pattern 4: "in/over/during the past/last week/month/year" (without number)
    else if (lowerQuery.match(/\b(in|over|during)\s+the\s+(past|last)\s+(week|month|year)\b/)) {
        const match = lowerQuery.match(/\b(in|over|during)\s+the\s+(past|last)\s+(week|month|year)\b/);
        if (match) {
            const unit = match[3];
            const pastDate = new Date(referenceDate);
            
            switch (unit) {
                case 'week':
                    pastDate.setDate(pastDate.getDate() - 7);
                    break;
                case 'month':
                    pastDate.setMonth(pastDate.getMonth() - 1);
                    break;
                case 'year':
                    pastDate.setFullYear(pastDate.getFullYear() - 1);
                    break;
            }
            
            startDate = startOfDay(pastDate).getTime();
            endDate = endOfDay(referenceDate).getTime();
            cleanQuery = cleanQuery.replace(/\b(in|over|during)\s+the\s+(past|last)\s+(week|month|year)\b/gi, '').trim();
        }
    }
    
    // Pattern 5: "in the last X days/weeks/months/years"
    else if (lowerQuery.match(/\bin\s+the\s+(last|past)\s+(\d+)\s+(day|week|month|year)s?\b/)) {
        const match = lowerQuery.match(/\bin\s+the\s+(last|past)\s+(\d+)\s+(day|week|month|year)s?\b/);
        if (match) {
            const amount = parseInt(match[2]);
            const unit = match[3];
            const pastDate = new Date(referenceDate);
            
            switch (unit) {
                case 'day':
                    pastDate.setDate(pastDate.getDate() - amount);
                    break;
                case 'week':
                    pastDate.setDate(pastDate.getDate() - (amount * 7));
                    break;
                case 'month':
                    pastDate.setMonth(pastDate.getMonth() - amount);
                    break;
                case 'year':
                    pastDate.setFullYear(pastDate.getFullYear() - amount);
                    break;
            }
            
            startDate = startOfDay(pastDate).getTime();
            endDate = endOfDay(referenceDate).getTime();
            cleanQuery = cleanQuery.replace(/\bin\s+the\s+(last|past)\s+(\d+)\s+(day|week|month|year)s?\b/gi, '').trim();
        }
    }
    
    // Pattern 6: "X days/weeks/months/years ago"
    else if (lowerQuery.match(/\b(\d+)\s+(day|week|month|year)s?\s+ago\b/)) {
        const match = lowerQuery.match(/\b(\d+)\s+(day|week|month|year)s?\s+ago\b/);
        if (match) {
            const amount = parseInt(match[1]);
            const unit = match[2];
            const pastDate = new Date(referenceDate);
            
            switch (unit) {
                case 'day':
                    pastDate.setDate(pastDate.getDate() - amount);
                    break;
                case 'week':
                    pastDate.setDate(pastDate.getDate() - (amount * 7));
                    break;
                case 'month':
                    pastDate.setMonth(pastDate.getMonth() - amount);
                    break;
                case 'year':
                    pastDate.setFullYear(pastDate.getFullYear() - amount);
                    break;
            }
            
            startDate = startOfDay(pastDate).getTime();
            endDate = endOfDay(referenceDate).getTime();
            cleanQuery = cleanQuery.replace(/\b(\d+)\s+(day|week|month|year)s?\s+ago\b/gi, '').trim();
        }
    }
    
    // Pattern 7: Month names (e.g., "since january", "in march")
    else if (lowerQuery.match(/\b(since|in)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/)) {
        const match = lowerQuery.match(/\b(since|in)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
        if (match) {
            const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
            const monthIndex = monthNames.indexOf(match[2]);
            const targetDate = new Date(referenceDate.getFullYear(), monthIndex, 1);
            
            // If month is in the future, use last year
            if (targetDate > referenceDate) {
                targetDate.setFullYear(targetDate.getFullYear() - 1);
            }
            
            if (match[1] === 'since') {
                startDate = startOfDay(targetDate).getTime();
                endDate = endOfDay(referenceDate).getTime();
            } else { // "in"
                startDate = startOfDay(targetDate).getTime();
                const monthEnd = new Date(targetDate);
                monthEnd.setMonth(monthEnd.getMonth() + 1);
                monthEnd.setDate(0);
                endDate = endOfDay(monthEnd).getTime();
            }
            cleanQuery = cleanQuery.replace(/\b(since|in)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi, '').trim();
        }
    }
    
    // Pattern 8: ISO date formats (YYYY-MM-DD, YYYY/MM/DD, DD-MM-YYYY, DD/MM/YYYY)
    else if (lowerQuery.match(/\b(from|since|after)\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\b/)) {
        const match = lowerQuery.match(/\b(from|since|after)\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\b/);
        if (match) {
            const dateStr = match[2];
            const parsedDate = parseFlexibleDate(dateStr);
            if (parsedDate) {
                startDate = startOfDay(parsedDate).getTime();
                endDate = endOfDay(referenceDate).getTime();
                cleanQuery = cleanQuery.replace(/\b(from|since|after)\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\b/gi, '').trim();
            }
        }
    }
    
    // Pattern 9: Date ranges (from X to Y)
    else if (lowerQuery.match(/\bfrom\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\s+to\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\b/)) {
        const match = lowerQuery.match(/\bfrom\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\s+to\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\b/);
        if (match) {
            const startDateParsed = parseFlexibleDate(match[1]);
            const endDateParsed = parseFlexibleDate(match[2]);
            if (startDateParsed && endDateParsed) {
                startDate = startOfDay(startDateParsed).getTime();
                endDate = endOfDay(endDateParsed).getTime();
                cleanQuery = cleanQuery.replace(/\bfrom\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\s+to\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\b/gi, '').trim();
            }
        }
    }
    
    // Pattern 10: "today", "yesterday"
    else if (lowerQuery.match(/\btoday\b/)) {
        startDate = startOfDay(referenceDate).getTime();
        endDate = endOfDay(referenceDate).getTime();
        cleanQuery = cleanQuery.replace(/\btoday\b/gi, '').trim();
    } else if (lowerQuery.match(/\byesterday\b/)) {
        const yesterday = new Date(referenceDate);
        yesterday.setDate(yesterday.getDate() - 1);
        startDate = startOfDay(yesterday).getTime();
        endDate = endOfDay(yesterday).getTime();
        cleanQuery = cleanQuery.replace(/\byesterday\b/gi, '').trim();
    }
    
    // Clean up extra whitespace
    cleanQuery = cleanQuery.replace(/\s+/g, ' ').trim();
    
    // Log the parsed result
    const result = {
        cleanQuery,
        startDate,
        endDate,
        hasTemporalFilter: startDate !== null || endDate !== null
    };
    
    if (result.hasTemporalFilter) {
                                    } else {
            }
    
    return result;
}

/**
 * Parse flexible date formats
 * Supports: YYYY-MM-DD, YYYY/MM/DD, DD-MM-YYYY, DD/MM/YYYY
 */
function parseFlexibleDate(dateStr: string): Date | null {
    // Try YYYY-MM-DD or YYYY/MM/DD
    let match = dateStr.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (match) {
        const year = parseInt(match[1]);
        const month = parseInt(match[2]) - 1; // JS months are 0-indexed
        const day = parseInt(match[3]);
        return new Date(year, month, day);
    }
    
    // Try DD-MM-YYYY or DD/MM/YYYY
    match = dateStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (match) {
        const day = parseInt(match[1]);
        const month = parseInt(match[2]) - 1;
        const year = parseInt(match[3]);
        return new Date(year, month, day);
    }
    
    return null;
}



/**
 * AI-based temporal query parsing for complex natural language queries.
 * Uses a lightweight LLM call to extract temporal information that regex can't handle.
 * Supports all providers: Gemini, OpenRouter, Groq, Ollama.
 * 
 * Examples it handles:
 * - "what were we working on five months ago"
 * - "files from around christmas time"
 * - "documents I edited last summer"
 * - "notes from when I was on vacation in july"
 */
async function parseTemporalQueryAI(query: string, referenceDate: Date, settings?: any): Promise<TemporalQuery> {
    const lowerQuery = query.toLowerCase();
    
    // Quick heuristic check: Does the query contain temporal FILE FILTERING indicators?
    // Focus on phrases that indicate filtering by file creation/modification date
    const temporalFileFilterPhrases = [
        'files created', 'files modified', 'files updated', 'files edited', 'files changed',
        'notes created', 'notes modified', 'notes updated', 'notes edited', 'notes changed',
        'documents created', 'documents modified', 'documents updated', 'documents edited',
        'i created', 'i modified', 'i updated', 'i edited', 'i changed', 'i worked on',
        'we created', 'we modified', 'we updated', 'we edited', 'we changed', 'we worked on',
        'created this', 'modified this', 'updated this', 'edited this', 'changed this',
        'created last', 'modified last', 'updated last', 'edited last', 'changed last',
        'created yesterday', 'modified yesterday', 'updated yesterday',
        'created today', 'modified today', 'updated today',
        'work from this', 'work from last', 'work this', 'work last'
    ];
    
    const hasTemporalFileFilterPhrase = temporalFileFilterPhrases.some(phrase => lowerQuery.includes(phrase));
    
    if (!hasTemporalFileFilterPhrase) {
        // No temporal file filtering phrases found, skip AI call
        return {
            cleanQuery: query,
            startDate: null,
            endDate: null,
            hasTemporalFilter: false
        };
    }
    
    if (!settings) {
                return {
            cleanQuery: query,
            startDate: null,
            endDate: null,
            hasTemporalFilter: false
        };
    }
    
    // Check if we have the necessary API key for the provider
    const provider = settings.provider || 'gemini';
    let apiKey = '';
    
    switch (provider) {
        case 'gemini':
            apiKey = settings.geminiApiKey || settings.apiKey;
            break;
        case 'openrouter':
            apiKey = settings.openRouterApiKey;
            break;
        case 'opencode':
            apiKey = settings.openCodeApiKey;
            break;
        case 'groq':
            apiKey = settings.groqApiKey;
            break;
        case 'nvidia':
            apiKey = settings.nvidiaApiKey;
            break;
        case 'ollama':
            // Ollama doesn't need API key for local instances
            apiKey = 'local';
            break;
        default:
            apiKey = settings.geminiApiKey || settings.apiKey;
    }
    
    if (!apiKey) {
                return {
            cleanQuery: query,
            startDate: null,
            endDate: null,
            hasTemporalFilter: false
        };
    }
    
    // Use a simple prompt to extract temporal information
    const prompt = `Current date: ${referenceDate.toISOString().split('T')[0]} (${referenceDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })})

Analyze this query and determine if it's asking to FILTER FILES by their creation/modification date, or if it's asking for CONTENT about a time period:
"${query}"

CRITICAL DISTINCTION:
- TEMPORAL FILTER (filter files by when they were created/modified): "files I created this week", "notes modified yesterday", "what did I work on last month", "documents I edited in January"
- CONTENT QUERY (search for content about a time period): "fertilizer subsidy in 2022", "events of 1945", "Q4 2023 revenue", "what happened in the year 2020"

If the query is asking to FILTER FILES by creation/modification date, respond with:
{"hasTime": true, "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "cleanQuery": "query without time references"}

If the query is asking for CONTENT about a time period (NOT filtering by file dates), respond with:
{"hasTime": false}

Rules:
- Only set hasTime:true if the query explicitly asks about file creation/modification dates
- Years/dates mentioned in the context of content topics should return hasTime:false
- Calculate dates relative to the current date shown above
- startDate and endDate should be in YYYY-MM-DD format
- cleanQuery should be the original query with temporal phrases removed
- Respond with ONLY the JSON, no other text

JSON:`;

    try {
        let response: any;
        let content: string = '';

        // Use provider-specific API calls
        if (provider === 'gemini') {
            // Use Gemini API
            response = await requestUrl({
                url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-8b:generateContent?key=${apiKey}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: prompt }]
                    }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 200
                    }
                })
            });
            
            if (response.status !== 200) {
                                return { cleanQuery: query, startDate: null, endDate: null, hasTemporalFilter: false };
            }
            
            content = response.json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
            
        } else if (provider === 'openrouter') {
            // Use OpenRouter API - try a sequence of reliable free/cheap models
            // google/gemini-flash-1.5-8b was deprecated; use current stable alternatives
            const openRouterModels = [
                'google/gemini-2.0-flash-lite-001',
                'meta-llama/llama-3.1-8b-instruct:free',
                'mistralai/mistral-7b-instruct:free',
            ];
            
            let openRouterSuccess = false;
            for (const orModel of openRouterModels) {
                try {
                    response = await requestUrl({
                        url: 'https://openrouter.ai/api/v1/chat/completions',
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`,
                            'HTTP-Referer': 'https://obsidian.md',
                            'X-Title': 'Obsidian AI Tutor - Temporal Parser'
                        },
                        body: JSON.stringify({
                            model: orModel,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: 0.1,
                            max_tokens: 200
                        })
                    });
                    
                    if (response.status === 200) {
                        content = response.json.choices?.[0]?.message?.content?.trim() || '';
                        openRouterSuccess = true;
                        break;
                    }
                                    } catch (modelErr) {
                                    }
            }
            
            if (!openRouterSuccess) {
                return parseTemporalQueryRegex(query, referenceDate);
            }
            
        } else if (provider === 'groq') {
            // Use Groq API - try primary model then fallback
            const groqModels = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'];
            let groqSuccess = false;
            for (const groqModel of groqModels) {
                try {
                    response = await requestUrl({
                        url: 'https://api.groq.com/openai/v1/chat/completions',
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`
                        },
                        body: JSON.stringify({
                            model: groqModel,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: 0.1,
                            max_tokens: 200
                        })
                    });
                    
                    if (response.status === 200) {
                        content = response.json.choices?.[0]?.message?.content?.trim() || '';
                        groqSuccess = true;
                        break;
                    }
                                    } catch (modelErr) {
                                    }
            }
            
            if (!groqSuccess) {
                return parseTemporalQueryRegex(query, referenceDate);
            }
            
        } else if (provider === 'ollama') {
            // Ollama is a local server — skip the AI call and use regex directly.
            // Regex is fast, reliable, and doesn't depend on the local model being loaded.
            return parseTemporalQueryRegex(query, referenceDate);
        } else if (UnifiedProviderManager.getInstance().hasProvider(provider)) {
            const unifiedProvider = UnifiedProviderManager.getInstance().getProvider(provider)!;
            const modelId = settings.model || 'default';
            const response = await unifiedProvider.generateContent(
                modelId,
                [{ role: 'user', content: prompt }],
                { temperature: 0.1, maxTokens: 200 }
            );
            content = response.text.trim();
        } else {
                        return { cleanQuery: query, startDate: null, endDate: null, hasTemporalFilter: false };
        }
        
        if (!content) {
            return {
                cleanQuery: query,
                startDate: null,
                endDate: null,
                hasTemporalFilter: false
            };
        }

        // Parse the JSON response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
                        return {
                cleanQuery: query,
                startDate: null,
                endDate: null,
                hasTemporalFilter: false
            };
        }

        const parsed = JSON.parse(jsonMatch[0]);
        
        if (!parsed.hasTime) {
            return {
                cleanQuery: query,
                startDate: null,
                endDate: null,
                hasTemporalFilter: false
            };
        }

        // Convert dates to timestamps
        const startDate = parsed.startDate ? new Date(parsed.startDate + 'T00:00:00').getTime() : null;
        const endDate = parsed.endDate ? new Date(parsed.endDate + 'T23:59:59.999').getTime() : null;
        
        const result = {
            cleanQuery: parsed.cleanQuery || query,
            startDate,
            endDate,
            hasTemporalFilter: startDate !== null || endDate !== null
        };

        if (result.hasTemporalFilter) {
                                                        } else {
                    }

        return result;

    } catch (error) {
                // Fall back to no temporal filter on error
        return {
            cleanQuery: query,
            startDate: null,
            endDate: null,
            hasTemporalFilter: false
        };
    }
}
