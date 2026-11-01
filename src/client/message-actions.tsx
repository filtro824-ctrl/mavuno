import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Member, Message, ReactionSummary } from './api';

type DurationUnit = 'minutes' | 'hours' | 'days';
export type DurationChoice = { amount: number; unit: DurationUnit } | null;
export type MenuRect = { top: number; right: number; bottom: number; left: number; width: number; height: number; touch?: boolean };
export type ActionMenuTarget = { kind: 'message'; message: Message; rect: MenuRect } | { kind: 'member'; member: Member; rect: MenuRect };
export function rectFor(rect: DOMRect, touch = false): MenuRect { return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height, touch }; }

function durationText(duration: DurationChoice): string {
  if (!duration) return 'permanentemente';
  const unit = duration.unit === 'minutes' ? (duration.amount === 1 ? 'minuto' : 'minutos') : duration.unit === 'hours' ? (duration.amount === 1 ? 'hora' : 'horas') : (duration.amount === 1 ? 'dia' : 'dias');
  return `${duration.amount} ${unit}`;
}
const ranks: Record<string, number> = { owner: 100, admin: 80, moderator: 50, member: 10 };
const can = (permissions: string[], permission: string) => permissions.includes(permission);
const canAct = (actor: string | null, target?: Member) => Boolean(target && target.role !== 'owner' && (ranks[actor ?? ''] ?? 0) > (ranks[target.role] ?? 0));

