import Link from 'next/link';
import { ArrowLeft, FileQuestion } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-nd-bg-0 text-nd-text-primary flex flex-col items-center justify-center p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-nd-surface border border-white/10 mb-4 text-nd-teal">
        <FileQuestion className="w-7 h-7" />
      </div>

      <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-nd-text-primary">
        Page Not Found
      </h1>
      <p className="mt-2 text-xs sm:text-sm text-nd-text-secondary max-w-sm">
        The page you are looking for doesn&apos;t exist or has expired. NexDrop sessions are ephemeral and private.
      </p>

      <Link
        href="/"
        className="mt-6 inline-flex items-center gap-2 rounded-lg bg-nd-teal px-4 py-2 text-xs sm:text-sm font-medium text-nd-bg-0 hover:bg-nd-teal-bright transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Return to NexDrop</span>
      </Link>
    </div>
  );
}
