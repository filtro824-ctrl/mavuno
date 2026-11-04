import { randomUUID } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import { and, count, eq, gt, isNull, lt, or, like } from 'drizzle-orm';
import { z } from 'zod';
import type { Server as SocketServer } from 'socket.io';
import { db } from './db/index.js';
import { channels, communityBans, communityMutes, communityMembers, customEmojis, stickers } from './db/schema.js';
import { hasPermission, isMember } from './permissions.js';
import { deleteStoredObject, inspectStoredObject, signReadUrl, signUploadUrl, storageIsConfigured } from './storage.js';
import { builtinEmojiUrl, builtinStickerUrl, BUILTIN_EMOJIS, BUILTIN_STICKERS } from './builtin-assets.js';
import { CUSTOM_EMOJI_LIMIT, CUSTOM_STICKER_LIMIT, validateCustomImage, isCustomAssetName, isCustomImageType } from './custom-asset-utils.js';

const uuid = z.string().uuid();
const STORAGE_UNAVAILABLE = 'Os emojis e stickers ainda não estão disponíveis. Tenta mais tarde.';
const asyncRoute = (handler: (req: Request, res: Parameters<RequestHandler>[1]) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { void handler(req, res).catch(next); };

async function blocked(communityId: string, userId: string): Promise<boolean> {
  const now = new Date();
  const [ban] = await db.select({ id: communityBans.id }).from(communityBans).where(and(eq(communityBans.communityId, communityId), eq(communityBans.userId, userId), isNull(communityBans.revokedAt), or(isNull(communityBans.expiresAt), gt(communityBans.expiresAt, now)))).limit(1);
  if (ban) return true;
  const [mute] = await db.select({ id: communityMutes.id }).from(communityMutes).where(and(eq(communityMutes.communityId, communityId), eq(communityMutes.userId, userId), isNull(communityMutes.revokedAt), gt(communityMutes.expiresAt, now))).limit(1);
  return Boolean(mute);
}

async function manageAccess(userId: string, communityId: string): Promise<boolean> {
  return await isMember(userId, communityId) && !await blocked(communityId, userId) && await hasPermission(userId, communityId, 'manage_community');
}

async function memberAccess(userId: string, communityId: string): Promise<boolean> {
  return await isMember(userId, communityId) && !await blocked(communityId, userId);
}

function extensionFor(mimeType: string): string {
  return mimeType === 'image/gif' ? 'gif' : mimeType === 'image/webp' ? 'webp' : 'png';
}

async function cleanStalePending(): Promise<void> {
  const cutoff = new Date(Date.now() - 60 * 60_000);
  const [emojiRows, stickerRows] = await Promise.all([
    db.select({ id: customEmojis.id, storageKey: customEmojis.storageKey }).from(customEmojis).where(and(like(customEmojis.storageKey, 'community-assets/pending/%'), lt(customEmojis.createdAt, cutoff))).limit(50),
    db.select({ id: stickers.id, storageKey: stickers.storageKey }).from(stickers).where(and(like(stickers.storageKey, 'community-assets/pending/%'), lt(stickers.createdAt, cutoff))).limit(50),
  ]);
  for (const row of emojiRows) {
    await db.delete(customEmojis).where(eq(customEmojis.id, row.id));
    try { if (storageIsConfigured()) await deleteStoredObject(row.storageKey); } catch { console.error('Não foi possível limpar emoji pendente:', row.id); }
  }
  for (const row of stickerRows) {
    await db.delete(stickers).where(eq(stickers.id, row.id));
    try { if (storageIsConfigured()) await deleteStoredObject(row.storageKey); } catch { console.error('Não foi possível limpar sticker pendente:', row.id); }
  }
}

async function publicEmoji(row: typeof customEmojis.$inferSelect): Promise<Record<string, unknown>> {
  return { id: row.id, name: row.name, mimeType: row.mimeType, width: row.width, height: row.height, animated: row.animated, url: await signReadUrl(row.storageKey, row.mimeType, `${row.name}.${extensionFor(row.mimeType)}`, false) };
}

async function publicSticker(row: typeof stickers.$inferSelect): Promise<Record<string, unknown>> {
  return { id: row.id, name: row.name, description: row.description, mimeType: row.mimeType, width: row.width, height: row.height, animated: row.animated, url: await signReadUrl(row.storageKey, row.mimeType, `${row.name}.${extensionFor(row.mimeType)}`, false) };
}

async function ensureCommunityAssetAccess(userId: string, communityId: string, manage = false): Promise<boolean> {
  return manage ? manageAccess(userId, communityId) : memberAccess(userId, communityId);
}

export function createCustomAssetsRouter(io: SocketServer): Router {
  const router = Router();

  router.get('/communities/:communityId/assets', asyncRoute(async (req, res) => {
    const communityId = uuid.safeParse(req.params.communityId);
    if (!communityId.success || !await ensureCommunityAssetAccess((res.locals.user as { id: string }).id, communityId.data)) { res.status(404).json({ error: 'Comunidade não encontrada.' }); return; }
    const [emojiRows, stickerRows] = await Promise.all([
      db.select().from(customEmojis).where(and(eq(customEmojis.communityId, communityId.data), isNull(customEmojis.removedAt))).orderBy(customEmojis.name),
      db.select().from(stickers).where(and(eq(stickers.communityId, communityId.data), isNull(stickers.removedAt))).orderBy(stickers.name),
    ]);
    const community = storageIsConfigured() ? {
      emojis: await Promise.all(emojiRows.map(publicEmoji)),
      stickers: await Promise.all(stickerRows.map(publicSticker)),
    } : { emojis: [], stickers: [] };
    res.json({ available: storageIsConfigured(), mavuno: {
      emojis: BUILTIN_EMOJIS.map((item) => ({ ...item, url: builtinEmojiUrl(item.key) })),
      stickers: BUILTIN_STICKERS.map((item) => ({ ...item, url: builtinStickerUrl(item.key) })),
    }, ...community });
  }));

  async function createAsset(req: Request, res: Parameters<RequestHandler>[1], kind: 'emoji' | 'sticker'): Promise<void> {
    const userId = (res.locals.user as { id: string }).id;
    const communityId = uuid.safeParse(req.params.communityId);
    if (!communityId.success || !await ensureCommunityAssetAccess(userId, communityId.data, true)) { res.status(403).json({ error: 'Não tens permissão para gerir estes ficheiros.' }); return; }
    if (!storageIsConfigured()) { res.status(503).json({ error: STORAGE_UNAVAILABLE }); return; }
    const input = z.object({ name: z.string().min(2).max(32), description: z.string().max(120).optional(), mimeType: z.string().max(120), sizeBytes: z.number().int().positive().max(524288) }).strict().safeParse(req.body);
    if (!input.success || !isCustomAssetName(input.data.name) || !isCustomImageType(input.data.mimeType)) { res.status(400).json({ error: 'Confirma o nome e o tipo de imagem.' }); return; }
    await cleanStalePending();
    const table = kind === 'emoji' ? customEmojis : stickers;
    const limit = kind === 'emoji' ? CUSTOM_EMOJI_LIMIT : CUSTOM_STICKER_LIMIT;
    const [total] = await db.select({ value: count() }).from(table).where(and(eq(table.communityId, communityId.data), isNull(table.removedAt)));
    if (Number(total.value) >= limit) { res.status(409).json({ error: kind === 'emoji' ? 'Atingiste o limite de 50 emojis.' : 'Atingiste o limite de 30 stickers.' }); return; }
    const storageKey = `community-assets/pending/${communityId.data}/${randomUUID().replaceAll('-', '')}.${extensionFor(input.data.mimeType)}`;
    try {
      const created = kind === 'emoji'
        ? await db.insert(customEmojis).values({ communityId: communityId.data, name: input.data.name, storageKey, mimeType: input.data.mimeType, width: 1, height: 1, createdBy: userId }).returning({ id: customEmojis.id })
        : await db.insert(stickers).values({ communityId: communityId.data, name: input.data.name, description: input.data.description ?? '', storageKey, mimeType: input.data.mimeType, width: 1, height: 1, createdBy: userId }).returning({ id: stickers.id });
      const uploadUrl = await signUploadUrl(storageKey, input.data.mimeType);
      res.status(201).json({ assetId: created[0].id, assetType: kind, uploadUrl, expiresIn: 300, headers: { 'Content-Type': input.data.mimeType } });
    } catch {
      res.status(503).json({ error: STORAGE_UNAVAILABLE });
    }
  }

  router.post('/communities/:communityId/emojis', asyncRoute((req, res) => createAsset(req, res, 'emoji')));
  router.post('/communities/:communityId/stickers', asyncRoute((req, res) => createAsset(req, res, 'sticker')));

  router.post('/community-assets/:assetId/confirm', asyncRoute(async (req, res) => {
    const assetId = uuid.safeParse(req.params.assetId);
    const input = z.object({ assetType: z.enum(['emoji', 'sticker']), sizeBytes: z.number().int().positive() }).strict().safeParse(req.body);
    if (!assetId.success || !input.success) { res.status(400).json({ error: 'Não foi possível confirmar este ficheiro.' }); return; }
    if (!storageIsConfigured()) { res.status(503).json({ error: STORAGE_UNAVAILABLE }); return; }
    const userId = (res.locals.user as { id: string }).id;
    const table = input.data.assetType === 'emoji' ? customEmojis : stickers;
    const [row] = await db.select().from(table).where(eq(table.id, assetId.data)).limit(1);
    if (!row || row.createdBy !== userId || row.removedAt || !await manageAccess(userId, row.communityId)) { res.status(404).json({ error: 'Ficheiro não encontrado.' }); return; }
    try {
      const object = await inspectStoredObject(row.storageKey);
      if (object.sizeBytes !== input.data.sizeBytes) { await deleteStoredObject(row.storageKey); await db.delete(table).where(eq(table.id, row.id)); res.status(400).json({ error: 'O tamanho do ficheiro não corresponde.' }); return; }
      const valid = validateCustomImage(input.data.assetType, row.mimeType, object.sizeBytes ?? 0, object.firstBytes);
      if (!valid.ok) { await deleteStoredObject(row.storageKey); await db.delete(table).where(eq(table.id, row.id)); res.status(400).json({ error: valid.reason === 'size' ? 'O ficheiro é demasiado grande.' : valid.reason === 'dimensions' ? 'As dimensões da imagem não são permitidas.' : 'O tipo de ficheiro não é permitido.' }); return; }
      const updated = input.data.assetType === 'emoji'
        ? await db.update(customEmojis).set({ width: valid.width, height: valid.height, animated: valid.animated }).where(eq(customEmojis.id, row.id)).returning()
        : await db.update(stickers).set({ width: valid.width, height: valid.height, animated: valid.animated }).where(eq(stickers.id, row.id)).returning();
      io.to(`community:${row.communityId}`).emit('community-assets:updated', { communityId: row.communityId });
      res.json({ asset: updated[0] });
    } catch { res.status(503).json({ error: STORAGE_UNAVAILABLE }); }
  }));

  router.patch('/communities/:communityId/emojis/:emojiId', asyncRoute(async (req, res) => {
    const input = z.object({ name: z.string().min(2).max(32) }).strict().safeParse(req.body);
    const ids = [uuid.safeParse(req.params.communityId), uuid.safeParse(req.params.emojiId)];
    const userId = (res.locals.user as { id: string }).id;
    if (!input.success || !ids[0].success || !ids[1].success || !isCustomAssetName(input.data.name) || !await manageAccess(userId, req.params.communityId)) { res.status(400).json({ error: 'Nome de emoji inválido ou sem permissão.' }); return; }
    const [updated] = await db.update(customEmojis).set({ name: input.data.name }).where(and(eq(customEmojis.id, ids[1].data), eq(customEmojis.communityId, ids[0].data), isNull(customEmojis.removedAt))).returning();
    if (!updated) { res.status(404).json({ error: 'Emoji não encontrado.' }); return; }
    io.to(`community:${ids[0].data}`).emit('community-assets:updated', { communityId: ids[0].data });
    res.json({ asset: updated });
  }));

  router.patch('/communities/:communityId/stickers/:stickerId', asyncRoute(async (req, res) => {
    const input = z.object({ name: z.string().min(2).max(32), description: z.string().max(120).optional() }).strict().safeParse(req.body);
    const ids = [uuid.safeParse(req.params.communityId), uuid.safeParse(req.params.stickerId)];
    const userId = (res.locals.user as { id: string }).id;
    if (!input.success || !ids[0].success || !ids[1].success || !isCustomAssetName(input.data.name) || !await manageAccess(userId, req.params.communityId)) { res.status(400).json({ error: 'Nome ou descrição inválidos.' }); return; }
    const [updated] = await db.update(stickers).set({ name: input.data.name, ...(input.data.description === undefined ? {} : { description: input.data.description }) }).where(and(eq(stickers.id, ids[1].data), eq(stickers.communityId, ids[0].data), isNull(stickers.removedAt))).returning();
    if (!updated) { res.status(404).json({ error: 'Sticker não encontrado.' }); return; }
    io.to(`community:${ids[0].data}`).emit('community-assets:updated', { communityId: ids[0].data });
    res.json({ asset: updated });
  }));

  async function removeAsset(req: Request, res: Parameters<RequestHandler>[1], kind: 'emoji' | 'sticker'): Promise<void> {
    const communityId = uuid.safeParse(req.params.communityId);
    const assetId = uuid.safeParse(req.params.assetId);
    const userId = (res.locals.user as { id: string }).id;
    if (!communityId.success || !assetId.success || !await manageAccess(userId, communityId.data)) { res.status(403).json({ error: 'Não tens permissão para gerir estes ficheiros.' }); return; }
    const table = kind === 'emoji' ? customEmojis : stickers;
    const [row] = await db.select().from(table).where(and(eq(table.id, assetId.data), eq(table.communityId, communityId.data), isNull(table.removedAt))).limit(1);
    if (!row) { res.status(404).json({ error: 'Ficheiro não encontrado.' }); return; }
    await db.update(table).set({ removedAt: new Date() }).where(eq(table.id, row.id));
    try { if (storageIsConfigured()) await deleteStoredObject(row.storageKey); } catch { console.error('Não foi possível apagar o ficheiro do bucket:', row.id); }
    io.to(`community:${communityId.data}`).emit('community-assets:updated', { communityId: communityId.data });
    res.json({ ok: true });
  }

  router.delete('/communities/:communityId/emojis/:assetId', asyncRoute((req, res) => removeAsset(req, res, 'emoji')));
  router.delete('/communities/:communityId/stickers/:assetId', asyncRoute((req, res) => removeAsset(req, res, 'sticker')));
  return router;
}
