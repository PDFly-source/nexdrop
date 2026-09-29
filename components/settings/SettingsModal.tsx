'use client';

import React, { useState } from 'react';
import {
  Settings,
  X,
  Volume2,
  VolumeX,
  Smartphone,
  Trash2,
  Check,
  ShieldCheck,
  FileCheck,
} from 'lucide-react';
import { DeviceInfo } from '@/lib/detection/capabilities';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  deviceInfo: DeviceInfo;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  onToggleSound: (enabled: boolean) => void;
  onToggleVibration: (enabled: boolean) => void;
  onUpdateDeviceName: (name: string) => void;
  onClearHistory: () => void;
  historyCount: number;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  deviceInfo,
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

  if (!isOpen) return null;

  const handleSaveName = (e: React.FormEvent) => {
    e.preventDefault();
    if (nameInput.trim()) {
      onUpdateDeviceName(nameInput.trim());
      setSavedName(true);
      setTimeout(() => setSavedName(false), 2000);
    }
  };

  const handleClear = () => {
    onClearHistory();
    setClearedNotice(true);
    setTimeout(() => setClearedNotice(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#15191E] p-5 shadow-2xl text-left max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between pb-3 border-b border-white/[0.08]">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-[#19C37D]" />
            <h3 className="text-sm font-semibold text-[#F5F7F8]">NexDrop Settings</h3>
          </div>
          <button onClick={onClose} className="text-[#9AA3AD] hover:text-[#F5F7F8]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-4 flex-1 overflow-y-auto space-y-5 pr-1 text-xs">
          {/* Section 1: Device Name */}
          <div>
            <label className="block text-xs font-medium text-[#F5F7F8] mb-1.5">
              Device Name (Broadcasted to peers)
            </label>
            <form onSubmit={handleSaveName} className="flex gap-2">
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                maxLength={40}
                className="flex-1 rounded-lg border border-white/[0.1] bg-[#111418] px-3 py-1.5 text-xs text-[#F5F7F8] focus:border-[#19C37D] focus:outline-none"
              />
              <button
                type="submit"
                className="rounded-lg bg-[#19C37D] px-3 py-1.5 text-xs font-medium text-[#0B0D0F] hover:bg-[#3DD6A0] transition-colors"
              >
                {savedName ? <Check className="w-3.5 h-3.5 inline" /> : 'Save'}
              </button>
            </form>
          </div>

          {/* Section 2: Audio & Feedback */}
          <div className="pt-3 border-t border-white/[0.06]">
            <p className="text-xs font-semibold text-[#F5F7F8] mb-2">Feedback & Sounds</p>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-[#F5F7F8]">Synthesized Audio Cues</p>
                  <p className="text-[11px] text-[#9AA3AD]">Play chime on connect, finish, and alerts</p>
                </div>
                <button
                  onClick={() => onToggleSound(!soundEnabled)}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                    soundEnabled ? 'bg-[#19C37D]' : 'bg-[#1B2026]'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      soundEnabled ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-[#F5F7F8]">Haptic Vibration</p>
                  <p className="text-[11px] text-[#9AA3AD]">Vibrate mobile devices on transfer completion</p>
                </div>
                <button
                  onClick={() => onToggleVibration(!vibrationEnabled)}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                    vibrationEnabled ? 'bg-[#19C37D]' : 'bg-[#1B2026]'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      vibrationEnabled ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>

          {/* Section 3: Transfer & Security */}
          <div className="pt-3 border-t border-white/[0.06]">
            <p className="text-xs font-semibold text-[#F5F7F8] mb-2">Transfer & Protocols</p>
            <div className="rounded-lg bg-[#111418] border border-white/[0.04] p-3 space-y-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-[#9AA3AD]">Chunk Size</span>
                <span className="font-mono text-[#F5F7F8]">64 KiB</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-[#9AA3AD]">Flow Control Window</span>
                <span className="font-mono text-[#F5F7F8]">16 Chunks</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-[#9AA3AD]">Integrity Verification</span>
                <span className="text-[#19C37D] font-mono">SHA-256 Enabled</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-[#9AA3AD]">Cloud Storage</span>
                <span className="text-[#22C55E] font-mono">Zero (Pure P2P)</span>
              </div>
            </div>
          </div>

          {/* Section 4: Local History & Privacy */}
          <div className="pt-3 border-t border-white/[0.06]">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-[#F5F7F8]">Local Transfer History</p>
                <p className="text-[11px] text-[#9AA3AD]">
                  Stored locally in browser only ({historyCount} items). No files stored.
                </p>
              </div>
              <button
                onClick={handleClear}
                className="flex items-center gap-1 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-xs text-[#EF4444] hover:bg-red-500/20 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{clearedNotice ? 'Cleared' : 'Clear'}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5 pt-3 border-t border-white/[0.08] text-right">
          <button
            onClick={onClose}
            className="rounded-lg bg-[#1B2026] px-4 py-1.5 text-xs font-medium text-[#F5F7F8] hover:bg-white/10 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
