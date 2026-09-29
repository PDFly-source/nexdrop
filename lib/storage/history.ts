import { LocalHistoryItem } from '@/types/transfer';

let memoryHistory: LocalHistoryItem[] | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

export function subscribeHistory(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function getHistorySnapshot(): LocalHistoryItem[] {
  if (memoryHistory === null) {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('nexdrop_history');
        memoryHistory = saved ? JSON.parse(saved) : [];
      } catch {
        memoryHistory = [];
      }
    } else {
      memoryHistory = [];
    }
  }
  return memoryHistory || [];
}

const SERVER_EMPTY_HISTORY: LocalHistoryItem[] = [];
export function getServerHistorySnapshot(): LocalHistoryItem[] {
  return SERVER_EMPTY_HISTORY;
}

export function addHistoryRecord(item: LocalHistoryItem): void {
  const current = getHistorySnapshot();
  memoryHistory = [item, ...current].slice(0, 50);
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem('nexdrop_history', JSON.stringify(memoryHistory));
    } catch {
      // Ignore quota errors
    }
  }
  notify();
}

/**
 * Update the verification status of a stored history record
 * (sent files get their verdict when the receiver's VERIFY message arrives).
 */
export function updateHistoryVerification(transferId: string, verified: boolean): void {
  const current = getHistorySnapshot();
  memoryHistory = current.map((item) =>
    item.id === transferId ? { ...item, hashVerified: verified } : item
  );
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem('nexdrop_history', JSON.stringify(memoryHistory));
    } catch {
      // Ignore quota errors
    }
  }
  notify();
}

export function clearHistoryRecords(): void {
  memoryHistory = [];
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem('nexdrop_history');
    } catch {
      // Ignore
    }
  }
  notify();
}
