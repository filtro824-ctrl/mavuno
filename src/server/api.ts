import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { AccessToken } from 'livekit-server-sdk';
import { db, pool } from './db/index.js';
import {
  channels, channelCategories, channelReads, communities, communityMembers, communityRoles, messages, joinRequests,
  messageMentions, rolePermissions, sessions, users, voiceRooms, communityBans, communityMutes,
  moderationAuditLogs, privateCalls, messageReactions, messageAttachments,
} from './db/schema.js';
import { createOpaqueToken, digestToken, hashPassword, readSessionCookie, setCsrfCookie, setSessionCookie, clearSessionCookie, verifyPassword } from './security.js';
import { hasPermission, isMember, roleFor, roleIdFor, type Permission } from './permissions.js';
import { groupReactionAggregates, isUnicodeEmoji } from './reaction-utils.js';
import { profileUpdateSchema, profileVisibilityFromRecord, visibleMemberIdentity, visibleMemberProfile, type CommonCommunity, type ProfileRecord } from './profile-utils.js';
import { broadcastProfileUpdate } from './profile-realtime.js';
import { canActOnHierarchy, durationInRange, durationSeconds } from './moderation-utils.js';
import type { Server as SocketServer } from 'socket.io';
import { attachmentsForMessages, createAttachmentsRouter, deleteChannelWithAttachments, removeMessageAttachments } from './attachments-api.js';
import { MAX_ATTACHMENTS_PER_MESSAGE, signatureMatches } from './attachment-utils.js';
import { createProfileMediaRouter } from './profile-media-api.js';
import { PROFILE_MEDIA_MAX_BYTES, makeProfileMediaReference, parseProfileMediaReference, profileMediaObjectKey, profileMediaStagingObjectKey } from './profile-media-utils.js';
import { copyStoredObject, deleteStoredObject, inspectStoredObject, storageIsConfigured } from './storage.js';
import { createJoinFlowRouter, createPublicInvitePreviewRouter } from './join-flow-api.js';
import { canWriteToChannel, categoryNameSchema, coverColorSchema, coverUrlSchema, summarizeUnreadRows } from './channel-utils.js';

const replyMessages = alias(messages, 'reply_messages');
const replyAuthors = alias(users, 'reply_authors');
const banActors = alias(users, 'ban_actors');
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
function withoutHiddenAvatar<T extends { avatarUrl: string | null; showAvatar: boolean }>(row: T): Omit<T, 'avatarUrl' | 'showAvatar'> & { avatarUrl?: string | null } {
  const { avatarUrl, showAvatar, ...safe } = row;
  return { ...safe, ...(showAvatar ? { avatarUrl } : {}) };
}
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
  bannerUrl: users.bannerUrl,
  bannerColor: users.bannerColor,
  statusText: users.statusText,
  presencePreference: users.presencePreference,
  showBanner: users.showBanner,
};

async function loadOwnProfile(userId: string) {
  const [profile] = await db.select(profileColumns).from(users).where(eq(users.id, userId)).limit(1);
  if (!profile) return null;
  const memberships = await db.select({
    id: communities.id,
    name: communities.name,
    role: communityRoles.key,
    joinedAt: communityMembers.joinedAt,
  }).from(communityMembers).innerJoin(communities, eq(communityMembers.communityId, communities.id))
    .innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
    .where(eq(communityMembers.userId, userId)).orderBy(desc(communityMembers.joinedAt));
  const record = profile as ProfileRecord;
  return {
    user: {
      id: profile.id,
      username: profile.username,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      aboutMe: profile.aboutMe,
      bannerUrl: profile.bannerUrl,
      bannerColor: profile.bannerColor,
      statusText: profile.statusText,
      presencePreference: profile.presencePreference,
      createdAt: profile.createdAt.toISOString(),
      visibility: profileVisibilityFromRecord(record),
    },
    communities: memberships.map((community) => ({ ...community, joinedAt: community.joinedAt.toISOString() })),
  };
}

