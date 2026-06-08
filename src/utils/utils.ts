export function stripMarkdown(markdown: string): string {
  // Remove bold, italics, strikethrough, highlights
  let stripped = markdown.replace(/\*\*|__|\*|_|~~|==/g, '');
  // Remove headings
  stripped = stripped.replace(/^\s*#{1,6}\s*.+$/gm, '');
  // Remove links (e.g., [text](url) or [[link]])
  stripped = stripped.replace(/\[\[(.*?)\]\]/g, '$1'); // Obsidian internal links
  stripped = stripped.replace(/\[(.*?)\]\((.*?)\)/g, '$1'); // Markdown links
  // Remove blockquotes
  stripped = stripped.replace(/^\s*>\s*.+$/gm, '');
  // Remove code blocks and inline code
  stripped = stripped.replace(/```[\s\S]*?```/g, '');
  stripped = stripped.replace(/`([^`]+)`/g, '$1');
  // Remove bullet points and numbered lists
  stripped = stripped.replace(/^\s*[\-*+]\s|^\s*\d+\.\s/gm, '');
  // Remove horizontal rules
  stripped = stripped.replace(/^-{3,}$|^\*{3,}$|^_{3,}$/gm, '');
  // Remove multiple newlines, replace with single newline
  stripped = stripped.replace(/\n{2,}/g, '\n');
  // Trim leading/trailing whitespace from each line
  stripped = stripped.split('\n').map(line => line.trim()).join('\n');
  return stripped.trim();
}

export function getDomain(url: string): string {
    try {
        const parsedUrl = new URL(url);
        return parsedUrl.hostname;
    } catch (e) {
        return '';
    }
}

export function getFaviconUrl(url: string): string {
    const domain = getDomain(url);
    if (!domain) return '';
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
}

// Image-to-text (OCR/captioning) backend processing utility
export async function extractTextFromImage(imageBase64: string): Promise<string> {
    // TODO: Integrate with real OCR/captioning backend (e.g., Google Vision, Azure, local model, etc.)
    // For now, return a placeholder
    return `Image text extracted (mock): [${imageBase64.slice(0, 40)}...]`;
} 