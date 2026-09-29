'use client';

import React from 'react';
import { ShieldCheck, X, Check, AlertTriangle } from 'lucide-react';

interface SecurityVerifyModalProps {
  isOpen: boolean;
  onClose: () => void;
  sasCode: string;
  isVerified: boolean;
  onConfirmVerification: (verified: boolean) => void;
  peerName?: string;
}

export const SecurityVerifyModal: React.FC<SecurityVerifyModalProps> = ({
  isOpen,
  onClose,
  sasCode,
  isVerified,
  onConfirmVerification,
  peerName,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-[#15191E] p-5 shadow-2xl text-left">
        <div className="flex items-center justify-between pb-3 border-b border-white/[0.08]">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[#19C37D]" />
            <h3 className="text-sm font-semibold text-[#F5F7F8]">Peer Verification</h3>
          </div>
          <button onClick={onClose} className="text-[#9AA3AD] hover:text-[#F5F7F8]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="mt-3 text-xs text-[#9AA3AD] leading-relaxed">
          Compare this 6-digit security code with the one displayed on{' '}
          <strong className="text-white">{peerName || 'the other device'}</strong> to confirm you are connected to the intended peer.
        </p>

        {/* Security Code Display */}
        <div className="mt-5 rounded-xl border border-emerald-500/30 bg-[#111418] p-4 text-center">
          <span className="font-mono text-3xl font-bold tracking-widest text-[#19C37D]">
            {sasCode}
          </span>
          <p className="mt-1 text-[11px] text-[#9AA3AD]">Short Authentication String (SAS)</p>
        </div>

        <div className="mt-6 flex items-center gap-2">
          <button
            onClick={() => {
              onConfirmVerification(true);
              onClose();
            }}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-[#19C37D] py-2 text-xs font-semibold text-[#0B0D0F] hover:bg-[#3DD6A0] transition-colors"
          >
            <Check className="w-4 h-4" />
            <span>Codes Match (Verify)</span>
          </button>

          <button
            onClick={() => {
              onConfirmVerification(false);
              onClose();
            }}
            className="flex-1 rounded-lg border border-white/[0.1] bg-[#1B2026] py-2 text-xs font-medium text-[#9AA3AD] hover:text-[#F5F7F8] hover:bg-white/10 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
