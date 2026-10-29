export interface User { id: string; username: string; email: string; avatarUrl: string | null }
export interface Community { id: string; name: string; slug: string; description: string; category: string; isPrivate: boolean; role?: string | null }
export interface Channel { id: string; name: string; topic: string; kind: 'text' | 'voice' }
export interface Member { id: string; username: string; avatarUrl: string | null; role: string }
export interface CommunityDetails { community: Community; myRole: string | null; members: Member[]; channels: Channel[] }
export interface Message { id: string; clientMessageId: string; body: string; replyToId: string | null; createdAt: string; authorId: string; username: string; avatarUrl: string | null; delivery?: 'sending' | 'failed' }
let csrfToken = '';

export async function prepareCsrf(): Promise<void> {
  const response = await fetch('/api/auth/csrf', { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error('Não foi possível preparar a sessão segura.');
  const data = await response.json() as { token: string };
  csrfToken = data.token;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (!csrfToken) await prepareCsrf();
    headers.set('X-CSRF-Token', csrfToken);
  }
  const response = await fetch(path.startsWith('/api/') ? path : `/api${path}`, {
    ...options, method, headers, credentials: 'include', cache: 'no-store',
  });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `O pedido falhou (${response.status}).`);
  return data;
}
