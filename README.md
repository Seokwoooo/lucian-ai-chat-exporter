# Lucian AI Chat Exporter

[![CI](https://github.com/Seokwoooo/lucian-ai-chat-exporter/actions/workflows/ci.yml/badge.svg)](https://github.com/Seokwoooo/lucian-ai-chat-exporter/actions/workflows/ci.yml)
![Manifest V3](https://img.shields.io/badge/Chrome-MV3-1a1a1a)
![License: MIT](https://img.shields.io/badge/license-MIT-1a1a1a)

ChatGPT·Claude·Gemini·Grok 대화를 **한 번의 클릭으로 다른 AI에게 인수인계**하거나, **전체 대화를 PDF·Markdown·Word·한글(HWPX) 등으로 내보내는** Chrome 확장 프로그램입니다.

모든 처리는 브라우저 안에서 끝납니다. 대화 내용을 외부 서버나 AI로 보내지 않고, 회원가입도 설정도 없습니다.

[English](#english) · [설치](#설치) · [기능](#두-가지-기능) · [지원 범위](#지원-범위) · [개인정보](#개인정보) · [한계](#알려진-한계) · [개발](#개발)

| 답변 아래 Lucian 버튼 | 툴바 팝업 | 다른 형식 펼침 (다크 모드) |
|---|---|---|
| ![답변 아래 버튼](docs/images/page-button-done.png) | ![팝업](docs/images/popup-handoff-done.png) | ![다크 모드](docs/images/popup-dark.png) |

**두 곳에서 실행할 수 있습니다.** 답변이 끝나면 각 답변 아래 도구 막대(복사·다시 생성 버튼 옆)에 은은한 보라·청록 빛 링이 도는 Lucian 버튼이 나타나고, 브라우저 툴바의 Lucian 아이콘으로도 같은 기능을 엽니다. 어느 쪽에서 시작해도 같은 작업이며, 진행 상황(“처리 중… (n% 완료)”)과 결과가 양쪽에 보입니다.

---

## 두 가지 기능

### 1. AI에게 인수인계하기 — `인수인계 Markdown 추출`

버튼 하나로 `lucian-handoff-2026-10-16.md` 같은 파일이 저장됩니다. 이 파일을 다른 AI(다른 서비스나 새 대화)에 첨부하면 그 AI가 작업을 바로 이어받을 수 있습니다. 버튼 위의 작은 그림(지금 쓰는 서비스 로고 → 곡선 화살표 → 다른 서비스 로고)이 이 흐름을 보여 줍니다.

- 문서 맨 위에 **읽는 AI를 위한 안내문**이 있습니다. 이어서 기본 정보, 목표와 요청 흐름(처음 요청 + 이후 요청을 시간순으로, 긴 대화는 각 답변의 요지 한 줄과 함께), 확정된 결정(최신 기준), 지시·제한·금지사항, 완료한 작업, 현재 상태, 미완료 문제, 다음 작업, 실패 원인, 핵심 코드·파일, 참고 링크, 중요한 맥락(원문 발췌), 원문(짧은 대화는 전체, 긴 대화는 최근) 순으로 정리됩니다. 내용이 없는 섹션은 넣지 않습니다.
- **추출식 정리입니다.** LLM, 임베딩, 외부 API를 쓰지 않는 규칙 기반 TypeScript가 원문 문장을 그대로 발췌합니다. 그래서 없던 사실을 만들어 내지 않습니다. 모든 항목에는 원문 위치 `[#m12]`가 붙습니다.
- 결정이 바뀌면 최신 결정을 우선하되, 이전 결정도 지우지 않고 남깁니다. 키워드만으로 바뀌었다고 단정하지 않고, 확신할 수 없는 항목은 ⚠️로 표시합니다.
- 짧은 대화는 원문 전체를 포함하고, 긴 대화는 원문 분량의 약 12%(8k–32k 토큰)로 줄입니다. 섹션마다 토큰 몫을 정해 중요도 순으로 채우므로 문서가 목표 분량을 크게 넘지 않습니다.
- **같은 분량에 더 많은 정보를 담습니다.** 남은 예산은 "예산 제약 최대 커버리지"로 채웁니다. 문서에 아직 없는 개념(단어·단어쌍)을 토큰당 가장 많이 새로 담는 원문 문장부터 고르는 방식입니다. 아주 긴 메시지는 원문 섹션에서 앞뒤만 보여 주고, 잘린 가운데의 문장·표도 같은 조건으로 고릅니다. 사용자의 실제 ChatGPT 대화 27개(약 152만 토큰)로 알고리즘 19가지를 비교해 정했습니다. v1.1보다 출력이 9% 짧으면서 핵심어 보존은 82% → 88%, 사실 문장 보존은 25% → 29%로 올랐습니다. 자세한 내용은 [압축 실험 보고서](docs/compression-lab.md)에 있습니다.
- **잡음을 넣지 않습니다.** 웹 검색 답변에 딸린 수십~수백 개의 검색 결과 링크, 추적 파라미터(`utm_source` 등), 출처 칩, 서비스의 화면용 마크업은 빼고, 같은 문장은 한 섹션에만 넣습니다. 거의 같은 요청이 반복되면 한 줄로 묶고 횟수를 적습니다. 링크는 같은 페이지를 하나로 합쳐 많이 언급된 순으로 보여 줍니다.
- 성능: 1M 토큰(3,782개 메시지) 대화의 문서 생성 시간이 **0.63초**입니다(데이터 확보 → Markdown 완료, Chrome 155, M2 Pro). 같은 대화를 다시 만들 때는 분석 캐시를 써서 **0.42초**입니다. 네트워크·수집·생성·저장 시간은 팝업에 따로 표시됩니다.

### 2. 전체 대화 내보내기

| 기본 | `다른 형식 더 보기 ˅` |
|---|---|
| **PDF** · **Markdown** · **Word (.docx)** | **한글 (HWPX)** · HTML · TXT · JSON · **ZIP 전체 백업** |

- **PDF**: Chrome의 인쇄 엔진으로 내 컴퓨터에서 만듭니다. 인쇄 창의 대상에서 “PDF로 저장”을 고르면 됩니다. 한글 글꼴, 표, 코드, 수식, 이미지가 그대로 나오고, 외부 PDF 서버는 쓰지 않습니다.
- **HWPX**: 직접 생성한 OWPML 패키지입니다. 확장자만 바꾼 파일이 아니며, 공식 OWPML XSD 스키마 검증을 통과합니다.
- **ZIP 전체 백업**: `conversation.md/html/json`, `images/`, `attachments/`, `verification-report.md/json`을 담습니다. 받지 못한 이미지·첨부는 보고서에 명시합니다.
- 내보낼 때마다 **검증 결과**를 보여 줍니다. 원본 메시지 수 대비 추출 수, 이미지 포함 여부, 첨부 저장 여부, 수식 렌더링, 파일 무결성(ZIP·XML 파싱, 다운로드 크기 일치)을 확인하고, 빠진 것이 있으면 경고나 실패로 표시합니다.
- 문서의 출처 목록에는 **답변이 실제로 인용한 출처**만 넣습니다. 검색만 하고 인용하지 않은 결과는 JSON·ZIP 백업에 보존하고, 그 사실을 검증 결과에 적습니다.
- 팝업을 닫아도 작업은 계속됩니다(서비스 워커와 offscreen 문서에서 처리).

---

## 설치

### 릴리스 ZIP으로 설치 (개발자 모드)

1. [Releases](https://github.com/Seokwoooo/lucian-ai-chat-exporter/releases)에서 `lucian-ai-chat-exporter-v1.2.0.zip`을 받아 압축을 풉니다.
2. Chrome 주소창에 `chrome://extensions`를 입력합니다.
3. 오른쪽 위 **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 누르고, 압축을 푼 폴더(`manifest.json`이 있는 폴더)를 고릅니다.
5. ChatGPT·Claude·Gemini·Grok의 대화 화면을 **새로고침**합니다. 답변 아래의 Lucian 버튼이나 툴바의 Lucian 아이콘을 누르면 됩니다.

이전 버전에서 업데이트할 때는 `chrome://extensions`에서 Lucian의 새로고침(↻) 버튼을 누른 뒤, 열려 있던 대화 탭도 새로고침해 주세요.

### 소스에서 빌드

```bash
git clone https://github.com/Seokwoooo/lucian-ai-chat-exporter.git
cd lucian-ai-chat-exporter
npm ci
npm run build      # dist/ 폴더를 위 4단계에서 선택
```

Chrome 116 이상이 필요합니다.

---

## 지원 범위

| | ChatGPT | Claude | Gemini | Grok |
|---|---|---|---|---|
| 수집 방식 | 내부 API + DOM 대체 경로 | 내부 API + DOM 대체 경로 | batchexecute + DOM 대체 경로 | REST + DOM 대체 경로 |
| 텍스트·코드·표·목록 | ✅ | ✅ | ✅ | ✅ |
| 수식 | ✅ (PDF·HTML: 렌더링 / DOCX·HWPX·TXT: LaTeX 원문) | ✅ | ✅ | ✅ |
| 이미지 | ✅ 업로드·생성 이미지 | ✅ 업로드 이미지 미리보기 | ✅ | ✅ 생성·첨부 이미지 |
| 첨부파일 원본 (ZIP) | ✅ 파일 API | △ URL이 있을 때만, 없으면 추출 텍스트 | ❌ 이름 정보만 | △ URL이 있을 때만 |
| 캔버스·아티팩트 | ✅ Canvas | ✅ Artifacts | — | — |
| 출처·인용 | ✅ | ✅ 웹 검색 | ❌ 파싱 안 함 | ✅ |
| 사고 과정(Thinking) | JSON·ZIP에만 보존 | JSON·ZIP에만 보존 | ❌ 파싱 안 함 | JSON·ZIP에만 보존 |
| 다른 답변 분기 | JSON·ZIP에 보존 | JSON·ZIP에 보존 | — | JSON·ZIP에 보존 |
| 긴 대화 | ✅ | ✅ | ✅ 페이지 단위 수집 | ✅ |
| 답변 아래 Lucian 버튼 | ✅ | ✅ (예전 답변은 마우스를 올렸을 때) | ✅ | ✅ |

- ✅는 단위 테스트, 그리고 모의 사이트에 대한 E2E로 확인했다는 뜻입니다. 실제 서비스에서 무엇을 확인했는지는 [테스트 보고서](docs/test-report.md#6-실제-서비스-확인)에 정리했습니다.
- 지원 사이트가 아닌 페이지에서는 버튼이 비활성화되고 안내가 표시됩니다.
- 공유 링크(`/share/...`)와 대화 목록 페이지는 대상이 아닙니다. 대화를 연 화면에서 사용하세요.

---

## 개인정보

- 대화는 **사용자의 브라우저 안에서만** 처리됩니다. 분석 서버, 외부 AI, 통계 도구가 없습니다.
- 로그인 정보, 쿠키, 인증 토큰을 **디스크에 저장하지 않습니다.** 서비스 페이지가 쓰는 인증 헤더는 그 탭의 메모리에서만 요청에 사용합니다.
- 수집한 대화, 이미지, 인수인계 분석 캐시는 이 컴퓨터의 IndexedDB(`lucianDB`)에만 저장됩니다. 7일이 지나면 삭제되고(브라우저 시작 시와 작업 시작 시 정리), 이미지 캐시는 최근 500개까지만 유지합니다.
- 인증을 우회하거나 보안 기능을 무력화하지 않습니다. 사용자가 이미 볼 수 있는 대화만 읽습니다.
- 자세한 내용: [개인정보처리방침 초안](docs/privacy-policy.md) · [권한 설명](docs/permissions.md)

---

## 알려진 한계

솔직하게 적습니다. 자세한 내용은 [테스트 보고서](docs/test-report.md)에 있습니다.

- **실제 계정에서 확장 프로그램 전체 흐름은 검증하지 못했습니다.** 실제 사이트 4곳에서는 로그인된 브라우저로 내부 API의 응답 구조와 DOM 구조만 읽기 전용으로 확인했습니다. 설치 → 클릭 → 다운로드까지의 흐름은 모의 사이트 E2E로만 검증했습니다.
- 각 서비스의 내부 API와 화면 구조는 예고 없이 바뀔 수 있습니다. API가 실패하면 화면(DOM)에서 읽는 대체 경로를 쓰고, 그 사실을 검증 결과에 경고로 남깁니다.
- PDF는 인쇄 창에서 사용자가 “PDF로 저장”을 직접 골라야 합니다. 브라우저 확장이 PDF 파일을 바로 저장하는 안정적인 로컬 방법이 없기 때문입니다.
- Word·HWPX·TXT의 수식은 LaTeX 원문으로 들어갑니다(PDF·HTML은 렌더링).
- HWPX는 공식 XSD 검증과 오픈소스 렌더러(rhwp)로 확인했고, **한컴오피스에서 직접 열어 보지는 않았습니다.** DOCX도 python-docx와 macOS 미리보기로 확인했고, **MS Word로는 열어 보지 않았습니다.**
- Gemini의 사고 과정과 출처는 파싱하지 않습니다. 실제 계정에 10턴이 넘는 Gemini 대화가 없어서, 여러 페이지로 나뉜 Gemini 수집은 실제 데이터로 확인하지 못했습니다(모의 데이터로는 확인).
- 긴 도구 출력(웹 페이지 본문, 명령 실행 로그 등)은 문서에 앞부분 2,000자만 넣습니다. 전체는 JSON·ZIP 백업에 있고, 검증 결과에도 표시됩니다.
- 1M 토큰 대화의 DOCX 생성에는 약 2초가 걸립니다(Markdown 0.1초, HWPX 1초). 긴 작업은 진행률(%)을 보여 줍니다.
- 다운로드 관리 확장 프로그램(Video DownloadHelper 등)은 다른 확장의 파일 이름을 바꾸기도 합니다. Lucian은 자기 다운로드의 이름을 직접 지정해 이를 막고, 그래도 바뀌면 검증 결과에 경고로 표시합니다. Lucian보다 나중에 설치한 다운로드 관리 확장이 이름을 덮어쓰면 막을 수 없습니다.

---

## 개발

```bash
npm ci
npm run build               # dist/
npm run typecheck && npm run lint
npm test                    # 단위 테스트 (어댑터, 인수인계 정확도, 내보내기 형식)
npm run e2e:install-chrome  # Chrome for Testing 설치 (최초 1회)
npm run test:e2e            # 빌드된 확장을 Chrome for Testing에 올려 모의 사이트 4곳에서 전 형식 검증 + 1M 토큰 성능
npm run bench               # 인수인계 엔진 성능 (100k / 1M 토큰, Node)
npm run package             # release/lucian-ai-chat-exporter-v<version>.zip (Chrome 웹 스토어 업로드용)
```

구조는 [docs/architecture.md](docs/architecture.md)를 보세요. 사이트마다 독립 어댑터(`src/content/adapters/*.ts`)가 공통 `Conversation` 모델을 만들고, 내보내기 모듈(`src/export/`)과 인수인계 엔진(`src/handoff/`)이 그 모델을 사용합니다.

### 기여

- 두 가지 기능(인수인계, 내보내기)을 넘는 기능은 받지 않습니다. 작고 빠르고 정확한 것이 목표입니다.
- 사이트 구조가 바뀌면 해당 어댑터 파일 하나와 `tests/adapters`의 fixture만 고치면 되도록 유지해 주세요.
- **실제 대화, 쿠키, 토큰을 테스트 데이터로 커밋하지 마세요.** fixture는 모두 합성 데이터입니다.
- PR 전에 `npm run check`와 `npm run test:e2e`를 실행해 주세요.

## 라이선스

[MIT](LICENSE) © 2026 Seokwoooo. 번들된 오픈소스 라이선스는 빌드 결과물의 `THIRD_PARTY_NOTICES.txt`에 있습니다.

ChatGPT·OpenAI, Claude·Anthropic, Gemini·Google, Grok·xAI의 이름과 로고는 각 회사의 상표입니다. 인수인계 그림에서 서비스를 가리키는 용도로만 쓰며, 이 프로젝트는 어느 회사와도 관련이 없습니다.

---

## English

**Lucian AI Chat Exporter** is a Chrome extension (Manifest V3) for ChatGPT, Claude, Gemini and Grok with exactly two features:

1. **Handoff to another AI** — one click saves `lucian-handoff-YYYY-MM-DD.md`. It starts with instructions for the AI that reads it, followed by source info, the goal and request flow (every later request in order, with a one-line gist of each answer in long chats), confirmed decisions (latest first, older ones kept), instructions and constraints, completed work, current state, open problems, next steps, failure causes, key code and files, links, important context (verbatim excerpts) and the transcript (full for short chats, recent for long ones). Empty sections are left out. It is **extractive and rule-based**: no LLM, no embeddings, no external API. Every line points back to `[#mN]`, and uncertain judgements are marked ⚠️ instead of guessed. Noise is kept out: uncited search results, tracking parameters, citation chips and UI markup are dropped, each sentence appears in one section only, near-identical requests collapse into one line, and every section has a token share of the budget. Earlier context is chosen by budgeted maximum coverage (the verbatim sentences that add the most not-yet-covered concepts per token), and the middle of very long messages competes for the budget instead of being cut away — chosen by comparing 19 algorithms on 27 of the author's real ChatGPT conversations ([compression lab](docs/compression-lab.md)). A 1M-token conversation (3,782 messages) is processed in **0.63 s** (0.42 s with the incremental cache) inside Chrome.
2. **Full export** — PDF (Chrome's print engine, locally), Markdown and Word. **More formats** adds real HWPX (OWPML, validated against the official XSD), HTML, TXT, JSON and a ZIP backup with images, attachments and a verification report. Each export is verified: source message count vs. exported, images, attachments, math, and file integrity. Gaps are reported, never hidden.

Both features open from a small **Lucian button under every finished answer** (next to copy/retry, with a soft violet–cyan glow) and from the toolbar icon. Long jobs show “Processing… (n% done)”. A small illustration above the handoff button (this service's logo → curved arrow → the other services) shows what a handoff is. Documents list the sources an answer actually cited; uncited search results stay in the JSON/ZIP backup.

**Install:** download the release ZIP → unzip → `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select the folder → reload the chat page.

**Privacy:** everything runs in your browser. No servers, analytics or AI APIs. Auth tokens and cookies are never written to disk. Collected conversations, images and the handoff analysis cache stay in this browser's IndexedDB and are deleted after 7 days; the image cache keeps at most 500 entries. See [privacy policy draft](docs/privacy-policy.md) and [permissions](docs/permissions.md).

**Limitations:** the full install → click → download flow was verified end to end against mocked sites in Chrome for Testing. On the real sites, only the API responses and page structure were checked, read-only, in a logged-in browser. HWPX was not opened in Hancom Office and DOCX was not opened in Microsoft Word. Math in DOCX/HWPX/TXT is LaTeX source. PDF requires choosing “Save as PDF” in the print dialog. Gemini thinking and citations are not parsed. See the [test report](docs/test-report.md).

**Development:** `npm ci && npm run check`, `npm run test:e2e` (after `npm run e2e:install-chrome`), `npm run package`.

MIT licensed. Service names and logos (ChatGPT/OpenAI, Claude/Anthropic, Gemini/Google, Grok/xAI) are trademarks of their owners, used only to name the services; this project is not affiliated with any of them.
