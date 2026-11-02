export type ProfileMediaKind = 'avatar' | 'banner';

export const PROFILE_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const referencePattern = new RegExp(`^/api/profile-media/(${UUID_SOURCE})/(avatar|banner)/(${UUID_SOURCE})$`, 'i');

export interface ProfileMediaReference {
  userId: string;
  kind: ProfileMediaKind;
  assetId: string;
}

export function makeProfileMediaReference(userId: string, kind: ProfileMediaKind, assetId: string): string {
  return `/api/profile-media/${userId.toLowerCase()}/${kind}/${assetId.toLowerCase()}`;
}

export function parseProfileMediaReference(value: string): ProfileMediaReference | null {
  const match = referencePattern.exec(value);
  if (!match) return null;
  return { userId: match[1].toLowerCase(), kind: match[2] as ProfileMediaKind, assetId: match[3].toLowerCase() };
}

export function profileMediaReferenceOwnedBy(value: string, userId: string, kind: ProfileMediaKind): boolean {
  const parsed = parseProfileMediaReference(value);
  return Boolean(parsed && parsed.userId === userId.toLowerCase() && parsed.kind === kind);
}

export function profileMediaObjectKey(userId: string, kind: ProfileMediaKind, assetId: string): string {
  return `profile-media/${userId.toLowerCase()}/${kind}/${assetId.toLowerCase()}.jpg`;
}

export function profileMediaStagingObjectKey(userId: string, kind: ProfileMediaKind, uploadId: string): string {
  return `profile-upload-pending/${userId.toLowerCase()}/${kind}/${uploadId.toLowerCase()}.jpg`;
}
