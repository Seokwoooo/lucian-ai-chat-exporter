# CLAUDE.md

Guidance for Claude Code (and other contributors) working in this repository.

## What this is

**Lucian AI Chat Exporter** — a Chrome MV3 extension with exactly two features:

1. **Handoff** — one click turns the current ChatGPT / Claude / Gemini / Grok conversation into an
   extractive handoff Markdown file (`<chat-title>-lucian-handoff-YYYY-MM-DD.md`) that another AI can continue from.
   Zero settings. No LLM, no embeddings, no external API — rule-based TypeScript only.
2. **Export** — the full conversation as PDF (Chrome print engine, local), Markdown, Word (.docx),
   Hangul (.hwpx, real OWPML), HTML, TXT, JSON or a ZIP backup, with completeness verification.

Do not add features beyond these two. Small, fast and reliable beats feature count.

## Commands

```bash
npm install
npm run build        # esbuild → dist/ (load unpacked from here)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest unit tests (adapters, handoff accuracy, exporters)
npm run test:e2e     # builds, then drives Chrome for Testing with the extension against mocked sites
npm run bench        # handoff performance on ~100k / ~1M token synthetic conversations
npm run lab          # compression lab on synthetic conversations (algorithms × budgets, retention metrics)
npm run lab:file -- <in.json> <out.json>  # same lab on a local file of ChatGPT payloads (keep it outside the repo)
npm run lab:qa -- presence [ratios] [algos]  # QA evaluation on synthetic chats: planted answers present in the document (no AI)
npm run check:real -- <folder>  # real handoffs vs JSON exports of the same chats (folder outside the repo; see docs/test-report.md §8)
npm run package      # build + release/lucian-ai-chat-exporter-v<version>.zip
npm run check        # typecheck + lint + test + build
npm run store-assets # Chrome Web Store images (en/ko) from the real UI → store-assets/ (needs Chrome for Testing)
```

E2E needs Chrome for Testing (branded Chrome ≥137 ignores `--load-extension`):
`npm run e2e:install-chrome` (installs into `~/.cache/lucian-cft`; or set `CHROME_PATH`). The E2E
suite also measures a 1M-token conversation end to end (`bench-results/e2e-chrome-1m.json`).

## Architecture (see docs/architecture.md)

```
page MAIN world  src/inject/main-world.ts   observes fetch/XHR headers (ChatGPT auth, Gemini _reqid/x-goog-ext)
                                            → window.postMessage "web-bridge" (handshake, 30s timeout)
content script   src/content/index.ts       picks the site adapter, collects, streams chunks over a Port
  page button    src/content/page-ui.ts     Lucian button in each answer's toolbar (adapter.actionBars()) + panel
  adapters       src/content/adapters/*.ts  one file per site → common Conversation model (src/shared/types.ts)
  DOM fallback   src/content/dom-fallback.ts used only when the API path fails (reported as a warning)
service worker   src/background/index.ts    job state (chrome.storage.session), assets, offscreen, downloads
offscreen doc    src/offscreen/offscreen.ts builds files; handoff runs in src/handoff/worker.ts (Web Worker)
print page       src/print/print.ts         PDF via window.print() — nothing leaves the machine
popup            src/popup/*                two cards: handoff button, export formats (+ "more formats")
```

- Exporters live in `src/export/` and share one Markdown intermediate representation
  (`md-parse.ts` = marked + math tokenizers). Heavy modules (docx, hwpx, katex) are dynamic imports.
- `src/export/verify.ts` turns every gap (missing messages, images, attachments, unrendered math)
  into warn/fail checks. Never report a partial result as a clean success. XML above 4 MB is checked with
  the streaming `scanXmlWellFormed` instead of `DOMParser`.
- Progress: builders and the handoff engine report fractions; offscreen turns them into whole
  percents (`offscreen-progress`), shown as "처리 중… (n% 완료)" in the popup and the page panel.
  Updates change only the text and the bar: the spinner element is created once per job (a new
  element restarts its rotation — the E2E 1M test counts this).
- `src/shared/ui-icons.ts` holds the export buttons' format logos (main row Markdown · PDF · TXT; Word,
  HWPX, HTML, JSON, ZIP under "more formats", v1.3.7) and the Markdown image-choice icons, shared by
  the popup and the page panel. PDF/Word marks only name the format (Adobe/Microsoft trademarks).
- `src/shared/handoff-visual.ts` draws the "this AI → other AI" illustration above the handoff
  button (popup + page panel). Logos live in `src/static/providers/` (web-accessible on the five
  AI origins only); they are trademarks used only to name the services.
- Storage: IndexedDB `lucianDB` (conversations 7-day TTL, asset cache LRU 500, handoff cache).
  Never persist auth tokens or cookies.

## Rules

- The technical reference for collection logic is `docs/AI_Exporter_상세_작동원리_기술문서.md`
  (local only, git-ignored). Product behaviour and UX follow the product spec, not that document.
