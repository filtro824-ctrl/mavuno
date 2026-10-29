import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response, CookieOptions } from 'express';

const scrypt = promisify(scryptCallback);
export const SESSION_COOKIE = 'mavuno_session';
const CSRF_COOKIE = 'mavuno_csrf';
const SESSION_DAYS = 30;
const cookieSecure = process.env.COOKIE_SECURE !== 'false';
const sameSite = (process.env.COOKIE_SAME_SITE === 'lax' ? 'lax' : 'none') as 'lax' | 'none';
const baseCookie: CookieOptions = { secure: cookieSecure, sameSite, path: '/', httpOnly: true };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, saltHex, keyHex] = stored.split('$');
  if (algorithm !== 'scrypt' || !saltHex || !keyHex) return false;
  try {
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), 64) as Buffer;
    const expected = Buffer.from(keyHex, 'hex');
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

export function createOpaqueToken(): string { return randomBytes(32).toString('base64url'); }
export function digestToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, { ...baseCookie, maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000 });
}
export function clearSessionCookie(res: Response): void { res.clearCookie(SESSION_COOKIE, baseCookie); }
export function setCsrfCookie(res: Response, token: string): void {
  res.cookie(CSRF_COOKIE, token, { ...baseCookie, httpOnly: false, maxAge: 24 * 60 * 60 * 1000 });
}

export function readCookieValue(header: string | undefined, cookieName: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === cookieName) {
      try { return decodeURIComponent(value.join('=')); } catch { return undefined; }
    }
  }
  return undefined;
}
export function readSessionCookie(req: Request): string | undefined {
  return readCookieValue(req.headers.cookie, SESSION_COOKIE);
}

export function requireCsrf(req: Request, res: Response, next: (err?: unknown) => void): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const cookie = readCookieValue(req.headers.cookie, CSRF_COOKIE);
  const header = req.get('x-csrf-token');
  if (!cookie || !header || cookie.length !== header.length || !timingSafeEqual(Buffer.from(cookie), Buffer.from(header))) {
    res.status(403).json({ error: 'Proteção CSRF: atualize a página e tente novamente.' });
    return;
  }
  next();
}
