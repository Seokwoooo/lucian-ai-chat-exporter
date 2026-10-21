// Completeness and output verification. A file is never reported as a clean success when
// messages, images, attachments or formulas were lost: each gap becomes a warn/fail check.

import { unzipSync, strFromU8 } from 'fflate';
import type { AssetStatus } from '../shared/messages';
import type { Conversation, ExportFormat, MdImageMode, Verification, VerificationCheck, VerificationCounts } from '../shared/types';
import { countAttachments, countImageRefs } from './images';
import { TOOL_DOC_LIMIT } from './markdown';
import { lex, statsOf } from './md-parse';

export interface FormatStats {
  images?: number;
  imagesEmbedded?: number;
  imagesMissing?: number;
  math?: number;
  mathFailed?: number;
  tables?: number;
  codeBlocks?: number;
  attachmentsSaved?: number;
  attachmentsMissing?: number;
}

export interface OutputCheck {
  ok: boolean;
  detail?: string;
}

const RICH: ExportFormat[] = ['pdf', 'docx', 'hwpx', 'html', 'zip'];

function contentStats(conv: Conversation) {
  let tables = 0;
  let codeBlocks = 0;
  let math = 0;
  let thinking = 0;
  let toolsClipped = 0;
  let uncited = 0;
  for (const m of conv.messages) {
    for (const c of m.contents) {
      if (c.type === 'sources') uncited += c.moreSources?.length ?? 0;
      if (c.type === 'tool' && (c.content?.length ?? 0) > TOOL_DOC_LIMIT) toolsClipped++;
      if (c.type === 'thinking') thinking++;
      else if (c.type === 'code' || c.type === 'tool' || c.type === 'artifact' || c.type === 'html_widget') codeBlocks++;
      else if ((c.type === 'text' || c.type === 'markdown') && c.content) {
        const s = statsOf(lex(c.content, { breaks: c.type === 'text' }));
        tables += s.tables;
        codeBlocks += s.codeBlocks;
        math += s.math;
      }
    }
  }
  return { tables, codeBlocks, math, thinking, toolsClipped, uncited };
}

