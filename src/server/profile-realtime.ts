import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';
import { db } from './db/index.js';
import { communities, communityMembers, communityRoles, rolePermissions, users } from './db/schema.js';
import { visibleMemberProfile, type CommonCommunity, type ProfileRecord } from './profile-utils.js';

const profileColumns = {
  id: users.id,
  username: users.username,
  email: users.email,
  avatarUrl: users.avatarUrl,
  aboutMe: users.aboutMe,
  createdAt: users.createdAt,
  showAvatar: users.showAvatar,
  showAbout: users.showAbout,
  showStatus: users.showStatus,
  showJoinDate: users.showJoinDate,
  showCommonCommunities: users.showCommonCommunities,
  showEmail: users.showEmail,
};

export async function broadcastProfileUpdate(io: SocketServer, userId: string): Promise<void> {
  const [target] = await db.select(profileColumns).from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return;
  const memberships = await db.select({ communityId: communityMembers.communityId })
    .from(communityMembers).where(eq(communityMembers.userId, userId));
  const communityIds = [...new Set(memberships.map((row) => row.communityId))];
  if (!communityIds.length) return;

  const sharedRows = await db.select({
    viewerId: communityMembers.userId,
    communityId: communities.id,
    name: communities.name,
  }).from(communityMembers).innerJoin(communities, eq(communityMembers.communityId, communities.id))
    .where(inArray(communityMembers.communityId, communityIds));
  const commonByViewer = new Map<string, CommonCommunity[]>();
  for (const row of sharedRows) {
    if (row.viewerId === userId) continue;
    const common = commonByViewer.get(row.viewerId) ?? [];
    if (!common.some((community) => community.id === row.communityId)) common.push({ id: row.communityId, name: row.name });
    commonByViewer.set(row.viewerId, common);
  }
  const managers = await db.selectDistinct({ userId: communityMembers.userId })
    .from(communityMembers).innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
    .innerJoin(rolePermissions, eq(communityRoles.id, rolePermissions.roleId))
    .where(and(inArray(communityMembers.communityId, communityIds), eq(rolePermissions.permission, 'manage_community')));
  const managerIds = new Set(managers.map((row) => row.userId));
  const online = (await io.in(`user:${userId}`).fetchSockets()).length > 0;
  const record = target as ProfileRecord;
  for (const [viewerId, commonCommunities] of commonByViewer) {
    const profile = visibleMemberProfile(record, {
      online,
      commonCommunities,
      canViewEmail: managerIds.has(viewerId),
    });
    io.in(`user:${viewerId}`).emit('profile:updated', { userId, profile });
  }
}

export async function broadcastProfilePresence(io: SocketServer, userId: string, online: boolean): Promise<void> {
  const [target] = await db.select({ showStatus: users.showStatus }).from(users).where(eq(users.id, userId)).limit(1);
  if (!target?.showStatus) return;
  const memberships = await db.select({ communityId: communityMembers.communityId })
    .from(communityMembers).where(eq(communityMembers.userId, userId));
  const communityIds = [...new Set(memberships.map((row) => row.communityId))];
  if (!communityIds.length) return;
  const recipients = await db.selectDistinct({ userId: communityMembers.userId }).from(communityMembers)
    .where(and(inArray(communityMembers.communityId, communityIds), ne(communityMembers.userId, userId)));
  for (const recipient of recipients) io.in(`user:${recipient.userId}`).emit('profile:presence', { userId, online });
}
