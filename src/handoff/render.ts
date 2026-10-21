// Renders the handoff document. Section order follows the product spec: source info, goal and
// request flow, confirmed decisions, instructions & constraints, completed work, current state,
// open work, next steps, failed attempts, code/files, links, past context, transcript,
// references. Sections with nothing to show are left out and the rest are numbered in order.

import { fillTemplate } from '../shared/i18n';
import { sourceDomain } from '../shared/sites';
import type { Conversation, Role } from '../shared/types';
import { estimateTokens, formatDateTime } from '../shared/util';
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

/**
 * A file or pasted text the conversation carried (v1.3.5). Its text is shown verbatim when the
 * message is not in the transcript below: whole, or head and tail when it is long.
 */
export interface AttachmentItem {
  m: number;
  role: Role;
  /** Empty for Claude's pasted text (shown as "붙여넣은 텍스트"). */
  name: string;
  mime?: string;
  image?: boolean;
  /** Tokens of the extracted text (0 when the record has no text, e.g. a PDF or an image). */
  tokens: number;
  /** Verbatim text (possibly clipped) when shown here. */
  text?: string;
  clipped?: boolean;
  /** The message is in the transcript below, which shows the text. */
  inTranscript?: boolean;
  /** Has text, but the budget left none for it. */
  omitted?: boolean;
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
  time?: number;
  body: string;
  clipped: boolean;
}

export interface HandoffDoc {
  lang: 'ko' | 'en';
  /** Appendix table of referenced messages that are not in the transcript. */
  refIndex: boolean;
  conv: Conversation;
  now: number;
  /** Tokens of the full export of the conversation. */
  sourceTokens: number;
  budget: number;
  /** Characters of the last request quoted in "Current state" when the transcript has it. */
  quoteChars: number;
  /** Characters per list line. */
  lineChars: number;
  /** Every candidate excerpt was taken: a larger budget would add nothing (render passes skip). */
  pastExhausted?: boolean;
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
  attachments: AttachmentItem[];
  /** Attachments not listed (beyond the list cap). */
  attachmentsMore: number;
  uncertainCount: number;
}

