// Format dispatcher used by the offscreen document. Each format module is independent; heavy
// ones (docx, hwpx, katex) are loaded with dynamic import() so they are only fetched on demand.

import { strToU8, zipSync, type Zippable } from 'fflate';
import type { Locale } from '../shared/i18n';
import type { AssetStatus } from '../shared/messages';
import type { Conversation, ExportFormat, MdImageMode, Verification } from '../shared/types';
import { bytesToBase64, formatDate, mimeToExt, safeFilename, yieldToLoop, type ProgressFn } from '../shared/util';
import type { ImageStore, StoredImage } from './images';
import { conversationToMarkdown } from './markdown';
import { buildVerification, verifyHtmlOutput, verifyJsonOutput, verifyTextOutput, verifyZipOutput, verifyDocxOutput, verifyHwpxOutput, type FormatStats, type OutputCheck } from './verify';
import { verificationReportMarkdown } from './report';

export const FORMAT_MIME: Record<ExportFormat, string> = {
  md: 'text/markdown;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
  json: 'application/json;charset=utf-8',
  html: 'text/html;charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  hwpx: 'application/hwp+zip',
  zip: 'application/zip',
  pdf: 'application/pdf',
};

export const FORMAT_LABEL: Record<ExportFormat, string> = {
  md: 'Markdown',
  txt: 'TXT',
  json: 'JSON',
  html: 'HTML',
  docx: 'Word',
  hwpx: 'HWPX',
  zip: 'ZIP',
  pdf: 'PDF',
};

export interface PipelineInput {
  conv: Conversation;
  format: Exclude<ExportFormat, 'pdf'>;
  locale: Locale;
  /** Images converted to Word/Hangul-embeddable formats. */
  embeddable: ImageStore;
  /** Original bytes as fetched (images and attachments), keyed like AssetRequest.key. */
  raw: Map<string, StoredImage>;
  assetStatus: AssetStatus[];
  renderMath?: (tex: string, display: boolean) => string | null;
  parseXml: (s: string) => Document;
  parseHtml: (s: string) => Document;
  exportedAt?: number;
  appVersion?: string;
  /** Overall progress of build + verification, 0…1. */
  onProgress?: ProgressFn;
  /** Markdown only: how the chat's images are saved (asked each time; v1.3.6). */
  mdImages?: MdImageMode;
}

export interface PipelineOutput {
  bytes: Uint8Array;
  mime: string;
  filename: string;
  verification: Verification;
  stageMs?: { build: number; verify: number };
  /** Files saved next to the main one (Markdown "folder" mode: its images), named relative to it. */
  extraFiles?: Array<{ filename: string; bytes: Uint8Array; mime: string }>;
}

export function exportFilename(conv: Conversation, ext: string): string {
  // Tech doc §22.2: title-based filename ("onlyChatName"), sanitized and length limited.
  return safeFilename(conv.title || `${conv.siteName}-${formatDate(Date.now())}`, ext);
}

function dataUrl(img: StoredImage): string {
  return `data:${img.mime};base64,${bytesToBase64(img.bytes)}`;
}

export function exportJsonText(conv: Conversation, exportedAt: number, appVersion: string): string {
  return JSON.stringify(
    {
      schema: 'lucian.conversation/v1',
      exportedAt: new Date(exportedAt).toISOString(),
      exporter: { name: 'Lucian AI Chat Exporter', version: appVersion },
      conversation: conv,
    },
    null,
    2,
  );
}

/**
 * Share of the work that is building (the rest is verifying the generated file), measured on a
 * 1M-token conversation in Chrome. Used only to turn stage progress into one percentage.
 */
const BUILD_SHARE: Record<Exclude<ExportFormat, 'pdf'>, number> = { md: 0.75, txt: 0.75, json: 0.6, html: 0.8, docx: 0.88, hwpx: 0.77, zip: 0.9 };

