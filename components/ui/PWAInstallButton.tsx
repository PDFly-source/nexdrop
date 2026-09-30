'use client';

import React, { useState } from 'react';
import { usePWAInstall } from '@/hooks/usePWAInstall';
import { Download, Share } from 'lucide-react';

export const PWAInstallButton: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button
        onClick={install}
        className={`flex items-center gap-1.5 rounded-lg border border-nd-success/30 bg-nd-success/10 px-3 py-1.5 text-xs font-medium text-nd-teal-bright hover:bg-nd-success/20 transition-colors whitespace-nowrap`}
        title="Install NexDrop PWA"
      >
        <Download className="w-3.5 h-3.5" />
        <span>{compact ? 'Install' : 'Install NexDrop'}</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          onClick={() => setShowIOSGuide(true)}
          className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-nd-text-secondary hover:text-nd-text-primary hover:bg-white/10 transition-colors whitespace-nowrap"
        >
          <Share className="w-3 h-3" />
          <span>Install PWA</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="w-full max-w-sm rounded-xl border border-white/10 bg-nd-surface p-6 shadow-2xl text-left">
              <h3 className="text-base font-semibold text-nd-text-primary">Install NexDrop on iOS</h3>
              <p className="mt-3 text-xs text-nd-text-secondary leading-relaxed">
                1. Tap the <strong className="text-white">Share</strong> button in your Safari toolbar.<br />
                2. Scroll down and select <strong className="text-white">Add to Home Screen</strong>.<br />
                3. Launch NexDrop directly from your home screen for full offline capability.
              </p>
              <button
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full rounded-lg bg-nd-surface-elevated py-2 text-xs font-medium text-nd-text-primary hover:bg-white/10 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
