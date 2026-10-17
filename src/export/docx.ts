// Conversation → Word (.docx) built locally with the `docx` library (tech doc §26). Messages are
// cloned implicitly (we never mutate the conversation), images are embedded at original quality
// when Word supports the format, tables become real Word tables and code keeps its indentation.

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Tab,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IRunOptions,
  type ParagraphChild,
} from 'docx';
import { attachmentName, t, formatBytes, type Locale } from '../shared/i18n';
import type { Conversation, ExportContent, ExportMessage } from '../shared/types';
import { formatDateTime } from '../shared/util';
import { EMBEDDABLE, fitSize, type ImageStore } from './images';
import { messageHeaderText, toolDocText } from './markdown';
import { lex, type Token, type Tokens } from './md-parse';
import { yieldToLoop, type ProgressFn } from '../shared/util';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const MESSAGE_STYLE = 'LucianMessage';

const MONO = { ascii: 'Consolas', hAnsi: 'Consolas', cs: 'Consolas', eastAsia: 'D2Coding' };
const BODY_FONT = { ascii: 'Calibri', hAnsi: 'Calibri', cs: 'Calibri', eastAsia: 'Malgun Gothic' };
const MAX_IMAGE_PX = 600;

export interface DocxStats {
  messages: number;
  tables: number;
  codeBlocks: number;
  math: number;
  images: number;
  imagesEmbedded: number;
  imagesMissing: number;
}

interface Ctx {
  locale: Locale;
  images: ImageStore;
  stats: DocxStats;
  listInstance: number;
}

type Block = Paragraph | Table;

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
}

function textRun(text: string, s: RunStyle): TextRun {
  const opts: IRunOptions = {
    // A newline inside a Markdown text token is a soft break and renders as a space.
    text: text.replace(/\r?\n/g, ' '),
    bold: s.bold,
    italics: s.italics,
    strike: s.strike,
    ...(s.code ? { font: MONO, size: 19, shading: { type: ShadingType.CLEAR, fill: 'F1F2F4', color: 'auto' } } : {}),
    ...(s.link ? { style: 'Hyperlink' } : {}),
  };
  return new TextRun(opts);
}

function imageRun(url: string, ctx: Ctx): ParagraphChild[] {
  ctx.stats.images++;
  const img = ctx.images.get(url);
  if (!img || !EMBEDDABLE.has(img.mime)) {
    ctx.stats.imagesMissing++;
    const label = t(ctx.locale, 'doc.imageMissing');
    return /^https?:/i.test(url)
      ? [textRun(`[${label}] `, { italics: true }), new ExternalHyperlink({ link: url, children: [textRun(url, { link: true })] })]
      : [textRun(`[${label}]`, { italics: true })];
  }
  ctx.stats.imagesEmbedded++;
  const size = fitSize(img, MAX_IMAGE_PX);
  const type = img.mime === 'image/jpeg' ? 'jpg' : img.mime === 'image/gif' ? 'gif' : img.mime === 'image/bmp' ? 'bmp' : 'png';
  return [new ImageRun({ type, data: img.bytes, transformation: size })];
}

function inlineRuns(tokens: Token[] | undefined, ctx: Ctx, style: RunStyle = {}): ParagraphChild[] {
  if (!tokens) return [];
  const out: ParagraphChild[] = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text': {
        const tt = tok as Tokens.Text;
        if (tt.tokens) out.push(...inlineRuns(tt.tokens, ctx, style));
        else out.push(textRun(tt.text, style));
        break;
      }
      case 'escape':
        out.push(textRun((tok as Tokens.Escape).text, style));
        break;
      case 'strong':
        out.push(...inlineRuns((tok as Tokens.Strong).tokens, ctx, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...inlineRuns((tok as Tokens.Em).tokens, ctx, { ...style, italics: true }));
        break;
      case 'del':
        out.push(...inlineRuns((tok as Tokens.Del).tokens, ctx, { ...style, strike: true }));
        break;
      case 'codespan':
        out.push(textRun((tok as Tokens.Codespan).text, { ...style, code: true }));
        break;
      case 'br':
        out.push(new TextRun({ text: '', break: 1 }));
        break;
      case 'link': {
        const l = tok as Tokens.Link;
        const children = inlineRuns(l.tokens, ctx, { ...style, link: true }).filter((c): c is TextRun => c instanceof TextRun);
        if (/^(https?:|mailto:)/i.test(l.href) && children.length) out.push(new ExternalHyperlink({ link: l.href, children }));
        else out.push(...children);
        break;
      }
      case 'image':
        out.push(...imageRun((tok as Tokens.Image).href, ctx));
        break;
      case 'html':
        out.push(textRun((tok as Tokens.HTML).text, style));
        break;
      case 'mathInline':
        ctx.stats.math++;
        out.push(textRun(`$${(tok as unknown as { text: string }).text}$`, { ...style, code: true }));
        break;
      case 'mathBlock':
        ctx.stats.math++;
        out.push(textRun(`$$${(tok as unknown as { text: string }).text}$$`, { ...style, code: true }));
        break;
      default:
        out.push(textRun((tok as { raw?: string }).raw ?? '', style));
    }
  }
  return out;
}

