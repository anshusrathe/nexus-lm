import { requestUrl } from 'obsidian';

interface TranscriptSegment {
    text: string;
    duration: number;
    offset: number;
}

export class YouTubeTranscriptService {
    private cache: Map<string, { transcript: string; timestamp: number }>;
    private readonly DEFAULT_CACHE_TTL = 1800000;
    // Use the Android app User-Agent — this client works without page scraping
    private readonly ANDROID_USER_AGENT = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip';
    private readonly CAPTION_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

    constructor() {
        this.cache = new Map();
    }

    private extractVideoId(url: string): string | null {
        const standardMatch = url.match(/[?&]v=([^&]+)/);
        if (standardMatch) return standardMatch[1];
        const shortMatch = url.match(/youtu\.be\/([^?&]+)/);
        if (shortMatch) return shortMatch[1];
        const liveMatch = url.match(/youtube\.com\/live\/([^/?&]+)/);
        if (liveMatch) return liveMatch[1];
        return null;
    }

    isValidYouTubeUrl(url: string): boolean {
        if (!url) return false;
        return /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|live\/)|youtu\.be\/)/.test(url);
    }

    /**
     * Extracts the video title from the YouTube page.
     * Falls back gracefully if the page fetch is blocked.
     */
    async getVideoTitle(videoUrl: string): Promise<string> {
        try {
            // Try oEmbed API first — lightweight, no bot detection
            const videoId = this.extractVideoId(videoUrl);
            if (videoId) {
                const oembedRes = await requestUrl({
                    url: `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
                    method: 'GET',
                    headers: { 'User-Agent': this.CAPTION_USER_AGENT },
                });
                if (oembedRes.status === 200 && oembedRes.json?.title) {
                    return oembedRes.json.title;
                }
            }
        } catch (_) {
            // fall through
        }
        return 'YouTube Video';
    }

    /**
     * Calls the Innertube player API using the ANDROID client.
     * This approach does NOT require scraping the YouTube page for an API key,
     * which was the source of the 429 / bot-detection redirect errors.
     */
    private async getPlayerResponse(videoId: string): Promise<SafeAny> {
        const response = await requestUrl({
            url: 'https://www.youtube.com/youtubei/v1/player',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': this.ANDROID_USER_AGENT,
            },
            body: JSON.stringify({
                context: {
                    client: {
                        clientName: 'ANDROID',
                        clientVersion: '20.10.38',
                        androidSdkVersion: 34,
                        hl: 'en',
                        gl: 'US',
                    }
                },
                videoId,
            }),
        });
        return response.json;
    }

    private extractCaptionTrackUrl(playerResponse: SafeAny, lang: string): string {
        const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (!tracks || tracks.length === 0) {
            throw new Error('No captions available for this video');
        }
        const track = tracks.find((t: SafeAny) => t.languageCode === lang);
        if (!track) {
            const available = tracks.map((t: SafeAny) => t.languageCode).join(', ');
            throw new Error(`Language ${lang} not available. Available: ${available}`);
        }
        return track.baseUrl.replace(/&fmt=\w+$/, '');
    }

    private async fetchAndParseCaptions(baseUrl: string): Promise<TranscriptSegment[]> {
        const response = await requestUrl({
            url: baseUrl,
            method: 'GET',
            headers: { 'User-Agent': this.CAPTION_USER_AGENT },
        });
        const segments: TranscriptSegment[] = [];
        const matches = response.text.matchAll(/<text start="([^"]+)" dur="([^"]+)"[^>]*>([^<]+)<\/text>/g);
        for (const match of matches) {
            segments.push({
                text: match[3]
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'"),
                offset: parseFloat(match[1]),
                duration: parseFloat(match[2]),
            });
        }
        if (segments.length === 0) throw new Error('No transcript segments found');
        return segments;
    }

    /**
     * Fetches the transcript for a YouTube video with automatic language detection.
     * Tries preferred languages in order, falls back to first available.
     */
    async getTranscript(videoUrl: string, preferredLanguages: string[] = ['en', 'hi', 'es', 'fr', 'de', 'ja', 'pt', 'ru', 'ar', 'zh']): Promise<string> {
        if (!this.isValidYouTubeUrl(videoUrl)) {
            throw new Error('Invalid YouTube URL');
        }
        const videoId = this.extractVideoId(videoUrl);
        if (!videoId) throw new Error('Could not extract video ID');

        // Check cache
        for (const lang of preferredLanguages) {
            const cached = this.cache.get(`${videoId}_${lang}`);
            if (cached && Date.now() - cached.timestamp < this.DEFAULT_CACHE_TTL) {
                return cached.transcript;
            }
        }

        const playerResponse = await this.getPlayerResponse(videoId);

        const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (!tracks || tracks.length === 0) {
            throw new Error('No captions available for this video');
        }

        const availableLanguages = tracks.map((t: SafeAny) => t.languageCode);

        let selectedLanguage = preferredLanguages.find(l => availableLanguages.includes(l))
            ?? availableLanguages[0];

        const captionUrl = this.extractCaptionTrackUrl(playerResponse, selectedLanguage);
        const segments = await this.fetchAndParseCaptions(captionUrl);
        const transcript = segments.map(s => s.text).join(' ').trim();

        this.cache.set(`${videoId}_${selectedLanguage}`, { transcript, timestamp: Date.now() });
        return transcript;
    }

    /**
     * Fetches transcript segments with timing info.
     * Auto-detects the best available language.
     */
    async getTranscriptSegments(videoUrl: string, preferredLanguages: string[] = ['en', 'hi', 'es', 'fr', 'de', 'ja', 'pt', 'ru', 'ar', 'zh']): Promise<TranscriptSegment[]> {
        if (!this.isValidYouTubeUrl(videoUrl)) throw new Error('Invalid YouTube URL');
        const videoId = this.extractVideoId(videoUrl);
        if (!videoId) throw new Error('Could not extract video ID');

        const playerResponse = await this.getPlayerResponse(videoId);

        const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (!tracks || tracks.length === 0) {
            throw new Error('No captions available for this video');
        }

        const availableLanguages = tracks.map((t: SafeAny) => t.languageCode);
        const selectedLanguage = preferredLanguages.find(l => availableLanguages.includes(l))
            ?? availableLanguages[0];

        const captionUrl = this.extractCaptionTrackUrl(playerResponse, selectedLanguage);
        return await this.fetchAndParseCaptions(captionUrl);
    }

    clearCache(): void {
        this.cache.clear();
    }
}
