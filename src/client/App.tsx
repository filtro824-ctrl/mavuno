import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { io } from 'socket.io-client';
import type { Room, RemoteParticipant } from 'livekit-client';
import { api, prepareCsrf, type Channel, type Community, type CommunityDetails, type Member, type MemberProfile, type Message, type OwnProfileResponse, type PrivateCall, type PrivateCallStatus, type ProfileVisibility, type ReactionSummary, type User } from './api';
import { EMOJI_CATEGORIES, EMOJI_INDEX, type EmojiCategoryId } from './emoji-data';
import { toggleReactionSummary } from './reaction-state';
import { applyDeafenState, audioOutputVolume, DEFAULT_AUDIO_PREFERENCES, microphoneConstraints, readAudioPreferences, writeAudioPreferences, type AudioPreferences, type VoiceProfile } from './audio-preferences';
import { ActionMenuOverlay, MessageRow, ModerationPrompt, rectFor, type ActionMenuTarget, type DurationChoice, type MenuRect } from './message-actions';

type ModalType = 'community' | 'channel' | 'profile' | 'memberProfile' | 'account' | 'settings' | 'admin' | null;
const roleLabels: Record<string, string> = { owner: 'Proprietário', admin: 'Administrador', moderator: 'Moderador', member: 'Membro' };
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

  if (checking) return <main className="boot-screen"><span className="brand-mark">m</span><p>A preparar as conversas…</p></main>;
  if (!user) return <AuthScreen notice={sessionExpired ? 'A tua sessão terminou. Inicia sessão novamente.' : ''} onAuthed={(next) => { setSessionExpired(false); setUser(next); }}/>;
  return <Dashboard user={user} onUserChange={setUser} onLogout={() => setUser(null)}/>;
}

