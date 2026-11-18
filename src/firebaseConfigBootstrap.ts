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
  activeDatabaseId?: string;
  activeOrder?: number;
  totalDatabases?: number;
  allExhausted?: boolean;
  revision?: number;
  updatedByEmail?: string;
  updatedAt?: number;
}

export interface InitialServerPlatformStatus {
  serverSynced: boolean;
  allExhausted: boolean;
  revision: number;
  activeDatabaseId: string;
  activeOrder: number;
  totalDatabases: number;
}

export const defaultFirebaseConfig: FirebaseAppConfig =
  defaultFirebaseConfigJson as FirebaseAppConfig;

export const MASTER_PROGRAMMER_NAME = 'محمد منتصر محمد يونس';
export const MASTER_PROGRAMMER_EMAIL = 'mohammedmonta2022m@gmail.com';

export function normalizeArabicName(input: string | undefined | null): string {
  if (!input) return '';
  return input
    .trim()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function isMasterProgrammerIdentity(identity: {
  email?: string | null;
  fullNameQuad?: string | null;
}): boolean {
  const emailLower = (identity.email || '').trim().toLowerCase();
  if (emailLower && emailLower === MASTER_PROGRAMMER_EMAIL) return true;
  const norm = normalizeArabicName(identity.fullNameQuad);
  return Boolean(norm && norm === normalizeArabicName(MASTER_PROGRAMMER_NAME));
}

export const CUSTOM_CONFIG_STORAGE_KEY = 'duoboard_custom_firebase_config_v1';
export const PREV_CONFIGS_STORAGE_KEY = 'duoboard_prev_firebase_configs_v1';
export const PENDING_REJOIN_ROOM_KEY = 'duoboard_pending_rejoin_room';
export const SYNCED_SOURCES_KEY_PREFIX = 'duoboard_synced_sources_v1_';
export const ACTIVE_ROOM_STORAGE_PREFIX = 'duoboard_active_room_';
export const DB_EPOCH_STORAGE_KEY = 'duoboard_db_epoch_v1';
export const CONSOLIDATED_FROM_SESSION_KEY = 'duoboard_consolidated_from_project';
export const CURRENT_DB_EPOCH = 'consolidated_primary_2026_11_18';

let initialServerStatus: InitialServerPlatformStatus = {
  serverSynced: false,
  allExhausted: false,
  revision: 0,
  activeDatabaseId: 'primary_default',
  activeOrder: 1,
  totalDatabases: 1,
};

export function getInitialServerPlatformStatus(): InitialServerPlatformStatus {
  return initialServerStatus;
}

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
    localStorage.setItem(PREV_CONFIGS_STORAGE_KEY, JSON.stringify(deduped.slice(0, 12)));
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
 * so ANY visitor opening the platform waits briefly, gets the exact active DB in the pool,
 * and logs in + enters rooms directly on that DB.
 */
export async function syncPlatformDbBeforeBoot(): Promise<InitialServerPlatformStatus> {
  if (typeof window === 'undefined') return initialServerStatus;

  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 3500);
    const resp = await fetch(`/api/platform-db?t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    if (!resp.ok) return initialServerStatus;

    const payload = (await resp.json()) as {
      pointer?: ServerPlatformPointer | null;
      revision?: number;
      allExhausted?: boolean;
      activeDatabaseId?: string;
      activeOrder?: number;
      totalDatabases?: number;
    };
    const ptr = payload?.pointer;
    if (!ptr || !ptr.config) return initialServerStatus;

    initialServerStatus = {
      serverSynced: true,
      allExhausted: Boolean(payload.allExhausted ?? ptr.allExhausted),
      revision: Number(payload.revision ?? ptr.revision ?? 1),
      activeDatabaseId: String(payload.activeDatabaseId || ptr.activeDatabaseId || 'primary_default'),
      activeOrder: Number(payload.activeOrder ?? ptr.activeOrder ?? 1),
      totalDatabases: Number(payload.totalDatabases ?? ptr.totalDatabases ?? 1),
    };

    // Server is authoritative over legacy ?fb= query links
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('fb')) {
        url.searchParams.delete('fb');
        window.history.replaceState({}, '', url.toString());
      }
    } catch {
      // Ignore URL errors
    }

    const targetCfg = sanitizeFirebaseConfig(ptr.config);
    if (!targetCfg) return initialServerStatus;

    const currentLocal = getCurrentStoredFirebaseConfig();
    const extras = Array.isArray(ptr.previousConfigs) ? ptr.previousConfigs : [];

    if (ptr.resetToDefault || isSameFirebaseTarget(targetCfg, defaultFirebaseConfig)) {
      if (!isSameFirebaseTarget(currentLocal, defaultFirebaseConfig)) {
        savePreviousFirebaseConfigs(
          [currentLocal, ...extras, ...getPreviousFirebaseConfigs()],
          defaultFirebaseConfig
        );
        localStorage.removeItem(CUSTOM_CONFIG_STORAGE_KEY);
        clearStaleRoomAndSessionKeys();
      } else if (extras.length > 0) {
        savePreviousFirebaseConfigs(
          [...extras, ...getPreviousFirebaseConfigs()],
          defaultFirebaseConfig
        );
      }
      localStorage.setItem(DB_EPOCH_STORAGE_KEY, CURRENT_DB_EPOCH);
      return initialServerStatus;
    }

    if (!isSameFirebaseTarget(targetCfg, currentLocal)) {
      savePreviousFirebaseConfigs(
        [currentLocal, defaultFirebaseConfig, ...extras, ...getPreviousFirebaseConfigs()],
        targetCfg
      );
      localStorage.setItem(CUSTOM_CONFIG_STORAGE_KEY, JSON.stringify(targetCfg));
      localStorage.setItem(DB_EPOCH_STORAGE_KEY, CURRENT_DB_EPOCH);
      clearStaleRoomAndSessionKeys();
    } else {
      localStorage.setItem(DB_EPOCH_STORAGE_KEY, CURRENT_DB_EPOCH);
      if (extras.length > 0) {
        savePreviousFirebaseConfigs(
          [...extras, ...getPreviousFirebaseConfigs()],
          targetCfg
        );
      }
    }
  } catch {
    // Static host or offline — gracefully rely on localStorage + Firestore platform/migration
  }

  return initialServerStatus;
}
