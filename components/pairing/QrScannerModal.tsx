'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Camera, X, RefreshCw, AlertCircle } from 'lucide-react';
import jsQR from 'jsqr';

interface QrScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScanSuccess: (data: string) => void;
}

export const QrScannerModal: React.FC<QrScannerModalProps> = ({
  isOpen,
  onClose,
  onScanSuccess,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const animationFrameIdRef = useRef<number | null>(null);

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

  const tick = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    if (video.readyState === video.HAVE_ENOUGH_DATA && ctx) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert',
      });

      if (code && code.data) {
        onScanSuccess(code.data);
        stopCamera();
        onClose();
        return;
      }
    }

    animationFrameIdRef.current = requestAnimationFrame(() => tickRef.current());
  }, [onClose, onScanSuccess, stopCamera]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    let streamInstance: MediaStream | null = null;

    if (!navigator.mediaDevices?.getUserMedia) {
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((stream) => {
        if (!isMounted) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamInstance = stream;
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute('playsinline', 'true');
          videoRef.current.play();
          setIsScanning(true);
          requestAnimationFrame(() => tickRef.current());
        }
      })
      .catch((err: any) => {
        if (!isMounted) return;
        setError(
          err.name === 'NotAllowedError'
            ? 'Camera permission denied. Please allow camera access in your browser settings.'
            : err.message || 'Unable to access camera.'
        );
        setIsScanning(false);
      });

    return () => {
      isMounted = false;
      if (streamInstance) {
        streamInstance.getTracks().forEach((t) => t.stop());
      }
      stopCamera();
    };
  }, [isOpen, stopCamera]);

  const handleRetryCamera = () => {
    setError(null);
    if (navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: 'environment' } })
        .then((stream) => {
          streamRef.current = stream;
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.setAttribute('playsinline', 'true');
            videoRef.current.play();
            setIsScanning(true);
            requestAnimationFrame(() => tickRef.current());
          }
        })
        .catch((err: any) => {
          setError(
            err.name === 'NotAllowedError'
              ? 'Camera permission denied. Please allow camera access in your browser settings.'
              : err.message || 'Unable to access camera.'
          );
        });
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-[#15191E] p-5 shadow-2xl">
        <div className="flex items-center justify-between pb-3 border-b border-white/[0.08]">
          <div className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-[#19C37D]" />
            <h3 className="text-sm font-semibold text-[#F5F7F8]">Scan NexDrop QR</h3>
          </div>
          <button
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="text-[#9AA3AD] hover:text-[#F5F7F8]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="relative mt-4 overflow-hidden rounded-lg bg-black aspect-square flex items-center justify-center border border-white/10">
          {error ? (
            <div className="p-4 text-center">
              <AlertCircle className="w-8 h-8 text-[#EF4444] mx-auto mb-2" />
              <p className="text-xs text-[#9AA3AD] leading-relaxed">{error}</p>
              <button
                onClick={handleRetryCamera}
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1B2026] text-xs font-medium text-[#F5F7F8] hover:bg-white/10"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Retry
              </button>
            </div>
          ) : (
            <>
              <video ref={videoRef} className="w-full h-full object-cover" />
              <canvas ref={canvasRef} className="hidden" />

              {/* Viewfinder crosshairs */}
              <div className="pointer-events-none absolute inset-8 border-2 border-dashed border-[#19C37D]/60 rounded-xl flex items-center justify-center">
                <div className="w-full h-0.5 bg-[#19C37D]/80 animate-pulse" />
              </div>
            </>
          )}
        </div>

        <p className="mt-3 text-center text-xs text-[#9AA3AD]">
          Point your camera at the QR code displayed on the other device.
        </p>
      </div>
    </div>
  );
};
