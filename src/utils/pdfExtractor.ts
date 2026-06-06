// This file will contain functionality for extracting text from PDF files using PDF.js.

import { TFile, Vault, Notice, Platform, App, Modal, Setting, ButtonComponent } from 'obsidian';
import { DirectorySuggester } from './directorySuggester';

// Assuming pdfjsLib is available globally or imported correctly via build process
// You might need to import it like this if your build process supports it:
// import * as pdfjsLib from 'pdfjs-dist';
// And set the worker source:
// pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/<version>/pdf.worker.min.js`;
// Or bundle the worker with your plugin's assets and set the path accordingly.
// For this code snippet, we'll assume pdfjsLib is accessible,
// likely attached to the global window object by your build setup if bundled correctly.

/**
 * Extracts text content from a PDF file using PDF.js.
 * Attempts to preserve basic formatting (lines, paragraphs, columns) using heuristics.
 * @param file The TFile object representing the PDF file in the Obsidian vault.
 * @param vault The Obsidian Vault object to read the file.
 * @returns A promise that resolves with the extracted text as a single string.
 */
export async function extractTextFromPdf(file: TFile, vault: Vault, opts?: { from?: number, to?: number }): Promise<string> {
  if (Platform.isMobile) {
    new Notice('PDF text extraction is not supported on mobile devices due to performance and compatibility issues.');
        return '';
  }
  try {
    // Read the PDF file as an ArrayBuffer using Obsidian's API
    const arrayBuffer = await vault.readBinary(file);

    // Load the PDF document using pdfjsLib (assuming it's accessible, e.g., on window)
    const pdfjsLib = (window as any).pdfjsLib; // Access from global scope if bundled this way

    if (!pdfjsLib) {
        throw new Error("PDF.js library not loaded. Ensure pdfjs-dist is installed and bundled correctly.");
    }

    // Set the worker source if not already set globally (Highly recommended for performance)
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
                  // As a temporary measure for development, you could use a CDN, but bundling is recommended for distribution:
         // pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
         // Note: Using a CDN in a released plugin requires careful consideration.
    }

    const pdfDocument = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    let fullText = '';
    const numPages = pdfDocument.numPages;
    let start = 1, end = numPages;
    if (opts && opts.from && opts.to) {
      start = Math.max(1, opts.from);
      end = Math.min(numPages, opts.to);
    }

    // Heuristic thresholds (values might need tuning based on typical PDF layouts)
    // PDF.js Y-coordinates increase upwards from the bottom-left.
    const LINE_THRESHOLD = 3; // Max vertical distance between baselines for items on the same visual line
    const PARAGRAPH_THRESHOLD_FACTOR = 1.8; // Factor of average line height to consider a paragraph break
    const MIN_GUTTER_PERCENT = 0.02; // Minimum horizontal gap for a potential column (e.g., 2% of page width)

    for (let i = start; i <= end; i++) {
      const page = await pdfDocument.getPage(i);
      const viewport = page.getViewport({ scale: 1.0 });
      const textContent = await page.getTextContent();

      // Filter out empty strings if they don't have a meaningful position/width
      const items = textContent.items.filter((item: any) => item.str.trim().length > 0 || item.width > 0);

      if (items.length === 0) {
          if (i < end) fullText += '\n\n---\n\n'; // Add separator even for empty pages
          continue;
      }

      // --- Step 1: Group items into approximate visual lines ---
      // Sort items by Y (descending, as Y increases upwards in PDF) to process from top to bottom
      items.sort((a: any, b: any) => b.transform[5] - a.transform[5]);

      const lines: any[][] = [];
      let currentLineItems: any[] = [];
      let currentLineY = -Infinity;

      // Estimate average line height for paragraph threshold calculation
      // This is a very rough estimate; a better way would analyze actual item heights or line spans.
      const avgItemHeight = items.reduce((sum: number, item: any) => sum + item.height, 0) / items.length;
      const PARAGRAPH_THRESHOLD = avgItemHeight * PARAGRAPH_THRESHOLD_FACTOR;


      for (const item of items) {
          const itemY = item.transform[5];

          if (currentLineItems.length === 0) {
              currentLineItems.push(item);
              currentLineY = itemY; // Reference Y for the current line
          } else {
              // Check vertical distance to the reference Y of the current line
              if (Math.abs(itemY - currentLineY) <= LINE_THRESHOLD) {
                  currentLineItems.push(item);
                  // Optionally update currentLineY to average/min/max of line items for better grouping
                  // For simplicity, we stick to the first item's Y or just check against a range.
                  // Let's update currentLineY to be the average of the line items processed so far for a slightly better centroid reference
                   currentLineY = currentLineItems.reduce((sum: number, item: any) => sum + item.transform[5], 0) / currentLineItems.length;

              } else {
                  // New line detected. Sort the finished line by X and add to lines.
                  currentLineItems.sort((a: any, b: any) => a.transform[4] - b.transform[4]);
                  lines.push(currentLineItems);

                  // Start a new line
                  currentLineItems = [item];
                  currentLineY = itemY;
              }
          }
      }
      // Add the last line
      if (currentLineItems.length > 0) {
          currentLineItems.sort((a: any, b: any) => a.transform[4] - b.transform[4]);
          lines.push(currentLineItems);
      }

      // Sort the lines themselves by their starting Y (descending)
      lines.sort((a, b) => b[0].transform[5] - a[0].transform[5]);


      // --- Step 2: Identify potential column boundaries (Simple X-gap method) ---
      let splitX: number | null = null;
      const xs = items.map((item: any) => item.transform[4]); // X coordinates
      xs.sort((a: number, b: number) => a - b);

      let maxGap = 0;
      let potentialSplitX = viewport.width / 2; // Default to middle if no clear gap

      for (let k = 1; k < xs.length; k++) {
          const gap = xs[k] - xs[k-1];
          // Consider a gap a potential column split if it's significant and not just space between words
          // A simple check: gap is wider than the width of several average characters?
          // Or use a percentage of page width as the example suggested:
          if (gap > maxGap && gap > viewport.width * MIN_GUTTER_PERCENT) {
              maxGap = gap;
              potentialSplitX = (xs[k] + xs[k-1]) / 2; // Midpoint of the gap
          }
      }

      // If a significant gap was found, set splitX
      if (maxGap > viewport.width * MIN_GUTTER_PERCENT) {
           splitX = potentialSplitX;
      }


      // --- Step 3 & 4: Process Lines and Build Page Text ---
      let pageText = '';
      let lastLineY = -Infinity; // Y position of the first item of the previously processed line

      for (const line of lines) {
          if (line.length === 0) continue;

          const currentLineY = line[0].transform[5]; // Y of the first item in the line

          // Add vertical spacing before the current line if it's not the very first line
          if (lastLineY !== -Infinity) {
              const vDist = lastLineY - currentLineY; // Vertical distance downwards

              if (vDist > PARAGRAPH_THRESHOLD) {
                  pageText += '\n\n'; // Add paragraph break
              } else if (vDist > LINE_THRESHOLD) {
                  pageText += '\n'; // Add line break
              }
               // Otherwise, vertical distance is small, assume part of the same text block visually
          }

          // Process horizontal content of this line
          let lineContent = '';
          if (splitX !== null) {
              // Process as multiple columns
              const leftItems = line.filter((item: any) => item.transform[4] < splitX);
              const rightItems = line.filter((item: any) => item.transform[4] >= splitX); // Items >= splitX go to right column

              const leftText = leftItems.map((item: any) => item.str).join(' ').trim();
              const rightText = rightItems.map((item: any) => item.str).join(' ').trim();

              lineContent += leftText;
              // Add space between columns if both have content on this line
              if (leftText.length > 0 && rightText.length > 0) {
                  lineContent += '   '; // Add significant horizontal space
              }
              lineContent += rightText;

          } else {
              // Process as a single column line
              lineContent = line.map((item: any) => item.str).join(' ').trim();
          }

          pageText += lineContent;

          // Update lastLineY
          lastLineY = currentLineY;
      }

      fullText += pageText + (i < end ? '\n\n---\n\n' : ''); // Add clear separator between pages
    }

    return fullText;

  } catch (error) {
        // Handle 'error' being of type 'unknown'
    let message = 'Unknown error';
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    }
    throw new Error(`Failed to extract text from PDF: ${message}`);
  }
}

