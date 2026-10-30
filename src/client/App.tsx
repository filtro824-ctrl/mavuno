import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { Room, RemoteParticipant } from 'livekit-client';
import { api, prepareCsrf, type Channel, type Community, type CommunityDetails, type Member, type Message, type PrivateCall, type PrivateCallStatus, type User } from './api';

type ModalType = 'community' | 'channel' | 'profile' | 'account' | 'admin' | null;
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
  if (!user) return <AuthScreen onAuthed={setUser}/>;
  return <Dashboard user={user} onUserChange={setUser} onLogout={() => setUser(null)}/>;
}

function AuthScreen({ onAuthed }: { onAuthed: (user: User) => void }) {
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
    <p className="muted" style={{ fontSize: 11 }}>A recuperação por email ficará disponível quando o serviço de email estiver configurado.</p>
  </section></main>;
}

function Dashboard({ user, onUserChange, onLogout }: { user: User; onUserChange: (user: User) => void; onLogout: () => void }) {
  const [communities, setCommunities] = useState<Community[]>([]);
  const [details, setDetails] = useState<CommunityDetails | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [explore, setExplore] = useState(false);
  const [search, setSearch] = useState('');
  const [publicCommunities, setPublicCommunities] = useState<Community[]>([]);
  const [modal, setModal] = useState<ModalType>(null);
  const [toast, setToast] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [mobileView, setMobileView] = useState<'channels' | 'chat'>('channels');
  const [quickOpen, setQuickOpen] = useState(false);
  const [tucked, setTucked] = useState(false);
  const [reply, setReply] = useState<Message | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [callTarget, setCallTarget] = useState<Member | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const nearBottom = useRef(true);
  const tuckTimer = useRef<number | undefined>(undefined);
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
  const openCommunity = useCallback(async (id: string, autoChannel = true) => {
    try {
      const data = await api<CommunityDetails>(`/communities/${id}`);
      setDetails(data);
      setExplore(false);
      setChannel(null);
      setMessages([]);
      setMobileView('channels');
      if (autoChannel && data.myRole) {
        const first = data.channels.find((item) => item.kind === 'text') ?? data.channels[0];
        if (first) { setChannel(first); setMobileView('chat'); }
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
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);
  useEffect(() => {
    if (tuckTimer.current) window.clearTimeout(tuckTimer.current);
    tuckTimer.current = window.setTimeout(() => setTucked(true), 3600);
    return () => { if (tuckTimer.current) window.clearTimeout(tuckTimer.current); };
  }, [quickOpen]);

  const fetchMessages = useCallback(async (channelId: string, before?: string) => {
    const params = before ? `?before=${encodeURIComponent(before)}` : '';
    setLoadingMessages(true);
    try {
      const result = await api<{ messages: Message[]; hasMore: boolean; nextCursor: string | null }>(`/channels/${channelId}/messages${params}`);
      setMessages((current) => before ? [...result.messages, ...current] : result.messages);
      setHasMore(result.hasMore);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Não foi possível carregar mensagens.');
    } finally {
      setLoadingMessages(false);
    }
  }, [notify]);
  useEffect(() => {
    nearBottom.current = true;
    if (!channel || channel.kind !== 'text') { setMessages([]); return; }
    void fetchMessages(channel.id);
  }, [channel?.id, channel?.kind, fetchMessages]);
  useEffect(() => {
    if (nearBottom.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length, channel?.id]);
  useEffect(() => {
    if (!channel || channel.kind !== 'text') return;
    const socket = io({ withCredentials: true, reconnection: true, reconnectionDelay: 700, reconnectionDelayMax: 5000, transports: ['websocket', 'polling'] });
    let connectedBefore = false;
    socket.on('connect', () => {
      socket.emit('channel:join', { channelId: channel.id });
      if (connectedBefore) {
        void api<{ messages: Message[]; hasMore: boolean; nextCursor: string | null }>(`/channels/${channel.id}/messages`)
          .then((result) => {
            setMessages((current) => result.messages.reduce((merged, item) => mergeMessage(merged, item), current));
            setHasMore(result.hasMore);
          })
          .catch((cause) => notify(cause instanceof Error ? cause.message : 'Não foi possível atualizar mensagens após a reconexão.'));
      }
      connectedBefore = true;
    });
    socket.on('message:new', (message: Message) => setMessages((current) => mergeMessage(current, message)));
    socket.on('message:deleted', (event: { id: string }) => setMessages((current) => current.filter((message) => message.id !== event.id)));
    socket.on('message:pinned', (event: { id: string; pinnedAt: string; pinnedBy: string }) => setMessages((current) => current.map((message) => message.id === event.id ? { ...message, ...event } : message)));
    socket.on('message:unpinned', (event: { id: string }) => setMessages((current) => current.map((message) => message.id === event.id ? { ...message, pinnedAt: null, pinnedBy: null } : message)));
    socket.on('channel:deleted', (event: { id: string }) => {
      if (event.id === channel.id) { setChannel(null); notify('Este canal foi removido.'); }
    });
    socket.on('community:kicked', (event: { communityId: string }) => {
      if (event.communityId === details?.community.id) { setDetails(null); setChannel(null); void loadCommunities(); notify('A tua associação à comunidade foi removida.'); }
    });
    socket.on('room:error', (event: { error: string }) => notify(event.error));
    socket.on('mention:new', (event: { username: string }) => notify(`Mencionaram-te numa conversa, ${event.username}.`));
    return () => { socket.disconnect(); };
  }, [channel?.id, channel?.kind, details?.community.id, loadCommunities, notify]);

  const sendMessage = async (body: string, clientMessageId: string = crypto.randomUUID()) => {
    if (!channel || channel.kind !== 'text') return;
    const message: Message = {
      id: `optimistic:${clientMessageId}`, clientMessageId, body, replyToId: reply?.id ?? null,
      createdAt: new Date().toISOString(), authorId: user.id, username: user.username,
      avatarUrl: user.avatarUrl, delivery: 'sending',
    };
    setMessages((current) => mergeMessage(current, message));
    try {
      const result = await api<{ message: Message }>(`/channels/${channel.id}/messages`, {
        method: 'POST', body: JSON.stringify({ clientMessageId, body, replyToId: reply?.id ?? null }),
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
      setMobileView('chat');
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
    setExplore(true); setDetails(null); setChannel(null); setMobileView('channels');
    try {
      const result = await api<{ communities: Community[] }>(`/communities/explore${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      setPublicCommunities(result.communities);
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível explorar.'); }
  };
  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST', body: '{}' }); } catch { /* clear the visible session if the server is unreachable */ }
    onLogout();
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
    setChannel(item); setMobileView('chat'); setReply(null);
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
    try { await api(`/messages/${message.id}`, { method: 'DELETE' }); setMessages((current) => current.filter((item) => item.id !== message.id)); notify('Mensagem apagada.'); }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível apagar a mensagem.'); }
  };
  const togglePin = async (message: Message) => {
    try {
      if (message.pinnedAt) { await api(`/messages/${message.id}/pin`, { method: 'DELETE' }); setMessages((current) => current.map((item) => item.id === message.id ? { ...item, pinnedAt: null, pinnedBy: null } : item)); notify('Mensagem desafixada.'); }
      else { const result = await api<{ message: { pinnedAt: string; pinnedBy: string } }>(`/messages/${message.id}/pin`, { method: 'POST', body: '{}' }); setMessages((current) => current.map((item) => item.id === message.id ? { ...item, ...result.message } : item)); notify('Mensagem fixada.'); }
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível atualizar a mensagem.'); }
  };
  const moderateMember = async (action: 'mute' | 'unmute' | 'ban' | 'kick', member: Member, durationMinutes?: number) => {
    if (!activeCommunityId) return;
    try {
      if (action === 'kick') await kickMember(member);
      else if (action === 'ban') { if (!window.confirm(`Banir ${member.username}?`)) return; await api(`/communities/${activeCommunityId}/members/${member.id}/ban`, { method: 'POST', body: JSON.stringify({}) }); setDetails((current) => current ? { ...current, members: current.members.filter((item) => item.id !== member.id) } : current); notify(`${member.username} foi banido.`); }
      else if (action === 'mute') { const result = await api<{ expiresAt: string }>(`/communities/${activeCommunityId}/members/${member.id}/mute`, { method: 'POST', body: JSON.stringify({ durationMinutes }) }); setDetails((current) => current ? { ...current, members: current.members.map((item) => item.id === member.id ? { ...item, mutedUntil: result.expiresAt } : item) } : current); notify(`${member.username} foi silenciado.`); }
      else { await api(`/communities/${activeCommunityId}/members/${member.id}/mute`, { method: 'DELETE' }); setDetails((current) => current ? { ...current, members: current.members.map((item) => item.id === member.id ? { ...item, mutedUntil: null } : item) } : current); notify('Silenciamento removido.'); }
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Não foi possível aplicar a ação de moderação.'); }
  };
  const updateProfile = async (data: { username?: string; avatarUrl?: string | null }) => {
    setProfileBusy(true);
    try {
      const result = await api<{ user: User }>('/profile', { method: 'PATCH', body: JSON.stringify(data) });
      onUserChange(result.user); setModal(null); notify('Perfil atualizado.');
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
          {details && isManager && <button className="icon-button" title="Configurações da comunidade" aria-label="Configurações da comunidade" onClick={() => setModal('admin')}>⚙</button>}
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
          <Avatar name={member.username} url={member.avatarUrl} size={27}/>
          <span className="member-name">{member.username}</span>
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
        <Avatar name={user.username} url={user.avatarUrl}/>
        <span style={{ minWidth: 0, flex: 1 }}><strong style={{ fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.username}</strong><span className="muted" style={{ fontSize: 11 }}>{online ? 'Ligado' : 'Sem ligação'}</span></span>
        <button className="icon-button" aria-label="Editar perfil" title="Editar perfil" onClick={() => { setAccountMenuOpen(false); setModal('profile'); }}>◎</button>
        <div className="account-menu-wrap">
          <button className="icon-button" aria-label="Abrir menu da conta" title="Menu da conta" aria-haspopup="menu" aria-expanded={accountMenuOpen} onClick={() => setAccountMenuOpen((value) => !value)}>⋯</button>
          {accountMenuOpen && <div className="account-menu" role="menu">
            <strong className="account-menu-title">Conta</strong>
            <button role="menuitem" className="account-menu-item" onClick={() => { setAccountMenuOpen(false); setModal('profile'); }}>Editar perfil</button>
            <button role="menuitem" className="account-menu-item" onClick={() => { setAccountMenuOpen(false); setModal('account'); }}>Planos e funcionalidades</button>
            <button role="menuitem" className="account-menu-item danger-text" onClick={() => { setAccountMenuOpen(false); void logout(); }}>Terminar sessão</button>
          </div>}
        </div>
      </footer>
    </aside>

    <main className="main-panel">
      <header className="topbar">
        {mobileView === 'chat' && <button className="icon-button mobile-back" onClick={() => setMobileView('channels')} aria-label="Voltar aos canais">←</button>}
        <h1>{explore ? 'Descobrir comunidades' : channel ? `${channel.kind === 'voice' ? '◖' : '#'} ${channel.name}` : details?.community.name ?? 'Mavuno'}</h1>
        <span className={`network-status ${online ? '' : 'offline'}`}>{online ? '● Ligado' : '● Sem ligação'}</span>
        {channel?.kind === 'text' && <span className="muted">Mensagens guardadas</span>}
      </header>

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
        }}>
          {hasMore && <button className="text-button" style={{ display: 'block', margin: '0 auto 10px' }} disabled={loadingMessages} onClick={() => {
            const oldest = messages[0];
            if (oldest) { nearBottom.current = false; void fetchMessages(channel.id, `${oldest.createdAt}~${oldest.id}`); }
          }}>{loadingMessages ? 'A carregar…' : 'Carregar mensagens anteriores'}</button>}
          {messages.length === 0 && !loadingMessages && <div className="empty-state">Ainda não há mensagens. Começa a conversa.</div>}
          {messages.map((message) => <article className="message" key={message.id}>
            <Avatar name={message.username} url={message.avatarUrl}/>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="message-meta">{message.username}<time className="message-time" dateTime={message.createdAt}>{formatTime(message.createdAt)}</time></div>
              {message.replyToId && <div className="muted" style={{ fontSize: 11 }}>↳ resposta a uma mensagem</div>}
              <div className="message-body">{message.pinnedAt && <span className="pinned-label">Fixada · </span>}{message.body}</div>
              {message.delivery === 'sending' && <span className="muted" style={{ fontSize: 11 }}>A enviar…</span>}
              {message.delivery === 'failed' && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ fontSize: 11, color: 'var(--danger)' }}>Falhou enviar</span><button className="text-button" onClick={() => void sendMessage(message.body, message.clientMessageId)}>Tentar novamente</button></div>}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {!message.delivery && <button className="text-button" style={{ fontSize: 11 }} onClick={() => setReply(message)}>Responder</button>}
                {!message.delivery && <MessageActions message={message} own={message.authorId === user.id} canModerate={['owner', 'admin', 'moderator'].includes(details?.myRole ?? '')} onDelete={() => void deleteMessage(message)} onPin={() => void togglePin(message)}/>} 
              </div>
            </div>
          </article>)}
        </div>
        <div className="composer-wrap">
          {reply && <div className="muted" style={{ maxWidth: 850, margin: '0 auto 6px', fontSize: 12 }}>A responder a {reply.username}: {reply.body.slice(0, 60)} <button className="text-button" onClick={() => setReply(null)}>Cancelar</button></div>}
          <form className="composer" onSubmit={(event) => { event.preventDefault(); const value = draft.trim(); if (!value) return; setDraft(''); void sendMessage(value); }}>
            <input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={2000} placeholder={`Mensagem em #${channel.name} · usa @nome para mencionar`} aria-label="Escrever mensagem"/>
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
    {modal === 'community' && <CommunityModal busy={busy} onClose={() => setModal(null)} onCreate={(data) => void createCommunity(data)}/>}
    {modal === 'channel' && <ChannelModal busy={busy} onClose={() => setModal(null)} onCreate={(data) => void createChannel(data)}/>}
    {modal === 'profile' && <ProfileModal user={user} busy={profileBusy} onClose={() => setModal(null)} onSave={(data) => void updateProfile(data)}/>}
    {modal === 'account' && <AccountModal user={user} onClose={() => setModal(null)} onEditProfile={() => setModal('profile')}/>}
    <PrivateCallDock target={callTarget} onClearTarget={() => setCallTarget(null)} notify={notify}/>
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

function MessageActions({ message, own, canModerate, onDelete, onPin }: { message: Message; own: boolean; canModerate: boolean; onDelete: () => void; onPin: () => void }) {
  const [open, setOpen] = useState(false);
  if (!own && !canModerate) return null;
  return <span className="context-menu-wrap"><button className="text-button context-trigger" aria-label="Ações da mensagem" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>⋯</button>{open && <span className="context-menu" role="menu">
    {canModerate && <button role="menuitem" onClick={() => { setOpen(false); onPin(); }}>{message.pinnedAt ? 'Desafixar' : 'Fixar'}</button>}
    {(own || canModerate) && <button role="menuitem" className="danger-text" onClick={() => { setOpen(false); onDelete(); }}>Apagar</button>}
  </span>}</span>;
}

function MemberActions({ member, onAction, onCall }: { member: Member; onAction: (action: 'mute' | 'unmute' | 'ban' | 'kick', duration?: number) => void; onCall: () => void }) {
  const [open, setOpen] = useState(false);
  return <span className="context-menu-wrap"><button className="member-remove" aria-label={`Ações de ${member.username}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>⋯</button>{open && <span className="context-menu member-context-menu" role="menu">
    {member.mutedUntil ? <button role="menuitem" onClick={() => { setOpen(false); onAction('unmute'); }}>Remover silêncio</button> : <><button role="menuitem" onClick={() => { setOpen(false); onAction('mute', 5); }}>Silenciar · 5 min</button><button role="menuitem" onClick={() => { setOpen(false); onAction('mute', 60); }}>Silenciar · 1 hora</button></>}
    <button role="menuitem" onClick={() => { setOpen(false); onCall(); }}>Chamada de voz</button><button role="menuitem" onClick={() => { setOpen(false); onAction('kick'); }}>Expulsar</button><button role="menuitem" className="danger-text" onClick={() => { setOpen(false); onAction('ban'); }}>Banir</button>
  </span>}</span>;
}

function PrivateCallDock({ target, onClearTarget, notify }: { target: Member | null; onClearTarget: () => void; notify: (text: string) => void }) {
  const [call, setCall] = useState<PrivateCall | null>(null); const [error, setError] = useState(''); const [connecting, setConnecting] = useState(false); const [micOn, setMicOn] = useState(true); const roomRef = useRef<Room | null>(null); const connectedCall = useRef<string | null>(null);
  const statusLabels: Record<PrivateCallStatus, string> = { initiated: 'Iniciada', ringing: 'A tocar', accepted: 'Aceite', connecting: 'A ligar', in_progress: 'Em curso', rejected: 'Recusada', timeout: 'Sem resposta', failed: 'Falhada', ended: 'Terminada' };
  useEffect(() => {
    const socket = io({ withCredentials: true, transports: ['websocket', 'polling'] });
    socket.on('call:incoming', (event: { callId: string; caller: { id: string; username: string; avatarUrl: string | null }; status: PrivateCallStatus }) => setCall({ id: event.callId, status: event.status, peer: event.caller }));
    socket.on('call:status', (event: { callId: string; status: PrivateCallStatus }) => setCall((current) => current?.id === event.callId ? { ...current, status: event.status } : current));
    return () => { socket.disconnect(); };
  }, []);
  useEffect(() => {
    if (!target || call) return;
    setError(''); setCall({ id: '', status: 'initiated', peer: { id: target.id, username: target.username, avatarUrl: target.avatarUrl } });
    void api<{ call: { id: string; status: PrivateCallStatus; peer: PrivateCall['peer'] } }>('/calls', { method: 'POST', body: JSON.stringify({ calleeId: target.id }) }).then((result) => setCall({ id: result.call.id, status: result.call.status, peer: result.call.peer })).catch((cause) => { setCall({ id: '', status: 'failed', peer: { id: target.id, username: target.username, avatarUrl: target.avatarUrl } }); setError(cause instanceof Error ? cause.message : 'Não foi possível iniciar a chamada.'); }).finally(onClearTarget);
  }, [target, call, onClearTarget]);
  const update = async (status: 'accepted' | 'rejected' | 'timeout' | 'ended') => { if (!call?.id) return; try { await api(`/calls/${call.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); setCall((current) => current ? { ...current, status } : current); if (status !== 'accepted') { await roomRef.current?.disconnect(); roomRef.current = null; } } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível atualizar a chamada.'); } };
  useEffect(() => {
    if (!call || call.status !== 'accepted' || connectedCall.current === call.id) return;
    connectedCall.current = call.id; setConnecting(true); setError(''); setCall((current) => current ? { ...current, status: 'connecting' } : current);
    void api<{ token: string; serverUrl: string }>(`/calls/${call.id}/token`, { method: 'POST', body: '{}' }).then(async (credentials) => { const { Room: LiveKitRoom, RoomEvent } = await import('livekit-client'); const room = new LiveKitRoom({ adaptiveStream: true, dynacast: true }); roomRef.current = room; room.on(RoomEvent.Disconnected, () => { roomRef.current = null; setCall((current) => current ? { ...current, status: 'ended' } : current); }); await room.connect(credentials.serverUrl, credentials.token); await room.localParticipant.setMicrophoneEnabled(true); setMicOn(true); setCall((current) => current ? { ...current, status: 'in_progress' } : current); }).catch((cause) => { connectedCall.current = null; setCall((current) => current ? { ...current, status: 'failed' } : current); setError(cause instanceof Error ? cause.message : 'Falha ao ligar o áudio.'); }).finally(() => setConnecting(false));
  }, [call]);
  if (!call) return null;
  const close = async () => { await roomRef.current?.disconnect(); roomRef.current = null; if (call.id && !['ended', 'rejected', 'timeout', 'failed'].includes(call.status)) await update('ended'); else setCall(null); };
  return <aside className="call-dock" role="dialog" aria-label="Chamada privada"><div className="call-dock-header"><Avatar name={call.peer?.username ?? 'Utilizador'} url={call.peer?.avatarUrl} size={38}/><div><strong>Chamada com {call.peer?.username ?? 'utilizador'}</strong><span className="muted">{statusLabels[call.status]}{connecting ? '…' : ''}</span></div></div>{error && <p className="error-banner">{error}</p>}{call.status === 'ringing' && <div className="call-actions"><button className="primary" onClick={() => void update('accepted')}>Aceitar</button><button className="secondary" onClick={() => void update('rejected')}>Recusar</button></div>}{call.status === 'in_progress' && <div className="call-actions"><button className="secondary" onClick={() => { const room = roomRef.current; if (!room) return; void room.localParticipant.setMicrophoneEnabled(!micOn); setMicOn((value) => !value); }}>{micOn ? 'Silenciar' : 'Ativar microfone'}</button><button className="danger-button" onClick={() => void close()}>Terminar</button></div>}{['failed', 'ended', 'rejected', 'timeout'].includes(call.status) && <button className="secondary" onClick={() => setCall(null)}>Fechar</button>}</aside>;
}

function AdminModal({ details, onClose, onSaved }: { details: CommunityDetails; onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(''); const form = new FormData(event.currentTarget);
    try { await api(`/communities/${details.community.id}`, { method: 'PATCH', body: JSON.stringify({ name: String(form.get('name')), description: String(form.get('description')), category: String(form.get('category')), rules: String(form.get('rules')) }) }); onSaved(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível guardar.'); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal admin-modal" role="dialog" aria-modal="true" aria-labelledby="admin-title"><h2 id="admin-title">⚙ Administração</h2><p className="muted" style={{ fontSize: 13 }}>Configura a comunidade. As ações de membros e canais continuam protegidas no servidor.</p>{error && <p className="error-banner">{error}</p>}<form onSubmit={(event) => void save(event)}><label className="field">Nome<input name="name" defaultValue={details.community.name} required/></label><label className="field">Descrição<textarea name="description" defaultValue={details.community.description} rows={3}/></label><label className="field">Categoria<input name="category" defaultValue={details.community.category} required/></label><label className="field">Regras<textarea name="rules" defaultValue={details.community.rules ?? ''} rows={4} placeholder="Regras da comunidade"/></label><div className="admin-summary"><strong>Gestão</strong><span>{details.members.length} membros · {details.channels.length} canais</span><span>Funções: proprietário, administrador, moderador e membro</span><span>Auditoria e moderação estão protegidas por permissões do backend.</span></div><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary" disabled={busy}>{busy ? 'A guardar…' : 'Guardar alterações'}</button></div></form></section></div>;
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
        <label className="field">Tipo<select name="kind"><option value="text">Texto</option><option value="voice">Voz (LiveKit)</option></select></label>
        <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary" disabled={busy}>{busy ? 'A criar…' : 'Criar canal'}</button></div>
      </form>
    </section>
  </div>;
}

function ProfileModal({ user, busy, onClose, onSave }: {
  user: User; busy: boolean; onClose: () => void; onSave: (data: { username?: string; avatarUrl?: string | null }) => void;
}) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="profile-title">
      <h2 id="profile-title">O teu perfil</h2>
      <form onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const avatar = String(form.get('avatarUrl') ?? '').trim(); onSave({ username: String(form.get('username') ?? '').trim(), avatarUrl: avatar || null }); }}>
        <label className="field">Nome de utilizador<input name="username" minLength={3} maxLength={32} pattern="[\p{L}\p{N}_-]+" defaultValue={user.username} required/></label>
        <label className="field">Foto de perfil (link da imagem)<input name="avatarUrl" type="url" maxLength={500} defaultValue={user.avatarUrl ?? ''} placeholder="https://…"/></label>
        <p className="muted" style={{ fontSize: 12 }}>Cola o link de uma imagem. Se deixares vazio, usamos a inicial do teu nome.</p>
        <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary" disabled={busy}>{busy ? 'A guardar…' : 'Guardar perfil'}</button></div>
      </form>
    </section>
  </div>;
}

function AccountModal({ user, onClose, onEditProfile }: { user: User; onClose: () => void; onEditProfile: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
      <div className="account-modal-heading"><Avatar name={user.username} url={user.avatarUrl} size={42}/><div><h2 id="account-title">A tua conta</h2><p className="muted" style={{ margin: 0 }}>@{user.username}</p></div></div>
      <div className="account-tabs" role="tablist" aria-label="Área da conta"><button className="account-tab active" role="tab" aria-selected="true">Conta</button><button className="account-tab" role="tab" aria-selected="false" disabled>Planos</button></div>
      <div className="account-section"><strong>Planos e funcionalidades</strong><p className="muted">A área de planos está preparada para uma futura implementação de subscrições. Nenhum plano pago está ativo nesta versão.</p><span className="account-status">Em preparação</span></div>
      <div className="account-section"><strong>Perfil</strong><p className="muted">Atualiza o teu nome de utilizador e avatar sem sair da sessão.</p><button className="secondary" onClick={onEditProfile}>Editar perfil</button></div>
      <div className="modal-actions"><button className="primary" onClick={onClose}>Fechar</button></div>
    </section>
  </div>;
}

function VoicePanel({ channel, notify }: { channel: Channel; notify: (text: string) => void }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [participants, setParticipants] = useState<string[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [error, setError] = useState('');
  const active = useRef<Room | null>(null);
  const refresh = useCallback((current: Room) => {
    setParticipants([current.localParticipant.identity, ...Array.from(current.remoteParticipants.values()).map((participant: RemoteParticipant) => participant.identity)]);
  }, []);
  const disconnect = useCallback(async () => {
    if (!active.current) return;
    const current = active.current;
    active.current = null;
    await current.disconnect();
    for (const element of document.querySelectorAll('audio[data-mavuno="voice"]')) element.remove();
    setRoom(null); setParticipants([]); setMicOn(true);
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
      next.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const element = track.attach(); element.dataset.mavuno = 'voice'; document.body.appendChild(element);
        }
      });
      next.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((element) => element.remove()));
      next.on(RoomEvent.Disconnected, () => { setRoom(null); setParticipants([]); active.current = null; });
      await next.connect(credentials.serverUrl, credentials.token);
      active.current = next;
      setRoom(next);
      await next.localParticipant.setMicrophoneEnabled(true);
      setMicOn(true);
      refresh(next);
    } catch (cause) {
      if (next) await next.disconnect().catch(() => undefined);
      active.current = null;
      const message = cause instanceof Error ? cause.message : 'Não foi possível entrar na sala.';
      setError(message); notify(message);
    } finally { setConnecting(false); }
  };
  const toggleMic = async () => {
    if (!room) return;
    try { await room.localParticipant.setMicrophoneEnabled(!micOn); setMicOn((value) => !value); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível alterar o microfone.'); }
  };

  return <section className="welcome-panel" style={{ marginTop: 0 }}>
    <span className="brand-mark">◖</span><h2>Sala de voz · {channel.name}</h2>
    <p className="muted">Áudio em tempo real através do LiveKit. Só mostramos participantes após uma autorização e conexão reais.</p>
    <div className="community-card" style={{ marginTop: 18 }}><strong>Participantes ligados · {participants.length}</strong>
      {participants.length === 0 ? <p className="muted">Ainda ninguém está ligado.</p> : participants.map((person) => <div className="member-row" key={person}><span className="online-dot"/>{person}{person === room?.localParticipant.identity ? ' (tu)' : ''}</div>)}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        {!room ? <button className="primary" disabled={connecting} onClick={() => void join()}>{connecting ? 'A ligar…' : 'Entrar na sala'}</button> : <><button className="secondary" onClick={() => void toggleMic()}>{micOn ? 'Silenciar microfone' : 'Ativar microfone'}</button><button className="danger-button" onClick={() => void disconnect()}>Sair da sala</button></>}
      </div>
      {error && <p className="error-banner" role="alert">{error}</p>}
    </div>
  </section>;
}
