// Synthetic API payloads shaped like the real services' responses (structure only; all text is
// invented). Used by adapter unit tests and by the browser E2E test that mocks each site.

export const CHATGPT_ID = '6710a3b2-1111-4222-8333-944455556666';
export const CLAUDE_ID = '0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9';
export const CLAUDE_ORG = '11111111-aaaa-4bbb-8ccc-dddddddddddd';
export const GEMINI_ID = 'a1b2c3d4e5f60718';
export const GROK_ID = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';

const t = (min: number) => 1760000000 + min * 60; // epoch seconds

/** ChatGPT /backend-api/conversation/{id} — tree with a regenerated answer and tool nodes. */
export function chatgptConversation() {
  const node = (id: string, parent: string | null, children: string[], message: unknown) => ({ id, parent, children, message });
  const msg = (id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
    id,
    author: { role, name: extra.authorName ?? null },
    create_time: extra.time ?? null,
    content,
    metadata: extra.metadata ?? {},
    recipient: extra.recipient ?? 'all',
  });
  const mapping: Record<string, unknown> = {
    'client-created-root': node('client-created-root', null, ['sys'], null),
    sys: node('sys', 'client-created-root', ['ctx'], msg('sys', 'system', { content_type: 'text', parts: [''] }, { metadata: { is_visually_hidden_from_conversation: true } })),
    ctx: node('ctx', 'sys', ['u1'], msg('ctx', 'user', { content_type: 'user_editable_context', user_profile: 'x' }, { metadata: { is_visually_hidden_from_conversation: true } })),
    u1: node(
      'u1',
      'ctx',
      ['a1-old', 'a1-think'],
      msg(
        'u1',
        'user',
        {
          content_type: 'multimodal_text',
          parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_000000001', width: 640, height: 360 }, '이 스크린샷의 오류를 분석하고 수정 코드를 알려줘.'],
        },
        { time: t(0), metadata: { attachments: [{ id: 'file_000000001', name: 'screen.png', mime_type: 'image/png' }, { id: 'file-doc-2', name: 'spec.pdf', mime_type: 'application/pdf', size: 52000 }] } },
      ),
    ),
    'a1-old': node('a1-old', 'u1', [], msg('a1-old', 'assistant', { content_type: 'text', parts: ['이전에 생성된 답변 (다시 생성됨).'] }, { time: t(1), metadata: { model_slug: 'gpt-5' } })),
    'a1-think': node('a1-think', 'u1', ['a1-code'], msg('a1-think', 'assistant', { content_type: 'thoughts', thoughts: [{ summary: '원인 분석', content: '널 체크가 빠졌다.' }] }, { time: t(2) })),
    'a1-code': node('a1-code', 'a1-think', ['a1-out'], msg('a1-code', 'assistant', { content_type: 'code', language: 'python', text: 'print(1 + 1)' }, { time: t(2), recipient: 'python' })),
    'a1-out': node('a1-out', 'a1-code', ['a1-search'], msg('a1-out', 'tool', { content_type: 'execution_output', text: '2' }, { time: t(2), authorName: 'python' })),
    'a1-search': node('a1-search', 'a1-out', ['a1'], msg('a1-search', 'assistant', { content_type: 'code', language: 'unknown', text: '{"query":"null check"}' }, { time: t(2), recipient: 'web.run' })),
    a1: node(
      'a1',
      'a1-search',
      ['u2'],
      msg(
        'a1',
        'assistant',
        {
          content_type: 'text',
          parts: [
            '원인은 `user`가 `null`일 때 접근하기 때문입니다.citeturn0search1\n\n```ts\nif (user) {\n\tconsole.log(user.name);\n}\n```\n\n| 항목 | 값 |\n|---|---|\n| 원인 | null 접근 |\n\n수식: \\(E = mc^2\\)',
          ],
        },
        {
          time: t(3),
          metadata: {
            model_slug: 'gpt-5',
            content_references: [
              { matched_text: 'citeturn0search1', start_idx: 40, end_idx: 60, type: 'grouped_webpages', alt: '([MDN](https://developer.mozilla.org/))', items: [{ title: 'MDN', url: 'https://developer.mozilla.org/' }] },
            ],
          },
        },
      ),
    ),
    u2: node('u2', 'a1', ['a2'], msg('u2', 'user', { content_type: 'text', parts: ['캔버스로 정리해 줘.'] }, { time: t(4) })),
    a2: node(
      'a2',
      'u2',
      [],
      msg('a2', 'assistant', { content_type: 'code', language: 'json', text: JSON.stringify({ name: 'fix.ts', type: 'code/typescript', content: 'export const ok = true;\n' }) }, { time: t(5), recipient: 'canmore.create_textdoc' }),
    ),
  };
  // Fix start/end indices of the citation to the real position.
  const a1 = (mapping.a1 as { message: { content: { parts: string[] }; metadata: { content_references: Array<{ start_idx: number; end_idx: number; matched_text: string }> } } }).message;
  const text = a1.content.parts[0];
  const ref = a1.metadata.content_references[0];
  ref.start_idx = text.indexOf(ref.matched_text);
  ref.end_idx = ref.start_idx + ref.matched_text.length;
  return { title: 'Null 오류 분석', create_time: t(0), update_time: t(5), mapping, current_node: 'a2', default_model_slug: 'gpt-5', conversation_id: CHATGPT_ID };
}

