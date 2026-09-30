/**
 * Canonical NexDrop QR rendering options.
 *
 * ONE source of truth for every QR we draw (live pairing display, downloaded
 * QR PNG). The camera scanner and image import decode what these produce, so
 * any change here must keep the QR reliably camera-readable.
 *
 * Why standard polarity (dark modules on a light background): jsQR's QR
 * finder detection is polarity-tolerant, but its data read assumes the QR
 * spec's dark-on-light orientation. An inverted, light-on-dark QR is not
 * reliably decodable, so the QR is always rendered as a light card with
 * near-black modules, independent of the app's dark theme.
 *
 * Why EC level M with these sizes: payloads are capped (see
 * SINGLE_QR_MAX_CHARS / SEGMENT_DATA_CHARS in lib/pairing/payload) so a QR
 * stays at version <= 15 (77 modules). On a ~300px phone display that keeps
 * modules around 4 CSS px — resolvable by a normal phone camera at
 * arm's length, with enough error correction to survive glare and noise.
 */

import QRCode from 'qrcode';

export const QR_DARK = '#070A0D';
export const QR_LIGHT = '#FFFFFF';
export const QR_MARGIN_MODULES = 4; // quiet zone; the spec minimum is 4
export const QR_ERROR_CORRECTION: QRCode.QRCodeErrorCorrectionLevel = 'M';

export const QR_RENDER_OPTIONS: QRCode.QRCodeToDataURLOptions = {
  errorCorrectionLevel: QR_ERROR_CORRECTION,
  margin: QR_MARGIN_MODULES,
  color: { dark: QR_DARK, light: QR_LIGHT },
};

/** Modules per side for a given payload length at our EC level (test helper). */
export function qrModuleSizeFor(payloadLength: number): number {
  return QRCode.create('A'.repeat(payloadLength), {
    errorCorrectionLevel: QR_ERROR_CORRECTION,
  }).modules.size;
}
