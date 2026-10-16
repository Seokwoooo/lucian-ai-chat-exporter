// Synthetic conversation covering every content type the exporters must preserve.
// All text is invented for tests; no real user data.

import { deflateSync, crc32 } from 'node:zlib';
import type { Conversation } from '../../src/shared/types';
import { describeImage, type ImageStore } from '../../src/export/images';

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** Builds a valid RGB PNG of the given size filled with one colour. */
export function makePng(width: number, height: number, rgb: [number, number, number] = [80, 90, 220]): Uint8Array {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

export const IMG_A = 'https://files.example-cdn.test/image-a.png';
export const IMG_B = 'https://files.example-cdn.test/image-b.png';
export const IMG_MISSING = 'https://files.example-cdn.test/expired.png';

export function sampleImages(): ImageStore {
  const store: ImageStore = new Map();
  store.set(IMG_A, describeImage(makePng(320, 180)));
  store.set(IMG_B, describeImage(makePng(1600, 900, [30, 160, 90])));
  return store;
}

const CODE_TS = `export function fib(n: number): number {
\tif (n < 2) return n; // 탭 들여쓰기
    return fib(n - 1) + fib(n - 2); // 4-space indent
}
`;

export function sampleConversation(): Conversation {
  const t0 = Date.UTC(2026, 9, 16, 5, 0, 0);
  return {
    title: '한국어/English 혼합 테스트 대화 — 코드·표·수식',
    pageId: '11111111-2222-4333-8444-555555555555',
    fromUrl: 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555',
    site: 'chatgpt',
    siteName: 'ChatGPT',
    createAt: t0,
    lastUpdateAt: t0 + 600_000,
    pageType: 'fullPage',
    model: 'gpt-test',
    messages: [
      {
        id: 'u1',
        ids: ['u1'],
        role: 'user',
        created_at: t0,
        contents: [
          { type: 'text', content: 'TypeScript로 피보나치 함수를 만들어 주세요. <div>태그</div>는 그대로 보여야 합니다.\n둘째 줄입니다.' },
          { type: 'image', imageUrl: IMG_A, linkType: 'private', alt: 'screenshot' },
          { type: 'attachment', attachment: { name: 'requirements.txt', mime_type: 'text/plain', size: 2048, extractedText: 'numpy==2.0\npandas>=2.2' } },
        ],
      },
      {
        id: 'a1',
        ids: ['a1', 'a1-tool'],
        role: 'assistant',
        model: 'gpt-test',
        created_at: t0 + 60_000,
        contents: [
          { type: 'thinking', content: '사용자는 재귀 구현을 원한다.' },
          {
            type: 'markdown',
            content: [
              '## 구현',
              '',
              '아래는 **재귀** 구현입니다. *기울임*, ~~취소선~~, `inline code`, [MDN 링크](https://developer.mozilla.org/).',
              '',
              '```ts',
              CODE_TS.trimEnd(),
              '```',
              '',
              '### 복잡도 표',
              '',
              '| 방식 | 시간 복잡도 | 비고 |',
              '|:---|:---:|---:|',
              '| 재귀 | $O(2^n)$ | 느림 |',
              '| 메모이제이션 | $O(n)$ | **권장** |',
              '| 행렬 거듭제곱 | $O(\\log n)$ | 고급 |',
              '',
              '황금비는 $\\varphi = \\frac{1+\\sqrt{5}}{2}$ 이고, 일반항은 다음과 같습니다.',
              '',
              '$$',
              'F_n = \\frac{\\varphi^n - (1-\\varphi)^n}{\\sqrt{5}}',
              '$$',
              '',
              'ChatGPT 스타일 수식: \\(a^2 + b^2 = c^2\\) 그리고',
              '',
              '\\[',
              '\\int_0^1 x^2\\,dx = \\frac{1}{3}',
              '\\]',
              '',
              '가격 표기 $5 and $10 은 수식이 아닙니다.',
              '',
              '1. 첫째 항목',
              '2. 둘째 항목',
              '   - 중첩 항목 A',
              '   - 중첩 항목 B',
              '3. 셋째 항목',
              '',
              '- [x] 완료된 작업',
              '- [ ] 남은 작업',
              '',
              '> 인용문입니다. Quote with **bold**.',
              '',
              '---',
              '',
              `인라인 이미지: ![chart](${IMG_B})`,
              '',
              `만료된 이미지: ![old](${IMG_MISSING})`,
            ].join('\n'),
          },
          { type: 'code', language: 'python', title: 'Code Interpreter', content: 'import math\nprint(math.pi)\n' },
          { type: 'tool', title: 'Output', content: '3.141592653589793' },
          { type: 'sources', sources: [{ url: 'https://en.wikipedia.org/wiki/Fibonacci_sequence', title: 'Fibonacci sequence - Wikipedia' }] },
        ],
      },
      {
        id: 'u2',
        ids: ['u2'],
        role: 'user',
        created_at: t0 + 120_000,
        contents: [{ type: 'text', content: '日本語のテキストも保存できますか？ 中文也可以吗？' }],
      },
      {
        id: 'a2',
        ids: ['a2'],
        role: 'assistant',
        model: 'gpt-test',
        created_at: t0 + 180_000,
        contents: [
          { type: 'markdown', content: 'はい、保存できます。中文也没问题。\n\n```\nplain fenced block with ``` inside? no\n```' },
          { type: 'artifact', title: 'README.md', language: 'markdown', content: '# Title\n\nSome text with ```code``` fence.\n' },
        ],
      },
    ],
    otherBranchMessages: [{ leafId: 'a1-alt', pathIds: ['u1', 'a1-alt'], create_time: t0 + 70_000, messages: [{ id: 'a1-alt', role: 'assistant', contents: [{ type: 'markdown', content: '다른 답변' }] }] }],
    extraction: { method: 'api', sourceNodeCount: 5, missingNodeIds: [], skipped: [{ id: 'sys', reason: 'system' }], warnings: [], fetchedAt: t0 + 600_000 },
  };
}
