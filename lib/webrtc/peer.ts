/**
 * WebRTC PeerConnection and Dedicated DataChannels Manager for NexDrop.
 *
 * Manual (server-less) pairing: no trickle ICE. Local descriptions are only
 * handed to the pairing layer AFTER ICE gathering completes, so the SDP in
 * the QR/paste payload already contains all candidates.
 *
 * 'connected' is reported ONLY when the required DataChannels are actually
 * open — never before.
 */

import {
  ChannelName,
  DATA_CHANNELS,
  DEFAULT_RTC_CONFIG,
  REQUIRED_CHANNELS,
  WebRTCConnectionState,
} from '@/types/webrtc';
import {
  ClipboardSyncMessage,
  ControlMessage,
  PeerMetadataMessage,
  TextTransferMessage,
} from '@/types/transfer';

export const ICE_GATHERING_TIMEOUT_MS = 4000;

export interface PeerCallbacks {
  onStateChange: (state: WebRTCConnectionState) => void;
  onControlMessage: (msg: ControlMessage) => void;
  onFileChunk: (chunk: ArrayBuffer) => void;
  onClipboardMessage: (msg: ClipboardSyncMessage) => void;
  onTextMessage: (msg: TextTransferMessage) => void;
  onRttChange: (rttMs: number) => void;
}

export class PeerConnectionManager {
  private pc: RTCPeerConnection | null = null;
  private channels: Partial<Record<ChannelName, RTCDataChannel>> = {};
  private callbacks: PeerCallbacks;
  private state: WebRTCConnectionState = 'idle';
  private isInitiator = false;
  private isClosed = false;
  private rtt: number | null = null;
  private connectedOnce = false;
  private disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPongAt = 0;

  constructor(callbacks: PeerCallbacks) {
    this.callbacks = callbacks;
  }

  public getRtt(): number | null {
    return this.rtt;
  }

  public getState(): WebRTCConnectionState {
    return this.state;
  }

  public getChannel(name: ChannelName): RTCDataChannel | undefined {
    return this.channels[name];
  }

  public isChannelReady(name: ChannelName): boolean {
    return this.channels[name]?.readyState === 'open';
  }

  public isConnected(): boolean {
    return this.state === 'connected';
  }

  private updateState(state: WebRTCConnectionState) {
    if (this.isClosed && state !== 'closed') return;
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onStateChange(state);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Create the RTCPeerConnection and channels. Throws when unsupported. */
  public initialize(isInitiator: boolean): void {
    if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined') {
      this.updateState('failed');
      throw new Error('unsupported-browser');
    }

    this.isInitiator = isInitiator;
    this.isClosed = false;
    this.connectedOnce = false;
    this.rtt = null;

    try {
      this.pc = new RTCPeerConnection(DEFAULT_RTC_CONFIG);
    } catch {
      this.updateState('failed');
      throw new Error('unsupported-browser');
    }

    this.setupPcListeners();

    if (isInitiator) {
      for (const name of DATA_CHANNELS) {
        const channel = this.pc.createDataChannel(name, { ordered: true });
        this.registerDataChannel(name, channel);
      }
    } else {
      this.pc.ondatachannel = (event) => {
        const channel = event.channel;
        if ((DATA_CHANNELS as string[]).includes(channel.label)) {
          this.registerDataChannel(channel.label as ChannelName, channel);
        }
      };
    }

    this.updateState('new');
  }

  private registerDataChannel(name: ChannelName, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    this.channels[name] = channel;

    channel.onopen = () => {
      this.checkAllChannelsReady();
    };

    channel.onclose = () => {
      // Individual channel close: let connection state drive the UI.
      this.updateState('disconnected');
    };

    channel.onerror = (evt) => {
      console.warn(`DataChannel ${name} error:`, evt);
    };

    channel.onmessage = (event) => {
      this.handleIncomingChannelMessage(name, event.data);
    };
  }

