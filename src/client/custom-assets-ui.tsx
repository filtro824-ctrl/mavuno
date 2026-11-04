import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';

type AssetKind = 'emojis' | 'stickers';
type Asset = { id: string; name: string; url: string; mimeType: string; width: number; height: number; animated: boolean; description?: string };
type UploadItem = { key: string; file: File; name: string; description: string; status: 'queued' | 'sending' | 'failed' | 'done'; error?: string };
type AssetResponse = { available?: unknown; mavuno?: unknown; emojis?: Asset[]; stickers?: Asset[] };
const LIMITS: Record<AssetKind, { count: number; bytes: number; width: number; height: number; label: string }> = {
  emojis: { count: 50, bytes: 256 * 1024, width: 128, height: 128, label: 'emoji' },
  stickers: { count: 30, bytes: 512 * 1024, width: 320, height: 320, label: 'sticker' },
};
const FRIENDLY = {
  tooLarge: 'Este emoji é demasiado grande. O máximo é 256 KB.',
  badType: 'Tipo de ficheiro não permitido. Usa PNG, WebP ou GIF.',
  storage: 'Os emojis e stickers ainda não estão disponíveis. Tenta mais tarde.',
  limit: 'Limite atingido para esta comunidade.',
  duplicate: 'Já existe um emoji ou sticker com este nome. Escolhe outro nome.',
};
const styles: Record<string, React.CSSProperties> = {
  root: { color: 'var(--text-primary, #f1f3f5)', fontFamily: 'inherit', width: '100%', maxWidth: 900, margin: '0 auto' },
  tabs: { display: 'flex', gap: 8, borderBottom: '1px solid var(--border, #343a40)', marginBottom: 16 },
  tab: { padding: '10px 16px', border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' },
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
  button: { border: '1px solid var(--border, #495057)', background: 'var(--surface, #24272b)', color: 'inherit', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', font: 'inherit' },
  primary: { border: 0, background: 'var(--primary, #5865f2)', color: '#fff', borderRadius: 8, padding: '9px 14px', cursor: 'pointer', font: 'inherit' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12 },
  card: { display: 'flex', gap: 12, alignItems: 'center', border: '1px solid var(--border, #343a40)', borderRadius: 10, padding: 12, minWidth: 0 },
  image: { width: 48, height: 48, objectFit: 'contain', flex: '0 0 48px', borderRadius: 6, background: 'var(--surface, #24272b)' },
  input: { boxSizing: 'border-box', width: '100%', background: 'var(--input, #17191c)', border: '1px solid var(--border, #495057)', borderRadius: 6, padding: '8px 9px', color: 'inherit', font: 'inherit' },
  muted: { color: 'var(--text-secondary, #aab0b7)', fontSize: 13 },
};
function cleanName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32); }
function defaultName(file: File): string { return cleanName(file.name.replace(/\.[^.]*$/, '')) || 'novo_asset'; }
function getFriendlyError(error: unknown, kind: AssetKind = 'emojis'): string {
  const raw = error instanceof Error ? error.message : '';
  if (/duplicate|already exists|unique|repetid|já existe/i.test(raw)) return FRIENDLY.duplicate;
  if (/demasiado grande|dimensions|dimensões|tamanho/i.test(raw)) return kind === 'emojis' ? FRIENDLY.tooLarge : 'Este sticker é demasiado grande. O máximo é 512 KB.';
  if (/tipo|mime|image type/i.test(raw)) return FRIENDLY.badType;
  if (/limit|quota|maximum|limite/i.test(raw)) return FRIENDLY.limit;
  if (/storage|unavailable|temporar|armazen|ainda não estão disponíveis/i.test(raw)) return FRIENDLY.storage;
  return raw && raw.length < 180 ? raw : 'Não foi possível concluir o envio. Verifica a ligação e tenta novamente.';
}
async function shrinkImage(file: File, maxSide: number): Promise<File> {
  if (!/^image\/(png|webp)$/.test(file.type)) return file;
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width <= maxSide && bitmap.height <= maxSide) return file;
    const scale = Math.min(maxSide / bitmap.width, maxSide / bitmap.height, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Não foi possível preparar a imagem.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Não foi possível preparar a imagem.')), file.type));
    if (blob.type !== file.type) throw new Error('Este navegador não conseguiu preparar este tipo de imagem.');
    return new File([blob], file.name, { type: file.type, lastModified: file.lastModified });
  } finally { bitmap.close(); }
}
async function imageDimensions(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  try { return { width: bitmap.width, height: bitmap.height }; } finally { bitmap.close(); }
}

