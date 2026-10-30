import { Component, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class SafeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="viewport-failure" role="alert"><span className="brand-mark">m</span><h1>O ecrã não conseguiu abrir.</h1><p>As tuas conversas continuam guardadas. Tenta recarregar a aplicação.</p><button className="primary" onClick={() => window.location.reload()}>Recarregar</button></main>;
    return this.props.children;
  }
}
function ViewportSync() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => document.documentElement.style.setProperty('--app-height', `${viewport?.height ?? window.innerHeight}px`);
    document.documentElement.style.setProperty('--app-offset-top', `${viewport?.offsetTop ?? 0}px`);
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => { viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, []);
  return null;
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(<SafeBoundary><ViewportSync/><App /></SafeBoundary>);
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/service-worker.js').catch(() => undefined); });
}
