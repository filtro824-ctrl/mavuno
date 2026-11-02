import { Router, type Request, type Response, type RequestHandler } from 'express';
import { and, count, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Server as SocketServer } from 'socket.io';
import { db } from './db/index.js';
import { communityBans, communityMembers, communityRoles, communities, invitations, joinRequests, rolePermissions, users } from './db/schema.js';
import { createOpaqueToken, digestToken } from './security.js';
import { hasPermission, isMember } from './permissions.js';
import { visibleMemberIdentity } from './profile-utils.js';
import { communityRulesAccepted, hasPendingJoinRequest, invitationIsValid, isWithinJoinRequestCooldown } from './join-flow-utils.js';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type JoinStatus = 'joined' | 'already_member' | 'pending';
type JoinResult = { status: JoinStatus; communityId: string; requestId?: string; createdRequest?: boolean; joinedNow?: boolean; joinedUserId?: string } | { error: 'invalid' | 'banned' | 'rules' | 'cooldown' | 'request_limit' | 'private' | 'pending' | 'missing' };

const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { void handler(req, res).catch(next); };
const uuid = z.string().uuid();
const validToken = /^[\w-]{32,64}$/;
const INVALID_INVITE = 'Este convite já não é válido.';
const GENERIC_JOIN_FAILURE = 'Não foi possível entrar nesta comunidade.';
const durationMs = { '30m': 30 * 60_000, '1h': 60 * 60_000, '1d': 24 * 60 * 60_000, '7d': 7 * 24 * 60 * 60_000, never: null } as const;
const inviteOptions = z.object({
  duration: z.enum(['30m', '1h', '1d', '7d', 'never']).default('7d'),
  maxUses: z.union([z.literal(1), z.literal(5), z.literal(25), z.null()]).default(null),
}).strict();
const joinInput = z.object({ acceptedRules: z.boolean().default(false) }).strict();

function userIdFrom(res: Response): string { return (res.locals.user as { id: string }).id; }
function inviteInvalid(res: Response): void { res.status(404).json({ error: INVALID_INVITE }); }
function respondJoinError(res: Response, result: Extract<JoinResult, { error: string }>): void {
  if (result.error === 'invalid') { inviteInvalid(res); return; }
  if (result.error === 'banned') { res.status(403).json({ error: GENERIC_JOIN_FAILURE }); return; }
  if (result.error === 'rules') { res.status(400).json({ error: 'Tens de aceitar as regras para continuar.' }); return; }
  if (result.error === 'cooldown') { res.status(429).json({ error: 'O teu pedido foi recusado recentemente. Podes voltar a pedir depois de 24 horas.' }); return; }
  if (result.error === 'request_limit') { res.status(429).json({ error: 'Já tens 20 pedidos pendentes. Aguarda uma resposta antes de pedir outra entrada.' }); return; }
  if (result.error === 'pending') { res.status(409).json({ error: 'Este pedido já não está pendente.' }); return; }
  if (result.error === 'private' || result.error === 'missing') { res.status(404).json({ error: 'Não foi possível encontrar esta comunidade.' }); return; }
  res.status(400).json({ error: GENERIC_JOIN_FAILURE });
}

async function activeBanIn(tx: Transaction, communityId: string, userId: string): Promise<boolean> {
  const [ban] = await tx.select({ id: communityBans.id }).from(communityBans)
    .where(and(eq(communityBans.communityId, communityId), eq(communityBans.userId, userId), isNull(communityBans.revokedAt), or(isNull(communityBans.expiresAt), gt(communityBans.expiresAt, new Date())))).limit(1);
  return Boolean(ban);
}

async function lockUser(tx: Transaction, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
}

