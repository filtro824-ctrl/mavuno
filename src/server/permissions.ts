import { and, eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { communityMembers, communityRoles, rolePermissions } from './db/schema.js';

export type Permission = 'manage_community' | 'manage_channels' | 'manage_members' | 'manage_roles' | 'manage_channel_permissions' | 'delete_messages' | 'pin_messages' | 'kick_members' | 'ban_members' | 'mute_members' | 'view_audit_log' | 'create_invites' | 'send_messages' | 'join_voice';

export async function hasPermission(userId: string, communityId: string, permission: Permission): Promise<boolean> {
  const [grant] = await db.select({ id: rolePermissions.roleId })
    .from(communityMembers)
    .innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
    .innerJoin(rolePermissions, eq(communityRoles.id, rolePermissions.roleId))
    .where(and(
      eq(communityMembers.userId, userId),
      eq(communityMembers.communityId, communityId),
      eq(rolePermissions.permission, permission),
    )).limit(1);
  return Boolean(grant);
}

export async function isMember(userId: string, communityId: string): Promise<boolean> {
  const [member] = await db.select({ id: communityMembers.id }).from(communityMembers)
    .where(and(eq(communityMembers.userId, userId), eq(communityMembers.communityId, communityId))).limit(1);
  return Boolean(member);
}

export async function roleIdFor(communityId: string, role: 'owner' | 'admin' | 'moderator' | 'member'): Promise<string> {
  const [found] = await db.select({ id: communityRoles.id }).from(communityRoles)
    .where(and(eq(communityRoles.communityId, communityId), eq(communityRoles.key, role))).limit(1);
  if (!found) throw new Error(`Missing ${role} role for community ${communityId}`);
  return found.id;
}

export async function roleFor(userId: string, communityId: string): Promise<{ role: 'owner' | 'admin' | 'moderator' | 'member'; hierarchy: number } | null> {
  const [found] = await db.select({ role: communityRoles.key, hierarchy: communityRoles.hierarchy })
    .from(communityMembers).innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
    .where(and(eq(communityMembers.userId, userId), eq(communityMembers.communityId, communityId))).limit(1);
  return found ?? null;
}
