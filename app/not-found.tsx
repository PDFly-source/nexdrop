import Link from 'next/link';
import { ArrowLeft, FileQuestion } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[#0B0D0F] text-[#F5F7F8] flex flex-col items-center justify-center p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#15191E] border border-white/10 mb-4 text-[#19C37D]">
        <FileQuestion className="w-7 h-7" />
      </div>

      <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-[#F5F7F8]">
        Page Not Found
      </h1>
      <p className="mt-2 text-xs sm:text-sm text-[#9AA3AD] max-w-sm">
        The page you are looking for doesn&apos;t exist or has expired. NexDrop sessions are ephemeral and private.
      </p>

      <Link
        href="/"
        className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[#19C37D] px-4 py-2 text-xs sm:text-sm font-medium text-[#0B0D0F] hover:bg-[#3DD6A0] transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Return to NexDrop</span>
      </Link>
    </div>
  );
}