/** Claude chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true */
export function claudeConversation() {
  const iso = (min: number) => new Date(t(min) * 1000).toISOString();
  const ROOT = '00000000-0000-4000-8000-000000000000';
  const m = (uuid: string, parent: string, sender: 'human' | 'assistant', index: number, content: unknown[], extra: Record<string, unknown> = {}) => ({
    uuid,
    parent_message_uuid: parent,
    sender,
    index,
    created_at: iso(index),
    updated_at: iso(index),
    text: '',
    content,
    attachments: [],
    files_v2: [],
    truncated: false,
    ...extra,
  });
  return {
    uuid: CLAUDE_ID,
    name: 'React 컴포넌트 리팩터링',
    model: 'claude-sonnet-test',
    created_at: iso(0),
    updated_at: iso(6),
    current_leaf_message_uuid: 'c-a2',
    chat_messages: [
      m('c-u1', ROOT, 'human', 0, [{ type: 'text', text: '이 컴포넌트를 훅으로 바꿔줘.' }], {
        attachments: [{ file_name: 'Old.jsx', file_size: 1200, file_type: 'text/javascript', extracted_content: 'class Old extends React.Component {}' }],
        files_v2: [{ file_kind: 'image', file_uuid: 'img-1', file_name: 'ui.png', preview_url: `/api/${CLAUDE_ORG}/files/img-1/preview`, preview_asset: { url: `/api/${CLAUDE_ORG}/files/img-1/preview`, image_width: 800, image_height: 450 } }],
      }),
      m('c-a1', 'c-u1', 'assistant', 1, [
        { type: 'thinking', thinking: '클래스 컴포넌트를 함수형으로 변환.' },
        { type: 'tool_use', name: 'web_search', input: { query: 'react hooks migration' } },
        { type: 'tool_result', name: 'web_search', content: [{ type: 'knowledge', title: 'React Docs', url: 'https://react.dev/reference/react' }] },
        { type: 'text', text: '다음과 같이 변환했습니다.', citations: [] },
        { type: 'tool_use', name: 'artifacts', input: { id: 'new-comp', type: 'application/vnd.ant.code', language: 'jsx', title: 'NewComp.jsx', command: 'create', content: 'export function NewComp() {\n  return <div/>;\n}\n' } },
      ]),
      m('c-u2', 'c-a1', 'human', 2, [{ type: 'text', text: '테스트도 추가해줘.' }]),
      m('c-a2-old', 'c-u2', 'assistant', 3, [{ type: 'text', text: '(이전 분기 답변)' }]),
      m('c-a2', 'c-u2', 'assistant', 4, [{ type: 'text', text: '테스트를 추가했습니다.\n\n```js\ntest("renders", () => {});\n```' }]),
    ],
  };
}

/** One Gemini turn: [[convId, respId], null, [[prompt]], [[candidates], null, null, chosenId], [sec, nanos]] */
function geminiTurn(i: number, prompt: string, answer: string, imageUrl?: string) {
  const cand = [`rc_${i}`, [answer], null, null, null, null, null, null, null, 'ko'];
  if (imageUrl) cand.push([[[null, null, null, [null, null, imageUrl]]]] as never);
  cand.push('2.5 Pro' as never);
  return [[`c_${GEMINI_ID}`, `r_${i}`], null, [[prompt], 1, null, 0], [[cand], null, null, `rc_${i}`], [t(i), 0]];
}

