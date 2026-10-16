// HWPX (OWPML, KS X 6101) header.xml generator. Character and paragraph shapes are registered
// on demand while the body is written, then emitted with stable ids. Element order follows the
// official OWPML schema (CharShapeType: fontRef, ratio, spacing, relSz, offset, italic, bold,
// underline, strikeout, outline, shadow).

export const NS_DECL =
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" ' +
  'xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" ' +
  'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" ' +
  'xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" ' +
  'xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" ' +
  'xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" ' +
  'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';

/** Font ids inside every language fontface list. */
export const FONT_BODY = 0;
export const FONT_MONO = 1;

export const BF_PAGE = 1;
export const BF_CHAR = 2;
export const BF_TABLE = 3;
export const BF_CODE = 4;
export const BF_TABLE_HEAD = 5;
export const BF_RULE_TOP = 6;
export const BF_QUOTE = 7;

export interface CharStyle {
  height?: number; // 1/100 pt (1000 = 10pt)
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  mono?: boolean;
  shade?: string;
}

export interface ParaStyle {
  align?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY';
  left?: number; // HWPUNIT
  intent?: number;
  prev?: number;
  next?: number;
  lineSpacing?: number; // percent
  keepWithNext?: boolean;
  borderFill?: number;
}

export class ShapeRegistry {
  private chars = new Map<string, { id: number; style: CharStyle }>();
  private paras = new Map<string, { id: number; style: ParaStyle }>();

  constructor() {
    this.char({}); // id 0 = 바탕글 character shape
    this.para({}); // id 0 = 바탕글 paragraph shape
  }

  char(style: CharStyle): number {
    const s: Required<CharStyle> = {
      height: style.height ?? 1000,
      color: style.color ?? '#1D1D1F',
      bold: !!style.bold,
      italic: !!style.italic,
      underline: !!style.underline,
      strike: !!style.strike,
      mono: !!style.mono,
      shade: style.shade ?? 'none',
    };
    const key = JSON.stringify(s);
    let entry = this.chars.get(key);
    if (!entry) {
      entry = { id: this.chars.size, style: s };
      this.chars.set(key, entry);
    }
    return entry.id;
  }

  para(style: ParaStyle): number {
    const s: Required<ParaStyle> = {
      align: style.align ?? 'JUSTIFY',
      left: style.left ?? 0,
      intent: style.intent ?? 0,
      prev: style.prev ?? 0,
      next: style.next ?? 600,
      lineSpacing: style.lineSpacing ?? 160,
      keepWithNext: !!style.keepWithNext,
      borderFill: style.borderFill ?? BF_CHAR,
    };
    const key = JSON.stringify(s);
    let entry = this.paras.get(key);
    if (!entry) {
      entry = { id: this.paras.size, style: s };
      this.paras.set(key, entry);
    }
    return entry.id;
  }

  charXml(): string {
    const items = [...this.chars.values()].sort((a, b) => a.id - b.id);
    return items.map(({ id, style }) => charPrXml(id, style as Required<CharStyle>)).join('');
  }

  paraXml(): string {
    const items = [...this.paras.values()].sort((a, b) => a.id - b.id);
    return items.map(({ id, style }) => paraPrXml(id, style as Required<ParaStyle>)).join('');
  }

  get charCount(): number {
    return this.chars.size;
  }

  get paraCount(): number {
    return this.paras.size;
  }
}

const LANGS = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'] as const;
const LANG_TAGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'] as const;

function langAttrs(v: number | string): string {
  return LANGS.map((l) => `${l}="${v}"`).join(' ');
}

function charPrXml(id: number, s: Required<CharStyle>): string {
  const font = s.mono ? FONT_MONO : FONT_BODY;
  return (
    `<hh:charPr id="${id}" height="${s.height}" textColor="${s.color}" shadeColor="${s.shade}" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="${BF_CHAR}">` +
    `<hh:fontRef ${langAttrs(font)}/>` +
    `<hh:ratio ${langAttrs(100)}/>` +
    `<hh:spacing ${langAttrs(0)}/>` +
    `<hh:relSz ${langAttrs(100)}/>` +
    `<hh:offset ${langAttrs(0)}/>` +
    (s.italic ? '<hh:italic/>' : '') +
    (s.bold ? '<hh:bold/>' : '') +
    `<hh:underline type="${s.underline ? 'BOTTOM' : 'NONE'}" shape="SOLID" color="${s.underline ? s.color : '#000000'}"/>` +
    `<hh:strikeout shape="${s.strike ? 'SOLID' : 'NONE'}" color="#000000"/>` +
    '<hh:outline type="NONE"/>' +
    '<hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/>' +
    '</hh:charPr>'
  );
}

