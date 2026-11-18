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
  backendAvailable: boolean;
  switchedOnBoot: boolean;
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
  backendAvailable: false,
  switchedOnBoot: false,
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

export interface ResolvedRemotePointer {
  config: FirebaseAppConfig;
  resetToDefault: boolean;
  migratedRoomId?: string | null;
  migrationEpoch?: string;
  previousConfigs: FirebaseAppConfig[];
  updatedAtMs: number;
}

type RestFieldValue = {
  stringValue?: string;
  timestampValue?: string;
  arrayValue?: { values?: Array<{ mapValue?: { fields?: Record<string, RestFieldValue> } }> };
  mapValue?: { fields?: Record<string, RestFieldValue> };
};

function readRestString(
  fields: Record<string, RestFieldValue> | undefined,
  key: string
): string {
  const val = fields?.[key]?.stringValue;
  return typeof val === 'string' ? val.trim() : '';
}

function parseConfigFromRestFields(
  fields: Record<string, RestFieldValue> | undefined
): FirebaseAppConfig | null {
  if (!fields) return null;
  return sanitizeFirebaseConfig({
    apiKey: readRestString(fields, 'apiKey'),
    authDomain: readRestString(fields, 'authDomain'),
    projectId: readRestString(fields, 'projectId'),
    appId: readRestString(fields, 'appId'),
    storageBucket: readRestString(fields, 'storageBucket'),
    messagingSenderId: readRestString(fields, 'messagingSenderId'),
    measurementId: readRestString(fields, 'measurementId'),
    firestoreDatabaseId: readRestString(fields, 'firestoreDatabaseId'),
  });
}

async function fetchFirestoreMigrationPointerRest(
  sourceCfg: FirebaseAppConfig,
  timeoutMs = 2600
): Promise<
  | { status: 'ok'; pointer: ResolvedRemotePointer }
  | { status: 'quota' }
  | { status: 'missing' }