function geminiFrame(payload: unknown): string {
  const inner = JSON.stringify(payload);
  const frame = JSON.stringify([['wrb.fr', 'hNvQHb', inner, null, null, null, 'generic'], ['di', 42], ['af.httprm', 41, '-123', 3]]);
  const tail = JSON.stringify([['e', 4, null, null, 1234]]);
  return `)]}'\n\n${frame.length}\n${frame}\n${tail.length}\n${tail}\n`;
}

/** Page 1 (no cursor sent) returns the newest turns + cursor; page 2 returns the oldest turns. */
export function geminiPage(cursor: string | null): string {
  if (!cursor) {
    const turns = [geminiTurn(4, '마지막 질문: 표로 정리해줘', '| 언어 | 특징 |\n|---|---|\n| Rust | 안전 |\n| Go | 단순 |'), geminiTurn(3, '세 번째 질문', '세 번째 답변 $x^2$', 'https://lh3.googleusercontent.com/gemini-test-image')];
    return geminiFrame([turns, 'cursor-page-2', null, []]);
  }
  const turns = [geminiTurn(2, '두 번째 질문', '두 번째 답변'), geminiTurn(1, '첫 질문: Rust와 Go를 비교해줘', '첫 답변입니다.')];
  return geminiFrame([turns, null, null, []]);
}

export function grokPayloads() {
  const iso = (min: number) => new Date(t(min) * 1000).toISOString();
  // grok.com (checked 2026-10-21 on 20 real conversations): the first question's parent is an empty
  // "system" response that response-node does not list; load-responses still returns it if asked.
  const nodes = [
    { responseId: 'g-u1', sender: 'human', parentResponseId: 'g-system-root' },
    { responseId: 'g-a1', sender: 'assistant', parentResponseId: 'g-u1' },
    { responseId: 'g-u2', sender: 'human', parentResponseId: 'g-a1' },
    { responseId: 'g-a2-old', sender: 'assistant', parentResponseId: 'g-u2' },
    { responseId: 'g-a2', sender: 'assistant', parentResponseId: 'g-u2' },
    { responseId: 'g-a3-partial', sender: 'assistant', parentResponseId: 'g-a2' },
  ];
  const responses = [
    { responseId: 'g-system-root', sender: 'system', message: '', createTime: iso(0) },
    { responseId: 'g-u1', sender: 'human', parentResponseId: 'g-system-root', message: '오늘 날씨 API를 추천해줘', createTime: iso(0) },
    {
      responseId: 'g-a1',
      sender: 'assistant',
      model: 'grok-test',
      createTime: iso(1),
      message: 'OpenWeather를 추천합니다.<grok:render type="render_inline_citation"><argument name="citation_id">0</argument></grok:render>',
      webSearchResults: [{ url: 'https://openweathermap.org/api', title: 'OpenWeather API', preview: 'weather' }],
      thinkingTrace: '날씨 API 후보 검토',
    },
    { responseId: 'g-u2', sender: 'human', message: '예제 코드도 줘', createTime: iso(2) },
    { responseId: 'g-a2-old', sender: 'assistant', message: '(이전 답변)', createTime: iso(3) },
    { responseId: 'g-a2', sender: 'assistant', model: 'grok-test', message: '```python\nimport requests\nprint(requests.get(URL).json())\n```', createTime: iso(4), generatedImageUrls: ['users/u1/generated/img1/image.jpg'] },
    { responseId: 'g-a3-partial', sender: 'assistant', message: '작성 중…', createTime: iso(5), partial: true },
  ];
  return { detail: { conversation: { conversationId: GROK_ID, title: '날씨 API', createTime: iso(0) } }, nodes: { responseNodes: nodes, inflightResponses: [] }, responses: { responses } };
}

/**
 * ChatGPT payload shaped like a 2026-10 reasoning-model conversation (structure observed on
 * chatgpt.com; all text is synthetic): preamble messages on the "commentary" channel, code run
 * through "container.exec", web.run calls, a reasoning recap and the final answer.
 */