export async function runExport(input: PipelineInput): Promise<PipelineOutput> {
  const { conv, format, locale } = input;
  const exportedAt = input.exportedAt ?? Date.now();
  const appVersion = input.appVersion ?? '1.0.0';
  const enc = new TextEncoder();
  const share = BUILD_SHARE[format];
  const report = (f: number, stage: string) => input.onProgress?.(Math.min(1, Math.max(0, f)), stage);
  const building: ProgressFn = (f, stage) => report(share * f, stage ?? 'build');
  let bytes: Uint8Array;
  let stats: FormatStats = {};
  let mime = FORMAT_MIME[format];
  let filename = exportFilename(conv, format);
  let extraFiles: PipelineOutput['extraFiles'];
  let verify: (onProgress: (f: number) => void) => OutputCheck | Promise<OutputCheck>;
  const t0 = performance.now();
  report(0, 'build');

  switch (format) {
    case 'md': {
      const mode = input.mdImages;
      if (mode === 'zip' || mode === 'folder') {
        // The .md links each image by a relative path: inside the ZIP ("images/…") or in the
        // "<title>_files" folder saved next to the .md. Images that could not be fetched get a note.
        const stem = exportFilename(conv, 'md').replace(/\.md$/, '');
        const images = savedImages(input, mode === 'zip' ? 'images/' : `${stem}_files/`, mode === 'folder');
        const md = conversationToMarkdown(conv, { locale, imageHref: (u) => images.path.get(u), unmappedImage: 'missing' }, exportedAt);
        stats = { imagesMissing: images.missing };
        if (mode === 'zip') {
          const files: Zippable = { [`${stem}/${stem}.md`]: strToU8(md.text) };
          for (const f of images.files) files[`${stem}/${f.filename}`] = [f.bytes, { level: 0 }];
          bytes = zipSync(files, { level: 6 });
          mime = FORMAT_MIME.zip;
          filename = exportFilename(conv, 'zip');
          const required = Object.keys(files);
          verify = () => verifyZipOutput(bytes, required);
        } else {
          bytes = enc.encode(md.text);
          extraFiles = images.files;
          verify = () => verifyTextOutput(bytes, md.headers);
        }
      } else {
        // 'none': the user chose the .md alone, so images become "[이미지: …]" instead of links that
        // only open while logged in to the service. Without a choice (no images) nothing changes.
        const md = conversationToMarkdown(conv, { locale, unmappedImage: mode === 'none' ? 'omit' : 'link' }, exportedAt);
        bytes = enc.encode(md.text);
        verify = () => verifyTextOutput(bytes, md.headers);
      }
      break;
    }
    case 'txt': {
      const { conversationToTxt } = await import('./txt');
      const txt = conversationToTxt(conv, locale, exportedAt);
      bytes = enc.encode(txt.text);
      verify = () => verifyTextOutput(bytes, txt.headers);
      break;
    }
    case 'json': {
      bytes = enc.encode(exportJsonText(conv, exportedAt, appVersion));
      verify = () => verifyJsonOutput(bytes, conv.messages.length);
      break;
    }
    case 'html': {
      const { renderConversationBody, wrapHtmlDocument } = await import('./html');
      const body = renderConversationBody(
        conv,
        { locale, mode: 'file', renderMath: input.renderMath, imageSrc: (url) => (input.raw.get(url) ? dataUrl(input.raw.get(url)!) : undefined) },
        exportedAt,
      );
      const html = wrapHtmlDocument(conv.title || conv.siteName, body.html, locale, 'file');
      bytes = enc.encode(html);
      stats = body.stats;
      verify = () => verifyHtmlOutput(html, conv.messages.length, input.parseHtml);
      break;
    }
    case 'docx': {
      const { buildDocx } = await import('./docx');
      const r = await buildDocx(conv, { locale, images: input.embeddable, exportedAt, onProgress: building });
      bytes = r.bytes;
      stats = r.stats;
      verify = (p) => verifyDocxOutput(bytes, conv.messages.length, r.stats.imagesEmbedded, input.parseXml, p);
      break;
    }
    case 'hwpx': {
      const [{ buildHwpx }, { messageHeaderText }] = await Promise.all([import('./hwpx'), import('./markdown')]);
      const r = await buildHwpx(conv, { locale, images: input.embeddable, exportedAt, appVersion, onProgress: building });
      bytes = r.bytes;
      stats = r.stats;
      verify = (p) => verifyHwpxOutput(bytes, conv.messages.map((m) => messageHeaderText(conv, m, locale)), r.stats.imagesEmbedded, input.parseXml, p);
      break;
    }
    case 'zip': {
      const r = await buildZip(input, exportedAt, appVersion, building);
      bytes = r.bytes;
      stats = r.stats;
      verify = () => verifyZipOutput(bytes, r.required);
      break;
    }
  }

  const buildMs = performance.now() - t0;
  report(share, 'verify');
  // Let the progress message go out before the (synchronous) verification starts.
  await yieldToLoop();
  const t1 = performance.now();
  const output = await verify((f) => report(share + (1 - share) * f, 'verify'));
  const verifyMs = performance.now() - t1;
  report(1, 'verify');
  const verification = buildVerification(conv, format, { assets: input.assetStatus, stats, output, formatLabel: FORMAT_LABEL[format], mdImages: format === 'md' ? input.mdImages : undefined });
  return { bytes, mime, filename, verification, stageMs: { build: buildMs, verify: verifyMs }, extraFiles };
}

/**
 * The fetched images of a Markdown export, named in conversation order under `dir`. In "folder"
 * mode a short content hash is added: saving the same chat again overwrites identical files
 * instead of creating "image-001 (1).png", which would break the .md's links.
 */
