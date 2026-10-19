// Composes the Chrome Web Store images from the UI captures (capture.mjs) and renders them with
// Chrome at 2× before downscaling, so text and UI stay sharp at the store's exact sizes.
//
//   node scripts/store-assets/compose.mjs [en|ko ...]
//
// Output: store-assets/<lang>/*.png (24-bit PNG, no alpha) + store-assets/icon/store-icon-128.png


/* global document -- page-side code run through puppeteer */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { marked } from 'marked';
import puppeteer from 'puppeteer-core';
import { COPY } from './copy.mjs';

const CAP = resolve('test-output/store-captures');
const WORK = resolve('test-output/store-compose');
const OUT = resolve('store-assets');
const ICON = resolve('src/static/icons/icon-512.png');
const HERE = resolve('scripts/store-assets');

const fileUrl = (f) => pathToFileURL(f).href;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** "Text with <hl>highlight</hl>" → gradient span. */
const rich = (s) => esc(s).replace(/&lt;hl&gt;/g, '<span class="hl">').replace(/&lt;\/hl&gt;/g, '</span>').replace(/&lt;br&gt;/g, '<br>');

function pngSize(f) {
  const b = readFileSync(f);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/** A region of a 2× capture, in CSS pixels of the capture, drawn at `scale`. */
function crop(file, { x = 0, y = 0, w, h }, scale = 1, style = '') {
  const n = pngSize(file);
  const W = n.w / 2;
  const H = n.h / 2;
  w ??= W - x;
  h ??= H - y;
  return `<div class="crop" style="width:${w * scale}px;height:${h * scale}px;background-image:url('${fileUrl(file)}');background-size:${W * scale}px ${H * scale}px;background-position:${-x * scale}px ${-y * scale}px;${style}"></div>`;
}

const I = {
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  puzzle: '<path d="M9.5 4.5a2 2 0 1 1 4 0V6H17a1 1 0 0 1 1 1v3.5h1.5a2 2 0 1 1 0 4H18V18a1 1 0 0 1-1 1h-3.5v-1.5a2 2 0 1 0-4 0V19H6a1 1 0 0 1-1-1v-3.5h1.5a2 2 0 1 0 0-4H5V7a1 1 0 0 1 1-1h3.5z"/>',
  check: '<circle cx="12" cy="12" r="9.5"/><path d="m7.5 12.3 3 3 6-6.3"/>',
  server: '<rect x="3.5" y="4" width="17" height="6.5" rx="2"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2"/><path d="M7 7.25h.01M7 16.75h.01"/><path d="M3 3l18 18"/>',
  ai: '<path d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9z"/><path d="M18.5 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A9.7 9.7 0 0 1 12 6c6 0 9.5 6 9.5 6a16.6 16.6 0 0 1-3.1 3.8M6.4 7.6A16.4 16.4 0 0 0 2.5 12s3.5 6 9.5 6a9.4 9.4 0 0 0 4.2-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  user: '<circle cx="10" cy="8" r="4"/><path d="M3 20.5a7 7 0 0 1 12.5-4.3"/><path d="M17 15l4 4M21 15l-4 4"/>',
  key: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.5v2"/>',
  bolt: '<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/>',
  arrow: '<path d="M5 12h13m0 0-5-5m5 5-5 5"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
};
const svg = (name, size = 24, extra = '') => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${I[name]}</svg>`;

const BASE_CSS = `
:root { --a1:#7c5cff; --a2:#22d3ee; --ink:#0b0b10; }
* { box-sizing:border-box; margin:0; padding:0; }
html, body { overflow:hidden; }
body { position:relative; font-family:system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif; color:#fff; -webkit-font-smoothing:antialiased; word-break:keep-all; overflow-wrap:break-word; background:var(--ink); }
.abs { position:absolute; }
.crop { background-repeat:no-repeat; flex:none; }
.bg { position:absolute; inset:0; overflow:hidden;
  background:
    radial-gradient(760px 560px at -4% -8%, rgba(124,92,255,.50), transparent 62%),
    radial-gradient(640px 520px at 104% 108%, rgba(34,211,238,.30), transparent 62%),
    radial-gradient(560px 420px at 88% -6%, rgba(79,124,255,.22), transparent 64%),
    linear-gradient(160deg, #111019 0%, #0b0b10 55%, #0a0d14 100%); }
.bg::after { content:''; position:absolute; inset:0; background-image:radial-gradient(rgba(255,255,255,.07) 1px, transparent 1.2px); background-size:26px 26px;
  -webkit-mask-image:radial-gradient(900px 600px at 30% 20%, #000 0%, transparent 75%); }
.eyebrow { display:inline-flex; align-items:center; gap:9px; padding:7px 15px 7px 12px; border-radius:999px; background:rgba(124,92,255,.16); border:1px solid rgba(165,180,252,.34); color:#d4d9ff; font-size:15px; font-weight:650; letter-spacing:.01em; white-space:nowrap; }
.eyebrow i { width:8px; height:8px; border-radius:50%; background:linear-gradient(135deg,#a78bfa,#22d3ee); box-shadow:0 0 12px rgba(34,211,238,.8); }
h1 { font-weight:780; letter-spacing:-.028em; line-height:1.13; text-wrap:balance; }
:lang(ko) h1 { letter-spacing:-.035em; line-height:1.22; font-weight:800; }
.hl { background:linear-gradient(92deg,#c4b5fd 0%,#93c5fd 45%,#67e8f9 100%); -webkit-background-clip:text; background-clip:text; color:transparent; }
.sub { color:rgba(230,230,242,.76); line-height:1.5; text-wrap:pretty; }
:lang(ko) .sub { letter-spacing:-.01em; }

/* browser window */
.win { position:absolute; border-radius:14px; overflow:hidden; background:#fff; box-shadow:0 40px 90px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.10), 0 0 80px rgba(124,92,255,.18); }
.bar { height:46px; display:flex; align-items:center; gap:14px; padding:0 16px; background:#f2f2f5; border-bottom:1px solid #e3e3e8; color:#5b5b64; }
.dots { display:flex; gap:8px; flex:none; } .dots i { width:12px; height:12px; border-radius:50%; background:#ff5f57; } .dots i:nth-child(2){background:#febc2e} .dots i:nth-child(3){background:#28c840}
.omni { flex:1; height:30px; border-radius:999px; background:#fff; border:1px solid #e3e3e8; display:flex; align-items:center; gap:8px; padding:0 14px; font-size:13.5px; color:#3a3a40; min-width:0; white-space:nowrap; overflow:hidden; }
.omni svg { flex:none; color:#6b6b73; }
.omni .dim { color:#8a8a93; }
.tools { display:flex; align-items:center; gap:12px; flex:none; }
.ext { width:24px; height:24px; border-radius:7px; display:block; }
.ext-wrap { position:relative; width:30px; height:30px; display:flex; align-items:center; justify-content:center; border-radius:8px; }
.ext-wrap.on { background:#e5e3ff; box-shadow:0 0 0 2px #a5a1ff; }
.viewport { position:relative; overflow:hidden; }
.shadow-card { border-radius:16px; overflow:hidden; box-shadow:0 30px 70px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.12); }
`;

function browserWin({ x, y, w, h, url, content, hlIcon = false, tools = true }) {
  return `<div class="win" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">
  <div class="bar"><span class="dots"><i></i><i></i><i></i></span>
    <div class="omni">${svg('lock', 14)}${url}</div>
    ${tools ? `<div class="tools">${svg('puzzle', 20)}<span class="ext-wrap${hlIcon ? ' on' : ''}"><img class="ext" src="${fileUrl(ICON)}"></span></div>` : ''}
  </div>
  <div class="viewport" style="height:${h - 46}px">${content}</div>
</div>`;
}

const page = (lang, w, h, body, css = '') => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>${BASE_CSS}
html, body { width:${w}px; height:${h}px; }
${css}</style></head><body><div class="bg"></div>${body}</body></html>`;

// ------------------------------------------------------------------------------------------------
// Screenshots (1280×800)
// ------------------------------------------------------------------------------------------------

const PROVIDERS = resolve('src/static/providers');

/** Plain window: traffic lights and a centred address with the site's icon. Nothing else. */
function siteWin({ x, y, w, h, favicon, host, content, dark = false }) {
  return `<div class="swin${dark ? ' dark' : ''}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">
  <div class="sbar"><span class="dots"><i></i><i></i><i></i></span><span class="saddr"><img src="${fileUrl(join(PROVIDERS, favicon))}">${host}</span><span style="width:52px"></span></div>
  <div class="viewport" style="height:${h - 36}px">${content}</div>
</div>`;
}

const SCENE_CSS = `
.swin { position:absolute; border-radius:14px; overflow:hidden; background:#fff; box-shadow:0 36px 80px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.12); }
.sbar { height:36px; background:#f2f2f5; border-bottom:1px solid #e6e6ea; display:flex; align-items:center; justify-content:space-between; padding:0 14px; }
.sbar .dots i { width:11px; height:11px; }
.saddr { display:flex; align-items:center; gap:7px; font-size:13px; font-weight:600; color:#3a3a40; }
.saddr img { width:15px; height:15px; }
.dim, .focus { position:absolute; inset:0; }
.dim { filter:blur(2.5px) saturate(.6); opacity:.42; }
.focus { filter:drop-shadow(0 12px 28px rgba(0,0,0,.18)); }
.cursor { position:absolute; filter:drop-shadow(0 3px 5px rgba(0,0,0,.3)); }
`;

/**
 * The real Lucian panel on the ChatGPT-style page, cropped around the panel and its page button;
 * everything else is veiled so the eye goes to the panel. Returns content for a w×h viewport.
 */
function gptPanelScene(cap, w, h, s) {
  const L = JSON.parse(readFileSync(join(cap, 'layout.json'), 'utf8'));
  const top = L.panel.y;
  const bottom = L.button.y + L.button.h;
  const src = { x: L.panel.x - (w / s - L.panel.w) / 2, y: top - (h / s - (bottom - top)) / 2 };
  const at = (px, py) => [(px - src.x) * s, (py - src.y) * s];
  const [hx, hy] = at(L.panel.x - 6, top - 6);
  const [cx, cy] = at(L.primary.x + L.primary.w * 0.86, L.primary.y + L.primary.h * 0.7);
  const fw = (L.panel.w + 12) * s;
  const fh = (bottom - top + 12) * s;
  const shot = crop(join(cap, 'chat-panel.png'), { x: src.x, y: src.y, w: w / s, h: h / s }, s);
  // Page behind: blurred and faded. Panel and its page button: sharp.
  return `<div class="dim">${shot}</div>
<div class="focus" style="clip-path:inset(${hy}px ${w - hx - fw}px ${h - hy - fh}px ${hx}px round 14px)">${shot}</div>
<svg class="cursor" style="left:${cx - 2 * s}px;top:${cy - 2 * s}px" width="${24 * Math.max(s, 0.75)}" height="${32 * Math.max(s, 0.75)}" viewBox="0 0 26 34"><path d="M2 2v25l6.5-6.2 4.3 10 4.4-1.9-4.3-9.8H22z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>`;
}

/** claude.ai new chat, drawn at 540×414 and scaled: greeting and a composer holding the handoff file. */
function claudeScene(c, file, lines, w, h) {
  const ic = (d, size = 17, sw = 1.8) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  const k = w / 540;
  return `<div class="cl" style="width:540px;height:${h / k}px;transform:scale(${k});transform-origin:0 0">
  <div class="cl-greet"><img src="${fileUrl(join(PROVIDERS, 'claude.svg'))}"><span>${esc(c.greeting)}</span></div>
  <div class="cl-box">
    <div class="cl-file"><div class="cl-fname">${esc(file)}</div><div class="cl-flines">${esc(c.lines.replace('{n}', lines))}</div><span class="cl-badge">MD</span></div>
    <div class="cl-text">${esc(c.prompt)}<span class="caret"></span></div>
    <div class="cl-tools"><span class="cl-tb">${ic('M12 5v14M5 12h14', 17, 1.9)}</span><span class="cl-tb">${ic('M4 7h10M4 17h6M18 7h2M14 17h6M14 4v6M10 14v6', 16)}</span>
      <span style="flex:1"></span><span class="cl-model">${esc(c.model)} ${ic('m6 9 6 6 6-6', 13, 2)}</span><span class="cl-send">${ic('M12 19V5m0 0-6 6m6-6 6 6', 16, 2.4)}</span></div>
  </div>
</div>`;
}

const CLAUDE_CSS = `
.cl { position:absolute; left:0; top:0; display:flex; flex-direction:column; align-items:center; justify-content:center; background:#faf9f5; color:#1f1e1d; font-family:system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif; }
.cl-greet { display:flex; align-items:center; gap:11px; font:400 28px/1.2 ui-serif,"New York",Georgia,"Apple SD Gothic Neo",serif; color:#3d3929; letter-spacing:-.01em; margin-bottom:22px; }
.cl-greet img { width:28px; height:28px; }
.cl-box { width:468px; background:#fff; border:1px solid #e2dfd6; border-radius:20px; padding:14px 14px 10px; box-shadow:0 4px 20px rgba(60,40,10,.06); }
.cl-file { position:relative; width:128px; height:116px; border:1px solid #e6e3da; border-radius:10px; padding:10px 11px; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.04); }
.cl-fname { font-size:12.5px; font-weight:600; line-height:1.35; word-break:break-all; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.cl-flines { font-size:11.5px; color:#87867f; margin-top:3px; }
.cl-badge { position:absolute; left:10px; bottom:9px; font:700 10px/1 system-ui; color:#5e5d59; border:1px solid #d9d6cc; border-radius:5px; padding:4px 6px; letter-spacing:.04em; background:#faf9f5; }
.cl-text { font-size:15.5px; line-height:1.5; margin:12px 2px 14px; }
.caret { display:inline-block; width:1.5px; height:18px; background:#1f1e1d; vertical-align:-3px; margin-left:2px; }
.cl-tools { display:flex; align-items:center; gap:8px; }
.cl-tb { width:32px; height:32px; border:1px solid #e2dfd6; border-radius:9px; display:flex; align-items:center; justify-content:center; color:#5e5d59; }
.cl-model { display:flex; align-items:center; gap:4px; font-size:13.5px; color:#3d3d3a; margin-right:6px; }
.cl-send { width:32px; height:32px; border-radius:9px; background:#c96442; color:#fff; display:flex; align-items:center; justify-content:center; }
`;

/** The ChatGPT → Claude scene (two windows and one arrow), positioned inside a box. */
function handoffScene(lang, c, { x, y, w, h, gap }) {
  const cap = join(CAP, lang);
  const file = JSON.parse(readFileSync(join(cap, 'handoff-job.json'), 'utf8')).result.filename;
  const lines = readFileSync(join(cap, 'handoff.md'), 'utf8').replace(/\n$/, '').split('\n').length;
  const ww = (w - gap) / 2;
  const vh = h - 36;
  const arrow = 52 * Math.min(1, w / 1150);
  return `
${siteWin({ x, y, w: ww, h, favicon: 'chatgpt.svg', host: 'chatgpt.com', content: gptPanelScene(cap, ww, vh, Math.min(0.9, (vh - 24) / 445)) })}
${siteWin({ x: x + ww + gap, y, w: ww, h, favicon: 'claude.svg', host: 'claude.ai', content: claudeScene(c.claude, file, lines, ww, vh) })}
<div class="abs flowarrow" style="left:${x + ww + gap / 2 - arrow / 2}px;top:${y + h / 2 - arrow / 2}px;width:${arrow}px;height:${arrow}px">${svg('arrow', arrow * 0.46)}</div>`;
}

const FLOW_CSS = SCENE_CSS + CLAUDE_CSS + `
.flowarrow { z-index:3; border-radius:50%; background:linear-gradient(135deg,#7c5cff,#22d3ee); color:#fff; display:flex; align-items:center; justify-content:center; box-shadow:0 10px 30px rgba(34,211,238,.35), 0 0 0 6px rgba(255,255,255,.08); }
.flowarrow svg { stroke-width:2.4; }
`;

function shotFlow(lang, c) {
  const box = { x: 64, y: 200, w: 1152, h: 452, gap: 72 };
  const ww = (box.w - box.gap) / 2;
  return page(lang, 1280, 800, `
<div class="abs" style="left:0;right:0;top:52px;text-align:center">
  <span class="eyebrow"><i></i>${esc(c.eyebrow)}</span>
  <h1 style="font-size:46px;margin-top:18px">${rich(c.title)}</h1>
</div>
${handoffScene(lang, c, box)}
${c.steps.map((t, i) => `<div class="abs cap" style="left:${box.x + i * (ww + box.gap)}px;width:${ww}px;top:${box.y + box.h + 26}px"><b>${i + 1}</b>${esc(t)}</div>`).join('')}
`, FLOW_CSS + `
.cap { display:flex; align-items:center; justify-content:center; gap:10px; font-size:18px; font-weight:600; color:rgba(240,240,250,.9); }
.cap b { width:28px; height:28px; border-radius:50%; background:rgba(255,255,255,.1); border:1px solid rgba(255,255,255,.22); font-size:14px; display:flex; align-items:center; justify-content:center; }
`);
}

function shotHero(lang, c) {
  const cap = join(CAP, lang);
  const L = JSON.parse(readFileSync(join(cap, 'layout.json'), 'utf8'));
  // Main column only (the sidebar would show as a stray strip at this width).
  const win = { x: 130, y: 238, w: 1020, h: 620 }; // page width minus the 260 px sidebar
  const src = { x: 1280 - win.w, y: L.panel.y - 10 };
  const bx = win.x + (L.button.x - src.x) + L.button.w / 2;
  const by = win.y + 46 + (L.button.y - src.y) + L.button.h / 2;
  return page(lang, 1280, 800, `
<div class="abs" style="left:0;right:0;top:46px;text-align:center">
  <span class="eyebrow"><i></i>${esc(c.eyebrow)}</span>
  <h1 style="font-size:50px;margin-top:18px">${rich(c.title)}</h1>
  <p class="sub" style="font-size:20px;margin-top:12px">${rich(c.sub)}</p>
</div>
${browserWin({ ...win, url: `chatgpt.com<span class="dim">/c/6731c0de…</span>`, hlIcon: false, content: crop(join(cap, 'chat-panel.png'), { x: src.x, y: src.y, w: win.w, h: win.h - 46 }) })}
<div class="abs ring" style="left:${bx - 24}px;top:${by - 24}px"></div>
<div class="abs callout" style="left:${bx + 36}px;top:${by - 18}px"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5m0 0 6-6m-6 6 6 6"/></svg>${esc(c.callout)}</div>
`, `
.ring { width:48px; height:48px; border-radius:50%; box-shadow:0 0 0 2.5px #8b7bff, 0 0 0 9px rgba(124,92,255,.16), 0 0 30px rgba(124,92,255,.55); }
.callout { display:flex; align-items:center; gap:7px; height:36px; padding:0 16px 0 12px; border-radius:999px; background:linear-gradient(135deg,#6d4dff,#4f7cff); color:#fff; font-size:15px; font-weight:700; box-shadow:0 10px 26px rgba(79,70,229,.45); white-space:nowrap; }
`);
}

function renderHandoff(md) {
  const html = marked.parse(md, { gfm: true });
  return html.replace(/\[#m(\d+)\]/g, '<span class="ref">#m$1</span>').replace(/ ×(\d+)/g, ' <span class="times">×$1</span>');
}

function shotHandoff(lang, c) {
  const cap = join(CAP, lang);
  const md = readFileSync(join(cap, 'handoff.md'), 'utf8');
  const job = JSON.parse(readFileSync(join(cap, 'handoff-job.json'), 'utf8'));
  const name = job.result.filename;
  return page(lang, 1280, 800, `
<div class="abs" style="left:64px;top:92px;width:430px">
  <span class="eyebrow"><i></i>${esc(c.eyebrow)}</span>
  <h1 style="font-size:46px;margin-top:20px">${rich(c.title)}</h1>
  <ul class="bullets">${c.bullets.map((b) => `<li>${svg('check', 22)}<span>${rich(b)}</span></li>`).join('')}</ul>
</div>
<div class="win doc" style="left:540px;top:60px;width:690px;height:800px">
  <div class="bar docbar"><span class="dots"><i></i><i></i><i></i></span><div class="fname">${svg('doc', 15)}${esc(name)}</div><span style="width:52px"></span></div>
  <div class="viewport md" id="doc" style="height:754px"><article>${renderHandoff(md)}</article></div>
</div>
<div class="abs shadow-card status" style="left:64px;top:${lang === 'ko' ? 548 : 560}px">${crop(join(cap, 'panel-status.png'), {}, 1)}</div>
<script>
  const doc = document.getElementById('doc');
  const h = [...doc.querySelectorAll('h2')].find((e) => /^2\\./.test(e.textContent.trim()));
  doc.scrollTop = h.offsetTop + 1; // hide the section rule; its padding keeps the heading off the edge
</script>
`, `
.bullets { list-style:none; margin-top:30px; display:flex; flex-direction:column; gap:16px; }
.bullets li { display:flex; gap:12px; align-items:flex-start; font-size:18px; line-height:1.45; color:rgba(236,236,246,.86); }
.bullets svg { flex:none; margin-top:1px; color:#8be9fd; }
:lang(ko) .bullets li { font-size:17.5px; letter-spacing:-.01em; }
.docbar { justify-content:space-between; }
.fname { display:flex; align-items:center; gap:8px; font-size:13.5px; font-weight:600; color:#3a3a40; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.md { background:#fff; color:#1f1f24; overflow:hidden; }
.md article { padding:6px 40px 40px; font-size:14.5px; line-height:1.6; }
.md h1 { font-size:22px; letter-spacing:-.01em; margin:18px 0 12px; }
.md h2 { font-size:16.5px; font-weight:750; margin:20px 0 8px; padding-top:20px; border-top:1px solid #ececf0; color:#17171a; }
.md h3 { font-size:14px; color:#55555d; margin:10px 0 4px; font-weight:650; }
.md ul { padding-left:20px; margin:0 0 6px; } .md li { margin:3px 0; }
.md p { margin:6px 0; } .md blockquote { border-left:3px solid #c7c3ff; padding:4px 14px; color:#4a4a52; background:#f7f6ff; border-radius:0 8px 8px 0; margin:8px 0; }
.md code { font:12.5px ui-monospace,Menlo,monospace; background:#f2f2f5; padding:1px 5px; border-radius:5px; }
.md table { border-collapse:collapse; font-size:13px; } .md td, .md th { border:1px solid #e6e6ea; padding:4px 10px; }
.ref { display:inline-block; font:600 11.5px/1 ui-monospace,Menlo,monospace; color:#5b45e0; background:#efedff; border:1px solid #dcd7ff; border-radius:6px; padding:3px 6px; vertical-align:1px; margin-left:2px; }
.times { color:#8a8a93; font-size:12px; }
.status { border-radius:12px; }
`);
}

const FORMATS = { pdf: ['PDF', '#ef4444'], docx: ['DOCX', '#2563eb'], md: ['MD', '#7c5cff'], hwpx: ['HWPX', '#0891b2'], html: ['HTML', '#ea580c'], txt: ['TXT', '#64748b'], json: ['JSON', '#ca8a04'], zip: ['ZIP', '#16a34a'] };

/** File-type glyph: white sheet with a folded corner and a coloured label band. */
function fileIcon(id) {
  const [label, color] = FORMATS[id];
  return `<svg class="ficon" width="40" height="48" viewBox="0 0 40 48"><path d="M6 2h20l10 10v32a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#f4f4f8"/><path d="M26 2v8a2 2 0 0 0 2 2h8z" fill="#c9c9d6"/><rect x="0" y="25" width="31" height="14" rx="3" fill="${color}"/><text x="15.5" y="35.2" text-anchor="middle" fill="#fff" font-family="system-ui,-apple-system,sans-serif" font-size="${label.length > 3 ? 8.4 : 9.5}" font-weight="800" letter-spacing=".3">${label}</text></svg>`;
}

function shotExport(lang, c) {
  const cap = join(CAP, lang);
  const win = { x: 560, y: 56, w: 680, h: 800 };
  const popupH = pngSize(join(cap, 'popup.png')).h / 2;
  return page(lang, 1280, 800, `
<div class="abs" style="left:64px;top:50%;transform:translateY(-50%);width:470px">
  <span class="eyebrow"><i></i>${esc(c.eyebrow)}</span>
  <h1 style="font-size:44px;margin-top:20px;width:${lang === 'ko' ? 470 : 520}px">${rich(c.title)}</h1>
  <p class="sub" style="font-size:19px;margin-top:16px">${rich(c.sub)}</p>
  <div class="fmts">${c.formats.map(([id, name, desc]) => `<div class="fmt">${fileIcon(id)}<div class="fname2">${esc(name)}</div><div class="fdesc">${esc(desc)}</div></div>`).join('')}</div>
</div>
${browserWin({ ...win, url: `chatgpt.com<span class="dim">/c/6731c0de…</span>`, hlIcon: true, content: crop(join(cap, 'chat.png'), { x: 398, y: 57, w: win.w, h: win.h - 46 }, 1) })}
<div class="abs popup shadow-card" style="left:${win.x + win.w - 16 - 360 - 4}px;top:${win.y + 46 + 6}px;height:${Math.min(popupH, 800)}px">${crop(join(cap, 'popup.png'), {}, 1)}</div>
`, `
.fmts { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; margin-top:34px; }
.fmt { background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.12); border-radius:14px; padding:14px 8px 12px; text-align:center; }
.ficon { display:block; margin:0 auto 9px; }
.fname2 { font-size:15px; font-weight:700; white-space:nowrap; }
.fdesc { font-size:12.5px; color:rgba(230,230,242,.62); margin-top:2px; white-space:nowrap; }
.popup { border-radius:12px; box-shadow:0 30px 70px rgba(0,0,0,.35), 0 0 0 1px rgba(0,0,0,.08); }
`);
}

function shotFidelity(lang, c) {
  const cap = join(CAP, lang);
  const P = JSON.parse(readFileSync(join(cap, 'print-layout.json'), 'utf8'));
  const win = { x: 500, y: 56, w: 740, h: 800 };
  const scale = 0.9;
  const srcX = (860 - win.w / scale) / 2;
  const status = join(cap, 'status-pdf-verified.png');
  return page(lang, 1280, 800, `
<div class="abs" style="left:64px;top:64px;width:384px">
  <span class="eyebrow"><i></i>${esc(c.eyebrow)}</span>
  <h1 style="font-size:44px;margin-top:20px">${rich(c.title)}</h1>
  <p class="sub" style="font-size:18px;margin-top:16px">${rich(c.sub)}</p>
</div>
<div class="abs shadow-card verify" style="left:64px;bottom:40px">${crop(status, {}, 1)}</div>
${browserWin({ ...win, url: `<span class="dim">chrome-extension://…/</span>print.html`, tools: false, content: crop(join(cap, 'print.png'), { x: srcX, y: P.m2 + 2, w: win.w / scale, h: (win.h - 46) / scale }, scale) })}
`, `
.verify { border-radius:12px; box-shadow:0 30px 80px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.14); }
`);
}

function shotPrivacy(lang, c) {
  const cap = join(CAP, lang);
  return page(lang, 1280, 800, `
<div class="abs" style="left:64px;top:50%;transform:translateY(-50%);width:760px">
  <span class="eyebrow"><i></i>${esc(c.eyebrow)}</span>
  <h1 style="font-size:50px;margin-top:20px">${rich(c.title)}</h1>
  <p class="sub" style="font-size:19px;margin-top:14px;max-width:700px">${rich(c.sub)}</p>
  <div class="cards">${c.cards.map(([icon, t, d]) => `<div class="card"><span class="ci">${svg(icon, 24)}</span><b>${esc(t)}</b><p>${esc(d)}</p></div>`).join('')}</div>
  <div class="sites"><span class="lbl">${esc(c.sitesLabel)}</span>${['ChatGPT', 'Claude', 'Gemini', 'Grok'].map((s) => `<span class="site">${s}</span>`).join('')}</div>
</div>
<div class="abs shadow-card dark" style="left:874px;top:${(800 - pngSize(join(cap, 'popup-dark.png')).h / 2) / 2}px">${crop(join(cap, 'popup-dark.png'), {}, 1)}</div>
`, `
.cards { display:grid; grid-template-columns:repeat(3, 1fr); gap:14px; margin-top:34px; width:760px; }
.card { background:rgba(255,255,255,.055); border:1px solid rgba(255,255,255,.12); border-radius:16px; padding:18px 18px 16px; }
.ci { width:42px; height:42px; border-radius:12px; display:flex; align-items:center; justify-content:center; color:#fff; background:linear-gradient(135deg,rgba(124,92,255,.55),rgba(34,211,238,.35)); border:1px solid rgba(255,255,255,.18); margin-bottom:12px; }
.card b { display:block; font-size:18px; font-weight:750; letter-spacing:-.01em; }
.card p { font-size:14.5px; line-height:1.45; color:rgba(230,230,242,.68); margin-top:4px; }
.sites { display:flex; align-items:center; gap:10px; margin-top:28px; }
.sites .lbl { font-size:15px; color:rgba(230,230,242,.6); margin-right:4px; }
.site { padding:7px 14px; border-radius:999px; border:1px solid rgba(255,255,255,.16); background:rgba(255,255,255,.06); font-size:15px; font-weight:650; }
.dark { border-radius:12px; box-shadow:0 40px 90px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.14), 0 0 90px rgba(124,92,255,.22); }
`);
}

// ------------------------------------------------------------------------------------------------
// Promo tiles (not localizable in the store: one language is uploaded)
// ------------------------------------------------------------------------------------------------

const TILE_CSS = `
.tile { position:absolute; inset:0; overflow:hidden;
  background:
    radial-gradient(60% 80% at 0% 0%, rgba(255,255,255,.20), transparent 60%),
    radial-gradient(50% 70% at 100% 100%, rgba(34,211,238,.55), transparent 65%),
    linear-gradient(128deg, #4c2bdc 0%, #6a4cff 38%, #4f6dff 70%, #1fb5e0 100%); }
.tile::after { content:''; position:absolute; inset:0; background-image:radial-gradient(rgba(255,255,255,.16) 1px, transparent 1.3px); background-size:22px 22px; -webkit-mask-image:linear-gradient(100deg, transparent 30%, #000 75%); }
.icon { display:block; filter:drop-shadow(0 14px 24px rgba(20,10,80,.45)); }
.name { font-weight:800; letter-spacing:-.035em; line-height:1; }
.tag { color:rgba(255,255,255,.92); font-weight:650; letter-spacing:-.01em; }
.docc { position:absolute; background:#fff; border-radius:14px; box-shadow:0 22px 44px rgba(20,10,90,.40); overflow:hidden; }
.ln { height:7px; border-radius:4px; background:#e7e6f0; margin:0 0 8px; }
.ln.h { height:9px; background:#c9c3ff; width:55%; }
.chip { display:inline-block; height:13px; border-radius:4px; background:#efedff; border:1px solid #d9d4ff; width:28px; vertical-align:middle; margin-left:4px; }
.badge { position:absolute; color:#fff; font:800 13px/1 system-ui; letter-spacing:.03em; padding:7px 9px; border-radius:8px; box-shadow:0 10px 22px rgba(20,10,90,.35); }
`;

function docCard({ x, y, w, h, rot = 0, label, color, lines = 6 }) {
  const rows = Array.from({ length: lines }, (_, i) => (i === 0 || i === 3 ? '<div class="ln h"></div>' : `<div class="ln" style="width:${[0, 92, 78, 0, 86, 64, 80, 70][i % 8]}%">${i === 2 || i === 5 ? '' : ''}</div>`)).join('');
  return `<div class="docc" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;transform:rotate(${rot}deg)">
    <div style="height:${Math.round(h * 0.2)}px;background:${color};display:flex;align-items:center;padding:0 ${Math.round(w * 0.1)}px;color:#fff;font:800 ${Math.round(h * 0.09)}px/1 system-ui;letter-spacing:.04em">${label}</div>
    <div style="padding:${Math.round(h * 0.09)}px ${Math.round(w * 0.1)}px">${rows}</div></div>`;
}

function promoSmall(lang, c) {
  return page(lang, 440, 280, `<div class="tile"></div>
<img class="abs icon" src="${fileUrl(ICON)}" style="left:30px;top:34px;width:78px;height:78px">
<div class="abs name" style="left:30px;top:132px;font-size:54px">Lucian</div>
<div class="abs tag" style="left:32px;top:198px;width:230px;font-size:19px;line-height:1.3">${esc(c.tagline)}</div>
${docCard({ x: 300, y: 112, w: 104, h: 132, rot: 8, label: 'PDF', color: '#ef4444' })}
${docCard({ x: 262, y: 54, w: 116, h: 148, rot: -6, label: 'MD', color: '#6d4dff', lines: 7 })}
`, TILE_CSS);
}

function promoMarquee(lang, c) {
  const headline = esc(c.headline.replace(/<\/?hl>/g, ''));
  return page(lang, 1400, 560, `<div class="tile"></div>
<div class="abs left">
  <div style="display:flex;align-items:center;gap:22px">
    <img class="icon" src="${fileUrl(ICON)}" style="width:88px;height:88px">
    <div><div class="name" style="font-size:70px">Lucian</div><div class="tag" style="font-size:20px;margin-top:6px;opacity:.85">AI Chat Exporter</div></div>
  </div>
  <div class="tag headline">${headline}</div>
</div>
${handoffScene(lang, COPY[lang].s0, { x: 588, y: 118, w: 752, h: 324, gap: 56 })}
`, TILE_CSS + FLOW_CSS + `
.left { left:84px; top:0; bottom:0; width:470px; display:flex; flex-direction:column; justify-content:center; gap:30px; }
.headline { font-size:${lang === 'ko' ? 36 : 38}px; line-height:1.22; font-weight:780; letter-spacing:-.025em; color:#fff; text-wrap:balance; }
.swin { box-shadow:0 30px 60px rgba(20,10,90,.45), 0 0 0 1px rgba(255,255,255,.25); }
.flowarrow { background:#fff; color:#5b45e0; box-shadow:0 12px 28px rgba(20,10,90,.4); }
`);
}

// ------------------------------------------------------------------------------------------------

const ASSETS = [
  ['screenshot-1-handoff-flow', 1280, 800, shotFlow, 's0'],
  ['extra/screenshot-handoff-button', 1280, 800, shotHero, 's1'],
  ['screenshot-2-handoff-file', 1280, 800, shotHandoff, 's2'],
  ['screenshot-3-export-formats', 1280, 800, shotExport, 's3'],
  ['screenshot-4-verified-export', 1280, 800, shotFidelity, 's4'],
  ['screenshot-5-privacy', 1280, 800, shotPrivacy, 's5'],
  ['promo-small-440x280', 440, 280, promoSmall, 'small'],
  ['promo-marquee-1400x560', 1400, 560, promoMarquee, 'marquee'],
];

const findChrome = () => {
  const base = join(process.env.HOME, '.cache/lucian-cft/chrome');
  const dir = execFileSync('ls', [base]).toString().trim().split('\n').sort().reverse()[0];
  return join(base, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
};

const langs = process.argv.slice(2).length ? process.argv.slice(2) : ['en', 'ko'];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || findChrome(), headless: true, args: ['--allow-file-access-from-files', '--hide-scrollbars'] });
const raw = [];
for (const lang of langs) {
  mkdirSync(join(WORK, lang), { recursive: true });
  mkdirSync(join(OUT, lang), { recursive: true });
  for (const [name, w, h, fn, key] of ASSETS) {
    const html = fn(lang, COPY[lang][key]);
    mkdirSync(join(WORK, lang, 'extra'), { recursive: true });
    mkdirSync(join(OUT, lang, 'extra'), { recursive: true });
    const htmlPath = join(WORK, lang, `${name}.html`);
    writeFileSync(htmlPath, html);
    const p = await browser.newPage();
    await p.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
    await p.goto(fileUrl(htmlPath), { waitUntil: 'load' });
    await p.evaluate(() => document.fonts.ready);
    const png2x = join(WORK, lang, `${name}@2x.png`);
    await p.screenshot({ path: png2x, clip: { x: 0, y: 0, width: w, height: h } });
    await p.close();
    raw.push([png2x, join(OUT, lang, `${name}.png`), w, h]);
    console.log(`${lang}/${name}`);
  }
}
await browser.close();

// Downscale 2× → exact store size, flatten to 24-bit RGB (the store rejects alpha in screenshots/tiles),
// and copy the 128×128 package icon as the store icon (96×96 artwork + 16 px padding, scripts/make-icons.py).
writeFileSync(join(WORK, 'jobs.json'), JSON.stringify(raw));
mkdirSync(join(OUT, 'icon'), { recursive: true });
execFileSync('python3', ['-I', join(HERE, 'finish.py'), join(WORK, 'jobs.json'), resolve('src/static/icons/icon-128.png'), join(OUT, 'icon', 'store-icon-128.png')], { stdio: 'inherit' });