- No remote code, no `eval`, no analytics, no external servers. PDF must stay local.
- Site adapters must stay independent; keep selectors/indices in the adapter file so a site change
  is a one-file fix. Parsers are pure functions with fixture tests in `tests/adapters`.
- Handoff output must be extractive: every line traceable to `[#mN]`; uncertain judgements are
  marked ⚠️ rather than guessed. Update `tests/handoff/accuracy.test.ts` when changing heuristics,
  and bump `CACHE_VERSION` (src/handoff/cache-codec.ts) whenever `classify()` changes.
- Handoff noise rules: no uncited search results, no tracking params, a sentence appears in one
  section only, tables/headings never become bullets, every section stays within its budget share.
  A revised draft is shown once (earlier copies become a `_(… N줄 생략 …)_` note, `collapseRepeats`;
  never for table rows, and not when the note is longer than the lines).
  Attachment text the record has (pasted text, text files) goes into “첨부 자료” verbatim within
  `attachShare`; files without text are listed so the next AI can ask for them (v1.3.5).
- The handoff is never larger than the full export of the same chat (user report 2026-10-21: short
  chats were included whole + sections, 29–38% LARGER). `sourceTokens` = tokens of the full Markdown
  export (`fullExportTokens`); budget = `handoffBudget` (12%, 8k–32k, ≤ 2/3 of it); the render passes
  end with a hard ceiling. Budgets below `SECTIONS_FROM` (4k) get the condensed form (the chat's key
  sentences in order, `buildCondensed`) instead of sections. `estimateTokens` is fitted to o200k
  (±7%); `tests/handoff/size.test.ts` checks 133 shapes with real tokenizers — keep it green.
- A saved handoff is always shown as saved: ✓ “인수인계 파일 저장 완료”, its warn/fail checks folded
  under “세부 정보” and marked “!” (`shownLevel`/`shownStatus` in src/export/report.ts, v1.3.8). Only
  a handoff that saved no file (phase `error`) shows as failed. Verification data keeps the real level.
  Missing source messages carry `missingKinds` ("assistant:multimodal_text(…)") so the details name them.
- Documents and the handoff name the source by its site address (`sourceDomain`, src/shared/sites.ts:
  "grok.com"), never the model slug; only JSON/ZIP data keep `model` (v1.3.8).
- User-facing strings go through `src/shared/i18n.ts` (Korean default, English supported).
- Fixtures must be synthetic — never commit real conversations, cookies or tokens.
- Site structures change: when a real-site check finds a new shape (e.g. ChatGPT `channel:
  "commentary"`, virtualized transcripts), add a synthetic fixture that mirrors it before fixing.
- Real sites keep earlier conversations mounted but hidden after in-app navigation (chatgpt.com,
  2026-10). DOM counts and the DOM fallback use `renderedElements()` only; the E2E injects a hidden
  earlier conversation on all four sites and also forces the API to fail.
- Before releasing a change to collection or the handoff engine, run it on real conversations the
  way users do (in-app navigation, the in-page panel), export JSON + handoff for each, and run
  `npm run check:real` on that folder. Mock E2E alone missed the hidden-conversation bug (v1.3.2).
- Markdown cannot hold images and service image URLs need the user's login: a Markdown export of a
  chat with images stops in phase `choose` and the popup / page panel ask zip | folder | none
  (`mdImages`, v1.3.6). Never leave unusable image links without saying so.
- Documents show what the user saw: thinking is excluded (JSON/ZIP keep it), long tool output is
  clipped to `TOOL_DOC_LIMIT` with a visible note, uncited search results go to `moreSources`
  (JSON/ZIP only); every such decision is reported in verification.
- The in-page button must not disturb the site: Shadow DOM only, added into the toolbar without
  moving the site's controls (appended, or in front of the element `actionAnchor()` names — Gemini's
  `.spacer`, v1.3.8), no reading of the conversation until the user clicks. Toolbar selectors live
  in `actionBars()` / `actionAnchor()`.
- Grok (2026-10): the first question's parent is a hidden empty `system` response missing from
  `response-node`; paths walk listed nodes only. Failed answers carry only `streamErrors` and are
  kept as the notice grok.com shows (`> **Grok error:** …`).
- ChatGPT (2026-10): fenced code blocks carry `client_defined_widget` content references
  (`category: "code_block"`, `data.content`, empty `alt`) whose `matched_text` is the fence itself;
  keep it (replacing it with the empty alt deleted every command). The condensed handoff takes short
  code blocks together with the sentence that leads into them.
- `scripts/compression-lab/` compares selection algorithms; results are in `docs/compression-lab.md`.
  The engine's `DEFAULT_SELECTION` (coverage) and `DEFAULT_LAYOUT` were chosen there — re-run the
  lab (`npm run lab`, and `npm run lab:qa -- presence` for the QA evaluation; `qa/ask.mjs` uses a reader
  AI on synthetic documents only) before changing them. Real conversations used for it must never enter the repo (only
  aggregate numbers).
- `scripts/build.mjs` strips the `new Function` branch from docx's bundled JSZip polyfill; CI fails
  if `eval`/`new Function` appears in `dist/`.
