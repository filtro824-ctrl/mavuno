import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ProfileMediaKind } from '../server/profile-media-utils.js';

type Point = { x: number; y: number };
type ActivePointer = { point: Point };
type CropDialogProps = {
  file: File;
  kind: ProfileMediaKind;
  onCancel: () => void;
  onComplete: (file: File) => void;
};

function clampZoom(value: number): number { return Math.max(1, Math.min(4, value)); }
function distance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y); }

export function ProfileImageCropper({ file, kind, onCancel, onComplete }: CropDialogProps) {
  const width = kind === 'avatar' ? 512 : 1360;
  const height = kind === 'avatar' ? 512 : 400;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointersRef = useRef(new Map<number, ActivePointer>());
  const dragRef = useRef<{ pointerId: number; last: Point } | null>(null);
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [loadingError, setLoadingError] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let active = true;
    const objectUrl = URL.createObjectURL(file);
    const photo = new Image();
    photo.onload = () => { if (active) { setImage(photo); setLoadingError(''); } };
    photo.onerror = () => { if (active) setLoadingError('Não foi possível abrir esta imagem. Escolhe outra fotografia.'); };
    photo.src = objectUrl;
    return () => { active = false; URL.revokeObjectURL(objectUrl); };
  }, [file]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) { setLoadingError('Não foi possível preparar o recorte.'); return; }
    context.clearRect(0, 0, width, height);
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight) * zoom;
    const drawnWidth = image.naturalWidth * scale;
    const drawnHeight = image.naturalHeight * scale;
    const maxX = Math.max(0, (drawnWidth - width) / 2);
    const maxY = Math.max(0, (drawnHeight - height) / 2);
    const x = Math.max(-maxX, Math.min(maxX, pan.x));
    const y = Math.max(-maxY, Math.min(maxY, pan.y));
    if (kind === 'avatar') {
      context.save();
      context.beginPath();
      context.arc(width / 2, height / 2, width / 2, 0, Math.PI * 2);
      context.clip();
    }
    context.drawImage(image, width / 2 - drawnWidth / 2 + x, height / 2 - drawnHeight / 2 + y, drawnWidth, drawnHeight);
    if (kind === 'avatar') context.restore();
  }, [height, image, kind, pan, width, zoom]);

  const pointFor = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * width, y: ((event.clientY - rect.top) / rect.height) * height };
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!image) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFor(event);
    pointersRef.current.set(event.pointerId, { point });
    if (pointersRef.current.size === 1) dragRef.current = { pointerId: event.pointerId, last: point };
    if (pointersRef.current.size === 2) {
      const [first, second] = [...pointersRef.current.values()].map((item) => item.point);
      pinchRef.current = { distance: Math.max(1, distance(first, second)), zoom };
      dragRef.current = null;
    }
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const previous = pointersRef.current.get(event.pointerId);
    if (!previous) return;
    const point = pointFor(event);
    pointersRef.current.set(event.pointerId, { point });
    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const [first, second] = [...pointersRef.current.values()].map((item) => item.point);
      setZoom(clampZoom(pinchRef.current.zoom * distance(first, second) / pinchRef.current.distance));
      return;
    }
    if (dragRef.current?.pointerId === event.pointerId) {
      const deltaX = point.x - dragRef.current.last.x;
      const deltaY = point.y - dragRef.current.last.y;
      dragRef.current.last = point;
      setPan((current) => ({ x: current.x + deltaX, y: current.y + deltaY }));
    }
  };
  const finishPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(event.pointerId);
    pinchRef.current = null;
    const remaining = [...pointersRef.current.entries()][0];
    dragRef.current = remaining ? { pointerId: remaining[0], last: remaining[1].point } : null;
    if (pointersRef.current.size >= 2) {
      const [first, second] = [...pointersRef.current.values()].map((item) => item.point);
      pinchRef.current = { distance: Math.max(1, distance(first, second)), zoom };
      dragRef.current = null;
    }
  };
  const handleWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    setZoom((current) => clampZoom(current * Math.exp(-event.deltaY * 0.0015)));
  };
  const complete = () => {
    const canvas = canvasRef.current;
    if (!canvas || exporting || !image) return;
    setExporting(true);
    canvas.toBlob((blob) => {
      setExporting(false);
      if (!blob) { setLoadingError('Não foi possível guardar este recorte. Tenta novamente.'); return; }
      const name = kind === 'avatar' ? 'foto-perfil.jpg' : 'imagem-fundo.jpg';
      onComplete(new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() }));
    }, 'image/jpeg', 0.9);
  };

  return createPortal(<div className="profile-crop-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !exporting) onCancel(); }}>
    <section className="profile-crop-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-crop-title">
      <header className="profile-crop-heading">
        <div><h2 id="profile-crop-title">{kind === 'avatar' ? 'Ajustar foto de perfil' : 'Ajustar imagem de fundo'}</h2><p>Arrasta para posicionar. Usa dois dedos ou o controlo de zoom para ampliar.</p></div>
        <button type="button" className="icon-button" onClick={onCancel} disabled={exporting} aria-label="Cancelar recorte">×</button>
      </header>
      <div className={`profile-crop-frame ${kind === 'avatar' ? 'profile-crop-avatar' : 'profile-crop-banner'}`}>
        {image ? <canvas ref={canvasRef} aria-label={kind === 'avatar' ? 'Pré-visualização circular da foto' : 'Pré-visualização da imagem de fundo'} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={finishPointer} onPointerCancel={finishPointer} onWheel={handleWheel}/> : <span role="status">{loadingError || 'A abrir a imagem…'}</span>}
      </div>
      <label className="profile-crop-zoom">Ampliar ou reduzir <input type="range" min="1" max="4" step="0.01" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} disabled={!image}/><output>{Math.round(zoom * 100)}%</output></label>
      {loadingError && image && <p className="error-banner" role="alert">{loadingError}</p>}
      <div className="profile-crop-actions"><button type="button" className="secondary" onClick={onCancel} disabled={exporting}>Cancelar</button><button type="button" className="primary" onClick={complete} disabled={!image || exporting || Boolean(loadingError)}>{exporting ? 'A preparar…' : 'Concluir'}</button></div>
    </section>
  </div>, document.body);
}
