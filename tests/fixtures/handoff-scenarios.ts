// Synthetic conversations for handoff accuracy tests. All content is invented.

import type { Conversation, ExportMessage } from '../../src/shared/types';

let seq = 0;
export function msg(role: 'user' | 'assistant', content: string): ExportMessage {
  seq++;
  return { id: `m${seq}`, ids: [`m${seq}`], role, created_at: Date.UTC(2026, 9, 1) + seq * 60_000, contents: [{ type: role === 'user' ? 'text' : 'markdown', content }] };
}

export function conv(messages: ExportMessage[], title = 'Test'): Conversation {
  return {
    title,
    pageId: 'test',
    fromUrl: 'https://chatgpt.com/c/test',
    site: 'chatgpt',
    siteName: 'ChatGPT',
    pageType: 'fullPage',
    messages,
    extraction: { method: 'api', sourceNodeCount: messages.length, missingNodeIds: [], skipped: [], warnings: [], fetchedAt: 0 },
  };
}

const FILLER_KO = [
  '데스크톱 앱의 창 관리 방식에는 여러 가지가 있습니다. 일반적으로 메인 프로세스가 창을 만들고 렌더러가 화면을 그립니다. 이벤트 루프는 사용자 입력과 타이머를 처리하며, 무거운 작업은 별도 스레드로 옮기는 것이 좋습니다.',
  '빌드 파이프라인은 소스 변환, 번들링, 서명, 배포 단계로 나뉩니다. 각 단계에서 캐시를 활용하면 시간을 크게 줄일 수 있습니다. 증분 빌드는 변경된 파일만 다시 처리합니다.',
  '테스트 전략으로는 단위 테스트, 통합 테스트, 종단 간 테스트를 조합하는 것이 일반적입니다. 테스트 피라미드의 아래쪽일수록 빠르고 많아야 합니다.',
  '상태 관리는 앱이 커질수록 중요해집니다. 전역 상태를 최소화하고, 파생 데이터는 계산으로 얻는 편이 버그를 줄입니다.',
];

/** Korean scenario: Electron → Tauri decision change, jQuery prohibition, files, done/open work. */
export function koreanScenario(fillerRounds = 80): Conversation {
  seq = 0;
  const m: ExportMessage[] = [];
  m.push(msg('user', '사내용 메모 데스크톱 앱을 만들고 싶어요. 목표는 가볍고 빠른 크로스플랫폼 앱입니다.'));
  m.push(msg('assistant', '좋습니다. Electron, Tauri, Flutter 같은 선택지가 있습니다. 팀이 웹 기술에 익숙하다면 Electron을 추천합니다.'));
  m.push(msg('user', '그럼 Electron으로 개발하기로 하자. 그리고 절대 jQuery는 사용하지 마세요.'));
  m.push(msg('assistant', '알겠습니다. Electron 기반으로 프로젝트 구조를 잡겠습니다.\n\n```bash\nnpm create electron-app memo\n```'));
  for (let i = 0; i < fillerRounds; i++) {
    m.push(msg('user', `창 관리와 빌드에 대해 조금 더 설명해 주세요 (${i + 1}).`));
    m.push(msg('assistant', `${FILLER_KO[i % FILLER_KO.length]}\n\n${FILLER_KO[(i + 1) % FILLER_KO.length]}\n\n${FILLER_KO[(i + 2) % FILLER_KO.length]}`));
  }
  m.push(msg('user', '메모리 사용량이 너무 커서 고민입니다. Electron 말고 Tauri로 바꾸자. 다시 한번 말하지만 jQuery는 사용하지 마세요.'));
  m.push(msg('assistant', 'Tauri로 전환하겠습니다. 프론트엔드는 그대로 두고 백엔드는 Rust로 작성합니다.\n\n```rust\n// src/main.rs\nfn main() {\n    tauri::Builder::default().run(tauri::generate_context!()).expect("error");\n}\n```\n\n설정 파일은 `src-tauri/tauri.conf.json`에 있습니다.'));
  m.push(msg('user', '좋아요. 최종적으로 Tauri로 확정합니다.'));
  m.push(msg('assistant', '프로젝트 초기 설정을 완료했습니다. 메모 목록 화면과 저장 기능도 구현했습니다.\n\n## 다음 단계\n\n- 자동 업데이트 기능 구현\n- 코드 서명 설정\n\n아직 자동 업데이트 기능은 구현하지 못했습니다.'));
  m.push(msg('user', '빌드할 때 `error: linker cc not found` 오류가 나서 실패했어요. 원인은 Xcode 명령줄 도구가 없어서였어요. 설치하니 해결됐어요.'));
  m.push(msg('assistant', '좋습니다. Xcode 명령줄 도구 설치로 링커 문제를 해결했습니다.'));
  m.push(msg('user', '이제 자동 업데이트 기능을 구현해 주세요. 업데이트 서버 주소는 https://updates.example.com/memo 입니다.'));
  return conv(m, '메모 앱 개발');
}

const FILLER_EN = [
  'There are several approaches to caching. A read-through cache loads data on a miss, while a write-through cache updates the store and the cache together. Choosing a TTL depends on how stale the data may be.',
  'Logging should be structured so it can be queried. Include request identifiers and keep sensitive fields out of the logs.',
  'Pagination can be offset-based or cursor-based. Cursor pagination is more stable when rows are inserted concurrently.',
];