const L = {
  ko: {
    title: 'AI 작업 인수인계',
    intro: {
      head: '**이 문서를 읽는 AI에게** — 이 파일은 {site}에서 진행하던 작업을 다른 AI가 이어받을 수 있도록 Lucian AI Chat Exporter가 자동으로 만든 인수인계 문서입니다. 내용은 원본 대화에서 규칙 기반 알고리즘이 **원문 그대로 발췌**한 것이며, 요약 과정에서 새로운 사실을 만들어 내지 않았습니다.',
      rules: '「확정된 주요 결정」과 「사용자 지시사항 · 제한사항」을 먼저 읽고 반드시 따르세요. 결정이 바뀐 경우 최신 결정이 우선입니다.',
      work: '「현재 진행 상황」과 「다음에 이어서 할 작업」에서 작업을 이어가세요.',
      uncertain: '⚠️ 표시는 알고리즘이 확신하지 못한 항목입니다. 진행하기 전에 사용자에게 확인하세요.',
      refs: '`[#m12]`는 원본 대화의 12번째 메시지를 뜻합니다.',
      reply: '답변은 사용자가 쓰던 언어로 하세요. 이 문서를 읽은 직후에는 이해한 현재 상태를 짧게 정리하고, 이어서 할 작업을 제안하세요.',
      condensed: '**이 문서를 읽는 AI에게** — {site} 대화를 이어받도록 Lucian AI Chat Exporter가 원문의 핵심 문장만 그대로 남긴 인수인계 문서입니다. `…`는 생략한 곳, `[#m12]`는 12번째 메시지입니다. 마지막 요청부터, 사용자가 쓰던 언어로 이어서 답하세요.',
      condensedShort: 'Lucian 인수인계: {site} 대화의 핵심 문장 원문(`…` 생략). 마지막 요청부터 이어서 답하세요.',
    },
    meta: '기본 정보',
    metaRows: { site: '원본 서비스', title: '대화 제목', url: '원본 링크', extracted: '추출 시각', messages: '메시지 수', size: '원문 분량', mode: '정리 방식' },
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
    lastBelow: '마지막 AI 응답 {ref}: 아래 대화 원문에 전체가 있습니다.',
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
    attachments: '첨부 자료 (원문 그대로)',
    attachTokens: '약 {n}토큰',
    pasted: '붙여넣은 텍스트',
    file: '파일',
    image: '이미지',
    attachIn: '(첨부 {n}개: {names} — 「첨부 자료」)',
    attachInBelow: '(첨부 {n}개: {names} — 아래 대화 원문 {ref})',
    attachBelow: '(내용은 아래 대화 원문 {ref}에 있습니다)',
    attachBare: '내용을 넣을 수 없는 파일 · 이미지',
    attachNoText: '(대화 기록에 이 파일들의 내용이 텍스트로 없어서 넣지 못했습니다. 필요하면 사용자에게 다시 첨부해 달라고 하세요.)',
    attachOmitted: '(분량 때문에 내용은 넣지 못했습니다. 필요하면 사용자에게 다시 첨부해 달라고 하세요.)',
    attachClipped: '(길어서 앞뒤만 넣었습니다. 전체가 필요하면 사용자에게 원본을 요청하세요.)',
    attachMore: '… 첨부 {n}개는 목록에서 생략했습니다',
    past: '중요한 맥락 (원문 발췌)',
    recent: '최근 대화 원문',
    condensed: '대화 원문 (핵심 문장만)',
    condensedMeta: '원본 {site} · 메시지 {n}개 · 전체 추출 약 {src}토큰 · 추출 {time}',
    attachmentLabel: '첨부',
    clippedTail: ' … (이하 생략)',
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
    intro: {
      head: '**To the AI reading this** — this file was generated by Lucian AI Chat Exporter so that another AI can continue work that was in progress on {site}. Its contents are **verbatim excerpts** selected from the original conversation by a rule-based algorithm; no new facts were generated.',
      rules: 'Read “Confirmed decisions” and “User instructions & constraints” first and follow them. When a decision changed, the latest one wins.',
      work: 'Continue the work from “Current state” and “Next steps”.',
      uncertain: 'Items marked ⚠️ are uncertain for the algorithm — confirm them with the user before acting.',
      refs: '`[#m12]` refers to the 12th message of the original conversation.',
      reply: 'Reply in the user’s language. Right after reading this, briefly summarize the current state as you understand it and propose the next step.',
      condensed: '**To the AI reading this** — a handoff of a {site} conversation by Lucian AI Chat Exporter: its key sentences, verbatim. `…` marks omitted text; `[#m12]` is the 12th message. Continue from the last request, in the user’s language.',
      condensedShort: 'Lucian handoff: key sentences of a {site} conversation, verbatim (`…` = omitted). Continue from the last request.',
    },
    meta: 'Source',
    metaRows: { site: 'Service', title: 'Title', url: 'URL', extracted: 'Extracted', messages: 'Messages', size: 'Source size', mode: 'Mode' },
    modeCompressed: 'key excerpts + recent transcript (target ~{budget} tokens)',
    goal: 'Goal and request flow',
    goalFirst: 'Initial request',
    requests: 'Later requests ({n}, in order)',
    requestsOmitted: '… {n} less important {n:request|requests} in between {n:is|are} omitted',
    leadPrefix: '→ answer in short:',
    similar: '({n} similar {n:request|requests})',
    decisions: 'Confirmed decisions (latest first priority)',
    supersededTitle: 'Earlier decisions that were changed or dropped',
    supersededNote: '→ changed in [#m{m}] (the latest decision above wins)',
    constraints: 'User instructions · constraints · prohibitions',
    constraintsSub: 'Constraints & prohibitions',
    requirementsSub: 'Requirements & instructions',
    repeated: '(emphasized {n} {n:time|times})',
    done: 'Completed work',
    current: 'Current state (last point of work)',
    lastUser: 'Last user request',
    fullBelow: '(full text in the transcript below, {ref})',
    moreBelow: '(continued in the transcript below, {ref}; its middle is omitted)',
    lastAssistant: 'Key sentences of the last AI reply',
    lastBelow: 'The last AI reply {ref} is in the transcript below in full.',
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
    olderVersions: '{n} earlier {n:version|versions} omitted',
    codeInRecent: 'Code that is in the recent transcript is shown only there: {refs}',
    truncatedCode: 'partly omitted',
    links: 'Links & sources',
    linksOmitted: '… {n} less referenced {n:link|links} omitted',
    attachments: 'Attachments (verbatim)',
    attachTokens: '~{n} {n:token|tokens}',
    pasted: 'Pasted text',
    file: 'File',
    image: 'Image',
    attachIn: '({n} {n:attachment|attachments}: {names} — see “Attachments”)',
    attachInBelow: '({n} {n:attachment|attachments}: {names} — in the transcript below, {ref})',
    attachBelow: '(its content is in the transcript below, {ref})',
    attachBare: 'Files and images without text',
    attachNoText: '(the conversation record has no text for these, so they are not included; ask the user to attach them again if needed)',
    attachOmitted: '(not included for lack of space; ask the user to attach it again if needed)',
    attachClipped: '(long — only its beginning and end are included; ask the user for the original if you need all of it)',
    attachMore: '… {n} more {n:attachment|attachments} not listed',
    past: 'Important context (verbatim excerpts)',
    recent: 'Recent conversation (verbatim)',
    condensed: 'Conversation (key sentences verbatim)',
    condensedMeta: 'Source {site} · {n} {n:message|messages} · full export ~{src} tokens · extracted {time}',
    attachmentLabel: 'Attachment',
    clippedTail: ' … (rest omitted)',
    clipped: '(long message — middle part omitted)',
    refs: 'Appendix. Message reference index',
    refsHead: '| Ref | Role | Time | First line |',
    refsOmitted: '{n} older {n:reference|references} omitted',
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
  return fillTemplate(s, params, '');
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
  const line = (it: Item, extra = '', max = doc.lineChars) => {
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
  const list = (items: Item[], max = doc.lineChars) => items.map((i) => line(i, '', max)).join('\n');

  const attName = (a: AttachmentItem) => a.name || (a.image ? S.image : a.tokens ? S.pasted : S.file);
  const attMeta = (a: AttachmentItem) => {
    const type = a.image ? '' : (a.mime ?? '').replace(/^application\//, '');
    const parts = [type && type.length <= 24 ? type : '', a.tokens ? fill(S.attachTokens, { n: a.tokens.toLocaleString('en-US') }) : ''].filter(Boolean);
    return parts.length ? ` · ${parts.join(' · ')}` : '';
  };
  // Pointers from requests name files and pasted text; images already read "[이미지: …]" there.
  const attOf = (m: number) => doc.attachments.filter((a) => a.m === m && !a.image);
  const attNames = (list: AttachmentItem[]) => {
    const names = list.slice(0, 3).map(attName).join(', ');
    return list.length > 3 ? `${names} …` : names;
  };

  const out: string[] = [];
  let n = 0;
  const section = (title: string) => {
    out.push(`## ${n}. ${title}`);
    out.push('');
    n++;
  };

  out.push(`# ${S.title} — ${conv.title || conv.siteName}`);
  out.push('');
  // The instructions name only what this document has (v1.3.8): no rules paragraph without rules,
  // no ⚠️ paragraph without ⚠️ items.
  const I = S.intro;
  const hasRules = doc.decisions.length + doc.constraints.length + doc.requirements.length > 0;
  const points = [hasRules ? I.rules : '', I.work, doc.uncertainCount > 0 ? I.uncertain : '', I.refs, I.reply].filter(Boolean);
  out.push([`> ${fill(I.head, { site: conv.siteName })}`, '>', ...points.map((p, i) => `> ${i + 1}. ${p}`)].join('\n'));
  out.push('');

  section(S.meta);
  out.push(`| | |`);
  out.push(`|---|---|`);
  // Only where it came from ("grok.com"); model names were confusing here (v1.3.8).
  out.push(`| ${S.metaRows.site} | ${sourceDomain(conv)} |`);
  out.push(`| ${S.metaRows.title} | ${(conv.title || '-').replace(/\|/g, '\\|')} |`);
  out.push(`| ${S.metaRows.url} | ${conv.fromUrl} |`);
  out.push(`| ${S.metaRows.extracted} | ${formatDateTime(doc.now)} |`);
  out.push(`| ${S.metaRows.messages} | ${conv.messages.length} |`);
  out.push(`| ${S.metaRows.size} | ~${doc.sourceTokens.toLocaleString('en-US')} tokens |`);
  out.push(`| ${S.metaRows.mode} | ${fill(S.modeCompressed, { budget: doc.budget.toLocaleString('en-US') })} |`);
  out.push('');

  section(S.goal);
  const firstM = conv.messages.findIndex((x) => x.role === 'user');
  const firstAtt = firstM >= 0 ? attOf(firstM) : [];
  if (doc.goal.length || firstAtt.length) {
    out.push(`**${S.goalFirst}**`);
    out.push('');
    if (doc.goal.length) out.push(list(doc.goal));
    // The first request is often about what it attached ("아래 글 어떻게 생각해?").
    if (firstAtt.length) {
      const below = firstAtt.every((a) => a.inTranscript);
      out.push(`- ${fill(below ? S.attachInBelow : S.attachIn, { n: firstAtt.length, names: attNames(firstAtt), ref: ref(firstM) })} ${ref(firstM)}`);
    }
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
      const ra = attOf(r.m);
      out.push(`- ${r.text} ${ref(r.m)}${r.repeats ? ` ${fill(S.similar, { n: r.repeats })}` : ''}${ra.length ? ` ${fill(S.attachIn, { n: ra.length, names: attNames(ra) })}` : ''}`);
      if (r.lead) out.push(`  - ${S.leadPrefix} ${r.lead.text} ${ref(r.lead.m)}`);
    }
    out.push('');
  }

  if (doc.attachments.length) {
    section(S.attachments);
    const withText = doc.attachments.filter((a) => a.tokens > 0);
    const bare = doc.attachments.filter((a) => a.tokens === 0);
    for (const a of withText) {
      out.push(`### ${attName(a)}${attMeta(a)} ${ref(a.m)}`);
      out.push('');
      if (a.text) {
        const fc = fence(a.text);
        out.push(`${fc}text\n${a.text}\n${fc}`);
        if (a.clipped) out.push(S.attachClipped);
      } else if (a.inTranscript) out.push(fill(S.attachBelow, { ref: ref(a.m) }));
      else out.push(S.attachOmitted);
      out.push('');
    }
    // Files and images the record has no text for: one list, one note.
    if (bare.length) {
      if (withText.length) out.push(`### ${S.attachBare}`, '');
      out.push(bare.map((a) => `- ${attName(a)}${attMeta(a)} ${ref(a.m)}`).join('\n'));
      out.push('');
      out.push(S.attachNoText);
    }
    if (doc.attachmentsMore) out.push(fill(S.attachMore, { n: doc.attachmentsMore }));
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
    out.push(list(doc.done, Math.min(220, doc.lineChars)));
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
    const max = below ? doc.quoteChars : Math.max(200, Math.min(3000, doc.budget * 0.375));
    const clipped = clipText(text, max);
    out.push(`**${S.lastUser}** ${ref(doc.lastUser)}`);
    out.push('');
    out.push(clipped.split('\n').map((l) => `> ${l}`).join('\n'));
    if (clipped !== text && below) out.push(`> ${fill(below.clipped ? S.moreBelow : S.fullBelow, { ref: ref(doc.lastUser) })}`);
    const la = attOf(doc.lastUser);
    if (la.length) out.push(`> ${fill(below ? S.attachInBelow : S.attachIn, { n: la.length, names: attNames(la), ref: ref(doc.lastUser) })}`);
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
  } else if (doc.lastAssistant > doc.lastUser && doc.recent.some((r) => r.m === doc.lastAssistant && !r.clipped)) {
    out.push(fill(S.lastBelow, { ref: ref(doc.lastAssistant) }));
    out.push('');
  } else if (doc.lastUser >= 0 && doc.lastAssistant < doc.lastUser) {
    out.push(S.noReply);
    out.push('');
  }

  if (doc.open.length) {
    section(S.open);
    out.push(list(doc.open, Math.min(220, doc.lineChars)));
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
      } else out.push(line(f, tail, Math.min(300, doc.lineChars)));
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

  if (doc.past.length) {
    section(S.past);
    let lastM = -1;
    for (const p of doc.past) {
      if (p.m !== lastM) {
        out.push(`- **${roleName(p.role)}** ${ref(p.m)}`);
        lastM = p.m;
      }
      if (p.table) out.push(`\n${p.text.split('\n').map((l) => `  ${l}`).join('\n')}\n`);
      else out.push(`  - ${oneLine(p.text, Math.round(doc.lineChars * 1.34))}`);
    }
    out.push('');
  }

  section(S.recent);
  for (const r of doc.recent) {
    const meta = r.time ? formatDateTime(r.time) : '';
    out.push(`### ${ref(r.m)} ${roleName(r.role)}${meta ? ` · ${meta}` : ''}${r.clipped ? ` ${S.clipped}` : ''}`);
    out.push('');
    out.push(r.body.trim() || S.emptyBody);
    out.push('');
  }

  // Index of referenced messages that are not in the transcript above (those carry their own
  // header with role and time).
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

/** The beginning of `text` within `max` tokens, cut at a space or line end, code fences closed. */
export function clipHead(text: string, max: number, lang: 'ko' | 'en'): string {
  if (estimateTokens(text) <= max) return text;
  const note = L[lang].clippedTail;
  const room = max - estimateTokens(note) - 4;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokens(text.slice(0, mid)) <= room) lo = mid;
    else hi = mid - 1;
  }
  let cut = text.slice(0, lo);
  const ws = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  if (ws > lo * 0.6) cut = cut.slice(0, ws);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  if (!cut.trim()) return '';
  const fences = (cut.match(/^\s{0,3}(`{3,}|~{3,})/gm) ?? []).length;
  return `${cut.trimEnd()}${fences % 2 ? '\n```' : ''}${note}`;
}

/** One verbatim piece of a message in the condensed form; null marks omitted text. */
export interface CondensedPiece {
  kind: 'sentence' | 'item' | 'heading' | 'code' | 'table' | 'quote' | 'attachment';
  text: string;
  lang?: string;
}
export interface CondensedMessage {
  m: number;
  pieces: Array<CondensedPiece | null>;
}

/**
 * The condensed form for short conversations (v1.3.8): the conversation itself with only its key
 * sentences, in order, each message under its [#mN] header, and `…` where text was left out. At
 * the budget of a short chat this keeps far more of it than the sections would (their headings,
 * lists and quotes cost most of a small budget).
 */
/** How much frame the condensed form has: a smaller budget drops the footer, the source line, then the note. */
export interface CondensedFrame {
  intro: 'full' | 'short' | 'none';
  meta: boolean;
  footer: boolean;
}
export const CONDENSED_FRAMES: CondensedFrame[] = [
  { intro: 'full', meta: true, footer: true },
  { intro: 'full', meta: true, footer: false },
  { intro: 'full', meta: false, footer: false },
  { intro: 'short', meta: false, footer: false },
  { intro: 'none', meta: false, footer: false },
];

export function renderCondensedHandoff(conv: Conversation, lang: 'ko' | 'en', messages: CondensedMessage[], opts: CondensedFrame & { sourceTokens: number; now: number }): string {
  const S = L[lang];
  const roleName = (role: Role) => (role === 'user' ? S.user : conv.siteName);
  const out = [`# ${S.title} — ${conv.title || conv.siteName}`, ''];
  if (opts.intro !== 'none') out.push(`> ${fill(opts.intro === 'full' ? S.intro.condensed : S.intro.condensedShort, { site: conv.siteName })}`, '');
  if (opts.meta) out.push(`- ${fill(S.condensedMeta, { site: `[${sourceDomain(conv)}](${conv.fromUrl})`, n: conv.messages.length, src: opts.sourceTokens.toLocaleString('en-US'), time: formatDateTime(opts.now) })}`, '');
  out.push(`## ${S.condensed}`, '');
  const piece = (p: CondensedPiece) => {
    switch (p.kind) {
      case 'code': {
        const fc = fence(p.text);
        return `${fc}${p.lang ?? ''}\n${p.text}\n${fc}`;
      }
      case 'item':
        return `- ${p.text}`;
      case 'heading':
        return `**${p.text}**`;
      case 'quote':
        return `> ${p.text}`;
      case 'attachment':
        return `[${S.attachmentLabel}: ${p.text}]`;
      default:
        return p.text;
    }
  };
  for (const cm of messages) {
    const msg = conv.messages[cm.m];
    out.push(`### [#m${cm.m + 1}] ${roleName(msg.role)}`, '');
    const body: string[] = [];
    let prev: CondensedPiece | null | undefined;
    for (const p of cm.pieces) {
      // Lines of one list or one paragraph stay together; blocks are separated by a blank line.
      if (p && prev && p.kind === prev.kind && (p.kind === 'item' || p.kind === 'sentence' || p.kind === 'quote')) body.push('\n');
      else if (body.length) body.push('\n\n');
      body.push(p ? piece(p) : '…');
      prev = p;
    }
    out.push(body.join('') || S.emptyBody, '');
  }
  if (opts.footer) out.push('---', `_${S.footer}_`);
  return `${out.join('\n')}\n`;
}

/**
 * Structure check for the verification report: the sections every handoff has (others are left
 * out when empty), in order, plus at least one message reference.
 */
export function verifyHandoffMarkdown(md: string, lang: 'ko' | 'en'): { ok: boolean; detail?: string } {
  const S = L[lang];
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The condensed form of a short conversation: reader note and the key sentences of each message.
  if (new RegExp(`^## ${esc(S.condensed)}$`, 'm').test(md)) return /\[#m\d+\]/.test(md) ? { ok: true } : { ok: false, detail: 'missing message references' };
  let rest = md;
  for (const title of [S.meta, S.goal, S.current, S.next]) {
    const m = new RegExp(`^## \\d+\\. ${esc(title)}`, 'm').exec(rest);
    if (!m) return { ok: false, detail: `missing section: ${title}` };
    rest = rest.slice(m.index + m[0].length);
  }
  if (!new RegExp(`^## \\d+\\. ${esc(S.recent)}`, 'm').test(rest)) return { ok: false, detail: `missing section: ${S.recent}` };
  if (!/\[#m\d+\]/.test(md)) return { ok: false, detail: 'missing message references' };
  return { ok: true };
}
