// Renders the handoff document. Section order follows the product spec: source info, goal and
// request flow, confirmed decisions, instructions & constraints, completed work, current state,
// open work, next steps, failed attempts, code/files, links, past context, transcript,
// references. Sections with nothing to show are left out and the rest are numbered in order.

import type { Conversation, Role } from '../shared/types';
import { formatDateTime } from '../shared/util';
import { clipText } from './patterns';

export interface Item {
  text: string;
  m: number;
  role: Role;
  uncertain?: { m: number; kind: 'maybe-changed' | 'maybe-lifted' | 'maybe-done' };
  confirmed?: number;
  supersededBy?: number;
  repeats?: number;
  /** Other messages where the same item was stated. */
  alsoAt?: number[];
  code?: boolean;
  resolved?: number;
}

export interface CodeItem {
  text: string;
  m: number;
  role: Role;
  lang?: string;
  title?: string;
  versions: number;
  truncated: boolean;
}

export interface PastItem {
  text: string;
  m: number;
  /** Unit index, so excerpts of one message keep their original order. */
  u: number;
  role: Role;
  table?: boolean;
}

/** One later user request, optionally with the lead sentence of the answer it received. */
export interface RequestItem {
  m: number;
  text: string;
  /** Number of near-identical requests collapsed into this (latest) one. */
  repeats?: number;
  lead?: { m: number; text: string };
}

export interface RecentMessage {
  m: number;
  role: Role;
  model?: string;
  time?: number;
  body: string;
  clipped: boolean;
}

export interface HandoffDoc {
  lang: 'ko' | 'en';
  mode: 'full' | 'compressed';
  /** Appendix table of referenced messages that are not in the transcript. */
  refIndex: boolean;
  conv: Conversation;
  now: number;
  sourceTokens: number;
  budget: number | null;
  goal: Item[];
  requests: RequestItem[];
  requestsOmitted: number;
  decisions: Item[];
  superseded: Item[];
  constraints: Item[];
  requirements: Item[];
  done: Item[];
  open: Item[];
  next: Item[];
  failures: Item[];
  lastUser: number;
  lastAssistant: number;
  lastAssistantKey: Item[];
  /** The last message is an answer with nothing visible yet (still being written, or thinking only). */
  lastAssistantEmpty: boolean;
  files: Array<{ text: string; m: number; count: number }>;
  commands: Array<{ text: string; m: number }>;
  links: Array<{ text: string; m: number; title?: string; count: number }>;
  linksOmitted: number;
  code: CodeItem[];
  /** Messages in the recent transcript whose code is not repeated in the code section. */
  codeInRecent: number[];
  past: PastItem[];
  recent: RecentMessage[];
  uncertainCount: number;
}

