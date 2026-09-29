'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCcw, Home } from 'lucide-react';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('App error boundary caught:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[#0B0D0F] text-[#F5F7F8] flex flex-col items-center justify-center p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20 mb-4 text-[#F59E0B]">
        <AlertTriangle className="w-7 h-7" />
      </div>

      <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-[#F5F7F8]">
        Something went wrong
      </h1>
      <p className="mt-2 text-xs sm:text-sm text-[#9AA3AD] max-w-sm">
        An unexpected error occurred during the session. Peer connections remain secure.
      </p>

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={() => reset()}
          className="inline-flex items-center gap-2 rounded-lg bg-[#19C37D] px-4 py-2 text-xs sm:text-sm font-medium text-[#0B0D0F] hover:bg-[#3DD6A0] transition-colors"
        >
          <RotateCcw className="w-4 h-4" />
          <span>Try again</span>
        </button>

        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-[#15191E] px-4 py-2 text-xs sm:text-sm font-medium text-[#F5F7F8] hover:bg-white/10 transition-colors"
        >
          <Home className="w-4 h-4 text-[#9AA3AD]" />
          <span>Home</span>
        </Link>
      </div>
    </div>
  );
}
