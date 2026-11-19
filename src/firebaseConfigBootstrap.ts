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

export interface BackupSignalPayload {
  backupDbId: string;
  backupProjectId: string;
  targetProjectId: string;
  targetConfig: FirebaseAppConfig;
  migratedRoomId?: string | null;
  announcedAt: number;
}

export interface ServerPlatformPointer {
  id: 'migration';
  config: FirebaseAppConfig;
  resetToDefault?: boolean;
  migratedRoomId?: string | null;
  migrationEpoch?: string;
  previousConfigs?: FirebaseAppConfig[];
  backupConfigs?: FirebaseAppConfig[];
  activePlayerDatabaseId?: string | null;
  lastBackupAnnouncement?: BackupSignalPayload | null;
  revision?: number;
  updatedByEmail?: string;
  updatedAt?: number;
}

export interface PublicDatabaseSummary {
  id: string;
  order: number;
  label: string;
  config: FirebaseAppConfig;
  lastUsedAt?: number | null;
  addedAt: number;
}

export interface InitialServerPlatformStatus {
  serverSynced: boolean;
  backendAvailable: boolean;
  switchedOnBoot: boolean;
  revision: number;
  activePlayerDatabaseId: string | null;
  playerDatabasesCount: number;
  backupDatabasesCount: number;
  playerDatabases: PublicDatabaseSummary[];
  backupSignalProjectId?: string | null;
}

export const defaultFirebaseConfig: FirebaseAppConfig =
  defaultFirebaseConfigJson as FirebaseAppConfig;

export const MASTER_PROGRAMMER_NAME = 'محمد منتصر محمد يونس';
export const MASTER_PROGRAMMER_EMAIL = 'mohammedmonta2022m@gmail.com';
export const MASTER_PROGRAMMER_EMAILS = [
  'mohammedmonta2022m@gmail.com',
  'qdrat2626@gmail.com',
] as const;

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
  if (
    emailLower &&
    (MASTER_PROGRAMMER_EMAILS as readonly string[]).includes(emailLower)
  ) {
    return true;
  }
  const norm = normalizeArabicName(identity.fullNameQuad);
  return Boolean(norm && norm === normalizeArabicName(MASTER_PROGRAMMER_NAME));
}

export const CUSTOM_CONFIG_STORAGE_KEY = 'duoboard_custom_firebase_config_v1';
export const PREV_CONFIGS_STORAGE_KEY = 'duoboard_prev_firebase_configs_v1';
export const BACKUP_CONFIGS_STORAGE_KEY = 'duoboard_backup_configs_v1';
export const LAST_APPLIED_BACKUP_TS_KEY = 'duoboard_last_backup_doc_ts_v1';
export const PENDING_REJOIN_ROOM_KEY = 'duoboard_pending_rejoin_room';
export const SYNCED_SOURCES_KEY_PREFIX = 'duoboard_synced_sources_v1_';
export const ACTIVE_ROOM_STORAGE_PREFIX = 'duoboard_active_room_';
export const DB_EPOCH_STORAGE_KEY = 'duoboard_db_epoch_v1';
export const CONSOLIDATED_FROM_SESSION_KEY = 'duoboard_consolidated_from_project';
export const SWITCH_REQUIRE_LOGIN_KEY = 'duoboard_switched_require_login_v1';
export const LEGACY_STATIC_POOL_KEY = 'duoboard_static_programmer_pool_v1';
export const PUBLIC_PLAYER_DBS_STORAGE_KEY = 'duoboard_public_player_dbs_v1';
export const MANUAL_DB_PIN_KEY = 'duoboard_manual_db_pin_v1';
export const CURRENT_DB_EPOCH = 'qdrat1_base_v4_2026_11_19';

export interface BootProgress {
  percent: number;
  title: string;
  subtitle: string;
  detail?: string;
}