/**
 * Modal for PDF extraction options (page range, directory)
 */
export class PdfExtractOptionsModal extends Modal {
  private numPages: number;
  private onSubmit: (opts: { from: number, to: number, full: boolean, directory: string }) => void;
  private fromPage: number;
  private toPage: number;
  private fullPdf: boolean = true;
  private directory: string;
  private errorEl: HTMLElement | null = null;
  private dirSuggester: DirectorySuggester | null = null;
  private pdfDocument: any;
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewContainer: HTMLElement | null = null;
  private currentPreviewPage: number = 1;
  private previewPageInfo: HTMLElement | null = null;
  private previewNavPrev: HTMLButtonElement | null = null;
  private previewNavNext: HTMLButtonElement | null = null;
  private tocContainer: HTMLElement | null = null;
  private fromInput: HTMLInputElement | null = null;
  private toInput: HTMLInputElement | null = null;

  constructor(app: App, numPages: number, defaultDir: string, pdfDocument: any, onSubmit: (opts: { from: number, to: number, full: boolean, directory: string }) => void) {
    super(app);
    this.numPages = numPages;
    this.onSubmit = onSubmit;
    this.fromPage = 1;
    this.toPage = numPages;
    this.directory = defaultDir;
    this.fullPdf = true;
    this.pdfDocument = pdfDocument;
    this.modalEl.addClass('pdf-extract-modal');
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
    // Create split layout container
    const splitContainer = contentEl.createDiv({ cls: 'pdf-extract-split-container' });
    
    // Left panel - controls
    const leftPanel = splitContainer.createDiv({ cls: 'pdf-extract-left-panel' });
    leftPanel.createEl('h2', { text: 'Extract Text from PDF' });

    // TOC Section (Moved to top)
    leftPanel.createEl('label', { text: 'Table of Contents:' });
    this.tocContainer = leftPanel.createDiv({ cls: 'pdf-extract-toc-container' });
    this.loadAndRenderOutline();

    // Page range row
    const rangeRow = leftPanel.createDiv({ cls: 'pdf-extract-range-row' });
    rangeRow.createEl('label', { text: 'Page Range:' });
    this.fromInput = rangeRow.createEl('input', { type: 'number', value: String(this.fromPage) });
    this.fromInput.min = '1';
    this.fromInput.max = String(this.numPages);
    rangeRow.createSpan({ text: ' to ' });
    this.toInput = rangeRow.createEl('input', { type: 'number', value: String(this.toPage) });
    this.toInput.min = '1';
    this.toInput.max = String(this.numPages);
    const fullBtn = rangeRow.createEl('button', { text: 'Full PDF', cls: 'mod-cta' });
    
    const updatePreview = () => {
      this.currentPreviewPage = this.fromPage;
      this.renderPreview();
    };
    
    fullBtn.onclick = () => {
      this.fullPdf = true;
      this.fromPage = 1;
      this.toPage = this.numPages;
      if (this.fromInput) this.fromInput.value = '1';
      if (this.toInput) this.toInput.value = String(this.numPages);
      this.clearError();
      updatePreview();
    };
    this.fromInput.oninput = () => {
      this.fullPdf = false;
      const val = Number(this.fromInput!.value);
      if (!isNaN(val) && val >= 1 && val <= this.numPages) {
        this.fromPage = val;
        updatePreview();
      }
      this.clearError();
    };
    this.toInput.oninput = () => {
      this.fullPdf = false;
      const val = Number(this.toInput!.value);
      if (!isNaN(val) && val >= 1 && val <= this.numPages) {
        this.toPage = val;
        // Removed aggressive fromPage adjustment to fix bug where typing in toInput changes fromInput
        updatePreview();
      }
      this.clearError();
    };

    // Page count info
    const pageCountInfo = leftPanel.createDiv({ cls: 'pdf-extract-page-count' });
    pageCountInfo.setText(`Total pages in PDF: ${this.numPages}`);

    // Directory row
    leftPanel.createEl('label', { text: 'Save to Directory:' });
    const dirContainer = leftPanel.createDiv();
    this.dirSuggester = new DirectorySuggester(this.app, dirContainer, (path) => {
      this.directory = path;
    }, this.directory);

    // Error message
    this.errorEl = leftPanel.createDiv({ cls: 'pdf-extract-error' });

    // Button row
    const btnRow = leftPanel.createDiv({ cls: 'modal-button-container' });
    new ButtonComponent(btnRow)
      .setButtonText('Cancel')
      .onClick(() => this.close());
    new ButtonComponent(btnRow)
      .setButtonText('Extract')
      .setCta()
      .onClick(() => {
        if (!this.validate()) return;
        this.onSubmit({
          from: this.fromPage,
          to: this.toPage,
          full: this.fullPdf,
          directory: this.directory
        });
        this.close();
      });

    // Right panel - preview
    const rightPanel = splitContainer.createDiv({ cls: 'pdf-extract-right-panel' });
    rightPanel.createEl('h3', { text: 'Preview' });
    
    // Preview navigation
    const previewNav = rightPanel.createDiv({ cls: 'pdf-preview-nav' });
    this.previewNavPrev = previewNav.createEl('button', { text: '◀ Previous' });
    this.previewPageInfo = previewNav.createEl('span', { cls: 'pdf-preview-page-info' });
    this.previewNavNext = previewNav.createEl('button', { text: 'Next ▶' });
    
    this.previewNavPrev.onclick = () => {
      if (this.currentPreviewPage > this.fromPage) {
        this.currentPreviewPage--;
        this.renderPreview();
      }
    };
    
    this.previewNavNext.onclick = () => {
      if (this.currentPreviewPage < this.toPage) {
        this.currentPreviewPage++;
        this.renderPreview();
      }
    };
    
    // Preview container with canvas
    this.previewContainer = rightPanel.createDiv({ cls: 'pdf-preview-container' });
    this.previewCanvas = this.previewContainer.createEl('canvas', { cls: 'pdf-preview-canvas' });
    
    // Initial render
    this.renderPreview();
  }

