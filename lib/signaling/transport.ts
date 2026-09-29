/**
 * Signaling Transport abstraction for NexDrop.
 * Separates WebRTC transport from signaling mechanisms.
 * Supports HTTP ephemeral polling, BroadcastChannel (instant multi-tab testing), and manual SDP exchange.
 */

import { SignalingMessage } from '@/types/session';

export interface SignalingTransport {
  connect(sessionId: string, peerId: string): Promise<void>;
  send(message: SignalingMessage): Promise<void>;
  onMessage(callback: (message: SignalingMessage) => void): void;
  close(): void;
}

/**
 * Ephemeral HTTP polling signaling transport.
 */
export class HttpPollSignalingTransport implements SignalingTransport {
  private sessionId: string | null = null;
  private peerId: string | null = null;
  private pollingTimer: any = null;
  private isClosed: boolean = false;
  private messageCallbacks: Array<(msg: SignalingMessage) => void> = [];
  private pollIntervalMs: number = 400; // Fast initial handshake polling

  async connect(sessionId: string, peerId: string): Promise<void> {
    this.sessionId = sessionId;
    this.peerId = peerId;
    this.isClosed = false;
    this.startPolling();
  }

  private startPolling() {
    if (this.isClosed || !this.sessionId || !this.peerId) return;

    const poll = async () => {
      if (this.isClosed) return;
      try {
        const res = await fetch(
          `/api/signaling?action=poll&sessionId=${encodeURIComponent(this.sessionId!)}&peerId=${encodeURIComponent(this.peerId!)}`,
          { cache: 'no-store', headers: { Accept: 'application/json' } }
        );
        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const data = await res.json().catch(() => null);
            if (data && data.messages && Array.isArray(data.messages)) {
              for (const msg of data.messages) {
                this.notifyMessage(msg);
              }
            }
          }
        }
      } catch (err) {
        // Network blip or temporary interruption
      }

      if (!this.isClosed) {
        this.pollingTimer = setTimeout(poll, this.pollIntervalMs);
      }
    };

    poll();
  }

  public setPollInterval(ms: number) {
    this.pollIntervalMs = ms;
  }

  async send(message: SignalingMessage): Promise<void> {
    if (this.isClosed || !this.sessionId) return;
    try {
      await fetch('/api/signaling', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          action: 'send',
          sessionId: this.sessionId,
          peerId: this.peerId,
          message,
        }),
      });
    } catch (err) {
      console.warn('Signaling send failed:', err);
    }
  }

  onMessage(callback: (message: SignalingMessage) => void): void {
    this.messageCallbacks.push(callback);
  }

  private notifyMessage(msg: SignalingMessage) {
    for (const cb of this.messageCallbacks) {
      try {
        cb(msg);
      } catch (err) {
        console.error('Error in signaling callback:', err);
      }
    }
  }

  close(): void {
    this.isClosed = true;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.messageCallbacks = [];
  }
}

/**
 * BroadcastChannel signaling transport for instant zero-latency pairing between tabs.
 */
export class BroadcastChannelSignalingTransport implements SignalingTransport {
  private channel: BroadcastChannel | null = null;
  private peerId: string | null = null;
  private messageCallbacks: Array<(msg: SignalingMessage) => void> = [];

  async connect(sessionId: string, peerId: string): Promise<void> {
    this.peerId = peerId;
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        this.channel = new BroadcastChannel(`nexdrop_signal_${sessionId}`);
        this.channel.onmessage = (event) => {
          const msg = event.data as SignalingMessage;
          if (msg && msg.fromPeerId !== this.peerId) {
            this.notifyMessage(msg);
          }
        };
      } catch (err) {
        console.warn('BroadcastChannel unavailable:', err);
      }
    }
  }

  async send(message: SignalingMessage): Promise<void> {
    if (this.channel) {
      try {
        this.channel.postMessage(message);
      } catch (err) {
        // channel error
      }
    }
  }

  onMessage(callback: (message: SignalingMessage) => void): void {
    this.messageCallbacks.push(callback);
  }

  private notifyMessage(msg: SignalingMessage) {
    for (const cb of this.messageCallbacks) {
      try {
        cb(msg);
      } catch (e) {
        console.error('BroadcastChannel callback error:', e);
      }
    }
  }

  close(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    this.messageCallbacks = [];
  }
}

/**
 * Hybrid Composite Signaling Transport:
 * Sends via both HTTP Poll and BroadcastChannel, de-duplicating messages.
 * Yields instant peer discovery across tabs on same device AND seamless remote discovery across devices!
 */
export class CompositeSignalingTransport implements SignalingTransport {
  private httpTransport = new HttpPollSignalingTransport();
  private bcTransport = new BroadcastChannelSignalingTransport();
  private seenMessageIds = new Set<string>();

  async connect(sessionId: string, peerId: string): Promise<void> {
    await Promise.all([
      this.httpTransport.connect(sessionId, peerId),
      this.bcTransport.connect(sessionId, peerId),
    ]);
  }

  async send(message: SignalingMessage): Promise<void> {
    await Promise.all([
      this.httpTransport.send(message),
      this.bcTransport.send(message),
    ]);
  }

  onMessage(callback: (message: SignalingMessage) => void): void {
    const dedupeCallback = (msg: SignalingMessage) => {
      // Create a fingerprint for de-duplicating between BroadcastChannel and HTTP
      const fp = `${msg.type}_${msg.fromPeerId}_${msg.timestamp}_${JSON.stringify(msg.payload || '')}`;
      if (this.seenMessageIds.has(fp)) return;
      this.seenMessageIds.add(fp);
      // Keep set bounded
      if (this.seenMessageIds.size > 200) {
        const first = this.seenMessageIds.values().next().value;
        if (first) this.seenMessageIds.delete(first);
      }
      callback(msg);
    };

    this.httpTransport.onMessage(dedupeCallback);
    this.bcTransport.onMessage(dedupeCallback);
  }

  close(): void {
    this.httpTransport.close();
    this.bcTransport.close();
    this.seenMessageIds.clear();
  }
}
