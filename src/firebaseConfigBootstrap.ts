import defaultFirebaseConfigJson from '../firebase-applet-config.json';

export interface FirebaseAppConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
  measurementId?: string;
  firestoreDatabaseId?: string;
}

export interface ServerPlatformPointer {
  id: 'migration';
  config: FirebaseAppConfig;
  resetToDefault?: boolean;
  migratedRoomId?: string | null;
  migrationEpoch?: string;
  previousConfigs?: FirebaseAppConfig[];
  updatedByEmail?: string;
  updatedAt?: number;
}

export const defaultFirebaseConfig: FirebaseAppConfig =
  defaultFirebaseConfigJson as FirebaseAppConfig;

export const CUSTOM_CONFIG_STORAGE_KEY = 'duoboard_custom_firebase_config_v1';
export const PREV_CONFIGS_STORAGE_KEY = 'duoboard_prev_firebase_configs_v1';
export const PENDING_REJOIN_ROOM_KEY = 'duoboard_pending_rejoin_room';
export const SYNCED_SOURCES_KEY_PREFIX = 'duoboard_synced_sources_v1_';
export const ACTIVE_ROOM_STORAGE_PREFIX = 'duoboard_active_room_';
export const DB_EPOCH_STORAGE_KEY = 'duoboard_db_epoch_v1';
export const CONSOLIDATED_FROM_SESSION_KEY = 'duoboard_consolidated_from_project';
export const CURRENT_DB_EPOCH = 'consolidated_primary_2026_11_18';

export function sanitizeFirebaseConfig(
  raw: unknown
): FirebaseAppConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const apiKey = typeof obj.apiKey === 'string' ? obj.apiKey.trim() : '';
  const projectId =
    typeof obj.projectId === 'string' ? obj.projectId.trim() : '';
  const appId = typeof obj.appId === 'string' ? obj.appId.trim() : '';
  const authDomainRaw =
    typeof obj.authDomain === 'string' ? obj.authDomain.trim() : '';
  const authDomain =
    authDomainRaw || (projectId ? `${projectId}.firebaseapp.com` : '');

  if (
    !apiKey ||
    apiKey.length < 10 ||
    apiKey.length > 200 ||
    !projectId ||
    !/^[a-z0-9-]{4,64}$/.test(projectId) ||
    !appId ||
    appId.length < 8 ||
    appId.length > 200 ||
    !authDomain
  ) {
    return null;
  }

  const dbIdRaw =
    typeof obj.firestoreDatabaseId === 'string'
      ? obj.firestoreDatabaseId.trim()
      : typeof obj.databaseId === 'string'
      ? obj.databaseId.trim()
      : '';

  return {
    apiKey,
    authDomain,
    projectId,
    storageBucket:
      typeof obj.storageBucket === 'string' && obj.storageBucket.trim()
        ? obj.storageBucket.trim()
        : `${projectId}.firebasestorage.app`,
    messagingSenderId:
      typeof obj.messagingSenderId === 'string'
        ? obj.messagingSenderId.trim()
        : '',
    appId,
    measurementId:
      typeof obj.measurementId === 'string' ? obj.measurementId.trim() : '',
    firestoreDatabaseId: dbIdRaw,
  };
}

export function isSameFirebaseTarget(
  a: FirebaseAppConfig,
  b: FirebaseAppConfig
): boolean {
  const dbA = (a.firestoreDatabaseId || '(default)').trim();
  const dbB = (b.firestoreDatabaseId || '(default)').trim();
  return a.projectId === b.projectId && dbA === dbB && a.apiKey === b.apiKey;
}

export function firebaseTargetKey(config: FirebaseAppConfig): string {
  const dbId = (config.firestoreDatabaseId || '(default)').trim();
  return `${config.projectId}::${dbId}`;
}

