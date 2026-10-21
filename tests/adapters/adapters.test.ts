import { describe, expect, it } from 'vitest';
import { conversationToMarkdown } from '../../src/export/markdown';
import { buildVerification } from '../../src/export/verify';
import { checkText, issuesFirst, shownLevel, shownStatus } from '../../src/export/report';
import type { JobState, VerificationCheck } from '../../src/shared/types';
import { applyContentReferences, parseChatGPTConversation } from '../../src/content/adapters/chatgpt';
import { parseClaudeConversation, selectClaudePath } from '../../src/content/adapters/claude';
import { buildGeminiConversation, extractReadChatPage, parseBatchExecute } from '../../src/content/adapters/gemini';
import { cleanGrokMarkdown, parseGrokConversation } from '../../src/content/adapters/grok';
import { extractConversationId, detectSite, sourceDomain } from '../../src/shared/sites';
import {
  CHATGPT_ID,
  CLAUDE_ID,
  GEMINI_ID,
  GROK_ID,
  chatgptCodeWidgetConversation,
  chatgptConversation,
  chatgptModernConversation,
  chatgptRichSearchConversation,
  claudeConversation,
  geminiPage,
  grokPayloads,
} from '../fixtures/sites';

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

describe('source address shown in documents (v1.3.8)', () => {
  it('uses the page host and falls back to the service home', () => {
    expect(sourceDomain({ site: 'grok', fromUrl: `https://grok.com/c/${GROK_ID}` })).toBe('grok.com');
    expect(sourceDomain({ site: 'chatgpt', fromUrl: 'https://chat.openai.com/c/x' })).toBe('chat.openai.com');
    expect(sourceDomain({ site: 'gemini', fromUrl: '' })).toBe('gemini.google.com');
    expect(sourceDomain({ site: 'claude', fromUrl: 'https://evil.example/claude' })).toBe('claude.ai');
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
    expect(md.startsWith('# 조사 결과\n')).toBe(true);
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

  it('keeps code blocks that carry a client widget reference (real search answer, 2026-10-21)', () => {
    const conv = parseChatGPTConversation(chatgptCodeWidgetConversation(), { conversationId: CHATGPT_ID, url: `https://chatgpt.com/c/${CHATGPT_ID}` });
    const md = conv.messages[1].contents.find((c) => c.type === 'markdown')!.content!;
    expect(md).toContain('터미널을 열고 다음 명령어를 입력하세요.\n\n```bash\nexamplecli\n```\n\n도구가 열리면');
    expect(md).toContain('```text\n/usage\n```');
    expect(md).toContain('([docs.example.com](https://docs.example.com/cli/usage))');
    const doc = conversationToMarkdown(conv, { locale: 'ko' }).text;
    expect(doc).toContain('```bash\nexamplecli\n```');
    expect(doc).toContain('```text\n/usage\n```');
    // A widget over private-use marker text is rendered from its data instead.
    const r = applyContentReferences('a \ue200widget\ue202x\ue201 b', [{ type: 'client_defined_widget', category: 'code_block', data: { content: 'npm test', language: 'bash' }, matched_text: '\ue200widget\ue202x\ue201', start_idx: 2, end_idx: 13, alt: '' }]);
    expect(r.text).toContain('```bash\nnpm test\n```');
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

  it('does not count the hidden system root above the first question as a lost message (grok.com, 2026-10)', () => {
    const p = grokPayloads();
    const conv = parseGrokConversation({ conversationId: GROK_ID, url: `https://grok.com/c/${GROK_ID}`, nodes: p.nodes.responseNodes, responses: p.responses.responses });
    expect(conv.extraction.missingNodeIds).toEqual([]);
    expect(conv.extraction.sourceNodeCount).toBe(4);
    expect(conv.messages[0]).toMatchObject({ id: 'g-u1', role: 'user' });
    expect(buildVerification(conv, 'handoff').checks.filter((c) => c.status === 'fail')).toEqual([]);
  });

  it('keeps an answer that failed on Grok\'s side as the notice grok.com shows (2026-10)', () => {
    const iso = (min: number) => new Date(Date.UTC(2026, 8, 3, 15, min)).toISOString();
    const conv = parseGrokConversation({
      conversationId: GROK_ID,
      url: '',
      nodes: [
        { responseId: 'e-u1', sender: 'human', parentResponseId: 'e-system' },
        { responseId: 'e-a1', sender: 'assistant', parentResponseId: 'e-u1' },
      ],
      responses: [
        { responseId: 'e-u1', sender: 'human', message: '트윗 하나 써 줘', createTime: iso(0) },
        {
          responseId: 'e-a1',
          sender: 'assistant',
          createTime: iso(1),
          steps: [{ text: ['Thinking about your request'], tags: ['header'] }],
          streamErrors: [{ message: 'This model is temporarily unavailable. Please try a different model.', modelNotAvailable: {}, severity: 'STREAM_ERROR_SEVERITY_NORMAL' }],
        },
      ],
    });
    expect(conv.extraction.missingNodeIds).toEqual([]);
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(conv.messages[1].contents).toEqual([{ type: 'markdown', content: '> **Grok error:** This model is temporarily unavailable. Please try a different model.' }]);
  });

  it('removes unknown render tags', () => {
    expect(cleanGrokMarkdown('a<grok:render type="x"><argument name="y">1</argument></grok:render>b', [])).toBe('ab');
  });
});

describe('answer still being written when the user clicks (real gpt-6-pro task, 2026-10)', () => {
  /** The fixture conversation plus a new request whose answer so far holds only thinking. */
  function inProgress(status: string) {
    const data = chatgptConversation() as { mapping: Record<string, { children: string[] }>; current_node: string };
    data.mapping.a2.children = ['u3'];
    data.mapping.u3 = { id: 'u3', parent: 'a2', children: ['a3'], message: { id: 'u3', author: { role: 'user' }, create_time: 1_790_000_100, content: { content_type: 'text', parts: ['보고서 전체를 다시 정리해 줘.'] } } } as never;
    data.mapping.a3 = { id: 'a3', parent: 'u3', children: [], message: { id: 'a3', author: { role: 'assistant' }, create_time: 1_790_000_110, status, content: { content_type: 'thoughts', thoughts: [{ summary: '계획', content: '목차부터 다시 정리한다.' }] } } } as never;
    data.current_node = 'a3';
    return parseChatGPTConversation(data, { conversationId: CHATGPT_ID, url: `https://chatgpt.com/c/${CHATGPT_ID}` });
  }

  it('warns that the last answer was still in progress', () => {
    const conv = inProgress('in_progress');
    expect(conv.extraction.warnings).toContain('answer-in-progress');
    const checks = buildVerification(conv, 'handoff').checks;
    expect(checks).toContainEqual({ code: 'answer.inProgress', status: 'warn' });
  });

  it('warns about a finished answer that has nothing visible', () => {
    const checks = buildVerification(inProgress('finished_successfully'), 'md').checks;
    expect(checks).toContainEqual({ code: 'answer.empty', status: 'warn' });
    expect(buildVerification(parseChatGPTConversation(chatgptConversation(), { conversationId: CHATGPT_ID, url: '' }), 'md').checks.some((c) => c.code.startsWith('answer.'))).toBe(false);
  });
});

describe('a message the adapter cannot read (v1.3.8)', () => {
  it('ChatGPT: records what the message held and the details name it', () => {
    const data = chatgptConversation() as { mapping: Record<string, { children: string[] }>; current_node: string };
    data.mapping.a2.children = ['a3'];
    data.mapping.a3 = { id: 'a3', parent: 'a2', children: [], message: { id: 'a3', author: { role: 'assistant' }, recipient: 'all', create_time: 1_790_000_110, content: { content_type: 'multimodal_text', parts: [{ content_type: 'future_widget', data: 1 }] } } } as never;
    data.current_node = 'a3';
    const conv = parseChatGPTConversation(data, { conversationId: CHATGPT_ID, url: '' });
    expect(conv.extraction.missingNodeIds).toEqual(['a3']);
    expect(conv.extraction.missingKinds).toEqual(['assistant:multimodal_text(future_widget)']);
    const check = buildVerification(conv, 'handoff').checks.find((c) => c.code === 'messages.missing')!;
    expect(checkText('ko', check)).toBe('원본 메시지 1개는 형식을 읽지 못해 문서에서 빠졌습니다 — AI 답변 · multimodal_text(future_widget)');
    expect(checkText('en', check)).toBe('1 source message was left out: its format could not be read — AI answer · multimodal_text(future_widget)');
  });

  it('Claude: names the block types of the message', () => {
    const data = claudeConversation() as { chat_messages: Array<{ uuid: string; content: unknown[] }> };
    data.chat_messages.find((m) => m.uuid === 'c-a2')!.content = [{ type: 'voice_note', audio: 'x' }];
    const conv = parseClaudeConversation(data, { conversationId: CLAUDE_ID, url: '' });
    expect(conv.extraction.missingKinds).toEqual(['assistant:voice_note']);
    // Older records without kinds keep the short sentence.
    expect(checkText('ko', { code: 'messages.missing', status: 'fail', params: { missing: 2 } })).toBe('원본 메시지 2개는 형식을 읽지 못해 문서에서 빠졌습니다');
  });
});

describe('result shown to the user (v1.3.8)', () => {
  const fail: VerificationCheck = { code: 'messages.missing', status: 'fail', params: { missing: 1 } };
  const pass: VerificationCheck = { code: 'download.ok', status: 'pass', params: { size: 10 } };
  const job = (kind: JobState['kind'], phase: JobState['phase']) =>
    ({ kind, phase, result: { filename: 'a.md', bytes: 10, verification: { level: 'error', checks: [pass, fail], counts: {} } } }) as unknown as JobState;

  it('a saved handoff always reads as saved; its gaps are notes in the details', () => {
    expect(shownLevel(job('handoff', 'done'))).toBe('ok');
    expect(shownStatus('handoff', fail)).toBe('warn');
    expect(issuesFirst([pass, fail])).toEqual([fail, pass]);
  });

  it('only a handoff that saved no file fails; exports keep their verification level', () => {
    expect(shownLevel({ kind: 'handoff', phase: 'error' } as JobState)).toBe('error');
    expect(shownLevel(job('export', 'done'))).toBe('error');
    expect(shownStatus('export', fail)).toBe('fail');
  });
});
