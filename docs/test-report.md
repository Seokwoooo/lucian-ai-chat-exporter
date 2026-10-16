# 테스트 · 성능 보고서

작성일 2026-10-16 · 버전 1.0.0

이 보고서는 **확인한 것과 확인하지 못한 것을 구분해** 적습니다. “통과”는 아래에 적은 방법으로 실제 실행해 본 결과만 뜻합니다.

## 1. 환경

| 항목 | 값 |
|---|---|
| CPU / RAM | Apple M2 Pro (12코어) / 16 GB |
| OS | macOS 27.0.1 (Darwin 27.0.0) |
| Node.js / npm | v26.5.0 / 11.17.0 |
| E2E 브라우저 | Chrome for Testing 155.0.8059.84 (headless, 빌드한 `dist/`를 로드) |
| 실제 사이트 확인 브라우저 | Google Chrome 155.0.8059.40 (사용자 프로필, 로그인 상태) |
| 문서 검증 도구 | python-hwpx 6.8.0 (`hwpx-validate`: 공식 OWPML XSD, `hwpx-validate-package`), @rhwp/core 0.8.7 (HWPX 렌더러), python-docx, macOS Quick Look·textutil, poppler `pdfinfo`·`pdftotext` |

## 2. 요약

| 구분 | 방법 | 결과 |
|---|---|---|
| 단위 테스트 | `npm test` (Vitest, 4개 파일) | **49 / 49 통과** |
| E2E | `npm run test:e2e`: Chrome for Testing에 확장을 올리고, CDP로 4개 사이트를 흉내 낸 모의 응답을 주고, 실제 팝업을 클릭해 실제 다운로드 파일을 검사 | **8 / 8 통과** |
| 1M 토큰 전체 흐름 | 같은 E2E 안에서 1,000,570토큰(3,782개 메시지) ChatGPT 대화 | 인수인계 생성 **0.79초** (요구치 10초 이하) |
| 실제 서비스 | 로그인된 Chrome에서 읽기 전용 스니펫으로 4개 서비스의 내부 API 응답 구조와 DOM 구조 확인 | 4개 서비스 모두 API 경로 동작, 바뀐 부분 5곳 발견·수정 (§6) |
| 형식 검증 | 외부 도구로 E2E 결과 파일 검사 | HWPX XSD 통과, DOCX 파싱, PDF 페이지·한글 텍스트 확인 |
| 정적 검사 | `tsc --noEmit`, ESLint, 빌드 결과물의 `eval`/`new Function` 검사 | 통과 |

## 3. 단위 테스트 (49개)

- **어댑터 (12개)**: URL에서 대화 ID 추출(ChatGPT 프로젝트·GPT 경로, Gemini `/u/1`·Gem 경로 포함). 4개 서비스의 파서를 합성 fixture로 검사합니다.
  - ChatGPT: `current_node` 경로 복원, 숨김·시스템·도구 호출 노드 건너뛰기, 도구 노드를 한 답변으로 병합, 이미지 포인터·첨부·thinking·코드·Canvas, 인용 마커를 링크로 변환, 코드의 탭 보존, 재생성 답변을 다른 분기로 보존, **2026-10 추론 모델 형식**(commentary 채널, container.exec, web.run, reasoning_recap)
  - Claude: `parent_message_uuid` 경로, 첨부 추출 텍스트, 이미지, thinking, 도구, 아티팩트, 출처
  - Gemini: batchexecute 프레임 파싱, cursor 페이지 넘김(오래된 순서), 표, 이미지
  - Grok: 최신 분기 선택, `partial` 노드 제외, `<grok:render>` 인용 변환
- **DOM 대체 경로 (1개)**: 2026-10 ChatGPT 화면 구조에서 사용자 줄바꿈 보존, 화면낭독기 전용 라벨 제외, 코드 블록 언어 보존
- **인수인계 정확도 (18개)**: 요구된 시나리오를 그대로 넣었습니다.
  - 한국어 시나리오(Electron 제안 → Tauri로 확정):
    - 최신 결정(Tauri)은 현재 결정으로, 바뀐 결정(Electron)은 “이전 결정”으로 분리합니다.
    - 오래됐지만 중요한 결정을 남깁니다.
    - 금지된 기술과 그 반복을 표시합니다.
    - 파일 경로와 최신 코드를 담습니다.
    - 완료한 일과 남은 일을 나눕니다.
    - 실패 원인과 마지막 지시를 현재 상태로 기록합니다.
    - 다음 AI를 위한 안내와 `[#mN]` 참조를 넣습니다.
  - 영어 시나리오(REST → GraphQL, Redux 금지)
  - **키워드만 겹치는 무관한 “변경” 요청으로는 결정을 바꾸지 않음**
  - 짧은 대화는 원문 전체 포함
  - 증분 캐시
  - thinking이 인수인계 문서(참조 색인 포함)에 새지 않음
