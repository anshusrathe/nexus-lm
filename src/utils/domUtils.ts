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
 * element is therefore created on a temporary detached document's body and
 * removed again, which matches the behavior of a native createElement call.
 */
export function createDetached<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  o?: DetachedElementInfo
): HTMLElementTagNameMap[K] {
  const holder = doc.implementation.createHTMLDocument().body;
  const el = tag === 'div' ? holder.createDiv(o) : tag === 'span' ? holder.createSpan(o) : holder.createEl(tag, o);
  holder.removeChild(el);
  return el as HTMLElementTagNameMap[K];
}

/**
 * Creates a detached SVG element in the SVG namespace. The element is
 * created on a temporary detached document's body (which never enters the
 * active DOM) and removed again, so the result can be mounted later.
 */
export function createSvgElement(doc: Document, tag: string): SVGElement {
  const holder = doc.implementation.createHTMLDocument().body;
  const el = holder.createSvg(tag as keyof SVGElementTagNameMap);
  holder.removeChild(el);
  return el;
}
