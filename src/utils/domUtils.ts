interface DetachedElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: { [key: string]: string | number | boolean | null };
  title?: string;
  parent?: Node;
  value?: string;
  type?: string;
  prepend?: boolean;
  placeholder?: string;
  href?: string;
}

/**
 * Creates an element without attaching it to the DOM, for later mounting.
 * Obsidian's createEl/createDiv/createSpan helpers always append their
 * result to the receiver, and appending to a Document throws
 * (HierarchyRequestError: "Only one element on document allowed"). The
 * element is therefore created on a temporary holder and detached again,
 * which matches the behavior of the native createElement call it replaces.
 */
export function createDetached<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  o?: DetachedElementInfo
): HTMLElementTagNameMap[K] {
  // eslint-disable-next-line obsidianmd/prefer-create-el -- Native createElement is required for the temporary holder: Obsidian's createEl helpers append to their receiver, and appending to a Document throws.
  const holder = doc.createElement('div');
  const el = tag === 'div' ? holder.createDiv(o) : tag === 'span' ? holder.createSpan(o) : holder.createEl(tag, o);
  holder.removeChild(el);
  return el as HTMLElementTagNameMap[K];
}

/**
 * Creates a detached SVG element in the SVG namespace. Obsidian's createSvg
 * helper is meant for building an <svg> element from an SVG path string and
 * appends to its receiver, so it cannot replace createElementNS for
 * arbitrary SVG tags.
 */
export function createSvgElement(doc: Document, tag: string): SVGElement {
  // eslint-disable-next-line obsidianmd/prefer-create-el -- SVG namespace elements can only be created with createElementNS; Obsidian's helpers append to the Document and throw.
  return doc.createElementNS('http://www.w3.org/2000/svg', tag);
}
