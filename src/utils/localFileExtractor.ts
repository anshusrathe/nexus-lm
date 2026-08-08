import { App, TFile, Notice } from 'obsidian';
import { extractTextFromPdf } from './pdfExtractor';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { isTextFile } from './multimodalUtils';

function getMammoth(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('mammoth');
  } catch (err) {
    console.warn('[NexusLM] mammoth module could not be loaded:', err);
    return null;
  }
}

export const SUPPORTED_EXTRACTABLE_EXTENSIONS = ['md', 'txt', 'csv', 'json', 'pdf', 'docx', 'xlsx', 'pptx'];

/**
 * Extracts raw text from a variety of file formats locally.
 * This completely bypasses third-party APIs to keep it cost-free.
 */
export async function extractTextFromFile(app: App, file: TFile): Promise<string> {
  const ext = file.extension.toLowerCase();

  try {
    // 1. Text-based files
    if (isTextFile(file.name)) {
      return await app.vault.read(file);
    }

    // 2. PDFs
    if (ext === 'pdf') {
      return await extractTextFromPdf(file, app.vault);
    }

    // 3. Word Documents (DOCX)
    if (ext === 'docx') {
      const mammothLib = getMammoth();
      if (!mammothLib) {
        return '[DOCX text extraction unavailable: mammoth library is not loaded.]';
      }
      const arrayBuffer = await app.vault.readBinary(file);
      const result = await mammothLib.extractRawText({ arrayBuffer });
      return result.value;
    }

    // 4. Excel Spreadsheets (XLSX)
    if (ext === 'xlsx' || ext === 'xls') {
      const arrayBuffer = await app.vault.readBinary(file);
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      let text = '';
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        text += `--- Sheet: ${sheetName} ---\n${csv}\n\n`;
      }
      return text.trim();
    }

    // 5. PowerPoint Presentations (PPTX)
    if (ext === 'pptx') {
      const arrayBuffer = await app.vault.readBinary(file);
      const zip = new JSZip();
      await zip.loadAsync(arrayBuffer);
      let text = '';
      const slideRegex = /^ppt\/slides\/slide\d+\.xml$/;
      const slideFiles = Object.keys(zip.files).filter(name => slideRegex.test(name));
      
      // Sort slides by number
      slideFiles.sort((a, b) => {
        const numA = parseInt(a.replace(/[^\d]/g, ''), 10);
        const numB = parseInt(b.replace(/[^\d]/g, ''), 10);
        return numA - numB;
      });

      for (const slideFile of slideFiles) {
        const content = await zip.files[slideFile].async('string');
        // Simple regex to extract text inside <a:t> tags
        const matches = content.match(/<a:t>([\s\S]*?)<\/a:t>/g);
        if (matches) {
          const slideText = matches.map(m => m.replace(/<\/?a:t>/g, '')).join(' ');
          text += `--- Slide ${slideFile.replace(/[^\d]/g, '')} ---\n${slideText}\n\n`;
        }
      }
      return text.trim();
    }

    // Fallback for unsupported binary files
    return `[Unsupported file type for text extraction: ${file.name}]`;
  } catch (error) {
    console.error(`Failed to extract text from ${file.name}:`, error);
    return `[Failed to extract text from ${file.name}. Ensure the file is not corrupted.]`;
  }
}

/**
 * Checks if a file is supported for local text extraction.
 */
export function isExtractable(fileName: string): boolean {
  if (isTextFile(fileName)) return true;
  const ext = fileName.split('.').pop()?.toLowerCase();
  return ext ? ['pdf', 'docx', 'xlsx', 'xls', 'pptx'].includes(ext) : false;
}