export function chatgptModernConversation() {
  const node = (id: string, parent: string | null, children: string[], message: unknown) => ({ id, parent, children, message });
  const msg = (id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
    id,
    author: { role, name: extra.authorName ?? null },
    create_time: t(10),
    content,
    metadata: extra.metadata ?? {},
    recipient: extra.recipient ?? 'all',
    channel: extra.channel ?? null,
  });
  const chain: Array<[string, unknown]> = [
    ['u1', msg('u1', 'user', { content_type: 'text', parts: ['리포지토리 구조를 분석해 줘.'] })],
    ['th1', msg('th1', 'assistant', { content_type: 'thoughts', thoughts: [{ summary: '계획', content: '파일 목록부터 확인한다.' }] })],
    ['pre1', msg('pre1', 'assistant', { content_type: 'text', parts: ['먼저 파일 목록을 확인하겠습니다.'] }, { channel: 'commentary', metadata: { is_thinking_preamble_message: true } })],
    ['exec1', msg('exec1', 'assistant', { content_type: 'code', language: 'unknown', text: 'ls -la /mnt/data' }, { recipient: 'container.exec' })],
    ['out1', msg('out1', 'tool', { content_type: 'execution_output', text: 'total 0' }, { authorName: 'container.exec' })],
    ['web1', msg('web1', 'assistant', { content_type: 'text', parts: ['{"search_query":[{"q":"vite docs"}]}'] }, { recipient: 'web.run' })],
    ['webout1', msg('webout1', 'tool', { content_type: 'text', parts: ['search results'] }, { authorName: 'web.run' })],
    ['recap', msg('recap', 'assistant', { content_type: 'reasoning_recap', content: '12초 동안 생각함' })],
    ['final', msg('final', 'assistant', { content_type: 'text', parts: ['구조 분석 결과입니다.\n\n- src/: 소스'] }, { channel: 'final', metadata: { model_slug: 'gpt-5-thinking' } })],
  ];
  const mapping: Record<string, unknown> = { root: node('root', null, [chain[0][0]], null) };
  chain.forEach(([id, m], i) => {
    mapping[id] = node(id, i === 0 ? 'root' : chain[i - 1][0], i + 1 < chain.length ? [chain[i + 1][0]] : [], m);
  });
  return { title: '구조 분석', create_time: t(10), update_time: t(11), mapping, current_node: 'final', default_model_slug: 'gpt-5-thinking' };
}

/**
 * ChatGPT search answer shaped like the 2026-10 rich format (structure observed on chatgpt.com;
 * all text and URLs are synthetic): `<Cite ref(s)>` ids that point at search_result_groups ref_ids,
 * `<Link>` components, layout boxes with indented children, and 100+ searched-but-uncited pages.
 */
export function chatgptRichSearchConversation() {
  const node = (id: string, parent: string | null, children: string[], message: unknown) => ({ id, parent, children, message });
  const entry = (i: number, url: string, title: string, attribution?: string) => ({
    type: 'search_result',
    url,
    title,
    snippet: `snippet ${i}`,
    ref_id: { turn_index: 7, ref_type: 'search', ref_index: i },
    attribution,
  });
  const entries = [
    entry(0, 'https://example.org/one?utm_source=chatgpt.com', '예시 문서 1', 'example.org'),
    entry(1, 'https://docs.example.com/guide', 'Guide', 'docs.example.com'),
    entry(2, 'https://www.example.net/page/', '페이지', undefined),
    entry(3, 'https://unrelated.example/a', '관련 없는 검색 결과'),
    entry(4, 'https://unrelated.example/b?utm_source=chatgpt.com', '또 다른 결과'),
  ];
  for (let i = 5; i < 120; i++) entries.push(entry(i, `https://search.example/${i}`, `결과 ${i}`));
  const answer = [
    '# 조사 결과',
    '',
    '<text color="secondary" size="sm">조사 기준: 합성 데이터</text>',
    '',
    '**결론부터 말씀드리면, A 방식을 권장합니다.** 근거는 공식 문서입니다. <Cite ref="turn7search0"/>',
    '',
    '| 사이트 | 내용 |',
    '|---|---|',
    '| <Link url="https://example.org/a?utm_source=chatgpt.com" title="예시 A"/> | 설명 <Cite refs={["turn7search1","turn7search2"]}/> |',
    '',
    '<box border radius="lg" padding={3} gap={2}>',
    '  <title size="xl">무료 플랜 비교표</title>',
    '  <row align="center" gap={1}>',
    '    <icon name="check-circle-2" color="success" size="sm"/>',
    '    <text size="xs">설치 없음</text>',
    '  </row>',
    '  <divider color="subtle"/>',
    '  <caption>합성 예시 데이터입니다.</caption>',
    '</box>',
    '',
    '인라인 코드 `<Cite ref="x"/>`는 그대로 둡니다. <MemoryCite />',
    '',
    '```jsx',
    '<box><text>코드 안의 마크업</text></box>',
    '```',
  ].join('\n');
  const msg = (id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
    id,
    author: { role, name: extra.authorName ?? null },
    create_time: t(20),
    content,
    metadata: extra.metadata ?? {},
    recipient: extra.recipient ?? 'all',
    channel: extra.channel ?? null,
  });
  const chain: Array<[string, unknown]> = [
    ['u1', msg('u1', 'user', { content_type: 'text', parts: ['A와 B 중 무엇이 좋은지 조사해 줘.'] })],
    ['web1', msg('web1', 'assistant', { content_type: 'code', text: '{"search_query":[{"q":"a vs b"}]}' }, { recipient: 'web.run' })],
    ['webout1', msg('webout1', 'tool', { content_type: 'text', parts: [''] }, { authorName: 'web.run', metadata: { search_result_groups: [{ type: 'search_result_group', domain: 'example.org', entries: entries.slice(0, 3) }] } })],
    [
      'final',
      msg('final', 'assistant', { content_type: 'text', parts: [answer] }, {
        channel: 'final',
        metadata: {
          model_slug: 'gpt-6-thinking',
          search_result_groups: [{ type: 'search_result_group', domain: 'mixed', entries }],
          content_references: [{ matched_text: ' ', start_idx: answer.length, end_idx: answer.length + 1, type: 'sources_footnote', sources: [] }],
        },
      }),
    ],
  ];
  const mapping: Record<string, unknown> = { root: node('root', null, [chain[0][0]], null) };
  chain.forEach(([id, m], i) => {
    mapping[id] = node(id, i === 0 ? 'root' : chain[i - 1][0], i + 1 < chain.length ? [chain[i + 1][0]] : [], m);
  });
  return { title: '조사', create_time: t(20), update_time: t(21), mapping, current_node: 'final', default_model_slug: 'gpt-6-thinking' };
}

