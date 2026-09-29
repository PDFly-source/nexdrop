/**
 * WebRTC PeerConnection and Dedicated DataChannels Manager.
 * Handles:
 * - Dedicated DataChannels: 'control', 'file', 'clipboard', 'text', 'metadata'
 * - binaryType = 'arraybuffer'
 * - Connection state lifecycle (connecting, connected, reconnecting, disconnected, failed, closed)
 * - ICE candidate management and ICE restarts
 */

import { ChannelName, DEFAULT_RTC_CONFIG, WebRTCConnectionState } from '@/types/webrtc';
import { SignalingMessage } from '@/types/session';

export interface PeerCallbacks {
  onStateChange: (state: WebRTCConnectionState) => void;
  onControlMessage: (data: any) => void;
  onFileChunk: (chunk: ArrayBuffer) => void;
  onClipboardMessage: (data: any) => void;
  onTextMessage: (data: any) => void;
  onMetadataMessage: (data: any) => void;
  onSignalingCandidate: (candidate: RTCIceCandidate) => void;
  onSignalingOffer: (offer: RTCSessionDescriptionInit) => void;
  onSignalingAnswer: (answer: RTCSessionDescriptionInit) => void;
  onRttChange?: (rttMs: number) => void;
}

export class PeerConnectionManager {
  private pc: RTCPeerConnection | null = null;
  private channels: Partial<Record<ChannelName, RTCDataChannel>> = {};
  private callbacks: PeerCallbacks;
  private state: WebRTCConnectionState = 'idle';
  private isInitiator: boolean = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private isClosed: boolean = false;
  private pingTimer: any = null;
  private rtt: number | null = null;

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

  public initialize(isInitiator: boolean): void {
    if (typeof window === 'undefined' || !('RTCPeerConnection' in window)) {
      this.updateState('failed');
      return;
    }

    this.isInitiator = isInitiator;
    this.isClosed = false;

    try {
      this.pc = new RTCPeerConnection(DEFAULT_RTC_CONFIG);
    } catch (err) {
      console.error('Failed to create RTCPeerConnection:', err);
      this.updateState('failed');
      return;
    }

    this.setupPcListeners();

    if (isInitiator) {
      this.createAllChannels();
    } else {
      this.pc.ondatachannel = (event) => {
        const channel = event.channel;
        this.registerDataChannel(channel.label as ChannelName, channel);
      };
    }
  }

  private createAllChannels() {
    const channelNames: ChannelName[] = ['control', 'file', 'clipboard', 'text', 'metadata'];
    for (const name of channelNames) {
      try {
        const channel = this.pc!.createDataChannel(name, {
          ordered: true,
        });
        this.registerDataChannel(name, channel);
      } catch (err) {
        console.error(`Failed to create data channel ${name}:`, err);
      }
    }
  }

  private registerDataChannel(name: ChannelName, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    this.channels[name] = channel;

    channel.onopen = () => {
      this.checkAllChannelsReady();
    };

    channel.onclose = () => {
      // Channel closed
    };

    channel.onerror = (evt) => {
      console.warn(`DataChannel ${name} error:`, evt);
    };

    channel.onmessage = (event) => {
      this.handleIncomingChannelMessage(name, event.data);
    };
  }

