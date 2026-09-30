'use client';

import React, { useState } from 'react';
import {
  Clipboard,
  Send,
  Copy,
  Check,
  ExternalLink,
  Code2,
  Sparkles,
  Download,
  Terminal,
  FileCode,
  Globe,
  Trash2,
  Lock,
} from 'lucide-react';
import { copyToClipboard, readFromClipboard, detectContentCategory } from '@/lib/clipboard';
import { ClipboardSyncMessage, TextTransferMessage } from '@/types/transfer';
import { formatTimestamp } from '@/lib/utils/format';

interface ClipboardWorkspaceProps {
  isConnected: boolean;
  peerName?: string;
  clipboardItems: ClipboardSyncMessage[];
  textMessages: TextTransferMessage[];
  onSendText: (text: string, category: 'plain' | 'code' | 'url' | 'json', lang?: string) => boolean;
  onSendClipboard: (content: string, category: 'plain' | 'code' | 'url' | 'json') => boolean;
  onPromptConnect: () => void;
}

export const ClipboardWorkspace: React.FC<ClipboardWorkspaceProps> = ({
  isConnected,
  peerName,
  clipboardItems,
  textMessages,
  onSendText,
  onSendClipboard,
  onPromptConnect,
}) => {
  const [inputText, setInputText] = useState<string>('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const detected = detectContentCategory(inputText);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    onSendText(inputText, detected.category, detected.language);
    setInputText('');
  };

  const handlePasteFromDevice = async () => {
    const text = await readFromClipboard();
    if (text) {
      const cat = detectContentCategory(text);
      onSendClipboard(text, cat.category);
    }
  };

  const handleCopyItem = async (id: string, text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  const handleDownloadSnippet = (text: string, filename: string = 'snippet.txt') => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Combine sent and received items into one reverse-chronological list
  const combinedItems = [
    ...textMessages.map((m) => ({
      id: m.id,
      content: m.text,
      category: m.category,
      language: m.language,
      timestamp: m.timestamp,
      direction: 'sent' as const,
    })),
    ...clipboardItems.map((c) => ({
      id: c.id,
      content: c.content,
      category: c.category,
      timestamp: c.timestamp,
      direction: 'received' as const,
    })),
  ].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 space-y-6 text-left">
      {/* Workspace Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/[0.08]">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-semibold text-nd-text-primary">Instant Clipboard &amp; Code</h1>
            <span className="text-[11px] font-medium text-nd-success/90 bg-nd-success/10 px-2.5 py-0.5 rounded-full border border-nd-success/20">
              Encrypted DataChannel
            </span>
          </div>
          <p className="text-xs text-nd-text-secondary mt-1">
            Share snippets, URLs, JSON, and system commands directly between your paired devices with zero cloud storage.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handlePasteFromDevice}
            disabled={!isConnected}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/[0.1] bg-nd-surface text-xs text-nd-text-primary hover:bg-white/[0.08] hover:border-white/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm"
          >
            <Clipboard className="w-3.5 h-3.5 text-nd-teal" />
            <span>Paste from Device</span>
          </button>
        </div>
      </div>

      {/* Connection Notice if Disconnected */}
      {!isConnected && (
        <div className="rounded-xl border border-nd-warning/20 bg-nd-warning/10 p-4 flex items-center justify-between gap-3 text-xs text-nd-warning">
          <div className="flex items-center gap-2.5">
            <Lock className="w-4 h-4 text-nd-warning shrink-0" />
            <span>No peer device connected. Connect a device in Transfer workspace to enable live clipboard sync.</span>
          </div>
          <button
            onClick={onPromptConnect}
            className="px-3 py-1.5 rounded-lg bg-nd-warning text-nd-bg-0 font-semibold hover:bg-nd-warning transition-colors shrink-0"
          >
            Connect
          </button>
        </div>
      )}

      {/* Compose & Send Box */}
      <div className="rounded-2xl border border-white/[0.08] bg-nd-surface p-5 shadow-sm">
        <form onSubmit={handleSend} className="space-y-4">
          <div className="relative">
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Type or paste code, links, notes, or credentials to share directly..."
              rows={5}
              disabled={!isConnected}
              className="w-full rounded-xl border border-white/[0.08] bg-nd-bg-1 p-4 text-xs sm:text-sm font-mono text-nd-text-primary placeholder:text-nd-text-secondary/80 focus:border-nd-teal focus:outline-none focus:ring-1 focus:ring-nd-teal disabled:opacity-50 transition-all resize-y min-h-[120px]"
            />

            {inputText.trim() && (
              <div className="absolute top-3 right-3 flex items-center gap-1.5 text-[10px] font-mono px-2 py-0.5 rounded bg-white/[0.08] text-nd-teal-bright border border-white/[0.06]">
                <Sparkles className="w-3 h-3" />
                <span className="capitalize">{detected.category}</span>
                {detected.language && <span>· {detected.language}</span>}
              </div>
            )}
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
            <div className="flex items-center gap-2 text-[11px] text-nd-text-secondary">
              <span className="h-1.5 w-1.5 rounded-full bg-nd-teal" />
              <span>Target: {isConnected ? peerName || 'Connected Device' : 'Not Connected'}</span>
            </div>

            <div className="flex items-center gap-2">
              {inputText.trim() && (
                <button
                  type="button"
                  onClick={() => setInputText('')}
                  className="px-3 py-2 rounded-xl text-xs text-nd-text-secondary hover:text-nd-text-primary transition-colors"
                >
                  Clear
                </button>
              )}

              <button
                type="submit"
                disabled={!isConnected || !inputText.trim()}
                className="flex items-center gap-2 rounded-xl bg-nd-teal px-5 py-2.5 text-xs font-semibold text-nd-bg-0 hover:bg-nd-teal-bright disabled:cursor-not-allowed disabled:bg-nd-surface-elevated disabled:text-nd-text-secondary transition-all shadow-sm"
              >
                <span>Send to Device</span>
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Shared Items History */}
      <div className="rounded-2xl border border-white/[0.08] bg-nd-surface p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-nd-text-primary">Shared Stream</h2>
            <span className="text-xs text-nd-text-secondary">({combinedItems.length} items)</span>
          </div>
        </div>

        {combinedItems.length === 0 ? (
          <div className="py-12 text-center text-xs text-nd-text-secondary/80">
            <Clipboard className="w-8 h-8 mx-auto mb-2 text-nd-text-secondary/30" />
            <p className="font-medium text-nd-text-secondary">No clipboard activity in this session</p>
            <p className="text-[11px] mt-1 text-nd-text-secondary/80">
              Text, code, or links sent between devices will appear here instantly.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {combinedItems.map((item) => (
              <div
                key={item.id}
                className="rounded-xl border border-white/[0.06] bg-nd-bg-1 p-4 text-xs transition-colors hover:border-white/10"
              >
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/[0.04]">
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
                        item.direction === 'sent'
                          ? 'bg-nd-teal/10 text-nd-teal border border-nd-teal/20'
                          : 'bg-nd-success/10 text-nd-teal-bright border border-nd-success/20'
                      }`}
                    >
                      {item.direction === 'sent' ? 'Sent' : 'Received'}
                    </span>

                    <span className="text-[11px] font-mono text-nd-text-secondary">
                      {item.category === 'code' && <Code2 className="w-3 h-3 inline mr-1 text-nd-coral" />}
                      {item.category === 'url' && <Globe className="w-3 h-3 inline mr-1 text-nd-teal-bright" />}
                      <span className="capitalize">{item.category}</span>
                      {'language' in item && item.language && <span> ({item.language})</span>}
                    </span>

                    <span className="text-white/45">·</span>
                    <span className="text-[10px] text-nd-text-secondary/80 font-mono">
                      {formatTimestamp(item.timestamp)}
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    {item.category === 'url' && (
                      <a
                        href={item.content}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="flex items-center gap-1 px-2 py-1 rounded bg-white/[0.04] text-[11px] text-nd-text-secondary hover:text-nd-text-primary hover:bg-white/[0.08] transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" />
                        <span>Open</span>
                      </a>
                    )}

                    <button
                      onClick={() => handleDownloadSnippet(item.content, `snippet_${item.id.slice(0, 6)}.txt`)}
                      className="flex items-center gap-1 px-2 py-1 rounded bg-white/[0.04] text-[11px] text-nd-text-secondary hover:text-nd-text-primary hover:bg-white/[0.08] transition-colors"
                      title="Download as file"
                    >
                      <Download className="w-3 h-3" />
                    </button>

                    <button
                      onClick={() => handleCopyItem(item.id, item.content)}
                      className="flex items-center gap-1 px-2 py-1 rounded bg-white/[0.04] text-[11px] text-nd-text-secondary hover:text-nd-teal hover:bg-white/[0.08] transition-colors"
                    >
                      {copiedId === item.id ? (
                        <>
                          <Check className="w-3 h-3 text-nd-teal" />
                          <span className="text-nd-teal">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Content Display */}
                {item.category === 'code' ? (
                  <pre className="p-3 rounded-lg bg-nd-bg-0 font-mono text-xs text-nd-text-primary overflow-x-auto border border-white/[0.04] leading-relaxed">
                    <code>{item.content}</code>
                  </pre>
                ) : item.category === 'url' ? (
                  <p className="font-mono text-xs text-nd-teal-bright break-all select-all">
                    {item.content}
                  </p>
                ) : (
                  <p className="text-xs text-nd-text-primary whitespace-pre-wrap break-words leading-relaxed">
                    {item.content}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