function marginXml(s: Required<ParaStyle>, factor: number): string {
  return (
    '<hh:margin>' +
    `<hc:intent value="${s.intent}" unit="HWPUNIT"/>` +
    `<hc:left value="${s.left}" unit="HWPUNIT"/>` +
    '<hc:right value="0" unit="HWPUNIT"/>' +
    `<hc:prev value="${s.prev * factor}" unit="HWPUNIT"/>` +
    `<hc:next value="${s.next * factor}" unit="HWPUNIT"/>` +
    '</hh:margin>' +
    `<hh:lineSpacing type="PERCENT" value="${s.lineSpacing}" unit="HWPUNIT"/>`
  );
}

function paraPrXml(id: number, s: Required<ParaStyle>): string {
  return (
    `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">` +
    `<hh:align horizontal="${s.align}" vertical="BASELINE"/>` +
    '<hh:heading type="NONE" idRef="0" level="0"/>' +
    `<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="BREAK_WORD" widowOrphan="0" keepWithNext="${s.keepWithNext ? 1 : 0}" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>` +
    '<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>' +
    // Same pattern Hangul writes: the HwpUnitChar case uses half the paragraph spacing values.
    `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${marginXml(s, 1)}</hp:case>` +
    `<hp:default>${marginXml(s, 2)}</hp:default></hp:switch>` +
    `<hh:border borderFillIDRef="${s.borderFill}" offsetLeft="0" offsetRight="0" offsetTop="${s.borderFill === BF_RULE_TOP ? 600 : 0}" offsetBottom="0" connect="0" ignoreMargin="0"/>` +
    '</hh:paraPr>'
  );
}

function borderFill(id: number, opts: { left?: string; right?: string; top?: string; bottom?: string; fill?: string }): string {
  const line = (tag: string, color?: string) =>
    color ? `<hh:${tag} type="SOLID" width="0.12 mm" color="${color}"/>` : `<hh:${tag} type="NONE" width="0.1 mm" color="#000000"/>`;
  return (
    `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">` +
    '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
    line('leftBorder', opts.left) +
    line('rightBorder', opts.right) +
    line('topBorder', opts.top) +
    line('bottomBorder', opts.bottom) +
    '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>' +
    (opts.fill ? `<hc:fillBrush><hc:winBrush faceColor="${opts.fill}" hatchColor="#999999" alpha="0"/></hc:fillBrush>` : '') +
    '</hh:borderFill>'
  );
}

export function buildHeaderXml(reg: ShapeRegistry): string {
  const fontface = (tag: string) =>
    `<hh:fontface lang="${tag}" fontCnt="2">` +
    `<hh:font id="${FONT_BODY}" face="맑은 고딕" type="TTF" isEmbedded="0"/>` +
    `<hh:font id="${FONT_MONO}" face="${tag === 'LATIN' ? 'Consolas' : 'D2Coding'}" type="TTF" isEmbedded="0"/>` +
    '</hh:fontface>';
  const grid = '#C9C9CF';
  const borderFills = [
    borderFill(BF_PAGE, {}),
    borderFill(BF_CHAR, {}),
    borderFill(BF_TABLE, { left: grid, right: grid, top: grid, bottom: grid }),
    borderFill(BF_CODE, { left: '#E3E3E8', right: '#E3E3E8', top: '#E3E3E8', bottom: '#E3E3E8', fill: '#F6F7F9' }),
    borderFill(BF_TABLE_HEAD, { left: grid, right: grid, top: grid, bottom: grid, fill: '#F2F2F5' }),
    borderFill(BF_RULE_TOP, { top: '#E3E3E8' }),
    borderFill(BF_QUOTE, { left: '#D0D0D7' }),
  ];
  return (
    `${XML_DECL}<hh:head ${NS_DECL} version="1.5" secCnt="1">` +
    '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>' +
    '<hh:refList>' +
    `<hh:fontfaces itemCnt="7">${LANG_TAGS.map(fontface).join('')}</hh:fontfaces>` +
    `<hh:borderFills itemCnt="${borderFills.length}">${borderFills.join('')}</hh:borderFills>` +
    `<hh:charProperties itemCnt="${reg.charCount}">${reg.charXml()}</hh:charProperties>` +
    '<hh:tabProperties itemCnt="2"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/><hh:tabPr id="1" autoTabLeft="1" autoTabRight="0"/></hh:tabProperties>' +
    '<hh:numberings itemCnt="1"><hh:numbering id="1" start="0">' +
    Array.from(
      { length: 7 },
      (_, i) =>
        `<hh:paraHead start="1" level="${i + 1}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">^${i + 1}.</hh:paraHead>`,
    ).join('') +
    '</hh:numbering></hh:numberings>' +
    `<hh:paraProperties itemCnt="${reg.paraCount}">${reg.paraXml()}</hh:paraProperties>` +
    '<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles>' +
    '</hh:refList>' +
    '<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>' +
    '<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>' +
    '<hh:trackchageConfig flags="56"/>' +
    '</hh:head>'
  );
}
