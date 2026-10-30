import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { authenticateCookie, createApi } from './api.js';
import { db, pool } from './db/index.js';
import { channels, communityBans, communityMembers, communityMutes, sessions } from './db/schema.js';
import { readCookieValue, readSessionCookie, requireCsrf } from './security.js';
import { isMember } from './permissions.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const app = express();
const server = createServer(app);
const io = new Server(server, {
  serveClient: true,
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 25_000,
  pingTimeout: 20_000,
  allowRequest: (request, callback) => {
    const origin = request.headers.origin;
    if (!origin) { callback(null, true); return; }
    const forwardedHost = request.headers['x-forwarded-host'];
    const requestHost = (typeof forwardedHost === 'string' ? forwardedHost.split(',')[0] : request.headers.host)?.trim();
    try { callback(null, Boolean(requestHost) && new URL(origin).host === requestHost); }
    catch { callback(null, false); }
  },
});
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  frameguard: false,
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: process.env.NODE_ENV === 'production' ? ["'self'"] : ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'", 'ws:', 'wss:'],
    mediaSrc: ["'self'", 'blob:'],
    workerSrc: ["'self'", 'blob:'],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    frameAncestors: ['https://*.manus.computer', 'https://*.manus.space'],
  } },
}));
app.use(express.json({ limit: '16kb', strict: true }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  void authenticateCookie(readSessionCookie(req)).then((user) => {
    if (user) res.locals.user = user;
    next();
  }).catch(next);
});

const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Demasiadas tentativas. Tenta novamente mais tarde.' } });
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api', requireCsrf);
app.use('/api', createApi(io));

io.use((socket, next) => {
  void authenticateCookie(readCookieValue(socket.handshake.headers.cookie, 'mavuno_session')).then((user) => {
    if (!user) { next(new Error('Autenticação necessária')); return; }
    socket.data.user = user;
    next();
  }).catch(() => next(new Error('Não foi possível validar a sessão')));
});
io.on('connection', (socket) => {
  const user = socket.data.user as { id: string };
  socket.join(`user:${user.id}`);
  let lastJoin = 0;
  socket.on('channel:join', (payload: unknown) => {
    const channelId = typeof payload === 'object' && payload !== null && 'channelId' in payload ? (payload as { channelId?: unknown }).channelId : null;
    if (typeof channelId !== 'string' || !/^[0-9a-f-]{36}$/i.test(channelId)) return;
    if (Date.now() - lastJoin < 250) { socket.emit('room:error', { error: 'Espera um instante antes de mudar de canal.' }); return; }
    lastJoin = Date.now();
    void (async () => {
      const [channel] = await db.select({ id: channels.id, communityId: channels.communityId, kind: channels.kind }).from(channels).where(eq(channels.id, channelId)).limit(1);
      const [ban] = channel ? await db.select({ id: communityBans.id }).from(communityBans).where(and(eq(communityBans.communityId, channel.communityId), eq(communityBans.userId, user.id), isNull(communityBans.revokedAt))).limit(1) : [];
      const [mute] = channel ? await db.select({ expiresAt: communityMutes.expiresAt }).from(communityMutes).where(and(eq(communityMutes.communityId, channel.communityId), eq(communityMutes.userId, user.id), isNull(communityMutes.revokedAt), gt(communityMutes.expiresAt, new Date()))).limit(1) : [];
      if (!channel || !await isMember(user.id, channel.communityId) || ban) { socket.emit('room:error', { error: 'Não tens acesso a este canal.' }); return; }
      if (mute && channel.kind === 'voice') { socket.emit('room:error', { error: 'Estás silenciado nesta comunidade.' }); return; }
      for (const room of socket.rooms) if (room.startsWith('channel:')) await socket.leave(room);
      const room = `channel:${channel.id}`;
      await socket.join(room);
      if (!await isMember(user.id, channel.communityId)) {
        await socket.leave(room);
        socket.emit('room:error', { error: 'Não tens acesso a este canal.' });
      }
    })().catch(() => socket.emit('room:error', { error: 'Não foi possível abrir o canal em tempo real.' }));
  });
  socket.on('disconnect', () => undefined);
});

const publicDir = resolve(root, 'public');
const clientDir = resolve(root, 'dist/client');
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(publicDir, { fallthrough: true, maxAge: '1h' }));
  app.use(express.static(clientDir, { fallthrough: true, maxAge: '1h', index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) { res.status(404).json({ error: 'Não encontrado.' }); return; }
    res.sendFile(resolve(clientDir, 'index.html'), (error) => { if (error) next(error); });
  });
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', configFile: resolve(root, 'vite.config.ts') });
  app.use(vite.middlewares);
  app.use(express.static(publicDir, { fallthrough: true }));
  app.get('*', async (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) { res.status(404).json({ error: 'Não encontrado.' }); return; }
    try {
      const template = await import('node:fs/promises').then((fs) => fs.readFile(resolve(root, 'src/client/index.html'), 'utf8'));
      res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(await vite.transformIndexHtml(req.originalUrl, template));
    } catch (error) { next(error); }
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('HTTP request failed:', error instanceof Error ? error.message : 'unknown error');
  if (!res.headersSent) res.status(500).json({ error: 'Erro interno do servidor.' });
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => console.log(`Mavuno listening on port ${port}`));

async function shutdown(): Promise<void> {
  io.close();
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