  private async renderPreview() {
    if (!this.previewCanvas || !this.pdfDocument || !this.previewContainer) return;
    
    // Validate current preview page is within selected range
    if (this.currentPreviewPage < this.fromPage) {
      this.currentPreviewPage = this.fromPage;
    }
    if (this.currentPreviewPage > this.toPage) {
      this.currentPreviewPage = this.toPage;
    }
    
    // Update page info
    const selectedCount = this.toPage - this.fromPage + 1;
    if (this.previewPageInfo) {
      this.previewPageInfo.setText(`Page ${this.currentPreviewPage} of ${this.numPages} (${selectedCount} selected)`);
    }
    
    // Update navigation buttons
    if (this.previewNavPrev) {
      this.previewNavPrev.disabled = this.currentPreviewPage <= this.fromPage;
    }
    if (this.previewNavNext) {
      this.previewNavNext.disabled = this.currentPreviewPage >= this.toPage;
    }
    
    try {
      const page = await this.pdfDocument.getPage(this.currentPreviewPage);
      
      // Calculate scale to fit preview container
      const containerWidth = this.previewContainer.clientWidth - 40; // Account for padding
      const viewport = page.getViewport({ scale: 1.0 });
      const scale = containerWidth / viewport.width;
      const scaledViewport = page.getViewport({ scale });
      
      // Set canvas dimensions
      this.previewCanvas.width = scaledViewport.width;
      this.previewCanvas.height = scaledViewport.height;
      
      // Render PDF page
      const context = this.previewCanvas.getContext('2d');
      if (context) {
        const renderContext = {
          canvasContext: context,
          viewport: scaledViewport
        };
        await page.render(renderContext).promise;
      }
    } catch (error) {
            if (this.previewPageInfo) {
        this.previewPageInfo.setText('Preview unavailable');
      }
    }
  }

