'use client';

import React, { useEffect, useRef, useState, useSyncExternalStore, Suspense } from 'react';
import { Navbar, WorkspaceTab } from '@/components/layout/Navbar';
import { BottomNav } from '@/components/layout/BottomNav';
import { Footer } from '@/components/layout/Footer';
import { HomeWorkspace } from '@/components/home/HomeWorkspace';
import { navigateToTab, subscribeRouter, getRouterTab, getServerRouterTab } from '@/lib/navigation/routing';
import { OnboardingOverlay } from '@/components/home/OnboardingOverlay';
import { TransfersWorkspace } from '@/components/transfers/TransfersWorkspace';
import { DevicesWorkspace } from '@/components/devices/DevicesWorkspace';
import { SettingsWorkspace } from '@/components/settings/SettingsWorkspace';
import { ClipboardOverlay } from '@/components/clipboard/ClipboardOverlay';
import { SecurityVerifyModal } from '@/components/dialogs/SecurityVerifyModal';
import { MediaPreviewModal } from '@/components/preview/MediaPreviewModal';
import DiagnosticsPanel from '@/components/transfer/DiagnosticsPanel';
import DeviceTestPanel from '@/components/dev/DeviceTestPanel';
import { onTestTransferComplete, onTestTransferVerified } from '@/lib/devicetest/recorder';
import { useNexDropSession } from '@/hooks/useNexDropSession';
import { updateHistoryVerification } from '@/lib/storage/history';
import { useSendFlow } from '@/hooks/useSendFlow';
import { useTransferEngine } from '@/hooks/useTransferEngine';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { FileItem } from '@/types/transfer';
import { WifiOff } from 'lucide-react';

