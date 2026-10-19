import { describe, expect, it } from 'vitest';
import { DICTS, fillTemplate, t, type Locale, type MessageKey } from '../../src/shared/i18n';

describe('fillTemplate', () => {
  it('picks the singular form only for exactly 1', () => {
    const s = '{n} {n:file|files}';
    expect(fillTemplate(s, { n: 1 })).toBe('1 file');
    expect(fillTemplate(s, { n: 0 })).toBe('0 files');
    expect(fillTemplate(s, { n: 2 })).toBe('2 files');
    expect(fillTemplate(s, { n: '1' })).toBe('1 file');
    expect(fillTemplate(s, { n: '1,000' })).toBe('1,000 files');
  });

  it('allows placeholders inside the forms', () => {
    const s = '{n:The file was|All {n} files were} saved';
    expect(fillTemplate(s, { n: 1 })).toBe('The file was saved');
    expect(fillTemplate(s, { n: 4 })).toBe('All 4 files were saved');
  });

  it('keeps unknown placeholders unless a replacement is given, and never parses parameter text', () => {
    expect(fillTemplate('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    expect(fillTemplate('{a} and {b}', { a: 1 }, '')).toBe('1 and ');
    expect(fillTemplate('{name}', { name: '{n:x|y} {n}' })).toBe('{n:x|y} {n}');
  });
});

describe('English counts in the UI and the verification report', () => {
  it('reads correctly for one and for many', () => {
    expect(t('en', 'check.tables.ok', { n: 1 })).toBe('1 table converted to a real table');
    expect(t('en', 'check.tables.ok', { n: 2 })).toBe('2 tables converted to real tables');
    expect(t('en', 'check.messages.match', { source: 1, messages: 1 })).toBe('The source message was captured (1 message in the document)');
    expect(t('en', 'check.messages.match', { source: 9, messages: 9 })).toBe('All 9 source messages were captured (9 messages in the document)');
    expect(t('en', 'check.math.latex', { n: 1 })).toBe('1 formula is kept as LaTeX source (this format does not create equation objects)');
    expect(t('en', 'check.attachments.missing', { missing: 1 })).toBe('1 attachment was not accessible; only its name and type are kept');
    expect(t('en', 'result.messages', { n: 1 })).toBe('1 message');
    expect(t('ko', 'check.tables.ok', { n: 1 })).toBe('표 1개를 표로 변환했습니다');
  });

  it('every template fills completely with counts of 1 and 2', () => {
    for (const locale of ['ko', 'en'] as Locale[]) {
      for (const [key, raw] of Object.entries(DICTS[locale]) as Array<[MessageKey, string]>) {
        const names = [...raw.matchAll(/\{(\w+)[}:]/g)].map((m) => m[1]);
        for (const v of [1, 2]) {
          const out = t(locale, key, Object.fromEntries(names.map((k) => [k, v])));
          expect(out, `${locale} ${key}`).not.toMatch(/\{\w+[}:]|\|/);
        }
      }
    }
  });

  it('format labels are short enough for the three-column format grid', () => {
    // Longer labels were cut off in the popup ("Hangul (H…", "ZIP full bac…").
    for (const locale of ['ko', 'en'] as Locale[]) {
      for (const f of ['pdf', 'md', 'docx', 'hwpx', 'html', 'txt', 'json', 'zip']) {
        expect(t(locale, `format.${f}` as MessageKey).length, `${locale} ${f}`).toBeLessThanOrEqual(10);
      }
    }
  });

  it('the Markdown image question is short and reads right for one and many (v1.3.7)', () => {
    expect(t('ko', 'choose.md.title', { n: 1 })).toBe('이미지 1개를 어떻게 저장할까요?');
    expect(t('en', 'choose.md.title', { n: 1 })).toBe('What to do with the image?');
    expect(t('en', 'choose.md.title', { n: 3 })).toBe('What to do with the 3 images?');
    // One line each, so the three choices fit the popup and the page panel without wrapping.
    for (const locale of ['ko', 'en'] as Locale[]) {
      for (const m of ['zip', 'folder', 'none']) {
        expect(t(locale, `choose.md.${m}Desc` as MessageKey).length, `${locale} ${m}`).toBeLessThanOrEqual(40);
      }
    }
  });
});