  private async loadAndRenderOutline() {
    if (!this.tocContainer || !this.pdfDocument) return;
    
    this.tocContainer.empty();
    const loading = this.tocContainer.createDiv({ text: 'Loading outline...', cls: 'pdf-toc-loading' });
    
    try {
      const outline = await this.pdfDocument.getOutline();
      loading.remove();
      
      if (!outline || outline.length === 0) {
        this.tocContainer.createDiv({ text: 'No Table of Contents found.', cls: 'pdf-toc-empty' });
        return;
      }
      
      const listContainer = this.tocContainer.createEl('ul', { cls: 'pdf-toc-list' });
      await this.renderOutlineItems(outline, listContainer);
      
    } catch (error) {
            loading.setText('Failed to load Table of Contents.');
    }
  }

  private async renderOutlineItems(items: any[], parentEl: HTMLElement) {
    for (const item of items) {
      const li = parentEl.createEl('li', { cls: 'pdf-toc-item-wrapper' });
      
      let contentContainer: HTMLElement;
      let childrenContainer: HTMLElement | null = null;

      if (item.items && item.items.length > 0) {
        const details = li.createEl('details', { cls: 'pdf-toc-details' });
        contentContainer = details.createEl('summary', { cls: 'pdf-toc-summary' });
        childrenContainer = details.createEl('ul', { cls: 'pdf-toc-sublist' });
      } else {
        contentContainer = li.createDiv({ cls: 'pdf-toc-leaf' });
      }

      const itemEl = contentContainer.createDiv({ cls: 'pdf-toc-item' });
      itemEl.createSpan({ text: item.title, cls: 'pdf-toc-title' });

      // Resolve page number if possible
      let pageNum: number | null = null;
      try {
        if (item.dest) {
          const dest = typeof item.dest === 'string' 
            ? await this.pdfDocument.getDestination(item.dest) 
            : item.dest;
          
          if (dest && dest.length > 0) {
            const pageIndex = await this.pdfDocument.getPageIndex(dest[0]);
            pageNum = pageIndex + 1;
          }
        }
      } catch (e) {
        // Silently fail for individual items
      }

      if (pageNum !== null) {
        const pageSpan = itemEl.createSpan({ text: ` (p. ${pageNum})`, cls: 'pdf-toc-page' });
        itemEl.addClass('is-clickable');
        itemEl.onclick = (e) => {
          // Update preview
          this.currentPreviewPage = pageNum!;
          this.renderPreview();
          
          // Sync with page range
          this.fromPage = pageNum!;
          if (this.fromInput) {
            this.fromInput.value = String(this.fromPage);
          }
          this.fullPdf = false;
          
          // Highlight active item
          this.tocContainer?.querySelectorAll('.pdf-toc-item').forEach(el => el.removeClass('is-active'));
          itemEl.addClass('is-active');
          
          // If it's in a summary, stop propagation to avoid weird double triggers if any
          e.stopPropagation();
        };
      }

      if (childrenContainer && item.items && item.items.length > 0) {
        await this.renderOutlineItems(item.items, childrenContainer);
      }
    }
  }