- **내보내기 (18개)**: Markdown 코드 펜스(백틱 포함 코드), 표·수식·링크·이미지, thinking 제외, KaTeX MathML과 실패 보고, TXT 평탄화.
  - md/txt/json/html/docx/hwpx/zip 7개 형식을 모두 만들고 검증 결과가 사실과 맞는지(빠진 이미지는 경고) 확인합니다.
  - HTML 원시 태그 이스케이프, DOCX 실제 표·하이퍼링크·이미지, HWPX의 무압축 mimetype 첫 항목과 BinData, ZIP 구성, JSON의 thinking·분기 보존, 긴 도구 출력 축약도 확인합니다.

## 4. E2E (Chrome for Testing, 모의 사이트)

`tests/e2e/extension.e2e.test.ts` 흐름:

1. 빌드한 `dist/`를 로드합니다.
2. 페이지와 서비스 워커의 `https://*` 요청을 CDP Fetch로 가로채 합성 응답을 줍니다(`tests/e2e/mock-sites.ts`). 실제 서비스에는 접속하지 않습니다.
3. 팝업 버튼을 클릭합니다.
4. 실제로 저장된 파일을 다운로드 폴더에서 읽어 검사합니다.

| 사이트 | 인수인계 | MD | DOCX | HWPX | HTML | TXT | JSON | ZIP | PDF(인쇄 페이지) |
|---|---|---|---|---|---|---|---|---|---|
| ChatGPT | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 원본 첨부 `spec.pdf` 포함 | ✅ |
| Claude | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ 경고(의도된 결과: 첨부 원본에 접근 불가 → 추출 텍스트만) | ✅ |
| Gemini | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Grok | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

각 칸에서 확인한 것:

- 작업 단계가 `done`(PDF는 `print`)입니다.
- 검증 결과에 `fail`이 없습니다.
- 원본 메시지 수와 일치합니다.
- 다운로드가 완료되었고, 저장된 파일 크기가 생성 크기와 같습니다.
- DOCX/HWPX/ZIP은 압축이 풀립니다.
- JSON의 메시지 수가 일치합니다.
- 이미지가 문서에 포함되었습니다(`1/1`).
- 인수인계 파일 이름은 `lucian-handoff-YYYY-MM-DD.md` 형식이고, `## 0. 기본 정보`와 `[#m1]`을 포함합니다.

그 밖의 E2E 확인:

- 지원하지 않는 페이지에서 안내가 표시되고 버튼이 비활성화됩니다.
- 다크 모드와 라이트 모드 화면을 캡처했습니다(`docs/images`).
- PDF는 인쇄 페이지를 Chrome 인쇄 엔진(`page.pdf`, Skia/PDF m155)으로 출력한 뒤 `pdftotext`로 한글 제목과 본문이 추출되는지 확인했습니다.

E2E로 찾아 고친 버그:

- offscreen 문서에서 `chrome.runtime.getManifest`를 쓸 수 없어 **모든 내보내기 형식이 실패**하던 문제
- 인수인계 참조 색인에 thinking 첫 줄이 나오던 문제
- ZIP 검증 문구에서 첨부 개수가 바이트(“0 B/1개”)로 표시되던 문제

### 외부 도구로 결과 파일 검사

| 파일 | 검사 | 결과 |
|---|---|---|
| `*-export.hwpx` ×4 | `hwpx-validate` (OWPML XSD) | 4개 모두 `All schema validations passed` |
| | `hwpx-validate-package` | 통과. 경고 1건(`content.hpf`가 version 파트를 참조하지 않음)은 한컴 공식 Skeleton 참조 파일에도 똑같이 나옵니다. |
| | rhwp 렌더링 → PNG | 제목, 메타, 이미지, 첨부, 추출 텍스트, 코드 상자, 출처가 의도대로 배치됨 |
| `*-export.docx` ×4 | python-docx 열기 | 문단 14–22개, 표 1–5개, 그림 1개 |
| `*-export.pdf` ×4 | `pdfinfo` / `pdftotext` | 1–2쪽, 한글 텍스트 추출됨 |

