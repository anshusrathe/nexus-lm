import { App, TFile } from 'obsidian';

/**
 * Multimodal file type definitions based on Google Gemini API documentation
 */

export interface MultimodalInput {
    type: 'inline' | 'fileUri';
    data?: string; // base64 for inline
    uri?: string; // for File API uploads
    mimeType: string;
    fileName: string;
    filePath?: string; // Added for efficient vault lookup
    fileSize: number;
}

export interface ProcessedMultimodalData {
    inlineData: Array<{ mimeType: string; data: string; fileName: string }>;
    fileUris: Array<{ uri: string; mimeType: string; fileName: string }>;
    textContent: Array<{ path: string; content: string; similarity: number }>;
}

// File size limits
export const MAX_INLINE_FILE_SIZE = 20 * 1024 * 1024; // 20MB - use inline data
export const MAX_FILE_API_SIZE = 2 * 1024 * 1024 * 1024; // 2GB - use File API

/**
 * Supported MIME types based on Gemini API documentation
 */
export const SUPPORTED_MIME_TYPES = {
    // Images
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'webp': 'image/webp',
    'heic': 'image/heic',
    'heif': 'image/heif',
    'gif': 'image/gif',
    'bmp': 'image/bmp',
    'svg': 'image/svg+xml',
    
    // Documents
    'pdf': 'application/pdf',
    
    // Audio
    'wav': 'audio/wav',
    'mp3': 'audio/mp3',
    'aiff': 'audio/aiff',
    'aac': 'audio/aac',
    'ogg': 'audio/ogg',
    'flac': 'audio/flac',
    
    // Video
    'mp4': 'video/mp4',
    'mpeg': 'video/mpeg',
    'mov': 'video/mov',
    'avi': 'video/avi',
    'flv': 'video/x-flv',
    'mpg': 'video/mpg',
    'webm': 'video/webm',
    'wmv': 'video/wmv',
    '3gpp': 'video/3gpp',
    '3gp': 'video/3gpp',
    
    // Data
    'csv': 'text/csv',
    'txt': 'text/plain',
    'json': 'application/json',
    'xml': 'application/xml',
};

/**
 * Get MIME type from file extension
 */
export function getMimeType(fileName: string): string | null {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (!ext) return null;
    return SUPPORTED_MIME_TYPES[ext as keyof typeof SUPPORTED_MIME_TYPES] || null;
}

/**
 * Check if file type is supported for multimodal input
 */
export function isMultimodalSupported(fileName: string): boolean {
    const ext = fileName.split('.').pop()?.toLowerCase();
    return ext ? ext in SUPPORTED_MIME_TYPES : false;
}

/**
 * Check if file is a text-based file (should be read as text)
 */
export function isTextFile(fileName: string): boolean {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const textExtensions = ['md', 'txt', 'json', 'xml', 'csv', 'html', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'yaml', 'yml'];
    return ext ? textExtensions.includes(ext) : false;
}

/**
 * Check if file is an image
 */
export function isImageFile(fileName: string): boolean {
    return /\.(png|jpg|jpeg|gif|bmp|svg|webp|heic|heif)$/i.test(fileName);
}

/**
 * Check if file is a PDF
 */
export function isPDFFile(fileName: string): boolean {
    return /\.pdf$/i.test(fileName);
}

/**
 * Check if file is an audio file
 */
export function isAudioFile(fileName: string): boolean {
    return /\.(wav|mp3|aiff|aac|ogg|flac|mpeg)$/i.test(fileName);
}

/**
 * Check if file is a video file
 */
export function isVideoFile(fileName: string): boolean {
    return /\.(mp4|mpeg|mov|avi|flv|mpg|webm|wmv|3gpp|3gp)$/i.test(fileName);
}

/**
 * Get file category for display (with Flaticon SVG icons)
 */
