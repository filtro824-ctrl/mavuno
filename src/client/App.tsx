import { type ChangeEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { io } from 'socket.io-client';
import type { Room, RemoteParticipant } from 'livekit-client';
import { api, prepareCsrf, type ActiveInvitation, type Channel, type ChannelCategory, type Community, type CommunityDetails, type InviteDuration, type InvitePreview, type InviteUseLimit, type JoinFlowInfo, type JoinRequest, type Member, type MemberProfile, type Message, type MessageAttachment, type OwnProfileResponse, type PrivateCall, type PrivateCallStatus, type ProfileVisibility, type ReactionSummary, type User, type CommunityAssetsResponse, type CommunityAsset } from './api';
import { EMOJI_CATEGORIES, EMOJI_INDEX, type EmojiCategoryId } from './emoji-data';
import { toggleReactionSummary } from './reaction-state';
import { applyDeafenState, audioOutputVolume, DEFAULT_AUDIO_PREFERENCES, microphoneConstraints, readAudioPreferences, writeAudioPreferences, type AudioPreferences, type VoiceProfile } from './audio-preferences';
import { ActionMenuOverlay, MessageRow, ModerationPrompt, rectFor, type ActionMenuTarget, type DurationChoice, type MenuRect } from './message-actions';
import { ATTACHMENT_TYPES, validateAttachmentMetadata, type AttachmentKind } from '../server/attachment-utils';
import { profileMediaReferenceOwnedBy, type ProfileMediaKind } from '../server/profile-media-utils';
import { clampFloatingPosition, FLOATING_BUTTON_SIZE, floatingTuckOffset, nearestFloatingSide, type FloatingSide } from './floating-button-utils';
import { ProfileImageCropper } from './profile-image-cropper';
import { AssetReaction, CommunityEmojiPicker, CommunityStickerPicker, InlineEmojiText, MessageStickerView } from './community-assets';
import CustomAssetsManager from './custom-assets-ui';
import { DirectMessagesView } from './direct-messages';

type ModalType = 'community' | 'channel' | 'profile' | 'memberProfile' | 'account' | 'settings' | 'admin' | null;
type PendingAttachment = { key: string; file: File; previewUrl: string; mimeType: string; kind: AttachmentKind; width: number | null; height: number | null; attachmentId?: string; progress: number; status: 'queued' | 'uploading' | 'ready' | 'failed'; error?: string };
type ProfileSaveData = { username: string; avatarUrl: string | null; avatarFile?: File; aboutMe: string; bannerUrl: string | null; bannerFile?: File; bannerColor: string | null; statusText: string; presencePreference: 'online' | 'away' | 'dnd' | 'invisible'; visibility: ProfileVisibility };
type FloatingPosition = { side: FloatingSide; top: number };
type FloatingDragState = { pointerId: number; startX: number; startY: number; startLeft: number; startTop: number; moved: boolean };
const FLOATING_POSITION_KEY = 'mavuno-floating-button-position-v1';
const INVITE_RETURN_KEY = 'mavuno-invite-return-v1';
const roleLabels: Record<string, string> = { owner: 'Proprietário', admin: 'Administrador', moderator: 'Moderador', member: 'Membro' };
const COVER_COLORS = ['#234B3B', '#356859', '#355070', '#4A4E69', '#6D597A', '#9B5DE5', '#C44536', '#E07A5F', '#D4A373', '#6B705C', '#264653', '#374151'];

function readInviteToken(): string | null {
  const match = window.location.pathname.match(/^\/invite\/([\w-]{32,64})$/);
  if (match) {
    try { window.sessionStorage.setItem(INVITE_RETURN_KEY, match[1]); } catch { /* deep link still works from the URL */ }
    return match[1];
  }
  try {
    const saved = window.sessionStorage.getItem(INVITE_RETURN_KEY);
    if (saved && /^[\w-]{32,64}$/.test(saved) && window.location.pathname === '/') {
      window.history.replaceState({}, '', `/invite/${saved}`);
      return saved;
    }
  } catch { /* session storage is optional */ }
  return null;
}

function clearInviteReturn(token: string | null): void {
  if (!token) return;
  try { if (window.sessionStorage.getItem(INVITE_RETURN_KEY) === token) window.sessionStorage.removeItem(INVITE_RETURN_KEY); } catch { /* optional storage */ }
  if (window.location.pathname === `/invite/${token}`) window.history.replaceState({}, '', '/');
}

function maxFloatingTop(): number { return Math.max(0, window.innerHeight - FLOATING_BUTTON_SIZE); }
function readFloatingPosition(): FloatingPosition {
  const fallback = { side: 'right' as const, top: Math.max(0, window.innerHeight - FLOATING_BUTTON_SIZE - 82) };
  try {
    const raw = window.localStorage.getItem(FLOATING_POSITION_KEY);
    if (!raw) return fallback;
    const stored = JSON.parse(raw) as { side?: unknown; topRatio?: unknown };
    if ((stored.side !== 'left' && stored.side !== 'right') || typeof stored.topRatio !== 'number' || !Number.isFinite(stored.topRatio)) return fallback;
    return { side: stored.side, top: Math.max(0, Math.min(1, stored.topRatio)) * maxFloatingTop() };
  } catch { return fallback; }
}

function inferredMimeType(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const extension = file.name.split('.').pop()?.toLowerCase();
  return Object.entries(ATTACHMENT_TYPES).find(([, rule]) => rule.extensions.includes(extension ?? ''))?.[0] ?? '';
}

async function prepareAttachmentFile(file: File, mimeType: string): Promise<{ file: File; width: number | null; height: number | null }> {
  const typedFile = file.type.toLowerCase() === mimeType ? file : new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return { file: typedFile, width: null, height: null };
  try {
    const bitmap = await createImageBitmap(typedFile);
    const width = bitmap.width;
    const height = bitmap.height;
    const largestSide = Math.max(width, height);
    if (largestSide <= 1600) { bitmap.close(); return { file: typedFile, width, height }; }
    const scale = 1600 / largestSide;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) { bitmap.close(); return { file: typedFile, width, height }; }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, 0.85));
    if (!blob || blob.type !== mimeType) return { file: typedFile, width, height };
    return { file: new File([blob], file.name, { type: mimeType, lastModified: file.lastModified }), width: canvas.width, height: canvas.height };
  } catch { return { file: typedFile, width: null, height: null }; }
}

