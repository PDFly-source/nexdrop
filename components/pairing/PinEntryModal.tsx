'use client';

import React, { useState, useRef, useEffect } from 'react';
import { KeyRound, X, ArrowRight, AlertCircle, Loader2 } from 'lucide-react';

interface PinEntryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onJoinByPin: (pin: string) => Promise<boolean>;
  onSwitchToScanner?: () => void;
}

export const PinEntryModal: React.FC<PinEntryModalProps> = ({
  isOpen,
  onClose,
  onJoinByPin,
  onSwitchToScanner,
}) => {
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        inputRefs.current[0]?.focus();
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleClose = () => {
    setDigits(['', '', '', '', '', '']);
    setError(null);
    setIsSubmitting(false);
    onClose();
  };

  if (!isOpen) return null;

  const handleDigitChange = (index: number, value: string) => {
    // Only accept numeric characters
    const clean = value.replace(/\D/g, '');
    if (!clean && value !== '') return;

    const newDigits = [...digits];

    if (clean.length > 1) {
      // Pasted multiple digits
      const chars = clean.slice(0, 6).split('');
      for (let i = 0; i < 6; i++) {
        newDigits[i] = chars[i] || '';
      }
      setDigits(newDigits);
      const nextFocus = Math.min(chars.length, 5);
      inputRefs.current[nextFocus]?.focus();

      // If full 6 digits entered via paste, auto submit
      if (chars.length === 6) {
        submitPin(newDigits.join(''));
      }
      return;
    }

    newDigits[index] = clean;
    setDigits(newDigits);

    // Auto-advance to next input
    if (clean && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    // If 6th digit entered, auto submit
    if (clean && index === 5) {
      const fullPin = newDigits.join('');
      if (fullPin.length === 6) {
        submitPin(fullPin);
      }
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;

    const newDigits = [...digits];
    for (let i = 0; i < 6; i++) {
      newDigits[i] = pasted[i] || '';
    }
    setDigits(newDigits);
    const nextFocus = Math.min(pasted.length, 5);
    inputRefs.current[nextFocus]?.focus();

    if (pasted.length === 6) {
      submitPin(pasted);
    }
  };

  const submitPin = async (pinString: string) => {
    if (pinString.length !== 6 || isSubmitting) return;

    setError(null);
    setIsSubmitting(true);

    try {
      const success = await onJoinByPin(pinString);
      if (success) {
        onClose();
      } else {
        setError('Session not found or PIN expired. Please verify and retry.');
        setDigits(['', '', '', '', '', '']);
        inputRefs.current[0]?.focus();
      }
    } catch {
      setError('Connection failed. Please check network and retry.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitPin(digits.join(''));
  };

  const fullPin = digits.join('');
  const isComplete = fullPin.length === 6;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-md rounded-2xl border border-white/[0.1] bg-[#111418] p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/[0.08]">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10 text-[#19C37D] border border-emerald-500/20">
              <KeyRound className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[#F5F7F8]">Enter Pairing PIN</h3>
              <p className="text-xs text-[#9AA3AD]">Enter the 6-digit code shown on the other device</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#9AA3AD] hover:text-[#F5F7F8] hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="mt-6 space-y-6">
          <div className="flex justify-center gap-2 sm:gap-3">
            {digits.map((digit, idx) => (
              <input
                key={idx}
                ref={(el) => {
                  inputRefs.current[idx] = el;
                }}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={idx === 0 ? 6 : 1}
                value={digit}
                onChange={(e) => handleDigitChange(idx, e.target.value)}
                onKeyDown={(e) => handleKeyDown(idx, e)}
                onPaste={idx === 0 ? handlePaste : undefined}
                disabled={isSubmitting}
                className="h-12 w-10 sm:h-14 sm:w-12 rounded-xl border border-white/[0.1] bg-[#15191E] text-center text-xl sm:text-2xl font-mono font-bold text-[#F5F7F8] focus:border-[#19C37D] focus:bg-[#15191E] focus:outline-none focus:ring-2 focus:ring-[#19C37D]/20 transition-all disabled:opacity-50"
              />
            ))}
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-xs text-red-400">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-3">
            <button
              type="submit"
              disabled={!isComplete || isSubmitting}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#19C37D] py-3 text-sm font-medium text-[#0B0D0F] hover:bg-[#3DD6A0] disabled:cursor-not-allowed disabled:opacity-40 transition-all shadow-sm"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Connecting to Peer...</span>
                </>
              ) : (
                <>
                  <span>Connect Device</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>

            {onSwitchToScanner && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onSwitchToScanner();
                }}
                className="w-full text-center text-xs text-[#9AA3AD] hover:text-[#19C37D] py-1 transition-colors"
              >
                Scan QR code with camera instead
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};
