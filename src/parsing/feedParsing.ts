import { Notice, requestUrl } from 'obsidian';

/**
 * Interface for parsed feed entry data.
 */
export interface ParsedFeedEntry {
    title?: string;
    link?: string;
    pubDate?: string;
    author?: string;
    content?: string;
    contentSnippet?: string;
    thumbnail?: string;
    feedName?: string;
}

/**
 * Interface for the overall parsed feed structure.
 */
export interface ParsedFeed {
    title?: string;
    description?: string;
    link?: string;
    entries: ParsedFeedEntry[];
}

/**
 * Helper to safely extract elements ignoring XML namespace headaches in WebKit.
 * Mobile WebKit (Safari) strictly isolates namespaces in text/xml documents,
 * meaning standard getElementsByTagName frequently fails for tags like <media:thumbnail>.
 */
function getFirstElement(parent: Element | Document, tagNames: string[]): Element | undefined {
    const lowerTags = tagNames.map(t => t.toLowerCase());
    
    // Quick fast-path for standard tags
    for (const tag of tagNames) {
        const els = parent.getElementsByTagName(tag);
        if (els.length > 0) return els[0];
    }

    // Bulletproof fallback for Safari/Mobile WebKit namespaces
    const all = parent.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const ln = el.localName?.toLowerCase();
        const nn = el.nodeName?.toLowerCase();
        if ((ln && lowerTags.includes(ln)) || (nn && lowerTags.includes(nn))) {
            return el;
        }
    }
    return undefined;
}

/**
 * Helper to get all elements matching tag names, ignoring namespaces.
 */
function getAllElements(parent: Element | Document, tagNames: string[]): Element[] {
    const lowerTags = tagNames.map(t => t.toLowerCase());
    const result: Element[] = [];
    
    const all = parent.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const ln = el.localName?.toLowerCase();
        const nn = el.nodeName?.toLowerCase();
        if ((ln && lowerTags.includes(ln)) || (nn && lowerTags.includes(nn))) {
            result.push(el);
        }
    }
    return result;
}

/**
 * Robustly get text content from an element.
 */
function getElementText(parent: Element | Document, tagNames: string[]): string | undefined {
    const el = getFirstElement(parent, tagNames);
    return el?.textContent?.trim() || undefined;
}

/**
 * Helper to strip HTML tags and return plain text.
 */
function stripHtml(html: string): string {
    if (!html) return "";
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return doc.body.textContent || "";
    } catch (e) {
        return html.replace(/<[^>]*>/g, '');
    }
}

/**
 * Fetches and parses an RSS or Atom feed from a given URL.
 * Uses native DOMParser with robust namespace crawling for 100% cross-platform compatibility.
 */
export async function parseFeed(url: string, name: string = ''): Promise<ParsedFeed | null> {
    try {
        // Add robust headers to bypass mobile WAF blocks and ensure XML response
        const response = await requestUrl({ 
            url: url,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/rss+xml, application/rdf+xml, application/atom+xml, application/xml, text/xml, */*'
            }
        });
        
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(response.text, "text/xml");

        // Check for severe parsing errors
        const errorNode = xmlDoc.getElementsByTagName("parsererror")[0];
        if (errorNode) {
                        throw new Error("Invalid XML format");
        }

        const feed: ParsedFeed = {
            title: getElementText(xmlDoc, ['title']),
            description: getElementText(xmlDoc, ['description', 'subtitle']),
            link: getElementText(xmlDoc, ['link']),
            entries: []
        };

        // If link is a tag with href (Atom format fallback)
        if (!feed.link) {
            const linkEl = getFirstElement(xmlDoc, ['link']);
            if (linkEl) feed.link = linkEl.getAttribute('href') || undefined;
        }

        // Bulletproof item extraction bypassing all WebKit namespace issues
        const items = getAllElements(xmlDoc, ['item', 'entry']);

        feed.entries = items.map(item => {
            // --- Title & Link ---
            let title = getElementText(item, ['title']);
            let link = getElementText(item, ['link']);
            if (!link) {
                const linkEl = getFirstElement(item, ['link']);
                if (linkEl) link = linkEl.getAttribute('href') || undefined;
            }

            // --- Date ---
            const pubDate = getElementText(item, ['pubDate', 'published', 'updated', 'dc:date']);

            // --- Author ---
            const author = getElementText(item, ['dc:creator', 'creator', 'itunes:author', 'author']);

            // --- Content ---
            const content = getElementText(item, ['content:encoded', 'content', 'description', 'summary']);
            const contentSnippet = content ? stripHtml(content).substring(0, 200) : undefined;

            // --- Thumbnail Finding Logic ---
            let thumbnailUrl: string | undefined;

            // 1. YouTube Specific
            const videoId = getElementText(item, ['yt:videoId', 'videoid']);
            if (videoId) {
                thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
            } else if (link && (link.includes('youtube.com/watch?v=') || link.includes('youtu.be/'))) {
                const match = link.match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
                if (match && match[1]) {
                    thumbnailUrl = `https://img.youtube.com/vi/${match[1]}/hqdefault.jpg`;
                }
            }

            // 2. Media Tags (Namespaced)
            if (!thumbnailUrl) {
                const mediaThumb = getFirstElement(item, ['media:thumbnail', 'thumbnail']);
                if (mediaThumb) thumbnailUrl = mediaThumb.getAttribute('url') || undefined;

                if (!thumbnailUrl) {
                    const mediaContents = getAllElements(item, ['media:content']);
                    for (const mc of mediaContents) {
                        const type = mc.getAttribute('type');
                        const url = mc.getAttribute('url');
                        if (url && (!type || type.startsWith('image/'))) {
                            thumbnailUrl = url;
                            break;
                        }
                    }
                }
            }

            // 3. Enclosure
            if (!thumbnailUrl) {
                const enclosures = getAllElements(item, ['enclosure']);
                for (const enc of enclosures) {
                    const type = enc.getAttribute('type');
                    const url = enc.getAttribute('url');
                    if (url && (!type || type.startsWith('image/') || type === 'application/octet-stream')) {
                        thumbnailUrl = url;
                        break;
                    }
                }
            }

            // 4. iTunes Image
            if (!thumbnailUrl) {
                const itunesImage = getFirstElement(item, ['itunes:image']);
                if (itunesImage) thumbnailUrl = itunesImage.getAttribute('href') || undefined;
            }

            // 5. Generic Image tag
            if (!thumbnailUrl) {
                const img = getFirstElement(item, ['image']);
                if (img) thumbnailUrl = img.getAttribute('url') || img.textContent?.trim() || undefined;
            }

            // --- Validation ---
            if (thumbnailUrl && !thumbnailUrl.match(/^https?:\/\//i)) {
                thumbnailUrl = undefined;
            }

            return {
                title,
                link,
                pubDate,
                author,
                content,
                contentSnippet,
                thumbnail: thumbnailUrl,
                feedName: name
            };
        });

        return feed;

    } catch (error) {
                let errorMessage = `Failed to fetch or parse feed from "${url}".`;
        if (error instanceof Error) errorMessage += ` Error: ${error.message}`;
        new Notice(errorMessage, 6000);
        return null;
    }
}
