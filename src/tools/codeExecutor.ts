/**
 * Code Executor for Nexus-LM
 * Handles in-plugin code execution and rendering for multiple languages.
 *
 * Execution (run + error-repair):  JavaScript, TypeScript, HTML, CSS, SVG, Python
 * Render-only (canvas preview):    Mermaid, Markdown, Dataview
 * Smart render:                    JSON (detects Vega-Lite / Chart.js schemas)
 */

export interface CodeExecutionResult {
    success: boolean;
    output: string;
    error?: string;
    language: string;
    /** Render as interactive HTML in an iframe */
    isHtml?: boolean;
    htmlContent?: string;
    /** Render via Obsidian's MarkdownRenderer */
    isMarkdown?: boolean;
    markdownContent?: string;
}

const EXECUTABLE_LANGS = new Set(['javascript', 'js', 'typescript', 'ts', 'html', 'css', 'svg']);
const RENDERABLE_LANGS  = new Set(['mermaid', 'markdown', 'md', 'json', 'dataview', 'dataviewjs']);

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function detectLanguage(preEl: HTMLElement): string {
    const codeEl = preEl.querySelector('code');
    if (!codeEl) return 'unknown';
    for (const cls of Array.from(codeEl.classList)) {
        if (cls.startsWith('language-')) return cls.replace('language-', '').toLowerCase();
    }
    return 'unknown';
}

export function isExecutable(language: string): boolean {
    return EXECUTABLE_LANGS.has(language.toLowerCase());
}

export function isRenderable(language: string): boolean {
    return RENDERABLE_LANGS.has(language.toLowerCase());
}

export function isEnhanceable(language: string): boolean {
    return isExecutable(language) || isRenderable(language);
}