export function buildVerification(
  conv: Conversation,
  format: ExportFormat | 'handoff',
  opts: { assets?: AssetStatus[]; stats?: FormatStats; output?: OutputCheck; formatLabel?: string; mdImages?: MdImageMode } = {},
): Verification {
  const checks: VerificationCheck[] = [];
  const ex = conv.extraction;
  const missing = ex.missingNodeIds.length;
  const source = ex.sourceNodeCount;
  const cs = contentStats(conv);
  const userMessages = conv.messages.filter((m) => m.role === 'user').length;

  // Source nodes (tool steps, reasoning, answer parts) can be merged into fewer document messages,
  // so both numbers are reported.
  if (missing === 0) checks.push({ code: 'messages.match', status: 'pass', params: { exported: source, source, messages: conv.messages.length } });
  else {
    // What was lost ("assistant:multimodal_text(audio_transcription)") so the details name the cause.
    const params: Record<string, string | number> = { missing };
    if (ex.missingKinds?.length) params.kinds = ex.missingKinds.join(',');
    checks.push({ code: 'messages.missing', status: 'fail', params });
  }
  // The last answer may still have been in progress when the user clicked: say so instead of
  // passing silently (a real handoff once showed only "(empty)" for a long-running answer).
  const last = conv.messages[conv.messages.length - 1];
  const lastVisible = last?.contents.some((c) => c.type !== 'thinking' && c.type !== 'sources' && c.type !== 'tool' && (c.content?.trim() || c.imageUrl || c.imageGroup?.images.length || c.attachment));
  if (ex.warnings.includes('answer-in-progress')) checks.push({ code: 'answer.inProgress', status: 'warn' });
  else if (last?.role === 'assistant' && !lastVisible) checks.push({ code: 'answer.empty', status: 'warn' });
  if (ex.domUserTurns != null && ex.domUserTurns > userMessages) {
    checks.push({ code: 'dom.more', status: 'warn', params: { dom: ex.domUserTurns, exported: userMessages } });
  }
  if (ex.method === 'dom') checks.push({ code: 'method.dom', status: 'warn' });
  if (ex.pages && ex.pages > 1) checks.push({ code: 'pages', status: 'info', params: { pages: ex.pages } });
  if (ex.truncatedBySource) checks.push({ code: 'truncated.source', status: 'warn', params: { n: ex.truncatedBySource } });
  const hidden = ex.skipped.filter((s) => s.reason !== 'empty' && s.reason !== 'partial').length;
  if (hidden) checks.push({ code: 'skipped.hidden', status: 'info', params: { n: hidden } });

  const branches = conv.otherBranchMessages?.length ?? 0;
  if (branches) checks.push({ code: format === 'json' || format === 'zip' ? 'branches.saved' : 'branches.note', status: 'info', params: { n: branches } });
  if (cs.thinking && format !== 'handoff') {
    checks.push({ code: format === 'json' ? 'thinking.kept' : 'thinking.excluded', status: 'info', params: { n: cs.thinking } });
  }

  const imageTotal = countImageRefs(conv);
  const att = countAttachments(conv);
  const st = opts.stats ?? {};
  let imagesEmbedded = 0;
  let imagesMissing = 0;
  if (format !== 'handoff') {
    // Markdown saved with its images (ZIP or a folder next to it) is checked like a rich format.
    if (RICH.includes(format as ExportFormat) || opts.mdImages === 'zip' || opts.mdImages === 'folder') {
      const assetImages = (opts.assets ?? []).filter((a) => a.kind === 'image');
      const failed = assetImages.filter((a) => !a.ok).length;
      imagesMissing = Math.max(failed, st.imagesMissing ?? 0);
      imagesEmbedded = Math.max(0, imageTotal - imagesMissing);
      if (imageTotal === 0) {
        /* nothing to report */
      } else if (imagesMissing === 0) checks.push({ code: 'images.all', status: 'pass', params: { total: imageTotal } });
      else checks.push({ code: 'images.missing', status: 'warn', params: { missing: imagesMissing, total: imageTotal } });
    } else if (imageTotal > 0 && opts.mdImages === 'none') {
      checks.push({ code: 'images.omitted', status: 'info', params: { total: imageTotal } });
    } else if (imageTotal > 0) {
      checks.push({ code: 'images.linked', status: 'info', params: { total: imageTotal } });
    }

    if (att.total > 0) {
      if (format === 'zip') {
        const saved = st.attachmentsSaved ?? 0;
        const miss = st.attachmentsMissing ?? Math.max(0, att.total - saved);
        checks.push({ code: 'attachments.saved', status: 'info', params: { saved, total: att.total } });
        if (miss > 0) checks.push({ code: 'attachments.missing', status: 'warn', params: { missing: miss } });
      } else {
        checks.push({ code: 'attachments.meta', status: 'info', params: { total: att.total } });
      }
      if (att.withText > 0) checks.push({ code: 'attachments.text', status: 'info', params: { n: att.withText } });
    }
    if (format !== 'json' && cs.toolsClipped > 0) {
      checks.push({ code: 'tools.clipped', status: 'info', params: { n: cs.toolsClipped } });
    }
    if (format !== 'json' && cs.uncited > 0) {
      checks.push({ code: 'sources.uncited', status: 'info', params: { n: cs.uncited } });
    }

    if (cs.math > 0) {
      if (format === 'pdf' || format === 'html' || format === 'zip') {
        const failed = st.mathFailed ?? 0;
        if (failed > 0) checks.push({ code: 'math.failed', status: 'warn', params: { n: failed } });
        else checks.push({ code: 'math.rendered', status: 'pass', params: { n: st.math ?? cs.math } });
      } else if (format === 'docx' || format === 'hwpx' || format === 'txt') {
        checks.push({ code: 'math.latex', status: 'info', params: { n: cs.math } });
      }
    }
    if (RICH.includes(format as ExportFormat)) {
      if (cs.tables) checks.push({ code: 'tables.ok', status: 'pass', params: { n: st.tables ?? cs.tables } });
      if (cs.codeBlocks) checks.push({ code: 'code.ok', status: 'pass', params: { n: st.codeBlocks ?? cs.codeBlocks } });
    }
    if (format === 'hwpx') checks.push({ code: 'hwpx.compat', status: 'info' });
    if (format === 'pdf') checks.push({ code: 'pdf.print', status: 'info' });
  }

  if (opts.output) {
    checks.push(
      opts.output.ok
        ? { code: 'output.ok', status: 'pass', params: { format: opts.formatLabel ?? format } }
        : { code: 'output.invalid', status: 'fail', params: { detail: opts.output.detail ?? '' } },
    );
  }

  const counts: VerificationCounts = {
    messages: conv.messages.length,
    sourceMessages: source,
    domUserTurns: ex.domUserTurns,
    images: imageTotal,
    imagesEmbedded,
    imagesMissing,
    attachments: att.total,
    attachmentsSaved: st.attachmentsSaved ?? 0,
    tables: cs.tables,
    codeBlocks: cs.codeBlocks,
    math: cs.math,
    thinkingBlocks: cs.thinking,
  };
  return { level: levelOf(checks), checks, counts };
}