export function MessageRow({ message, grouped, own, children, onOpenMenu, onProfile, onReply, onRetry, onQuickReaction }: {
  message: Message; grouped: boolean; own: boolean; children?: ReactNode;
  onOpenMenu: (rect: MenuRect) => void; onProfile: () => void; onReply: () => void; onRetry: () => void;
  onQuickReaction: (emoji: string) => void;
}) {
  const press = useRef<{ pointerId: number; x: number; y: number; timer: number } | null>(null);
  const rowRef = useRef<HTMLElement | null>(null);
  const clearPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    document.body.classList.remove('message-pressing');
  };
  const open = (element: HTMLElement) => { clearPress(); onOpenMenu(rectFor((rowRef.current ?? element).getBoundingClientRect())); };
  useEffect(() => () => clearPress(), []);
  return <article ref={rowRef} className={`message ${grouped ? 'message-grouped' : ''}`} tabIndex={0} aria-label={`Mensagem de ${message.username}: ${message.body}`} onPointerDown={(event) => {
    if (event.pointerType === 'mouse' || event.button !== 0) return;
    clearPress(); document.body.classList.add('message-pressing');
    const element = event.currentTarget;
    const timer = window.setTimeout(() => {
      press.current = null; document.body.classList.remove('message-pressing');
      try { navigator.vibrate?.(12); } catch { /* vibração opcional */ }
      onOpenMenu(rectFor(element.getBoundingClientRect(), true));
    }, 500);
    press.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer };
  }} onPointerMove={(event) => {
    const start = press.current;
    if (start && start.pointerId === event.pointerId && (Math.abs(event.clientX - start.x) > 10 || Math.abs(event.clientY - start.y) > 10)) clearPress();
  }} onPointerUp={clearPress} onPointerCancel={clearPress} onPointerLeave={() => { if (press.current) clearPress(); }} onDragStart={(event) => event.preventDefault()} onContextMenu={(event) => { event.preventDefault(); open(event.currentTarget); }} onKeyDown={(event) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); open(event.currentTarget); }
  }}>
    <button className="profile-avatar-button message-avatar-button" aria-label={`Ver perfil de ${message.username}`} onClick={onProfile}><span className="avatar">{message.avatarUrl ? <img src={message.avatarUrl} alt="" referrerPolicy="no-referrer" loading="lazy"/> : message.username.trim().slice(0, 1).toUpperCase() || '?'}</span></button>
    <div className="message-content" style={{ minWidth: 0, flex: 1 }}>
      <div className="message-meta"><button className="profile-name-link" onClick={onProfile}>{message.username}</button><time className="message-time" dateTime={message.createdAt}>{new Intl.DateTimeFormat('pt-MZ', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt))}</time></div>
      {message.replyToId && <div className="reply-preview"><strong>{message.replyAuthor ?? 'Mensagem apagada'}</strong>{message.replyBody && <span>{message.replyBody.slice(0, 100)}</span>}</div>}
      <div className="message-body">{message.pinnedAt && <span className="pinned-label">Fixada · </span>}{message.body}</div>
      {children}
      {message.delivery === 'sending' && <span className="message-delivery">A enviar…</span>}
      {!message.delivery && own && <span className="message-delivery">Enviada</span>}
      {message.delivery === 'failed' && <div className="message-failed"><span>Falhou enviar</span><button className="text-button" onClick={onRetry}>Tentar novamente</button></div>}
    </div>
    {!message.delivery && <div className="message-action-bar" role="toolbar" aria-label={`Ações rápidas de ${message.username}`}>
      {['👍', '❤️', '😂'].map((emoji) => <button key={emoji} type="button" aria-label={`Reagir com ${emoji}`} onClick={() => onQuickReaction(emoji)}>{emoji}</button>)}
      <button type="button" className="message-reply-action" onClick={onReply}>Responder</button>
      <button type="button" className="message-more-action" aria-label="Mais opções da mensagem" onClick={(event) => open(event.currentTarget)}>⋯</button>
    </div>}
  </article>;
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    react: <><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/></>,
    reply: <><path d="m9 17-5-5 5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
    speak: <><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15 9a5 5 0 0 1 0 6M18 6a9 9 0 0 1 0 12"/></>,
    pin: <><path d="m16 3 5 5-4 1-4 4-1 4-2-2-4 4"/><path d="m8 8 8 8"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
    call: <><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7l.5 2.8a2 2 0 0 1-.6 1.8L7.7 9.6a16 16 0 0 0 6.7 6.7l1.3-1.3a2 2 0 0 1 1.8-.6l2.8.5a2 2 0 0 1 1.7 2z"/></>,
    mute: <><path d="M12 2v10M5 10a7 7 0 0 0 14 0M12 19v3M8 22h8"/></>,
    kick: <><path d="M10 17l5-5-5-5M15 12H3"/><path d="M21 19V5a2 2 0 0 0-2-2h-5"/></>,
    ban: <><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></>,
    trash: <><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
  };
  return <svg className="action-menu-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name] ?? paths.react}</svg>;
}
function MenuRow({ icon, children, danger, onClick }: { icon: string; children: ReactNode; danger?: boolean; onClick: () => void }) {
  return <button type="button" className={`action-menu-row ${danger ? 'danger-text' : ''}`} onClick={onClick}><Icon name={icon}/><span>{children}</span></button>;
}

