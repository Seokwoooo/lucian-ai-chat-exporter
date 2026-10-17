# Chrome 웹 스토어 등록 정보 (초안)

업로드 파일: `release/lucian-ai-chat-exporter-v1.3.2.zip` (`npm run package`로 생성, SHA-256은 같은 폴더의 `.sha256` 파일)

## 기본 정보

| 항목 | 값 |
|---|---|
| 이름 | Lucian AI Chat Exporter |
| 요약 (132자 이내) | ChatGPT·Claude·Gemini·Grok 대화를 원클릭으로 다른 AI에 인수인계하거나 PDF·Markdown·Word·한글로 손실 없이 내보냅니다. |
| 카테고리 | 생산성 (Productivity) |
| 언어 | 한국어(기본), 영어 |
| 공식 URL | https://github.com/Seokwoooo/lucian-ai-chat-exporter |
| 지원 URL | https://github.com/Seokwoooo/lucian-ai-chat-exporter/issues |
| 개인정보처리방침 URL | 게시한 `docs/privacy-policy.md`의 주소 (GitHub Pages 등) |

## 상세 설명 (한국어)

AI와 오래 작업한 대화를 다른 AI로 옮기거나, 문서로 보관해야 할 때 쓰는 도구입니다. 기능은 두 가지뿐이고, 답변 아래의 작은 Lucian 버튼이나 툴바 아이콘에서 바로 실행합니다.

■ AI에게 인수인계하기
버튼 하나로 현재 대화를 인수인계 문서(Markdown)로 저장합니다. 이 파일을 다른 AI에 첨부하면 바로 이어서 작업할 수 있습니다.
• 목표와 요청 흐름, 확정된 결정(최신 기준), 지시·금지사항, 완료한 작업, 현재 상태, 남은 문제, 다음 작업, 핵심 코드·파일을 정리합니다.
• 인용하지 않은 검색 결과 링크, 추적 파라미터, 화면용 마크업, 반복 문장은 넣지 않습니다.
• 원문을 그대로 발췌하므로 없는 내용을 지어내지 않고, 모든 항목에 원문 위치가 붙습니다. 확실하지 않은 판단은 ⚠️로 표시합니다.
• 100만 토큰 분량의 대화도 1초 안에 처리합니다.

■ 전체 대화 내보내기
PDF, Markdown, Word(.docx)를 바로 고를 수 있습니다. “다른 형식 더 보기”를 누르면 한글(HWPX), HTML, TXT, JSON, ZIP 전체 백업도 나옵니다.
• 코드, 표, 수식, 이미지, 첨부파일 정보를 보존합니다.
• 내보낼 때마다 메시지 수, 이미지, 첨부 저장 여부, 파일 무결성을 검사하고, 빠진 것이 있으면 숨기지 않고 알려 줍니다.

■ 개인정보
• 모든 처리는 브라우저 안에서 이뤄집니다. 외부 서버, AI API, 통계 도구가 없습니다.
• 회원가입이나 설정이 필요 없습니다.
• 로그인 정보와 토큰은 저장하지 않습니다.

지원 사이트: chatgpt.com, claude.ai, gemini.google.com, grok.com
각 서비스의 화면이나 내부 구조가 바뀌면 일부 기능이 일시적으로 동작하지 않을 수 있습니다. 그런 경우 화면에서 읽는 대체 경로를 쓰고, 그 사실을 검증 결과에 표시합니다.

## Detailed description (English)

Move a long AI conversation to another AI, or keep it as a proper document. Two features, nothing else — started from a small Lucian button under each answer or from the toolbar icon.

■ Handoff to another AI — one click saves a handoff Markdown file with the goal, latest confirmed decisions, constraints, completed work, current state, open issues, next steps and key code. It is extractive: lines are quoted from the conversation with message references, and uncertain items are flagged. 1M-token conversations are processed in about a second.

■ Full export — PDF, Markdown and Word, plus HWPX, HTML, TXT, JSON and a ZIP backup under “More formats”. Code, tables, math, images and attachment info are preserved, and every export is verified (message counts, images, attachments, file integrity), with any gaps reported.

■ Privacy — runs entirely in your browser. No servers, AI APIs, analytics, accounts or settings. Credentials and tokens are never stored.

Supported: chatgpt.com, claude.ai, gemini.google.com, grok.com.

## 단일 목적 (Single purpose)

사용자가 연 AI 채팅 대화를 다른 AI용 인수인계 문서 또는 보관용 파일(PDF, Markdown, Word, HWPX, HTML, TXT, JSON, ZIP)로 내보냅니다.

## 권한 사유 (심사 양식용)

| 권한 | 사유 |
|---|---|
| storage | 진행 중인 내보내기 작업의 상태를 세션 저장소에 보관해, 팝업을 다시 열어도 진행 상황과 검증 결과를 보여 줍니다. |
| downloads | 생성한 파일을 사용자의 다운로드 폴더에 저장하고, 저장 완료와 크기를 확인합니다. 다운로드 관리 확장이 파일 이름을 바꾸지 않도록 이 확장이 시작한 다운로드에만 파일 이름을 지정합니다(onDeterminingFilename). |
| offscreen | 서비스 워커에는 DOM과 Worker가 없으므로 문서 생성(DOCX/HWPX/ZIP)과 인수인계 분석을 offscreen 문서에서 실행합니다. 팝업을 닫아도 작업이 이어집니다. |
| scripting | 확장 설치 전부터 열려 있던 지원 사이트 탭에 확장 자신의 콘텐츠 스크립트 파일을 주입합니다. |
| 호스트 권한 (chatgpt.com, chat.openai.com, claude.ai, gemini.google.com, grok.com) | 사용자가 보고 있는 대화를 해당 서비스에서 가져옵니다. |
| 호스트 권한 (*.oaiusercontent.com, *.googleusercontent.com, assets.grok.com) | 대화에 포함된 이미지와 첨부 파일을 문서에 넣기 위해 내려받습니다. |

원격 코드: **사용하지 않음.** 모든 코드는 패키지에 포함되어 있고 `eval`/`new Function`을 쓰지 않습니다.

## 데이터 사용 공개 (Privacy practices)

- 수집하는 사용자 데이터: **웹사이트 콘텐츠**(사용자가 내보내기를 누른 대화). 이 데이터는 사용자의 기기 안에서만 처리되고, 개발자에게 전송되지 않습니다.
- 판매하지 않음 / 목적 외 사용 없음 / 신용 평가 등에 사용하지 않음: 모두 해당
- 인증 정보, 개인 통신, 위치, 웹 기록, 사용자 활동 데이터: 수집하지 않음

## 스크린샷 (1280×800 권장)

`docs/images/`의 팝업 캡처(360px 폭, 2배율)를 1280×800 캔버스 가운데에 놓아 만듭니다.
1. `popup-handoff-done.png` — 인수인계 완료와 단계별 소요 시간
2. `popup-dark.png` — 다른 형식 펼침, 다크 모드
3. `popup-export-done.png` — 내보내기 검증 결과
4. `print-preview.png` — PDF 인쇄 미리보기(한글, 표, 코드)
5. `popup-unsupported.png` — 지원하지 않는 페이지 안내

## 아이콘

`src/static/icons/icon-128.png` (스토어 아이콘), 원본 `icon-512.png`
