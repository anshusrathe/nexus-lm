import type { FileOutlineNode } from '../types';
import { computeLineHash } from './hashReader';

interface HeadingMatch {
  level: number;
  text: string;
  lineNumber: number;
}

function findHeadings(lines: string[]): HeadingMatch[] {
  const headings: HeadingMatch[] = [];
  const headingRegex = /^(#{1,6})\s+(.+)$/;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headingRegex);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        lineNumber: i + 1,
      });
    }
  }
  return headings;
}

function findCodeBlockBoundaries(lines: string[]): Array<{ start: number; end: number }> {
  const fences: Array<{ start: number; end: number }> = [];
  let inBlock = false;
  let blockStart = 0;
  const fenceRegex = /^```/;
  for (let i = 0; i < lines.length; i++) {
    if (fenceRegex.test(lines[i])) {
      if (inBlock) {
        fences.push({ start: blockStart, end: i + 1 });
        inBlock = false;
      } else {
        blockStart = i + 1;
        inBlock = true;
      }
    }
  }
  return fences;
}

export function buildOutline(content: string, path: string): FileOutlineNode {
  const lines = content.split('\n');
  const headings = findHeadings(lines);
  const codeBlocks = findCodeBlockBoundaries(lines);

  const root: FileOutlineNode = {
    name: path,
    type: 'section',
    lineStart: 1,
    lineEnd: lines.length,
    hash: computeLineHash(1, content.substring(0, 200)),
    children: [],
    depth: 0,
  };

  const stack: FileOutlineNode[] = [root];

  for (const heading of headings) {
    const node: FileOutlineNode = {
      name: heading.text,
      type: 'heading',
      lineStart: heading.lineNumber,
      lineEnd: heading.lineNumber,
      hash: computeLineHash(heading.lineNumber, lines[heading.lineNumber - 1]),
      children: [],
      depth: heading.level,
    };

    while (stack.length > 1 && stack[stack.length - 1].depth >= heading.level) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    parent.children.push(node);
    stack.push(node);
  }

  for (let i = 0; i < headings.length; i++) {
    const current = headings[i];
    const next = headings[i + 1];
    if (next) {
      const node = findNodeByName(root, current.text, current.level);
      if (node) {
        node.lineEnd = next.lineNumber - 1;
      }
    } else {
      const node = findNodeByName(root, current.text, current.level);
      if (node) {
        node.lineEnd = lines.length;
      }
    }
  }

  return root;
}

function findNodeByName(
  node: FileOutlineNode,
  name: string,
  depth: number
): FileOutlineNode | null {
  if (node.name === name && node.depth === depth) return node;
  for (const child of node.children) {
    const found = findNodeByName(child, name, depth);
    if (found) return found;
  }
  return null;
}

export function expandOutline(
  node: FileOutlineNode,
  content: string,
  maxLines: number = 50
): string {
  const lines = content.split('\n');
  const start = Math.max(0, node.lineStart - 1);
  const end = Math.min(lines.length, start + maxLines);
  return lines.slice(start, end).join('\n');
}

export function formatOutline(outline: FileOutlineNode, indent: number = 0): string {
  const prefix = '  '.repeat(indent);
  const hashInfo = `#${outline.hash}`;
  const lineInfo = `${outline.lineStart}-${outline.lineEnd}`;
  let result = `${prefix}${outline.name} [${lineInfo}] (${hashInfo})\n`;
  for (const child of outline.children) {
    result += formatOutline(child, indent + 1);
  }
  return result;
}
