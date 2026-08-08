import type { ToolHandler } from './toolRegistry';
import type { YouTubeTranscriptService } from '../services/youtubeTranscriptService';

export function createYouTubeTranscriptTool(transcriptService: YouTubeTranscriptService): ToolHandler {
  return {
    definition: {
      name: 'youtube_transcript',
      description: 'Fetch the transcript of a YouTube video to use as context for answering user queries. Use this whenever the user provides a YouTube URL or asks about a YouTube video. Provide the full YouTube video URL as input.',
      category: 'plugin',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full YouTube video URL (e.g., https://www.youtube.com/watch?v=...)',
          },
        },
        required: ['url'],
      },
      needsApproval: false,
    },
    execute: async (args, deps) => {
      const url = String(args.url ?? '');

      deps.onEvent({
        type: 'tool_call',
        data: { toolName: 'youtube_transcript', args },
        timestamp: Date.now(),
      });

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return `Invalid URL: "${url}". URL must start with http:// or https://.`;
      }

      try {
        const transcript = await transcriptService.getTranscript(url);
        
        if (!transcript || transcript.trim().length === 0) {
          return 'The transcript could not be extracted or is empty.';
        }
        
        return `Transcript for ${url}:\n\n${transcript}`;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return `Failed to fetch transcript: ${message}`;
      }
    },
  };
}
