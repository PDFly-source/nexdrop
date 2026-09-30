'use client';

import React, { useState } from 'react';
import {
  AlertCircle,
  History,
  Trash2,
  Search,
  ArrowUpRight,
  ArrowDownLeft,
  FileCheck,
  Shield,
  File,
  HardDrive,
  Download,
} from 'lucide-react';
import { LocalHistoryItem } from '@/types/transfer';
import { formatBytes, formatTimestamp } from '@/lib/utils/format';

interface HistoryWorkspaceProps {
  historyItems: LocalHistoryItem[];
  onClearHistory: () => void;
  onNavigateTransfer: () => void;
}

export const HistoryWorkspace: React.FC<HistoryWorkspaceProps> = ({
  historyItems,
  onClearHistory,
  onNavigateTransfer,
}) => {
  const [filter, setFilter] = useState<'all' | 'sent' | 'received'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'failed' | 'cancelled'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [confirmClear, setConfirmClear] = useState<boolean>(false);

  const filteredItems = historyItems
    .filter((item) => {
      if (filter === 'sent') return item.direction === 'sent';
      if (filter === 'received') return item.direction === 'received';
      return true;
    })
    .filter((item) => {
      if (statusFilter === 'all') return true;
      return item.status === statusFilter;
    })
    .filter((item) => item.name.toLowerCase().includes(searchQuery.toLowerCase()));

  const totalBytesTransferred = historyItems.reduce((acc, item) => acc + item.size, 0);

  return (
    <div className="space-y-6 text-left">
      {/* Workspace Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/[0.08]">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-semibold text-nd-text-primary">Transfer History</h1>
            <span className="text-[11px] font-medium text-nd-success/90 bg-nd-success/10 px-2.5 py-0.5 rounded-full border border-nd-success/20">
              Local Browser Only
            </span>
          </div>
          <p className="text-xs text-nd-text-secondary mt-1">
            Audit logs of completed peer-to-peer transfers. No file contents or logs are ever uploaded to any server.
          </p>
        </div>

        {historyItems.length > 0 && (
          <div className="flex items-center gap-2">
            {confirmClear ? (
              <div className="flex items-center gap-2 animate-in fade-in duration-150">
                <span className="text-xs text-nd-error">Clear all records?</span>
                <button
                  onClick={() => {
                    onClearHistory();
                    setConfirmClear(false);
                  }}
                  className="px-2.5 py-1.5 rounded-lg bg-nd-error text-xs font-medium text-white hover:bg-nd-error transition-colors"
                >
                  Yes, Clear
                </button>
                <button
                  onClick={() => setConfirmClear(false)}
                  className="px-2.5 py-1.5 rounded-lg bg-white/[0.06] text-xs text-nd-text-secondary hover:text-nd-text-primary transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmClear(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-white/[0.1] bg-nd-surface text-xs text-nd-text-secondary hover:text-nd-error hover:border-nd-error/30 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear History</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border border-white/[0.06] bg-nd-surface p-4">
          <span className="text-[11px] text-nd-text-secondary font-medium">Total Transfers</span>
          <div className="text-2xl font-bold text-nd-text-primary mt-1">{historyItems.length}</div>
          <span className="text-[10px] text-nd-text-secondary/80">Session lifetime records</span>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-nd-surface p-4">
          <span className="text-[11px] text-nd-text-secondary font-medium">Total Volume</span>
          <div className="text-2xl font-bold text-nd-teal mt-1">{formatBytes(totalBytesTransferred)}</div>
          <span className="text-[10px] text-nd-text-secondary/80">Streamed peer-to-peer</span>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-nd-surface p-4">
          <span className="text-[11px] text-nd-text-secondary font-medium">Privacy Architecture</span>
          <div className="flex items-center gap-1.5 text-sm font-semibold text-nd-text-primary mt-2">
            <Shield className="w-4 h-4 text-nd-teal" />
            <span>Local-Only Records</span>
          </div>
          <span className="text-[10px] text-nd-text-secondary/80">Stored only in this browser</span>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
        <div className="flex items-center gap-1 rounded-xl bg-nd-surface border border-white/[0.08] p-1 w-full sm:w-auto">
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              filter === 'all' ? 'bg-nd-teal text-nd-bg-0' : 'text-nd-text-secondary hover:text-nd-text-primary'
            }`}
          >
            All ({historyItems.length})
          </button>
          <button
            onClick={() => setFilter('sent')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              filter === 'sent' ? 'bg-nd-teal text-nd-bg-0' : 'text-nd-text-secondary hover:text-nd-text-primary'
            }`}
          >
            Sent ({historyItems.filter((i) => i.direction === 'sent').length})
          </button>
          <button
            onClick={() => setFilter('received')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              filter === 'received' ? 'bg-nd-teal text-nd-bg-0' : 'text-nd-text-secondary hover:text-nd-text-primary'
            }`}
          >
            Received ({historyItems.filter((i) => i.direction === 'received').length})
          </button>
        </div>

        <div
          role="group"
          aria-label="Filter by status"
          className="flex items-center gap-1 rounded-xl bg-nd-surface border border-white/[0.08] p-1 w-full sm:w-auto"
        >
          {(['all', 'completed', 'failed', 'cancelled'] as const).map((sf) => (
            <button
              key={sf}
              onClick={() => setStatusFilter(sf)}
              aria-pressed={statusFilter === sf}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium capitalize transition-all ${
                statusFilter === sf ? 'bg-nd-teal text-nd-bg-0' : 'text-nd-text-secondary hover:text-nd-text-primary'
              }`}
            >
              {sf === 'all' ? 'Any status' : `${sf} (${historyItems.filter((i) => i.status === sf).length})`}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-nd-text-secondary" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search transfer history..."
            className="w-full rounded-xl border border-white/[0.08] bg-nd-surface pl-9 pr-3 py-1.5 text-xs text-nd-text-primary placeholder:text-nd-text-secondary/80 focus:border-nd-teal focus:outline-none"
          />
        </div>
      </div>

      {/* History Items List */}
      <div className="rounded-2xl border border-white/[0.08] bg-nd-surface p-5 shadow-sm">
        {filteredItems.length === 0 ? (
          <div className="py-16 text-center text-xs text-nd-text-secondary/80">
            <History className="w-9 h-9 mx-auto mb-2 text-nd-text-secondary/30" />
            <p className="font-medium text-nd-text-secondary">
              {historyItems.length === 0 ? 'No transfers yet' : 'No transfers match your filter'}
            </p>
            <p className="text-[11px] mt-1 text-nd-text-secondary/80">
              When you send or receive files, their metadata will be logged here locally.
            </p>
            {historyItems.length === 0 && (
              <button
                onClick={onNavigateTransfer}
                className="mt-4 px-4 py-2 rounded-xl bg-nd-teal text-xs font-semibold text-nd-bg-0 hover:bg-nd-teal-bright transition-colors"
              >
                Start a Transfer
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {filteredItems.map((item) => (
              <div
                key={item.id}
                className="py-3 flex items-center justify-between gap-4 text-xs transition-colors hover:bg-white/[0.01] px-2 rounded-lg"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-xl shrink-0 ${
                      item.direction === 'sent'
                        ? 'bg-nd-teal/10 text-nd-teal border border-nd-teal/20'
                        : 'bg-nd-success/10 text-nd-teal-bright border border-nd-success/20'
                    }`}
                  >
                    {item.direction === 'sent' ? (
                      <ArrowUpRight className="w-4 h-4" />
                    ) : (
                      <ArrowDownLeft className="w-4 h-4" />
                    )}
                  </div>

                  <div className="min-w-0">
                    <p className="truncate font-medium text-nd-text-primary text-xs sm:text-sm">
                      {item.name}
                    </p>
                    <div className="flex items-center gap-2 text-[11px] text-nd-text-secondary mt-0.5">
                      <span>{formatBytes(item.size)}</span>
                      <span>·</span>
                      <span className="capitalize">{item.direction}</span>
                      <span>·</span>
                      <span>{formatTimestamp(item.timestamp)}</span>
                      {item.hashVerified === true && (
                        <>
                          <span>·</span>
                          <span className="text-nd-teal flex items-center gap-0.5">
                            <FileCheck className="w-3 h-3 inline" />
                            SHA-256 Verified
                          </span>
                        </>
                      )}
                      {item.status === 'completed' && item.hashVerified === false && (
                        <>
                          <span>·</span>
                          <span className="text-nd-error flex items-center gap-0.5">
                            <AlertCircle className="w-3 h-3 inline" />
                            Verification failed
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="shrink-0 flex items-center gap-2">
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-medium uppercase ${
                      item.status === 'completed'
                        ? 'bg-nd-success/10 text-nd-teal-bright border border-nd-success/20'
                        : 'bg-nd-error/10 text-nd-error border border-nd-error/20'
                    }`}
                  >
                    {item.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