export function getFileCategory(fileName: string): string {
    const icons = {
        image: '<svg class="file-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M464 448H48c-26.51 0-48-21.49-48-48V112c0-26.51 21.49-48 48-48h416c26.51 0 48 21.49 48 48v288c0 26.51-21.49 48-48 48zM112 120c-30.928 0-56 25.072-56 56s25.072 56 56 56 56-25.072 56-56-25.072-56-56-56zM64 384h384V272l-87.515-87.515c-4.686-4.686-12.284-4.686-16.971 0L208 320l-55.515-55.515c-4.686-4.686-12.284-4.686-16.971 0L64 336v48z"/></svg>',
        document: '<svg class="file-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512"><path d="M224 136V0H24C10.7 0 0 10.7 0 24v464c0 13.3 10.7 24 24 24h336c13.3 0 24-10.7 24-24V160H248c-13.2 0-24-10.8-24-24zm160-14.1v6.1H256V0h6.1c6.4 0 12.5 2.5 17 7l97.9 98c4.5 4.5 7 10.6 7 16.9z"/></svg>',
        audio: '<svg class="file-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512"><path d="M224 136V0H24C10.7 0 0 10.7 0 24v464c0 13.3 10.7 24 24 24h336c13.3 0 24-10.7 24-24V160H248c-13.2 0-24-10.8-24-24zm-64 268c0 10.7-12.9 16-20.5 8.5L104 376H76c-6.6 0-12-5.4-12-12v-56c0-6.6 5.4-12 12-12h28l35.5-36.5c7.6-7.6 20.5-2.2 20.5 8.5v136zm33.2-47.6c9.1-9.3 9.1-24.1 0-33.4-22.1-22.8 12.2-56.2 34.4-33.5 27.2 27.9 27.2 72.4 0 100.4-21.8 22.3-56.9-10.4-34.4-33.5zm86-117.1c54.4 55.9 54.4 144.8 0 200.8-21.8 22.4-57-10.3-34.4-33.5 36.2-37.2 36.3-96.5 0-133.8-22.1-22.8 12.3-56.3 34.4-33.5zM384 121.9v6.1H256V0h6.1c6.4 0 12.5 2.5 17 7l97.9 98c4.5 4.5 7 10.6 7 16.9z"/></svg>',
        video: '<svg class="file-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><path d="M336.2 64H47.8C21.4 64 0 85.4 0 111.8v288.4C0 426.6 21.4 448 47.8 448h288.4c26.4 0 47.8-21.4 47.8-47.8V111.8c0-26.4-21.4-47.8-47.8-47.8zm189.4 37.7L416 177.3v157.4l109.6 75.5c21.2 14.6 50.4-.3 50.4-25.8V127.5c0-25.4-29.1-40.4-50.4-25.8z"/></svg>',
        spreadsheet: '<svg class="file-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512"><path d="M224 136V0H24C10.7 0 0 10.7 0 24v464c0 13.3 10.7 24 24 24h336c13.3 0 24-10.7 24-24V160H248c-13.2 0-24-10.8-24-24zM48 296h80v64H48v-64zm0 96h80v64H48v-64zm96-96h80v64h-80v-64zm0 96h80v64h-80v-64zm96-96h80v64h-80v-64zm0 96h80v64h-80v-64zM384 121.9v6.1H256V0h6.1c6.4 0 12.5 2.5 17 7l97.9 98c4.5 4.5 7 10.6 7 16.9z"/></svg>',
        text: '<svg class="file-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512"><path d="M224 136V0H24C10.7 0 0 10.7 0 24v464c0 13.3 10.7 24 24 24h336c13.3 0 24-10.7 24-24V160H248c-13.2 0-24-10.8-24-24zm64 236c0 6.6-5.4 12-12 12H108c-6.6 0-12-5.4-12-12v-8c0-6.6 5.4-12 12-12h168c6.6 0 12 5.4 12 12v8zm0-64c0 6.6-5.4 12-12 12H108c-6.6 0-12-5.4-12-12v-8c0-6.6 5.4-12 12-12h168c6.6 0 12 5.4 12 12v8zm0-72v8c0 6.6-5.4 12-12 12H108c-6.6 0-12-5.4-12-12v-8c0-6.6 5.4-12 12-12h168c6.6 0 12 5.4 12 12zm48-22.1v6.1H256V0h6.1c6.4 0 12.5 2.5 17 7l97.9 98c4.5 4.5 7 10.6 7 16.9z"/></svg>'
    };
    
    if (isImageFile(fileName)) return icons.image + ' Image';
    if (isPDFFile(fileName)) return icons.document + ' PDF';
    if (isAudioFile(fileName)) return icons.audio + ' Audio';
    if (isVideoFile(fileName)) return icons.video + ' Video';
    if (/\.csv$/i.test(fileName)) return icons.spreadsheet + ' CSV';
    if (isTextFile(fileName)) return icons.text + ' Text';
    return icons.document + ' File';
}

/**
 * Process a file for multimodal input
 * Returns inline data for small files, null for large files (which need File API)
 */
