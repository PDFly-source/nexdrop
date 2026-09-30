'use client';

import React, { useEffect, useState, useSyncExternalStore } from 'react';

const ONBOARDING_KEY = 'nexdrop_onboarded_v1';

const emptySubscribe = () => () => {};

/**
 * Premium first-launch experience. Shows exactly once per browser
 * (localStorage flag). Returning users are never forced through it again.
 * Respects prefers-reduced-motion via the global CSS override.
 */
export const OnboardingOverlay: React.FC = () => {
  // First-launch check, hydration-safe: read on the client only. If storage
  // is unavailable (private mode) we never block the app behind onboarding.
  const needsOnboarding = useSyncExternalStore(
    emptySubscribe,
    () => {
      try {
        return !localStorage.getItem(ONBOARDING_KEY);
      } catch {
        return false;
      }
    },
    () => false
  );

  const [dismissed, setDismissed] = useState<boolean>(false);
  const visible = needsOnboarding && !dismissed;

  const handleGetStarted = () => {
    try {
      localStorage.setItem(ONBOARDING_KEY, '1');
    } catch {
      // best-effort; even without storage we dismiss for this session
    }
    setDismissed(true);
  };

  // Enter/Space also dismisses (onboarding must never trap a returning user)
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') handleGetStarted();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-nd-bg-0"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to NexDrop"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.12]"
        style={{
          background: 'radial-gradient(ellipse 60% 40% at 50% 0%, rgba(24, 184, 166, 0.6), transparent 70%)',
        }}
      />

      <div className="relative mx-6 flex max-w-sm flex-col items-center text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
        {/* Logo */}
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-nd-surface border border-white/10 animate-in zoom-in duration-500">
          <svg viewBox="0 0 24 24" className="w-8 h-8 fill-none stroke-nd-teal stroke-[2]">
            <path d="M7 10l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 5v14" strokeLinecap="round" />
            <path d="M17 14l-5 5-5-5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 3" />
          </svg>
        </div>

        {/* Brand */}
        <h2 className="mt-5 text-2xl font-semibold tracking-tight text-nd-text-primary animate-in fade-in duration-700">
          NexDrop
        </h2>
        <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-nd-teal animate-in fade-in duration-700">
          Private · Direct · Fast
        </p>

        {/* Statement */}
        <p className="mt-4 text-sm text-nd-text-primary/90 leading-relaxed animate-in fade-in duration-700">
          Share files &amp; text directly between your devices.
        </p>
        <p className="mt-1.5 text-xs text-nd-text-secondary leading-relaxed animate-in fade-in duration-700">
          Private by design. No cloud file uploads — transfers travel directly over encrypted WebRTC DataChannels.
        </p>

        {/* CTA */}
        <button
          onClick={handleGetStarted}
          className="mt-7 w-full rounded-xl bg-nd-teal px-6 py-3 text-sm font-semibold text-nd-bg-0 hover:bg-nd-teal-bright active:scale-[0.98] transition-all min-h-[44px] shadow-sm animate-in fade-in duration-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal focus-visible:ring-offset-2 focus-visible:ring-offset-nd-bg-0"
        >
          Get Started
        </button>
      </div>
    </div>
  );
};
