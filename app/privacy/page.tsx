'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowLeft, Shield, EyeOff, Trash2, Database, Globe } from 'lucide-react';

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-nd-bg-0 text-nd-text-primary selection:bg-nd-teal/20 selection:text-nd-teal-bright">
      {/* Top Header */}
      <header className="border-b border-white/[0.08] bg-nd-bg-0/90 backdrop-blur-md sticky top-0 z-20">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 text-xs font-medium text-nd-text-secondary hover:text-nd-text-primary transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to NexDrop</span>
          </Link>
          <span className="text-xs font-semibold text-nd-teal">Privacy Policy</span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6 text-left">
        <div className="max-w-2xl">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-nd-text-primary">
            Privacy Constitution
          </h1>
          <p className="mt-3 text-sm text-nd-text-secondary leading-relaxed">
            NexDrop was designed from day one with a radical premise: you should not need to hand over your personal data or identity to transfer a file across the room.
          </p>
        </div>

        <div className="mt-10 space-y-8">
          <section className="space-y-3">
            <h2 className="text-base font-semibold text-nd-text-primary flex items-center gap-2">
              <EyeOff className="w-4 h-4 text-nd-teal" />
              1. Zero Account & Zero Identity Tracking
            </h2>
            <p className="text-xs sm:text-sm text-nd-text-secondary leading-relaxed">
              We do not ask for your email address, phone number, or name. There are no user profiles, account databases, or persistent tracking IDs — the app is a static website with no user accounts and no file storage of any kind.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-nd-text-primary flex items-center gap-2">
              <Database className="w-4 h-4 text-nd-teal-bright" />
              2. Zero Cloud File Retention
            </h2>
            <p className="text-xs sm:text-sm text-nd-text-secondary leading-relaxed">
              When you drop a 5 GB video or a confidential PDF into NexDrop, that file never touches any cloud storage bucket, CDN, or server filesystem. The file is sliced in browser memory and streamed directly across the WebRTC peer connection to your recipient.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-nd-text-primary flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-nd-teal" />
              3. Ephemeral Sessions with Auto-Destruction
            </h2>
            <p className="text-xs sm:text-sm text-nd-text-secondary leading-relaxed">
              Pairing sessions are short-lived: each one expires automatically after 10 minutes, the join token is single-use, and the session is destroyed the moment the direct connection opens. Automatic one-scan pairing uses a lightweight ephemeral signaling service that carries only connection establishment data (session id, single-use token, SDP, ICE, device name) — never file contents. The manual QR / copy-paste fallback exchanges codes directly between the two screens with no signaling service involved at all.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-nd-text-primary flex items-center gap-2">
              <Globe className="w-4 h-4 text-nd-teal-bright" />
              4. Zero Third-Party Advertising Trackers
            </h2>
            <p className="text-xs sm:text-sm text-nd-text-secondary leading-relaxed">
              NexDrop embeds zero third-party advertising tracking pixels, Facebook SDKs, behavioral fingerprinting scripts, or session replay recorders. Your browsing patterns and transferred file names remain strictly confidential.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-nd-text-primary flex items-center gap-2">
              <Shield className="w-4 h-4 text-nd-teal" />
              5. Local Device Storage Exclusively
            </h2>
            <p className="text-xs sm:text-sm text-nd-text-secondary leading-relaxed">
              Optional transfer history and device preferences are stored inside your own browser&apos;s local storage. This data never leaves your device and can be erased instantly at any time via Settings &gt; Clear Local History.
            </p>
          </section>
        </div>

        <div className="mt-12 pt-8 border-t border-white/[0.08] text-center">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-lg bg-nd-teal px-6 py-2.5 text-xs font-semibold text-nd-bg-0 hover:bg-nd-teal-bright transition-colors"
          >
            Return to NexDrop
          </Link>
        </div>
      </main>
    </div>
  );
}