  validate(): boolean {
    if (!this.fullPdf) {
      if (isNaN(this.fromPage) || isNaN(this.toPage) || this.fromPage < 1 || this.toPage > this.numPages || this.fromPage > this.toPage) {
        this.showError('Invalid page range.');
        return false;
      }
    }
    if (!this.directory || this.directory.trim() === '') {
      this.showError('Please select a directory.');
      return false;
    }
    this.clearError();
    return true;
  }
  showError(msg: string) {
    if (this.errorEl) this.errorEl.setText(msg);
  }
  clearError() {
    if (this.errorEl) this.errorEl.empty();
  }
  onClose() {
    this.contentEl.empty();
  }
}

// Note: Further work could potentially include:
// 1. More sophisticated column detection (e.g., analyzing vertical alignment of X positions across multiple lines).
// 2. Improved paragraph detection based on indentation, item density, or font styles.
// 3. Basic table detection by looking for grid-like patterns of text items and analyzing horizontal/vertical alignment.
// 4. Using font information (size, weight) from `item.fontName` and `item.height` to identify headings or other text types.
// 5. Implementing OCR for image-based PDFs (requires a separate OCR library, PDF.js alone won't do this).
// 6. Handling rotated text or complex text flows.
// 7. Ensuring robust handling of PDF.js worker source bundling and loading in the main plugin.
