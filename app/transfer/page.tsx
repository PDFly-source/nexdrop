'use client';

import React, { useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Radio } from 'lucide-react';

function TransferAutoJoin() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const pin = searchParams.get('pin');
    const session = searchParams.get('session');
    const token = searchParams.get('token');

    if (pin) {
      router.replace(`/?pin=${encodeURIComponent(pin)}`);
    } else if (session) {
      router.replace(`/?session=${encodeURIComponent(session)}${token ? `&token=${encodeURIComponent(token)}` : ''}`);
    } else {
      router.replace('/');
    }
  }, [router, searchParams]);

  return (
    <div className="min-h-screen bg-[#0B0D0F] flex flex-col items-center justify-center text-center p-4">
      <Radio className="w-8 h-8 text-[#19C37D] animate-pulse mb-3" />
      <h2 className="text-sm font-semibold text-[#F5F7F8]">Connecting to NexDrop Session...</h2>
      <p className="mt-1 text-xs text-[#9AA3AD]">Negotiating peer-to-peer WebRTC connection</p>
      <Link href="/" className="mt-4 text-xs text-[#19C37D] underline">
        Go to home
      </Link>
    </div>
  );
}

export default function TransferPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#0B0D0F] flex items-center justify-center text-xs text-[#9AA3AD]">
          Loading NexDrop...
        </div>
      }
    >
      <TransferAutoJoin />
    </Suspense>
  );
}
