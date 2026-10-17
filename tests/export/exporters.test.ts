import { mkdirSync, writeFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { renderMathMl } from '../../src/export/math';
import { conversationToMarkdown } from '../../src/export/markdown';
import { runExport, type PipelineInput } from '../../src/export/pipeline';
import { markdownToTxt } from '../../src/export/txt';
import { scanXmlWellFormed } from '../../src/export/verify';
import type { AssetStatus } from '../../src/shared/messages';
import type { ExportFormat } from '../../src/shared/types';
import { handoffFilename } from '../../src/shared/util';
import { IMG_A, IMG_B, IMG_MISSING, sampleConversation, sampleImages } from '../fixtures/sample-conversation';

const win = new Window();
const parser = new win.DOMParser();
const assets: AssetStatus[] = [
  { key: IMG_A, kind: 'image', ok: true, mime: 'image/png' },
  { key: IMG_B, kind: 'image', ok: true, mime: 'image/png' },
  { key: IMG_MISSING, kind: 'image', ok: false, error: 'HTTP 404' },
];

function input(format: Exclude<ExportFormat, 'pdf'>): PipelineInput {
  const images = sampleImages();
  return {
    conv: sampleConversation(),
    format,
    locale: 'ko',
    embeddable: images,
    raw: images,
    assetStatus: assets.map((a) => ({ ...a })),
    renderMath: renderMathMl,
    parseXml: (s) => parser.parseFromString(s, 'application/xml') as unknown as Document,
    parseHtml: (s) => parser.parseFromString(s, 'text/html') as unknown as Document,
    exportedAt: Date.UTC(2026, 9, 16),
  };
}

mkdirSync('test-output', { recursive: true });

describe('markdown serializer', () => {
  const md = conversationToMarkdown(sampleConversation(), { locale: 'ko' }).text;
  it('keeps code fences with language and content containing backticks', () => {
    expect(md).toContain('```ts\nexport function fib');
    expect(md).toContain('\tif (n < 2) return n;');
    expect(md).toMatch(/````markdown\n# Title\n\nSome text with ```code``` fence\.\n````/);
  });
  it('keeps tables, math, links and image references', () => {
    expect(md).toContain('| 메모이제이션 | $O(n)$ | **권장** |');
    expect(md).toContain('$$\nF_n = ');
    expect(md).toContain('[MDN 링크](https://developer.mozilla.org/)');
    expect(md).toContain(`![chart](${IMG_B})`);
  });
  it('excludes thinking by default and lists sources and attachments', () => {
    expect(md).not.toContain('사용자는 재귀 구현을 원한다');
    expect(md).toContain('1. [Fibonacci sequence - Wikipedia](https://en.wikipedia.org/wiki/Fibonacci_sequence)');
    expect(md).toContain('첨부파일: **requirements.txt** (text/plain, 2.0 KB)');
  });
});

describe('file names and pasted text (v1.3.5)', () => {
  it('puts the conversation title in front of the handoff file name', () => {
    const now = Date.UTC(2026, 9, 18, 3, 0, 0);
    expect(handoffFilename('Garden watering schedule', now)).toBe('Garden-watering-schedule-lucian-handoff-2026-10-18.md');
    expect(handoffFilename('텃밭 일정/물주기: 정리?', now)).toBe('텃밭-일정물주기-정리-lucian-handoff-2026-10-18.md');
    expect(handoffFilename('', now)).toBe('lucian-handoff-2026-10-18.md');
    expect(handoffFilename(undefined, now)).toBe('lucian-handoff-2026-10-18.md');
    const long = handoffFilename('가'.repeat(300), now);
    expect(long).toBe(`${'가'.repeat(50)}-lucian-handoff-2026-10-18.md`);
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(200);
    expect(new TextEncoder().encode(handoffFilename('😀'.repeat(100), now)).length).toBeLessThanOrEqual(200);
  });

  it('labels a nameless attachment (Claude pasted text) instead of leaving the name empty', () => {
    const conv = sampleConversation();
    conv.messages[0].contents.push({ type: 'attachment', attachment: { name: '', mime_type: 'txt', size: 4241, extractedText: '붙여넣은 메모의 첫 줄입니다.' } });
    const md = conversationToMarkdown(conv, { locale: 'ko' }).text;
    expect(md).toContain('첨부파일: **붙여넣은 텍스트** (txt, 4.1 KB)');
    expect(md).toContain('추출된 텍스트 — 붙여넣은 텍스트');
    expect(md).not.toContain('****');
    expect(conversationToMarkdown(conv, { locale: 'en' }).text).toContain('**Pasted text**');
  });
});

describe('math', () => {
  it('renders LaTeX to MathML and reports failures', () => {
    expect(renderMathMl('\\frac{1}{2}', false)).toContain('<math');
    expect(renderMathMl('\\frac{1}{', false)).toBeNull();
  });
});

describe('txt', () => {
  it('flattens markdown but keeps code and table cells', () => {
    const txt = markdownToTxt('# T\n\n**bold** [l](https://x.y)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nx()\n```');
    expect(txt).toContain('bold l (https://x.y)');
    expect(txt).toContain('a | b');
    expect(txt).toContain('[js]\nx()');
  });
});

describe.each(['md', 'txt', 'json', 'html', 'docx', 'hwpx', 'zip'] as const)('export %s', (format) => {
  it('builds a structurally valid file and reports gaps honestly', async () => {
    const out = await runExport(input(format));
    writeFileSync(`test-output/sample.${format}`, out.bytes);
    expect(out.bytes.byteLength).toBeGreaterThan(200);
    const codes = out.verification.checks.map((c) => `${c.status}:${c.code}`);
    expect(codes).toContain('pass:output.ok');
    expect(codes).toContain('pass:messages.match');
    if (['html', 'docx', 'hwpx', 'zip'].includes(format)) {
      expect(codes).toContain('warn:images.missing');
      expect(out.verification.level).toBe('warning');
    } else {
      expect(codes).toContain('info:images.linked');
    }
    expect(codes).toContain(format === 'json' ? 'info:thinking.kept' : 'info:thinking.excluded');
    expect(codes).toContain(format === 'json' || format === 'zip' ? 'info:branches.saved' : 'info:branches.note');
    if (format === 'docx' || format === 'hwpx' || format === 'txt') expect(codes).toContain('info:math.latex');
    if (format === 'html' || format === 'zip') expect(codes).toContain('pass:math.rendered');
  });
});

describe('format specifics', () => {
  it('html escapes raw HTML from messages and embeds images as data URLs', async () => {
    const html = new TextDecoder().decode((await runExport(input('html'))).bytes);
    expect(html).toContain('&lt;div&gt;태그&lt;/div&gt;');
    expect(html).not.toContain('<div>태그</div>');
    expect(html).toMatch(/<img src="data:image\/png;base64,/);
    expect(html).toContain('<math');
    expect((html.match(/<section class="msg /g) ?? []).length).toBe(4);
  });

  it('docx contains real tables, hyperlinks and embedded pictures', async () => {
    const files = unzipSync((await runExport(input('docx'))).bytes);
    const doc = strFromU8(files['word/document.xml']);
    expect((doc.match(/<w:tbl>/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(doc).toContain('<w:hyperlink');
    expect(Object.keys(files).filter((f) => /^word\/media\/.+\.png$/.test(f)).length).toBe(2);
    expect(doc).toContain('xml:space="preserve"');
  });

  it('hwpx is an OCF package with an uncompressed mimetype first and BinData pictures', async () => {
    const bytes = (await runExport(input('hwpx'))).bytes;
    expect(new TextDecoder().decode(bytes.subarray(30, 38))).toBe('mimetype');
    const files = unzipSync(bytes);
    expect(strFromU8(files.mimetype)).toBe('application/hwp+zip');
    expect(Object.keys(files).filter((f) => f.startsWith('BinData/')).length).toBe(2);
    const section = strFromU8(files['Contents/section0.xml']);
    expect(section).toContain('<hp:tbl ');
    expect(section).toContain('HYPERLINK');
    expect(section).toContain('日本語のテキスト');
  });

  it('zip backup contains conversation files, images and the verification report', async () => {
    const files = unzipSync((await runExport(input('zip'))).bytes);
    const names = Object.keys(files);
    const root = names[0].split('/')[0];
    for (const f of ['conversation.md', 'conversation.html', 'conversation.json', 'verification-report.md', 'verification-report.json', 'images/image-001.png', 'images/image-002.png']) {
      expect(names).toContain(`${root}/${f}`);
    }
    const md = strFromU8(files[`${root}/conversation.md`]);
    expect(md).toContain('![screenshot](images/image-001.png)');
    expect(md).toContain('![chart](images/image-002.png)');
    expect(md).toContain(`![old](${IMG_MISSING})`);
    const report = strFromU8(files[`${root}/verification-report.md`]);
    expect(report).toMatch(/이미지 1\/3개를 가져오지 못했습니다/);
  });

  it('json keeps the full conversation including thinking and branches', async () => {
    const data = JSON.parse(new TextDecoder().decode((await runExport(input('json'))).bytes));
    expect(data.schema).toBe('lucian.conversation/v1');
    expect(data.conversation.messages[1].contents[0].type).toBe('thinking');
    expect(data.conversation.otherBranchMessages.length).toBe(1);
  });
});

describe('long tool output', () => {
  it('is shortened in documents with a visible note, but kept whole in JSON', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} of a fetched page`).join('\n');
    const withTool = (format: 'md' | 'docx' | 'json'): PipelineInput => {
      const base = input(format);
      const conv = base.conv;
      conv.messages[1].contents.push({ type: 'tool', title: 'WebFetch · result', content: long });
      return base;
    };
    const md = await runExport(withTool('md'));
    const text = strFromU8(md.bytes);
    expect(text).toContain('line 10 of a fetched page');
    expect(text).not.toContain('line 399 of a fetched page');
    expect(text).toMatch(/[\d,]+자 생략 — 전체 내용은 JSON·ZIP 백업에 있습니다/);
    expect(md.verification.checks.map((c) => `${c.status}:${c.code}`)).toContain('info:tools.clipped');
    const docx = await runExport(withTool('docx'));
    const xml = strFromU8(unzipSync(docx.bytes)['word/document.xml']);
    expect(xml).not.toContain('line 399 of a fetched page');
    const json = await runExport(withTool('json'));
    expect(strFromU8(json.bytes)).toContain('line 399 of a fetched page');
    expect(json.verification.checks.some((c) => c.code === 'tools.clipped')).toBe(false);
  });
});

describe('streaming XML well-formedness scan (large documents)', () => {
  it('accepts well-formed XML and agrees with DOMParser on broken documents', async () => {
    const good = [
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t xml:space="preserve">a &amp; b &lt;c&gt; &#44032;</w:t></w:r></w:p><w:p/></w:body></w:document>',
      '<root a="1 > 0" b=\'x\'><!-- c --><![CDATA[<raw & text>]]><x/></root>',
    ];
    for (const xml of good) expect(await scanXmlWellFormed(xml)).toBeNull();
    // happy-dom's XML parser has no CDATA support, so only the first sample is cross-checked.
    expect(parser.parseFromString(good[0], 'application/xml').getElementsByTagName('parsererror').length).toBe(0);
    const bad = [
      '<a><b></a></b>',
      '<a><b></b>',
      '<a>1 & 2</a>',
      '<a></a><b></b>',
      '<a x="<"></a>',
      '<a x=1></a>',
      'text<a></a>',
      '<a><b',
    ];
    for (const xml of bad) expect(await scanXmlWellFormed(xml), xml).not.toBeNull();
  });

  it('checks a real generated DOCX document.xml and reports progress on large input', async () => {
    const docx = await runExport(input('docx'));
    const xml = strFromU8(unzipSync(docx.bytes)['word/document.xml']);
    expect(await scanXmlWellFormed(xml)).toBeNull();
    const big = `<r>${'<p a="1">x &amp; y</p>'.repeat(200_000)}</r>`;
    const seen: number[] = [];
    expect(await scanXmlWellFormed(big, (f) => seen.push(f))).toBeNull();
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(1);
  });
});
