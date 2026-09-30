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
    <div className="min-h-screen bg-nd-bg-0 text-nd-text-primary flex flex-col items-center justify-center p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-nd-warning/10 border border-nd-warning/20 mb-4 text-nd-warning">
        <AlertTriangle className="w-7 h-7" />
      </div>

      <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-nd-text-primary">
        Something went wrong
      </h1>
      <p className="mt-2 text-xs sm:text-sm text-nd-text-secondary max-w-sm">
        An unexpected error occurred during the session. Peer connections remain secure.
      </p>

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={() => reset()}
          className="inline-flex items-center gap-2 rounded-lg bg-nd-teal px-4 py-2 text-xs sm:text-sm font-medium text-nd-bg-0 hover:bg-nd-teal-bright transition-colors"
        >
          <RotateCcw className="w-4 h-4" />
          <span>Try again</span>
        </button>

        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-nd-surface px-4 py-2 text-xs sm:text-sm font-medium text-nd-text-primary hover:bg-white/10 transition-colors"
        >
          <Home className="w-4 h-4 text-nd-text-secondary" />
          <span>Home</span>
        </Link>
      </div>
    </div>
  );
}