export async function processFileForMultimodal(
    app: App,
    file: TFile
): Promise<MultimodalInput | null> {
    try {
        const mimeType = getMimeType(file.name);
        if (!mimeType) {
                        return null;
        }

        const fileSize = file.stat.size;
        
        // For large files, return metadata indicating File API should be used
        if (fileSize > MAX_INLINE_FILE_SIZE) {
                        return {
                type: 'fileUri',
                mimeType,
                fileName: file.name,
                filePath: file.path,
                fileSize,
            };
        }

        // For images, PDFs, audio, video - read as binary and convert to base64
        if (isImageFile(file.name) || isPDFFile(file.name) || isAudioFile(file.name) || isVideoFile(file.name)) {
            const arrayBuffer = await app.vault.readBinary(file);
            const base64 = arrayBufferToBase64(arrayBuffer);
            
            return {
                type: 'inline',
                data: base64,
                mimeType,
                fileName: file.name,
                filePath: file.path,
                fileSize,
            };
        }

        // For CSV and other text-based formats, read as text
        if (file.extension === 'csv' || isTextFile(file.name)) {
            const textContent = await app.vault.read(file);
            const base64 = btoa(unescape(encodeURIComponent(textContent)));
            
            return {
                type: 'inline',
                data: base64,
                mimeType,
                fileName: file.name,
                filePath: file.path,
                fileSize,
            };
        }

        return null;
    } catch (error) {
                return null;
    }
}

/**
 * Convert ArrayBuffer to base64 string
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Format multimodal inputs for Gemini API (inline data)
 * Returns an array of parts that can be included in the API request
 */
export function formatInlineDataForGemini(multimodalInputs: MultimodalInput[]): Array<{ inlineData: { mimeType: string; data: string } }> {
    return multimodalInputs
        .filter(input => input.type === 'inline' && input.data)
        .map(input => ({
            inlineData: {
                mimeType: input.mimeType,
                data: input.data!,
            }
        }));
}

/**
 * Format multimodal inputs for OpenRouter API
 * Returns content array with text and file objects for OpenRouter's format
 */
export function formatMultimodalForOpenRouter(
    textContent: string,
    multimodalInputs: MultimodalInput[]
): Array<{ type: string; text?: string; file?: { filename: string; fileData: string } }> {
    const content: Array<{ type: string; text?: string; file?: { filename: string; fileData: string } }> = [];
    
    // Add text content first
    if (textContent) {
        content.push({
            type: 'text',
            text: textContent
        });
    }
    
    // Add multimodal files
    multimodalInputs
        .filter(input => input.type === 'inline' && input.data)
        .forEach(input => {
            // For PDFs and images, use OpenRouter's file format
            if (isPDFFile(input.fileName) || isImageFile(input.fileName)) {
                const dataUrl = `data:${input.mimeType};base64,${input.data}`;
                content.push({
                    type: 'file',
                    file: {
                        filename: input.fileName,
                        fileData: dataUrl
                    }
                });
            }
        });
    
    return content;
}

/**
 * Get OpenRouter plugins configuration for PDF processing
 * Uses the free 'pdf-text' engine
 */
export function getOpenRouterPDFPlugins() {
    return [
        {
            id: 'file-parser',
            pdf: {
                engine: 'pdf-text' // Free engine for text-based PDFs
            }
        }
    ];
}

/**
 * Check if a file needs to be uploaded via File API
 */
export function needsFileAPIUpload(file: TFile): boolean {
    return file.stat.size > MAX_INLINE_FILE_SIZE;
}

/**
 * Get display icon for file type (Colorful Flaticon SVG)
 */
