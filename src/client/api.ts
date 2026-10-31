export interface ProfileVisibility { avatar: boolean; about: boolean; status: boolean; joinDate: boolean; commonCommunities: boolean; email: boolean }
export interface User { id: string; username: string; email: string; avatarUrl: string | null; aboutMe?: string; createdAt?: string; visibility?: ProfileVisibility }
export interface OwnProfile extends User { aboutMe: string; createdAt: string; visibility: ProfileVisibility }
export interface OwnProfileResponse { user: OwnProfile; communities: Array<{ id: string; name: string; role: string; joinedAt: string }> }
export interface MemberProfile { id: string; username: string; avatarUrl?: string | null; aboutMe?: string; online?: boolean; createdAt?: string; commonCommunities?: Array<{ id: string; name: string }>; email?: string }
export interface Community { id: string; name: string; slug: string; description: string; category: string; imageUrl?: string | null; rules?: string; isPrivate: boolean; role?: string | null }
export interface Channel { id: string; name: string; topic: string; kind: 'text' | 'voice' }
export interface Member { id: string; username: string; avatarUrl?: string | null; role: string; mutedUntil?: string | null; banned?: boolean }
export interface CommunityDetails { community: Community; myRole: string | null; members: Member[]; channels: Channel[] }
export interface ReactionSummary { emoji: string; count: number; reactedByMe: boolean }
export interface Message { id: string; clientMessageId: string; body: string; replyToId: string | null; replyAuthor?: string | null; replyBody?: string | null; createdAt: string; pinnedAt?: string | null; pinnedBy?: string | null; authorId: string; username: string; avatarUrl?: string | null; reactions?: ReactionSummary[]; delivery?: 'sending' | 'failed' }
export type PrivateCallStatus = 'initiated' | 'ringing' | 'accepted' | 'connecting' | 'in_progress' | 'rejected' | 'timeout' | 'failed' | 'ended';
export interface PrivateCall { id: string; status: PrivateCallStatus; peer?: { id: string; username: string; avatarUrl?: string | null } }
let csrfToken = '';
const sessionEvent = () => window.dispatchEvent(new CustomEvent('mavuno:session-expired'));
function friendlyFailure(status: number, raw?: string): string {
  const message = (raw ?? '').trim();
  if (/livekit|token|socket|postgres|database|sql|stack|server|\bundefined\b|\bnull\b|\bNaN\b|\b\d{3}\b|^\s*[{[]/i.test(message)) return 'A voz ainda não está disponível. Tenta mais tarde.';
  if (message && message.length < 240) return message;
  if (status === 401) return 'A tua sessão terminou. Inicia sessão novamente.';
  if (status === 403) return 'Não tens permissão para fazer esta ação.';
  if (status === 404) return 'Não foi possível encontrar este conteúdo.';
  if (status === 409) return 'Esta ação já não está disponível. Atualiza e tenta novamente.';
  if (status >= 500) return 'Ocorreu um problema. Tenta novamente mais tarde.';
  return 'Não foi possível concluir esta ação. Confirma os dados e tenta novamente.';
}
async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try { return await fetch(input, init); }
  catch { throw new Error('Sem ligação. A tentar novamente...'); }
}
export async function prepareCsrf(): Promise<void> {
  const response = await safeFetch('/api/auth/csrf', { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error(friendlyFailure(response.status));
  const data = await response.json().catch(() => null) as { token?: string } | null;
  if (!data?.token) throw new Error('Não foi possível preparar a sessão. Tenta novamente.');
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
  const response = await safeFetch(path.startsWith('/api/') ? path : `/api${path}`, {
    ...options, method, headers, credentials: 'include', cache: 'no-store',
  });
  const data = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) {
    if (response.status === 401 && !/\/auth\/(?:login|register|csrf|me)$/.test(path)) sessionEvent();
    throw new Error(friendlyFailure(response.status, data?.error));
  }
  if (data === null) throw new Error('A resposta não foi recebida corretamente. Tenta novamente.');
  return data;
}
