// Message contract between the page MAIN world script (inject.js) and the isolated content
// script (tech doc §3.2). Values follow the documented bridge: request timeout 30s, handshake
// wait 500ms, retry interval 1s, at most 10 handshakes.

export const BRIDGE_TYPE = 'web-bridge';
export const HANDSHAKE_ACTION = '__handshake__';
export const CONTENT_ID = 'lucian-extension-content';
export const INJECT_ID = 'lucian-inject-web';

export const BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
export const BRIDGE_HANDSHAKE_WAIT_MS = 500;
export const BRIDGE_HANDSHAKE_RETRY_MS = 1_000;
export const BRIDGE_HANDSHAKE_MAX = 10;

export interface BridgeMessage {
  type: typeof BRIDGE_TYPE;
  communicationId: string;
  id: string;
  action: string;
  data?: unknown;
  needResponse?: boolean;
  requestId?: string;
  success?: boolean;
  error?: string;
  timestamp: number;
}

export type BridgeAction =
  | typeof HANDSHAKE_ACTION
  | 'getChatGPTAuthHeader'
  | 'getGeminiGlobalData'
  | 'getGeminiLatestReqId'
  | 'getGeminiExtHeaders'
  | 'getGrokHeaders';

export interface ChatGPTAuthData {
  authorization?: string;
  extraHeaders: Record<string, string>;
}

export interface GeminiGlobalData {
  sid?: string; // FdrFJe
  bl?: string; // cfb2h
  at?: string; // SNlM0e
  hl?: string;
}

export function createBridgeMessage(
  communicationId: string,
  action: string,
  data?: unknown,
  needResponse = false,
  requestId?: string,
): BridgeMessage {
  return {
    type: BRIDGE_TYPE,
    communicationId,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    action,
    data,
    needResponse,
    requestId,
    timestamp: Date.now(),
  };
}

export function isBridgeMessage(v: unknown): v is BridgeMessage {
  return !!v && typeof v === 'object' && (v as BridgeMessage).type === BRIDGE_TYPE && typeof (v as BridgeMessage).action === 'string';
}
