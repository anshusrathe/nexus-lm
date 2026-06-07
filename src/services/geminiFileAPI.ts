import { App, TFile, Notice } from 'obsidian';
import { AISettings } from '../settings';
import { getMimeType, MultimodalInput } from '../utils/multimodalUtils';
import { requestUrl } from 'obsidian';

/**
 * Service for uploading large files to Gemini File API
 * Files larger than 20MB must be uploaded via File API instead of inline data
 * 
 * Note: This uses the native Web Fetch API with FormData for robust cross-platform upload support.
 */
export class GeminiFileAPIService {
    private app: App;
    private settings: AISettings;
    private uploadedFiles: Map<string, { uri: string; expiresAt: Date }> = new Map();
    private apiKey: string;

    constructor(app: App, settings: AISettings) {
        this.app = app;
        this.settings = settings;
        this.apiKey = settings.apiKey;
    }

    /**
     * Upload a file to Gemini File API using REST API
     * @param file The Obsidian TFile to upload
     * @returns The file URI and metadata, or null if upload failed
     */
    async uploadFile(file: TFile): Promise<{ uri: string; mimeType: string; fileName: string } | null> {
        if (!this.apiKey || this.settings.provider !== 'gemini') {
                        return null;
        }

        try {
            const mimeType = getMimeType(file.name);
            if (!mimeType) {
                                return null;
            }

            // Check if file was already uploaded and is still valid
            const cached = this.uploadedFiles.get(file.path);
            if (cached && cached.expiresAt > new Date()) {
                                return {
                    uri: cached.uri,
                    mimeType,
                    fileName: file.name
                };
            }

            // Read file as ArrayBuffer
            const arrayBuffer = await this.app.vault.readBinary(file);
            
                        new Notice(`Uploading ${file.name}...`);

            // Use native fetch with FormData as it automatically handles boundary and multipart encoding
            // This is 100% cross-platform (Electron and Mobile WebViews)
            const formData = new FormData();
            const blob = new Blob([arrayBuffer], { type: mimeType });
            
            // Step 1: Resumable upload or simple multipart
            // For simplicity and cross-platform reliability, we use simple multipart first
            // We need to wrap metadata and file in the same request or use headers
            
            // Simplified metadata as JSON string for the upload request
            const metadata = {
                file: {
                    display_name: file.name,
                }
            };
            
            formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            formData.append('file', blob);

            const response = await fetch(
                `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${this.apiKey}`,
                {
                    method: 'POST',
                    body: formData
                }
            );

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error?.message || `Upload failed with status ${response.status}`);
            }

            const data = await response.json();
            const fileUri = data.file.uri;
            
                        new Notice(`${file.name} uploaded successfully`);

            // Cache the upload (files are stored for 48 hours on Gemini)
            const expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + 47); // Set to 47 hours to be safe
            
            this.uploadedFiles.set(file.path, {
                uri: fileUri,
                expiresAt
            });

            return {
                uri: fileUri,
                mimeType,
                fileName: file.name
            };

        } catch (error: unknown) {
            const err = error as { message?: string };
            new Notice(`Failed to upload ${file.name}: ${err.message || 'Unknown error'}`);
            return null;
        }
    }

    /**
     * Upload multiple files in batch
     * @param files Array of TFiles to upload
     * @returns Array of successfully uploaded file data
     */
    async uploadFiles(files: TFile[]): Promise<Array<{ uri: string; mimeType: string; fileName: string }>> {
        const results: Array<{ uri: string; mimeType: string; fileName: string }> = [];
        
        for (const file of files) {
            const result = await this.uploadFile(file);
            if (result) {
                results.push(result);
            }
        }
        
        return results;
    }

    /**
     * Get metadata for an uploaded file using REST API
     * @param fileUri The URI of the uploaded file
     */
    async getFileMetadata(fileUri: string): Promise<any> {
        if (!this.apiKey) {
                        return null;
        }

        try {
            // Extract file name from URI (format: files/{fileId})
            const fileId = fileUri.split('/').pop();
            if (!fileId) return null;
            
            const response = await requestUrl({
                url: `https://generativelanguage.googleapis.com/v1beta/files/${fileId}?key=${this.apiKey}`
            });
            
            return response.json;
        } catch (error) {
                        return null;
        }
    }

    /**
     * Delete an uploaded file from Gemini servers using REST API
     * @param fileUri The URI of the file to delete
     */
    async deleteFile(fileUri: string): Promise<boolean> {
        if (!this.apiKey) {
                        return false;
        }

        try {
            const fileId = fileUri.split('/').pop();
            if (!fileId) return false;
            
            await requestUrl({
                url: `https://generativelanguage.googleapis.com/v1beta/files/${fileId}?key=${this.apiKey}`,
                method: 'DELETE'
            });
            
                        
            // Remove from cache
            for (const [path, data] of this.uploadedFiles.entries()) {
                if (data.uri === fileUri) {
                    this.uploadedFiles.delete(path);
                    break;
                }
            }
            
            return true;
        } catch (error) {
                        return false;
        }
    }

    /**
     * Clear cached upload data
     */
    clearCache() {
        this.uploadedFiles.clear();
    }

    /**
     * Process multimodal inputs that need File API upload
     * @param multimodalInputs Array of multimodal inputs
     * @returns Updated array with File API URIs
     */
    async processLargeFiles(multimodalInputs: MultimodalInput[]): Promise<MultimodalInput[]> {
        const processed: MultimodalInput[] = [];
        
        for (const input of multimodalInputs) {
            // If it needs File API upload but doesn't have a URI yet
            if (input.type === 'fileUri' && !input.uri) {
                // Get the file from vault
                let file = null;
                if (input.filePath) {
                    file = this.app.vault.getFileByPath(input.filePath);
                } else {
                    // Fallback to searching by name if path is missing (deprecated behavior)
                    file = this.app.vault.getFiles().find(f => f.name === input.fileName);
                }

                if (file) {
                    const uploadResult = await this.uploadFile(file);
                    if (uploadResult) {
                        processed.push({
                            ...input,
                            uri: uploadResult.uri
                        });
                    }
                }
            } else {
                // Keep as is (inline data or already uploaded)
                processed.push(input);
            }
        }
        
        return processed;
    }
}
