'use client';

import React from 'react';
import Link from 'next/link';

/**
 * Official NexDrop brand signature footer — shared identity with the
 * Android App and the 3D gateway. Presentation only; no transfer logic.
 */
export const Footer: React.FC = () => {
  return (
    <footer className="w-full border-t border-white/[0.08] bg-nd-bg-0 text-nd-text-secondary">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-4 py-10 text-center sm:px-6">
        {/* Wordmark */}
        <div className="text-base font-semibold tracking-tight text-nd-text-primary">
          Nex<span className="text-nd-teal-bright">Drop</span>
        </div>

        {/* Brand tagline */}
        <p
          className="text-[10px] uppercase text-nd-text-muted"
          style={{ letterSpacing: '0.32em' }}
        >
          Private · Direct · Fast
        </p>

        {/* Signature */}
        <div className="mt-2 flex flex-col items-center gap-1 text-[11px] leading-relaxed text-nd-text-secondary/80">
          <p>Crafted &amp; Developed by PKD</p>
          <p>© 2026 NexDrop. All rights reserved.</p>
        </div>

        {/* Thin divider */}
        <div className="mt-3 h-px w-16 bg-white/[0.08]" />

        {/* Existing destinations only */}
        <nav className="mt-3 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs">
          <Link href="/security" className="transition-colors hover:text-nd-text-primary">
            Security
          </Link>
          <Link href="/privacy" className="transition-colors hover:text-nd-text-primary">
            Privacy
          </Link>
          <Link href="/about" className="transition-colors hover:text-nd-text-primary">
            About
          </Link>
          <Link href="/app" className="transition-colors hover:text-nd-text-primary">
            App
          </Link>
          <a href="#/home" className="transition-colors hover:text-nd-text-primary">
            WebApp
          </a>
          <a
            href="https://github.com/PDFly-source/nexdrop"
            target="_blank"
            rel="noreferrer noopener"
            className="transition-colors hover:text-nd-text-primary"
          >
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
};
