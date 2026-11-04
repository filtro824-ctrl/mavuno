import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, type Message } from './api';
import { ActionMenuOverlay, MessageRow, type ActionMenuTarget, rectFor } from './message-actions';
import { EMOJI_CATEGORIES } from './emoji-data';
import { BUILTIN_EMOJIS, BUILTIN_STICKERS } from '../server/builtin-assets';

type Peer = { id: string; username: string; avatarUrl?: string | null };
type Conversation = { id: string; other: Peer; lastMessageAt: string | null; lastMessage: null | { body: string; builtinStickerKey?: string | null; createdAt: string | null }; unreadCount: number };
type ServerMessage = { id: string; conversationId: string; clientMessageId: string; body: string; replyToId: string | null; replyTo?: { author: { username: string } | null; body: string } | null; builtinStickerKey?: string | null; createdAt: string; author: Peer; deleted?: boolean; delivery?: 'sending' | 'failed' };
type Page = { messages: ServerMessage[]; hasMore: boolean; nextCursor: string | null };
type Pending = { body: string; sticker: string | null; replyToId: string | null; conversationId: string; failed?: boolean };
const avatar = (peer: Peer, size = 40) => <span className="avatar" style={{ width: size, height: size, flex: `0 0 ${size}px` }}>{peer.avatarUrl ? <img src={peer.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer"/> : peer.username.slice(0, 1).toUpperCase() || '?'}</span>;
const asMessage = (row: ServerMessage): Message => ({ id: row.id, clientMessageId: row.clientMessageId, body: row.body, replyToId: row.replyToId, replyAuthor: row.replyTo?.author?.username ?? null, replyBody: row.replyTo?.body ?? null, createdAt: row.createdAt, authorId: row.author.id, username: row.author.username, avatarUrl: row.author.avatarUrl, delivery: row.delivery });

export function DirectMessagesView({ currentUserId, onCall, onProfile, notify }: { currentUserId: string; onCall(peer: Peer): void; onProfile(userId: string): void; notify(message: string): void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ServerMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [sticker, setSticker] = useState<string | null>(null);
  const [reply, setReply] = useState<Message | null>(null);
  const [picker, setPicker] = useState<'emoji' | 'sticker' | null>(null);
  const [emojiTab, setEmojiTab] = useState<'unicode' | 'mavuno'>('unicode');
  const [emojiCategory, setEmojiCategory] = useState('rostos');
  const [menu, setMenu] = useState<ActionMenuTarget | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const pendingRef = useRef<Map<string, Pending>>(new Map());
  const confirmedRef = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(true);
  const historyLoadingRef = useRef(new Set<string>());
  const nearBottomRef = useRef(true);
  const preserveScrollRef = useRef<{ height: number; top: number } | null>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  const selectedRef = useRef(selected); selectedRef.current = selected;

  const refreshInbox = useCallback(async () => { try { const data = await api<{ conversations: Conversation[] }>('/dm/conversations'); setConversations(data.conversations); } catch (error) { notify(error instanceof Error ? error.message : 'Não foi possível carregar as conversas.'); } }, [notify]);
  const loadHistory = useCallback(async (id: string, before?: string, append = false) => {
    if (historyLoadingRef.current.has(id)) return;
    historyLoadingRef.current.add(id); setLoading(true);
    if (append && listRef.current) preserveScrollRef.current = { height: listRef.current.scrollHeight, top: listRef.current.scrollTop };
    try { const path = `/dm/conversations/${encodeURIComponent(id)}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`; const data = await api<Page>(path); if (selectedRef.current?.id !== id) return; const deliveredIds = new Set(data.messages.map((message) => message.clientMessageId)); for (const clientMessageId of deliveredIds) pendingRef.current.delete(clientMessageId); const failed: ServerMessage[] = [...pendingRef.current.entries()].filter(([clientMessageId, pending]) => pending.conversationId === id && pending.failed && !deliveredIds.has(clientMessageId)).map(([clientMessageId, pending]) => ({ id: clientMessageId, conversationId: id, clientMessageId, body: pending.body, replyToId: pending.replyToId, createdAt: new Date().toISOString(), author: { id: currentUserId, username: 'Tu' }, builtinStickerKey: pending.sticker, delivery: 'failed' })); setMessages((old) => append ? [...data.messages, ...old.filter((m) => !data.messages.some((n) => n.id === m.id))] : [...data.messages, ...failed]); setHasMore(data.hasMore); setNextCursor(data.nextCursor); }
    catch (error) { preserveScrollRef.current = null; notify(error instanceof Error ? error.message : 'Não foi possível carregar as mensagens.'); }
    finally { historyLoadingRef.current.delete(id); setLoading(historyLoadingRef.current.size > 0); }
  }, [currentUserId, notify]);
  const markRead = useCallback(async (id: string) => { if (!visibleRef.current || document.visibilityState !== 'visible') return; try { await api(`/dm/conversations/${encodeURIComponent(id)}/read`, { method: 'POST', body: '{}' }); } catch { /* será novamente tentado ao voltar a ficar visível */ } }, []);
  useEffect(() => { void refreshInbox(); }, [refreshInbox]);
  useEffect(() => {
    const socket = io({ withCredentials: true, reconnection: true, transports: ['websocket', 'polling'] });
    const recover = () => { void refreshInbox(); if (selected) void loadHistory(selected.id); };
    const onNew = (row: ServerMessage) => { confirmedRef.current.add(row.clientMessageId); pendingRef.current.delete(row.clientMessageId); void refreshInbox(); if (selected?.id === row.conversationId) { setMessages((old) => [...old.filter((m) => m.id !== row.id && m.clientMessageId !== row.clientMessageId), row]); if (visibleRef.current && document.visibilityState === 'visible' && row.author.id !== currentUserId) void markRead(row.conversationId); } };
    const onDeleted = (event: { id: string; conversationId: string }) => { setMessages((old) => old.map((m) => m.id === event.id ? { ...m, body: 'Mensagem apagada', deleted: true, builtinStickerKey: null } : m)); void refreshInbox(); };
    const onRead = () => { void refreshInbox(); };
    socket.on('connect', recover); socket.on('dm:message:new', onNew); socket.on('dm:message:deleted', onDeleted); socket.on('dm:read', onRead);
    return () => { socket.off('connect', recover); socket.off('dm:message:new', onNew); socket.off('dm:message:deleted', onDeleted); socket.off('dm:read', onRead); socket.disconnect(); };
  }, [currentUserId, loadHistory, markRead, refreshInbox, selected]);
  useEffect(() => { const change = () => { visibleRef.current = document.visibilityState === 'visible'; if (visibleRef.current && selected) void markRead(selected.id); }; document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change); }, [markRead, selected]);
  useEffect(() => { if (selected) { void loadHistory(selected.id); if (document.visibilityState === 'visible') void markRead(selected.id); } else { setMessages([]); } }, [selected?.id, loadHistory, markRead]);
  useEffect(() => { const element = listRef.current; if (!element) return; const previous = preserveScrollRef.current; if (previous) { element.scrollTop = previous.top + (element.scrollHeight - previous.height); preserveScrollRef.current = null; } else if (nearBottomRef.current) element.scrollTo({ top: element.scrollHeight }); }, [messages.length, selected?.id]);

  const openPeer = async (peerId: string) => { try { const data = await api<{ conversation: { id: string; other: Peer } }>(`/dm/conversations/${encodeURIComponent(peerId)}/open`, { method: 'POST', body: '{}' }); const convo: Conversation = { id: data.conversation.id, other: data.conversation.other, lastMessageAt: null, lastMessage: null, unreadCount: 0 }; setConversations((old) => [convo, ...old.filter((item) => item.id !== convo.id)]); preserveScrollRef.current = null; setMessages([]); setSelected(convo); setDraft(''); setSticker(null); setReply(null); } catch (error) { notify(error instanceof Error ? error.message : 'Não foi possível abrir a conversa.'); } };
  const choose = (conversation: Conversation) => { preserveScrollRef.current = null; setMessages([]); setSelected(conversation); setDraft(''); setSticker(null); setReply(null); };
  const send = async (retryId?: string) => {
    if (!selected || sending) return;
    const clientMessageId = retryId ?? crypto.randomUUID();
    const conversationId = selected.id;
    const pending = pendingRef.current.get(clientMessageId) ?? { body: draft, sticker, replyToId: reply?.id ?? null, conversationId };
    if (!pending.body.trim() && !pending.sticker) return;
    pendingRef.current.set(clientMessageId, pending); setSending(true);
    const optimistic: ServerMessage = { id: clientMessageId, conversationId, clientMessageId, body: pending.body, replyToId: pending.replyToId, createdAt: new Date().toISOString(), author: { id: currentUserId, username: 'Tu' }, builtinStickerKey: pending.sticker, delivery: 'sending' };
    setMessages((old) => old.some((m) => m.clientMessageId === clientMessageId) ? old : [...old, optimistic]);
    try {
      const data = await api<{ message: ServerMessage }>(`/dm/conversations/${encodeURIComponent(conversationId)}/messages`, { method: 'POST', body: JSON.stringify({ clientMessageId, body: pending.body, replyToId: pending.replyToId, builtinStickerKey: pending.sticker }) });
      if (selectedRef.current?.id === conversationId) setMessages((old) => [...old.filter((m) => m.clientMessageId !== clientMessageId && m.id !== data.message.id), data.message]); pendingRef.current.delete(clientMessageId); confirmedRef.current.delete(clientMessageId);
      if (selectedRef.current?.id === conversationId) { if (draftRef.current === pending.body) setDraft(''); setSticker((old) => old === pending.sticker ? null : old); if (reply?.id === pending.replyToId) setReply(null); } void refreshInbox();
    } catch (error) { if (confirmedRef.current.delete(clientMessageId)) { pendingRef.current.delete(clientMessageId); void refreshInbox(); } else { pendingRef.current.set(clientMessageId, { ...pending, failed: true }); if (selectedRef.current?.id === conversationId) setMessages((old) => old.map((m) => m.clientMessageId === clientMessageId ? { ...m, body: pending.body, builtinStickerKey: pending.sticker, delivery: 'failed' } : m)); notify(error instanceof Error ? error.message : 'Não foi possível enviar a mensagem.'); } }
    finally { setSending(false); }
  };
  const messageRows = useMemo(() => messages.map(asMessage), [messages]);
  const renderBody = (row: ServerMessage) => <>{row.body.split(/(<:builtin:[a-z0-9_-]+>)/gi).map((part, i) => { const match = part.match(/^<:builtin:([a-z0-9_-]+)>$/i); return match ? <img key={i} src={`/emojis/mavuno/${encodeURIComponent(match[1])}.png`} alt={`:${match[1]}:`} title={match[1]} style={{ width: 24, height: 24, verticalAlign: 'middle', objectFit: 'contain' }}/> : part; })}{row.builtinStickerKey && !row.deleted && <div><img src={`/stickers/mavuno/${encodeURIComponent(row.builtinStickerKey)}.png`} alt="Sticker" style={{ maxWidth: 160, maxHeight: 160, objectFit: 'contain' }}/></div>}</>;
  const deleteMessage = async (message: Message) => { try { await api(`/dm/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' }); setMessages((old) => old.map((m) => m.id === message.id ? { ...m, body: 'Mensagem apagada', deleted: true, builtinStickerKey: null } : m)); void refreshInbox(); } catch (error) { notify(error instanceof Error ? error.message : 'Não foi possível apagar a mensagem.'); } };
  return <div className={`dm-view${selected ? ' has-selected' : ''}`} style={{ display: 'flex', minWidth: 0, width: '100%', height: 'auto', minHeight: 0, flex: 1, overflow: 'hidden' }}>
    <aside className="dm-inbox" style={{ width: selected ? 'min(320px, 36%)' : '100%', minWidth: selected ? 0 : undefined, overflowY: 'auto', flex: selected ? '0 1 320px' : '1 1 auto' }} aria-label="Conversas">
      {conversations.length === 0 ? <p style={{ padding: 20 }}>Ainda não tens conversas. Abre o perfil de alguém e toca em Mensagem.</p> : conversations.map((conversation) => <button key={conversation.id} type="button" className={`dm-conversation${selected?.id === conversation.id ? ' active' : ''}`} onClick={() => choose(conversation)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minWidth: 0, textAlign: 'left' }}>
        {avatar(conversation.other, 42)}<span style={{ display: 'block', minWidth: 0, flex: 1 }}><strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conversation.other.username}</strong><span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conversation.lastMessage?.builtinStickerKey ? 'Sticker' : conversation.lastMessage?.body ?? ''}</span></span>{conversation.lastMessageAt && <time>{new Intl.DateTimeFormat('pt-MZ', { hour: '2-digit', minute: '2-digit' }).format(new Date(conversation.lastMessageAt))}</time>}{conversation.unreadCount > 0 && <span className="dm-unread-badge">{conversation.unreadCount}</span>}
      </button>)}
    </aside>
    {selected && <section className="dm-conversation-panel" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, overflow: 'hidden' }}>
      <header className="dm-header" style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}><button type="button" className="dm-back" onClick={() => setSelected(null)}>Voltar</button><button className="profile-avatar-button" onClick={() => onProfile(selected.other.id)}>{avatar(selected.other, 38)}</button><button className="profile-name-link" onClick={() => onProfile(selected.other.id)}>{selected.other.username}</button><button type="button" className="dm-call" aria-label="Chamada privada" onClick={() => onCall(selected.other)}>Chamada</button></header>
      <div className="dm-message-list" ref={listRef} onScroll={(event) => { const element = event.currentTarget; nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;  }} style={{ overflowY: 'auto', overflowX: 'hidden', minWidth: 0, flex: 1 }}>{hasMore && <button type="button" disabled={loading} onClick={() => nextCursor && void loadHistory(selected.id, nextCursor, true)}>{loading ? 'A carregar…' : 'Carregar mensagens anteriores'}</button>}{messageRows.map((message, index) => { const raw = messages.find((row) => row.id === message.id || row.clientMessageId === message.clientMessageId)!; return <MessageRow key={message.clientMessageId || message.id} message={message} own={message.authorId === currentUserId} grouped={index > 0 && messageRows[index - 1].authorId === message.authorId} renderBody={renderBody(raw)} onProfile={() => onProfile(message.authorId)} onReply={() => setReply(message)} onRetry={() => void send(message.clientMessageId)} onQuickReaction={() => {}} onOpenMenu={(rect) => setMenu({ kind: 'message', message, rect })}/>; })}</div>
      {reply && <div className="dm-reply-composer"><span>A responder a {reply.username}: {reply.body.slice(0, 100)}</span><button type="button" onClick={() => setReply(null)}>×</button></div>}
      {sticker && <div className="dm-sticker-preview"><img src={`/stickers/mavuno/${sticker}.png`} alt="Sticker selecionado" width="48" height="48"/><button type="button" onClick={() => setSticker(null)}>Remover</button></div>}
      <form className="dm-composer" onSubmit={(event) => { event.preventDefault(); void send(); }} style={{ display: 'flex', gap: 6, minWidth: 0 }}><button type="button" aria-label="Emoji" onClick={() => setPicker(picker === 'emoji' ? null : 'emoji')}>☺</button><button type="button" aria-label="Stickers" onClick={() => setPicker(picker === 'sticker' ? null : 'sticker')}>▣</button><textarea value={draft} maxLength={2000} rows={1} placeholder="Escreve uma mensagem…" onChange={(event) => setDraft(event.target.value)} style={{ minWidth: 0, flex: 1, resize: 'vertical' }}/><button type="submit" disabled={sending || (!draft.trim() && !sticker)}>{sending ? 'A enviar…' : 'Enviar'}</button></form>
      {picker && <div className="dm-picker" role="dialog" aria-modal="true" aria-label={picker === 'emoji' ? 'Escolher emoji' : 'Escolher sticker'}><button type="button" onClick={() => setPicker(null)}>Fechar</button>{picker === 'emoji' ? <><nav><button type="button" onClick={() => setEmojiTab('unicode')}>Unicode</button><button type="button" onClick={() => setEmojiTab('mavuno')}>Mavuno</button></nav>{emojiTab === 'unicode' ? <><div>{EMOJI_CATEGORIES.filter((category) => category.items.length).map((category) => <button key={category.id} type="button" onClick={() => setEmojiCategory(category.id)}>{category.label}</button>)}</div><div className="dm-picker-grid">{EMOJI_CATEGORIES.find((category) => category.id === emojiCategory)?.items.map((item) => <button key={item.emoji} type="button" title={item.name} onClick={() => { setDraft((old) => `${old}${item.emoji}`); setPicker(null); }}>{item.emoji}</button>)}</div></> : <div className="dm-picker-grid">{BUILTIN_EMOJIS.map((item) => <button key={item.key} type="button" title={item.label} onClick={() => { setDraft((old) => `${old}<:builtin:${item.key}>`); setPicker(null); }}><img src={`/emojis/mavuno/${item.key}.png`} alt={item.label} width="28" height="28"/></button>)}</div>}</> : <div className="dm-picker-grid">{BUILTIN_STICKERS.map((item) => <button key={item.key} type="button" title={item.label} onClick={() => { setSticker(item.key); setPicker(null); }}><img src={`/stickers/mavuno/${item.key}.png`} alt={item.label} width="60" height="60"/></button>)}</div>}</div>}
    </section>}
    {menu?.kind === 'message' && <ActionMenuOverlay target={menu} mode="direct" actorId={currentUserId} actorRole={null} actorPermissions={[]} onClose={() => setMenu(null)} onReply={(message) => setReply(message)} onDelete={deleteMessage} onDownload={() => {}} onPin={() => {}} onQuickReaction={() => {}} onMoreReactions={() => {}} onProfile={onProfile} onCall={(member) => onCall({ id: member.id, username: member.username, avatarUrl: member.avatarUrl })} onModerate={() => {}} onUnmute={() => {}} onKick={() => {}} notify={notify}/>}
  </div>;
}
