import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { and, count, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Server as SocketServer } from 'socket.io';
import { db } from './db/index.js';
import {
  communityBans, communityMembers, directConversations, directMessages, directReads,
  dmBlocks, users,
} from './db/schema.js';
import { BUILTIN_EMOJIS, BUILTIN_STICKERS } from './builtin-assets.js';
import { canOpenConversation, isBuiltinStickerKey, isValidDirectMessageBody, orderUserPair, presentDirectMessage } from './direct-message-utils.js';
import { visibleMemberProfile, type ProfileRecord } from './profile-utils.js';

const uuid = z.string().uuid();
const genericSendError = 'Não foi possível enviar esta mensagem.';
const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { void handler(req, res).catch(next); };
const replyMessages = alias(directMessages, 'dm_reply_messages');
const replyAuthors = alias(users, 'dm_reply_authors');
const targetMembers = alias(communityMembers, 'dm_target_members');
const rateWindowMs = 60_000;
const maxMessagesPerMinute = 30;
const messageRate = new Map<string, number[]>();

function takeMessageAllowance(userId: string, now = Date.now()): boolean {
  const recent = (messageRate.get(userId) ?? []).filter((timestamp) => now - timestamp < rateWindowMs);
  if (recent.length >= maxMessagesPerMinute) { messageRate.set(userId, recent); return false; }
  recent.push(now);
  messageRate.set(userId, recent);
  if (messageRate.size > 2_000) {
    for (const [key, timestamps] of messageRate) if (timestamps.every((timestamp) => now - timestamp >= rateWindowMs)) messageRate.delete(key);
  }
  return true;
}

async function hasSharedCommunityWithoutBan(firstUserId: string, secondUserId: string): Promise<boolean> {
  const shared = await db.select({ communityId: communityMembers.communityId })
    .from(communityMembers).innerJoin(targetMembers, eq(targetMembers.communityId, communityMembers.communityId))
    .where(and(eq(communityMembers.userId, firstUserId), eq(targetMembers.userId, secondUserId)));
  if (!shared.length) return false;
  const communityIds = [...new Set(shared.map((row) => row.communityId))];
  const active = await db.select({ communityId: communityBans.communityId })
    .from(communityBans)
    .where(and(
      inArray(communityBans.communityId, communityIds),
      inArray(communityBans.userId, [firstUserId, secondUserId]),
      isNull(communityBans.revokedAt),
      or(isNull(communityBans.expiresAt), gt(communityBans.expiresAt, new Date())),
    ));
  const bannedCommunities = new Set(active.map((row) => row.communityId));
  return canOpenConversation(communityIds.some((id) => !bannedCommunities.has(id)));
}

async function recipientBlockedSender(senderId: string, recipientId: string): Promise<boolean> {
  const [row] = await db.select({ blockerId: dmBlocks.blockerId }).from(dmBlocks)
    .where(and(eq(dmBlocks.blockerId, recipientId), eq(dmBlocks.blockedId, senderId))).limit(1);
  return Boolean(row);
}

function otherParticipant(conversation: { userAId: string; userBId: string }, userId: string): string {
  return conversation.userAId === userId ? conversation.userBId : conversation.userAId;
}

async function emitParticipantEvent(io: SocketServer, conversation: { userAId: string; userBId: string }, actorId: string, eventName: string, payload: unknown): Promise<void> {
  io.to(`user:${actorId}`).emit(eventName, payload);
  const otherId = otherParticipant(conversation, actorId);
  if (!await recipientBlockedSender(actorId, otherId)) io.to(`user:${otherId}`).emit(eventName, payload);
}

async function getConversation(conversationId: string, userId: string) {
  const [conversation] = await db.select().from(directConversations)
    .where(and(eq(directConversations.id, conversationId), or(eq(directConversations.userAId, userId), eq(directConversations.userBId, userId))!)).limit(1);
  return conversation ?? null;
}