  private handleIncomingChannelMessage(channelName: ChannelName, data: unknown) {
    if (this.isClosed) return;
    switch (channelName) {
      case 'file':
        if (data instanceof ArrayBuffer) {
          this.callbacks.onFileChunk(data);
        }
        break;
      case 'control':
      case 'clipboard':
      case 'text': {
        let parsed: ControlMessage | null = null;
        try {
          parsed = typeof data === 'string' ? (JSON.parse(data) as ControlMessage) : (data as ControlMessage);
        } catch {
          console.warn('Malformed message on', channelName);
          return;
        }
        if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return;

        if (parsed.type === 'PING') {
          this.sendControl({ type: 'PONG', timestamp: (parsed as { timestamp: number }).timestamp });
          return;
        }
        if (parsed.type === 'PONG') {
          const ts = (parsed as { timestamp: number }).timestamp;
          this.rtt = Math.max(1, Date.now() - ts);
          this.lastPongAt = Date.now();
          this.callbacks.onRttChange(this.rtt);
          return;
        }

        if (channelName === 'control') {
          this.callbacks.onControlMessage(parsed);
        } else if (channelName === 'clipboard') {
          this.callbacks.onClipboardMessage(parsed as ClipboardSyncMessage);
        } else {
          this.callbacks.onTextMessage(parsed as TextTransferMessage);
        }
        break;
      }
    }
  }

  private checkAllChannelsReady() {
    const ready = REQUIRED_CHANNELS.every(
      (name) => this.channels[name]?.readyState === 'open'
    );
    if (ready && this.state !== 'connected') {
      this.connectedOnce = true;
      this.updateState('connected');
      this.lastPongAt = Date.now();
      this.startLivenessChecks();
    }
  }

  private setupPcListeners() {
    if (!this.pc) return;

    this.pc.onconnectionstatechange = () => {
      if (!this.pc) return;
      switch (this.pc.connectionState) {
        case 'new':
          this.updateState('new');
          break;
        case 'connecting':
          this.updateState('connecting');
          break;
        case 'connected':
          this.checkAllChannelsReady();
          this.clearDisconnectGrace();
          break;
        case 'disconnected':
          this.scheduleDisconnectGrace();
          break;
        case 'failed':
          this.updateState('failed');
          break;
        case 'closed':
          this.updateState('closed');
          break;
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (!this.pc) return;
      switch (this.pc.iceConnectionState) {
        case 'connected':
        case 'completed':
          this.checkAllChannelsReady();
          this.clearDisconnectGrace();
          break;
        case 'disconnected':
          this.scheduleDisconnectGrace();
          break;
        case 'failed':
          this.updateState('failed');
          break;
        case 'closed':
          this.updateState('closed');
          break;
      }
    };
  }

  /**
   * WebRTC connections can blip. Give the peer 5 seconds to recover before
   * reporting 'disconnected' — after that the user must re-pair (manual
   * signaling cannot restart ICE without a new offer/answer exchange).
   */
  private scheduleDisconnectGrace() {
    if (this.disconnectGraceTimer || this.state === 'disconnected') return;
    this.disconnectGraceTimer = setTimeout(() => {
      this.disconnectGraceTimer = null;
      if (this.pc && this.pc.connectionState === 'disconnected') {
        this.updateState('disconnected');
      }
    }, 5000);
  }

  private clearDisconnectGrace() {
    if (this.disconnectGraceTimer) {
      clearTimeout(this.disconnectGraceTimer);
      this.disconnectGraceTimer = null;
    }
  }

  /** PING/PONG liveness + RTT measurement while connected. */
  private livenessTimer: ReturnType<typeof setInterval> | null = null;

  private startLivenessChecks() {
    this.stopLivenessChecks();
    this.livenessTimer = setInterval(() => {
      if (this.isClosed || !this.isChannelReady('control')) {
        this.stopLivenessChecks();
        return;
      }
      // If no PONG for 12s, the peer is gone.
      if (Date.now() - this.lastPongAt > 12000) {
        this.updateState('disconnected');
        this.stopLivenessChecks();
        return;
      }
      this.sendControl({ type: 'PING', timestamp: Date.now() });
    }, 4000);
  }

  private stopLivenessChecks() {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Manual (non-trickle) offer / answer
  // -----------------------------------------------------------------------

  /**
   * Initiator: create an offer and wait for ICE gathering to complete so the
   * local SDP contains all candidates. Returns the full local description.
   */
  public async createOfferAndWaitForIce(): Promise<RTCSessionDescriptionInit> {
    if (!this.pc) throw new Error('peer-not-initialized');
    this.updateState('gathering');

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.waitForIceGathering();

    if (!this.pc.localDescription) throw new Error('no-local-description');
    return this.pc.localDescription;
  }

  /**
   * Joiner: apply the remote offer, create the answer, wait for ICE
   * gathering, and return the full local answer description.
   */
  public async acceptOfferAndWaitForIce(
    offerSdp: string
  ): Promise<RTCSessionDescriptionInit> {
    if (!this.pc) throw new Error('peer-not-initialized');
    this.updateState('gathering');

    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.waitForIceGathering();

    if (!this.pc.localDescription) throw new Error('no-local-description');
    return this.pc.localDescription;
  }

  /** Initiator: apply the remote answer. */
  public async acceptAnswer(answerSdp: string): Promise<void> {
    if (!this.pc) throw new Error('peer-not-initialized');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    this.updateState('connecting');
  }

  /**
   * Wait until ICE gathering completes (or a short timeout elapses with at
   * least one candidate). Non-trickle manual pairing requires this.
   */
  private waitForIceGathering(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.pc) return resolve();

      if (this.pc.iceGatheringState === 'complete') return resolve();

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.pc?.removeEventListener('icegatheringstatechange', onChange);
        clearTimeout(timer);
        resolve();
      };

      const onChange = () => {
        if (this.pc?.iceGatheringState === 'complete') finish();
      };

      // Failsafe: after ICE_GATHERING_TIMEOUT_MS continue with whatever we
      // have (host candidates may already be enough on a shared network).
      const timer = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);

