'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowLeft, Shield, EyeOff, Trash2, Database, Globe } from 'lucide-react';

export default function PrivacyPage() {
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
          <span className="text-xs font-semibold text-[#00F5A0]">Privacy Policy</span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6 text-left">
        <div className="max-w-2xl">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-[#F5F7F8]">
            Privacy Constitution
          </h1>
          <p className="mt-3 text-sm text-[#9AA7AE] leading-relaxed">
            NexDrop was designed from day one with a radical premise: you should not need to hand over your personal data or identity to transfer a file across the room.
          </p>
        </div>

        <div className="mt-10 space-y-8">
          <section className="space-y-3">
            <h2 className="text-base font-semibold text-[#F5F7F8] flex items-center gap-2">
              <EyeOff className="w-4 h-4 text-[#00F5A0]" />
              1. Zero Account & Zero Identity Tracking
            </h2>
            <p className="text-xs sm:text-sm text-[#9AA7AE] leading-relaxed">
              We do not ask for your email address, phone number, or name. There are no user profiles, account databases, or persistent tracking IDs — the app is a static website with no backend of any kind.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-[#F5F7F8] flex items-center gap-2">
              <Database className="w-4 h-4 text-[#00D9B5]" />
              2. Zero Cloud File Retention
            </h2>
            <p className="text-xs sm:text-sm text-[#9AA7AE] leading-relaxed">
              When you drop a 5 GB video or a confidential PDF into NexDrop, that file never touches any cloud storage bucket, CDN, or server filesystem. The file is sliced in browser memory and streamed directly across the WebRTC peer connection to your recipient.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-[#F5F7F8] flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-[#00F5A0]" />
              3. Ephemeral Sessions with Auto-Destruction
            </h2>
            <p className="text-xs sm:text-sm text-[#9AA7AE] leading-relaxed">
              Pairing codes (the QR codes or pasted text used to negotiate the WebRTC handshake) exist only in memory on the two pairing devices and expire automatically after 10 minutes. There is no signaling server at all — the codes are exchanged directly between the two screens.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-[#F5F7F8] flex items-center gap-2">
              <Globe className="w-4 h-4 text-[#00D9B5]" />
              4. Zero Third-Party Advertising Trackers
            </h2>
            <p className="text-xs sm:text-sm text-[#9AA7AE] leading-relaxed">
              NexDrop embeds zero third-party advertising tracking pixels, Facebook SDKs, behavioral fingerprinting scripts, or session replay recorders. Your browsing patterns and transferred file names remain strictly confidential.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-[#F5F7F8] flex items-center gap-2">
              <Shield className="w-4 h-4 text-[#00F5A0]" />
              5. Local Device Storage Exclusively
            </h2>
            <p className="text-xs sm:text-sm text-[#9AA7AE] leading-relaxed">
              Optional transfer history and device preferences are stored inside your own browser&apos;s local storage. This data never leaves your device and can be erased instantly at any time via Settings &gt; Clear Local History.
            </p>
          </section>
        </div>

        <div className="mt-12 pt-8 border-t border-white/[0.08] text-center">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-lg bg-[#00F5A0] px-6 py-2.5 text-xs font-semibold text-[#070A0D] hover:bg-[#00D9B5] transition-colors"
          >
            Return to NexDrop
          </Link>
        </div>
      </main>
    </div>
  );
}
