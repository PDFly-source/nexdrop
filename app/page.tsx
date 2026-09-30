'use client';

import React, { useEffect, useRef, useState, useSyncExternalStore, Suspense } from 'react';
import { Navbar, WorkspaceTab } from '@/components/layout/Navbar';
import { BottomNav } from '@/components/layout/BottomNav';
import { Footer } from '@/components/layout/Footer';
import { HomeWorkspace } from '@/components/home/HomeWorkspace';
import { OnboardingOverlay } from '@/components/home/OnboardingOverlay';
import { TransfersWorkspace } from '@/components/transfers/TransfersWorkspace';
import { DevicesWorkspace } from '@/components/devices/DevicesWorkspace';
import { SettingsWorkspace } from '@/components/settings/SettingsWorkspace';
import { ClipboardOverlay } from '@/components/clipboard/ClipboardOverlay';
import { SecurityVerifyModal } from '@/components/dialogs/SecurityVerifyModal';
import { MediaPreviewModal } from '@/components/preview/MediaPreviewModal';
import DiagnosticsPanel from '@/components/transfer/DiagnosticsPanel';
import { useNexDropSession } from '@/hooks/useNexDropSession';
import { updateHistoryVerification } from '@/lib/storage/history';
import { useTransferEngine } from '@/hooks/useTransferEngine';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { FileItem } from '@/types/transfer';
import { WifiOff } from 'lucide-react';

const emptySubscribe = () => () => {};

/**
 * Session states where the pairing state machine is mid-flow. When one of
 * these becomes active while the user is on Home, we surface the Devices
 * screen so the pairing / Accept-Decline decision is never missed —
 * the same visibility the old single-screen workspace guaranteed.
 */
const PAIRING_STATES = new Set([
  'hosting',
  'hosting-offer',
  'waiting-for-join',
  'join-requested',
  'accepted',
  'awaiting-accept',
  'joiner-answer',
  'connecting',
]);