const L = {
  ko: {
    title: 'AI 작업 인수인계',
    intro: [
      '**이 문서를 읽는 AI에게** — 이 파일은 {site}에서 진행하던 작업을 다른 AI가 이어받을 수 있도록 Lucian AI Chat Exporter가 자동으로 만든 인수인계 문서입니다. 내용은 원본 대화에서 규칙 기반 알고리즘이 **원문 그대로 발췌**한 것이며, 요약 과정에서 새로운 사실을 만들어 내지 않았습니다.',
      '1. 「확정된 주요 결정」과 「사용자 지시사항 · 제한사항」이 있으면 먼저 읽고 반드시 따르세요. 결정이 바뀐 경우 최신 결정이 우선입니다.',
      '2. 「현재 진행 상황」과 「다음에 이어서 할 작업」에서 작업을 이어가세요.',
      '3. ⚠️ 표시는 알고리즘이 확신하지 못한 항목입니다. 진행하기 전에 사용자에게 확인하세요.',
      '4. `[#m12]`는 원본 대화의 12번째 메시지를 뜻합니다.',
      '5. 답변은 사용자가 쓰던 언어로 하세요. 이 문서를 읽은 직후에는 이해한 현재 상태를 짧게 정리하고, 이어서 할 작업을 제안하세요.',
    ],
    introEn:
      '*To the AI reading this:* this is an automatically generated, extractive handoff of an earlier chat. Treat the latest decisions and the constraints as authoritative, continue from “Next steps”, and confirm ⚠️ items with the user.',
    meta: '기본 정보',
    metaRows: { site: '원본 서비스', title: '대화 제목', url: '원본 링크', extracted: '추출 시각', messages: '메시지 수', size: '원문 분량', mode: '정리 방식' },
    modeFull: '대화가 짧아 전체 원문 포함',
    modeCompressed: '핵심 발췌 + 최근 원문 (약 {budget} 토큰 목표)',
    goal: '목표와 요청 흐름',
    goalFirst: '처음 요청',
    requests: '이후 요청 ({n}개, 시간순)',
    requestsOmitted: '… 중간 요청 {n}개는 생략했습니다 (중요도 낮음)',
    leadPrefix: '→ 답변 요지:',
    similar: '(비슷한 요청 {n}회)',
    decisions: '확정된 주요 결정 (최신 기준)',
    supersededTitle: '변경되거나 폐기된 이전 결정',
    supersededNote: '→ [#m{m}]에서 변경됨 (위 최신 결정이 우선)',
    constraints: '사용자 지시사항 · 제한사항 · 금지사항',
    constraintsSub: '제한·금지',
    requirementsSub: '요구사항·지시',
    repeated: '({n}회 반복 강조)',
    done: '완료한 작업',
    current: '현재 진행 상황 (마지막 작업 지점)',
    lastUser: '마지막 사용자 요청',
    fullBelow: '(전체는 아래 대화 원문 {ref})',
    moreBelow: '(이어지는 내용은 아래 대화 원문 {ref}, 길어서 가운데 일부 생략)',
    lastAssistant: '마지막 AI 응답의 핵심 문장',
    noReply: '마지막 요청에 대한 AI 응답이 아직 없습니다. 이 요청부터 처리하세요.',
    emptyReply: '마지막 AI 응답 {ref}에는 보이는 내용이 없습니다(추출할 때 아직 생성 중이었거나 생각 과정만 있음). 마지막 사용자 요청부터 처리하세요.',
    emptyBody: '_(보이는 내용 없음)_',
    open: '미완료 작업 · 해결되지 않은 문제',
    next: '다음에 이어서 할 작업',
    nextFallback: '명시된 다음 단계가 없습니다. 「현재 진행 상황」의 마지막 사용자 요청을 기준으로 이어가세요.',
    failures: '이전 시도에서 실패한 원인',
    resolved: '(이후 [#m{m}]에서 해결된 것으로 보임)',
    code: '핵심 코드 · 설정 · 파일',
    files: '파일 · 경로',
    commands: '명령어',
    latestCode: '최신 코드 (같은 코드의 이전 버전은 생략)',
    olderVersions: '이전 버전 {n}개 생략',
    codeInRecent: '최근 대화 원문에 있는 코드는 그곳에만 둡니다: {refs}',
    truncatedCode: '일부 생략',
    links: '참고 링크 · 출처',
    linksOmitted: '… 덜 언급된 링크 {n}개는 생략했습니다',
    past: '중요한 맥락 (원문 발췌)',
    recent: '최근 대화 원문',
    transcript: '전체 대화 원문',
    clipped: '(길어서 가운데 일부 생략)',
    refs: '부록. 메시지 참조 색인',
    refsHead: '| 참조 | 역할 | 시각 | 첫 줄 |',
    refsOmitted: '이전 참조 {n}개 생략',
    none: '_(해당 내용을 찾지 못했습니다)_',
    user: '사용자',
    uncertain: {
      'maybe-changed': '⚠️ [#m{m}]에서 변경되었을 수 있음 — 확인 필요',
      'maybe-lifted': '⚠️ [#m{m}]에서 해제되었을 수 있음 — 확인 필요',
      'maybe-done': '⚠️ [#m{m}]에서 완료되었을 수 있음 — 확인 필요',
    },
    confirmed: '(사용자가 [#m{m}]에서 승인)',
    footer: 'Lucian AI Chat Exporter · 규칙 기반 발췌(외부 AI·서버 미사용)',
  },
  en: {
    title: 'AI work handoff',
    intro: [
      '**To the AI reading this** — this file was generated by Lucian AI Chat Exporter so that another AI can continue work that was in progress on {site}. Its contents are **verbatim excerpts** selected from the original conversation by a rule-based algorithm; no new facts were generated.',
      '1. If there are “Confirmed decisions” and “User instructions & constraints”, read them first and follow them. When a decision changed, the latest one wins.',
      '2. Continue the work from “Current state” and “Next steps”.',
      '3. Items marked ⚠️ are uncertain for the algorithm — confirm them with the user before acting.',
      '4. `[#m12]` refers to the 12th message of the original conversation.',
      '5. Reply in the user’s language. Right after reading this, briefly summarize the current state as you understand it and propose the next step.',
    ],
    introEn: '',
    meta: 'Source',
    metaRows: { site: 'Service', title: 'Title', url: 'URL', extracted: 'Extracted', messages: 'Messages', size: 'Source size', mode: 'Mode' },
    modeFull: 'short conversation — full transcript included',
    modeCompressed: 'key excerpts + recent transcript (target ~{budget} tokens)',
    goal: 'Goal and request flow',
    goalFirst: 'Initial request',
    requests: 'Later requests ({n}, in order)',
    requestsOmitted: '… {n} less important requests in between are omitted',
    leadPrefix: '→ answer in short:',
    similar: '({n} similar requests)',
    decisions: 'Confirmed decisions (latest first priority)',
    supersededTitle: 'Earlier decisions that were changed or dropped',
    supersededNote: '→ changed in [#m{m}] (the latest decision above wins)',
    constraints: 'User instructions · constraints · prohibitions',
    constraintsSub: 'Constraints & prohibitions',
    requirementsSub: 'Requirements & instructions',
    repeated: '(emphasized {n} times)',
    done: 'Completed work',
    current: 'Current state (last point of work)',
    lastUser: 'Last user request',
    fullBelow: '(full text in the transcript below, {ref})',
    moreBelow: '(continued in the transcript below, {ref}; its middle is omitted)',
    lastAssistant: 'Key sentences of the last AI reply',
    noReply: 'The last request has no AI reply yet. Start by handling it.',
    emptyReply: 'The last AI reply {ref} has no visible content (it was still being written, or holds only thinking). Start from the last user request.',
    emptyBody: '_(no visible content)_',
    open: 'Open tasks · unresolved problems',
    next: 'Next steps',
    nextFallback: 'No explicit next steps were stated. Continue from the last user request in “Current state”.',
    failures: 'Causes of earlier failed attempts',
    resolved: '(appears resolved later in [#m{m}])',
    code: 'Key code · configuration · files',
    files: 'Files & paths',
    commands: 'Commands',
    latestCode: 'Latest code (earlier versions of the same code omitted)',
    olderVersions: '{n} earlier versions omitted',
    codeInRecent: 'Code that is in the recent transcript is shown only there: {refs}',
    truncatedCode: 'partly omitted',
    links: 'Links & sources',
    linksOmitted: '… {n} less referenced links omitted',
    past: 'Important context (verbatim excerpts)',
    recent: 'Recent conversation (verbatim)',
    transcript: 'Full conversation (verbatim)',
    clipped: '(long message — middle part omitted)',
    refs: 'Appendix. Message reference index',
    refsHead: '| Ref | Role | Time | First line |',
    refsOmitted: '{n} older references omitted',
    none: '_(nothing found)_',
    user: 'User',
    uncertain: {
      'maybe-changed': '⚠️ may have been changed in [#m{m}] — confirm',
      'maybe-lifted': '⚠️ may have been lifted in [#m{m}] — confirm',
      'maybe-done': '⚠️ may have been completed in [#m{m}] — confirm',
    },
    confirmed: '(approved by the user in [#m{m}])',
    footer: 'Lucian AI Chat Exporter · rule-based extraction (no external AI or server)',
  },
};

