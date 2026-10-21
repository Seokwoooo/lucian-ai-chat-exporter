// HWPX section0.xml writer: paragraphs, runs, hyperlink fields, tables and pictures.

import { attachmentName, t, formatBytes, type Locale } from '../../shared/i18n';
import { sourceDomain } from '../../shared/sites';
import type { Conversation, ExportContent, ExportMessage } from '../../shared/types';
import { escapeXml, formatDateTime } from '../../shared/util';
import { EMBEDDABLE, fitSize, type ImageStore } from '../images';
import { messageHeaderText, toolDocText } from '../markdown';
import { lex, type Token, type Tokens } from '../md-parse';
import {
  BF_CODE,
  BF_QUOTE,
  BF_RULE_TOP,
  BF_TABLE,
  BF_TABLE_HEAD,
  NS_DECL,
  XML_DECL,
  type CharStyle,
  type ShapeRegistry,
} from './header';

/** A4 portrait with 30mm/20mm margins, in HWPUNIT (1/7200 inch). */
const PAGE_W = 59528;
const PAGE_H = 84186;
const MARGIN_LR = 7086;
export const TEXT_WIDTH = PAGE_W - MARGIN_LR * 2;
const PX_TO_HWP = 75; // 7200 / 96

export interface HwpxImage {
  id: string;
  path: string;
  mime: string;
  bytes: Uint8Array;
}

export interface HwpxStats {
  messages: number;
  tables: number;
  codeBlocks: number;
  math: number;
  images: number;
  imagesEmbedded: number;
  imagesMissing: number;
  paragraphs: number;
}

type Run = { charPr: number; xml: string };

interface CellContent {
  paras: string[];
  /** Estimated content height in HWPUNIT (without cell padding). */
  height: number;
}

const CELL_PAD_H = 510;
const CELL_PAD_V = 283;

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

/** Rough line count for text set at `fontHeight` (HWPUNIT) in `avail` width. */
export function estimateLines(text: string, fontHeight: number, avail: number, mono: boolean): number {
  if (!text) return 1;
  let total = 0;
  for (const line of text.split('\n')) {
    let w = 0;
    for (const ch of line) w += isWide(ch.codePointAt(0) ?? 0) ? fontHeight : fontHeight * (mono ? 0.6 : 0.55);
    total += Math.max(1, Math.ceil(w / Math.max(1000, avail)));
  }
  return total;
}

function plainText(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  return tokens
    .map((t) => {
      const g = t as Tokens.Generic;
      if (t.type === 'image') return '';
      if (Array.isArray(g.tokens)) return plainText(g.tokens as Token[]);
      return typeof g.text === 'string' ? g.text : '';
    })
    .join('');
}

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
  color?: string;
  height?: number;
}

const BASE_COLOR = '#1D1D1F';
const MUTED = '#6E6E73';
const LINK = '#3A3AD6';

export class SectionWriter {
  private parts: string[] = [];
  private nextId = 1;
  private objectId = 1000;
  readonly binItems: HwpxImage[] = [];
  private binByUrl = new Map<string, HwpxImage>();
  readonly stats: HwpxStats = { messages: 0, tables: 0, codeBlocks: 0, math: 0, images: 0, imagesEmbedded: 0, imagesMissing: 0, paragraphs: 0 };

  constructor(
    private reg: ShapeRegistry,
    private locale: Locale,
    private images: ImageStore,
  ) {}

  private charId(s: InlineStyle): number {
    const cs: CharStyle = {
      height: s.height ?? (s.code ? 920 : 1000),
      color: s.link ? LINK : s.color ?? BASE_COLOR,
      bold: s.bold,
      italic: s.italic,
      strike: s.strike,
      underline: s.link,
      mono: s.code,
      shade: s.code ? '#F1F2F4' : undefined,
    };
    return this.reg.char(cs);
  }

  textRun(text: string, s: InlineStyle = {}): Run {
    // A newline inside a Markdown text token is a soft break and renders as a space.
    return { charPr: this.charId(s), xml: `<hp:t>${escapeXml(text.replace(/\r?\n/g, ' '))}</hp:t>` };
  }