/**
 * ChatGPT answer whose code blocks carry a client widget reference (seen 2026-10-21 on a real
 * search answer; text here is synthetic): `client_defined_widget` with category "code_block" and
 * data {content, language}, matched_text = the fenced block, alt = "". The adapter used to put the
 * empty alt in place of the block, so the commands vanished from every export and the handoff.
 */
export function chatgptCodeWidgetConversation() {
  const answer = [
    '## 3. 사용량 확인 방법',
    '',
    '터미널을 열고 다음 명령어를 입력하세요.',
    '',
    '```bash',
    'examplecli',
    '```',
    '',
    '도구가 열리면 다음 명령어를 입력하면 됩니다.',
    '',
    '```text',
    '/usage',
    '```',
    '',
    '`/quota`도 동일한 명령어입니다. <Cite ref="turn0search0"/>',
    '',
    '공식 문서: <Link url="https://docs.example.com/plans">요금제와 한도</Link>',
  ].join('\n');
  const widget = (code: string, language: string) => {
    const matched = `\`\`\`${language}\n${code}\n\`\`\``;
    const start = answer.indexOf(matched);
    return { type: 'client_defined_widget', category: 'code_block', data: { content: code, language, widget_type: 'code_block' }, matched_text: matched, start_idx: start, end_idx: start + matched.length, safe_urls: [], refs: [], alt: '', prompt_text: null };
  };
  const entry = { type: 'search_result', url: 'https://docs.example.com/cli/usage', title: 'CLI usage', snippet: 's', ref_id: { turn_index: 0, ref_type: 'search', ref_index: 0 } };
  const msg = (id: string, role: string, content: unknown, metadata: Record<string, unknown> = {}) => ({ id, author: { role, name: null }, create_time: t(30), content, metadata, recipient: 'all', channel: role === 'assistant' ? 'final' : null });
  const mapping: Record<string, unknown> = {
    root: { id: 'root', parent: null, children: ['u1'], message: null },
    u1: { id: 'u1', parent: 'root', children: ['final'], message: msg('u1', 'user', { content_type: 'text', parts: ['사용량은 어떻게 확인해?'] }) },
    final: {
      id: 'final',
      parent: 'u1',
      children: [],
      message: msg('final', 'assistant', { content_type: 'text', parts: [answer] }, {
        model_slug: 'gpt-6-thinking',
        search_result_groups: [{ type: 'search_result_group', domain: 'docs.example.com', entries: [entry] }],
        content_references: [widget('examplecli', 'bash'), widget('/usage', 'text'), { type: 'hidden', matched_text: '', start_idx: 0, end_idx: 0, safe_urls: [] }],
      }),
    },
  };
  return { title: '사용량 확인', create_time: t(30), update_time: t(31), mapping, current_node: 'final', default_model_slug: 'gpt-6-thinking' };
}