export function getFileIcon(fileName: string): string {
    const icons = {
        image: '<svg class="file-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#7B68EE" d="M448 0H64C28.7 0 0 28.7 0 64v384c0 35.3 28.7 64 64 64h384c35.3 0 64-28.7 64-64V64c0-35.3-28.7-64-64-64z"/><path fill="#FFF" d="M160 192c-17.7 0-32-14.3-32-32s14.3-32 32-32 32 14.3 32 32-14.3 32-32 32zm224 192H128l64-96 48 64 64-96 80 128z"/></svg>',
        pdf: '<svg class="file-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#E2574C" d="M448 0H64C28.7 0 0 28.7 0 64v384c0 35.3 28.7 64 64 64h384c35.3 0 64-28.7 64-64V64c0-35.3-28.7-64-64-64z"/><path fill="#FFF" d="M191.7 256.5c-11.5 0-20.8-9.3-20.8-20.8s9.3-20.8 20.8-20.8 20.8 9.3 20.8 20.8-9.3 20.8-20.8 20.8zm0-31.2c-5.7 0-10.4 4.7-10.4 10.4s4.7 10.4 10.4 10.4 10.4-4.7 10.4-10.4-4.7-10.4-10.4-10.4zm-31.2 83.2h-31.2v-93.6h31.2c17.2 0 31.2 14 31.2 31.2s-14 31.2-31.2 31.2h-10.4v31.2zm0-52v-31.2h10.4c11.5 0 20.8 9.3 20.8 20.8s-9.3 20.8-20.8 20.8h-10.4zm93.6 52h-31.2v-93.6h31.2c17.2 0 31.2 14 31.2 31.2v31.2c0 17.2-14 31.2-31.2 31.2zm-10.4-10.4h10.4c11.5 0 20.8-9.3 20.8-20.8v-31.2c0-11.5-9.3-20.8-20.8-20.8h-10.4v72.8zm93.6 10.4h-52v-93.6h52v10.4h-41.6v31.2h31.2v10.4h-31.2v31.2h41.6v10.4z"/></svg>',
        audio: '<svg class="file-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#FF6B6B" d="M448 0H64C28.7 0 0 28.7 0 64v384c0 35.3 28.7 64 64 64h384c35.3 0 64-28.7 64-64V64c0-35.3-28.7-64-64-64z"/><path fill="#FFF" d="M352 128v256l-128-64v-128zm-192 64c-17.7 0-32 14.3-32 32v64c0 17.7 14.3 32 32 32s32-14.3 32-32v-64c0-17.7-14.3-32-32-32z"/></svg>',
        video: '<svg class="file-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#FF4757" d="M448 0H64C28.7 0 0 28.7 0 64v384c0 35.3 28.7 64 64 64h384c35.3 0 64-28.7 64-64V64c0-35.3-28.7-64-64-64z"/><path fill="#FFF" d="M208 352V160l144 96z"/></svg>',
        spreadsheet: '<svg class="file-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#1D6F42" d="M448 0H64C28.7 0 0 28.7 0 64v384c0 35.3 28.7 64 64 64h384c35.3 0 64-28.7 64-64V64c0-35.3-28.7-64-64-64z"/><path fill="#FFF" d="M128 160h96v64h-96zm0 96h96v64h-96zm0 96h96v64h-96zm128-192h96v64h-96zm0 96h96v64h-96zm0 96h96v64h-96z"/></svg>',
        document: '<svg class="file-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#4A90E2" d="M448 0H64C28.7 0 0 28.7 0 64v384c0 35.3 28.7 64 64 64h384c35.3 0 64-28.7 64-64V64c0-35.3-28.7-64-64-64z"/><path fill="#FFF" d="M128 128h256v32H128zm0 64h256v32H128zm0 64h256v32H128zm0 64h192v32H128z"/></svg>'
    };
    
    if (isImageFile(fileName)) return icons.image;
    if (isPDFFile(fileName)) return icons.pdf;
    if (isAudioFile(fileName)) return icons.audio;
    if (isVideoFile(fileName)) return icons.video;
    if (/\.csv$/i.test(fileName)) return icons.spreadsheet;
    return icons.document;
}

/**
 * Get human-readable file size
 */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Extracts embedded images from markdown text and resolves them to TFiles
 */
export function extractImagesFromMarkdown(app: App, content: string, sourcePath: string): TFile[] {
    const images: TFile[] = [];
    
    // Pattern for Obsidian wiki-links: ![[image.png]]
    const wikiRegex = /!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = wikiRegex.exec(content)) !== null) {
        const linkText = match[1];
        const file = app.metadataCache.getFirstLinkpathDest(linkText, sourcePath);
        if (file && isImageFile(file.name)) {
            images.push(file);
        }
    }
    
    // Pattern for standard markdown links: ![alt text](image.jpg)
    const mdRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
    while ((match = mdRegex.exec(content)) !== null) {
        const linkText = match[1];
        // Handle potential URL encoding in markdown links
        const decodedLink = decodeURIComponent(linkText);
        const file = app.metadataCache.getFirstLinkpathDest(decodedLink, sourcePath);
        if (file && isImageFile(file.name)) {
            images.push(file);
        }
    }
    
    // Remove duplicates
    return Array.from(new Set(images));
}

