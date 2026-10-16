# 권한 설명 · Permissions

Lucian AI Chat Exporter가 요청하는 권한과 그 이유입니다. 기능에 꼭 필요한 권한만 요청합니다. `tabs`, `cookies`, `webRequest`, `history`, `<all_urls>`는 요청하지 **않습니다**.

## API 권한

| 권한 | 사용하는 곳 | 이유 |
|---|---|---|
| `storage` | `chrome.storage.session` (서비스 워커) | 진행 중인 작업의 상태(단계, 소요 시간, 검증 결과)를 저장합니다. 팝업을 닫았다 열어도 진행 상황이 보이게 하기 위한 것이며, 세션 저장소라 브라우저를 닫으면 사라집니다. 대화 본문이나 토큰은 넣지 않습니다. |
| `downloads` | `chrome.downloads.download / search / show / onDeterminingFilename` | 만든 파일(인수인계 Markdown, PDF를 뺀 모든 내보내기 형식)을 저장하고, 저장이 끝났는지와 크기를 확인하고, “파일 위치 열기”를 지원합니다. `onDeterminingFilename`은 **Lucian이 시작한 다운로드에만** 원래 파일 이름을 지정합니다. 다운로드 관리 확장이 이름을 가로채 blob UUID로 저장되는 문제를 막기 위한 것이며, 다른 다운로드에는 아무것도 하지 않습니다. |
| `offscreen` | `chrome.offscreen.createDocument` | 서비스 워커에는 DOM과 Web Worker가 없습니다. 그래서 DOCX·HWPX·ZIP 생성과 인수인계 분석(Web Worker)을 화면에 보이지 않는 offscreen 문서에서 실행합니다. 덕분에 팝업을 닫아도 작업이 계속됩니다. |
| `scripting` | `chrome.scripting.executeScript` | 확장을 설치·업데이트하기 전부터 열려 있던 AI 사이트 탭에는 콘텐츠 스크립트가 없습니다. 이런 탭에 확장 자신의 번들 파일(`content.js`, `inject.js`)만 주입합니다. 원격 코드는 주입하지 않습니다. |

## 호스트 권한

| 호스트 | 이유 |
|---|---|
| `https://chatgpt.com/*`, `https://chat.openai.com/*` | ChatGPT 대화 화면에서 대화를 수집합니다(`/backend-api/conversation/{id}`, 파일 다운로드 API). |
| `https://claude.ai/*` | Claude 대화 수집(`/api/organizations/{org}/chat_conversations/{id}`), 업로드 이미지 미리보기 |
| `https://gemini.google.com/*` | Gemini 대화 수집(`batchexecute` RPC `hNvQHb`) |
| `https://grok.com/*` | Grok 대화 수집(`/rest/app-chat/...`) |
| `https://*.oaiusercontent.com/*` | ChatGPT 이미지·첨부 원본 다운로드(파일 API가 이 도메인의 서명된 URL을 줄 때) |
| `https://*.googleusercontent.com/*` | Gemini 이미지 다운로드(`lh3.googleusercontent.com`) |
| `https://assets.grok.com/*` | Grok 생성 이미지·첨부 다운로드 |

이미지 호스트 권한은 문서에 이미지를 넣기 위한 것입니다. 페이지 안에서 이미지를 받지 못하면(CORS 등) 서비스 워커가 같은 URL을 다시 요청합니다.

## 콘텐츠 스크립트

| 파일 | 실행 위치 | 하는 일 |
|---|---|---|
| `inject.js` | 지원 사이트, `document_start`, **MAIN world** | 페이지가 서비스 서버로 보내는 요청의 헤더(ChatGPT 인증 헤더, Gemini `_reqid`·`x-goog-ext-*`, Grok `x-*`)를 **관찰만** 합니다. 확장이 같은 형식으로 대화를 요청할 수 있도록, 값은 그 탭의 메모리에만 둡니다. 요청 내용을 바꾸거나 막지 않습니다. |
| `content.js` | 지원 사이트, `document_idle`, isolated world | 사용자가 버튼을 누를 때만 대화를 수집해 서비스 워커로 넘깁니다. 답변 아래 도구 막대(복사·다시 생성 버튼 옆)에 작은 Lucian 버튼 하나를 Shadow DOM으로 추가합니다. 사이트의 기존 버튼과 화면은 옮기거나 바꾸지 않으며, 버튼을 누르기 전에는 대화를 읽지 않습니다. |

## 쿠키 사용

`cookies` 권한은 없습니다. 콘텐츠 스크립트가 같은 출처의 `document.cookie`에서 아래 두 값만 읽습니다. 둘 다 인증 토큰이 아니며 저장하지 않습니다.

- `claude.ai`의 `lastActiveOrg`: 대화가 속한 조직 ID(대화 API 경로에 필요)
- `chatgpt.com`의 `oai-did`: ChatGPT 웹이 모든 API 요청에 붙이는 기기 ID 헤더 값

## 하지 않는 것

- 원격 코드 로드, `eval`, `new Function`(빌드 결과물을 CI에서 검사합니다)
- 외부 서버 전송, 통계·광고·오류 수집 도구
- 인증 우회, 보안 기능 무력화, 로그인 정보·토큰의 디스크 저장
