// Icons shared by the popup and the in-page panel: format logos on the main export buttons and the
// pictures on the Markdown image choice. Inline SVG (no ids, no external files) so they work in
// the popup and inside the panel's shadow root alike.
//
// The PDF and Word marks are drawn in the style of Adobe Acrobat and Microsoft Word, and the
// Markdown mark is Dustin Curtis's public-domain mark. They only name the file format a button
// saves; no affiliation is implied.

import type { ExportFormat, MdImageMode } from './types';

const ACROBAT =
  'M23.63 15.3c-.71-.745-2.166-1.17-4.224-1.17-1.1 0-2.377.106-3.761.354a19.443 19.443 0 0 1-2.307-2.661c-.532-.71-.994-1.49-1.42-2.236.817-2.484 1.207-4.507 1.207-5.962 0-1.632-.603-3.336-2.342-3.336-.532 0-1.065.32-1.349.781-.78 1.384-.425 4.4.923 7.381a60.277 60.277 0 0 1-1.703 4.507c-.568 1.349-1.207 2.733-1.917 4.01C2.834 18.53.314 20.34.03 21.758c-.106.533.071 1.03.462 1.42.142.107.639.533 1.49.533 2.59 0 5.323-4.188 6.707-6.707 1.065-.355 2.13-.71 3.194-.994a34.963 34.963 0 0 1 3.407-.745c2.732 2.448 5.145 2.839 6.352 2.839 1.49 0 2.023-.604 2.2-1.1.32-.64.106-1.349-.213-1.704zm-1.42 1.03c-.107.532-.64.887-1.384.887-.213 0-.39-.036-.604-.071-1.348-.32-2.626-.994-3.903-2.059a17.717 17.717 0 0 1 2.98-.248c.746 0 1.385.035 1.81.142.497.106 1.278.426 1.1 1.348zm-7.524-1.668a38.01 38.01 0 0 0-2.945.674 39.68 39.68 0 0 0-2.52.745 40.05 40.05 0 0 0 1.207-2.555c.426-.994.78-2.023 1.136-2.981.354.603.745 1.207 1.135 1.739a50.127 50.127 0 0 0 1.987 2.378zM10.038 1.46a.768.768 0 0 1 .674-.425c.745 0 .887.851.887 1.526 0 1.135-.355 2.874-.958 4.861-1.03-2.768-1.1-5.074-.603-5.962zM6.134 17.997c-1.81 2.981-3.549 4.826-4.613 4.826a.872.872 0 0 1-.532-.177c-.213-.213-.32-.461-.249-.745.213-1.065 2.271-2.555 5.394-3.904Z';

const MARKDOWN =
  'M22.27 19.385H1.73A1.73 1.73 0 010 17.655V6.345a1.73 1.73 0 011.73-1.73h20.54A1.73 1.73 0 0124 6.345v11.308a1.73 1.73 0 01-1.73 1.731zM5.769 15.923v-4.5l2.308 2.885 2.307-2.885v4.5h2.308V8.078h-2.308l-2.307 2.885-2.308-2.885H3.46v7.847zM21.232 12h-2.309V8.077h-2.307V12h-2.308l3.461 4.039z';

/** Logos for the main formats and Word (32×32). Other formats keep the outline file icon. */
export const FORMAT_LOGOS: Partial<Record<ExportFormat, string>> = {
  pdf:
    '<svg class="fmt-logo" viewBox="0 0 32 32" aria-hidden="true">' +
    '<rect x="2" y="2" width="28" height="28" rx="6.5" fill="#E5261F"/>' +
    `<path transform="translate(6.6 6.8) scale(.783)" fill="#fff" d="${ACROBAT}"/>` +
    '</svg>',
  md:
    '<svg class="fmt-logo" viewBox="0 0 32 32" aria-hidden="true">' +
    `<path transform="translate(2 2) scale(1.1667)" fill="currentColor" d="${MARKDOWN}"/>` +
    '</svg>',
  // Plain text has no brand: a slate page with lines, in the same weight as the others.
  txt:
    '<svg class="fmt-logo" viewBox="0 0 32 32" aria-hidden="true">' +
    '<path d="M8 2.5h12l6.5 6.5v18a2.5 2.5 0 0 1-2.5 2.5H8A2.5 2.5 0 0 1 5.5 27V5A2.5 2.5 0 0 1 8 2.5z" fill="#64748B"/>' +
    '<path d="M20 2.5V7a2 2 0 0 0 2 2h4.5z" fill="#A5B1C2"/>' +
    '<path d="M9.8 14.5h12.4M9.8 19h12.4M9.8 23.5h7.6" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/>' +
    '</svg>',
  docx:
    '<svg class="fmt-logo" viewBox="0 0 32 32" aria-hidden="true">' +
    '<path d="M9.5 5.6A2.6 2.6 0 0 1 12.1 3h15.3A2.6 2.6 0 0 1 30 5.6v3.9H9.5z" fill="#41A5EE"/>' +
    '<path d="M9.5 9.5H30V16H9.5z" fill="#2B7CD3"/>' +
    '<path d="M9.5 16H30v6.5H9.5z" fill="#185ABD"/>' +
    '<path d="M9.5 22.5H30v3.9A2.6 2.6 0 0 1 27.4 29H12.1a2.6 2.6 0 0 1-2.6-2.6z" fill="#103F91"/>' +
    '<rect x="2" y="8.5" width="15" height="15" rx="2.2" fill="#1A5CC2"/>' +
    '<path d="M5.2 12.3 7.1 19.7 9.5 13.9 11.9 19.7 13.8 12.3" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>',
};

