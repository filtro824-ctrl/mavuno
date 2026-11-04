import { useMemo, useState } from 'react';
import { EMOJI_CATEGORIES } from './emoji-data';
import type { CommunityAsset, CommunityAssetsResponse, MessageSticker } from './api';

const normalize = (value: string) => value.toLocaleLowerCase('pt').normalize('NFD').replace(/\p{Diacritic}/gu, '');
const label = (item: CommunityAsset) => item.name ?? item.label ?? item.key ?? 'emoji';
const assetToken = (item: CommunityAsset, builtin: boolean) => builtin ? `<:builtin:${item.key}>` : `<:${item.name}:${item.id}>`;

export function InlineEmojiText({ text, assets }: { text: string; assets: CommunityAssetsResponse | null }) {
  const map = useMemo(() => {
    const result = new Map<string, CommunityAsset>();
    for (const item of assets?.emojis ?? []) if (item.id && item.name) result.set(`custom:${item.id}`, item);
    for (const item of assets?.mavuno.emojis ?? []) if (item.key) result.set(`builtin:${item.key}`, item);
    return result;
  }, [assets]);
  const pieces: Array<string | { raw: string; asset: CommunityAsset }> = [];
  const pattern = /<:([a-z0-9_]{2,32}):([0-9a-f-]{36})>|<:builtin:([a-z0-9_]{2,32})>/gi;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) pieces.push(text.slice(cursor, index));
    const key = match[3] ? `builtin:${match[3]}` : `custom:${match[2]}`;
    const asset = map.get(key);
    pieces.push(asset ? { raw: match[0], asset } : match[3] ? `:${match[3]}:` : `:${match[1]}:`);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return <>{pieces.map((piece, index) => typeof piece === 'string' ? <span key={index}>{piece}</span> : <img key={`${piece.raw}-${index}`} className="inline-custom-emoji" src={piece.asset.url} alt={`:${label(piece.asset)}:`} title={label(piece.asset)} loading="lazy"/>)}</>;
}

export function AssetReaction({ value, assets }: { value: string; assets: CommunityAssetsResponse | null }) {
  const item = value.startsWith('custom:') ? assets?.emojis.find((asset) => asset.id === value.slice(7)) : value.startsWith('builtin:') ? assets?.mavuno.emojis.find((asset) => asset.key === value.slice(8)) : undefined;
  return item ? <img className="reaction-custom-emoji" src={item.url} alt={label(item)} title={label(item)}/> : <>{value}</>;
}

