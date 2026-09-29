'use client';

import React from 'react';
import { ArrowDown, ArrowRight, Laptop, Smartphone, ShieldCheck, Lock } from 'lucide-react';

interface HeroProps {
  onSendClick: () => void;
  onReceiveClick: () => void;
  isConnected: boolean;
}

export const Hero: React.FC<HeroProps> = ({ onSendClick, onReceiveClick, isConnected }) => {
  return (
    <section className="relative overflow-hidden pt-12 pb-10 md:pt-16 md:pb-14 border-b border-white/[0.06]">
      {/* Background ambient gradient glow - very subtle */}
      <div
        className="pointer-events-none absolute inset-0 opacity-20"
        style={{
          background:
            'radial-gradient(ellipse 60% 40% at 50% -10%, rgba(25, 195, 125, 0.15), transparent 70%)',
        }}
      />

      <div className="relative mx-auto max-w-4xl px-4 text-center sm:px-6">
        {/* Subtle kicker line */}
        <div className="inline-flex items-center gap-2 text-xs font-medium text-[#19C37D] mb-4">
          <span className="h-1.5 w-1.5 rounded-full bg-[#19C37D]" />
          <span>Private by design · Powered by WebRTC</span>
        </div>

        {/* Main Headline */}
        <h1 className="text-3xl sm:text-5xl md:text-6xl font-semibold tracking-tight text-[#F5F7F8] max-w-3xl mx-auto text-balance leading-tight">
          Share directly. <br className="hidden sm:inline" />
          <span className="text-[#9AA3AD]">Keep it private.</span>
        </h1>

        {/* Supporting description */}
        <p className="mt-4 text-sm sm:text-base text-[#9AA3AD] max-w-xl mx-auto leading-relaxed">
          Transfer files, photos, videos, documents and text directly between your devices using peer-to-peer technology.
        </p>

        {/* CTAs */}
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={onSendClick}
            className="flex items-center gap-2 rounded-lg bg-[#19C37D] px-5 py-2.5 text-xs sm:text-sm font-medium text-[#0B0D0F] hover:bg-[#3DD6A0] transition-colors shadow-sm"
          >
            <span>Send Files</span>
            <ArrowRight className="w-4 h-4" />
          </button>

          <button
            onClick={onReceiveClick}
            className="flex items-center gap-2 rounded-lg border border-white/[0.12] bg-[#15191E] px-5 py-2.5 text-xs sm:text-sm font-medium text-[#F5F7F8] hover:bg-white/[0.08] hover:border-white/20 transition-colors"
          >
            <ArrowDown className="w-4 h-4 text-[#9AA3AD]" />
            <span>Receive Files</span>
          </button>
        </div>

        {/* Trust line */}
        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-[#9AA3AD]/80">
          <span>No account</span>
          <span className="text-white/20">·</span>
          <span>No cloud upload</span>
          <span className="text-white/20">·</span>
          <span>Direct P2P</span>
        </div>

        {/* Subtle animated connection visualization: Device A -> encrypted tunnel -> Device B */}
        <div className="mt-10 mx-auto max-w-md rounded-xl border border-white/[0.08] bg-[#111418] p-3 sm:p-4">
          <div className="flex items-center justify-between gap-3 text-xs">
            {/* Device A */}
            <div className="flex items-center gap-2 rounded-lg bg-[#15191E] border border-white/[0.06] px-3 py-2">
              <Laptop className="w-4 h-4 text-[#9AA3AD]" />
              <div className="text-left">
                <p className="font-medium text-[#F5F7F8] text-[11px] leading-tight">Device A</p>
                <p className="text-[10px] text-[#9AA3AD] leading-tight">Sender</p>
              </div>
            </div>

            {/* Connection Channel Flow */}
            <div className="flex-1 flex flex-col items-center">
              <div className="flex items-center gap-1 text-[10px] text-[#19C37D] font-mono">
                <Lock className="w-2.5 h-2.5" />
                <span>E2E Encrypted</span>
              </div>
              <div className="w-full relative flex items-center justify-center mt-1">
                <div className="w-full h-[1.5px] bg-white/[0.08] rounded-full overflow-hidden">
                  <div
                    className={`h-full bg-gradient-to-r from-transparent via-[#19C37D] to-transparent ${
                      isConnected ? 'w-full animate-pulse' : 'w-24 animate-[pulse_2s_infinite]'
                    }`}
                  />
                </div>
              </div>
              <span className="text-[9px] text-[#9AA3AD] mt-1 font-mono">DataChannel</span>
            </div>

            {/* Device B */}
            <div className="flex items-center gap-2 rounded-lg bg-[#15191E] border border-white/[0.06] px-3 py-2">
              <Smartphone className="w-4 h-4 text-[#9AA3AD]" />
              <div className="text-left">
                <p className="font-medium text-[#F5F7F8] text-[11px] leading-tight">Device B</p>
                <p className="text-[10px] text-[#9AA3AD] leading-tight">Receiver</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