export function levelOf(checks: VerificationCheck[]): Verification['level'] {
  if (checks.some((c) => c.status === 'fail')) return 'error';
  if (checks.some((c) => c.status === 'warn')) return 'warning';
  return 'ok';
}

// ---------- structural output checks (run on the generated bytes) ----------

type XmlParser = (xml: string) => Document;

function parseOk(parse: XmlParser, xml: string): Document | null {
  const doc = parse(xml);
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}

/**
 * DOMParser is the strictest well-formedness check but builds a whole DOM: for the ~25 MB
 * document.xml of a 1M-token conversation that took 4.5 s in Chrome as one blocking step. Above
 * this size a streaming scan is used instead (and reports progress).
 */
export const DOM_PARSE_LIMIT = 4 * 1024 * 1024;

const BAD_ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
const NAME = /^[A-Za-z_][\w.:-]*/;
const ATTRS = /^(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*$/;

/**
 * Streaming XML well-formedness scan: one root element, every start tag closed in order, valid
 * attribute syntax (no '<' in values), entity references well-formed, no text outside the root.
 * Returns null when well-formed, otherwise a short reason.
 */
export async function scanXmlWellFormed(xml: string, onProgress?: (fraction: number) => void): Promise<string | null> {
  const n = xml.length;
  const stack: string[] = [];
  let roots = 0;
  let i = 0;
  let nextReport = 1 << 20;
  while (i < n) {
    if (i >= nextReport) {
      nextReport = i + (1 << 20);
      onProgress?.(i / n);
      await new Promise((r) => setTimeout(r, 0));
    }
    const lt = xml.indexOf('<', i);
    const text = lt < 0 ? xml.slice(i) : xml.slice(i, lt);
    if (text) {
      if (text.includes('&') && BAD_ENTITY.test(text)) return `invalid entity near offset ${i}`;
      if (!stack.length && text.trim()) return `text outside the root element at offset ${i}`;
    }
    if (lt < 0) break;
    if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt + 2);
      if (e < 0) return 'unterminated processing instruction';
      i = e + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      if (e < 0) return 'unterminated comment';
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      if (!stack.length) return 'CDATA outside the root element';
      const e = xml.indexOf(']]>', lt + 9);
      if (e < 0) return 'unterminated CDATA section';
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const e = xml.indexOf('>', lt + 2);
      if (e < 0 || roots) return 'misplaced declaration';
      i = e + 1;
      continue;
    }
    // End of the tag: the first '>' outside quoted attribute values.
    let gt = lt + 1;
    for (let q = 0; gt < n; gt++) {
      const c = xml.charCodeAt(gt);
      if (q) {
        if (c === q) q = 0;
      } else if (c === 34 || c === 39) q = c;
      else if (c === 62) break;
    }
    if (gt >= n) return `unterminated tag at offset ${lt}`;
    const tag = xml.slice(lt + 1, gt);
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      const open = stack.pop();
      if (open !== name) return `</${name}> does not close <${open ?? '(none)'}>`;
    } else {
      const selfClosing = tag.endsWith('/');
      const body = selfClosing ? tag.slice(0, -1) : tag;
      const name = NAME.exec(body)?.[0];
      if (!name) return `invalid tag at offset ${lt}`;
      const attrs = body.slice(name.length);
      if (attrs && (!ATTRS.test(attrs) || (attrs.includes('&') && BAD_ENTITY.test(attrs)))) return `invalid attributes in <${name}>`;
      if (!stack.length) {
        roots++;
        if (roots > 1) return 'more than one root element';
      }
      if (!selfClosing) stack.push(name);
    }
    i = gt + 1;
  }
  if (stack.length) return `<${stack[stack.length - 1]}> is not closed`;
  if (roots !== 1) return 'no root element';
  onProgress?.(1);
  return null;
}

async function xmlWellFormed(parse: XmlParser, xml: string, onProgress?: (fraction: number) => void): Promise<boolean> {
  if (xml.length <= DOM_PARSE_LIMIT) return parseOk(parse, xml) != null;
  return (await scanXmlWellFormed(xml, onProgress)) == null;
}