export function ActionMenuOverlay({ target, actorId, actorRole, actorPermissions, targetMember, onClose, onReply, onDelete, onPin, onQuickReaction, onMoreReactions, onProfile, onCall, onModerate, onUnmute, onKick, notify }: {
  target: ActionMenuTarget; actorId: string; actorRole: string | null; actorPermissions: string[]; targetMember?: Member;
  onClose: () => void; onReply: (message: Message) => void; onDelete: (message: Message) => Promise<void> | void; onPin: (message: Message) => Promise<void> | void;
  onQuickReaction: (message: Message, emoji: string) => void; onMoreReactions: (message: Message) => void; onProfile: (userId: string) => void; onCall: (member: Member) => void;
  onModerate: (action: 'mute' | 'ban', member: Member) => void; onUnmute: (member: Member) => void; onKick: (member: Member) => Promise<void> | void; notify: (text: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const [mobileHighlightTop, setMobileHighlightTop] = useState<number | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const mobile = window.innerWidth <= 760 || Boolean(target.rect.touch);
  const message = target.kind === 'message' ? target.message : null;
  const member = target.kind === 'member' ? target.member : targetMember;
  const own = message?.authorId === actorId;
  const mayPin = Boolean(message && can(actorPermissions, 'pin_messages'));
  const mayDelete = Boolean(message && (own || can(actorPermissions, 'delete_messages')));
  const canTarget = canAct(actorRole, member);
  const mayMute = canTarget && can(actorPermissions, 'mute_members');
  const mayKick = canTarget && can(actorPermissions, 'kick_members');
  const mayBan = canTarget && can(actorPermissions, 'ban_members');
  useLayoutEffect(() => {
    if (mobile) {
      const placeHighlight = () => {
        const panel = menuRef.current?.getBoundingClientRect();
        const highlight = highlightRef.current?.getBoundingClientRect();
        if (!panel || !highlight) return;
        setMobileHighlightTop(Math.max(4, panel.top - highlight.height - 8));
      };
      placeHighlight(); window.addEventListener('resize', placeHighlight);
      return () => window.removeEventListener('resize', placeHighlight);
    }
    const place = () => {
      const menu = menuRef.current;
      if (!menu) return;
      const rect = target.rect;
      const width = Math.min(menu.getBoundingClientRect().width || 340, window.innerWidth - 24);
      const height = menu.getBoundingClientRect().height;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const useBelow = below >= height || below >= above;
      const maxHeight = Math.max(120, Math.min(height, useBelow ? below : above));
      const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
      const top = useBelow ? Math.min(rect.bottom + 8, window.innerHeight - maxHeight - 12) : Math.max(12, rect.top - maxHeight - 8);
      setPosition({ top, left, maxHeight });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [mobile, target]);
  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden';
    const focusFrame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousBodyOverflow; document.documentElement.style.overflow = previousHtmlOverflow;
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    };
  }, [onClose]);
  const run = (action: () => void) => { onClose(); action(); };
  const copyText = (text: string) => run(() => {
    if (!navigator.clipboard?.writeText) { notify('Não foi possível copiar o texto neste aparelho.'); return; }
    void navigator.clipboard.writeText(text).then(() => notify('Texto copiado.')).catch(() => notify('Não foi possível copiar o texto.'));
  });
  const toggleSpeech = (text: string) => {
    if (!('speechSynthesis' in window)) return;
    if (speaking) { window.speechSynthesis.cancel(); setSpeaking(false); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'pt-PT';
    utterance.onend = () => setSpeaking(false); utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance); setSpeaking(true);
  };
  const panelStyle = mobile ? undefined : position ? { position: 'fixed' as const, top: position.top, left: position.left, maxHeight: position.maxHeight, visibility: 'visible' as const } : { position: 'fixed' as const, top: -1000, left: -1000, visibility: 'hidden' as const };
  const highlightTop = mobile && mobileHighlightTop !== null ? mobileHighlightTop : Math.max(8, Math.min(target.rect.top, window.innerHeight - 118));
  return createPortal(<div className="action-overlay-root">
    <button type="button" className="action-overlay-backdrop" aria-label="Fechar menu" onClick={onClose}/>
    {message && <article ref={highlightRef} className="action-message-highlight" style={{ top: highlightTop, left: Math.max(8, target.rect.left), width: Math.min(target.rect.width, window.innerWidth - 16) }} aria-hidden="true"><strong>{message.username}</strong><time>{new Intl.DateTimeFormat('pt-MZ', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt))}</time><p>{message.pinnedAt && <span className="pinned-label">Fixada · </span>}{message.body}</p></article>}
    <section ref={menuRef} className={`action-menu-panel ${mobile ? 'mobile' : 'desktop'}`} style={panelStyle} role="dialog" aria-modal="true" aria-label={message ? 'Opções da mensagem' : `Ações de ${member?.username ?? 'membro'}`}>
      {mobile && <header className="action-menu-sheet-heading"><span className="action-menu-drag-handle"/><span>{message ? 'Mensagem' : member?.username}</span><button type="button" className="action-menu-close" aria-label="Fechar menu" onClick={onClose}>×</button></header>}
      {message && <div className="action-menu-group action-menu-reactions" role="group" aria-label="Reações rápidas">
        <div className="action-menu-reaction-row">{['👍', '❤️', '😂', '😮', '😢', '🙏'].map((emoji) => <button type="button" key={emoji} aria-label={`Reagir com ${emoji}`} onClick={() => run(() => onQuickReaction(message, emoji))}>{emoji}</button>)}</div>
        <MenuRow icon="plus" onClick={() => run(() => onMoreReactions(message))}>Adicionar reação</MenuRow>
      </div>}
      {message && <div className="action-menu-group"><h3>Mensagem</h3>
        {!message.delivery && <MenuRow icon="reply" onClick={() => run(() => onReply(message))}>Responder</MenuRow>}
        <MenuRow icon="copy" onClick={() => copyText(message.body)}>Copiar texto</MenuRow>
        {'speechSynthesis' in window && <MenuRow icon="speak" onClick={() => { if (speaking) { window.speechSynthesis.cancel(); setSpeaking(false); } else { toggleSpeech(message.body); } }}>{speaking ? 'Parar de falar' : 'Falar mensagem'}</MenuRow>}
        {mayPin && <MenuRow icon="pin" onClick={() => run(() => { void onPin(message); })}>{message.pinnedAt ? 'Desafixar' : 'Fixar'}</MenuRow>}
      </div>}
      {member && member.id !== actorId && <div className="action-menu-group"><h3>Membro</h3>
        <MenuRow icon="user" onClick={() => run(() => onProfile(member.id))}>Ver perfil</MenuRow>
        <MenuRow icon="call" onClick={() => run(() => onCall(member))}>Chamada privada</MenuRow>
      </div>}
      {member && (mayMute || mayKick || mayBan) && <div className="action-menu-group"><h3>Moderação</h3>
        {mayMute && <MenuRow icon="mute" onClick={() => run(() => onModerate('mute', member))}>Silenciar membro</MenuRow>}
        {mayMute && member.mutedUntil && <MenuRow icon="mute" onClick={() => run(() => onUnmute(member))}>Remover silêncio</MenuRow>}
        {mayKick && <MenuRow icon="kick" danger onClick={() => run(() => { void onKick(member); })}>Expulsar membro</MenuRow>}
        {mayBan && <MenuRow icon="ban" danger onClick={() => run(() => onModerate('ban', member))}>Banir membro</MenuRow>}
      </div>}
      {message && mayDelete && <div className="action-menu-group"><MenuRow icon="trash" danger onClick={() => run(() => { void onDelete(message); })}>Apagar mensagem</MenuRow></div>}
    </section>
  </div>, document.body);
}