  paragraph(runs: Run[], paraPr: number): string {
    this.stats.paragraphs++;
    const body = runs.length ? runs.map((r) => `<hp:run charPrIDRef="${r.charPr}">${r.xml}</hp:run>`).join('') : `<hp:run charPrIDRef="0"><hp:t/></hp:run>`;
    return `<hp:p id="${this.nextId++}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${body}</hp:p>`;
  }

  push(xml: string): void {
    this.parts.push(xml);
  }

  // ---------- inline ----------

  private hyperlink(url: string, children: Run[]): Run[] {
    const id = this.objectId++;
    const cmd = `${url.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/\?/g, '\\?').replace(/;/g, '\\;')};1;5;-1;`;
    const begin =
      `<hp:ctrl><hp:fieldBegin id="${id}" type="HYPERLINK" name="" editable="0" dirty="1" zorder="-1" fieldid="${id}" metaTag="">` +
      '<hp:parameters cnt="6" name="">' +
      '<hp:integerParam name="Prop">0</hp:integerParam>' +
      `<hp:stringParam name="Command">${escapeXml(cmd)}</hp:stringParam>` +
      `<hp:stringParam name="Path">${escapeXml(url)}</hp:stringParam>` +
      '<hp:stringParam name="Category">HWPHYPERLINK_TYPE_URL</hp:stringParam>' +
      '<hp:stringParam name="TargetType">HWPHYPERLINK_TARGET_HYPERLINK</hp:stringParam>' +
      '<hp:stringParam name="DocOpenType">HWPHYPERLINK_JUMP_DONTCARE</hp:stringParam>' +
      '</hp:parameters></hp:fieldBegin></hp:ctrl>';
    const end = `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="${id}"/></hp:ctrl>`;
    return [{ charPr: 0, xml: begin }, ...children, { charPr: 0, xml: end }];
  }