async function createPendingRequest(tx: Transaction, args: { communityId: string; userId: string; invitationId: string | null }): Promise<JoinResult> {
  const { communityId, userId, invitationId } = args;
  const pendingRows = await tx.select({ id: joinRequests.id, status: joinRequests.status }).from(joinRequests)
    .where(and(eq(joinRequests.communityId, communityId), eq(joinRequests.userId, userId), eq(joinRequests.status, 'pending'))).limit(1);
  if (hasPendingJoinRequest(pendingRows)) return { status: 'pending', communityId, requestId: pendingRows[0]?.id };

  const [recentRejection] = await tx.select({ decidedAt: joinRequests.decidedAt }).from(joinRequests)
    .where(and(eq(joinRequests.communityId, communityId), eq(joinRequests.userId, userId), eq(joinRequests.status, 'rejected'), gt(joinRequests.decidedAt, new Date(Date.now() - 24 * 60 * 60_000))))
    .orderBy(desc(joinRequests.decidedAt)).limit(1);
  if (isWithinJoinRequestCooldown(recentRejection?.decidedAt ?? null)) return { error: 'cooldown' };

  const [pendingTotal] = await tx.select({ value: count() }).from(joinRequests)
    .where(and(eq(joinRequests.userId, userId), eq(joinRequests.status, 'pending')));
  if ((pendingTotal?.value ?? 0) >= 20) return { error: 'request_limit' };

  const [created] = await tx.insert(joinRequests).values({ communityId, userId, invitationId, status: 'pending' }).returning({ id: joinRequests.id });
  return { status: 'pending', communityId, requestId: created.id, createdRequest: true };
}

async function moderatorIds(communityId: string): Promise<string[]> {
  const rows = await db.selectDistinct({ userId: communityMembers.userId }).from(communityMembers)
    .innerJoin(communityRoles, eq(communityMembers.roleId, communityRoles.id))
    .innerJoin(rolePermissions, eq(communityRoles.id, rolePermissions.roleId))
    .where(and(eq(communityMembers.communityId, communityId), eq(rolePermissions.permission, 'manage_members')));
  return rows.map((item) => item.userId);
}

async function notifyModerators(io: SocketServer, communityId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  const recipients = await moderatorIds(communityId);
  for (const recipient of recipients) io.in(`user:${recipient}`).emit(event, payload);
}

async function notifyMemberJoined(io: SocketServer, communityId: string, userId: string): Promise<void> {
  const [person] = await db.select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl, showAvatar: users.showAvatar })
    .from(users).where(eq(users.id, userId)).limit(1);
  if (!person) return;
  const member = { ...visibleMemberIdentity(person), role: 'member' };
  const recipients = await db.select({ userId: communityMembers.userId }).from(communityMembers).where(eq(communityMembers.communityId, communityId));
  for (const recipient of recipients) io.in(`user:${recipient.userId}`).emit('community:member_joined', { communityId, member });
}

async function notifyRequestChanged(io: SocketServer, communityId: string, payload: Record<string, unknown>): Promise<void> {
  await notifyModerators(io, communityId, 'community:join-request-changed', payload);
}

async function communityJoinCard(communityId: string) {
  const [community] = await db.select({
    id: communities.id,
    name: communities.name,
    description: communities.description,
    imageUrl: communities.imageUrl,
    rules: communities.rules,
    welcomeMessage: communities.welcomeMessage,
    requireApproval: communities.requireApproval,
    isPrivate: communities.isPrivate,
  }).from(communities).where(eq(communities.id, communityId)).limit(1);
  if (!community) return null;
  const [memberCount] = await db.select({ value: count() }).from(communityMembers).where(eq(communityMembers.communityId, communityId));
  return { ...community, memberCount: memberCount?.value ?? 0 };
}

async function requestState(communityId: string, userId: string): Promise<{ alreadyMember: boolean; requestPending: boolean; requestId: string | null }> {
  const alreadyMember = await isMember(userId, communityId);
  if (alreadyMember) return { alreadyMember: true, requestPending: false, requestId: null };
  const [pending] = await db.select({ id: joinRequests.id }).from(joinRequests)
    .where(and(eq(joinRequests.communityId, communityId), eq(joinRequests.userId, userId), eq(joinRequests.status, 'pending'))).limit(1);
  return { alreadyMember: false, requestPending: Boolean(pending), requestId: pending?.id ?? null };
}

