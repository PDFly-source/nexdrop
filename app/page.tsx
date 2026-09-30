'use client';

import React, { useEffect, useRef, useState, useSyncExternalStore, Suspense } from 'react';
import { Navbar, WorkspaceTab } from '@/components/layout/Navbar';
import { BottomNav } from '@/components/layout/BottomNav';
import { Footer } from '@/components/layout/Footer';
import { ConnectionStatusArea } from '@/components/transfer/ConnectionStatusArea';
import { SendDropzone } from '@/components/transfer/SendDropzone';
import { IncomingTransfersCard } from '@/components/transfer/IncomingTransfersCard';
import { ActiveTransferCard } from '@/components/transfer/ActiveTransferCard';
import { ClipboardWorkspace } from '@/components/clipboard/ClipboardWorkspace';
import { HistoryWorkspace } from '@/components/history/HistoryWorkspace';
import { SettingsWorkspace } from '@/components/settings/SettingsWorkspace';
import { SecurityVerifyModal } from '@/components/dialogs/SecurityVerifyModal';
import { MediaPreviewModal } from '@/components/preview/MediaPreviewModal';
import { useNexDropSession } from '@/hooks/useNexDropSession';
import { updateHistoryVerification } from '@/lib/storage/history';
import { useTransferEngine } from '@/hooks/useTransferEngine';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { FileItem } from '@/types/transfer';
import {
  WifiOff,
  ShieldCheck,
  Lock,
  ArrowUpRight,
  ArrowDownLeft,
  UploadCloud,
  Download,
  CheckCircle2,
  HardDrive,
  ExternalLink,
} from 'lucide-react';
import Link from 'next/link';

const emptySubscribe = () => () => {};

