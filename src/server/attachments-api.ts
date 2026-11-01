import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type RequestHandler } from 'express';
import { and, asc, count, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Server as SocketServer } from 'socket.io';
import { db } from './db/index.js';
import { channels, communityBans, communityMutes, messageAttachments, users } from './db/schema.js';
import { hasPermission, isMember } from './permissions.js';
import {
  dailyQuotaAllows,
  signatureMatches,
  validateAttachmentMetadata,
} from './attachment-utils.js';
import { deleteStoredObject, inspectStoredObject, signReadUrl, signUploadUrl, storageIsConfigured } from './storage.js';

const uuid = z.string().uuid();
const STORAGE_UNAVAILABLE = 'Os anexos ainda não estão disponíveis. Tenta mais tarde.';
const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { void handler(req, res).catch(next); };

interface PublicAttachment {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  url: string;
}

async function isBanned(communityId: string, userId: string): Promise<boolean> {
  const now = new Date();
  const [ban] = await db.select({ id: communityBans.id }).from(communityBans)
    .where(and(eq(communityBans.communityId, communityId), eq(communityBans.userId, userId), isNull(communityBans.revokedAt), or(isNull(communityBans.expiresAt), gt(communityBans.expiresAt, now)))).limit(1);
  return Boolean(ban);
}

async function activeMute(communityId: string, userId: string): Promise<boolean> {
  const [mute] = await db.select({ id: communityMutes.id }).from(communityMutes)
    .where(and(eq(communityMutes.communityId, communityId), eq(communityMutes.userId, userId), isNull(communityMutes.revokedAt), gt(communityMutes.expiresAt, new Date()))).limit(1);
  return Boolean(mute);
}

async function uploadAccess(userId: string, channelId: string): Promise<{ ok: true; channel: { id: string; communityId: string } } | { ok: false; status: number; error: string }> {
  const [channel] = await db.select({ id: channels.id, communityId: channels.communityId, kind: channels.kind }).from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!channel || channel.kind !== 'text' || !await isMember(userId, channel.communityId)) return { ok: false, status: 404, error: 'Canal não encontrado.' };
  if (await isBanned(channel.communityId, userId)) return { ok: false, status: 403, error: 'Não tens acesso a esta comunidade.' };
  if (!await hasPermission(userId, channel.communityId, 'send_messages')) return { ok: false, status: 403, error: 'Não tens permissão para enviar anexos neste canal.' };
  if (await activeMute(channel.communityId, userId)) return { ok: false, status: 403, error: 'Não podes enviar anexos enquanto estiveres silenciado.' };
  return { ok: true, channel: { id: channel.id, communityId: channel.communityId } };
}

async function readAccess(userId: string, channelId: string): Promise<{ ok: true; communityId: string } | { ok: false; status: number; error: string }> {
  const [channel] = await db.select({ id: channels.id, communityId: channels.communityId, kind: channels.kind }).from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!channel || channel.kind !== 'text' || !await isMember(userId, channel.communityId) || await isBanned(channel.communityId, userId)) return { ok: false, status: 404, error: 'Anexo não encontrado.' };
  return { ok: true, communityId: channel.communityId };
}

export async function attachmentsForMessages(messageIds: string[]): Promise<Record<string, PublicAttachment[]>> {
  if (messageIds.length === 0 || !storageIsConfigured()) return {};
  const rows = await db.select({
    id: messageAttachments.id,
    messageId: messageAttachments.messageId,
    originalName: messageAttachments.originalName,
    mimeType: messageAttachments.mimeType,
    sizeBytes: messageAttachments.sizeBytes,
    width: messageAttachments.width,
    height: messageAttachments.height,
    storageKey: messageAttachments.storageKey,
  }).from(messageAttachments)
    .where(and(inArray(messageAttachments.messageId, messageIds), eq(messageAttachments.status, 'ready')))
    .orderBy(asc(messageAttachments.createdAt));
  const result: Record<string, PublicAttachment[]> = {};
  const signed = await Promise.all(rows.map(async (row) => {
    const url = await signReadUrl(row.storageKey, row.mimeType, row.originalName, !row.mimeType.startsWith('image/') && !row.mimeType.startsWith('video/'));
    return { messageId: row.messageId!, attachment: { id: row.id, originalName: row.originalName, mimeType: row.mimeType, sizeBytes: row.sizeBytes, width: row.width, height: row.height, url } satisfies PublicAttachment };
  }));
  for (const entry of signed) (result[entry.messageId] ??= []).push(entry.attachment);
  return result;
}