## 5. 성능

### 5.1 1M 토큰: 확장 전체 흐름 (Chrome for Testing 155, E2E)

합성 ChatGPT 대화 1,000,570토큰(3,782개 메시지, 한국어·영어 혼합, 코드·표·목록·반복 포함)입니다. `bench-results/e2e-chrome-1m.json`

| 작업 | 네트워크 | 수집(네트워크 포함) | **생성** | 저장 | 클릭→완료 | 결과 |
|---|---|---|---|---|---|---|
| 인수인계 (처음) | 104 ms | 152 ms | **789 ms** | 9 ms | 1,236 ms | 129 KB, 출력 36,440토큰 |
| 인수인계 (캐시 재사용) | 77 ms | 191 ms | **591 ms** | 6 ms | 926 ms | 동일 |
| Markdown | 60 ms | 175 ms | 93 ms | 12 ms | 478 ms | 3.8 MB |
| HTML | 70 ms | 168 ms | 160 ms | 113 ms | 519 ms | 4.5 MB |
| HWPX | 68 ms | 189 ms | 1,072 ms | 1,193 ms | 2,549 ms | 1.1 MB |
| DOCX | 70 ms | 188 ms | 6,543 ms | 125 ms | 7,718 ms | 0.96 MB |

- “생성”은 데이터 확보 이후부터 파일 완성까지의 시간이며, 요구사항 “10초 이하”가 이 구간을 가리킵니다.
- 네트워크 시간은 모의 응답이라 실제보다 짧습니다. 실제 ChatGPT API는 0.7–3.1초가 걸렸습니다(§6).
- “저장”이 1초 안팎으로 튀는 경우(HWPX, ZIP)는 Chrome이 압축 파일을 저장할 때 하는 검사 시간입니다.

### 5.2 인수인계 엔진만 (Node, `npm run bench`)

| 원문 | 메시지 | 처음 | 캐시 재사용 | 출력 | 힙 증가 |
|---|---|---|---|---|---|
| 100,114토큰 | 381 | 105 ms | 49 ms | 15,084토큰 | 8 MB |
| 1,000,570토큰 | 3,783 | 870 ms (정규화 71, 중복 제거 250, 점수 547) | 648 ms | 36,402토큰 | 26 MB |

`bench-results/handoff-node.json`

## 6. 실제 서비스 확인

### 방법과 범위

- 사용자의 로그인된 Chrome(Claude in Chrome 연결)에서 각 서비스의 대화 화면을 열었습니다.
- 확장이 쓰는 것과 **같은 요청**(엔드포인트, 파라미터, 헤더)을 짧은 읽기 전용 스니펫으로 보냈습니다.
- 응답의 **구조(키, 개수, 유형, 상태 코드)만** 집계했습니다. 대화 본문, 제목, 토큰은 저장하거나 이 저장소에 남기지 않았습니다.
- 확장 번들 자체를 페이지에 주입하는 방식은 자동 권한 검사에서 거부되어 쓰지 않았습니다.
- **따라서 실제 계정에서 “확장 설치 → 버튼 클릭 → 파일 저장” 전체 흐름은 검증하지 못했습니다.** 어댑터 파서는 실제 응답과 같은 구조로 만든 fixture로만 검증했습니다.

| 서비스 | 확인한 것 | 결과 |
|---|---|---|
| ChatGPT | `/backend-api/conversation/{id}` — 대화 19개 | 모두 200. 노드 19–374개, 본문 3.5천–72만 자, 응답 0.7–3.1초. `mapping`/`current_node`/`content_type` 구조 일치 |
| | 이미지: `sediment://` 포인터 → `/backend-api/files/download/{id}` → `download_url` 받기 | 200, `download_url`은 같은 출처(chatgpt.com), 파일 요청 200 `image/png` |
| | DOM | `data-message-author-role`이 **사라짐**. 새 구조와 가상화 목록 발견 → 수정 |
| Claude | `chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true` | 200 (0.6초). 경로 메시지 9개, 블록 text 10 / thinking 34 / tool_use 86 / tool_result 86. 구조 일치 |
| | DOM | `.font-claude-response`가 **사라지고** `[data-testid=assistant-message]`로 바뀜, 가상화된 행 → 수정 |
| Gemini | `batchexecute?rpcids=hNvQHb` (WIZ_global_data 값 사용) — 대화 15개 | 모두 200, 각 1페이지(1–8턴). 항목 인덱스(`[2][0][0]` 질문, `[3][0][n][1][0]` 답변, `[3][3]` 선택 후보, `[4]` 시각) 일치. DOM `user-query`/`model-response` 일치 |
| Grok | `conversations_v2`, `response-node?includeThreads=true`, `load-responses` | 3개 모두 200. 노드(`responseId`/`parentResponseId`/`sender`), 응답 필드(`message`, `partial`, `webSearchResults`, `generatedImageUrls`, `fileAttachments` 등) 일치. DOM `.message-bubble` 일치 |