import Gateway from '@/components/gateway/Gateway';

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

  // Active workspace tab (LAYER 3 — real routing). The URL is the store:
  // #/home, #/transfers, #/devices, #/settings are deep-linkable and
  // support browser back/forward. Transitions go through navigateToTab
  // (pushState + notify); #join= invite links bypass tab routing untouched.
  const activeTab = useSyncExternalStore(subscribeRouter, getRouterTab, getServerRouterTab);

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
    connectionPhase,
    transferActivity,
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
    transportKind,
    peerManager,
    cipher,
    createPairing,
    createPairingManual,
    pairingMode,
    pairingExpiresAt,
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
    transferProfile,
    setTransferProfile,
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
      // Dev-only Device Test mode: record the real engine completion (name,
      // size, engine-computed SHA-256) when a physical test case is armed.
      // A no-op during the normal journey.
      onTestTransferComplete(completedItem);
    },
    (transferId, match) => {
      // Update the local history record when the receiver's VERIFY verdict arrives
      try {
        updateHistoryVerification(transferId, match);
      } catch {
        // history is best-effort local metadata
      }
      // Dev-only Device Test mode: the receiver's real SHA-256 verdict.
      onTestTransferVerified(transferId, match);
    },
    setTransferActivity
  );

  const sendFlow = useSendFlow({
    sessionState, sendQueue, addFiles: addFilesToSend, createPairing, disconnect,
  });
  const openSend = () => { sendFlow.beginSend(); navigateToTab('transfers'); };
  // Home → RECEIVE opens the QR scanner directly (camera permission is
  // only requested when the scanner opens). One tap, zero technical steps.
  const [receiveScanTick, setReceiveScanTick] = useState(0);
  const openReceive = () => { navigateToTab('devices'); setReceiveScanTick((t) => t + 1); };

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
      if (activeTab === 'home') navigateToTab('devices');
    }
    prevSessionStateRef.current = sessionState;
  }, [sessionState, activeTab]);

  // A live transfer starting should be visible too — send the user to
  // Transfers so real progress/speed/ETA is on screen (only from Home).
  const hasActiveTransfer = !!activeTransfer;
  const prevHasActiveTransferRef = useRef(hasActiveTransfer);
  useEffect(() => {
    if (hasActiveTransfer && !prevHasActiveTransferRef.current) {
      if (activeTab === 'home') navigateToTab('transfers');
    }
    prevHasActiveTransferRef.current = hasActiveTransfer;
  }, [hasActiveTransfer, activeTab]);

  return (
    <div id="webapp-root" className="min-h-screen bg-nd-bg-0 text-nd-text-primary selection:bg-nd-teal/20 selection:text-nd-teal-bright flex flex-col justify-between">
      {/* LAYER 1 — first-launch onboarding (shows once per browser) */}
      <OnboardingOverlay />

      {/* Offline Banner */}
      {isMounted && !isOnline && (
        <div className="bg-nd-warning/10 border-b border-nd-warning/20 px-4 py-2 text-center text-xs text-nd-warning flex items-center justify-center gap-2">
          <WifiOff className="w-3.5 h-3.5" aria-hidden="true" />
          <span>You are currently offline. Local P2P features remain cached and functional.</span>
        </div>
      )}

        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:rounded-lg focus:bg-nd-teal-bright focus:text-black focus:text-sm focus:font-semibold focus:shadow-lg"
        >
          Skip to main content
        </a>
      <div>
        {/* Workspace Header */}
        <Navbar
          activeTab={activeTab}
          onTabChange={(tab) => navigateToTab(tab)}
          connectionPhase={connectionPhase}
          transferDirection={transferActivity.direction}
          peerName={peerInfo?.name}
          peerPlatform={peerInfo?.platform}
          onOpenConnectionDetails={() => navigateToTab('devices')}
          onStartPairing={() => {
            navigateToTab('devices');
            createPairing();
          }}
        />

        <main
          id="main-content"
          tabIndex={-1}
          key={activeTab}
          className="mx-auto max-w-6xl px-4 py-6 sm:py-8 sm:px-6 animate-in fade-in duration-200"
        >
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
              transferProfile={transferProfile}
              onSetTransferProfile={setTransferProfile}
              onFilesSelected={sendFlow.queueFiles}
              onBeginSend={openSend}
              onOpenText={() => setIsClipboardOpen(true)}
              onNavigate={(tab) => navigateToTab(tab)}
              onReceiveScan={openReceive}
            />
          )}

          {/* LAYER 5 — TRANSFERS (active queue, incoming, history) */}
          {activeTab === 'transfers' && (
            <TransfersWorkspace
              sendFlowState={sendFlow.state}
              offerQr={offerQr}
              pairingError={pairingError}
              onCancelConnection={sendFlow.cancelConnection}
              onRetryConnection={sendFlow.retry}
              sendQueue={sendQueue}
              incomingFiles={incomingFiles}
              activeTransfer={activeTransfer}
              historyItems={transferHistory}
              onNavigateHome={() => navigateToTab('home')}
              isConnected={isPeerConnected}
              supportsFileSystemAccess={isMounted ? !!capabilities?.fileSystemAccess : false}
              onFilesSelected={sendFlow.queueFiles}
              onRemoveItem={removeSendItem}
              onClearCompleted={clearCompletedSends}
              onPauseTransfer={pauseActiveTransfer}
              onResumeTransfer={resumeActiveTransfer}
              onCancelTransfer={cancelActiveTransfer}
              onClearHistory={clearHistory}
              onPromptConnect={() => navigateToTab('devices')}
              pairingExpiresAt={pairingExpiresAt}
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
              transportKind={transportKind}
              onCreatePairing={() => void createPairing()}
              onCreatePairingManual={() => void createPairingManual()}
              pairingMode={pairingMode}
              receiveScanTick={receiveScanTick}
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

          {/* Dev-only Device Test overlay — owner-run physical validation */}
          <DeviceTestPanel />
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
          navigateToTab('devices');
        }}
      />

      {/* Mobile Bottom Navigation */}
      <BottomNav
        activeTab={activeTab}
        onTabChange={(tab) => navigateToTab(tab)}
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
  /**
   * PREMIUM PUBLIC GATEWAY: a bare "/" visit (no URL hash) shows the premium
   * 3D gateway (components/gateway/Gateway.tsx). ANY hash — #/home,
   * #/transfers, #/devices, #/settings, #join= invite links — renders the
   * WebApp exactly as before, untouched.
   *
   * Hydration-safe: the static export prerenders the WebApp DOM (matching the
   * first client render); the inline pre-paint script in app/layout.tsx adds
   * the nd-gateway class to <html> when the hash is empty so the prerendered
   * shell is hidden from first paint; the swap to <Gateway /> happens after
   * mount. When the visitor picks "Open WebApp" the hash becomes #/home, the
   * class is toggled off, and the real WebApp mounts via this same listener.
   */
  const [gateway, setGateway] = useState<boolean>(false);
  useEffect(() => {
    const update = () => setGateway(window.location.hash === '');
    update();
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  if (gateway) return <Gateway />;

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