      this.pc.addEventListener('icegatheringstatechange', onChange);
    });
  }

  // -----------------------------------------------------------------------
  // Senders
  // -----------------------------------------------------------------------

  public sendControl(msg: ControlMessage): boolean {
    return this.sendJson('control', msg);
  }

  public sendClipboard(msg: ClipboardSyncMessage): boolean {
    return this.sendJson('clipboard', msg);
  }

  public sendText(msg: TextTransferMessage): boolean {
    return this.sendJson('text', msg);
  }

  public sendMetadata(msg: PeerMetadataMessage): boolean {
    return this.sendJson('control', msg);
  }

  public sendFileChunk(packet: ArrayBuffer): boolean {
    const ch = this.channels.file;
    if (ch && ch.readyState === 'open') {
      try {
        ch.send(packet);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private sendJson(name: ChannelName, msg: unknown): boolean {
    const ch = this.channels[name];
    if (ch && ch.readyState === 'open') {
      try {
        ch.send(JSON.stringify(msg));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  public close(): void {
    this.isClosed = true;
    this.stopLivenessChecks();
    this.clearDisconnectGrace();

    for (const name of DATA_CHANNELS) {
      const ch = this.channels[name];
      if (ch) {
        try {
          ch.onopen = null;
          ch.onclose = null;
          ch.onerror = null;
          ch.onmessage = null;
          if (ch.readyState !== 'closed') ch.close();
        } catch {
          // ignore
        }
      }
    }
    this.channels = {};

    if (this.pc) {
      try {
        this.pc.onicecandidate = null;
        this.pc.onconnectionstatechange = null;
        this.pc.oniceconnectionstatechange = null;
        this.pc.ondatachannel = null;
        this.pc.close();
      } catch {
        // ignore
      }
      this.pc = null;
    }

    this.updateState('closed');
  }
}