function AuthScreen({ onAuthed, notice }: { onAuthed: (user: User) => void; notice?: string }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
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

function Dashboard({ user, onUserChange, onLogout }: { user: User; onUserChange: (user: User) => void; onLogout: () => void }) {
  const [communities, setCommunities] = useState<Community[]>([]);
  const [details, setDetails] = useState<CommunityDetails | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [newMessages, setNewMessages] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [explore, setExplore] = useState(false);
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
  const [reply, setReply] = useState<Message | null>(null);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [pinnedMessages, setPinnedMessages] = useState<Message[]>([]);
  const [emojiPickerTarget, setEmojiPickerTarget] = useState<'composer' | { messageId: string } | null>(null);
  const [reactionUsers, setReactionUsers] = useState<{ messageId: string; emoji: string; users: string[]; loading: boolean } | null>(null);
  const [pendingReactionKeys, setPendingReactionKeys] = useState<Set<string>>(new Set());
  const pendingReactionKeysRef = useRef(new Set<string>());
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState('');
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
  const [settingsSection, setSettingsSection] = useState<'account' | 'voice'>('account');
  const [previousMicMuted, setPreviousMicMuted] = useState<boolean | null>(null);
  const [callTarget, setCallTarget] = useState<Member | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const knownMessageIds = useRef(new Set<string>());
  knownMessageIds.current = new Set(messages.flatMap((message) => [message.id, message.clientMessageId]));
  const nearBottom = useRef(true);
  const tuckTimer = useRef<number | undefined>(undefined);
  const hintShownRef = useRef(false);
  useEffect(() => { actionMenuRef.current = actionMenu; }, [actionMenu]);
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
  const activeCommunityId = details?.community.id;
  const quickItems = useMemo(() => communities.map((community) => ({ id: community.id, name: community.name })), [communities]);

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
      if (request === profileRequestRef.current && memberProfileIdRef.current === targetId) setMemberProfile(result.profile);
    } catch (cause) {
      if (request === profileRequestRef.current && memberProfileIdRef.current === targetId) setMemberProfileError(cause instanceof Error ? cause.message : 'Não foi possível abrir este perfil.');
    } finally {
      if (request === profileRequestRef.current && memberProfileIdRef.current === targetId) setMemberProfileLoading(false);
    }
  }, []);
  const openMemberProfile = useCallback((targetId: string) => {
    if (targetId === user.id) { void openOwnProfile(); return; }
    if (!activeCommunityId) return;
    memberProfileIdRef.current = targetId;
    setMemberProfile(null);
    setModal('memberProfile');
    void loadMemberProfile(targetId, activeCommunityId);
  }, [activeCommunityId, loadMemberProfile, openOwnProfile, user.id]);
  const closeMemberProfile = useCallback(() => {
    memberProfileIdRef.current = null;
    profileRequestRef.current += 1;
    setMemberProfile(null);
    setModal(null);
  }, []);
  const openCommunity = useCallback(async (id: string, autoChannel = true) => {
    try {
      const data = await api<CommunityDetails>(`/communities/${id}`);
      setDetails(data);
      setExplore(false);
      setChannel(null);
      setMessages([]);
      setPinnedMessages([]);
      navigateMobile('channels');
      if (autoChannel && data.myRole) {
        const first = data.channels.find((item) => item.kind === 'text') ?? data.channels[0];
        if (first) { setChannel(first); navigateMobile('chat'); }
      }
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Não foi possível abrir a comunidade.');
    }
  }, [notify]);

  useEffect(() => {
    void loadCommunities();
    const invite = window.location.pathname.match(/^\/invite\/([\w-]{32,64})$/);
    if (invite) {
      void api<{ communityId: string }>('/invites/' + invite[1] + '/join', { method: 'POST', body: '{}' })
        .then(async (result) => {
          window.history.replaceState({}, '', '/');
          await loadCommunities();
          await openCommunity(result.communityId);
          notify('Entraste na comunidade.');
        })
        .catch((cause) => {
          window.history.replaceState({}, '', '/');
          notify(cause instanceof Error ? cause.message : 'Convite inválido ou expirado.');
        });
    }
  }, [loadCommunities, openCommunity, notify]);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => { setOnline(false); setReconnecting(true); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);
  useEffect(() => {
    if (tuckTimer.current) window.clearTimeout(tuckTimer.current);
    tuckTimer.current = window.setTimeout(() => setTucked(true), 3600);
    return () => { if (tuckTimer.current) window.clearTimeout(tuckTimer.current); };
  }, [quickOpen]);

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
  useEffect(() => {
    nearBottom.current = true;
    setNewMessages(0);
    if (!channel || channel.kind !== 'text') { setMessages([]); setPinnedMessages([]); setReconnecting(false); return; }
    setPinnedMessages([]);
    void fetchMessages(channel.id);
    void fetchPinnedMessages(channel.id);
  }, [channel?.id, channel?.kind, fetchMessages, fetchPinnedMessages]);
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
    if (!details?.community.id) return;
    const communityId = details.community.id;
    const socket = io({ withCredentials: true, reconnection: true, transports: ['websocket', 'polling'] });
    socket.on('connect', () => { setOnline(true); setReconnecting(false); });
    socket.on('disconnect', (reason) => { if (reason !== 'io client disconnect') setReconnecting(true); });
    socket.on('connect_error', () => setReconnecting(true));
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
  }, [details?.community.id, loadCommunities, loadMemberProfile, notify]);
  useEffect(() => {
    const socket = io({ withCredentials: true, reconnection: true, transports: ['websocket', 'polling'] });
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

  const sendMessage = async (body: string, clientMessageId: string = crypto.randomUUID(), replyToId: string | null = reply?.id ?? null) => {
    if (!channel || channel.kind !== 'text') return;
    nearBottom.current = true; setNewMessages(0);
    const message: Message = {
      id: `optimistic:${clientMessageId}`, clientMessageId, body, replyToId, replyAuthor: replyToId ? reply?.username ?? null : null, replyBody: replyToId ? reply?.body ?? null : null,
      createdAt: new Date().toISOString(), authorId: user.id, username: user.username,
      avatarUrl: user.avatarUrl, delivery: 'sending',
    };
    setMessages((current) => mergeMessage(current, message));
    try {
      const result = await api<{ message: Message }>(`/channels/${channel.id}/messages`, {
        method: 'POST', body: JSON.stringify({ clientMessageId, body, replyToId }),
      });
      setMessages((current) => mergeMessage(current, result.message));
      setReply(null);
    } catch (cause) {
      setMessages((current) => current.map((item) => item.clientMessageId === clientMessageId ? { ...item, delivery: 'failed' } : item));
      notify(cause instanceof Error ? cause.message : 'A mensagem falhou. Toca em “Tentar novamente”.');
    }
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
  const createInvite = async () => {
    if (!activeCommunityId) return;
    try {
      const result = await api<{ inviteUrl: string }>(`/communities/${activeCommunityId}/invites`, { method: 'POST', body: '{}' });
      const url = `${window.location.origin}${result.inviteUrl}`;
      try { await navigator.clipboard.writeText(url); notify('Ligação de convite copiada.'); }
      catch { notify(`Convite: ${url}`); }
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível criar convite.'); }
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
  const joinPublic = async (community: Community) => { await openCommunity(community.id, false); };
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
  const updateProfile = async (data: { username: string; avatarUrl: string | null; aboutMe: string; bannerUrl: string | null; bannerColor: string | null; statusText: string; presencePreference: 'online' | 'away' | 'dnd' | 'invisible'; visibility: ProfileVisibility }) => {
    setProfileBusy(true);
    try {
      const result = await api<OwnProfileResponse>('/profile', { method: 'PATCH', body: JSON.stringify(data) });
      setOwnProfile(result);
      onUserChange(result.user);
      setDetails((current) => current ? { ...current, members: current.members.map((member) => member.id === user.id ? { ...member, username: result.user.username, avatarUrl: result.user.avatarUrl } : member) } : current);
      setMessages((current) => current.map((message) => message.authorId === user.id ? { ...message, username: result.user.username, avatarUrl: result.user.avatarUrl } : message));
      setPinnedMessages((current) => current.map((message) => message.authorId === user.id ? { ...message, username: result.user.username, avatarUrl: result.user.avatarUrl } : message));
      setModal(null);
      notify('Perfil atualizado.');
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível atualizar o perfil.'); }
    finally { setProfileBusy(false); }
  };
  const appClass = `app-shell ${mobileView === 'channels' ? 'mobile-channels' : 'mobile-chat'}`;

  return <div className={appClass}>
    <nav className="community-rail" aria-label="Navegação principal">
      <button className="rail-logo" aria-label="Início" onClick={() => { setDetails(null); setChannel(null); setExplore(false); }}>m</button>
      <div className="rail-divider"/>
      {communities.map((item) => <button key={item.id} title={item.name} aria-label={item.name} className={`community-chip ${details?.community.id === item.id ? 'active' : ''}`} onClick={() => void openCommunity(item.id)}>{initials(item.name)}</button>)}
      <button className="community-chip" title="Criar comunidade" aria-label="Criar comunidade" onClick={() => setModal('community')}>＋</button>
      <div className="rail-divider"/>
      <button className={`community-chip ${explore ? 'active' : ''}`} title="Explorar comunidades" aria-label="Explorar comunidades" onClick={() => void loadExplore()}>⌕</button>
    </nav>

    <aside className="side-panel">
      <header className="side-header">
        <strong>{explore ? 'Explorar' : details?.community.name ?? 'As tuas conversas'}</strong>
        <div style={{ display: 'flex', gap: 4 }}>
          {details && canKick && <button className="icon-button" title="Administração da comunidade" aria-label="Configurações da comunidade" onClick={() => setModal('admin')}>⚙</button>}
          {details && isManager && <button className="icon-button" title="Criar convite" aria-label="Criar convite" onClick={() => void createInvite()}>↗</button>}
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
        {details.channels.map((item) => <div className="channel-manage-row" key={item.id}>
          <button disabled={!details.myRole} className={`channel-row ${channel?.id === item.id ? 'active' : ''}`} onClick={() => selectChannel(item)}><span>{item.kind === 'voice' ? '◖' : '#'}</span>{item.name}</button>
          {isManager && <button className="channel-delete" title={`Apagar ${item.name}`} aria-label={`Apagar canal ${item.name}`} onClick={() => void deleteChannel(item)}>×</button>}
        </div>)}
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
        {!details.myRole && <p className="muted" style={{ fontSize: 12, padding: 8 }}>Precisas de um convite para abrir os canais.</p>}
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
        {mobileView === 'chat' && <button className="icon-button mobile-back" onClick={() => { if (mobileHistory.current.length > 1) window.history.back(); else navigateMobile('channels'); }} aria-label="Voltar aos canais">←</button>}
        <h1>{explore ? 'Descobrir comunidades' : channel ? `${channel.kind === 'voice' ? '◖' : '#'} ${channel.name}` : details?.community.name ?? 'Mavuno'}</h1>
        <span className={`network-status ${online ? '' : 'offline'}`}>{!online ? '● Sem ligação. A tentar novamente...' : reconnecting ? '● A reconectar…' : '● Ligado'}</span>
        {channel?.kind === 'text' && <span className="muted">Mensagens</span>}
      </header>

      {!explore && channel?.kind === 'text' && pinnedMessages.length > 0 && <div className="pinned-strip"><span aria-hidden="true">◆</span><strong>Fixadas</strong><button onClick={() => void openPinned()}>{pinnedMessages.length} mensagem(ns) · Ver lista</button></div>}
      {explore ? <section className="explore-view">
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
          if (nearBottom.current) setNewMessages(0);
        }}>
          {hasMore && <button className="text-button" style={{ display: 'block', margin: '0 auto 10px' }} disabled={loadingMessages} onClick={() => {
            const oldest = messages[0];
            if (oldest) { nearBottom.current = false; void fetchMessages(channel.id, `${oldest.createdAt}~${oldest.id}`); }
          }}>{loadingMessages ? 'A carregar…' : 'Carregar mensagens anteriores'}</button>}
          {messages.length === 0 && !loadingMessages && <div className="empty-state">Ainda não há mensagens. Começa a conversa.</div>}
          {messages.map((message, index) => <MessageRow key={message.id} message={message} grouped={index > 0 && messages[index - 1]?.authorId === message.authorId} own={message.authorId === user.id} onOpenMenu={(rect) => openMessageMenu(message, rect)} onProfile={() => openMemberProfile(message.authorId)} onReply={() => setReply(message)} onRetry={() => void sendMessage(message.body, message.clientMessageId, message.replyToId)} onQuickReaction={(emoji) => void toggleReaction(message, emoji)}>
            {!!message.reactions?.length && <div className="reaction-pills">{message.reactions.map((reaction) => <ReactionPill key={reaction.emoji} reaction={reaction} pending={pendingReactionKeys.has(`${message.id}:${reaction.emoji}`)} onToggle={() => void toggleReaction(message, reaction.emoji)} onLongPress={() => void showReactionUsers(message.id, reaction.emoji)}/>)}</div>}
            {Array.from(pendingReactionKeys).some((key) => key.startsWith(`${message.id}:`)) && !(message.reactions ?? []).some((reaction) => pendingReactionKeys.has(`${message.id}:${reaction.emoji}`)) && <small className="reaction-pending-label">A enviar…</small>}
          </MessageRow>)}
          {newMessages > 0 && <button className="new-messages-button" onClick={() => { if (listRef.current) listRef.current.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); nearBottom.current = true; setNewMessages(0); }}>Novas mensagens · Descer</button>}
        </div>
        <div className="composer-wrap">
          {reply && <div className="muted" style={{ maxWidth: 850, margin: '0 auto 6px', fontSize: 12 }}>A responder a {reply.username}: {reply.body.slice(0, 60)} <button className="text-button" onClick={() => setReply(null)}>Cancelar</button></div>}
          <form className="composer" onSubmit={(event) => { event.preventDefault(); const value = draft.trim(); if (!value) return; void sendMessage(value); setDraft(''); }}>
            <input ref={composerInputRef} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={2000} placeholder={`Escreve uma mensagem em #${channel.name}`} aria-label="Escrever mensagem"/>
            <button type="button" className="secondary composer-emoji-button" aria-label="Inserir emoji" title="Inserir emoji" onClick={() => setEmojiPickerTarget('composer')}>☺</button>
            <button className="primary send-button" disabled={!draft.trim()} aria-label="Enviar mensagem">Enviar</button>
          </form>
        </div>
      </> : <section className="welcome-panel">
        <span className="brand-mark">m</span>
        <h2>{details ? details.community.name : 'Conversas com espaço para todos.'}</h2>
        <p className="muted">{details ? details.community.description || 'Uma comunidade Mavuno.' : 'Cria uma comunidade ou descobre uma conversa pública.'}</p>
        {details && <p className="muted" style={{ fontSize: 13 }}>{details.community.category} · {details.members.length} membros · {details.channels.length} canais</p>}
        {details && !details.myRole && <p className="notice">Esta comunidade é pública. Para participar nos canais, entra através de um convite válido.</p>}
        {!details && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button className="primary" onClick={() => setModal('community')}>Criar comunidade</button><button className="secondary" onClick={() => void loadExplore()}>Explorar comunidades</button></div>}
      </section>}
    </main>

    <div className="floating-wrap">
      <button className={`floating-button ${tucked && !quickOpen ? 'tucked' : ''}`} aria-label="Abrir painel rápido" aria-expanded={quickOpen} onClick={() => { setTucked(false); setQuickOpen((value) => !value); }} onPointerDown={() => setTucked(false)}>m</button>
      {quickOpen && <div className="quick-panel"><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><strong>Conversas rápidas</strong><button className="text-button" onClick={() => setQuickOpen(false)} aria-label="Fechar painel">×</button></div>
        {quickItems.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>As tuas comunidades aparecem aqui.</p> : quickItems.map((item) => <button key={item.id} className="channel-row" onClick={() => { void openCommunity(item.id); setQuickOpen(false); }}>{item.name}</button>)}
        <button className="text-button" onClick={() => { void loadExplore(); setQuickOpen(false); }}>Explorar comunidades</button>
      </div>}
    </div>
    {pinnedOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPinnedOpen(false); }}><section className="modal pinned-modal" role="dialog" aria-modal="true" aria-labelledby="pinned-title"><h2 id="pinned-title">Mensagens fixadas</h2><div className="pinned-list">{pinnedMessages.map((item) => <article className="pinned-item" key={item.id}><strong>{item.username}</strong><time className="message-time">{formatTime(item.createdAt)}</time><p>{item.body}</p>{!!item.reactions?.length && <div className="reaction-pills">{item.reactions.map((reaction) => <ReactionPill key={reaction.emoji} reaction={reaction} pending={pendingReactionKeys.has(`${item.id}:${reaction.emoji}`)} onToggle={() => void toggleReaction(item, reaction.emoji)} onLongPress={() => void showReactionUsers(item.id, reaction.emoji)}/>)}</div>}</article>)}</div><div className="modal-actions"><button className="secondary" onClick={() => setPinnedOpen(false)}>Fechar</button></div></section></div>}
    {emojiPickerTarget && <EmojiPicker onClose={() => setEmojiPickerTarget(null)} onSelect={(emoji) => { const target = emojiPickerTarget; setEmojiPickerTarget(null); if (target === 'composer') insertComposerEmoji(emoji); else { const message = messages.find((item) => item.id === target.messageId) ?? pinnedMessages.find((item) => item.id === target.messageId); if (message) void toggleReaction(message, emoji); } }}/> }
    {reactionUsers && <ReactionUsersSheet emoji={reactionUsers.emoji} users={reactionUsers.users} loading={reactionUsers.loading} onClose={() => setReactionUsers(null)}/>}
    {actionMenu && details && <ActionMenuOverlay target={actionMenu} actorId={user.id} actorRole={details.myRole} actorPermissions={details.myPermissions} targetMember={actionMenu.kind === 'member' ? actionMenu.member : details.members.find((member) => member.id === actionMenu.message.authorId) ?? (actionMenu.message.authorId === user.id ? undefined : { id: actionMenu.message.authorId, username: actionMenu.message.username, avatarUrl: actionMenu.message.avatarUrl, role: 'unknown' })} onClose={closeActionMenu} onReply={(message) => setReply(message)} onDelete={deleteMessage} onPin={togglePin} onQuickReaction={(message, emoji) => void toggleReaction(message, emoji)} onMoreReactions={(message) => setEmojiPickerTarget({ messageId: message.id })} onProfile={openMemberProfile} onCall={(member) => setCallTarget(member)} onModerate={(action, member) => setModerationPrompt({ action, member })} onUnmute={(member) => void removeMemberMute(member)} onKick={kickMember} notify={notify}/>}
    {moderationPrompt && <ModerationPrompt action={moderationPrompt.action} member={moderationPrompt.member} onClose={() => setModerationPrompt(null)} onConfirm={async (duration, reason) => { await applyModeration(moderationPrompt.action, moderationPrompt.member, duration, reason); setModerationPrompt(null); }}/>
    }
    {modal === 'community' && <CommunityModal busy={busy} onClose={() => setModal(null)} onCreate={(data) => void createCommunity(data)}/>}
    {modal === 'channel' && <ChannelModal busy={busy} onClose={() => setModal(null)} onCreate={(data) => void createChannel(data)}/>}
    {modal === 'admin' && details && <AdminModal details={details} onClose={() => setModal(null)} onSaved={() => { if (activeCommunityId) void openCommunity(activeCommunityId, false); }}/>}
    {modal === 'profile' && <ProfileModal data={ownProfile} loading={profileLoading} error={ownProfileError} online={online && !reconnecting} busy={profileBusy} onClose={() => setModal(null)} onReload={() => void openOwnProfile()} onLogout={onLogout} onSave={(data) => void updateProfile(data)}/>}
    {modal === 'memberProfile' && <MemberProfileSheet profile={memberProfile} loading={memberProfileLoading} error={memberProfileError} onClose={closeMemberProfile}/>}
    {modal === 'account' && <AccountModal user={user} onClose={() => setModal(null)} onEditProfile={() => setModal('profile')}/>}
    {modal === 'settings' && <SettingsModal user={user} section={settingsSection} preferences={audioPreferences} devices={audioDevices} audioError={audioError} onSection={setSettingsSection} onChange={saveAudio} onRequestMic={() => void requestMicrophone()} onOpenProfile={() => { setModal('profile'); void openOwnProfile(); }} onLogout={logout} onClose={() => setModal(null)}/>}
    <PrivateCallDock target={callTarget} onClearTarget={() => setCallTarget(null)} notify={notify} preferences={audioPreferences} onAudioChange={saveAudio}/>
    {audioMenu && createPortal(<div className="audio-portal" onMouseDown={(event) => { if (event.target === event.currentTarget) setAudioMenu(null); }}><AudioMenu kind={audioMenu} preferences={audioPreferences} devices={audioDevices} error={audioError} onClose={() => setAudioMenu(null)} onToggleMute={toggleMute} onToggleDeafen={toggleDeafen} onChange={saveAudio} onRequestMic={() => void requestMicrophone()} onSettings={() => { setAudioMenu(null); setSettingsSection('voice'); setModal('settings'); }}/></div>, document.body)}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

function ReactionPill({ reaction, pending, onToggle, onLongPress }: { reaction: ReactionSummary; pending: boolean; onToggle: () => void; onLongPress: () => void }) {
  const timer = useRef<number | null>(null);
  const held = useRef(false);
  const clear = () => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; };
  return <button type="button" className={`reaction-pill ${reaction.reactedByMe ? 'reacted' : ''} ${pending ? 'pending' : ''}`} aria-label={`${reaction.emoji}, ${reaction.count}; ${reaction.reactedByMe ? 'já reagiste' : 'ainda não reagiste'}. Toca para alternar; mantém premido para ver quem reagiu.`} aria-pressed={reaction.reactedByMe} disabled={pending} onPointerDown={() => { held.current = false; clear(); timer.current = window.setTimeout(() => { held.current = true; onLongPress(); }, 520); }} onPointerUp={clear} onPointerLeave={clear} onPointerCancel={clear} onContextMenu={(event) => { event.preventDefault(); clear(); held.current = true; onLongPress(); }} onClick={() => { if (held.current) { held.current = false; return; } onToggle(); }}>{reaction.emoji}<span>{reaction.count}</span>{pending && <small>A enviar…</small>}</button>;
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

function AdminModal({ details, onClose, onSaved }: { details: CommunityDetails; onClose: () => void; onSaved: () => void }) {
  type AuditEntry = { id: string; action: string; reason: string; durationSeconds: number | null; metadata: string; createdAt: string; actorId: string; actorUsername: string; targetUserId: string | null };
  type BanEntry = { userId: string; username: string; reason: string; createdAt: string; expiresAt: string | null };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [tab, setTab] = useState<'community' | 'bans' | 'audit'>(details.myRole === 'moderator' ? 'audit' : 'community');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [bans, setBans] = useState<BanEntry[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [loadingBans, setLoadingBans] = useState(false);
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
  useEffect(() => { if (tab === 'audit') void loadAudit(); else if (tab === 'bans') void loadBans(); }, [tab, details.community.id]);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(''); const form = new FormData(event.currentTarget);
    try {
      await api(`/communities/${details.community.id}`, { method: 'PATCH', body: JSON.stringify({ name: String(form.get('name')), description: String(form.get('description')), category: String(form.get('category')), rules: String(form.get('rules')) }) });
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
  const actionLabels: Record<string, string> = {
    'member.banned': 'Banimento aplicado', 'member.unbanned': 'Banimento revogado', 'member.kicked': 'Membro expulso',
    'member.muted': 'Silenciamento aplicado', 'member.unmuted': 'Silenciamento removido', 'member.role_changed': 'Cargo alterado',
    'community.updated': 'Comunidade atualizada', 'message.pinned': 'Mensagem fixada', 'message.unpinned': 'Mensagem desafixada',
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal admin-modal" role="dialog" aria-modal="true" aria-labelledby="admin-title">
      <div className="admin-heading"><div><h2 id="admin-title">Administração</h2><p className="muted">Regras, membros e atividade da comunidade.</p></div><button type="button" className="icon-button" aria-label="Fechar administração" onClick={onClose}>×</button></div>
      <div className="admin-tabs" role="tablist" aria-label="Secções de administração">
        {['owner', 'admin'].includes(details.myRole ?? '') && <button className={tab === 'community' ? 'active' : ''} role="tab" aria-selected={tab === 'community'} onClick={() => setTab('community')}>Comunidade</button>}
        <button className={tab === 'bans' ? 'active' : ''} role="tab" aria-selected={tab === 'bans'} onClick={() => setTab('bans')}>Banimentos</button>
        <button className={tab === 'audit' ? 'active' : ''} role="tab" aria-selected={tab === 'audit'} onClick={() => setTab('audit')}>Auditoria</button>
      </div>
      {error && <p className="error-banner" role="alert">{error}</p>}{success && <p className="notice" role="status">{success}</p>}
      {tab === 'community' && ['owner', 'admin'].includes(details.myRole ?? '') && <form onSubmit={(event) => void save(event)}>
        <label className="field">Nome<input name="name" defaultValue={details.community.name} required/></label>
        <label className="field">Descrição<textarea name="description" defaultValue={details.community.description} rows={3}/></label>
        <label className="field">Categoria<input name="category" defaultValue={details.community.category} required/></label>
        <label className="field">Regras<textarea name="rules" defaultValue={details.community.rules ?? ''} rows={4} placeholder="Regras da comunidade"/></label>
        <div className="admin-summary"><strong>Gestão de membros</strong><span>{details.members.length} membros · {details.channels.length} canais</span><span>Altera cargos e gere silenciamentos pelo menu de cada membro.</span></div>
        <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary" disabled={busy}>{busy ? 'A guardar…' : 'Guardar alterações'}</button></div>
      </form>}
      {tab === 'bans' && <div className="admin-list-section"><div className="admin-list-heading"><strong>Banimentos ativos</strong><button className="text-button" onClick={() => void loadBans()} disabled={loadingBans}>Atualizar</button></div>
        {loadingBans ? <div className="empty-state">A carregar…</div> : bans.length === 0 ? <div className="empty-state">Não há banimentos ativos.</div> : <div className="admin-clean-list">{bans.map((ban) => <div className="admin-list-row" key={ban.userId}><div className="admin-list-copy"><strong>{ban.username}</strong><span className="muted">{banExpiryLabel(ban.expiresAt)} · aplicado em {new Intl.DateTimeFormat('pt-MZ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ban.createdAt))}</span>{ban.reason && <span className="muted">{ban.reason}</span>}</div><button className="secondary" onClick={() => void revokeBan(ban.userId)}>Revogar banimento</button></div>)}</div>}
      </div>}
      {tab === 'audit' && <div className="admin-list-section"><div className="admin-list-heading"><strong>Atividade recente</strong><button className="text-button" onClick={() => void loadAudit()} disabled={loadingAudit}>Atualizar</button></div>
        {loadingAudit ? <div className="empty-state">A carregar…</div> : entries.length === 0 ? <div className="empty-state">Ainda não há ações registadas.</div> : <div className="admin-clean-list">{entries.map((entry) => <article className="audit-row" key={entry.id}><div className="audit-row-top"><strong>{actionLabels[entry.action] ?? 'Ação da comunidade'}</strong><time>{new Intl.DateTimeFormat('pt-MZ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.createdAt))}</time></div><span className="muted">Por {entry.actorUsername}{entry.targetUserId ? ` · Utilizador ${entry.targetUserId.slice(0, 8)}` : ''}</span>{entry.reason && <p>{entry.reason}</p>}</article>)}</div>}
      </div>}
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
  onSave: (data: { username: string; avatarUrl: string | null; aboutMe: string; bannerUrl: string | null; bannerColor: string | null; statusText: string; presencePreference: 'online' | 'away' | 'dnd' | 'invisible'; visibility: ProfileVisibility }) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<'profile' | 'appearance' | 'privacy' | 'account'>('profile');
  const [username, setUsername] = useState(''); const [avatarUrl, setAvatarUrl] = useState(''); const [aboutMe, setAboutMe] = useState('');
  const [bannerUrl, setBannerUrl] = useState(''); const [bannerColor, setBannerColor] = useState<string | null>(null); const [statusText, setStatusText] = useState('');
  const [presencePreference, setPresencePreference] = useState<'online' | 'away' | 'dnd' | 'invisible'>('online');
  const [visibility, setVisibility] = useState<ProfileVisibility>({ avatar: true, about: true, status: true, joinDate: true, commonCommunities: true, email: false, banner: true });
  const [savedSnapshot, setSavedSnapshot] = useState('');
  useEffect(() => { if (!data) return; setUsername(data.user.username); setAvatarUrl(data.user.avatarUrl ?? ''); setAboutMe(data.user.aboutMe); setBannerUrl(data.user.bannerUrl ?? ''); setBannerColor(data.user.bannerColor); setStatusText(data.user.statusText); setPresencePreference(data.user.presencePreference); setVisibility(data.user.visibility); setSavedSnapshot(JSON.stringify(data.user)); }, [data]);
  useEffect(() => { const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; document.addEventListener('keydown', closeOnEscape); return () => document.removeEventListener('keydown', closeOnEscape); }, [onClose]);
  const draft = { username: username.trim(), avatarUrl: safeHttps(avatarUrl), aboutMe: aboutMe.trim(), bannerUrl: safeHttps(bannerUrl), bannerColor, statusText: statusText.trim(), presencePreference, visibility };
  const dirty = Boolean(data && JSON.stringify({ ...data.user, ...draft }) !== savedSnapshot);
  const requestClose = () => { if (!dirty || window.confirm('Sair sem guardar?')) onClose(); };
  const save = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); onSave({ ...draft }); };
  const preview: MemberProfile = { id: data?.user.id ?? '', username: username || data?.user.username || 'Perfil', avatarUrl: visibility.avatar ? safeHttps(avatarUrl) : null, aboutMe: visibility.about ? aboutMe.trim() : undefined, bannerUrl: visibility.banner ? safeHttps(bannerUrl) : undefined, bannerColor: visibility.banner ? bannerColor : undefined, statusText: visibility.status ? statusText.trim() : undefined, online, presence: presencePreference };
  if (loading) return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true"><p className="muted" role="status">A carregar o teu perfil…</p></section></div>;
  if (error || !data) return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true"><p className="error-banner" role="alert">{error || 'Perfil não encontrado.'}</p><button className="secondary" onClick={onReload}>Tentar novamente</button></section></div>;
  if (!expanded) return <ProfileCompactCard profile={preview} own onExpand={() => setExpanded(true)} onClose={requestClose} onEdit={() => { setExpanded(true); setTab('profile'); }} onStatus={() => { setExpanded(true); setTab('profile'); }}/>
  return createPortal(<div className="modal-backdrop expanded-profile-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}><section className="expanded-profile-panel" role="dialog" aria-modal="true" aria-labelledby="expanded-profile-title"><header className="profile-page-header"><button className="icon-button" onClick={requestClose} aria-label="Voltar">←</button><div><h2 id="expanded-profile-title">O teu perfil</h2><p className="muted">Vê e escolhe o que partilhas.</p></div></header><div className="expanded-profile-grid"><form onSubmit={save} className="profile-editor"><nav className="profile-tabs" aria-label="Secções do perfil">{(['profile', 'appearance', 'privacy', 'account'] as const).map((item) => <button type="button" key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item === 'profile' ? 'Perfil' : item === 'appearance' ? 'Aparência' : item === 'privacy' ? 'Privacidade' : 'Conta'}</button>)}</nav>{tab === 'profile' && <section className="profile-section"><h3>Perfil</h3><label className="field">Nome de utilizador<input value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={32} required/><small>O nome de utilizador é sempre público.</small></label><label className="field">Sobre mim<textarea value={aboutMe} onChange={(event) => setAboutMe(event.target.value.slice(0, 160))} maxLength={160} rows={4}/><small className="profile-counter">{aboutMe.length}/160</small></label><label className="field">Texto de estado<input value={statusText} onChange={(event) => setStatusText(event.target.value.slice(0, 80))} maxLength={80}/><small className="profile-counter">{statusText.length}/80</small></label><label className="field">Estado<select value={presencePreference} onChange={(event) => setPresencePreference(event.target.value as typeof presencePreference)}>{Object.entries(presenceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>O estado Invisível aparece como desligado para os outros.</small></label></section>}{tab === 'appearance' && <section className="profile-section"><h3>Aparência</h3><label className="field">Foto de perfil (link)<input value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} placeholder="https://…"/><small>Cola o link de uma imagem.</small></label><label className="field">Imagem de fundo (link)<input value={bannerUrl} onChange={(event) => setBannerUrl(event.target.value)} placeholder="https://…"/><small>Cola o link de uma imagem. Para o fundo, uma imagem larga fica melhor.</small></label><div className="field"><span>Cor de fundo</span><div className="profile-color-grid"><button type="button" className={!bannerColor ? 'selected' : ''} onClick={() => setBannerColor(null)}>Nenhuma</button>{profileColors.map((color) => <button type="button" key={color} aria-label={color} className={bannerColor === color ? 'selected' : ''} style={{ backgroundColor: color }} onClick={() => setBannerColor(color)}/>)}</div></div></section>}{tab === 'privacy' && <section className="profile-section"><h3>Privacidade</h3><div className="privacy-list">{profileVisibilityOptions.map((option) => <label className="privacy-row" key={option.key}><span><strong>{option.title}</strong><small>{option.help}</small></span><input type="checkbox" checked={visibility[option.key]} onChange={(event) => setVisibility((current) => ({ ...current, [option.key]: event.target.checked }))}/></label>)}</div><button type="button" className="secondary privacy-preview-button" onClick={() => setTab('profile')}>Ver como os outros me veem</button></section>}{tab === 'account' && <section className="profile-section"><h3>Conta</h3><div className="profile-account-info"><div><strong>Email</strong><span>{data.user.email}</span></div><div><strong>Data de entrada</strong><span>{profileDate(data.user.createdAt)}</span></div><div><strong>Comunidades</strong><span>{data.communities.length ? data.communities.map((community) => community.name).join(', ') : 'Ainda não participas em comunidades.'}</span></div></div><button type="button" className="danger-button" onClick={() => { if (window.confirm('Queres terminar sessão?')) onLogout(); }}>Terminar sessão</button></section>}<div className="profile-actions"><button type="button" className="secondary" onClick={requestClose}>Descartar alterações</button><button className="primary" disabled={!dirty || busy}>{busy ? 'A guardar…' : 'Guardar'}</button></div></form><aside className="profile-live-preview"><h3>Pré-visualização</h3><ProfileCompactCard profile={preview} own={false} onExpand={() => undefined} onClose={() => undefined}/></aside></div></section></div>, document.body);
}

function MemberProfileSheet({ profile, loading, error, onClose }: { profile: MemberProfile | null; loading: boolean; error: string; onClose: () => void }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; document.addEventListener('keydown', closeOnEscape); return () => document.removeEventListener('keydown', closeOnEscape); }, [onClose]);
  if (loading || error || !profile) return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true">{loading && <p className="muted" role="status">A carregar o perfil…</p>}{error && <p className="error-banner" role="alert">{error}</p>}{error && <button className="secondary" onClick={onClose}>Fechar</button>}</section></div>;
  const presence = profile.presence ?? (profile.online ? 'online' : 'invisible');
  if (!expanded) return <ProfileCompactCard profile={profile} own={false} onExpand={() => setExpanded(true)} onClose={onClose}/>;
  return <div className="modal-backdrop profile-card-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="expanded-member-panel" role="dialog" aria-modal="true" aria-labelledby="member-profile-title"><ProfileBanner name={profile.username} url={profile.bannerUrl} color={profile.bannerColor}><button className="profile-close icon-button" onClick={onClose} aria-label="Fechar perfil">×</button></ProfileBanner><div className="expanded-member-content"><header className="profile-card-head"><span className="profile-large-avatar"><Avatar name={profile.username} url={profile.avatarUrl} size={80}/><span className="profile-status-ring" style={{ backgroundColor: presenceColor(presence, profile.online) }}/></span><div className="profile-card-title"><h2 id="member-profile-title">{profile.username}</h2><span className="profile-presence">{presenceLabels[presence as keyof typeof presenceLabels] ?? 'Desligado'}{profile.role ? ` · ${roleLabels[profile.role] ?? profile.role}` : ''}</span></div></header>{profile.statusText && <p className="profile-status-bubble">{profile.statusText}</p>}{profile.aboutMe && <section className="member-profile-item"><h3>Sobre mim</h3><p>{profile.aboutMe}</p></section>}{profile.createdAt && <section className="member-profile-item"><h3>Data de entrada no Mavuno</h3><p>{profileDate(profile.createdAt)}</p></section>}{!!profile.commonCommunities?.length && <section className="member-profile-item"><h3>Comunidades em comum</h3><ul>{profile.commonCommunities.map((community) => <li key={community.id}>{community.name}</li>)}</ul></section>}{profile.email && <section className="member-profile-item"><h3>Email</h3><p>{profile.email}</p></section>}</div></section></div>;
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

function SettingsModal({ user, section, preferences, devices, audioError, onSection, onChange, onRequestMic, onOpenProfile, onLogout, onClose }: { user: User; section: 'account' | 'voice'; preferences: AudioPreferences; devices: MediaDeviceInfo[]; audioError: string; onSection: (section: 'account' | 'voice') => void; onChange: (patch: Partial<AudioPreferences>) => void; onRequestMic: () => void; onOpenProfile: () => void; onLogout: () => void; onClose: () => void }) {
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
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
      <div className="settings-body"><nav className="settings-nav"><button className={section === 'account' ? 'active' : ''} onClick={() => onSection('account')}>Conta</button><button className={section === 'voice' ? 'active' : ''} onClick={() => onSection('voice')}>Voz e áudio</button></nav>
        <div className="settings-content">{section === 'account' ? <><section className="settings-section"><h3>Conta</h3><p className="muted">O teu perfil e as informações que escolhes partilhar.</p><button className="secondary" onClick={onOpenProfile}><Avatar name={user.username} url={user.avatarUrl} size={28}/> O meu perfil</button></section><section className="settings-section danger-section"><h3>Terminar sessão</h3><p className="muted">Sair deste aparelho.</p><button className="danger-button" onClick={() => { if (window.confirm('Queres terminar sessão?')) onLogout(); }}>Terminar sessão</button></section></> : <><section className="settings-section"><h3>Voz e áudio</h3><label className="audio-setting-row">Dispositivo de entrada<select value={preferences.inputDeviceId} onChange={(event) => onChange({ inputDeviceId: event.target.value })}><option value="">Predefinido do sistema</option>{devices.filter((device) => device.kind === 'audioinput').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microfone ${index + 1}`}</option>)}</select></label><button className="audio-menu-link" onClick={onRequestMic}>Permitir / testar microfone</button><label className="audio-setting-row">Perfil de voz<select value={preferences.voiceProfile} onChange={(event) => onChange({ voiceProfile: event.target.value as VoiceProfile })}><option value="default">Padrão</option><option value="noise-reduction">Redução de ruído</option><option value="studio">Estúdio</option></select></label><div className="mic-test"><button className="secondary" onClick={() => void testMic()}>{testing ? 'A ouvir…' : 'Testar microfone'}</button><div className="level-track"><span style={{ width: `${level}%` }}/></div></div>{audioError && <p className="error-banner">{audioError}</p>}</section><section className="settings-section"><h3>Saída</h3><p className="audio-note">{devices.some((device) => device.kind === 'audiooutput') && 'setSinkId' in HTMLMediaElement.prototype ? 'Escolhe a saída no menu dos auscultadores.' : 'Este navegador usa a saída do sistema.'}</p><label className="audio-setting-row">Volume de saída <output>{preferences.outputVolume}%</output><input type="range" min="0" max="100" value={preferences.outputVolume} onChange={(event) => onChange({ outputVolume: Number(event.target.value) })}/></label></section></>}</div></div>
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
