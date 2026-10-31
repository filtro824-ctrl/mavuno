import { z } from 'zod';

export const profileVisibilitySchema = z.object({
  avatar: z.boolean(),
  about: z.boolean(),
  status: z.boolean(),
  joinDate: z.boolean(),
  commonCommunities: z.boolean(),
  email: z.boolean(),
}).strict();

const httpsImageUrl = z.string().trim().min(1).max(500).url().refine((value) => {
  try { return new URL(value).protocol === 'https:'; }
  catch { return false; }
}, 'A foto deve usar uma ligação HTTPS.');

export const profileUpdateSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_-]+$/u).optional(),
  avatarUrl: z.union([httpsImageUrl, z.null()]).optional(),
  aboutMe: z.string().trim().max(160).optional(),
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
  createdAt: Date | string;
  showAvatar: boolean;
  showAbout: boolean;
  showStatus: boolean;
  showJoinDate: boolean;
  showCommonCommunities: boolean;
  showEmail: boolean;
}

export interface CommonCommunity {
  id: string;
  name: string;
}

export interface MemberIdentity {
  id: string;
  username: string;
  avatarUrl?: string | null;
}

export interface VisibleMemberProfile extends MemberIdentity {
  aboutMe?: string;
  online?: boolean;
  createdAt?: string;
  commonCommunities?: CommonCommunity[];
  email?: string;
}

export function visibleMemberIdentity(user: { id: string; username: string; avatarUrl: string | null; showAvatar: boolean }): MemberIdentity {
  return user.showAvatar
    ? { id: user.id, username: user.username, avatarUrl: user.avatarUrl }
    : { id: user.id, username: user.username };
}

export function visibleMemberProfile(
  target: ProfileRecord,
  options: { online: boolean; commonCommunities: CommonCommunity[]; canViewEmail: boolean },
): VisibleMemberProfile {
  const result: VisibleMemberProfile = { id: target.id, username: target.username };
  if (target.showAvatar) result.avatarUrl = target.avatarUrl;
  if (target.showAbout && target.aboutMe.trim()) result.aboutMe = target.aboutMe;
  if (target.showStatus) result.online = options.online;
  if (target.showJoinDate) result.createdAt = (target.createdAt instanceof Date ? target.createdAt : new Date(target.createdAt)).toISOString();
  if (target.showCommonCommunities && options.commonCommunities.length) result.commonCommunities = options.commonCommunities;
  if (target.showEmail && options.canViewEmail) result.email = target.email;
  return result;
}

export function profileVisibilityFromRecord(target: ProfileRecord): ProfileVisibility {
  return {
    avatar: target.showAvatar,
    about: target.showAbout,
    status: target.showStatus,
    joinDate: target.showJoinDate,
    commonCommunities: target.showCommonCommunities,
    email: target.showEmail,
  };
}
