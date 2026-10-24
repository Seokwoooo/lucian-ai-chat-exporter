# 개인정보처리방침 · Privacy Policy

Lucian AI Chat Exporter (Chrome 확장 프로그램) · 시행일 2026-10-24 · v1.3.10

게시본: https://lucianlabs.dev/ai-chat-exporter/privacy/ (Chrome 웹 스토어에 등록된 주소). 이 파일은 같은 내용의 사본이며, 서로 다르면 게시본을 따릅니다. [English below](#english)

## 01 요약

Lucian AI Chat Exporter는 사용자가 요청한 AI 대화를 사용자의 브라우저 안에서 파일로 만드는 Chrome 확장 프로그램입니다. 대화 내용을 비롯한 어떤 정보도 개발자나 제3자의 서버로 보내지 않습니다.

- 모든 처리는 사용자의 기기 안에서 끝납니다. 개발자는 사용자의 대화나 개인정보를 받지 않으며 볼 수도 없습니다.
- 회원가입, 계정, 통계, 광고, 오류 보고 도구가 없습니다.
- 사용자 데이터를 판매하거나, 확장 프로그램의 기능과 관계없는 목적으로 쓰지 않습니다.

## 02 운영자와 적용 범위

이 방침은 루샨(lucianLabs)이 만들어 배포하는 Chrome 확장 프로그램 Lucian AI Chat Exporter에 적용됩니다. 소스 코드는 [GitHub](https://github.com/Seokwoooo/lucian-ai-chat-exporter)에 MIT 라이선스로 공개되어 있어, 아래 내용을 누구나 직접 확인할 수 있습니다.

lucianlabs.dev 웹사이트를 방문할 때의 정보 처리는 [사이트 개인정보처리방침](https://lucianlabs.dev/privacy/)을 따릅니다.

## 03 처리하는 정보

확장 프로그램이 다루는 정보와 보관 방식은 아래가 전부입니다. 모두 사용자의 브라우저 안에만 있습니다.

| 정보 | 언제 | 보관 위치 · 기간 |
|---|---|---|
| **대화 내용** — 메시지, 코드, 표, 수식, 대화 제목, 이미지·첨부 정보 | 답변 아래 Lucian 버튼이나 툴바 팝업에서 인수인계·내보내기를 눌렀을 때 | 이 브라우저의 IndexedDB · 7일 |
| **이미지·첨부 파일** — 대화에 들어 있는 파일 | 문서에 넣거나 ZIP으로 묶을 때 | IndexedDB · 7일, 최근 500개까지 |
| **인수인계 분석 캐시** — 문장 해시 같은 숫자 값 | 인수인계 문서를 만들 때 | IndexedDB · 해당 대화와 함께 7일 |
| **작업 상태** — 대화 제목, 파일 이름, 진행 단계, 검증 결과 | 작업하는 동안 | `chrome.storage.session` · 브라우저를 닫으면 삭제 |
| **서비스 요청 헤더** — ChatGPT 인증 헤더, Gemini·Grok 요청 헤더 | 지원 사이트가 자기 서버에 요청할 때 관찰 | 그 탭의 메모리에만 · 저장하지 않음 |
| **쿠키 값 두 개** — claude.ai의 `lastActiveOrg`(조직 ID), chatgpt.com의 `oai-did`(기기 ID) | 대화를 가져올 때 읽기만 | 저장하지 않음 |
| **팝업 화면 설정** — ‘다른 형식 더 보기’를 펼쳤는지 여부 | 직접 펼치거나 접을 때 | 확장 프로그램의 로컬 저장소 · 제거할 때까지 |

대화에는 사용자가 직접 쓴 개인정보가 들어 있을 수 있습니다. 이런 내용도 위와 같이 이 브라우저 안에서만 처리됩니다. 확장 프로그램은 사용자가 답변 아래 Lucian 버튼이나 툴바 팝업의 버튼을 누르기 전에는 대화를 읽지 않습니다. 답변 아래에 버튼을 보여 줄 때도 대화 내용은 읽지 않습니다.

## 04 이용 목적

위 정보는 사용자가 요청한 파일(인수인계 Markdown, PDF, Markdown, Word, 한글(HWPX), HTML, TXT, JSON, ZIP)을 만들어 저장하는 데에만 씁니다. 같은 대화를 다시 처리할 때 더 빨리 끝내기 위한 캐시로도 씁니다. 그 밖의 목적으로는 쓰지 않습니다.

서비스가 요청을 잠시 막거나(HTTP 429) 네트워크·로그인 문제로 대화를 받아 오지 못하면, 앞서 이 브라우저의 IndexedDB에 저장해 둔 그 대화의 사본으로 파일을 만들 수 있습니다. 이때는 결과의 검증 정보에 사본을 썼다고 적고, 사본으로 만들어도 그 사본의 보관 기간(7일)은 늘어나지 않습니다. 이 사본도 어디로도 보내지 않습니다.

## 05 전송과 제3자 제공

개발자나 제3자에게 어떤 정보도 보내거나 제공하지 않습니다.

확장 프로그램의 네트워크 요청은 사용자가 이미 로그인해 쓰고 있는 AI 서비스(`chatgpt.com`, `chat.openai.com`, `claude.ai`, `gemini.google.com`, `grok.com`)와, 그 서비스가 이미지·첨부 파일을 두는 주소(`*.oaiusercontent.com`, `*.googleusercontent.com`, `assets.grok.com`)로만 갑니다. 사용자가 화면에서 이미 볼 수 있는 대화와 파일을 가져오기 위한 요청이며, 여기에는 해당 서비스의 이용약관과 개인정보처리방침이 적용됩니다.

만들어진 파일은 Chrome의 다운로드 기능으로 사용자의 다운로드 폴더에 저장됩니다. 그 파일을 다른 AI나 사람에게 건넬지는 사용자가 정합니다.

## 06 하지 않는 것

- 외부 AI API, 임베딩 서비스, PDF 변환 서버를 쓰지 않습니다.
- 분석·통계·광고·오류 보고 도구를 넣지 않습니다.
- 로그인 정보, 쿠키, 인증 토큰을 저장하지 않으며, 그 값이 속한 서비스 밖으로 보내지 않습니다.
- 원격 코드를 불러와 실행하지 않습니다. 모든 코드는 패키지 안에 있고 `eval`과 `new Function`을 쓰지 않습니다.
- 서비스의 인증을 우회하거나 보안 기능을 끄지 않습니다. 요청을 바꾸거나 막지도 않습니다.
- 사용자 데이터를 판매하거나, 맞춤 광고·신용 평가·대출 심사에 쓰지 않습니다.

## 07 Chrome 권한

- `storage`: 진행 중인 작업 상태를 세션 저장소에 둡니다. 팝업을 닫았다 열어도 진행 상황을 보여 주기 위한 것입니다.
- `downloads`: 만든 파일을 저장하고, 저장이 끝났는지 확인하고, ‘파일 위치 열기’를 지원합니다. 파일 이름은 Lucian이 시작한 다운로드에만 지정합니다.
- `offscreen`: 화면에 보이지 않는 문서에서 Word·한글·ZIP 파일과 인수인계 문서를 만듭니다. 팝업을 닫아도 작업이 이어집니다.
- `scripting`: 설치 전부터 열려 있던 지원 사이트 탭에 확장 프로그램 자신의 스크립트 파일만 넣습니다.
- 사이트 접근 권한: 위 ‘전송과 제3자 제공’에 적은 AI 서비스와 이미지·첨부 주소에만 접근합니다.

권한마다 쓰는 곳은 [권한 설명 문서](permissions.md)에 자세히 적어 두었습니다.

## 08 보관과 삭제

- IndexedDB에 저장한 지 7일이 지난 데이터는 브라우저를 다시 시작하거나 다음 작업을 실행할 때 삭제됩니다. 이미지 캐시는 최근 500개까지만 남깁니다.
- 작업 상태는 브라우저를 닫으면 지워집니다.
- 확장 프로그램을 제거하면 Chrome이 확장 프로그램의 저장소를 모두 삭제합니다.
- 다운로드한 파일은 사용자의 컴퓨터에 남으며, 사용자가 직접 삭제할 수 있습니다.

개발자의 서버에 저장된 사용자 데이터가 없으므로, 따로 열람이나 삭제를 요청할 데이터도 없습니다.

## 09 Chrome 웹 스토어 사용자 데이터 정책

Lucian AI Chat Exporter의 사용자 데이터 사용은 [제한적 사용(Limited Use) 요건](https://developer.chrome.com/docs/webstore/program-policies/limited-use)을 포함한 Chrome 웹 스토어 사용자 데이터 정책을 따릅니다.

## 10 아동

이 확장 프로그램은 아동을 대상으로 하지 않으며, 아동의 개인정보를 따로 수집하지 않습니다.

## 11 문의와 변경

개인정보에 관한 문의는 lucian.sw.kim@gmail.com으로 보내 주세요. 그 밖의 문의 방법은 [문의·지원](https://lucianlabs.dev/ai-chat-exporter/support/) 페이지에 있습니다.

이메일로 문의하면 이메일 주소와 문의 내용이 운영자에게 전달되어 Gmail에서 처리됩니다. 답변에만 쓰며, 필요하지 않게 되면 삭제합니다.

확장 프로그램의 정보 처리 방식이 바뀌면 이 페이지를 고치고 시행일을 갱신하며, GitHub 저장소와 Chrome 웹 스토어 등록 정보에도 알립니다.

---

## English

Lucian AI Chat Exporter (Chrome extension) · Effective 2026-10-24 · v1.3.10 · Published at https://lucianlabs.dev/ai-chat-exporter/privacy/ (the published page prevails if they differ).

### 01 Summary

Lucian AI Chat Exporter is a Chrome extension that turns the AI conversation you choose into a file, inside your browser. It sends no information, including your conversations, to the developer or any third party.

- Everything is processed on your device. The developer never receives your conversations or personal information and cannot see them.
- There are no sign-ups, accounts, analytics, ads or crash reporting.
- Your data is never sold or used for anything unrelated to what the extension does.

### 02 Operator and scope

This policy applies to Lucian AI Chat Exporter, a Chrome extension made and published by Lucian (lucianLabs). The source code is public on [GitHub](https://github.com/Seokwoooo/lucian-ai-chat-exporter) under the MIT license, so anyone can check what is described here. Visiting the lucianlabs.dev website is covered by the [site privacy policy](https://lucianlabs.dev/privacy/).

### 03 Information the extension handles

This is everything the extension handles and how it is kept. All of it stays inside your browser.

| Information | When | Where · how long |
|---|---|---|
| **Conversation content** — messages, code, tables, math, the chat title, image and attachment details | When you start a handoff or an export from the Lucian button under an answer or the toolbar popup | This browser's IndexedDB · 7 days |
| **Images and attachments** — files that are part of the chat | When they go into a document or ZIP | IndexedDB · 7 days, at most the latest 500 |
| **Handoff analysis cache** — numeric values such as sentence hashes | When a handoff file is built | IndexedDB · 7 days, with its conversation |
| **Job status** — chat title, file name, progress step, verification result | While a job runs | `chrome.storage.session` · cleared when the browser closes |
| **Service request headers** — the ChatGPT authorization header, Gemini and Grok request headers | Observed when a supported site calls its own server | Only in that tab's memory · never stored |
| **Two cookie values** — `lastActiveOrg` on claude.ai (organization ID), `oai-did` on chatgpt.com (device ID) | Read only, when fetching a chat | Never stored |
| **Popup display setting** — whether “More formats” is expanded | When you expand or collapse it | The extension's local storage · until uninstalled |

Your conversations may contain personal information you wrote yourself. It is handled the same way, only inside this browser. The extension does not read a conversation until you press a button in the Lucian panel under an answer or in the toolbar popup. Showing the button under answers does not read the conversation either.

### 04 How the information is used

The information is used only to build and save the file you asked for (handoff Markdown, PDF, Markdown, Word, HWPX, HTML, TXT, JSON or ZIP), and as a cache so the same conversation is processed faster next time. It is not used for anything else.

If a service briefly refuses requests (HTTP 429), or a network or login problem stops the conversation from loading, the file may be built from the copy of that conversation saved earlier in this browser's IndexedDB. The result's verification details then say a saved copy was used, and using the copy does not extend its 7-day retention. The copy is never sent anywhere either.

### 05 Transfers and sharing

No information is sent or disclosed to the developer or any third party. The extension only makes requests to the AI services you already use while logged in (`chatgpt.com`, `chat.openai.com`, `claude.ai`, `gemini.google.com`, `grok.com`) and to the addresses where those services keep images and attachments (`*.oaiusercontent.com`, `*.googleusercontent.com`, `assets.grok.com`). These requests fetch conversations and files you can already see, and the terms and privacy policies of those services apply to them. Finished files are saved to your download folder through Chrome's downloads feature. Whether you hand a file to another AI or person is up to you.

### 06 What the extension never does

- It uses no external AI APIs, embedding services or PDF conversion servers.
- It includes no analytics, tracking, advertising or crash-reporting tools.
- It never stores passwords, cookies or authentication tokens, and never sends them anywhere other than the service they belong to.
- It never loads or runs remote code. All code ships in the package and it does not use `eval` or `new Function`.
- It does not bypass a service's authentication or disable its security features, and it does not modify or block requests.
- It never sells user data or uses it for personalized ads, creditworthiness or lending decisions.

### 07 Chrome permissions

- `storage`: keeps the status of a running job in session storage, so the popup can show progress after it is reopened.
- `downloads`: saves finished files, confirms they were saved and supports “Show in folder”. It sets file names only on downloads Lucian started.
- `offscreen`: builds Word, HWPX and ZIP files and handoff documents in a hidden document, so jobs continue after the popup closes.
- `scripting`: adds the extension's own bundled script files to supported tabs that were open before installation.
- Site access: limited to the AI services and image/attachment addresses listed under “Transfers and sharing”.

Where each permission is used is detailed in the [permissions document](permissions.md).

### 08 Retention and deletion

- Data stored in IndexedDB for more than 7 days is deleted the next time the browser starts or a job runs. The image cache keeps only the latest 500 entries.
- Job status is cleared when the browser closes.
- Uninstalling the extension makes Chrome delete all of its stored data.
- Downloaded files stay on your computer, and you can delete them yourself.

Because no user data is stored on the developer's servers, there is nothing for the developer to provide or delete on request.

### 09 Chrome Web Store User Data Policy

The use of information by Lucian AI Chat Exporter adheres to the Chrome Web Store User Data Policy, including the [Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).

### 10 Children

The extension is not directed at children and does not knowingly collect children's personal information.

### 11 Contact and changes

Send privacy questions to lucian.sw.kim@gmail.com. Other ways to reach us are on the [Support](https://lucianlabs.dev/ai-chat-exporter/support/) page. If you email us, your address and message reach the operator and are handled in Gmail. They are used only to reply and are deleted when no longer needed. If the way the extension handles information changes, this page and its effective date will be updated, and the change will be noted in the GitHub repository and the Chrome Web Store listing.