function NexDropMainContent() {
  const autoJoinAttempted = useRef<boolean>(false);

  // Mounted status to guard against any client-server hydration mismatch
  const isMounted = useSyncExternalStore(emptySubscribe, () => true, () => false);

  // Active top-level workspace tab
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('home');

  // Text & Clipboard sheet (re-homed from the old bottom-nav tab)
  const [isClipboardOpen, setIsClipboardOpen] = useState<boolean>(false);

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
    createPairingManual,
    pairingMode,
    signalUnavailable,
    signalJoinerAccepted,
    joinRequestInfo,
    acceptJoinRequest,
    declineJoinRequest,
    setTransferActivity,
    submitAnswer,
    joinWithOffer,
    acceptPendingOffer,
    declinePendingOffer,
    pendingOfferInfo,
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
  const isPeerConnected =
    sessionState === 'connected' || sessionState === 'transferring' || sessionState === 'completed';

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
    },
    setTransferActivity
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

  // Keep pairing flows visible: if a pairing state becomes active while the
  // user sits on Home, move to Devices so QR / Accept-Decline is on screen.
  const prevSessionStateRef = useRef(sessionState);
  useEffect(() => {
    if (prevSessionStateRef.current !== sessionState && PAIRING_STATES.has(sessionState)) {
      setActiveTab((current) => (current === 'home' ? 'devices' : current));
    }
    prevSessionStateRef.current = sessionState;
  }, [sessionState]);

  // A live transfer starting should be visible too — send the user to
  // Transfers so real progress/speed/ETA is on screen (only from Home).
  const hasActiveTransfer = !!activeTransfer;
  const prevHasActiveTransferRef = useRef(hasActiveTransfer);
  useEffect(() => {
    if (hasActiveTransfer && !prevHasActiveTransferRef.current) {
      setActiveTab((current) => (current === 'home' ? 'transfers' : current));
    }
    prevHasActiveTransferRef.current = hasActiveTransfer;
  }, [hasActiveTransfer]);

  return (
    <div className="min-h-screen bg-nd-bg-0 text-nd-text-primary selection:bg-nd-teal/20 selection:text-nd-teal-bright flex flex-col justify-between">
      {/* LAYER 1 — first-launch onboarding (shows once per browser) */}
      <OnboardingOverlay />

      {/* Offline Banner */}
      {isMounted && !isOnline && (
        <div className="bg-nd-warning/10 border-b border-nd-warning/20 px-4 py-2 text-center text-xs text-nd-warning flex items-center justify-center gap-2">
          <WifiOff className="w-3.5 h-3.5" aria-hidden="true" />
          <span>You are currently offline. Local P2P features remain cached and functional.</span>
        </div>
      )}

      <div>
        {/* Workspace Header */}
        <Navbar
          activeTab={activeTab}
          onTabChange={(tab) => setActiveTab(tab)}
          sessionState={sessionState}
          peerName={peerInfo?.name}
          onOpenConnectionDetails={() => setActiveTab('devices')}
          onStartPairing={() => {
            setActiveTab('devices');
            createPairing();
          }}
        />

        <main key={activeTab} className="mx-auto max-w-6xl px-4 py-6 sm:py-8 sm:px-6 animate-in fade-in duration-200">
          <h1 className="sr-only">NexDrop — peer-to-peer file and text transfer</h1>

          {/* LAYER 2 — HOME DASHBOARD (command center) */}
          {activeTab === 'home' && (
            <HomeWorkspace
              isConnected={isPeerConnected}
              peerName={peerInfo?.name}
              sessionState={sessionState}
              historyItems={transferHistory}
              sendQueueCount={sendQueue.length}
              incomingCount={incomingFiles.length}
              onFilesSelected={addFilesToSend}
              onOpenText={() => setIsClipboardOpen(true)}
              onNavigate={(tab) => setActiveTab(tab)}
            />
          )}

          {/* LAYER 5 — TRANSFERS (active queue, incoming, history) */}
          {activeTab === 'transfers' && (
            <TransfersWorkspace
              sendQueue={sendQueue}
              incomingFiles={incomingFiles}
              activeTransfer={activeTransfer}
              historyItems={transferHistory}
              onNavigateHome={() => setActiveTab('home')}
              isConnected={isPeerConnected}
              supportsFileSystemAccess={isMounted ? !!capabilities?.fileSystemAccess : false}
              onFilesSelected={addFilesToSend}
              onRemoveItem={removeSendItem}
              onClearCompleted={clearCompletedSends}
              onPauseTransfer={pauseActiveTransfer}
              onResumeTransfer={resumeActiveTransfer}
              onCancelTransfer={cancelActiveTransfer}
              onClearHistory={clearHistory}
              onPromptConnect={() => setActiveTab('devices')}
              onPreviewFile={(file) => setPreviewFile(file)}
            />
          )}

          {/* LAYER 4/6 — DEVICES (connect, QR pairing, accept/decline, session) */}
          {activeTab === 'devices' && (
            <DevicesWorkspace
              deviceInfo={deviceInfo}
              sessionState={sessionState}
              offerQr={offerQr}
              answerQr={answerQr}
              pairingError={pairingError}
              peerInfo={peerInfo}
              sasCode={sasCode}
              isSecurityVerified={isSecurityVerified}
              rttMs={rttMs}
              onCreatePairing={() => void createPairing()}
              onCreatePairingManual={() => void createPairingManual()}
              pairingMode={pairingMode}
              signalUnavailable={signalUnavailable}
              signalJoinerAccepted={signalJoinerAccepted}
              joinRequestInfo={joinRequestInfo}
              onSubmitAnswer={submitAnswer}
              onJoinWithOffer={joinWithOffer}
              onAcceptPendingOffer={acceptPendingOffer}
              onDeclinePendingOffer={declinePendingOffer}
              onAcceptJoinRequest={acceptJoinRequest}
              onDeclineJoinRequest={declineJoinRequest}
              onStartOver={declinePendingOffer}
              pendingOfferInfo={pendingOfferInfo}
              onClearPairingError={() => setPairingError(null)}
              onDisconnect={disconnect}
              onOpenSecurityModal={() => setIsSecurityModalOpen(true)}
            />
          )}

          {/* LAYER 8 — SETTINGS */}
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

          {/* Dev-only live transfer diagnostics (opt-in: ?diag=1 or localStorage) */}
          <div className="mt-8">
            <DiagnosticsPanel />
          </div>
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

      {/* Text & Clipboard sheet (re-homed clipboard workspace) */}
      <ClipboardOverlay
        isOpen={isClipboardOpen}
        onClose={() => setIsClipboardOpen(false)}
        isConnected={isPeerConnected}
        peerName={peerInfo?.name}
        clipboardItems={clipboardItems}
        textMessages={textMessages}
        onSendText={sendTextMessage}
        onSendClipboard={sendClipboardItem}
        onPromptConnect={() => {
          setIsClipboardOpen(false);
          setActiveTab('devices');
        }}
      />

      {/* Mobile Bottom Navigation */}
      <BottomNav
        activeTab={activeTab}
        onTabChange={(tab) => setActiveTab(tab)}
        activeTransferCount={activeTransfer ? 1 : 0}
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
        <div className="min-h-screen bg-nd-bg-0 flex items-center justify-center">
          <div className="flex items-center gap-3 text-xs text-nd-text-secondary">
            <div className="h-4 w-4 rounded-full border-2 border-nd-teal border-t-transparent animate-spin" aria-hidden="true" />
            <span>Loading NexDrop workspace…</span>
          </div>
        </div>
      }
    >
      <NexDropMainContent />
    </Suspense>
  );
}
