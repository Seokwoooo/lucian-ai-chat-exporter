// Runtime message contracts between popup, service worker, content script, offscreen document
// and print page.

import type { BranchMessages, Conversation, ExportFormat, ExportMessage, JobKind, JobState, JobTimings, Verification, HandoffStats } from './types';
import type { Locale } from './i18n';

export const COLLECT_PORT = 'lucian-collect';

export interface AssetRequest {
  key: string;
  kind: 'image' | 'attachment';
  url?: string;
  fileId?: string;
}

/** Messages the service worker sends to the content script over the collect port. */
export type ToContent = { type: 'collect' } | { type: 'assets'; items: AssetRequest[] };

/** Messages the content script streams back over the collect port. */
export type FromContent =
  | { type: 'progress'; label: 'messages' | 'pages' | 'assets'; done: number; total?: number }
  | { type: 'meta'; conversation: Omit<Conversation, 'messages' | 'otherBranchMessages'> }
  | { type: 'messages'; messages: ExportMessage[] }
  | { type: 'branches'; branches: BranchMessages[] }
  | { type: 'done' }
  | { type: 'asset'; key: string; ok: boolean; mime?: string; base64?: string; size?: number; error?: string }
  | { type: 'assets-done' }
  | { type: 'error'; code: string; message?: string };

export type PopupRequest =
  | { type: 'start-job'; kind: JobKind; format?: ExportFormat; tabId: number; locale: Locale }
  | { type: 'get-job'; tabId: number }
  | { type: 'show-download'; downloadId: number };

export interface AssetStatus {
  key: string;
  kind: 'image' | 'attachment';
  ok: boolean;
  mime?: string;
  size?: number;
  error?: string;
}

export interface BuildRequest {
  target: 'offscreen';
  type: 'build';
  jobId: string;
  conversationKey: string;
  kind: JobKind;
  format?: ExportFormat;
  locale: Locale;
  assets: AssetStatus[];
}

export interface BuildResponse {
  ok: boolean;
  blobUrl?: string;
  filename?: string;
  mime?: string;
  bytes?: number;
  verification?: Verification;
  handoffStats?: HandoffStats;
  timings?: JobTimings;
  error?: string;
}

export interface OffscreenProgress {
  type: 'offscreen-progress';
  jobId: string;
  label: string;
}

export interface PrintReport {
  type: 'print-report';
  jobId: string;
  verification: Verification;
  renderMs: number;
}

export interface JobStateMessage {
  type: 'job-state';
  job: JobState;
}

export const jobStorageKey = (tabId: number) => `job:${tabId}`;
