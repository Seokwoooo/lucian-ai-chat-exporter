import { cleanUrl } from '../shared/util';

// Rule-based detectors for Korean and English chat text. No model is involved: every flag comes
// from an explicit pattern so results are explainable and deterministic.

export const F = {
  DIRECTIVE: 1 << 0,
  CONSTRAINT: 1 << 1,
  DECISION: 1 << 2,
  CHANGE: 1 << 3,
  DONE: 1 << 4,
  TODO: 1 << 5,
  FAILURE: 1 << 6,
  QUESTION: 1 << 7,
  GOAL: 1 << 8,
  EMPHASIS: 1 << 9,
  NEXT: 1 << 10,
  CONFIRM: 1 << 11,
  POLITE: 1 << 12,
  NOT_DONE: 1 << 13,
  CAUSE: 1 << 14,
  RECOMMEND: 1 << 15,
  PERMIT: 1 << 16,
  PROHIBIT: 1 << 17,
  /** Request for information/explanation rather than a requirement. */
  ASK: 1 << 18,
  /** Conclusion / summary sentence ("결론부터 말하면", "In short"). */
  LEAD: 1 << 19,
  /** Explicitly unfinished work ("아직 구현하지 못했습니다", "TODO", "not yet implemented"). */
  PENDING: 1 << 20,
} as const;

const KO = {
  directive:
    /(하자|바꾸자|쓰자|가자|만들자|넣자|빼자|합시다|바꿉시다|갑시다|해\s?줘|해\s?주세요|해\s?주십시오|해\s?주시|하세요|하십시오|해라|해야\s?(해|합니다|함|돼|됩니다|한다)|하도록|만들어|구현해|작성해|추가해|수정해|바꿔|변경해|사용해|써\s?줘|넣어|빼\s?줘|지워|삭제해|적용해|진행해|시작해|유지해|필요(해|합니다|함)|원해|원합니다|바란다|바랍니다|부탁)/,
  prohibit:
    /(하지\s?마|하지\s?말|말아\s?(줘|주세요|라)|금지|절대\s?(로)?\s?\S*\s?(마|말|안|않|금지)|하면\s?안\s?(돼|됩니다|된다)|쓰지\s?마|사용하지\s?(마|말|않)|넣지\s?(마|말)|추가하지\s?(마|말)|만들지\s?(마|말)|허용하지\s?않|해서는\s?안)/,
  constraint: /(않도록|없이|빼고|제외|만\s?(사용|써|쓰)|반드시|무조건|필수|꼭\s|제한|이하로|이내로|초과하지|넘지\s?않)/,
  decision:
    /(로\s?하자|으로\s?하자|로\s?결정|으로\s?결정|확정|결정(했|하였|함|합니다|하겠|할게)|로\s?가자|으로\s?가자|로\s?갑시다|으로\s?갑시다|채택|선택(했|함|합니다|하겠|할게)|그걸로|그것으로|이걸로|이것으로|그렇게\s?(하자|해|진행|합시다|가자)|최종(적으로|안|결정)|(로|으로)\s?(진행|구현|개발|만들)(하겠|할게|합니다|하자|하기로)|기로\s?(했|하였|함|하자)|(로|으로)\s?(바꾸자|바꿉시다|변경하자|변경합시다|전환하자|교체하자|갈게|할게|하겠습니다|정하자|정했))/,
  change:
    /(아니(라|고|요|야)?[,.\s]|아닌|말고|대신(에)?|바꾸|바꿔|변경|정정|취소|철회|오히려|틀렸|잘못|번복|폐기|되돌|원복|다시\s?(하|해|만들|구현))/,
  done:
    /(완료(했|됐|되었|함|입니다|하였)?|끝났|끝냈|마쳤|구현(했|함|완료|하였|되었)|추가(했|함|하였|되었)|수정(했|함|하였|완료|되었)|해결(했|됨|함|되었)|성공(했|함|하였)|작성(했|함|하였)|적용(했|함|하였|되었)|통과(했|함|하였)|반영(했|함|하였|되었)|생성(했|함|하였|되었)|배포(했|함|하였)|고쳤|만들었|찾았|되었습니다|됐습니다|했습니다|하였습니다)/,
  notDone: /(완료(되지|하지)\s?(않|못)|아직\s?(완료|안|못|구현)|못\s?했|안\s?됐|되지\s?않았|하지\s?못)/,
  todo: /(해야\s?할|해야\s?합니다|남은|남아\s?있|아직|다음\s?(단계|작업|으로|에는|할\s?일)|추후|나중에|미완료|미구현|진행\s?중|할\s?일|예정|계획|이어서|계속해서|우선순위)/,
  next: /(다음\s?(단계|작업|할\s?일|으로|순서)|이어서\s?(할|진행)|남은\s?(핵심|작업|일|과제|단계|문제|확인)|앞으로|후속\s?(작업|조치|확인))/,
  lead: /(결론(부터|은|적으로|:)|요약(하면|하자면|:)|정리(하면|하자면)|핵심(은|만)|최종\s?(판단|판정|결론|정리|추천)|한\s?줄\s?요약)/,
  pending: /(미완료|미구현|아직\s?(구현|완료|테스트|확인|적용|반영|처리|작성|수정|해결)(하지|되지|을|를|이|가)?\s?(못|안|않)|구현(하지|되지)\s?(못|않)|완료(하지|되지)\s?(못|않))/,
  failure:
    /(오류|에러|실패|안\s?(돼|됨|되네|된다|되요|돼요)|작동(하지|안\s?하|을\s?안)|동작(하지|안)|문제(가|는|점)|버그|충돌|깨(짐|져|졌)|예외\s?발생|크래시|멈춤|타임아웃|먹통|누락)/,
  cause: /(원인|때문|이유는|이유가|탓)/,
  question: /(까요|나요|인가요|습니까|을까|할까|는지|건가요|되나요|어때)\s*[?？.]?\s*$/,
  goal: /(목표|목적|만들고\s?싶|만들려고|하려고\s?(해|합니다)|원하는\s?(것|건|바)|프로젝트|구축|개발(하려|하고\s?싶)|최종\s?결과물|핵심\s?기능|핵심은)/,
  emphasis: /(!!|중요|반드시|꼭|절대|무조건|명심|강조|최우선|주의)/,
  confirm: /^(네|예|응|넵|좋아요?|좋습니다|좋네요|오케이|확정|맞아요?|맞습니다|그렇게\s?(해|하자|해\s?주세요|진행|합시다)|진행(해|하세요|해\s?주세요|합시다)|그걸로|이걸로|그대로\s?(해|진행)|ㅇㅋ|ㅇㅇ)/,
  polite: /^(물론(입니다|이죠)?|좋은 질문|알겠습니다|네[,!]?\s?(알겠습니다|좋습니다|물론)|도움이\s?(되었|됐|되길)|궁금한\s?(점|것)|추가로\s?(필요|궁금)|감사합니다|천만에요)/,
  recommend: /(추천|권장|제안)(합니다|드립니다|해요|하는|드려요|드리)|가\s?좋겠|이\s?좋겠|을\s?권합니다/,
  permit: /(써도\s?(돼|된|괜찮)|사용해도\s?(돼|된|괜찮)|허용|해도\s?(돼|된|괜찮)|풀어|해제)/,
  ask: /(설명해|알려\s?줘|알려\s?주세요|알려\s?주실|뭐야|뭔가요|무엇인가요|무엇입니까|어떻게\s?(해|하나요|되나요|하면)|차이(가|점|는)|궁금|비교해\s?(줘|주세요))/,
};

