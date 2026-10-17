// Small illustration above the handoff button: the current service's logo, a curved arrow
// carrying a Markdown file, and the other services' logos taking turns as the destination.
// Shared by the popup and the in-page panel. Logos are trademarks of their owners and are used
// only to name the services. Motion is CSS/SMIL only and stops with prefers-reduced-motion.

import { t, type Locale } from './i18n';
import { SITES } from './sites';
import type { SiteId } from './types';

const ORDER: SiteId[] = ['chatgpt', 'claude', 'gemini', 'grok'];
// The arc is drawn 1:1 in pixels: the SVG sits in a fixed 120px column between two 56px logo columns,
// so x=-13 and x=133 are the logos' facing edges and y=15 is their vertical centre.
const ARC = 'M-6 15 C 24 -5, 96 -5, 126 15';

export const HANDOFF_VISUAL_CSS = `
.hv { display: grid; grid-template-columns: 56px 120px 56px; justify-content: center; align-items: start; margin: 4px 0 10px; padding-top: 6px; }
.hv-node { display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 0; }
.hv-logo { position: relative; width: 30px; height: 30px; }
.hv-logo img { position: absolute; inset: 0; width: 30px; height: 30px; border-radius: 8px; object-fit: contain; }
.hv-name { position: relative; height: 14px; width: 64px; font-size: 10.5px; line-height: 14px; color: var(--muted, #6b6b73); text-align: center; }
.hv-name span { position: absolute; inset: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hv-to img, .hv-to .hv-name span { opacity: 0; animation: hv-cycle 7.2s infinite; }
.hv-to img:nth-child(2), .hv-to .hv-name span:nth-child(2) { animation-delay: 2.4s; }
.hv-to img:nth-child(3), .hv-to .hv-name span:nth-child(3) { animation-delay: 4.8s; }
@keyframes hv-cycle { 0% { opacity: 0; } 4% { opacity: 1; } 30% { opacity: 1; } 34% { opacity: 0; } 100% { opacity: 0; } }
.hv-arc { width: 120px; height: 30px; overflow: visible; }
.hv-arc .track { fill: none; stroke: url(#hv-grad); stroke-width: 1.6; stroke-linecap: round; stroke-dasharray: 3 4; opacity: .9; animation: hv-flow 1.2s linear infinite; }
.hv-arc .head { fill: none; stroke: #22d3ee; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.hv-arc .doc rect { fill: var(--bg, #fff); stroke: #7c5cff; stroke-width: 1.2; }
.hv-arc .doc text { fill: #7c5cff; font: 700 5.5px/1 system-ui, -apple-system, sans-serif; }
@keyframes hv-flow { to { stroke-dashoffset: -14; } }
.dark .hv-logo img[data-site="chatgpt"], .hv-dark .hv-logo img[data-site="chatgpt"] { filter: invert(1); }
@media (prefers-color-scheme: dark) { .hv-auto .hv-logo img[data-site="chatgpt"] { filter: invert(1); } }
@media (prefers-reduced-motion: reduce) {
  .hv-arc .track { animation: none; }
  .hv-to img, .hv-to .hv-name span { animation: none; }
  .hv-to img:first-child, .hv-to .hv-name span:first-child { opacity: 1; }
  .hv-arc .doc { display: none; }
}
`;

/** The services a handoff from `site` is illustrated with (all others, in a fixed order). */
export function handoffTargets(site: SiteId | null): SiteId[] {
  const from = site ?? 'chatgpt';
  return ORDER.filter((s) => s !== from);
}

export function handoffVisualHtml(site: SiteId | null, iconUrl: (s: SiteId) => string, locale: Locale, theme: 'auto' | 'dark' | 'light' = 'auto'): string {
  const from = site ?? 'chatgpt';
  const to = handoffTargets(site);
  const img = (s: SiteId) => `<img data-site="${s}" src="${iconUrl(s)}" alt="" draggable="false">`;
  const label = t(locale, 'handoff.visual', { from: SITES[from].name, to: to.map((s) => SITES[s].name).join(', ') });
  return `
<div class="hv hv-${theme}" role="img" aria-label="${label.replace(/"/g, '&quot;')}">
  <div class="hv-node"><div class="hv-logo">${img(from)}</div><div class="hv-name"><span>${SITES[from].name}</span></div></div>
  <svg class="hv-arc" viewBox="0 0 120 30" aria-hidden="true">
    <defs><linearGradient id="hv-grad" x1="0" x2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
    <path class="track" d="${ARC}"/>
    <path class="head" d="M120.5 14.6 L126 15 L123.6 10.1"/>
    <g class="doc"><rect x="-6" y="-7.5" width="12" height="15" rx="2"/><text x="0" y="2" text-anchor="middle">MD</text>
      <animateMotion dur="2.4s" repeatCount="indefinite" path="${ARC}" keyPoints="0;1;1" keyTimes="0;.8;1" calcMode="spline" keySplines=".45 0 .55 1;0 0 1 1"/>
      <animate attributeName="opacity" dur="2.4s" repeatCount="indefinite" values="0;1;1;0;0" keyTimes="0;.08;.74;.82;1"/></g>
  </svg>
  <div class="hv-node hv-to"><div class="hv-logo">${to.map(img).join('')}</div><div class="hv-name">${to.map((s) => `<span>${SITES[s].name}</span>`).join('')}</div></div>
</div>`;
}
