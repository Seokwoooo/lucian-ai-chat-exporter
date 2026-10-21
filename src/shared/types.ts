// Common conversation data model shared by every adapter, exporter and the handoff engine.
// Platform specific payloads are normalized into this shape (tech doc §4.3) so that exporters
// never need to know which AI service produced a conversation.

export type SiteId = 'chatgpt' | 'claude' | 'gemini' | 'grok';

export type ContentType =
  | 'text'
  | 'markdown'
  | 'thinking'
  | 'code'
  | 'image'
  | 'image_group'
  | 'attachment'
  | 'sources'
  | 'tool'
  | 'artifact'
  | 'html_widget';

export interface SourceRef {
  title?: string;
  url: string;
  snippet?: string;
}

export interface ImageRef {
  imageUrl?: string;
  thumbnailUrl?: string;
  /** 'private' when the URL needs the site's login session to be readable. */
  linkType?: 'public' | 'private' | 'pointer';
  fileId?: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface AttachmentRef {
  url?: string;
  name?: string;
  mime_type?: string;
  size?: number;
  /** Text the service extracted from the uploaded file, when the API exposes it. */
  extractedText?: string;
  /** Service-side file identifier used to resolve a download URL later. */
  fileId?: string;
}

export interface ExportContent {
  type: ContentType;
  /** Markdown / plain text payload for text, markdown, thinking, code, tool, artifact, html_widget. */
  content?: string;
  language?: string;
  title?: string;
  imageUrl?: string;
  /** 'pointer' means imageUrl is a service file reference that still needs resolving. */
  linkType?: 'public' | 'private' | 'pointer';
  /** Service-side file id (ChatGPT asset pointer, Claude file uuid...). */
  fileId?: string;
  alt?: string;
  width?: number;
  height?: number;
  imageGroup?: { images: ImageRef[] };
  attachment?: AttachmentRef;
  sources?: SourceRef[];
  /** Search results the answer did not cite. Kept in JSON/ZIP only; documents list cited sources. */
  moreSources?: SourceRef[];
}

export type Role = 'user' | 'assistant';

export interface ExportMessage {
  id: string;
  /** Raw node ids merged into this message (e.g. assistant + tool nodes of one ChatGPT turn). */
  ids?: string[];
  role: Role;
  model?: string;
  displayModel?: string;
  /** epoch milliseconds */
  created_at?: number;
  updated_at?: number;
  /** The service stored this message truncated (e.g. a response cut off mid-generation). */
  truncated?: boolean;
  contents: ExportContent[];
}

export interface BranchMessages {
  leafId?: string;
  pathIds?: string[];
  create_time?: number | null;
  messages: ExportMessage[];
}

export interface SkippedNode {
  id?: string;
  reason: string;
}

export interface ExtractionInfo {
  method: 'api' | 'dom';
  /** Number of visible message nodes on the selected path in the raw source data. */
  sourceNodeCount: number;
  /** Raw visible node ids that did not end up in any exported message (should be empty). */
  missingNodeIds: string[];
  /**
   * One "role:shape" per missing node, e.g. "assistant:multimodal_text(audio_transcription)", so the
   * result details say what could not be converted (v1.3.8). Roles: user | assistant | unknown.
   */
  missingKinds?: string[];
  /** Nodes intentionally excluded (system prompts, hidden tool plumbing, unfinished nodes...). */
  skipped: SkippedNode[];
  /** Number of user turns rendered on screen when extraction ran (undefined if not detectable). */
  domUserTurns?: number;
  /** Pages requested from a paginated API. */
  pages?: number;
  /** Raw requests and parse time measured inside the content script. */
  networkMs?: number;
  parseMs?: number;
  warnings: string[];
  /** Messages that were truncated by the service itself. */
  truncatedBySource?: number;
  fetchedAt: number;
  /**
   * Set when this run could not fetch the conversation (the site limited or refused the request,
   * or the network failed) and used the copy an earlier run saved; `fetchedAt` stays that run's
   * time. `current`: the page showed no message the copy lacks, so it was used without waiting
   * (v1.3.10).
   */
  savedCopy?: { reason: string; retryAfterSec?: number; current?: boolean };
}

export interface Conversation {
  title: string;
  pageId: string;
  fromUrl: string;
  site: SiteId;
  siteName: string;
  createAt?: number;
  lastUpdateAt?: number;
  pageType: 'fullPage';
  model?: string;
  displayModel?: string;
  messages: ExportMessage[];
  otherBranchMessages?: BranchMessages[];
  extraction: ExtractionInfo;
}

export type ExportFormat = 'pdf' | 'md' | 'docx' | 'hwpx' | 'html' | 'txt' | 'json' | 'zip';
export type JobKind = 'handoff' | 'export';

export type JobPhase =
  | 'queued'
  | 'collecting'
  | 'assets'
  | 'processing'
  | 'downloading'
  | 'print'
  /** Waiting for the user: a Markdown export of a chat with images asks how to save them (v1.3.6). */
  | 'choose'
  | 'done'
  | 'error';

/**
 * How a Markdown export saves the chat's images (asked each time, v1.3.6): one ZIP with the .md and
 * an images folder, the .md plus a "<title>_files" folder next to it, or the .md alone.
 */
export type MdImageMode = 'zip' | 'folder' | 'none';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

/** Verification checks carry a code and params; UI and reports localize them. */
export interface VerificationCheck {
  code: string;
  status: CheckStatus;
  params?: Record<string, string | number>;
}

export interface VerificationCounts {
  messages: number;
  sourceMessages: number;
  domUserTurns?: number;
  images: number;
  imagesEmbedded: number;
  imagesMissing: number;
  attachments: number;
  attachmentsSaved: number;
  tables: number;
  codeBlocks: number;
  math: number;
  thinkingBlocks: number;
}

export interface Verification {
  level: 'ok' | 'warning' | 'error';
  checks: VerificationCheck[];
  counts: VerificationCounts;
}

export interface JobTimings {
  /** Content-script time: network requests to the AI service. */
  networkMs?: number;
  /** Content-script time: parsing / normalization of the raw payload. */
  parseMs?: number;
  /** Total time until the whole conversation is stored locally. */
  collectMs?: number;
  assetsMs?: number;
  /** Handoff engine stages (from data available → Markdown ready). */
  loadMs?: number;
  normalizeMs?: number;
  dedupeMs?: number;
  scoreMs?: number;
  renderMs?: number;
  /** From conversation data available to output file built (handoff or export). */
  processMs?: number;
  /** Export only: building the file vs. verifying the generated bytes. */
  buildMs?: number;
  verifyMs?: number;
  downloadMs?: number;
}

export interface JobResult {
  filename: string;
  bytes: number;
  downloadId?: number;
  verification: Verification;
  handoffStats?: HandoffStats;
}

export interface HandoffStats {
  sourceTokens: number;
  outputTokens: number;
  messages: number;
  decisions: number;
  constraints: number;
  openTasks: number;
  cacheHits: number;
  cacheMisses: number;
  /** 'condensed': a short conversation, handed off as its key sentences in order (no sections). */
  mode: 'compressed' | 'condensed';
}

export interface JobState {
  id: string;
  kind: JobKind;
  format?: ExportFormat;
  tabId: number;
  site?: SiteId;
  title?: string;
  phase: JobPhase;
  progress?: { done?: number; total?: number; label?: string };
  timings: JobTimings;
  result?: JobResult;
  error?: { code: string; message?: string; retryAfterSec?: number };
  startedAt: number;
  finishedAt?: number;
  /** Markdown image mode the job runs with (after the user chose). */
  mdImages?: MdImageMode;
  /** Set with phase 'choose': what the user is asked. */
  choice?: { kind: 'md-images'; images: number };
}
