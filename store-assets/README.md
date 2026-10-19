# Chrome 웹 스토어 등록 이미지

개발자 대시보드 → 항목 → **스토어 등록정보(Store listing)** 탭의 "그래픽 애셋"에 올리는 파일입니다.
모든 화면은 실제 확장 프로그램(`dist/`, v1.3.7)을 Chrome for Testing에서 실행해 캡처했고, 대화 내용은 합성 데이터입니다(실제 대화·계정 정보 없음).

## 무엇을 어디에 올리나

| 대시보드 항목 | 규격 | 필수 | 언어별 등록 | 올릴 파일 |
|---|---|---|---|---|
| 스토어 아이콘 | 128×128 PNG (96×96 그림 + 사방 16px 투명 여백) | 필수 | 불가(공통) | `icon/store-icon-128.png` (패키지 `icon-128.png`와 같음) |
| 스크린샷 | 1280×800, 1~5장, JPEG 또는 24비트 PNG(알파 없음) | 1장 이상 | **가능** | `ko/screenshot-*.png`, `en/screenshot-*.png` |
| 작은 프로모션 타일 | 440×280 PNG/JPEG | 필수 | 불가(1개만) | `ko/` 또는 `en/promo-small-440x280.png` |
| 마키 프로모션 타일 | 1400×560 PNG/JPEG | 선택 | 불가(1개만) | `ko/` 또는 `en/promo-marquee-1400x560.png` |
| 홍보 동영상 | YouTube 링크 | 선택 | 가능 | (없음) |

- **스크린샷**: 언어 선택에서 "한국어"를 고른 뒤 `ko/` 5장, "English"를 고른 뒤 `en/` 5장을 순서대로 올립니다.
- **프로모션 타일**: 스토어가 언어별 타일을 받지 않으므로 하나만 올립니다. 사용자가 가장 많은 언어를 고르라는 것이 Google 안내입니다. 기본 언어가 한국어이므로 `ko/`를 권장하고, 해외 사용자를 노린다면 `en/`을 올립니다.
- 작은 타일이 없으면 검색·카테고리 목록에서 뒤로 밀리고, 마키 타일이 없으면 상단 추천 배너에 실릴 수 없습니다.

## 스크린샷 순서

1. `screenshot-1-handoff-flow` — ① ChatGPT에서 Lucian 패널 클릭 → ② Claude 입력창에 .md 파일 첨부 (마키 타일도 같은 장면)
2. `screenshot-2-handoff-file` — 실제로 생성된 인수인계 Markdown 파일 (결정·금지사항·다음 작업, `[#mN]` 출처)
3. `screenshot-3-export-formats` — 툴바 팝업과 8가지 내보내기 형식
4. `screenshot-4-verified-export` — PDF 인쇄 미리보기(표·수식·코드)와 검증 결과
5. `screenshot-5-privacy` — 브라우저 안에서만 처리 (서버·AI API·추적 없음), 다크 모드 팝업

`extra/screenshot-handoff-button.png`는 답변 아래 Lucian 버튼과 페이지 패널만 크게 보여 주는 예비 이미지입니다. 스크린샷은 최대 5장이라 기본 구성에서는 뺐고, 1번 대신 쓰거나 다른 장과 바꿔 올릴 수 있습니다.

ChatGPT·Claude 화면은 확장 프로그램이 실제로 동작하는 사이트를 보여 주기 위해 각 사이트 모양을 본떠 그렸습니다(대화·이름은 가상). Lucian 패널과 팝업, 인수인계 파일, PDF 미리보기는 실제 확장의 캡처입니다.

## 다시 만들기

UI나 문구가 바뀌면 다시 생성합니다 (Chrome for Testing 필요: `npm run e2e:install-chrome`).

```bash
npm run store-assets
```

- `scripts/store-assets/content.mjs` — 화면에 나오는 합성 대화 (영어·한국어)
- `scripts/store-assets/copy.mjs` — 이미지 위 문구
- `scripts/store-assets/capture.mjs` — 확장 UI 캡처 → `test-output/store-captures/`
- `scripts/store-assets/compose.mjs` — 2배율로 합성 후 정확한 크기로 축소, 알파 제거 → 이 폴더

규격 출처: [Supplying images](https://developer.chrome.com/docs/webstore/images), [Complete your listing information](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
