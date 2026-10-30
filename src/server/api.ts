import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { AccessToken } from 'livekit-server-sdk';
import { db, pool } from './db/index.js';
import {
  channels, communities, communityMembers, communityRoles, invitations, messages,
  messageMentions, rolePermissions, sessions, users, voiceRooms, communityBans, communityMutes,
  moderationAuditLogs, privateCalls, messageReactions,
} from './db/schema.js';
import { createOpaqueToken, digestToken, hashPassword, readSessionCookie, setCsrfCookie, setSessionCookie, clearSessionCookie, verifyPassword } from './security.js';
import { hasPermission, isMember, roleFor, roleIdFor, type Permission } from './permissions.js';
import { groupReactionAggregates, isUnicodeEmoji } from './reaction-utils.js';
import type { Server as SocketServer } from 'socket.io';

const replyMessages = alias(messages, 'reply_messages');
const replyAuthors = alias(users, 'reply_authors');
interface PublicUser { id: string; username: string; email: string; avatarUrl: string | null }
interface RoleDef { key: 'owner' | 'admin' | 'moderator' | 'member'; name: string; hierarchy: number; permissions: Permission[] }
const permissionSet: RoleDef[] = [
  { key: 'owner', name: 'Proprietário', hierarchy: 100, permissions: ['manage_community', 'manage_channels', 'manage_members', 'manage_roles', 'manage_channel_permissions', 'delete_messages', 'pin_messages', 'kick_members', 'ban_members', 'mute_members', 'view_audit_log', 'create_invites', 'send_messages', 'join_voice'] },
  { key: 'admin', name: 'Administrador', hierarchy: 80, permissions: ['manage_community', 'manage_channels', 'manage_members', 'manage_roles', 'manage_channel_permissions', 'delete_messages', 'pin_messages', 'kick_members', 'ban_members', 'mute_members', 'view_audit_log', 'create_invites', 'send_messages', 'join_voice'] },
  { key: 'moderator', name: 'Moderador', hierarchy: 50, permissions: ['delete_messages', 'pin_messages', 'kick_members', 'ban_members', 'mute_members', 'view_audit_log', 'create_invites', 'send_messages', 'join_voice'] },
  { key: 'member', name: 'Membro', hierarchy: 10, permissions: ['send_messages', 'join_voice'] },
];
const asyncRoute = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { void fn(req, res, next).catch(next); };
const requireAuth: RequestHandler = (_req, res, next) => {
  if (!res.locals.user) { res.status(401).json({ error: 'Inicia sessão para continuar.' }); return; }
  next();
};
const currentUser = (res: Response): PublicUser => res.locals.user as PublicUser;
const uuid = z.string().uuid();

async function issueSession(userId: string, res: Response): Promise<void> {
  const token = createOpaqueToken();
  await db.insert(sessions).values({ userId, tokenHash: digestToken(token), expiresAt: new Date(Date.now() + 30 * 86400_000) });
  setSessionCookie(res, token);
}

export async function authenticateCookie(cookie: string | undefined): Promise<PublicUser | null> {
  if (!cookie) return null;
  const [row] = await db.select({ id: users.id, username: users.username, email: users.email, avatarUrl: users.avatarUrl })
    .from(sessions).innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, digestToken(cookie)), gt(sessions.expiresAt, new Date()))).limit(1);
  return row ?? null;
}

async function removeCommunitySocketAccess(io: SocketServer, userId: string, communityId: string): Promise<void> {
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const socket of sockets) {
    for (const room of socket.rooms) {
      if (!room.startsWith('channel:')) continue;
      const channelId = room.slice('channel:'.length);
      const [channel] = await db.select({ communityId: channels.communityId }).from(channels).where(eq(channels.id, channelId)).limit(1);
      if (channel?.communityId === communityId) await socket.leave(room);
    }
  }
}

async function broadcastCommunityMembers(io: SocketServer, communityId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  const recipients = await db.select({ userId: communityMembers.userId }).from(communityMembers).where(eq(communityMembers.communityId, communityId));
  for (const recipient of recipients) io.in(`user:${recipient.userId}`).emit(event, payload);
}
async function activeBan(communityId: string, userId: string): Promise<boolean> {
  const [ban] = await db.select({ id: communityBans.id }).from(communityBans)
    .where(and(eq(communityBans.communityId, communityId), eq(communityBans.userId, userId), isNull(communityBans.revokedAt))).limit(1);
  return Boolean(ban);
}

async function activeMute(communityId: string, userId: string): Promise<{ expiresAt: Date } | null> {
  const [mute] = await db.select({ expiresAt: communityMutes.expiresAt }).from(communityMutes)
    .where(and(eq(communityMutes.communityId, communityId), eq(communityMutes.userId, userId), isNull(communityMutes.revokedAt), gt(communityMutes.expiresAt, new Date()))).limit(1);
  return mute ?? null;
}

async function reactionSummariesFor(messageIds: string[], userId: string): Promise<Record<string, { emoji: string; count: number; reactedByMe: boolean }[]>> {
  if (!messageIds.length) return {};
  const rows = await db.select({
    messageId: messageReactions.messageId,
    emoji: messageReactions.emoji,
    count: count(),
    reactedByMe: sql<boolean>`bool_or(${messageReactions.userId} = ${userId})`,
  }).from(messageReactions)
    .where(inArray(messageReactions.messageId, messageIds))
    .groupBy(messageReactions.messageId, messageReactions.emoji);
  return groupReactionAggregates(rows);
}

async function audit(communityId: string, actorId: string, action: string, targetUserId: string | null, reason = '', durationSeconds: number | null = null, metadata: Record<string, unknown> = {}): Promise<void> {
  await db.insert(moderationAuditLogs).values({ communityId, actorId, targetUserId, action, reason, durationSeconds, metadata: JSON.stringify(metadata) });
}

async function canActOnTarget(actorId: string, communityId: string, targetUserId: string): Promise<boolean> {
  const actor = await roleFor(actorId, communityId);
  const target = await roleFor(targetUserId, communityId);
  return Boolean(actor && target && target.role !== 'owner' && actor.hierarchy > target.hierarchy);
}

