import { useCallback, useEffect, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let swRegistered = false;

export function initPWA(): void {
  if (swRegistered || typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  swRegistered = true;
  try {
    registerSW({
      immediate: true,
      onRegisteredSW() {
        // Registered cleanly
      },
      onRegisterError(err) {
        console.warn('SW registration skipped:', err);
      },
    });
  } catch {
    // Ignore in environments without SW support
  }
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const onUp = () => setOnline(true);
    const onDown = () => setOnline(false);
    window.addEventListener('online', onUp);
    window.addEventListener('offline', onDown);
    return () => {
      window.removeEventListener('online', onUp);
      window.removeEventListener('offline', onDown);
    };
  }, []);

  return online;
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as { standalone?: boolean }).standalone === true
    );
  });
  const [isIOS, setIsIOS] = useState<boolean>(false);

  useEffect(() => {
    initPWA();
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const ios = /iPad|iPhone|iPod/.test(ua) && !(window as { MSStream?: unknown }).MSStream;
    setIsIOS(ios);

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const onInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'ios' | 'unavailable'> => {
    if (isInstalled) return 'accepted';
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const res = await deferredPrompt.userChoice;
      if (res.outcome === 'accepted') {
        setIsInstalled(true);
        setDeferredPrompt(null);
      }
      return res.outcome;
    }
    if (isIOS) return 'ios';
    return 'unavailable';
  }, [deferredPrompt, isIOS, isInstalled]);

  return {
    canNativeInstall: Boolean(deferredPrompt),
    isInstalled,
    isIOS,
    promptInstall,
  };
}

export type NotificationPermState = NotificationPermission | 'unsupported';

const NOTIFICATIONS_ENABLED_KEY = 'duoboard_notifications_enabled_v1';

export function isNotificationsEnabledPref(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setNotificationsEnabledPref(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore storage restriction
  }
  window.dispatchEvent(
    new CustomEvent('duoboard:notifications-pref-changed', { detail: { enabled } })
  );
}

export function getNotificationPermission(): NotificationPermState {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'unsupported';
  }
  return Notification.permission;
}

export async function requestNotificationPermissionSafe(): Promise<NotificationPermState> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'unsupported';
  }
  if (Notification.permission === 'granted') return 'granted';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export async function triggerSystemNotification(opts: {
  title: string;
  body: string;
  tag: string;
  senderUid?: string;
  chatId?: string;
  actionTab?: 'friends' | 'leaderboard';
  onInAppClick?: () => void;
}): Promise<void> {
  if (!isNotificationsEnabledPref()) return;
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;

  const data = {
    senderUid: opts.senderUid || '',
    chatId: opts.chatId || '',
    actionTab: opts.actionTab || 'friends',
  };

  try {
    if ('serviceWorker' in navigator) {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((r) => window.setTimeout(() => r(null), 900)),
      ]);
      if (reg && 'showNotification' in reg) {
        await reg.showNotification(opts.title, {
          body: opts.body,
          icon: '/pwa-192x192.png',
          badge: '/pwa-192x192.png',
          dir: 'rtl',
          lang: 'ar',
          tag: opts.tag,
          data,
        });
        return;
      }
    }
  } catch {
    // Fallback to Notification constructor below
  }

  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      icon: '/pwa-192x192.png',
      dir: 'rtl',
      lang: 'ar',
      tag: opts.tag,
    });
    n.onclick = () => {
      window.focus();
      n.close();
      opts.onInAppClick?.();
    };
  } catch {
    // Ignore blocked OS notification
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

let cachedVapidPublicKey: string | null = null;

export async function subscribeBrowserToWebPush(
  idToken: string,
  tokenMeta?: { projectId?: string; apiKey?: string; firestoreDatabaseId?: string }
): Promise<boolean> {
  if (
    !idToken ||
    !isNotificationsEnabledPref() ||
    typeof window === 'undefined' ||
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window)
  ) {
    return false;
  }

  try {
    if (!cachedVapidPublicKey) {
      const keyRes = await fetch('/api/push/vapid-public-key', { cache: 'no-store' });
      if (!keyRes.ok) return false;
      const keyJson = (await keyRes.json()) as { enabled?: boolean; publicKey?: string };
      if (!keyJson.enabled || !keyJson.publicKey) return false;
      cachedVapidPublicKey = keyJson.publicKey;
    }

    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((r) => window.setTimeout(() => r(null), 2500)),
    ]);
    if (!reg || !reg.pushManager) return false;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const appServerKey = urlBase64ToUint8Array(cachedVapidPublicKey);
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey as unknown as BufferSource,
      });
    }

    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        subscription: sub.toJSON(),
        tokenProjectId: tokenMeta?.projectId,
        tokenApiKey: tokenMeta?.apiKey,
        tokenFirestoreDatabaseId: tokenMeta?.firestoreDatabaseId,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function unsubscribeBrowserFromWebPush(
  idToken: string,
  tokenMeta?: { projectId?: string; apiKey?: string; firestoreDatabaseId?: string }
): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }

  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((r) => window.setTimeout(() => r(null), 2000)),
    ]);
    if (!reg || !reg.pushManager) return false;

    const sub = await reg.pushManager.getSubscription();
    if (!sub) return true;

    const endpoint = sub.endpoint;
    if (idToken && endpoint) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          endpoint,
          tokenProjectId: tokenMeta?.projectId,
          tokenApiKey: tokenMeta?.apiKey,
          tokenFirestoreDatabaseId: tokenMeta?.firestoreDatabaseId,
        }),
      }).catch(() => undefined);
    }

    await sub.unsubscribe().catch(() => false);
    return true;
  } catch {
    return false;
  }
}
