// Image bookkeeping shared by exporters. Exporters receive already-fetched bytes through an
// ImageStore; conversion of formats Word/Hangul cannot embed (WebP, AVIF, SVG) happens in the
// offscreen document before exporters run, so exporters stay pure and testable in Node.

import type { Conversation, ExportContent } from '../shared/types';
import { imageSize, sniffImageMime } from '../shared/util';
import { inlineImageUrls } from './md-parse';
import type { AssetRequest } from '../shared/messages';

export interface StoredImage {
  bytes: Uint8Array;
  mime: string;
  width?: number;
  height?: number;
}

export type ImageStore = Map<string, StoredImage>;

export const EMBEDDABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp']);

export function describeImage(bytes: Uint8Array, mimeHint?: string): StoredImage {
  const mime = sniffImageMime(bytes) ?? mimeHint ?? 'application/octet-stream';
  const size = imageSize(bytes);
  return { bytes, mime, width: size?.width, height: size?.height };
}

/** Fits an image into maxWidth px (keeping aspect ratio); unknown sizes get a sane default. */
export function fitSize(img: { width?: number; height?: number }, maxWidth: number, maxHeight = maxWidth * 1.4): { width: number; height: number } {
  let w = img.width && img.width > 0 ? img.width : maxWidth;
  let h = img.height && img.height > 0 ? img.height : Math.round(maxWidth * 0.6);
  const scale = Math.min(1, maxWidth / w, maxHeight / h);
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));
  return { width: w, height: h };
}

function imageUrlsOf(c: ExportContent): string[] {
  switch (c.type) {
    case 'image':
      return c.imageUrl ? [c.imageUrl] : [];
    case 'image_group':
      return (c.imageGroup?.images ?? []).map((i) => i.imageUrl ?? i.thumbnailUrl).filter((u): u is string => !!u);
    case 'attachment':
      return c.attachment?.url && c.attachment.mime_type?.startsWith('image/') ? [c.attachment.url] : [];
    case 'text':
    case 'markdown':
      return c.content && c.content.includes('![') ? inlineImageUrls(c.content) : [];
    default:
      return [];
  }
}

/** Lists every image (and optionally attachment) the conversation references, deduplicated by key. */
export function collectAssetRequests(conv: Conversation, includeAttachments: boolean): AssetRequest[] {
  const out = new Map<string, AssetRequest>();
  for (const m of conv.messages) {
    for (const c of m.contents) {
      for (const url of imageUrlsOf(c)) {
        if (!out.has(url)) out.set(url, { key: url, kind: 'image', url, fileId: c.type === 'image' ? c.fileId : undefined });
      }
      if (includeAttachments && c.type === 'attachment' && c.attachment && !c.attachment.mime_type?.startsWith('image/')) {
        const a = c.attachment;
        const key = a.url ?? (a.fileId ? `file:${a.fileId}` : undefined);
        if (key && !out.has(key) && (a.url || (a.fileId && conv.site === 'chatgpt'))) {
          out.set(key, { key, kind: 'attachment', url: a.url, fileId: a.fileId });
        }
      }
    }
  }
  return [...out.values()];
}

export function countImageRefs(conv: Conversation): number {
  const set = new Set<string>();
  for (const m of conv.messages) for (const c of m.contents) for (const u of imageUrlsOf(c)) set.add(u);
  return set.size;
}

export function countAttachments(conv: Conversation): { total: number; withText: number } {
  let total = 0;
  let withText = 0;
  for (const m of conv.messages)
    for (const c of m.contents)
      if (c.type === 'attachment') {
        total++;
        if (c.attachment?.extractedText) withText++;
      }
  return { total, withText };
}
