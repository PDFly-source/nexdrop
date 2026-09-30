'use client';

import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { ClipboardWorkspace } from '@/components/clipboard/ClipboardWorkspace';
import { ClipboardSyncMessage, TextTransferMessage } from '@/types/transfer';

interface ClipboardOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  isConnected: boolean;
  peerName?: string;
  clipboardItems: ClipboardSyncMessage[];
  textMessages: TextTransferMessage[];
  onSendText: (text: string, category: 'plain' | 'code' | 'url' | 'json', lang?: string) => boolean;
  onSendClipboard: (content: string, category: 'plain' | 'code' | 'url' | 'json') => boolean;
  onPromptConnect: () => void;
}

/**
 * Full-screen sheet that reuses the existing ClipboardWorkspace unchanged —
 * text & clipboard sharing stays fully functional, now reachable from the
 * Home quick actions instead of a bottom-nav tab.
 */
export const ClipboardOverlay: React.FC<ClipboardOverlayProps> = ({
  isOpen,
  onClose,
  isConnected,
  peerName,
  clipboardItems,
  textMessages,
  onSendText,
  onSendClipboard,
  onPromptConnect,
}) => {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Close on Escape + trap initial focus for keyboard users
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Text and clipboard sharing"
    >
      {/* Backdrop */}
      <button
        aria-label="Close text and clipboard sharing"
        onClick={onClose}
        tabIndex={-1}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative w-full sm:max-w-4xl max-h-[92vh] sm:max-h-[88vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-white/[0.1] bg-nd-bg-0 shadow-2xl focus:outline-none"
      >
        {/* Sheet header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.08] bg-nd-bg-0/95 backdrop-blur-md px-4 sm:px-6 py-3">
          <div>
            <h2 className="text-sm font-semibold text-nd-text-primary">Text &amp; Clipboard</h2>
            <p className="text-[11px] text-nd-text-secondary mt-0.5">
              Send text, links, code and clipboard content directly to the connected device
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.1] bg-nd-surface text-nd-text-secondary hover:text-nd-text-primary hover:border-white/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
            aria-label="Close"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <ClipboardWorkspace
          isConnected={isConnected}
          peerName={peerName}
          clipboardItems={clipboardItems}
          textMessages={textMessages}
          onSendText={onSendText}
          onSendClipboard={onSendClipboard}
          onPromptConnect={onPromptConnect}
        />
      </div>
    </div>
  );
};
