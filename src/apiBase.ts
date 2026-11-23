declare global {
  interface Window {
    __DUOBOARD_API_ORIGIN__?: string;
    __DUOBOARD_BACKEND_DETECTED__?: boolean;
  }
}

function normalizeOrigin(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(trimmed)) {
    return trimmed;
  }
  return '';
}

export function getConfiguredApiOrigin(): string {
  if (typeof window !== 'undefined') {
    const fromWindow = normalizeOrigin(window.__DUOBOARD_API_ORIGIN__);
    if (fromWindow) return fromWindow;
  }
  const envVal =
    typeof import.meta !== 'undefined' &&
    import.meta.env &&
    typeof import.meta.env.VITE_API_ORIGIN === 'string'
      ? import.meta.env.VITE_API_ORIGIN
      : '';
  return normalizeOrigin(envVal);
}

export function setBackendServerDetected(available: boolean): void {
  if (typeof window !== 'undefined') {
    window.__DUOBOARD_BACKEND_DETECTED__ = available;
  }
}

export function isBackendServerDetected(): boolean {
  if (getConfiguredApiOrigin()) return true;
  if (typeof window !== 'undefined') {
    if (window.__DUOBOARD_BACKEND_DETECTED__ === true) return true;
    if (window.__DUOBOARD_BACKEND_DETECTED__ === false) return false;
    const host = window.location.hostname.toLowerCase();
    if (host.endsWith('.github.io') || host.endsWith('.netlify.app')) {
      return false;
    }
  }
  return true;
}

/**
 * يحوّل أي مسار API نسبي (/api/...) إلى المسار الصحيح:
 * - محلياً أو مع خادم Express المدمج: `/api/...`
 * - على GitHub Pages مع ضبط `VITE_API_ORIGIN` لخادم Node: `${VITE_API_ORIGIN}/api/...`
 */
export function resolveApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const origin = getConfiguredApiOrigin();
  return origin ? `${origin}${normalizedPath}` : normalizedPath;
}