function safeProfile(row: ProfileRecord, online: boolean) {
  return visibleMemberProfile(row, { online, commonCommunities: [], canViewEmail: false });
}

async function messagePayload(messageId: string) {
  const [row] = await db.select({
    id: directMessages.id,
    conversationId: directMessages.conversationId,
    clientMessageId: directMessages.clientMessageId,
    body: directMessages.body,
    deletedAt: directMessages.deletedAt,
    replyToId: directMessages.replyToId,
    builtinStickerKey: directMessages.builtinStickerKey,
    createdAt: directMessages.createdAt,
    authorId: users.id,
    username: users.username,
    avatarUrl: users.avatarUrl,
    showAvatar: users.showAvatar,
    replyAuthorId: replyAuthors.id,
    replyUsername: replyAuthors.username,
    replyBody: replyMessages.body,
    replyDeletedAt: replyMessages.deletedAt,
  }).from(directMessages).innerJoin(users, eq(directMessages.authorId, users.id))
    .leftJoin(replyMessages, eq(directMessages.replyToId, replyMessages.id))
    .leftJoin(replyAuthors, eq(replyMessages.authorId, replyAuthors.id))
    .where(eq(directMessages.id, messageId)).limit(1);
  if (!row) return null;
  const presentation = presentDirectMessage(row.body, row.deletedAt !== null);
  const replyPresentation = row.replyBody === null ? null : presentDirectMessage(row.replyBody, row.replyDeletedAt !== null);
  const author = row.showAvatar ? { id: row.authorId, username: row.username, avatarUrl: row.avatarUrl } : { id: row.authorId, username: row.username };
  return {
    id: row.id,
    conversationId: row.conversationId,
    clientMessageId: row.clientMessageId,
    body: presentation.body,
    deleted: presentation.deleted,
    replyToId: row.replyToId,
    replyTo: row.replyToId ? {
      id: row.replyToId,
      author: row.replyAuthorId ? { id: row.replyAuthorId, username: row.replyUsername } : null,
      body: replyPresentation?.body ?? 'Mensagem apagada',
      deleted: replyPresentation?.deleted ?? true,
    } : null,
    builtinStickerKey: row.builtinStickerKey,
    createdAt: row.createdAt.toISOString(),
    author,
  };
}

interface InboxRow {
  id: string;
  createdAt: Date;
  lastMessageAt: Date | null;
  otherId: string;
  username: string;
  email: string;
  avatarUrl: string | null;
  aboutMe: string;
  bannerUrl: string | null;
  bannerColor: string | null;
  statusText: string;
  presencePreference: ProfileRecord['presencePreference'];
  createdAtProfile: Date;
  showAvatar: boolean;
  showAbout: boolean;
  showStatus: boolean;
  showJoinDate: boolean;
  showCommonCommunities: boolean;
  showEmail: boolean;
  showBanner: boolean;
  lastMessageId: string | null;
  lastBody: string | null;
  lastDeletedAt: Date | null;
  lastAuthorId: string | null;
  lastMessageCreatedAt: Date | null;
  lastStickerKey: string | null;
  unreadCount: number | string;
}

