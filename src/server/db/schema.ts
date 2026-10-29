import { pgTable, pgEnum, uuid, varchar, text, boolean, timestamp, integer, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const roleKey = pgEnum('role_key', ['owner', 'admin', 'moderator', 'member']);
export const permissionKey = pgEnum('permission_key', [
  'manage_community', 'manage_channels', 'delete_messages', 'kick_members', 'create_invites', 'send_messages', 'join_voice',
]);

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 254 }).notNull().unique(),
  username: varchar('username', { length: 32 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
  isPrivate: boolean('is_private').notNull().default(false),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('communities_discovery_idx').on(t.isPrivate, t.category, t.createdAt)]);

export const communityRoles = pgTable('community_roles', {
  id: uuid('id').defaultRandom().primaryKey(),
  communityId: uuid('community_id').notNull().references(() => communities.id, { onDelete: 'cascade' }),
  key: roleKey('key').notNull(),
  name: varchar('name', { length: 40 }).notNull(),
}, (t) => [uniqueIndex('community_roles_key_unique').on(t.communityId, t.key)]);

export const rolePermissions = pgTable('role_permissions', {
  roleId: uuid('role_id').notNull().references(() => communityRoles.id, { onDelete: 'cascade' }),
  permission: permissionKey('permission').notNull(),
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
}, (t) => [uniqueIndex('messages_client_unique').on(t.channelId, t.authorId, t.clientMessageId), index('messages_channel_cursor_idx').on(t.channelId, t.createdAt, t.id)]);

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

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
