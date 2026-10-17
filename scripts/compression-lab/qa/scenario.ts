// QA evaluation — synthetic project conversations (Korean / English) with planted facts and an
// answer key. Filler is varied technical chatter with distractors (other retry counts, other
// timeouts, other file paths, other measured latencies) so that a fact has to be selected, not
// just "kept because everything fits".

import type { Conversation, ExportMessage } from '../../../src/shared/types';
import { estimateTokens } from '../../../src/shared/util';

export type Lang = 'ko' | 'en';
export interface Question {
  id: string;
  kind: string;
  q: string;
  accept: string; // regex source (case-insensitive)
  reject?: string;
  unanswerable?: boolean;
}

let seed = 1;
const rand = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pickNot = <T>(a: readonly T[], not: T): T => {
  for (;;) {
    const x = pick(a);
    if (x !== not) return x;
  }
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- planted values (per conversation)

const V = [
  {
    goal: { ko: '온라인 꽃집 주문·결제 시스템을', en: 'an order and payment system for an online flower shop', re: '꽃|flower' },
    dbOld: 'MongoDB', dbNew: 'PostgreSQL',
    reason: { ko: '주문과 결제를 한 트랜잭션으로 묶어야 해서요', en: 'we need orders and payments in one transaction', re: '트랜잭션|transaction' },
    lib: 'moment.js', libRe: 'moment', p95: 200,
    commit: { ko: 'Conventional Commits 형식', en: 'the Conventional Commits format', re: 'conventional' },
    cause: { ko: '스테이징 서버에 DATABASE_URL 환경변수가 없었기', en: 'the DATABASE_URL environment variable was missing on the staging server', re: 'DATABASE_URL', fixKo: '배포 설정의 secrets에 DATABASE_URL을 추가했습니다.', fixEn: 'I added DATABASE_URL to the deployment secrets.' },
    queue: 'BullMQ', header: 'Idempotency-Key', path: 'src/payments/retry-policy.ts',
    cmd: 'npm run db:migrate -- --env staging', cmdRe: 'db:migrate',
    retryMax: 5, gap: 30, access: 15, refresh: 14,
    rejected: { ko: 'Redis 캐시를', en: 'a Redis cache', q: { ko: 'Redis 캐시를', en: 'a Redis cache' } },
    done: { ko: '웹훅 서명 검증', koObj: '웹훅 서명 검증을', koTopic: '웹훅 서명 검증은', en: 'webhook signature verification' },
    pending: { ko: '부분 환불', en: 'partial refunds', re: '부분\\s?환불|partial refund', blockerKo: 'PG사의 부분 취소 API 사용 승인이 아직 나지 않았기', blockerEn: 'the payment gateway has not approved our access to its partial-cancel API yet' },
    next: { ko: '결제 내역 CSV 내보내기', en: 'a CSV export of the payment history', re: 'CSV' },
  },
  {
    goal: { ko: '헬스장 회원권 결제 서비스를', en: 'a membership payment service for a gym', re: '헬스|gym|fitness' },
    dbOld: 'Firebase Firestore', dbNew: 'Supabase',
    reason: { ko: '복잡한 조인 쿼리가 필요해서요', en: 'we need complex join queries', re: '조인|join' },
    lib: 'jQuery', libRe: 'jquery', p95: 300,
    commit: { ko: 'gitmoji 형식', en: 'the gitmoji format', re: 'gitmoji' },
    cause: { ko: 'Dockerfile의 Node 버전이 18로 고정되어 있었기(이 프로젝트는 20 이상 필요)', en: 'the Dockerfile pinned Node 18 while the project needs Node 20 or later', re: 'node.{0,20}18|18.{0,20}node|노드.{0,10}18', fixKo: '베이스 이미지를 node:20-slim으로 올렸습니다.', fixEn: 'I bumped the base image to node:20-slim.' },
    queue: 'SQS', header: 'X-Idempotency-Key', path: 'src/payments/requeue.ts',
    cmd: 'pnpm prisma migrate deploy', cmdRe: 'prisma migrate deploy',
    retryMax: 4, gap: 20, access: 30, refresh: 30,
    rejected: { ko: 'Elasticsearch를', en: 'Elasticsearch', q: { ko: 'Elasticsearch를', en: 'Elasticsearch' } },
    done: { ko: '영수증 PDF 발급', koObj: '영수증 PDF 발급을', koTopic: '영수증 PDF 발급은', en: 'receipt PDF generation' },
    pending: { ko: '정기결제 자동 갱신', en: 'automatic renewal of recurring payments', re: '자동\\s?갱신|정기\\s?결제|renewal|recurring', blockerKo: '카드사와의 빌링키 발급 계약이 아직 끝나지 않았기', blockerEn: 'the billing-key contract with the card company is not signed yet' },
    next: { ko: '관리자용 환불 승인 화면', en: 'an admin screen for approving refunds', re: '환불\\s?승인|approv' },
  },
  {
    goal: { ko: '독립 서점 온라인 주문 서비스를', en: 'an online ordering service for an independent bookstore', re: '서점|book' },
    dbOld: 'MySQL', dbNew: 'SQLite',
    reason: { ko: '서버 한 대로 운영해서 비용을 줄이려고요', en: 'we want to cut costs by running on a single server', re: '비용|cost|한 대|single server' },
    lib: 'lodash', libRe: 'lodash', p95: 150,
    commit: { ko: '"[PAY-번호] 요약" 형식', en: 'the "[PAY-number] summary" format', re: 'PAY-' },
    cause: { ko: '헬스체크 경로가 /healthz로 잘못 설정되어 있었기(실제 경로는 /health)', en: 'the health check path was wrongly set to /healthz (the real path is /health)', re: 'healthz|헬스\\s?체크|health\\s?check', fixKo: '헬스체크 경로를 /health로 고쳤습니다.', fixEn: 'I changed the health check path to /health.' },
    queue: 'RabbitMQ', header: 'X-Request-Key', path: 'src/payments/backoff.ts',
    cmd: 'npx knex migrate:latest --env staging', cmdRe: 'knex migrate:latest',
    retryMax: 6, gap: 15, access: 10, refresh: 7,
    rejected: { ko: 'Memcached를', en: 'Memcached', q: { ko: 'Memcached를', en: 'Memcached' } },
    done: { ko: '주문 취소 API', koObj: '주문 취소 API를', koTopic: '주문 취소 API는', en: 'the order cancellation API' },
    pending: { ko: '세금계산서 발행', en: 'tax invoice issuing', re: '세금\\s?계산서|tax invoice', blockerKo: '국세청 연동 인증서를 아직 받지 못했기', blockerEn: 'we have not received the certificate for the tax office integration yet' },
    next: { ko: '결제 수단 저장', en: 'saving payment methods', re: '결제\\s?수단|payment method' },
  },
  {
    goal: { ko: '캠핑장 예약·결제 서비스를', en: 'a booking and payment service for campsites', re: '캠핑|camp' },
    dbOld: 'DynamoDB', dbNew: 'PostgreSQL',
    reason: { ko: '팀원 모두 SQL에 익숙해서요', en: 'everyone on the team already knows SQL', re: 'SQL.{0,15}(익숙|familiar|know)|(익숙|familiar|know).{0,20}SQL|익숙|familiar' },
    lib: 'axios', libRe: 'axios', p95: 250,
    commit: { ko: 'Angular 커밋 규칙', en: 'the Angular commit convention', re: 'angular' },
    cause: { ko: '컨테이너 이미지에 sharp 네이티브 모듈이 빠져 있었기', en: 'the container image was missing the native sharp module', re: 'sharp', fixKo: '빌드 단계에서 sharp를 linux용으로 다시 설치했습니다.', fixEn: 'I reinstalled sharp for linux in the build stage.' },
    queue: 'Cloud Tasks', header: 'Idem-Key', path: 'src/payments/redrive.ts',
    cmd: 'yarn drizzle-kit push', cmdRe: 'drizzle-kit push',
    retryMax: 7, gap: 45, access: 20, refresh: 60,
    rejected: { ko: 'Kafka를', en: 'Kafka', q: { ko: 'Kafka를', en: 'Kafka' } },
    done: { ko: '관리자 매출 대시보드', koObj: '관리자 매출 대시보드를', koTopic: '관리자 매출 대시보드는', en: 'the admin sales dashboard' },
    pending: { ko: '결제 실패 알림 메일', en: 'payment failure notification emails', re: '실패\\s?알림|failure notification', blockerKo: '메일 발송 도메인 인증이 아직 끝나지 않았기', blockerEn: 'domain verification for sending mail is not finished yet' },
    next: { ko: '예약 대기열', en: 'a waitlist for bookings', re: '대기|waitlist|wait list' },
  },
  {
    goal: { ko: '공방 클래스 예약 결제 서비스를', en: 'a class booking and payment service for a craft workshop', re: '공방|craft|workshop' },
    dbOld: 'PostgreSQL', dbNew: 'MySQL',
    reason: { ko: '호스팅 업체가 MySQL만 관리형으로 제공해서요', en: 'our hosting provider only offers managed MySQL', re: '호스팅|관리형|managed|hosting' },
    lib: 'Redux', libRe: 'redux', p95: 400,
    commit: { ko: 'Conventional Commits 형식', en: 'the Conventional Commits format', re: 'conventional' },
    cause: { ko: '마이그레이션이 앱 시작보다 늦게 실행되었기', en: 'the migration ran after the app had already started', re: '마이그레이션|migration', fixKo: '배포 스크립트에서 마이그레이션을 앱 시작 전에 실행하도록 순서를 바꿨습니다.', fixEn: 'I reordered the deploy script so the migration runs before the app starts.' },
    queue: 'Redis Streams', header: 'X-Dedupe-Key', path: 'src/payments/retry.ts',
    cmd: 'make migrate ENV=staging', cmdRe: 'make migrate',
    retryMax: 3, gap: 60, access: 60, refresh: 90,
    rejected: { ko: 'CDN 엣지 캐시를', en: 'CDN edge caching', q: { ko: 'CDN 엣지 캐시를', en: 'CDN edge caching' } },
    done: { ko: '결제 영수증 이메일 발송', koObj: '결제 영수증 이메일 발송을', koTopic: '결제 영수증 이메일 발송은', en: 'sending payment receipt emails' },
    pending: { ko: '해외 카드 결제', en: 'payments with foreign cards', re: '해외|foreign|international', blockerKo: 'PG사의 해외 결제 심사가 아직 진행 중이기', blockerEn: "the payment gateway's review for international payments is still in progress" },
    next: { ko: '결제 페이지 다국어 지원', en: 'multi-language support for the payment page', re: '다국어|multi-?lang|languages|i18n|locali' },
  },
] as const;

// ---------------------------------------------------------------- filler pools

const COMPS = {
  ko: ['알림', '검색', '배송', '리포트', '인증', '장바구니', '관리자 화면', '로그 수집', '이미지 업로드', '구독', '포인트', '리뷰', '추천', '주문', '회원', '쿠폰'],
  en: ['notifications', 'search', 'shipping', 'reports', 'auth', 'cart', 'admin console', 'log ingestion', 'image upload', 'subscriptions', 'points', 'reviews', 'recommendations', 'orders', 'members', 'coupons'],
};
const AREAS = ['orders', 'notifications', 'search', 'shipping', 'reports', 'auth', 'cart', 'admin', 'logs', 'uploads', 'subscriptions', 'points', 'reviews', 'members', 'coupons'];
const NAMES = ['service', 'handler', 'store', 'client', 'worker', 'api', 'schema', 'utils', 'config', 'cache', 'validator', 'routes', 'mapper', 'events'];
const PAY_FILES = ['src/payments/service.ts', 'src/payments/webhook.ts', 'src/payments/types.ts', 'src/payments/gateway-client.ts', 'src/payments/ledger.ts'];
const VERBS = ['load', 'save', 'sync', 'build', 'parse', 'render', 'validate', 'flush', 'merge', 'fetch', 'compute', 'apply', 'resolve', 'format'];
const NOUNS = ['Order', 'Session', 'Coupon', 'Report', 'Batch', 'Event', 'Token', 'Invoice', 'Cart', 'Profile', 'Review', 'Shipment', 'Member', 'Point'];
const LIBS = ['zod', 'date-fns', 'pino', 'vitest', 'Playwright', 'tRPC', 'React Query', 'Zustand', 'Fastify', 'Sentry', 'OpenTelemetry', 'dayjs', 'Hono', 'Vite'];
const TABLES = ['orders', 'payments', 'members', 'coupons', 'shipments', 'reviews', 'points', 'sessions', 'reports'];

const file = () => (rand() < 0.15 ? pick(PAY_FILES) : `src/${pick(AREAS)}/${pick(NAMES)}.ts`);
const fn = () => `${pick(VERBS)}${pick(NOUNS)}`;

type S = (c: string) => string;
const SENT: Record<Lang, S[]> = {
  ko: [
    (c) => `${c} 모듈은 요청을 받으면 먼저 입력값을 ${pick(['zod', 'valibot', 'yup'])} 스키마로 검증합니다.`,
    (c) => `${c} 쪽 데이터는 하루에 약 ${int(2, 90) * 100}건씩 쌓이고 있어서 인덱스를 미리 잡아 두는 편이 좋습니다.`,
    () => `${fn()} 함수는 지금 동기로 동작하는데, 호출이 몰리면 이벤트 루프를 막을 수 있습니다.`,
    (c) => `${c} 화면은 목록을 한 번에 ${pick([20, 30, 50, 100])}개씩 불러오도록 페이지네이션을 넣었습니다.`,
    () => '로그에는 요청 ID와 사용자 ID만 남기고 카드 번호 같은 민감한 값은 남기지 않습니다.',
    () => `${file()} 파일이 너무 길어져서 조회 로직과 저장 로직을 나누는 것을 추천합니다.`,
    (c) => `캐시 무효화는 ${c} 데이터가 바뀔 때 이벤트를 발행해서 처리하면 됩니다.`,
    () => `테스트는 ${pick(['vitest', 'Jest', 'node:test'])} 기준으로 작성하고, 외부 API 호출은 모두 목으로 대체합니다.`,
    (c) => `${c} 기능은 관리자 권한이 있는 사용자만 접근할 수 있도록 미들웨어에서 막습니다.`,
    () => `지금 구조에서는 ${fn()} 함수가 두 번 호출되는 경로가 있어서 중복 처리를 막는 조건이 필요합니다.`,
    (c) => `${c} API 응답 형식은 다른 API와 맞춰서 data, error, meta 세 필드로 통일했습니다.`,
    (c) => `${c} 배치 작업은 새벽 ${int(1, 5)}시에 돌도록 스케줄을 잡는 게 무난합니다.`,
    () => '에러 메시지는 사용자에게 보여 줄 문구와 개발자용 코드를 따로 둡니다.',
    (c) => `${c} 데이터는 소프트 삭제로 처리해서 나중에 복구할 수 있게 했습니다.`,
    () => `공통 타입은 ${file()} 파일에 모아 두고 프론트엔드와 백엔드가 같이 씁니다.`,
    () => `${pick(LIBS)} 버전을 올리면서 바뀐 옵션 이름 몇 개를 같이 고쳤습니다.`,
    (c) => `${c} 목록의 기본 정렬은 생성 시각 내림차순이고, 사용자가 바꿀 수 있습니다.`,
    (c) => `${c} 호출은 실패해도 주문 흐름 전체를 막지 않도록 비동기로 분리했습니다.`,
    () => '환경별 설정은 설정 모듈 한 곳에서 읽도록 모아 두는 편이 안전합니다.',
    () => `${fn()} 함수의 반환값이 null일 수 있어서 호출하는 쪽에서 기본값을 넣어 줘야 합니다.`,
    (c) => `${c} 이벤트는 순서가 중요하지 않아서 병렬로 처리해도 됩니다.`,
    () => '날짜는 서버에서 모두 UTC로 저장하고 화면에서만 한국 시간으로 바꿉니다.',
    (c) => `${c} 쪽 쿼리의 실행 계획을 보니 풀 스캔이 나와서 복합 인덱스를 추가했습니다.`,
    () => '이 부분은 트래픽이 늘면 다시 보기로 하고 지금은 단순하게 둡니다.',
    (c) => `${c} 기능의 권한 체크는 서버에서 한 번 더 하므로 화면에서 버튼을 숨기는 것만으로는 충분하지 않습니다.`,
    (c) => `${c} 업로드 파일은 최대 ${pick([5, 10, 20, 50])}MB까지만 받도록 제한했습니다.`,
    () => `${pick(['pino', 'winston'])} 설정에서 로그 레벨을 info로 낮춰서 운영 로그 양을 줄였습니다.`,
    (c) => `${c} 쪽은 아직 사용자가 적어서 성능보다 읽기 쉬운 코드를 우선했습니다.`,
    (c) => `관리자 화면에서 ${c} 데이터를 엑셀로 받아 볼 수 있으면 좋겠다는 의견이 있었습니다.`,
    () => `${fn()} 함수는 순수 함수로 바꿔서 테스트하기 쉽게 만들었습니다.`,
    () => '외부 서비스 키는 코드에 넣지 않고 비밀 저장소에서 읽습니다.',
    (c) => `${c} 목록 API에 검색 조건이 늘어나면서 쿼리 빌더를 따로 뺐습니다.`,
    () => '프론트엔드에서는 낙관적 업데이트를 쓰고, 실패하면 이전 상태로 되돌립니다.',
    (c) => `${c} 화면에 빈 상태 문구와 로딩 스켈레톤을 추가했습니다.`,
    () => `코드 리뷰에서 ${file()} 파일의 함수 이름이 역할과 맞지 않는다는 지적이 있었습니다.`,
    (c) => `${c} 알림은 사용자가 설정에서 끌 수 있어야 합니다.`,
    (c) => `동시성 문제가 생기지 않도록 ${c} 수량 차감은 행 잠금으로 처리합니다.`,
    () => 'API 문서는 OpenAPI 스펙에서 자동으로 만들어지게 해 두었습니다.',
    (c) => `${c} 데이터 보관 기간은 ${pick([3, 6, 12, 24, 36])}개월로 잡았습니다.`,
    (c) => `좁은 화면에서 ${c} 표가 넘쳐서 가로 스크롤을 넣었습니다.`,
    (c) => `${c} 쪽 에러는 ${pick(['Sentry', 'OpenTelemetry'])}로 모아서 한 화면에서 봅니다.`,
    () => `${fn()} 함수 안의 중복된 분기를 하나로 합쳐서 코드가 ${int(20, 80)}줄 줄었습니다.`,
  ],
  en: [
    (c) => `The ${c} module validates its input with a ${pick(['zod', 'valibot', 'yup'])} schema before anything else.`,
    (c) => `About ${int(2, 90) * 100} ${c} records are added every day, so it is worth adding the index now.`,
    () => `The ${fn()} function is synchronous right now and can block the event loop under load.`,
    (c) => `The ${c} list now loads ${pick([20, 30, 50, 100])} items per page.`,
    () => 'Logs only keep the request ID and user ID, never sensitive values such as card numbers.',
    () => `The file ${file()} has grown too long, so I suggest splitting the read and write logic.`,
    (c) => `Cache invalidation can be handled by publishing an event whenever ${c} data changes.`,
    () => `Tests are written with ${pick(['vitest', 'Jest', 'node:test'])}, and every external API call is mocked.`,
    (c) => `Only users with the admin role can reach the ${c} feature; the middleware blocks everyone else.`,
    () => `There is a path where ${fn()} is called twice, so we need a guard against double processing.`,
    (c) => `The ${c} API response now uses the same data, error and meta fields as the other APIs.`,
    (c) => `Scheduling the ${c} batch job at ${int(1, 5)} a.m. is a safe choice.`,
    () => 'Error messages keep the user-facing text separate from the developer error code.',
    (c) => `${c} data is soft-deleted so it can be restored later.`,
    () => `Shared types live in ${file()} and are used by both the front end and the back end.`,
    () => `While upgrading ${pick(LIBS)} I also fixed a few renamed options.`,
    (c) => `The ${c} list is sorted by creation time, newest first, and users can change that.`,
    (c) => `${c} calls were moved to an async step so a failure does not block the whole order flow.`,
    () => 'It is safer to read environment-specific settings from a single config module.',
    () => `${fn()} can return null, so callers need to provide a default value.`,
    (c) => `The order of ${c} events does not matter, so they can be processed in parallel.`,
    () => 'All dates are stored in UTC on the server and converted to local time only in the UI.',
    (c) => `The query plan for the ${c} query showed a full scan, so I added a composite index.`,
    () => 'We will revisit this when traffic grows; for now it stays simple.',
    (c) => `Permissions for the ${c} feature are checked again on the server, so hiding the button is not enough.`,
    (c) => `${c} uploads are limited to ${pick([5, 10, 20, 50])} MB.`,
    () => `I lowered the log level to info in the ${pick(['pino', 'winston'])} config to reduce production log volume.`,
    (c) => `The ${c} area has few users so far, so readability comes before performance there.`,
    (c) => `Someone asked whether the admin console could offer the ${c} data as an Excel download.`,
    () => `${fn()} is now a pure function, which makes it easier to test.`,
    () => 'Keys for external services are read from the secret store, never hard-coded.',
    (c) => `As the ${c} list API gained more filters, I moved the query builder into its own module.`,
    () => 'The front end uses optimistic updates and rolls back to the previous state on failure.',
    (c) => `I added an empty-state message and a loading skeleton to the ${c} screen.`,
    () => `In code review someone pointed out that a function name in ${file()} does not match what it does.`,
    (c) => `Users must be able to turn ${c} notifications off in their settings.`,
    (c) => `To avoid race conditions, ${c} quantity updates take a row lock.`,
    () => 'The API docs are generated automatically from the OpenAPI spec.',
    (c) => `${c} data is kept for ${pick([3, 6, 12, 24, 36])} months.`,
    (c) => `On narrow screens the ${c} table overflowed, so I added horizontal scrolling.`,
    (c) => `Errors from ${c} are collected in ${pick(['Sentry', 'OpenTelemetry'])} so we can see them in one place.`,
    () => `Merging the duplicated branches in ${fn()} removed about ${int(20, 80)} lines.`,
  ],
};

const ASK: Record<Lang, S[]> = {
  ko: [
    (c) => `${c} 쪽은 어떻게 구성하는 게 좋을까요?`,
    () => `${file()} 파일 좀 봐 줄 수 있어요?`,
    (c) => `${c} 기능에서 신경 써야 할 점이 뭐가 있을까요?`,
    () => `${fn()} 함수가 느린 것 같은데 확인해 주세요.`,
    (c) => `${c} 관련해서 지금 구조를 다시 설명해 줘요.`,
    (c) => `${c} 화면 목록 정렬이 이상해요.`,
    () => `${pick(LIBS)}를 계속 써도 괜찮을까요?`,
    (c) => `${c} API 응답 형식을 정리해 줄래요?`,
    () => '이 부분 테스트는 어떻게 짜면 돼요?',
    (c) => `${c} 쪽 코드 리뷰 부탁해요.`,
    (c) => `${c} 데이터가 늘어나면 어떻게 되나요?`,
  ],
  en: [
    (c) => `How should we structure the ${c} part?`,
    () => `Can you take a look at ${file()}?`,
    (c) => `What should we watch out for in the ${c} feature?`,
    () => `${fn()} seems slow, can you check it?`,
    (c) => `Can you explain the current ${c} structure again?`,
    (c) => `The ${c} list is sorted strangely.`,
    () => `Is it fine to keep using ${pick(LIBS)}?`,
    (c) => `Can you tidy up the ${c} API response format?`,
    () => 'How should I write the tests for this part?',
    (c) => `Please review the ${c} code.`,
    (c) => `What happens when the ${c} data grows?`,
  ],
};

const STMT: Array<(t: string, T: string, f: string, i: number) => string> = [
  (t, _T, _f, i) => `const rows${i} = await db.select().from(${t}).where(eq(${t}.id, input.id));`,
  (_t, _T, f, i) => `logger.info({ id: input.id, step: ${i} }, '${f}');`,
  (_t, _T, _f, i) => `if (!rows${Math.max(0, i - 1)}?.length) return { ok: false, error: 'not_found' };`,
  (t) => `const cached = cache.get(\`${t}:\${input.id}\`);`,
  () => `if (cached) return { ok: true, value: cached };`,
  (_t, T) => `const parsed = ${T}Schema.safeParse(input);`,
  () => `if (!parsed.success) return { ok: false, error: 'invalid_input' };`,
  (t, _T, _f, i) => `const total${i} = rows${Math.max(0, i - 1)}.reduce((s, r) => s + r.amount, 0); // ${t}`,
  () => `const now = new Date().toISOString();`,
  (t) => `await db.update(${t}).set({ updatedAt: now }).where(eq(${t}.id, input.id));`,
  (_t, T) => `const result: ${T} = { ...input, updatedAt: now };`,
  () => `if (input.limit > 100) input.limit = 100;`,
  (t) => `cache.set(\`${t}:\${input.id}\`, result, { ttl: 60 });`,
  (_t, _T, f) => `metrics.increment('${f}.calls');`,
  () => `const ids = input.items.map((x) => x.id);`,
  () => `for (const id of ids) await events.publish('updated', { id });`,
];

function code(f: string, name: string): string {
  const T = pick(NOUNS);
  const t = pick(TABLES);
  const lines = Array.from({ length: int(5, 16) }, (_, i) => `  ${pick(STMT)(t, T, name, i)}`);
  return `\`\`\`ts\n// ${f}\nimport { db } from '../db';\nimport { logger } from '../logger';\n\nexport async function ${name}(input: ${T}Input): Promise<Result<${T}>> {\n${lines.join('\n')}\n  return { ok: true, value: result };\n}\n\`\`\``;
}

const para = (lang: Lang, n: number) => Array.from({ length: n }, () => pick(SENT[lang])(pick(COMPS[lang]))).join(' ');
const bullets = (lang: Lang, n: number) => Array.from({ length: n }, () => `- ${pick(SENT[lang])(pick(COMPS[lang]))}`).join('\n');

type Pair = [string, string];

function fillerEpisode(lang: Lang, v: (typeof V)[number]): Pair[] {
  const ko = lang === 'ko';
  const c = pick(COMPS[lang]);
  const r = rand();
  if (r < 0.3) {
    const body = rand() < 0.4 ? `${para(lang, int(2, 4))}\n\n${bullets(lang, int(3, 5))}\n\n${para(lang, int(1, 3))}` : `${para(lang, int(3, 6))}\n\n${para(lang, int(2, 5))}`;
    return [[pick(ASK[lang])(c), body]];
  }
  if (r < 0.48) {
    const f = file();
    const name = fn();
    const change = pick(ko ? ['비동기로 동작하도록', '에러를 던지지 않고 결과 객체를 돌려주도록', '입력 검증을 하도록', '캐시를 쓰도록', '로그를 남기도록'] : ['async', 'return a result object instead of throwing', 'validate its input', 'use the cache', 'log each step']);
    return [[ko ? `${f} 파일의 ${name} 함수를 ${change} 바꿔 주세요.` : `Please change ${name} in ${f} to ${change}.`, `${ko ? `${f} 파일을 수정했습니다.` : `I updated ${f}.`}\n\n${code(f, name)}\n\n${para(lang, int(1, 3))}`]];
  }
  if (r < 0.6) {
    const f = file();
    const name = fn();
    const err = pick(['TypeError: Cannot read properties of undefined (reading \'id\')', 'Error: Request aborted', 'ZodError: Expected string, received number', 'RangeError: Invalid time value', 'Error: deadlock detected']);
    const [dc, df] = pick(
      ko
        ? [[`${name} 함수에서 undefined를 검사하지 않은 것`, 'null 검사를 추가했습니다.'], ['응답이 오기 전에 컴포넌트가 사라진 것', '요청 취소 처리를 넣었습니다.'], ['타입 정의와 실제 응답 필드 이름이 다른 것', '필드 이름을 맞췄습니다.'], ['테스트 데이터의 날짜 형식이 달랐던 것', '날짜를 ISO 형식으로 통일했습니다.'], ['두 요청이 같은 행을 동시에 수정한 것', '행 잠금을 추가했습니다.']]
        : [[`${name} did not check for undefined`, 'I added a null check.'], ['the component unmounted before the response arrived', 'I added request cancellation.'], ['the type definition and the real response used different field names', 'I aligned the field names.'], ['the test data used a different date format', 'I switched all dates to ISO format.'], ['two requests updated the same row at the same time', 'I added a row lock.']],
    );
    return [[ko ? `${c} 쪽에서 이런 오류가 나요.\n\n\`\`\`\n${err}\n    at ${name} (${f}:${int(10, 300)}:${int(3, 40)})\n\`\`\`` : `I get this error in ${c}:\n\n\`\`\`\n${err}\n    at ${name} (${f}:${int(10, 300)}:${int(3, 40)})\n\`\`\``, ko ? `원인은 ${dc}입니다. ${df} ${para(lang, int(1, 2))}` : `The cause is that ${dc}. ${df} ${para(lang, int(1, 2))}`]];
  }
  if (r < 0.7) {
    const p50 = int(20, 120);
    const p95 = pickNot([90, 120, 180, 220, 260, 320, 350, 450, 520, 640, 800], v.p95 as number);
    const where = pick(ko ? ['DB 쿼리', 'JSON 직렬화', '외부 API 호출', '인증 미들웨어'] : ['the DB query', 'JSON serialization', 'the external API call', 'the auth middleware']);
    return [[ko ? `${c} API 성능 재 봤어요?` : `Did you measure the ${c} API?`, ko ? `로컬에서 ${int(2, 20) * 100}번 호출해 보니 ${c} API의 p50은 ${p50}ms, p95는 ${p95}ms였습니다. 대부분의 시간은 ${where}에서 씁니다. ${para(lang, int(1, 2))}` : `Calling it ${int(2, 20) * 100} times locally, the ${c} API had p50 ${p50} ms and p95 ${p95} ms. Most of the time is spent in ${where}. ${para(lang, int(1, 2))}`]];
  }
  if (r < 0.8) {
    const x = pickNot([2, 3, 4, 5, 6, 7, 8, 9], v.retryMax as number);
    const t = pick([3, 5, 8, 10, 15]);
    const m = pickNot([5, 10, 15, 20, 30, 45, 60, 90, 120], v.access as number);
    return [[ko ? `${c} 쪽 재시도랑 타임아웃은 어떻게 둘까요?` : `How should we set retries and timeouts for ${c}?`, ko ? `${c} 호출은 최대 ${x}회까지 재시도하고 타임아웃은 ${t}초로 두겠습니다. ${c} 화면의 세션은 ${m}분 동안 유지합니다. ${para(lang, int(1, 2))}` : `${c} calls will retry up to ${x} times with a ${t}-second timeout. The ${c} screen keeps its session for ${m} minutes. ${para(lang, int(1, 2))}`]];
  }
  if (r < 0.9) {
    const ui = pick(ko ? ['버튼', '필터', '정렬 옵션', '빈 상태 문구', '표 머리글', '날짜 표시'] : ['button', 'filter', 'sort option', 'empty-state text', 'table header', 'date display']);
    const f = file();
    return [[ko ? `${c} 화면의 ${ui} 좀 ${pick(['바꿔 주세요', '추가해 주세요', '더 눈에 띄게 해 주세요'])}.` : `Please ${pick(['change', 'add', 'make more visible'])} the ${ui} on the ${c} screen.`, ko ? `${c} 화면의 ${ui}를 수정했습니다. 변경한 파일은 ${f}입니다.` : `I updated the ${ui} on the ${c} screen. The change is in ${f}.`], [pick(ko ? ['좋아요, 그렇게 해 주세요.', '네, 진행해 주세요.', '확인했어요.', '고마워요.'] : ['Great, go ahead.', 'Yes, please continue.', 'Got it.', 'Thanks.']), para(lang, int(1, 2))]];
  }
  const libs = [pick(LIBS), pick(LIBS), pick(LIBS)];
  const pro = ko ? ['타입 추론이 좋음', '문서가 잘 되어 있음', '가벼움', '생태계가 큼', '설정이 단순함'] : ['good type inference', 'well documented', 'lightweight', 'large ecosystem', 'simple setup'];
  const con = ko ? ['번들이 조금 큼', '버전 변화가 잦음', '자료가 적음', '학습 비용이 있음', '플러그인이 부족함'] : ['slightly larger bundle', 'frequent breaking changes', 'fewer resources', 'learning curve', 'few plugins'];
  const table = `| ${ko ? '라이브러리' : 'Library'} | ${ko ? '장점' : 'Pros'} | ${ko ? '단점' : 'Cons'} |\n|---|---|---|\n${libs.map((l) => `| ${l} | ${pick(pro)} | ${pick(con)} |`).join('\n')}`;
  return [[ko ? `${c} 쪽에 쓸 라이브러리 비교해 줘요.` : `Can you compare libraries for ${c}?`, `${table}\n\n${ko ? `지금 단계에서는 ${libs[0]} 쪽이 무난해 보입니다.` : `${libs[0]} looks like a reasonable choice for now.`} ${para(lang, 1)}`]];
}

function designDoc(lang: Lang, v: (typeof V)[number]): string {
  const ko = lang === 'ko';
  const titles = ko
    ? ['개요', '결제 흐름', '상태 전이', '에러 코드', '로그와 추적', '권한', '데이터 보관', '인증과 토큰', '알림', '모니터링', '배포 절차', '테스트 계획', '성능 목표 점검', '보안 점검', '운영 절차', '남은 질문']
    : ['Overview', 'Payment flow', 'State transitions', 'Error codes', 'Logging and tracing', 'Permissions', 'Data retention', 'Authentication and tokens', 'Notifications', 'Monitoring', 'Deployment', 'Test plan', 'Performance check', 'Security review', 'Operations', 'Open questions'];
  const parts: string[] = [ko ? '결제 모듈 설계 문서 초안을 정리했습니다.' : 'Here is the first draft of the payment module design document.'];
  titles.forEach((t, i) => {
    let body = `${para(lang, int(3, 6))}\n\n${bullets(lang, int(3, 6))}`;
    if (i === 7) {
      const admin = pickNot([5, 10, 15, 20, 30, 45, 60, 90, 120], v.access as number);
      body = ko
        ? `${para(lang, int(2, 4))} 액세스 토큰 만료는 ${v.access}분, 리프레시 토큰은 ${v.refresh}일로 합니다. 토큰은 HttpOnly 쿠키에만 저장합니다. 관리자 화면 세션은 ${admin}분 동안 유지합니다. ${para(lang, int(2, 3))}\n\n${bullets(lang, int(2, 4))}`
        : `${para(lang, int(2, 4))} Access tokens expire after ${v.access} minutes and refresh tokens after ${v.refresh} days. Tokens are stored only in HttpOnly cookies. Admin console sessions last ${admin} minutes. ${para(lang, int(2, 3))}\n\n${bullets(lang, int(2, 4))}`;
    }
    parts.push(`## ${i + 1}. ${t}\n\n${body}`);
  });
  return parts.join('\n\n');
}

// ---------------------------------------------------------------- planted episodes

interface Planted {
  at: number; // position as a fraction of the conversation
  pairs: Pair[];
}

function planted(lang: Lang, v: (typeof V)[number]): Planted[] {
  const ko = lang === 'ko';
  const p = (n: number) => para(lang, n);
  const c = () => pick(COMPS[lang]);
  return [
    { at: 0, pairs: [[ko ? `${v.goal.ko} 만들려고 해요. 프론트엔드는 React, 백엔드는 Node.js로 생각하고 있어요. 처음 버전은 작게 시작하고 싶어요.` : `I want to build ${v.goal.en}. I am thinking React for the front end and Node.js for the back end. I would like to start small.`, ko ? `좋습니다. 먼저 데이터 모델과 결제 흐름부터 잡아 보겠습니다. ${p(3)}` : `Sounds good. Let's start with the data model and the payment flow. ${p(3)}`]] },
    { at: 0.02, pairs: [[ko ? `${pick(ASK.ko)(c())} 그리고 미리 말해 두는데, 이 프로젝트에서는 ${v.lib}를 절대 쓰지 마세요. 번들이 커져서요.` : `${pick(ASK.en)(c())} Also, to be clear up front: never use ${v.lib} in this project. It bloats the bundle.`, ko ? `알겠습니다. ${v.lib}는 쓰지 않겠습니다. ${p(3)}` : `Understood, I will not use ${v.lib}. ${p(3)}`]] },
    { at: 0.03, pairs: [[ko ? `DB는 일단 ${v.dbOld}로 하자.` : `Let's go with ${v.dbOld} for the database for now.`, ko ? `${v.dbOld} 기준으로 컬렉션과 스키마를 잡겠습니다. ${p(3)}` : `I will set up the schema on ${v.dbOld}. ${p(3)}`]] },
    { at: 0.05, pairs: [[ko ? `커밋 메시지는 ${v.commit.ko}으로 맞춰 주세요.` : `Please write commit messages in ${v.commit.en}.`, ko ? `네, 앞으로 커밋 메시지는 그 형식으로 쓰겠습니다. ${p(2)}` : `Will do, every commit message will follow that format. ${p(2)}`]] },
    { at: 0.1, pairs: [[ko ? `${pick(ASK.ko)(c())} 아, 그리고 API p95 응답 시간은 항상 ${v.p95}ms 이하로 유지해야 해요.` : `${pick(ASK.en)(c())} Oh, and the API p95 latency must always stay at or below ${v.p95} ms.`, p(4)]] },
    { at: 0.3, pairs: [[ko ? '결제 승인이 가끔 실패하는데 어떻게 처리하죠?' : 'Payment authorization fails now and then. How do we handle it?', ko ? `${p(2)}\n\n결제 승인 요청이 실패하면 작업을 ${v.queue}에 넣고 ${v.gap}초 뒤에 다시 시도하도록 바꿨습니다. 이 방식은 같은 결제가 두 번 승인될 수 있어서, 클라이언트가 ${v.header} 헤더로 고유 키를 보내야 합니다. ${p(2)}` : `${p(2)}\n\nWhen an authorization request fails, the job is now pushed to ${v.queue} and retried after ${v.gap} seconds. This approach can authorize the same payment twice, so the client has to send a unique key in the ${v.header} header. ${p(2)}`]] },
    { at: 0.35, pairs: [[ko ? '재시도 쪽 코드 정리해 주세요.' : 'Please clean up the retry code.', ko ? `${p(1)} 재시도 정책은 ${v.path} 파일에 모아 두었습니다.\n\n${code(v.path, 'scheduleRetry')}\n\n${p(2)}` : `${p(1)} The retry policy now lives in ${v.path}.\n\n${code(v.path, 'scheduleRetry')}\n\n${p(2)}`]] },
    { at: 0.4, pairs: [[ko ? '스테이징 배포가 실패했어요. 컨테이너가 계속 재시작돼요.' : 'The staging deploy failed. The container keeps restarting.', ko ? `로그를 보니 원인은 ${v.cause.ko} 때문입니다. ${v.cause.fixKo} 다시 배포하니 정상적으로 올라갔습니다. ${p(2)}` : `From the logs, the cause is that ${v.cause.en}. ${v.cause.fixEn} After redeploying it came up normally. ${p(2)}`]] },
    { at: 0.45, pairs: [[ko ? 'DB 마이그레이션은 어떻게 돌리면 돼요?' : 'How do I run the DB migration?', ko ? `${p(1)}\n\n\`\`\`bash\n${v.cmd}\n\`\`\`\n\n마이그레이션은 위 명령으로 실행하면 됩니다. ${p(2)}` : `${p(1)}\n\n\`\`\`bash\n${v.cmd}\n\`\`\`\n\nRun the migration with the command above. ${p(2)}`]] },
    { at: 0.5, pairs: [[ko ? '결제 재시도 횟수랑 간격은 어떻게 할까요?' : 'What retry count and interval should payments use?', ko ? `${p(1)} 결제 재시도는 최대 ${v.retryMax}회, 간격은 ${v.gap}초로 정했습니다. ${p(2)}` : `${p(1)} Payment retries are capped at ${v.retryMax} attempts, ${v.gap} seconds apart. ${p(2)}`]] },
    { at: 0.55, pairs: [[pick(ASK[lang])(c()), ko ? `${p(2)} 조회 속도를 높이려면 ${v.rejected.ko} 도입하는 것도 방법입니다.` : `${p(2)} To speed up reads we could introduce ${v.rejected.en}.`], [ko ? `아니요, ${v.rejected.ko} 쓰지 않기로 해요. 운영할 사람이 없어요.` : `No, we will not use ${v.rejected.en}. Nobody can operate it.`, ko ? `알겠습니다. 지금 구조에서 쿼리를 다듬는 쪽으로 가겠습니다. ${p(2)}` : `Understood. I will tune the queries in the current setup instead. ${p(2)}`]] },
    { at: 0.6, pairs: [[ko ? `${v.dbOld} 말고 ${v.dbNew}로 바꾸자. ${v.reason.ko}.` : `Let's switch from ${v.dbOld} to ${v.dbNew} instead. ${v.reason.en.charAt(0).toUpperCase() + v.reason.en.slice(1)}.`, ko ? `${v.dbNew}로 전환하겠습니다. 스키마를 다시 정의하고 데이터 이전 스크립트를 만들었습니다. ${p(2)}` : `Switching to ${v.dbNew}. I redefined the schema and wrote a data migration script. ${p(2)}`]] },
    { at: 0.75, pairs: [[pick(ASK[lang])(c()), ko ? `${p(2)} 그리고 ${v.done.koObj} 구현했고 테스트도 통과했습니다. ${p(1)}` : `${p(2)} Also, ${v.done.en} is implemented and its tests pass. ${p(1)}`]] },
    { at: 0.85, pairs: [[ko ? '남은 결제 기능은 어떻게 되고 있어요?' : 'How are the remaining payment features going?', ko ? `${p(1)} ${v.pending.ko} 기능은 아직 구현하지 못했습니다. ${v.pending.blockerKo} 때문입니다. ${p(2)}` : `${p(1)} ${v.pending.en.charAt(0).toUpperCase() + v.pending.en.slice(1)} is not implemented yet, because ${v.pending.blockerEn}. ${p(2)}`]] },
    { at: 0.93, pairs: [[ko ? '지금까지 내용을 바탕으로 결제 모듈 설계 문서를 써 줄래요?' : 'Can you write the payment module design document based on everything so far?', designDoc(lang, v)]] },
    { at: 1, pairs: [[ko ? `좋아요. 이제 ${v.next.ko} 기능을 만들어 주세요.` : `Great. Now please build ${v.next.en}.`, ko ? `네, ${v.next.ko} 기능부터 시작하겠습니다.` : `Okay, I will start on ${v.next.en}.`]] },
  ];
}

export function questions(lang: Lang, ci: number): Question[] {
  const v = V[ci];
  const ko = lang === 'ko';
  const num = (n: number, unit: string) => `(^|\\D)${n}\\s*(${unit})`;
  const qs: Question[] = [
    { id: 'goal', kind: '초반 목표', q: ko ? '이 대화에서 만들고 있는 서비스는 무엇인가요?' : 'What service is being built in this conversation?', accept: v.goal.re },
    { id: 'ban', kind: '초반 금지', q: ko ? '이 프로젝트에서 사용이 금지된 라이브러리는 무엇인가요?' : 'Which library is forbidden in this project?', accept: v.libRe },
    { id: 'commit', kind: '초반 규칙', q: ko ? '커밋 메시지는 어떤 형식으로 써야 하나요?' : 'What format must commit messages follow?', accept: v.commit.re },
    { id: 'p95', kind: '초반 제약', q: ko ? 'API p95 응답 시간은 몇 ms 이하로 유지해야 하나요?' : 'At or below how many ms must the API p95 latency stay?', accept: num(v.p95, 'ms|밀리|$|\\D') },
    { id: 'db', kind: '바뀐 결정', q: ko ? '현재 사용하기로 한 데이터베이스는 무엇인가요?' : 'Which database is the project using now?', accept: esc(v.dbNew) },
    { id: 'dbwhy', kind: '결정 이유', q: ko ? '데이터베이스를 바꾼 이유는 무엇인가요?' : 'Why was the database changed?', accept: v.reason.re },
    { id: 'queue', kind: '참조(앞 문장)', q: ko ? `${v.header} 헤더가 필요해진 건 결제 실패를 어떤 방식으로 처리하기 때문인가요? (어디에 넣는지 포함)` : `Which way of handling failed payments made the ${v.header} header necessary? (include where the job goes)`, accept: esc(v.queue) },
    { id: 'header', kind: '중반 세부', q: ko ? '결제 요청의 고유 키는 어떤 헤더로 보내야 하나요?' : 'In which header must the unique payment key be sent?', accept: esc(v.header) + '(?![-\\w])' },
    { id: 'path', kind: '중반 경로', q: ko ? '결제 재시도 정책 코드는 어느 파일에 있나요?' : 'Which file contains the payment retry policy?', accept: esc(v.path) },
    { id: 'deploy', kind: '실패 원인', q: ko ? '스테이징 배포가 실패했던 원인은 무엇인가요?' : 'What caused the staging deploy to fail?', accept: v.cause.re },
    { id: 'cmd', kind: '중반 명령', q: ko ? 'DB 마이그레이션 실행 명령은 무엇인가요?' : 'What is the command to run the DB migration?', accept: v.cmdRe },
    { id: 'retry', kind: '중반 숫자', q: ko ? '결제 재시도 최대 횟수는 몇 회인가요?' : 'What is the maximum number of payment retries?', accept: num(v.retryMax, '회|번|times|attempts|retries|$|\\D') },
    { id: 'rejected', kind: '거절된 제안', q: ko ? `${v.rejected.q.ko} 도입하기로 했나요?` : `Was it decided to introduce ${v.rejected.q.en}?`, accept: '(아니|않|안\\s|안 쓰|no\\b|not\\b|reject|declin|against)', reject: '^\\s*((예|네)(?![가-힣])|yes\\b)(?![^.]{0,40}(reject|않|안 |not|no\\b))' },
    { id: 'done', kind: '완료 작업', q: ko ? `${v.done.koTopic} 완료되었나요?` : `Is ${v.done.en} done?`, accept: '^\\s*(예|네)(?![가-힣])|(완료|됐|되었|했|통과|구현|yes|done|complete|implemented|finished|pass)', reject: '(아직|않았|미완|안 됐|not yet|not complete|isn.t|hasn.t|pending|^\\s*no\\b)' },
    { id: 'pending', kind: '미완료 작업', q: ko ? '아직 구현하지 못한 결제 기능은 무엇인가요?' : 'Which payment feature is not implemented yet?', accept: v.pending.re },
    { id: 'token', kind: '긴 답변 중간', q: ko ? '액세스 토큰 만료 시간은 얼마인가요?' : 'When do access tokens expire?', accept: num(v.access, '분|min') },
    { id: 'next', kind: '다음 작업', q: ko ? '지금 바로 이어서 해야 할 작업은 무엇인가요?' : 'What is the task to work on right now?', accept: v.next.re },
    { id: 'un1', kind: '답 없음', q: ko ? '모바일 앱 출시 예정일은 언제인가요?' : 'When is the mobile app scheduled to launch?', accept: '', unanswerable: true },
    { id: 'un2', kind: '답 없음', q: ko ? '운영 서버는 어느 클라우드 리전에 두기로 했나요?' : 'Which cloud region was chosen for the production servers?', accept: '', unanswerable: true },
  ];
  return qs;
}

/** Regex (source) per question that is true when the document contains the planted answer. */
export function presence(ci: number): Record<string, string> {
  const v = V[ci];
  return {
    goal: v.goal.re,
    ban: `${esc(v.lib)}(를 절대| in this project)`,
    commit: `커밋 메시지는 ${esc(v.commit.ko)}|commit messages in ${esc(v.commit.en)}`,
    p95: `${v.p95}ms 이하|at or below ${v.p95} ms`,
    db: `${esc(v.dbNew)}로 (바꾸자|전환)|to ${esc(v.dbNew)} instead|Switching to ${esc(v.dbNew)}`,
    dbwhy: `${esc(v.reason.ko)}|${esc(v.reason.en.charAt(0).toUpperCase() + v.reason.en.slice(1))}`,
    queue: `${esc(v.queue)}에 넣고|pushed to ${esc(v.queue)}`,
    header: `${esc(v.header)} 헤더|${esc(v.header)} header`,
    path: `재시도 정책은 ${esc(v.path)}|retry policy now lives in ${esc(v.path)}`,
    deploy: `${esc(v.cause.ko.slice(0, 18))}|${esc(v.cause.en.slice(0, 24))}`,
    cmd: esc(v.cmd),
    retry: `최대 ${v.retryMax}회, 간격|capped at ${v.retryMax} attempts`,
    rejected: `아니요, ${esc(v.rejected.ko)} 쓰지 않기로|No, we will not use ${esc(v.rejected.en)}`,
    done: `${esc(v.done.koObj)} 구현했고|${esc(v.done.en)} is implemented`,
    pending: `${esc(v.pending.ko)} 기능은 아직|${esc(v.pending.en.charAt(0).toUpperCase() + v.pending.en.slice(1))} is not implemented`,
    token: `만료는 ${v.access}분|expire after ${v.access} minutes`,
    next: `이제 ${esc(v.next.ko)} 기능|please build ${esc(v.next.en)}`,
  };
}

/**
 * The same planted facts in the shape real ChatGPT sessions often have (1st study: median 10
 * messages, single messages of 10k–100k+ tokens): a few turns whose answers are long documents.
 * Each planted exchange is merged into one of `turns` user/assistant pairs, and its assistant
 * sentences land at a random place inside a long answer of filler paragraphs, lists and code.
 */
export function buildLongConversation(lang: Lang, ci: number, targetTokens: number, turns = 6): Conversation {
  seed = 5000 + ci * 31 + (lang === 'ko' ? 0 : 11);
  const v = V[ci];
  const plant = planted(lang, v);
  const last = plant[plant.length - 1];
  const body = plant.slice(0, -1);
  const groups: Pair[][] = Array.from({ length: turns }, () => []);
  for (const pl of body) groups[Math.min(turns - 1, Math.floor(pl.at * turns))].push(...pl.pairs);
  const perAnswer = targetTokens / turns;
  const msgs: ExportMessage[] = [];
  for (const g of groups) {
    const blocks: string[] = [];
    let tokens = 0;
    while (tokens < perAnswer) {
      const r = rand();
      const b = r < 0.55 ? para(lang, int(3, 7)) : r < 0.8 ? bullets(lang, int(3, 6)) : code(file(), fn());
      blocks.push(b);
      tokens += estimateTokens(b);
    }
    // Planted answers go to random places in the long answer (in their original order).
    const spots = g.map(() => Math.floor(rand() * (blocks.length + 1))).sort((a, b) => a - b);
    g.forEach(([, a], k) => blocks.splice(spots[k] + k, 0, a));
    msgs.push(message(msgs.length + 1, 'user', g.map(([u]) => u).join('\n\n') || pick(ASK[lang])(pick(COMPS[lang]))));
    msgs.push(message(msgs.length + 1, 'assistant', blocks.join('\n\n')));
  }
  for (const [u, a] of last.pairs) {
    msgs.push(message(msgs.length + 1, 'user', u));
    msgs.push(message(msgs.length + 1, 'assistant', a));
  }
  return {
    title: lang === 'ko' ? `결제 프로젝트 ${ci + 1} (긴 답변)` : `Payments project ${ci + 1} (long answers)`,
    pageId: `qa-long-${lang}-${ci}`,
    fromUrl: `https://chatgpt.com/c/qa-long-${lang}-${ci}`,
    site: 'chatgpt',
    siteName: 'ChatGPT',
    pageType: 'fullPage',
    messages: msgs,
    extraction: { method: 'api', sourceNodeCount: msgs.length, missingNodeIds: [], skipped: [], warnings: [], fetchedAt: 0 },
  };
}

function message(id: number, role: 'user' | 'assistant', content: string): ExportMessage {
  return { id: `m${id}`, ids: [`m${id}`], role, created_at: Date.UTC(2026, 8, 1) + id * 90_000, contents: [{ type: role === 'user' ? 'text' : 'markdown', content }] };
}

export function buildConversation(lang: Lang, ci: number, targetTokens: number): Conversation {
  seed = 1000 + ci * 17 + (lang === 'ko' ? 0 : 7);
  const v = V[ci];
  const plant = planted(lang, v);
  const plantTokens = plant.reduce((s, x) => s + x.pairs.reduce((a, [u, b]) => a + estimateTokens(u) + estimateTokens(b), 0), 0);
  const filler: Pair[][] = [];
  let tokens = plantTokens;
  while (tokens < targetTokens) {
    const ep = fillerEpisode(lang, v);
    filler.push(ep);
    tokens += ep.reduce((a, [u, b]) => a + estimateTokens(u) + estimateTokens(b), 0);
  }
  const slots: Pair[][] = [];
  let fi = 0;
  for (const pl of plant) {
    const until = Math.round(pl.at * filler.length);
    while (fi < until) slots.push(filler[fi++]);
    slots.push(pl.pairs);
  }
  while (fi < filler.length) slots.splice(slots.length - 1, 0, filler[fi++]);
  const msgs: ExportMessage[] = [];
  for (const ep of slots)
    for (const [u, a] of ep) {
      msgs.push(message(msgs.length + 1, 'user', u));
      msgs.push(message(msgs.length + 1, 'assistant', a));
    }
  return {
    title: lang === 'ko' ? `결제 프로젝트 ${ci + 1}` : `Payments project ${ci + 1}`,
    pageId: `qa-${lang}-${ci}`,
    fromUrl: `https://chatgpt.com/c/qa-${lang}-${ci}`,
    site: 'chatgpt',
    siteName: 'ChatGPT',
    pageType: 'fullPage',
    messages: msgs,
    extraction: { method: 'api', sourceNodeCount: msgs.length, missingNodeIds: [], skipped: [], warnings: [], fetchedAt: 0 },
  };
}
