'use client';

import React from 'react';
import Link from 'next/link';

export const Footer: React.FC = () => {
  return (
    <footer className="w-full border-t border-white/[0.08] bg-nd-bg-0 py-10 text-xs text-nd-text-secondary">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight text-nd-text-primary">NexDrop</span>
              <span className="text-white/45">/</span>
              <span className="text-xs text-nd-text-secondary">Local-First Utilities</span>
            </div>
            <p className="mt-1 text-xs text-nd-text-secondary">
              Private. Direct. Fast. Browser-to-browser P2P file and text sharing.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <a href="#how-it-works" className="hover:text-nd-text-primary transition-colors">
              How it works
            </a>
            <Link href="/security" className="hover:text-nd-text-primary transition-colors">
              Security
            </Link>
            <Link href="/privacy" className="hover:text-nd-text-primary transition-colors">
              Privacy
            </Link>
            <Link href="/about" className="hover:text-nd-text-primary transition-colors">
              About
            </Link>
            <a
              href="https://github.com"
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-nd-text-primary transition-colors"
            >
              GitHub
            </a>
            <span className="text-white/45 font-mono">v1.0.0</span>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-white/[0.04] flex flex-col sm:flex-row items-center justify-between gap-4 text-[11px] text-nd-text-secondary/80">
          <p>© {new Date().getFullYear()} NexDrop. Zero telemetry, zero tracking.</p>
          <p>Powered by WebRTC & Web Crypto API</p>
        </div>
      </div>
    </footer>
  );
};
