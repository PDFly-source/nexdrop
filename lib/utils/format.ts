/**
 * Formatting and Helper Utilities for NexDrop.
 */

export function formatBytes(bytes: number, decimals: number = 2): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const idx = Math.min(i, sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, idx)).toFixed(dm))} ${sizes[idx]}`;
}

/**
 * ONE consistent binary-unit speed formatter for the whole app:
 * < 1 MiB/s → whole KB/s ("850 KB/s"), ≥ 1 MiB/s → "1.24 MB/s",
 * ≥ 1 GiB/s → "1.24 GB/s". 1024 KB/s is never shown — it is 1.00 MB/s.
 * The underlying measured value is never scaled or smoothed here.
 */
export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 KB/s';
  if (bytesPerSec >= 1024 * 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
  }
  if (bytesPerSec >= 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
  }
  return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
}

export function formatEta(seconds: number): string {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return 'Calculating...';
  if (seconds < 60) return `${Math.ceil(seconds)}s remaining`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  if (mins < 60) return `${mins}m ${secs}s remaining`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours}h ${remainingMins}m remaining`;
}

export function formatTimestamp(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export type FileCategory =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'code'
  | 'archive'
  | 'apk'
  | 'document'
  | 'generic';

export function getFileCategory(name: string, mime: string = ''): FileCategory {
  const ext = name.split('.').pop()?.toLowerCase() || '';

  if (ext === 'apk') return 'apk';
  if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz'].includes(ext)) return 'archive';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic'].includes(ext) || mime.startsWith('image/')) return 'image';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'wmv'].includes(ext) || mime.startsWith('video/')) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext) || mime.startsWith('audio/')) return 'audio';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'html', 'css', 'json', 'sh', 'sql', 'cpp', 'c', 'h', 'java', 'go', 'rs', 'php', 'rb'].includes(ext)) return 'code';
  if (['txt', 'md', 'doc', 'docx', 'csv', 'xlsx', 'pptx'].includes(ext)) return 'document';

  return 'generic';
}
