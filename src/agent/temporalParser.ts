export interface TemporalReference {
  raw: string;
  startMs: number;
  endMs: number;
  isRange: boolean;
}

export interface TemporalContext {
  references: TemporalReference[];
  earliestMs: number | null;
  latestMs: number | null;
  summary: string;
}

const TEMPORAL_PATTERNS: Array<{ regex: RegExp; resolve: (now: Date, match: RegExpExecArray | null) => { start: Date; end: Date } }> = [
  { regex: /\b(today|now)\b/gi, resolve: (now) => ({ start: startOfDay(now), end: now }) },
  { regex: /\b(yesterday)\b/gi, resolve: (now) => ({ start: startOfDay(addDays(now, -1)), end: endOfDay(addDays(now, -1)) }) },
  { regex: /\b(tomorrow)\b/gi, resolve: (now) => ({ start: startOfDay(addDays(now, 1)), end: endOfDay(addDays(now, 1)) }) },
  { regex: /\b(this\s+week)\b/gi, resolve: (now) => ({ start: startOfWeek(now), end: now }) },
  { regex: /\b(last\s+week)\b/gi, resolve: (now) => ({ start: startOfWeek(addDays(now, -7)), end: endOfWeek(addDays(now, -7)) }) },
  { regex: /\b(this\s+month)\b/gi, resolve: (now) => ({ start: startOfMonth(now), end: now }) },
  { regex: /\b(last\s+month)\b/gi, resolve: (now) => ({ start: startOfMonth(addMonths(now, -1)), end: endOfMonth(addMonths(now, -1)) }) },
  { regex: /\b(this\s+year)\b/gi, resolve: (now) => ({ start: startOfYear(now), end: now }) },
  { regex: /\b(recently|recent)\b/gi, resolve: (now) => ({ start: addDays(now, -7), end: now }) },
  { regex: /\b(past\s+(\d+)\s+days?)\b/gi, resolve: (now, match) => {
    const days = parseInt(match?.[2] ?? '7', 10);
    return { start: addDays(now, -days), end: now };
  }},
  { regex: /\b(last\s+(\d+)\s+days?)\b/gi, resolve: (now, match) => {
    const days = parseInt(match?.[2] ?? '7', 10);
    return { start: addDays(now, -days), end: now };
  }},
  { regex: /\b(past\s+(\d+)\s+weeks?)\b/gi, resolve: (now, match) => {
    const weeks = parseInt(match?.[2] ?? '2', 10);
    return { start: addDays(now, -weeks * 7), end: now };
  }},
  { regex: /\b(before\s+(\d{4}-\d{2}-\d{2}))\b/gi, resolve: (_now, match) => {
    const d = new Date(match![2] + 'T23:59:59');
    return { start: new Date(0), end: d };
  }},
  { regex: /\b(after\s+(\d{4}-\d{2}-\d{2}))\b/gi, resolve: (now, match) => {
    const d = new Date(match![2] + 'T00:00:00');
    return { start: d, end: now };
  }},
  { regex: /\b(between\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2}))\b/gi, resolve: (_now, match) => {
    return { start: new Date(match![2] + 'T00:00:00'), end: new Date(match![3] + 'T23:59:59') };
  }},
];

export function parseTemporal(text: string): TemporalContext {
  const now = new Date();
  const references: TemporalReference[] = [];
  const MAX_REFERENCES = 20;
  const MAX_TEXT_LENGTH = 2000;

  const truncated = text.length > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;

  for (const pattern of TEMPORAL_PATTERNS) {
    let match: RegExpExecArray | null;
    pattern.regex.lastIndex = 0;
    while ((match = pattern.regex.exec(truncated)) !== null) {
      const { start, end } = pattern.resolve(now, match);
      references.push({
        raw: match[0],
        startMs: start.getTime(),
        endMs: end.getTime(),
        isRange: start.getTime() !== end.getTime(),
      });
      if (references.length >= MAX_REFERENCES) break;
    }
    if (references.length >= MAX_REFERENCES) break;
  }

  if (references.length === 0) {
    return { references: [], earliestMs: null, latestMs: null, summary: '' };
  }

  let earliestMs = Infinity;
  let latestMs = -Infinity;
  for (const r of references) {
    if (r.startMs < earliestMs) earliestMs = r.startMs;
    if (r.endMs > latestMs) latestMs = r.endMs;
  }
  const daysSpan = Math.ceil((latestMs - earliestMs) / (1000 * 60 * 60 * 24));

  const summary = references.map(r => r.raw).join(', ')
    + ` (${daysSpan <= 1 ? 'same day' : `${daysSpan} day span`})`;

  return { references, earliestMs, latestMs, summary };
}

export function formatTemporalForMemory(ctx: TemporalContext): string {
  if (!ctx.summary) return '';
  const startStr = ctx.earliestMs !== null ? new Date(ctx.earliestMs).toISOString().split('T')[0] : '?';
  const endStr = ctx.latestMs !== null ? new Date(ctx.latestMs).toISOString().split('T')[0] : '?';
  return `Temporal filter: ${ctx.summary}. Focus on records between ${startStr} and ${endStr}.`;
}

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function endOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function startOfWeek(d: Date): Date {
  const r = new Date(d);
  const day = r.getDay();
  r.setDate(r.getDate() - day);
  r.setHours(0, 0, 0, 0);
  return r;
}

function endOfWeek(d: Date): Date {
  const r = startOfWeek(d);
  r.setDate(r.getDate() + 6);
  r.setHours(23, 59, 59, 999);
  return r;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
}

function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1);
}