export async function removeMessageAttachments(messageId: string): Promise<void> {
  const rows = await db.select({ id: messageAttachments.id, storageKey: messageAttachments.storageKey }).from(messageAttachments)
    .where(eq(messageAttachments.messageId, messageId));
  if (!rows.length) return;
  await db.update(messageAttachments).set({ status: 'removed' }).where(inArray(messageAttachments.id, rows.map((row) => row.id)));
  for (const row of rows) {
    try { await deleteStoredObject(row.storageKey); }
    catch { console.error('Could not remove a message attachment object; record retained as removed:', row.id); }
  }
}

export type ChannelDeleteOutcome = 'deleted' | 'not-found' | 'last-text-channel' | 'storage-failed';

export async function deleteChannelWithAttachments(channelId: string): Promise<ChannelDeleteOutcome> {
  return db.transaction(async (tx) => {
    const [channel] = await tx.select({ id: channels.id, communityId: channels.communityId, kind: channels.kind }).from(channels)
      .where(eq(channels.id, channelId)).for('update');
    if (!channel) return 'not-found';
    if (channel.kind === 'text') {
      const [total] = await tx.select({ value: count() }).from(channels)
        .where(and(eq(channels.communityId, channel.communityId), eq(channels.kind, 'text')));
      if (Number(total.value) <= 1) return 'last-text-channel';
    }
    const rows = await tx.select({ id: messageAttachments.id, storageKey: messageAttachments.storageKey }).from(messageAttachments)
      .where(eq(messageAttachments.channelId, channel.id));
    if (rows.length) {
      await tx.update(messageAttachments).set({ status: 'removed' }).where(inArray(messageAttachments.id, rows.map((row) => row.id)));
      if (!storageIsConfigured()) return 'storage-failed';
      let failed = false;
      for (let offset = 0; offset < rows.length; offset += 25) {
        const batch = rows.slice(offset, offset + 25);
        const outcomes = await Promise.all(batch.map(async (row) => {
          try { await deleteStoredObject(row.storageKey); return true; }
          catch { console.error('Could not remove a channel attachment object; record retained as removed:', row.id); return false; }
        }));
        if (outcomes.some((success) => !success)) failed = true;
      }
      if (failed) return 'storage-failed';
      await tx.delete(messageAttachments).where(inArray(messageAttachments.id, rows.map((row) => row.id)));
    }
    await tx.delete(channels).where(eq(channels.id, channel.id));
    return 'deleted';
  });
}

async function cleanStalePendingAttachments(): Promise<void> {
  const stale = await db.select({ id: messageAttachments.id, storageKey: messageAttachments.storageKey }).from(messageAttachments)
    .where(and(eq(messageAttachments.status, 'pending'), lt(messageAttachments.createdAt, new Date(Date.now() - 60 * 60_000))))
    .orderBy(asc(messageAttachments.createdAt)).limit(50);
  for (const item of stale) {
    try {
      const claimed = await db.transaction(async (tx) => {
        const [current] = await tx.select({ status: messageAttachments.status }).from(messageAttachments)
          .where(eq(messageAttachments.id, item.id)).for('update');
        if (!current || current.status !== 'pending') return false;
        await tx.update(messageAttachments).set({ status: 'removed' }).where(eq(messageAttachments.id, item.id));
        return true;
      });
      if (!claimed) continue;
      await deleteStoredObject(item.storageKey);
      await db.delete(messageAttachments).where(and(eq(messageAttachments.id, item.id), eq(messageAttachments.status, 'removed')));
    } catch { console.error('Could not clean a stale pending attachment; record retained:', item.id); }
  }
}

function uploadValidationMessage(reason: 'name' | 'type' | 'size', mimeType: string, maxBytes?: number): string {
  if (reason === 'size') {
    if (mimeType.startsWith('video/')) return 'Este ficheiro é demasiado grande. O máximo para vídeos é 25 MB.';
    const maximumMb = Math.ceil((maxBytes ?? 0) / (1024 * 1024));
    return `Este ficheiro é demasiado grande. O máximo permitido é ${maximumMb} MB.`;
  }
  return 'Este tipo de ficheiro não é permitido.';
}

async function rejectUploadedObject(attachmentId: string, storageKey: string): Promise<void> {
  await db.update(messageAttachments).set({ status: 'removed' }).where(eq(messageAttachments.id, attachmentId));
  try { await deleteStoredObject(storageKey); }
  catch { console.error('Could not remove a rejected attachment object; record retained as removed:', attachmentId); }
}