const LINE = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';

/** Pictures for the Markdown image choice: ZIP archive, folder of pictures, no pictures (24×24). */
export const MD_CHOICE_ICONS: Record<MdImageMode, string> = {
  zip:
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8.5L19 7.5V21H6z" ${LINE}/><path d="M14.5 3v4.5H19" ${LINE}/>` +
    `<path d="M9.4 5h1.7M11.1 6.9h1.7M9.4 8.8h1.7M11.1 10.7h1.7" ${LINE} stroke-width="1.5"/><rect x="9.4" y="12.6" width="3.4" height="4.4" rx="1" ${LINE} stroke-width="1.5"/></svg>`,
  folder:
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a1.5 1.5 0 0 1 1.5-1.5h4.8l2 2.3h8.2A1.5 1.5 0 0 1 21 9.3v8.7a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z" ${LINE}/>` +
    `<path d="m7.2 16.6 2.9-2.9 2.1 2.1 1.4-1.4 3.2 2.2" ${LINE} stroke-width="1.5"/><circle cx="15.6" cy="11.4" r="1.15" fill="currentColor"/></svg>`,
  none:
    `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2" ${LINE}/>` +
    `<path d="m3.8 16.4 4.4-4.4 3.6 3.6 2.4-2.4 6.2 5.4" ${LINE} stroke-width="1.5"/><path d="M3 3.5 21 20.5" ${LINE}/></svg>`,
};

/** Header picture for the choice (a photo), used instead of a warning: nothing has gone wrong. */
export const IMAGE_ICON =
  `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2.5" ${LINE}/>` +
  `<path d="m3.5 16.5 4.8-4.8 3.9 3.9 2.6-2.6 5.7 5" ${LINE}/><circle cx="15.8" cy="9.3" r="1.5" fill="currentColor"/></svg>`;

/** The choice buttons' inner HTML; the caller supplies the localized label and description. */
export function mdChoiceHtml(mode: MdImageMode, label: string, desc: string, badge?: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return (
    `<span class="choice-ic" data-tone="${mode}">${MD_CHOICE_ICONS[mode]}</span>` +
    `<span class="choice-text"><b>${esc(label)}${badge ? ` <em class="choice-badge">${esc(badge)}</em>` : ''}</b>` +
    `<span>${esc(desc)}</span></span>`
  );
}

/** Styles for the choice buttons, shared by the popup and the panel (both define --bg/--text/--muted/--border). */
export const MD_CHOICE_CSS = `
.choice { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--text); font: inherit; cursor: pointer; box-sizing: border-box; }
.choice:hover { background: var(--surface-hover); }
.choice:focus-visible { outline: 2px solid var(--text); outline-offset: 1px; }
.choice:disabled { opacity: .45; cursor: default; }
.choice-ic { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; }
.choice-ic svg { width: 19px; height: 19px; display: block; }
.choice-ic[data-tone="zip"] { background: rgba(124, 92, 255, .13); color: #6a4cf0; }
.choice-ic[data-tone="folder"] { background: rgba(245, 158, 11, .16); color: #b45309; }
.choice-ic[data-tone="none"] { background: rgba(120, 120, 130, .13); color: var(--muted); }
.choice-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.choice-text b { font-size: 12.5px; font-weight: 650; line-height: 1.35; }
.choice-text > span { font-size: 11.5px; line-height: 1.35; color: var(--muted); }
.choice-badge { font-style: normal; font-size: 10.5px; font-weight: 600; padding: 1px 6px; margin-left: 4px; border-radius: 999px; background: rgba(124, 92, 255, .13); color: #6a4cf0; vertical-align: 1px; }
`;

/** Dark-theme overrides for MD_CHOICE_CSS under `scope` (the popup wraps them in a media query, the panel uses `.panel.dark`). */
export function mdChoiceDarkCss(scope = ''): string {
  const s = scope ? `${scope} ` : '';
  return (
    `${s}.choice-ic[data-tone="zip"], ${s}.choice-badge { background: rgba(165, 148, 255, .16); color: #b3a5ff; }\n` +
    `${s}.choice-ic[data-tone="folder"] { background: rgba(251, 191, 36, .14); color: #fbbf24; }\n`
  );
}
