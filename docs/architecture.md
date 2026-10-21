# 아키텍처 · Architecture

Chrome Manifest V3 확장입니다. 빌드는 esbuild, 언어는 TypeScript이고 UI 프레임워크는 쓰지 않습니다. 실행 중에 쓰는 라이브러리는 `docx`, `fflate`, `marked`, `katex` 네 개이며, docx·HWPX·KaTeX는 필요할 때만 동적으로 불러옵니다.

```
┌──────────────── AI 사이트 탭 (chatgpt.com / claude.ai / gemini.google.com / grok.com) ────────────────┐
│  inject.js (MAIN world, document_start)                                                              │
│    페이지의 fetch/XHR 요청 헤더만 관찰 → window.postMessage "web-bridge" (handshake 500ms, 재시도 1s×10, │
│    요청 타임아웃 30s)                                                                                  │
│  content.js (isolated world)                                                                         │
│    답변 아래 도구 막대에 Lucian 버튼(Shadow DOM, page-ui.ts) → 패널에서 인수인계·내보내기 시작          │
│    사이트 어댑터 선택 → 내부 API로 전체 대화 수집 → 공통 Conversation 모델                              │
│    429면 Retry-After만큼 기다렸다 재시도(최대 3번·90초, 팝업·패널에 카운트다운)                         │
│    단, 화면의 최신 메시지 id가 모두 저장된 사본에 있으면 기다리지 않고 바로 사본 사용                   │
│    응답 형식을 못 읽을 때만 DOM 대체 경로(가상화 목록은 스크롤하며 안정 키로 수집) → 경고 기록           │
│    차단·로그인·네트워크 실패는 화면을 읽지 않음 → 서비스 워커가 저장된 사본 사용 또는 오류                │
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
| ChatGPT | `GET /backend-api/conversation/{id}`. 인증 헤더는 관찰한 값, 없으면 `/api/auth/session`. `mapping` 트리를 `current_node`부터 거슬러 올라가 현재 분기를 복원하고, 나머지 잎은 다른 분기로 보존합니다. 숨김·시스템·도구 호출 노드는 건너뛰고 그 이유를 기록합니다. 2026-10 형식: `commentary` 채널(사고 중 안내문)은 thinking으로 분류하고, `container.exec` 실행은 화면에 보이지 않으므로 건너뜁니다. 코드 블록마다 붙는 복사 버튼 위젯 참조(`client_defined_widget`, `code_block`, 빈 `alt`)는 코드 자체를 가리키므로 지우지 않습니다(v1.3.9). 이미지·첨부는 `/backend-api/files/download/{id}`로 받습니다. | DOM: `[data-message-author-role]` 또는 `[data-chatgpt-search-unit-key]`·`[data-user-message-bubble]`. 앱 안에서 옮겨 다니면 이전 대화가 `display: none`으로 남으므로, 모든 사이트에서 렌더링된 요소만 셉니다(`renderedElements`). |
| Claude | `lastActiveOrg` 쿠키(없으면 `/api/organizations`) → `chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true` → `current_leaf_message_uuid`에서 `parent_message_uuid`를 따라 경로를 만듭니다. text/thinking/tool_use/tool_result/artifacts를 변환합니다. | DOM: `[data-testid=user-message]`, `[data-testid=assistant-message]` (키는 `data-turn-key`) |
| Gemini | `WIZ_global_data`(`SNlM0e`→at, `FdrFJe`→f.sid, `cfb2h`→bl), `_reqid`(관찰값+100000)와 `x-goog-ext-*` 헤더로 `batchexecute?rpcids=hNvQHb`를 호출합니다. cursor가 없어질 때까지 페이지를 이어 받고, 앞쪽에 붙입니다. | DOM: `user-query`, `model-response` |
| Grok | `conversations_v2/{id}`(제목) → `response-node?includeThreads=true` → `load-responses`(청크). `createTime`이 가장 최근인 분기를 따르고, `partial` 노드는 버리며, `<grok:render>` 인용은 링크로 바꿉니다. 첫 질문의 부모는 노드 목록에 없는 빈 `system` 응답이라, 경로는 목록에 있는 노드만 따라갑니다(v1.3.8). 생성에 실패한 답변(`streamErrors`만 있음)은 화면처럼 오류 문구로 남깁니다. | DOM: `.message-bubble` |

어댑터의 파서는 순수 함수이고 `tests/adapters`의 fixture로 테스트합니다. 사이트 구조가 바뀌면 어댑터 파일 하나만 고치면 됩니다.

### 출처와 화면용 마크업

- ChatGPT(2026-10)는 검색 답변을 `<Cite ref="turn…search13"/>`, `<Link url title/>`, `<box>`·`<row>`·`<text>`·`<title>` 같은 화면용 마크업으로 보냅니다. `Cite`의 id는 같은 대화의 `search_result_groups[].entries[].ref_id`와 이어지므로 실제 출처 링크로 바꾸고, 레이아웃 태그는 벗겨 내며 들여쓰기를 없앱니다(코드 블록 오인 방지). 코드 블록·인라인 코드 안은 건드리지 않습니다.
- 문서의 출처 목록(`sources`)에는 답변이 인용한 페이지만 넣고, 검색만 한 결과는 `moreSources`로 JSON·ZIP에만 남깁니다(ChatGPT, Grok). `utm_*` 같은 추적 파라미터는 인용 링크에서 지웁니다.

### 답변 아래 버튼 (src/content/page-ui.ts)

- 각 어댑터의 `actionBars()`가 사이트별 도구 막대 위치를 돌려줍니다: ChatGPT `.turn-action-controls`(사용자 말풍선 제외), Claude `[data-testid=assistant-message] [data-testid=message-actions]`, Gemini `model-response message-actions .buttons-container-v2`(버튼 뒤에 줄을 채우는 `.spacer`가 있어 `actionAnchor()`로 그 앞에 넣음, v1.3.8), Grok `[id^=response-]:not(.items-end) .action-buttons`.
- 도구 막대는 답변이 끝난 뒤에 렌더링되므로 버튼도 그때 나타납니다. `MutationObserver`(300ms 묶음 처리)로 다시 그려진 도구 막대에 버튼을 다시 붙이고, 사이트가 버튼을 지운 도구 막대(마우스를 올렸을 때만 보이는 경우)에서는 함께 지웁니다. 확장이 다시 로드되면 이전 스크립트의 버튼은 스스로 사라집니다.
- 버튼과 패널은 Shadow DOM이라 사이트 CSS와 섞이지 않습니다. 패널은 팝업과 같은 `start-job`/`get-job` 메시지를 쓰고(탭은 발신 탭), 결과·경고를 보여 주며, 닫혀 있을 때 끝나면 작은 알림을 띄웁니다. 페이지 배경 밝기로 라이트/다크를 고릅니다.
- 버튼은 사이트 아이콘과 같은 크기지만 보라→청록 그라데이션 링이 천천히 돌고 뒤쪽 빛이 은은하게 숨 쉬듯 바뀝니다(CSS만 사용, `prefers-reduced-motion`이면 멈춤).
- 형식 버튼 로고와 Markdown 이미지 선택지 아이콘(`src/shared/ui-icons.ts`, 팝업과 패널 공용, v1.3.7): 인라인 SVG라 패널의 Shadow DOM에서도 그대로 쓰고 외부 파일을 읽지 않습니다. 기본 줄은 Markdown·PDF·TXT, “다른 형식 더 보기”는 Word·HWPX·HTML·JSON·ZIP입니다. PDF·Word 로고는 Adobe·Microsoft 상표 모양이고 Markdown 마크는 퍼블릭 도메인이며, 모두 파일 형식을 가리키는 용도로만 씁니다. 이미지 선택은 문제가 아니라 질문이라 경고 아이콘 대신 사진 아이콘을 쓰고(`data-level="choose"`), ZIP에 “추천”을 붙입니다.
- 원본 표시(v1.3.8): 모든 문서 머리말(Markdown·TXT·HTML/PDF·DOCX·HWPX·검증 보고서)과 인수인계 「기본 정보」의 원본은 `sourceDomain()`(`src/shared/sites.ts`)이 돌려주는 사이트 주소(`chatgpt.com`, `claude.ai`, `gemini.google.com`, `grok.com`)입니다. 대화 링크의 호스트를 쓰고, 지원 사이트가 아니면 서비스 기본 주소로 대신합니다. 모델 이름은 머리말·메시지 제목·인수인계 원문 제목에 넣지 않고 JSON(ZIP 안 포함)에만 남깁니다.
- 결과 표시(v1.3.8): 저장된 인수인계는 문제가 있어도 팝업·패널·알림 모두 ✓ “인수인계 파일 저장 완료”로 보여 줍니다(`shownLevel`, `src/export/report.ts`). 경고·실패 항목은 접힌 “세부 정보” 맨 위에 “!”로 나오고(`shownStatus`, `issuesFirst`), 파일을 만들거나 저장하지 못한 작업(phase `error`)만 실패로 보입니다. 검증 데이터(`verification.level`, ZIP·JSON 보고서)는 실제 수준을 그대로 둡니다. 내보내기는 이전처럼 검증 수준을 그대로 보여 줍니다. 어댑터는 읽지 못한 메시지마다 `extraction.missingKinds`에 “역할:형식”(예: `assistant:multimodal_text(audio_transcription)`)을 남겨 세부 정보가 무엇이 빠졌는지 말합니다.
- 인수인계 버튼 위 그림(`src/shared/handoff-visual.ts`, 팝업과 패널 공용): 현재 서비스 로고 → 곡선 화살표 위로 움직이는 MD 문서 → 나머지 서비스 로고가 번갈아 나타납니다. 화살표는 두 로고 사이 120px 고정 칸에 1:1 픽셀로 그려서, 컨테이너 폭과 상관없이 두 로고의 세로 가운데를 잇습니다. 로고 SVG는 `providers/`에 들어 있고 `web_accessible_resources`로 다섯 사이트에만 공개합니다. 로고는 각 회사의 상표이며 서비스를 가리키는 용도로만 씁니다.

### 진행률

- 긴 대화는 파일을 만드는 데 몇 초가 걸리므로 offscreen 문서가 단계별 진행률(0–100%)을 서비스 워커로 보내고, 팝업과 패널이 "처리 중… (n% 완료)"와 막대로 보여 줍니다. 1% 단위로만 보내 메시지 수를 줄입니다.
- 진행률이 바뀔 때는 글자와 막대만 바꾸고 회전 아이콘 요소는 그대로 둡니다(v1.3.4). 예전에는 갱신할 때마다 아이콘을 새로 만들어 회전이 처음부터 다시 시작했고, 그래서 아이콘이 뚝뚝 끊겨 보였습니다(1M 토큰 인수인계 2초 동안 6번). 회전은 SVG가 아니라 감싼 요소에 `will-change: transform`으로 걸어, 페이지가 바쁠 때도 합성 스레드에서 돕니다. E2E가 작업 하나에 아이콘이 한 번만 만들어지는지 확인합니다.
- 형식마다 만들기와 검증의 비율이 다릅니다(`pipeline.ts`의 `BUILD_SHARE`). DOCX·HWPX 빌더는 메시지 50개마다 진행률을 보내고 이벤트 루프에 양보합니다. 인수인계 엔진은 Web Worker에서 단계(정규화·중복 묶기·점수·선택·렌더링)마다 진행률을 보냅니다.
- 4MB가 넘는 XML(DOCX `document.xml`, HWPX `section0.xml`)은 `DOMParser` 대신 스트리밍 검사기(`scanXmlWellFormed`)로 태그 짝·속성·엔터티·루트 하나를 확인합니다. 1M 토큰 DOCX에서 검증이 4.5초에서 0.24초로 줄었습니다.

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
- **Markdown과 이미지 (v1.3.6)**: 서비스의 이미지 주소는 로그인한 브라우저에서만 열려서(ChatGPT `estuary/content`, Claude `files/…/preview` 모두 쿠키 없이 403), Markdown에 링크만 남기면 다른 프로그램에서는 보이지 않습니다. 이미지가 있는 대화의 Markdown 작업은 대화를 모은 뒤 `choose` 단계에서 멈추고(종료 상태), 팝업과 답변 아래 패널이 세 가지 선택지를 보여 줍니다. 고르면 `mdImages`를 붙여 새 작업을 시작합니다. 서비스 워커가 답을 기다리지 않으므로, 기다리는 동안 워커가 내려가도 문제가 없습니다.
  - `zip`: `제목/제목.md` + `제목/images/image-001.png`, 상대 경로 링크.
  - `folder`: `제목.md`와 `제목_files/image-001-<내용 해시>.png`를 따로 다운로드합니다. 이미지가 먼저 저장되고, 같은 대화를 다시 내보내면 같은 이름·같은 내용이라 덮어씁니다(`conflictAction: 'overwrite'`). 그래서 `… (1).png`로 링크가 깨지지 않습니다. 각 이미지가 `.md`와 같은 폴더 아래 `제목_files/`에 실제로 저장됐는지 다운로드 경로로 확인합니다.
  - `none`: `.md`만. 이미지 자리는 `*[이미지: 설명]*`입니다.
  - 받지 못한 이미지는 죽은 링크 대신 `*[이미지를 가져오지 못했습니다: 설명]*`로 남기고 경고합니다.
- `verify.ts` → 원본 대비 메시지 수, 이미지·첨부·수식·표·코드 수, 출력 파일 무결성(ZIP·XML 파싱), 다운로드 크기. 결과는 `pass / info / warn / fail`이고 가장 나쁜 값이 전체 수준이 됩니다.
- 사고 과정은 문서에서 빼고 JSON·ZIP에만 남깁니다. 2,000자를 넘는 도구 출력은 문서에 앞부분만 넣고 JSON·ZIP에는 전부 남깁니다. 두 경우 모두 검증 결과에 표시합니다.

## 인수인계 엔진 (src/handoff)

외부 모델 없이 결정론적으로 동작하고, 같은 입력이면 항상 같은 출력이 나옵니다.

1. **normalize**: 메시지를 문장·목록·제목·코드·표 단위로 나눕니다(`segment.ts`). 각 단위의 FNV 해시를 키로 이전 분석 결과를 캐시에서 다시 씁니다(`cache-codec.ts`, IndexedDB).
2. **dedupe**: 정확히 같은 해시끼리 묶고, MinHash(해시 32개, 8밴드) + LSH로 거의 같은 문단·코드를 union-find로 묶습니다. 대표는 가장 최근에 나온 것으로 고르고, 반복 횟수와 코드 수정 횟수를 셉니다.
3. **score**: 한국어·영어 규칙(`patterns.ts`, 지시·제약·결정·변경·완료·할 일·실패·원인·금지·허용 등 19개 플래그)과 최근성, 반복, 역할을 함께 봅니다.
4. **track**: 결정의 대체(“A 대신 B로”, “B로 확정”)를 주제 토큰 유사도로 연결합니다. 이전 결정은 지우지 않고 “이전 결정”으로 남기며, 근거가 약하면 ⚠️(바뀌었을 수 있음 / 해제됐을 수 있음 / 완료됐을 수 있음)로 표시합니다. 제약·금지사항은 출현 위치와 함께 합칩니다. 사용자의 수정 요청("버튼 문구 좀 바꿔 주세요")은 이전 선택을 뒤집는 표현("A 말고 B", "대신", "instead of", `REVERSAL_RE`)이 있을 때만 결정으로 봅니다. 금지 표현이 있는 문장("Redis는 쓰지 않기로 해요", "we won't use X")은 결정이 아니라 제약으로 보냅니다.
5. **select**: 섹션마다 예산(원문의 12%, 8k–32k 토큰)의 몫을 정하고 중요도 순으로 채웁니다. 예산의 대부분은 아래 "중요한 맥락"(커버리지 선택)에 남깁니다(v1.3, [3차 실험](compression-lab.md#3차-실험-질의응답-평가-v13)).
   - **몫**: 요청 흐름 6%, 완료 3%, 미완료 4%, 실패 2%, 코드 6%(최소 300토큰), 최근 원문 6%(최소 400토큰), 결정·지시 합쳐서 20%입니다. 결정은 그 절반까지 쓰고, 나머지는 금지·제약사항에 남겨 둡니다.
   - **목록 개수**: 파일 목록은 예산 200토큰당 하나(6–40개), 명령어는 700토큰당 하나(8–25개)입니다.
   - **중복 제한**: 같은 문장(또는 MinHash로 묶인 거의 같은 문장)은 문서 전체에서 한 번만 씁니다. 긴 답변 하나가 섹션을 채우지 않도록 답변당 4개로 제한합니다.
   - 최근 원문에는 마지막 두 메시지를 항상 넣습니다(각 2,500토큰까지). 그 앞 메시지는 예산의 6%(최대 1,500토큰)까지 넣고, 더 긴 메시지는 앞 60%·뒤 40%만 보여 줍니다.
   - 최신 코드가 최근 원문에 그대로 있으면 코드 섹션에는 위치(`[#mN]`)만 적습니다. 명령어 목록에 모두 있는 셸 블록은 다시 넣지 않습니다.
   - 마지막 답변이 최근 원문에 잘리지 않고 다 보이면, "현재 진행 상황"에는 그 핵심 문장 2개만 넣습니다.
   - **첨부 자료 (v1.3.5)**: 첨부 파일과 붙여넣은 글(Claude는 긴 붙여넣기를 이름 없는 txt 첨부로 저장)은 「첨부 자료」 섹션에 원문 그대로 넣습니다. 그 메시지가 최근 원문에 있으면 위치만 적습니다. 예산의 12%(`attachShare`, 최소 400토큰) 안에서 처음 요청과 마지막 요청의 첨부를 먼저, 나머지는 최근 것부터 넣고, 넘치면 앞뒤만 넣습니다(`clipMarkdown`). 대화 기록에 텍스트가 없는 파일(PDF, 이미지)은 이름만 한 목록으로 적고, 다음 AI가 사용자에게 다시 첨부를 요청하도록 안내합니다. 이름 없는 이미지(ChatGPT)는 요청 줄에 이미 "이미지"로 나오므로 목록에 넣지 않습니다. 요청 흐름과 마지막 요청에는 `(첨부 N개: 이름 — …)`로 첨부를 가리킵니다. 첨부 텍스트는 규칙 분류(결정·지시 등)에 넣지 않습니다. 남이 쓴 글의 "~하지 마세요"가 사용자 지시로 잘못 분류되지 않게 하기 위해서입니다.
   - **고쳐 쓴 초안 (v1.3.4)**: 원문 섹션에서 뒤 메시지가 거의 그대로 다시 쓴 줄(같은 줄, 또는 비슷한 길이에 단어 85% 이상이 같은 줄)과 같은 코드 블록은 가장 뒤 메시지에만 남깁니다. 앞 메시지에서는 그런 줄이 이어진 부분마다 `_(… N줄 생략 — 같거나 거의 같은 내용이 아래 [#mK]에 있습니다)_` 한 줄로 바꾸고, 달라진 줄은 그대로 둡니다. 24자보다 짧은 줄(제목, "가격: 3만원")은 느슨하게 비교하지 않습니다. 사용자의 줄은 뒤의 사용자 메시지로만 접습니다. 사용자가 한 말이 AI 답변으로만 남지 않게 하기 위해서입니다(`collapseRepeats`).
   - 나머지 예산은 "중요한 맥락"으로 채웁니다. 후보는 최근 원문 이전의 문장·목록·표, 그리고 **최근 원문에서 잘려 나간 가운데 부분**입니다. 선택은 예산 제약 최대 커버리지입니다(`coverage.ts`, lazy greedy). 단어와 인접 단어쌍을 개념으로 보고, 개념 가중치는 IDF × log 빈도(사용자가 쓴 단어는 ×1.5)입니다. 이미 문서에 들어간 결정·요청·최근 원문의 개념은 덮인 것으로 칩니다. 모든 개념이 덮이면 남은 예산은 관련도 순으로 채웁니다.
   - "이 방식은…", "그래서…", "This…"처럼 앞 문장을 가리키며 시작하는 문장(`ANAPHOR_RE`)은 앞 문장(같은 메시지 안에서 최대 두 문장)과 한 묶음으로, 비용을 합쳐 고릅니다. 앞 문장 없이 남으면 다음 AI가 무엇을 가리키는지 알 수 없기 때문입니다. 묶음의 비용은 고를 때마다 다시 계산합니다(`CoverHooks.cost`). 앞 문장이 이미 들어갔으면 그만큼 싸집니다.
   - 잘린 메시지에서 어떤 문장이 원문 섹션에 보이는지는 메시지 안에서 순서대로 찾아 판단합니다(같은 문장이 앞부분에 한 번 나와도 가운데의 같은 문장을 "보인다"고 보지 않음).
   - 첫 계산이 예산을 넘거나 4% 넘게 모자라면, 최대 두 번까지 그 차이를 중요한 맥락에서 빼거나 더합니다. 결과는 예산의 102%를 넘지 않고, 예산이 작아지면 문서도 작아집니다.
   - 선택 방식은 실제 대화로, 분량 배분은 질의응답 평가(합성 대화, 읽는 AI가 문서만 보고 답함)로 비교해 정했습니다([compression-lab.md](compression-lab.md)).
6. **render**: 사용자 요청은 시간순 "요청 흐름"으로 한 줄씩 보여 주고(거의 같은 요청은 한 줄로 묶어 횟수 표시), 긴 대화에서는 각 답변의 요지 문장을 붙입니다. 출처 칩·추적 파라미터를 지우고, 표·제목은 항목 목록에 넣지 않으며, 원문 안의 제목은 문서 목차보다 낮은 단계로 내립니다. 비어 있는 섹션은 넣지 않습니다. 안내문은 문서에 있는 섹션만 가리킵니다(결정·지시가 없으면 그 항목을, ⚠️가 없으면 그 항목을 뺍니다).
   - **크기 보장 (v1.3.8)**: 인수인계는 같은 대화의 전체 추출보다 항상 작습니다. `sourceTokens`는 전체 Markdown 추출의 토큰 수(`fullExportTokens`, 가장 짧은 라벨·이미지 링크 없이)이고, 예산은 그 12%(8k–32k)이되 2/3를 넘지 않습니다(`handoffBudget`). 예산 맞춤 단계 뒤에도 넘으면 선택 섹션을 빼고(`squeeze`) 원문을 더 줄이며, 그래도 넘으면 핵심 문장 형식으로 만듭니다. 이전에는 12k 토큰 이하 대화를 원문 전체 + 섹션(색인)으로 만들어 전체 추출보다 29–38% 컸습니다.
   - **핵심 문장 형식**: 예산이 4천 토큰 미만이면(전체 추출 약 6천 토큰 미만) 섹션 대신 대화 원문의 핵심 문장만 메시지 순서대로 남깁니다(`buildCondensed`). 마지막 메시지·마지막 요청·첫 요청의 앞부분, 사용자 문장, 짧은 코드 블록과 그 앞 문장(예산의 12%까지, 최신부터), 개념 커버리지, 점수 순으로 채우고, 생략한 곳은 `…`로 표시합니다. 예산이 작으면 꼬리말 → 출처 줄 → 긴 안내문 순으로 줄입니다. 실제 짧은 대화 3개에서 같은 크기의 섹션 형식보다 보존 점수가 높았습니다(59.5–81.3 → 85.3–88.0, [압축 실험](compression-lab.md)).
   - 작은 예산에서는 최소 분량(최근 원문, 코드, 첨부, 목록 개수)을 예산에 비례해 줄입니다. 8천 토큰 이상에서는 이전과 같습니다.
   - "중요한 맥락"을 고르기 전에 나머지 부분을 실제로 그려 크기를 잽니다(몇 ms). 발췌 한 줄의 비용은 그려지는 그대로(자르기, 메시지 묶음 줄) 셉니다. 첫 계산이 예산 ±4% 안에 들어 재계산이 거의 없습니다.
   - 토큰 수(`estimateTokens`)는 BPE 토크나이저처럼 글자를 단어·숫자 묶음·문장부호·줄바꿈 단위로 나눠 세며, o200k와 ±7% 안입니다(v1.3.8). 이전 규칙은 마크업을 절반쯤으로 셌습니다. 메시지 참조 색인(역할·시각·첫 줄 표)은 질문에 답하는 데 쓰이지 않으면서 문서의 7–12%를 차지해서, v1.3부터 기본으로 넣지 않습니다(`refIndex`).

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
