// Small dependency-free helpers shared by content scripts, the service worker and extension pages.

/** 32-bit FNV-1a hash of a string (UTF-16 code units). */
export function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hashHex(str: string): string {
  return fnv1a(str).toString(16).padStart(8, '0') + fnv1a(str, 0x01000193).toString(16).padStart(8, '0');
}

const CJK_RE = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿]/g;

/**
 * Rough token estimate that works for mixed Korean/Japanese/English text without a tokenizer:
 * CJK characters count ~1 token each, other characters ~4 per token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

export function hangulRatio(text: string): number {
  let letters = 0;
  let hangul = 0;
  for (let i = 0; i < text.length && letters < 20000; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x3130 && c <= 0x318f)) {
      hangul++;
      letters++;
    } else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      letters++;
    }
  }
  return letters ? hangul / letters : 0;
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${formatDate(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Accepts epoch seconds, epoch milliseconds or ISO strings; returns epoch ms. */
export function toEpochMs(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    if (/^\d+(\.\d+)?$/.test(value)) return toEpochMs(Number(value));
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

const RESERVED = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * Builds a safe download filename (tech doc §22.2 `tu`): removes reserved characters,
 * collapses whitespace to hyphens and limits the stem to ~150 characters.
 */
export function safeFilename(stem: string, ext: string, fallback = 'conversation'): string {
  let s = (stem || '').normalize('NFC').replace(RESERVED, '').replace(/\s+/g, '-');
  s = s.replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!s) s = fallback;
  if (s.length > 150) s = s.slice(0, 150).replace(/-+$/, '');
  return `${s}.${ext}`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeXml(text: string): string {
  // Strip characters that are illegal in XML 1.0 before escaping.
   
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
  return clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function uid(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Runs async tasks with a concurrency limit, preserving result order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function mimeToExt(mime: string | undefined, fallback = 'bin'): string {
  if (!mime) return fallback;
  const m = mime.toLowerCase().split(';')[0].trim();
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/avif': 'avif',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'application/json': 'json',
    'application/zip': 'zip',
  };
  return map[m] ?? fallback;
}

/** Detects common image formats from magic bytes. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45)
    return 'image/webp';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(256, bytes.length)));
  if (/<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return undefined;
}

/** Reads pixel dimensions from PNG / JPEG / GIF / WebP headers without decoding. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const mime = sniffImageMime(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (mime === 'image/png') return { width: dv.getUint32(16), height: dv.getUint32(20) };
    if (mime === 'image/gif') return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    if (mime === 'image/webp') {
      const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
      if (chunk === 'VP8X') {
        const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return { width: w, height: h };
      }
      if (chunk === 'VP8L') {
        const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
        return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
      }
      if (chunk === 'VP8 ') return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    }
    if (mime === 'image/jpeg') {
      let off = 2;
      while (off < bytes.length) {
        if (bytes[off] !== 0xff) return undefined;
        const marker = bytes[off + 1];
        const len = dv.getUint16(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: dv.getUint16(off + 5), width: dv.getUint16(off + 7) };
        }
        off += 2 + len;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