> {
  const dbName = encodeURIComponent((sourceCfg.firestoreDatabaseId || '(default)').trim());
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    sourceCfg.projectId
  )}/databases/${dbName}/documents/platform/migration?key=${encodeURIComponent(sourceCfg.apiKey)}`;

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { cache: 'no-store', signal: controller.signal });
    window.clearTimeout(timer);
    if (resp.status === 429) {
      return { status: 'quota' };
    }
    if (!resp.ok) {
      return { status: 'missing' };
    }
    const docJson = (await resp.json()) as {
      fields?: Record<string, RestFieldValue>;
      updateTime?: string;
    };
    const fields = docJson?.fields;
    const cfg = parseConfigFromRestFields(fields);
    if (!cfg) return { status: 'missing' };

    const epoch = readRestString(fields, 'migrationEpoch');
    const migratedRoomId = readRestString(fields, 'migratedRoomId') || null;
    const updatedTsStr =
      fields?.updatedAt?.timestampValue ||
      (typeof docJson.updateTime === 'string' ? docJson.updateTime : '');
    const parsedTs = updatedTsStr ? Date.parse(updatedTsStr) : 0;
    const updatedAtMs = Number.isFinite(parsedTs) && parsedTs > 0 ? parsedTs : 1;

    const prevRaw = fields?.previousConfigs?.arrayValue?.values ?? [];
    const previousConfigs: FirebaseAppConfig[] = [];
    for (const item of prevRaw) {
      const pCfg = parseConfigFromRestFields(item?.mapValue?.fields);
      if (pCfg && !previousConfigs.some((x) => isSameFirebaseTarget(x, pCfg))) {
        previousConfigs.push(pCfg);
      }
    }

    return {
      status: 'ok',
      pointer: {
        config: cfg,
        resetToDefault: isSameFirebaseTarget(cfg, defaultFirebaseConfig),
        migratedRoomId,
        migrationEpoch: epoch || undefined,
        previousConfigs,
        updatedAtMs,
      },
    };
  } catch {
    window.clearTimeout(timer);
    return { status: 'missing' };
  }
}

/**
 * Walks Firestore /platform/migration via public unauthenticated REST API across
 * defaultFirebaseConfig -> current DB -> any forwarded target DBs (up to 8 hops),
 * returning the newest active database pointer configured by the programmer.
 */
export async function resolveLatestFirestoreMigrationRest(
  extraSeeds: FirebaseAppConfig[] = []
): Promise<ResolvedRemotePointer | null> {
  if (typeof window === 'undefined') return null;

  const initialSeeds: FirebaseAppConfig[] = [];
  const addSeed = (cfg: FirebaseAppConfig | null | undefined) => {
    if (!cfg) return;
    if (!initialSeeds.some((x) => isSameFirebaseTarget(x, cfg))) {
      initialSeeds.push(cfg);
    }
  };
  addSeed(defaultFirebaseConfig);
  addSeed(getCurrentStoredFirebaseConfig());
  for (const prev of getPreviousFirebaseConfigs()) addSeed(prev);
  for (const extra of extraSeeds) addSeed(extra);

  const visited = new Set<string>();
  let frontier: FirebaseAppConfig[] = [...initialSeeds];
  let best: ResolvedRemotePointer | null = null;
  let allCollectedConfigs: FirebaseAppConfig[] = [...initialSeeds];

  for (let hop = 0; hop < 6 && frontier.length > 0; hop++) {
    const batch = frontier.filter((c) => {
      const k = firebaseTargetKey(c);
      if (visited.has(k)) return false;
      visited.add(k);
      return true;
    });
    if (batch.length === 0) break;

    const results = await Promise.all(
      batch.map((cfg) => fetchFirestoreMigrationPointerRest(cfg, hop === 0 ? 2800 : 2200))
    );

    const nextFrontier: FirebaseAppConfig[] = [];
    for (const res of results) {
      if (res.status !== 'ok') continue;
      const ptr = res.pointer;
      if (ptr.migrationEpoch && ptr.migrationEpoch !== CURRENT_DB_EPOCH) continue;

      if (!allCollectedConfigs.some((x) => isSameFirebaseTarget(x, ptr.config))) {
        allCollectedConfigs.push(ptr.config);
      }
      for (const prev of ptr.previousConfigs) {
        if (!allCollectedConfigs.some((x) => isSameFirebaseTarget(x, prev))) {
          allCollectedConfigs.push(prev);
        }
      }

      if (!best || ptr.updatedAtMs >= best.updatedAtMs) {
        best = ptr;
      }

      const targetKey = firebaseTargetKey(ptr.config);
      if (
        !visited.has(targetKey) &&
        !nextFrontier.some((x) => isSameFirebaseTarget(x, ptr.config))
      ) {
        nextFrontier.push(ptr.config);
      }
    }
    frontier = nextFrontier;
  }

  if (!best) return null;

  return {
    ...best,
    previousConfigs: allCollectedConfigs.filter(
      (c, idx, arr) =>
        !isSameFirebaseTarget(c, best!.config) &&
        arr.findIndex((x) => isSameFirebaseTarget(x, c)) === idx
    ),
  };
}

function persistResolvedTargetConfig(params: {
  targetCfg: FirebaseAppConfig;
  resetToDefault?: boolean;
  extras?: FirebaseAppConfig[];
}): boolean {
  const { targetCfg, resetToDefault, extras = [] } = params;
  const currentLocal = getCurrentStoredFirebaseConfig();
  let switched = false;

  if (resetToDefault || isSameFirebaseTarget(targetCfg, defaultFirebaseConfig)) {
    if (!isSameFirebaseTarget(currentLocal, defaultFirebaseConfig)) {
      switched = true;
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
    return switched;
  }

  if (!isSameFirebaseTarget(targetCfg, currentLocal)) {
    switched = true;
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
  return switched;
}

/**
 * Fetches the authoritative active Firebase pointer BEFORE firebase.ts initializes,
 * checking BOTH the Express server (/api/platform-db) AND Firestore /platform/migration REST chain
 * so BOTH AI Studio server deployments and static hosts (GitHub Pages / Netlify)
 * always route every visitor directly to the programmer's currently active database.
 */
export async function syncPlatformDbBeforeBoot(): Promise<InitialServerPlatformStatus> {
  if (typeof window === 'undefined') return initialServerStatus;

  let serverPtr: ServerPlatformPointer | null = null;
  let serverAllExhausted = false;
  let serverRevision = 0;
  let serverActiveId = 'primary_default';
  let serverActiveOrder = 1;
  let serverTotalDbs = 1;
  let backendAvailable = false;

  const tryServerPromise = (async () => {
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 3200);
      const resp = await fetch(`/api/platform-db?t=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      window.clearTimeout(timer);
      if (!resp.ok) return;
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) return;
      const payload = (await resp.json()) as {
        pointer?: ServerPlatformPointer | null;
        revision?: number;
        allExhausted?: boolean;
        activeDatabaseId?: string;
        activeOrder?: number;
        totalDatabases?: number;
      };
      if (payload?.pointer?.config) {
        backendAvailable = true;
        serverPtr = payload.pointer;
        serverAllExhausted = Boolean(payload.allExhausted ?? payload.pointer.allExhausted);
        serverRevision = Number(payload.revision ?? payload.pointer.revision ?? 1);
        serverActiveId = String(
          payload.activeDatabaseId || payload.pointer.activeDatabaseId || 'primary_default'
        );
        serverActiveOrder = Number(payload.activeOrder ?? payload.pointer.activeOrder ?? 1);
        serverTotalDbs = Number(payload.totalDatabases ?? payload.pointer.totalDatabases ?? 1);
      }
    } catch {
      // Static host (GitHub Pages / Netlify) or offline
    }
  })();

  const tryFirestoreRestPromise = resolveLatestFirestoreMigrationRest().catch(() => null);

  const [, restPtr] = await Promise.all([tryServerPromise, tryFirestoreRestPromise]);

  // Clear legacy ?fb= URL params when authoritative resolution ran
  if (backendAvailable || restPtr) {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('fb')) {
        url.searchParams.delete('fb');
        window.history.replaceState({}, '', url.toString());
      }
    } catch {
      // Ignore URL errors
    }
  }

  let chosenTarget: FirebaseAppConfig | null = null;
  let chosenResetToDefault = false;
  let chosenExtras: FirebaseAppConfig[] = [];

  if (serverPtr && (serverPtr as ServerPlatformPointer).config) {
    const sPtr = serverPtr as ServerPlatformPointer;
    const sCfg = sanitizeFirebaseConfig(sPtr.config);
    const serverUpdatedAt = Number(sPtr.updatedAt || 0);
    // Prefer server pointer when server was explicitly switched/rotated (revision > 1) or is newer than REST
    const restIsExplicitlyNewerCustom =
      restPtr &&
      serverRevision <= 1 &&
      isSameFirebaseTarget(sCfg || defaultFirebaseConfig, defaultFirebaseConfig) &&
      !isSameFirebaseTarget(restPtr.config, defaultFirebaseConfig) &&
      restPtr.updatedAtMs > serverUpdatedAt;

    if (restIsExplicitlyNewerCustom && restPtr) {
      chosenTarget = restPtr.config;
      chosenResetToDefault = restPtr.resetToDefault;
      chosenExtras = restPtr.previousConfigs;
    } else if (sCfg) {
      chosenTarget = sCfg;
      chosenResetToDefault = Boolean(sPtr.resetToDefault);
      chosenExtras = [
        ...(Array.isArray(sPtr.previousConfigs) ? sPtr.previousConfigs : []),
        ...(restPtr?.previousConfigs ?? []),
      ];
    }
  } else if (restPtr) {
    chosenTarget = restPtr.config;
    chosenResetToDefault = restPtr.resetToDefault;
    chosenExtras = restPtr.previousConfigs;
  }

  let switchedOnBoot = false;
  if (chosenTarget) {
    switchedOnBoot = persistResolvedTargetConfig({
      targetCfg: chosenTarget,
      resetToDefault: chosenResetToDefault,
      extras: chosenExtras,
    });
  }

  initialServerStatus = {
    serverSynced: backendAvailable || Boolean(restPtr),
    backendAvailable,
    switchedOnBoot,
    allExhausted: backendAvailable ? serverAllExhausted : false,
    revision: serverRevision,
    activeDatabaseId: serverActiveId,
    activeOrder: serverActiveOrder,
    totalDatabases: serverTotalDbs,
  };

  return initialServerStatus;
}
