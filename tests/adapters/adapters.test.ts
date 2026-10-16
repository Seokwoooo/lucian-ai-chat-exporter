import { describe, expect, it } from 'vitest';
import { conversationToMarkdown } from '../../src/export/markdown';
import { buildVerification } from '../../src/export/verify';
import { applyContentReferences, parseChatGPTConversation } from '../../src/content/adapters/chatgpt';
import { parseClaudeConversation, selectClaudePath } from '../../src/content/adapters/claude';
import { buildGeminiConversation, extractReadChatPage, parseBatchExecute } from '../../src/content/adapters/gemini';
import { cleanGrokMarkdown, parseGrokConversation } from '../../src/content/adapters/grok';
import { extractConversationId, detectSite } from '../../src/shared/sites';
import { CHATGPT_ID, CLAUDE_ID, GEMINI_ID, GROK_ID, chatgptConversation, chatgptModernConversation, chatgptRichSearchConversation, claudeConversation, geminiPage, grokPayloads } from '../fixtures/sites';

describe('site detection and conversation ids', () => {
  it('extracts ids from the supported URL shapes', () => {
    expect(extractConversationId('chatgpt', `https://chatgpt.com/c/${CHATGPT_ID}`)).toBe(CHATGPT_ID);
    expect(extractConversationId('chatgpt', `https://chatgpt.com/g/g-p-abc-project/c/${CHATGPT_ID}`)).toBe(CHATGPT_ID);
    expect(extractConversationId('chatgpt', 'https://chatgpt.com/')).toBeNull();
    expect(extractConversationId('claude', `https://claude.ai/chat/${CLAUDE_ID}`)).toBe(CLAUDE_ID);
    expect(extractConversationId('gemini', `https://gemini.google.com/app/${GEMINI_ID}`)).toBe(GEMINI_ID);
    expect(extractConversationId('gemini', `https://gemini.google.com/u/1/app/${GEMINI_ID}?hl=ko`)).toBe(GEMINI_ID);
    expect(extractConversationId('gemini', `https://gemini.google.com/gem/coding-partner/${GEMINI_ID}`)).toBe(GEMINI_ID);
    expect(extractConversationId('grok', `https://grok.com/c/${GROK_ID}`)).toBe(GROK_ID);
    expect(detectSite('https://example.com')).toBeNull();
    expect(detectSite('https://chat.openai.com/c/x')).toBe('chatgpt');
  });
});

