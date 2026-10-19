// A synthetic page in the style of chatgpt.com, served at chatgpt.com/c/<id> during capture. It
// carries the DOM hooks the ChatGPT adapter reads (message roles, answer toolbars); the layout only
// imitates the site so the store screenshots show the extension where it really runs.

import katex from 'katex';
import { marked } from 'marked';
import { CONVERSATIONS } from './content.mjs';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderMarkdown(md) {
  const math = [];
  const keep = (html) => `@@MATH${math.push(html) - 1}@@`;
  let src = md.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => `\n\n${keep(katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false }))}\n\n`);
  src = src.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => keep(katex.renderToString(tex.trim(), { throwOnError: false })));
  let html = marked.parse(src, { gfm: true });
  html = html.replace(/<pre><code class="language-(\w+)">/g, `<pre data-lang="$1"><div class="code-head"><span>$1</span><span class="copy">${ICON('copy', 14)}Copy code</span></div><code>`);
  html = html.replace(/<table>/g, '<div class="tbl"><table>').replace(/<\/table>/g, '</table></div>');
  return html.replace(/@@MATH(\d+)@@/g, (_, i) => math[Number(i)]);
}

const PATHS = {
  copy: 'M8 8h11v11H8zM5 16V5h11',
  up: 'M7 10v10M7 10l4-7a2 2 0 0 1 3 2l-1 5h6l-2 9H7',
  down: 'M17 14V4M17 14l-4 7a2 2 0 0 1-3-2l1-5H5l2-9h10',
  share: 'M12 15V3m0 0L8 7m4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6',
  retry: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  pen: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
  library: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9h.01',
  panel: 'M4 4h16v16H4zM9 4v16',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  plus: 'M12 5v14M5 12h14',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  chev: 'm6 9 6 6 6-6',
  wave: 'M5 10v4M9 7v10M13 9v6M17 6v12M21 10v4',
};
const ICON = (name, size = 18, sw = 1.8) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"><path d="${PATHS[name]}"/></svg>`;
const ICON_BTN = (label, name) => `<button aria-label="${label}" class="ib">${ICON(name, 17)}</button>`;
const ACTIONS =
  '<div class="mt-1.5 flex turn-action-controls"><div class="flex min-h-5 bar">' +
  ICON_BTN('Copy', 'copy') +
  ICON_BTN('Good response', 'up') +
  ICON_BTN('Bad response', 'down') +
  ICON_BTN('Share', 'share') +
  ICON_BTN('Try again', 'retry') +
  ICON_BTN('More actions', 'more') +
  '</div></div>';

const UI = {
  en: {
    nav: [['pen', 'New chat'], ['search', 'Search chats'], ['library', 'Library']],
    nav2: [['grid', 'GPTs'], ['folder', 'Projects']],
    chatsLabel: 'Chats',
    chats: ['Pricing page A/B test', 'Onboarding email sequence', 'Q4 roadmap review', 'SQL for weekly cohorts', 'Landing page copy ideas', 'Interview questions: PM', 'Churn survey summary'],
    user: ['JP', 'Jamie Park', 'Plus'],
    share: 'Share',
    placeholder: 'Ask anything',
    disclaimer: 'ChatGPT can make mistakes. Check important info.',
  },
  ko: {
    nav: [['pen', '새 채팅'], ['search', '채팅 검색'], ['library', '라이브러리']],
    nav2: [['grid', 'GPT'], ['folder', '프로젝트']],
    chatsLabel: '채팅',
    chats: ['요금제 페이지 A/B 테스트 분석', '온보딩 이메일 시퀀스', '4분기 로드맵 검토', '주간 코호트 SQL 작성', '랜딩 페이지 문구 아이디어', 'PM 면접 질문 정리', '이탈 설문 요약'],
    user: ['지민', '김지민', 'Plus'],
    share: '공유하기',
    placeholder: '무엇이든 물어보세요',
    disclaimer: 'ChatGPT는 실수를 할 수 있습니다. 중요한 정보는 재차 확인하세요.',
  },
};

