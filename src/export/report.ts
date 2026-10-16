// Human readable verification report (shown in the popup and stored in the ZIP backup).

import { t, formatBytes, formatMs, type Locale, type MessageKey } from '../shared/i18n';
import type { Conversation, JobTimings, Verification, VerificationCheck } from '../shared/types';
import { formatDateTime } from '../shared/util';

const ICON: Record<VerificationCheck['status'], string> = { pass: '✓', warn: '!', fail: '✗', info: 'i' };

export function checkText(locale: Locale, c: VerificationCheck): string {
  const params = { ...(c.params ?? {}) };
  // Only size parameters are byte counts; "saved" is a plain count in attachments.saved.
  const byteKeys = c.code === 'download.mismatch' ? ['saved', 'expected'] : ['size'];
  for (const [k, v] of Object.entries(params)) if (byteKeys.includes(k) && typeof v === 'number') params[k] = formatBytes(v);
  return t(locale, `check.${c.code}` as MessageKey, params);
}

export function verificationReportMarkdown(
  conv: Conversation,
  verification: Verification,
  locale: Locale,
  extra: { files?: Array<{ path: string; status: string }>; timings?: JobTimings; exportedAt?: number } = {},
): string {
  const lines: string[] = [];
  lines.push(`# ${t(locale, 'doc.report')}`);
  lines.push('');
  lines.push(`- ${conv.title || conv.siteName}`);
  lines.push(`- ${t(locale, 'doc.source')}: ${conv.siteName} — ${conv.fromUrl}`);
  lines.push(`- ${t(locale, 'doc.exportedAt')}: ${formatDateTime(extra.exportedAt ?? Date.now())}`);
  lines.push(`- level: **${verification.level}**`);
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  for (const c of verification.checks) lines.push(`| ${ICON[c.status]} ${c.status} | ${checkText(locale, c).replace(/\|/g, '\\|')} |`);
  lines.push('');
  const k = verification.counts;
  lines.push('```json');
  lines.push(JSON.stringify(k, null, 2));
  lines.push('```');
  if (extra.timings) {
    lines.push('');
    const tm = extra.timings;
    lines.push(`- network: ${formatMs(tm.networkMs)} · parse: ${formatMs(tm.parseMs)} · collect: ${formatMs(tm.collectMs)} · assets: ${formatMs(tm.assetsMs)} · build: ${formatMs(tm.processMs)}`);
  }
  if (extra.files?.length) {
    lines.push('');
    lines.push('| file | status |');
    lines.push('|---|---|');
    for (const f of extra.files) lines.push(`| ${f.path} | ${f.status} |`);
  }
  const ex = conv.extraction;
  if (ex.skipped.length || ex.missingNodeIds.length || ex.warnings.length) {
    lines.push('');
    lines.push('<details><summary>extraction details</summary>');
    lines.push('');
    if (ex.missingNodeIds.length) lines.push(`- missing node ids: ${ex.missingNodeIds.join(', ')}`);
    if (ex.warnings.length) lines.push(`- warnings: ${ex.warnings.join(', ')}`);
    const reasons = new Map<string, number>();
    for (const s of ex.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    for (const [r, n] of reasons) lines.push(`- skipped ${r}: ${n}`);
    lines.push('');
    lines.push('</details>');
  }
  return `${lines.join('\n')}\n`;
}
