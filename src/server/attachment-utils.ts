export const MIB = 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const DAILY_ATTACHMENT_LIMIT_BYTES = 100 * MIB;

export type AttachmentKind = 'image' | 'gif' | 'video' | 'document';
export interface AttachmentTypeRule {
  extensions: readonly string[];
  kind: AttachmentKind;
  maxBytes: number;
}

export const ATTACHMENT_TYPES: Readonly<Record<string, AttachmentTypeRule>> = {
  'image/jpeg': { extensions: ['jpg', 'jpeg'], kind: 'image', maxBytes: 8 * MIB },
  'image/png': { extensions: ['png'], kind: 'image', maxBytes: 8 * MIB },
  'image/webp': { extensions: ['webp'], kind: 'image', maxBytes: 8 * MIB },
  'image/gif': { extensions: ['gif'], kind: 'gif', maxBytes: 10 * MIB },
  'video/mp4': { extensions: ['mp4'], kind: 'video', maxBytes: 25 * MIB },
  'video/webm': { extensions: ['webm'], kind: 'video', maxBytes: 25 * MIB },
  'application/pdf': { extensions: ['pdf'], kind: 'document', maxBytes: 20 * MIB },
  'text/plain': { extensions: ['txt'], kind: 'document', maxBytes: 20 * MIB },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { extensions: ['docx'], kind: 'document', maxBytes: 20 * MIB },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { extensions: ['xlsx'], kind: 'document', maxBytes: 20 * MIB },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { extensions: ['pptx'], kind: 'document', maxBytes: 20 * MIB },
  'application/zip': { extensions: ['zip'], kind: 'document', maxBytes: 20 * MIB },
};

const dangerousExtensions = new Set([
  'exe', 'apk', 'bat', 'cmd', 'sh', 'bash', 'zsh', 'js', 'mjs', 'cjs', 'html', 'htm', 'xhtml', 'svg', 'msi', 'dll', 'com', 'scr', 'pif', 'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'wsh', 'jar', 'class', 'php', 'py', 'pyc', 'rb', 'pl', 'cgi', 'asp', 'aspx', 'wasm', 'deb', 'rpm', 'dmg', 'app', 'iso', 'reg', 'lnk', 'url', 'hta', 'chm', 'sys', 'drv', 'ocx', 'sys', 'command', 'shar', 'fish', 'ksh', 'zsh',
]);

export function cleanOriginalName(value: string): string {
  const leaf = value.normalize('NFKC').split(/[\\/]/).pop() ?? '';
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[<>:"|?*;]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return Array.from(cleaned).slice(0, 180).join('') || 'ficheiro';
}

export type AttachmentValidation =
  | { ok: true; originalName: string; mimeType: string; kind: AttachmentKind; maxBytes: number }
  | { ok: false; reason: 'name' | 'type' | 'size'; maxBytes?: number };

export function validateAttachmentMetadata(name: string, mimeType: string, sizeBytes: number): AttachmentValidation {
  const originalName = cleanOriginalName(name);
  const parts = originalName.toLowerCase().split('.');
  const extension = parts.pop() ?? '';
  if (!extension || dangerousExtensions.has(extension) || parts.some((part) => dangerousExtensions.has(part))) return { ok: false, reason: 'type' };

  const normalizedMime = mimeType.trim().toLowerCase().split(';', 1)[0] ?? '';
  const rule = ATTACHMENT_TYPES[normalizedMime];
  if (!rule || !rule.extensions.includes(extension)) return { ok: false, reason: 'type' };
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return { ok: false, reason: 'size', maxBytes: rule.maxBytes };
  if (sizeBytes > rule.maxBytes) return { ok: false, reason: 'size', maxBytes: rule.maxBytes };
  return { ok: true, originalName, mimeType: normalizedMime, kind: rule.kind, maxBytes: rule.maxBytes };
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

export function signatureMatches(mimeType: string, bytes: Uint8Array): boolean {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg': return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/png': return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/gif': return startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    case 'image/webp': return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    case 'video/mp4': return bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
    case 'video/webm': return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case 'application/pdf': return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case 'application/zip':
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
    case 'text/plain': {
      if (bytes.includes(0)) return false;
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true }); return true; }
      catch { return false; }
    }
    default: return false;
  }
}

export function attachmentCountAllowed(existingCount: number, requestedCount: number): boolean {
  return Number.isInteger(existingCount) && Number.isInteger(requestedCount) && existingCount >= 0 && requestedCount > 0 && existingCount + requestedCount <= MAX_ATTACHMENTS_PER_MESSAGE;
}

export function dailyQuotaAllows(usedBytes: number, requestedBytes: number): boolean {
  return Number.isFinite(usedBytes) && Number.isSafeInteger(requestedBytes) && usedBytes >= 0 && requestedBytes > 0 && usedBytes + requestedBytes <= DAILY_ATTACHMENT_LIMIT_BYTES;
}
