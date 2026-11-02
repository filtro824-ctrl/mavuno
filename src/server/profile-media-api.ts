import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db/index.js';
import { communityMembers, users } from './db/schema.js';
import { signatureMatches } from './attachment-utils.js';
import {
  PROFILE_MEDIA_MAX_BYTES,
  makeProfileMediaReference,
  profileMediaStagingObjectKey,
} from './profile-media-utils.js';
import { deleteStoredObject, signReadUrl, signUploadUrl, storageIsConfigured } from './storage.js';

const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { void handler(req, res).catch(next); };
const uuid = z.string().uuid();
const imageKind = z.enum(['avatar', 'banner']);
const MEDIA_UNAVAILABLE = 'O envio de imagens ainda não está disponível. Tenta mais tarde.';

export function createProfileMediaRouter(): Router {
  const router = Router();

  router.get('/profile/media/availability', (_req, res) => {
    res.json({ available: storageIsConfigured() });
  });

  router.post('/profile/media/upload', asyncRoute(async (req, res) => {
    const input = z.object({
      kind: imageKind,
      mimeType: z.literal('image/jpeg'),
      sizeBytes: z.number().int().positive().max(PROFILE_MEDIA_MAX_BYTES),
    }).strict().safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'A imagem não é válida ou é demasiado grande.' }); return; }
    if (!storageIsConfigured()) { res.status(503).json({ error: MEDIA_UNAVAILABLE }); return; }
    const userId = (res.locals.user as { id: string }).id;
    const uploadId = randomUUID();
    const storageKey = profileMediaStagingObjectKey(userId, input.data.kind, uploadId);
    try {
      const uploadUrl = await signUploadUrl(storageKey, input.data.mimeType);
      res.status(201).json({ uploadId, uploadUrl, expiresIn: 300, headers: { 'Content-Type': input.data.mimeType } });
    } catch {
      res.status(503).json({ error: MEDIA_UNAVAILABLE });
    }
  }));

  router.delete('/profile/media/upload/:kind/:uploadId', asyncRoute(async (req, res) => {
    const kind = imageKind.safeParse(req.params.kind);
    const uploadId = uuid.safeParse(req.params.uploadId);
    if (!kind.success || !uploadId.success) { res.status(404).json({ error: 'Envio não encontrado.' }); return; }
    const userId = (res.locals.user as { id: string }).id;
    try {
      await deleteStoredObject(profileMediaStagingObjectKey(userId, kind.data, uploadId.data));
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: MEDIA_UNAVAILABLE });
    }
  }));

  router.get('/profile-media/:userId/:kind/:assetId', asyncRoute(async (req, res) => {
    const userId = uuid.safeParse(req.params.userId);
    const kind = imageKind.safeParse(req.params.kind);
    const assetId = uuid.safeParse(req.params.assetId);
    if (!userId.success || !kind.success || !assetId.success) { res.status(404).end(); return; }
    const [owner] = await db.select({
      avatarUrl: users.avatarUrl,
      bannerUrl: users.bannerUrl,
      showAvatar: users.showAvatar,
      showBanner: users.showBanner,
    }).from(users).where(eq(users.id, userId.data)).limit(1);
    const reference = makeProfileMediaReference(userId.data, kind.data, assetId.data);
    const currentReference = kind.data === 'avatar' ? owner?.avatarUrl : owner?.bannerUrl;
    if (!owner || currentReference !== reference) { res.status(404).end(); return; }

    const viewerId = (res.locals.user as { id: string }).id;
    if (viewerId !== userId.data) {
      const visible = kind.data === 'avatar' ? owner.showAvatar : owner.showBanner;
      if (!visible) { res.status(404).end(); return; }
      const viewerCommunities = await db.select({ communityId: communityMembers.communityId })
        .from(communityMembers).where(eq(communityMembers.userId, viewerId));
      if (viewerCommunities.length === 0) { res.status(404).end(); return; }
      const ownerCommunities = await db.select({ communityId: communityMembers.communityId })
        .from(communityMembers).where(eq(communityMembers.userId, userId.data));
      const sharedCommunity = ownerCommunities.some((item) => viewerCommunities.some((membership) => membership.communityId === item.communityId));
      if (!sharedCommunity) { res.status(404).end(); return; }
    }
    if (!storageIsConfigured()) { res.status(404).end(); return; }
    const storageKey = `profile-media/${userId.data}/${kind.data}/${assetId.data}.jpg`;
    let readUrl: string;
    try { readUrl = await signReadUrl(storageKey, 'image/jpeg', `${kind.data}.jpg`, false, 300); }
    catch { res.status(503).json({ error: MEDIA_UNAVAILABLE }); return; }
    res.set('Cache-Control', 'private, no-store');
    res.set('Vary', 'Cookie');
    res.redirect(302, readUrl);
  }));

  return router;
}