function codeLineChildren(line: string): ParagraphChild[] {
  const parts = line.split('\t');
  const out: ParagraphChild[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(new TextRun({ children: [new Tab()], font: MONO, size: 18 }));
    if (p) out.push(new TextRun({ text: p, font: MONO, size: 18 }));
  });
  return out;
}

function codeBlock(code: string, caption: string | undefined, ctx: Ctx, indent = 0): Block[] {
  ctx.stats.codeBlocks++;
  const lines = code.replace(/\n$/, '').split('\n');
  const paragraphs = lines.map(
    (line) => new Paragraph({ children: codeLineChildren(line), spacing: { before: 0, after: 0, line: 260 } }),
  );
  if (caption) {
    paragraphs.unshift(
      new Paragraph({ children: [new TextRun({ text: caption, size: 16, color: '6E6E73', font: MONO })], spacing: { before: 0, after: 60 } }),
    );
  }
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'E3E3E8' };
  return [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      indent: indent ? { size: indent, type: WidthType.DXA } : undefined,
      borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              children: paragraphs,
              shading: { type: ShadingType.CLEAR, fill: 'F6F7F9', color: 'auto' },
              margins: { top: 100, bottom: 100, left: 140, right: 140 },
            }),
          ],
        }),
      ],
    }),
    new Paragraph({ spacing: { before: 0, after: 80 }, children: [] }),
  ];
}

function tableBlock(tb: Tokens.Table, ctx: Ctx): Block[] {
  ctx.stats.tables++;
  const cols = Math.max(1, tb.header.length);
  const width = Math.floor(100 / cols);
  const align = (i: number) =>
    tb.align[i] === 'center' ? AlignmentType.CENTER : tb.align[i] === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT;
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'C9C9CF' };
  const cell = (tokens: Token[], i: number, header: boolean) =>
    new TableCell({
      width: { size: width, type: WidthType.PERCENTAGE },
      shading: header ? { type: ShadingType.CLEAR, fill: 'F2F2F5', color: 'auto' } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ alignment: align(i), spacing: { before: 0, after: 0 }, children: inlineRuns(tokens, ctx, header ? { bold: true } : {}) })],
    });
  const rows = [
    new TableRow({ tableHeader: true, cantSplit: true, children: tb.header.map((h, i) => cell(h.tokens, i, true)) }),
    ...tb.rows.map((r) => new TableRow({ cantSplit: true, children: Array.from({ length: cols }, (_, i) => cell(r[i]?.tokens ?? [], i, false)) })),
  ];
  return [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
      rows,
    }),
    new Paragraph({ spacing: { before: 0, after: 80 }, children: [] }),
  ];
}

function blocks(tokens: Token[], ctx: Ctx, level = 0, quote = false): Block[] {
  const out: Block[] = [];
  const indent = quote ? { left: 360 } : undefined;
  const quoteBorder = quote ? { left: { style: BorderStyle.SINGLE, size: 12, color: 'D0D0D7', space: 8 } } : undefined;
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break;
      case 'paragraph':
      case 'text': {
        const p = tok as Tokens.Paragraph;
        out.push(new Paragraph({ children: inlineRuns(p.tokens ?? [{ type: 'text', raw: p.text, text: p.text } as Token], ctx), indent, border: quoteBorder }));
        break;
      }
      case 'heading': {
        const h = tok as Tokens.Heading;
        const levels = [HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
        out.push(new Paragraph({ heading: levels[Math.min(levels.length - 1, h.depth - 1)], children: inlineRuns(h.tokens, ctx) }));
        break;
      }
      case 'code': {
        const c = tok as Tokens.Code;
        out.push(...codeBlock(c.text, c.lang?.trim().split(/\s+/)[0] || undefined, ctx, level * 360));
        break;
      }
      case 'blockquote':
        out.push(...blocks((tok as Tokens.Blockquote).tokens, ctx, level, true));
        break;
      case 'list': {
        const l = tok as Tokens.List;
        const instance = ++ctx.listInstance;
        for (const item of l.items) {
          const [first, ...rest] = item.tokens.filter((x) => x.type !== 'space');
          const firstRuns =
            first && (first.type === 'text' || first.type === 'paragraph')
              ? inlineRuns((first as Tokens.Text).tokens ?? [{ type: 'text', raw: (first as Tokens.Text).text, text: (first as Tokens.Text).text } as Token], ctx)
              : [];
          const prefix = item.task ? [textRun(item.checked ? '☑ ' : '☐ ', {})] : [];
          out.push(
            new Paragraph({
              numbering: { reference: l.ordered ? 'lucian-numbers' : 'lucian-bullets', level: Math.min(level, 8), instance: l.ordered ? instance : undefined },
              children: [...prefix, ...firstRuns],
              spacing: { after: 40 },
            }),
          );
          const remaining = first && (first.type === 'text' || first.type === 'paragraph') ? rest : [first, ...rest].filter(Boolean);
          out.push(...blocks(remaining as Token[], ctx, level + 1, quote));
        }
        break;
      }
      case 'table':
        out.push(...tableBlock(tok as Tokens.Table, ctx));
        break;
      case 'hr':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D0D0D7', space: 1 } }, children: [] }));
        break;
      case 'html':
        out.push(new Paragraph({ children: [textRun((tok as Tokens.HTML).text, {})] }));
        break;
      case 'mathBlock':
        ctx.stats.math++;
        out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [textRun(`$$${(tok as unknown as { text: string }).text}$$`, { code: true })] }));
        break;
      default: {
        const g = tok as Tokens.Generic;
        if (g.raw?.trim()) out.push(new Paragraph({ children: [textRun(g.raw, {})] }));
      }
    }
  }
  return out;
}

