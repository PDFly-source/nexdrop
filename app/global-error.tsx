'use client';

import React from 'react';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark bg-nd-bg-0 text-nd-text-primary">
      <body className="bg-nd-bg-0 text-nd-text-primary antialiased min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md text-center">
          <h2 className="text-lg font-semibold mb-2">Something went wrong</h2>
          <p className="text-xs text-nd-text-secondary mb-4">A critical error occurred while loading the workspace.</p>
          <button
            onClick={() => reset()}
            className="px-4 py-2 bg-nd-teal text-nd-bg-0 rounded-lg text-xs font-medium hover:bg-nd-teal-bright transition-colors"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