function headersInOrder(text: string, headers: string[]): OutputCheck {
  let pos = 0;
  for (const h of headers) {
    const i = text.indexOf(h, pos);
    if (i < 0) return { ok: false, detail: `missing message header: ${h.slice(0, 60)}` };
    pos = i + h.length;
  }
  return { ok: true };
}

export function verifyTextOutput(bytes: Uint8Array, headers: string[]): OutputCheck {
  return headersInOrder(new TextDecoder().decode(bytes), headers);
}

export function verifyJsonOutput(bytes: Uint8Array, expectedMessages: number): OutputCheck {
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    const n = data?.conversation?.messages?.length;
    return n === expectedMessages ? { ok: true } : { ok: false, detail: `messages ${n} ≠ ${expectedMessages}` };
  } catch (e) {
    return { ok: false, detail: `invalid JSON: ${e instanceof Error ? e.message : e}` };
  }
}

export function verifyHtmlOutput(html: string, expectedMessages: number, parseHtml: (s: string) => Document): OutputCheck {
  const doc = parseHtml(html);
  const n = doc.querySelectorAll('section.msg').length;
  return n === expectedMessages ? { ok: true } : { ok: false, detail: `rendered messages ${n} ≠ ${expectedMessages}` };
}

export async function verifyDocxOutput(
  bytes: Uint8Array,
  expectedMessages: number,
  expectedImages: number,
  parse: XmlParser,
  onProgress?: (fraction: number) => void,
): Promise<OutputCheck> {
  try {
    const files = unzipSync(bytes);
    const xml = files['word/document.xml'];
    if (!xml) return { ok: false, detail: 'word/document.xml missing' };
    if (!files['[Content_Types].xml']) return { ok: false, detail: '[Content_Types].xml missing' };
    const text = strFromU8(xml);
    if (!(await xmlWellFormed(parse, text, onProgress))) return { ok: false, detail: 'document.xml is not well-formed' };
    const headers = (text.match(/<w:pStyle w:val="LucianMessage"\/>/g) ?? []).length;
    if (headers !== expectedMessages) return { ok: false, detail: `message headers ${headers} ≠ ${expectedMessages}` };
    const drawings = (text.match(/<w:drawing>/g) ?? []).length;
    if (drawings !== expectedImages) return { ok: false, detail: `embedded images ${drawings} ≠ ${expectedImages}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: `unzip failed: ${e instanceof Error ? e.message : e}` };
  }
}

export async function verifyHwpxOutput(
  bytes: Uint8Array,
  headers: string[],
  expectedImages: number,
  parse: XmlParser,
  onProgress?: (fraction: number) => void,
): Promise<OutputCheck> {
  try {
    // The first local file header must be the uncompressed `mimetype` entry.
    const name = strFromU8(bytes.subarray(30, 38));
    if (name !== 'mimetype' || bytes[8] !== 0) return { ok: false, detail: 'mimetype entry is not first/stored' };
    const files = unzipSync(bytes);
    if (strFromU8(files['mimetype']) !== 'application/hwp+zip') return { ok: false, detail: 'wrong mimetype' };
    for (const part of ['version.xml', 'Contents/content.hpf', 'Contents/header.xml', 'Contents/section0.xml', 'META-INF/container.xml']) {
      if (!files[part]) return { ok: false, detail: `${part} missing` };
      if (part.endsWith('.xml') || part.endsWith('.hpf')) {
        if (!(await xmlWellFormed(parse, strFromU8(files[part]), part === 'Contents/section0.xml' ? onProgress : undefined))) return { ok: false, detail: `${part} is not well-formed` };
      }
    }
    const hpf = strFromU8(files['Contents/content.hpf']);
    for (const m of hpf.matchAll(/href="(BinData\/[^"]+)"/g)) if (!files[m[1]]) return { ok: false, detail: `${m[1]} missing` };
    const section = strFromU8(files['Contents/section0.xml']);
    const pics = (section.match(/<hp:pic /g) ?? []).length;
    if (pics !== expectedImages) return { ok: false, detail: `pictures ${pics} ≠ ${expectedImages}` };
    const plain = section.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    return headersInOrder(plain, headers);
  } catch (e) {
    return { ok: false, detail: `unzip failed: ${e instanceof Error ? e.message : e}` };
  }
}

export function verifyZipOutput(bytes: Uint8Array, required: string[]): OutputCheck {
  try {
    const files = unzipSync(bytes);
    for (const r of required) if (!files[r]) return { ok: false, detail: `${r} missing` };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: `unzip failed: ${e instanceof Error ? e.message : e}` };
  }
}
