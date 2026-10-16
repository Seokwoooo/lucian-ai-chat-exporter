# 아키텍처 · Architecture

Chrome Manifest V3 확장입니다. 빌드는 esbuild, 언어는 TypeScript이고 UI 프레임워크는 쓰지 않습니다. 실행 중에 쓰는 라이브러리는 `docx`, `fflate`, `marked`, `katex` 네 개이며, docx·HWPX·KaTeX는 필요할 때만 동적으로 불러옵니다.

```
┌──────────────── AI 사이트 탭 (chatgpt.com / claude.ai / gemini.google.com / grok.com) ────────────────┐
│  inject.js (MAIN world, document_start)                                                              │
│    페이지의 fetch/XHR 요청 헤더만 관찰 → window.postMessage "web-bridge" (handshake 500ms, 재시도 1s×10, │
│    요청 타임아웃 30s)                                                                                  │
│  content.js (isolated world)                                                                         │
│    사이트 어댑터 선택 → 내부 API로 전체 대화 수집 → 공통 Conversation 모델                              │
│    실패 시 DOM 대체 경로(가상화 목록은 스크롤하며 안정 키로 수집) → 경고 기록                            │
│    200개 메시지 / 3M자 단위로 Port 스트리밍, 이미지·첨부 바이트 요청 처리                               │
└──────────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                               │ chrome.runtime Port
┌───────────────────────── background.js (service worker, 작업 조정) ─────────────────────────┐
│  작업 상태: chrome.storage.session (팝업이 닫혀도 진행)                                       │
│  IndexedDB lucianDB 저장 → 이미지·첨부 수집(페이지 실패 시 SW가 재요청) → offscreen에 빌드 요청 │
│  chrome.downloads로 저장, 저장된 크기 검증 · PDF는 print.html 탭을 염                           │
└───────────────┬──────────────────────────────────────────────┬──────────────────────────────┘
                │ runtime message                              │ tabs.create
┌───────────────▼────────────── offscreen.html ─────┐  ┌────────▼──────── print.html ─────────┐
│  내보내기: 형식별 모듈을 동적 import               │  │  HTML 렌더링 → 렌더 검증 → window.print │
│  인수인계: handoff-worker.js (Web Worker)          │  │  (Chrome 인쇄 엔진 → “PDF로 저장”)     │
│  결과를 blob: URL로 SW에 전달                      │  └──────────────────────────────────────┘
└───────────────────────────────────────────────────┘
popup.html — 두 영역(인수인계 / 내보내기), 진행 상태, 검증 결과, 단계별 시간
```

## 수집 (src/content)

| 사이트 | 기본 경로 | 대체 경로 |
|---|---|---|
| ChatGPT | `GET /backend-api/conversation/{id}`. 인증 헤더는 관찰한 값, 없으면 `/api/auth/session`. `mapping` 트리를 `current_node`부터 거슬러 올라가 현재 분기를 복원하고, 나머지 잎은 다른 분기로 보존합니다. 숨김·시스템·도구 호출 노드는 건너뛰고 그 이유를 기록합니다. 2026-10 형식: `commentary` 채널(사고 중 안내문)은 thinking으로 분류하고, `container.exec` 실행은 화면에 보이지 않으므로 건너뜁니다. 이미지·첨부는 `/backend-api/files/download/{id}`로 받습니다. | DOM: `[data-message-author-role]` 또는 `[data-chatgpt-search-unit-key]`·`[data-user-message-bubble]` |
| Claude | `lastActiveOrg` 쿠키(없으면 `/api/organizations`) → `chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true` → `current_leaf_message_uuid`에서 `parent_message_uuid`를 따라 경로를 만듭니다. text/thinking/tool_use/tool_result/artifacts를 변환합니다. | DOM: `[data-testid=user-message]`, `[data-testid=assistant-message]` (키는 `data-turn-key`) |
| Gemini | `WIZ_global_data`(`SNlM0e`→at, `FdrFJe`→f.sid, `cfb2h`→bl), `_reqid`(관찰값+100000)와 `x-goog-ext-*` 헤더로 `batchexecute?rpcids=hNvQHb`를 호출합니다. cursor가 없어질 때까지 페이지를 이어 받고, 앞쪽에 붙입니다. | DOM: `user-query`, `model-response` |
| Grok | `conversations_v2/{id}`(제목) → `response-node?includeThreads=true` → `load-responses`(청크). `createTime`이 가장 최근인 분기를 따르고, `partial` 노드는 버리며, `<grok:render>` 인용은 링크로 바꿉니다. | DOM: `.message-bubble` |

어댑터의 파서는 순수 함수이고 `tests/adapters`의 fixture로 테스트합니다. 사이트 구조가 바뀌면 어댑터 파일 하나만 고치면 됩니다.

## 공통 모델 (src/shared/types.ts)

