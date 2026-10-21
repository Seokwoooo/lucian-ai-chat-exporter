// Saved copy used when the site limits or refuses the conversation request (v1.3.10).

import { describe, expect, it } from 'vitest';
import { checkText, jobErrorText, waitStatus } from '../../src/export/report';
import { buildVerification } from '../../src/export/verify';
import type { ConversationRecord } from '../../src/shared/db';
import { savedCopyFor } from '../../src/shared/saved-copy';
import type { Conversation, JobState } from '../../src/shared/types';

const MIN = 60_000;

function conv(method: 'api' | 'dom', fetchedAt = Date.now() - 3 * MIN): Conversation {
  return {
    title: 't',
    pageId: 'x',
    fromUrl: 'https://chatgpt.com/c/x',
    site: 'chatgpt',
    siteName: 'ChatGPT',
    pageType: 'fullPage',
    messages: [
      { id: 'm1', role: 'user', contents: [{ type: 'text', content: '질문' }] },
      { id: 'm2', role: 'assistant', contents: [{ type: 'markdown', content: '답변' }] },
    ],
    extraction: { method, sourceNodeCount: 2, missingNodeIds: [], skipped: [], warnings: [], fetchedAt },
  };
}
const record = (c: Conversation): ConversationRecord => ({ key: 'chatgpt:x', savedAt: c.extraction.fetchedAt, site: 'chatgpt', conversation: c });

describe('savedCopyFor', () => {
  it('stands in for a limited, refused or failed request, keeping when it was fetched', () => {
    for (const code of ['RATE_LIMIT', 'AUTH', 'NETWORK']) {
      const saved = conv('api');
      const out = savedCopyFor(code, record(saved), code === 'RATE_LIMIT' ? 35 : undefined);
      expect(out?.messages).toHaveLength(2);
      expect(out?.extraction.savedCopy).toEqual({ reason: code, retryAfterSec: code === 'RATE_LIMIT' ? 35 : undefined });
      expect(out?.extraction.fetchedAt).toBe(saved.extraction.fetchedAt);
      expect(saved.extraction.savedCopy).toBeUndefined(); // the record itself is not changed
    }
  });

  it('is not used for other failures, for a copy read from the page, or without a copy', () => {
    expect(savedCopyFor('PARSE', record(conv('api')))).toBeUndefined();
    expect(savedCopyFor('NOT_FOUND', record(conv('api')))).toBeUndefined();
    expect(savedCopyFor('RATE_LIMIT', record(conv('dom')))).toBeUndefined();
    expect(savedCopyFor('RATE_LIMIT', record({ ...conv('api'), messages: [] }))).toBeUndefined();
    expect(savedCopyFor('RATE_LIMIT', undefined)).toBeUndefined();
  });
});

describe('verification of a document built from a saved copy', () => {
  it('warns, naming why and how old the copy is', () => {
    const c = savedCopyFor('RATE_LIMIT', record(conv('api')), 35)!;
    const check = buildVerification(c, 'md').checks.find((x) => x.code === 'source.saved');
    expect(check?.status).toBe('warn');
    expect(checkText('ko', check!)).toBe('ChatGPT 서버가 요청을 잠시 막아 3분 전에 받아 둔 사본으로 만들었습니다. 그 뒤에 나눈 대화는 빠졌을 수 있습니다');
    expect(checkText('en', check!)).toBe('ChatGPT was limiting requests, so this was built from the copy saved 3 minutes ago. Anything said since may be missing');
    expect(buildVerification(c, 'md').level).not.toBe('ok');
  });

  it('says "just now", hours and days, and the reason for login and network failures', () => {
    const at = (code: string, ago: number) => checkText('ko', buildVerification(savedCopyFor(code, record(conv('api', Date.now() - ago)))!, 'md').checks.find((x) => x.code === 'source.saved')!);
    expect(at('RATE_LIMIT', 10_000)).toMatch(/^ChatGPT 서버가 요청을 잠시 막아 방금 받아 둔 사본/);
    expect(at('AUTH', 5 * 60 * MIN)).toMatch(/^ChatGPT 로그인을 확인하지 못해 5시간 전에 받아 둔 사본/);
    expect(at('NETWORK', 3 * 24 * 60 * MIN)).toMatch(/^ChatGPT 서버에 연결하지 못해 3일 전에 받아 둔 사본/);
    expect(checkText('en', buildVerification(savedCopyFor('NETWORK', record(conv('api', Date.now() - 61 * MIN)))!, 'md').checks.find((x) => x.code === 'source.saved')!)).toBe(
      'ChatGPT could not be reached, so this was built from the copy saved 1 hour ago. Anything said since may be missing',
    );
  });

  it('a fresh API result has no such check', () => {
    expect(buildVerification(conv('api'), 'md').checks.some((x) => x.code === 'source.saved')).toBe(false);
  });
});

describe('popup / page panel texts', () => {
  const job = (progress: JobState['progress']): Pick<JobState, 'site' | 'progress'> => ({ site: 'chatgpt', progress });

  it('counts down while a 429 is waited out', () => {
    expect(waitStatus('ko', job({ label: 'wait', done: 5, total: 35 }))).toEqual({ title: 'ChatGPT 서버가 요청을 잠시 막았습니다', sub: '30초 후 다시 받아 옵니다' });
    expect(waitStatus('ko', job({ label: 'wait', done: 35, total: 35 }))?.sub).toBe('다시 받아 오는 중…');
    expect(waitStatus('en', job({ label: 'wait', done: 0, total: 2 }))).toEqual({ title: 'ChatGPT is limiting requests for a moment', sub: 'Retrying in 2 s' });
    expect(waitStatus('ko', job({ label: 'messages', done: 3 }))).toBeNull();
  });

  it('names the wait the site asked for when it still refused', () => {
    expect(jobErrorText('ko', { site: 'chatgpt', error: { code: 'RATE_LIMIT', retryAfterSec: 35 } })).toBe('ChatGPT 서버가 요청을 잠시 막았습니다. 35초 뒤에 다시 시도해 주세요.');
    expect(jobErrorText('ko', { site: 'chatgpt', error: { code: 'RATE_LIMIT' } })).toBe('서비스가 요청을 잠시 제한했습니다. 잠시 후 다시 시도해 주세요.');
    expect(jobErrorText('en', { site: 'gemini', error: { code: 'NO_SUCH_CODE' } })).toBe('An unknown error occurred.');
  });
});