function NexDropMainContent() {
  const autoJoinAttempted = useRef<boolean>(false);

  // Mounted status to guard against any client-server hydration mismatch
  const isMounted = useSyncExternalStore(emptySubscribe, () => true, () => false);

  // Active top-level workspace tab
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('transfer');

  // Mobile Send / Receive toggle
  const [mobileTransferMode, setMobileTransferMode] = useState<'send' | 'receive'>('send');

  // Modals state
  const [isSecurityModalOpen, setIsSecurityModalOpen] = useState<boolean>(false);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);

  // Hydration-safe network status
  const isOnline = useNetworkStatus();

  // Master Session Hook
  const {
    sessionState,
    peerInfo,
    sasCode,
    isSecurityVerified,
    pairingError,
    offerQr,
    answerQr,
    deviceInfo,
    capabilities,
    textMessages,
    clipboardItems,
    transferHistory,
    soundEnabled,
    vibrationEnabled,
    rttMs,
    peerManager,
    cipher,
    createPairing,
    submitAnswer,
    joinWithOffer,
    verifySasSecurityCode,
    sendTextMessage,
    sendClipboardItem,
    addHistoryItem,
    clearHistory,
    toggleSound,
    toggleVibration,
    updateDeviceName,
    setPairingError,
    disconnect,
    onFileChunkCallbackRef,
    onControlCallbackRef,
  } = useNexDropSession();

  // Master Transfer Engine Hook
  const isPeerConnected = sessionState === 'connected';

  const {
    sendQueue,
    incomingFiles,
    activeTransfer,
    addFilesToSend,
    removeSendItem,
    clearCompletedSends,
    pauseActiveTransfer,
    resumeActiveTransfer,
    cancelActiveTransfer,
  } = useTransferEngine(
    peerManager,
    isPeerConnected,
    onFileChunkCallbackRef,
    onControlCallbackRef,
    cipher,
    (completedItem) => {
      addHistoryItem({
        id: completedItem.transferId || `hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: completedItem.name,
        size: completedItem.size,
        direction: completedItem.direction,
        timestamp: Date.now(),
        status: 'completed',
        hashVerified: completedItem.hashVerified,
      });
    },
    (transferId, match) => {
      // Update the local history record when the receiver's VERIFY verdict arrives
      try {
        updateHistoryVerification(transferId, match);
      } catch {
        // history is best-effort local metadata
      }
    }
  );

  // Handle invite links: #join=<pairing code> loads the offer automatically
  useEffect(() => {
    if (autoJoinAttempted.current) return;
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    const match = hash && hash.startsWith('#join=') ? decodeURIComponent(hash.slice('#join='.length)) : null;
    if (match) {
      autoJoinAttempted.current = true;
      joinWithOffer(match);
    }
  }, [joinWithOffer]);

  return (
    <div className="min-h-screen bg-[#0B0D0F] text-[#F5F7F8] selection:bg-[#19C37D]/20 selection:text-[#3DD6A0] flex flex-col justify-between">
      {/* Offline Banner */}
      {isMounted && !isOnline && (
        <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 text-center text-xs text-[#F59E0B] flex items-center justify-center gap-2">
          <WifiOff className="w-3.5 h-3.5" />
          <span>You are currently offline. Local P2P features remain cached and functional.</span>
        </div>
      )}

      <div>
        {/* Modern Workspace Header */}
        <Navbar
          activeTab={activeTab}
          onTabChange={(tab) => setActiveTab(tab)}
          sessionState={sessionState}
          peerName={peerInfo?.name}
          onOpenConnectionDetails={() => setActiveTab('transfer')}
          onStartPairing={() => {
            setActiveTab('transfer');
            createPairing();
          }}
        />

        <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8 sm:px-6 space-y-6">
        <h1 className="sr-only">NexDrop — peer-to-peer file and text transfer</h1>
        {/* WORKSPACE 1: TRANSFER (MAIN P2P WORKSPACE) */}
        {activeTab === 'transfer' && (
          <>
            {/* Top Focused Connection Status Area */}
            <ConnectionStatusArea
              sessionState={sessionState}
              offerQr={offerQr}
              answerQr={answerQr}
              pairingError={pairingError}
              peerInfo={peerInfo}
              sasCode={sasCode}
              isSecurityVerified={isSecurityVerified}
              rttMs={rttMs}
              onCreatePairing={() => void createPairing()}
              onSubmitAnswer={submitAnswer}
              onJoinWithOffer={joinWithOffer}
              onClearPairingError={() => setPairingError(null)}
              onDisconnect={disconnect}
              onOpenSecurityModal={() => setIsSecurityModalOpen(true)}
            />

            {/* Active Transfer Card (Highlighted at top when active) */}
            {activeTransfer && (
              <div className="animate-in fade-in duration-150">
                <ActiveTransferCard
                  activeTransfer={activeTransfer}
                  onPause={pauseActiveTransfer}
                  onResume={resumeActiveTransfer}
                  onCancel={cancelActiveTransfer}
                />
              </div>
            )}

            {/* Mobile Segmented Toggle [ Send ] [ Receive ] when space is limited */}
            <div className="flex lg:hidden items-center justify-center pt-1">
              <div className="grid grid-cols-2 rounded-xl bg-[#15191E] p-1 border border-white/[0.08] w-full max-w-xs shadow-sm">
                <button
                  onClick={() => setMobileTransferMode('send')}
                  className={`flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-lg transition-all ${
                    mobileTransferMode === 'send'
                      ? 'bg-[#19C37D] text-[#0B0D0F] shadow-sm'
                      : 'text-[#9AA3AD] hover:text-[#F5F7F8]'
                  }`}
                >
                  <UploadCloud className="w-3.5 h-3.5" />
                  <span>Send ({sendQueue.length})</span>
                </button>
                <button
                  onClick={() => setMobileTransferMode('receive')}
                  className={`flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-lg transition-all ${
                    mobileTransferMode === 'receive'
                      ? 'bg-[#19C37D] text-[#0B0D0F] shadow-sm'
                      : 'text-[#9AA3AD] hover:text-[#F5F7F8]'
                  }`}
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Receive ({incomingFiles.length})</span>
                </button>
              </div>
            </div>

            {/* Send / Receive Workspace: Desktop 2-column bento, Mobile tabbed view */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
              {/* Send Dropzone & Queue */}
              <div
                className={`lg:col-span-6 flex flex-col ${
                  mobileTransferMode === 'send' ? 'block' : 'hidden lg:flex'
                }`}
              >
                <SendDropzone
                  sendQueue={sendQueue}
                  isConnected={isPeerConnected}
                  onFilesSelected={addFilesToSend}
                  onRemoveItem={removeSendItem}
                  onClearCompleted={clearCompletedSends}
                  onPromptConnect={() => setActiveTab('transfer')}
                />
              </div>

              {/* Incoming Received Files */}
              <div
                className={`lg:col-span-6 flex flex-col ${
                  mobileTransferMode === 'receive' ? 'block' : 'hidden lg:flex'
                }`}
              >
                <IncomingTransfersCard
                  incomingFiles={incomingFiles}
                  onPreviewFile={(file) => setPreviewFile(file)}
                  supportsFileSystemAccess={isMounted ? !!capabilities?.fileSystemAccess : false}
                />
              </div>
            </div>

            {/* Minimal Trust & Architecture Info Banner */}
            <div className="rounded-2xl border border-white/[0.06] bg-[#111418] p-5 text-xs text-[#9AA3AD] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-[#19C37D] border border-emerald-500/20">
                  <ShieldCheck className="w-4 h-4" />
                </div>
                <div>
                  <p className="font-medium text-[#F5F7F8]">Zero-Cloud P2P Architecture</p>
                  <p className="text-[11px] text-[#9AA3AD] mt-0.5">
                    Pairing happens by QR or pasted codes between your devices only — there is no server at all. Files and text travel strictly over encrypted WebRTC DataChannels.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0 self-start sm:self-center">
                <Link
                  href="/security"
                  className="flex items-center gap-1 text-[11px] text-[#3DD6A0] hover:underline"
                >
                  <span>Security Whitepaper</span>
                  <ExternalLink className="w-3 h-3" />
                </Link>
                <span className="text-white/20">·</span>
                <Link
                  href="/privacy"
                  className="flex items-center gap-1 text-[11px] text-[#9AA3AD] hover:text-white"
                >
                  <span>Privacy Policy</span>
                </Link>
              </div>
            </div>
          </>
        )}

        {/* WORKSPACE 2: CLIPBOARD & CODE */}
        {activeTab === 'clipboard' && (
          <ClipboardWorkspace
            isConnected={isPeerConnected}
            peerName={peerInfo?.name}
            clipboardItems={clipboardItems}
            textMessages={textMessages}
            onSendText={sendTextMessage}
            onSendClipboard={sendClipboardItem}
            onPromptConnect={() => {
              setActiveTab('transfer');
            }}
          />
        )}

        {/* WORKSPACE 3: HISTORY */}
        {activeTab === 'history' && (
          <HistoryWorkspace
            historyItems={transferHistory}
            onClearHistory={clearHistory}
            onNavigateTransfer={() => setActiveTab('transfer')}
          />
        )}

        {/* WORKSPACE 4: SETTINGS */}
        {activeTab === 'settings' && (
          <SettingsWorkspace
            deviceInfo={deviceInfo}
            capabilities={capabilities}
            soundEnabled={soundEnabled}
            vibrationEnabled={vibrationEnabled}
            onToggleSound={toggleSound}
            onToggleVibration={toggleVibration}
            onUpdateDeviceName={updateDeviceName}
            onClearHistory={clearHistory}
            historyCount={transferHistory.length}
          />
        )}
        </main>
      </div>

      {/* Global Dialogs & Modals */}
      <SecurityVerifyModal
        isOpen={isSecurityModalOpen}
        onClose={() => setIsSecurityModalOpen(false)}
        sasCode={sasCode || '—'}
        isVerified={isSecurityVerified}
        peerName={peerInfo?.name}
        onConfirmVerification={(verified) => verifySasSecurityCode(verified)}
      />

      <MediaPreviewModal
        file={previewFile}
        onClose={() => setPreviewFile(null)}
      />

      {/* Mobile Bottom Navigation */}
      <BottomNav
        activeTab={activeTab}
        onTabChange={(tab) => setActiveTab(tab)}
        unreadClipboardCount={clipboardItems.length}
      />

      {/* Standard Footer with padding for mobile bottom bar */}
      <div className="pb-16 md:pb-0">
        <Footer />
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#0B0D0F] flex items-center justify-center">
          <div className="flex items-center gap-3 text-xs text-[#9AA3AD]">
            <div className="h-4 w-4 rounded-full border-2 border-[#19C37D] border-t-transparent animate-spin" />
            <span>Loading NexDrop workspace…</span>
          </div>
        </div>
      }
    >
      <NexDropMainContent />
    </Suspense>
  );
}