export function createPublicInvitePreviewRouter(): Router {
  const router = Router();
  router.get('/invites/:token/preview', asyncRoute(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'private, no-store');
    if (!validToken.test(req.params.token)) { inviteInvalid(res); return; }
    const [invite] = await db.select().from(invitations).where(eq(invitations.tokenHash, digestToken(req.params.token))).limit(1);
    if (!invite || !invitationIsValid(invite)) { inviteInvalid(res); return; }
    const [community] = await db.select({ name: communities.name, imageUrl: communities.imageUrl, description: communities.description })
      .from(communities).where(eq(communities.id, invite.communityId)).limit(1);
    if (!community) { inviteInvalid(res); return; }
    const [members] = await db.select({ value: count() }).from(communityMembers).where(eq(communityMembers.communityId, invite.communityId));
    res.json({ ...community, memberCount: members?.value ?? 0, valid: true });
  }));
  return router;
}

export function createJoinFlowRouter(io: SocketServer): Router {
  const router = Router();

  router.post('/communities/:communityId/invites', asyncRoute(async (req, res) => {
    const communityId = uuid.safeParse(req.params.communityId);
    if (!communityId.success) { res.status(400).json({ error: 'Comunidade inválida.' }); return; }
    const userId = userIdFrom(res);
    if (!await hasPermission(userId, communityId.data, 'create_invites')) { res.status(403).json({ error: 'Não tens permissão para criar convites.' }); return; }
    const input = inviteOptions.safeParse(req.body ?? {});
    if (!input.success) { res.status(400).json({ error: 'Escolhe uma duração e um limite de utilizações válidos.' }); return; }
    const [community] = await db.select({ id: communities.id }).from(communities).where(eq(communities.id, communityId.data)).limit(1);
    if (!community) { res.status(404).json({ error: 'Comunidade não encontrada.' }); return; }
    const token = createOpaqueToken();
    const ttl = durationMs[input.data.duration];
    const expiresAt = ttl === null ? null : new Date(Date.now() + ttl);
    await db.insert(invitations).values({ communityId: communityId.data, createdBy: userId, tokenHash: digestToken(token), expiresAt, maxUses: input.data.maxUses });
    res.status(201).json({ inviteUrl: `/invite/${token}`, expiresAt, maxUses: input.data.maxUses });
  }));

  router.get('/communities/:communityId/invites', asyncRoute(async (req, res) => {
    const communityId = uuid.safeParse(req.params.communityId);
    if (!communityId.success) { res.status(400).json({ error: 'Comunidade inválida.' }); return; }
    if (!await hasPermission(userIdFrom(res), communityId.data, 'create_invites')) { res.status(403).json({ error: 'Não tens permissão para ver os convites.' }); return; }
    const now = new Date();
    const rows = await db.select({ id: invitations.id, createdAt: invitations.createdAt, expiresAt: invitations.expiresAt, maxUses: invitations.maxUses, useCount: invitations.useCount, createdBy: users.username })
      .from(invitations).innerJoin(users, eq(invitations.createdBy, users.id))
      .where(and(eq(invitations.communityId, communityId.data), isNull(invitations.revokedAt), or(isNull(invitations.expiresAt), gt(invitations.expiresAt, now)), or(isNull(invitations.maxUses), sql`${invitations.useCount} < ${invitations.maxUses}`)))
      .orderBy(desc(invitations.createdAt)).limit(100);
    res.json({ invites: rows });
  }));

  router.delete('/communities/:communityId/invites/:inviteId', asyncRoute(async (req, res) => {
    const communityId = uuid.safeParse(req.params.communityId);
    const inviteId = uuid.safeParse(req.params.inviteId);
    if (!communityId.success || !inviteId.success) { res.status(400).json({ error: 'Convite inválido.' }); return; }
    if (!await hasPermission(userIdFrom(res), communityId.data, 'create_invites')) { res.status(403).json({ error: 'Não tens permissão para gerir convites.' }); return; }
    const [revoked] = await db.update(invitations).set({ revokedAt: new Date() })
      .where(and(eq(invitations.id, inviteId.data), eq(invitations.communityId, communityId.data), isNull(invitations.revokedAt))).returning({ id: invitations.id });
    if (!revoked) { res.status(404).json({ error: 'Este convite já não está disponível.' }); return; }
    res.json({ ok: true });
  }));

  router.get('/invites/:token/join-info', asyncRoute(async (req, res) => {
    if (!validToken.test(req.params.token)) { inviteInvalid(res); return; }
    const [invite] = await db.select().from(invitations).where(eq(invitations.tokenHash, digestToken(req.params.token))).limit(1);
    if (!invite) { inviteInvalid(res); return; }
    const userId = userIdFrom(res);
    const [community] = await db.select({ id: communities.id }).from(communities).where(eq(communities.id, invite.communityId)).limit(1);
    if (!community) { inviteInvalid(res); return; }
    if (await isBanned(userId, invite.communityId)) { res.status(403).json({ error: GENERIC_JOIN_FAILURE }); return; }
    const state = await requestState(invite.communityId, userId);
    if (!state.alreadyMember && !state.requestPending && !invitationIsValid(invite)) { inviteInvalid(res); return; }
    const card = await communityJoinCard(invite.communityId);
    if (!card) { inviteInvalid(res); return; }
    res.json({ ...card, alreadyMember: state.alreadyMember, requestPending: state.requestPending, requestId: state.requestId, invitationValid: invitationIsValid(invite) });
  }));

  router.get('/communities/:communityId/join-info', asyncRoute(async (req, res) => {
    const communityId = uuid.safeParse(req.params.communityId);
    if (!communityId.success) { res.status(404).json({ error: 'Não foi possível encontrar esta comunidade.' }); return; }
    const userId = userIdFrom(res);
    if (await isBanned(userId, communityId.data)) { res.status(403).json({ error: GENERIC_JOIN_FAILURE }); return; }
    const card = await communityJoinCard(communityId.data);
    if (!card || (card.isPrivate && !await isMember(userId, communityId.data))) { res.status(404).json({ error: 'Não foi possível encontrar esta comunidade.' }); return; }
    const state = await requestState(communityId.data, userId);
    res.json({ ...card, alreadyMember: state.alreadyMember, requestPending: state.requestPending, requestId: state.requestId });
  }));

  router.post('/invites/:token/join', asyncRoute(async (req, res) => {
    if (!validToken.test(req.params.token)) { inviteInvalid(res); return; }
    const input = joinInput.safeParse(req.body ?? {});
    if (!input.success) { res.status(400).json({ error: 'Confirma os dados e tenta novamente.' }); return; }
    const userId = userIdFrom(res);
    const tokenHash = digestToken(req.params.token);
    const result = await db.transaction(async (tx): Promise<JoinResult> => {
      await lockUser(tx, userId);
      const [invite] = await tx.select().from(invitations).where(eq(invitations.tokenHash, tokenHash)).for('update').limit(1);
      if (!invite) return { error: 'invalid' };
      const [community] = await tx.select().from(communities).where(eq(communities.id, invite.communityId)).limit(1);
      if (!community) return { error: 'invalid' };
      if (await activeBanIn(tx, invite.communityId, userId)) return { error: 'banned' };
      const [member] = await tx.select({ id: communityMembers.id }).from(communityMembers)
        .where(and(eq(communityMembers.userId, userId), eq(communityMembers.communityId, invite.communityId))).limit(1);
      if (member) return { status: 'already_member', communityId: invite.communityId };
      if (!invitationIsValid(invite)) return { error: 'invalid' };
      if (!communityRulesAccepted(community.rules, input.data.acceptedRules)) return { error: 'rules' };
      if (community.requireApproval) return createPendingRequest(tx, { communityId: invite.communityId, userId, invitationId: invite.id });
      const [role] = await tx.select({ id: communityRoles.id }).from(communityRoles)
        .where(and(eq(communityRoles.communityId, invite.communityId), eq(communityRoles.key, 'member'))).limit(1);
      if (!role) return { error: 'missing' };
      const now = new Date();
      const [joined] = await tx.insert(communityMembers).values({ communityId: invite.communityId, userId, roleId: role.id, rulesAcceptedAt: community.rules.trim() ? now : null }).onConflictDoNothing().returning({ id: communityMembers.id });
      if (!joined) return { status: 'already_member', communityId: invite.communityId };
      await tx.update(invitations).set({ useCount: sql`${invitations.useCount} + 1` }).where(eq(invitations.id, invite.id));
      return { status: 'joined', communityId: invite.communityId, joinedNow: true };
    });
    if ('error' in result) { respondJoinError(res, result); return; }
    if (result.createdRequest) {
      const [person] = await db.select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl, showAvatar: users.showAvatar }).from(users).where(eq(users.id, userId)).limit(1);
      await notifyRequestChanged(io, result.communityId, { communityId: result.communityId, requestId: result.requestId, status: 'pending', createdAt: new Date().toISOString(), user: person ? visibleMemberIdentity(person) : { id: userId, username: 'Membro' } });
    }
    if (result.joinedNow) await notifyMemberJoined(io, result.communityId, userId);
    res.json({ status: result.status, communityId: result.communityId, requestId: result.requestId ?? null });
  }));

  router.post('/communities/:communityId/join', asyncRoute(async (req, res) => {
    const communityId = uuid.safeParse(req.params.communityId);
    const input = joinInput.safeParse(req.body ?? {});
    if (!communityId.success) { res.status(404).json({ error: 'Não foi possível encontrar esta comunidade.' }); return; }
    if (!input.success) { res.status(400).json({ error: 'Confirma os dados e tenta novamente.' }); return; }
    const userId = userIdFrom(res);
    const result = await db.transaction(async (tx): Promise<JoinResult> => {
      await lockUser(tx, userId);
      const [community] = await tx.select().from(communities).where(eq(communities.id, communityId.data)).limit(1);
      if (!community || community.isPrivate) return { error: 'private' };
      if (await activeBanIn(tx, community.id, userId)) return { error: 'banned' };
      const [member] = await tx.select({ id: communityMembers.id }).from(communityMembers)
        .where(and(eq(communityMembers.communityId, community.id), eq(communityMembers.userId, userId))).limit(1);
      if (member) return { status: 'already_member', communityId: community.id };
      if (!communityRulesAccepted(community.rules, input.data.acceptedRules)) return { error: 'rules' };
      if (community.requireApproval) return createPendingRequest(tx, { communityId: community.id, userId, invitationId: null });
      const [role] = await tx.select({ id: communityRoles.id }).from(communityRoles)
        .where(and(eq(communityRoles.communityId, community.id), eq(communityRoles.key, 'member'))).limit(1);
      if (!role) return { error: 'missing' };
      const [joined] = await tx.insert(communityMembers).values({ communityId: community.id, userId, roleId: role.id, rulesAcceptedAt: community.rules.trim() ? new Date() : null }).onConflictDoNothing().returning({ id: communityMembers.id });
      if (!joined) return { status: 'already_member', communityId: community.id };
      return { status: 'joined', communityId: community.id, joinedNow: true };
    });
    if ('error' in result) { respondJoinError(res, result); return; }
    if (result.createdRequest) {
      const [person] = await db.select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl, showAvatar: users.showAvatar }).from(users).where(eq(users.id, userId)).limit(1);
      await notifyRequestChanged(io, result.communityId, { communityId: result.communityId, requestId: result.requestId, status: 'pending', createdAt: new Date().toISOString(), user: person ? visibleMemberIdentity(person) : { id: userId, username: 'Membro' } });
    }
    if (result.joinedNow) await notifyMemberJoined(io, result.communityId, userId);
    res.json({ status: result.status, communityId: result.communityId, requestId: result.requestId ?? null });
  }));

  router.get('/communities/:communityId/join-requests', asyncRoute(async (req, res) => {
    const communityId = uuid.safeParse(req.params.communityId);
    if (!communityId.success) { res.status(400).json({ error: 'Comunidade inválida.' }); return; }
    if (!await hasPermission(userIdFrom(res), communityId.data, 'manage_members')) { res.status(403).json({ error: 'Não tens permissão para ver estes pedidos.' }); return; }
    const rows = await db.select({ id: joinRequests.id, createdAt: joinRequests.createdAt, userId: users.id, username: users.username, avatarUrl: users.avatarUrl, showAvatar: users.showAvatar })
      .from(joinRequests).innerJoin(users, eq(joinRequests.userId, users.id))
      .where(and(eq(joinRequests.communityId, communityId.data), eq(joinRequests.status, 'pending'))).orderBy(joinRequests.createdAt).limit(100);
    res.json({ requests: rows.map(({ showAvatar, avatarUrl, ...row }) => ({ ...row, ...(showAvatar ? { avatarUrl } : {}) })) });
  }));

  router.post('/communities/:communityId/join-requests/:requestId/approve', asyncRoute(async (req, res) => {
    const communityId = uuid.safeParse(req.params.communityId);
    const requestId = uuid.safeParse(req.params.requestId);
    if (!communityId.success || !requestId.success) { res.status(400).json({ error: 'Pedido inválido.' }); return; }
    const actorId = userIdFrom(res);
    if (!await hasPermission(actorId, communityId.data, 'manage_members')) { res.status(403).json({ error: 'Não tens permissão para aprovar pedidos.' }); return; }
    const result = await db.transaction(async (tx): Promise<JoinResult> => {
      const [request] = await tx.select().from(joinRequests).where(and(eq(joinRequests.id, requestId.data), eq(joinRequests.communityId, communityId.data))).for('update').limit(1);
      if (!request || request.status !== 'pending') return { error: 'pending' };
      await lockUser(tx, request.userId);
      const [community] = await tx.select().from(communities).where(eq(communities.id, communityId.data)).limit(1);
      if (!community) return { error: 'missing' };
      if (await activeBanIn(tx, community.id, request.userId)) return { error: 'banned' };
      const [member] = await tx.select({ id: communityMembers.id }).from(communityMembers)
        .where(and(eq(communityMembers.communityId, community.id), eq(communityMembers.userId, request.userId))).limit(1);
      let joinedNow = false;
      if (!member) {
        let invite = null as typeof invitations.$inferSelect | null;
        if (request.invitationId) {
          const [found] = await tx.select().from(invitations).where(eq(invitations.id, request.invitationId)).for('update').limit(1);
          invite = found ?? null;
          if (!invite || invite.communityId !== community.id || !invitationIsValid(invite)) return { error: 'invalid' };
        }
        const [role] = await tx.select({ id: communityRoles.id }).from(communityRoles)
          .where(and(eq(communityRoles.communityId, community.id), eq(communityRoles.key, 'member'))).limit(1);
        if (!role) return { error: 'missing' };
        const [createdMember] = await tx.insert(communityMembers).values({ communityId: community.id, userId: request.userId, roleId: role.id, rulesAcceptedAt: community.rules.trim() ? request.createdAt : null }).onConflictDoNothing().returning({ id: communityMembers.id });
        joinedNow = Boolean(createdMember);
        if (joinedNow && invite) await tx.update(invitations).set({ useCount: sql`${invitations.useCount} + 1` }).where(eq(invitations.id, invite.id));
      }
      await tx.update(joinRequests).set({ status: 'approved', decidedBy: actorId, decidedAt: new Date() }).where(eq(joinRequests.id, request.id));
      return { status: joinedNow ? 'joined' : 'already_member', communityId: community.id, joinedNow, joinedUserId: request.userId };
    });
    if ('error' in result) { respondJoinError(res, result); return; }
    if (result.joinedNow && result.joinedUserId) await notifyMemberJoined(io, result.communityId, result.joinedUserId);
    const [community] = await db.select({ name: communities.name }).from(communities).where(eq(communities.id, result.communityId)).limit(1);
    const [request] = await db.select({ userId: joinRequests.userId }).from(joinRequests).where(eq(joinRequests.id, requestId.data)).limit(1);
    if (request) io.in(`user:${request.userId}`).emit('community:join-request-status', { communityId: result.communityId, communityName: community?.name ?? 'a comunidade', status: 'approved' });
    await notifyRequestChanged(io, result.communityId, { communityId: result.communityId, requestId: requestId.data, status: 'approved' });
    res.json({ status: 'approved' });
  }));

  router.post('/communities/:communityId/join-requests/:requestId/reject', asyncRoute(async (req, res) => {
    const communityId = uuid.safeParse(req.params.communityId);
    const requestId = uuid.safeParse(req.params.requestId);
    if (!communityId.success || !requestId.success) { res.status(400).json({ error: 'Pedido inválido.' }); return; }
    const actorId = userIdFrom(res);
    if (!await hasPermission(actorId, communityId.data, 'manage_members')) { res.status(403).json({ error: 'Não tens permissão para recusar pedidos.' }); return; }
    const result = await db.transaction(async (tx) => {
      const [request] = await tx.select().from(joinRequests).where(and(eq(joinRequests.id, requestId.data), eq(joinRequests.communityId, communityId.data))).for('update').limit(1);
      if (!request || request.status !== 'pending') return null;
      await tx.update(joinRequests).set({ status: 'rejected', decidedBy: actorId, decidedAt: new Date() }).where(eq(joinRequests.id, request.id));
      return { userId: request.userId };
    });
    if (!result) { res.status(409).json({ error: 'Este pedido já não está pendente.' }); return; }
    const [community] = await db.select({ name: communities.name }).from(communities).where(eq(communities.id, communityId.data)).limit(1);
    io.in(`user:${result.userId}`).emit('community:join-request-status', { communityId: communityId.data, communityName: community?.name ?? 'a comunidade', status: 'rejected' });
    await notifyRequestChanged(io, communityId.data, { communityId: communityId.data, requestId: requestId.data, status: 'rejected' });
    res.json({ status: 'rejected' });
  }));

  router.post('/communities/:communityId/join-requests/:requestId/cancel', asyncRoute(async (req, res) => {
    const communityId = uuid.safeParse(req.params.communityId);
    const requestId = uuid.safeParse(req.params.requestId);
    if (!communityId.success || !requestId.success) { res.status(400).json({ error: 'Pedido inválido.' }); return; }
    const userId = userIdFrom(res);
    const result = await db.update(joinRequests).set({ status: 'cancelled', decidedAt: new Date() })
      .where(and(eq(joinRequests.id, requestId.data), eq(joinRequests.communityId, communityId.data), eq(joinRequests.userId, userId), eq(joinRequests.status, 'pending'))).returning({ id: joinRequests.id });
    if (!result.length) { res.status(404).json({ error: 'Não encontrámos um pedido pendente para cancelar.' }); return; }
    await notifyRequestChanged(io, communityId.data, { communityId: communityId.data, requestId: requestId.data, status: 'cancelled' });
    res.json({ status: 'cancelled' });
  }));

  return router;
}

async function isBanned(userId: string, communityId: string): Promise<boolean> {
  const now = new Date();
  const [ban] = await db.select({ id: communityBans.id }).from(communityBans)
    .where(and(eq(communityBans.communityId, communityId), eq(communityBans.userId, userId), isNull(communityBans.revokedAt), or(isNull(communityBans.expiresAt), gt(communityBans.expiresAt, now)))).limit(1);
  return Boolean(ban);
}