function captionParagraph(text: string): Paragraph {
  return new Paragraph({ keepNext: true, spacing: { before: 60, after: 40 }, children: [new TextRun({ text, bold: true, size: 19, color: '4A4A50' })] });
}

function contentBlocks(c: ExportContent, ctx: Ctx): Block[] {
  const L = ctx.locale;
  switch (c.type) {
    case 'text':
    case 'markdown':
      return blocks(lex(c.content ?? '', { breaks: c.type === 'text' }), ctx);
    case 'thinking':
      return [];
    case 'code':
      return codeBlock(c.content ?? '', [c.title, c.language].filter(Boolean).join(' · ') || undefined, ctx);
    case 'tool':
      return [captionParagraph(`${t(L, 'doc.tool')} · ${c.title ?? ''}`), ...codeBlock(toolDocText(c.content ?? '', L), c.language, ctx)];
    case 'artifact':
    case 'html_widget':
      return [captionParagraph(`${t(L, 'doc.artifact')} · ${c.title ?? ''}`), ...codeBlock(c.content ?? '', c.type === 'html_widget' ? 'html' : c.language, ctx)];
    case 'image':
      return c.imageUrl ? [new Paragraph({ children: imageRun(c.imageUrl, ctx) })] : [];
    case 'image_group':
      return (c.imageGroup?.images ?? [])
        .map((i) => i.imageUrl ?? i.thumbnailUrl)
        .filter((u): u is string => !!u)
        .map((u) => new Paragraph({ children: imageRun(u, ctx) }));
    case 'attachment': {
      const a = c.attachment ?? {};
      const meta = [a.mime_type, a.size ? formatBytes(a.size) : ''].filter(Boolean).join(', ');
      const out: Block[] = [
        new Paragraph({
          children: [
            new TextRun({ text: `${t(L, 'doc.attachment')}: `, color: '6E6E73' }),
            new TextRun({ text: attachmentName(a, L), bold: true }),
            ...(meta ? [new TextRun({ text: ` (${meta})`, color: '6E6E73' })] : []),
          ],
        }),
      ];
      if (a.extractedText) out.push(captionParagraph(t(L, 'doc.extractedText')), ...codeBlock(a.extractedText, undefined, ctx));
      return out;
    }
    case 'sources': {
      const list = c.sources ?? [];
      if (!list.length) return [];
      return [
        captionParagraph(t(L, 'doc.sources')),
        ...list.map(
          (s, i) =>
            new Paragraph({
              spacing: { after: 20 },
              children: [
                new TextRun({ text: `${i + 1}. `, size: 19 }),
                /^https?:/i.test(s.url)
                  ? new ExternalHyperlink({ link: s.url, children: [new TextRun({ text: s.title || s.url, style: 'Hyperlink', size: 19 })] })
                  : new TextRun({ text: s.title || s.url, size: 19 }),
              ],
            }),
        ),
      ];
    }
  }
  return [];
}

function messageBlocks(conv: Conversation, msg: ExportMessage, ctx: Ctx): Block[] {
  ctx.stats.messages++;
  const header = new Paragraph({ style: MESSAGE_STYLE, children: [new TextRun(messageHeaderText(conv, msg, ctx.locale))] });
  const body = msg.contents.flatMap((c) => contentBlocks(c, ctx));
  if (msg.truncated) body.push(new Paragraph({ children: [new TextRun({ text: t(ctx.locale, 'doc.truncated'), italics: true, color: '6E6E73' })] }));
  return [header, ...body];
}