function fill(s: string, params: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''));
}

function oneLine(text: string, max = 600): string {
  return clipText(text.replace(/\s*\n\s*/g, ' ').trim(), max);
}

function fence(code: string): string {
  let max = 2;
  for (const m of code.match(/`{3,}/g) ?? []) max = Math.max(max, m.length);
  return '`'.repeat(max + 1);
}

export function renderHandoff(doc: HandoffDoc): string {
  const S = L[doc.lang];
  const conv = doc.conv;
  const refs = new Set<number>();
  const ref = (m: number) => {
    refs.add(m);
    return `[#m${m + 1}]`;
  };
  const roleName = (role: Role) => (role === 'user' ? S.user : conv.siteName);
  const line = (it: Item, extra = '', max = 600) => {
    const also = (it.alsoAt ?? []).filter((m) => m !== it.m).sort((a, b) => a - b);
    let s = `- ${oneLine(it.text, max)} ${[...also.map(ref), ref(it.m)].join(' ')}`;
    if (it.repeats && it.repeats > 1) s += ` ${fill(S.repeated, { n: it.repeats })}`;
    if (it.confirmed != null) s += ` ${fill(S.confirmed, { m: it.confirmed + 1 })}`;
    if (it.uncertain) {
      refs.add(it.uncertain.m);
      s += ` ${fill(S.uncertain[it.uncertain.kind], { m: it.uncertain.m + 1 })}`;
    }
    return s + extra;
  };
  const list = (items: Item[], max = 600) => items.map((i) => line(i, '', max)).join('\n');

  const out: string[] = [];
  let n = 0;
  const section = (title: string) => {
    out.push(`## ${n}. ${title}`);
    out.push('');
    n++;
  };

  out.push(`# ${S.title} — ${conv.title || conv.siteName}`);
  out.push('');
  out.push(S.intro.map((p, i) => `> ${fill(p, { site: conv.siteName })}${i === 0 ? '\n>' : ''}`).join('\n'));
  if (S.introEn) out.push(`>\n> ${S.introEn}`);
  out.push('');

  section(S.meta);
  out.push(`| | |`);
  out.push(`|---|---|`);
  out.push(`| ${S.metaRows.site} | ${conv.siteName}${conv.model ? ` (${conv.model})` : ''} |`);
  out.push(`| ${S.metaRows.title} | ${(conv.title || '-').replace(/\|/g, '\\|')} |`);
  out.push(`| ${S.metaRows.url} | ${conv.fromUrl} |`);
  out.push(`| ${S.metaRows.extracted} | ${formatDateTime(doc.now)} |`);
  out.push(`| ${S.metaRows.messages} | ${conv.messages.length} |`);
  out.push(`| ${S.metaRows.size} | ~${doc.sourceTokens.toLocaleString('en-US')} tokens |`);
  out.push(`| ${S.metaRows.mode} | ${doc.mode === 'full' ? S.modeFull : fill(S.modeCompressed, { budget: (doc.budget ?? 0).toLocaleString('en-US') })} |`);
  out.push('');

  section(S.goal);
  if (doc.goal.length) {
    out.push(`**${S.goalFirst}**`);
    out.push('');
    out.push(list(doc.goal));
    out.push('');
  }
  if (doc.requests.length) {
    out.push(`**${fill(S.requests, { n: doc.requests.reduce((a, r) => a + (r.repeats ?? 1), 0) + doc.requestsOmitted })}**`);
    out.push('');
    let shownOmission = doc.requestsOmitted === 0;
    for (const r of doc.requests) {
      // The omission note goes where the gap is: before the trailing run of latest requests.
      if (!shownOmission && doc.requests.indexOf(r) >= doc.requests.length - 12) {
        out.push(`- ${fill(S.requestsOmitted, { n: doc.requestsOmitted })}`);
        shownOmission = true;
      }
      out.push(`- ${r.text} ${ref(r.m)}${r.repeats ? ` ${fill(S.similar, { n: r.repeats })}` : ''}`);
      if (r.lead) out.push(`  - ${S.leadPrefix} ${r.lead.text} ${ref(r.lead.m)}`);
    }
    out.push('');
  }

  if (doc.decisions.length || doc.superseded.length) {
    section(S.decisions);
    if (doc.decisions.length) out.push(list(doc.decisions));
    if (doc.superseded.length) {
      if (doc.decisions.length) out.push('');
      out.push(`### ${S.supersededTitle}`);
      out.push('');
      out.push(doc.superseded.map((it) => line(it, it.supersededBy != null ? ` ${fill(S.supersededNote, { m: (refs.add(it.supersededBy), it.supersededBy + 1) })}` : '')).join('\n'));
    }
    out.push('');
  }

  if (doc.constraints.length || doc.requirements.length) {
    section(S.constraints);
    if (doc.constraints.length) {
      out.push(`### ${S.constraintsSub}`);
      out.push('');
      out.push(list(doc.constraints));
      out.push('');
    }
    if (doc.requirements.length) {
      out.push(`### ${S.requirementsSub}`);
      out.push('');
      out.push(list(doc.requirements));
      out.push('');
    }
  }

  if (doc.done.length) {
    section(S.done);
    out.push(list(doc.done, 220));
    out.push('');
  }

  section(S.current);
  if (doc.lastUser >= 0) {
    const msg = conv.messages[doc.lastUser];
    const text = msg.contents
      .filter((c) => c.type === 'text' || c.type === 'markdown')
      .map((c) => c.content ?? '')
      .join('\n')
      .trim();
    // When the request is in the verbatim transcript below, a short quote is enough here. A clipped
    // transcript keeps the request's opening, so a long quote here would only repeat it.
    const below = doc.recent.find((r) => r.m === doc.lastUser);
    const max = below ? 400 : 3000;
    const clipped = clipText(text, max);
    out.push(`**${S.lastUser}** ${ref(doc.lastUser)}`);
    out.push('');
    out.push(clipped.split('\n').map((l) => `> ${l}`).join('\n'));
    if (clipped !== text && below) out.push(`> ${fill(below.clipped ? S.moreBelow : S.fullBelow, { ref: ref(doc.lastUser) })}`);
    out.push('');
  }
  if (doc.lastAssistant > doc.lastUser && doc.lastAssistantKey.length) {
    out.push(`**${S.lastAssistant}** ${ref(doc.lastAssistant)}`);
    out.push('');
    out.push(doc.lastAssistantKey.map((i) => `- ${oneLine(i.text)}`).join('\n'));
    out.push('');
  } else if (doc.lastAssistant > doc.lastUser && doc.lastAssistantEmpty) {
    out.push(fill(S.emptyReply, { ref: ref(doc.lastAssistant) }));
    out.push('');
  } else if (doc.lastUser >= 0 && doc.lastAssistant < doc.lastUser) {
    out.push(S.noReply);
    out.push('');
  }

  if (doc.open.length) {
    section(S.open);
    out.push(list(doc.open, 220));
    out.push('');
  }

  section(S.next);
  out.push(doc.next.length ? list(doc.next) : S.nextFallback);
  out.push('');

  if (doc.failures.length) {
    section(S.failures);
    for (const f of doc.failures) {
      const tail = f.resolved != null ? ` ${fill(S.resolved, { m: (refs.add(f.resolved), f.resolved + 1) })}` : '';
      if (f.code) {
        const fc = fence(f.text);
        out.push(`- ${ref(f.m)}${tail}`);
        out.push('');
        out.push(`  ${fc}text\n${f.text.split('\n').map((l) => `  ${l}`).join('\n')}\n  ${fc}`);
      } else out.push(line(f, tail, 300));
    }
    out.push('');
  }

  if (doc.files.length || doc.commands.length || doc.code.length || doc.codeInRecent.length) {
    section(S.code);
    if (doc.files.length) {
      out.push(`### ${S.files}`);
      out.push('');
      out.push(doc.files.map((f) => `- \`${f.text}\` ${ref(f.m)}${f.count > 1 ? ` ×${f.count}` : ''}`).join('\n'));
      out.push('');
    }
    if (doc.commands.length) {
      out.push(`### ${S.commands}`);
      out.push('');
      const body = doc.commands.map((c) => c.text).join('\n');
      const fc = fence(body);
      out.push(`${fc}bash\n${body}\n${fc}`);
      out.push('');
    }
    if (doc.code.length || doc.codeInRecent.length) {
      out.push(`### ${S.latestCode}`);
      out.push('');
      if (doc.codeInRecent.length) {
        out.push(fill(S.codeInRecent, { refs: doc.codeInRecent.map(ref).join(', ') }));
        out.push('');
      }
      for (const c of doc.code) {
        const label = [c.title && !c.title.startsWith('tool:') ? c.title : '', c.lang ?? ''].filter(Boolean).join(' · ') || 'code';
        const notes = [c.versions > 0 ? fill(S.olderVersions, { n: c.versions }) : '', c.truncated ? S.truncatedCode : ''].filter(Boolean).join(', ');
        out.push(`#### ${label} ${ref(c.m)}${notes ? ` — ${notes}` : ''}`);
        out.push('');
        const fc = fence(c.text);
        out.push(`${fc}${c.lang ?? ''}\n${c.text}\n${fc}`);
        out.push('');
      }
    }
  }

  if (doc.links.length) {
    section(S.links);
    out.push(doc.links.map((l) => `- ${l.title ? `[${l.title.replace(/[[\]]/g, '')}](${l.text})` : l.text} ${ref(l.m)}`).join('\n'));
    if (doc.linksOmitted) out.push(`- ${fill(S.linksOmitted, { n: doc.linksOmitted })}`);
    out.push('');
  }

  if (doc.mode === 'compressed' && doc.past.length) {
    section(S.past);
    let lastM = -1;
    for (const p of doc.past) {
      if (p.m !== lastM) {
        out.push(`- **${roleName(p.role)}** ${ref(p.m)}`);
        lastM = p.m;
      }
      if (p.table) out.push(`\n${p.text.split('\n').map((l) => `  ${l}`).join('\n')}\n`);
      else out.push(`  - ${oneLine(p.text, 800)}`);
    }
    out.push('');
  }

  section(doc.mode === 'full' ? S.transcript : S.recent);
  for (const r of doc.recent) {
    const meta = [r.role === 'assistant' && r.model ? r.model : '', r.time ? formatDateTime(r.time) : ''].filter(Boolean).join(' · ');
    out.push(`### ${ref(r.m)} ${roleName(r.role)}${meta ? ` · ${meta}` : ''}${r.clipped ? ` ${S.clipped}` : ''}`);
    out.push('');
    out.push(r.body.trim() || S.emptyBody);
    out.push('');
  }

  // Index of referenced messages that are not in the transcript above (those carry their own
  // header with role and time). A short conversation in full needs no index at all.
  const inTranscript = new Set(doc.recent.map((r) => r.m));
  const sorted = [...refs].filter((m) => !inTranscript.has(m)).sort((a, b) => a - b);
  if (sorted.length && doc.refIndex) {
    out.push(`## ${S.refs}`);
    out.push('');
    out.push(S.refsHead);
    out.push('|---|---|---|---|');
    const shown = sorted.length > 40 ? sorted.slice(-40) : sorted;
    if (shown.length < sorted.length) out.push(`| … | | | ${fill(S.refsOmitted, { n: sorted.length - shown.length })} |`);
    for (const m of shown) {
      const msg = conv.messages[m];
      if (!msg) continue;
      // Thinking is never shown in the handoff, so the index uses the visible answer text.
      const visible = msg.contents.find((c) => (c.type === 'markdown' || c.type === 'text') && c.content) ?? msg.contents.find((c) => c.type !== 'thinking' && c.content);
      const first = oneLine((visible?.content ?? '').replace(/^#{1,6}\s+/gm, ''), 32).replace(/\|/g, '\\|');
      out.push(`| #m${m + 1} | ${roleName(msg.role)} | ${msg.created_at ? formatDateTime(msg.created_at) : '-'} | ${first} |`);
    }
    out.push('');
  }
  out.push(`---`);
  out.push(`_${S.footer}_`);
  return `${out.join('\n')}\n`;
}

/**
 * Structure check for the verification report: the sections every handoff has (others are left
 * out when empty), in order, plus at least one message reference.
 */
export function verifyHandoffMarkdown(md: string, lang: 'ko' | 'en'): { ok: boolean; detail?: string } {
  const S = L[lang];
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let rest = md;
  for (const title of [S.meta, S.goal, S.current, S.next]) {
    const m = new RegExp(`^## \\d+\\. ${esc(title)}`, 'm').exec(rest);
    if (!m) return { ok: false, detail: `missing section: ${title}` };
    rest = rest.slice(m.index + m[0].length);
  }
  if (!new RegExp(`^## \\d+\\. (${esc(S.transcript)}|${esc(S.recent)})`, 'm').test(rest)) return { ok: false, detail: `missing section: ${S.transcript}` };
  if (!/\[#m\d+\]/.test(md)) return { ok: false, detail: 'missing message references' };
  return { ok: true };
}