function savedImages(input: PipelineInput, dir: string, hashed: boolean) {
  const path = new Map<string, string>();
  const files: Array<{ filename: string; bytes: Uint8Array; mime: string }> = [];
  let n = 0;
  let missing = 0;
  for (const a of input.assetStatus) {
    if (a.kind !== 'image') continue;
    const data = input.raw.get(a.key);
    if (!a.ok || !data) {
      missing++;
      continue;
    }
    const name = `${dir}image-${String(++n).padStart(3, '0')}${hashed ? `-${contentHash(data.bytes)}` : ''}.${mimeToExt(data.mime, 'png')}`;
    path.set(a.key, name);
    files.push({ filename: name, bytes: data.bytes, mime: data.mime });
  }
  return { path, files, missing };
}

/** FNV-1a over the bytes, 8 hex digits: enough to tell different images of one chat apart. */
function contentHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

async function buildZip(input: PipelineInput, exportedAt: number, appVersion: string, onProgress?: ProgressFn) {
  const { conv, locale } = input;
  const root = exportFilename(conv, 'zip').replace(/\.zip$/, '');
  const files: Zippable = {};
  const imagePath = new Map<string, string>();
  const attachmentPath = new Map<string, string>();
  const listing: Array<{ path: string; status: string }> = [];
  let imgN = 0;
  let attachmentsSaved = 0;
  let attachmentsMissing = 0;
  const usedNames = new Set<string>();

  for (const a of input.assetStatus) {
    const data = input.raw.get(a.key);
    if (a.kind === 'image') {
      if (a.ok && data) {
        const name = `images/image-${String(++imgN).padStart(3, '0')}.${mimeToExt(data.mime, 'png')}`;
        imagePath.set(a.key, name);
        files[`${root}/${name}`] = [data.bytes, { level: 0 }];
        listing.push({ path: name, status: 'ok' });
      } else listing.push({ path: a.key, status: `missing (${a.error ?? 'unavailable'})` });
    } else {
      if (a.ok && data) {
        const att = findAttachment(conv, a.key);
        let name = safeFilename((att?.name ?? 'attachment').replace(/\.[^.]+$/, ''), (att?.name?.split('.').pop() ?? mimeToExt(data.mime)) || 'bin');
        while (usedNames.has(name)) name = `${attachmentsSaved + 1}-${name}`;
        usedNames.add(name);
        attachmentPath.set(a.key, `attachments/${name}`);
        files[`${root}/attachments/${name}`] = [data.bytes, { level: 6 }];
        attachmentsSaved++;
        listing.push({ path: `attachments/${name}`, status: 'ok' });
      } else {
        attachmentsMissing++;
        listing.push({ path: a.key, status: `missing (${a.error ?? 'unavailable'})` });
      }
    }
  }
  // Attachments the service never exposed as files (no URL / id) are reported as missing too.
  const totalAttachments = conv.messages.reduce((n, m) => n + m.contents.filter((c) => c.type === 'attachment').length, 0);
  attachmentsMissing = Math.max(attachmentsMissing, totalAttachments - attachmentsSaved);

  onProgress?.(0.1, 'build');
  const md = conversationToMarkdown(conv, { locale, imageHref: (u) => imagePath.get(u), attachmentHref: (k) => attachmentPath.get(k) }, exportedAt);
  files[`${root}/conversation.md`] = strToU8(md.text);
  onProgress?.(0.25, 'build');
  await yieldToLoop();
  const { renderConversationBody, wrapHtmlDocument } = await import('./html');
  const body = renderConversationBody(
    conv,
    { locale, mode: 'file', renderMath: input.renderMath, imageSrc: (u) => imagePath.get(u), attachmentHref: (k) => attachmentPath.get(k) },
    exportedAt,
  );
  files[`${root}/conversation.html`] = strToU8(wrapHtmlDocument(conv.title || conv.siteName, body.html, locale, 'file'));
  files[`${root}/conversation.json`] = strToU8(exportJsonText(conv, exportedAt, appVersion));
  onProgress?.(0.6, 'pack');
  await yieldToLoop();

  const stats: FormatStats = { ...body.stats, attachmentsSaved, attachmentsMissing };
  const preVerification = buildVerification(conv, 'zip', { assets: input.assetStatus, stats });
  files[`${root}/verification-report.md`] = strToU8(verificationReportMarkdown(conv, preVerification, locale, { files: listing, exportedAt }));
  files[`${root}/verification-report.json`] = strToU8(JSON.stringify({ verification: preVerification, files: listing, extraction: conv.extraction }, null, 2));
  const required = ['conversation.md', 'conversation.html', 'conversation.json', 'verification-report.md'].map((f) => `${root}/${f}`);
  const bytes = zipSync(files, { level: 6 });
  onProgress?.(1, 'pack');
  return { bytes, stats, required };
}

function findAttachment(conv: Conversation, key: string) {
  for (const m of conv.messages)
    for (const c of m.contents)
      if (c.type === 'attachment' && c.attachment) {
        const k = c.attachment.url ?? (c.attachment.fileId ? `file:${c.attachment.fileId}` : undefined);
        if (k === key) return c.attachment;
      }
  return undefined;
}