export function CommunityEmojiPicker({ assets, onSelect, onClose }: { assets: CommunityAssetsResponse | null; onSelect: (value: string) => void; onClose: () => void }) {
  const [tab, setTab] = useState('Mavuno');
  const [query, setQuery] = useState('');
  const unicode = EMOJI_CATEGORIES.flatMap((category) => category.items);
  const mavuno = assets?.mavuno.emojis ?? [];
  const community = assets?.emojis ?? [];
  const match = (item: CommunityAsset) => !query.trim() || normalize(`${label(item)} ${item.description ?? ''}`).includes(normalize(query.trim()));
  const builtins = tab === 'Mavuno';
  const chosenAssets = (builtins ? mavuno : community).filter(match);
  const unicodeCategory = tab.startsWith('unicode:') ? EMOJI_CATEGORIES.find((category) => category.id === tab.slice(8)) : undefined;
  const chosenUnicode = tab === 'Unicode' ? unicode.filter((item) => !query.trim() || normalize(item.name).includes(normalize(query.trim()))) : unicodeCategory ? unicodeCategory.items.filter((item) => !query.trim() || normalize(item.name).includes(normalize(query.trim()))) : [];
  return <div className="modal-backdrop emoji-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal emoji-sheet" role="dialog" aria-modal="true" aria-label="Escolher emoji"><div className="sheet-heading"><h2>Escolher emoji</h2><button className="icon-button" aria-label="Fechar seletor" onClick={onClose}>×</button></div><label className="emoji-search"><span className="sr-only">Pesquisar emoji</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar por nome ou etiqueta…"/></label><div className="emoji-tabs" role="tablist"><button role="tab" aria-selected={tab === 'Mavuno'} className={tab === 'Mavuno' ? 'active' : ''} onClick={() => setTab('Mavuno')}>Mavuno</button><button role="tab" aria-selected={tab === 'Comunidade'} className={tab === 'Comunidade' ? 'active' : ''} onClick={() => setTab('Comunidade')}>Comunidade</button><button role="tab" aria-selected={tab === 'Unicode'} className={tab === 'Unicode' ? 'active' : ''} onClick={() => setTab('Unicode')}>Todos</button>{EMOJI_CATEGORIES.map((category) => <button key={category.id} role="tab" aria-selected={tab === `unicode:${category.id}`} className={tab === `unicode:${category.id}` ? 'active' : ''} onClick={() => setTab(`unicode:${category.id}`)}>{category.label}</button>)}</div><div className="emoji-grid">{tab === 'Unicode' || tab.startsWith('unicode:') ? chosenUnicode.map((item) => <button type="button" key={item.emoji} title={item.name} aria-label={item.name} onClick={() => onSelect(item.emoji)}>{item.emoji}</button>) : chosenAssets.map((item) => <button type="button" key={item.key ?? item.id} title={label(item)} aria-label={label(item)} onClick={() => onSelect(assetToken(item, builtins))}><img src={item.url} alt="" loading="lazy"/></button>)}</div>{tab === 'Comunidade' && !community.length && <p className="empty-state">Ainda não há emojis da comunidade.</p>}{assets && !assets.available && <p className="muted">Os emojis e stickers ainda não estão disponíveis. Tenta mais tarde.</p>}</section></div>;
}

export function CommunityStickerPicker({ assets, onSelect, onClose }: { assets: CommunityAssetsResponse | null; onSelect: (item: CommunityAsset, builtin: boolean) => void; onClose: () => void }) {
  const [tab, setTab] = useState<'Mavuno' | 'Comunidade'>('Mavuno');
  const [query, setQuery] = useState('');
  const builtin = tab === 'Mavuno';
  const list = (builtin ? assets?.mavuno.stickers : assets?.stickers) ?? [];
  const filtered = list.filter((item) => !query.trim() || normalize(`${label(item)} ${item.description ?? ''}`).includes(normalize(query.trim())));
  return <div className="attachment-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="attachment-picker-sheet sticker-picker-sheet" role="dialog" aria-modal="true" aria-label="Escolher sticker"><div className="attachment-picker-handle"/><div className="sheet-heading"><h2>Escolher sticker</h2><button className="icon-button" aria-label="Fechar seletor" onClick={onClose}>×</button></div><label className="emoji-search"><span className="sr-only">Pesquisar sticker</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar por nome ou descrição…"/></label><div className="emoji-tabs" role="tablist"><button role="tab" aria-selected={builtin} className={builtin ? 'active' : ''} onClick={() => setTab('Mavuno')}>Mavuno</button><button role="tab" aria-selected={!builtin} className={!builtin ? 'active' : ''} onClick={() => setTab('Comunidade')}>Comunidade</button></div><div className="sticker-grid">{filtered.map((item) => <button type="button" key={item.key ?? item.id} aria-label={label(item)} title={item.description ?? label(item)} onClick={() => onSelect(item, builtin)}><img src={item.url} alt="" loading="lazy"/><span>{label(item)}</span></button>)}</div>{tab === 'Comunidade' && !list.length && <p className="empty-state">Ainda não há stickers da comunidade.</p>}</section></div>;
}

export function MessageStickerView({ sticker }: { sticker: MessageSticker }) {
  if (sticker.kind === 'removed' || !sticker.url) return <span className="removed-sticker">{sticker.name}</span>;
  return <img className="message-sticker" src={sticker.url} alt={sticker.description || sticker.name} title={sticker.description || sticker.name} width={sticker.width ?? 160} height={sticker.height ?? 160} loading="lazy"/>;
}
