'use client';

import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

interface RevealProps {
  children: React.ReactNode;
  className?: string;
  /** Extra transition delay in ms for subtle staggering. */
  delay?: number;
  as?: 'div' | 'section';
}

/**
 * One-shot scroll reveal. The element starts hidden via .nd-reveal and flips
 * to visible the first time it enters the viewport (IntersectionObserver).
 * Falls back to instantly-visible when IO is unavailable, and the global
 * prefers-reduced-motion rule disables the transition entirely.
 */
export const Reveal: React.FC<RevealProps> = ({ children, className, delay, as = 'div' }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  // Always starts hidden — identical on the prerendered static shell and
  // on hydration, so there is no hydration mismatch.
  const [visible, setVisible] = useState<boolean>(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      // No observer available (extremely old browsers): reveal immediately
      // via an imperative class flip — content must never stay hidden.
      el.classList.add('nd-reveal-visible');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { threshold: 0.05 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  const Tag = as as 'div';

  return (
    <Tag
      ref={ref}
      className={clsx('nd-reveal', visible && 'nd-reveal-visible', className)}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
};
