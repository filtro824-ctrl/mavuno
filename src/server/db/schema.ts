import { pgTable, pgEnum, uuid, varchar, text, boolean, timestamp, integer, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const roleKey = pgEnum('role_key', ['owner', 'admin', 'moderator', 'member']);
export const permissionKey = pgEnum('permission_key', [
  'manage_community', 'manage_channels', 'manage_members', 'manage_roles', 'manage_channel_permissions',
  'delete_messages', 'pin_messages', 'kick_members', 'ban_members', 'mute_members', 'view_audit_log',
  'create_invites', 'send_messages', 'join_voice',
]);

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 254 }).notNull().unique(),
  username: varchar('username', { length: 32 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  aboutMe: varchar('about_me', { length: 160 }).notNull().default(''),
  showAvatar: boolean('show_avatar').notNull().default(true),
  showAbout: boolean('show_about').notNull().default(true),
  showStatus: boolean('show_status').notNull().default(true),
  showJoinDate: boolean('show_join_date').notNull().default(true),
  showCommonCommunities: boolean('show_common_communities').notNull().default(true),
  showEmail: boolean('show_email').notNull().default(false),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expiry_idx').on(t.expiresAt)]);

export const communities = pgTable('communities', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 80 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  description: varchar('description', { length: 500 }).notNull().default(''),
  category: varchar('category', { length: 40 }).notNull().default('Geral'),
  imageUrl: text('image_url'),
  rules: varchar('rules', { length: 4000 }).notNull().default(''),
  isPrivate: boolean('is_private').notNull().default(false),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('communities_discovery_idx').on(t.isPrivate, t.category, t.createdAt)]);

export const communityRoles = pgTable('community_roles', {
  id: uuid('id').defaultRandom().primaryKey(),
  communityId: uuid('community_id').notNull().references(() => communities.id, { onDelete: 'cascade' }),
  key: roleKey('key').notNull(),
  name: varchar('name', { length: 40 }).notNull(),
  hierarchy: integer('hierarchy').notNull().default(10),
}, (t) => [uniqueIndex('community_roles_key_unique').on(t.communityId, t.key)]);

export const rolePermissions = pgTable('role_permissions', {
  roleId: uuid('role_id').notNull().references(() => communityRoles.id, { onDelete: 'cascade' }),
  permission: varchar('permission', { length: 50 }).notNull(),
}, (t) => [uniqueIndex('role_permissions_unique').on(t.roleId, t.permission)]);

export const communityMembers = pgTable('community_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  communityId: uuid('community_id').notNull().references(() => communities.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => communityRoles.id, { onDelete: 'restrict' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('community_member_unique').on(t.communityId, t.userId), index('members_user_idx').on(t.userId)]);

export const channels = pgTable('channels', {
  id: uuid('id').defaultRandom().primaryKey(),
  communityId: uuid('community_id').notNull().references(() => communities.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 60 }).notNull(),
  topic: varchar('topic', { length: 200 }).notNull().default(''),
  kind: varchar('kind', { length: 10 }).notNull().default('text'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('channels_community_name_unique').on(t.communityId, t.name), index('channels_community_idx').on(t.communityId)]);

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  clientMessageId: uuid('client_message_id').notNull(),
  body: varchar('body', { length: 2000 }).notNull(),
  replyToId: uuid('reply_to_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  pinnedAt: timestamp('pinned_at', { withTimezone: true }),
  pinnedBy: uuid('pinned_by').references(() => users.id, { onDelete: 'set null' }),
}, (t) => [uniqueIndex('messages_client_unique').on(t.channelId, t.authorId, t.clientMessageId), index('messages_channel_cursor_idx').on(t.channelId, t.createdAt, t.id)]);

export const messageReactions = pgTable('message_reactions', {
  id: uuid('id').defaultRandom().primaryKey(),
  messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: varchar('emoji', { length: 32 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('message_reactions_message_user_emoji_unique').on(t.messageId, t.userId, t.emoji),
  index('message_reactions_message_idx').on(t.messageId),
]);

export const channelPermissions = pgTable('channel_permissions', {
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => communityRoles.id, { onDelete: 'cascade' }),
  permission: varchar('permission', { length: 50 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
}, (t) => [uniqueIndex('channel_permissions_unique').on(t.channelId, t.roleId, t.permission)]);

export const communityBans = pgTable('community_bans', {
  id: uuid('id').defaultRandom().primaryKey(),
  communityId: uuid('community_id').notNull().references(() => communities.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  reason: varchar('reason', { length: 500 }).notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [index('community_bans_lookup_idx').on(t.communityId, t.userId, t.revokedAt)]);

export const communityMutes = pgTable('community_mutes', {
  id: uuid('id').defaultRandom().primaryKey(),
  communityId: uuid('community_id').notNull().references(() => communities.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  reason: varchar('reason', { length: 500 }).notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [index('community_mutes_lookup_idx').on(t.communityId, t.userId, t.expiresAt, t.revokedAt)]);

export const moderationAuditLogs = pgTable('moderation_audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  communityId: uuid('community_id').notNull().references(() => communities.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  targetUserId: uuid('target_user_id').references(() => users.id, { onDelete: 'set null' }),
  action: varchar('action', { length: 60 }).notNull(),
  reason: varchar('reason', { length: 500 }).notNull().default(''),
  durationSeconds: integer('duration_seconds'),
  metadata: text('metadata').notNull().default('{}'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('moderation_audit_community_idx').on(t.communityId, t.createdAt)]);

export const messageMentions = pgTable('message_mentions', {
  messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (t) => [uniqueIndex('message_mentions_unique').on(t.messageId, t.userId), index('message_mentions_user_idx').on(t.userId)]);

export const invitations = pgTable('invitations', {
  id: uuid('id').defaultRandom().primaryKey(),
  communityId: uuid('community_id').notNull().references(() => communities.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  maxUses: integer('max_uses'),
  useCount: integer('use_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const voiceRooms = pgTable('voice_rooms', {
  id: uuid('id').defaultRandom().primaryKey(),
  communityId: uuid('community_id').notNull().references(() => communities.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().unique().references(() => channels.id, { onDelete: 'cascade' }),
  livekitRoom: varchar('livekit_room', { length: 120 }).notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const privateCalls = pgTable('private_calls', {
  id: uuid('id').defaultRandom().primaryKey(),
  callerId: uuid('caller_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  calleeId: uuid('callee_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 20 }).notNull().default('initiated'),
  livekitRoom: varchar('livekit_room', { length: 140 }).notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, (t) => [index('private_calls_participants_idx').on(t.callerId, t.calleeId, t.createdAt)]);

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