`Conversation { title, site, fromUrl, model, messages[], otherBranchMessages?, extraction }`

- `ExportMessage.contents[]`의 type: `text | markdown | code | tool | artifact | html_widget | thinking | image | image_group | attachment | sources`
- `extraction`: 수집 방식(api/dom), 원본 노드 수, 변환 못 한 노드, 건너뛴 노드와 이유, 경고, 페이지 수, 네트워크·파싱 시간

## 내보내기 (src/export)

- `markdown.ts`가 기준 직렬화 모듈입니다. 다른 형식은 `md-parse.ts`(marked + 수식 토크나이저) 토큰을 각자 렌더링합니다.
- `html.ts` → HTML과 PDF(print 페이지). 수식은 KaTeX MathML로 렌더링합니다.
- `docx.ts` → `docx` 라이브러리. 맑은 고딕/Consolas, 코드 상자, 표, 이미지 비율 유지.
- `hwpx/` → 직접 작성한 OWPML 패키지: `mimetype`(무압축, 첫 항목), `version.xml`, `META-INF/container.xml·manifest.xml`, `Contents/content.hpf·header.xml·section0.xml`, `BinData/`. 공식 XSD로 검증합니다.
- `pipeline.ts` → 형식 선택, ZIP 백업 구성(`conversation.md/html/json`, `images/`, `attachments/`, `verification-report.*`).
- `verify.ts` → 원본 대비 메시지 수, 이미지·첨부·수식·표·코드 수, 출력 파일 무결성(ZIP·XML 파싱), 다운로드 크기. 결과는 `pass / info / warn / fail`이고 가장 나쁜 값이 전체 수준이 됩니다.
- 사고 과정은 문서에서 빼고 JSON·ZIP에만 남깁니다. 2,000자를 넘는 도구 출력은 문서에 앞부분만 넣고 JSON·ZIP에는 전부 남깁니다. 두 경우 모두 검증 결과에 표시합니다.

## 인수인계 엔진 (src/handoff)

외부 모델 없이 결정론적으로 동작하고, 같은 입력이면 항상 같은 출력이 나옵니다.

1. **normalize**: 메시지를 문장·목록·제목·코드·표 단위로 나눕니다(`segment.ts`). 각 단위의 FNV 해시를 키로 이전 분석 결과를 캐시에서 다시 씁니다(`cache-codec.ts`, IndexedDB).
2. **dedupe**: 정확히 같은 해시끼리 묶고, MinHash(해시 32개, 8밴드) + LSH로 거의 같은 문단·코드를 union-find로 묶습니다. 대표는 가장 최근에 나온 것으로 고르고, 반복 횟수와 코드 수정 횟수를 셉니다.
3. **score**: 한국어·영어 규칙(`patterns.ts`, 지시·제약·결정·변경·완료·할 일·실패·원인·금지·허용 등 19개 플래그)과 최근성, 반복, 역할을 함께 봅니다.
4. **track**: 결정의 대체(“A 대신 B로”, “B로 확정”)를 주제 토큰 유사도로 연결합니다. 이전 결정은 지우지 않고 “이전 결정”으로 남기며, 근거가 약하면 ⚠️(바뀌었을 수 있음 / 해제됐을 수 있음 / 완료됐을 수 있음)로 표시합니다. 제약·금지사항은 출현 위치와 함께 합칩니다.
5. **render**: 원문 분량에 맞춘 예산(원문의 12%, 8k–32k 토큰)으로 섹션을 채웁니다. 12k 토큰 이하의 대화는 원문 전체를 넣습니다. 모든 줄에 `[#mN]`이 붙고, 끝에 메시지 참조 색인이 붙습니다.

## 저장소

| 위치 | 내용 | 보관 |
|---|---|---|
| `chrome.storage.session` | 작업 상태(탭별) | 브라우저 세션 |
| IndexedDB `conversations` | 수집한 대화 | 7일 |
| IndexedDB `assets` | 이미지·첨부 Blob | 7일, 최대 500개(LRU) |
| IndexedDB `handoffCache` | 단위별 분석 캐시 | 7일 |

인증 토큰과 쿠키는 어디에도 저장하지 않습니다.

## 빌드 (scripts/build.mjs)

- 팝업, offscreen, print, handoff-worker: ESM + 코드 분할(`chunks/`)
- 서비스 워커: 단일 ESM 파일(서비스 워커에서는 동적 import를 쓸 수 없음)
- 콘텐츠 스크립트: IIFE 두 개(isolated, MAIN)
- docx에 미리 번들된 JSZip의 `setImmediate` 폴리필에 들어 있는 `new Function` 분기를 빌드 단계에서 제거하고, CI에서 `eval`/`new Function`이 없는지 검사합니다.
- `THIRD_PARTY_NOTICES.txt`와 `LICENSE.txt`를 자동으로 생성합니다.