### 실제 데이터에서 찾아 고친 것

1. **ChatGPT 추론 모델의 `commentary` 채널** — 표본 대화에서 16개가 있었습니다. 화면에 표시된 텍스트와 대조해 보니 하나도 보이지 않았습니다(접힌 사고 패널 안에 있음). 그래서 thinking으로 분류해 문서에서 빼고 JSON·ZIP에 남깁니다.
2. **ChatGPT `container.exec` 코드 실행과 그 출력** — 화면에 보이지 않습니다. 그래서 건너뛰고, 건너뛴 사실을 검증 결과에 표시합니다. 예전 Code Interpreter(`python`)는 그대로 보입니다.
3. **ChatGPT·Claude의 DOM 대체 경로** — 새 선택자로 바꿨습니다. 가상화된 목록은 스크롤하면서 `data-chatgpt-search-unit-key` / `data-turn-key`로 중복 없이 모읍니다. 사용자 메시지 줄바꿈(`white-space: pre-wrap`)이 사라지던 버그도 고쳤습니다.
4. **도구를 많이 쓰는 Claude 대화** — 도구 결과 86개(웹 페이지 본문, 명령 로그)가 문서를 뒤덮었습니다. 2,000자를 넘는 도구 출력은 문서에 앞부분만 넣고 전체는 JSON·ZIP에 남기도록 바꾸고, 검증 결과에 표시합니다.
5. 화면의 사용자 메시지 수는 가상화 때문에 일부만 보입니다. 그래서 하한값으로만 비교합니다(화면 수가 추출 수보다 많을 때만 경고).

## 7. 검증하지 못한 것

- 실제 계정에서 확장의 전체 흐름(설치 → 클릭 → 파일 저장) — §6 참고
- 실제 데이터에서 Gemini 여러 페이지 수집 — 계정에 10턴이 넘는 대화가 없었습니다. 모의 데이터로는 확인했습니다.
- 실제 Claude·Grok·Gemini의 이미지·첨부 다운로드 — ChatGPT 이미지만 실제로 확인했습니다.
- 실제 대화의 수식·표 렌더링 품질(합성 fixture로만 확인)
- 한컴오피스(한글)로 HWPX 열기, Microsoft Word로 DOCX 열기
- Windows·Linux, Chrome 155 이외 버전(최소 116으로 선언했지만 실행 확인은 155만), Edge 등 다른 Chromium 브라우저
- 인쇄 창에서 사용자가 “PDF로 저장”을 누르는 마지막 단계. E2E는 같은 인쇄 페이지를 `page.pdf`로 출력해 확인했습니다.
- 메모리 사용량은 Node 힙 증가량(1M: 26 MB)만 측정했습니다. 확장 프로세스의 메모리는 측정하지 않았습니다.
- 이 보고서 작성 시점에는 GitHub Actions CI가 아직 실행되지 않았습니다(첫 푸시 후 확인).

## 8. 재현 방법

```bash
npm ci
npm run check                # typecheck + lint + 단위 테스트 + 빌드
npm run e2e:install-chrome   # 최초 1회
npm run test:e2e             # 결과 파일: test-output/e2e/, 1M 성능: bench-results/e2e-chrome-1m.json
npm run bench                # bench-results/handoff-node.json
```

### 실제 계정에서 직접 확인하기 (권장)

1. `npm run build`를 실행하고, `chrome://extensions`에서 개발자 모드를 켠 뒤 `dist/`를 로드합니다.
2. 각 서비스에서 짧은 대화 하나와 긴 대화 하나를 열고 **새로고침**합니다.
3. 인수인계 → 첫 줄 안내문, 결정, 현재 상태가 맞는지 확인합니다.
4. PDF·Markdown·Word를 차례로 내보내고 검증 결과를 열어 경고를 확인합니다. 경고가 사실과 다르면 이슈로 알려 주세요.
5. 다른 형식(HWPX·ZIP)을 내보내고, 한글에서 열리는지와 ZIP의 `verification-report.md`를 확인합니다.
