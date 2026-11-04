import { signatureMatches } from './attachment-utils.js';

export const CUSTOM_EMOJI_MAX_BYTES = 256 * 1024;
export const CUSTOM_STICKER_MAX_BYTES = 512 * 1024;
export const CUSTOM_EMOJI_MAX_DIMENSION = 128;
export const CUSTOM_STICKER_MAX_DIMENSION = 320;
export const CUSTOM_EMOJI_LIMIT = 50;
export const CUSTOM_STICKER_LIMIT = 30;

export const CUSTOM_IMAGE_TYPES = ['image/png', 'image/webp', 'image/gif'] as const;
export type CustomImageType = typeof CUSTOM_IMAGE_TYPES[number];
export type CustomAssetKind = 'emoji' | 'sticker';

export function isCustomAssetName(value: string): boolean {
  return /^[a-z0-9_]{2,32}$/.test(value);
}

export function isCustomImageType(value: string): value is CustomImageType {
  return (CUSTOM_IMAGE_TYPES as readonly string[]).includes(value.trim().toLowerCase());
}

export function readImageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number; animated: boolean } | null {
  const mime = mimeType.toLowerCase();
  if (!signatureMatches(mime, bytes)) return null;
  if (mime === 'image/png' && bytes.length >= 24) {
    return { width: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16), height: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20), animated: false };
  }
  if (mime === 'image/gif' && bytes.length >= 10) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint16(6, true), height: view.getUint16(8, true), animated: true };
  }
  if (mime === 'image/webp' && bytes.length >= 30) {
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
      const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
      return { width, height, animated: (bytes[20] & 0x02) !== 0 };
    }
  }
  return null;
}

export function validateCustomImage(kind: CustomAssetKind, mimeType: string, sizeBytes: number, bytes: Uint8Array): { ok: true; width: number; height: number; animated: boolean } | { ok: false; reason: 'type' | 'size' | 'dimensions' | 'signature' } {
  const normalized = mimeType.trim().toLowerCase();
  if (!isCustomImageType(normalized)) return { ok: false, reason: 'type' };
  const maxBytes = kind === 'emoji' ? CUSTOM_EMOJI_MAX_BYTES : CUSTOM_STICKER_MAX_BYTES;
  const maxDimension = kind === 'emoji' ? CUSTOM_EMOJI_MAX_DIMENSION : CUSTOM_STICKER_MAX_DIMENSION;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > maxBytes) return { ok: false, reason: 'size' };
  const dimensions = readImageDimensions(bytes, normalized);
  if (!dimensions) return { ok: false, reason: 'signature' };
  if (dimensions.width < 1 || dimensions.height < 1 || dimensions.width > maxDimension || dimensions.height > maxDimension) return { ok: false, reason: 'dimensions' };
  return { ok: true, ...dimensions };
}

export function extractEmojiReferences(body: string): Array<{ kind: 'custom' | 'builtin'; value: string; id?: string; raw: string }> {
  const result: Array<{ kind: 'custom' | 'builtin'; value: string; id?: string; raw: string }> = [];
  const pattern = /<:([a-z0-9_]{2,32}|builtin:[a-z0-9_]{2,32}):([0-9a-f-]{36})>|<:(builtin):([a-z0-9_]{2,32})>/gi;
  for (const match of body.matchAll(pattern)) {
    if (match[3] === 'builtin') result.push({ kind: 'builtin', value: match[4].toLowerCase(), raw: match[0] });
    else result.push({ kind: 'custom', value: match[1], id: match[2], raw: match[0] });
  }
  return result;
}

export function parseReactionValue(value: string): { kind: 'unicode'; value: string } | { kind: 'custom' | 'builtin'; value: string } | null {
  if (value.startsWith('custom:')) {
    const id = value.slice('custom:'.length);
    return /^[0-9a-f-]{36}$/i.test(id) ? { kind: 'custom', value: id } : null;
  }
  if (value.startsWith('builtin:')) {
    const key = value.slice('builtin:'.length);
    return /^[a-z0-9_]{2,32}$/.test(key) ? { kind: 'builtin', value: key } : null;
  }
  return value.length > 0 && value.length <= 32 ? { kind: 'unicode', value } : null;
}