export function createAttachmentsRouter(_io: SocketServer): Router {
  const router = Router();

  router.get('/channels/:channelId/attachments/availability', asyncRoute(async (req, res) => {
    const access = await uploadAccess((res.locals.user as { id: string }).id, req.params.channelId);
    if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
    res.json({ available: storageIsConfigured() });
  }));

  router.post('/channels/:channelId/attachments', asyncRoute(async (req, res) => {
    const userId = (res.locals.user as { id: string }).id;
    const access = await uploadAccess(userId, req.params.channelId);
    if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
    if (!storageIsConfigured()) { res.status(503).json({ error: STORAGE_UNAVAILABLE }); return; }
    const input = z.object({
      originalName: z.string().min(1).max(2048),
      mimeType: z.string().min(1).max(120),
      sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      width: z.number().int().positive().max(100_000).nullable().optional(),
      height: z.number().int().positive().max(100_000).nullable().optional(),
    }).safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Confirma o nome, tipo e tamanho do ficheiro.' }); return; }
    const valid = validateAttachmentMetadata(input.data.originalName, input.data.mimeType, input.data.sizeBytes);
    if (!valid.ok) { res.status(400).json({ error: uploadValidationMessage(valid.reason, input.data.mimeType, valid.maxBytes) }); return; }
    await cleanStalePendingAttachments();
    const storageKey = randomUUID().replace(/-/g, '');
    const created = await db.transaction(async (tx) => {
      const [lockedChannel] = await tx.select({ id: channels.id, communityId: channels.communityId }).from(channels)
        .where(eq(channels.id, access.channel.id)).for('share');
      if (!lockedChannel) return { error: 'channel' as const };
      const [lockedUser] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      if (!lockedUser) return { error: 'user' as const };
      const [quota] = await tx.select({ used: sql<string>`coalesce(sum(${messageAttachments.sizeBytes}), 0)` }).from(messageAttachments)
        .where(and(eq(messageAttachments.userId, userId), gt(messageAttachments.createdAt, new Date(Date.now() - 24 * 60 * 60_000))));
      if (!dailyQuotaAllows(Number(quota?.used ?? 0), input.data.sizeBytes)) return { error: 'quota' as const };
      const [attachment] = await tx.insert(messageAttachments).values({
        userId,
        communityId: lockedChannel.communityId,
        channelId: lockedChannel.id,
        storageKey,
        originalName: valid.originalName,
        mimeType: valid.mimeType,
        sizeBytes: input.data.sizeBytes,
        width: input.data.width ?? null,
        height: input.data.height ?? null,
      }).returning({ id: messageAttachments.id });
      return { attachment };
    });
    if ('error' in created) {
      if (created.error === 'quota') { res.status(429).json({ error: 'Atingiste o limite diário de 100 MB para anexos. Tenta novamente mais tarde.' }); return; }
      res.status(404).json({ error: 'Canal não encontrado.' }); return;
    }
    try {
      const uploadUrl = await signUploadUrl(storageKey, valid.mimeType);
      res.status(201).json({ attachmentId: created.attachment.id, uploadUrl, expiresIn: 300, headers: { 'Content-Type': valid.mimeType } });
    } catch {
      await db.delete(messageAttachments).where(eq(messageAttachments.id, created.attachment.id));
      res.status(503).json({ error: STORAGE_UNAVAILABLE });
    }
  }));

  router.post('/attachments/:attachmentId/upload-url', asyncRoute(async (req, res) => {
    const id = uuid.safeParse(req.params.attachmentId);
    if (!id.success) { res.status(404).json({ error: 'Anexo não encontrado.' }); return; }
    const userId = (res.locals.user as { id: string }).id;
    const [attachment] = await db.select().from(messageAttachments).where(eq(messageAttachments.id, id.data)).limit(1);
    if (!attachment || attachment.userId !== userId || attachment.status !== 'pending' || attachment.messageId !== null) { res.status(404).json({ error: 'Anexo não encontrado.' }); return; }
    const access = await uploadAccess(userId, attachment.channelId);
    if (!access.ok || access.channel.communityId !== attachment.communityId) { res.status(404).json({ error: 'Anexo não encontrado.' }); return; }
    if (!storageIsConfigured()) { res.status(503).json({ error: STORAGE_UNAVAILABLE }); return; }
    try { res.json({ uploadUrl: await signUploadUrl(attachment.storageKey, attachment.mimeType), expiresIn: 300, headers: { 'Content-Type': attachment.mimeType } }); }
    catch { res.status(503).json({ error: STORAGE_UNAVAILABLE }); }
  }));

  router.post('/attachments/:attachmentId/confirm', asyncRoute(async (req, res) => {
    const id = uuid.safeParse(req.params.attachmentId);
    if (!id.success) { res.status(404).json({ error: 'Anexo não encontrado.' }); return; }
    const userId = (res.locals.user as { id: string }).id;
    const input = z.object({ width: z.number().int().positive().max(100_000).nullable().optional(), height: z.number().int().positive().max(100_000).nullable().optional() }).safeParse(req.body ?? {});
    if (!input.success) { res.status(400).json({ error: 'Não foi possível confirmar este ficheiro.' }); return; }
    const [attachment] = await db.select().from(messageAttachments).where(and(eq(messageAttachments.id, id.data), eq(messageAttachments.userId, userId))).limit(1);
    if (!attachment || attachment.messageId !== null || attachment.status === 'removed') { res.status(404).json({ error: 'Anexo não encontrado.' }); return; }
    const access = await uploadAccess(userId, attachment.channelId);
    if (!access.ok || access.channel.communityId !== attachment.communityId) { res.status(404).json({ error: 'Anexo não encontrado.' }); return; }
    if (attachment.status === 'ready') { res.json({ attachmentId: attachment.id, status: 'ready' }); return; }
    if (!storageIsConfigured()) { res.status(503).json({ error: STORAGE_UNAVAILABLE }); return; }
    let object: { sizeBytes: number | null; firstBytes: Uint8Array };
    try { object = await inspectStoredObject(attachment.storageKey); }
    catch { res.status(400).json({ error: 'Não foi possível confirmar este ficheiro. Tenta enviá-lo novamente.' }); return; }
    const valid = validateAttachmentMetadata(attachment.originalName, attachment.mimeType, object.sizeBytes ?? 0);
    if (object.sizeBytes === null || object.sizeBytes !== attachment.sizeBytes || !valid.ok || !signatureMatches(attachment.mimeType, object.firstBytes)) {
      await rejectUploadedObject(attachment.id, attachment.storageKey);
      const error = valid.ok || object.sizeBytes === attachment.sizeBytes
        ? 'O ficheiro não corresponde ao tipo escolhido. Escolhe outro ficheiro.'
        : uploadValidationMessage('size', attachment.mimeType, valid.maxBytes);
      res.status(400).json({ error }); return;
    }
    const [ready] = await db.update(messageAttachments).set({
      status: 'ready',
      sizeBytes: object.sizeBytes,
      width: input.data.width ?? attachment.width,
      height: input.data.height ?? attachment.height,
    }).where(and(eq(messageAttachments.id, attachment.id), eq(messageAttachments.userId, userId), eq(messageAttachments.status, 'pending'), isNull(messageAttachments.messageId)))
      .returning({ id: messageAttachments.id });
    if (!ready) { res.status(409).json({ error: 'Este ficheiro já não está disponível. Tenta novamente.' }); return; }
    res.json({ attachmentId: ready.id, status: 'ready' });
  }));

  router.get('/attachments/:attachmentId/url', asyncRoute(async (req, res) => {
    const id = uuid.safeParse(req.params.attachmentId);
    if (!id.success) { res.status(404).json({ error: 'Anexo não encontrado.' }); return; }
    const userId = (res.locals.user as { id: string }).id;
    const [attachment] = await db.select().from(messageAttachments).where(and(eq(messageAttachments.id, id.data), eq(messageAttachments.status, 'ready'))).limit(1);
    if (!attachment) { res.status(404).json({ error: 'Anexo não encontrado.' }); return; }
    const access = await readAccess(userId, attachment.channelId);
    if (!access.ok || access.communityId !== attachment.communityId) { res.status(404).json({ error: 'Anexo não encontrado.' }); return; }
    if (!storageIsConfigured()) { res.status(503).json({ error: STORAGE_UNAVAILABLE }); return; }
    try {
      const download = !attachment.mimeType.startsWith('image/') && !attachment.mimeType.startsWith('video/');
      res.json({ url: await signReadUrl(attachment.storageKey, attachment.mimeType, attachment.originalName, download), expiresIn: 3600 });
    } catch { res.status(503).json({ error: STORAGE_UNAVAILABLE }); }
  }));

  return router;
}
