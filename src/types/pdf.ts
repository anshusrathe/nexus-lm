export interface PdfjsLib {
    getDocument(data: { data: ArrayBuffer }): { promise: Promise<PdfDocumentProxy> };
    GlobalWorkerOptions: { workerSrc: string };
}

export interface PdfDocumentProxy {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfPageProxy>;
    getOutline(): Promise<PdfOutlineItem[] | null>;
    getDestination(destString: string): Promise<(PdfPageProxy | number)[]>;
    getPageIndex(ref: { num: number; gen: number }): Promise<number>;
}

export interface PdfPageProxy {
    getViewport(params: { scale: number }): { width: number; height: number };
    getTextContent(): Promise<{ items: PdfTextItem[] }>;
    render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
}

export interface PdfTextItem {
    str: string;
    transform: number[];
    width: number;
    height: number;
    fontName: string;
}

export interface PdfOutlineItem {
    title: string;
    dest?: string | unknown[];
    items: PdfOutlineItem[];
}
