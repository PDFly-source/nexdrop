'use client';

import React from 'react';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark bg-[#070A0D] text-[#F5F7F8]">
      <body className="bg-[#070A0D] text-[#F5F7F8] antialiased min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md text-center">
          <h2 className="text-lg font-semibold mb-2">Something went wrong</h2>
          <p className="text-xs text-[#9AA7AE] mb-4">A critical error occurred while loading the workspace.</p>
          <button
            onClick={() => reset()}
            className="px-4 py-2 bg-[#00F5A0] text-[#070A0D] rounded-lg text-xs font-medium hover:bg-[#00D9B5] transition-colors"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