let initialServerStatus: InitialServerPlatformStatus = {
  serverSynced: false,
  backendAvailable: false,
  switchedOnBoot: false,
  revision: 0,
  activePlayerDatabaseId: null,
  playerDatabasesCount: 0,
  backupDatabasesCount: 0,
  playerDatabases: [],
  backupSignalProjectId: null,
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

export function getBackupFirebaseConfigs(): FirebaseAppConfig[] {
  try {
    const raw = localStorage.getItem(BACKUP_CONFIGS_STORAGE_KEY);
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

export function saveBackupFirebaseConfigs(configs: FirebaseAppConfig[]): void {
  try {
    const deduped: FirebaseAppConfig[] = [];
    for (const raw of configs) {
      const cfg = sanitizeFirebaseConfig(raw);
      if (!cfg) continue;
      if (!deduped.some((x) => isSameFirebaseTarget(x, cfg))) {
        deduped.push(cfg);
      }
    }
    localStorage.setItem(BACKUP_CONFIGS_STORAGE_KEY, JSON.stringify(deduped.slice(0, 25)));
  } catch {
    // Ignore storage errors
  }
}

export function getLastAppliedBackupDocTs(): number {
  try {
    const raw = localStorage.getItem(LAST_APPLIED_BACKUP_TS_KEY);
    const num = raw ? Number(raw) : 0;
    return Number.isFinite(num) && num > 0 ? num : 0;
  } catch {
    return 0;
  }
}

export function setLastAppliedBackupDocTs(ts: number): void {
  try {
    if (Number.isFinite(ts) && ts > 0) {
      localStorage.setItem(LAST_APPLIED_BACKUP_TS_KEY, String(ts));
    }
  } catch {
    // Ignore storage errors
  }
}

export function getPublicPlayerDatabases(): PublicDatabaseSummary[] {
  try {
    const raw = localStorage.getItem(PUBLIC_PLAYER_DBS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PublicDatabaseSummary[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const d = item as Record<string, unknown>;
      const cfg = sanitizeFirebaseConfig(d.config);
      if (!cfg || out.some((x) => isSameFirebaseTarget(x.config, cfg))) continue;
      out.push({
        id: typeof d.id === 'string' && d.id ? d.id : `pub_${out.length + 1}_${cfg.projectId}`,
        order: typeof d.order === 'number' ? d.order : out.length + 1,
        label:
          typeof d.label === 'string' && d.label.trim()
            ? d.label.trim().slice(0, 80)
            : cfg.projectId,
        config: cfg,
        lastUsedAt: typeof d.lastUsedAt === 'number' ? d.lastUsedAt : null,
        addedAt: typeof d.addedAt === 'number' ? d.addedAt : Date.now(),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function savePublicPlayerDatabases(list: PublicDatabaseSummary[]): void {
  try {
    const deduped: PublicDatabaseSummary[] = [];
    for (const item of list) {
      const cfg = sanitizeFirebaseConfig(item?.config);
      if (!cfg || deduped.some((x) => isSameFirebaseTarget(x.config, cfg))) continue;
      deduped.push({
        id: item.id || `pub_${deduped.length + 1}_${cfg.projectId}`,
        order: deduped.length + 1,
        label: (item.label || cfg.projectId).trim().slice(0, 80),
        config: cfg,
        lastUsedAt: typeof item.lastUsedAt === 'number' ? item.lastUsedAt : null,
        addedAt: typeof item.addedAt === 'number' ? item.addedAt : Date.now(),
      });
    }
    localStorage.setItem(PUBLIC_PLAYER_DBS_STORAGE_KEY, JSON.stringify(deduped.slice(0, 25)));
  } catch {
    // Ignore storage errors
  }
}

export function getManualDbPin(): { targetKey: string; pinnedRevision: number } | null {
  try {
    const raw = localStorage.getItem(MANUAL_DB_PIN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { targetKey?: string; pinnedRevision?: number };
    if (parsed && typeof parsed.targetKey === 'string' && parsed.targetKey) {
      return {
        targetKey: parsed.targetKey,
        pinnedRevision: Number(parsed.pinnedRevision || 0),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function setManualDbPin(config: FirebaseAppConfig, revision = 0): void {
  try {
    localStorage.setItem(
      MANUAL_DB_PIN_KEY,
      JSON.stringify({
        targetKey: firebaseTargetKey(config),
        pinnedRevision: Number(revision || 0),
      })
    );
  } catch {
    // Ignore storage errors
  }
}

export function clearManualDbPin(): void {
  try {
    localStorage.removeItem(MANUAL_DB_PIN_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function wipeLegacyDatabaseStorage(): void {
  try {
    localStorage.removeItem(LEGACY_STATIC_POOL_KEY);
    localStorage.removeItem(CUSTOM_CONFIG_STORAGE_KEY);
    localStorage.removeItem(PREV_CONFIGS_STORAGE_KEY);
    localStorage.removeItem(BACKUP_CONFIGS_STORAGE_KEY);
    localStorage.removeItem(PUBLIC_PLAYER_DBS_STORAGE_KEY);
    localStorage.removeItem(MANUAL_DB_PIN_KEY);
    localStorage.removeItem(LAST_APPLIED_BACKUP_TS_KEY);
    localStorage.removeItem(PENDING_REJOIN_ROOM_KEY);
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (
        k &&
        (k.startsWith(ACTIVE_ROOM_STORAGE_PREFIX) || k.startsWith(SYNCED_SOURCES_KEY_PREFIX))
      ) {
        toRemove.push(k);
      }
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // Ignore storage errors
  }
  try {
    sessionStorage.removeItem('duoboard_auto_switched_to');
    sessionStorage.removeItem('duoboard_self_migrated_target');
  } catch {
    // Ignore sessionStorage errors
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
  announcedFromBackupProjectId?: string;
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
 * Checks configured untouched Backup Databases via public REST ONLY when queried
 * (on boot / fallback / quota error) to discover if a Backup DB woke up and announced
 * a newer target Player DB.
 */
export async function resolveBackupAnnouncementsRest(
  extraBackupSeeds: FirebaseAppConfig[] = []
): Promise<ResolvedRemotePointer | null> {
  if (typeof window === 'undefined') return null;
  const seeds = [...getBackupFirebaseConfigs(), ...extraBackupSeeds].filter(
    (c, idx, arr) => arr.findIndex((x) => isSameFirebaseTarget(x, c)) === idx
  );
  if (seeds.length === 0) return null;

  const results = await Promise.all(
    seeds.map(async (bCfg) => {
      const res = await fetchFirestoreMigrationPointerRest(bCfg, 2600);
      if (res.status !== 'ok') return null;
      if (res.pointer.migrationEpoch !== CURRENT_DB_EPOCH) return null;
      return {
        ...res.pointer,
        announcedFromBackupProjectId: bCfg.projectId,
      } as ResolvedRemotePointer;
    })
  );

  let newest: ResolvedRemotePointer | null = null;
  for (const ptr of results) {
    if (!ptr) continue;
    if (!newest || ptr.updatedAtMs >= newest.updatedAtMs) {
      newest = ptr;
    }
  }
  return newest;
}

/**
 * Resolves the latest target pointer from configured Backup DBs + active/previous Player DB chain.
 */
export async function resolveLatestFirestoreMigrationRest(
  extraSeeds: FirebaseAppConfig[] = []
): Promise<ResolvedRemotePointer | null> {
  if (typeof window === 'undefined') return null;

  const backupPtr = await resolveBackupAnnouncementsRest(extraSeeds);

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
  let best: ResolvedRemotePointer | null = backupPtr;
  const allCollectedConfigs: FirebaseAppConfig[] = [...initialSeeds];

  for (let hop = 0; hop < 4 && frontier.length > 0; hop++) {
    const batch = frontier.filter((c) => {
      const k = firebaseTargetKey(c);
      if (visited.has(k)) return false;
      visited.add(k);
      return true;
    });
    if (batch.length === 0) break;

    const results = await Promise.all(
      batch.map((cfg) => fetchFirestoreMigrationPointerRest(cfg, hop === 0 ? 2500 : 2000))
    );

    const nextFrontier: FirebaseAppConfig[] = [];
    for (const res of results) {
      if (res.status !== 'ok') continue;
      const ptr = res.pointer;
      if (ptr.migrationEpoch !== CURRENT_DB_EPOCH) continue;

      if (!allCollectedConfigs.some((x) => isSameFirebaseTarget(x, ptr.config))) {
        allCollectedConfigs.push(ptr.config);
      }
      for (const prev of ptr.previousConfigs) {
        if (!allCollectedConfigs.some((x) => isSameFirebaseTarget(x, prev))) {
          allCollectedConfigs.push(prev);
        }
      }

      if (!best || ptr.updatedAtMs > best.updatedAtMs) {
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
  announcedDocTs?: number;
}): boolean {
  const { targetCfg, resetToDefault, extras = [], announcedDocTs } = params;
  const currentLocal = getCurrentStoredFirebaseConfig();
  let previousEpoch: string | null = null;
  try {
    previousEpoch = localStorage.getItem(DB_EPOCH_STORAGE_KEY);
  } catch {
    previousEpoch = null;
  }
  const epochChanged = Boolean(previousEpoch !== CURRENT_DB_EPOCH);
  if (epochChanged) {
    wipeLegacyDatabaseStorage();
  }

  let switched = false;

  if (resetToDefault || isSameFirebaseTarget(targetCfg, defaultFirebaseConfig)) {
    if (!isSameFirebaseTarget(currentLocal, defaultFirebaseConfig) || epochChanged) {
      switched = !isSameFirebaseTarget(currentLocal, defaultFirebaseConfig);
      if (switched) {
        savePreviousFirebaseConfigs(
          [currentLocal, ...extras, ...getPreviousFirebaseConfigs()],
          defaultFirebaseConfig
        );
      }
      localStorage.removeItem(CUSTOM_CONFIG_STORAGE_KEY);
      clearStaleRoomAndSessionKeys();
    } else if (extras.length > 0) {
      savePreviousFirebaseConfigs(
        [...extras, ...getPreviousFirebaseConfigs()],
        defaultFirebaseConfig
      );
    }
    localStorage.setItem(DB_EPOCH_STORAGE_KEY, CURRENT_DB_EPOCH);
    if (announcedDocTs) setLastAppliedBackupDocTs(announcedDocTs);
    return switched;
  }

  if (!isSameFirebaseTarget(targetCfg, currentLocal) || epochChanged) {
    switched = !isSameFirebaseTarget(targetCfg, currentLocal);
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
  if (announcedDocTs) setLastAppliedBackupDocTs(announcedDocTs);
  return switched;
}

export function markSwitchRequiresLogin(config: FirebaseAppConfig): void {
  try {
    sessionStorage.setItem(SWITCH_REQUIRE_LOGIN_KEY, firebaseTargetKey(config));
  } catch {
    // Ignore sessionStorage restrictions
  }
}

export function hasSwitchRequiresLogin(config: FirebaseAppConfig): boolean {
  try {
    return sessionStorage.getItem(SWITCH_REQUIRE_LOGIN_KEY) === firebaseTargetKey(config);
  } catch {
    return false;
  }
}

export function clearSwitchRequiresLogin(): void {
  try {
    sessionStorage.removeItem(SWITCH_REQUIRE_LOGIN_KEY);
  } catch {
    // Ignore sessionStorage restrictions
  }
}

export async function syncPlatformDbBeforeBoot(
  onProgress?: (progress: BootProgress) => void
): Promise<InitialServerPlatformStatus> {
  if (typeof window === 'undefined') return initialServerStatus;

  // Wipe old epoch DB pool keys immediately on first boot into new epoch
  try {
    const savedEpoch = localStorage.getItem(DB_EPOCH_STORAGE_KEY);
    if (savedEpoch !== CURRENT_DB_EPOCH) {
      wipeLegacyDatabaseStorage();
      localStorage.setItem(DB_EPOCH_STORAGE_KEY, CURRENT_DB_EPOCH);
    }
  } catch {
    // Ignore storage errors
  }

  onProgress?.({
    percent: 18,
    title: 'جاري التحميل، الرجاء الانتظار قليلاً...',
    subtitle: 'يتم الآن الاتصال بالمنصة للتحقق من قاعدة البيانات المعتمدة',
    detail: 'جاري فحص التوجيه والتهيئة',
  });

  let serverPtr: ServerPlatformPointer | null = null;
  let serverRevision = 0;
  let serverActivePlayerDbId: string | null = null;
  let playerCount = 0;
  let backupCount = 0;
  let publicPlayerDbs: PublicDatabaseSummary[] = getPublicPlayerDatabases();
  let backendAvailable = false;
  let backupSignalProjectId: string | null = null;

  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 3200);
    const resp = await fetch(`/api/platform-db?t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    const contentType = resp.headers.get('content-type') || '';
    if (resp.ok && contentType.includes('application/json')) {
      const payload = (await resp.json()) as {
        pointer?: ServerPlatformPointer | null;
        revision?: number;
        activePlayerDatabaseId?: string | null;
        playerDatabasesCount?: number;
        backupDatabasesCount?: number;
        playerDatabases?: PublicDatabaseSummary[];
        backupConfigs?: FirebaseAppConfig[];
      };
      if (payload?.pointer?.config) {
        backendAvailable = true;
        serverPtr = payload.pointer;
        serverRevision = Number(payload.revision ?? payload.pointer.revision ?? 1);
        serverActivePlayerDbId = payload.activePlayerDatabaseId ?? payload.pointer.activePlayerDatabaseId ?? null;
        playerCount = Number(payload.playerDatabasesCount ?? 0);
        backupCount = Number(payload.backupDatabasesCount ?? 0);
        backupSignalProjectId = payload.pointer.lastBackupAnnouncement?.backupProjectId || null;

        if (Array.isArray(payload.playerDatabases)) {
          savePublicPlayerDatabases(payload.playerDatabases);
          publicPlayerDbs = getPublicPlayerDatabases();
        }
        if (Array.isArray(payload.backupConfigs)) {
          saveBackupFirebaseConfigs(payload.backupConfigs);
        }
      }
    }
  } catch {
    // Static host or server offline
  }

  onProgress?.({
    percent: 58,
    title: 'جاري التحميل، الرجاء الانتظار قليلاً...',
    subtitle: 'يتم التحقق من إعلانات القواعد الاحتياطية وتجهيز قاعدة اللاعبين النشطة',
    detail: backendAvailable ? 'تم استلام حالة المنصة' : 'فحص الإعلان الاحتياطي السحابي...',
  });

  // Only query Backup DB(s) via REST if backend isn't available OR if server hasn't switched away from default yet
  let restPtr: ResolvedRemotePointer | null = null;
  if (!backendAvailable || (serverPtr && isSameFirebaseTarget(serverPtr.config, defaultFirebaseConfig) && getBackupFirebaseConfigs().length > 0)) {
    restPtr = await resolveLatestFirestoreMigrationRest().catch(() => null);
  }

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
  let chosenDocTs: number | undefined;

  const sCfg = serverPtr ? sanitizeFirebaseConfig(serverPtr.config) : null;
  const lastAppliedTs = getLastAppliedBackupDocTs();

  const restOverridesFreshServer =
    Boolean(restPtr) &&
    restPtr!.migrationEpoch === CURRENT_DB_EPOCH &&
    restPtr!.updatedAtMs > lastAppliedTs &&
    serverRevision <= 1 &&
    Boolean(sCfg && isSameFirebaseTarget(sCfg, defaultFirebaseConfig)) &&
    !isSameFirebaseTarget(restPtr!.config, defaultFirebaseConfig);

  if (restOverridesFreshServer && restPtr) {
    chosenTarget = restPtr.config;
    chosenResetToDefault = restPtr.resetToDefault;
    chosenExtras = restPtr.previousConfigs;
    chosenDocTs = restPtr.updatedAtMs;
    if (restPtr.announcedFromBackupProjectId) {
      backupSignalProjectId = restPtr.announcedFromBackupProjectId;
    }
  } else if (sCfg) {
    chosenTarget = sCfg;
    chosenResetToDefault = Boolean(serverPtr?.resetToDefault);
    chosenExtras = [
      ...(Array.isArray(serverPtr?.previousConfigs) ? serverPtr!.previousConfigs! : []),
      ...(restPtr?.previousConfigs ?? []),
    ];
  } else if (restPtr && restPtr.updatedAtMs > lastAppliedTs) {
    chosenTarget = restPtr.config;
    chosenResetToDefault = restPtr.resetToDefault;
    chosenExtras = restPtr.previousConfigs;
    chosenDocTs = restPtr.updatedAtMs;
    if (restPtr.announcedFromBackupProjectId) {
      backupSignalProjectId = restPtr.announcedFromBackupProjectId;
    }
  }

  let switchedOnBoot = false;
  const manualPin = getManualDbPin();
  const currentStoredCfg = getCurrentStoredFirebaseConfig();
  const manualPinMatchesCurrent =
    Boolean(manualPin) && manualPin!.targetKey === firebaseTargetKey(currentStoredCfg);
  const manualPinStillValid =
    manualPinMatchesCurrent &&
    (!serverRevision || serverRevision <= manualPin!.pinnedRevision) &&
    !restOverridesFreshServer;

  if (manualPin && !manualPinStillValid) {
    clearManualDbPin();
  }

  if (chosenTarget && !manualPinStillValid) {
    switchedOnBoot = persistResolvedTargetConfig({
      targetCfg: chosenTarget,
      resetToDefault: chosenResetToDefault,
      extras: chosenExtras,
      announcedDocTs: chosenDocTs,
    });
    if (switchedOnBoot) {
      let isSelfInitiated = false;
      try {
        isSelfInitiated =
          sessionStorage.getItem('duoboard_self_migrated_target') ===
          firebaseTargetKey(chosenTarget);
      } catch {
        // Ignore sessionStorage restrictions
      }
      if (!isSelfInitiated) {
        markSwitchRequiresLogin(chosenTarget);
      }
      if (serverPtr?.migratedRoomId) {
        try {
          localStorage.setItem(PENDING_REJOIN_ROOM_KEY, serverPtr.migratedRoomId);
        } catch {
          // Ignore storage
        }
      } else if (restPtr?.migratedRoomId) {
        try {
          localStorage.setItem(PENDING_REJOIN_ROOM_KEY, restPtr.migratedRoomId);
        } catch {
          // Ignore storage
        }
      }
    }
  }

  if (!switchedOnBoot) {
    onProgress?.({
      percent: 100,
      title: 'تم التحقق من القاعدة المعتمدة بنجاح!',
      subtitle: 'جاري فتح السبورة التفاعلية الآن...',
    });
  }

  initialServerStatus = {
    serverSynced: backendAvailable || Boolean(restPtr),
    backendAvailable,
    switchedOnBoot,
    revision: serverRevision,
    activePlayerDatabaseId: serverActivePlayerDbId,
    playerDatabasesCount: Math.max(playerCount, publicPlayerDbs.length),
    backupDatabasesCount: backupCount,
    playerDatabases: publicPlayerDbs,
    backupSignalProjectId,
  };

  return initialServerStatus;
}
