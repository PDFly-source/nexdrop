'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowLeft, Layers, Cpu, Globe } from 'lucide-react';

export default function AboutPage() {
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
          <span className="text-xs font-semibold text-[#00F5A0]">About NexDrop</span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6 text-left">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2 text-xs text-[#00F5A0] font-medium mb-3">
            <span>NexDrop</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-[#F5F7F8]">
            About NexDrop
          </h1>
          <p className="mt-3 text-sm text-[#9AA7AE] leading-relaxed">
            Private. Direct. Fast. Browser-to-browser file and text sharing without accounts or cloud storage intermediaries.
          </p>
        </div>

        <div className="mt-10 space-y-8 text-xs sm:text-sm text-[#9AA7AE] leading-relaxed">
          <section className="space-y-3">
            <h2 className="text-base font-semibold text-[#F5F7F8]">What is NexDrop?</h2>
            <p>
              NexDrop is a Progressive Web App designed to bridge personal devices — phones, laptops, desktops, and tablets — over direct peer-to-peer WebRTC connections. Whether sharing high-resolution photos, 4K video clips, code snippets, or clipboard text, files and text travel directly between the two devices — never through a cloud server. Pairing uses lightweight ephemeral signaling only to establish the WebRTC connection: one scan, the host accepts, and the devices connect. The signaling service does not relay file contents.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-[#F5F7F8]">How Large-File Streaming Works</h2>
            <p>
              Traditional web applications crash when loading gigabyte-sized files into memory. NexDrop solves this with high-performance 64 KiB chunk streaming:
            </p>
            <ul className="list-disc pl-5 space-y-1.5 text-xs text-[#9AA7AE]">
              <li><strong className="text-white">File.slice() Engine:</strong> Reads small 64 KiB slices from the source disk on demand without loading the full file into heap RAM.</li>
              <li><strong className="text-white">Backpressure & Flow Control:</strong> Automatically throttles chunk delivery when RTCDataChannel buffer limits are reached.</li>
              <li><strong className="text-white">Direct Disk Streaming:</strong> On modern Chromium browsers, the File System Access API streams incoming chunks directly to disk through a file handle.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-[#F5F7F8]">Browser Compatibility</h2>
            <div className="overflow-x-auto rounded-lg border border-white/[0.08] bg-[#11171B] p-4 text-xs">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-white/[0.06] text-[#9AA7AE]">
                    <th className="pb-2">Browser / Platform</th>
                    <th className="pb-2">P2P WebRTC</th>
                    <th className="pb-2">Storage Pipeline</th>
                    <th className="pb-2">Max Recommended Size</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  <tr>
                    <td className="py-2.5 font-medium text-white">Chrome / Edge Desktop</td>
                    <td className="py-2.5 text-[#22C55E]">Full Support</td>
                    <td className="py-2.5 text-[#00D9B5]">File System Access API (Direct to Disk)</td>
                    <td className="py-2.5 font-mono text-white">50+ GB</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 font-medium text-white">Chrome Android</td>
                    <td className="py-2.5 text-[#22C55E]">Full Support</td>
                    <td className="py-2.5 text-[#00D9B5]">OPFS / Blob Assembly</td>
                    <td className="py-2.5 font-mono text-white">10 GB</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 font-medium text-white">Safari (macOS & iOS)</td>
                    <td className="py-2.5 text-[#22C55E]">Full Support</td>
                    <td className="py-2.5 text-amber-400">Sandboxed Blob Stream</td>
                    <td className="py-2.5 font-mono text-white">2 GB</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 font-medium text-white">Firefox Desktop</td>
                    <td className="py-2.5 text-[#22C55E]">Full Support</td>
                    <td className="py-2.5 text-[#00D9B5]">OPFS / Blob Assembly</td>
                    <td className="py-2.5 font-mono text-white">5 GB</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-[#F5F7F8]">No Accounts, No File Servers</h2>
            <p>
              NexDrop runs entirely in your browser as a static PWA. There are no accounts, no subscriptions, and no database. One-scan pairing uses a lightweight ephemeral signaling service that carries only connection establishment data (session id, single-use token, SDP, ICE) and destroys the session as soon as the devices connect — it never sees file contents. Prefer no signaling at all? The manual QR / copy-paste fallback exchanges everything directly between the two screens. Direct connectivity depends on your browser and network; for the most reliable link, keep both devices on the same Wi-Fi.
            </p>
          </section>
        </div>

        <div className="mt-12 pt-8 border-t border-white/[0.08] text-center">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-lg bg-[#00F5A0] px-6 py-2.5 text-xs font-semibold text-[#070A0D] hover:bg-[#00D9B5] transition-colors"
          >
            Launch NexDrop
          </Link>
        </div>
      </main>
    </div>
  );
}