export function createDirectMessagesRouter(io: SocketServer): Router {
  const router = Router();

  router.post('/conversations/:otherUserId/open', asyncRoute(async (req, res) => {
    const currentUserId = (res.locals.user as { id: string }).id;
    const parsedTargetId = uuid.safeParse(req.params.otherUserId);
    if (!parsedTargetId.success || parsedTargetId.data.toLowerCase() === currentUserId.toLowerCase()) { res.status(400).json({ error: 'Não podes enviar mensagens a esta pessoa.' }); return; }
    const otherUserId = parsedTargetId.data;
    const pair = orderUserPair(currentUserId, otherUserId);
    let [conversation] = await db.select().from(directConversations)
      .where(and(eq(directConversations.userAId, pair.userA), eq(directConversations.userBId, pair.userB))).limit(1);
    const eligible = await hasSharedCommunityWithoutBan(currentUserId, otherUserId);
    const blockedByTarget = await recipientBlockedSender(currentUserId, otherUserId);
    if (!conversation) {
      if (!eligible || blockedByTarget) { res.status(403).json({ error: 'Não podes enviar mensagens a esta pessoa.' }); return; }
      const since = new Date(Date.now() - 24 * 60 * 60_000);
      const [{ total }] = await db.select({ total: count() }).from(directConversations)
        .where(and(or(eq(directConversations.userAId, currentUserId), eq(directConversations.userBId, currentUserId)), gt(directConversations.createdAt, since)));
      if (total >= 30) { res.status(429).json({ error: 'Atingiste o limite diário de novas conversas. Tenta novamente mais tarde.' }); return; }
      const [created] = await db.insert(directConversations).values({ userAId: pair.userA, userBId: pair.userB })
        .onConflictDoNothing().returning();
      conversation = created ?? (await db.select().from(directConversations)
        .where(and(eq(directConversations.userAId, pair.userA), eq(directConversations.userBId, pair.userB))).limit(1))[0];
      if (!conversation) { res.status(500).json({ error: 'Não foi possível abrir a conversa.' }); return; }
    }
    const [other] = await db.select({
      id: users.id, username: users.username, email: users.email, avatarUrl: users.avatarUrl,
      aboutMe: users.aboutMe, bannerUrl: users.bannerUrl, bannerColor: users.bannerColor,
      statusText: users.statusText, presencePreference: users.presencePreference,
      createdAt: users.createdAt, showAvatar: users.showAvatar, showAbout: users.showAbout,
      showStatus: users.showStatus, showJoinDate: users.showJoinDate,
      showCommonCommunities: users.showCommonCommunities, showEmail: users.showEmail, showBanner: users.showBanner,
    }).from(users).where(eq(users.id, otherUserId)).limit(1);
    if (!other) { res.status(404).json({ error: 'Utilizador não encontrado.' }); return; }
    const online = (await io.in(`user:${otherUserId}`).fetchSockets()).length > 0;
    const lastRead = await db.select({ lastReadAt: directReads.lastReadAt }).from(directReads)
      .where(and(eq(directReads.userId, currentUserId), eq(directReads.conversationId, conversation.id))).limit(1);
    res.status(200).json({ conversation: { id: conversation.id, other: safeProfile(other as ProfileRecord, online), canSend: eligible && !blockedByTarget, lastReadAt: lastRead[0]?.lastReadAt?.toISOString() ?? null } });
  }));

  router.get('/conversations', asyncRoute(async (_req, res) => {
    const userId = (res.locals.user as { id: string }).id;
    const result = await db.execute(sql`
      SELECT c.id,
        c.created_at AS "createdAt",
        c.last_message_at AS "lastMessageAt",
        other.id AS "otherId", other.username, other.email, other.avatar_url AS "avatarUrl",
        other.about_me AS "aboutMe", other.banner_url AS "bannerUrl", other.banner_color AS "bannerColor",
        other.status_text AS "statusText", other.presence_preference AS "presencePreference",
        other.created_at AS "createdAtProfile", other.show_avatar AS "showAvatar", other.show_about AS "showAbout",
        other.show_status AS "showStatus", other.show_join_date AS "showJoinDate",
        other.show_common_communities AS "showCommonCommunities", other.show_email AS "showEmail", other.show_banner AS "showBanner",
        latest.id AS "lastMessageId",
        CASE WHEN latest.deleted_at IS NOT NULL THEN 'Mensagem apagada' ELSE latest.body END AS "lastBody",
        latest.deleted_at AS "lastDeletedAt", latest.author_id AS "lastAuthorId",
        latest.created_at AS "lastMessageCreatedAt", latest.builtin_sticker_key AS "lastStickerKey",
        LEAST(99, (SELECT COUNT(*)::int FROM direct_messages unread
          WHERE unread.conversation_id = c.id AND unread.author_id <> ${userId}::uuid
            AND unread.deleted_at IS NULL
            AND (read_state.last_read_at IS NULL OR unread.created_at > read_state.last_read_at))) AS "unreadCount"
      FROM direct_conversations c
      JOIN users other ON other.id = CASE WHEN c.user_a_id = ${userId}::uuid THEN c.user_b_id ELSE c.user_a_id END
      LEFT JOIN direct_reads read_state ON read_state.user_id = ${userId}::uuid AND read_state.conversation_id = c.id
      LEFT JOIN LATERAL (
        SELECT dm.id, dm.body, dm.deleted_at, dm.author_id, dm.created_at, dm.builtin_sticker_key
        FROM direct_messages dm WHERE dm.conversation_id = c.id
        ORDER BY dm.created_at DESC, dm.id DESC LIMIT 1
      ) latest ON TRUE
      WHERE c.user_a_id = ${userId}::uuid OR c.user_b_id = ${userId}::uuid
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
    `);
    const rows = result.rows as unknown as InboxRow[];
    const conversations = await Promise.all(rows.map(async (row) => {
      const online = (await io.in(`user:${row.otherId}`).fetchSockets()).length > 0;
      const profile: ProfileRecord = {
        id: row.otherId, username: row.username, email: row.email, avatarUrl: row.avatarUrl,
        aboutMe: row.aboutMe, bannerUrl: row.bannerUrl, bannerColor: row.bannerColor,
        statusText: row.statusText, presencePreference: row.presencePreference,
        createdAt: row.createdAtProfile, showAvatar: row.showAvatar, showAbout: row.showAbout,
        showStatus: row.showStatus, showJoinDate: row.showJoinDate,
        showCommonCommunities: row.showCommonCommunities, showEmail: row.showEmail, showBanner: row.showBanner,
      };
      return {
        id: row.id,
        other: safeProfile(profile, online),
        createdAt: row.createdAt.toISOString(),
        lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
        lastMessage: row.lastMessageId ? {
          id: row.lastMessageId,
          authorId: row.lastAuthorId,
          body: row.lastBody ?? '',
          deleted: row.lastDeletedAt !== null,
          builtinStickerKey: row.lastStickerKey,
          createdAt: row.lastMessageCreatedAt?.toISOString() ?? null,
        } : null,
        unreadCount: Number(row.unreadCount),
      };
    }));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ conversations });
  }));

  router.get('/conversations/:conversationId/messages', asyncRoute(async (req, res) => {
    const userId = (res.locals.user as { id: string }).id;
    const conversationId = uuid.safeParse(req.params.conversationId);
    if (!conversationId.success) { res.status(404).json({ error: 'Conversa não encontrada.' }); return; }
    const conversation = await getConversation(conversationId.data, userId);
    if (!conversation) { res.status(404).json({ error: 'Conversa não encontrada.' }); return; }
    const cursor = typeof req.query.before === 'string' ? req.query.before.split('~') : null;
    let before: Date | null = null;
    let beforeId: string | null = null;
    if (cursor) {
      if (cursor.length !== 2 || Number.isNaN(Date.parse(cursor[0])) || !uuid.safeParse(cursor[1]).success) { res.status(400).json({ error: 'Cursor inválido.' }); return; }
      before = new Date(cursor[0]); beforeId = cursor[1];
    }
    const conditions = [eq(directMessages.conversationId, conversation.id)];
    if (before && beforeId) conditions.push(or(lt(directMessages.createdAt, before), and(eq(directMessages.createdAt, before), lt(directMessages.id, beforeId)))!);
    const pageSize = 50;
    const selected = await db.select({ id: directMessages.id, createdAt: directMessages.createdAt }).from(directMessages).where(and(...conditions))
      .orderBy(desc(directMessages.createdAt), desc(directMessages.id)).limit(pageSize + 1);
    const hasMore = selected.length > pageSize;
    const page = selected.slice(0, pageSize);
    const oldest = page[page.length - 1];
    const ordered = page.reverse();
    const rows = ordered.length ? await db.select({
      id: directMessages.id, conversationId: directMessages.conversationId, clientMessageId: directMessages.clientMessageId,
      body: directMessages.body, deletedAt: directMessages.deletedAt, replyToId: directMessages.replyToId,
      builtinStickerKey: directMessages.builtinStickerKey, createdAt: directMessages.createdAt,
      authorId: users.id, username: users.username, avatarUrl: users.avatarUrl, showAvatar: users.showAvatar,
      replyAuthorId: replyAuthors.id, replyUsername: replyAuthors.username,
      replyBody: replyMessages.body, replyDeletedAt: replyMessages.deletedAt,
    }).from(directMessages).innerJoin(users, eq(directMessages.authorId, users.id))
      .leftJoin(replyMessages, eq(directMessages.replyToId, replyMessages.id))
      .leftJoin(replyAuthors, eq(replyMessages.authorId, replyAuthors.id))
      .where(inArray(directMessages.id, ordered.map((row) => row.id)))
      .orderBy(directMessages.createdAt, directMessages.id) : [];
    const messages = rows.map((row) => {
      const presentation = presentDirectMessage(row.body, row.deletedAt !== null);
      const replyPresentation = row.replyBody === null ? null : presentDirectMessage(row.replyBody, row.replyDeletedAt !== null);
      return {
        id: row.id, conversationId: row.conversationId, clientMessageId: row.clientMessageId,
        body: presentation.body, deleted: presentation.deleted,
        author: row.showAvatar ? { id: row.authorId, username: row.username, avatarUrl: row.avatarUrl } : { id: row.authorId, username: row.username },
        replyToId: row.replyToId,
        replyTo: row.replyToId ? { id: row.replyToId, author: row.replyAuthorId ? { id: row.replyAuthorId, username: row.replyUsername } : null, body: replyPresentation?.body ?? 'Mensagem apagada', deleted: replyPresentation?.deleted ?? true } : null,
        builtinStickerKey: row.builtinStickerKey,
        createdAt: row.createdAt.toISOString(),
      };
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ messages, hasMore, nextCursor: oldest ? `${oldest.createdAt.toISOString()}~${oldest.id}` : null });
  }));

  router.post('/conversations/:conversationId/messages', asyncRoute(async (req, res) => {
    const userId = (res.locals.user as { id: string }).id;
    const conversationId = uuid.safeParse(req.params.conversationId);
    const input = z.object({
      clientMessageId: uuid,
      body: z.string().max(2000),
      replyToId: uuid.nullable().optional(),
      builtinStickerKey: z.string().regex(/^[a-z0-9_]{2,64}$/).nullable().optional(),
    }).strict().safeParse(req.body);
    if (!conversationId.success || !input.success) { res.status(400).json({ error: 'Mensagem inválida. Usa até 2000 caracteres.' }); return; }
    const conversation = await getConversation(conversationId.data, userId);
    if (!conversation) { res.status(404).json({ error: genericSendError }); return; }
    const recipientId = otherParticipant(conversation, userId);
    const [priorMessage] = await db.select({ id: directMessages.id }).from(directMessages)
      .where(and(eq(directMessages.conversationId, conversation.id), eq(directMessages.authorId, userId), eq(directMessages.clientMessageId, input.data.clientMessageId))).limit(1);
    if (priorMessage) {
      const message = await messagePayload(priorMessage.id);
      if (message) { res.json({ message }); return; }
    }
    const stickerKey = input.data.builtinStickerKey ?? null;
    const emojiKeys = BUILTIN_EMOJIS.map((item) => item.key);
    const stickerKeys = BUILTIN_STICKERS.map((item) => item.key);
    if (!isValidDirectMessageBody(input.data.body, { builtinEmojiKeys: emojiKeys, stickerKey, builtinStickerKeys: stickerKeys })
      || (stickerKey !== null && !isBuiltinStickerKey(stickerKey, stickerKeys))) {
      res.status(400).json({ error: 'Mensagem inválida. Usa texto, emojis Unicode ou emojis e stickers do Pacote Mavuno.' }); return;
    }
    if (!await hasSharedCommunityWithoutBan(userId, recipientId) || await recipientBlockedSender(userId, recipientId)) {
      res.status(404).json({ error: genericSendError }); return;
    }
    if (!takeMessageAllowance(userId)) { res.status(429).json({ error: 'Estás a enviar mensagens demasiado depressa. Tenta novamente num minuto.' }); return; }
    if (input.data.replyToId) {
      const [parent] = await db.select({ id: directMessages.id }).from(directMessages)
        .where(and(eq(directMessages.id, input.data.replyToId), eq(directMessages.conversationId, conversation.id))).limit(1);
      if (!parent) { res.status(400).json({ error: 'A resposta tem de ser a uma mensagem desta conversa.' }); return; }
    }
    const now = new Date();
    const outcome = await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: directMessages.id }).from(directMessages)
        .where(and(eq(directMessages.conversationId, conversation.id), eq(directMessages.authorId, userId), eq(directMessages.clientMessageId, input.data.clientMessageId))).limit(1);
      if (existing) return { id: existing.id, created: false };
      const [created] = await tx.insert(directMessages).values({
        conversationId: conversation.id, authorId: userId, clientMessageId: input.data.clientMessageId,
        body: input.data.body, replyToId: input.data.replyToId ?? null, builtinStickerKey: stickerKey,
      }).onConflictDoNothing().returning({ id: directMessages.id, createdAt: directMessages.createdAt });
      if (!created) {
        const [duplicate] = await tx.select({ id: directMessages.id }).from(directMessages)
          .where(and(eq(directMessages.conversationId, conversation.id), eq(directMessages.authorId, userId), eq(directMessages.clientMessageId, input.data.clientMessageId))).limit(1);
        return duplicate ? { id: duplicate.id, created: false } : null;
      }
      await tx.update(directConversations).set({ lastMessageAt: created.createdAt }).where(eq(directConversations.id, conversation.id));
      await tx.insert(directReads).values({ userId, conversationId: conversation.id, lastReadAt: now })
        .onConflictDoUpdate({ target: [directReads.userId, directReads.conversationId], set: { lastReadAt: now } });
      return { id: created.id, created: true };
    });
    if (!outcome) { res.status(409).json({ error: genericSendError }); return; }
    const message = await messagePayload(outcome.id);
    if (!message) { res.status(500).json({ error: 'Não foi possível ler a mensagem enviada.' }); return; }
    if (outcome.created) {
      io.to(`user:${userId}`).emit('dm:message:new', message);
      io.to(`user:${recipientId}`).emit('dm:message:new', message);
    }
    res.status(outcome.created ? 201 : 200).json({ message });
  }));

  router.delete('/messages/:messageId', asyncRoute(async (req, res) => {
    const userId = (res.locals.user as { id: string }).id;
    const messageId = uuid.safeParse(req.params.messageId);
    if (!messageId.success) { res.status(404).json({ error: 'Mensagem não encontrada.' }); return; }
    const [row] = await db.select({ id: directMessages.id, conversationId: directMessages.conversationId, authorId: directMessages.authorId, deletedAt: directMessages.deletedAt })
      .from(directMessages).innerJoin(directConversations, eq(directMessages.conversationId, directConversations.id))
      .where(and(eq(directMessages.id, messageId.data), or(eq(directConversations.userAId, userId), eq(directConversations.userBId, userId))!)).limit(1);
    if (!row || row.authorId !== userId) { res.status(404).json({ error: 'Mensagem não encontrada.' }); return; }
    if (!row.deletedAt) await db.update(directMessages).set({ deletedAt: new Date() }).where(and(eq(directMessages.id, row.id), eq(directMessages.authorId, userId), isNull(directMessages.deletedAt)));
    const payload = { id: row.id, conversationId: row.conversationId, body: 'Mensagem apagada', deleted: true };
    const conversation = await getConversation(row.conversationId, userId);
    if (conversation) {
      await emitParticipantEvent(io, conversation, userId, 'dm:message:deleted', payload);
    }
    res.json({ message: payload });
  }));

  router.post('/conversations/:conversationId/read', asyncRoute(async (req, res) => {
    const userId = (res.locals.user as { id: string }).id;
    const conversationId = uuid.safeParse(req.params.conversationId);
    const conversation = conversationId.success ? await getConversation(conversationId.data, userId) : null;
    if (!conversation) { res.status(404).json({ error: 'Conversa não encontrada.' }); return; }
    const lastReadAt = new Date();
    await db.insert(directReads).values({ userId, conversationId: conversation.id, lastReadAt })
      .onConflictDoUpdate({ target: [directReads.userId, directReads.conversationId], set: { lastReadAt } });
    const event = { conversationId: conversation.id, userId, lastReadAt: lastReadAt.toISOString() };
    await emitParticipantEvent(io, conversation, userId, 'dm:read', event);
    res.json({ lastReadAt: lastReadAt.toISOString() });
  }));

  router.get('/blocks', asyncRoute(async (_req, res) => {
    const userId = (res.locals.user as { id: string }).id;
    const rows = await db.select({
      id: users.id, username: users.username, email: users.email, avatarUrl: users.avatarUrl,
      aboutMe: users.aboutMe, bannerUrl: users.bannerUrl, bannerColor: users.bannerColor,
      statusText: users.statusText, presencePreference: users.presencePreference,
      createdAt: users.createdAt, showAvatar: users.showAvatar, showAbout: users.showAbout,
      showStatus: users.showStatus, showJoinDate: users.showJoinDate,
      showCommonCommunities: users.showCommonCommunities, showEmail: users.showEmail, showBanner: users.showBanner,
      blockedAt: dmBlocks.createdAt,
    }).from(dmBlocks).innerJoin(users, eq(dmBlocks.blockedId, users.id)).where(eq(dmBlocks.blockerId, userId)).orderBy(desc(dmBlocks.createdAt));
    const blocked = await Promise.all(rows.map(async (row) => ({
      user: safeProfile(row as ProfileRecord, (await io.in(`user:${row.id}`).fetchSockets()).length > 0),
      blockedAt: row.blockedAt.toISOString(),
    })));
    res.json({ blocked });
  }));

  router.post('/blocks/:userId', asyncRoute(async (req, res) => {
    const blockerId = (res.locals.user as { id: string }).id;
    const blockedId = uuid.safeParse(req.params.userId);
    if (!blockedId.success || blockedId.data.toLowerCase() === blockerId.toLowerCase()) { res.status(400).json({ error: 'Não podes bloquear esta pessoa.' }); return; }
    const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, blockedId.data)).limit(1);
    if (!target) { res.status(404).json({ error: 'Utilizador não encontrado.' }); return; }
    await db.insert(dmBlocks).values({ blockerId, blockedId: blockedId.data }).onConflictDoNothing();
    res.json({ ok: true });
  }));

  router.delete('/blocks/:userId', asyncRoute(async (req, res) => {
    const blockerId = (res.locals.user as { id: string }).id;
    const blockedId = uuid.safeParse(req.params.userId);
    if (!blockedId.success) { res.status(400).json({ error: 'Utilizador inválido.' }); return; }
    await db.delete(dmBlocks).where(and(eq(dmBlocks.blockerId, blockerId), eq(dmBlocks.blockedId, blockedId.data)));
    res.json({ ok: true });
  }));

  return router;
}
