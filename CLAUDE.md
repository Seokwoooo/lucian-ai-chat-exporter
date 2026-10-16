# CLAUDE.md

Guidance for Claude Code (and other contributors) working in this repository.

## What this is

**Lucian AI Chat Exporter** — a Chrome MV3 extension with exactly two features:

1. **Handoff** — one click turns the current ChatGPT / Claude / Gemini / Grok conversation into an
   extractive handoff Markdown file (`lucian-handoff-YYYY-MM-DD.md`) that another AI can continue from.
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
npm run package      # build + release/lucian-ai-chat-exporter-v<version>.zip
npm run check        # typecheck + lint + test + build
```

E2E needs Chrome for Testing (branded Chrome ≥137 ignores `--load-extension`):
`npm run e2e:install-chrome` (installs into `~/.cache/lucian-cft`; or set `CHROME_PATH`). The E2E
suite also measures a 1M-token conversation end to end (`bench-results/e2e-chrome-1m.json`).

## Architecture (see docs/architecture.md)

```
page MAIN world  src/inject/main-world.ts   observes fetch/XHR headers (ChatGPT auth, Gemini _reqid/x-goog-ext)
                                            → window.postMessage "web-bridge" (handshake, 30s timeout)
content script   src/content/index.ts       picks the site adapter, collects, streams chunks over a Port
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
  into warn/fail checks. Never report a partial result as a clean success.
- Storage: IndexedDB `lucianDB` (conversations 7-day TTL, asset cache LRU 500, handoff cache).
  Never persist auth tokens or cookies.

## Rules

- The technical reference for collection logic is `docs/AI_Exporter_상세_작동원리_기술문서.md`
  (local only, git-ignored). Product behaviour and UX follow the product spec, not that document.
- No remote code, no `eval`, no analytics, no external servers. PDF must stay local.
- Site adapters must stay independent; keep selectors/indices in the adapter file so a site change
  is a one-file fix. Parsers are pure functions with fixture tests in `tests/adapters`.
- Handoff output must be extractive: every line traceable to `[#mN]`; uncertain judgements are
  marked ⚠️ rather than guessed. Update `tests/handoff/accuracy.test.ts` when changing heuristics.
- User-facing strings go through `src/shared/i18n.ts` (Korean default, English supported).
- Fixtures must be synthetic — never commit real conversations, cookies or tokens.
- Site structures change: when a real-site check finds a new shape (e.g. ChatGPT `channel:
  "commentary"`, virtualized transcripts), add a synthetic fixture that mirrors it before fixing.
- Documents show what the user saw: thinking is excluded (JSON/ZIP keep it), long tool output is
  clipped to `TOOL_DOC_LIMIT` with a visible note; every such decision is reported in verification.
- `scripts/build.mjs` strips the `new Function` branch from docx's bundled JSZip polyfill; CI fails
  if `eval`/`new Function` appears in `dist/`.
