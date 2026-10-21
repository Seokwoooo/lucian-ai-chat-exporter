// Human readable verification report (shown in the popup and stored in the ZIP backup).

import { t, formatBytes, formatMs, type Locale, type MessageKey } from '../shared/i18n';
import { sourceDomain } from '../shared/sites';
import type { CheckStatus, Conversation, JobState, JobTimings, Verification, VerificationCheck } from '../shared/types';
import { formatDateTime } from '../shared/util';

const ICON: Record<VerificationCheck['status'], string> = { pass: '✓', warn: '!', fail: '✗', info: 'i' };

/**
 * The level a finished job is shown with. A saved handoff is always shown as saved (v1.3.8): the
 * file is there and the next AI can use it, so gaps (a message that could not be read, a size
 * mismatch) are listed under the collapsed details instead of turning the result into ✗. Only a
 * job that saved no file (phase 'error') is shown as a failure.
 */
export function shownLevel(job: Pick<JobState, 'kind' | 'phase' | 'result'>): Verification['level'] {
  if (job.phase === 'error') return 'error';
  if (job.kind === 'handoff') return 'ok';
  return job.result?.verification.level ?? 'ok';
}

/** Status mark of a check in the details: a saved handoff's gaps are notes ("!"), never ✗. */
export function shownStatus(kind: JobState['kind'], c: VerificationCheck): CheckStatus {
  return kind === 'handoff' && c.status === 'fail' ? 'warn' : c.status;
}

/** Gaps (warn/fail) before the rest, otherwise in their original order. */
export function issuesFirst(checks: VerificationCheck[]): VerificationCheck[] {
  const issue = (c: VerificationCheck) => c.status === 'warn' || c.status === 'fail';
  return [...checks.filter(issue), ...checks.filter((c) => !issue(c))];
}

/** "AI 답변 · multimodal_text, 사용자 메시지 · text ×2" from "role:shape" entries. */
function kindsText(locale: Locale, kinds: string): string {
  const counts = new Map<string, number>();
  for (const k of kinds.split(',').filter(Boolean)) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts]
    .map(([k, n]) => {
      const i = k.indexOf(':');
      const role = i < 0 ? 'unknown' : k.slice(0, i);
      const shape = i < 0 ? k : k.slice(i + 1);
      const label = t(locale, role === 'user' ? 'check.role.user' : role === 'assistant' ? 'check.role.assistant' : 'check.role.unknown');
      return `${label}${shape ? ` · ${shape}` : ''}${n > 1 ? ` ×${n}` : ''}`;
    })
    .join(', ');
}

export function checkText(locale: Locale, c: VerificationCheck): string {
  const params = { ...(c.params ?? {}) };
  if (c.code === 'messages.missing' && typeof params.kinds === 'string' && params.kinds) {
    return t(locale, 'check.messages.missingKinds', { missing: params.missing, kinds: kindsText(locale, params.kinds) });
  }
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
  lines.push(`- ${t(locale, 'doc.source')}: ${sourceDomain(conv)} — ${conv.fromUrl}`);
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
    if (ex.missingKinds?.length) lines.push(`- missing node kinds: ${ex.missingKinds.join(', ')}`);
    if (ex.warnings.length) lines.push(`- warnings: ${ex.warnings.join(', ')}`);
    const reasons = new Map<string, number>();
    for (const s of ex.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    for (const [r, n] of reasons) lines.push(`- skipped ${r}: ${n}`);
    lines.push('');
    lines.push('</details>');
  }
  return `${lines.join('\n')}\n`;
}
