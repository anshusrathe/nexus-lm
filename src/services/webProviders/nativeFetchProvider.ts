import { requestUrl } from 'obsidian';

export class NativeFetchProvider {
  private userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

  async fetchUrl(url: string): Promise<{ title: string; content: string }> {
    const response = await requestUrl({
      url,
      method: 'GET',
      headers: {
        'User-Agent': this.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      throw: false,
    });

    if (response.status >= 400) {
      throw new Error(`HTTP status ${response.status} when fetching ${url}`);
    }

    const contentType = (
      response.headers['content-type'] ||
      response.headers['Content-Type'] ||
      ''
    ).toLowerCase();

    const bodyText = response.text || '';

    if (
      contentType.includes('text/plain') ||
      contentType.includes('text/markdown') ||
      url.endsWith('.md') ||
      url.endsWith('.txt')
    ) {
      return {
        title: this.extractTitleFromUrl(url),
        content: bodyText.trim(),
      };
    }

    if (contentType.includes('application/json') || url.endsWith('.json')) {
      return {
        title: this.extractTitleFromUrl(url),
        content: '```json\n' + bodyText.trim() + '\n```',
      };
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(bodyText, 'text/html');

    const title =
      doc.querySelector('title')?.textContent?.trim() ||
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ||
      doc.querySelector('h1')?.textContent?.trim() ||
      this.extractTitleFromUrl(url);

    const selectorsToRemove = [
      'script',
      'style',
      'noscript',
      'iframe',
      'svg',
      'canvas',
      'header',
      'footer',
      'nav',
      'aside',
      'form',
      '.ad',
      '.ads',
      '.advertisement',
      '.sidebar',
      '#cookie-banner',
      '#cookie-notice',
      '.comments',
      '#comments',
    ];

    for (const selector of selectorsToRemove) {
      doc.querySelectorAll(selector).forEach((el) => el.remove());
    }

    const mainContainer =
      doc.querySelector('article') ||
      doc.querySelector('main') ||
      doc.querySelector('#content') ||
      doc.querySelector('.content') ||
      doc.body;

    const rawMarkdown = this.elementToMarkdown(mainContainer || doc.body);
    const cleanedContent = this.cleanMarkdown(rawMarkdown);

    if (!cleanedContent || cleanedContent.length < 20) {
      throw new Error('Native fetch yielded insufficient content');
    }

    return {
      title,
      content: cleanedContent,
    };
  }

  private extractTitleFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
      return path.replace(/[-_]/g, ' ');
    } catch {
      return url;
    }
  }

  private elementToMarkdown(element: Node): string {
    let result = '';

    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        result += child.textContent || '';
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement;
        const tagName = el.tagName.toLowerCase();

        switch (tagName) {
          case 'h1':
            result += `\n\n# ${this.elementToMarkdown(el).trim()}\n\n`;
            break;
          case 'h2':
            result += `\n\n## ${this.elementToMarkdown(el).trim()}\n\n`;
            break;
          case 'h3':
            result += `\n\n### ${this.elementToMarkdown(el).trim()}\n\n`;
            break;
          case 'h4':
            result += `\n\n#### ${this.elementToMarkdown(el).trim()}\n\n`;
            break;
          case 'h5':
            result += `\n\n##### ${this.elementToMarkdown(el).trim()}\n\n`;
            break;
          case 'h6':
            result += `\n\n###### ${this.elementToMarkdown(el).trim()}\n\n`;
            break;
          case 'p':
            result += `\n\n${this.elementToMarkdown(el).trim()}\n\n`;
            break;
          case 'br':
            result += '\n';
            break;
          case 'strong':
          case 'b':
            result += ` **${this.elementToMarkdown(el).trim()}** `;
            break;
          case 'em':
          case 'i':
            result += ` *${this.elementToMarkdown(el).trim()}* `;
            break;
          case 'code':
            if (el.parentElement?.tagName.toLowerCase() === 'pre') {
              result += this.elementToMarkdown(el);
            } else {
              result += ` \`${this.elementToMarkdown(el).trim()}\` `;
            }
            break;
          case 'pre':
            result += `\n\n\`\`\`\n${el.textContent?.trim() || ''}\n\`\`\`\n\n`;
            break;
          case 'blockquote':
            result += `\n\n> ${this.elementToMarkdown(el).trim().replace(/\n/g, '\n> ')}\n\n`;
            break;
          case 'ul':
            result += `\n\n${this.parseList(el, false)}\n\n`;
            break;
          case 'ol':
            result += `\n\n${this.parseList(el, true)}\n\n`;
            break;
          case 'a': {
            const href = el.getAttribute('href');
            const linkText = this.elementToMarkdown(el).trim();
            if (href && linkText && !href.startsWith('javascript:')) {
              result += `[${linkText}](${href})`;
            } else {
              result += linkText;
            }
            break;
          }
          case 'img': {
            const alt = el.getAttribute('alt') || 'image';
            const src = el.getAttribute('src');
            if (src) {
              result += `![${alt}](${src})`;
            }
            break;
          }
          case 'hr':
            result += '\n\n---\n\n';
            break;
          case 'table':
            result += `\n\n${this.parseTable(el)}\n\n`;
            break;
          case 'div':
          case 'section':
          case 'article':
          case 'main':
          case 'span':
          default:
            result += this.elementToMarkdown(el);
            break;
        }
      }
    }

    return result;
  }

  private parseList(listEl: HTMLElement, isOrdered: boolean): string {
    const items = Array.from(listEl.children).filter((c) => c.tagName.toLowerCase() === 'li');
    return items
      .map((li, index) => {
        const prefix = isOrdered ? `${index + 1}. ` : '- ';
        const content = this.elementToMarkdown(li).trim().replace(/\n+/g, ' ');
        return `${prefix}${content}`;
      })
      .join('\n');
  }

  private parseTable(tableEl: HTMLElement): string {
    const rows = Array.from(tableEl.querySelectorAll('tr'));
    if (rows.length === 0) return '';

    const tableData: string[][] = [];
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('th, td')).map((cell) =>
        this.elementToMarkdown(cell).trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|')
      );
      if (cells.length > 0) {
        tableData.push(cells);
      }
    }

    if (tableData.length === 0) return '';

    const header = tableData[0];
    const divider = header.map(() => '---');
    const bodyRows = tableData.slice(1);

    let markdown = `| ${header.join(' | ')} |\n| ${divider.join(' | ')} |`;
    for (const row of bodyRows) {
      markdown += `\n| ${row.join(' | ')} |`;
    }

    return markdown;
  }

  private cleanMarkdown(md: string): string {
    return md
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}
