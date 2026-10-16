// Isolated-world side of the web-bridge (tech doc §3.2). Requests are matched to responses by
// requestId and resolved through Promises; the handshake confirms the MAIN-world script exists.

import {
  BRIDGE_HANDSHAKE_MAX,
  BRIDGE_HANDSHAKE_RETRY_MS,
  BRIDGE_HANDSHAKE_WAIT_MS,
  BRIDGE_REQUEST_TIMEOUT_MS,
  CONTENT_ID,
  HANDSHAKE_ACTION,
  INJECT_ID,
  createBridgeMessage,
  isBridgeMessage,
  type BridgeAction,
} from '../shared/bridge-protocol';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class Bridge {
  private pending = new Map<string, Pending>();
  private ready: Promise<boolean> | null = null;

  constructor() {
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!isBridgeMessage(msg) || msg.communicationId !== INJECT_ID || !msg.requestId) return;
      const p = this.pending.get(msg.requestId);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.requestId);
      if (msg.success) p.resolve(msg.data);
      else p.reject(new Error(msg.error || 'bridge error'));
    });
  }

  private send<T>(action: BridgeAction, data: unknown, timeoutMs: number): Promise<T> {
    const msg = createBridgeMessage(CONTENT_ID, action, data, true);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`bridge timeout: ${action}`));
      }, timeoutMs);
      this.pending.set(msg.id, { resolve: resolve as (v: unknown) => void, reject, timer });
      window.postMessage(msg, location.origin);
    });
  }

  /** Resolves true once the MAIN-world script answered a handshake, false after all retries. */
  handshake(): Promise<boolean> {
    if (!this.ready) {
      this.ready = (async () => {
        for (let attempt = 0; attempt < BRIDGE_HANDSHAKE_MAX; attempt++) {
          try {
            await this.send(HANDSHAKE_ACTION, null, BRIDGE_HANDSHAKE_WAIT_MS);
            return true;
          } catch {
            await new Promise((r) => setTimeout(r, attempt === 0 ? 100 : BRIDGE_HANDSHAKE_RETRY_MS));
          }
        }
        return false;
      })();
      // A failed handshake may succeed later if the script gets injected; allow retrying.
      this.ready.then((ok) => {
        if (!ok) this.ready = null;
      });
    }
    return this.ready;
  }

  /** Calls a bridge action; returns undefined instead of throwing when the bridge is unavailable. */
  async request<T>(action: BridgeAction, data: unknown = null): Promise<T | undefined> {
    const ok = await this.handshake();
    if (!ok) return undefined;
    try {
      return await this.send<T>(action, data, BRIDGE_REQUEST_TIMEOUT_MS);
    } catch {
      return undefined;
    }
  }
}
