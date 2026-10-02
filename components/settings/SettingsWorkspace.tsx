'use client';

import React, { useState } from 'react';
import {
  Smartphone,
  Volume2,
  Vibrate,
  ShieldCheck,
  Cpu,
  Trash2,
  Check,
  HardDrive,
  Layers,
  UserRound,
  Palette,
  ExternalLink,
  Info,
  Activity,
} from 'lucide-react';
import Link from 'next/link';
import { DeviceInfo, BrowserCapabilities } from '@/lib/detection/capabilities';
import { openDeviceTest } from '@/lib/devicetest/recorder';

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

function SectionCard({
  id,
  icon: Icon,
  title,
  children,
}: {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="rounded-2xl border border-white/[0.08] bg-nd-surface p-5 sm:p-6 shadow-sm space-y-4 scroll-mt-20"
    >
      <div className="flex items-center gap-2 pb-2 border-b border-white/[0.06]">
        <Icon className="w-4 h-4 text-nd-teal" />
        <h2 id={`${id}-heading`} className="text-sm font-semibold text-nd-text-primary">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onToggle,
  ariaLabel,
}: {
  title: string;
  description: string;
  checked: boolean;
  onToggle: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <div className="py-3 flex items-center justify-between gap-4 text-xs">
      <div>
        <p className="font-medium text-nd-text-primary">{title}</p>
        <p className="text-[11px] text-nd-text-secondary mt-0.5">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        onClick={() => onToggle(!checked)}
        className={`w-11 h-6 shrink-0 flex items-center rounded-full p-1 transition-colors min-h-[44px] ${
          checked ? 'bg-nd-teal' : 'bg-white/[0.1]'
        }`}
      >
        <div
          aria-hidden="true"
          className={`bg-nd-bg-0 w-4 h-4 rounded-full shadow-md transform transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}

function CapabilityTile({ label, ok, okText, fallbackText }: { label: string; ok: boolean | undefined; okText: string; fallbackText: string }) {
  return (
    <div className="rounded-xl bg-nd-bg-1 border border-white/[0.06] p-3">
      <span className="text-[10px] text-nd-text-secondary/80 block font-mono">{label}</span>
      <span className="font-medium text-nd-text-primary mt-1 block">
        {ok ? (
          <span className="text-nd-teal flex items-center gap-1">
            <Check className="w-3 h-3" aria-hidden="true" />
            {okText}
          </span>
        ) : (
          <span className="text-nd-text-secondary">{fallbackText}</span>
        )}
      </span>
    </div>
  );
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
    <div className="mx-auto max-w-4xl space-y-6 text-left">
      {/* Header */}
      <div className="pb-4 border-b border-white/[0.08]">
        <div className="flex items-center gap-2">
          <h1 className="text-xl sm:text-2xl font-semibold text-nd-text-primary">Settings</h1>
          <span className="text-[11px] font-medium text-nd-text-secondary bg-white/[0.06] px-2.5 py-0.5 rounded-full border border-white/[0.08]">
            Local Preferences
          </span>
        </div>
        <p className="text-xs text-nd-text-secondary mt-1">
          Profile, transfer parameters, storage, notifications and security. All settings are stored locally on this device.
        </p>

        {/* In-page section navigation */}
        <nav aria-label="Settings sections" className="mt-3 flex flex-wrap gap-1.5">
          {[
            { href: '#settings-profile', label: 'Profile' },
            { href: '#settings-theme', label: 'Theme' },
            { href: '#settings-transfers', label: 'Transfer Settings' },
            { href: '#settings-storage', label: 'Storage' },
            { href: '#settings-notifications', label: 'Notifications' },
            { href: '#settings-security', label: 'Security' },
            { href: '#settings-advanced', label: 'Advanced' },
            { href: '#settings-about', label: 'About' },
          ].map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-lg border border-white/[0.08] bg-nd-surface px-2.5 py-1.5 text-[11px] font-medium text-nd-text-secondary hover:text-nd-text-primary hover:border-white/20 transition-colors"
            >
              {item.label}
            </a>
          ))}
        </nav>
      </div>

      {/* 1 — PROFILE */}
      <SectionCard id="settings-profile" icon={UserRound} title="Profile">
        <div>
          <label htmlFor="device-name-input" className="block text-xs font-medium text-nd-text-primary mb-1.5">
            Device Display Name
          </label>
          <p className="text-xs text-nd-text-secondary mb-3">
            This name is visible to paired devices during session connection and transfer prompts.
          </p>

          <form onSubmit={handleSaveName} className="flex flex-wrap gap-2 max-w-md">
            <input
              id="device-name-input"
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              maxLength={40}
              placeholder="e.g. Pixel 10, MacBook Pro, Studio PC"
              className="flex-1 min-w-[200px] rounded-xl border border-white/[0.1] bg-nd-bg-1 px-3.5 py-2 text-xs sm:text-sm text-nd-text-primary focus:border-nd-teal focus:outline-none transition-all font-medium"
            />
            <button
              type="submit"
              className="rounded-xl bg-nd-teal px-4 py-2 text-xs font-semibold text-nd-bg-0 hover:bg-nd-teal-bright transition-colors shrink-0 shadow-sm min-h-[36px]"
            >
              {savedName ? (
                <span className="flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />
                  Saved
                </span>
              ) : (
                'Save'
              )}
            </button>
          </form>
        </div>

        <div className="pt-3 flex flex-wrap items-center gap-4 text-xs text-nd-text-secondary">
          <div className="flex items-center gap-1.5">
            <Smartphone className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="text-nd-text-secondary/80">Platform:</span>
            <span className="text-nd-text-primary font-mono">{deviceInfo.os}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-nd-text-secondary/80">Browser:</span>
            <span className="text-nd-text-primary font-mono">{deviceInfo.browser}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-nd-text-secondary/80">Device Type:</span>
            <span className="text-nd-text-primary font-mono">
              {deviceInfo.isMobile ? (deviceInfo.isIOS ? 'iOS Mobile' : 'Android Mobile') : 'Desktop / Laptop'}
            </span>
          </div>
        </div>
      </SectionCard>

      {/* 2 — THEME */}
      <SectionCard id="settings-theme" icon={Palette} title="Theme">
        <div className="flex items-center justify-between gap-4 text-xs">
          <div>
            <p className="font-medium text-nd-text-primary">NexDrop Dark</p>
            <p className="text-[11px] text-nd-text-secondary mt-0.5">
              The premium dark interface is built into the app and matched to the PWA theme color
              on every device. No personal data is used to style it.
            </p>
          </div>
          <span className="flex items-center gap-2 shrink-0">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.1] bg-nd-bg-0" aria-hidden="true">
              <span className="h-4 w-4 rounded bg-nd-teal" />
            </span>
            <span className="text-[11px] font-medium text-nd-text-primary">Dark</span>
          </span>
        </div>
      </SectionCard>

      {/* 3 — TRANSFER SETTINGS */}
      <SectionCard id="settings-transfers" icon={Layers} title="Transfer Settings">
        <div className="divide-y divide-white/[0.04] text-xs">
          <ToggleRow
            title="Incremental SHA-256 Hash Verification"
            description="Computes cryptographically secure chunk hashes on both sender and receiver to verify file integrity."
            checked={verifyIntegrity}
            onToggle={setVerifyIntegrity}
            ariaLabel="Incremental SHA-256 hash verification"
          />
          <ToggleRow
            title="Auto-Resume Interrupted Transfers"
            description="Automatically triggers ICE restart and resumes chunk streaming from last confirmed ACK if disconnected."
            checked={autoResume}
            onToggle={setAutoResume}
            ariaLabel="Auto-resume interrupted transfers"
          />
          <div className="py-3 flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-nd-text-primary">Adaptive Streaming Chunk Size</p>
              <p className="text-[11px] text-nd-text-secondary mt-0.5">
                Starts at 64 KiB and grows up to 256 KiB as the link proves stable, with backpressure to prevent buffer saturation.
              </p>
            </div>
            <span className="font-mono text-xs text-nd-teal bg-white/[0.04] px-2.5 py-1 rounded-md shrink-0">
              64-256 KiB
            </span>
          </div>
        </div>
      </SectionCard>

      {/* 4 — STORAGE */}
      <SectionCard id="settings-storage" icon={HardDrive} title="Storage">
        <div className="divide-y divide-white/[0.04] text-xs">
          <div className="py-3 flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-nd-text-primary">Optimal Destination Writer</p>
              <p className="text-[11px] text-nd-text-secondary mt-0.5">
                {capabilities?.fileSystemAccess
                  ? 'File System Access API (streams directly to your disk with zero RAM buffer)'
                  : capabilities?.opfs
                  ? 'Origin Private File System (OPFS persistent streaming)'
                  : 'Memory-safe chunk streaming container'}
              </p>
            </div>
            <span className="font-mono text-[11px] text-nd-teal-bright bg-nd-success/10 px-2 py-0.5 rounded border border-nd-success/20 shrink-0">
              {capabilities?.fileSystemAccess ? 'FileSystemAccess' : capabilities?.opfs ? 'OPFS' : 'Blob'}
            </span>
          </div>

          <div className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className="font-medium text-nd-text-primary">Local Transfer Records</p>
              <p className="text-[11px] text-nd-text-secondary mt-0.5">
                Currently holding {historyCount} local transfer metadata entries in browser storage.
              </p>
            </div>

            <button
              onClick={handleClearHistory}
              disabled={historyCount === 0}
              className="flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl border border-nd-error/20 bg-nd-error/10 text-xs font-medium text-nd-error hover:bg-nd-error/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors self-start sm:self-center min-h-[36px]"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{clearedNotice ? 'Cleared!' : 'Clear Local History'}</span>
            </button>
          </div>
        </div>
      </SectionCard>

      {/* 5 — NOTIFICATIONS */}
      <SectionCard id="settings-notifications" icon={Volume2} title="Notifications">
        <div className="divide-y divide-white/[0.04] text-xs">
          <ToggleRow
            title="Sound Effects"
            description="Synthesized Web Audio chimes for connection establishment, transfer completion, and errors."
            checked={soundEnabled}
            onToggle={onToggleSound}
            ariaLabel="Sound effects"
          />
          <ToggleRow
            title="Vibration Feedback"
            description="Haptic vibration on mobile devices upon successful peer pairing and transfer completion."
            checked={vibrationEnabled}
            onToggle={onToggleVibration}
            ariaLabel="Vibration feedback"
          />
        </div>
      </SectionCard>

      {/* 6 — SECURITY */}
      <SectionCard id="settings-security" icon={ShieldCheck} title="Security">
        <p className="text-xs text-nd-text-secondary">
          Real-time audit of local browser APIs used by NexDrop for P2P streaming and persistent storage.
          These are <strong className="text-nd-text-primary">browser capabilities</strong> — API support only, not
          permissions. NexDrop requests <strong className="text-nd-text-primary">no permission up front</strong>;
          the camera permission is requested only when you open the QR scanner and the camera stops
          immediately after a scan or cancel. No location, Bluetooth, microphone, Wi-Fi or hotspot
          permission is ever requested.
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
          <CapabilityTile label="WebRTC Core" ok={capabilities?.webRTC} okText="Supported" fallbackText="Unavailable" />
          <CapabilityTile label="RTCDataChannel" ok={capabilities?.dataChannel} okText="Supported" fallbackText="Unavailable" />
          <CapabilityTile
            label="File System Access"
            ok={capabilities?.fileSystemAccess}
            okText="Supported"
            fallbackText="OPFS Fallback"
          />
          <CapabilityTile label="OPFS Storage" ok={capabilities?.opfs} okText="Supported" fallbackText="Fallback" />
          <CapabilityTile label="Web Crypto API" ok={capabilities?.webCrypto} okText="Active" fallbackText="Unavailable" />
          <CapabilityTile label="Camera API (QR)" ok={capabilities?.camera} okText="Ready" fallbackText="Unavailable" />
          <CapabilityTile label="Clipboard API" ok={capabilities?.clipboard} okText="Supported" fallbackText="Unavailable" />
          <CapabilityTile label="Service Worker" ok={capabilities?.serviceWorker} okText="Supported" fallbackText="Unavailable" />
        </div>
      </SectionCard>

      {/* 7 — ADVANCED: Device Test & Diagnostics */}
      <SectionCard id="settings-advanced" icon={Activity} title="Advanced">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <p className="font-medium text-nd-text-primary">Device Test &amp; Diagnostics</p>
            <p className="text-[11px] text-nd-text-secondary mt-0.5 max-w-md">
              Run a real two-device transfer test and inspect WebRTC path, bitrate, RTT,
              flow-control, receiver write performance, stalls and bottlenecks. Records real values
              only (N/A when the browser does not expose a metric); nothing is uploaded, diagnostics
              stay on this device. The transfer engine itself is untouched.
            </p>
          </div>
          <button
            type="button"
            onClick={openDeviceTest}
            className="shrink-0 rounded-lg border border-nd-teal/40 bg-nd-teal/10 px-4 py-2 text-xs font-semibold text-nd-teal hover:bg-nd-teal/20 transition-colors"
          >
            Open Device Test
          </button>
        </div>
      </SectionCard>

      {/* 8 — ABOUT */}
      <SectionCard id="settings-about" icon={Info} title="About">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs">
          <div>
            <p className="font-medium text-nd-text-primary">NexDrop — Private · Direct · Fast</p>
            <p className="text-[11px] text-nd-text-secondary mt-0.5">
              A P2P file &amp; text sharing app. Files travel directly between devices over
              encrypted WebRTC DataChannels — never through cloud file storage. Pairing uses a
              lightweight ephemeral signaling service.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <Link href="/about" className="flex items-center gap-1 text-[11px] text-nd-teal-bright hover:underline">
              <span>About</span>
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </Link>
            <Link href="/security" className="flex items-center gap-1 text-[11px] text-nd-teal-bright hover:underline">
              <span>Security Whitepaper</span>
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </Link>
            <Link href="/privacy" className="flex items-center gap-1 text-[11px] text-nd-text-secondary hover:text-white hover:underline">
              <span>Privacy Policy</span>
            </Link>
          </div>
        </div>
      </SectionCard>
    </div>
  );
};