async function commonCommunitiesFor(viewerId: string, targetId: string): Promise<CommonCommunity[]> {
  const mine = await db.select({ id: communityMembers.communityId }).from(communityMembers).where(eq(communityMembers.userId, viewerId));
  if (!mine.length) return [];
  const mineIds = new Set(mine.map((row) => row.id));
  const target = await db.select({ id: communities.id, name: communities.name })
    .from(communityMembers).innerJoin(communities, eq(communityMembers.communityId, communities.id))
    .where(eq(communityMembers.userId, targetId));
  return target.filter((community) => mineIds.has(community.id));
}

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
  const now = new Date();
  const [ban] = await db.select({ id: communityBans.id }).from(communityBans)
    .where(and(eq(communityBans.communityId, communityId), eq(communityBans.userId, userId), isNull(communityBans.revokedAt), or(isNull(communityBans.expiresAt), gt(communityBans.expiresAt, now)))).limit(1);
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
  return canActOnHierarchy(actor?.hierarchy ?? null, target?.hierarchy ?? null, target?.role ?? null);
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

  router.use(createPublicInvitePreviewRouter());
  router.use(requireAuth);
  router.use(createJoinFlowRouter(io));
  router.use(createAttachmentsRouter(io));
  router.use(createProfileMediaRouter());
  router.get('/auth/me', (_req, res) => res.json({ user: currentUser(res) }));
  router.get('/profile', asyncRoute(async (_req, res) => {
    const profile = await loadOwnProfile(currentUser(res).id);
    if (!profile) { res.status(404).json({ error: 'Não foi possível encontrar o teu perfil.' }); return; }
    res.json(profile);
  }));
  router.patch('/profile', asyncRoute(async (req, res) => {
    const input = profileUpdateSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Confirma os links HTTPS, as imagens, as cores e os textos.' }); return; }
    const userId = currentUser(res).id;
    const uploadCandidates = [
      input.data.avatarUploadId ? { kind: 'avatar' as const, uploadId: input.data.avatarUploadId } : null,
      input.data.bannerUploadId ? { kind: 'banner' as const, uploadId: input.data.bannerUploadId } : null,
    ].filter((item): item is { kind: 'avatar' | 'banner'; uploadId: string } => item !== null)
      .map((item) => ({ ...item, temporaryKey: profileMediaStagingObjectKey(userId, item.kind, item.uploadId), finalKey: profileMediaObjectKey(userId, item.kind, item.uploadId), reference: makeProfileMediaReference(userId, item.kind, item.uploadId) }));
    let protectedFinalKeys = new Set<string>();
    const cleanupCandidates = async (includeFinal: boolean, additionalProtectedKeys = new Set<string>()) => {
      const safeProtectedKeys = new Set([...protectedFinalKeys, ...additionalProtectedKeys]);
      if (includeFinal) {
        try {
          const [current] = await db.select({ avatarUrl: users.avatarUrl, bannerUrl: users.bannerUrl }).from(users).where(eq(users.id, userId)).limit(1);
          for (const value of [current?.avatarUrl, current?.bannerUrl]) {
            if (!value) continue;
            const reference = parseProfileMediaReference(value);
            if (reference?.userId === userId) safeProtectedKeys.add(profileMediaObjectKey(reference.userId, reference.kind, reference.assetId));
          }
        } catch {
          for (const item of uploadCandidates) safeProtectedKeys.add(item.finalKey);
        }
      }
      const keys = uploadCandidates.flatMap((item) => [item.temporaryKey, ...(includeFinal && !safeProtectedKeys.has(item.finalKey) ? [item.finalKey] : [])]);
      await Promise.all(keys.map(async (key) => { try { await deleteStoredObject(key); } catch { /* Staging cleanup is retried by the bucket lifecycle rule. */ } }));
    };
    if (uploadCandidates.length) {
      if (!storageIsConfigured()) { res.status(503).json({ error: 'O envio de imagens ainda não está disponível. Tenta mais tarde.' }); return; }
      const [current] = await db.select({ avatarUrl: users.avatarUrl, bannerUrl: users.bannerUrl }).from(users).where(eq(users.id, userId)).limit(1);
      if (!current) { res.status(404).json({ error: 'Não foi possível encontrar o teu perfil.' }); return; }
      protectedFinalKeys = new Set([current.avatarUrl, current.bannerUrl].flatMap((value) => {
        if (!value) return [];
        const reference = parseProfileMediaReference(value);
        return reference?.userId === userId ? [profileMediaObjectKey(reference.userId, reference.kind, reference.assetId)] : [];
      }));
      if (uploadCandidates.some((item) => protectedFinalKeys.has(item.finalKey))) {
        await cleanupCandidates(false);
        res.status(400).json({ error: 'Não foi possível validar a nova imagem. Escolhe-a novamente.' }); return;
      }
      try {
        for (const item of uploadCandidates) {
          const stored = await inspectStoredObject(item.temporaryKey);
          if (stored.sizeBytes === null || stored.sizeBytes <= 0 || stored.sizeBytes > PROFILE_MEDIA_MAX_BYTES || !signatureMatches('image/jpeg', stored.firstBytes)) {
            throw new Error('invalid profile image');
          }
          await copyStoredObject(item.temporaryKey, item.finalKey, 'image/jpeg');
        }
      } catch (error) {
        await cleanupCandidates(true, protectedFinalKeys);
        const statusCode = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        const invalidImage = error instanceof Error && error.message === 'invalid profile image';
        if (invalidImage || statusCode === 404) { res.status(400).json({ error: 'A imagem não pôde ser confirmada. Tenta escolher e guardar novamente.' }); return; }
        res.status(503).json({ error: 'O envio de imagens ainda não está disponível. Tenta mais tarde.' }); return;
      }
    }
    const changes: {
      username?: string;
      avatarUrl?: string | null;
      aboutMe?: string;
      showAvatar?: boolean;
      showAbout?: boolean;
      showStatus?: boolean;
      showJoinDate?: boolean;
      showCommonCommunities?: boolean;
      showEmail?: boolean;
      bannerUrl?: string | null;
      bannerColor?: string | null;
      statusText?: string;
      presencePreference?: 'online' | 'away' | 'dnd' | 'invisible';
      showBanner?: boolean;
    } = {};
    const profileFields = { ...input.data };
    delete profileFields.visibility;
    delete profileFields.avatarUploadId;
    delete profileFields.bannerUploadId;
    const visibility = input.data.visibility;
    Object.assign(changes, profileFields);
    for (const item of uploadCandidates) {
      if (item.kind === 'avatar') changes.avatarUrl = item.reference;
      else changes.bannerUrl = item.reference;
    }
    if (visibility) Object.assign(changes, {
      showAvatar: visibility.avatar,
      showAbout: visibility.about,
      showStatus: visibility.status,
      showJoinDate: visibility.joinDate,
      showCommonCommunities: visibility.commonCommunities,
      showEmail: visibility.email,
      showBanner: visibility.banner,
    });
    let previousImages: { avatarUrl: string | null; bannerUrl: string | null };
    let profileCommitSucceeded = false;
    try {
      const result = await db.transaction(async (tx) => {
        const [current] = await tx.select({ avatarUrl: users.avatarUrl, bannerUrl: users.bannerUrl }).from(users).where(eq(users.id, userId)).for('update');
        if (!current) return { error: 'missing' as const };
        const requestedAvatar = input.data.avatarUrl;
        const requestedBanner = input.data.bannerUrl;
        const avatarReference = typeof requestedAvatar === 'string' ? parseProfileMediaReference(requestedAvatar) : null;
        const bannerReference = typeof requestedBanner === 'string' ? parseProfileMediaReference(requestedBanner) : null;
        if (avatarReference && (avatarReference.userId !== userId || avatarReference.kind !== 'avatar' || (!input.data.avatarUploadId && requestedAvatar !== current.avatarUrl))) return { error: 'reference' as const };
        if (bannerReference && (bannerReference.userId !== userId || bannerReference.kind !== 'banner' || (!input.data.bannerUploadId && requestedBanner !== current.bannerUrl))) return { error: 'reference' as const };
        await tx.update(users).set(changes).where(eq(users.id, userId));
        return { previous: current };
      });
      if ('error' in result) {
        await cleanupCandidates(true, protectedFinalKeys);
        res.status(result.error === 'missing' ? 404 : 400).json({ error: result.error === 'missing' ? 'Não foi possível encontrar o teu perfil.' : 'A imagem selecionada não pertence a este perfil.' }); return;
      }
      previousImages = result.previous;
      profileCommitSucceeded = true;
      const profile = await loadOwnProfile(userId);
      if (!profile) { res.status(404).json({ error: 'Não foi possível encontrar o teu perfil.' }); return; }
      const replacedKeys = (['avatar', 'banner'] as const).flatMap((kind) => {
        const previous = kind === 'avatar' ? previousImages.avatarUrl : previousImages.bannerUrl;
        const next = kind === 'avatar' ? profile.user.avatarUrl : profile.user.bannerUrl;
        if (!previous || previous === next) return [];
        const reference = parseProfileMediaReference(previous);
        return reference?.userId === userId && reference.kind === kind ? [profileMediaObjectKey(userId, kind, reference.assetId)] : [];
      });
      await Promise.all([...uploadCandidates.map((item) => item.temporaryKey), ...replacedKeys].map(async (key) => { try { await deleteStoredObject(key); } catch { console.error('Could not clean a replaced profile image object.'); } }));
      void broadcastProfileUpdate(io, userId).catch(() => undefined);
      res.json(profile);
    } catch (error) {
      if (!profileCommitSucceeded) await cleanupCandidates(true, protectedFinalKeys);
      if ((error as { code?: string }).code === '23505') { res.status(409).json({ error: 'Esse nome de utilizador já está em uso.' }); return; }
      throw error;
    }
  }));
  router.get('/users/:userId/profile', asyncRoute(async (req, res) => {
    const userId = uuid.safeParse(req.params.userId);
    const communityId = uuid.safeParse(req.query.communityId);
    if (!userId.success || !communityId.success || userId.data === currentUser(res).id) { res.status(404).json({ error: 'Perfil não encontrado.' }); return; }
    const viewerId = currentUser(res).id;
    if (await activeBan(communityId.data, viewerId)) { res.status(404).json({ error: 'Perfil não encontrado.' }); return; }
    const [viewerMembership] = await db.select({ id: communityMembers.id })
      .from(communityMembers).where(and(eq(communityMembers.communityId, communityId.data), eq(communityMembers.userId, viewerId))).limit(1);
    const [targetMembership] = await db.select({ id: communityMembers.id, role: communityRoles.key })
      .from(communityMembers).innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
      .where(and(eq(communityMembers.communityId, communityId.data), eq(communityMembers.userId, userId.data))).limit(1);
    if (!viewerMembership || !targetMembership) { res.status(404).json({ error: 'Perfil não encontrado.' }); return; }
    const [target] = await db.select(profileColumns).from(users).where(eq(users.id, userId.data)).limit(1);
    if (!target) { res.status(404).json({ error: 'Perfil não encontrado.' }); return; }
    const commonCommunities = await commonCommunitiesFor(viewerId, userId.data);
    const canViewEmail = await hasPermission(viewerId, communityId.data, 'manage_community');
    const online = (await io.in(`user:${userId.data}`).fetchSockets()).length > 0;
    res.json({ profile: visibleMemberProfile(target as ProfileRecord, { online, commonCommunities, canViewEmail, role: targetMembership.role }) });
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
    const [community] = await db.select({ id: communities.id, name: communities.name, slug: communities.slug, description: communities.description, category: communities.category, imageUrl: communities.imageUrl, coverUrl: communities.coverUrl, coverColor: communities.coverColor, rules: communities.rules, welcomeMessage: communities.welcomeMessage, requireApproval: communities.requireApproval, isPrivate: communities.isPrivate, ownerId: communities.ownerId })
      .from(communities).where(eq(communities.id, req.params.communityId)).limit(1);
    if (!community || (community.isPrivate && !(await isMember(currentUser(res).id, community.id)))) { res.status(404).json({ error: 'Comunidade não encontrada.' }); return; }
    if (await activeBan(community.id, currentUser(res).id)) { res.status(403).json({ error: 'Não foi possível entrar nesta comunidade.' }); return; }
    const mine = await db.select({ role: communityRoles.key }).from(communityMembers).innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
      .where(and(eq(communityMembers.userId, currentUser(res).id), eq(communityMembers.communityId, community.id))).limit(1);
    const permissionRows = await db.select({ permission: rolePermissions.permission }).from(communityMembers)
      .innerJoin(rolePermissions, eq(communityMembers.roleId, rolePermissions.roleId))
      .where(and(eq(communityMembers.userId, currentUser(res).id), eq(communityMembers.communityId, community.id)));
    const canReviewJoinRequests = permissionRows.some((row) => row.permission === 'manage_members');
    const [pendingJoinCount] = canReviewJoinRequests ? await db.select({ value: count() }).from(joinRequests)
      .where(and(eq(joinRequests.communityId, community.id), eq(joinRequests.status, 'pending'))) : [];
    const memberRows = await db.select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl, showAvatar: users.showAvatar, role: communityRoles.key })
      .from(communityMembers).innerJoin(users, eq(communityMembers.userId, users.id)).innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
      .where(eq(communityMembers.communityId, community.id)).orderBy(users.username).limit(100);
    let channelRows: Array<{ id: string; name: string; topic: string; kind: string; categoryId: string | null; readOnly: boolean; position: number; unreadCount: number; hasMention: boolean; canWrite: boolean }> = [];
    let categoryRows: Array<{ id: string; communityId: string; name: string; position: number }> = [];
    if (mine.length) {
      const accessible = await db.select({ id: channels.id }).from(channels).where(eq(channels.communityId, community.id));
      if (accessible.length) await db.insert(channelReads).values(accessible.map((item) => ({ userId: currentUser(res).id, channelId: item.id }))).onConflictDoNothing();
      const unreadRows = await db.select({
        channelId: channels.id,
        messageId: messages.id,
        authorId: messages.authorId,
        userId: sql<string>`${currentUser(res).id}`,
        createdAt: messages.createdAt,
        lastReadAt: channelReads.lastReadAt,
        mentionUserId: messageMentions.userId,
      }).from(channels)
        .leftJoin(channelReads, and(eq(channelReads.channelId, channels.id), eq(channelReads.userId, currentUser(res).id)))
        .leftJoin(messages, and(eq(messages.channelId, channels.id), gt(messages.createdAt, channelReads.lastReadAt), ne(messages.authorId, currentUser(res).id)))
        .leftJoin(messageMentions, and(eq(messageMentions.messageId, messages.id), eq(messageMentions.userId, currentUser(res).id)))
        .where(eq(channels.communityId, community.id));
      const unreadById = summarizeUnreadRows(unreadRows);
      const canManageChannels = permissionRows.some((row) => row.permission === 'manage_channels');
      const canSendMessages = permissionRows.some((row) => row.permission === 'send_messages');
      channelRows = await db.select({ id: channels.id, name: channels.name, topic: channels.topic, kind: channels.kind, categoryId: channels.categoryId, readOnly: channels.readOnly, position: channels.position })
        .from(channels).where(eq(channels.communityId, community.id)).orderBy(channels.position, channels.createdAt)
        .then((rows) => rows.map((row) => ({ ...row, unreadCount: unreadById[row.id]?.unreadCount ?? 0, hasMention: unreadById[row.id]?.hasMention ?? false, canWrite: canSendMessages && canWriteToChannel(row.readOnly, canManageChannels) })));
      categoryRows = await db.select({ id: channelCategories.id, communityId: channelCategories.communityId, name: channelCategories.name, position: channelCategories.position })
        .from(channelCategories).where(eq(channelCategories.communityId, community.id)).orderBy(channelCategories.position, channelCategories.name);
    }
    const members = memberRows.map(({ role, ...member }) => ({ ...visibleMemberIdentity(member), role }));
    res.json({ community, myRole: mine[0]?.role ?? null, myPermissions: permissionRows.map((row) => row.permission), members, channels: channelRows, categories: categoryRows, pendingJoinRequests: pendingJoinCount?.value ?? 0 });
  }));

  router.patch('/communities/:communityId', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId;
    if (!await hasPermission(currentUser(res).id, communityId, 'manage_community')) { res.status(403).json({ error: 'Não tens permissão para gerir a comunidade.' }); return; }
    const input = z.object({ name: z.string().trim().min(2).max(80).optional(), description: z.string().trim().max(500).optional(), category: z.string().trim().min(1).max(40).optional(), imageUrl: z.string().url().max(500).startsWith('https://').nullable().optional(), coverUrl: coverUrlSchema, coverColor: coverColorSchema, rules: z.string().trim().max(4000).optional(), welcomeMessage: z.string().trim().max(1000).optional(), requireApproval: z.boolean().optional() }).safeParse(req.body);
    if (!input.success || Object.keys(input.data).length === 0) { res.status(400).json({ error: 'Dados da comunidade inválidos.' }); return; }
    const [updated] = await db.update(communities).set(input.data).where(eq(communities.id, communityId)).returning();
    if (!updated) { res.status(404).json({ error: 'Comunidade não encontrada.' }); return; }
    await audit(communityId, currentUser(res).id, 'community.updated', null, '', null, { fields: Object.keys(input.data) });
    await broadcastCommunityMembers(io, communityId, 'community:updated', { communityId });
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

  router.post('/communities/:communityId/channel-categories', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId;
    if (!await hasPermission(currentUser(res).id, communityId, 'manage_channels')) { res.status(403).json({ error: 'Não tens permissão para gerir canais.' }); return; }
    const input = z.object({ name: categoryNameSchema }).safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'O nome da categoria deve ter entre 1 e 40 caracteres.' }); return; }
    const [last] = await db.select({ position: sql<number>`coalesce(max(${channelCategories.position}), -1)` }).from(channelCategories).where(eq(channelCategories.communityId, communityId));
    const [category] = await db.insert(channelCategories).values({ communityId, name: input.data.name, position: Number(last.position) + 1 }).returning();
    await broadcastCommunityMembers(io, communityId, 'channels:updated', { communityId });
    res.status(201).json({ category });
  }));

  router.patch('/communities/:communityId/channel-categories/:categoryId', asyncRoute(async (req, res) => {
    const { communityId, categoryId } = req.params;
    if (!await hasPermission(currentUser(res).id, communityId, 'manage_channels')) { res.status(403).json({ error: 'Não tens permissão para gerir canais.' }); return; }
    const input = z.object({ name: categoryNameSchema.optional(), position: z.number().int().min(0).optional() }).strict().safeParse(req.body);
    if (!input.success || !Object.keys(input.data).length) { res.status(400).json({ error: 'Dados da categoria inválidos.' }); return; }
    const [updated] = await db.update(channelCategories).set(input.data).where(and(eq(channelCategories.id, categoryId), eq(channelCategories.communityId, communityId))).returning();
    if (!updated) { res.status(404).json({ error: 'Categoria não encontrada.' }); return; }
    await broadcastCommunityMembers(io, communityId, 'channels:updated', { communityId });
    res.json({ category: updated });
  }));

  router.delete('/communities/:communityId/channel-categories/:categoryId', asyncRoute(async (req, res) => {
    const { communityId, categoryId } = req.params;
    if (!await hasPermission(currentUser(res).id, communityId, 'manage_channels')) { res.status(403).json({ error: 'Não tens permissão para gerir canais.' }); return; }
    const [removed] = await db.delete(channelCategories).where(and(eq(channelCategories.id, categoryId), eq(channelCategories.communityId, communityId))).returning({ id: channelCategories.id });
    if (!removed) { res.status(404).json({ error: 'Categoria não encontrada.' }); return; }
    await broadcastCommunityMembers(io, communityId, 'channels:updated', { communityId });
    res.json({ ok: true });
  }));

  router.patch('/channels/:channelId/organization', asyncRoute(async (req, res) => {
    const [channel] = await db.select({ id: channels.id, communityId: channels.communityId }).from(channels).where(eq(channels.id, req.params.channelId)).limit(1);
    if (!channel) { res.status(404).json({ error: 'Canal não encontrado.' }); return; }
    if (!await hasPermission(currentUser(res).id, channel.communityId, 'manage_channels')) { res.status(403).json({ error: 'Não tens permissão para gerir canais.' }); return; }
    const input = z.object({ categoryId: uuid.nullable(), position: z.number().int().min(0) }).strict().safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Categoria ou posição inválida.' }); return; }
    if (input.data.categoryId) {
      const [category] = await db.select({ id: channelCategories.id }).from(channelCategories).where(and(eq(channelCategories.id, input.data.categoryId), eq(channelCategories.communityId, channel.communityId))).limit(1);
      if (!category) { res.status(400).json({ error: 'A categoria não pertence a esta comunidade.' }); return; }
    }
    await db.update(channels).set({ categoryId: input.data.categoryId, position: input.data.position }).where(eq(channels.id, channel.id));
    await broadcastCommunityMembers(io, channel.communityId, 'channels:updated', { communityId: channel.communityId });
    res.json({ ok: true });
  }));

  router.patch('/channels/:channelId/read-only', asyncRoute(async (req, res) => {
    const [channel] = await db.select({ id: channels.id, communityId: channels.communityId }).from(channels).where(eq(channels.id, req.params.channelId)).limit(1);
    if (!channel) { res.status(404).json({ error: 'Canal não encontrado.' }); return; }
    if (!await hasPermission(currentUser(res).id, channel.communityId, 'manage_channels')) { res.status(403).json({ error: 'Não tens permissão para gerir canais.' }); return; }
    const input = z.object({ readOnly: z.boolean() }).strict().safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Escolhe se só os moderadores podem escrever.' }); return; }
    await db.update(channels).set({ readOnly: input.data.readOnly }).where(eq(channels.id, channel.id));
    await broadcastCommunityMembers(io, channel.communityId, 'channels:updated', { communityId: channel.communityId });
    res.json({ ok: true });
  }));

  router.delete('/channels/:channelId', asyncRoute(async (req, res) => {
    const [channel] = await db.select({ id: channels.id, communityId: channels.communityId, kind: channels.kind })
      .from(channels).where(eq(channels.id, req.params.channelId)).limit(1);
    if (!channel) { res.status(404).json({ error: 'Canal não encontrado.' }); return; }
    if (!await hasPermission(currentUser(res).id, channel.communityId, 'manage_channels')) { res.status(403).json({ error: 'Não tens permissão para gerir canais.' }); return; }
    const outcome = await deleteChannelWithAttachments(channel.id);
    if (outcome === 'not-found') { res.status(404).json({ error: 'Canal não encontrado.' }); return; }
    if (outcome === 'last-text-channel') { res.status(409).json({ error: 'A comunidade precisa de pelo menos um canal de texto.' }); return; }
    if (outcome === 'storage-failed') { res.status(503).json({ error: 'Não foi possível apagar os anexos agora. Tenta novamente mais tarde.' }); return; }
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
    const rows = await db.select({ id: messages.id, clientMessageId: messages.clientMessageId, body: messages.body, replyToId: messages.replyToId, replyAuthor: replyAuthors.username, replyBody: replyMessages.body, createdAt: messages.createdAt, pinnedAt: messages.pinnedAt, pinnedBy: messages.pinnedBy, authorId: users.id, username: users.username, avatarUrl: users.avatarUrl, showAvatar: users.showAvatar })
      .from(messages).innerJoin(users, eq(messages.authorId, users.id)).leftJoin(replyMessages, eq(messages.replyToId, replyMessages.id)).leftJoin(replyAuthors, eq(replyMessages.authorId, replyAuthors.id)).where(and(...filters)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(pageSize + 1);
    const hasMore = rows.length > pageSize;
    res.setHeader('Cache-Control', 'private, no-store');
    const selected = rows.slice(0, pageSize);
    const oldest = selected[selected.length - 1];
    const ordered = selected.reverse();
    const reactions = await reactionSummariesFor(ordered.map((message) => message.id), currentUser(res).id);
    const attachments = await attachmentsForMessages(ordered.map((message) => message.id));
    res.json({ messages: ordered.map((message) => ({ ...withoutHiddenAvatar(message), reactions: reactions[message.id] ?? [], attachments: attachments[message.id] ?? [] })), hasMore, nextCursor: oldest ? `${oldest.createdAt.toISOString()}~${oldest.id}` : null });
  }));

  router.post('/channels/:channelId/read', asyncRoute(async (req, res) => {
    const userId = currentUser(res).id;
    const [channel] = await db.select({ id: channels.id, communityId: channels.communityId }).from(channels).where(eq(channels.id, req.params.channelId)).limit(1);
    if (!channel || !await isMember(userId, channel.communityId) || await activeBan(channel.communityId, userId)) { res.status(404).json({ error: 'Canal não encontrado.' }); return; }
    const lastReadAt = new Date();
    await db.insert(channelReads).values({ userId, channelId: channel.id, lastReadAt }).onConflictDoUpdate({ target: [channelReads.userId, channelReads.channelId], set: { lastReadAt } });
    res.json({ lastReadAt: lastReadAt.toISOString() });
  }));

  router.get('/channels/:channelId/pinned', asyncRoute(async (req, res) => {
    const [channel] = await db.select({ id: channels.id, communityId: channels.communityId }).from(channels).where(eq(channels.id, req.params.channelId)).limit(1);
    const userId = currentUser(res).id;
    if (!channel || !await isMember(userId, channel.communityId) || await activeBan(channel.communityId, userId)) { res.status(404).json({ error: 'Canal não encontrado.' }); return; }
    const rows = await db.select({ id: messages.id, clientMessageId: messages.clientMessageId, body: messages.body, replyToId: messages.replyToId, replyAuthor: replyAuthors.username, replyBody: replyMessages.body, createdAt: messages.createdAt, pinnedAt: messages.pinnedAt, pinnedBy: messages.pinnedBy, authorId: users.id, username: users.username, avatarUrl: users.avatarUrl, showAvatar: users.showAvatar })
      .from(messages).innerJoin(users, eq(messages.authorId, users.id)).innerJoin(channels, eq(messages.channelId, channels.id))
      .leftJoin(replyMessages, eq(messages.replyToId, replyMessages.id)).leftJoin(replyAuthors, eq(replyMessages.authorId, replyAuthors.id))
      .where(and(eq(messages.channelId, channel.id), isNotNull(messages.pinnedAt))).orderBy(desc(messages.pinnedAt), desc(messages.id));
    const reactions = await reactionSummariesFor(rows.map((message) => message.id), userId);
    const attachments = await attachmentsForMessages(rows.map((message) => message.id));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ messages: rows.map((message) => ({ ...withoutHiddenAvatar(message), reactions: reactions[message.id] ?? [], attachments: attachments[message.id] ?? [] })) });
  }));

  router.post('/channels/:channelId/messages', asyncRoute(async (req, res) => {
    const [channel] = await db.select({ id: channels.id, communityId: channels.communityId, kind: channels.kind, readOnly: channels.readOnly }).from(channels).where(eq(channels.id, req.params.channelId)).limit(1);
    if (!channel || channel.kind !== 'text') { res.status(404).json({ error: 'Canal não encontrado ou acesso não autorizado.' }); return; }
    if (!canWriteToChannel(channel.readOnly, await hasPermission(currentUser(res).id, channel.communityId, 'manage_channels'))) { res.status(403).json({ error: 'Neste canal só moderadores podem escrever.' }); return; }
    if (!await hasPermission(currentUser(res).id, channel.communityId, 'send_messages')) { res.status(404).json({ error: 'Canal não encontrado ou acesso não autorizado.' }); return; }
    if (await activeBan(channel.communityId, currentUser(res).id)) { res.status(403).json({ error: 'O teu acesso a esta comunidade está banido.' }); return; }
    const mute = await activeMute(channel.communityId, currentUser(res).id);
    if (mute) { res.status(403).json({ error: `Foste silenciado até às ${new Intl.DateTimeFormat('pt-MZ', { hour: '2-digit', minute: '2-digit' }).format(mute.expiresAt)}.` }); return; }
    const input = z.object({
      clientMessageId: uuid,
      body: z.string().trim().max(2000).default(''),
      replyToId: uuid.nullable().optional(),
      attachmentIds: z.array(uuid).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]).refine((ids) => new Set(ids).size === ids.length),
    }).safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Mensagem inválida. Podes enviar até 5 anexos e 2000 caracteres.' }); return; }
    if (!input.data.body && input.data.attachmentIds.length === 0) { res.status(400).json({ error: 'Escreve uma mensagem ou escolhe pelo menos um anexo.' }); return; }
    if (input.data.replyToId) {
      const [parent] = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.id, input.data.replyToId), eq(messages.channelId, channel.id))).limit(1);
      if (!parent) { res.status(400).json({ error: 'A resposta deve referir uma mensagem deste canal.' }); return; }
    }
    const author = currentUser(res);
    const outcome = await db.transaction(async (tx) => {
      const [lockedChannel] = await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, channel.id)).for('share');
      if (!lockedChannel) return { type: 'channel-missing' as const };
      const findExisting = () => tx.select({ id: messages.id }).from(messages)
        .where(and(eq(messages.channelId, channel.id), eq(messages.authorId, author.id), eq(messages.clientMessageId, input.data.clientMessageId))).limit(1);
      const [existing] = await findExisting();
      if (existing) return { type: 'existing' as const, id: existing.id };

      if (input.data.attachmentIds.length) {
        const ready = await tx.select({ id: messageAttachments.id }).from(messageAttachments)
          .where(and(inArray(messageAttachments.id, input.data.attachmentIds), eq(messageAttachments.userId, author.id), eq(messageAttachments.communityId, channel.communityId), eq(messageAttachments.channelId, channel.id), eq(messageAttachments.status, 'ready'), isNull(messageAttachments.messageId)))
          .for('update');
        if (ready.length !== input.data.attachmentIds.length) {
          const [duplicate] = await findExisting();
          if (duplicate) return { type: 'existing' as const, id: duplicate.id };
          return { type: 'attachments-unavailable' as const };
        }
      }

      const [created] = await tx.insert(messages).values({
        channelId: channel.id,
        authorId: author.id,
        clientMessageId: input.data.clientMessageId,
        body: input.data.body,
        replyToId: input.data.replyToId ?? null,
      }).onConflictDoNothing().returning({ id: messages.id });
      if (!created) {
        const [duplicate] = await findExisting();
        return duplicate ? { type: 'existing' as const, id: duplicate.id } : { type: 'attachments-unavailable' as const };
      }
      if (input.data.attachmentIds.length) {
        const linked = await tx.update(messageAttachments).set({ messageId: created.id })
          .where(and(inArray(messageAttachments.id, input.data.attachmentIds), eq(messageAttachments.userId, author.id), eq(messageAttachments.channelId, channel.id), eq(messageAttachments.status, 'ready'), isNull(messageAttachments.messageId)))
          .returning({ id: messageAttachments.id });
        if (linked.length !== input.data.attachmentIds.length) throw new Error('Attachment link changed during message transaction');
      }
      return { type: 'created' as const, id: created.id };
    });
    if (outcome.type === 'channel-missing') { res.status(404).json({ error: 'Canal não encontrado.' }); return; }
    if (outcome.type === 'attachments-unavailable') { res.status(400).json({ error: 'Um ou mais anexos já não estão disponíveis. Escolhe-os novamente.' }); return; }
    const created = outcome.type === 'created';
    const [row] = await db.select({ id: messages.id, clientMessageId: messages.clientMessageId, body: messages.body, replyToId: messages.replyToId, replyAuthor: replyAuthors.username, replyBody: replyMessages.body, createdAt: messages.createdAt, pinnedAt: messages.pinnedAt, pinnedBy: messages.pinnedBy, authorId: users.id, username: users.username, avatarUrl: users.avatarUrl, showAvatar: users.showAvatar })
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
    }
    if (row) {
      const attachments = await attachmentsForMessages([row.id]);
      const message = { ...withoutHiddenAvatar(row), attachments: attachments[row.id] ?? [] };
      if (created) io.to(`channel:${channel.id}`).emit('message:new', message);
      res.status(created ? 201 : 200).json({ message });
      return;
    }
    res.status(500).json({ error: 'Não foi possível guardar a mensagem.' });
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
        .where(and(eq(communityBans.communityId, message.communityId), eq(communityBans.userId, userId), isNull(communityBans.revokedAt), or(isNull(communityBans.expiresAt), gt(communityBans.expiresAt, new Date())))).limit(1);
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
    await removeMessageAttachments(message.id);
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
    const input = z.object({ duration: z.object({ amount: z.number().int().positive(), unit: z.enum(['minutes', 'hours', 'days']) }).optional(), durationMinutes: z.number().int().positive().optional(), reason: z.string().trim().max(500).default('') })
      .refine((value) => Boolean(value.duration) !== (value.durationMinutes !== undefined)).safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Duração ou motivo inválido.' }); return; }
    const seconds = input.data.duration ? durationSeconds(input.data.duration.amount, input.data.duration.unit) : (input.data.durationMinutes ?? 0) * 60;
    if (!durationInRange(seconds, 60, 28 * 24 * 60 * 60)) { res.status(400).json({ error: 'O silêncio deve durar entre 1 minuto e 28 dias.' }); return; }
    const expiresAt = new Date(Date.now() + seconds * 1000);
    await db.update(communityMutes).set({ revokedAt: new Date() }).where(and(eq(communityMutes.communityId, communityId), eq(communityMutes.userId, req.params.userId), isNull(communityMutes.revokedAt)));
    await db.insert(communityMutes).values({ communityId, userId: req.params.userId, actorId, expiresAt, reason: input.data.reason });
    await audit(communityId, actorId, 'member.muted', req.params.userId, input.data.reason, seconds);
    io.in(`user:${req.params.userId}`).emit('community:muted', { communityId, expiresAt });
    await broadcastCommunityMembers(io, communityId, 'community:member_muted', { communityId, userId: req.params.userId, expiresAt });
    res.json({ expiresAt });
  }));

  router.delete('/communities/:communityId/members/:userId/mute', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId; const actorId = currentUser(res).id;
    if (!await hasPermission(actorId, communityId, 'mute_members') || !await canActOnTarget(actorId, communityId, req.params.userId)) { res.status(403).json({ error: 'Não tens permissão para remover este silêncio.' }); return; }
    await db.update(communityMutes).set({ revokedAt: new Date() }).where(and(eq(communityMutes.communityId, communityId), eq(communityMutes.userId, req.params.userId), isNull(communityMutes.revokedAt)));
    await audit(communityId, actorId, 'member.unmuted', req.params.userId);
    io.in(`user:${req.params.userId}`).emit('community:unmuted', { communityId });
    await broadcastCommunityMembers(io, communityId, 'community:member_unmuted', { communityId, userId: req.params.userId });
    res.json({ ok: true });
  }));

  router.post('/communities/:communityId/members/:userId/ban', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId; const actorId = currentUser(res).id;
    if (!await hasPermission(actorId, communityId, 'ban_members') || !await canActOnTarget(actorId, communityId, req.params.userId)) { res.status(403).json({ error: 'Não tens permissão para banir este membro.' }); return; }
    const input = z.object({ duration: z.object({ amount: z.number().int().positive(), unit: z.enum(['minutes', 'hours', 'days']) }).nullable().optional(), reason: z.string().trim().max(500).default('') }).safeParse(req.body ?? {});
    if (!input.success) { res.status(400).json({ error: 'Duração ou motivo inválido.' }); return; }
    const seconds = input.data.duration ? durationSeconds(input.data.duration.amount, input.data.duration.unit) : null;
    if (seconds !== null && !durationInRange(seconds, 60 * 60, 365 * 24 * 60 * 60)) { res.status(400).json({ error: 'O banimento temporário deve durar entre 1 hora e 365 dias.' }); return; }
    const expiresAt = seconds === null ? null : new Date(Date.now() + seconds * 1000);
    await db.update(communityBans).set({ revokedAt: new Date() }).where(and(eq(communityBans.communityId, communityId), eq(communityBans.userId, req.params.userId), isNull(communityBans.revokedAt)));
    await db.insert(communityBans).values({ communityId, userId: req.params.userId, actorId, reason: input.data.reason, expiresAt });
    await db.delete(communityMembers).where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, req.params.userId)));
    await audit(communityId, actorId, 'member.banned', req.params.userId, input.data.reason, seconds);
    io.in(`user:${req.params.userId}`).emit('community:banned', { communityId, expiresAt });
    await removeCommunitySocketAccess(io, req.params.userId, communityId);
    await broadcastCommunityMembers(io, communityId, 'community:member_left', { communityId, userId: req.params.userId });
    res.json({ ok: true });
  }));

  router.get('/communities/:communityId/bans', asyncRoute(async (req, res) => {
    const communityId = req.params.communityId;
    if (!await hasPermission(currentUser(res).id, communityId, 'ban_members') && !await hasPermission(currentUser(res).id, communityId, 'view_audit_log')) { res.status(403).json({ error: 'Não tens permissão para consultar banimentos.' }); return; }
    const now = new Date();
    const rows = await db.select({ userId: communityBans.userId, username: users.username, reason: communityBans.reason, createdAt: communityBans.createdAt, expiresAt: communityBans.expiresAt, bannedBy: banActors.username })
      .from(communityBans).innerJoin(users, eq(communityBans.userId, users.id)).innerJoin(banActors, eq(communityBans.actorId, banActors.id))
      .where(and(eq(communityBans.communityId, communityId), isNull(communityBans.revokedAt), or(isNull(communityBans.expiresAt), gt(communityBans.expiresAt, now))))
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
    const [callee] = await db.select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl, showAvatar: users.showAvatar }).from(users).where(eq(users.id, input.data.calleeId)).limit(1);
    if (!callee) { res.status(404).json({ error: 'Utilizador não encontrado.' }); return; }
    const [callerRecord] = await db.select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl, showAvatar: users.showAvatar }).from(users).where(eq(users.id, caller.id)).limit(1);
    const callerProfile = callerRecord ? visibleMemberIdentity(callerRecord) : { id: caller.id, username: caller.username };
    const calleeProfile = visibleMemberIdentity(callee);
    const [busy] = await db.select({ id: privateCalls.id }).from(privateCalls).where(and(or(eq(privateCalls.callerId, caller.id), eq(privateCalls.calleeId, caller.id)), or(eq(privateCalls.callerId, input.data.calleeId), eq(privateCalls.calleeId, input.data.calleeId)), or(eq(privateCalls.status, 'initiated'), eq(privateCalls.status, 'ringing'), eq(privateCalls.status, 'accepted'), eq(privateCalls.status, 'connecting'), eq(privateCalls.status, 'in_progress')))).limit(1);
    if (busy) { res.status(409).json({ error: 'Já existe uma chamada ativa entre estes utilizadores.' }); return; }
    const [call] = await db.insert(privateCalls).values({ callerId: caller.id, calleeId: callee.id, status: 'ringing', livekitRoom: `mavuno-call-${crypto.randomUUID()}` }).returning();
    io.in(`user:${callee.id}`).emit('call:incoming', { callId: call.id, caller: callerProfile, status: 'ringing' });
    io.in(`user:${caller.id}`).emit('call:status', { callId: call.id, status: 'ringing', peer: calleeProfile });
    res.status(201).json({ call: { id: call.id, status: call.status, peer: calleeProfile } });
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
