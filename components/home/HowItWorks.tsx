'use client';

import React from 'react';
import { ShieldCheck, Zap, KeyRound, HardDrive, Lock, RefreshCw, CheckCircle2 } from 'lucide-react';

export const HowItWorks: React.FC = () => {
  const steps = [
    {
      num: '01',
      title: 'Pair Devices Instantly',
      desc: 'Point your phone camera at the QR code on your laptop — one scan, then the host taps Accept. No accounts, sign-ins, or installs required.',
      icon: <KeyRound className="w-5 h-5 text-[#00F5A0]" />,
    },
    {
      num: '02',
      title: 'Direct WebRTC Tunnel',
      desc: 'Browsers establish a direct P2P connection via WebRTC. Signaling only coordinates the handshake—files never touch a server.',
      icon: <Lock className="w-5 h-5 text-[#00D9B5]" />,
    },
    {
      num: '03',
      title: 'Streamed in 64 KiB Chunks',
      desc: 'Files are read incrementally with File.slice(). Even a 10 GB file streams safely with real-time backpressure and ACK flow control.',
      icon: <Zap className="w-5 h-5 text-[#00F5A0]" />,
    },
    {
      num: '04',
      title: 'Direct Disk Saving & Verify',
      desc: 'Where supported, File System Access API writes directly to your hard drive with SHA-256 verification and automatic object release.',
      icon: <HardDrive className="w-5 h-5 text-[#00D9B5]" />,
    },
  ];

  return (
    <section id="how-it-works" className="py-14 md:py-20 border-b border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl text-left">
          <p className="text-xs font-semibold uppercase tracking-wider text-[#00F5A0]">
            Architecture & Privacy
          </p>
          <h2 className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight text-[#F5F7F8]">
            How NexDrop transfers files
          </h2>
          <p className="mt-3 text-sm text-[#9AA7AE] leading-relaxed">
            Built from first principles for total device sovereignty. All data flows exclusively between paired browsers over authenticated WebRTC DataChannels.
          </p>
        </div>

        {/* 4 Steps Grid */}
        <div className="mt-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {steps.map((s) => (
            <div
              key={s.num}
              className="rounded-xl border border-white/[0.08] bg-[#11171B] p-5 text-left flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0B0F12] border border-white/[0.06]">
                    {s.icon}
                  </div>
                  <span className="font-mono text-xs text-[#9AA7AE]">{s.num}</span>
                </div>

                <h3 className="mt-4 text-sm font-semibold text-[#F5F7F8]">
                  {s.title}
                </h3>
                <p className="mt-2 text-xs text-[#9AA7AE] leading-relaxed">
                  {s.desc}
                </p>
              </div>

              <div className="mt-4 pt-3 border-t border-white/[0.04] flex items-center gap-1.5 text-[11px] text-[#00D9B5]">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Zero Cloud Storage</span>
              </div>
            </div>
          ))}
        </div>

        {/* Comparison Table / Trust Pillars */}
        <div className="mt-12 rounded-xl border border-white/[0.08] bg-[#0B0F12] p-6 text-left">
          <h3 className="text-base font-semibold text-[#F5F7F8] mb-4">
            Cloud Upload Services vs. NexDrop
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-xs">
            <div className="space-y-1.5">
              <p className="font-semibold text-[#F5F7F8]">No Account or Registration</p>
              <p className="text-[#9AA7AE] leading-relaxed">
                Traditional cloud tools require emails, passwords, and phone numbers. NexDrop requires zero sign-up. Open the browser and share.
              </p>
            </div>

            <div className="space-y-1.5">
              <p className="font-semibold text-[#F5F7F8]">Zero Server Storage</p>
              <p className="text-[#9AA7AE] leading-relaxed">
                Your private files, photos, and code never sit in an S3 bucket or cloud database. Files travel strictly device-to-device.
              </p>
            </div>

            <div className="space-y-1.5">
              <p className="font-semibold text-[#F5F7F8]">Direct LAN & P2P Speeds</p>
              <p className="text-[#9AA7AE] leading-relaxed">
                When devices are on the same Wi-Fi or local network, WebRTC routes packets directly over LAN at full hardware network bandwidth.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