describe('ChatGPT adapter', () => {
  const conv = parseChatGPTConversation(chatgptConversation(), { conversationId: CHATGPT_ID, url: `https://chatgpt.com/c/${CHATGPT_ID}` });

  it('follows current_node, skips hidden/system nodes and merges tool nodes into one assistant turn', () => {
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(conv.messages[1].ids).toEqual(['a1-think', 'a1-code', 'a1-out', 'a1']);
    expect(conv.extraction.missingNodeIds).toEqual([]);
    expect(conv.extraction.skipped.map((s) => s.reason)).toEqual(expect.arrayContaining(['hidden', 'tool-call:web.run']));
    expect(conv.title).toBe('Null 오류 분석');
  });

  it('keeps image pointers, attachments, thinking, code, tool output and canvas documents', () => {
    const [u1, a1, , a2] = conv.messages;
    expect(u1.contents.find((c) => c.type === 'image')).toMatchObject({ fileId: 'file_000000001', linkType: 'pointer', width: 640 });
    expect(u1.contents.find((c) => c.type === 'attachment')?.attachment).toMatchObject({ name: 'spec.pdf', fileId: 'file-doc-2' });
    expect(a1.contents.map((c) => c.type)).toEqual(['thinking', 'code', 'tool', 'markdown', 'sources']);
    expect(a2.contents[0]).toMatchObject({ type: 'artifact', title: 'fix.ts', language: 'typescript' });
  });

  it('replaces citation markers with readable links and preserves tabs in code', () => {
    const md = conv.messages[1].contents.find((c) => c.type === 'markdown')!.content!;
    expect(md).toContain('([MDN](https://developer.mozilla.org/))');
    expect(md).not.toMatch(/[-]/);
    expect(md).toContain('\tconsole.log(user.name);');
  });

  it('stores the regenerated answer as another branch', () => {
    expect(conv.otherBranchMessages?.[0].messages[0].contents[0].content).toContain('다시 생성됨');
  });

  it('keeps reasoning-model preambles and container runs out of the answer text (2026-10 shape)', () => {
    const modern = parseChatGPTConversation(chatgptModernConversation(), { conversationId: CHATGPT_ID, url: `https://chatgpt.com/c/${CHATGPT_ID}` });
    expect(modern.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const a = modern.messages[1];
    expect(a.contents.map((c) => c.type)).toEqual(['thinking', 'thinking', 'thinking', 'markdown']);
    expect(a.contents.find((c) => c.title === 'commentary')?.content).toBe('먼저 파일 목록을 확인하겠습니다.');
    expect(a.contents.at(-1)?.content).toContain('구조 분석 결과입니다.');
    expect(a.contents.some((c) => c.type === 'tool' || c.type === 'code')).toBe(false);
    expect(modern.extraction.skipped.map((s) => s.reason)).toEqual(
      expect.arrayContaining(['tool-call:container.exec', 'tool:container.exec', 'tool-call:web.run', 'tool:web.run']),
    );
    expect(modern.extraction.missingNodeIds).toEqual([]);
  });

  it('converts 2026-10 rich answer markup and lists only cited sources', () => {
    const rich = parseChatGPTConversation(chatgptRichSearchConversation(), { conversationId: CHATGPT_ID, url: `https://chatgpt.com/c/${CHATGPT_ID}` });
    expect(rich.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const a = rich.messages[1];
    const md = a.contents.find((c) => c.type === 'markdown')!.content!;
    const outsideCode = md.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    expect(outsideCode).not.toMatch(/<\/?(Cite|Link|MemoryCite|box|row|text|title|caption|icon|divider)\b/);
    expect(md).toContain('권장합니다.** 근거는 공식 문서입니다. ([example.org](https://example.org/one))');
    expect(md).toContain('| [예시 A](https://example.org/a) | 설명 ([docs.example.com](https://docs.example.com/guide), [example.net](https://www.example.net/page/)) |');
    expect(md).toContain('**무료 플랜 비교표**');
    expect(md).toContain('\n설치 없음\n');
    expect(md).toContain('합성 예시 데이터입니다.');
    expect(md.split('\n').some((l) => /^ {4}\S/.test(l))).toBe(false);
    expect(md).toContain('`<Cite ref="x"/>`');
    expect(md).toContain('```jsx\n<box><text>코드 안의 마크업</text></box>\n```');
    const src = a.contents.find((c) => c.type === 'sources')!;
    expect(src.sources!.map((s) => s.url)).toEqual(['https://example.org/one', 'https://docs.example.com/guide', 'https://www.example.net/page/']);
    expect(src.moreSources!.length).toBe(117);
    expect(src.moreSources!.some((s) => s.url.includes('utm_source'))).toBe(false);
    // Documents say that uncited results were left out; JSON keeps them without that note.
    expect(buildVerification(rich, 'md').checks).toContainEqual({ code: 'sources.uncited', status: 'info', params: { n: 117 } });
    expect(buildVerification(rich, 'json').checks.some((c) => c.code === 'sources.uncited')).toBe(false);
    expect(conversationToMarkdown(rich, { locale: 'ko' }).text).not.toContain('search.example');
  });

  it('strips unmatched private-use citation markers', () => {
    expect(applyContentReferences('acitexb', []).text).toBe('ab');
  });
});

describe('Claude adapter', () => {
  const data = claudeConversation();
  const conv = parseClaudeConversation(data, { conversationId: CLAUDE_ID, url: `https://claude.ai/chat/${CLAUDE_ID}` });

  it('walks parent_message_uuid from current_leaf_message_uuid', () => {
    expect(selectClaudePath(data).map((m: { uuid: string }) => m.uuid)).toEqual(['c-u1', 'c-a1', 'c-u2', 'c-a2']);
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(conv.otherBranchMessages?.length).toBe(1);
  });

  it('converts attachments, images, thinking, artifacts and search sources', () => {
    const [u1, a1] = conv.messages;
    expect(u1.contents.find((c) => c.type === 'image')?.imageUrl).toMatch(/^https:\/\/claude\.ai\/api\/.+\/preview$/);
    expect(u1.contents.find((c) => c.type === 'attachment')?.attachment?.extractedText).toContain('class Old');
    expect(a1.contents.map((c) => c.type)).toEqual(['thinking', 'tool', 'markdown', 'artifact', 'sources']);
    expect(a1.contents.find((c) => c.type === 'artifact')).toMatchObject({ title: 'NewComp.jsx', language: 'jsx' });
    expect(a1.contents.find((c) => c.type === 'sources')?.sources?.[0].url).toBe('https://react.dev/reference/react');
  });
});

describe('Gemini adapter', () => {
  it('parses batchexecute frames and paginates with the cursor (oldest first)', () => {
    const p1 = extractReadChatPage(parseBatchExecute(geminiPage(null)))!;
    const p2 = extractReadChatPage(parseBatchExecute(geminiPage('cursor-page-2')))!;
    expect(p1.continueCursor).toBe('cursor-page-2');
    expect(p2.continueCursor).toBeNull();
    const all = [...p2.items, ...p1.items];
    const conv = buildGeminiConversation(all, { conversationId: GEMINI_ID, url: 'https://gemini.google.com/app/x', title: '', pages: 2 });
    expect(conv.messages.length).toBe(8);
    expect(conv.messages[0].contents[0].content).toBe('첫 질문: Rust와 Go를 비교해줘');
    expect(conv.messages[7].contents[0].content).toContain('| Rust | 안전 |');
    expect(conv.messages[5].contents.find((c) => c.type === 'image')?.imageUrl).toBe('https://lh3.googleusercontent.com/gemini-test-image');
    expect(conv.title).toBe('첫 질문: Rust와 Go를 비교해줘');
    expect(conv.extraction.sourceNodeCount).toBe(8);
    expect(conv.extraction.missingNodeIds).toEqual([]);
    expect(conv.model).toBe('2.5 Pro');
  });
});

describe('Grok adapter', () => {
  it('follows the newest branch, drops partial nodes and resolves citations', () => {
    const p = grokPayloads();
    const conv = parseGrokConversation({
      conversationId: GROK_ID,
      url: `https://grok.com/c/${GROK_ID}`,
      title: p.detail.conversation.title,
      nodes: p.nodes.responseNodes,
      responses: p.responses.responses,
    });
    expect(conv.messages.map((m) => m.id)).toEqual(['g-u1', 'g-a1', 'g-u2', 'g-a2']);
    expect(conv.extraction.skipped).toEqual([{ id: 'g-a3-partial', reason: 'partial' }]);
    const a1 = conv.messages[1];
    expect(a1.contents.find((c) => c.type === 'markdown')?.content).toContain('([openweathermap.org](https://openweathermap.org/api))');
    expect(a1.contents.find((c) => c.type === 'thinking')).toBeTruthy();
    expect(conv.messages[3].contents.find((c) => c.type === 'image')?.imageUrl).toBe('https://assets.grok.com/users/u1/generated/img1/image.jpg');
    expect(conv.otherBranchMessages?.[0].messages[0].id).toBe('g-a2-old');
  });

  it('removes unknown render tags', () => {
    expect(cleanGrokMarkdown('a<grok:render type="x"><argument name="y">1</argument></grok:render>b', [])).toBe('ab');
  });
});
