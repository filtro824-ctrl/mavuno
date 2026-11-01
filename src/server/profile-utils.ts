import { z } from 'zod';

export const presencePreferences = ['online', 'away', 'dnd', 'invisible'] as const;
export type PresencePreference = typeof presencePreferences[number];

export const profileVisibilitySchema = z.object({
  avatar: z.boolean(),
  about: z.boolean(),
  status: z.boolean(),
  joinDate: z.boolean(),
  commonCommunities: z.boolean(),
  email: z.boolean(),
  banner: z.boolean(),
}).strict();

const httpsImageUrl = z.string().trim().min(1).max(500).url().refine((value) => {
  try { return new URL(value).protocol === 'https:'; }
  catch { return false; }
}, 'A imagem deve usar uma ligação HTTPS.');
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A cor deve estar no formato #RRGGBB.');
const presenceSchema = z.enum(presencePreferences);

export const profileUpdateSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_-]+$/u).optional(),
  avatarUrl: z.union([httpsImageUrl, z.null()]).optional(),
  aboutMe: z.string().trim().max(160).optional(),
  bannerUrl: z.union([httpsImageUrl, z.null()]).optional(),
  bannerColor: z.union([colorSchema, z.null()]).optional(),
  statusText: z.string().trim().max(80).optional(),
  presencePreference: presenceSchema.optional(),
  visibility: profileVisibilitySchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

export type ProfileVisibility = z.infer<typeof profileVisibilitySchema>;
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

export interface ProfileRecord {
  id: string;
  username: string;
  email: string;
  avatarUrl: string | null;
  aboutMe: string;
  bannerUrl: string | null;
  bannerColor: string | null;
  statusText: string;
  presencePreference: PresencePreference;
  createdAt: Date | string;
  showAvatar: boolean;
  showAbout: boolean;
  showStatus: boolean;
  showJoinDate: boolean;
  showCommonCommunities: boolean;
  showEmail: boolean;
  showBanner: boolean;
}

export interface CommonCommunity { id: string; name: string }
export interface MemberIdentity { id: string; username: string; avatarUrl?: string | null }
export interface VisibleMemberProfile extends MemberIdentity {
  aboutMe?: string;
  online?: boolean;
  presence?: PresencePreference;
  statusText?: string;
  bannerUrl?: string | null;
  bannerColor?: string | null;
  createdAt?: string;
  commonCommunities?: CommonCommunity[];
  email?: string;
  role?: string;
}

export function visibleMemberIdentity(user: { id: string; username: string; avatarUrl: string | null; showAvatar: boolean }): MemberIdentity {
  return user.showAvatar ? { id: user.id, username: user.username, avatarUrl: user.avatarUrl } : { id: user.id, username: user.username };
}

export function fallbackBannerColor(name: string): string {
  let hash = 0;
  for (const character of name.trim().toLowerCase()) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 28% 28%)`;
}

export function visibleMemberProfile(target: ProfileRecord, options: { online: boolean; commonCommunities: CommonCommunity[]; canViewEmail: boolean; role?: string }): VisibleMemberProfile {
  const result: VisibleMemberProfile = { id: target.id, username: target.username };
  if (target.showAvatar) result.avatarUrl = target.avatarUrl;
  if (target.showBanner) {
    if (target.bannerUrl) result.bannerUrl = target.bannerUrl;
    if (target.bannerColor) result.bannerColor = target.bannerColor;
  }
  if (target.showAbout && target.aboutMe.trim()) result.aboutMe = target.aboutMe;
  if (target.showStatus) {
    const invisible = target.presencePreference === 'invisible';
    result.online = invisible ? false : options.online;
    result.presence = invisible ? 'invisible' : target.presencePreference;
    if (target.statusText.trim()) result.statusText = target.statusText;
  }
  if (target.showJoinDate) result.createdAt = (target.createdAt instanceof Date ? target.createdAt : new Date(target.createdAt)).toISOString();
  if (target.showCommonCommunities && options.commonCommunities.length) result.commonCommunities = options.commonCommunities;
  if (target.showEmail && options.canViewEmail) result.email = target.email;
  if (options.role) result.role = options.role;
  return result;
}

export function profileVisibilityFromRecord(target: ProfileRecord): ProfileVisibility {
  return { avatar: target.showAvatar, about: target.showAbout, status: target.showStatus, joinDate: target.showJoinDate, commonCommunities: target.showCommonCommunities, email: target.showEmail, banner: target.showBanner };
}