const bulletLevels = Array.from({ length: 9 }, (_, i) => ({
  level: i,
  format: LevelFormat.BULLET,
  text: ['•', '◦', '▪'][i % 3],
  alignment: AlignmentType.LEFT,
  style: { paragraph: { indent: { left: 360 * (i + 1), hanging: 260 } } },
}));

const numberLevels = Array.from({ length: 9 }, (_, i) => ({
  level: i,
  format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][i % 3],
  text: `%${i + 1}.`,
  alignment: AlignmentType.LEFT,
  style: { paragraph: { indent: { left: 360 * (i + 1), hanging: 300 } } },
}));

/** Measured on a 1M-token conversation: building paragraphs is about this share of buildDocx. */
export const DOCX_BLOCKS_SHARE = 0.3;

export async function buildDocx(
  conv: Conversation,
  opts: { locale: Locale; images: ImageStore; exportedAt?: number; onProgress?: ProgressFn },
): Promise<{ bytes: Uint8Array; stats: DocxStats }> {
  const exportedAt = opts.exportedAt ?? Date.now();
  const stats: DocxStats = { messages: 0, tables: 0, codeBlocks: 0, math: 0, images: 0, imagesEmbedded: 0, imagesMissing: 0 };
  const ctx: Ctx = { locale: opts.locale, images: opts.images, stats, listInstance: 0 };
  const L = opts.locale;
  const meta = [
    `${t(L, 'doc.source')}: ${conv.siteName}`,
    `${t(L, 'doc.exportedAt')}: ${formatDateTime(exportedAt)}`,
    `${t(L, 'doc.messages')}: ${conv.messages.length}`,
    conv.model ? `${t(L, 'doc.model')}: ${conv.model}` : '',
  ].filter(Boolean);

  const children: Block[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(conv.title || conv.siteName)] }),
    new Paragraph({ children: [new TextRun({ text: meta.join('   ·   '), color: '6E6E73', size: 19 })] }),
    new Paragraph({
      spacing: { after: 200 },
      children: [new ExternalHyperlink({ link: conv.fromUrl, children: [new TextRun({ text: conv.fromUrl, style: 'Hyperlink', size: 18 })] })],
    }),
  ];
  // Building paragraphs is reported per message; packing (XML + ZIP inside the docx library) has
  // no progress of its own and is the remaining share.
  const N = conv.messages.length;
  for (let i = 0; i < N; i++) {
    children.push(...messageBlocks(conv, conv.messages[i], ctx));
    if (opts.onProgress && i % 50 === 49) {
      opts.onProgress((DOCX_BLOCKS_SHARE * (i + 1)) / N, 'build');
      await yieldToLoop();
    }
  }
  opts.onProgress?.(DOCX_BLOCKS_SHARE, 'pack');

  const doc = new Document({
    creator: 'Lucian AI Chat Exporter',
    title: conv.title || conv.siteName,
    description: `${conv.siteName} conversation export`,
    styles: {
      default: {
        document: { run: { font: BODY_FONT, size: 21 }, paragraph: { spacing: { after: 120, line: 300 } } },
        title: { run: { font: BODY_FONT, size: 40, bold: true, color: '1D1D1F' }, paragraph: { spacing: { after: 80 } } },
        heading3: { run: { font: BODY_FONT, size: 26, bold: true, color: '1D1D1F' }, paragraph: { spacing: { before: 200, after: 80 } } },
        heading4: { run: { font: BODY_FONT, size: 23, bold: true, color: '1D1D1F' }, paragraph: { spacing: { before: 160, after: 60 } } },
        heading5: { run: { font: BODY_FONT, size: 21, bold: true, color: '1D1D1F' } },
        heading6: { run: { font: BODY_FONT, size: 21, bold: true, color: '4A4A50' } },
        hyperlink: { run: { color: '3A3AD6', underline: {} } },
      },
      paragraphStyles: [
        {
          id: MESSAGE_STYLE,
          name: 'Lucian Message',
          basedOn: 'Normal',
          next: 'Normal',
          run: { bold: true, size: 22, color: '1D1D1F', font: BODY_FONT },
          paragraph: {
            keepNext: true,
            outlineLevel: 1,
            spacing: { before: 320, after: 120 },
            border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'E3E3E8', space: 10 } },
          },
        },
      ],
    },
    numbering: {
      config: [
        { reference: 'lucian-bullets', levels: bulletLevels },
        { reference: 'lucian-numbers', levels: numberLevels },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        children,
      },
    ],
  });
  const buf = await Packer.toArrayBuffer(doc);
  opts.onProgress?.(1, 'pack');
  return { bytes: new Uint8Array(buf), stats };
}
