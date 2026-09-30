'use client';

import React, { useRef, useState } from 'react';
import {
  UploadCloud,
  File,
  X,
  FileText,
  FileArchive,
  Image as ImageIcon,
  Video,
  Music,
  CheckCircle2,
  AlertCircle,
  Clock,
  FolderOpen,
} from 'lucide-react';
import { FileItem } from '@/types/transfer';
import { formatBytes, getFileCategory } from '@/lib/utils/format';

interface SendDropzoneProps {
  sendQueue: FileItem[];
  isConnected: boolean;
  onFilesSelected: (files: FileList | File[]) => void;
  onRemoveItem: (id: string) => void;
  onClearCompleted: () => void;
  onPromptConnect: () => void;
}

export const SendDropzone: React.FC<SendDropzoneProps> = ({
  sendQueue,
  isConnected,
  onFilesSelected,
  onRemoveItem,
  onClearCompleted,
  onPromptConnect,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFilesSelected(e.dataTransfer.files);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(e.target.files);
      // Reset input value so re-selecting same file triggers change
      e.target.value = '';
    }
  };

  const renderFileIcon = (name: string, type: string) => {
    const category = getFileCategory(name, type);
    switch (category) {
      case 'image':
        return <ImageIcon className="w-4 h-4 text-[#00D9B5]" />;
      case 'video':
        return <Video className="w-4 h-4 text-purple-400" />;
      case 'audio':
        return <Music className="w-4 h-4 text-pink-400" />;
      case 'archive':
        return <FileArchive className="w-4 h-4 text-amber-400" />;
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
          <h2 className="text-sm font-semibold text-[#F5F7F8]">Send Files</h2>
          <p className="text-xs text-[#9AA7AE] mt-0.5">Direct P2P · Adaptive streaming</p>
        </div>

        <div className="flex items-center gap-2">
          {sendQueue.some((i) => i.status === 'completed') && (
            <button
              onClick={onClearCompleted}
              className="text-[11px] text-[#9AA7AE] hover:text-[#F5F7F8] transition-colors"
            >
              Clear Completed
            </button>
          )}
        </div>
      </div>

      {/* Main Drag & Drop Zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`mt-4 relative flex flex-col items-center justify-center rounded-xl border border-dashed py-8 px-4 text-center cursor-pointer transition-all ${
          isDragOver
            ? 'border-[#00F5A0] bg-[#00F5A0]/5 scale-[0.99]'
            : 'border-white/[0.12] bg-[#0B0F12] hover:border-white/20 hover:bg-white/[0.02]'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileChange}
          className="hidden"
        />

        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#1B2026] border border-white/[0.08] mb-3">
          <UploadCloud className="w-5 h-5 text-[#00F5A0]" />
        </div>

        <p className="text-xs font-medium text-[#F5F7F8]">
          Drop files here or <span className="text-[#00F5A0] underline">browse</span>
        </p>

        <p className="mt-1 text-[11px] text-[#9AA7AE]">
          Photos, videos, documents, ZIP, APK, code · Any size
        </p>

        {!isConnected && (
          <div
            onClick={(e) => {
              e.stopPropagation();
              onPromptConnect();
            }}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-white/[0.05] border border-white/[0.08] px-2.5 py-1 text-[11px] text-[#9AA7AE] hover:text-[#F5F7F8] hover:border-white/20"
          >
            <span>Connect peer device to start sending</span>
          </div>
        )}
      </div>

      {/* Send Queue List */}
      <div className="mt-4 flex-1 flex flex-col min-h-36">
        <div className="flex items-center justify-between text-xs text-[#9AA7AE] pb-2">
          <span>Outbound Queue ({sendQueue.length})</span>
          {sendQueue.length > 0 && (
            <span>
              {formatBytes(sendQueue.reduce((acc, f) => acc + f.size, 0))} total
            </span>
          )}
        </div>

        {sendQueue.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center rounded-lg border border-dashed border-white/[0.04] p-6 text-center text-xs text-[#9AA7AE]/80">
            <span>No files in send queue</span>
            <span className="text-[11px] mt-0.5">Files added will be transferred sequentially</span>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto max-h-56 space-y-2 pr-1">
            {sendQueue.map((item) => (
              <div
                key={item.id}
                className="group flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-[#0B0F12] p-2.5 text-xs transition-colors hover:border-white/10"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="shrink-0">{renderFileIcon(item.name, item.type)}</div>
                  <div className="min-w-0 text-left">
                    <p className="truncate font-medium text-[#F5F7F8] text-xs">
                      {item.name}
                    </p>
                    <div className="flex items-center gap-2 text-[11px] text-[#9AA7AE]">
                      <span>{formatBytes(item.size)}</span>
                      <span>·</span>
                      <span className="capitalize">{item.status}</span>
                      {item.progress > 0 && item.status === 'transferring' && (
                        <span>· {item.progress.toFixed(0)}%</span>
                      )}
                      {item.status === 'completed' && item.integrityVerified === true && (
                        <span className="text-[#22C55E]">· Verified by receiver</span>
                      )}
                      {item.status === 'completed' && item.integrityVerified === false && (
                        <span className="text-[#FF5C5C]">· Receiver reported integrity failure</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {item.status === 'completed' && (
                    <CheckCircle2 className="w-4 h-4 text-[#22C55E]" />
                  )}
                  {item.status === 'failed' && (
                    <AlertCircle className="w-4 h-4 text-[#FF5C5C]" />
                  )}
                  {item.status === 'queued' && (
                    <Clock className="w-3.5 h-3.5 text-[#9AA7AE]" />
                  )}
                  {item.status !== 'transferring' && (
                    <button
                      onClick={() => onRemoveItem(item.id)}
                      className="text-[#9AA7AE] hover:text-[#FF5C5C] transition-colors p-1"
                      title="Remove from queue"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
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
