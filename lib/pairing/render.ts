import QRCode from 'qrcode';
import { QR_RENDER_OPTIONS } from './qrOptions';

/** Same scannable QR renderer for Devices, Send-first, and downloads. */
export function renderPairingQr(code: string, width?: number): Promise<string> {
  return QRCode.toDataURL(code, { ...QR_RENDER_OPTIONS, ...(width ? { width } : {}) });
}