export function getPreviousFirebaseConfigs(): FirebaseAppConfig[] {
  try {
    const raw = localStorage.getItem(PREV_CONFIGS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: FirebaseAppConfig[] = [];
    for (const item of parsed) {
      const cfg = sanitizeFirebaseConfig(item);
      if (cfg && !out.some((x) => isSameFirebaseTarget(x, cfg))) {
        out.push(cfg);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function savePreviousFirebaseConfigs(
  configs: FirebaseAppConfig[],
  excludeCurrent?: FirebaseAppConfig
): void {
  try {
    const deduped: FirebaseAppConfig[] = [];
    for (const raw of configs) {
      const cfg = sanitizeFirebaseConfig(raw);
      if (!cfg) continue;
      if (excludeCurrent && isSameFirebaseTarget(cfg, excludeCurrent)) continue;
      if (!deduped.some((x) => isSameFirebaseTarget(x, cfg))) {
        deduped.push(cfg);
      }
    }
    localStorage.setItem(PREV_CONFIGS_STORAGE_KEY, JSON.stringify(deduped.slice(0, 8)));
  } catch {
    // Ignore storage errors
  }
}

export function clearStaleRoomAndSessionKeys(): void {
  try {
    localStorage.removeItem(PENDING_REJOIN_ROOM_KEY);
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(ACTIVE_ROOM_STORAGE_PREFIX)) {
        toRemove.push(k);
      }
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // Ignore localStorage errors
  }
  try {
    sessionStorage.removeItem('duoboard_auto_switched_to');
  } catch {
    // Ignore sessionStorage errors
  }
}

function getCurrentStoredFirebaseConfig(): FirebaseAppConfig {
  try {
    const raw = localStorage.getItem(CUSTOM_CONFIG_STORAGE_KEY);
    if (raw) {
      const parsed = sanitizeFirebaseConfig(JSON.parse(raw));
      if (parsed) return parsed;
    }
  } catch {
    // Ignore storage errors
  }
  return defaultFirebaseConfig;
}

/**
 * Fetches the authoritative server-stored Firebase pointer BEFORE firebase.ts initializes,
 * so any device opening the site connects directly to the active migrated database for login & data.
 */
export async function syncPlatformDbBeforeBoot(): Promise<void> {
  if (typeof window === 'undefined') return;

  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('fb')) {
      return;
    }
  } catch {
    // Ignore URL errors
  }

  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 900);
    const resp = await fetch('/api/platform-db', {
      cache: 'no-store',
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    if (!resp.ok) return;

    const payload = (await resp.json()) as { pointer?: ServerPlatformPointer | null };
    const ptr = payload?.pointer;
    if (!ptr || !ptr.config) return;

    const targetCfg = sanitizeFirebaseConfig(ptr.config);
    if (!targetCfg) return;

    const currentLocal = getCurrentStoredFirebaseConfig();

    if (ptr.resetToDefault || isSameFirebaseTarget(targetCfg, defaultFirebaseConfig)) {
      if (!isSameFirebaseTarget(currentLocal, defaultFirebaseConfig)) {
        savePreviousFirebaseConfigs(
          [currentLocal, ...getPreviousFirebaseConfigs()],
          defaultFirebaseConfig
        );
        localStorage.removeItem(CUSTOM_CONFIG_STORAGE_KEY);
        clearStaleRoomAndSessionKeys();
      }
      localStorage.setItem(DB_EPOCH_STORAGE_KEY, CURRENT_DB_EPOCH);
      return;
    }

    if (!isSameFirebaseTarget(targetCfg, currentLocal)) {
      const extras = Array.isArray(ptr.previousConfigs) ? ptr.previousConfigs : [];
      savePreviousFirebaseConfigs(
        [currentLocal, defaultFirebaseConfig, ...extras, ...getPreviousFirebaseConfigs()],
        targetCfg
      );
      localStorage.setItem(CUSTOM_CONFIG_STORAGE_KEY, JSON.stringify(targetCfg));
      localStorage.setItem(DB_EPOCH_STORAGE_KEY, CURRENT_DB_EPOCH);
      clearStaleRoomAndSessionKeys();
    }
  } catch {
    // Static host or offline — gracefully rely on localStorage + Firestore platform/migration
  }
}
