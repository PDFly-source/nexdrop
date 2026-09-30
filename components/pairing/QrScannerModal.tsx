'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Camera, X, RefreshCw, AlertCircle, Image as ImageIcon, ClipboardPaste, Loader2 } from 'lucide-react';
import jsQR from 'jsqr';
import { QrSegmentAssembler } from '@/lib/pairing/payload';

interface QrScannerModalProps {
  isOpen: boolean;
  title?: string;
  onClose: () => void;
  /** Called with the complete pairing code once all QR segments are scanned. */
  onScanComplete: (data: string) => void;
}

/**
 * QR scanning modal: live camera (where permission & browser allow),
 * QR-image file import fallback, and manual text paste fallback.
 * Handles multi-QR payloads transparently with real reassembly progress.
 */
export const QrScannerModal: React.FC<QrScannerModalProps> = ({
  isOpen,
  title = 'Scan NexDrop QR',
  onClose,
  onScanComplete,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastDecodeAtRef = useRef<number>(0);
  const assemblerRef = useRef<QrSegmentAssembler>(new QrSegmentAssembler());
  const onScanCompleteRef = useRef(onScanComplete);

  useEffect(() => {
    onScanCompleteRef.current = onScanComplete;
  }, [onScanComplete, onScanCompleteRef]);

  const [error, setError] = useState<string | null>(null);
  /** Transient, non-blocking notice shown over the live camera. */
  const [notice, setNotice] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [segmentProgress, setSegmentProgress] = useState<{ received: number; total: number } | null>(null);
  const [pasteText, setPasteText] = useState<string>('');
  const [isDecodingImage, setIsDecodingImage] = useState<boolean>(false);

  const stopCamera = useCallback(() => {
    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsScanning(false);
  }, []);

  const tickRef = useRef<() => void>(() => {});

  const handleScannedText = useCallback((raw: string) => {
    const result = assemblerRef.current.feed(raw);
    if (result.error) {
      if (result.error === 'wrong-session' || result.error === 'timeout') {
        // Fatal for this assembly: start over.
        setError(
          result.error === 'wrong-session'
            ? 'That QR belongs to a different pairing. Start the scan again.'
            : 'Scan timed out. Please start again.'
        );
        assemblerRef.current.reset();
        setSegmentProgress(null);
        setNotice(null);
        return;
      }
      // Misread fragment or a foreign QR: if we are mid-assembly, KEEP the
      // fragments already collected and let the user re-scan — a phone
      // camera misreads an occasional frame, and silently discarding
      // progress would force a full restart.
      if (result.received > 0) {
        setNotice(
          result.error === 'corrupt-segment'
            ? 'That fragment did not read cleanly — scan it again.'
            : 'Keep scanning the NexDrop pairing QRs.'
        );
        return;
      }
      setError(
        result.error === 'corrupt-segment'
          ? 'That QR did not read cleanly. Hold the camera steady over the code, or use the image / paste fallback below.'
          : 'That is not a NexDrop pairing QR code.'
      );
      assemblerRef.current.reset();
      setSegmentProgress(null);
      setNotice(null);
      return;
    }
    if (result.code) {
      setSegmentProgress(null);
      setNotice(null);
      assemblerRef.current.reset();
      stopCamera();
      onScanCompleteRef.current(result.code);
      return;
    }
    // Multi-QR in progress
    setNotice(null);
    setSegmentProgress({ received: result.received, total: result.total });
  }, [stopCamera]);

  const tick = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Decode at most ~8 times per second: jsQR over a full video frame is
      // expensive, and unthrottled rAF decoding overheats phones without
      // making detection any more reliable.
      const now = performance.now();
      if (now - lastDecodeAtRef.current >= 120) {
        lastDecodeAtRef.current = now;
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        // attemptBoth: our QRs are standard dark-on-light, but tolerate
        // inverted captures (e.g. photographed off a reflection) too.
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'attemptBoth',
        });

        if (code && code.data) {
          handleScannedText(code.data);
          if (
            code.data.startsWith('NDP1.') ||
            code.data.startsWith('NDP2.') ||
            code.data.startsWith('NDPS1.')
          ) {
            return; // complete single QR — stop the camera immediately
          }
          // multi-segment: keep the camera running for the next segment
        }
      }
    }

    animationFrameIdRef.current = requestAnimationFrame(() => tickRef.current());
  }, [handleScannedText]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  const startCamera = useCallback(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      window.setTimeout(
        () => setError('This browser does not support camera access. Use the image or paste fallback below.'),
        0
      );
      return;
    }
    navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode: 'environment',
          // Ask for a decent resolution: dense pairing QRs need the pixels.
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      })
      .then((stream) => {
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute('playsinline', 'true');
          void videoRef.current.play();
          setIsScanning(true);
          setError(null);
          requestAnimationFrame(() => tickRef.current());
        }
      })
      .catch((err: any) => {
        setIsScanning(false);
        if (err.name === 'NotAllowedError') {
          setError('Camera permission denied. Allow camera access, or use the image / paste fallback below.');
        } else if (err.name === 'NotFoundError') {
          setError('No camera found on this device. Use the image / paste fallback below.');
        } else {
          setError(err?.message || 'Unable to access camera. Use the image / paste fallback below.');
        }
      });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    startCamera();
    return () => {
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // ---------------------------------------------------------------------
  // QR image file import fallback
  // ---------------------------------------------------------------------

  const handleImageFile = useCallback(async (file: File) => {
    setIsDecodingImage(true);
    setError(null);
    try {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.decoding = 'async';
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Could not load image'));
          img.src = url;
        });

        const canvas = document.createElement('canvas');
        const maxDim = 1600;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Canvas unavailable');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'attemptBoth',
        });
        if (!code || !code.data) {
          setError('No QR code found in that image.');
          return;
        }
        handleScannedText(code.data);
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to read that image.');
    } finally {
      setIsDecodingImage(false);
    }
  }, [handleScannedText]);

  const handlePasteSubmit = () => {
    const text = pasteText.trim();
    if (!text) return;
    handleScannedText(text);
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-[#15191E] p-5 shadow-2xl">
        <div className="flex items-center justify-between pb-3 border-b border-white/[0.08]">
          <div className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-[#19C37D]" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-[#F5F7F8]">{title}</h3>
          </div>
          <button
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="rounded-md p-1 text-[#9AA3AD] hover:text-[#F5F7F8] hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
            aria-label="Close QR scanner"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="relative mt-4 overflow-hidden rounded-lg bg-black aspect-square flex items-center justify-center border border-white/10">
          {error ? (
            <div className="p-4 text-center" role="alert">
              <AlertCircle className="w-8 h-8 text-[#EF4444] mx-auto mb-2" aria-hidden="true" />
              <p className="text-xs text-[#9AA3AD] leading-relaxed">{error}</p>
              <button
                onClick={() => {
                  setError(null);
                  startCamera();
                }}
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1B2026] text-xs font-medium text-[#F5F7F8] hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                Retry camera
              </button>
            </div>
          ) : (
            <>
              <video ref={videoRef} className="w-full h-full object-cover" playsInline muted aria-label="Camera preview" />
              <canvas ref={canvasRef} className="hidden" />

              <div className="pointer-events-none absolute inset-8 border-2 border-dashed border-[#19C37D]/60 rounded-xl flex items-center justify-center">
                <div className="w-full h-0.5 bg-[#19C37D]/80 animate-pulse" />
              </div>

              {notice && (
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 max-w-[90%] rounded-lg bg-black/75 px-3 py-1.5 text-xs text-[#F5F7F8] text-center" role="status">
                  {notice}
                </div>
              )}

              {isDecodingImage && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                  <Loader2 className="w-6 h-6 text-[#19C37D] animate-spin" aria-hidden="true" />
                </div>
              )}
            </>
          )}
        </div>

        {/* Multi-QR reassembly progress */}
        {segmentProgress && segmentProgress.total > 1 && (
          <div
            className="mt-3 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-center text-xs text-[#3DD6A0]"
            role="status"
            aria-live="polite"
          >
            Code {segmentProgress.received} of {segmentProgress.total} scanned — keep going
          </div>
        )}

        <p className="mt-3 text-center text-xs text-[#9AA3AD]">
          Point your camera at the QR code shown on the other device.
        </p>

        {/* Fallbacks */}
        <div className="mt-4 pt-4 border-t border-white/[0.06] space-y-3">
          <div className="flex gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-white/[0.1] bg-[#1B2026] text-xs font-medium text-[#F5F7F8] hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
            >
              <ImageIcon className="w-3.5 h-3.5 text-[#19C37D]" aria-hidden="true" />
              Import QR image
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              aria-label="Import QR code image"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImageFile(file);
                e.target.value = '';
              }}
            />
          </div>

          <div>
            <label htmlFor="qr-paste" className="text-[11px] text-[#9AA3AD]">
              Or paste the pairing code from the other device:
            </label>
            <div className="mt-1.5 flex gap-2">
              <textarea
                id="qr-paste"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={2}
                placeholder="NDP1.…"
                className="flex-1 rounded-lg border border-white/[0.1] bg-[#111418] px-3 py-2 text-xs font-mono text-[#F5F7F8] placeholder:text-[#9AA3AD]/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D] resize-none"
              />
              <button
                onClick={handlePasteSubmit}
                disabled={!pasteText.trim()}
                className="self-stretch inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#19C37D] text-xs font-semibold text-[#0B0D0F] hover:bg-[#3DD6A0] disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
              >
                <ClipboardPaste className="w-3.5 h-3.5" aria-hidden="true" />
                Use
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
