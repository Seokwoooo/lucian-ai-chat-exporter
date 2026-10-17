# 개인정보처리방침 (초안) · Privacy Policy (draft)

> 이 문서는 Chrome 웹 스토어 등록용 **초안**입니다. 게시 전에 운영자 정보와 연락처를 채우고 법률 검토를 거쳐 주세요.

시행일: 2026-10-17 · 대상: Lucian AI Chat Exporter (Chrome 확장 프로그램) v1.3.3

## 1. 요약

Lucian AI Chat Exporter는 사용자가 연 AI 대화를 **사용자의 브라우저 안에서만** 파일로 만듭니다. 개발자나 제3자의 서버로 어떤 데이터도 보내지 않습니다. 회원가입, 계정, 통계, 광고가 없습니다.

## 2. 처리하는 정보

| 정보 | 언제 | 어디서 처리 | 보관 |
|---|---|---|---|
| 대화 내용(메시지, 코드, 표, 이미지, 첨부 정보) | 사용자가 팝업에서 버튼을 누를 때 | 사용자의 브라우저 | 이 브라우저의 IndexedDB. 7일 후 삭제 |
| 대화의 이미지·첨부 파일 | 내보내기에 필요할 때 | 사용자의 브라우저 | IndexedDB. 7일 후 삭제, 최대 500개 |
| 인수인계 분석 캐시(문단 해시·점수) | 인수인계 실행 시 | Web Worker | IndexedDB. 7일 후 삭제 |
| 작업 진행 상태 | 작업 중 | 서비스 워커 | `chrome.storage.session`. 브라우저를 닫으면 삭제 |
| 서비스의 요청 헤더(인증 헤더 등) | 페이지가 서비스 서버에 요청할 때 관찰 | 해당 탭의 메모리 | 저장하지 않음 |

만들어진 파일(Markdown, PDF, DOCX, HWPX, HTML, TXT, JSON, ZIP)은 사용자가 지정한 다운로드 폴더에 저장되며, 이후 관리는 사용자의 몫입니다.

## 3. 제3자 제공·전송

없습니다. 확장 프로그램이 접속하는 곳은 사용자가 이미 로그인해 쓰고 있는 AI 서비스(chatgpt.com, claude.ai, gemini.google.com, grok.com)와 그 서비스의 이미지·파일 호스트뿐입니다. 사용자가 화면에서 볼 수 있는 대화와 파일을 가져오기 위한 것이며, 해당 서비스의 이용약관과 개인정보처리방침이 함께 적용됩니다.

## 4. 사용하지 않는 것

- 인공지능 API, 임베딩 서비스, 외부 PDF 변환 서버
- 분석·통계·광고·오류 보고 도구
- 로그인 정보, 쿠키, 인증 토큰의 저장 또는 전송
- 인증 우회 또는 서비스 보안 기능의 무력화

## 5. 사용자의 선택

- 확장 프로그램을 제거하면 IndexedDB와 세션 저장소의 모든 데이터가 Chrome에 의해 삭제됩니다.
- 저장된 파일은 다운로드 폴더에서 직접 삭제할 수 있습니다.

## 6. 아동

이 확장 프로그램은 아동을 대상으로 하지 않으며, 아동의 개인정보를 따로 수집하지 않습니다.

## 7. 변경

이 방침이 바뀌면 이 저장소와 Chrome 웹 스토어 등록 정보에 공지합니다.

## 8. 문의

GitHub Issues: https://github.com/Seokwoooo/lucian-ai-chat-exporter/issues
(게시 전 운영자 이메일 주소를 추가하세요.)

---

## English summary

Lucian AI Chat Exporter turns AI conversations you open into files **entirely inside your browser**. It sends no data to the developer or any third party, and has no accounts, analytics or ads.

- **Processed:** the conversation you choose to export, its images and attachments, and a handoff analysis cache. All of it is stored only in this browser's IndexedDB and deleted after 7 days (the image cache holds at most 500 entries). Job progress is kept in `chrome.storage.session`.
- **Request headers** that the service page sends (for example an authorization header) are observed only in that tab's memory so the extension can make the same requests. They are never stored or transmitted elsewhere.
- **Network access** is limited to the AI services you already use (chatgpt.com, claude.ai, gemini.google.com, grok.com) and their image/file hosts.
- **Never used:** AI APIs, embeddings, external PDF servers, analytics or crash reporting, credential or cookie storage, authentication bypass.
- Uninstalling the extension removes all stored data.