  picture(url: string): Run[] {
    this.stats.images++;
    const img = this.images.get(url);
    if (!img || !EMBEDDABLE.has(img.mime)) {
      this.stats.imagesMissing++;
      const label = `[${t(this.locale, 'doc.imageMissing')}]`;
      const runs = [this.textRun(label, { italic: true, color: MUTED })];
      if (/^https?:/i.test(url)) runs.push(this.textRun(' '), ...this.hyperlink(url, [this.textRun(url, { link: true })]));
      return runs;
    }
    this.stats.imagesEmbedded++;
    let bin = this.binByUrl.get(url);
    if (!bin) {
      const n = this.binItems.length + 1;
      const ext = img.mime === 'image/jpeg' ? 'jpg' : img.mime === 'image/gif' ? 'gif' : img.mime === 'image/bmp' ? 'bmp' : 'png';
      bin = { id: `image${n}`, path: `BinData/image${n}.${ext}`, mime: img.mime, bytes: img.bytes };
      this.binItems.push(bin);
      this.binByUrl.set(url, bin);
    }
    const size = fitSize(img, Math.floor(TEXT_WIDTH / PX_TO_HWP));
    const w = size.width * PX_TO_HWP;
    const h = size.height * PX_TO_HWP;
    const id = this.objectId++;
    const xml =
      `<hp:pic id="${id}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id}" reverse="0">` +
      '<hp:offset x="0" y="0"/>' +
      `<hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/>` +
      '<hp:flip horizontal="0" vertical="0"/>' +
      `<hp:rotationInfo angle="0" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}" rotateimage="1"/>` +
      '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>' +
      `<hc:img binaryItemIDRef="${bin.id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
      `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>` +
      '<hp:imgClip left="0" right="0" top="0" bottom="0"/>' +
      '<hp:inMargin left="0" right="0" top="0" bottom="0"/>' +
      '<hp:imgDim dimwidth="0" dimheight="0"/>' +
      '<hp:effects/>' +
      `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>` +
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
      '<hp:outMargin left="0" right="0" top="0" bottom="0"/>' +
      '<hp:shapeComment/>' +
      '</hp:pic>';
    return [{ charPr: 0, xml }];
  }

  inline(tokens: Token[] | undefined, s: InlineStyle = {}): Run[] {
    if (!tokens) return [];
    const out: Run[] = [];
    for (const tok of tokens) {
      switch (tok.type) {
        case 'text': {
          const tt = tok as Tokens.Text;
          if (tt.tokens) out.push(...this.inline(tt.tokens, s));
          else out.push(this.textRun(tt.text, s));
          break;
        }
        case 'escape':
          out.push(this.textRun((tok as Tokens.Escape).text, s));
          break;
        case 'strong':
          out.push(...this.inline((tok as Tokens.Strong).tokens, { ...s, bold: true }));
          break;
        case 'em':
          out.push(...this.inline((tok as Tokens.Em).tokens, { ...s, italic: true }));
          break;
        case 'del':
          out.push(...this.inline((tok as Tokens.Del).tokens, { ...s, strike: true }));
          break;
        case 'codespan':
          out.push(this.textRun((tok as Tokens.Codespan).text, { ...s, code: true }));
          break;
        case 'br':
          out.push({ charPr: this.charId(s), xml: '<hp:t><hp:lineBreak/></hp:t>' });
          break;
        case 'link': {
          const l = tok as Tokens.Link;
          const children = this.inline(l.tokens, { ...s, link: true });
          if (/^(https?:|mailto:)/i.test(l.href) && children.every((c) => c.xml.startsWith('<hp:t>'))) out.push(...this.hyperlink(l.href, children));
          else out.push(...children);
          break;
        }
        case 'image':
          out.push(...this.picture((tok as Tokens.Image).href));
          break;
        case 'html':
          out.push(this.textRun((tok as Tokens.HTML).text, s));
          break;
        case 'mathInline':
          this.stats.math++;
          out.push(this.textRun(`$${(tok as unknown as { text: string }).text}$`, { ...s, code: true }));
          break;
        case 'mathBlock':
          this.stats.math++;
          out.push(this.textRun(`$$${(tok as unknown as { text: string }).text}$$`, { ...s, code: true }));
          break;
        default:
          out.push(this.textRun((tok as { raw?: string }).raw ?? '', s));
      }
    }
    return out;
  }

  // ---------- tables / code boxes ----------

  private cell(c: CellContent, col: number, row: number, width: number, height: number, header: boolean, borderFill: number): string {
    return (
      `<hp:tc name="" header="${header ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${borderFill}">` +
      `<hp:subList id="${this.objectId++}" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
      c.paras.join('') +
      '</hp:subList>' +
      `<hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="1" rowSpan="1"/>` +
      `<hp:cellSz width="${width}" height="${height}"/><hp:cellMargin left="${CELL_PAD_H}" right="${CELL_PAD_H}" top="${CELL_PAD_V}" bottom="${CELL_PAD_V}"/>` +
      '</hp:tc>'
    );
  }

  /**
   * Emits a table. Row heights are estimated from the cell text so viewers that trust the stored
   * layout sizes do not overlap following paragraphs; Hangul grows rows to fit content anyway.
   */
  private table(rows: CellContent[][], opts: { headerRow: boolean; borderFill: number; headerFill?: number; indent?: number }): string {
    const rowCnt = rows.length;
    const colCnt = Math.max(1, ...rows.map((r) => r.length));
    const total = TEXT_WIDTH - (opts.indent ?? 0);
    const widths = Array.from({ length: colCnt }, () => Math.floor(total / colCnt));
    const sum = widths.reduce((a, b) => a + b, 0);
    const empty = (): CellContent => ({ paras: [this.paragraph([], this.reg.para({ next: 0 }))], height: 1500 });
    const heights = rows.map((r) => Math.max(1000, ...Array.from({ length: colCnt }, (_, ci) => (r[ci]?.height ?? 1500) + CELL_PAD_V * 2)));
    const trs = rows
      .map((r, ri) => {
        const cells = Array.from({ length: colCnt }, (_, ci) => {
          const header = opts.headerRow && ri === 0;
          return this.cell(r[ci] ?? empty(), ci, ri, widths[ci], heights[ri], header, header ? opts.headerFill ?? opts.borderFill : opts.borderFill);
        });
        return `<hp:tr>${cells.join('')}</hp:tr>`;
      })
      .join('');
    const id = this.objectId++;
    const tbl =
      `<hp:tbl id="${id}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="${opts.headerRow ? 1 : 0}" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="${opts.borderFill}" noAdjust="0">` +
      `<hp:sz width="${sum}" widthRelTo="ABSOLUTE" height="${heights.reduce((a, b) => a + b, 0)}" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="${opts.indent ?? 0}"/>` +
      '<hp:outMargin left="0" right="0" top="0" bottom="600"/>' +
      `<hp:inMargin left="${CELL_PAD_H}" right="${CELL_PAD_H}" top="${CELL_PAD_V}" bottom="${CELL_PAD_V}"/>` +
      trs +
      '</hp:tbl>';
    return this.paragraph([{ charPr: 0, xml: tbl }], this.reg.para({ next: 400 }));
  }

  codeBox(code: string, caption: string | undefined, indent = 0): string {
    this.stats.codeBlocks++;
    const linePara = this.reg.para({ align: 'LEFT', next: 0, lineSpacing: 140 });
    const lines = code.replace(/\n$/, '').replace(/\t/g, '    ').split('\n');
    const avail = TEXT_WIDTH - (indent ?? 0) - CELL_PAD_H * 2;
    const paras: string[] = [];
    let height = 0;
    if (caption) {
      paras.push(this.paragraph([this.textRun(caption, { code: true, color: MUTED, height: 800 })], this.reg.para({ align: 'LEFT', next: 200 })));
      height += 800 * 1.6 + 400;
    }
    for (const line of lines) {
      paras.push(this.paragraph(line ? [this.textRun(line, { code: true, height: 900 })] : [], linePara));
      height += estimateLines(line, 900, avail, true) * 900 * 1.4;
    }
    return this.table([[{ paras, height: Math.ceil(height) }]], { headerRow: false, borderFill: BF_CODE, indent });
  }

  gfmTable(tb: Tokens.Table): string {
    this.stats.tables++;
    const cols = Math.max(1, tb.header.length);
    const avail = Math.floor(TEXT_WIDTH / cols) - CELL_PAD_H * 2;
    const align = (i: number) => (tb.align[i] === 'center' ? 'CENTER' : tb.align[i] === 'right' ? 'RIGHT' : 'LEFT');
    const cell = (tokens: Token[], i: number, header: boolean): CellContent => ({
      paras: [this.paragraph(this.inline(tokens, header ? { bold: true } : {}), this.reg.para({ align: align(i), next: 0, lineSpacing: 150 }))],
      height: Math.ceil(estimateLines(plainText(tokens), 1000, avail, false) * 1000 * 1.5),
    });
    const rows: CellContent[][] = [tb.header.map((h, i) => cell(h.tokens, i, true)), ...tb.rows.map((r) => r.map((c, i) => cell(c.tokens, i, false)))];
    return this.table(rows, { headerRow: true, borderFill: BF_TABLE, headerFill: BF_TABLE_HEAD });
  }

  // ---------- blocks ----------

  blocks(tokens: Token[], level = 0, quote = false): void {
    const indent = level * 1600 + (quote ? 1200 : 0);
    const color = quote ? MUTED : undefined;
    const body = this.reg.para({ left: indent, borderFill: quote ? BF_QUOTE : undefined });
    for (const tok of tokens) {
      switch (tok.type) {
        case 'space':
          break;
        case 'paragraph':
        case 'text': {
          const p = tok as Tokens.Paragraph;
          const images = (p.tokens ?? []).filter((x) => x.type === 'image') as Tokens.Image[];
          const hasText = (p.tokens ?? []).some((x) => x.type !== 'image' && (x.raw ?? '').trim().length > 0);
          if (images.length && hasText) {
            // Large pictures are laid out as characters in HWPX; give each its own paragraph so it
            // never overflows the text line it was written in.
            this.push(this.paragraph(this.inline(p.tokens.filter((x) => x.type !== 'image'), { color }), body));
            for (const img of images) this.push(this.paragraph(this.picture(img.href), this.reg.para({ left: indent, align: 'LEFT' })));
            break;
          }
          const runs = p.tokens ? this.inline(p.tokens, { color }) : [this.textRun(p.text, { color })];
          this.push(this.paragraph(runs, body));
          break;
        }
        case 'heading': {
          const h = tok as Tokens.Heading;
          const size = [1400, 1250, 1120, 1050, 1000, 1000][Math.min(5, h.depth - 1)];
          this.push(this.paragraph(this.inline(h.tokens, { bold: true, height: size }), this.reg.para({ left: indent, prev: 600, next: 300, keepWithNext: true, align: 'LEFT' })));
          break;
        }
        case 'code': {
          const c = tok as Tokens.Code;
          this.push(this.codeBox(c.text, c.lang?.trim().split(/\s+/)[0] || undefined, indent));
          break;
        }
        case 'blockquote':
          this.blocks((tok as Tokens.Blockquote).tokens, level, true);
          break;
        case 'list': {
          const l = tok as Tokens.List;
          let n = l.ordered ? Number(l.start || 1) : 0;
          for (const item of l.items) {
            const marker = l.ordered ? `${n++}. ` : ['• ', '◦ ', '▪ '][level % 3];
            const task = item.task ? (item.checked ? '☑ ' : '☐ ') : '';
            const [first, ...rest] = item.tokens.filter((x) => x.type !== 'space');
            const isText = first && (first.type === 'text' || first.type === 'paragraph');
            const runs = isText ? ((first as Tokens.Text).tokens ? this.inline((first as Tokens.Text).tokens, { color }) : [this.textRun((first as Tokens.Text).text, { color })]) : [];
            const itemPara = this.reg.para({ left: indent + 1600, intent: -1000, next: 200, align: 'LEFT', borderFill: quote ? BF_QUOTE : undefined });
            this.push(this.paragraph([this.textRun(marker + task, { color }), ...runs], itemPara));
            this.blocks((isText ? rest : [first, ...rest].filter(Boolean)) as Token[], level + 1, quote);
          }
          break;
        }
        case 'table':
          this.push(this.gfmTable(tok as Tokens.Table));
          break;
        case 'hr':
          this.push(this.paragraph([], this.reg.para({ borderFill: BF_RULE_TOP, next: 300 })));
          break;
        case 'html':
          this.push(this.paragraph([this.textRun((tok as Tokens.HTML).text, { color })], body));
          break;
        case 'mathBlock':
          this.stats.math++;
          this.push(this.paragraph([this.textRun(`$$${(tok as unknown as { text: string }).text}$$`, { code: true })], this.reg.para({ align: 'CENTER' })));
          break;
        default: {
          const g = tok as Tokens.Generic;
          if (g.raw?.trim()) this.push(this.paragraph([this.textRun(g.raw, { color })], body));
        }
      }
    }
  }

  caption(text: string): void {
    this.push(this.paragraph([this.textRun(text, { bold: true, color: '#4A4A50', height: 950 })], this.reg.para({ next: 200, keepWithNext: true, align: 'LEFT' })));
  }

  content(c: ExportContent): void {
    const L = this.locale;
    switch (c.type) {
      case 'text':
      case 'markdown':
        this.blocks(lex(c.content ?? '', { breaks: c.type === 'text' }));
        break;
      case 'thinking':
        break;
      case 'code':
        this.push(this.codeBox(c.content ?? '', [c.title, c.language].filter(Boolean).join(' · ') || undefined));
        break;
      case 'tool':
        this.caption(`${t(L, 'doc.tool')} · ${c.title ?? ''}`);
        this.push(this.codeBox(toolDocText(c.content ?? '', L), c.language));
        break;
      case 'artifact':
      case 'html_widget':
        this.caption(`${t(L, 'doc.artifact')} · ${c.title ?? ''}`);
        this.push(this.codeBox(c.content ?? '', c.type === 'html_widget' ? 'html' : c.language));
        break;
      case 'image':
        if (c.imageUrl) this.push(this.paragraph(this.picture(c.imageUrl), this.reg.para({ align: 'LEFT' })));
        break;
      case 'image_group':
        for (const img of c.imageGroup?.images ?? []) {
          const url = img.imageUrl ?? img.thumbnailUrl;
          if (url) this.push(this.paragraph(this.picture(url), this.reg.para({ align: 'LEFT' })));
        }
        break;
      case 'attachment': {
        const a = c.attachment ?? {};
        const meta = [a.mime_type, a.size ? formatBytes(a.size) : ''].filter(Boolean).join(', ');
        this.push(
          this.paragraph(
            [this.textRun(`${t(L, 'doc.attachment')}: `, { color: MUTED }), this.textRun(attachmentName(a, L), { bold: true }), ...(meta ? [this.textRun(` (${meta})`, { color: MUTED })] : [])],
            this.reg.para({}),
          ),
        );
        if (a.extractedText) {
          this.caption(t(L, 'doc.extractedText'));
          this.push(this.codeBox(a.extractedText, undefined));
        }
        break;
      }
      case 'sources': {
        const list = c.sources ?? [];
        if (!list.length) break;
        this.caption(t(L, 'doc.sources'));
        list.forEach((s, i) => {
          const label = this.textRun(s.title || s.url, { link: /^https?:/i.test(s.url), height: 920 });
          const runs = /^https?:/i.test(s.url) ? this.hyperlink(s.url, [label]) : [label];
          this.push(this.paragraph([this.textRun(`${i + 1}. `, { height: 920 }), ...runs], this.reg.para({ next: 100, align: 'LEFT' })));
        });
        break;
      }
    }
  }

  message(conv: Conversation, msg: ExportMessage): void {
    this.stats.messages++;
    this.push(
      this.paragraph(
        [this.textRun(messageHeaderText(conv, msg, this.locale), { bold: true, height: 1150 })],
        this.reg.para({ borderFill: BF_RULE_TOP, prev: 900, next: 400, keepWithNext: true, align: 'LEFT' }),
      ),
    );
    for (const c of msg.contents) this.content(c);
    if (msg.truncated) this.push(this.paragraph([this.textRun(t(this.locale, 'doc.truncated'), { italic: true, color: MUTED })], this.reg.para({})));
  }

  documentHead(conv: Conversation, exportedAt: number): void {
    const L = this.locale;
    const meta = [
      `${t(L, 'doc.source')}: ${sourceDomain(conv)}`,
      `${t(L, 'doc.exportedAt')}: ${formatDateTime(exportedAt)}`,
      `${t(L, 'doc.messages')}: ${conv.messages.length}`,
    ].filter(Boolean);
    this.push(this.paragraph([this.textRun(conv.title || conv.siteName, { bold: true, height: 1800 })], this.reg.para({ next: 300, align: 'LEFT' })));
    this.push(this.paragraph([this.textRun(meta.join('   ·   '), { color: MUTED, height: 900 })], this.reg.para({ next: 100, align: 'LEFT' })));
    this.push(this.paragraph(this.hyperlink(conv.fromUrl, [this.textRun(conv.fromUrl, { link: true, height: 900 })]), this.reg.para({ next: 600, align: 'LEFT' })));
  }

  /** First paragraph carries the section definition (page size, margins) as Hangul expects. */
  private sectionDefinition(): string {
    const secPr =
      '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">' +
      '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>' +
      '<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>' +
      '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>' +
      '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>' +
      `<hp:pagePr landscape="WIDELY" width="${PAGE_W}" height="${PAGE_H}" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="${MARGIN_LR}" right="${MARGIN_LR}" top="5668" bottom="4252"/></hp:pagePr>` +
      '<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>' +
      '<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>' +
      ['BOTH', 'EVEN', 'ODD']
        .map(
          (type) =>
            `<hp:pageBorderFill type="${type}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`,
        )
        .join('') +
      '</hp:secPr>';
    const ctrl = '<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>';
    return `<hp:p id="${this.nextId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${secPr}${ctrl}</hp:run><hp:run charPrIDRef="0"><hp:t/></hp:run></hp:p>`;
  }

  toXml(): string {
    const first = this.sectionDefinition();
    return `${XML_DECL}<hs:sec ${NS_DECL}>${first}${this.parts.join('')}</hs:sec>`;
  }
}