function uploadWithProgress(url: string, file: File, mimeType: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.setRequestHeader('Content-Type', mimeType);
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100)); };
    request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error('Não foi possível enviar este ficheiro. Tenta novamente.'));
    request.onerror = () => reject(new Error('Não foi possível enviar este ficheiro. Tenta novamente.'));
    request.onabort = () => reject(new Error('O envio foi interrompido. Tenta novamente.'));
    request.send(file);
  });
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(0)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
function durationLabel(duration: DurationChoice): string {
  if (!duration) return 'permanentemente';
  const unit = duration.unit === 'minutes' ? (duration.amount === 1 ? 'minuto' : 'minutos') : duration.unit === 'hours' ? (duration.amount === 1 ? 'hora' : 'horas') : (duration.amount === 1 ? 'dia' : 'dias');
  return `${duration.amount} ${unit}`;
}
function banExpiryLabel(expiresAt: string | null): string {
  if (!expiresAt) return 'Permanente';
  const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
  if (seconds === 0) return 'A terminar';
  const days = Math.floor(seconds / 86400);
  if (days > 0) return `Termina em ${days} ${days === 1 ? 'dia' : 'dias'}`;
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) return `Termina em ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Termina em ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
}

function initials(value: string): string {
  return value.trim().slice(0, 1).toUpperCase() || '?';
}
function fallbackBannerColor(name: string): string {
  let hash = 0;
  for (const character of name.trim().toLowerCase()) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 28% 28%)`;
}
function formatTime(value: string): string {
  return new Intl.DateTimeFormat('pt-MZ', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
function mergeMessage(list: Message[], item: Message): Message[] {
  const filtered = list.filter((message) => message.id !== item.id && message.clientMessageId !== item.clientMessageId);
  return [...filtered, item].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
function refreshVisibleIdentity<T extends { username: string; avatarUrl?: string | null }>(current: T, profile: MemberProfile): T {
  const next = { ...current, username: profile.username };
  if (Object.hasOwn(profile, 'avatarUrl')) next.avatarUrl = profile.avatarUrl;
  else delete next.avatarUrl;
  return next;
}
async function releaseLiveKitRoom(room: Room | null): Promise<void> {
  if (!room) return;
  try { await room.localParticipant.setMicrophoneEnabled(false); } catch { /* release continues even if permission was revoked */ }
  try { await room.disconnect(); } catch { /* device tracks have already been stopped */ }
}
function Avatar({ name, url, size }: { name: string; url?: string | null; size?: number }) {
  return <span className="avatar" style={size ? { width: size, height: size, fontSize: Math.max(10, size * .36) } : undefined}>
    {url ? <img src={url} alt="" referrerPolicy="no-referrer" loading="lazy"/> : initials(name)}
  </span>;
}
function AttachmentGallery({ attachments, onDownload, notify }: { attachments: MessageAttachment[]; onDownload: (attachment: MessageAttachment) => Promise<void> | void; notify: (text: string) => void }) {
  const signature = attachments.map((item) => `${item.id}:${item.url}`).join('|');
  const [urls, setUrls] = useState<Record<string, string>>(() => Object.fromEntries(attachments.map((item) => [item.id, item.url])));
  const [viewerId, setViewerId] = useState<string | null>(null);
  const retriedIds = useRef(new Set<string>());
  useEffect(() => {
    setUrls(Object.fromEntries(attachments.map((item) => [item.id, item.url])));
    retriedIds.current.clear();
  }, [signature]);
  useEffect(() => {
    if (!viewerId) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setViewerId(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [viewerId]);
  const renew = async (attachment: MessageAttachment) => {
    if (retriedIds.current.has(attachment.id)) return;
    retriedIds.current.add(attachment.id);
    try {
      const result = await api<{ url: string }>(`/attachments/${attachment.id}/url`);
      setUrls((current) => ({ ...current, [attachment.id]: result.url }));
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível abrir este anexo.'); }
  };
  const viewer = attachments.find((item) => item.id === viewerId);
  if (!attachments.length) return null;
  return <>
    <div className="attachment-gallery">
      {attachments.map((item) => {
        const url = urls[item.id] ?? item.url;
        const ratio = item.width && item.height ? `${item.width} / ${item.height}` : '16 / 9';
        if (item.mimeType.startsWith('image/')) return <button key={item.id} type="button" className="attachment-image-button" style={{ aspectRatio: ratio }} aria-label={`Abrir imagem ${item.originalName}`} onClick={() => setViewerId(item.id)}><img src={url} alt={item.originalName} loading="lazy" onError={() => void renew(item)}/></button>;
        if (item.mimeType.startsWith('video/')) return <video key={item.id} className="attachment-video" style={{ aspectRatio: ratio }} src={url} controls playsInline preload="none" aria-label={item.originalName} onError={() => void renew(item)}/>;
        const extension = item.originalName.split('.').pop()?.toUpperCase().slice(0, 5) || 'FILE';
        return <div className="attachment-document" key={item.id}><span className="attachment-document-icon" aria-hidden="true">{extension}</span><span className="attachment-document-meta"><strong title={item.originalName}>{item.originalName}</strong><small>{formatFileSize(item.sizeBytes)}</small></span><button type="button" className="secondary attachment-download-button" onClick={() => void onDownload(item)}>Descarregar</button></div>;
      })}
    </div>
    {viewer && createPortal(<div className="attachment-viewer" role="dialog" aria-modal="true" aria-label={`Imagem ${viewer.originalName}`} onMouseDown={(event) => { if (event.target === event.currentTarget) setViewerId(null); }}><button type="button" className="attachment-viewer-close" aria-label="Fechar imagem" onClick={() => setViewerId(null)}>×</button><img src={urls[viewer.id] ?? viewer.url} alt={viewer.originalName} onError={() => void renew(viewer)}/></div>, document.body)}
  </>;
}
function Brand() {
  return <div className="brand-lockup"><span className="brand-mark">m</span><span>Mavuno</span></div>;
}
function Glyph({ name }: { name: 'mic' | 'headphones' | 'settings' | 'chevron' | 'close' | 'back' }) {
  const paths = {
    mic: <><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/></>,
    headphones: <><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><path d="M4 14h3v6H5a1 1 0 0 1-1-1zM20 14h-3v6h2a1 1 0 0 0 1-1z"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.7 1.7-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-2.4v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L8 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H6v-2.4h.8a1.7 1.7 0 0 0 1.6-1A1.7 1.7 0 0 0 8.1 8L8 7.9l1.7-1.7.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2h2.4V5a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 8l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v2.4H21a1.7 1.7 0 0 0-1.6 1z"/></>,
    chevron: <path d="m8 10 4 4 4-4"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    back: <path d="m15 5-7 7 7 7M8 12h12"/>,
  };
  return <svg className="inline-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(() => readInviteToken());
  const [invitePreview, setInvitePreview] = useState<InvitePreview | null>(null);
  const [invitePreviewError, setInvitePreviewError] = useState('');
  const [invitePreviewLoading, setInvitePreviewLoading] = useState(false);
  useEffect(() => { const expired = () => { setSessionExpired(true); setUser(null); }; window.addEventListener('mavuno:session-expired', expired); return () => window.removeEventListener('mavuno:session-expired', expired); }, []);

  useEffect(() => {
    void (async () => {
      try {
        await prepareCsrf();
        const result = await api<{ user: User }>('/auth/me');
        setUser(result.user);
      } catch {
        setUser(null);
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!inviteToken) { setInvitePreview(null); setInvitePreviewError(''); return; }
    let active = true;
    setInvitePreviewLoading(true); setInvitePreviewError(''); setInvitePreview(null);
    void api<InvitePreview>(`/invites/${encodeURIComponent(inviteToken)}/preview`)
      .then((result) => { if (active) setInvitePreview(result); })
      .catch((cause) => { if (active) setInvitePreviewError(cause instanceof Error ? cause.message : 'Este convite já não é válido.'); })
      .finally(() => { if (active) setInvitePreviewLoading(false); });
    return () => { active = false; };
  }, [inviteToken]);

  const clearInvite = () => { clearInviteReturn(inviteToken); setInviteToken(null); setInvitePreview(null); setInvitePreviewError(''); };

  if (checking) return <main className="boot-screen"><span className="brand-mark">m</span><p>A preparar as conversas…</p></main>;
  if (!user && inviteToken) return <InviteEntryScreen preview={invitePreview} error={invitePreviewError} loading={invitePreviewLoading} notice={sessionExpired ? 'A tua sessão terminou. Inicia sessão novamente.' : ''} onClear={clearInvite} onAuthed={(next) => { setSessionExpired(false); setUser(next); }}/>
  if (!user) return <AuthScreen notice={sessionExpired ? 'A tua sessão terminou. Inicia sessão novamente.' : ''} onAuthed={(next) => { setSessionExpired(false); setUser(next); }}/>
  return <Dashboard user={user} onUserChange={setUser} onLogout={() => setUser(null)} inviteToken={inviteToken} onClearInvite={clearInvite}/>;
}

function InvitePreviewCard({ preview }: { preview: InvitePreview }) {
  const [failed, setFailed] = useState(false);
  const image = preview.coverUrl ?? preview.imageUrl;
  useEffect(() => setFailed(false), [image]);
  return <article className="invite-preview-card">
    <div className={`invite-preview-cover ${!image || failed ? 'invite-preview-fallback' : ''}`} style={{ backgroundColor: preview.coverColor ?? '#193124' }} aria-hidden="true">{image && !failed ? <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}/> : 'm'}</div>
    <div className="invite-preview-copy"><span className="muted">Convite para a comunidade</span><h2>{preview.name}</h2><p>{preview.description || 'Uma comunidade Mavuno.'}</p><small>{preview.memberCount} {preview.memberCount === 1 ? 'membro' : 'membros'}</small></div>
  </article>;
}

function InviteEntryScreen({ preview, error, loading, notice, onClear, onAuthed }: { preview: InvitePreview | null; error: string; loading: boolean; notice: string; onClear: () => void; onAuthed: (user: User) => void }) {
  const [authMode, setAuthMode] = useState<'login' | 'register' | null>(null);
  if (authMode) return <AuthScreen initialMode={authMode} invitePreview={preview ?? undefined} notice={notice} onBack={() => setAuthMode(null)} onAuthed={onAuthed}/>;
  return <main className="auth-wrap"><section className="auth-card invite-entry-card"><Brand/>
    {loading ? <div className="empty-state">A verificar o convite…</div> : preview ? <><InvitePreviewCard preview={preview}/><p className="muted">Inicia sessão ou cria uma conta para veres a mensagem de boas-vindas e pedires entrada.</p><div className="invite-entry-actions"><button className="primary" onClick={() => setAuthMode('login')}>Entrar</button><button className="secondary" onClick={() => setAuthMode('register')}>Criar conta</button></div></> : <><h1>Convite indisponível</h1><p className="error-banner" role="status">{error || 'Este convite já não é válido.'}</p><button className="secondary" onClick={onClear}>Ir para o Mavuno</button></>}
  </section></main>;
}

function AuthScreen({ onAuthed, notice, initialMode = 'login', invitePreview, onBack }: { onAuthed: (user: User) => void; notice?: string; initialMode?: 'login' | 'register'; invitePreview?: InvitePreview; onBack?: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const body: Record<string, string> = {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    };
    if (mode === 'register') body.username = String(form.get('username') ?? '');
    try {
      await prepareCsrf();
      const result = await api<{ user: User }>(`/auth/${mode}`, { method: 'POST', body: JSON.stringify(body) });
      onAuthed(result.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível iniciar sessão.');
    } finally {
      setBusy(false);
    }
  };

  return <main className="auth-wrap"><section className="auth-card">
    <Brand/>
    {invitePreview && <><InvitePreviewCard preview={invitePreview}/>{onBack && <button type="button" className="text-button invite-back-button" onClick={onBack}>← Voltar ao convite</button>}</>}
    <h1>{mode === 'login' ? 'Continua a conversa' : 'Cria a tua conta'}</h1>
    <p className="muted">Comunidades leves, mesmo em ligações modestas.</p>
    {notice && <div className="notice" role="status">{notice}</div>}
    {error && <div className="error-banner" role="alert">{error}</div>}
    <form onSubmit={(event) => void submit(event)}>
      {mode === 'register' && <label className="field">Nome de utilizador<input name="username" minLength={3} maxLength={32} autoComplete="username" required placeholder="ex.: amina"/></label>}
      <label className="field">Email<input name="email" type="email" maxLength={254} autoComplete="email" required placeholder="nome@exemplo.com"/></label>
      <label className="field">Palavra-passe<input name="password" type="password" minLength={mode === 'register' ? 12 : 1} maxLength={200} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required placeholder={mode === 'register' ? 'Pelo menos 12 caracteres' : 'A tua palavra-passe'}/></label>
      <button className="primary" disabled={busy}>{busy ? 'A verificar…' : mode === 'login' ? 'Iniciar sessão' : 'Criar conta'}</button>
    </form>
    <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
      {mode === 'login' ? 'Ainda não tens conta?' : 'Já tens conta?'}{' '}
      <button className="text-button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
        {mode === 'login' ? 'Criar conta' : 'Iniciar sessão'}
      </button>
    </p>
    <p className="muted" style={{ fontSize: 11 }}>A recuperação de conta ainda não está disponível.</p>
  </section></main>;
}

const CATEGORY_COLLAPSE_KEY = 'mavuno.channel-categories-collapsed.v1';

function CommunityCover({ community, compact = false }: { community: Pick<Community, 'name' | 'coverUrl' | 'coverColor'>; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [community.coverUrl]);
  return <div className={`community-cover ${compact ? 'community-cover-compact' : ''}`} style={{ backgroundColor: community.coverColor ?? '#234b3b' }}>
    {community.coverUrl && !failed && <img src={community.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}/>}
    <strong>{community.name}</strong>
  </div>;
}

function ChannelSidebar({ channels, categories, current, canManage, onSelect, onDelete }: { channels: Channel[]; categories: ChannelCategory[]; current: Channel | null; canManage: boolean; onSelect: (channel: Channel) => void; onDelete: (channel: Channel) => void }) {
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try { const value = JSON.parse(localStorage.getItem(CATEGORY_COLLAPSE_KEY) ?? '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []; }
    catch { return []; }
  });
  const toggle = (id: string) => setCollapsed((current) => {
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    try { localStorage.setItem(CATEGORY_COLLAPSE_KEY, JSON.stringify(next)); } catch { /* recolher continua disponível nesta sessão */ }
    return next;
  });
  const renderChannel = (item: Channel) => <div className="channel-manage-row" key={item.id}>
    <button className={`channel-row ${current?.id === item.id ? 'active' : ''} ${item.unreadCount ? 'channel-unread' : ''}`} onClick={() => onSelect(item)}>
      <span title={item.readOnly ? 'Canal só de leitura' : undefined} aria-label={item.readOnly ? 'Canal só de leitura' : undefined}>{item.kind === 'voice' ? '◖' : item.readOnly ? '🔒' : '#'}</span><span className="channel-row-name">{item.name}</span>
      {item.unreadCount ? item.hasMention ? <span className="unread-badge">{item.unreadCount > 99 ? '99+' : item.unreadCount}</span> : <span className="unread-dot" aria-label="Mensagens novas"/> : null}
    </button>
    {canManage && <button className="channel-delete" title={`Apagar ${item.name}`} aria-label={`Apagar canal ${item.name}`} onClick={() => onDelete(item)}>×</button>}
  </div>;
  const uncategorized = channels.filter((item) => !item.categoryId).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return <div className="channel-groups">
    {uncategorized.map(renderChannel)}
    {categories.slice().sort((a, b) => a.position - b.position).map((category) => {
      const closed = collapsed.includes(category.id);
      return <section className="channel-category" key={category.id}>
        <button className="channel-category-heading" aria-expanded={!closed} onClick={() => toggle(category.id)}><span aria-hidden="true">{closed ? '›' : '⌄'}</span>{category.name.toLocaleUpperCase()}</button>
        {!closed && channels.filter((item) => item.categoryId === category.id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(renderChannel)}
      </section>;
    })}
  </div>;
}

function Dashboard({ user, onUserChange, onLogout, inviteToken, onClearInvite }: { user: User; onUserChange: (user: User) => void; onLogout: () => void; inviteToken: string | null; onClearInvite: () => void }) {
  const [communities, setCommunities] = useState<Community[]>([]);
  const [details, setDetails] = useState<CommunityDetails | null>(null);
  const detailsRef = useRef<CommunityDetails | null>(details);
  detailsRef.current = details;
  const [channel, setChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [newMessages, setNewMessages] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [explore, setExplore] = useState(false);
  const [directMessagesOpen, setDirectMessagesOpen] = useState(false);
  const [directMessageTarget, setDirectMessageTarget] = useState<MemberProfile | null>(null);
  const [dmUnreadCount, setDmUnreadCount] = useState(0);
  const [search, setSearch] = useState('');
  const [publicCommunities, setPublicCommunities] = useState<Community[]>([]);
  const [modal, setModal] = useState<ModalType>(null);
  const [actionMenu, setActionMenu] = useState<ActionMenuTarget | null>(null);
  const actionMenuRef = useRef<ActionMenuTarget | null>(null);
  const menuHistoryRef = useRef(false);
  const [moderationPrompt, setModerationPrompt] = useState<{ action: 'mute' | 'ban'; member: Member } | null>(null);
  const [toast, setToast] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [reconnecting, setReconnecting] = useState(false);
  const [mobileView, setMobileView] = useState<'channels' | 'chat'>('channels');
  const mobileHistory = useRef<Array<'channels' | 'chat'>>(['channels']);
  const navigateMobile = useCallback((view: 'channels' | 'chat') => {
    if (window.innerWidth <= 760 && mobileHistory.current[mobileHistory.current.length - 1] !== view) { mobileHistory.current.push(view); window.history.pushState({ mavunoView: view }, '', window.location.href); }
    setMobileView(view);
  }, []);
  const [quickOpen, setQuickOpen] = useState(false);
  const [tucked, setTucked] = useState(false);
  const [floatingPosition, setFloatingPosition] = useState<FloatingPosition>(() => readFloatingPosition());
  const [floatingDragPosition, setFloatingDragPosition] = useState<{ left: number; top: number } | null>(null);
  const [reply, setReply] = useState<Message | null>(null);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [pinnedMessages, setPinnedMessages] = useState<Message[]>([]);
  const [emojiPickerTarget, setEmojiPickerTarget] = useState<'composer' | { messageId: string } | null>(null);
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
  const [communityAssets, setCommunityAssets] = useState<CommunityAssetsResponse | null>(null);
  const [reactionUsers, setReactionUsers] = useState<{ messageId: string; emoji: string; users: string[]; loading: boolean } | null>(null);
  const [pendingReactionKeys, setPendingReactionKeys] = useState<Set<string>>(new Set());
  const pendingReactionKeysRef = useRef(new Set<string>());
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState('');
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const documentInputRef = useRef<HTMLInputElement | null>(null);
  const [attachmentDrafts, setAttachmentDrafts] = useState<PendingAttachment[]>([]);
  const attachmentDraftsRef = useRef<PendingAttachment[]>([]);
  attachmentDraftsRef.current = attachmentDrafts;
  const previousAttachmentChannelRef = useRef<string | null>(channel?.id ?? null);
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [ownProfile, setOwnProfile] = useState<OwnProfileResponse | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [ownProfileError, setOwnProfileError] = useState('');
  const [memberProfile, setMemberProfile] = useState<MemberProfile | null>(null);
  const [memberProfileLoading, setMemberProfileLoading] = useState(false);
  const [memberProfileError, setMemberProfileError] = useState('');
  const memberProfileIdRef = useRef<string | null>(null);
  const profileRequestRef = useRef(0);
  const [audioPreferences, setAudioPreferences] = useState<AudioPreferences>(() => readAudioPreferences());
  const [audioMenu, setAudioMenu] = useState<'input' | 'output' | null>(null);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioError, setAudioError] = useState('');
  const [settingsSection, setSettingsSection] = useState<'account' | 'voice' | 'direct'>('account');
  const [joinTarget, setJoinTarget] = useState<{ kind: 'invite' | 'community'; value: string } | null>(null);
  const [joinInfo, setJoinInfo] = useState<JoinFlowInfo | null>(null);
  const [joinInfoLoading, setJoinInfoLoading] = useState(false);
  const [joinInfoError, setJoinInfoError] = useState('');
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinRequestsRefresh, setJoinRequestsRefresh] = useState(0);
  const [actionToast, setActionToast] = useState<{ text: string; communityId: string } | null>(null);
  const [inviteShare, setInviteShare] = useState<{ url: string; showOptions: boolean; duration: InviteDuration; maxUses: InviteUseLimit; copyBlocked: boolean } | null>(null);
  const [inviteListRefresh, setInviteListRefresh] = useState(0);
  const [previousMicMuted, setPreviousMicMuted] = useState<boolean | null>(null);
  const [callTarget, setCallTarget] = useState<Member | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const knownMessageIds = useRef(new Set<string>());
  knownMessageIds.current = new Set(messages.flatMap((message) => [message.id, message.clientMessageId]));
  const nearBottom = useRef(true);
  const tuckTimer = useRef<number | undefined>(undefined);
  const floatingButtonRef = useRef<HTMLButtonElement | null>(null);
  const floatingDragRef = useRef<FloatingDragState | null>(null);
  const suppressFloatingClickRef = useRef(false);
  const hintShownRef = useRef(false);
  useEffect(() => { actionMenuRef.current = actionMenu; }, [actionMenu]);
  useEffect(() => () => { attachmentDraftsRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl)); }, []);
  useEffect(() => {
    if (!inviteToken) return;
    let active = true;
    setJoinTarget({ kind: 'invite', value: inviteToken }); setJoinInfo(null); setJoinInfoError(''); setJoinInfoLoading(true);
    void api<JoinFlowInfo>(`/invites/${encodeURIComponent(inviteToken)}/join-info`)
      .then((result) => { if (active) setJoinInfo(result); })
      .catch((cause) => { if (active) setJoinInfoError(cause instanceof Error ? cause.message : 'Este convite já não é válido.'); })
      .finally(() => { if (active) setJoinInfoLoading(false); });
    return () => { active = false; };
  }, [inviteToken]);
  useEffect(() => {
    const nextChannelId = channel?.id ?? null;
    if (previousAttachmentChannelRef.current !== nextChannelId) {
      attachmentDraftsRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      attachmentDraftsRef.current = [];
      setAttachmentDrafts([]);
      setAttachmentPickerOpen(false);
      previousAttachmentChannelRef.current = nextChannelId;
    }
  }, [channel?.id]);
  useEffect(() => {
    const onPopState = () => {
      if (menuHistoryRef.current || actionMenuRef.current) { menuHistoryRef.current = false; setActionMenu(null); return; }
      if (mobileHistory.current.length > 1) { mobileHistory.current.pop(); setMobileView(mobileHistory.current[mobileHistory.current.length - 1]); }
      else { window.history.pushState({ mavunoView: 'channels' }, '', window.location.href); setMobileView('channels'); }
    };
    window.history.replaceState({ mavunoView: 'channels' }, '', window.location.href);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const openActionMenu = (target: ActionMenuTarget) => {
    composerInputRef.current?.blur();
    if ((window.innerWidth <= 760 || target.rect.touch) && !menuHistoryRef.current) {
      window.history.pushState({ mavunoActionMenu: true }, '', window.location.href);
      menuHistoryRef.current = true;
    }
    setActionMenu(target);
  };
  const closeActionMenu = useCallback(() => {
    setActionMenu(null);
    if (menuHistoryRef.current) window.history.back();
  }, []);
  const openMessageMenu = (message: Message, rect: MenuRect) => openActionMenu({ kind: 'message', message, rect });
  const openMemberMenu = (member: Member, rect: MenuRect) => openActionMenu({ kind: 'member', member, rect });
  const isManager = details?.myRole === 'owner' || details?.myRole === 'admin';
  const canKick = ['owner', 'admin', 'moderator'].includes(details?.myRole ?? '');
  const canManageCommunity = details?.myPermissions.includes('manage_community') ?? false;
  const canManageRequests = details?.myPermissions.includes('manage_members') ?? false;
  const canCreateInvites = details?.myPermissions.includes('create_invites') ?? false;
  const canOpenAdmin = canKick || canManageCommunity || canManageRequests || canCreateInvites || (details?.myPermissions.includes('manage_channels') ?? false) || (details?.myPermissions.includes('view_audit_log') ?? false);
  const activeCommunityId = details?.community.id;
  const quickItems = useMemo(() => communities.map((community) => ({ id: community.id, name: community.name })), [communities]);
  const shortcodeQuery = draft.match(/:([a-z0-9_]{2,32})$/i)?.[1] ?? '';
  const shortcodeSuggestions: Array<{ title: string; token: string; search: string }> = shortcodeQuery.length >= 2 ? [
    ...(communityAssets?.mavuno.emojis ?? []).filter((item) => `${item.key} ${item.label}`.toLowerCase().includes(shortcodeQuery.toLowerCase())).map((item) => ({ title: item.label ?? item.key ?? '', token: `<:builtin:${item.key}>`, search: item.key ?? '' })),
    ...(communityAssets?.emojis ?? []).filter((item) => `${item.name} ${item.description ?? ''}`.toLowerCase().includes(shortcodeQuery.toLowerCase())).map((item) => ({ title: item.name ?? '', token: `<:${item.name}:${item.id}>`, search: item.name ?? '' })),
  ].slice(0, 6) : [];

  const notify = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(''), 3200);
  }, []);
  const saveAudio = useCallback((patch: Partial<AudioPreferences>) => {
    setAudioPreferences((current) => {
      const next = { ...current, ...patch };
      writeAudioPreferences(next);
      return next;
    });
  }, []);
  const refreshAudioDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioDevices(devices.filter((device) => device.kind === 'audioinput' || device.kind === 'audiooutput'));
    } catch { setAudioDevices([]); }
  }, []);
  useEffect(() => { void refreshAudioDevices(); navigator.mediaDevices?.addEventListener?.('devicechange', refreshAudioDevices); return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshAudioDevices); }, [refreshAudioDevices]);
  const requestMicrophone = async () => {
    if (!navigator.mediaDevices?.getUserMedia) { setAudioError('Este navegador não permite testar o microfone.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(audioPreferences.voiceProfile, audioPreferences.inputDeviceId));
      stream.getTracks().forEach((track) => track.stop());
      setAudioError(''); await refreshAudioDevices(); notify('Microfone autorizado.');
    } catch { setAudioError('Permite o acesso ao microfone nas definições do navegador e tenta novamente.'); }
  };
  const toggleMute = () => {
    if (audioPreferences.deafened) return;
    saveAudio({ micMuted: !audioPreferences.micMuted });
  };
  const toggleDeafen = () => {
    const next = applyDeafenState(audioPreferences.micMuted, audioPreferences.deafened, !audioPreferences.deafened);
    const restoredMic = audioPreferences.deafened && previousMicMuted !== null ? previousMicMuted : next.micMuted;
    setPreviousMicMuted(next.deafened ? audioPreferences.micMuted : null);
    saveAudio({ micMuted: restoredMic, deafened: next.deafened });
  };
  const loadCommunities = useCallback(async () => {
    try {
      const result = await api<{ communities: Community[] }>('/communities/mine');
      setCommunities(result.communities);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Não foi possível carregar as comunidades.');
    }
  }, [notify]);
  const openOwnProfile = useCallback(async () => {
    memberProfileIdRef.current = null;
    profileRequestRef.current += 1;
    setMemberProfile(null);
    setMemberProfileLoading(false);
    setOwnProfile(null);
    setModal('profile');
    setProfileLoading(true);
    setOwnProfileError('');
    try { setOwnProfile(await api<OwnProfileResponse>('/profile')); }
    catch (cause) { setOwnProfileError(cause instanceof Error ? cause.message : 'Não foi possível carregar o teu perfil.'); }
    finally { setProfileLoading(false); }
  }, []);
  const loadMemberProfile = useCallback(async (targetId: string, communityId: string) => {
    const request = ++profileRequestRef.current;
    setMemberProfileLoading(true);
    setMemberProfileError('');
    try {
      const result = await api<{ profile: MemberProfile }>(`/users/${encodeURIComponent(targetId)}/profile?communityId=${encodeURIComponent(communityId)}`);
      if (request === profileRequestRef.current && memberProfileIdRef.current === targetId) { setMemberProfile(result.profile); return true; }
      return false;
    } catch (cause) {
      if (request === profileRequestRef.current && memberProfileIdRef.current === targetId) setMemberProfileError(cause instanceof Error ? cause.message : 'Não foi possível abrir este perfil.');
      return false;
    } finally {
      if (request === profileRequestRef.current && memberProfileIdRef.current === targetId) setMemberProfileLoading(false);
    }
  }, []);
  const openMemberProfile = useCallback((targetId: string) => {
    if (targetId === user.id) { void openOwnProfile(); return; }
    const communityIds = [...new Set([activeCommunityId, ...communities.map((item) => item.id)].filter((id): id is string => Boolean(id)))];
    if (!communityIds.length) return;
    memberProfileIdRef.current = targetId;
    setMemberProfile(null);
    setModal('memberProfile');
    void (async () => { for (const communityId of communityIds) if (await loadMemberProfile(targetId, communityId)) return; })();
  }, [activeCommunityId, communities, loadMemberProfile, openOwnProfile, user.id]);
  const openDirectMessage = useCallback((peer: { id: string; username: string; avatarUrl?: string | null }) => {
    memberProfileIdRef.current = null; profileRequestRef.current += 1; setMemberProfile(null); setMemberProfileLoading(false);
    setDirectMessageTarget({ id: peer.id, username: peer.username, avatarUrl: peer.avatarUrl });
    setDirectMessagesOpen(true); setExplore(false); setQuickOpen(false); setModal(null); setMobileView('chat');
  }, []);
  const closeMemberProfile = useCallback(() => {
    memberProfileIdRef.current = null;
    profileRequestRef.current += 1;
    setMemberProfile(null);
    setModal(null);
  }, []);
  const openCommunity = useCallback(async (id: string, autoChannel = true) => {
    setDirectMessagesOpen(false);
    try {
      const data = await api<CommunityDetails>(`/communities/${id}`);
      setDetails(data);
      const unreadCount = Math.min(99, data.channels.reduce((total, item) => total + (item.unreadCount ?? 0), 0));
      setCommunities((current) => current.map((item) => item.id === id ? { ...item, unreadCount } : item));
      setExplore(false);
      setChannel(null);
      setMessages([]);
      setPinnedMessages([]);
      navigateMobile('channels');
      if (autoChannel && data.myRole) {
        const first = data.channels.find((item) => item.kind === 'text' && item.name.toLocaleLowerCase() === 'geral') ?? data.channels.find((item) => item.kind === 'text') ?? data.channels[0];
        if (first) { setChannel(first); navigateMobile('chat'); }
      }
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Não foi possível abrir a comunidade.');
    }
  }, [notify]);

  useEffect(() => {
    void loadCommunities();
  }, [loadCommunities]);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => { setOnline(false); setReconnecting(true); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);
  const resetTuckTimer = useCallback(() => {
    if (tuckTimer.current !== undefined) window.clearTimeout(tuckTimer.current);
    setTucked(false);
    tuckTimer.current = window.setTimeout(() => { if (!floatingDragRef.current) setTucked(true); }, 10_000);
  }, []);
  useEffect(() => {
    resetTuckTimer();
    return () => { if (tuckTimer.current !== undefined) window.clearTimeout(tuckTimer.current); };
  }, [quickOpen, resetTuckTimer]);
  useEffect(() => {
    try {
      const maxTop = maxFloatingTop();
      window.localStorage.setItem(FLOATING_POSITION_KEY, JSON.stringify({ side: floatingPosition.side, topRatio: maxTop ? floatingPosition.top / maxTop : 0 }));
    } catch { /* A posição continua funcional mesmo quando o armazenamento local não está disponível. */ }
  }, [floatingPosition]);
  useEffect(() => {
    const onResize = () => {
      setFloatingPosition((current) => ({ ...current, top: clampFloatingPosition(0, current.top, window.innerWidth, window.innerHeight).top }));
      setFloatingDragPosition((current) => current ? clampFloatingPosition(current.left, current.top, window.innerWidth, window.innerHeight) : null);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const startFloatingPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    suppressFloatingClickRef.current = false;
    const bounds = floatingButtonRef.current?.getBoundingClientRect();
    const edgeLeft = floatingPosition.side === 'left' ? 0 : Math.max(0, window.innerWidth - FLOATING_BUTTON_SIZE);
    floatingDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: tucked ? edgeLeft : bounds?.left ?? edgeLeft,
      startTop: tucked ? floatingPosition.top : bounds?.top ?? floatingPosition.top,
      moved: false,
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional on older browsers. */ }
    resetTuckTimer();
  };
  const moveFloatingPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = floatingDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 6) return;
    drag.moved = true;
    setFloatingDragPosition(clampFloatingPosition(drag.startLeft + deltaX, drag.startTop + deltaY, window.innerWidth, window.innerHeight));
    setQuickOpen(false);
  };
  const finishFloatingPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = floatingDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) >= 6) drag.moved = true;
    floatingDragRef.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* The browser may already have released capture. */ }
    if (drag.moved) {
      const position = clampFloatingPosition(drag.startLeft + deltaX, drag.startTop + deltaY, window.innerWidth, window.innerHeight);
      setFloatingPosition({ side: nearestFloatingSide(position.left, window.innerWidth), top: position.top });
      setFloatingDragPosition(null);
      setQuickOpen(false);
      suppressFloatingClickRef.current = true;
      window.setTimeout(() => { suppressFloatingClickRef.current = false; }, 100);
    }
    resetTuckTimer();
  };
  const moveFloatingWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setFloatingPosition((current) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') return { ...current, side: event.key === 'ArrowLeft' ? 'left' : 'right' };
      const top = event.key === 'Home' ? 0 : event.key === 'End' ? maxFloatingTop() : current.top + (event.key === 'ArrowDown' ? 32 : -32);
      return { ...current, top: clampFloatingPosition(0, top, window.innerWidth, window.innerHeight).top };
    });
    resetTuckTimer();
  };

  const fetchPinnedMessages = useCallback(async (channelId: string) => {
    try { const result = await api<{ messages: Message[] }>(`/channels/${channelId}/pinned`); setPinnedMessages(result.messages); }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível carregar as mensagens fixadas.'); }
  }, [notify]);
  const fetchMessages = useCallback(async (channelId: string, before?: string) => {
    const params = before ? `?before=${encodeURIComponent(before)}` : '';
    setLoadingMessages(true);
    try {
      const result = await api<{ messages: Message[]; hasMore: boolean; nextCursor: string | null }>(`/channels/${channelId}/messages${params}`);
      setMessages((current) => before ? result.messages.reduce((merged, item) => mergeMessage(merged, item), current) : result.messages);
      setHasMore(result.hasMore);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Não foi possível carregar mensagens.');
    } finally {
      setLoadingMessages(false);
    }
  }, [notify]);
  const markChannelRead = useCallback(async (channelId: string) => {
    try {
      await api(`/channels/${channelId}/read`, { method: 'POST', body: '{}' });
      const currentDetails = detailsRef.current;
      const currentChannel = currentDetails?.channels.find((item) => item.id === channelId);
      if (currentDetails && currentChannel) setCommunities((items) => items.map((item) => item.id === currentDetails.community.id ? { ...item, unreadCount: Math.max(0, (item.unreadCount ?? 0) - (currentChannel.unreadCount ?? 0)) } : item));
      setDetails((current) => current ? { ...current, channels: current.channels.map((item) => item.id === channelId ? { ...item, unreadCount: 0, hasMention: false } : item) } : current);
      setNewMessages(0);
    } catch { /* a failed read mark will be retried on the next visible visit */ }
  }, []);
  useEffect(() => {
    nearBottom.current = true;
    setNewMessages(0);
    if (!channel || channel.kind !== 'text') { setMessages([]); setPinnedMessages([]); setReconnecting(false); return; }
    setPinnedMessages([]);
    void fetchMessages(channel.id);
    void fetchPinnedMessages(channel.id);
  }, [channel?.id, channel?.kind, fetchMessages, fetchPinnedMessages]);
  useEffect(() => {
    if (!channel || channel.kind !== 'text' || loadingMessages || document.visibilityState !== 'visible' || !nearBottom.current) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState === 'visible' && nearBottom.current) void markChannelRead(channel.id);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [channel?.id, channel?.kind, messages.length, loadingMessages, markChannelRead]);
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && channel?.kind === 'text' && nearBottom.current) void markChannelRead(channel.id);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [channel?.id, channel?.kind, markChannelRead]);
  useEffect(() => {
    if (!channel || channel.kind !== 'text' || messages.length === 0 || hintShownRef.current) return;
    hintShownRef.current = true;
    try {
      if (localStorage.getItem('mavuno.message-menu-hint.v1')) return;
      localStorage.setItem('mavuno.message-menu-hint.v1', '1');
    } catch { /* a dica continua a ser mostrada uma vez nesta sessão */ }
    notify('Prime uma mensagem para ver as opções.');
  }, [channel?.id, channel?.kind, messages.length, notify]);
  useEffect(() => {
    if (nearBottom.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length, channel?.id]);
  useEffect(() => {
    if (!details?.community.id) { setCommunityAssets(null); return; }
    const communityId = details.community.id;
    const refreshAssets = () => { void api<CommunityAssetsResponse>(`/communities/${communityId}/assets`).then(setCommunityAssets).catch(() => setCommunityAssets(null)); };
    refreshAssets();
    const socket = io({ withCredentials: true, reconnection: true, transports: ['websocket', 'polling'] });
    socket.on('connect', () => { setOnline(true); setReconnecting(false); });
    socket.on('disconnect', (reason) => { if (reason !== 'io client disconnect') setReconnecting(true); });
    socket.on('connect_error', () => setReconnecting(true));
    socket.on('channels:updated', (event: { communityId: string }) => {
      if (event.communityId !== communityId) return;
      void api<CommunityDetails>(`/communities/${communityId}`).then((fresh) => {
        setDetails(fresh);
        const unreadCount = Math.min(99, fresh.channels.reduce((total, item) => total + (item.unreadCount ?? 0), 0));
        setCommunities((items) => items.map((item) => item.id === communityId ? { ...item, unreadCount } : item));
        if (channel) setChannel(fresh.channels.find((item) => item.id === channel.id) ?? null);
      }).catch(() => undefined);
    });
    socket.on('community-assets:updated', (event: { communityId: string }) => { if (event.communityId === communityId) refreshAssets(); });
    socket.on('community:updated', (event: { communityId: string }) => {
      if (event.communityId === communityId) void api<CommunityDetails>(`/communities/${communityId}`).then(setDetails).catch(() => undefined);
    });
    socket.on('channel:unread', (event: { communityId: string; channelId: string; authorId: string; hasMention?: boolean }) => {
      if (event.authorId === user.id) return;
      setCommunities((items) => items.map((item) => item.id === event.communityId ? { ...item, unreadCount: Math.min(99, (item.unreadCount ?? 0) + 1) } : item));
      if (event.communityId === communityId) setDetails((current) => current ? { ...current, channels: current.channels.map((item) => item.id === event.channelId ? { ...item, unreadCount: Math.min(99, (item.unreadCount ?? 0) + 1), hasMention: Boolean(item.hasMention || event.hasMention) } : item) } : current);
    });
    socket.on('community:member_joined', (event: { communityId: string; member: Member }) => {
      if (event.communityId === communityId) setDetails((current) => current && current.members.some((member) => member.id === event.member.id) ? current : current ? { ...current, members: [...current.members, event.member].sort((a, b) => a.username.localeCompare(b.username)) } : current);
    });
    socket.on('community:member_left', (event: { communityId: string; userId: string }) => {
      if (event.communityId === communityId) setDetails((current) => current ? { ...current, members: current.members.filter((member) => member.id !== event.userId) } : current);
    });
    socket.on('community:member_muted', (event: { communityId: string; userId: string; expiresAt: string }) => {
      if (event.communityId === communityId) setDetails((current) => current ? { ...current, members: current.members.map((member) => member.id === event.userId ? { ...member, mutedUntil: event.expiresAt } : member) } : current);
    });
    socket.on('community:member_unmuted', (event: { communityId: string; userId: string }) => {
      if (event.communityId === communityId) setDetails((current) => current ? { ...current, members: current.members.map((member) => member.id === event.userId ? { ...member, mutedUntil: null } : member) } : current);
    });
    socket.on('profile:updated', (event: { userId: string; profile: MemberProfile }) => {
      setDetails((current) => current ? { ...current, members: current.members.map((member) => member.id === event.userId ? refreshVisibleIdentity(member, event.profile) : member) } : current);
      setMessages((current) => current.map((message) => message.authorId === event.userId ? refreshVisibleIdentity(message, event.profile) : message));
      setPinnedMessages((current) => current.map((message) => message.authorId === event.userId ? refreshVisibleIdentity(message, event.profile) : message));
      setCallTarget((current) => current?.id === event.userId ? refreshVisibleIdentity(current, event.profile) : current);
      if (memberProfileIdRef.current === event.userId) setMemberProfile((current) => current?.id === event.userId ? event.profile : current);
    });
    socket.on('profile:presence', (event: { userId: string; online: boolean }) => {
      setMemberProfile((current) => current?.id === event.userId && Object.hasOwn(current, 'online') ? { ...current, online: event.online } : current);
    });
    return () => { socket.disconnect(); };
  }, [details?.community.id, channel?.id, loadCommunities, loadMemberProfile, notify, user.id]);
  useEffect(() => {
    const socket = io({ withCredentials: true, reconnection: true, transports: ['websocket', 'polling'] });
    const refreshDmUnread = () => { void api<{ conversations: Array<{ unreadCount: number }> }>('/dm/conversations').then((data) => setDmUnreadCount(Math.min(99, data.conversations.reduce((total, item) => total + item.unreadCount, 0)))).catch(() => undefined); };
    socket.on('connect', refreshDmUnread); socket.on('dm:message:new', refreshDmUnread); socket.on('dm:read', refreshDmUnread); socket.on('dm:message:deleted', refreshDmUnread);
    socket.on('community:muted', (event: { communityId: string; expiresAt: string }) => notify(`Foste silenciado até às ${new Intl.DateTimeFormat('pt-MZ', { hour: '2-digit', minute: '2-digit' }).format(new Date(event.expiresAt))}.`));
    socket.on('community:unmuted', () => notify('O teu silêncio foi removido.'));
    socket.on('community:kicked', (event: { communityId: string }) => {
      if (activeCommunityId === event.communityId) { setDetails(null); setChannel(null); setActionMenu(null); void loadCommunities(); }
      notify('Foste expulso desta comunidade.');
    });
    socket.on('community:banned', (event: { communityId: string; expiresAt?: string | null }) => {
      if (activeCommunityId === event.communityId) { setDetails(null); setChannel(null); setActionMenu(null); void loadCommunities(); }
      notify(event.expiresAt ? `Foste banido até ${new Intl.DateTimeFormat('pt-MZ', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(event.expiresAt))}.` : 'Foste banido permanentemente desta comunidade.');
    });
    socket.on('community:join-request-changed', (event: { communityId: string; requestId: string; status?: string; user?: { username?: string } }) => {
      setJoinRequestsRefresh((version) => version + 1);
      if (activeCommunityId === event.communityId) setDetails((current) => current ? { ...current, pendingJoinRequests: Math.max(0, (current.pendingJoinRequests ?? 0) + (event.status === 'pending' ? 1 : -1)) } : current);
      if (event.status === 'pending') notify(`Novo pedido de entrada${event.user?.username ? ` de ${event.user.username}` : ''}.`);
    });
    socket.on('community:join-request-status', (event: { communityId: string; communityName: string; status: 'approved' | 'rejected' }) => {
      setJoinInfo((current) => current?.id === event.communityId ? { ...current, requestPending: false, requestId: null, alreadyMember: event.status === 'approved' } : current);
      if (event.status === 'approved') setActionToast({ text: `Já podes entrar em ${event.communityName}.`, communityId: event.communityId });
      else notify(`O teu pedido para entrar em ${event.communityName} foi recusado.`);
    });
    return () => { socket.disconnect(); };
  }, [activeCommunityId, loadCommunities, notify]);
  useEffect(() => {
    if (!channel || channel.kind !== 'text') return;
    const socket = io({ withCredentials: true, reconnection: true, reconnectionDelay: 700, reconnectionDelayMax: 5000, transports: ['websocket', 'polling'] });
    let connectedBefore = false;
    socket.on('connect', () => {
      setOnline(true); setReconnecting(false);
      socket.emit('channel:join', { channelId: channel.id });
      if (connectedBefore) {
        void api<{ messages: Message[]; hasMore: boolean; nextCursor: string | null }>(`/channels/${channel.id}/messages`)
          .then((result) => {
            const unseen = result.messages.filter((item) => !knownMessageIds.current.has(item.id) && !knownMessageIds.current.has(item.clientMessageId) && item.authorId !== user.id);
            if (!nearBottom.current && unseen.length) setNewMessages((count) => count + unseen.length);
            setMessages((current) => result.messages.reduce((merged, item) => mergeMessage(merged, item), current));
            setHasMore(result.hasMore);
          })
          .catch((cause) => notify(cause instanceof Error ? cause.message : 'Não foi possível atualizar mensagens após a reconexão.'));
        void fetchPinnedMessages(channel.id);
      }
      connectedBefore = true;
    });
    socket.on('disconnect', (reason) => { if (reason !== 'io client disconnect') setReconnecting(true); });
    socket.on('connect_error', () => setReconnecting(true));
    socket.on('message:new', (message: Message) => {
      const known = knownMessageIds.current.has(message.id) || knownMessageIds.current.has(message.clientMessageId);
      knownMessageIds.current.add(message.id); knownMessageIds.current.add(message.clientMessageId);
      if (!known && !nearBottom.current && message.authorId !== user.id) setNewMessages((count) => count + 1);
      setMessages((current) => mergeMessage(current, message));
    });
    socket.on('message:deleted', (event: { id: string }) => { setMessages((current) => current.filter((message) => message.id !== event.id).map((message) => message.replyToId === event.id ? { ...message, replyAuthor: null, replyBody: null } : message)); setPinnedMessages((current) => current.filter((message) => message.id !== event.id)); });
    socket.on('message:pinned', (event: { id: string; pinnedAt: string; pinnedBy: string }) => { setMessages((current) => current.map((message) => message.id === event.id ? { ...message, ...event } : message)); setPinnedMessages((current) => current.map((message) => message.id === event.id ? { ...message, ...event } : message)); });
    socket.on('message:unpinned', (event: { id: string }) => { setMessages((current) => current.map((message) => message.id === event.id ? { ...message, pinnedAt: null, pinnedBy: null } : message)); setPinnedMessages((current) => current.filter((message) => message.id !== event.id)); });
    socket.on('message:reactions', (event: { messageId: string; reactions: ReactionSummary[] }) => { setMessages((current) => current.map((message) => message.id === event.messageId ? { ...message, reactions: event.reactions } : message)); setPinnedMessages((current) => current.map((message) => message.id === event.messageId ? { ...message, reactions: event.reactions } : message)); });
    socket.on('channel:deleted', (event: { id: string }) => {
      if (event.id === channel.id) { setChannel(null); notify('Este canal foi removido.'); }
    });
    socket.on('room:error', () => notify('Não foi possível ligar à sala. Tenta novamente.'));
    socket.on('mention:new', (event: { username: string }) => notify(`Mencionaram-te numa conversa, ${event.username}.`));
    return () => { socket.disconnect(); };
  }, [channel?.id, channel?.kind, details?.community.id, fetchPinnedMessages, loadCommunities, notify, user.id]);

  const updateReactionLists = (messageId: string, reactions: ReactionSummary[]) => {
    setMessages((current) => current.map((message) => message.id === messageId ? { ...message, reactions } : message));
    setPinnedMessages((current) => current.map((message) => message.id === messageId ? { ...message, reactions } : message));
  };
  const toggleReaction = async (message: Message, emoji: string) => {
    if (!channel || channel.kind !== 'text') return;
    const key = `${message.id}:${emoji}`;
    if (pendingReactionKeysRef.current.has(key)) return;
    const latest = messages.find((item) => item.id === message.id) ?? pinnedMessages.find((item) => item.id === message.id) ?? message;
    const previous = latest.reactions ?? [];
    const active = !previous.some((item) => item.emoji === emoji && item.reactedByMe);
    pendingReactionKeysRef.current.add(key);
    setPendingReactionKeys((current) => new Set(current).add(key));
    updateReactionLists(message.id, toggleReactionSummary(previous, emoji));
    try {
      const result = await api<{ reactions: ReactionSummary[] }>(`/messages/${message.id}/reactions`, { method: 'POST', body: JSON.stringify({ emoji, active }) });
      updateReactionLists(message.id, result.reactions);
    } catch {
      updateReactionLists(message.id, previous);
      notify('Não foi possível reagir. Tenta de novo.');
    } finally {
      pendingReactionKeysRef.current.delete(key);
      setPendingReactionKeys((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  };
  const showReactionUsers = async (messageId: string, emoji: string) => {
    setReactionUsers({ messageId, emoji, users: [], loading: true });
    try {
      const result = await api<{ users: string[] }>(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/users`);
      setReactionUsers({ messageId, emoji, users: result.users, loading: false });
    } catch {
      setReactionUsers(null);
      notify('Não foi possível carregar quem reagiu.');
    }
  };
  const openPinned = async () => {
    if (!channel) return;
    setPinnedOpen(true);
    await fetchPinnedMessages(channel.id);
  };
  const insertComposerEmoji = (emoji: string) => {
    const input = composerInputRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? start;
    setDraft((current) => `${current.slice(0, start)}${emoji}${current.slice(end)}`);
    window.requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + emoji.length, start + emoji.length); });
  };

  const openAttachmentPicker = async () => {
    if (!channel || channel.kind !== 'text') return;
    try {
      const result = await api<{ available: boolean }>(`/channels/${channel.id}/attachments/availability`);
      if (!result.available) { notify('Os anexos ainda não estão disponíveis. Tenta mais tarde.'); return; }
      setAttachmentPickerOpen(true);
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível abrir os anexos.'); }
  };
  const addSelectedFiles = async (selection: FileList | File[] | null) => {
    if (!selection?.length) return;
    const available = Math.max(0, 5 - attachmentDrafts.length);
    if (available === 0) { notify('Podes enviar até 5 anexos por mensagem.'); return; }
    const files = Array.from(selection);
    if (files.length > available) notify('Podes enviar até 5 anexos por mensagem.');
    setAttachmentBusy(true);
    try {
      for (const originalFile of files.slice(0, available)) {
        const mimeType = inferredMimeType(originalFile);
        const preliminary = validateAttachmentMetadata(originalFile.name, mimeType, 1);
        if (!preliminary.ok && preliminary.reason === 'type') { notify('Este tipo de ficheiro não é permitido.'); continue; }
        const prepared = await prepareAttachmentFile(originalFile, mimeType);
        const valid = validateAttachmentMetadata(prepared.file.name, mimeType, prepared.file.size);
        if (!valid.ok) {
          if (valid.reason === 'size' && mimeType.startsWith('video/')) notify('Este ficheiro é demasiado grande. O máximo para vídeos é 25 MB.');
          else if (valid.reason === 'size') notify(`Este ficheiro é demasiado grande. O máximo permitido é ${Math.ceil((valid.maxBytes ?? 0) / (1024 * 1024))} MB.`);
          else notify('Este tipo de ficheiro não é permitido.');
          continue;
        }
        const pending: PendingAttachment = {
          key: crypto.randomUUID(), file: prepared.file, previewUrl: URL.createObjectURL(prepared.file), mimeType: valid.mimeType,
          kind: valid.kind, width: prepared.width, height: prepared.height, progress: 0, status: 'queued',
        };
        setAttachmentDrafts((current) => current.length < 5 ? [...current, pending] : current);
      }
    } finally { setAttachmentBusy(false); }
  };
  const removeAttachmentDraft = (key: string) => {
    const item = attachmentDrafts.find((entry) => entry.key === key);
    if (item) URL.revokeObjectURL(item.previewUrl);
    setAttachmentDrafts((current) => current.filter((entry) => entry.key !== key));
  };
  const updateAttachmentDraft = (key: string, patch: Partial<PendingAttachment>) => {
    setAttachmentDrafts((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));
  };
  const downloadAttachment = async (attachment: MessageAttachment) => {
    try {
      const result = await api<{ url: string }>(`/attachments/${attachment.id}/url`);
      if (!attachment.mimeType.startsWith('image/') && !attachment.mimeType.startsWith('video/')) { window.location.assign(result.url); return; }
      const response = await fetch(result.url, { cache: 'no-store', credentials: 'omit' });
      if (!response.ok) throw new Error('Não foi possível descarregar este anexo. Tenta novamente.');
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = objectUrl; link.download = attachment.originalName; link.rel = 'noopener';
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível descarregar este anexo.'); }
  };
  const downloadMessageAttachments = async (message: Message) => {
    for (const attachment of message.attachments ?? []) await downloadAttachment(attachment);
  };

  const sendMessage = async (body: string, clientMessageId: string = crypto.randomUUID(), replyToId: string | null = reply?.id ?? null, selectedAttachments: PendingAttachment[] = attachmentDrafts): Promise<boolean> => {
    if (!channel || channel.kind !== 'text' || attachmentBusy || (!body.trim() && selectedAttachments.length === 0)) return false;
    if (channel.readOnly && channel.canWrite === false) { notify('Neste canal só moderadores podem escrever.'); return false; }
    const destination = channel;
    const normalizedBody = body.trim().replace(/:mv_([a-z0-9_]{2,32}):/gi, (raw, key: string) => { const asset = communityAssets?.mavuno.emojis.find((item) => item.key === key.toLowerCase()); return asset ? `<:builtin:${asset.key}>` : raw; }).replace(/:([a-z0-9_]{2,32}):/gi, (raw, name: string) => { const asset = communityAssets?.emojis.find((item) => item.name === name.toLowerCase()); return asset?.id ? `<:${asset.name}:${asset.id}>` : raw; });
    nearBottom.current = true; setNewMessages(0);
    setAttachmentBusy(true);
    let currentUploadKey: string | null = null;
    let optimisticAdded = false;
    try {
      const attachmentIds: string[] = [];
      for (const item of selectedAttachments) {
        currentUploadKey = item.key;
        if (item.attachmentId && item.status === 'ready') { attachmentIds.push(item.attachmentId); continue; }
        let attachmentId = item.attachmentId;
        let uploadUrl: string | null = null;
        if (attachmentId) {
          try {
            await api(`/attachments/${attachmentId}/confirm`, { method: 'POST', body: JSON.stringify({ width: item.width, height: item.height }) });
            updateAttachmentDraft(item.key, { status: 'ready', progress: 100 });
            attachmentIds.push(attachmentId);
            continue;
          } catch { /* An unconfirmed upload gets a refreshed PUT URL below. */ }
          const refreshed = await api<{ uploadUrl: string }>(`/attachments/${attachmentId}/upload-url`, { method: 'POST', body: '{}' });
          uploadUrl = refreshed.uploadUrl;
        } else {
          const started = await api<{ attachmentId: string; uploadUrl: string }>(`/channels/${destination.id}/attachments`, {
            method: 'POST', body: JSON.stringify({ originalName: item.file.name, mimeType: item.mimeType, sizeBytes: item.file.size, width: item.width, height: item.height }),
          });
          attachmentId = started.attachmentId;
          uploadUrl = started.uploadUrl;
          updateAttachmentDraft(item.key, { attachmentId, status: 'uploading', progress: 0, error: undefined });
        }
        if (!attachmentId || !uploadUrl) throw new Error('Não foi possível preparar este ficheiro. Tenta novamente.');
        updateAttachmentDraft(item.key, { attachmentId, status: 'uploading', progress: 0, error: undefined });
        try {
          await uploadWithProgress(uploadUrl, item.file, item.mimeType, (progress) => updateAttachmentDraft(item.key, { progress }));
        } catch {
          const refreshed = await api<{ uploadUrl: string }>(`/attachments/${attachmentId}/upload-url`, { method: 'POST', body: '{}' });
          await uploadWithProgress(refreshed.uploadUrl, item.file, item.mimeType, (progress) => updateAttachmentDraft(item.key, { progress }));
        }
        await api(`/attachments/${attachmentId}/confirm`, { method: 'POST', body: JSON.stringify({ width: item.width, height: item.height }) });
        updateAttachmentDraft(item.key, { status: 'ready', progress: 100 });
        attachmentIds.push(attachmentId);
      }
      const message: Message = {
        id: `optimistic:${clientMessageId}`, clientMessageId, body: normalizedBody, replyToId, replyAuthor: replyToId ? reply?.username ?? null : null, replyBody: replyToId ? reply?.body ?? null : null,
        createdAt: new Date().toISOString(), authorId: user.id, username: user.username,
        avatarUrl: user.avatarUrl, delivery: 'sending',
      };
      setMessages((current) => mergeMessage(current, message));
      optimisticAdded = true;
      const result = await api<{ message: Message }>(`/channels/${destination.id}/messages`, {
        method: 'POST', body: JSON.stringify({ clientMessageId, body: normalizedBody, replyToId, attachmentIds }),
      });
      setMessages((current) => mergeMessage(current, result.message));
      setReply(null);
      selectedAttachments.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      setAttachmentDrafts((current) => current.filter((item) => !selectedAttachments.some((sent) => sent.key === item.key)));
      return true;
    } catch (cause) {
      if (currentUploadKey) updateAttachmentDraft(currentUploadKey, { status: 'failed', error: cause instanceof Error ? cause.message : 'Tenta novamente.' });
      if (optimisticAdded) setMessages((current) => current.map((item) => item.clientMessageId === clientMessageId ? { ...item, delivery: 'failed' } : item));
      notify(cause instanceof Error ? cause.message : 'Não foi possível enviar. Tenta novamente.');
      return false;
    } finally { setAttachmentBusy(false); }
  };
  const createCommunity = async (data: { name: string; description: string; category: string; isPrivate: boolean }) => {
    setBusy(true);
    try {
      const result = await api<{ community: Community }>('/communities', { method: 'POST', body: JSON.stringify(data) });
      await loadCommunities();
      await openCommunity(result.community.id);
      setModal(null);
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível criar a comunidade.'); }
    finally { setBusy(false); }
  };
  const createChannel = async (data: { name: string; topic: string; kind: 'text' | 'voice' }) => {
    if (!activeCommunityId) return;
    setBusy(true);
    try {
      const result = await api<{ channel: Channel }>(`/communities/${activeCommunityId}/channels`, { method: 'POST', body: JSON.stringify(data) });
      await openCommunity(activeCommunityId, false);
      setChannel(result.channel);
      navigateMobile('chat');
      setModal(null);
      notify('Canal criado.');
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível criar o canal.'); }
    finally { setBusy(false); }
  };
  const deleteChannel = async (item: Channel) => {
    if (!window.confirm(`Apagar o canal “${item.name}” e as respetivas mensagens de forma permanente?`)) return;
    try {
      await api(`/channels/${item.id}`, { method: 'DELETE' });
      if (channel?.id === item.id) setChannel(null);
      if (activeCommunityId) await openCommunity(activeCommunityId, false);
      notify('Canal apagado.');
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível apagar o canal.'); }
  };
  const openJoinInfo = async (target: { kind: 'invite' | 'community'; value: string }) => {
    setJoinTarget(target); setJoinInfo(null); setJoinInfoError(''); setJoinInfoLoading(true);
    try {
      const path = target.kind === 'invite' ? `/invites/${encodeURIComponent(target.value)}/join-info` : `/communities/${encodeURIComponent(target.value)}/join-info`;
      setJoinInfo(await api<JoinFlowInfo>(path));
    } catch (cause) { setJoinInfoError(cause instanceof Error ? cause.message : 'Não foi possível abrir esta comunidade.'); }
    finally { setJoinInfoLoading(false); }
  };
  const submitJoin = async (acceptedRules: boolean) => {
    if (!joinTarget) return;
    setJoinBusy(true); setJoinInfoError('');
    try {
      const path = joinTarget.kind === 'invite' ? `/invites/${encodeURIComponent(joinTarget.value)}/join` : `/communities/${encodeURIComponent(joinTarget.value)}/join`;
      const result = await api<{ status: 'joined' | 'already_member' | 'pending'; communityId: string; requestId: string | null }>(path, { method: 'POST', body: JSON.stringify({ acceptedRules }) });
      if (result.status === 'pending') {
        setJoinInfo((current) => current ? { ...current, requestPending: true, requestId: result.requestId } : current);
        if (joinTarget.kind === 'invite') onClearInvite();
        notify('Pedido enviado. Vais poder entrar quando um moderador aprovar.');
        return;
      }
      const alreadyMember = result.status === 'already_member';
      if (joinTarget.kind === 'invite') onClearInvite();
      setJoinInfo(null); setJoinTarget(null);
      await loadCommunities();
      await openCommunity(result.communityId);
      notify(alreadyMember ? 'Já és membro desta comunidade.' : 'Entraste na comunidade.');
    } catch (cause) { setJoinInfoError(cause instanceof Error ? cause.message : 'Não foi possível entrar nesta comunidade.'); }
    finally { setJoinBusy(false); }
  };
  const cancelJoinRequest = async () => {
    if (!joinInfo?.requestId) return;
    setJoinBusy(true); setJoinInfoError('');
    try {
      await api(`/communities/${encodeURIComponent(joinInfo.id)}/join-requests/${encodeURIComponent(joinInfo.requestId)}/cancel`, { method: 'POST', body: '{}' });
      setJoinInfo((current) => current ? { ...current, requestPending: false, requestId: null } : current);
      notify('Pedido cancelado.');
    } catch (cause) { setJoinInfoError(cause instanceof Error ? cause.message : 'Não foi possível cancelar o pedido.'); }
    finally { setJoinBusy(false); }
  };
  const closeJoinFlow = () => {
    if (joinTarget?.kind === 'invite') onClearInvite();
    setJoinTarget(null); setJoinInfo(null); setJoinInfoError('');
  };
  const createInvite = async (duration: InviteDuration = '7d', maxUses: InviteUseLimit = null) => {
    if (!activeCommunityId) return;
    try {
      const result = await api<{ inviteUrl: string }>(`/communities/${activeCommunityId}/invites`, { method: 'POST', body: JSON.stringify({ duration, maxUses }) });
      const url = `${window.location.origin}${result.inviteUrl}`;
      setInviteShare({ url, showOptions: false, duration, maxUses, copyBlocked: false });
      setInviteListRefresh((version) => version + 1);
      try { await navigator.clipboard.writeText(url); notify('Link copiado'); }
      catch { setInviteShare((current) => current ? { ...current, copyBlocked: true } : current); }
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível criar convite.'); }
  };
  const copyInviteLink = async () => {
    if (!inviteShare) return;
    try { await navigator.clipboard.writeText(inviteShare.url); setInviteShare((current) => current ? { ...current, copyBlocked: false } : current); notify('Link copiado'); }
    catch { setInviteShare((current) => current ? { ...current, copyBlocked: true } : current); notify('Seleciona o link e copia-o.'); }
  };
  const shareInviteLink = async () => {
    if (!inviteShare) return;
    if (navigator.share) {
      try { await navigator.share({ title: 'Convite para a comunidade Mavuno', url: inviteShare.url }); return; }
      catch (cause) { if (cause instanceof DOMException && cause.name === 'AbortError') return; }
    }
    await copyInviteLink();
  };
  const loadExplore = async (query = '') => {
    setExplore(true); setDetails(null); setChannel(null); navigateMobile('channels');
    try {
      const result = await api<{ communities: Community[] }>(`/communities/explore${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      setPublicCommunities(result.communities);
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível explorar.'); }
  };
  const logout = () => {
    setCommunities([]); setDetails(null); setMessages([]); setChannel(null); setCallTarget(null); setModal(null); setDraft('');
    onLogout();
    void api('/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
  };
  const leaveCommunity = async () => {
    if (!activeCommunityId || details?.myRole === 'owner') return;
    try {
      await api(`/communities/${activeCommunityId}/leave`, { method: 'POST', body: '{}' });
      setDetails(null); setChannel(null); await loadCommunities(); notify('Saíste da comunidade.');
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível sair.'); }
  };
  const joinPublic = async (community: Community) => { await openJoinInfo({ kind: 'community', value: community.id }); };
  const selectChannel = (item: Channel) => {
    if (!details?.myRole) { notify('Para abrir este canal, entra através de um convite válido.'); return; }
    setChannel(item); setPinnedMessages([]); navigateMobile('chat'); setReply(null);
  };
  const changeRole = async (member: Member, role: string) => {
    if (!activeCommunityId || !['admin', 'moderator', 'member'].includes(role)) return;
    try {
      await api(`/communities/${activeCommunityId}/members/${member.id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
      setDetails((current) => current ? { ...current, members: current.members.map((item) => item.id === member.id ? { ...item, role } : item) } : current);
      notify(`Cargo de ${member.username} atualizado.`);
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível alterar o cargo.'); }
  };
  const kickMember = async (member: Member) => {
    if (!activeCommunityId || !window.confirm(`Expulsar ${member.username} da comunidade?`)) return;
    try {
      await api(`/communities/${activeCommunityId}/members/${member.id}`, { method: 'DELETE' });
      setDetails((current) => current ? { ...current, members: current.members.filter((item) => item.id !== member.id) } : current);
      notify(`${member.username} foi removido.`);
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível remover este membro.'); }
  };
  const deleteMessage = async (message: Message) => {
    if (!window.confirm('Apagar esta mensagem permanentemente?')) return;
    try { await api(`/messages/${message.id}`, { method: 'DELETE' }); setMessages((current) => current.filter((item) => item.id !== message.id)); setPinnedMessages((current) => current.filter((item) => item.id !== message.id)); notify('Mensagem apagada.'); }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível apagar a mensagem.'); }
  };
  const togglePin = async (message: Message) => {
    try {
      if (message.pinnedAt) { await api(`/messages/${message.id}/pin`, { method: 'DELETE' }); setMessages((current) => current.map((item) => item.id === message.id ? { ...item, pinnedAt: null, pinnedBy: null } : item)); setPinnedMessages((current) => current.filter((item) => item.id !== message.id)); notify('Mensagem desafixada.'); }
      else { const result = await api<{ message: { id: string; pinnedAt: string; pinnedBy: string } }>(`/messages/${message.id}/pin`, { method: 'POST', body: '{}' }); const updated = { ...message, ...result.message }; setMessages((current) => current.map((item) => item.id === message.id ? { ...item, ...result.message } : item)); setPinnedMessages((current) => current.some((item) => item.id === message.id) ? current.map((item) => item.id === message.id ? { ...item, ...result.message } : item) : [...current, updated]); notify('Mensagem fixada.'); }
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível atualizar a mensagem.'); }
  };
  const applyModeration = async (action: 'mute' | 'ban', member: Member, duration: DurationChoice, reason: string) => {
    if (!activeCommunityId) throw new Error('Não foi possível encontrar a comunidade.');
    if (action === 'mute') {
      const result = await api<{ expiresAt: string }>(`/communities/${activeCommunityId}/members/${member.id}/mute`, { method: 'POST', body: JSON.stringify({ duration, reason }) });
      setDetails((current) => current ? { ...current, members: current.members.map((item) => item.id === member.id ? { ...item, mutedUntil: result.expiresAt } : item) } : current);
      notify(`${member.username} foi silenciado até às ${new Intl.DateTimeFormat('pt-MZ', { hour: '2-digit', minute: '2-digit' }).format(new Date(result.expiresAt))}.`);
      return;
    }
    await api(`/communities/${activeCommunityId}/members/${member.id}/ban`, { method: 'POST', body: JSON.stringify({ duration, reason }) });
    setDetails((current) => current ? { ...current, members: current.members.filter((item) => item.id !== member.id) } : current);
    notify(`${member.username} foi banido${duration ? ` durante ${durationLabel(duration)}` : ' permanentemente'}.`);
  };
  const removeMemberMute = async (member: Member) => {
    if (!activeCommunityId) return;
    try {
      await api(`/communities/${activeCommunityId}/members/${member.id}/mute`, { method: 'DELETE' });
      setDetails((current) => current ? { ...current, members: current.members.map((item) => item.id === member.id ? { ...item, mutedUntil: null } : item) } : current);
      notify('Silenciamento removido.');
    } catch { notify('Não foi possível remover o silêncio. Tenta de novo.'); }
  };
  const updateProfile = async (data: ProfileSaveData) => {
    setProfileBusy(true);
    const stagedUploads: Array<{ kind: ProfileMediaKind; uploadId: string }> = [];
    try {
      const stageImage = async (kind: ProfileMediaKind, file: File): Promise<string> => {
        const staged = await api<{ uploadId: string; uploadUrl: string }>('/profile/media/upload', { method: 'POST', body: JSON.stringify({ kind, mimeType: 'image/jpeg', sizeBytes: file.size }) });
        stagedUploads.push({ kind, uploadId: staged.uploadId });
        await uploadWithProgress(staged.uploadUrl, file, 'image/jpeg', () => undefined);
        return staged.uploadId;
      };
      const avatarUploadId = data.avatarFile ? await stageImage('avatar', data.avatarFile) : undefined;
      const bannerUploadId = data.bannerFile ? await stageImage('banner', data.bannerFile) : undefined;
      const payload: Record<string, unknown> = {
        username: data.username,
        avatarUrl: data.avatarUrl,
        aboutMe: data.aboutMe,
        bannerUrl: data.bannerUrl,
        bannerColor: data.bannerColor,
        statusText: data.statusText,
        presencePreference: data.presencePreference,
        visibility: data.visibility,
      };
      if (avatarUploadId) { delete payload.avatarUrl; payload.avatarUploadId = avatarUploadId; }
      if (bannerUploadId) { delete payload.bannerUrl; payload.bannerUploadId = bannerUploadId; }
      const result = await api<OwnProfileResponse>('/profile', { method: 'PATCH', body: JSON.stringify(payload) });
      setOwnProfile(result);
      onUserChange(result.user);
      setDetails((current) => current ? { ...current, members: current.members.map((member) => member.id === user.id ? { ...member, username: result.user.username, avatarUrl: result.user.avatarUrl } : member) } : current);
      setMessages((current) => current.map((message) => message.authorId === user.id ? { ...message, username: result.user.username, avatarUrl: result.user.avatarUrl } : message));
      setPinnedMessages((current) => current.map((message) => message.authorId === user.id ? { ...message, username: result.user.username, avatarUrl: result.user.avatarUrl } : message));
      setModal(null);
      notify('Perfil atualizado.');
    } catch (cause) {
      await Promise.allSettled(stagedUploads.map(({ kind, uploadId }) => api<{ ok: boolean }>(`/profile/media/upload/${kind}/${uploadId}`, { method: 'DELETE' })));
      notify(cause instanceof Error ? cause.message : 'Não foi possível atualizar o perfil.');
    }
    finally { setProfileBusy(false); }
  };
  const appClass = `app-shell ${mobileView === 'channels' ? 'mobile-channels' : 'mobile-chat'}${directMessagesOpen ? ' direct-messages-mode' : ''}`;
  const communityUnread = Math.min(99, details?.channels.reduce((total, item) => total + (item.unreadCount ?? 0), 0) ?? 0);

  return <div className={appClass}>
    <nav className="community-rail" aria-label="Navegação principal">
      <button className="rail-logo" aria-label="Início" onClick={() => { setDirectMessagesOpen(false); setDetails(null); setChannel(null); setExplore(false); }}>m</button>
      <div className="rail-divider"/>
      <button className={`community-chip dm-rail-button${directMessagesOpen ? ' active' : ''}`} title="Mensagens privadas" aria-label={`Mensagens privadas${dmUnreadCount ? `, ${dmUnreadCount} não lidas` : ''}`} aria-pressed={directMessagesOpen} onClick={() => { setQuickOpen(false); if (directMessagesOpen) { setDirectMessagesOpen(false); setMobileView('channels'); } else { setDirectMessagesOpen(true); setMobileView('chat'); } }}>{dmUnreadCount > 0 && <span className="dm-rail-unread">{dmUnreadCount}</span>}m</button>
      {communities.map((item) => { const unread = details?.community.id === item.id ? communityUnread : item.unreadCount ?? 0; return <button key={item.id} title={item.name} aria-label={`${item.name}${unread ? `, ${unread} mensagens não lidas` : ''}`} className={`community-chip ${details?.community.id === item.id ? 'active' : ''}`} onClick={() => void openCommunity(item.id)}>{initials(item.name)}{unread > 0 && <span className="community-unread-badge">{unread > 99 ? '99+' : unread}</span>}</button>; })}
      <button className="community-chip" title="Criar comunidade" aria-label="Criar comunidade" onClick={() => setModal('community')}>＋</button>
      <div className="rail-divider"/>
      <button className={`community-chip ${explore ? 'active' : ''}`} title="Explorar comunidades" aria-label="Explorar comunidades" onClick={() => { setDirectMessagesOpen(false); void loadExplore(); }}>⌕</button>
    </nav>

    <aside className="side-panel">
      <header className="side-header">
        <strong>{explore ? 'Explorar' : details?.community.name ?? 'As tuas conversas'}</strong>
        <div style={{ display: 'flex', gap: 4 }}>
          {details && canOpenAdmin && <button className="icon-button admin-gear-button" title="Administração da comunidade" aria-label={`Administração da comunidade${(details.pendingJoinRequests ?? 0) > 0 ? `, ${details.pendingJoinRequests} pedidos pendentes` : ''}`} onClick={() => setModal('admin')}>⚙{(details.pendingJoinRequests ?? 0) > 0 && <span className="admin-pending-badge">{details.pendingJoinRequests! > 99 ? '99+' : details.pendingJoinRequests}</span>}</button>}
          {details && canCreateInvites && <button className="icon-button" title="Criar convite" aria-label="Criar convite" onClick={() => void createInvite()}>↗</button>}
          {details && isManager && <button className="icon-button" title="Criar canal" aria-label="Criar canal" onClick={() => setModal('channel')}>＋</button>}
        </div>
      </header>
      {explore ? <div className="side-content">
        <label className="field">Pesquisar<input className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void loadExplore(search); }} placeholder="Nome ou categoria"/></label>
        <button className="secondary" style={{ width: '100%', marginTop: 8 }} onClick={() => void loadExplore(search)}>Pesquisar</button>
        <div className="section-label">Comunidades públicas</div>
        {publicCommunities.map((item) => <button className="channel-row" key={item.id} onClick={() => void joinPublic(item)}>{item.name}</button>)}
      </div> : details ? <div className="side-content">
        <div className="section-label">Canais</div>
        <ChannelSidebar channels={details.channels} categories={details.categories ?? []} current={channel} canManage={details.myPermissions.includes('manage_channels')} onSelect={selectChannel} onDelete={(item) => void deleteChannel(item)}/>
        <div className="section-label">Membros · {details.members.length}</div>
        {details.members.map((member) => <div className="member-row member-action-row" key={member.id} title={roleLabels[member.role] ?? member.role} tabIndex={0} aria-label={`Ações de ${member.username}`} onClick={(event) => { if ((event.target as HTMLElement).closest('select')) return; openMemberMenu(member, rectFor(event.currentTarget.getBoundingClientRect(), navigator.maxTouchPoints > 0)); }} onContextMenu={(event) => { event.preventDefault(); openMemberMenu(member, rectFor(event.currentTarget.getBoundingClientRect())); }} onKeyDown={(event) => { if ((event.target === event.currentTarget) && (event.key === 'Enter' || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) { event.preventDefault(); openMemberMenu(member, rectFor(event.currentTarget.getBoundingClientRect())); } }}>
          <button className="profile-avatar-button" aria-label={`Abrir o perfil de ${member.username}`} onClick={(event) => { event.stopPropagation(); openMemberProfile(member.id); }}><Avatar name={member.username} url={member.avatarUrl} size={27}/></button>
          <button className="member-name profile-name-link" onClick={(event) => { event.stopPropagation(); openMemberProfile(member.id); }}>{member.username}</button>
          {isManager && member.role !== 'owner' ? <select className="role-select" aria-label={`Cargo de ${member.username}`} value={member.role} onClick={(event) => event.stopPropagation()} onChange={(event) => void changeRole(member, event.target.value)}>
            <option value="admin">Admin</option><option value="moderator">Moderador</option><option value="member">Membro</option>
          </select> : <small className="member-role">{roleLabels[member.role] ?? member.role}</small>}
          <button type="button" className="member-remove member-action-trigger" aria-label={`Mais ações de ${member.username}`} onClick={(event) => { event.stopPropagation(); openMemberMenu(member, rectFor(event.currentTarget.getBoundingClientRect(), navigator.maxTouchPoints > 0)); }}>⋯</button>
        </div>)}
        {details.myRole && details.myRole !== 'owner' && <button className="text-button" style={{ marginTop: 12 }} onClick={() => void leaveCommunity()}>Sair da comunidade</button>}
        {!details.myRole && <p className="muted" style={{ fontSize: 12, padding: 8 }}>Consulta as regras e pede entrada para participar.</p>}
      </div> : <div className="side-content">
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>Escolhe uma comunidade à esquerda ou explora espaços públicos.</p>
        <button className="secondary" style={{ width: '100%' }} onClick={() => setModal('community')}>＋ Criar comunidade</button>
      </div>}
      <footer className="side-footer">
        <button className="identity-control" aria-label={`Abrir o teu perfil, ${user.username}`} onClick={() => void openOwnProfile()}>
          <Avatar name={user.username} url={user.avatarUrl} size={36}/>
          <span className="identity-copy"><strong>{user.username}</strong><span className="muted">{!online ? 'Sem ligação' : reconnecting ? 'A reconectar…' : 'Ligado'}</span></span>
        </button>
        <div className="audio-control-group">
          <button className={`audio-button ${audioPreferences.micMuted ? 'audio-off' : ''}`} aria-label={audioPreferences.micMuted ? 'Ativar microfone' : 'Silenciar microfone'} title={audioPreferences.micMuted ? 'Ativar microfone' : 'Silenciar microfone'} onClick={toggleMute}><Glyph name="mic"/>{audioPreferences.micMuted && <span className="audio-slash"/>}</button>
          <button className="audio-chevron" aria-label="Opções do microfone" title="Opções do microfone" onClick={() => setAudioMenu(audioMenu === 'input' ? null : 'input')}><Glyph name="chevron"/></button>
        </div>
        <div className="audio-control-group">
          <button className={`audio-button ${audioPreferences.deafened ? 'audio-off' : ''}`} aria-label={audioPreferences.deafened ? 'Ativar som' : 'Ensurdecer'} title={audioPreferences.deafened ? 'Ativar som' : 'Ensurdecer'} onClick={toggleDeafen}><Glyph name="headphones"/>{audioPreferences.deafened && <span className="audio-slash"/>}</button>
          <button className="audio-chevron" aria-label="Opções dos auscultadores" title="Opções dos auscultadores" onClick={() => setAudioMenu(audioMenu === 'output' ? null : 'output')}><Glyph name="chevron"/></button>
        </div>
        <button className="audio-button settings-button" aria-label="Abrir Definições" title="Definições" onClick={() => { setSettingsSection('account'); setModal('settings'); }}><Glyph name="settings"/></button>
      </footer>
    </aside>

    <main className="main-panel">
      <header className="topbar">
        {mobileView === 'chat' && <button className="icon-button mobile-back" onClick={() => { if (directMessagesOpen) { setDirectMessagesOpen(false); setMobileView('channels'); } else if (mobileHistory.current.length > 1) window.history.back(); else navigateMobile('channels'); }} aria-label={directMessagesOpen ? 'Fechar mensagens' : 'Voltar aos canais'}>←</button>}
        <h1>{directMessagesOpen ? 'Mensagens' : explore ? 'Descobrir comunidades' : channel ? `${channel.kind === 'voice' ? '◖' : channel.readOnly ? '🔒' : '#'} ${channel.name}` : details?.community.name ?? 'Mavuno'}</h1>
        <span className={`network-status ${online ? '' : 'offline'}`}>{!online ? '● Sem ligação. A tentar novamente...' : reconnecting ? '● A reconectar…' : '● Ligado'}</span>
        {!directMessagesOpen && channel?.kind === 'text' && <span className="muted">Mensagens</span>}
      </header>

      {!directMessagesOpen && !explore && details && <CommunityCover community={details.community}/>}

      {!directMessagesOpen && !explore && channel?.kind === 'text' && pinnedMessages.length > 0 && <div className="pinned-strip"><span aria-hidden="true">◆</span><strong>Fixadas</strong><button onClick={() => void openPinned()}>{pinnedMessages.length} mensagem(ns) · Ver lista</button></div>}
      {!directMessagesOpen && !explore && channel?.kind === 'text' && newMessages > 0 && <div className="new-messages-strip" role="status"><span>{newMessages} {newMessages === 1 ? 'mensagem nova' : 'mensagens novas'}</span><button onClick={() => void markChannelRead(channel.id)}>Marcar como lida</button></div>}
      {directMessagesOpen ? <DirectMessagesView currentUserId={user.id} initialTarget={directMessageTarget ? { id: directMessageTarget.id, username: directMessageTarget.username, avatarUrl: directMessageTarget.avatarUrl } : null} onInitialTargetHandled={() => setDirectMessageTarget(null)} onUnreadCount={setDmUnreadCount} onCall={(peer) => { const member = details?.members.find((item) => item.id === peer.id); setCallTarget(member ?? { id: peer.id, username: peer.username, avatarUrl: peer.avatarUrl, role: 'member' }); }} onProfile={openMemberProfile} notify={notify}/> : explore ? <section className="explore-view">
        <h2>Encontra o teu espaço</h2><p className="muted">Explora comunidades abertas ou pesquisa por nome e categoria.</p>
        <div className="community-cards">{publicCommunities.map((item) => <article className="community-card" key={item.id}>
          <span className="muted" style={{ fontSize: 11 }}>{item.category}</span><h3>{item.name}</h3><p className="muted" style={{ fontSize: 13 }}>{item.description || 'Uma comunidade Mavuno.'}</p>
          <button className="secondary" onClick={() => void joinPublic(item)}>Ver comunidade</button>
        </article>)}</div>
        {publicCommunities.length === 0 && <div className="empty-state">Ainda não encontrámos comunidades públicas com esse termo.</div>}
      </section> : channel?.kind === 'voice' ? <VoicePanel channel={channel} notify={notify} preferences={audioPreferences} onAudioChange={saveAudio}/> : channel ? <>
        <div className="message-list" ref={listRef} aria-live="polite" onScroll={(event) => {
          const element = event.currentTarget;
          nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          if (nearBottom.current) { setNewMessages(0); if ((details?.channels.find((item) => item.id === channel.id)?.unreadCount ?? 0) > 0) void markChannelRead(channel.id); }
        }}>
          {hasMore && <button className="text-button" style={{ display: 'block', margin: '0 auto 10px' }} disabled={loadingMessages} onClick={() => {
            const oldest = messages[0];
            if (oldest) { nearBottom.current = false; void fetchMessages(channel.id, `${oldest.createdAt}~${oldest.id}`); }
          }}>{loadingMessages ? 'A carregar…' : 'Carregar mensagens anteriores'}</button>}
          {messages.length === 0 && !loadingMessages && <div className="empty-state">Ainda não há mensagens. Começa a conversa.</div>}
          {messages.map((message, index) => <MessageRow key={message.id} message={message} grouped={index > 0 && messages[index - 1]?.authorId === message.authorId} own={message.authorId === user.id} onOpenMenu={(rect) => openMessageMenu(message, rect)} onProfile={() => openMemberProfile(message.authorId)} onReply={() => setReply(message)} onRetry={() => void sendMessage(message.body, message.clientMessageId, message.replyToId)} onQuickReaction={(emoji) => void toggleReaction(message, emoji)} renderBody={<InlineEmojiText text={message.body} assets={communityAssets}/>}>
            {message.sticker && <MessageStickerView sticker={message.sticker}/>}
            <AttachmentGallery attachments={message.attachments ?? []} onDownload={downloadAttachment} notify={notify}/>
            {!!message.reactions?.length && <div className="reaction-pills">{message.reactions.map((reaction) => <ReactionPill key={reaction.emoji} assets={communityAssets} reaction={reaction} pending={pendingReactionKeys.has(`${message.id}:${reaction.emoji}`)} onToggle={() => void toggleReaction(message, reaction.emoji)} onLongPress={() => void showReactionUsers(message.id, reaction.emoji)}/>)}</div>}
            {Array.from(pendingReactionKeys).some((key) => key.startsWith(`${message.id}:`)) && !(message.reactions ?? []).some((reaction) => pendingReactionKeys.has(`${message.id}:${reaction.emoji}`)) && <small className="reaction-pending-label">A enviar…</small>}
          </MessageRow>)}
          {newMessages > 0 && <button className="new-messages-button" onClick={() => { if (listRef.current) listRef.current.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); nearBottom.current = true; setNewMessages(0); }}>Novas mensagens · Descer</button>}
        </div>
        <div className="composer-wrap">
          {reply && <div className="muted" style={{ maxWidth: 850, margin: '0 auto 6px', fontSize: 12 }}>A responder a {reply.username}: {reply.body.slice(0, 60)} <button className="text-button" onClick={() => setReply(null)}>Cancelar</button></div>}
          {attachmentDrafts.length > 0 && <div className="attachment-draft-list" aria-live="polite">
            {attachmentDrafts.map((item) => <div className="attachment-draft-card" key={item.key}>
              {item.kind === 'image' || item.kind === 'gif' ? <img className="attachment-draft-preview" src={item.previewUrl} alt=""/> : item.kind === 'video' ? <video className="attachment-draft-preview" src={item.previewUrl} muted preload="none"/> : <span className="attachment-draft-file-icon" aria-hidden="true">▤</span>}
              <div className="attachment-draft-details"><strong title={item.file.name}>{item.file.name}</strong><small>{item.status === 'uploading' ? `A enviar · ${item.progress}%` : item.status === 'failed' ? 'Falhou' : item.status === 'ready' ? 'Pronto para enviar' : 'Pronto'} · {formatFileSize(item.file.size)}</small>
                {item.status === 'uploading' && <progress max={100} value={item.progress} aria-label={`Envio de ${item.file.name}`}/>}
                {item.status === 'failed' && <button type="button" className="text-button" disabled={attachmentBusy} onClick={() => void sendMessage(draft.trim(), crypto.randomUUID(), reply?.id ?? null)}>Tentar de novo</button>}
              </div>
              <button type="button" className="attachment-remove-button" disabled={attachmentBusy} aria-label={`Remover ${item.file.name}`} title="Remover anexo" onClick={() => removeAttachmentDraft(item.key)}>×</button>
            </div>)}
          </div>}
          <form className="composer" onSubmit={(event) => { event.preventDefault(); const value = draft.trim(); if (!value && attachmentDrafts.length === 0) return; void sendMessage(value).then((sent) => { if (sent) setDraft(''); }); }}>
            <input ref={composerInputRef} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={2000} disabled={attachmentBusy || (channel.readOnly && channel.canWrite === false)} placeholder={channel.readOnly && channel.canWrite === false ? 'Neste canal só moderadores podem escrever.' : `Escreve uma mensagem em #${channel.name}`} aria-label="Escrever mensagem"/>
            {shortcodeSuggestions.length > 0 && <div className="asset-autocomplete" role="listbox" aria-label="Sugestões de emoji">{shortcodeSuggestions.map((item) => <button type="button" role="option" key={item.token} onClick={() => { const current = draft; const start = current.lastIndexOf(':'); setDraft(`${current.slice(0, start)}${item.token} `); composerInputRef.current?.focus(); }}>{item.title} <small>:{item.search}:</small></button>)}</div>}
            <button type="button" className="secondary composer-attach-button" aria-label="Anexar ficheiro" title="Anexar ficheiro" disabled={attachmentBusy || (channel.readOnly && channel.canWrite === false)} onClick={() => void openAttachmentPicker()}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m21.4 11.1-8.9 8.9a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg></button>
            <button type="button" className="secondary composer-emoji-button" aria-label="Inserir emoji" title="Inserir emoji" disabled={attachmentBusy || (channel.readOnly && channel.canWrite === false)} onClick={() => setEmojiPickerTarget('composer')}>☺</button><button type="button" className="secondary composer-emoji-button" aria-label="Escolher sticker" title="Escolher sticker" disabled={attachmentBusy || (channel.readOnly && channel.canWrite === false)} onClick={() => setStickerPickerOpen(true)}>▧</button>
            <button className="primary send-button" disabled={attachmentBusy || (channel.readOnly && channel.canWrite === false) || (!draft.trim() && attachmentDrafts.length === 0)} aria-label="Enviar mensagem">Enviar</button>
          </form>
          <input ref={photoInputRef} className="attachment-file-input" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm" aria-label="Escolher foto ou vídeo" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; setAttachmentPickerOpen(false); void addSelectedFiles(files); }}/>
          <input ref={documentInputRef} className="attachment-file-input" type="file" multiple accept=".pdf,.txt,.docx,.xlsx,.pptx,.zip,application/pdf,text/plain,application/zip" aria-label="Escolher ficheiro" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; setAttachmentPickerOpen(false); void addSelectedFiles(files); }}/>
        </div>
      </> : <section className="welcome-panel">
        <span className="brand-mark">m</span>
        <h2>{details ? details.community.name : 'Conversas com espaço para todos.'}</h2>
        <p className="muted">{details ? details.community.description || 'Uma comunidade Mavuno.' : 'Cria uma comunidade ou descobre uma conversa pública.'}</p>
        {details && <p className="muted" style={{ fontSize: 13 }}>{details.community.category} · {details.members.length} membros · {details.channels.length} canais</p>}
        {details && !details.myRole && <p className="notice">Consulta as regras e pede entrada para participar.</p>}
        {!details && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button className="primary" onClick={() => setModal('community')}>Criar comunidade</button><button className="secondary" onClick={() => void loadExplore()}>Explorar comunidades</button></div>}
      </section>}
    </main>

    <div className={`floating-wrap${floatingDragPosition ? ' dragging' : ''}`} style={{ left: `${floatingDragPosition?.left ?? (floatingPosition.side === 'left' ? 0 : Math.max(0, window.innerWidth - FLOATING_BUTTON_SIZE))}px`, top: `${floatingDragPosition?.top ?? floatingPosition.top}px` }}>
      <button ref={floatingButtonRef} className={`floating-button${tucked ? ` tucked-${floatingPosition.side}` : ''}`} aria-label="Abrir painel rápido; arrasta para mover. Usa as setas para posicionar." aria-expanded={quickOpen} onClick={() => { if (suppressFloatingClickRef.current) { suppressFloatingClickRef.current = false; return; } resetTuckTimer(); setQuickOpen((value) => !value); }} onPointerDown={startFloatingPointer} onPointerMove={moveFloatingPointer} onPointerUp={finishFloatingPointer} onPointerCancel={finishFloatingPointer} onKeyDown={moveFloatingWithKeyboard}>m</button>
      {quickOpen && <div className={`quick-panel${floatingPosition.side === 'left' ? ' quick-panel-left' : ''}`} onPointerDown={resetTuckTimer}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><strong>Conversas rápidas</strong><button className="text-button" onClick={() => setQuickOpen(false)} aria-label="Fechar painel">×</button></div>
        {quickItems.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>As tuas comunidades aparecem aqui.</p> : quickItems.map((item) => <button key={item.id} className="channel-row" onClick={() => { void openCommunity(item.id); setQuickOpen(false); }}>{item.name}</button>)}
        <button className="text-button quick-dm-entry" onClick={() => { setDirectMessagesOpen(true); setMobileView('chat'); setQuickOpen(false); }}>Mensagens privadas{dmUnreadCount > 0 && <span className="unread-badge">{dmUnreadCount}</span>}</button><button className="text-button" onClick={() => { setDirectMessagesOpen(false); void loadExplore(); setQuickOpen(false); }}>Explorar comunidades</button>
      </div>}
    </div>
    {pinnedOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPinnedOpen(false); }}><section className="modal pinned-modal" role="dialog" aria-modal="true" aria-labelledby="pinned-title"><h2 id="pinned-title">Mensagens fixadas</h2><div className="pinned-list">{pinnedMessages.map((item) => <article className="pinned-item" key={item.id}><strong>{item.username}</strong><time className="message-time">{formatTime(item.createdAt)}</time><p><InlineEmojiText text={item.body} assets={communityAssets}/></p>{item.sticker && <MessageStickerView sticker={item.sticker}/>}<AttachmentGallery attachments={item.attachments ?? []} onDownload={downloadAttachment} notify={notify}/>{!!item.reactions?.length && <div className="reaction-pills">{item.reactions.map((reaction) => <ReactionPill key={reaction.emoji} assets={communityAssets} reaction={reaction} pending={pendingReactionKeys.has(`${item.id}:${reaction.emoji}`)} onToggle={() => void toggleReaction(item, reaction.emoji)} onLongPress={() => void showReactionUsers(item.id, reaction.emoji)}/>)}</div>}</article>)}</div><div className="modal-actions"><button className="secondary" onClick={() => setPinnedOpen(false)}>Fechar</button></div></section></div>}
    {attachmentPickerOpen && createPortal(<div className="attachment-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAttachmentPickerOpen(false); }}><section className="attachment-picker-sheet" role="dialog" aria-modal="true" aria-labelledby="attachment-picker-title" onMouseDown={(event) => event.stopPropagation()}><div className="attachment-picker-handle"/><h2 id="attachment-picker-title">Adicionar anexo</h2><button type="button" className="attachment-picker-option" onClick={() => photoInputRef.current?.click()}><span aria-hidden="true">▧</span><span><strong>Foto ou vídeo</strong><small>JPEG, PNG, WebP, GIF, MP4 ou WebM</small></span></button><button type="button" className="attachment-picker-option" onClick={() => documentInputRef.current?.click()}><span aria-hidden="true">▤</span><span><strong>Ficheiro</strong><small>PDF, TXT, DOCX, XLSX, PPTX ou ZIP</small></span></button><button type="button" className="secondary attachment-picker-cancel" onClick={() => setAttachmentPickerOpen(false)}>Cancelar</button></section></div>, document.body)}
    {emojiPickerTarget && <CommunityEmojiPicker assets={communityAssets} onClose={() => setEmojiPickerTarget(null)} onSelect={(emoji) => { const target = emojiPickerTarget; setEmojiPickerTarget(null); if (target === 'composer') insertComposerEmoji(emoji); else { const message = messages.find((item) => item.id === target.messageId) ?? pinnedMessages.find((item) => item.id === target.messageId); if (message) void toggleReaction(message, emoji.startsWith('<:builtin:') ? `builtin:${emoji.slice(10, -1)}` : emoji.startsWith('<:') ? `custom:${emoji.slice(emoji.lastIndexOf(':') + 1, -1)}` : emoji); } }}/>}
    {stickerPickerOpen && <CommunityStickerPicker assets={communityAssets} onClose={() => setStickerPickerOpen(false)} onSelect={(item, builtin) => { setStickerPickerOpen(false); if (!channel || channel.kind !== 'text') return; const key = builtin ? item.key : undefined; const id = builtin ? undefined : item.id; void api<{message: Message}>(`/channels/${channel.id}/messages`, { method: 'POST', body: JSON.stringify({ clientMessageId: crypto.randomUUID(), body: '', stickerId: id, builtinKey: key }) }).then(({message}) => setMessages((current) => mergeMessage(current, message))).catch((cause) => notify(cause instanceof Error ? cause.message : 'Não foi possível enviar o sticker.')); }}/>} 
    {reactionUsers && <ReactionUsersSheet emoji={reactionUsers.emoji} users={reactionUsers.users} loading={reactionUsers.loading} onClose={() => setReactionUsers(null)}/>}
    {actionMenu && details && <ActionMenuOverlay target={actionMenu} actorId={user.id} actorRole={details.myRole} actorPermissions={details.myPermissions} targetMember={actionMenu.kind === 'member' ? actionMenu.member : details.members.find((member) => member.id === actionMenu.message.authorId) ?? (actionMenu.message.authorId === user.id ? undefined : { id: actionMenu.message.authorId, username: actionMenu.message.username, avatarUrl: actionMenu.message.avatarUrl, role: 'unknown' })} onClose={closeActionMenu} onReply={(message) => setReply(message)} onDelete={deleteMessage} onDownload={downloadMessageAttachments} onPin={togglePin} onQuickReaction={(message, emoji) => void toggleReaction(message, emoji)} onMoreReactions={(message) => setEmojiPickerTarget({ messageId: message.id })} onProfile={openMemberProfile} onCall={(member) => setCallTarget(member)} onDirectMessage={openDirectMessage} onModerate={(action, member) => setModerationPrompt({ action, member })} onUnmute={(member) => void removeMemberMute(member)} onKick={kickMember} notify={notify}/>}
    {moderationPrompt && <ModerationPrompt action={moderationPrompt.action} member={moderationPrompt.member} onClose={() => setModerationPrompt(null)} onConfirm={async (duration, reason) => { await applyModeration(moderationPrompt.action, moderationPrompt.member, duration, reason); setModerationPrompt(null); }}/>
    }
    {modal === 'community' && <CommunityModal busy={busy} onClose={() => setModal(null)} onCreate={(data) => void createCommunity(data)}/>}
    {modal === 'channel' && <ChannelModal busy={busy} onClose={() => setModal(null)} onCreate={(data) => void createChannel(data)}/>}
    {modal === 'admin' && details && <AdminModal details={details} requestRefresh={joinRequestsRefresh} inviteRefresh={inviteListRefresh} onClose={() => setModal(null)} onSaved={() => { if (activeCommunityId) void api<CommunityDetails>(`/communities/${activeCommunityId}`).then((fresh) => { setDetails(fresh); const unreadCount = Math.min(99, fresh.channels.reduce((total, item) => total + (item.unreadCount ?? 0), 0)); setCommunities((items) => items.map((item) => item.id === activeCommunityId ? { ...item, unreadCount } : item)); setChannel((current) => current ? fresh.channels.find((item) => item.id === current.id) ?? null : null); }).catch(() => undefined); }}/>}
    {joinTarget && <JoinFlowModal info={joinInfo} loading={joinInfoLoading} error={joinInfoError} busy={joinBusy} onClose={closeJoinFlow} onJoin={(accepted) => void submitJoin(accepted)} onCancelRequest={() => void cancelJoinRequest()}/>}
    {inviteShare && <InviteSharePanel share={inviteShare} onChange={(patch) => setInviteShare((current) => current ? { ...current, ...patch } : current)} onClose={() => setInviteShare(null)} onCopy={() => void copyInviteLink()} onShare={() => void shareInviteLink()} onCreate={(duration, maxUses) => void createInvite(duration, maxUses)}/>}
    {modal === 'profile' && <ProfileModal data={ownProfile} loading={profileLoading} error={ownProfileError} online={online && !reconnecting} busy={profileBusy} onClose={() => setModal(null)} onReload={() => void openOwnProfile()} onLogout={onLogout} onSave={(data) => void updateProfile(data)}/>}
    {modal === 'memberProfile' && <MemberProfileSheet profile={memberProfile} loading={memberProfileLoading} error={memberProfileError} onClose={closeMemberProfile} onMessage={openDirectMessage}/>}
    {modal === 'account' && <AccountModal user={user} onClose={() => setModal(null)} onEditProfile={() => setModal('profile')}/>}
    {modal === 'settings' && <SettingsModal user={user} section={settingsSection} preferences={audioPreferences} devices={audioDevices} audioError={audioError} onSection={setSettingsSection} onChange={saveAudio} onRequestMic={() => void requestMicrophone()} onOpenProfile={() => { setModal('profile'); void openOwnProfile(); }} onLogout={logout} notify={notify} onClose={() => setModal(null)}/>}
    <PrivateCallDock target={callTarget} onClearTarget={() => setCallTarget(null)} notify={notify} preferences={audioPreferences} onAudioChange={saveAudio}/>
    {audioMenu && createPortal(<div className="audio-portal" onMouseDown={(event) => { if (event.target === event.currentTarget) setAudioMenu(null); }}><AudioMenu kind={audioMenu} preferences={audioPreferences} devices={audioDevices} error={audioError} onClose={() => setAudioMenu(null)} onToggleMute={toggleMute} onToggleDeafen={toggleDeafen} onChange={saveAudio} onRequestMic={() => void requestMicrophone()} onSettings={() => { setAudioMenu(null); setSettingsSection('voice'); setModal('settings'); }}/></div>, document.body)}
    {actionToast && <div className="toast toast-action" role="status"><span>{actionToast.text}</span><button className="primary" onClick={() => { const destination = actionToast.communityId; setActionToast(null); void openCommunity(destination); }}>Abrir</button><button className="icon-button" aria-label="Fechar aviso" onClick={() => setActionToast(null)}>×</button></div>}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

function ReactionPill({ reaction, pending, assets, onToggle, onLongPress }: { reaction: ReactionSummary; pending: boolean; assets: CommunityAssetsResponse | null; onToggle: () => void; onLongPress: () => void }) {
  const timer = useRef<number | null>(null);
  const held = useRef(false);
  const clear = () => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; };
  return <button type="button" className={`reaction-pill ${reaction.reactedByMe ? 'reacted' : ''} ${pending ? 'pending' : ''}`} aria-label={`${reaction.emoji}, ${reaction.count}; ${reaction.reactedByMe ? 'já reagiste' : 'ainda não reagiste'}. Toca para alternar; mantém premido para ver quem reagiu.`} aria-pressed={reaction.reactedByMe} disabled={pending} onPointerDown={() => { held.current = false; clear(); timer.current = window.setTimeout(() => { held.current = true; onLongPress(); }, 520); }} onPointerUp={clear} onPointerLeave={clear} onPointerCancel={clear} onContextMenu={(event) => { event.preventDefault(); clear(); held.current = true; onLongPress(); }} onClick={() => { if (held.current) { held.current = false; return; } onToggle(); }}><AssetReaction value={reaction.emoji} assets={assets}/><span>{reaction.count}</span>{pending && <small>A enviar…</small>}</button>;
}
function EmojiPicker({ onClose, onSelect }: { onClose: () => void; onSelect: (emoji: string) => void }) {
  const [category, setCategory] = useState<EmojiCategoryId>('recentes');
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => { try { const stored = JSON.parse(localStorage.getItem('mavuno.recent-emojis') ?? '[]'); if (Array.isArray(stored)) setRecent(stored.filter((item): item is string => typeof item === 'string' && EMOJI_INDEX.has(item)).slice(0, 24)); } catch { setRecent([]); } }, []);
  const items = useMemo(() => {
    const all = EMOJI_CATEGORIES.flatMap((item) => item.items);
    const normalized = (value: string) => value.toLocaleLowerCase('pt').normalize('NFD').replace(/\p{Diacritic}/gu, '');
    if (query.trim()) { const term = normalized(query.trim()); return all.filter((item) => normalized(item.name).includes(term)); }
    if (category === 'recentes') return recent.map((emoji) => EMOJI_INDEX.get(emoji)).filter((item): item is NonNullable<typeof item> => Boolean(item));
    return EMOJI_CATEGORIES.find((item) => item.id === category)?.items ?? [];
  }, [category, query, recent]);
  const choose = (emoji: string) => { const next = [emoji, ...recent.filter((item) => item !== emoji)].slice(0, 24); setRecent(next); try { localStorage.setItem('mavuno.recent-emojis', JSON.stringify(next)); } catch { /* recent emojis are a convenience only */ } onSelect(emoji); };
  return <div className="modal-backdrop emoji-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal emoji-sheet" role="dialog" aria-modal="true" aria-labelledby="emoji-picker-title"><div className="sheet-heading"><h2 id="emoji-picker-title">Escolher emoji</h2><button className="icon-button" aria-label="Fechar seletor" onClick={onClose}>×</button></div><label className="emoji-search"><span className="sr-only">Pesquisar emoji</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar por nome…"/></label><div className="emoji-tabs" role="tablist" aria-label="Categorias de emoji">{EMOJI_CATEGORIES.map((item) => <button key={item.id} role="tab" aria-selected={!query && category === item.id} className={!query && category === item.id ? 'active' : ''} onClick={() => { setQuery(''); setCategory(item.id); }}>{item.label}</button>)}</div><div className="emoji-grid" role="list" aria-label={query ? 'Resultados da pesquisa' : EMOJI_CATEGORIES.find((item) => item.id === category)?.label}>{items.map((item) => <button type="button" role="listitem" key={item.emoji} title={item.name} aria-label={item.name} onClick={() => choose(item.emoji)}>{item.emoji}</button>)}</div>{items.length === 0 && <p className="empty-state">{query ? 'Não encontrámos esse emoji.' : 'Ainda não há emojis recentes.'}</p>}</section></div>;
}
function ReactionUsersSheet({ emoji, users, loading, onClose }: { emoji: string; users: string[]; loading: boolean; onClose: () => void }) {
  return <div className="modal-backdrop reaction-users-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal reaction-users-sheet" role="dialog" aria-modal="true" aria-labelledby="reaction-users-title"><div className="sheet-heading"><h2 id="reaction-users-title">{emoji} Reações</h2><button className="icon-button" aria-label="Fechar lista" onClick={onClose}>×</button></div>{loading ? <p className="muted">A carregar…</p> : users.length ? <div className="reaction-user-list">{users.map((username, index) => <div className="reaction-user" key={`${username}-${index}`}>{username}</div>)}</div> : <p className="empty-state">Ainda ninguém reagiu com este emoji.</p>}</section></div>;
}
function PrivateCallDock({ target, onClearTarget, notify, preferences, onAudioChange }: { target: Member | null; onClearTarget: () => void; notify: (text: string) => void; preferences: AudioPreferences; onAudioChange: (patch: Partial<AudioPreferences>) => void }) {
  const [call, setCall] = useState<PrivateCall | null>(null); const [error, setError] = useState(''); const [connecting, setConnecting] = useState(false); const [micOn, setMicOn] = useState(true); const roomRef = useRef<Room | null>(null); const connectedCall = useRef<string | null>(null);
  const statusLabels: Record<PrivateCallStatus, string> = { initiated: 'A chamar…', ringing: 'A tocar', accepted: 'Aceite', connecting: 'A ligar', in_progress: 'Em curso', rejected: 'Recusada', timeout: 'Sem resposta', failed: 'Falhada', ended: 'Terminada' };
  useEffect(() => {
    const socket = io({ withCredentials: true, transports: ['websocket', 'polling'] });
    socket.on('call:incoming', (event: { callId: string; caller: { id: string; username: string; avatarUrl?: string | null }; status: PrivateCallStatus }) => setCall({ id: event.callId, status: event.status, peer: event.caller }));
    socket.on('profile:updated', (event: { userId: string; profile: MemberProfile }) => setCall((current) => {
      if (!current?.peer || current.peer.id !== event.userId) return current;
      const peer: NonNullable<PrivateCall['peer']> = { ...current.peer, username: event.profile.username };
      if (Object.hasOwn(event.profile, 'avatarUrl')) peer.avatarUrl = event.profile.avatarUrl;
      else delete peer.avatarUrl;
      return { ...current, peer };
    }));
    socket.on('call:status', (event: { callId: string; status: PrivateCallStatus }) => {
      if (['ended', 'rejected', 'timeout', 'failed'].includes(event.status)) { const activeRoom = roomRef.current; roomRef.current = null; void releaseLiveKitRoom(activeRoom); for (const element of document.querySelectorAll('audio[data-mavuno="voice"]')) element.remove(); }
      setCall((current) => current?.id === event.callId ? { ...current, status: event.status } : current);
    });
    return () => { socket.disconnect(); void releaseLiveKitRoom(roomRef.current); roomRef.current = null; for (const element of document.querySelectorAll('audio[data-mavuno="voice"]')) element.remove(); };
  }, []);
  useEffect(() => {
    if (!call || call.status !== 'ringing' || !call.id) return;
    const timer = window.setTimeout(() => { void api(`/calls/${call.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'timeout' }) }).then(() => setCall((current) => current?.id === call.id ? { ...current, status: 'timeout' } : current)).catch(() => setCall((current) => current?.id === call.id ? { ...current, status: 'timeout' } : current)); }, 45_000);
    return () => window.clearTimeout(timer);
  }, [call?.id, call?.status]);
  useEffect(() => {
    if (!target || call) return;
    setError(''); setCall({ id: '', status: 'initiated', peer: { id: target.id, username: target.username, avatarUrl: target.avatarUrl } });
    void api<{ call: { id: string; status: PrivateCallStatus; peer: PrivateCall['peer'] } }>('/calls', { method: 'POST', body: JSON.stringify({ calleeId: target.id }) }).then((result) => setCall({ id: result.call.id, status: result.call.status, peer: result.call.peer })).catch((cause) => { setCall({ id: '', status: 'failed', peer: { id: target.id, username: target.username, avatarUrl: target.avatarUrl } }); setError(cause instanceof Error ? cause.message : 'Não foi possível iniciar a chamada.'); }).finally(onClearTarget);
  }, [target, call, onClearTarget]);
  const update = async (status: 'accepted' | 'rejected' | 'timeout' | 'ended') => { if (!call?.id) return; try { await api(`/calls/${call.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); setCall((current) => current ? { ...current, status } : current); if (status !== 'accepted') { await releaseLiveKitRoom(roomRef.current); roomRef.current = null; } } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível atualizar a chamada.'); } };
  useEffect(() => {
    if (!call || call.status !== 'accepted' || connectedCall.current === call.id) return;
    connectedCall.current = call.id; setConnecting(true); setError(''); setCall((current) => current ? { ...current, status: 'connecting' } : current);
    void api<{ token: string; serverUrl: string }>(`/calls/${call.id}/token`, { method: 'POST', body: '{}' }).then(async (credentials) => { const { Room: LiveKitRoom, RoomEvent } = await import('livekit-client'); const room = new LiveKitRoom({ adaptiveStream: true, dynacast: true }); roomRef.current = room; room.on(RoomEvent.TrackSubscribed, (track) => { const audio = track.attach(); audio.dataset.mavuno = 'voice'; audio.volume = audioOutputVolume(preferences); document.body.appendChild(audio); void audio.play().catch(() => setError('O navegador bloqueou o áudio. Ativa o som e tenta novamente.')); }); room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((element) => element.remove())); room.on(RoomEvent.Disconnected, () => { roomRef.current = null; setCall((current) => current ? { ...current, status: 'ended' } : current); }); await room.connect(credentials.serverUrl, credentials.token); await room.localParticipant.setMicrophoneEnabled(!preferences.micMuted && !preferences.deafened); setMicOn(!preferences.micMuted && !preferences.deafened); setCall((current) => current ? { ...current, status: 'in_progress' } : current); }).catch((cause) => { connectedCall.current = null; if (call.id) void api(`/calls/${call.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'ended' }) }).catch(() => undefined); void releaseLiveKitRoom(roomRef.current); roomRef.current = null; setCall((current) => current ? { ...current, status: 'failed' } : current); const name = cause instanceof Error ? cause.name : ''; setError(name === 'NotAllowedError' || name === 'PermissionDeniedError' ? 'Permite o acesso ao microfone nas definições do navegador e tenta novamente.' : 'A voz ainda não está disponível. Tenta mais tarde.'); }).finally(() => setConnecting(false));
  }, [call, preferences]);
  useEffect(() => { const room = roomRef.current; if (room) void room.localParticipant.setMicrophoneEnabled(!preferences.micMuted && !preferences.deafened).then(() => setMicOn(!preferences.micMuted && !preferences.deafened)).catch(() => undefined); for (const audio of document.querySelectorAll<HTMLAudioElement>('audio[data-mavuno="voice"]')) audio.volume = audioOutputVolume(preferences); }, [preferences]);
  if (!call) return null;
  const toggleMicrophone = async () => { const room = roomRef.current; if (!room) { onAudioChange({ micMuted: !preferences.micMuted }); return; } try { const next = !micOn; await room.localParticipant.setMicrophoneEnabled(next); setMicOn(next); onAudioChange({ micMuted: !next }); } catch { setError('Não foi possível alterar o microfone. Verifica a permissão do microfone.'); } };
  const close = async () => { await releaseLiveKitRoom(roomRef.current); roomRef.current = null; if (call.id && !['ended', 'rejected', 'timeout', 'failed'].includes(call.status)) await update('ended'); else setCall(null); };
  return <aside className="call-dock" role="dialog" aria-label="Chamada privada"><div className="call-dock-header"><Avatar name={call.peer?.username ?? 'Utilizador'} url={call.peer?.avatarUrl} size={38}/><div><strong>Chamada com {call.peer?.username ?? 'utilizador'}</strong><span className="muted">{statusLabels[call.status]}{connecting ? '…' : ''}</span></div></div>{error && <p className="error-banner">{error}</p>}{call.status === 'ringing' && <div className="call-actions"><button className="primary" onClick={() => void update('accepted')}>Aceitar</button><button className="secondary" onClick={() => void update('rejected')}>Recusar</button></div>}{call.status === 'in_progress' && <div className="call-actions"><button className="secondary" onClick={() => void toggleMicrophone()}>{micOn ? 'Silenciar' : 'Ativar microfone'}</button><button className="danger-button" onClick={() => void close()}>Terminar</button></div>}{['failed', 'ended', 'rejected', 'timeout'].includes(call.status) && <button className="secondary" onClick={() => setCall(null)}>Fechar</button>}</aside>;
}

function AdminModal({ details, requestRefresh, inviteRefresh, onClose, onSaved }: { details: CommunityDetails; requestRefresh: number; inviteRefresh: number; onClose: () => void; onSaved: () => void }) {
  type AuditEntry = { id: string; action: string; reason: string; durationSeconds: number | null; metadata: string; createdAt: string; actorId: string; actorUsername: string; targetUserId: string | null };
  type BanEntry = { userId: string; username: string; reason: string; createdAt: string; expiresAt: string | null; bannedBy: string };
  const permissions = details.myPermissions;
  const canEditCommunity = permissions.includes('manage_community');
  const canReviewRequests = permissions.includes('manage_members');
  const canManageInvites = permissions.includes('create_invites');
  const canReviewBans = permissions.includes('ban_members') || permissions.includes('view_audit_log');
  const canRevokeBans = permissions.includes('ban_members');
  const canManageChannels = permissions.includes('manage_channels');
  const canReviewAudit = permissions.includes('view_audit_log');
  const initialTab = canEditCommunity || canManageChannels ? 'community' : canReviewRequests ? 'requests' : canManageInvites ? 'invites' : canReviewBans ? 'bans' : 'audit';
  const [busy, setBusy] = useState(false);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [tab, setTab] = useState<'community' | 'invites' | 'requests' | 'bans' | 'audit'>(initialTab);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [bans, setBans] = useState<BanEntry[]>([]);
  const [invites, setInvites] = useState<ActiveInvitation[]>([]);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [loadingBans, setLoadingBans] = useState(false);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [welcomeLength, setWelcomeLength] = useState(details.community.welcomeMessage?.length ?? 0);
  const [coverUrl, setCoverUrl] = useState(details.community.coverUrl ?? '');
  const [coverColor, setCoverColor] = useState(details.community.coverColor ?? COVER_COLORS[0]);
  const [categoryName, setCategoryName] = useState('');
  const [categoryNames, setCategoryNames] = useState<Record<string, string>>({});
  const loadAudit = async () => {
    setLoadingAudit(true); setError('');
    try { const result = await api<{ entries: AuditEntry[] }>(`/communities/${details.community.id}/audit-log`); setEntries(result.entries); }
    catch { setError('Não foi possível carregar o registo de ações.'); }
    finally { setLoadingAudit(false); }
  };
  const loadBans = async () => {
    setLoadingBans(true); setError('');
    try { const result = await api<{ bans: BanEntry[] }>(`/communities/${details.community.id}/bans`); setBans(result.bans); }
    catch { setError('Não foi possível carregar os banimentos.'); }
    finally { setLoadingBans(false); }
  };
  const loadInvites = async () => {
    setLoadingInvites(true); setError('');
    try { const result = await api<{ invites: ActiveInvitation[] }>(`/communities/${details.community.id}/invites`); setInvites(result.invites); }
    catch { setError('Não foi possível carregar os convites ativos.'); }
    finally { setLoadingInvites(false); }
  };
  const loadRequests = async () => {
    setLoadingRequests(true); setError('');
    try { const result = await api<{ requests: JoinRequest[] }>(`/communities/${details.community.id}/join-requests`); setRequests(result.requests); }
    catch { setError('Não foi possível carregar os pedidos de entrada.'); }
    finally { setLoadingRequests(false); }
  };
  useEffect(() => {
    if (tab === 'audit') void loadAudit();
    else if (tab === 'bans') void loadBans();
    else if (tab === 'invites') void loadInvites();
    else if (tab === 'requests') void loadRequests();
  }, [tab, details.community.id, requestRefresh, inviteRefresh]);
  const addCategory = async () => {
    const name = categoryName.trim();
    if (!name) return;
    try { await api(`/communities/${details.community.id}/channel-categories`, { method: 'POST', body: JSON.stringify({ name }) }); setCategoryName(''); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível criar a categoria.'); }
  };
  const renameCategory = async (category: ChannelCategory) => {
    const name = (categoryNames[category.id] ?? category.name).trim();
    try { await api(`/communities/${details.community.id}/channel-categories/${category.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível guardar o nome.'); }
  };
  const reorderCategory = async (category: ChannelCategory, direction: -1 | 1) => {
    const ordered = (details.categories ?? []).slice().sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((item) => item.id === category.id); const neighbor = ordered[index + direction];
    if (!neighbor) return;
    try {
      await api(`/communities/${details.community.id}/channel-categories/${category.id}`, { method: 'PATCH', body: JSON.stringify({ position: neighbor.position }) });
      await api(`/communities/${details.community.id}/channel-categories/${neighbor.id}`, { method: 'PATCH', body: JSON.stringify({ position: category.position }) }); onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível ordenar as categorias.'); }
  };
  const deleteCategory = async (category: ChannelCategory) => {
    if (!window.confirm('Apagar esta categoria? Os canais ficam sem categoria.')) return;
    try { await api(`/communities/${details.community.id}/channel-categories/${category.id}`, { method: 'DELETE' }); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível apagar a categoria.'); }
  };
  const updateChannelOrder = async (channel: Channel, direction: -1 | 1) => {
    const siblings = details.channels.filter((item) => (item.categoryId ?? null) === (channel.categoryId ?? null)).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const index = siblings.findIndex((item) => item.id === channel.id); const neighbor = siblings[index + direction];
    if (!neighbor) return;
    try {
      await api(`/channels/${channel.id}/organization`, { method: 'PATCH', body: JSON.stringify({ categoryId: channel.categoryId ?? null, position: neighbor.position ?? 0 }) });
      await api(`/channels/${neighbor.id}/organization`, { method: 'PATCH', body: JSON.stringify({ categoryId: neighbor.categoryId ?? null, position: channel.position ?? 0 }) }); onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível ordenar os canais.'); }
  };
  const moveChannel = async (channel: Channel, categoryId: string) => {
    const nextCategoryId = categoryId || null;
    const position = nextCategoryId === (channel.categoryId ?? null) ? channel.position ?? 0 : details.channels.filter((item) => (item.categoryId ?? null) === nextCategoryId).length;
    try { await api(`/channels/${channel.id}/organization`, { method: 'PATCH', body: JSON.stringify({ categoryId: nextCategoryId, position }) }); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível mover o canal.'); }
  };
  const setChannelReadOnly = async (channel: Channel, readOnly: boolean) => {
    try { await api(`/channels/${channel.id}/read-only`, { method: 'PATCH', body: JSON.stringify({ readOnly }) }); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível guardar a opção.'); }
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(''); const form = new FormData(event.currentTarget);
    try {
      await api(`/communities/${details.community.id}`, { method: 'PATCH', body: JSON.stringify({ name: String(form.get('name')), description: String(form.get('description')), category: String(form.get('category')), coverUrl: coverUrl.trim() || null, coverColor, rules: String(form.get('rules')), welcomeMessage: String(form.get('welcomeMessage')), requireApproval: Boolean(form.get('requireApproval')) }) });
      onSaved(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível guardar.'); }
    finally { setBusy(false); }
  };
  const revokeBan = async (userId: string) => {
    if (!window.confirm('Revogar o banimento deste utilizador?')) return;
    setError('');
    try { await api(`/communities/${details.community.id}/bans/${userId}`, { method: 'DELETE' }); await loadBans(); setSuccess('Banimento revogado.'); }
    catch { setError('Não foi possível revogar o banimento.'); }
  };
  const revokeInvite = async (invite: ActiveInvitation) => {
    if (!window.confirm('Revogar este convite? A ligação deixará de funcionar.')) return;
    setError('');
    try { await api(`/communities/${details.community.id}/invites/${invite.id}`, { method: 'DELETE' }); await loadInvites(); setSuccess('Convite revogado.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível revogar o convite.'); }
  };
  const decideRequest = async (request: JoinRequest, action: 'approve' | 'reject') => {
    setBusyRequestId(request.id); setError(''); setSuccess('');
    try {
      await api(`/communities/${details.community.id}/join-requests/${request.id}/${action}`, { method: 'POST', body: '{}' });
      await loadRequests(); setSuccess(action === 'approve' ? `Pedido de ${request.username} aprovado.` : `Pedido de ${request.username} recusado.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível decidir este pedido.'); }
    finally { setBusyRequestId(null); }
  };
  const actionLabels: Record<string, string> = {
    'member.banned': 'Banimento aplicado', 'member.unbanned': 'Banimento revogado', 'member.kicked': 'Membro expulso',
    'member.muted': 'Silenciamento aplicado', 'member.unmuted': 'Silenciamento removido', 'member.role_changed': 'Cargo alterado',
    'community.updated': 'Comunidade atualizada', 'message.pinned': 'Mensagem fixada', 'message.unpinned': 'Mensagem desafixada',
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal admin-modal" role="dialog" aria-modal="true" aria-labelledby="admin-title">
      <div className="admin-heading"><div><h2 id="admin-title">Administração</h2><p className="muted">Boas-vindas, convites, pedidos e atividade da comunidade.</p></div><button type="button" className="icon-button" aria-label="Fechar administração" onClick={onClose}>×</button></div>
      <div className="admin-tabs" role="tablist" aria-label="Secções de administração">
        {(canEditCommunity || canManageChannels) && <button className={tab === 'community' ? 'active' : ''} role="tab" aria-selected={tab === 'community'} onClick={() => setTab('community')}>Comunidade</button>}
        {canManageInvites && <button className={tab === 'invites' ? 'active' : ''} role="tab" aria-selected={tab === 'invites'} onClick={() => setTab('invites')}>Convites</button>}
        {canReviewRequests && <button className={tab === 'requests' ? 'active' : ''} role="tab" aria-selected={tab === 'requests'} onClick={() => setTab('requests')}>Pedidos{(details.pendingJoinRequests ?? 0) > 0 ? ` · ${details.pendingJoinRequests}` : ''}</button>}
        {canReviewBans && <button className={tab === 'bans' ? 'active' : ''} role="tab" aria-selected={tab === 'bans'} onClick={() => setTab('bans')}>Banimentos</button>}
        {canReviewAudit && <button className={tab === 'audit' ? 'active' : ''} role="tab" aria-selected={tab === 'audit'} onClick={() => setTab('audit')}>Auditoria</button>}
      </div>
      {error && <p className="error-banner" role="alert">{error}</p>}{success && <p className="notice" role="status">{success}</p>}
      {tab === 'community' && (canEditCommunity || canManageChannels) && <form onSubmit={(event) => void save(event)}>
        {canEditCommunity && <>
        <label className="field">Nome<input name="name" defaultValue={details.community.name} required maxLength={80}/></label>
        <label className="field">Descrição<textarea name="description" defaultValue={details.community.description} maxLength={500} rows={3}/></label>
        <label className="field">Categoria<input name="category" defaultValue={details.community.category} required maxLength={40}/></label>
        <label className="field">Imagem de capa (link)<input type="url" inputMode="url" value={coverUrl} onChange={(event) => setCoverUrl(event.target.value)} placeholder="https://exemplo.com/imagem.jpg"/></label>
        <div className="field"><span>Cor de capa</span><div className="cover-palette" role="group" aria-label="Escolher cor de capa">{COVER_COLORS.map((color) => <button type="button" key={color} aria-label={`Cor ${color}`} aria-pressed={coverColor === color} style={{ backgroundColor: color }} onClick={() => setCoverColor(color)}/>)}</div></div>
        <div className="cover-preview"><span className="cover-preview-label">Pré-visualização</span><CommunityCover community={{ name: details.community.name, coverUrl: coverUrl.trim() || null, coverColor }} compact/></div>
        <label className="field">Mensagem de boas-vindas<textarea name="welcomeMessage" defaultValue={details.community.welcomeMessage ?? ''} maxLength={1000} rows={3} onChange={(event) => setWelcomeLength(event.target.value.length)}/><small className="muted form-counter">{welcomeLength}/1000</small></label>
        <label className="field">Regras<textarea name="rules" defaultValue={details.community.rules ?? ''} maxLength={4000} rows={4} placeholder="Regras da comunidade"/></label>
        <label className="approval-toggle"><input name="requireApproval" type="checkbox" defaultChecked={details.community.requireApproval ?? false}/><span><strong>Pedir aprovação para entrar</strong><small>Quem usar um convite fica à espera de aprovação.</small></span></label>
        <div className="admin-summary"><strong>Gestão de membros</strong><span>{details.members.length} membros · {details.channels.length} canais</span><span>Altera cargos e gere silenciamentos pelo menu de cada membro.</span></div>
        </>}
        {canEditCommunity && <section className="channel-management-settings"><h3>Emojis e stickers</h3><CustomAssetsManager communityId={details.community.id} onUpdated={onSaved}/></section>}
        {canManageChannels && <section className="channel-management-settings">
          <h3>Categorias e canais</h3>
          <div className="category-settings-row"><input aria-label="Nome da nova categoria" value={categoryName} maxLength={40} onChange={(event) => setCategoryName(event.target.value)} placeholder="Nome da categoria"/><button type="button" className="secondary" disabled={!categoryName.trim()} onClick={() => void addCategory()}>Criar categoria</button></div>
          {(details.categories ?? []).slice().sort((a, b) => a.position - b.position).map((category, index, ordered) => <div className="category-settings-row" key={category.id}>
            <input aria-label={`Nome da categoria ${category.name}`} value={categoryNames[category.id] ?? category.name} maxLength={40} onChange={(event) => setCategoryNames((current) => ({ ...current, [category.id]: event.target.value }))}/>
            <button type="button" className="secondary" aria-label={`Subir categoria ${category.name}`} disabled={index === 0} onClick={() => void reorderCategory(category, -1)}>↑</button><button type="button" className="secondary" aria-label={`Descer categoria ${category.name}`} disabled={index === ordered.length - 1} onClick={() => void reorderCategory(category, 1)}>↓</button>
            <button type="button" className="secondary" onClick={() => void renameCategory(category)}>Guardar</button><button type="button" className="danger-button" onClick={() => void deleteCategory(category)}>Apagar</button>
          </div>)}
          <div className="channel-settings-list">{details.channels.map((item) => <div className="channel-settings-row" key={item.id}>
            <strong>{item.kind === 'voice' ? '◖' : '#'} {item.name}</strong>
            <select aria-label={`Categoria de ${item.name}`} value={item.categoryId ?? ''} onChange={(event) => void moveChannel(item, event.target.value)}><option value="">Sem categoria</option>{(details.categories ?? []).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
            <button type="button" className="secondary" aria-label={`Subir ${item.name}`} onClick={() => void updateChannelOrder(item, -1)}>↑</button><button type="button" className="secondary" aria-label={`Descer ${item.name}`} onClick={() => void updateChannelOrder(item, 1)}>↓</button>
            <label className="channel-readonly-toggle"><input type="checkbox" checked={Boolean(item.readOnly)} onChange={(event) => void setChannelReadOnly(item, event.target.checked)}/>Só moderadores podem escrever</label>
          </div>)}</div>
        </section>}
        <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Fechar</button>{canEditCommunity && <button className="primary" disabled={busy}>{busy ? 'A guardar…' : 'Guardar alterações'}</button>}</div>
      </form>}
      {tab === 'invites' && canManageInvites && <div className="admin-list-section"><div className="admin-list-heading"><strong>Convites ativos</strong><button className="text-button" onClick={() => void loadInvites()} disabled={loadingInvites}>Atualizar</button></div>
        {loadingInvites ? <div className="empty-state">A carregar…</div> : invites.length === 0 ? <div className="empty-state">Não há convites ativos.</div> : <div className="admin-clean-list">{invites.map((invite) => <div className="admin-list-row" key={invite.id}><div className="admin-list-copy"><strong>Criado por {invite.createdBy}</strong><span className="muted">{invite.expiresAt ? `Termina ${new Intl.DateTimeFormat('pt-MZ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(invite.expiresAt))}` : 'Sem validade'} · {invite.maxUses === null ? 'Usos ilimitados' : `${invite.useCount}/${invite.maxUses} utilizações`}</span><span className="muted">Criado em {new Intl.DateTimeFormat('pt-MZ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(invite.createdAt))}</span></div><button className="danger-button" onClick={() => void revokeInvite(invite)}>Revogar</button></div>)}</div>}
      </div>}
      {tab === 'requests' && canReviewRequests && <div className="admin-list-section"><div className="admin-list-heading"><strong>Pedidos de entrada</strong><button className="text-button" onClick={() => void loadRequests()} disabled={loadingRequests}>Atualizar</button></div>
        {loadingRequests ? <div className="empty-state">A carregar…</div> : requests.length === 0 ? <div className="empty-state">Não há pedidos pendentes.</div> : <div className="admin-clean-list">{requests.map((request) => <div className="join-request-row" key={request.id}><div className="join-request-person"><Avatar name={request.username} url={request.avatarUrl} size={38}/><div className="admin-list-copy"><strong>{request.username}</strong><span className="muted">Pedido em {new Intl.DateTimeFormat('pt-MZ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(request.createdAt))}</span></div></div><div className="join-request-actions"><button className="primary" disabled={busyRequestId === request.id} onClick={() => void decideRequest(request, 'approve')}>Aprovar</button><button className="secondary" disabled={busyRequestId === request.id} onClick={() => void decideRequest(request, 'reject')}>Recusar</button></div></div>)}</div>}
      </div>}
      {tab === 'bans' && canReviewBans && <div className="admin-list-section"><div className="admin-list-heading"><strong>Banimentos ativos</strong><button className="text-button" onClick={() => void loadBans()} disabled={loadingBans}>Atualizar</button></div>
        {loadingBans ? <div className="empty-state">A carregar…</div> : bans.length === 0 ? <div className="empty-state">Não há banimentos ativos.</div> : <div className="admin-clean-list">{bans.map((ban) => <div className="admin-list-row" key={ban.userId}><div className="admin-list-copy"><strong>{ban.username}</strong><span className="muted">{banExpiryLabel(ban.expiresAt)} · aplicado em {new Intl.DateTimeFormat('pt-MZ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ban.createdAt))}</span><span className="muted">Aplicado por {ban.bannedBy}</span>{ban.reason && <span className="muted">{ban.reason}</span>}</div>{canRevokeBans && <button className="secondary" onClick={() => void revokeBan(ban.userId)}>Revogar</button>}</div>)}</div>}
      </div>}
      {tab === 'audit' && canReviewAudit && <div className="admin-list-section"><div className="admin-list-heading"><strong>Atividade recente</strong><button className="text-button" onClick={() => void loadAudit()} disabled={loadingAudit}>Atualizar</button></div>
        {loadingAudit ? <div className="empty-state">A carregar…</div> : entries.length === 0 ? <div className="empty-state">Ainda não há ações registadas.</div> : <div className="admin-clean-list">{entries.map((entry) => <article className="audit-row" key={entry.id}><div className="audit-row-top"><strong>{actionLabels[entry.action] ?? 'Ação da comunidade'}</strong><time>{new Intl.DateTimeFormat('pt-MZ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.createdAt))}</time></div><span className="muted">Por {entry.actorUsername}{entry.targetUserId ? ` · Utilizador ${entry.targetUserId.slice(0, 8)}` : ''}</span>{entry.reason && <p>{entry.reason}</p>}</article>)}</div>}
      </div>}
    </section>
  </div>;
}
function JoinFlowModal({ info, loading, error, busy, onClose, onJoin, onCancelRequest }: { info: JoinFlowInfo | null; loading: boolean; error: string; busy: boolean; onClose: () => void; onJoin: (acceptedRules: boolean) => void; onCancelRequest: () => void }) {
  const [acceptedRules, setAcceptedRules] = useState(false);
  useEffect(() => { setAcceptedRules(!info?.rules.trim()); }, [info?.id]);
  const rulesRequired = Boolean(info?.rules.trim());
  const headline = info?.alreadyMember ? 'Já fazes parte desta comunidade' : info?.requestPending ? 'Pedido enviado' : info?.requireApproval ? 'Pedir para entrar' : 'Antes de entrar';
  return <div className="modal-backdrop join-flow-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal join-flow-modal" role="dialog" aria-modal="true" aria-labelledby="join-flow-title">
      <div className="join-flow-heading"><div><h2 id="join-flow-title">{info?.name ?? 'Convite'}</h2><p className="muted">{headline}</p></div><button className="icon-button" aria-label="Fechar" onClick={onClose}>×</button></div>
      {loading ? <div className="empty-state">A carregar…</div> : info ? <>
        <CommunityCover community={{ name: info.name, coverUrl: info.coverUrl ?? info.imageUrl, coverColor: info.coverColor }} compact/>
        <div className="join-flow-details"><p className="join-flow-description">{info.description || 'Uma comunidade Mavuno.'}</p><span className="muted">{info.memberCount} {info.memberCount === 1 ? 'membro' : 'membros'}</span>
          {info.welcomeMessage?.trim() && <section className="join-welcome-message"><h3>Boas-vindas</h3><p>{info.welcomeMessage}</p></section>}
          {rulesRequired && <section className="join-rules-block"><h3>Regras</h3><div className="join-rules-text">{info.rules}</div><label className="join-rules-accept"><input type="checkbox" checked={acceptedRules} disabled={info.alreadyMember || info.requestPending} onChange={(event) => setAcceptedRules(event.target.checked)}/><span>Li e aceito as regras desta comunidade.</span></label></section>}
          {info.requestPending && <div className="notice join-pending-notice" role="status">O teu pedido está à espera de aprovação dos moderadores. Não gastaste uma utilização do convite.</div>}
          {!info.alreadyMember && !info.requestPending && info.requireApproval && <p className="muted join-approval-help">Um moderador irá analisar o teu pedido antes de poderes participar.</p>}
        </div>
        {error && <p className="error-banner" role="alert">{error}</p>}
        <div className="modal-actions join-flow-actions">
          {info.requestPending ? <><button type="button" className="secondary" onClick={onClose}>Fechar</button>{info.requestId && <button type="button" className="danger-button" disabled={busy} onClick={onCancelRequest}>{busy ? 'A cancelar…' : 'Cancelar pedido'}</button>}</> : <><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button type="button" className="primary" disabled={busy || (rulesRequired && !acceptedRules)} onClick={() => onJoin(info.alreadyMember ? false : acceptedRules)}>{busy ? 'A processar…' : info.alreadyMember ? 'Abrir comunidade' : info.requireApproval ? 'Pedir para entrar' : 'Entrar na comunidade'}</button></>}
        </div>
      </> : <><p className="error-banner" role="alert">{error || 'Este convite já não é válido.'}</p><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Fechar</button></div></>}
    </section>
  </div>;
}

function InviteSharePanel({ share, onChange, onClose, onCopy, onShare, onCreate }: { share: { url: string; showOptions: boolean; duration: InviteDuration; maxUses: InviteUseLimit; copyBlocked: boolean }; onChange: (patch: Partial<typeof share>) => void; onClose: () => void; onCopy: () => void; onShare: () => void; onCreate: (duration: InviteDuration, maxUses: InviteUseLimit) => Promise<void> | void }) {
  const [creating, setCreating] = useState(false);
  const createAnother = async () => { setCreating(true); try { await onCreate(share.duration, share.maxUses); } finally { setCreating(false); } };
  return <div className="modal-backdrop invite-share-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal invite-share-panel" role="dialog" aria-modal="true" aria-labelledby="invite-share-title">
      <div className="sheet-heading"><div><h2 id="invite-share-title">Convidar para a comunidade</h2><p className="muted">Partilha esta ligação com as pessoas que queres convidar.</p></div><button className="icon-button" aria-label="Fechar convite" onClick={onClose}>×</button></div>
      {share.url ? <><label className="field">Ligação do convite<input className="invite-link-input" type="url" readOnly value={share.url} onFocus={(event) => event.currentTarget.select()} aria-label="Link do convite"/></label><div className="invite-share-actions"><button type="button" className="primary" onClick={onShare}>Partilhar</button><button type="button" className="secondary" onClick={onCopy}>{share.copyBlocked ? 'Copiar' : 'Copiar outra vez'}</button></div><button type="button" className="text-button invite-options-toggle" aria-expanded={share.showOptions} onClick={() => onChange({ showOptions: !share.showOptions })}>{share.showOptions ? 'Fechar opções' : 'Criar outro link com opções diferentes'}</button></> : <p className="muted">Escolhe a validade e quantas vezes o convite pode ser usado.</p>}
      {share.showOptions && <div className="invite-options-form"><label className="field">Duração<select value={share.duration} onChange={(event) => onChange({ duration: event.target.value as InviteDuration })}><option value="30m">30 minutos</option><option value="1h">1 hora</option><option value="1d">1 dia</option><option value="7d">7 dias</option><option value="never">Sem validade</option></select></label><label className="field">Limite de utilizações<select value={share.maxUses ?? 'unlimited'} onChange={(event) => onChange({ maxUses: event.target.value === 'unlimited' ? null : Number(event.target.value) as InviteUseLimit })}><option value="1">1 utilização</option><option value="5">5 utilizações</option><option value="25">25 utilizações</option><option value="unlimited">Ilimitadas</option></select></label><button type="button" className="primary" disabled={creating} onClick={() => void createAnother()}>{creating ? 'A criar…' : share.url ? 'Criar novo link' : 'Criar convite'}</button></div>}
    </section>
  </div>;
}

function CommunityModal({ busy, onClose, onCreate }: {
  busy: boolean; onClose: () => void;
  onCreate: (data: { name: string; description: string; category: string; isPrivate: boolean }) => void;
}) {
  const [isPrivate, setPrivate] = useState(false);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="community-title">
      <h2 id="community-title">Criar comunidade</h2>
      <form onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); onCreate({ name: String(form.get('name')), description: String(form.get('description')), category: String(form.get('category')), isPrivate }); }}>
        <label className="field">Nome<input name="name" minLength={2} maxLength={80} required placeholder="ex.: Clube de leitura"/></label>
        <label className="field">Descrição<textarea name="description" maxLength={500} rows={3} placeholder="O que reúne esta comunidade?"/></label>
        <label className="field">Categoria<input name="category" maxLength={40} defaultValue="Geral"/></label>
        <label style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={isPrivate} onChange={(event) => setPrivate(event.target.checked)}/>Comunidade privada (só por convite)</label>
        <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary" disabled={busy}>{busy ? 'A criar…' : 'Criar'}</button></div>
      </form>
    </section>
  </div>;
}

function ChannelModal({ busy, onClose, onCreate }: {
  busy: boolean; onClose: () => void; onCreate: (data: { name: string; topic: string; kind: 'text' | 'voice' }) => void;
}) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="channel-title">
      <h2 id="channel-title">Criar canal</h2>
      <form onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); onCreate({ name: String(form.get('name')), topic: String(form.get('topic')), kind: form.get('kind') === 'voice' ? 'voice' : 'text' }); }}>
        <label className="field">Nome<input name="name" minLength={2} maxLength={60} pattern="[A-Za-zÀ-ž0-9_-]+" required placeholder="ex.: projectos"/></label>
        <label className="field">Assunto<input name="topic" maxLength={200} placeholder="Tema deste canal"/></label>
        <label className="field">Tipo<select name="kind"><option value="text">Texto</option><option value="voice">Voz</option></select></label>
        <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary" disabled={busy}>{busy ? 'A criar…' : 'Criar canal'}</button></div>
      </form>
    </section>
  </div>;
}

function profileDate(value: string): string {
  return new Intl.DateTimeFormat('pt-MZ', { dateStyle: 'long' }).format(new Date(value));
}

const profileVisibilityOptions: Array<{ key: keyof ProfileVisibility; title: string; help: string }> = [
  { key: 'avatar', title: 'Foto de perfil', help: 'Outros membros veem a tua foto.' },
  { key: 'about', title: 'Sobre mim', help: 'Outros membros veem o texto que escreveste.' },
  { key: 'status', title: 'Estado', help: 'Outros membros veem o teu estado.' },
  { key: 'joinDate', title: 'Data de entrada no Mavuno', help: 'Outros membros veem quando criaste a conta.' },
  { key: 'commonCommunities', title: 'Comunidades em comum', help: 'Cada pessoa vê apenas as comunidades onde ambos participam.' },
  { key: 'email', title: 'Email', help: 'Só proprietários e administradores podem ver, se ativares.' },
  { key: 'banner', title: 'Imagem de fundo', help: 'Outros membros veem a imagem ou cor escolhida.' },
];
const profileColors = ['#203b2d', '#3a5f4b', '#355070', '#4d3b5f', '#6b3f46', '#674d2d', '#5b5f32', '#2f5558', '#503f32', '#423b59', '#5a394f', '#263d52'];
const presenceLabels = { online: 'Disponível', away: 'Ausente', dnd: 'Não incomodar', invisible: 'Invisível' } as const;
function safeHttps(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try { return new URL(value.trim()).protocol === 'https:' ? value.trim() : null; } catch { return null; }
}
function safeProfileImage(value: string | null | undefined, userId: string, kind: ProfileMediaKind): string | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  return profileMediaReferenceOwnedBy(trimmed, userId, kind) ? trimmed : safeHttps(trimmed);
}
function presenceColor(presence?: string, online?: boolean): string {
  if (presence === 'away') return '#e8bd63';
  if (presence === 'dnd') return '#f07878';
  if (presence === 'invisible' || online === false) return '#87978c';
  return '#82e3a6';
}
function ProfileBanner({ name, url, color, children }: { name: string; url?: string | null; color?: string | null; children: ReactNode }) {
  const [failed, setFailed] = useState(false);
  const background = !failed && url ? `url("${url}") center/cover` : (color || fallbackBannerColor(name));
  return <div className="profile-banner" style={{ background }}>{url && !failed && <img className="profile-banner-image" src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> }<div className="profile-banner-shade"/>{children}</div>;
}
function ProfileCompactCard({ profile, own, onExpand, onClose, onEdit, onStatus }: { profile: MemberProfile; own: boolean; onExpand: () => void; onClose: () => void; onEdit?: () => void; onStatus?: () => void }) {
  const presence = profile.presence ?? (profile.online ? 'online' : 'invisible');
  return <div className="modal-backdrop profile-card-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="profile-card" role="dialog" aria-modal="true" aria-labelledby="profile-card-title">
      <ProfileBanner name={profile.username} url={profile.bannerUrl} color={profile.bannerColor}><button className="profile-close icon-button" onClick={onClose} aria-label="Fechar perfil">×</button></ProfileBanner>
      <div className="profile-card-body"><div className="profile-card-head"><span className="profile-large-avatar"><Avatar name={profile.username} url={profile.avatarUrl} size={80}/><span className="profile-status-ring" style={{ backgroundColor: presenceColor(presence, profile.online) }}/></span><div className="profile-card-title"><h2 id="profile-card-title">{profile.username}</h2><span className="profile-presence"><span className="online-dot" style={{ backgroundColor: presenceColor(presence, profile.online) }}/>{presenceLabels[presence as keyof typeof presenceLabels] ?? 'Desligado'}</span></div></div>
        {profile.statusText ? <p className="profile-status-bubble">{profile.statusText}</p> : own ? <button className="profile-status-bubble profile-status-empty" onClick={onStatus}>＋ Define um estado</button> : null}
        {profile.aboutMe && <p className="profile-about-clamp">{profile.aboutMe}</p>}
        <div className="profile-card-actions"><button className="secondary" onClick={onExpand}>Expandir perfil</button>{own && <><button className="secondary" onClick={onEdit}>Editar perfil</button><button className="secondary" onClick={onStatus}>Estado</button></>}</div>
      </div>
    </section>
  </div>;
}

function ProfileModal({ data, loading, error, online, busy, onClose, onReload, onLogout, onSave }: {
  data: OwnProfileResponse | null; loading: boolean; error: string; online: boolean; busy: boolean; onClose: () => void; onReload: () => void; onLogout: () => void;
  onSave: (data: ProfileSaveData) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<'profile' | 'appearance' | 'privacy' | 'account'>('profile');
  const [username, setUsername] = useState(''); const [avatarUrl, setAvatarUrl] = useState(''); const [aboutMe, setAboutMe] = useState('');
  const [bannerUrl, setBannerUrl] = useState(''); const [bannerColor, setBannerColor] = useState<string | null>(null); const [statusText, setStatusText] = useState('');
  const [presencePreference, setPresencePreference] = useState<'online' | 'away' | 'dnd' | 'invisible'>('online');
  const [visibility, setVisibility] = useState<ProfileVisibility>({ avatar: true, about: true, status: true, joinDate: true, commonCommunities: true, email: false, banner: true });
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [avatarFile, setAvatarFile] = useState<File | null>(null); const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [cropSelection, setCropSelection] = useState<{ kind: ProfileMediaKind; file: File } | null>(null);
  const [profileImageError, setProfileImageError] = useState(''); const [checkingImageStorage, setCheckingImageStorage] = useState(false);
  const avatarPickerRef = useRef<HTMLInputElement>(null); const bannerPickerRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef(new Set<string>());
  useEffect(() => { if (!data) return; setUsername(data.user.username); setAvatarUrl(data.user.avatarUrl ?? ''); setAboutMe(data.user.aboutMe); setBannerUrl(data.user.bannerUrl ?? ''); setBannerColor(data.user.bannerColor); setStatusText(data.user.statusText); setPresencePreference(data.user.presencePreference); setVisibility(data.user.visibility); setSavedSnapshot(JSON.stringify(data.user)); }, [data]);
  useEffect(() => () => { for (const url of previewUrlsRef.current) URL.revokeObjectURL(url); previewUrlsRef.current.clear(); }, []);
  useEffect(() => { const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (cropSelection) setCropSelection(null); else onClose(); } }; document.addEventListener('keydown', closeOnEscape); return () => document.removeEventListener('keydown', closeOnEscape); }, [cropSelection, onClose]);
  const chooseProfileImage = async (kind: ProfileMediaKind) => {
    setProfileImageError(''); setCheckingImageStorage(true);
    try {
      const status = await api<{ available: boolean }>('/profile/media/availability');
      if (!status.available) { setProfileImageError('O envio de fotos ainda não está disponível. Podes continuar a usar um link.'); return; }
      (kind === 'avatar' ? avatarPickerRef : bannerPickerRef).current?.click();
    } catch (cause) { setProfileImageError(cause instanceof Error ? cause.message : 'Não foi possível verificar o envio de fotos.'); }
    finally { setCheckingImageStorage(false); }
  };
  const selectProfileImage = (kind: ProfileMediaKind, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type.toLowerCase())) { setProfileImageError('Escolhe uma imagem JPEG, PNG ou WebP.'); return; }
    if (file.size <= 0 || file.size > 20 * 1024 * 1024) { setProfileImageError('A imagem original deve ter até 20 MB.'); return; }
    setProfileImageError(''); setCropSelection({ kind, file });
  };
  const releaseCropPreview = (value: string) => {
    if (value.startsWith('blob:')) { URL.revokeObjectURL(value); previewUrlsRef.current.delete(value); }
  };
  const updateImageLink = (kind: ProfileMediaKind, value: string) => {
    if (kind === 'avatar') { releaseCropPreview(avatarUrl); setAvatarFile(null); setAvatarUrl(value); }
    else { releaseCropPreview(bannerUrl); setBannerFile(null); setBannerUrl(value); }
  };
  const completeProfileCrop = (kind: ProfileMediaKind, file: File) => {
    const previewUrl = URL.createObjectURL(file);
    previewUrlsRef.current.add(previewUrl);
    const previousUrl = kind === 'avatar' ? avatarUrl : bannerUrl;
    releaseCropPreview(previousUrl);
    if (kind === 'avatar') { setAvatarFile(file); setAvatarUrl(previewUrl); }
    else { setBannerFile(file); setBannerUrl(previewUrl); }
    setCropSelection(null); setProfileImageError('');
  };
  const currentUserId = data?.user.id ?? '';
  const draft = { username: username.trim(), avatarUrl: avatarFile ? null : safeProfileImage(avatarUrl, currentUserId, 'avatar'), aboutMe: aboutMe.trim(), bannerUrl: bannerFile ? null : safeProfileImage(bannerUrl, currentUserId, 'banner'), bannerColor, statusText: statusText.trim(), presencePreference, visibility };
  const dirty = Boolean(data && JSON.stringify({ ...data.user, ...draft }) !== savedSnapshot) || Boolean(avatarFile || bannerFile);
  const requestClose = () => { if (!dirty || window.confirm('Sair sem guardar?')) onClose(); };
  const save = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); onSave({ ...draft, avatarFile: avatarFile ?? undefined, bannerFile: bannerFile ?? undefined }); };
  const preview: MemberProfile = { id: currentUserId, username: username || data?.user.username || 'Perfil', avatarUrl: visibility.avatar ? (avatarFile ? avatarUrl : safeProfileImage(avatarUrl, currentUserId, 'avatar')) : null, aboutMe: visibility.about ? aboutMe.trim() : undefined, bannerUrl: visibility.banner ? (bannerFile ? bannerUrl : safeProfileImage(bannerUrl, currentUserId, 'banner')) : undefined, bannerColor: visibility.banner ? bannerColor : undefined, statusText: visibility.status ? statusText.trim() : undefined, online, presence: presencePreference };
  if (loading) return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true"><p className="muted" role="status">A carregar o teu perfil…</p></section></div>;
  if (error || !data) return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true"><p className="error-banner" role="alert">{error || 'Perfil não encontrado.'}</p><button className="secondary" onClick={onReload}>Tentar novamente</button></section></div>;
  if (!expanded) return <ProfileCompactCard profile={preview} own onExpand={() => setExpanded(true)} onClose={requestClose} onEdit={() => { setExpanded(true); setTab('profile'); }} onStatus={() => { setExpanded(true); setTab('profile'); }}/>
  return createPortal(<div className="modal-backdrop expanded-profile-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}><section className="expanded-profile-panel" role="dialog" aria-modal="true" aria-labelledby="expanded-profile-title"><header className="profile-page-header"><button className="icon-button" onClick={requestClose} aria-label="Voltar">←</button><div><h2 id="expanded-profile-title">O teu perfil</h2><p className="muted">Vê e escolhe o que partilhas.</p></div></header><div className="expanded-profile-grid"><form onSubmit={save} className="profile-editor"><nav className="profile-tabs" aria-label="Secções do perfil">{(['profile', 'appearance', 'privacy', 'account'] as const).map((item) => <button type="button" key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item === 'profile' ? 'Perfil' : item === 'appearance' ? 'Aparência' : item === 'privacy' ? 'Privacidade' : 'Conta'}</button>)}</nav><input ref={avatarPickerRef} className="profile-file-input" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Escolher foto de perfil" onChange={(event) => selectProfileImage('avatar', event)}/><input ref={bannerPickerRef} className="profile-file-input" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Escolher imagem de fundo" onChange={(event) => selectProfileImage('banner', event)}/>{tab === 'profile' && <section className="profile-section"><h3>Perfil</h3><label className="field">Nome de utilizador<input value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={32} required/><small>O nome de utilizador é sempre público.</small></label><label className="field">Sobre mim<textarea value={aboutMe} onChange={(event) => setAboutMe(event.target.value.slice(0, 160))} maxLength={160} rows={4}/><small className="profile-counter">{aboutMe.length}/160</small></label><label className="field">Texto de estado<input value={statusText} onChange={(event) => setStatusText(event.target.value.slice(0, 80))} maxLength={80}/><small className="profile-counter">{statusText.length}/80</small></label><label className="field">Estado<select value={presencePreference} onChange={(event) => setPresencePreference(event.target.value as typeof presencePreference)}>{Object.entries(presenceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>O estado Invisível aparece como desligado para os outros.</small></label></section>}{tab === 'appearance' && <section className="profile-section"><h3>Aparência</h3><div className="profile-image-field"><div><strong>Foto de perfil</strong><small>Escolhe uma fotografia e ajusta o recorte circular.</small></div><button type="button" className="secondary" onClick={() => void chooseProfileImage('avatar')} disabled={checkingImageStorage || busy}>Escolher foto</button></div><label className="field">Link da foto (opcional)<input value={avatarFile || profileMediaReferenceOwnedBy(avatarUrl, currentUserId, 'avatar') ? '' : avatarUrl} onChange={(event) => updateImageLink('avatar', event.target.value)} placeholder="https://…"/><small>As imagens que já tens continuam até guardares uma nova.</small></label>{avatarFile && <p className="profile-image-ready">Recorte pronto. Guarda o perfil para aplicar a foto.</p>}<div className="profile-image-field"><div><strong>Imagem de fundo</strong><small>Escolhe uma fotografia e ajusta o enquadramento largo.</small></div><button type="button" className="secondary" onClick={() => void chooseProfileImage('banner')} disabled={checkingImageStorage || busy}>Escolher imagem</button></div><label className="field">Link da imagem (opcional)<input value={bannerFile || profileMediaReferenceOwnedBy(bannerUrl, currentUserId, 'banner') ? '' : bannerUrl} onChange={(event) => updateImageLink('banner', event.target.value)} placeholder="https://…"/><small>Para o fundo, uma imagem larga fica melhor.</small></label>{bannerFile && <p className="profile-image-ready">Recorte pronto. Guarda o perfil para aplicar a imagem.</p>}{profileImageError && <p className="error-banner" role="alert">{profileImageError}</p>}<div className="field"><span>Cor de fundo</span><div className="profile-color-grid"><button type="button" className={!bannerColor ? 'selected' : ''} onClick={() => setBannerColor(null)}>Nenhuma</button>{profileColors.map((color) => <button type="button" key={color} aria-label={color} className={bannerColor === color ? 'selected' : ''} style={{ backgroundColor: color }} onClick={() => setBannerColor(color)}/>)}</div></div></section>}{tab === 'privacy' && <section className="profile-section"><h3>Privacidade</h3><div className="privacy-list">{profileVisibilityOptions.map((option) => <label className="privacy-row" key={option.key}><span><strong>{option.title}</strong><small>{option.help}</small></span><input type="checkbox" checked={visibility[option.key]} onChange={(event) => setVisibility((current) => ({ ...current, [option.key]: event.target.checked }))}/></label>)}</div><button type="button" className="secondary privacy-preview-button" onClick={() => setTab('profile')}>Ver como os outros me veem</button></section>}{tab === 'account' && <section className="profile-section"><h3>Conta</h3><div className="profile-account-info"><div><strong>Email</strong><span>{data.user.email}</span></div><div><strong>Data de entrada</strong><span>{profileDate(data.user.createdAt)}</span></div><div><strong>Comunidades</strong><span>{data.communities.length ? data.communities.map((community) => community.name).join(', ') : 'Ainda não participas em comunidades.'}</span></div></div><button type="button" className="danger-button" onClick={() => { if (window.confirm('Queres terminar sessão?')) onLogout(); }}>Terminar sessão</button></section>}<div className="profile-actions"><button type="button" className="secondary" onClick={requestClose}>Descartar alterações</button><button className="primary" disabled={!dirty || busy}>{busy ? 'A guardar…' : 'Guardar'}</button></div></form><aside className="profile-live-preview"><h3>Pré-visualização</h3><ProfileCompactCard profile={preview} own={false} onExpand={() => undefined} onClose={() => undefined}/></aside></div>{cropSelection && <ProfileImageCropper file={cropSelection.file} kind={cropSelection.kind} onCancel={() => setCropSelection(null)} onComplete={(file) => completeProfileCrop(cropSelection.kind, file)}/>}</section></div>, document.body);
}

function MemberProfileSheet({ profile, loading, error, onClose, onMessage }: { profile: MemberProfile | null; loading: boolean; error: string; onClose: () => void; onMessage: (peer: { id: string; username: string; avatarUrl?: string | null }) => void }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; document.addEventListener('keydown', closeOnEscape); return () => document.removeEventListener('keydown', closeOnEscape); }, [onClose]);
  if (loading || error || !profile) return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true">{loading && <p className="muted" role="status">A carregar o perfil…</p>}{error && <p className="error-banner" role="alert">{error}</p>}{error && <button className="secondary" onClick={onClose}>Fechar</button>}</section></div>;
  const presence = profile.presence ?? (profile.online ? 'online' : 'invisible');
  if (!expanded) return <ProfileCompactCard profile={profile} own={false} onExpand={() => setExpanded(true)} onClose={onClose}/>;
  return <div className="modal-backdrop profile-card-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="expanded-member-panel" role="dialog" aria-modal="true" aria-labelledby="member-profile-title">
    <ProfileBanner name={profile.username} url={profile.bannerUrl} color={profile.bannerColor}><button className="profile-close icon-button" onClick={onClose} aria-label="Fechar perfil">×</button></ProfileBanner>
    <div className="expanded-member-content"><header className="profile-card-head"><span className="profile-large-avatar"><Avatar name={profile.username} url={profile.avatarUrl} size={80}/><span className="profile-status-ring" style={{ backgroundColor: presenceColor(presence, profile.online) }}/></span><div className="profile-card-title"><h2 id="member-profile-title">{profile.username}</h2><span className="profile-presence">{presenceLabels[presence as keyof typeof presenceLabels] ?? 'Desligado'}{profile.role ? ` · ${roleLabels[profile.role] ?? profile.role}` : ''}</span></div></header>
      {profile.statusText && <p className="profile-status-bubble">{profile.statusText}</p>}{profile.aboutMe && <section className="member-profile-item"><h3>Sobre mim</h3><p>{profile.aboutMe}</p></section>}{profile.createdAt && <section className="member-profile-item"><h3>Data de entrada no Mavuno</h3><p>{profileDate(profile.createdAt)}</p></section>}{!!profile.commonCommunities?.length && <section className="member-profile-item"><h3>Comunidades em comum</h3><ul>{profile.commonCommunities.map((community) => <li key={community.id}>{community.name}</li>)}</ul></section>}{profile.email && <section className="member-profile-item"><h3>Email</h3><p>{profile.email}</p></section>}
    </div><footer className="member-profile-actions"><button type="button" className="primary" onClick={() => onMessage(profile)}>Mensagem</button><button type="button" className="secondary" onClick={onClose}>Fechar</button></footer>
  </section></div>;
}

function AccountModal({ user, onClose, onEditProfile }: { user: User; onClose: () => void; onEditProfile: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
      <div className="account-modal-heading"><Avatar name={user.username} url={user.avatarUrl} size={42}/><div><h2 id="account-title">A tua conta</h2><p className="muted" style={{ margin: 0 }}>@{user.username}</p></div></div>
      <div className="account-section"><strong>Perfil</strong><p className="muted">Atualiza o teu nome de utilizador e avatar sem sair da sessão.</p><button className="secondary" onClick={onEditProfile}>Editar perfil</button></div>
      <div className="modal-actions"><button className="primary" onClick={onClose}>Fechar</button></div>
    </section>
  </div>;
}

function AudioMenu({ kind, preferences, devices, error, onClose, onToggleMute, onToggleDeafen, onChange, onSettings, onRequestMic }: { kind: 'input' | 'output'; preferences: AudioPreferences; devices: MediaDeviceInfo[]; error: string; onClose: () => void; onToggleMute: () => void; onToggleDeafen: () => void; onChange: (patch: Partial<AudioPreferences>) => void; onSettings: () => void; onRequestMic: () => void }) {
  const inputs = devices.filter((device) => device.kind === 'audioinput');
  const outputs = devices.filter((device) => device.kind === 'audiooutput');
  const outputSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  const selectOutput = (deviceId: string) => {
    onChange({ outputDeviceId: deviceId });
    if (outputSupported) void Promise.all(Array.from(document.querySelectorAll<HTMLAudioElement>('audio[data-mavuno="voice"]')).map((audio) => (audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(deviceId) ?? Promise.resolve()));
  };
  return <div className={`audio-menu ${kind === 'output' ? 'audio-menu-output' : ''}`} role="dialog" aria-label={kind === 'input' ? 'Opções do microfone' : 'Opções dos auscultadores'}>
    <div className="audio-menu-handle"/>
    <div className="audio-menu-heading"><strong>{kind === 'input' ? 'Microfone' : 'Auscultadores'}</strong><button className="icon-button" onClick={onClose} aria-label="Fechar"><Glyph name="close"/></button></div>
    {kind === 'input' ? <>
      <label className="audio-setting-row">Dispositivo de entrada<select value={preferences.inputDeviceId} onChange={(event) => onChange({ inputDeviceId: event.target.value })}><option value="">Predefinido do sistema</option>{inputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microfone ${index + 1}`}</option>)}</select></label>
      {!inputs.some((device) => device.label) && <button className="audio-menu-link" onClick={onRequestMic}>Permitir acesso para mostrar os nomes dos microfones</button>}
      <label className="audio-setting-row">Perfil de voz<select value={preferences.voiceProfile} onChange={(event) => onChange({ voiceProfile: event.target.value as VoiceProfile })}><option value="default">Padrão</option><option value="noise-reduction">Redução de ruído</option><option value="studio">Estúdio</option></select><small>Aplica-se na próxima entrada na voz.</small></label>
      <button className="audio-menu-action" onClick={onToggleMute}><Glyph name="mic"/>{preferences.micMuted ? 'Ativar microfone' : 'Silenciar microfone'}</button>
    </> : <>
      {outputSupported ? <label className="audio-setting-row">Dispositivo de saída<select value={preferences.outputDeviceId} onChange={(event) => selectOutput(event.target.value)}><option value="">Predefinido do sistema</option>{outputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Saída ${index + 1}`}</option>)}</select></label> : <p className="audio-note">Este navegador usa a saída do sistema.</p>}
      <label className="audio-setting-row">Volume de saída <output>{preferences.outputVolume}%</output><input type="range" min="0" max="100" value={preferences.outputVolume} onChange={(event) => onChange({ outputVolume: Number(event.target.value) })}/></label>
      <button className="audio-menu-action" onClick={onToggleDeafen}><Glyph name="headphones"/>{preferences.deafened ? 'Ativar som' : 'Ensurdecer'}</button>
    </>}
    {error && <p className="audio-note audio-error">{error}</p>}
    <button className="audio-menu-action" onClick={onSettings}>Configurações de voz</button>
  </div>;
}

function SettingsModal({ user, section, preferences, devices, audioError, onSection, onChange, onRequestMic, onOpenProfile, onLogout, onClose, notify }: { user: User; section: 'account' | 'voice' | 'direct'; preferences: AudioPreferences; devices: MediaDeviceInfo[]; audioError: string; onSection: (section: 'account' | 'voice' | 'direct') => void; onChange: (patch: Partial<AudioPreferences>) => void; onRequestMic: () => void; onOpenProfile: () => void; onLogout: () => void; onClose: () => void; notify: (message: string) => void }) {
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [blocked, setBlocked] = useState<Array<{ user: MemberProfile; blockedAt: string }>>([]);
  const [blockedLoading, setBlockedLoading] = useState(false);
  const [blockedError, setBlockedError] = useState('');
  useEffect(() => { if (section !== 'direct') return; let active = true; setBlockedLoading(true); setBlockedError(''); void api<{ blocked: Array<{ user: MemberProfile; blockedAt: string }> }>('/dm/blocks').then((data) => { if (active) setBlocked(data.blocked); }).catch((error) => { if (active) setBlockedError(error instanceof Error ? error.message : 'Não foi possível carregar os bloqueios.'); }).finally(() => { if (active) setBlockedLoading(false); }); return () => { active = false; }; }, [section]);
  const unblock = async (id: string) => { try { await api(`/dm/blocks/${encodeURIComponent(id)}`, { method: 'DELETE' }); setBlocked((old) => old.filter((entry) => entry.user.id !== id)); window.dispatchEvent(new Event('mavuno:dm-blocks-updated')); notify('Utilizador desbloqueado.'); } catch (error) { notify(error instanceof Error ? error.message : 'Não foi possível desbloquear este utilizador.'); } };
  const testMic = async () => {
    if (testing) return;
    if (!navigator.mediaDevices?.getUserMedia) return;
    setTesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(preferences.voiceProfile, preferences.inputDeviceId));
      const context = new AudioContext(); const source = context.createMediaStreamSource(stream); const analyser = context.createAnalyser(); analyser.fftSize = 256; source.connect(analyser);
      const values = new Uint8Array(analyser.frequencyBinCount); const started = Date.now();
      const tick = () => { analyser.getByteTimeDomainData(values); setLevel(Math.min(100, Math.round(values.reduce((sum, value) => sum + Math.abs(value - 128), 0) / values.length * 2))); if (Date.now() - started < 1800) requestAnimationFrame(tick); else { stream.getTracks().forEach((track) => track.stop()); void context.close(); setTesting(false); setLevel(0); } }; tick();
    } catch { setTesting(false); }
  };
  return <div className="settings-backdrop" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <section className="settings-screen"><header className="settings-header"><button className="icon-button" onClick={onClose} aria-label="Voltar"><Glyph name="back"/></button><h2 id="settings-title">Definições</h2></header>
      <div className="settings-body"><nav className="settings-nav"><button className={section === 'account' ? 'active' : ''} onClick={() => onSection('account')}>Conta</button><button className={section === 'direct' ? 'active' : ''} onClick={() => onSection('direct')}>Mensagens privadas</button><button className={section === 'voice' ? 'active' : ''} onClick={() => onSection('voice')}>Voz e áudio</button></nav>
        <div className="settings-content">{section === 'account' ? <><section className="settings-section"><h3>Conta</h3><p className="muted">O teu perfil e as informações que escolhes partilhar.</p><button className="secondary" onClick={onOpenProfile}><Avatar name={user.username} url={user.avatarUrl} size={28}/> O meu perfil</button></section><section className="settings-section danger-section"><h3>Terminar sessão</h3><p className="muted">Sair deste aparelho.</p><button className="danger-button" onClick={() => { if (window.confirm('Queres terminar sessão?')) onLogout(); }}>Terminar sessão</button></section></> : section === 'direct' ? <section className="settings-section"><h3>Utilizadores bloqueados</h3><p className="muted">As pessoas que bloqueaste não te podem enviar mensagens privadas nem gerar avisos. Podes desbloqueá-las aqui.</p>{blockedError && <p className="error-banner" role="alert">{blockedError}</p>}{blockedLoading ? <p className="muted" role="status">A carregar…</p> : blocked.length ? <div className="dm-block-list">{blocked.map((entry) => <div className="dm-block-row" key={entry.user.id}><Avatar name={entry.user.username} url={entry.user.avatarUrl} size={36}/><span><strong>{entry.user.username}</strong><small>Bloqueado em {new Intl.DateTimeFormat('pt-MZ', { dateStyle: 'medium' }).format(new Date(entry.blockedAt))}</small></span><button className="secondary" onClick={() => void unblock(entry.user.id)}>Desbloquear</button></div>)}</div> : <p className="muted">Ainda não bloqueaste ninguém.</p>}</section> : <><section className="settings-section"><h3>Voz e áudio</h3><label className="audio-setting-row">Dispositivo de entrada<select value={preferences.inputDeviceId} onChange={(event) => onChange({ inputDeviceId: event.target.value })}><option value="">Predefinido do sistema</option>{devices.filter((device) => device.kind === 'audioinput').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microfone ${index + 1}`}</option>)}</select></label><button className="audio-menu-link" onClick={onRequestMic}>Permitir / testar microfone</button><label className="audio-setting-row">Perfil de voz<select value={preferences.voiceProfile} onChange={(event) => onChange({ voiceProfile: event.target.value as VoiceProfile })}><option value="default">Padrão</option><option value="noise-reduction">Redução de ruído</option><option value="studio">Estúdio</option></select></label><div className="mic-test"><button className="secondary" onClick={() => void testMic()}>{testing ? 'A ouvir…' : 'Testar microfone'}</button><div className="level-track"><span style={{ width: `${level}%` }}/></div></div>{audioError && <p className="error-banner">{audioError}</p>}</section><section className="settings-section"><h3>Saída</h3><p className="audio-note">{devices.some((device) => device.kind === 'audiooutput') && 'setSinkId' in HTMLMediaElement.prototype ? 'Escolhe a saída no menu dos auscultadores.' : 'Este navegador usa a saída do sistema.'}</p><label className="audio-setting-row">Volume de saída <output>{preferences.outputVolume}%</output><input type="range" min="0" max="100" value={preferences.outputVolume} onChange={(event) => onChange({ outputVolume: Number(event.target.value) })}/></label></section></>}</div></div>
    </section></div>;
}

function VoicePanel({ channel, notify, preferences, onAudioChange }: { channel: Channel; notify: (text: string) => void; preferences: AudioPreferences; onAudioChange: (patch: Partial<AudioPreferences>) => void }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [participants, setParticipants] = useState<string[]>([]);
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [error, setError] = useState('');
  const active = useRef<Room | null>(null);
  const refresh = useCallback((current: Room) => {
    setParticipants([current.localParticipant.identity, ...Array.from(current.remoteParticipants.values()).map((participant: RemoteParticipant) => participant.identity)]);
    setSpeakers(current.activeSpeakers.map((participant) => participant.identity));
  }, []);
  const disconnect = useCallback(async () => {
    if (!active.current) return;
    const current = active.current;
    active.current = null;
    await releaseLiveKitRoom(current);
    for (const element of document.querySelectorAll('audio[data-mavuno="voice"]')) element.remove();
    setRoom(null); setParticipants([]); setSpeakers([]); setMicOn(true);
  }, []);
  useEffect(() => () => { void disconnect(); }, [channel.id, disconnect]);
  useEffect(() => { if (room) void room.localParticipant.setMicrophoneEnabled(!preferences.micMuted && !preferences.deafened).then(() => setMicOn(!preferences.micMuted && !preferences.deafened)).catch(() => undefined); for (const audio of document.querySelectorAll<HTMLAudioElement>('audio[data-mavuno="voice"]')) audio.volume = audioOutputVolume(preferences); }, [preferences, room]);

  const join = async () => {
    setError(''); setConnecting(true);
    let next: Room | null = null;
    try {
      const credentials = await api<{ token: string; serverUrl: string }>(`/channels/${channel.id}/voice-token`, { method: 'POST', body: '{}' });
      const { Room: LiveKitRoom, RoomEvent, Track } = await import('livekit-client');
      next = new LiveKitRoom({ adaptiveStream: true, dynacast: true });
      next.on(RoomEvent.ParticipantConnected, () => refresh(next!));
      next.on(RoomEvent.ParticipantDisconnected, () => refresh(next!));
      next.on(RoomEvent.ActiveSpeakersChanged, () => refresh(next!));
      next.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const element = track.attach(); element.dataset.mavuno = 'voice'; element.volume = audioOutputVolume(preferences); document.body.appendChild(element);
        }
      });
      next.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((element) => element.remove()));
      next.on(RoomEvent.Disconnected, () => { setRoom(null); setParticipants([]); setSpeakers([]); active.current = null; });
      await next.connect(credentials.serverUrl, credentials.token);
      active.current = next;
      setRoom(next);
      await next.localParticipant.setMicrophoneEnabled(!preferences.micMuted && !preferences.deafened);
      setMicOn(!preferences.micMuted && !preferences.deafened);
      refresh(next);
    } catch (cause) {
      if (next) await releaseLiveKitRoom(next);
      active.current = null;
      const name = cause instanceof Error ? cause.name : '';
      const message = name === 'NotAllowedError' || name === 'PermissionDeniedError' ? 'Permite o acesso ao microfone nas definições do navegador e tenta novamente.' : 'A voz ainda não está disponível. Tenta mais tarde.';
      setError(message); notify(message);
    } finally { setConnecting(false); }
  };
  const toggleMic = async () => {
    if (!room) return;
    try { const next = !micOn; await room.localParticipant.setMicrophoneEnabled(next); setMicOn(next); onAudioChange({ micMuted: !next }); }
    catch { setError('Não foi possível alterar o microfone. Verifica a permissão do microfone.'); }
  };

  return <section className="welcome-panel" style={{ marginTop: 0 }}>
    <span className="brand-mark">◖</span><h2>Sala de voz · {channel.name}</h2>
    <p className="muted">Conversa por voz com a tua comunidade.</p>
    <div className="community-card" style={{ marginTop: 18 }}><strong>Participantes ligados · {participants.length}</strong>
      {participants.length === 0 ? <p className="muted">Ainda ninguém está ligado.</p> : participants.map((person) => <div className="member-row" key={person}><span className={`online-dot ${speakers.includes(person) ? 'speaking' : ''}`}/>{person}{person === room?.localParticipant.identity ? ' (tu)' : ''}{speakers.includes(person) && <span className="voice-activity">A falar</span>}</div>)}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        {!room ? <button className="primary" disabled={connecting} onClick={() => void join()}>{connecting ? 'A ligar…' : 'Entrar na sala'}</button> : <><button className="secondary" onClick={() => void toggleMic()}>{micOn ? 'Silenciar microfone' : 'Ativar microfone'}</button><button className="danger-button" onClick={() => void disconnect()}>Sair da sala</button></>}
      </div>
      {error && <p className="error-banner" role="alert">{error}</p>}
    </div>
  </section>;
}