const EN = {
  directive:
    /\b(please|must|should|need(s)? to|make sure|ensure|i want|i need|we need|let'?s|implement|create|add|remove|use|write|build|fix|change|update|keep|don'?t|do not|never|always)\b/i,
  prohibit: /\b(don'?t|do not|never|must not|mustn'?t|shouldn'?t|should not|avoid|forbidden|prohibited|not allowed|disallow(ed)?|under no circumstances|no (more )?\w+ allowed)\b/i,
  constraint: /\b(without|no more than|at most|at least|only use|only|required|mandatory|always|limit(ed)? to|strictly)\b/i,
  decision:
    /\b(let'?s go with|let'?s use|we'?ll use|we will use|decided|decision|going with|go with|final(ly)?|settled on|we chose|chose|opt(ed)? for|switch(ed)? to|confirmed?|agreed|the plan is|we'?ll go with)\b/i,
  change: /\b(instead|actually|rather than|change (it|that|this)? ?to|switch(ed)? (to|from)|replace|scratch that|no,|not .{1,40} but|correction|revert|undo|wrong|on second thought|never ?mind|drop(ped)?|abandon(ed)?)\b/i,
  done: /\b(done|completed?|finished|implemented|fixed|resolved|added|created|works now|passed|merged|deployed|shipped|updated|refactored)\b|✅/i,
  notDone: /\b(not (yet )?(done|finished|implemented|fixed|working|complete)|didn'?t|failed to|isn'?t done)\b/i,
  todo: /\b(todo|to-do|to do|next steps?|next,|remaining|pending|not yet|still need|later|follow[- ]up|in progress|wip|plan to|will need|should also|outstanding|backlog)\b/i,
  next: /\b(next steps?|next,|next up|going forward|remaining work|still need to|what'?s left|then we|after that)\b/i,
  lead: /\b(in summary|in short|tl;?dr|bottom line|to summarize|the short answer|conclusion:?|overall,)/i,
  pending: /\b(todo|not (yet )?(implemented|done|finished|tested|verified|working)|still (missing|failing|pending)|unfinished|incomplete)\b/i,
  failure:
    /\b(error|exception|failed|failure|fails|failing|broken|bug|crash(es|ed)?|doesn'?t work|does not work|not working|traceback|stack trace|undefined is not|cannot|can'?t|timeout|timed out|regression)\b/i,
  cause: /\b(because|caused by|root cause|due to|the reason)\b/i,
  question: /\?\s*$/,
  goal: /\b(goal|objective|aim|purpose|i'?m building|we'?re building|i want to build|i'?m making|this project (is|will)|trying to build|the idea is|end result|deliverable)\b/i,
  emphasis: /\b(important|critical|crucial|must|never|always|essential)\b|!!/i,
  confirm: /^(ok(ay)?|yes|yep|yeah|sure|go( ahead)?|sounds good|perfect|lgtm|agreed|do it|let'?s do (it|that)|that works|great,? (go|do))/i,
  polite: /^(sure[!,.]|certainly|great question|happy to help|i hope this helps|let me know if|feel free to|of course[!,.]|absolutely[!,.])/i,
  recommend: /\b(recommend|suggest|propose|i'?d go with|the best option|you should use)\b/i,
  permit: /\b(you can (now )?use|it'?s (ok|fine) to|allowed now|feel free to use|lift(ed)? the)\b/i,
  ask: /\b(explain|what is|what are|what'?s|how (do|does|can|should)|why (do|does|is|are)|tell me (about|more)|difference between|compare)\b/i,
};

/** Classifies a prose unit. `role` lets user-only signals (confirmations) apply correctly. */
export function classify(text: string, role: 'user' | 'assistant'): number {
  let f = 0;
  const t = text;
  if (KO.directive.test(t) || EN.directive.test(t)) f |= F.DIRECTIVE;
  if (KO.prohibit.test(t) || EN.prohibit.test(t)) f |= F.PROHIBIT | F.CONSTRAINT;
  else if (KO.constraint.test(t) || EN.constraint.test(t)) f |= F.CONSTRAINT;
  if (KO.decision.test(t) || EN.decision.test(t)) f |= F.DECISION;
  if (KO.change.test(t) || EN.change.test(t)) f |= F.CHANGE;
  if (KO.done.test(t) || EN.done.test(t) || /^\s*[-*]\s*\[[xX]\]/.test(t)) f |= F.DONE;
  if (KO.notDone.test(t) || EN.notDone.test(t)) f |= F.NOT_DONE;
  if (KO.todo.test(t) || EN.todo.test(t) || /^\s*[-*]\s*\[ \]/.test(t)) f |= F.TODO;
  if (KO.next.test(t) || EN.next.test(t)) f |= F.NEXT;
  if (KO.failure.test(t) || EN.failure.test(t)) f |= F.FAILURE;
  if (KO.cause.test(t) || EN.cause.test(t)) f |= F.CAUSE;
  if (/[?？]\s*$/.test(t) || KO.question.test(t)) f |= F.QUESTION;
  if (KO.goal.test(t) || EN.goal.test(t)) f |= F.GOAL;
  if (KO.emphasis.test(t) || EN.emphasis.test(t) || /\*\*[^*]+\*\*/.test(t) || /\b[A-Z]{4,}\b/.test(t)) f |= F.EMPHASIS;
  if (KO.recommend.test(t) || EN.recommend.test(t)) f |= F.RECOMMEND;
  if (KO.permit.test(t) || EN.permit.test(t)) f |= F.PERMIT;
  if (KO.ask.test(t) || EN.ask.test(t)) f |= F.ASK;
  if (KO.lead.test(t) || EN.lead.test(t)) f |= F.LEAD;
  if (KO.pending.test(t) || EN.pending.test(t)) f |= F.PENDING;
  const trimmed = t.trim();
  if (role === 'user' && trimmed.length <= 60 && (KO.confirm.test(trimmed) || EN.confirm.test(trimmed))) f |= F.CONFIRM;
  if (role === 'assistant' && (KO.polite.test(trimmed) || EN.polite.test(trimmed))) f |= F.POLITE;
  return f;
}

// ---------- entities ----------

const PATH_RE =
  /(?:~|\.{1,2}|[A-Za-z]:)?(?:[\\/][\w.@+-]+){2,}\/?|\b[\w-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]{1,6}\b|\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|ps1|sql|md|mdx|json|jsonc|yml|yaml|toml|ini|env|lock|html|css|scss|vue|svelte|xml|csv|txt|pdf|docx|hwpx|ipynb|gradle|tf|dockerfile)\b/gi;
const URL_RE = /https?:\/\/[^\s<>()"'`\]]+[^\s<>()"'`\].,;:!?]/g;
const CMD_RE = /^(?:\$\s+|>\s+)?((?:npm|npx|pnpm|yarn|bun|node|deno|git|gh|pip3?|python3?|uv|poetry|docker|docker-compose|kubectl|curl|wget|brew|apt(?:-get)?|cargo|go|make|cmake|java|mvn|gradle|dotnet|terraform|aws|gcloud|firebase|vercel|supabase|psql|mysql|redis-cli|chmod|mkdir|cd|ls|cp|mv|rm|export|source)\s[^\n]{1,200})$/gm;

export function extractPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.replace(URL_RE, ' ').matchAll(PATH_RE)) {
    const p = m[0].replace(/[.,;:)]+$/, '');
    if (p.length < 4 || /^https?:/i.test(p) || /^\/\//.test(p)) continue;
    if (/^\d+(\.\d+)+$/.test(p)) continue; // version numbers
    out.add(p);
  }
  return [...out];
}

export function extractUrls(text: string): string[] {
  return [...new Set(text.match(URL_RE) ?? [])];
}

/** URLs with the Markdown link text that labels them, when there is one. */
export function extractLinks(text: string): Array<{ url: string; title?: string }> {
  const out = new Map<string, string | undefined>();
  for (const m of text.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/g)) if (!out.has(m[2])) out.set(m[2], m[1].replace(/[*_`]/g, '').trim() || undefined);
  for (const url of text.match(URL_RE) ?? []) if (!out.has(url)) out.set(url, undefined);
  return [...out.entries()].map(([url, title]) => ({ url, title }));
}

/**
 * Text for a handoff bullet: citation chips appended by the adapters (" ([site](url))") are removed
 * — the links section lists them — and the rest of the sentence is kept verbatim.
 */
export function bulletText(text: string): string {
  return stripTracking(text.replace(/\s?\((?:\[[^\]\n]{1,80}\]\(https?:\/\/[^)\s]+\)(?:,\s*)?)+\)/g, '')).trim();
}

/** Removes tracking parameters (utm_source=chatgpt.com…) from every URL in the text. */
export function stripTracking(text: string): string {
  if (!/[?&#](utm_|fbclid|gclid|source=post_page|:~:text)/.test(text)) return text;
  return text.replace(URL_RE, (url) => cleanUrl(url));
}

export function extractCommands(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(CMD_RE)) out.add(m[1].trim());
  return [...out];
}

// ---------- topic tokens ----------

const KO_PARTICLE = /(으로는|로는|에서는|에게서|으로|에서|에게|한테|까지|부터|처럼|보다|이랑|하고|이라|이다|입니다|은|는|이|가|을|를|에|의|로|와|과|도|만|랑)$/;

const STOP = new Set(
  (
    '그리고 하지만 그래서 그러면 그런데 이것 그것 저것 이거 그거 저거 우리 여기 거기 사용 방식 방법 구현 개발 진행 결정 확정 하자 해줘 합니다 있습니다 없습니다 됩니다 같은 이번 다음 이전 기존 모든 정도 경우 부분 관련 위해 대해 통해 지금 이제 먼저 그냥 정말 아주 매우 ' +
    'the a an to of and or we you i it is are be will would should could can use using used with for in on at this that these those from by as not but if then than so do does did let lets let\'s make go going instead please also just'
  ).split(/\s+/),
);

/** Content tokens used to compare what two sentences are about (decisions, tasks). */
export function topicTokens(text: string): string[] {
  const out = new Set<string>();
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._+#/-]*/gu) ?? [];
  for (let w of words) {
    w = w.replace(/[._/-]+$/, '');
    if (/[가-힣]/.test(w)) {
      w = w.replace(KO_PARTICLE, '');
      if (w.length < 2) continue;
    } else if (w.length < 2 || (w.length < 3 && !/\d/.test(w))) {
      continue;
    }
    if (STOP.has(w)) continue;
    out.add(w);
  }
  return [...out];
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  let inter = 0;
  for (const x of b) if (sa.has(x)) inter++;
  return inter / (sa.size + b.length - inter);
}

/** Pairs of (old, new) phrases expressed in one sentence, e.g. "A 말고 B로", "use B instead of A". */
export function replacementPairs(text: string): Array<{ old: string[]; neu: string[] }> {
  const pairs: Array<{ old: string[]; neu: string[] }> = [];
  const push = (oldS: string | undefined, newS: string | undefined) => {
    if (!oldS || !newS) return;
    const old = topicTokens(oldS);
    const neu = topicTokens(newS);
    if (old.length && neu.length) pairs.push({ old, neu });
  };
  let m: RegExpExecArray | null;
  const ko1 = /((?:\S+\s){0,2}\S+?)\s?(?:말고|대신에?|가\s?아니라|이\s?아니라|아니고)\s+((?:\S+\s?){1,3})/g;
  while ((m = ko1.exec(text))) push(m[1], m[2]);
  const ko2 = /((?:\S+\s){0,2}\S+?)\s?(?:에서|를|을)\s+((?:\S+\s?){1,3}?)(?:으로|로)\s?(?:변경|바꾸|바꿔|전환|교체|대체)/g;
  while ((m = ko2.exec(text))) push(m[1], m[2]);
  const en = [
    /\b(?:use|using|go with|switch to|choose)\s+([\w.+#/-]+(?:\s[\w.+#/-]+)?)\s+instead of\s+([\w.+#/-]+(?:\s[\w.+#/-]+)?)/gi,
    /\b([\w.+#/-]+(?:\s[\w.+#/-]+)?)\s+instead of\s+([\w.+#/-]+(?:\s[\w.+#/-]+)?)/gi,
    /\b([\w.+#/-]+(?:\s[\w.+#/-]+)?)\s+rather than\s+([\w.+#/-]+(?:\s[\w.+#/-]+)?)/gi,
  ];
  for (const re of en) while ((m = re.exec(text))) push(m[2], m[1]);
  const notBut = /\bnot\s+([\w.+#/-]+(?:\s[\w.+#/-]+)?),?\s+but\s+([\w.+#/-]+(?:\s[\w.+#/-]+)?)/gi;
  while ((m = notBut.exec(text))) push(m[1], m[2]);
  const fromTo = /\b(?:switch(?:ed)?|move[ds]?|migrat(?:e|ed|ing)|chang(?:e|ed|ing))\s+from\s+([\w.+#/-]+(?:\s[\w.+#/-]+)?)\s+to\s+([\w.+#/-]+(?:\s[\w.+#/-]+)?)/gi;
  while ((m = fromTo.exec(text))) push(m[1], m[2]);
  const replaceWith = /\breplac(?:e|ed|ing)\s+([\w.+#/-]+(?:\s[\w.+#/-]+)?)\s+with\s+([\w.+#/-]+(?:\s[\w.+#/-]+)?)/gi;
  while ((m = replaceWith.exec(text))) push(m[1], m[2]);
  return pairs;
}

/** Error output in code/tool blocks (stack traces, compiler errors), not the word "error" in code. */
/**
 * A sentence that needs the one before it to be understood: Korean demonstratives and connectives
 * ("이 방식은…", "그래서…", "따라서…") and their English counterparts ("This…", "So…").
 */
export const ANAPHOR_RE =
  /^(?:[-*>]\s*)?(?:(?:이|그|저)(?=\s|것|거|게|건|걸|렇|런|러|래|리|때|곳|쪽|분|중|와|후|전|를|는|가|에|로|의)|해당|위의?\s|아래의?\s|앞의?\s|따라서|그러므로|그러면|하지만|또한|즉[,\s]|결국|(?:this|that|these|those|it|its|they|them|such|thus|therefore|hence|however|also|then|so|above|below)\b|as (?:mentioned|noted|shown)\b)/i;

export const CODE_ERROR_RE =
  /(Traceback \(most recent call last\)|^\s*[\w.]*(Error|Exception)(:|\s+at\b)|\berror\[E\d+\]|^\s*error(\[\w+\])?:|\bFAILED\b|panicked at|Uncaught \w*Error|Unhandled (promise )?rejection|npm ERR!|fatal:)/m;
