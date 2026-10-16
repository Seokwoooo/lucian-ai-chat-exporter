// Shared Markdown front-end for every rich exporter (HTML/PDF, DOCX, HWPX, TXT). Uses `marked`'s
// lexer with GFM plus math tokenizers so each renderer walks the same token tree.

import { Marked, type Token, type Tokens, type TokenizerExtension } from 'marked';

export interface MathToken {
  type: 'mathBlock' | 'mathInline';
  raw: string;
  text: string;
}

const mathBlock: TokenizerExtension = {
  name: 'mathBlock',
  level: 'block',
  start(src: string) {
    const m = src.match(/^ {0,3}(\$\$|\\\[)/m);
    return m?.index;
  },
  tokenizer(src: string) {
    const m = src.match(/^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/) ?? src.match(/^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\n|$)/);
    if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() } as unknown as Tokens.Generic;
    return undefined;
  },
};

const mathInline: TokenizerExtension = {
  name: 'mathInline',
  level: 'inline',
  start(src: string) {
    const i = src.search(/\$|\\\(|\\\[/);
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    let m = src.match(/^\$\$([^$]+?)\$\$/);
    if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() } as unknown as Tokens.Generic;
    m = src.match(/^\\\[([\s\S]+?)\\\]/);
    if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() } as unknown as Tokens.Generic;
    m = src.match(/^\\\(([\s\S]+?)\\\)/);
    if (m) return { type: 'mathInline', raw: m[0], text: m[1].trim() } as unknown as Tokens.Generic;
    // $...$ : opening $ must be followed by a non-space, closing $ preceded by a non-space and not
    // followed by a digit (avoids treating "$5 and $10" as math).
    m = src.match(/^\$(?=\S)((?:\\\$|[^$\n])+?)(?<=\S)\$(?!\d)/);
    if (m) return { type: 'mathInline', raw: m[0], text: m[1] } as unknown as Tokens.Generic;
    return undefined;
  },
};

const markedStd = new Marked({ gfm: true, breaks: false, extensions: [mathBlock, mathInline] });
// User messages are plain text typed in a textarea: every newline is a real line break.
const markedBreaks = new Marked({ gfm: true, breaks: true, extensions: [mathBlock, mathInline] });

function stripCheckboxes(tokens: Token[]): void {
  for (const t of tokens) {
    if (t.type === 'list') {
      for (const item of (t as Tokens.List).items) {
        item.tokens = item.tokens.filter((x) => x.type !== 'checkbox');
        stripCheckboxes(item.tokens);
      }
    } else if (t.type === 'blockquote') {
      stripCheckboxes((t as Tokens.Blockquote).tokens);
    }
  }
}

/** Lexes Markdown. Task-list checkbox tokens are removed; renderers draw their own markers. */
export function lex(markdown: string, opts: { breaks?: boolean } = {}): Token[] {
  const tokens = (opts.breaks ? markedBreaks : markedStd).lexer(markdown ?? '');
  stripCheckboxes(tokens);
  return tokens;
}

export interface MdStats {
  tables: number;
  codeBlocks: number;
  math: number;
  images: number;
}

export function walkTokens(tokens: Token[], fn: (t: Token) => void): void {
  for (const t of tokens) {
    fn(t);
    const anyT = t as Tokens.Generic;
    if (Array.isArray(anyT.tokens)) walkTokens(anyT.tokens as Token[], fn);
    if (t.type === 'list') for (const item of (t as Tokens.List).items) walkTokens(item.tokens, fn);
    if (t.type === 'table') {
      const tt = t as Tokens.Table;
      for (const h of tt.header) walkTokens(h.tokens, fn);
      for (const row of tt.rows) for (const c of row) walkTokens(c.tokens, fn);
    }
  }
}

export function statsOf(tokens: Token[]): MdStats {
  const s: MdStats = { tables: 0, codeBlocks: 0, math: 0, images: 0 };
  walkTokens(tokens, (t) => {
    if (t.type === 'table') s.tables++;
    else if (t.type === 'code') s.codeBlocks++;
    else if (t.type === 'mathBlock' || t.type === 'mathInline') s.math++;
    else if (t.type === 'image') s.images++;
  });
  return s;
}

/** Inline images in Markdown text that are outside code (tech doc §20.3 / §26.3 embedInlineImages). */
export function inlineImageUrls(markdown: string): string[] {
  const urls: string[] = [];
  walkTokens(lex(markdown), (t) => {
    if (t.type === 'image') {
      const href = (t as Tokens.Image).href;
      if (href && /^(https?:|data:)/.test(href)) urls.push(href);
    }
  });
  return urls;
}

export type { Token, Tokens };
