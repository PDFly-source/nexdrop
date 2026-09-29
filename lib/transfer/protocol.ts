/**
 * Binary Chunk Encoding and Decoding for High-Performance DataChannel Streaming.
 * Header format (16 bytes):
 * - 0..3: chunk index (uint32)
 * - 4..7: total chunks (uint32)
 * - 8..11: transferId checksum (uint32)
 * - 12..15: payload length (uint32)
 * - 16..end: raw chunk payload bytes
 */

export const HEADER_SIZE = 16;

export function simpleStringHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

export function encodeBinaryChunk(
  chunkIndex: number,
  totalChunks: number,
  transferId: string,
  chunkPayload: ArrayBuffer
): ArrayBuffer {
  const payloadBytes = new Uint8Array(chunkPayload);
  const totalLength = HEADER_SIZE + payloadBytes.byteLength;
  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);

  view.setUint32(0, chunkIndex, false);
  view.setUint32(4, totalChunks, false);
  view.setUint32(8, simpleStringHash(transferId), false);
  view.setUint32(12, payloadBytes.byteLength, false);

  const uint8 = new Uint8Array(buffer);
  uint8.set(payloadBytes, HEADER_SIZE);

  return buffer;
}

export interface DecodedChunk {
  chunkIndex: number;
  totalChunks: number;
  transferIdHash: number;
  payloadLength: number;
  payload: ArrayBuffer;
}

export function decodeBinaryChunk(buffer: ArrayBuffer): DecodedChunk | null {
  if (buffer.byteLength < HEADER_SIZE) return null;
  const view = new DataView(buffer);

  const chunkIndex = view.getUint32(0, false);
  const totalChunks = view.getUint32(4, false);
  const transferIdHash = view.getUint32(8, false);
  const payloadLength = view.getUint32(12, false);

  const payload = buffer.slice(HEADER_SIZE, HEADER_SIZE + payloadLength);

  return {
    chunkIndex,
    totalChunks,
    transferIdHash,
    payloadLength,
    payload,
  };
}
