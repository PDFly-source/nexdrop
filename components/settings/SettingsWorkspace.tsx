'use client';

import React, { useState } from 'react';
import {
  Settings,
  Smartphone,
  Volume2,
  VolumeX,
  Vibrate,
  ShieldCheck,
  FileCheck,
  Cpu,
  Trash2,
  Check,
  AlertCircle,
  HardDrive,
  Info,
  Lock,
  Layers,
  Sparkles,
} from 'lucide-react';
import { DeviceInfo, BrowserCapabilities } from '@/lib/detection/capabilities';

interface SettingsWorkspaceProps {
  deviceInfo: DeviceInfo;
  capabilities: BrowserCapabilities | null;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  onToggleSound: (enabled: boolean) => void;
  onToggleVibration: (enabled: boolean) => void;
  onUpdateDeviceName: (name: string) => void;
  onClearHistory: () => void;
  historyCount: number;
}

export const SettingsWorkspace: React.FC<SettingsWorkspaceProps> = ({
  deviceInfo,
  capabilities,
  soundEnabled,
  vibrationEnabled,
  onToggleSound,
  onToggleVibration,
  onUpdateDeviceName,
  onClearHistory,
  historyCount,
}) => {
  const [nameInput, setNameInput] = useState<string>(deviceInfo.name);
  const [savedName, setSavedName] = useState<boolean>(false);
  const [clearedNotice, setClearedNotice] = useState<boolean>(false);
  const [autoResume, setAutoResume] = useState<boolean>(true);
  const [verifyIntegrity, setVerifyIntegrity] = useState<boolean>(true);

  const handleSaveName = (e: React.FormEvent) => {
    e.preventDefault();
    if (nameInput.trim()) {
      onUpdateDeviceName(nameInput.trim());
      setSavedName(true);
      setTimeout(() => setSavedName(false), 2000);
    }
  };

  const handleClearHistory = () => {
    onClearHistory();
    setClearedNotice(true);
    setTimeout(() => setClearedNotice(false), 2500);
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 space-y-8 text-left">
      {/* Header */}
      <div className="pb-4 border-b border-white/[0.08]">
        <div className="flex items-center gap-2">
          <h1 className="text-xl sm:text-2xl font-semibold text-[#F5F7F8]">Application Settings</h1>
          <span className="text-[11px] font-medium text-[#9AA3AD] bg-white/[0.06] px-2.5 py-0.5 rounded-full border border-white/[0.08]">
            Local Preferences
          </span>
        </div>
        <p className="text-xs text-[#9AA3AD] mt-1">
          Customize device profile, transfer parameters, sound notifications, and privacy options. All settings are stored locally on this device.
        </p>
      </div>

      {/* Section 1: General & Device Profile */}
      <div className="rounded-2xl border border-white/[0.08] bg-[#15191E] p-5 sm:p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2 pb-2 border-b border-white/[0.06]">
          <Smartphone className="w-4 h-4 text-[#19C37D]" />
          <h2 className="text-sm font-semibold text-[#F5F7F8]">General &amp; Device Identity</h2>
        </div>

        <div>
          <label className="block text-xs font-medium text-[#F5F7F8] mb-1.5">
            Device Display Name
          </label>
          <p className="text-xs text-[#9AA3AD] mb-3">
            This name is visible to paired devices during session connection and transfer prompts.
          </p>

          <form onSubmit={handleSaveName} className="flex gap-2 max-w-md">
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              maxLength={40}
              placeholder="e.g. Pixel 10, MacBook Pro, Studio PC"
              className="flex-1 rounded-xl border border-white/[0.1] bg-[#111418] px-3.5 py-2 text-xs sm:text-sm text-[#F5F7F8] focus:border-[#19C37D] focus:outline-none transition-all font-medium"
            />
            <button
              type="submit"
              className="rounded-xl bg-[#19C37D] px-4 py-2 text-xs font-semibold text-[#0B0D0F] hover:bg-[#3DD6A0] transition-colors shrink-0 shadow-sm"
            >
              {savedName ? (
                <span className="flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" />
                  Saved
                </span>
              ) : (
                'Save'
              )}
            </button>
          </form>
        </div>

        <div className="pt-3 flex flex-wrap items-center gap-4 text-xs text-[#9AA3AD]">
          <div className="flex items-center gap-1.5">
            <span className="text-[#9AA3AD]/80">Platform:</span>
            <span className="text-[#F5F7F8] font-mono">{deviceInfo.os}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[#9AA3AD]/80">Browser:</span>
            <span className="text-[#F5F7F8] font-mono">{deviceInfo.browser}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[#9AA3AD]/80">Device Type:</span>
            <span className="text-[#F5F7F8] font-mono">
              {deviceInfo.isMobile ? (deviceInfo.isIOS ? 'iOS Mobile' : 'Android Mobile') : 'Desktop / Laptop'}
            </span>
          </div>
        </div>
      </div>

      {/* Section 2: Transfer Engine Preferences */}
      <div className="rounded-2xl border border-white/[0.08] bg-[#15191E] p-5 sm:p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2 pb-2 border-b border-white/[0.06]">
          <Layers className="w-4 h-4 text-[#19C37D]" />
          <h2 className="text-sm font-semibold text-[#F5F7F8]">Transfer &amp; Storage Engine</h2>
        </div>

        <div className="divide-y divide-white/[0.04] text-xs">
          <div className="py-3 flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-[#F5F7F8]">Incremental SHA-256 Hash Verification</p>
              <p className="text-[11px] text-[#9AA3AD] mt-0.5">
                Computes cryptographically secure chunk hashes on both sender and receiver to verify file integrity.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={verifyIntegrity}
              aria-label="Incremental SHA-256 hash verification"
              onClick={() => setVerifyIntegrity(!verifyIntegrity)}
              className={`w-11 h-6 flex items-center rounded-full p-1 transition-colors ${
                verifyIntegrity ? 'bg-[#19C37D]' : 'bg-white/[0.1]'
              }`}
            >
              <div
                className={`bg-[#0B0D0F] w-4 h-4 rounded-full shadow-md transform transition-transform ${
                  verifyIntegrity ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          <div className="py-3 flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-[#F5F7F8]">Auto-Resume Interrupted Transfers</p>
              <p className="text-[11px] text-[#9AA3AD] mt-0.5">
                Automatically triggers ICE restart and resumes chunk streaming from last confirmed ACK if disconnected.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={autoResume}
              aria-label="Auto-resume interrupted transfers"
              onClick={() => setAutoResume(!autoResume)}
              className={`w-11 h-6 flex items-center rounded-full p-1 transition-colors ${
                autoResume ? 'bg-[#19C37D]' : 'bg-white/[0.1]'
              }`}
            >
              <div
                className={`bg-[#0B0D0F] w-4 h-4 rounded-full shadow-md transform transition-transform ${
                  autoResume ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          <div className="py-3 flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-[#F5F7F8]">Active Streaming Chunk Size</p>
              <p className="text-[11px] text-[#9AA3AD] mt-0.5">
                Optimized 64 KiB chunks with 256 KiB backpressure threshold to prevent buffer saturation.
              </p>
            </div>
            <span className="font-mono text-xs text-[#19C37D] bg-white/[0.04] px-2.5 py-1 rounded-md">
              64 KiB
            </span>
          </div>

          <div className="py-3 flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-[#F5F7F8]">Optimal Destination Writer</p>
              <p className="text-[11px] text-[#9AA3AD] mt-0.5">
                {capabilities?.fileSystemAccess
                  ? 'File System Access API (Streams directly to user disk with zero RAM buffer)'
                  : capabilities?.opfs
                  ? 'Origin Private File System (OPFS persistent streaming)'
                  : 'Memory-safe chunk streaming container'}
              </p>
            </div>
            <span className="font-mono text-[11px] text-[#3DD6A0] bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
              {capabilities?.fileSystemAccess ? 'FileSystemAccess' : capabilities?.opfs ? 'OPFS' : 'Blob'}
            </span>
          </div>
        </div>
      </div>

      {/* Section 3: Audio & Notifications */}
      <div className="rounded-2xl border border-white/[0.08] bg-[#15191E] p-5 sm:p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2 pb-2 border-b border-white/[0.06]">
          <Volume2 className="w-4 h-4 text-[#19C37D]" />
          <h2 className="text-sm font-semibold text-[#F5F7F8]">Sound &amp; Haptic Notifications</h2>
        </div>

        <div className="divide-y divide-white/[0.04] text-xs">
          <div className="py-3 flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-[#F5F7F8]">Sound Effects</p>
              <p className="text-[11px] text-[#9AA3AD] mt-0.5">
                Synthesized Web Audio chimes for connection establishment, transfer completion, and errors.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={soundEnabled}
              aria-label="Sound effects"
              onClick={() => onToggleSound(!soundEnabled)}
              className={`w-11 h-6 flex items-center rounded-full p-1 transition-colors ${
                soundEnabled ? 'bg-[#19C37D]' : 'bg-white/[0.1]'
              }`}
            >
              <div
                className={`bg-[#0B0D0F] w-4 h-4 rounded-full shadow-md transform transition-transform ${
                  soundEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          <div className="py-3 flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-[#F5F7F8]">Vibration Feedback</p>
              <p className="text-[11px] text-[#9AA3AD] mt-0.5">
                Haptic vibration on mobile devices upon successful peer pairing and transfer completion.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={vibrationEnabled}
              aria-label="Vibration feedback"
              onClick={() => onToggleVibration(!vibrationEnabled)}
              className={`w-11 h-6 flex items-center rounded-full p-1 transition-colors ${
                vibrationEnabled ? 'bg-[#19C37D]' : 'bg-white/[0.1]'
              }`}
            >
              <div
                className={`bg-[#0B0D0F] w-4 h-4 rounded-full shadow-md transform transition-transform ${
                  vibrationEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Section 4: Browser Diagnostics & Capability Audit */}
      <div className="rounded-2xl border border-white/[0.08] bg-[#15191E] p-5 sm:p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2 pb-2 border-b border-white/[0.06]">
          <Cpu className="w-4 h-4 text-[#19C37D]" />
          <h2 className="text-sm font-semibold text-[#F5F7F8]">Browser Capabilities Diagnostics</h2>
        </div>

        <p className="text-xs text-[#9AA3AD]">
          Real-time audit of local browser APIs used by NexDrop for P2P streaming and zero-heap persistence:
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
          <div className="rounded-xl bg-[#111418] border border-white/[0.06] p-3">
            <span className="text-[10px] text-[#9AA3AD]/80 block font-mono">WebRTC Core</span>
            <span className="font-medium text-[#F5F7F8] mt-1 block">
              {capabilities?.webRTC ? (
                <span className="text-[#19C37D] flex items-center gap-1">
                  <Check className="w-3 h-3" />
                  Supported
                </span>
              ) : (
                'Unavailable'
              )}
            </span>
          </div>

          <div className="rounded-xl bg-[#111418] border border-white/[0.06] p-3">
            <span className="text-[10px] text-[#9AA3AD]/80 block font-mono">RTCDataChannel</span>
            <span className="font-medium text-[#F5F7F8] mt-1 block">
              {capabilities?.dataChannel ? (
                <span className="text-[#19C37D] flex items-center gap-1">
                  <Check className="w-3 h-3" />
                  Supported
                </span>
              ) : (
                'Unavailable'
              )}
            </span>
          </div>

          <div className="rounded-xl bg-[#111418] border border-white/[0.06] p-3">
            <span className="text-[10px] text-[#9AA3AD]/80 block font-mono">File System Access</span>
            <span className="font-medium text-[#F5F7F8] mt-1 block">
              {capabilities?.fileSystemAccess ? (
                <span className="text-[#19C37D] flex items-center gap-1">
                  <Check className="w-3 h-3" />
                  Supported
                </span>
              ) : (
                <span className="text-[#9AA3AD]">OPFS Fallback</span>
              )}
            </span>
          </div>

          <div className="rounded-xl bg-[#111418] border border-white/[0.06] p-3">
            <span className="text-[10px] text-[#9AA3AD]/80 block font-mono">OPFS Storage</span>
            <span className="font-medium text-[#F5F7F8] mt-1 block">
              {capabilities?.opfs ? (
                <span className="text-[#19C37D] flex items-center gap-1">
                  <Check className="w-3 h-3" />
                  Supported
                </span>
              ) : (
                <span className="text-[#9AA3AD]">Fallback</span>
              )}
            </span>
          </div>

          <div className="rounded-xl bg-[#111418] border border-white/[0.06] p-3">
            <span className="text-[10px] text-[#9AA3AD]/80 block font-mono">Web Crypto API</span>
            <span className="font-medium text-[#F5F7F8] mt-1 block">
              {capabilities?.webCrypto ? (
                <span className="text-[#19C37D] flex items-center gap-1">
                  <Check className="w-3 h-3" />
                  Active
                </span>
              ) : (
                'Unavailable'
              )}
            </span>
          </div>

          <div className="rounded-xl bg-[#111418] border border-white/[0.06] p-3">
            <span className="text-[10px] text-[#9AA3AD]/80 block font-mono">Camera API (QR)</span>
            <span className="font-medium text-[#F5F7F8] mt-1 block">
              {capabilities?.camera ? (
                <span className="text-[#19C37D] flex items-center gap-1">
                  <Check className="w-3 h-3" />
                  Ready
                </span>
              ) : (
                'Unavailable'
              )}
            </span>
          </div>

          <div className="rounded-xl bg-[#111418] border border-white/[0.06] p-3">
            <span className="text-[10px] text-[#9AA3AD]/80 block font-mono">Clipboard API</span>
            <span className="font-medium text-[#F5F7F8] mt-1 block">
              {capabilities?.clipboard ? (
                <span className="text-[#19C37D] flex items-center gap-1">
                  <Check className="w-3 h-3" />
                  Supported
                </span>
              ) : (
                'Unavailable'
              )}
            </span>
          </div>

          <div className="rounded-xl bg-[#111418] border border-white/[0.06] p-3">
            <span className="text-[10px] text-[#9AA3AD]/80 block font-mono">Service Worker</span>
            <span className="font-medium text-[#F5F7F8] mt-1 block">
              {capabilities?.serviceWorker ? (
                <span className="text-[#19C37D] flex items-center gap-1">
                  <Check className="w-3 h-3" />
                  Supported
                </span>
              ) : (
                'Unavailable'
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Section 5: Privacy & Local Storage Data */}
      <div className="rounded-2xl border border-white/[0.08] bg-[#15191E] p-5 sm:p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2 pb-2 border-b border-white/[0.06]">
          <ShieldCheck className="w-4 h-4 text-[#19C37D]" />
          <h2 className="text-sm font-semibold text-[#F5F7F8]">Privacy &amp; Local Storage</h2>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <p className="font-medium text-[#F5F7F8] text-xs">Local Transfer Records</p>
            <p className="text-[11px] text-[#9AA3AD] mt-0.5">
              Currently holding {historyCount} local transfer metadata entries in browser storage.
            </p>
          </div>

          <button
            onClick={handleClearHistory}
            disabled={historyCount === 0}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-red-500/20 bg-red-500/10 text-xs font-medium text-red-400 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors self-start sm:self-center"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{clearedNotice ? 'Cleared!' : 'Clear Local History'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
