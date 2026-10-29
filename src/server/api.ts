import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { and, count, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AccessToken } from 'livekit-server-sdk';
import { db, pool } from './db/index.js';
import {
  channels, communities, communityMembers, communityRoles, invitations, messages,
  messageMentions, rolePermissions, sessions, users, voiceRooms,
} from './db/schema.js';
import { createOpaqueToken, digestToken, hashPassword, readSessionCookie, setCsrfCookie, setSessionCookie, clearSessionCookie, verifyPassword } from './security.js';
import { hasPermission, isMember, roleIdFor, type Permission } from './permissions.js';
import type { Server as SocketServer } from 'socket.io';

interface PublicUser { id: string; username: string; email: string; avatarUrl: string | null }
interface RoleDef { key: 'owner' | 'admin' | 'moderator' | 'member'; name: string; permissions: Permission[] }
const permissionSet: RoleDef[] = [
  { key: 'owner', name: 'Proprietário', permissions: ['manage_community', 'manage_channels', 'delete_messages', 'kick_members', 'create_invites', 'send_messages', 'join_voice'] },
  { key: 'admin', name: 'Administrador', permissions: ['manage_community', 'manage_channels', 'delete_messages', 'kick_members', 'create_invites', 'send_messages', 'join_voice'] },
  { key: 'moderator', name: 'Moderador', permissions: ['delete_messages', 'kick_members', 'create_invites', 'send_messages', 'join_voice'] },
  { key: 'member', name: 'Membro', permissions: ['send_messages', 'join_voice'] },
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
      const roles = await tx.insert(communityRoles).values(permissionSet.map(({ key, name }) => ({ communityId: id, key, name }))).returning();
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
    const [community] = await db.select({ id: communities.id, name: communities.name, slug: communities.slug, description: communities.description, category: communities.category, isPrivate: communities.isPrivate, ownerId: communities.ownerId })
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
    const [claimed] = await db.update(invitations).set({ useCount: sql`${invitations.useCount} + 1` })
      .where(and(eq(invitations.id, invite.id), or(isNull(invitations.maxUses), sql`${invitations.useCount} < ${invitations.maxUses}`), or(isNull(invitations.expiresAt), gt(invitations.expiresAt, new Date())))).returning({ id: invitations.id });
    if (!claimed) { res.status(409).json({ error: 'O convite atingiu o limite de utilizações.' }); return; }
    await db.insert(communityMembers).values({ communityId: invite.communityId, userId: currentUser(res).id, roleId: await roleIdFor(invite.communityId, 'member') }).onConflictDoNothing();
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
    const cursor = typeof req.query.before === 'string' ? req.query.before.split('~') : null;
    const before = cursor ? new Date(cursor[0]) : null;
    const beforeId = cursor?.[1];
    if (cursor && (cursor.length !== 2 || !before || Number.isNaN(before.getTime()) || !uuid.safeParse(beforeId).success)) { res.status(400).json({ error: 'Cursor inválido.' }); return; }
    const pageSize = 50;
    const filters = [eq(messages.channelId, channel.id)];
    if (before && beforeId) filters.push(or(lt(messages.createdAt, before), and(eq(messages.createdAt, before), lt(messages.id, beforeId)))!);
    const rows = await db.select({ id: messages.id, clientMessageId: messages.clientMessageId, body: messages.body, replyToId: messages.replyToId, createdAt: messages.createdAt, authorId: users.id, username: users.username, avatarUrl: users.avatarUrl })
      .from(messages).innerJoin(users, eq(messages.authorId, users.id)).where(and(...filters)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(pageSize + 1);
    const hasMore = rows.length > pageSize;
    res.setHeader('Cache-Control', 'private, no-store');
    const selected = rows.slice(0, pageSize);
    const oldest = selected[selected.length - 1];
    res.json({ messages: selected.reverse(), hasMore, nextCursor: oldest ? `${oldest.createdAt.toISOString()}~${oldest.id}` : null });
  }));

  router.post('/channels/:channelId/messages', asyncRoute(async (req, res) => {
    const [channel] = await db.select({ id: channels.id, communityId: channels.communityId, kind: channels.kind }).from(channels).where(eq(channels.id, req.params.channelId)).limit(1);
    if (!channel || channel.kind !== 'text' || !await hasPermission(currentUser(res).id, channel.communityId, 'send_messages')) { res.status(404).json({ error: 'Canal não encontrado ou acesso não autorizado.' }); return; }
    const input = z.object({ clientMessageId: uuid, body: z.string().trim().min(1).max(2000), replyToId: uuid.nullable().optional() }).safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Mensagem inválida (máximo 2000 caracteres).' }); return; }
    if (input.data.replyToId) {
      const [parent] = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.id, input.data.replyToId), eq(messages.channelId, channel.id))).limit(1);
      if (!parent) { res.status(400).json({ error: 'A resposta deve referir uma mensagem deste canal.' }); return; }
    }
    const author = currentUser(res);
    const [created] = await db.insert(messages).values({ channelId: channel.id, authorId: author.id, ...input.data }).onConflictDoNothing().returning();
    const [row] = await db.select({ id: messages.id, clientMessageId: messages.clientMessageId, body: messages.body, replyToId: messages.replyToId, createdAt: messages.createdAt, authorId: users.id, username: users.username, avatarUrl: users.avatarUrl })
      .from(messages).innerJoin(users, eq(messages.authorId, users.id))
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

  router.delete('/communities/:communityId/members/:userId', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId;
    if (!await hasPermission(currentUser(res).id, communityId, 'kick_members')) { res.status(403).json({ error: 'Não tens permissão para remover membros.' }); return; }
    if (req.params.userId === currentUser(res).id) { res.status(400).json({ error: 'Usa a opção sair para remover a tua própria conta.' }); return; }
    const [actor] = await db.select({ role: communityRoles.key }).from(communityMembers).innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
      .where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, currentUser(res).id))).limit(1);
    const [target] = await db.select({ role: communityRoles.key }).from(communityMembers).innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
      .where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, req.params.userId))).limit(1);
    if (!target || target.role === 'owner') { res.status(404).json({ error: 'Membro não encontrado ou protegido.' }); return; }
    if (!actor || (actor.role === 'moderator' && target.role !== 'member') || (actor.role === 'admin' && target.role === 'admin')) { res.status(403).json({ error: 'O teu cargo não pode remover este membro.' }); return; }
    await db.delete(communityMembers).where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, req.params.userId)));
    io.in(`user:${req.params.userId}`).emit('community:kicked', { communityId });
    await removeCommunitySocketAccess(io, req.params.userId, communityId);
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
    if (actor?.role === 'admin' && (target.role === 'admin' || input.data.role === 'admin')) { res.status(403).json({ error: 'Apenas o proprietário pode gerir administradores.' }); return; }
    const targetRoleId = await roleIdFor(communityId, input.data.role);
    const [result] = await db.update(communityMembers).set({ roleId: targetRoleId }).where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, req.params.userId))).returning({ id: communityMembers.id });
    if (!result) { res.status(404).json({ error: 'Membro não encontrado.' }); return; }
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
