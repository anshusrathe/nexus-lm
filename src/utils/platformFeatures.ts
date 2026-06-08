import { Platform } from 'obsidian';

/**
 * Feature registry for platform-specific capabilities.
 * This ensures the plugin loads on both desktop and mobile,
 * while gracefully disabling incompatible features on mobile.
 */
export const PLATFORM_FEATURES = {
    PDF_EXTRACTION: !Platform.isMobile,

    RSS_FEEDS: true,

    YOUTUBE_TRANSCRIPTS: !Platform.isMobile,

    AI_CHAT: true,
    AI_TUTOR: true,
    EMBEDDINGS: true,
    NOTEBOOKS: true,

    FILE_SYSTEM_CACHE: true,
} as const;

/**
 * Check if a specific feature is available on the current platform
 */
export function isFeatureAvailable(feature: keyof typeof PLATFORM_FEATURES): boolean {
    return PLATFORM_FEATURES[feature];
}

/**
 * Get platform name for logging/debugging
 */
export function getPlatformName(): string {
    if (Platform.isMobile) {
        return Platform.isIosApp ? 'iOS' : 'Android';
    }
    return Platform.isMacOS ? 'macOS' : Platform.isWin ? 'Windows' : 'Linux';
}