export function createApi(io: SocketServer): Router {
  const router = Router();

  router.get('/health', asyncRoute(async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ok', database: 'connected' }); }
    catch { res.status(503).json({ status: 'degraded', database: 'unavailable' }); }
  }));
  router.get('/auth/csrf', (_req, res) => {
    const token = createOpaqueToken();
    setCsrfCookie(res, token);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ token });
  });

  router.post('/auth/register', asyncRoute(async (req, res) => {
    const input = z.object({
      email: z.string().email().max(254).transform((v) => v.trim().toLowerCase()),
      username: z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_-]+$/u),
      password: z.string().min(12).max(200),
    }).safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Verifica email, nome (3–32 caracteres) e palavra-passe (mínimo 12 caracteres).' }); return; }
    try {
      const passwordHash = await hashPassword(input.data.password);
      const [user] = await db.insert(users).values({ ...input.data, passwordHash }).returning({ id: users.id, username: users.username, email: users.email, avatarUrl: users.avatarUrl });
      await issueSession(user.id, res);
      res.status(201).json({ user });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') { res.status(409).json({ error: 'Esse email ou nome de utilizador já está em uso.' }); return; }
      throw error;
    }
  }));

  router.post('/auth/login', asyncRoute(async (req, res) => {
    const input = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Credenciais inválidas.' }); return; }
    const email = input.data.email.trim().toLowerCase();
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || !(await verifyPassword(input.data.password, user.passwordHash))) {
      res.status(401).json({ error: 'Email ou palavra-passe incorretos.' }); return;
    }
    await issueSession(user.id, res);
    res.json({ user: { id: user.id, username: user.username, email: user.email, avatarUrl: user.avatarUrl } });
  }));

  router.post('/auth/logout', asyncRoute(async (req, res) => {
    const token = readSessionCookie(req);
    if (token) await db.delete(sessions).where(eq(sessions.tokenHash, digestToken(token)));
    if (res.locals.user?.id) io.in(`user:${(res.locals.user as PublicUser).id}`).disconnectSockets(true);
    clearSessionCookie(res);
    res.json({ ok: true });
  }));

  router.post('/auth/forgot', asyncRoute(async (_req, res) => {
    res.status(503).json({ error: 'A recuperação por email ainda não está configurada. Contacta o administrador do serviço.' });
  }));

  router.use(requireAuth);
  router.get('/auth/me', (_req, res) => res.json({ user: currentUser(res) }));
  router.patch('/profile', asyncRoute(async (req, res) => {
    const input = z.object({ username: z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_-]+$/u).optional(), avatarUrl: z.string().url().max(500).startsWith('https://').nullable().optional() }).safeParse(req.body);
    if (!input.success || Object.keys(input.data).length === 0) { res.status(400).json({ error: 'Dados de perfil inválidos.' }); return; }
    try {
      const [user] = await db.update(users).set(input.data).where(eq(users.id, currentUser(res).id)).returning({ id: users.id, username: users.username, email: users.email, avatarUrl: users.avatarUrl });
      res.json({ user });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') { res.status(409).json({ error: 'Esse nome de utilizador já está em uso.' }); return; }
      throw error;
    }
  }));

  router.get('/communities/mine', asyncRoute(async (_req, res) => {
    const rows = await db.select({ id: communities.id, name: communities.name, slug: communities.slug, description: communities.description, category: communities.category, isPrivate: communities.isPrivate, role: communityRoles.key })
      .from(communityMembers).innerJoin(communities, eq(communityMembers.communityId, communities.id)).innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
      .where(eq(communityMembers.userId, currentUser(res).id)).orderBy(desc(communities.createdAt));
    res.json({ communities: rows });
  }));

  router.get('/communities/explore', asyncRoute(async (req, res) => {
    const query = z.string().trim().max(80).optional().safeParse(req.query.q);
    if (!query.success) { res.status(400).json({ error: 'Pesquisa inválida.' }); return; }
    const filters = [eq(communities.isPrivate, false)];
    if (query.data) filters.push(sql`(${communities.name} ILIKE ${`%${query.data}%`} OR ${communities.category} ILIKE ${`%${query.data}%`})` as never);
    const rows = await db.select({ id: communities.id, name: communities.name, slug: communities.slug, description: communities.description, category: communities.category })
      .from(communities).where(and(...filters)).orderBy(desc(communities.createdAt)).limit(50);
    res.json({ communities: rows });
  }));

  router.post('/communities', asyncRoute(async (req, res) => {
    const input = z.object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(500).default(''), category: z.string().trim().min(1).max(40).default('Geral'), isPrivate: z.boolean().default(false) }).safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Dados da comunidade inválidos.' }); return; }
    const ownerId = currentUser(res).id;
    const id = crypto.randomUUID();
    const slug = `${input.data.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 70) || 'comunidade'}-${id.slice(0, 8)}`;
    const community = await db.transaction(async (tx) => {
      const [created] = await tx.insert(communities).values({ id, ...input.data, slug, ownerId }).returning();
      const roles = await tx.insert(communityRoles).values(permissionSet.map(({ key, name, hierarchy }) => ({ communityId: id, key, name, hierarchy }))).returning();
      const roleByKey = new Map(roles.map((role) => [role.key, role.id]));
      for (const def of permissionSet) {
        const roleId = roleByKey.get(def.key);
        if (roleId && def.permissions.length) await tx.insert(rolePermissions).values(def.permissions.map((permission) => ({ roleId, permission })));
      }
      const ownerRoleId = roleByKey.get('owner');
      if (!ownerRoleId) throw new Error('Owner role was not created');
      await tx.insert(communityMembers).values({ communityId: id, userId: ownerId, roleId: ownerRoleId });
      await tx.insert(channels).values({ communityId: id, name: 'geral', topic: 'Conversa geral', kind: 'text' });
      return created;
    });
    res.status(201).json({ community });
  }));

  router.get('/communities/:communityId', asyncRoute(async (req, res) => {
    if (!uuid.safeParse(req.params.communityId).success) { res.status(400).json({ error: 'Comunidade inválida.' }); return; }
    const [community] = await db.select({ id: communities.id, name: communities.name, slug: communities.slug, description: communities.description, category: communities.category, imageUrl: communities.imageUrl, rules: communities.rules, isPrivate: communities.isPrivate, ownerId: communities.ownerId })
      .from(communities).where(eq(communities.id, req.params.communityId)).limit(1);
    if (!community || (community.isPrivate && !(await isMember(currentUser(res).id, community.id)))) { res.status(404).json({ error: 'Comunidade não encontrada.' }); return; }
    const mine = await db.select({ role: communityRoles.key }).from(communityMembers).innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
      .where(and(eq(communityMembers.userId, currentUser(res).id), eq(communityMembers.communityId, community.id))).limit(1);
    const memberRows = await db.select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl, role: communityRoles.key })
      .from(communityMembers).innerJoin(users, eq(communityMembers.userId, users.id)).innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
      .where(eq(communityMembers.communityId, community.id)).orderBy(users.username).limit(100);
    const channelRows = await db.select({ id: channels.id, name: channels.name, topic: channels.topic, kind: channels.kind })
      .from(channels).where(eq(channels.communityId, community.id)).orderBy(channels.createdAt);
    res.json({ community, myRole: mine[0]?.role ?? null, members: memberRows, channels: channelRows });
  }));

  router.patch('/communities/:communityId', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId;
    if (!await hasPermission(currentUser(res).id, communityId, 'manage_community')) { res.status(403).json({ error: 'Não tens permissão para gerir a comunidade.' }); return; }
    const input = z.object({ name: z.string().trim().min(2).max(80).optional(), description: z.string().trim().max(500).optional(), category: z.string().trim().min(1).max(40).optional(), imageUrl: z.string().url().max(500).startsWith('https://').nullable().optional(), rules: z.string().trim().max(4000).optional() }).safeParse(req.body);
    if (!input.success || Object.keys(input.data).length === 0) { res.status(400).json({ error: 'Dados da comunidade inválidos.' }); return; }
    const [updated] = await db.update(communities).set(input.data).where(eq(communities.id, communityId)).returning();
    if (!updated) { res.status(404).json({ error: 'Comunidade não encontrada.' }); return; }
    await audit(communityId, currentUser(res).id, 'community.updated', null, '', null, { fields: Object.keys(input.data) });
    res.json({ community: updated });
  }));

  router.post('/communities/:communityId/leave', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId;
    const [community] = await db.select({ ownerId: communities.ownerId }).from(communities).where(eq(communities.id, communityId)).limit(1);
    if (!community) { res.status(404).json({ error: 'Comunidade não encontrada.' }); return; }
    if (community.ownerId === currentUser(res).id) { res.status(409).json({ error: 'O proprietário não pode sair antes de transferir a propriedade.' }); return; }
    await db.delete(communityMembers).where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, currentUser(res).id)));
    await removeCommunitySocketAccess(io, currentUser(res).id, communityId);
    res.json({ ok: true });
  }));

  router.post('/communities/:communityId/invites', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId;
    if (!await hasPermission(currentUser(res).id, communityId, 'create_invites')) { res.status(403).json({ error: 'Não tens permissão para criar convites.' }); return; }
    const input = z.object({ expiresInHours: z.number().int().min(1).max(720).default(168), maxUses: z.number().int().min(1).max(500).nullable().default(null) }).safeParse(req.body ?? {});
    if (!input.success) { res.status(400).json({ error: 'Opções de convite inválidas.' }); return; }
    const token = createOpaqueToken();
    await db.insert(invitations).values({ communityId, createdBy: currentUser(res).id, tokenHash: digestToken(token), expiresAt: new Date(Date.now() + input.data.expiresInHours * 3600_000), maxUses: input.data.maxUses });
    res.status(201).json({ inviteUrl: `/invite/${token}`, token });
  }));

  router.post('/invites/:token/join', asyncRoute(async (req, res) => {
    if (!/^[\w-]{32,64}$/.test(req.params.token)) { res.status(404).json({ error: 'Convite inválido ou expirado.' }); return; }
    const [invite] = await db.select().from(invitations).where(eq(invitations.tokenHash, digestToken(req.params.token))).limit(1);
    if (!invite || (invite.expiresAt && invite.expiresAt <= new Date()) || (invite.maxUses !== null && invite.useCount >= invite.maxUses)) { res.status(404).json({ error: 'Convite inválido ou expirado.' }); return; }
    const already = await isMember(currentUser(res).id, invite.communityId);
    if (already) { res.json({ communityId: invite.communityId, alreadyMember: true }); return; }
    if (await activeBan(invite.communityId, currentUser(res).id)) { res.status(403).json({ error: 'Não podes entrar nesta comunidade enquanto o banimento estiver ativo.' }); return; }
    const [claimed] = await db.update(invitations).set({ useCount: sql`${invitations.useCount} + 1` })
      .where(and(eq(invitations.id, invite.id), or(isNull(invitations.maxUses), sql`${invitations.useCount} < ${invitations.maxUses}`), or(isNull(invitations.expiresAt), gt(invitations.expiresAt, new Date())))).returning({ id: invitations.id });
    if (!claimed) { res.status(409).json({ error: 'O convite atingiu o limite de utilizações.' }); return; }
    await db.insert(communityMembers).values({ communityId: invite.communityId, userId: currentUser(res).id, roleId: await roleIdFor(invite.communityId, 'member') }).onConflictDoNothing();
    const joiningUser = currentUser(res);
    await broadcastCommunityMembers(io, invite.communityId, 'community:member_joined', { communityId: invite.communityId, member: { id: joiningUser.id, username: joiningUser.username, avatarUrl: joiningUser.avatarUrl, role: 'member' } });
    res.json({ communityId: invite.communityId, alreadyMember: false });
  }));

  router.post('/communities/:communityId/channels', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId;
    if (!await hasPermission(currentUser(res).id, communityId, 'manage_channels')) { res.status(403).json({ error: 'Não tens permissão para gerir canais.' }); return; }
    const input = z.object({ name: z.string().trim().min(2).max(60).regex(/^[\p{L}\p{N}_-]+$/u), topic: z.string().trim().max(200).default(''), kind: z.enum(['text', 'voice']).default('text') }).safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Dados do canal inválidos.' }); return; }
    const channel = await db.transaction(async (tx) => {
      const [created] = await tx.insert(channels).values({ communityId, ...input.data }).returning();
      if (created.kind === 'voice') await tx.insert(voiceRooms).values({ communityId, channelId: created.id, livekitRoom: `mv-${created.id}` });
      return created;
    });
    res.status(201).json({ channel });
  }));

  router.delete('/channels/:channelId', asyncRoute(async (req, res) => {
    const [channel] = await db.select({ id: channels.id, communityId: channels.communityId, kind: channels.kind })
      .from(channels).where(eq(channels.id, req.params.channelId)).limit(1);
    if (!channel) { res.status(404).json({ error: 'Canal não encontrado.' }); return; }
    if (!await hasPermission(currentUser(res).id, channel.communityId, 'manage_channels')) { res.status(403).json({ error: 'Não tens permissão para gerir canais.' }); return; }
    if (channel.kind === 'text') {
      const [total] = await db.select({ value: count() }).from(channels).where(and(eq(channels.communityId, channel.communityId), eq(channels.kind, 'text')));
      if (total.value <= 1) { res.status(409).json({ error: 'A comunidade precisa de pelo menos um canal de texto.' }); return; }
    }
    await db.delete(channels).where(eq(channels.id, channel.id));
    io.to(`channel:${channel.id}`).emit('channel:deleted', { id: channel.id });
    res.json({ ok: true });
  }));

  router.get('/channels/:channelId/messages', asyncRoute(async (req, res) => {
    const [channel] = await db.select({ id: channels.id, communityId: channels.communityId }).from(channels).where(eq(channels.id, req.params.channelId)).limit(1);
    if (!channel || !await isMember(currentUser(res).id, channel.communityId)) { res.status(404).json({ error: 'Canal não encontrado.' }); return; }
    if (await activeBan(channel.communityId, currentUser(res).id)) { res.status(403).json({ error: 'O teu acesso a esta comunidade está banido.' }); return; }
    const cursor = typeof req.query.before === 'string' ? req.query.before.split('~') : null;
    const before = cursor ? new Date(cursor[0]) : null;
    const beforeId = cursor?.[1];
    if (cursor && (cursor.length !== 2 || !before || Number.isNaN(before.getTime()) || !uuid.safeParse(beforeId).success)) { res.status(400).json({ error: 'Cursor inválido.' }); return; }
    const pageSize = 50;
    const filters = [eq(messages.channelId, channel.id)];
    if (before && beforeId) filters.push(or(lt(messages.createdAt, before), and(eq(messages.createdAt, before), lt(messages.id, beforeId)))!);
    const rows = await db.select({ id: messages.id, clientMessageId: messages.clientMessageId, body: messages.body, replyToId: messages.replyToId, replyAuthor: replyAuthors.username, replyBody: replyMessages.body, createdAt: messages.createdAt, pinnedAt: messages.pinnedAt, pinnedBy: messages.pinnedBy, authorId: users.id, username: users.username, avatarUrl: users.avatarUrl })
      .from(messages).innerJoin(users, eq(messages.authorId, users.id)).leftJoin(replyMessages, eq(messages.replyToId, replyMessages.id)).leftJoin(replyAuthors, eq(replyMessages.authorId, replyAuthors.id)).where(and(...filters)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(pageSize + 1);
    const hasMore = rows.length > pageSize;
    res.setHeader('Cache-Control', 'private, no-store');
    const selected = rows.slice(0, pageSize);
    const oldest = selected[selected.length - 1];
    const ordered = selected.reverse();
    const reactions = await reactionSummariesFor(ordered.map((message) => message.id), currentUser(res).id);
    res.json({ messages: ordered.map((message) => ({ ...message, reactions: reactions[message.id] ?? [] })), hasMore, nextCursor: oldest ? `${oldest.createdAt.toISOString()}~${oldest.id}` : null });
  }));

  router.get('/channels/:channelId/pinned', asyncRoute(async (req, res) => {
    const [channel] = await db.select({ id: channels.id, communityId: channels.communityId }).from(channels).where(eq(channels.id, req.params.channelId)).limit(1);
    const userId = currentUser(res).id;
    if (!channel || !await isMember(userId, channel.communityId) || await activeBan(channel.communityId, userId)) { res.status(404).json({ error: 'Canal não encontrado.' }); return; }
    const rows = await db.select({ id: messages.id, clientMessageId: messages.clientMessageId, body: messages.body, replyToId: messages.replyToId, replyAuthor: replyAuthors.username, replyBody: replyMessages.body, createdAt: messages.createdAt, pinnedAt: messages.pinnedAt, pinnedBy: messages.pinnedBy, authorId: users.id, username: users.username, avatarUrl: users.avatarUrl })
      .from(messages).innerJoin(users, eq(messages.authorId, users.id)).innerJoin(channels, eq(messages.channelId, channels.id))
      .leftJoin(replyMessages, eq(messages.replyToId, replyMessages.id)).leftJoin(replyAuthors, eq(replyMessages.authorId, replyAuthors.id))
      .where(and(eq(messages.channelId, channel.id), isNotNull(messages.pinnedAt))).orderBy(desc(messages.pinnedAt), desc(messages.id));
    const reactions = await reactionSummariesFor(rows.map((message) => message.id), userId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ messages: rows.map((message) => ({ ...message, reactions: reactions[message.id] ?? [] })) });
  }));

  router.post('/channels/:channelId/messages', asyncRoute(async (req, res) => {
    const [channel] = await db.select({ id: channels.id, communityId: channels.communityId, kind: channels.kind }).from(channels).where(eq(channels.id, req.params.channelId)).limit(1);
    if (!channel || channel.kind !== 'text' || !await hasPermission(currentUser(res).id, channel.communityId, 'send_messages')) { res.status(404).json({ error: 'Canal não encontrado ou acesso não autorizado.' }); return; }
    if (await activeBan(channel.communityId, currentUser(res).id)) { res.status(403).json({ error: 'O teu acesso a esta comunidade está banido.' }); return; }
    const mute = await activeMute(channel.communityId, currentUser(res).id);
    if (mute) { res.status(403).json({ error: `Estás silenciado até ${mute.expiresAt.toISOString()}.` }); return; }
    const input = z.object({ clientMessageId: uuid, body: z.string().trim().min(1).max(2000), replyToId: uuid.nullable().optional() }).safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Mensagem inválida (máximo 2000 caracteres).' }); return; }
    if (input.data.replyToId) {
      const [parent] = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.id, input.data.replyToId), eq(messages.channelId, channel.id))).limit(1);
      if (!parent) { res.status(400).json({ error: 'A resposta deve referir uma mensagem deste canal.' }); return; }
    }
    const author = currentUser(res);
    const [created] = await db.insert(messages).values({ channelId: channel.id, authorId: author.id, ...input.data }).onConflictDoNothing().returning();
    const [row] = await db.select({ id: messages.id, clientMessageId: messages.clientMessageId, body: messages.body, replyToId: messages.replyToId, replyAuthor: replyAuthors.username, replyBody: replyMessages.body, createdAt: messages.createdAt, pinnedAt: messages.pinnedAt, pinnedBy: messages.pinnedBy, authorId: users.id, username: users.username, avatarUrl: users.avatarUrl })
      .from(messages).innerJoin(users, eq(messages.authorId, users.id)).leftJoin(replyMessages, eq(messages.replyToId, replyMessages.id)).leftJoin(replyAuthors, eq(replyMessages.authorId, replyAuthors.id))
      .where(and(eq(messages.channelId, channel.id), eq(messages.authorId, author.id), eq(messages.clientMessageId, input.data.clientMessageId))).limit(1);
    if (created && row) {
      const mentionedNames = [...new Set(Array.from(input.data.body.matchAll(/@([\p{L}\p{N}_-]{3,32})/gu), (match) => match[1].toLowerCase()))];
      if (mentionedNames.length) {
        const mentioned = await db.select({ id: users.id, username: users.username })
          .from(communityMembers).innerJoin(users, eq(communityMembers.userId, users.id))
          .where(and(eq(communityMembers.communityId, channel.communityId), inArray(sql`lower(${users.username})`, mentionedNames)));
        const recipients = mentioned.filter((person) => person.id !== author.id);
        if (recipients.length) {
          await db.insert(messageMentions).values(recipients.map((person) => ({ messageId: row.id, userId: person.id }))).onConflictDoNothing();
          for (const person of recipients) io.to(`user:${person.id}`).emit('mention:new', { username: author.username, channelId: channel.id, messageId: row.id });
        }
      }
      io.to(`channel:${channel.id}`).emit('message:new', row);
    }
    res.status(created ? 201 : 200).json({ message: row });
  }));

  router.post('/messages/:messageId/reactions', asyncRoute(async (req, res) => {
    const input = z.object({ emoji: z.string().min(1).max(32).refine(isUnicodeEmoji), active: z.boolean() }).safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Escolhe um único emoji válido.' }); return; }
    const userId = currentUser(res).id;
    const outcome = await db.transaction(async (tx) => {
      const [message] = await tx.select({ id: messages.id, channelId: messages.channelId, communityId: channels.communityId })
        .from(messages).innerJoin(channels, eq(messages.channelId, channels.id)).where(eq(messages.id, req.params.messageId)).for('update');
      if (!message) return { status: 404, error: 'Mensagem não encontrada.' };
      const [member] = await tx.select({ id: communityMembers.id }).from(communityMembers)
        .where(and(eq(communityMembers.communityId, message.communityId), eq(communityMembers.userId, userId))).limit(1);
      if (!member) return { status: 404, error: 'Não tens acesso a esta mensagem.' };
      const [ban] = await tx.select({ id: communityBans.id }).from(communityBans)
        .where(and(eq(communityBans.communityId, message.communityId), eq(communityBans.userId, userId), isNull(communityBans.revokedAt))).limit(1);
      if (ban) return { status: 403, error: 'Não podes reagir nesta comunidade.' };
      const [mute] = await tx.select({ id: communityMutes.id }).from(communityMutes)
        .where(and(eq(communityMutes.communityId, message.communityId), eq(communityMutes.userId, userId), isNull(communityMutes.revokedAt), gt(communityMutes.expiresAt, new Date()))).limit(1);
      if (mute) return { status: 403, error: 'Não podes reagir enquanto estiveres silenciado.' };
      const [existing] = await tx.select({ id: messageReactions.id }).from(messageReactions)
        .where(and(eq(messageReactions.messageId, message.id), eq(messageReactions.userId, userId), eq(messageReactions.emoji, input.data.emoji))).limit(1);
      if (input.data.active && !existing) {
        const distinct = await tx.selectDistinct({ emoji: messageReactions.emoji }).from(messageReactions).where(eq(messageReactions.messageId, message.id));
        if (!distinct.some((item) => item.emoji === input.data.emoji) && distinct.length >= 20) return { status: 409, error: 'Esta mensagem já tem 20 emojis diferentes.' };
        await tx.insert(messageReactions).values({ messageId: message.id, userId, emoji: input.data.emoji }).onConflictDoNothing();
      } else if (!input.data.active && existing) await tx.delete(messageReactions).where(eq(messageReactions.id, existing.id));
      return { status: 200, channelId: message.channelId };
    });
    if (outcome.status !== 200 || !('channelId' in outcome)) { res.status(outcome.status).json({ error: outcome.error }); return; }
    const reactions = (await reactionSummariesFor([req.params.messageId], userId))[req.params.messageId] ?? [];
    io.to(`channel:${outcome.channelId}`).emit('message:reactions', { messageId: req.params.messageId, reactions });
    res.json({ reactions });
  }));

  router.get('/messages/:messageId/reactions/:emoji/users', asyncRoute(async (req, res) => {
    const parsedEmoji = z.string().min(1).max(32).refine(isUnicodeEmoji).safeParse(req.params.emoji);
    if (!parsedEmoji.success) { res.status(400).json({ error: 'Emoji inválido.' }); return; }
    const userId = currentUser(res).id;
    const [message] = await db.select({ id: messages.id, communityId: channels.communityId }).from(messages)
      .innerJoin(channels, eq(messages.channelId, channels.id)).where(eq(messages.id, req.params.messageId)).limit(1);
    if (!message || !await isMember(userId, message.communityId) || await activeBan(message.communityId, userId)) { res.status(404).json({ error: 'Mensagem não encontrada.' }); return; }
    const rows = await db.select({ username: users.username }).from(messageReactions)
      .innerJoin(users, eq(messageReactions.userId, users.id))
      .where(and(eq(messageReactions.messageId, message.id), eq(messageReactions.emoji, parsedEmoji.data))).orderBy(users.username);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ users: rows.map((row) => row.username) });
  }));

  router.delete('/messages/:messageId', asyncRoute(async (req, res) => {
    const [message] = await db.select({ id: messages.id, authorId: messages.authorId, communityId: channels.communityId, channelId: messages.channelId })
      .from(messages).innerJoin(channels, eq(messages.channelId, channels.id)).where(eq(messages.id, req.params.messageId)).limit(1);
    if (!message) { res.status(404).json({ error: 'Mensagem não encontrada.' }); return; }
    const actorId = currentUser(res).id;
    if (!await isMember(actorId, message.communityId)) { res.status(404).json({ error: 'Mensagem não encontrada.' }); return; }
    if (message.authorId !== actorId && !await hasPermission(actorId, message.communityId, 'delete_messages')) { res.status(403).json({ error: 'Não tens permissão para apagar esta mensagem.' }); return; }
    await db.delete(messages).where(eq(messages.id, message.id));
    io.to(`channel:${message.channelId}`).emit('message:deleted', { id: message.id });
    res.json({ ok: true });
  }));

  router.post('/messages/:messageId/pin', asyncRoute(async (req, res) => {
    const [message] = await db.select({ id: messages.id, channelId: messages.channelId, communityId: channels.communityId, pinnedAt: messages.pinnedAt })
      .from(messages).innerJoin(channels, eq(messages.channelId, channels.id)).where(eq(messages.id, req.params.messageId)).limit(1);
    if (!message || !await hasPermission(currentUser(res).id, message.communityId, 'pin_messages')) { res.status(403).json({ error: 'Não tens permissão para fixar mensagens.' }); return; }
    const [updated] = await db.update(messages).set({ pinnedAt: new Date(), pinnedBy: currentUser(res).id }).where(eq(messages.id, message.id)).returning({ id: messages.id, pinnedAt: messages.pinnedAt, pinnedBy: messages.pinnedBy });
    await audit(message.communityId, currentUser(res).id, 'message.pinned', null, '', null, { messageId: message.id });
    io.to(`channel:${message.channelId}`).emit('message:pinned', updated);
    res.json({ message: updated });
  }));

  router.delete('/messages/:messageId/pin', asyncRoute(async (req, res) => {
    const [message] = await db.select({ id: messages.id, channelId: messages.channelId, communityId: channels.communityId })
      .from(messages).innerJoin(channels, eq(messages.channelId, channels.id)).where(eq(messages.id, req.params.messageId)).limit(1);
    if (!message || !await hasPermission(currentUser(res).id, message.communityId, 'pin_messages')) { res.status(403).json({ error: 'Não tens permissão para desafixar mensagens.' }); return; }
    await db.update(messages).set({ pinnedAt: null, pinnedBy: null }).where(eq(messages.id, message.id));
    await audit(message.communityId, currentUser(res).id, 'message.unpinned', null, '', null, { messageId: message.id });
    io.to(`channel:${message.channelId}`).emit('message:unpinned', { id: message.id });
    res.json({ ok: true });
  }));

  router.post('/communities/:communityId/members/:userId/mute', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId; const actorId = currentUser(res).id;
    if (!await hasPermission(actorId, communityId, 'mute_members') || !await canActOnTarget(actorId, communityId, req.params.userId)) { res.status(403).json({ error: 'Não tens permissão para silenciar este membro.' }); return; }
    const input = z.object({ durationMinutes: z.union([z.literal(5), z.literal(10), z.literal(60), z.literal(1440)]), reason: z.string().trim().max(500).default('') }).safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Duração de silêncio inválida.' }); return; }
    const durationSeconds = input.data.durationMinutes * 60; const expiresAt = new Date(Date.now() + durationSeconds * 1000);
    await db.update(communityMutes).set({ revokedAt: new Date() }).where(and(eq(communityMutes.communityId, communityId), eq(communityMutes.userId, req.params.userId), isNull(communityMutes.revokedAt)));
    await db.insert(communityMutes).values({ communityId, userId: req.params.userId, actorId, expiresAt, reason: input.data.reason });
    await audit(communityId, actorId, 'member.muted', req.params.userId, input.data.reason, durationSeconds);
    io.in(`user:${req.params.userId}`).emit('community:muted', { communityId, expiresAt });
    res.json({ expiresAt });
  }));

  router.delete('/communities/:communityId/members/:userId/mute', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId; const actorId = currentUser(res).id;
    if (!await hasPermission(actorId, communityId, 'mute_members') || !await canActOnTarget(actorId, communityId, req.params.userId)) { res.status(403).json({ error: 'Não tens permissão para remover este silêncio.' }); return; }
    await db.update(communityMutes).set({ revokedAt: new Date() }).where(and(eq(communityMutes.communityId, communityId), eq(communityMutes.userId, req.params.userId), isNull(communityMutes.revokedAt)));
    await audit(communityId, actorId, 'member.unmuted', req.params.userId);
    io.in(`user:${req.params.userId}`).emit('community:unmuted', { communityId });
    res.json({ ok: true });
  }));

  router.post('/communities/:communityId/members/:userId/ban', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId; const actorId = currentUser(res).id;
    if (!await hasPermission(actorId, communityId, 'ban_members') || !await canActOnTarget(actorId, communityId, req.params.userId)) { res.status(403).json({ error: 'Não tens permissão para banir este membro.' }); return; }
    const input = z.object({ reason: z.string().trim().max(500).default('') }).safeParse(req.body ?? {});
    if (!input.success) { res.status(400).json({ error: 'Motivo inválido.' }); return; }
    await db.insert(communityBans).values({ communityId, userId: req.params.userId, actorId, reason: input.data.reason });
    await db.delete(communityMembers).where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, req.params.userId)));
    await audit(communityId, actorId, 'member.banned', req.params.userId, input.data.reason);
    io.in(`user:${req.params.userId}`).emit('community:banned', { communityId });
    await removeCommunitySocketAccess(io, req.params.userId, communityId);
    await broadcastCommunityMembers(io, communityId, 'community:member_left', { communityId, userId: req.params.userId });
    res.json({ ok: true });
  }));

  router.get('/communities/:communityId/bans', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId;
    if (!await hasPermission(currentUser(res).id, communityId, 'ban_members')) { res.status(403).json({ error: 'Não tens permissão para consultar banimentos.' }); return; }
    const rows = await db.select({ userId: communityBans.userId, username: users.username, reason: communityBans.reason, createdAt: communityBans.createdAt })
      .from(communityBans).innerJoin(users, eq(communityBans.userId, users.id))
      .where(and(eq(communityBans.communityId, communityId), isNull(communityBans.revokedAt)))
      .orderBy(desc(communityBans.createdAt));
    const seen = new Set<string>();
    const bans = rows.filter((row) => { if (seen.has(row.userId)) return false; seen.add(row.userId); return true; });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ bans });
  }));
  router.delete('/communities/:communityId/bans/:userId', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId; const actorId = currentUser(res).id;
    if (!await hasPermission(actorId, communityId, 'ban_members')) { res.status(403).json({ error: 'Não tens permissão para revogar banimentos.' }); return; }
    await db.update(communityBans).set({ revokedAt: new Date() }).where(and(eq(communityBans.communityId, communityId), eq(communityBans.userId, req.params.userId), isNull(communityBans.revokedAt)));
    await audit(communityId, actorId, 'member.unbanned', req.params.userId);
    res.json({ ok: true });
  }));

  router.get('/communities/:communityId/audit-log', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId;
    if (!await hasPermission(currentUser(res).id, communityId, 'view_audit_log')) { res.status(403).json({ error: 'Não tens permissão para consultar o registo.' }); return; }
    const rows = await db.select({ id: moderationAuditLogs.id, action: moderationAuditLogs.action, reason: moderationAuditLogs.reason, durationSeconds: moderationAuditLogs.durationSeconds, metadata: moderationAuditLogs.metadata, createdAt: moderationAuditLogs.createdAt, actorId: moderationAuditLogs.actorId, actorUsername: users.username, targetUserId: moderationAuditLogs.targetUserId })
      .from(moderationAuditLogs).innerJoin(users, eq(moderationAuditLogs.actorId, users.id)).where(eq(moderationAuditLogs.communityId, communityId)).orderBy(desc(moderationAuditLogs.createdAt)).limit(100);
    res.json({ entries: rows });
  }));

  router.post('/calls', asyncRoute(async (req, res) => {
    const caller = currentUser(res);
    const input = z.object({ calleeId: uuid }).safeParse(req.body);
    if (!input.success || input.data.calleeId === caller.id) { res.status(400).json({ error: 'Destinatário de chamada inválido.' }); return; }
    const [callee] = await db.select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, input.data.calleeId)).limit(1);
    if (!callee) { res.status(404).json({ error: 'Utilizador não encontrado.' }); return; }
    const [busy] = await db.select({ id: privateCalls.id }).from(privateCalls).where(and(or(eq(privateCalls.callerId, caller.id), eq(privateCalls.calleeId, caller.id)), or(eq(privateCalls.callerId, input.data.calleeId), eq(privateCalls.calleeId, input.data.calleeId)), or(eq(privateCalls.status, 'initiated'), eq(privateCalls.status, 'ringing'), eq(privateCalls.status, 'accepted'), eq(privateCalls.status, 'connecting'), eq(privateCalls.status, 'in_progress')))).limit(1);
    if (busy) { res.status(409).json({ error: 'Já existe uma chamada ativa entre estes utilizadores.' }); return; }
    const [call] = await db.insert(privateCalls).values({ callerId: caller.id, calleeId: callee.id, status: 'ringing', livekitRoom: `mavuno-call-${crypto.randomUUID()}` }).returning();
    io.in(`user:${callee.id}`).emit('call:incoming', { callId: call.id, caller: { id: caller.id, username: caller.username, avatarUrl: caller.avatarUrl }, status: 'ringing' });
    io.in(`user:${caller.id}`).emit('call:status', { callId: call.id, status: 'ringing', peer: callee });
    res.status(201).json({ call: { id: call.id, status: call.status, peer: callee } });
  }));

  router.patch('/calls/:callId', asyncRoute(async (req, res) => {
    const actorId = currentUser(res).id;
    const input = z.object({ status: z.enum(['accepted', 'rejected', 'timeout', 'ended']) }).safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Estado de chamada inválido.' }); return; }
    const [call] = await db.select().from(privateCalls).where(eq(privateCalls.id, req.params.callId)).limit(1);
    if (!call || (call.callerId !== actorId && call.calleeId !== actorId)) { res.status(404).json({ error: 'Chamada não encontrada.' }); return; }
    const active = ['ringing', 'accepted', 'connecting', 'in_progress'].includes(call.status);
    if (!active && input.data.status !== 'ended') { res.status(409).json({ error: 'A chamada já não está disponível.' }); return; }
    const next = input.data.status === 'accepted' ? 'accepted' : input.data.status;
    const [updated] = await db.update(privateCalls).set({ status: next, answeredAt: next === 'accepted' ? new Date() : call.answeredAt, endedAt: ['rejected', 'timeout', 'ended'].includes(next) ? new Date() : call.endedAt }).where(eq(privateCalls.id, call.id)).returning({ id: privateCalls.id, status: privateCalls.status });
    const peerId = call.callerId === actorId ? call.calleeId : call.callerId;
    io.in(`user:${peerId}`).emit('call:status', { callId: updated.id, status: updated.status });
    io.in(`user:${actorId}`).emit('call:status', { callId: updated.id, status: updated.status });
    res.json({ call: updated });
  }));

  router.post('/calls/:callId/token', asyncRoute(async (req, res) => {
    const actorId = currentUser(res).id;
    const [call] = await db.select().from(privateCalls).where(eq(privateCalls.id, req.params.callId)).limit(1);
    if (!call || (call.callerId !== actorId && call.calleeId !== actorId)) { res.status(404).json({ error: 'Chamada não encontrada.' }); return; }
    if (call.status !== 'accepted' && call.status !== 'connecting' && call.status !== 'in_progress') { res.status(409).json({ error: 'A chamada ainda não foi aceite.' }); return; }
    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) { res.status(503).json({ error: 'O serviço LiveKit ainda não está configurado.' }); return; }
    await db.update(privateCalls).set({ status: 'in_progress' }).where(eq(privateCalls.id, call.id));
    const user = currentUser(res);
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: user.id, name: user.username, ttl: '15m' });
    token.addGrant({ roomJoin: true, room: call.livekitRoom, canPublish: true, canSubscribe: true });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ token: await token.toJwt(), serverUrl: LIVEKIT_URL, room: call.livekitRoom, status: 'in_progress' });
  }));

  router.delete('/communities/:communityId/members/:userId', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId;
    if (!await hasPermission(currentUser(res).id, communityId, 'kick_members')) { res.status(403).json({ error: 'Não tens permissão para remover membros.' }); return; }
    if (req.params.userId === currentUser(res).id) { res.status(400).json({ error: 'Usa a opção sair para remover a tua própria conta.' }); return; }
    const [actor] = await db.select({ role: communityRoles.key }).from(communityMembers).innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
      .where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, currentUser(res).id))).limit(1);
    const [target] = await db.select({ role: communityRoles.key }).from(communityMembers).innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
      .where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, req.params.userId))).limit(1);
    if (!target || target.role === 'owner') { res.status(404).json({ error: 'Membro não encontrado ou protegido.' }); return; }
    if (!actor || !await canActOnTarget(currentUser(res).id, communityId, req.params.userId)) { res.status(403).json({ error: 'O teu cargo não pode remover este membro.' }); return; }
    await db.delete(communityMembers).where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, req.params.userId)));
    await audit(communityId, currentUser(res).id, 'member.kicked', req.params.userId);
    io.in(`user:${req.params.userId}`).emit('community:kicked', { communityId });
    await removeCommunitySocketAccess(io, req.params.userId, communityId);
    await broadcastCommunityMembers(io, communityId, 'community:member_left', { communityId, userId: req.params.userId });
    res.json({ ok: true });
  }));

  router.patch('/communities/:communityId/members/:userId/role', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId;
    if (!await hasPermission(currentUser(res).id, communityId, 'manage_community')) { res.status(403).json({ error: 'Não tens permissão para gerir cargos.' }); return; }
    const input = z.object({ role: z.enum(['admin', 'moderator', 'member']) }).safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Cargo inválido.' }); return; }
    const [actor] = await db.select({ role: communityRoles.key }).from(communityMembers).innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
      .where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, currentUser(res).id))).limit(1);
    const [target] = await db.select({ role: communityRoles.key }).from(communityMembers).innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
      .where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, req.params.userId))).limit(1);
    if (!target || target.role === 'owner') { res.status(404).json({ error: 'Membro não encontrado ou protegido.' }); return; }
    if (!actor || !await canActOnTarget(currentUser(res).id, communityId, req.params.userId)) { res.status(403).json({ error: 'O teu cargo não pode gerir este membro.' }); return; }
    const targetHierarchy = input.data.role === 'admin' ? 80 : input.data.role === 'moderator' ? 50 : 10;
    if (actor.role !== 'owner' && actor.role !== 'admin' && targetHierarchy >= (await roleFor(currentUser(res).id, communityId))!.hierarchy) { res.status(403).json({ error: 'Não podes atribuir uma função igual ou superior à tua.' }); return; }
    const targetRoleId = await roleIdFor(communityId, input.data.role);
    const [result] = await db.update(communityMembers).set({ roleId: targetRoleId }).where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, req.params.userId))).returning({ id: communityMembers.id });
    if (!result) { res.status(404).json({ error: 'Membro não encontrado.' }); return; }
    await audit(communityId, currentUser(res).id, 'member.role_changed', req.params.userId, '', null, { role: input.data.role });
    res.json({ ok: true });
  }));

  router.post('/channels/:channelId/voice-token', asyncRoute(async (req, res) => {
    const [channel] = await db.select({ id: channels.id, communityId: channels.communityId, kind: channels.kind }).from(channels).where(eq(channels.id, req.params.channelId)).limit(1);
    if (!channel || channel.kind !== 'voice' || !await hasPermission(currentUser(res).id, channel.communityId, 'join_voice')) { res.status(403).json({ error: 'Não tens acesso a esta sala de voz.' }); return; }
    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) { res.status(503).json({ error: 'O serviço LiveKit ainda não está configurado.' }); return; }
    const [room] = await db.select({ name: voiceRooms.livekitRoom }).from(voiceRooms).where(eq(voiceRooms.channelId, channel.id)).limit(1);
    if (!room) { res.status(503).json({ error: 'Esta sala ainda não está configurada para voz.' }); return; }
    const user = currentUser(res);
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: user.id, name: user.username, ttl: '15m' });
    token.addGrant({ roomJoin: true, room: room.name, canPublish: true, canSubscribe: true });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ token: await token.toJwt(), serverUrl: LIVEKIT_URL, room: room.name });
  }));

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : 'Erro inesperado.';
    console.error('API request failed:', message);
    if (!res.headersSent) res.status(500).json({ error: 'Ocorreu um erro interno. Tenta novamente.' });
  });
  return router;
}