export function ModerationPrompt({ action, member, onClose, onConfirm }: {
  action: 'mute' | 'ban'; member: Member; onClose: () => void; onConfirm: (duration: DurationChoice, reason: string) => Promise<void>;
}) {
  const isMute = action === 'mute';
  const [duration, setDuration] = useState<DurationChoice>(isMute ? { amount: 5, unit: 'minutes' } : { amount: 1, unit: 'hours' });
  const [custom, setCustom] = useState(false);
  const [amount, setAmount] = useState(isMute ? 5 : 1);
  const [unit, setUnit] = useState<DurationUnit>(isMute ? 'minutes' : 'hours');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const min = isMute ? 60 : 3600;
  const max = isMute ? 28 * 86400 : 365 * 86400;
  const seconds = duration ? duration.amount * (duration.unit === 'minutes' ? 60 : duration.unit === 'hours' ? 3600 : 86400) : null;
  const validCustom = Number.isInteger(amount) && amount > 0 && (() => { const value = amount * (unit === 'minutes' ? 60 : unit === 'hours' ? 3600 : 86400); return value >= min && value <= max; })();
  const presets: Array<{ label: string; choice: DurationChoice }> = isMute ? [
    { label: '5 minutos', choice: { amount: 5, unit: 'minutes' } }, { label: '10 minutos', choice: { amount: 10, unit: 'minutes' } }, { label: '1 hora', choice: { amount: 1, unit: 'hours' } }, { label: '1 dia', choice: { amount: 1, unit: 'days' } }, { label: '1 semana', choice: { amount: 7, unit: 'days' } },
  ] : [
    { label: '1 hora', choice: { amount: 1, unit: 'hours' } }, { label: '1 dia', choice: { amount: 1, unit: 'days' } }, { label: '1 semana', choice: { amount: 7, unit: 'days' } }, { label: '30 dias', choice: { amount: 30, unit: 'days' } }, { label: 'Permanente', choice: null },
  ];
  const submit = async () => {
    const selected = custom ? (validCustom ? { amount, unit } : null) : duration;
    const selectedSeconds = selected ? selected.amount * (selected.unit === 'minutes' ? 60 : selected.unit === 'hours' ? 3600 : 86400) : null;
    if (selectedSeconds !== null && (selectedSeconds < min || selectedSeconds > max)) { setError(isMute ? 'Escolhe entre 1 minuto e 28 dias.' : 'Escolhe entre 1 hora e 365 dias.'); return; }
    if (custom && !validCustom) { setError(isMute ? 'Escolhe entre 1 minuto e 28 dias.' : 'Escolhe entre 1 hora e 365 dias.'); return; }
    setBusy(true); setError('');
    try { await onConfirm(selected, reason.trim()); }
    catch { setError(isMute ? 'Não foi possível silenciar. Tenta de novo.' : 'Não foi possível banir. Tenta de novo.'); }
    finally { setBusy(false); }
  };
  return createPortal(<div className="modal-backdrop moderation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal moderation-prompt" role="dialog" aria-modal="true" aria-labelledby="moderation-title">
      <h2 id="moderation-title">{isMute ? 'Silenciar membro' : 'Banir membro'}</h2>
      <div className="moderation-presets">{presets.map((preset) => <button type="button" key={preset.label} className={`secondary ${!custom && durationText(duration) === durationText(preset.choice) ? 'selected' : ''}`} onClick={() => { setCustom(false); setDuration(preset.choice); }}>{preset.label}</button>)}</div>
      <button type="button" className={`secondary moderation-custom-toggle ${custom ? 'selected' : ''}`} onClick={() => { setCustom(true); setDuration({ amount, unit }); }}>Personalizado</button>
      {custom && <div className="moderation-custom-fields"><label className="field">Duração<input type="number" min={1} max={isMute ? 40320 : 525600} value={amount} onChange={(event) => { const next = Number(event.target.value); setAmount(next); setDuration({ amount: next, unit }); }}/></label><label className="field">Unidade<select value={unit} onChange={(event) => { const next = event.target.value as DurationUnit; setUnit(next); setDuration({ amount, unit: next }); }}><option value="minutes">Minutos</option><option value="hours">Horas</option><option value="days">Dias</option></select></label><small>{isMute ? 'Mínimo 1 minuto · máximo 28 dias' : 'Mínimo 1 hora · máximo 365 dias'}</small></div>}
      <label className="field moderation-reason">Motivo (opcional)<textarea value={reason} onChange={(event) => setReason(event.target.value.slice(0, 500))} maxLength={500} rows={3}/><small>{reason.length}/500</small></label>
      <p className="moderation-summary">{isMute ? `Silenciar ${member.username} durante ${durationText(custom && validCustom ? { amount, unit } : duration)}?` : `Banir ${member.username} ${duration ? `durante ${durationText(custom && validCustom ? { amount, unit } : duration)}?` : 'permanentemente?'}`}</p>
      {error && <p className="error-banner" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancelar</button><button type="button" className={isMute ? 'primary' : 'danger-button'} onClick={() => void submit()} disabled={busy || (custom && !validCustom)}>{busy ? 'A aplicar…' : isMute ? 'Confirmar' : 'Banir'}</button></div>
    </section>
  </div>, document.body);
}
