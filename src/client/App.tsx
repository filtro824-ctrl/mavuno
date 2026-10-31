import { type FormEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { io } from 'socket.io-client';
import type { Room, RemoteParticipant } from 'livekit-client';
import { api, prepareCsrf, type Channel, type Community, type CommunityDetails, type Member, type MemberProfile, type Message, type OwnProfileResponse, type PrivateCall, type PrivateCallStatus, type ProfileVisibility, type ReactionSummary, type User } from './api';
import { EMOJI_CATEGORIES, EMOJI_INDEX, type EmojiCategoryId } from './emoji-data';
import { toggleReactionSummary } from './reaction-state';

type ModalType = 'community' | 'channel' | 'profile' | 'memberProfile' | 'account' | 'admin' | null;
const roleLabels: Record<string, string> = { owner: 'Proprietário', admin: 'Administrador', moderator: 'Moderador', member: 'Membro' };

function initials(value: string): string {
  return value.trim().slice(0, 1).toUpperCase() || '?';
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
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [callTarget, setCallTarget] = useState<Member | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const knownMessageIds = useRef(new Set<string>());
  knownMessageIds.current = new Set(messages.flatMap((message) => [message.id, message.clientMessageId]));
  const nearBottom = useRef(true);
  const tuckTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const onPopState = () => {
      if (mobileHistory.current.length > 1) { mobileHistory.current.pop(); setMobileView(mobileHistory.current[mobileHistory.current.length - 1]); }
      else { window.history.pushState({ mavunoView: 'channels' }, '', window.location.href); setMobileView('channels'); }
    };
    window.history.replaceState({ mavunoView: 'channels' }, '', window.location.href);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const isManager = details?.myRole === 'owner' || details?.myRole === 'admin';
  const canKick = ['owner', 'admin', 'moderator'].includes(details?.myRole ?? '');
  const activeCommunityId = details?.community.id;
  const quickItems = useMemo(() => communities.map((community) => ({ id: community.id, name: community.name })), [communities]);

  const notify = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(''), 3200);
  }, []);
  const loadCommunities = useCallback(async () => {
    try {
      const result = await api<{ communities: Community[] }>('/communities/mine');
      setCommunities(result.communities);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Não foi possível carregar as comunidades.');
    }
  }, [notify]);
  const openOwnProfile = useCallback(async () => {
    setAccountMenuOpen(false);
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
    setAccountMenuOpen(false);
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
    socket.on('community:kicked', (event: { communityId: string }) => {
      if (event.communityId === communityId) { setDetails(null); setChannel(null); void loadCommunities(); notify('A tua associação à comunidade foi removida.'); }
    });
    socket.on('community:banned', (event: { communityId: string }) => {
      if (event.communityId === communityId) { setDetails(null); setChannel(null); void loadCommunities(); notify('O teu acesso a esta comunidade foi removido.'); }
    });
    return () => { socket.disconnect(); };
  }, [details?.community.id, loadCommunities, loadMemberProfile, notify]);
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
    socket.on('community:kicked', (event: { communityId: string }) => {
      if (event.communityId === details?.community.id) { setDetails(null); setChannel(null); void loadCommunities(); notify('A tua associação à comunidade foi removida.'); }
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
    if (!activeCommunityId || !window.confirm(`Remover ${member.username} desta comunidade?`)) return;
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
  const moderateMember = async (action: 'mute' | 'unmute' | 'ban' | 'kick', member: Member, durationMinutes?: number) => {
    if (!activeCommunityId) return;
    if ((action === 'mute' || action === 'unmute') && !window.confirm(action === 'mute' ? `Silenciar ${member.username} por ${durationMinutes === 5 ? '5 minutos' : '1 hora'}?` : `Remover o silenciamento de ${member.username}?`)) return;
    try {
      if (action === 'kick') await kickMember(member);
      else if (action === 'ban') { if (!window.confirm(`Banir ${member.username}?`)) return; await api(`/communities/${activeCommunityId}/members/${member.id}/ban`, { method: 'POST', body: JSON.stringify({}) }); setDetails((current) => current ? { ...current, members: current.members.filter((item) => item.id !== member.id) } : current); notify(`${member.username} foi banido.`); }
      else if (action === 'mute') { const result = await api<{ expiresAt: string }>(`/communities/${activeCommunityId}/members/${member.id}/mute`, { method: 'POST', body: JSON.stringify({ durationMinutes }) }); setDetails((current) => current ? { ...current, members: current.members.map((item) => item.id === member.id ? { ...item, mutedUntil: result.expiresAt } : item) } : current); notify(`${member.username} foi silenciado.`); }
      else { await api(`/communities/${activeCommunityId}/members/${member.id}/mute`, { method: 'DELETE' }); setDetails((current) => current ? { ...current, members: current.members.map((item) => item.id === member.id ? { ...item, mutedUntil: null } : item) } : current); notify('Silenciamento removido.'); }
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível aplicar a ação de moderação.'); }
  };
  const updateProfile = async (data: { username: string; avatarUrl: string | null; aboutMe: string; visibility: ProfileVisibility }) => {
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
        {details.members.map((member) => <div className="member-row" key={member.id} title={roleLabels[member.role] ?? member.role}>
          <button className="profile-avatar-button" aria-label={`Ver perfil de ${member.username}`} onClick={() => openMemberProfile(member.id)}><Avatar name={member.username} url={member.avatarUrl} size={27}/></button>
          <button className="member-name profile-name-link" onClick={() => openMemberProfile(member.id)}>{member.username}</button>
          {isManager && member.role !== 'owner' ? <select className="role-select" aria-label={`Cargo de ${member.username}`} value={member.role} onChange={(event) => void changeRole(member, event.target.value)}>
            <option value="admin">Admin</option><option value="moderator">Moderador</option><option value="member">Membro</option>
          </select> : <small className="member-role">{roleLabels[member.role] ?? member.role}</small>}
          {canKick && member.id !== user.id && member.role !== 'owner' && <MemberActions member={member} onAction={(action, duration) => void moderateMember(action, member, duration)} onCall={() => setCallTarget(member)}/>} 
        </div>)}
        {details.myRole && details.myRole !== 'owner' && <button className="text-button" style={{ marginTop: 12 }} onClick={() => void leaveCommunity()}>Sair da comunidade</button>}
        {!details.myRole && <p className="muted" style={{ fontSize: 12, padding: 8 }}>Precisas de um convite para abrir os canais.</p>}
      </div> : <div className="side-content">
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>Escolhe uma comunidade à esquerda ou explora espaços públicos.</p>
        <button className="secondary" style={{ width: '100%' }} onClick={() => setModal('community')}>＋ Criar comunidade</button>
      </div>}
      <footer className="side-footer">
        <button className="identity-control" aria-label={`Abrir o teu perfil, ${user.username}`} onClick={() => void openOwnProfile()}>
          <Avatar name={user.username} url={user.avatarUrl}/>
          <span className="identity-copy"><strong>{user.username}</strong><span className="muted">{!online ? 'Sem ligação' : reconnecting ? 'A reconectar…' : 'Ligado'}</span></span>
        </button>
        <button className="icon-button" aria-label="Editar perfil" title="Editar perfil" onClick={() => void openOwnProfile()}>◎</button>
        <div className="account-menu-wrap">
          <button className="icon-button" aria-label="Abrir menu da conta" title="Menu da conta" aria-haspopup="menu" aria-expanded={accountMenuOpen} onClick={() => setAccountMenuOpen((value) => !value)}>⋯</button>
          {accountMenuOpen && <div className="account-menu" role="menu">
            <strong className="account-menu-title">Conta</strong>
            <button role="menuitem" className="account-menu-item" onClick={() => void openOwnProfile()}>Editar perfil</button>
            <button role="menuitem" className="account-menu-item" onClick={() => { setAccountMenuOpen(false); setModal('account'); }}>Definições da conta</button>
            <button role="menuitem" className="account-menu-item danger-text" onClick={() => { setAccountMenuOpen(false); void logout(); }}>Terminar sessão</button>
          </div>}
        </div>
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
      </section> : channel?.kind === 'voice' ? <VoicePanel channel={channel} notify={notify}/> : channel ? <>
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
          {messages.map((message, index) => <article className={`message ${index > 0 && messages[index - 1]?.authorId === message.authorId ? 'message-grouped' : ''}`} key={message.id}>
            <button className="profile-avatar-button message-avatar-button" aria-label={`Ver perfil de ${message.username}`} onClick={() => openMemberProfile(message.authorId)}><Avatar name={message.username} url={message.avatarUrl}/></button>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="message-meta"><button className="profile-name-link" onClick={() => openMemberProfile(message.authorId)}>{message.username}</button><time className="message-time" dateTime={message.createdAt}>{formatTime(message.createdAt)}</time></div>
              {message.replyToId && <div className="reply-preview"><strong>{message.replyAuthor ?? 'Mensagem apagada'}</strong>{message.replyBody && <span>{message.replyBody.slice(0, 100)}</span>}</div>}
              <div className="message-body">{message.pinnedAt && <span className="pinned-label">Fixada · </span>}{message.body}</div>
              {!!message.reactions?.length && <div className="reaction-pills">{message.reactions.map((reaction) => <ReactionPill key={reaction.emoji} reaction={reaction} pending={pendingReactionKeys.has(`${message.id}:${reaction.emoji}`)} onToggle={() => void toggleReaction(message, reaction.emoji)} onLongPress={() => void showReactionUsers(message.id, reaction.emoji)}/>)}</div>}
              {Array.from(pendingReactionKeys).some((key) => key.startsWith(`${message.id}:`)) && !(message.reactions ?? []).some((reaction) => pendingReactionKeys.has(`${message.id}:${reaction.emoji}`)) && <small className="reaction-pending-label">A enviar…</small>}
              {message.delivery === 'sending' && <span className="message-delivery">A enviar…</span>}
              {!message.delivery && message.authorId === user.id && <span className="message-delivery">Enviada</span>}
              {message.delivery === 'failed' && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ fontSize: 11, color: 'var(--danger)' }}>Falhou enviar</span><button className="text-button" onClick={() => void sendMessage(message.body, message.clientMessageId, message.replyToId)}>Tentar novamente</button></div>}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {!message.delivery && <button className="text-button" style={{ fontSize: 11 }} onClick={() => setReply(message)}>Responder</button>}
                {!message.delivery && <MessageActions message={message} own={message.authorId === user.id} canModerate={['owner', 'admin', 'moderator'].includes(details?.myRole ?? '')} onDelete={() => void deleteMessage(message)} onPin={() => void togglePin(message)} onQuickReaction={(emoji) => void toggleReaction(message, emoji)} onMoreReactions={() => setEmojiPickerTarget({ messageId: message.id })}/>}
              </div>
            </div>
          </article>)}
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
    {modal === 'community' && <CommunityModal busy={busy} onClose={() => setModal(null)} onCreate={(data) => void createCommunity(data)}/>}
    {modal === 'channel' && <ChannelModal busy={busy} onClose={() => setModal(null)} onCreate={(data) => void createChannel(data)}/>}
    {modal === 'admin' && details && <AdminModal details={details} onClose={() => setModal(null)} onSaved={() => { if (activeCommunityId) void openCommunity(activeCommunityId, false); }}/>}
    {modal === 'profile' && <ProfileModal data={ownProfile} loading={profileLoading} error={ownProfileError} online={online && !reconnecting} busy={profileBusy} onClose={() => setModal(null)} onReload={() => void openOwnProfile()} onSave={(data) => void updateProfile(data)}/>}
    {modal === 'memberProfile' && <MemberProfileSheet profile={memberProfile} loading={memberProfileLoading} error={memberProfileError} onClose={closeMemberProfile}/>}
    {modal === 'account' && <AccountModal user={user} onClose={() => setModal(null)} onEditProfile={() => setModal('profile')}/>}
    <PrivateCallDock target={callTarget} onClearTarget={() => setCallTarget(null)} notify={notify}/>
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

function ContextMenu({ label, triggerClassName, children }: { label: string; triggerClassName: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = triggerRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const rect = anchor.getBoundingClientRect();
      if (window.innerWidth <= 760) { setPosition(null); return; }
      const width = Math.min(menu.getBoundingClientRect().width || 184, window.innerWidth - 24);
      const height = menu.getBoundingClientRect().height;
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const useBelow = below >= Math.min(height, 220) || below >= above;
      const maxHeight = Math.max(100, (useBelow ? below : above));
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      setPosition({ top: useBelow ? rect.bottom + 6 : Math.max(8, rect.top - Math.min(height, maxHeight) - 6), left, maxHeight });
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const onPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) close();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); window.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); };
  }, [open, close]);
  return <>
    <button ref={triggerRef} className={triggerClassName} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>⋯</button>
    {open && createPortal(<><button className="menu-backdrop" aria-label="Fechar menu" onClick={close}/><div ref={menuRef} className="context-menu" role="menu" style={window.innerWidth > 760 ? { position: 'fixed', top: position?.top ?? -1000, left: position?.left ?? -1000, maxHeight: position?.maxHeight ?? '70dvh', overflowY: 'auto', visibility: position ? 'visible' : 'hidden' } : undefined}>{children(close)}</div></>, document.body)}
  </>;
}
function MessageActions({ message, own, canModerate, onDelete, onPin, onQuickReaction, onMoreReactions }: { message: Message; own: boolean; canModerate: boolean; onDelete: () => void; onPin: () => void; onQuickReaction: (emoji: string) => void; onMoreReactions: () => void }) {
  return <ContextMenu label="Ações da mensagem" triggerClassName="text-button context-trigger">{(close) => <>
    <div className="quick-reactions-menu" role="group" aria-label="Reações rápidas">{['👍', '❤️', '😂', '😮', '😢', '🙏'].map((emoji) => <button key={emoji} type="button" aria-label={`Reagir com ${emoji}`} onClick={() => { close(); onQuickReaction(emoji); }}>{emoji}</button>)}<button type="button" aria-label="Mais emojis" onClick={() => { close(); onMoreReactions(); }}>＋</button></div>
    {canModerate && <button role="menuitem" onClick={() => { close(); onPin(); }}>{message.pinnedAt ? 'Desafixar' : 'Fixar'}</button>}
    {(own || canModerate) && <button role="menuitem" className="danger-text" onClick={() => { close(); onDelete(); }}>Apagar</button>}
  </>}</ContextMenu>;
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
function MemberActions({ member, onAction, onCall }: { member: Member; onAction: (action: 'mute' | 'unmute' | 'ban' | 'kick', duration?: number) => void; onCall: () => void }) {
  return <ContextMenu label={`Ações de ${member.username}`} triggerClassName="member-remove">{(close) => <>
    {member.mutedUntil ? <button role="menuitem" onClick={() => { close(); onAction('unmute'); }}>Remover silêncio</button> : <><button role="menuitem" onClick={() => { close(); onAction('mute', 5); }}>Silenciar · 5 min</button><button role="menuitem" onClick={() => { close(); onAction('mute', 60); }}>Silenciar · 1 hora</button></>}
    <button role="menuitem" onClick={() => { close(); onCall(); }}>Chamada de voz</button><button role="menuitem" className="danger-text" onClick={() => { close(); onAction('kick'); }}>Expulsar</button><button role="menuitem" className="danger-text" onClick={() => { close(); onAction('ban'); }}>Banir</button>
  </>}</ContextMenu>;
}
function PrivateCallDock({ target, onClearTarget, notify }: { target: Member | null; onClearTarget: () => void; notify: (text: string) => void }) {
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
    void api<{ token: string; serverUrl: string }>(`/calls/${call.id}/token`, { method: 'POST', body: '{}' }).then(async (credentials) => { const { Room: LiveKitRoom, RoomEvent } = await import('livekit-client'); const room = new LiveKitRoom({ adaptiveStream: true, dynacast: true }); roomRef.current = room; room.on(RoomEvent.TrackSubscribed, (track) => { const audio = track.attach(); audio.dataset.mavuno = 'voice'; document.body.appendChild(audio); void audio.play().catch(() => setError('O navegador bloqueou o áudio. Ativa o som e tenta novamente.')); }); room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((element) => element.remove())); room.on(RoomEvent.Disconnected, () => { roomRef.current = null; setCall((current) => current ? { ...current, status: 'ended' } : current); }); await room.connect(credentials.serverUrl, credentials.token); await room.localParticipant.setMicrophoneEnabled(true); setMicOn(true); setCall((current) => current ? { ...current, status: 'in_progress' } : current); }).catch((cause) => { connectedCall.current = null; if (call.id) void api(`/calls/${call.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'ended' }) }).catch(() => undefined); void releaseLiveKitRoom(roomRef.current); roomRef.current = null; setCall((current) => current ? { ...current, status: 'failed' } : current); const name = cause instanceof Error ? cause.name : ''; setError(name === 'NotAllowedError' || name === 'PermissionDeniedError' ? 'Permite o acesso ao microfone nas definições do navegador e tenta novamente.' : 'A voz ainda não está disponível. Tenta mais tarde.'); }).finally(() => setConnecting(false));
  }, [call]);
  if (!call) return null;
  const toggleMicrophone = async () => { const room = roomRef.current; if (!room) return; try { await room.localParticipant.setMicrophoneEnabled(!micOn); setMicOn((value) => !value); } catch { setError('Não foi possível alterar o microfone. Verifica a permissão do microfone.'); } };
  const close = async () => { await releaseLiveKitRoom(roomRef.current); roomRef.current = null; if (call.id && !['ended', 'rejected', 'timeout', 'failed'].includes(call.status)) await update('ended'); else setCall(null); };
  return <aside className="call-dock" role="dialog" aria-label="Chamada privada"><div className="call-dock-header"><Avatar name={call.peer?.username ?? 'Utilizador'} url={call.peer?.avatarUrl} size={38}/><div><strong>Chamada com {call.peer?.username ?? 'utilizador'}</strong><span className="muted">{statusLabels[call.status]}{connecting ? '…' : ''}</span></div></div>{error && <p className="error-banner">{error}</p>}{call.status === 'ringing' && <div className="call-actions"><button className="primary" onClick={() => void update('accepted')}>Aceitar</button><button className="secondary" onClick={() => void update('rejected')}>Recusar</button></div>}{call.status === 'in_progress' && <div className="call-actions"><button className="secondary" onClick={() => void toggleMicrophone()}>{micOn ? 'Silenciar' : 'Ativar microfone'}</button><button className="danger-button" onClick={() => void close()}>Terminar</button></div>}{['failed', 'ended', 'rejected', 'timeout'].includes(call.status) && <button className="secondary" onClick={() => setCall(null)}>Fechar</button>}</aside>;
}

function AdminModal({ details, onClose, onSaved }: { details: CommunityDetails; onClose: () => void; onSaved: () => void }) {
  type AuditEntry = { id: string; action: string; reason: string; durationSeconds: number | null; metadata: string; createdAt: string; actorId: string; actorUsername: string; targetUserId: string | null };
  type BanEntry = { userId: string; username: string; reason: string; createdAt: string };
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
        {loadingBans ? <div className="empty-state">A carregar…</div> : bans.length === 0 ? <div className="empty-state">Não há banimentos ativos.</div> : <div className="admin-clean-list">{bans.map((ban) => <div className="admin-list-row" key={ban.userId}><div className="admin-list-copy"><strong>{ban.username}</strong><span className="muted">Banido em {new Intl.DateTimeFormat('pt-MZ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ban.createdAt))}</span>{ban.reason && <span className="muted">{ban.reason}</span>}</div><button className="secondary" onClick={() => void revokeBan(ban.userId)}>Revogar banimento</button></div>)}</div>}
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
  { key: 'status', title: 'Estado «Ligado»', help: 'Outros membros veem se estás ligado.' },
  { key: 'joinDate', title: 'Data de entrada no Mavuno', help: 'Outros membros veem quando criaste a conta.' },
  { key: 'commonCommunities', title: 'Comunidades em comum', help: 'Cada pessoa vê apenas as comunidades onde ambos participam.' },
  { key: 'email', title: 'Email', help: 'Só proprietários e administradores podem ver, se ativares.' },
];

function ProfileModal({ data, loading, error, online, busy, onClose, onReload, onSave }: {
  data: OwnProfileResponse | null;
  loading: boolean;
  error: string;
  online: boolean;
  busy: boolean;
  onClose: () => void;
  onReload: () => void;
  onSave: (data: { username: string; avatarUrl: string | null; aboutMe: string; visibility: ProfileVisibility }) => void;
}) {
  const [username, setUsername] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [aboutMe, setAboutMe] = useState('');
  const [visibility, setVisibility] = useState<ProfileVisibility>({ avatar: true, about: true, status: true, joinDate: true, commonCommunities: true, email: false });
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    if (!data) return;
    setUsername(data.user.username);
    setAvatarUrl(data.user.avatarUrl ?? '');
    setAboutMe(data.user.aboutMe);
    setVisibility(data.user.visibility);
  }, [data]);
  const safeAvatarUrl = (() => { try { const value = avatarUrl.trim(); return new URL(value).protocol === 'https:' ? value : null; } catch { return null; } })();
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave({ username: username.trim(), avatarUrl: avatarUrl.trim() || null, aboutMe: aboutMe.trim(), visibility });
  };

  return <div className="modal-backdrop own-profile-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal own-profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title">
      <header className="profile-page-header"><button className="icon-button profile-back" onClick={onClose} aria-label="Voltar">←</button><div><h2 id="profile-title">O teu perfil</h2><p className="muted">Vê e escolhe o que partilhas.</p></div></header>
      {loading && <p className="muted" role="status">A carregar o teu perfil…</p>}
      {error && <div className="error-banner" role="alert">{error}<button className="text-button" onClick={onReload}>Tentar novamente</button></div>}
      {!loading && data && <form onSubmit={save}>
        <section className="profile-hero">
          <Avatar name={username || data.user.username} url={safeAvatarUrl} size={72}/>
          <div><strong className="profile-hero-name">{username || data.user.username}</strong><span className="profile-online"><span className={`online-dot ${online ? '' : 'offline'}`}/>{online ? 'Ligado' : 'A reconectar…'}</span></div>
        </section>
        <section className="profile-section"><h3>Editar perfil</h3>
          <label className="field">Nome de utilizador<input value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={32} pattern="[\p{L}\p{N}_-]+" required/><small>O nome de utilizador é sempre público.</small></label>
          <label className="field">Foto de perfil (link da imagem)<input value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} type="url" maxLength={500} placeholder="https://…"/><small>Usa uma ligação HTTPS. Se deixares vazio, aparece a inicial do teu nome.</small></label>
          <label className="field">Sobre mim<textarea value={aboutMe} onChange={(event) => setAboutMe(event.target.value.slice(0, 160))} maxLength={160} rows={3} placeholder="Escreve algo curto sobre ti."/><small className="profile-counter">{aboutMe.length}/160</small></label>
        </section>
        <section className="profile-section"><h3>Informações da conta</h3>
          <div className="profile-account-info"><div><strong>Email</strong><span>{data.user.email}</span></div><div><strong>Data de entrada no Mavuno</strong><span>{profileDate(data.user.createdAt)}</span></div><div><strong>Comunidades em que participas</strong>{data.communities.length ? <ul>{data.communities.map((community) => <li key={community.id}>{community.name}</li>)}</ul> : <span>Ainda não participas em comunidades.</span>}</div></div>
        </section>
        <section className="profile-section"><h3>O que os outros podem ver</h3>
          <div className="privacy-list">{profileVisibilityOptions.map((option) => <label className="privacy-row" key={option.key}>
            <span><strong>{option.title}</strong><small>{option.help}</small></span>
            <input type="checkbox" checked={visibility[option.key]} onChange={(event) => setVisibility((current) => ({ ...current, [option.key]: event.target.checked }))} aria-label={`${option.title}: ${option.help}`}/>
          </label>)}</div>
        </section>
        <section className="profile-preview-section"><button type="button" className="secondary" onClick={() => setPreview((value) => !value)}>{preview ? 'Fechar pré-visualização' : 'Ver como os outros me veem'}</button>
          {preview && <div className="profile-preview"><div className="profile-preview-heading"><Avatar name={username || data.user.username} url={visibility.avatar ? safeAvatarUrl : null} size={48}/><div><strong>{username || data.user.username}</strong>{visibility.status && <span>{online ? 'Ligado' : 'A reconectar…'}</span>}</div></div>
            {visibility.about && aboutMe.trim() && <p>{aboutMe.trim()}</p>}
            {visibility.joinDate && <p><strong>Data de entrada:</strong> {profileDate(data.user.createdAt)}</p>}
            {visibility.commonCommunities && <p className="muted">As comunidades em comum aparecem apenas a quem também participa nelas.</p>}
            {visibility.email && <p className="muted">O email só é mostrado a proprietários e administradores.</p>}
            {!visibility.about && !visibility.status && !visibility.joinDate && !visibility.commonCommunities && <p className="muted">Só o teu nome de utilizador será mostrado.</p>}
          </div>}
        </section>
        <div className="modal-actions profile-actions"><button className="primary" disabled={busy}>{busy ? 'A guardar…' : 'Guardar'}</button></div>
      </form>}
    </section>
  </div>;
}

function MemberProfileSheet({ profile, loading, error, onClose }: { profile: MemberProfile | null; loading: boolean; error: string; onClose: () => void }) {
  const visibleItems = Boolean(profile && (profile.aboutMe || Object.hasOwn(profile, 'online') || profile.createdAt || profile.commonCommunities?.length || profile.email));
  return <div className="modal-backdrop member-profile-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal member-profile-sheet" role="dialog" aria-modal="true" aria-labelledby="member-profile-title">
      <header className="member-profile-heading"><Avatar name={profile?.username ?? '?'} url={profile?.avatarUrl} size={62}/><div><h2 id="member-profile-title">{profile?.username ?? (loading ? 'Perfil' : 'Perfil do membro')}</h2>{profile && Object.hasOwn(profile, 'online') && <span className="profile-online"><span className={`online-dot ${profile.online ? '' : 'offline'}`}/>{profile.online ? 'Ligado' : 'Desligado'}</span>}</div><button className="icon-button" onClick={onClose} aria-label="Fechar perfil">×</button></header>
      {loading && <p className="muted" role="status">A carregar o perfil…</p>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      {profile && <div className="member-profile-content">
        {profile.aboutMe && <section className="member-profile-item"><h3>Sobre mim</h3><p>{profile.aboutMe}</p></section>}
        {profile.createdAt && <section className="member-profile-item"><h3>Data de entrada no Mavuno</h3><p>{profileDate(profile.createdAt)}</p></section>}
        {!!profile.commonCommunities?.length && <section className="member-profile-item"><h3>Comunidades em comum</h3><ul>{profile.commonCommunities.map((community) => <li key={community.id}>{community.name}</li>)}</ul></section>}
        {profile.email && <section className="member-profile-item"><h3>Email</h3><p>{profile.email}</p></section>}
        {!loading && !visibleItems && <p className="muted">Este membro ainda não partilhou mais informações.</p>}
      </div>}
    </section>
  </div>;
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

function VoicePanel({ channel, notify }: { channel: Channel; notify: (text: string) => void }) {
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
          const element = track.attach(); element.dataset.mavuno = 'voice'; document.body.appendChild(element);
        }
      });
      next.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((element) => element.remove()));
      next.on(RoomEvent.Disconnected, () => { setRoom(null); setParticipants([]); setSpeakers([]); active.current = null; });
      await next.connect(credentials.serverUrl, credentials.token);
      active.current = next;
      setRoom(next);
      await next.localParticipant.setMicrophoneEnabled(true);
      setMicOn(true);
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
    try { await room.localParticipant.setMicrophoneEnabled(!micOn); setMicOn((value) => !value); }
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
