'use client';

import React from 'react';
import {
  Download,
  Eye,
  FileCheck,
  File,
  HardDrive,
  CheckCircle2,
  Clock,
  AlertCircle,
  FileText,
  Image as ImageIcon,
  Video,
  Music,
} from 'lucide-react';
import { FileItem } from '@/types/transfer';
import { formatBytes, getFileCategory } from '@/lib/utils/format';

interface IncomingTransfersCardProps {
  incomingFiles: FileItem[];
  onPreviewFile: (file: FileItem) => void;
  supportsFileSystemAccess: boolean;
}

export const IncomingTransfersCard: React.FC<IncomingTransfersCardProps> = ({
  incomingFiles,
  onPreviewFile,
  supportsFileSystemAccess,
}) => {
  const handleDownloadBlob = (file: FileItem) => {
    if (!file.blobUrl) return;
    const a = document.createElement('a');
    a.href = file.blobUrl;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const renderIcon = (name: string, type: string) => {
    const cat = getFileCategory(name, type);
    switch (cat) {
      case 'image':
        return <ImageIcon className="w-4 h-4 text-[#00D9B5]" />;
      case 'video':
        return <Video className="w-4 h-4 text-purple-400" />;
      case 'audio':
        return <Music className="w-4 h-4 text-pink-400" />;
      case 'code':
      case 'document':
      case 'pdf':
        return <FileText className="w-4 h-4 text-blue-400" />;
      default:
        return <File className="w-4 h-4 text-[#9AA7AE]" />;
    }
  };

  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#11171B] p-5 shadow-sm flex flex-col h-full">
      <div className="flex items-center justify-between pb-3 border-b border-white/[0.06]">
        <div>
          <h2 className="text-sm font-semibold text-[#F5F7F8]">Incoming Files</h2>
          <p className="text-xs text-[#9AA7AE] mt-0.5" suppressHydrationWarning>
            {supportsFileSystemAccess
              ? 'Streaming directly to disk (File System Access)'
              : 'Streaming with browser persistent storage'}
          </p>
        </div>

        <div className="flex items-center gap-1.5 text-[11px] text-[#9AA7AE]">
          <HardDrive className="w-3.5 h-3.5 text-[#00F5A0]" />
          <span>Local Device Storage</span>
        </div>
      </div>

      <div className="mt-4 flex-1 flex flex-col min-h-48">
        {incomingFiles.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center rounded-lg border border-dashed border-white/[0.04] p-8 text-center text-xs text-[#9AA7AE]/80">
            <Download className="w-6 h-6 text-[#9AA7AE]/40 mb-2" />
            <span>No incoming files yet</span>
            <span className="text-[11px] mt-0.5">
              Files sent from paired devices will appear here automatically
            </span>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto max-h-80 space-y-2 pr-1">
            {incomingFiles.map((file) => (
              <div
                key={file.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-[#0B0F12] p-3 text-xs"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="shrink-0">{renderIcon(file.name, file.type)}</div>
                  <div className="min-w-0 text-left">
                    <p className="truncate font-medium text-[#F5F7F8] text-xs">
                      {file.name}
                    </p>
                    <div className="flex items-center gap-2 text-[11px] text-[#9AA7AE] mt-0.5">
                      <span>{formatBytes(file.size)}</span>
                      <span>·</span>
                      <span className="capitalize">{file.status}</span>
                      {file.integrityVerified === true && (
                        <>
                          <span>·</span>
                          <span className="text-[#22C55E] flex items-center gap-1">
                            <FileCheck className="w-3 h-3 inline" />
                            Verified
                          </span>
                        </>
                      )}
                      {file.status === 'completed' && file.integrityVerified === false && (
                        <>
                          <span>·</span>
                          <span className="text-[#FF5C5C] flex items-center gap-1">
                            <AlertCircle className="w-3 h-3 inline" />
                            Verification failed
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {file.status === 'completed' && (
                    <>
                      {/* Preview Button */}
                      <button
                        onClick={() => onPreviewFile(file)}
                        className="flex items-center gap-1 rounded-md border border-white/[0.08] bg-[#1B2026] px-2.5 py-1 text-xs text-[#F5F7F8] hover:bg-white/10 transition-colors"
                        title="Preview file"
                      >
                        <Eye className="w-3.5 h-3.5 text-[#9AA7AE]" />
                        <span className="hidden sm:inline">Preview</span>
                      </button>

                      {/* Download Button if object URL available */}
                      {file.blobUrl && (
                        <button
                          onClick={() => handleDownloadBlob(file)}
                          className="flex items-center gap-1 rounded-md bg-[#00F5A0] px-2.5 py-1 text-xs font-medium text-[#070A0D] hover:bg-[#00D9B5] transition-colors"
                          title="Save to local device"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Save</span>
                        </button>
                      )}
                    </>
                  )}

                  {file.status === 'transferring' && (
                    <span className="text-xs text-[#00F5A0] font-mono">
                      {file.progress.toFixed(0)}%
                    </span>
                  )}

                  {file.status === 'failed' && (
                    <AlertCircle className="w-4 h-4 text-[#FF5C5C]" />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
