// Converts rendered chat HTML back to Markdown for the DOM fallback path. It keeps code fences
// with their language, GFM tables, nested lists, links, images and KaTeX / Gemini math source.

const SKIP_TAGS = new Set(['BUTTON', 'SVG', 'STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'NAV', 'FORM']);

function fence(code: string, char = '`'): string {
  let max = 2;
  const re = new RegExp(`${char === '`' ? '`' : '~'}{3,}`, 'g');
  for (const m of code.match(re) ?? []) max = Math.max(max, m.length);
  return char.repeat(max + 1);
}

function inlineCode(text: string): string {
  let ticks = '`';
  while (text.includes(ticks)) ticks += '`';
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function detectLanguage(pre: Element): string {
  const code = pre.querySelector('code') ?? pre;
  const cls = `${code.className} ${pre.className}`;
  const m = cls.match(/(?:language|lang)-([\w+#.-]+)/);
  if (m) return m[1];
  const container = pre.closest('code-block, .code-block, [class*="code-block"]') ?? pre.parentElement;
  const label = container?.querySelector('.code-block-decoration, [class*="code-block-header"], [class*="lang"]')?.textContent?.trim();
  if (label && /^[\w+#.-]{1,20}$/.test(label)) return label.toLowerCase();
  return '';
}

function mathSource(el: Element): { tex: string; display: boolean } | null {
  const dataMath = el.getAttribute('data-math');
  if (dataMath != null) return { tex: dataMath, display: el.classList.contains('math-block') || el.tagName === 'DIV' };
  if (el.classList.contains('katex') || el.classList.contains('katex-display')) {
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    if (ann?.textContent) return { tex: ann.textContent.trim(), display: el.classList.contains('katex-display') || !!el.closest('.katex-display') };
  }
  if (el.tagName === 'MATH' || el.tagName.toLowerCase() === 'math') {
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    if (ann?.textContent) return { tex: ann.textContent.trim(), display: el.getAttribute('display') === 'block' };
  }
  return null;
}

/** UI chrome and screen-reader-only labels (e.g. "ChatGPT said:") are not message content. */
function skipped(el: Element): boolean {
  return SKIP_TAGS.has(el.tagName.toUpperCase()) || el.classList.contains('sr-only');
}

/**
 * Plain-text containers that render with preserved line breaks (user messages are usually shown
 * with white-space: pre-wrap). Their text is returned verbatim instead of being whitespace-folded.
 */
function preformattedText(el: Element): string | null {
  const style = (el as HTMLElement).style?.whiteSpace ?? '';
  if (!el.classList.contains('whitespace-pre-wrap') && !/^pre/.test(style)) return null;
  if (el.querySelector('p,pre,ul,ol,table,blockquote,h1,h2,h3,h4,h5,h6')) return null;
  return (el.textContent ?? '').replace(/\r\n?/g, '\n');
}

interface Ctx {
  listDepth: number;
}

function inline(node: Node, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\s+/g, ' ');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  if (skipped(el)) return '';
  const math = mathSource(el);
  if (math) return math.display ? `\n\n$$\n${math.tex}\n$$\n\n` : `$${math.tex}$`;
  const tag = el.tagName.toUpperCase();
  const kids = () => Array.from(el.childNodes).map((c) => inline(c, ctx)).join('');
  switch (tag) {
    case 'BR':
      return '\n';
    case 'STRONG':
    case 'B': {
      const t = kids().trim();
      return t ? `**${t}**` : '';
    }
    case 'EM':
    case 'I': {
      const t = kids().trim();
      return t ? `*${t}*` : '';
    }
    case 'DEL':
    case 'S':
      return `~~${kids()}~~`;
    case 'CODE':
      return inlineCode(el.textContent ?? '');
    case 'A': {
      const href = el.getAttribute('href') ?? '';
      const text = kids().trim() || href;
      return href && !href.startsWith('javascript:') ? `[${text}](${href})` : text;
    }
    case 'IMG': {
      const src = el.getAttribute('src') ?? '';
      if (!src || src.startsWith('blob:')) return '';
      return `![${el.getAttribute('alt') ?? ''}](${src})`;
    }
    case 'SUP':
      return `^${kids()}`;
    default:
      return kids();
  }
}

function tableToMd(table: Element, ctx: Ctx): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return '';
  const cell = (c: Element) => inline(c, ctx).replace(/\|/g, '\\|').replace(/\n+/g, '<br>').trim();
  const matrix = rows.map((r) => Array.from(r.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH').map(cell));
  const width = Math.max(...matrix.map((r) => r.length));
  const norm = matrix.map((r) => [...r, ...Array(width - r.length).fill('')]);
  const header = norm[0];
  const body = norm.slice(1);
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)];
  return lines.join('\n');
}

function listToMd(list: Element, ctx: Ctx): string {
  const ordered = list.tagName === 'OL';
  let n = Number(list.getAttribute('start') ?? '1') || 1;
  const indent = '   '.repeat(ctx.listDepth);
  const out: string[] = [];
  for (const li of Array.from(list.children).filter((c) => c.tagName === 'LI')) {
    const marker = ordered ? `${n++}.` : '-';
    const inner = blocks(li, { listDepth: ctx.listDepth + 1 }).trim();
    const [first, ...rest] = inner.split('\n');
    out.push(`${indent}${marker} ${first ?? ''}`);
    for (const line of rest) out.push(line.trim() ? `${indent}   ${line.replace(/^ {0,3}/, '')}` : '');
  }
  return out.join('\n');
}

function blocks(root: Element, ctx: Ctx): string {
  const parts: string[] = [];
  let inlineBuf = '';
  const flush = () => {
    const t = inlineBuf.replace(/[ \t]+\n/g, '\n').trim();
    if (t) parts.push(t);
    inlineBuf = '';
  };
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      inlineBuf += inline(node, ctx);
      continue;
    }
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (skipped(el)) continue;
    const math = mathSource(el);
    if (math && math.display) {
      flush();
      parts.push(`$$\n${math.tex}\n$$`);
      continue;
    }
    if (math) {
      inlineBuf += `$${math.tex}$`;
      continue;
    }
    const pre = preformattedText(el);
    if (pre != null) {
      flush();
      if (pre.trim()) parts.push(pre.replace(/^\n+|\s+$/g, ''));
      continue;
    }
    switch (tag) {
      case 'P':
        flush();
        parts.push(inline(el, ctx).trim());
        break;
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6':
        flush();
        parts.push(`${'#'.repeat(Number(tag[1]))} ${inline(el, ctx).trim()}`);
        break;
      case 'PRE': {
        flush();
        const code = (el.querySelector('code') ?? el).textContent ?? '';
        const f = fence(code);
        parts.push(`${f}${detectLanguage(el)}\n${code.replace(/\n$/, '')}\n${f}`);
        break;
      }
      case 'UL':
      case 'OL':
        flush();
        parts.push(listToMd(el, ctx));
        break;
      case 'TABLE':
        flush();
        parts.push(tableToMd(el, ctx));
        break;
      case 'BLOCKQUOTE':
        flush();
        parts.push(
          blocks(el, ctx)
            .split('\n')
            .map((l) => (l ? `> ${l}` : '>'))
            .join('\n'),
        );
        break;
      case 'HR':
        flush();
        parts.push('---');
        break;
      case 'DIV':
      case 'SECTION':
      case 'ARTICLE':
      case 'CODE-BLOCK':
      case 'MESSAGE-CONTENT':
      case 'FIGURE': {
        // Wrapper elements: treat as block containers when they contain block children.
        const hasBlock = el.querySelector('p,pre,ul,ol,table,h1,h2,h3,h4,h5,h6,blockquote,div');
        if (hasBlock) {
          flush();
          const inner = blocks(el, ctx);
          if (inner.trim()) parts.push(inner.trim());
        } else {
          inlineBuf += inline(el, ctx);
        }
        break;
      }
      default:
        inlineBuf += inline(el, ctx);
    }
  }
  flush();
  return parts.join('\n\n');
}

export function htmlToMarkdown(root: Element): string {
  const pre = preformattedText(root);
  if (pre != null) return pre.trim();
  return blocks(root, { listDepth: 0 })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