export default function CustomAssetsManager({ communityId, onUpdated }: { communityId: string; onUpdated?: () => void }) {
  const [kind, setKind] = useState<AssetKind>('emojis');
  const [assets, setAssets] = useState<Record<AssetKind, Asset[]>>({ emojis: [], stickers: [] });
  const [available, setAvailable] = useState(true);
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [excluded, setExcluded] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const current = assets[kind];
  const limit = LIMITS[kind];
  const pendingCount = queue.filter((item) => item.status !== 'done').length;
  const occupied = current.length + pendingCount;
  const duplicateNames = useMemo(() => new Set(current.map((asset) => asset.name.toLowerCase())), [current]);

  const refresh = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const result = await api<AssetResponse>(`/communities/${encodeURIComponent(communityId)}/assets`);
      setAvailable(result.available !== false);
      setAssets({ emojis: Array.isArray(result.emojis) ? result.emojis : [], stickers: Array.isArray(result.stickers) ? result.stickers : [] });
    } catch (error) { setLoadError(getFriendlyError(error, kind)); }
    finally { setLoading(false); }
  }, [communityId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const updateItem = (key: string, patch: Partial<UploadItem>) => setQueue((items) => items.map((item) => item.key === key ? { ...item, ...patch } : item));
  const upload = async (key: string) => {
    const item = queue.find((entry) => entry.key === key);
    if (!item || item.status === 'sending') return;
    const name = cleanName(item.name);
    if (!name) { updateItem(key, { status: 'failed', error: 'Introduz um nome com letras, números ou _.' }); return; }
    if (duplicateNames.has(name.toLowerCase()) || current.some((asset) => asset.name.toLowerCase() === name.toLowerCase()) || queue.some((entry) => entry.key !== key && entry.status !== 'done' && cleanName(entry.name).toLowerCase() === name.toLowerCase())) {
      updateItem(key, { status: 'failed', error: FRIENDLY.duplicate }); return;
    }
    if (current.length >= limit.count) { updateItem(key, { status: 'failed', error: FRIENDLY.limit }); return; }
    updateItem(key, { status: 'sending', error: undefined, name });
    try {
      let file = item.file;
      if (!['image/png', 'image/webp', 'image/gif'].includes(file.type)) throw new Error(FRIENDLY.badType);
      const dimensions = await imageDimensions(file);
      if (file.type === 'image/gif' && (dimensions.width > limit.width || dimensions.height > limit.height)) throw new Error(`GIF acima de ${limit.width}×${limit.height}px não pode ser redimensionado. Escolhe outro ficheiro.`);
      file = await shrinkImage(file, limit.width);
      if (file.size > limit.bytes) throw new Error(kind === 'emojis' ? FRIENDLY.tooLarge : 'Este sticker é demasiado grande. O máximo é 512 KB.');
      const { assetId, uploadUrl, headers } = await api<{ assetId: string; uploadUrl: string; headers?: Record<string, string> }>(`/communities/${encodeURIComponent(communityId)}/${kind}`, {
        method: 'POST', body: JSON.stringify({ name, description: item.description.trim(), mimeType: file.type, sizeBytes: file.size }),
      });
      const response = await fetch(uploadUrl, { method: 'PUT', headers: headers ?? { 'Content-Type': file.type }, body: file });
      if (!response.ok) throw new Error(response.status === 413 ? FRIENDLY.tooLarge : 'Não foi possível enviar o ficheiro. Tenta novamente.');
      await api(`/community-assets/${encodeURIComponent(assetId)}/confirm`, { method: 'POST', body: JSON.stringify({ assetType: kind === 'emojis' ? 'emoji' : 'sticker', sizeBytes: file.size }) });
      setQueue((items) => items.map((entry) => entry.key === key ? { ...entry, status: 'done', error: undefined } : entry));
      await refresh(); onUpdated?.();
    } catch (error) {
      const message = error instanceof Error && [FRIENDLY.tooLarge, 'Este sticker é demasiado grande. O máximo é 512 KB.', FRIENDLY.badType].some((known) => error.message === known) ? error.message : getFriendlyError(error, kind);
      updateItem(key, { status: 'failed', error: message });
    }
  };

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const chosen = Array.from(files);
    const room = Math.max(0, limit.count - current.length - queue.filter((item) => item.status !== 'done').length);
    const accepted = chosen.slice(0, room);
    setExcluded((count) => count + chosen.length - accepted.length);
    if (chosen.length > accepted.length) setNotice(FRIENDLY.limit);
    else setNotice('');
    setQueue((items) => [...items.filter((item) => item.status !== 'done'), ...accepted.map((file) => ({ key: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, name: defaultName(file), description: '', status: 'queued' as const }))]);
  };

  const rename = async (asset: Asset, name: string, description: string) => {
    const clean = cleanName(name);
    if (!clean) { setNotice('Introduz um nome com letras, números ou _.'); return; }
    if (current.some((entry) => entry.id !== asset.id && entry.name.toLowerCase() === clean.toLowerCase())) { setNotice(FRIENDLY.duplicate); return; }
    try {
      await api(`/communities/${encodeURIComponent(communityId)}/${kind}/${encodeURIComponent(asset.id)}`, { method: 'PATCH', body: JSON.stringify(kind === 'stickers' ? { name: clean, description } : { name: clean }) });
      setNotice(''); await refresh(); onUpdated?.();
    } catch (error) { setNotice(getFriendlyError(error, kind)); }
  };
  const remove = async (asset: Asset) => {
    if (!window.confirm(`Apagar ${kind === 'emojis' ? 'o emoji' : 'o sticker'} “${asset.name}”? Esta ação não pode ser desfeita.`)) return;
    try { await api(`/communities/${encodeURIComponent(communityId)}/${kind}/${encodeURIComponent(asset.id)}`, { method: 'DELETE' }); setNotice(''); await refresh(); onUpdated?.(); }
    catch (error) { setNotice(getFriendlyError(error, kind)); }
  };

  return <section style={styles.root} aria-label="Gestão de emojis e stickers">
    <div style={styles.tabs} role="tablist" aria-label="Tipo de imagem">
      {(['emojis', 'stickers'] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={kind === value} onClick={() => { setKind(value); setNotice(''); }} style={{ ...styles.tab, borderBottom: kind === value ? '2px solid var(--primary, #5865f2)' : '2px solid transparent', fontWeight: kind === value ? 700 : 400 }}>{value === 'emojis' ? 'Emojis' : 'Stickers'}</button>)}
    </div>
    <div style={styles.toolbar}><strong>{current.length}/{limit.count} {kind === 'emojis' ? 'emojis' : 'stickers'} da comunidade</strong><div style={{ display: 'flex', gap: 8 }}><input ref={inputRef} type="file" accept="image/png,image/webp,image/gif" multiple hidden onChange={(event) => { addFiles(event.currentTarget.files); event.currentTarget.value = ''; }}/><button type="button" style={styles.primary} onClick={() => inputRef.current?.click()} disabled={!available || loading}>Adicionar {kind === 'emojis' ? 'emojis' : 'stickers'}</button><button type="button" style={styles.button} onClick={() => void refresh()} disabled={loading}>Atualizar</button></div></div>
    <p style={styles.muted}>PNG, WebP ou GIF · máximo {kind === 'emojis' ? '256 KB' : '512 KB'} por ficheiro · apenas os recursos desta comunidade contam para o limite.</p>
    {!available && <p role="alert">Os emojis e stickers ainda não estão disponíveis. Tenta mais tarde.</p>}{loading && <p role="status">A carregar recursos…</p>}{loadError && <p role="alert">{loadError} <button type="button" style={styles.button} onClick={() => void refresh()}>Tentar novamente</button></p>}{notice && <p role="alert">{notice}</p>}
    {excluded > 0 && <p role="status" style={styles.muted}>{excluded} ficheiro(s) excluído(s): o limite da comunidade foi atingido.</p>}
    {queue.filter((item) => item.status !== 'done').map((item) => <div key={item.key} style={{ ...styles.card, margin: '10px 0', alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 8 }}><strong style={{ overflowWrap: 'anywhere' }}>{item.file.name}</strong><input aria-label={`Nome de ${item.file.name}`} style={styles.input} value={item.name} maxLength={32} onChange={(event) => updateItem(item.key, { name: cleanName(event.target.value) })}/>{kind === 'stickers' && <input aria-label={`Descrição de ${item.file.name}`} style={styles.input} value={item.description} maxLength={120} placeholder="Descrição (opcional)" onChange={(event) => updateItem(item.key, { description: event.target.value })}/>}<span role={item.status === 'failed' ? 'alert' : 'status'} style={{ ...styles.muted, color: item.status === 'failed' ? '#ff7777' : undefined }}>{item.status === 'sending' ? 'A enviar…' : item.status === 'failed' ? `Falhou: ${item.error}` : 'Pronto para enviar'}</span></div>
      <button type="button" style={styles.button} onClick={() => void upload(item.key)} disabled={!available || loading || item.status === 'sending'}>{item.status === 'failed' ? 'Tentar de novo' : item.status === 'sending' ? 'A enviar…' : 'Enviar'}</button>
    </div>)}
    {!loading && !loadError && current.length === 0 && queue.every((item) => item.status === 'done') && <p style={styles.muted}>Ainda não há {kind === 'emojis' ? 'emojis' : 'stickers'} personalizados nesta comunidade.</p>}
    <div style={styles.grid}>{current.map((asset) => <AssetCard key={asset.id} asset={asset} kind={kind} onSave={rename} onDelete={remove}/>)}</div>
  </section>;
}