export function chatPage(lang) {
  const c = CONVERSATIONS[lang];
  const u = UI[lang];
  const turns = c.messages
    .map(([role, text]) =>
      role === 'user'
        ? `<div class="turn user" data-message-author-role="user"><div class="whitespace-pre-wrap bubble">${esc(text).replace(/`([^`]+)`/g, '<code>$1</code>')}</div></div>`
        : `<div class="turn assistant"><div data-message-author-role="assistant"><div class="markdown">${renderMarkdown(text)}</div></div>${ACTIONS}</div>`,
    )
    .join('');
  const nav = (items) => items.map(([icon, label]) => `<div class="nav">${ICON(icon, 18)}<span>${label}</span></div>`).join('');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${esc(c.title)}</title>
<link rel="stylesheet" href="/__static/katex/katex.min.css">
<script>document.cookie = "oai-did=store-capture-device; path=/";</script>
<style>
*{box-sizing:border-box} html,body{margin:0;height:100%}
body{font:16px/1.75 ui-sans-serif,-apple-system,system-ui,"Segoe UI","Apple SD Gothic Neo",Helvetica,Arial,sans-serif;color:#0d0d0d;background:#fff;-webkit-font-smoothing:antialiased;word-break:keep-all;display:flex}
aside{width:260px;flex:none;background:#f9f9f9;padding:8px 8px 10px;display:flex;flex-direction:column;height:100vh;position:sticky;top:0;font-size:14px;line-height:1.4}
.side-top{display:flex;align-items:center;justify-content:space-between;height:44px;padding:0 6px 0 8px;color:#5d5d5d}
.side-top img{width:24px;height:24px}
.nav{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:10px;color:#0d0d0d}
.nav svg{color:#0d0d0d;flex:none}
.gap{height:14px}
.label{color:#8f8f8f;padding:6px 10px 4px;font-size:14px}
.item{padding:7px 10px;border-radius:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item.active{background:#ececec}
.me{margin-top:auto;display:flex;align-items:center;gap:10px;padding:8px 8px;border-radius:10px}
.av{width:28px;height:28px;border-radius:50%;background:#7c5cff;color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;flex:none}
.me b{display:block;font-weight:500} .me small{color:#8f8f8f;font-size:12px}
.main{flex:1;min-width:0;display:flex;flex-direction:column;height:100vh;position:relative}
.top{height:52px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:0 12px 0 16px}
.model{display:flex;align-items:center;gap:4px;font-size:18px;font-weight:500;padding:6px 10px;border-radius:10px}
.model svg{color:#8f8f8f}
.actions{display:flex;align-items:center;gap:6px;font-size:14px}
.sharebtn{display:flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px}
.scroll{flex:1;overflow:auto}
.col{max-width:768px;margin:0 auto;padding:20px 24px 170px}
.turn{margin:0 0 30px}
.user{display:flex;justify-content:flex-end}
.bubble{background:#f4f4f4;border-radius:18px;padding:10px 18px;max-width:70%;white-space:pre-wrap;line-height:1.6}
.bubble code{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:#e8e8e8;padding:2px 5px;border-radius:5px}
.markdown p{margin:0 0 14px}
.markdown h2{font-size:20px;font-weight:600;margin:22px 0 10px;line-height:1.4}
.markdown ul{margin:0 0 14px;padding-left:24px} .markdown li{margin:2px 0}
.markdown strong{font-weight:600}
.tbl{margin:4px 0 16px;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden;display:inline-block}
.markdown table{border-collapse:collapse;font-size:15px;line-height:1.5}
.markdown th,.markdown td{border-bottom:1px solid #ececec;padding:9px 16px;text-align:left}
.markdown tr:last-child td{border-bottom:0}
.markdown th{font-weight:600;background:#f9f9f9}
.markdown code{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:#ececec;padding:2px 5px;border-radius:5px}
.markdown pre{background:#f9f9f9;border-radius:16px;overflow:hidden;margin:0 0 16px;border:1px solid #efefef}
.markdown pre code{display:block;background:none;padding:6px 18px 16px;font-size:13.5px;line-height:1.6;white-space:pre;overflow:auto}
.code-head{display:flex;justify-content:space-between;align-items:center;font:12px/1 system-ui;color:#5d5d5d;padding:12px 14px 8px 18px}
.code-head .copy{display:flex;align-items:center;gap:5px}
.katex-display{margin:8px 0 16px}
.bar{display:flex;align-items:center;gap:0;margin-left:-6px}
.ib{width:32px;height:32px;border:0;border-radius:8px;background:none;color:#5d5d5d;display:inline-flex;align-items:center;justify-content:center}
.composer{position:absolute;left:0;right:0;bottom:0;padding:0 24px 10px;background:linear-gradient(rgba(255,255,255,0),#fff 32%)}
.box{max-width:768px;margin:0 auto;border-radius:28px;padding:10px 10px 10px 12px;color:#8f8f8f;box-shadow:0 4px 4px rgba(0,0,0,.04),0 0 1px rgba(0,0,0,.62);display:flex;align-items:center;gap:10px;background:#fff}
.box .ph{flex:1;font-size:16px}
.box .circle{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#0d0d0d}
.box .voice{background:#0d0d0d;color:#fff}
.disc{text-align:center;font-size:12px;color:#5d5d5d;padding-top:8px}
</style></head><body>
<aside>
  <div class="side-top"><img src="/__static/providers/chatgpt.svg" alt="">${ICON('panel', 20)}</div>
  ${nav(u.nav)}
  <div class="gap"></div>
  ${nav(u.nav2)}
  <div class="gap"></div>
  <div class="label">${u.chatsLabel}</div>
  ${u.chats.map((t, i) => `<div class="item${i === 0 ? ' active' : ''}">${esc(t)}</div>`).join('')}
  <div class="me"><span class="av">${u.user[0]}</span><div><b>${u.user[1]}</b><small>${u.user[2]}</small></div></div>
</aside>
<div class="main">
  <div class="top"><div class="model">ChatGPT ${ICON('chev', 16, 2)}</div><div class="actions"><span class="sharebtn">${ICON('share', 16)}${u.share}</span><span class="ib">${ICON('more', 18)}</span></div></div>
  <div class="scroll" id="scroll"><main class="col">${turns}</main></div>
  <div class="composer"><div class="box"><span class="circle">${ICON('plus', 20)}</span><span class="ph">${u.placeholder}</span><span class="circle">${ICON('mic', 19)}</span><span class="circle voice">${ICON('wave', 18, 2.2)}</span></div><div class="disc">${u.disclaimer}</div></div>
</div>
</body></html>`;
}