export function wrapInMarkdownFence(code: string, language: string): string {
    return `\`\`\`${language}\n${code}\n\`\`\``;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function executeCode(code: string, language: string): Promise<CodeExecutionResult> {
    const lang = language.toLowerCase();
    if (lang === 'html')  return executeHtml(code);
    if (lang === 'css')   return executeCss(code);
    if (lang === 'svg')   return executeSvg(code);
    if (lang === 'json')  return executeJson(code);
    if (['javascript', 'js', 'typescript', 'ts'].includes(lang)) {
        const exec = (lang === 'typescript' || lang === 'ts') ? stripTypeAnnotations(code) : code;
        return executeJavaScript(exec);
    }
    if (['python', 'py'].includes(lang)) {
        return {
            success: false, output: '',
            error: "Python execution is not supported due to Obsidian security policies (dynamic script injection is blocked).",
            language: 'python'
        };
    }
    if (isRenderable(lang)) {
        return {
            success: true, output: '', language: lang,
            isMarkdown: true,
            markdownContent: wrapInMarkdownFence(code, lang === 'md' ? 'markdown' : lang),
        };
    }
    return {
        success: false, output: '',
        error: `"${language}" is not supported for in-plugin execution. Supported: JavaScript, TypeScript, HTML, CSS, Python.`,
        language,
    };
}

// ---------------------------------------------------------------------------
// JS / TS execution
// ---------------------------------------------------------------------------

async function executeJavaScript(code: string): Promise<CodeExecutionResult> {
    const logs: string[] = [];
    try {
        const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
        const result = await new AsyncFn(code)();
        if (result !== undefined)
            logs.push(`→ ${typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result)}`);
        return { success: true, output: logs.join('\n') || '(no output)', language: 'javascript' };
    } catch (err: SafeAny) {
        return { success: false, output: logs.join('\n'), error: err?.message || String(err), language: 'javascript' };
    }
}

// ---------------------------------------------------------------------------
// HTML / CSS execution
// ---------------------------------------------------------------------------

function executeHtml(code: string): CodeExecutionResult {
    return { success: true, output: '', language: 'html', isHtml: true, htmlContent: code };
}

function executeSvg(code: string): CodeExecutionResult {
    // Wrap bare SVG in a minimal HTML page so it renders in the iframe correctly.
    // If the code already starts with <!DOCTYPE or <html, pass through as-is.
    const trimmed = code.trim();
    const isFullHtml = /^<!DOCTYPE|^<html/i.test(trimmed);
    const html = isFullHtml ? trimmed : `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:8px;background:transparent;display:flex;align-items:flex-start;justify-content:center;}
svg{max-width:100%;height:auto;}</style>
</head><body>${trimmed}
<script>parent.postMessage({iframeHeight:document.body.scrollHeight},'*');</script>
</body></html>`;
    return { success: true, output: '', language: 'svg', isHtml: true, htmlContent: html };
}

function executeCss(code: string): CodeExecutionResult {
    const html = `<!DOCTYPE html><html><head><style>
body{font-family:sans-serif;padding:16px;}
${code}
</style></head><body>
<p class="preview-text">Paragraph text</p>
<div class="preview-box">Box element</div>
<button class="preview-btn">Button</button>
</body></html>`;
    return { success: true, output: '', language: 'css', isHtml: true, htmlContent: html };
}

// ---------------------------------------------------------------------------
// Python execution via Pyodide (REMOVED due to Obsidian security policy)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JSON smart rendering
// ---------------------------------------------------------------------------

type JsonVizType = 'vega-lite' | 'chartjs' | 'chartjs-simple' | 'card-list' | 'plain';

// Chart.js native types — any of these in obj.type triggers chartjs-simple
const CHARTJS_SIMPLE_TYPES = new Set([
    'bar','line','pie','doughnut','radar','polarArea','bubble','scatter','sparkline',
    'treemap','horizontalBar'
]);

function detectJsonVizType(obj: SafeAny): JsonVizType {
    if (!obj || typeof obj !== 'object') return 'plain';
    // Vega-Lite spec
    if (typeof obj.$schema === 'string' && obj.$schema.includes('vega-lite')) return 'vega-lite';
    // Full Chart.js spec: has type + data.datasets or data.labels
    if (obj.type && obj.data && (obj.data.datasets || obj.data.labels)) return 'chartjs';
    // Sparkline shorthand: { type:'sparkline', data:[numbers] }
    if (obj.type === 'sparkline' && Array.isArray(obj.data)
        && obj.data.every((v: SafeAny) => typeof v === 'number')) return 'chartjs-simple';
    // Simple chart: { type, title, data:[{label,value},...] } — any chart type
    if (obj.type && CHARTJS_SIMPLE_TYPES.has(obj.type) && Array.isArray(obj.data)
        && obj.data.length > 0 && typeof obj.data[0] === 'object'
        && 'label' in obj.data[0] && 'value' in obj.data[0]) return 'chartjs-simple';
    // Card list: { type:'auto'|'cards', title, data:[{...}] }
    if ((obj.type === 'auto' || obj.type === 'cards') && obj.title && Array.isArray(obj.data)
        && obj.data.length > 0 && typeof obj.data[0] === 'object') return 'card-list';
    return 'plain';
}

function buildVegaLiteHtml(spec: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/vega@5"></script>
<script src="https://cdn.jsdelivr.net/npm/vega-lite@5"></script>
<script src="https://cdn.jsdelivr.net/npm/vega-embed@6"></script>
<style>html,body{margin:0;padding:8px;background:transparent;}</style>
</head><body><div id="vis"></div>
<script>
vegaEmbed('#vis',${spec},{renderer:'svg',actions:false}).then(()=>{
  parent.postMessage({iframeHeight:document.body.scrollHeight},'*');
}).catch(() => {});
</script>
</body></html>`;
}

function buildChartJsHtml(spec: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>html,body{margin:0;padding:8px;background:transparent;}canvas{max-width:100%;display:block;}.error-text{color:red;padding:8px;}</style>
</head><body><canvas id="c"></canvas>
<script>
try{
  const chart=new Chart(document.getElementById('c'),${spec});
  setTimeout(()=>parent.postMessage({iframeHeight:document.body.scrollHeight},'*'),200);
}catch(e){const p=document.createElement('pre');p.className='error-text';p.textContent=e.message;document.body.empty();document.body.appendChild(p);
  parent.postMessage({iframeHeight:document.body.scrollHeight},'*');}
</script>
</body></html>`;
}

/** Convert simple {type, title, data:[{label,value}]} to a Chart.js spec and render */
function buildSimpleChartHtml(obj: SafeAny): string {
    // Map unsupported types to nearest Chart.js equivalent
    const typeMap: Record<string, string> = { treemap: 'pie', sparkline: 'line', horizontalBar: 'bar' };
    const rawType = (obj.type || 'bar').toLowerCase();
    const chartType = typeMap[rawType] ?? rawType;

    const PALETTE = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444','#14b8a6','#f97316','#84cc16'];

    let spec: SafeAny;
    if (rawType === 'sparkline') {
        // Sparkline: minimal line chart, no axes, no legend
        spec = {
            type: 'line',
            data: { labels: obj.data.map((_: SafeAny, i: number) => i + 1),
                    datasets: [{ label: obj.title || '', data: obj.data,
                        borderColor: PALETTE[0], backgroundColor: PALETTE[0] + '33',
                        fill: true, tension: 0.4, pointRadius: 2 }] },
            options: { responsive: true, plugins: { legend: { display: false },
                title: { display: !!obj.title, text: obj.title || '' } },
                scales: { x: { display: false }, y: { display: false } } }
        };
    } else {
        const labels = obj.data.map((d: SafeAny) => d.label);
        const values = obj.data.map((d: SafeAny) => d.value);
        const isCircular = ['pie','doughnut','polarArea'].includes(chartType);
        spec = {
            type: chartType,
            data: {
                labels,
                datasets: [{ label: obj.title || 'Value', data: values,
                    backgroundColor: isCircular ? PALETTE : PALETTE[0],
                    borderColor: isCircular ? PALETTE.map(c => c) : PALETTE[1],
                    borderWidth: 1 }]
            },
            options: { responsive: true,
                plugins: { legend: { position: 'bottom' },
                    title: { display: !!obj.title, text: obj.title || '' } },
                ...(chartType === 'bar' && obj.horizontal ? { indexAxis: 'y' } : {})
            }
        };
    }
    return buildChartJsHtml(JSON.stringify(spec));
}

/** Render a card list for {type:'auto'|'cards', title, data:[{key:val,...}]} */
function buildCardListHtml(obj: SafeAny): string {
    const keys = Object.keys(obj.data[0] || {});
    const [titleKey, ...descKeys] = keys;
    const cards = obj.data.map((item: SafeAny) => {
        const title = item[titleKey] || '';
        const desc = descKeys.map((k: string) => `<p style="margin:4px 0 0;font-size:0.85em;opacity:0.8">${item[k]}</p>`).join('');
        return `<div style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.2);border-radius:8px;padding:12px 16px;margin-bottom:8px">
            <strong style="font-size:0.95em">${title}</strong>${desc}</div>`;
    }).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:12px;font-family:sans-serif;color:inherit;background:transparent;}
h3{margin:0 0 12px;font-size:0.8em;opacity:0.6;text-transform:uppercase;letter-spacing:.08em}</style>
</head><body><h3>${obj.title || ''}</h3>${cards}
<script>parent.postMessage({iframeHeight:document.body.scrollHeight},'*');</script>
</body></html>`;
}

function executeJson(code: string): CodeExecutionResult {
    let parsed: SafeAny;
    try { parsed = JSON.parse(code); }
    catch (err: SafeAny) {
        return { success: false, output: '', error: `Invalid JSON: ${err?.message}`, language: 'json' };
    }
    const pretty = JSON.stringify(parsed, null, 2);
    const viz = detectJsonVizType(parsed);
    if (viz === 'vega-lite')      return { success: true, output: '', language: 'json', isHtml: true, htmlContent: buildVegaLiteHtml(pretty) };
    if (viz === 'chartjs')        return { success: true, output: '', language: 'json', isHtml: true, htmlContent: buildChartJsHtml(pretty) };
    if (viz === 'chartjs-simple') return { success: true, output: '', language: 'json', isHtml: true, htmlContent: buildSimpleChartHtml(parsed) };
    if (viz === 'card-list')      return { success: true, output: '', language: 'json', isHtml: true, htmlContent: buildCardListHtml(parsed) };
    // Plain JSON — pretty-print via MarkdownRenderer fenced block
    return { success: true, output: '', language: 'json', isMarkdown: true, markdownContent: '```json\n' + pretty + '\n```' };
}

// ---------------------------------------------------------------------------
// TypeScript type stripper (minimal)
// ---------------------------------------------------------------------------

function stripTypeAnnotations(code: string): string {
    return code
        .replace(/\binterface\s+\w+\s*\{[^}]*\}/gs, '')
        .replace(/\btype\s+\w+\s*=\s*[^;]+;/g, '')
        .replace(/:\s*[\w<>\[\]|&,\s]+(?=\s*[=,);{])/g, '')
        .replace(/\)\s*:\s*[\w<>\[\]|&,\s]+(?=\s*\{)/g, ')')
        .replace(/<[^>()]*>/g, '')
        .replace(/\bas\s+[\w<>\[\]|&,\s]+/g, '');
}