function AssetCard({ asset, kind, onSave, onDelete }: { asset: Asset; kind: AssetKind; onSave: (asset: Asset, name: string, description: string) => Promise<void>; onDelete: (asset: Asset) => Promise<void> }) {
  const [name, setName] = useState(asset.name);
  const [description, setDescription] = useState(asset.description ?? '');
  useEffect(() => { setName(asset.name); setDescription(asset.description ?? ''); }, [asset.name, asset.description]);
  return <article style={styles.card}>
    <img src={asset.url} alt={asset.name} style={styles.image} loading="lazy"/>
    <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 7 }}><input aria-label={`Nome do recurso ${asset.name}`} style={styles.input} value={name} maxLength={32} onChange={(event) => setName(cleanName(event.target.value))}/>{kind === 'stickers' && <input aria-label={`Descrição do sticker ${asset.name}`} style={styles.input} value={description} maxLength={120} placeholder="Descrição (opcional)" onChange={(event) => setDescription(event.target.value)}/>}<span style={styles.muted}>{asset.width}×{asset.height}{asset.animated ? ' · animado' : ''}</span><div style={{ display: 'flex', gap: 6 }}><button type="button" style={styles.button} onClick={() => void onSave(asset, name, description)}>Guardar</button><button type="button" style={styles.button} onClick={() => void onDelete(asset)}>Apagar</button></div></div>
  </article>;
}
