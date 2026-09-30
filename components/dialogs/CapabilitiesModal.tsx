'use client';

import React from 'react';
import { Cpu, X, CheckCircle2, AlertCircle, HardDrive, Shield, Zap } from 'lucide-react';
import { BrowserCapabilities } from '@/lib/detection/capabilities';

interface CapabilitiesModalProps {
  isOpen: boolean;
  onClose: () => void;
  capabilities: BrowserCapabilities | null;
}

export const CapabilitiesModal: React.FC<CapabilitiesModalProps> = ({
  isOpen,
  onClose,
  capabilities,
}) => {
  if (!isOpen || !capabilities) return null;

  const features = [
    {
      name: 'WebRTC PeerConnection',
      desc: 'Enables direct browser-to-browser P2P networking without servers.',
      active: capabilities.webRTC,
    },
    {
      name: 'RTCDataChannel',
      desc: 'High-throughput binary streaming channels with adaptive 64-256 KiB chunk sizing.',
      active: capabilities.dataChannel,
    },
    {
      name: 'File System Access API',
      desc: 'Direct disk streaming via showSaveFilePicker, bypassing RAM limits.',
      active: capabilities.fileSystemAccess,
      tag: capabilities.fileSystemAccess ? 'Optimal for 10GB+' : 'Unavailable',
    },
    {
      name: 'Origin Private File System (OPFS)',
      desc: 'Fast sandboxed disk storage for large file assembly.',
      active: capabilities.opfs,
    },
    {
      name: 'Web Crypto API',
      desc: 'Hardware-accelerated AES-256-GCM & SHA-256 verification.',
      active: capabilities.webCrypto,
    },
    {
      name: 'Clipboard API',
      desc: 'Seamless cross-device text & code synchronization.',
      active: capabilities.clipboard,
    },
    {
      name: 'Camera MediaDevices',
      desc: 'Real-time QR code scanning for instantaneous pairing.',
      active: capabilities.camera,
    },
    {
      name: 'PWA Service Worker',
      desc: 'Offline caching and native home-screen installation.',
      active: capabilities.serviceWorker,
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-white/10 bg-nd-surface p-5 shadow-2xl text-left max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between pb-3 border-b border-white/[0.08]">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-nd-teal" />
            <h3 className="text-sm font-semibold text-nd-text-primary">Browser Capability Center</h3>
          </div>
          <button onClick={onClose} className="text-nd-text-secondary hover:text-nd-text-primary">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Highlight box */}
        <div className="mt-4 rounded-lg bg-nd-bg-1 border border-white/[0.06] p-3 text-xs">
          <div className="flex items-start gap-2.5">
            <Zap className="w-4 h-4 text-nd-teal shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-nd-text-primary">
                {capabilities.fileSystemAccess
                  ? 'High-Performance Disk Streaming Supported'
                  : capabilities.opfs
                  ? 'OPFS Storage Streaming Supported'
                  : 'Memory-Safe Fallback Active'}
              </p>
              <p className="mt-1 text-[11px] text-nd-text-secondary leading-relaxed">
                {capabilities.fileSystemAccess
                  ? 'Your browser supports the File System Access API. Incoming files stream directly to disk without consuming heap RAM.'
                  : capabilities.opfs
                  ? 'Your browser supports Origin Private File System (OPFS) for background chunk persistence.'
                  : 'Your browser uses memory-bounded chunks with strict buffer guards. Recommended transfer size under 2 GB.'}
              </p>
            </div>
          </div>
        </div>

        {/* Feature List */}
        <div className="mt-4 flex-1 overflow-y-auto space-y-2.5 pr-1">
          {features.map((feat) => (
            <div
              key={feat.name}
              className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.04] bg-nd-bg-1 p-2.5 text-xs"
            >
              <div className="min-w-0 text-left">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-nd-text-primary">{feat.name}</span>
                  {feat.tag && (
                    <span className="text-[10px] text-nd-teal-bright font-mono">{feat.tag}</span>
                  )}
                </div>
                <p className="text-[11px] text-nd-text-secondary mt-0.5">{feat.desc}</p>
              </div>

              <div className="shrink-0">
                {feat.active ? (
                  <CheckCircle2 className="w-4 h-4 text-nd-success" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-nd-text-secondary/40" />
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 pt-3 border-t border-white/[0.06] text-right">
          <button
            onClick={onClose}
            className="rounded-lg bg-nd-surface-elevated px-4 py-1.5 text-xs font-medium text-nd-text-primary hover:bg-white/10 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
