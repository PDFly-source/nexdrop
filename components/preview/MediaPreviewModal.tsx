'use client';

import React, { useEffect, useState } from 'react';
import { X, Download, FileText, Image as ImageIcon, Video, Music } from 'lucide-react';
import { FileItem } from '@/types/transfer';
import { formatBytes, getFileCategory } from '@/lib/utils/format';

interface MediaPreviewModalProps {
  file: FileItem | null;
  onClose: () => void;
}

export const MediaPreviewModal: React.FC<MediaPreviewModalProps> = ({ file, onClose }) => {
  const [textContent, setTextContent] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!file || !file.blobUrl) return;

    const cat = getFileCategory(file.name, file.type);
    if (cat === 'code' || cat === 'document' || file.name.endsWith('.txt') || file.name.endsWith('.md')) {
      fetch(file.blobUrl)
        .then((res) => res.text())
        .then((txt) => {
          if (active) setTextContent(txt.slice(0, 10000));
        })
        .catch(() => {
          if (active) setTextContent('Unable to read text preview.');
        });
    }

    return () => {
      active = false;
    };
  }, [file]);

  if (!file) return null;

  const category = getFileCategory(file.name, file.type);

  const handleDownload = () => {
    if (!file.blobUrl) return;
    const a = document.createElement('a');
    a.href = file.blobUrl;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
      <div className="w-full max-w-2xl rounded-xl border border-white/10 bg-[#11171B] shadow-2xl flex flex-col max-h-[85vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.08]">
          <div className="min-w-0 text-left">
            <h3 className="truncate text-sm font-semibold text-[#F5F7F8]">
              {file.name}
            </h3>
            <p className="text-[11px] text-[#9AA7AE]">
              {formatBytes(file.size)} · {file.type || 'Unknown MIME'}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {file.blobUrl && (
              <button
                onClick={handleDownload}
                className="flex items-center gap-1.5 rounded-lg bg-[#00F5A0] px-3 py-1.5 text-xs font-semibold text-[#070A0D] hover:bg-[#00D9B5] transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Save File</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="text-[#9AA7AE] hover:text-[#F5F7F8] p-1.5"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Preview Viewport */}
        <div className="flex-1 overflow-auto p-4 flex items-center justify-center bg-[#070A0D]">
          {category === 'image' && file.blobUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={file.blobUrl}
              alt={file.name}
              className="max-h-[60vh] max-w-full rounded object-contain"
            />
          )}

          {category === 'video' && file.blobUrl && (
            <video
              src={file.blobUrl}
              controls
              autoPlay
              className="max-h-[60vh] max-w-full rounded"
            />
          )}

          {category === 'audio' && file.blobUrl && (
            <div className="w-full max-w-md p-6 text-center">
              <Music className="w-12 h-12 text-[#00F5A0] mx-auto mb-4" />
              <p className="text-sm font-medium text-white mb-4">{file.name}</p>
              <audio src={file.blobUrl} controls className="w-full" />
            </div>
          )}

          {(category === 'code' || category === 'document') && textContent !== null && (
            <pre className="w-full max-h-[60vh] overflow-auto rounded bg-[#0B0F12] p-4 text-left font-mono text-xs text-[#F5F7F8] leading-relaxed">
              <code>{textContent}</code>
            </pre>
          )}

          {category === 'pdf' && file.blobUrl && (
            <iframe
              src={file.blobUrl}
              className="w-full h-[60vh] rounded border border-white/10"
              title="PDF Preview"
            />
          )}

          {!['image', 'video', 'audio', 'code', 'document', 'pdf'].includes(category) && (
            <div className="p-8 text-center text-xs text-[#9AA7AE]">
              <FileText className="w-10 h-10 text-[#9AA7AE]/40 mx-auto mb-2" />
              <p>Direct inline preview is not supported for this file format.</p>
              <p className="mt-1 text-[11px]">Click &quot;Save File&quot; to inspect it on your local system.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
