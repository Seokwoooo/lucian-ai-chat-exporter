// Format dispatcher used by the offscreen document. Each format module is independent; heavy
// ones (docx, hwpx, katex) are loaded with dynamic import() so they are only fetched on demand.

import { strToU8, zipSync, type Zippable } from 'fflate';
import type { Locale } from '../shared/i18n';
import type { AssetStatus } from '../shared/messages';
import type { Conversation, ExportFormat, Verification } from '../shared/types';
import { bytesToBase64, formatDate, mimeToExt, safeFilename } from '../shared/util';
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
}

export interface PipelineOutput {
  bytes: Uint8Array;
  mime: string;
  filename: string;
  verification: Verification;
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

export async function runExport(input: PipelineInput): Promise<PipelineOutput> {
  const { conv, format, locale } = input;
  const exportedAt = input.exportedAt ?? Date.now();
  const appVersion = input.appVersion ?? '1.0.0';
  const enc = new TextEncoder();
  let bytes: Uint8Array;
  let stats: FormatStats = {};
  let output: OutputCheck;

  switch (format) {
    case 'md': {
      const md = conversationToMarkdown(conv, { locale }, exportedAt);
      bytes = enc.encode(md.text);
      output = verifyTextOutput(bytes, md.headers);
      break;
    }
    case 'txt': {
      const { conversationToTxt } = await import('./txt');
      const txt = conversationToTxt(conv, locale, exportedAt);
      bytes = enc.encode(txt.text);
      output = verifyTextOutput(bytes, txt.headers);
      break;
    }
    case 'json': {
      bytes = enc.encode(exportJsonText(conv, exportedAt, appVersion));
      output = verifyJsonOutput(bytes, conv.messages.length);
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
      output = verifyHtmlOutput(html, conv.messages.length, input.parseHtml);
      break;
    }
    case 'docx': {
      const { buildDocx } = await import('./docx');
      const r = await buildDocx(conv, { locale, images: input.embeddable, exportedAt });
      bytes = r.bytes;
      stats = r.stats;
      output = verifyDocxOutput(bytes, conv.messages.length, r.stats.imagesEmbedded, input.parseXml);
      break;
    }
    case 'hwpx': {
      const [{ buildHwpx }, { messageHeaderText }] = await Promise.all([import('./hwpx'), import('./markdown')]);
      const r = await buildHwpx(conv, { locale, images: input.embeddable, exportedAt, appVersion });
      bytes = r.bytes;
      stats = r.stats;
      output = verifyHwpxOutput(bytes, conv.messages.map((m) => messageHeaderText(conv, m, locale)), r.stats.imagesEmbedded, input.parseXml);
      break;
    }
    case 'zip': {
      const r = await buildZip(input, exportedAt, appVersion);
      bytes = r.bytes;
      stats = r.stats;
      output = verifyZipOutput(bytes, r.required);
      break;
    }
  }

  const verification = buildVerification(conv, format, { assets: input.assetStatus, stats, output, formatLabel: FORMAT_LABEL[format] });
  return { bytes, mime: FORMAT_MIME[format], filename: exportFilename(conv, format), verification };
}

async function buildZip(input: PipelineInput, exportedAt: number, appVersion: string) {
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

  const md = conversationToMarkdown(conv, { locale, imageHref: (u) => imagePath.get(u), attachmentHref: (k) => attachmentPath.get(k) }, exportedAt);
  files[`${root}/conversation.md`] = strToU8(md.text);
  const { renderConversationBody, wrapHtmlDocument } = await import('./html');
  const body = renderConversationBody(
    conv,
    { locale, mode: 'file', renderMath: input.renderMath, imageSrc: (u) => imagePath.get(u), attachmentHref: (k) => attachmentPath.get(k) },
    exportedAt,
  );
  files[`${root}/conversation.html`] = strToU8(wrapHtmlDocument(conv.title || conv.siteName, body.html, locale, 'file'));
  files[`${root}/conversation.json`] = strToU8(exportJsonText(conv, exportedAt, appVersion));

  const stats: FormatStats = { ...body.stats, attachmentsSaved, attachmentsMissing };
  const preVerification = buildVerification(conv, 'zip', { assets: input.assetStatus, stats });
  files[`${root}/verification-report.md`] = strToU8(verificationReportMarkdown(conv, preVerification, locale, { files: listing, exportedAt }));
  files[`${root}/verification-report.json`] = strToU8(JSON.stringify({ verification: preVerification, files: listing, extraction: conv.extraction }, null, 2));
  const required = ['conversation.md', 'conversation.html', 'conversation.json', 'verification-report.md'].map((f) => `${root}/${f}`);
  return { bytes: zipSync(files, { level: 6 }), stats, required };
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
