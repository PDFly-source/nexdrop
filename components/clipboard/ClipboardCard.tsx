'use client';

import React, { useState } from 'react';
import {
  Clipboard,
  Send,
  Copy,
  Check,
  ExternalLink,
  Code2,
  Layers,
  ArrowUpRight,
} from 'lucide-react';
import { copyToClipboard, readFromClipboard, detectContentCategory } from '@/lib/clipboard';
import { ClipboardSyncMessage, TextTransferMessage } from '@/types/transfer';

interface ClipboardCardProps {
  isConnected: boolean;
  clipboardItems: ClipboardSyncMessage[];
  textMessages: TextTransferMessage[];
  onSendText: (text: string, category: 'plain' | 'code' | 'url' | 'json', lang?: string) => boolean;
  onSendClipboard: (content: string, category: 'plain' | 'code' | 'url' | 'json') => boolean;
}

export const ClipboardCard: React.FC<ClipboardCardProps> = ({
  isConnected,
  clipboardItems,
  textMessages,
  onSendText,
  onSendClipboard,
}) => {
  const [inputText, setInputText] = useState<string>('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    const { category, language } = detectContentCategory(inputText);
    onSendText(inputText, category, language);
    setInputText('');
  };

  const handlePasteFromDevice = async () => {
    const text = await readFromClipboard();
    if (text) {
      const { category } = detectContentCategory(text);
      onSendClipboard(text, category);
    }
  };

  const handleCopyItem = async (id: string, text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  // Combine clipboard sync items and text messages
  const allItems = [
    ...clipboardItems.map((c) => ({
      id: c.id,
      text: c.content,
      category: c.category,
      timestamp: c.timestamp,
      source: 'clipboard',
    })),
    ...textMessages.map((t) => ({
      id: t.id,
      text: t.text,
      category: t.category,
      language: t.language,
      timestamp: t.timestamp,
      source: 'text',
    })),
  ].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#15191E] p-5 shadow-sm flex flex-col h-full">
      <div className="flex items-center justify-between pb-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <Clipboard className="w-4 h-4 text-[#19C37D]" />
          <h2 className="text-sm font-semibold text-[#F5F7F8]">Instant Clipboard & Text</h2>
        </div>

        <button
          onClick={handlePasteFromDevice}
          disabled={!isConnected}
          className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#1B2026] px-2.5 py-1 text-xs text-[#F5F7F8] hover:bg-white/10 disabled:opacity-40 transition-colors"
          title="Push your current system clipboard to peer"
        >
          <span>Sync My Clipboard</span>
        </button>
      </div>

      {/* Quick Input Bar */}
      <form onSubmit={handleSend} className="mt-4 flex gap-2">
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={isConnected ? 'Type message, URL, or paste code snippet...' : 'Connect a device to share text...'}
          disabled={!isConnected}
          className="flex-1 rounded-lg border border-white/[0.1] bg-[#111418] px-3.5 py-2 text-xs text-[#F5F7F8] placeholder:text-[#9AA3AD]/40 focus:border-[#19C37D] focus:outline-none disabled:opacity-40"
        />
        <button
          type="submit"
          disabled={!isConnected || !inputText.trim()}
          className="flex items-center justify-center rounded-lg bg-[#19C37D] px-3.5 py-2 text-xs font-semibold text-[#0B0D0F] hover:bg-[#3DD6A0] disabled:opacity-40 transition-colors shrink-0"
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </form>

      {/* Received Items Feed */}
      <div className="mt-4 flex-1 flex flex-col min-h-36">
        {allItems.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center rounded-lg border border-dashed border-white/[0.04] p-6 text-center text-xs text-[#9AA3AD]/60">
            <span>No text or clipboard items synced yet</span>
            <span className="text-[11px] mt-0.5">
              Copy something on your phone or laptop to transfer instantly
            </span>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto max-h-60 space-y-2 pr-1">
            {allItems.map((item) => {
              const { category, language } = detectContentCategory(item.text);

              return (
                <div
                  key={item.id}
                  className="rounded-lg border border-white/[0.06] bg-[#111418] p-3 text-xs text-left"
                >
                  <div className="flex items-center justify-between pb-1.5 border-b border-white/[0.04] text-[11px] text-[#9AA3AD]">
                    <div className="flex items-center gap-1.5">
                      {category === 'code' ? (
                        <span className="text-blue-400 font-mono">Code {language ? `(${language})` : ''}</span>
                      ) : category === 'url' ? (
                        <span className="text-emerald-400">URL Link</span>
                      ) : (
                        <span>Text</span>
                      )}
                    </div>

                    <button
                      onClick={() => handleCopyItem(item.id, item.text)}
                      className="flex items-center gap-1 text-[#9AA3AD] hover:text-[#F5F7F8] transition-colors"
                      title="Copy to clipboard"
                    >
                      {copiedId === item.id ? (
                        <>
                          <Check className="w-3 h-3 text-[#22C55E]" />
                          <span className="text-[10px] text-[#22C55E]">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span className="text-[10px]">Copy</span>
                        </>
                      )}
                    </button>
                  </div>

                  {category === 'url' ? (
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <a
                        href={item.text}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="truncate text-[#19C37D] hover:underline"
                      >
                        {item.text}
                      </a>
                      <a
                        href={item.text}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[#9AA3AD] hover:text-white shrink-0"
                      >
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  ) : category === 'code' ? (
                    <pre className="mt-2 overflow-x-auto rounded bg-[#0B0D0F] p-2 font-mono text-[11px] text-[#F5F7F8]/90">
                      <code>{item.text}</code>
                    </pre>
                  ) : (
                    <p className="mt-2 text-[#F5F7F8] whitespace-pre-wrap break-words">
                      {item.text}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