/** English scenario: REST → GraphQL change, "never use Redux" constraint. */
export function englishScenario(fillerRounds = 80): Conversation {
  seq = 0;
  const m: ExportMessage[] = [];
  m.push(msg('user', 'I am building an internal dashboard for support tickets. The goal is fast search and clean filters.'));
  m.push(msg('assistant', 'A REST API with a React front end is a good default.'));
  m.push(msg('user', "Let's go with a REST API for the backend. Never use Redux in this project."));
  for (let i = 0; i < fillerRounds; i++) {
    m.push(msg('user', `Can you explain more about caching and pagination (${i + 1})?`));
    m.push(msg('assistant', `${FILLER_EN[i % 3]}\n\n${FILLER_EN[(i + 1) % 3]}`));
  }
  m.push(msg('user', 'Actually, use GraphQL instead of REST for the backend. Again: never use Redux.'));
  m.push(msg('assistant', 'Switched to GraphQL. I created `server/schema.graphql` and implemented the ticket query resolver.'));
  m.push(msg('user', 'Great, the decision is final: GraphQL it is.'));
  m.push(msg('assistant', 'Next steps:\n\n- Add the ticket search resolver\n- Write integration tests\n\nThe filter UI is not done yet.'));
  m.push(msg('user', 'Please implement the ticket search resolver now.'));
  return conv(m, 'Support dashboard');
}

/** An unrelated "change" must not supersede an earlier decision on a different topic. */
export function unrelatedChangeScenario(): Conversation {
  seq = 0;
  return conv([
    msg('user', '데이터베이스는 PostgreSQL로 결정했습니다.'),
    msg('assistant', 'PostgreSQL 기준으로 스키마를 설계하겠습니다.'),
    msg('user', '버튼 색상은 파란색 대신 초록색으로 바꿔 주세요.'),
    msg('assistant', '버튼 색상을 초록색으로 변경했습니다.'),
  ]);
}

/**
 * Short research conversation shaped like a ChatGPT web-search session (2026-10): answers with
 * headings, tables, citation chips and 100+ searched-but-uncited pages per answer. Mirrors the
 * structure of a real handoff a user reported as noisy; all text and URLs are synthetic.
 */
export function researchScenario(): Conversation {
  const chip = (host: string, path: string) => ` ([${host}](https://${host}/${path}))`;
  const searched = (n: number, salt: string) =>
    Array.from({ length: n }, (_, i) => ({ url: `https://search${i % 7}.example/${salt}/${i}?utm_source=chatgpt.com`, title: `검색 결과 ${i}` }));
  const answer = (m: ExportMessage, salt: string, cited: Array<{ url: string; title: string }>) => {
    m.contents.push({ type: 'sources', sources: cited, moreSources: searched(110, salt) });
    return m;
  };
  return conv(
    [
      msg('user', '노트북에서 쓸 수 있는 유료 메모 앱 중 인기 있는 것들 정리해 줘'),
      answer(
        msg(
          'assistant',
          [
            '대표적으로 **앱 A, 앱 B, 앱 C**가 있습니다.' + chip('shop.example', 'a'),
            '',
            '## 유료 앱 목록',
            '',
            '| 앱 | 가격 |',
            '|---|---|',
            '| [앱 A](https://shop.example/a?utm_source=chatgpt.com) | 9,900원 |',
            '| [앱 B](https://shop.example/b) | 15,000원 |',
            '',
            '유료 플랜은 기기 수와 동기화 제한도 확인해야 합니다.',
          ].join('\n'),
        ),
        'a',
        [{ url: 'https://shop.example/a', title: '앱 A 요금제' }],
      ),
      msg('user', '앱 A랑 비슷한 오픈소스 있는지 찾아줘'),
      answer(
        msg(
          'assistant',
          [
            '## 결론: 오픈소스 대안이 있습니다.',
            '',
            '| 프로젝트 | 내용 | 판단 |',
            '|---|---|---|',
            '| [OpenThing](https://github.com/example/openthing) | 플러그인 120개 | 가장 유용함 |',
            '| [OtherThing](https://github.com/example/other) | 동기화 서버 포함 | 라이선스 확인 필요 |',
            '',
            '저장소의 루트 `LICENSE` 파일은 확인되지 않았습니다.',
            '그 프로젝트는 테마 12개를 자체 제작해 작성했습니다.',
          ].join('\n'),
        ),
        'b',
        [{ url: 'https://github.com/example/openthing', title: 'OpenThing' }],
      ),
      msg('user', '라이선스 조건 찾아서 제대로 정리해줘'),
      answer(
        msg(
          'assistant',
          [
            '# 재배포 조건에 대한 라이선스 조사',
            '',
            '**먼저 결론부터 말씀드리면, 개인 사용과 상업적 재배포는 구분해야 합니다.**' + chip('law.example', 'x'),
            '',
            '| 항목 | 내용 |',
            '|---|---|',
            '| 라이선스 | EXAMPLE-1.0 |',
            '',
            '공식 문서 페이지는 열렸으나 실제 약관 원문은 확보하지 못했습니다.',
            '',
            '남은 핵심은 저작권 표시 조건의 실제 원문 확인입니다.',
          ].join('\n'),
        ),
        'c',
        [{ url: 'https://law.example/x', title: '법령' }],
      ),
    ],
    '유료 메모 앱 비교',
  );
}
