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
  Activity,
} from 'lucide-react';
import { DeviceInfo } from '@/lib/detection/capabilities';
import { openDeviceTest } from '@/lib/devicetest/recorder';

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
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-nd-surface p-5 shadow-2xl text-left max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between pb-3 border-b border-white/[0.08]">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-nd-teal" />
            <h3 className="text-sm font-semibold text-nd-text-primary">NexDrop Settings</h3>
          </div>
          <button onClick={onClose} className="text-nd-text-secondary hover:text-nd-text-primary">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-4 flex-1 overflow-y-auto space-y-5 pr-1 text-xs">
          {/* Section 1: Device Name */}
          <div>
            <label className="block text-xs font-medium text-nd-text-primary mb-1.5">
              Device Name (Broadcasted to peers)
            </label>
            <form onSubmit={handleSaveName} className="flex gap-2">
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                maxLength={40}
                className="flex-1 rounded-lg border border-white/[0.1] bg-nd-bg-1 px-3 py-1.5 text-xs text-nd-text-primary focus:border-nd-teal focus:outline-none"
              />
              <button
                type="submit"
                className="rounded-lg bg-nd-teal px-3 py-1.5 text-xs font-medium text-nd-bg-0 hover:bg-nd-teal-bright transition-colors"
              >
                {savedName ? <Check className="w-3.5 h-3.5 inline" /> : 'Save'}
              </button>
            </form>
          </div>

          {/* Section 2: Audio & Feedback */}
          <div className="pt-3 border-t border-white/[0.06]">
            <p className="text-xs font-semibold text-nd-text-primary mb-2">Feedback & Sounds</p>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-nd-text-primary">Synthesized Audio Cues</p>
                  <p className="text-[11px] text-nd-text-secondary">Play chime on connect, finish, and alerts</p>
                </div>
                <button
                  onClick={() => onToggleSound(!soundEnabled)}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                    soundEnabled ? 'bg-nd-teal' : 'bg-nd-surface-elevated'
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
                  <p className="font-medium text-nd-text-primary">Haptic Vibration</p>
                  <p className="text-[11px] text-nd-text-secondary">Vibrate mobile devices on transfer completion</p>
                </div>
                <button
                  onClick={() => onToggleVibration(!vibrationEnabled)}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                    vibrationEnabled ? 'bg-nd-teal' : 'bg-nd-surface-elevated'
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
            <p className="text-xs font-semibold text-nd-text-primary mb-2">Transfer & Protocols</p>
            <div className="rounded-lg bg-nd-bg-1 border border-white/[0.04] p-3 space-y-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-nd-text-secondary">Chunk Size (adaptive)</span>
                <span className="font-mono text-nd-text-primary">64-256 KiB</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-nd-text-secondary">Flow Control Window</span>
                <span className="font-mono text-nd-text-primary">16 Chunks</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-nd-text-secondary">Integrity Verification</span>
                <span className="text-nd-teal font-mono">SHA-256 Enabled</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-nd-text-secondary">Cloud Storage</span>
                <span className="text-nd-success font-mono">Zero (Pure P2P)</span>
              </div>
            </div>
          </div>

          {/* Section 4: Local History & Privacy */}
          <div className="pt-3 border-t border-white/[0.06]">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-nd-text-primary">Local Transfer History</p>
                <p className="text-[11px] text-nd-text-secondary">
                  Stored locally in browser only ({historyCount} items). No files stored.
                </p>
              </div>
              <button
                onClick={handleClear}
                className="flex items-center gap-1 rounded-lg border border-nd-error/20 bg-nd-error/10 px-2.5 py-1 text-xs text-nd-error hover:bg-nd-error/20 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{clearedNotice ? 'Cleared' : 'Clear'}</span>
              </button>
            </div>
          </div>
        </div>

          {/* Section 5: Advanced — Device Test & Diagnostics */}
          <div className="pt-3 border-t border-white/[0.06]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium text-nd-text-primary flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-nd-teal" aria-hidden="true" />
                  Device Test &amp; Diagnostics
                </p>
                <p className="text-[11px] text-nd-text-secondary">
                  Guided two-device transfer test with measured telemetry. Records real values only;
                  diagnostics stay on this device.
                </p>
              </div>
              <button
                onClick={openDeviceTest}
                className="shrink-0 rounded-lg border border-nd-teal/40 bg-nd-teal/10 px-3 py-1.5 text-xs font-medium text-nd-teal hover:bg-nd-teal/20 transition-colors"
              >
                Open
              </button>
            </div>
          </div>

        <div className="mt-5 pt-3 border-t border-white/[0.08] text-right">
          <button
            onClick={onClose}
            className="rounded-lg bg-nd-surface-elevated px-4 py-1.5 text-xs font-medium text-nd-text-primary hover:bg-white/10 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
