'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowLeft, Shield, Lock, Key, CheckCircle, Cpu, EyeOff, FileCheck } from 'lucide-react';

export default function SecurityPage() {
  return (
    <div className="min-h-screen bg-[#070A0D] text-[#F5F7F8] selection:bg-[#00F5A0]/20 selection:text-[#00D9B5]">
      {/* Top Header */}
      <header className="border-b border-white/[0.08] bg-[#070A0D]/90 backdrop-blur-md sticky top-0 z-20">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 text-xs font-medium text-[#9AA7AE] hover:text-[#F5F7F8] transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to NexDrop</span>
          </Link>
          <span className="text-xs font-semibold text-[#00F5A0]">Security Architecture</span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <div className="text-left">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-[#F5F7F8]">
            Security & Cryptography
          </h1>
          <p className="mt-3 text-sm text-[#9AA7AE] leading-relaxed max-w-2xl">
            NexDrop is architected so that your sensitive files, videos, documents, and credentials never touch a cloud storage server. Here is how our cryptographic security layers operate.
          </p>
        </div>

        <div className="mt-10 space-y-6 text-left">
          {/* Layer 1 */}
          <div className="rounded-xl border border-white/[0.08] bg-[#11171B] p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0B0F12] border border-white/[0.06]">
                <Lock className="w-5 h-5 text-[#00F5A0]" />
              </div>
              <h2 className="text-base font-semibold text-[#F5F7F8]">
                1. WebRTC Transport Security (DTLS-SRTP)
              </h2>
            </div>
            <p className="mt-3 text-xs sm:text-sm text-[#9AA7AE] leading-relaxed">
              All WebRTC communication uses mandatory Datagram Transport Layer Security (DTLS). DataChannels are encrypted end-to-end between the two browser endpoints. Even if network packets are inspected on transit, the payload cannot be decrypted without the ephemeral DTLS session keys negotiated directly between the peers.
            </p>
          </div>

          {/* Layer 2 */}
          <div className="rounded-xl border border-white/[0.08] bg-[#11171B] p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0B0F12] border border-white/[0.06]">
                <Key className="w-5 h-5 text-[#00D9B5]" />
              </div>
              <h2 className="text-base font-semibold text-[#F5F7F8]">
                2. Application-Layer E2EE (ECDH + AES-256-GCM)
              </h2>
            </div>
            <p className="mt-3 text-xs sm:text-sm text-[#9AA7AE] leading-relaxed">
              On top of transport encryption, every device generates an ephemeral ECDH (P-256) key pair whose public key travels inside the QR pairing code. Both devices derive the same AES-256-GCM session key via HKDF-SHA256, and every file chunk is individually encrypted with a unique 96-bit IV before it ever touches the DataChannel. Keys are never hardcoded and exist only in memory.
            </p>
          </div>

          {/* Layer 3 */}
          <div className="rounded-xl border border-white/[0.08] bg-[#11171B] p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0B0F12] border border-white/[0.06]">
                <EyeOff className="w-5 h-5 text-[#00F5A0]" />
              </div>
              <h2 className="text-base font-semibold text-[#F5F7F8]">
                3. Short Authentication String (SAS Verification)
              </h2>
            </div>
            <p className="mt-3 text-xs sm:text-sm text-[#9AA7AE] leading-relaxed">
              Because pairing codes are exchanged by QR or copy/paste, they could in theory be tampered with. To catch this, both devices derive a 6-digit Short Authentication String (e.g., <code className="font-mono text-[#00F5A0]">482 913</code>) from the actual ECDH shared secret via HKDF. If both screens show the same code, no one altered the handshake. Users confirm this in the Verify dialog.
            </p>
          </div>

          {/* Layer 4 */}
          <div className="rounded-xl border border-white/[0.08] bg-[#11171B] p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0B0F12] border border-white/[0.06]">
                <FileCheck className="w-5 h-5 text-[#00D9B5]" />
              </div>
              <h2 className="text-base font-semibold text-[#F5F7F8]">
                4. Streaming SHA-256 Integrity Verification
              </h2>
            </div>
            <p className="mt-3 text-xs sm:text-sm text-[#9AA7AE] leading-relaxed">
              During transmission, the sender and receiver compute SHA-256 hashes incrementally. Upon completion, hashes are matched to guarantee bit-for-bit payload integrity without corruptions or silent drops.
            </p>
          </div>

          {/* Layer 5 */}
          <div className="rounded-xl border border-white/[0.08] bg-[#11171B] p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0B0F12] border border-white/[0.06]">
                <Cpu className="w-5 h-5 text-[#00F5A0]" />
              </div>
              <h2 className="text-base font-semibold text-[#F5F7F8]">
                5. Zero Cloud File Persistence
              </h2>
            </div>
            <p className="mt-3 text-xs sm:text-sm text-[#9AA7AE] leading-relaxed">
              NexDrop is a fully static PWA: no database, no file storage. One-scan pairing uses a lightweight ephemeral signaling service that relays only connection metadata (session id, single-use token, SDP, ICE) and expires each session within minutes; the manual QR/paste code path needs no signaling at all. File contents never touch any server — they travel only over the direct peer connection.
            </p>
          </div>
        </div>

        <div className="mt-12 text-center">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-lg bg-[#00F5A0] px-6 py-2.5 text-xs font-semibold text-[#070A0D] hover:bg-[#00D9B5] transition-colors"
          >
            Start Private Transfer
          </Link>
        </div>
      </main>
    </div>
  );
}