  private handleIncomingChannelMessage(channelName: ChannelName, data: any) {
    switch (channelName) {
      case 'file':
        if (data instanceof ArrayBuffer) {
          this.callbacks.onFileChunk(data);
        }
        break;
      case 'control':
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          if (parsed && parsed.type === 'PING') {
            this.sendControl({ type: 'PONG', timestamp: parsed.timestamp });
            return;
          }
          if (parsed && parsed.type === 'PONG') {
            const rtt = Math.max(1, Date.now() - parsed.timestamp);
            this.rtt = rtt;
            this.callbacks.onRttChange?.(rtt);
            return;
          }
          this.callbacks.onControlMessage(parsed);
        } catch (e) {
          console.error('Malformed control message', e);
        }
        break;
      case 'clipboard':
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          this.callbacks.onClipboardMessage(parsed);
        } catch (e) {
          console.error('Malformed clipboard message', e);
        }
        break;
      case 'text':
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          this.callbacks.onTextMessage(parsed);
        } catch (e) {
          console.error('Malformed text message', e);
        }
        break;
      case 'metadata':
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          this.callbacks.onMetadataMessage(parsed);
        } catch (e) {
          console.error('Malformed metadata message', e);
        }
        break;
    }
  }

  private checkAllChannelsReady() {
    const required: ChannelName[] = ['control', 'file'];
    const ready = required.every((name) => this.channels[name]?.readyState === 'open');
    if (ready && this.state !== 'connected') {
      this.updateState('connected');
    }
  }

  private setupPcListeners() {
    if (!this.pc) return;

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.callbacks.onSignalingCandidate(event.candidate);
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (!this.pc) return;
      const cs = this.pc.connectionState;
      if (cs === 'connected') {
        this.checkAllChannelsReady();
      } else if (cs === 'disconnected') {
        this.updateState('reconnecting');
        this.attemptIceRestart();
      } else if (cs === 'failed') {
        this.updateState('failed');
      } else if (cs === 'closed') {
        this.updateState('closed');
      } else if (cs === 'connecting') {
        this.updateState('connecting');
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (!this.pc) return;
      const ics = this.pc.iceConnectionState;
      if (ics === 'connected' || ics === 'completed') {
        this.checkAllChannelsReady();
      } else if (ics === 'disconnected') {
        this.updateState('reconnecting');
      } else if (ics === 'failed') {
        this.attemptIceRestart();
      }
    };
  }

  public async createOffer(): Promise<RTCSessionDescriptionInit | null> {
    if (!this.pc) return null;
    this.updateState('connecting');
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      return offer;
    } catch (err) {
      console.error('Failed to create offer:', err);
      this.updateState('failed');
      return null;
    }
  }

  public async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit | null> {
    if (!this.pc) {
      this.initialize(false);
    }
    if (!this.pc) return null;

    this.updateState('connecting');
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
      // Process any queued candidates
      await this.flushPendingCandidates();

      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      return answer;
    } catch (err) {
      console.error('Failed to handle offer and create answer:', err);
      this.updateState('failed');
      return null;
    }
  }

  public async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
      await this.flushPendingCandidates();
    } catch (err) {
      console.error('Failed to handle answer:', err);
      this.updateState('failed');
    }
  }

  public async addIceCandidate(candidateInit: RTCIceCandidateInit): Promise<void> {
    if (!this.pc || !this.pc.remoteDescription) {
      this.pendingCandidates.push(candidateInit);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidateInit));
    } catch (err) {
      console.warn('Error adding ICE candidate:', err);
    }
  }

  private async flushPendingCandidates() {
    if (!this.pc || !this.pc.remoteDescription) return;
    while (this.pendingCandidates.length > 0) {
      const cand = this.pendingCandidates.shift();
      if (cand) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch (e) {
          console.warn('Candidate flush error:', e);
        }
      }
    }
  }

  public async attemptIceRestart(): Promise<void> {
    if (!this.pc || this.isClosed || !this.isInitiator) return;
    try {
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      this.callbacks.onSignalingOffer(offer);
    } catch (err) {
      console.warn('ICE restart attempt failed:', err);
    }
  }

  public sendControl(msg: any): boolean {
    const ch = this.channels.control;
    if (ch && ch.readyState === 'open') {
      try {
        ch.send(JSON.stringify(msg));
        return true;
      } catch (err) {
        console.error('Failed to send control message:', err);
      }
    }
    return false;
  }

  public sendClipboard(msg: any): boolean {
    const ch = this.channels.clipboard;
    if (ch && ch.readyState === 'open') {
      ch.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  public sendText(msg: any): boolean {
    const ch = this.channels.text;
    if (ch && ch.readyState === 'open') {
      ch.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  public sendMetadata(msg: any): boolean {
    const ch = this.channels.metadata;
    if (ch && ch.readyState === 'open') {
      ch.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  private startPingLoop() {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      if (this.state === 'connected' && this.isChannelReady('control')) {
        this.sendControl({ type: 'PING', timestamp: Date.now() });
      }
    }, 3000);
    // Send immediate initial ping
    if (this.isChannelReady('control')) {
      this.sendControl({ type: 'PING', timestamp: Date.now() });
    }
  }

  private stopPingLoop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private updateState(newState: WebRTCConnectionState) {
    if (this.state !== newState) {
      this.state = newState;
      if (newState === 'connected') {
        this.startPingLoop();
      } else {
        this.stopPingLoop();
        this.rtt = null;
      }
      this.callbacks.onStateChange(newState);
    }
  }

  public close(): void {
    this.stopPingLoop();
    this.isClosed = true;
    for (const key of Object.keys(this.channels) as ChannelName[]) {
      const ch = this.channels[key];
      if (ch) {
        try {
          ch.close();
        } catch (e) {}
      }
    }
    this.channels = {};

    if (this.pc) {
      try {
        this.pc.close();
      } catch (e) {}
      this.pc = null;
    }
    this.pendingCandidates = [];
    this.updateState('closed');
  }
}
