// Lab-only stand-in for src/shared/i18n.ts: the lab never shows UI, and Markdown labels do not
// affect what the algorithms select. Keeps the browser bundle small.
export type Locale = 'ko' | 'en';
export type MessageKey = string;
export const t = (_locale: Locale, key: string, params?: Record<string, string | number>): string =>
  params ? `${key} ${Object.values(params).join(' ')}` : key;
export const detectLocale = (): Locale => 'ko';
export const formatBytes = (n: number): string => `${n} B`;
export const formatMs = (ms: number | undefined): string => `${Math.round(ms ?? 0)} ms`;
