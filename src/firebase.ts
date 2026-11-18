import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import {
  doc,
  getDocFromServer,
  getFirestore,
  type Firestore,
} from 'firebase/firestore';
import {
  clearStaleRoomAndSessionKeys,
  CONSOLIDATED_FROM_SESSION_KEY,
  CURRENT_DB_EPOCH,
  CUSTOM_CONFIG_STORAGE_KEY,
  DB_EPOCH_STORAGE_KEY,
  defaultFirebaseConfig,
  firebaseTargetKey,
  getInitialServerPlatformStatus,
  getPreviousFirebaseConfigs,
  isMasterProgrammerIdentity,
  isSameFirebaseTarget,
  MASTER_PROGRAMMER_EMAIL,
  MASTER_PROGRAMMER_NAME,
  normalizeArabicName,
  PENDING_REJOIN_ROOM_KEY,
  resolveLatestFirestoreMigrationRest,
  sanitizeFirebaseConfig,
  savePreviousFirebaseConfigs,
  SYNCED_SOURCES_KEY_PREFIX,
  type FirebaseAppConfig,
  type InitialServerPlatformStatus,
  type ResolvedRemotePointer,
  type ServerPlatformPointer,
} from './firebaseConfigBootstrap';

export {
  CURRENT_DB_EPOCH,
  defaultFirebaseConfig,
  firebaseTargetKey,
  getInitialServerPlatformStatus,
  getPreviousFirebaseConfigs,
  isMasterProgrammerIdentity,
  isSameFirebaseTarget,
  MASTER_PROGRAMMER_EMAIL,
  MASTER_PROGRAMMER_NAME,
  normalizeArabicName,
  resolveLatestFirestoreMigrationRest,
  sanitizeFirebaseConfig,
  savePreviousFirebaseConfigs,
  type FirebaseAppConfig,
  type InitialServerPlatformStatus,
  type ResolvedRemotePointer,
  type ServerPlatformPointer,
};

function toBase64Url(jsonText: string): string {
  const bytes = new TextEncoder().encode(jsonText);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export function encodeCompactFirebaseConfig(
  config: FirebaseAppConfig
): string {
  const payload: Record<string, string> = {
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    appId: config.appId,
    epoch: CURRENT_DB_EPOCH,
  };
  if (config.storageBucket) payload.storageBucket = config.storageBucket;
  if (config.messagingSenderId) {
    payload.messagingSenderId = config.messagingSenderId;
  }
  if (config.firestoreDatabaseId) {
    payload.firestoreDatabaseId = config.firestoreDatabaseId;
  }
  return toBase64Url(JSON.stringify(payload));
}

function decodeCompactFirebasePayload(encoded: string): {
  config: FirebaseAppConfig;
  epoch: string | null;
} | null {
  try {
    const json = fromBase64Url(encoded.trim());
    const parsed = JSON.parse(json) as unknown;
    const config = sanitizeFirebaseConfig(parsed);
    if (!config) return null;
    const rawEpoch =
      parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).epoch === 'string'
        ? ((parsed as Record<string, unknown>).epoch as string).trim()
        : null;
    return { config, epoch: rawEpoch || null };
  } catch {
    return null;
  }
}

export function decodeCompactFirebaseConfig(
  encoded: string
): FirebaseAppConfig | null {
  return decodeCompactFirebasePayload(encoded)?.config ?? null;
}

export function getSyncedSourceKeys(uid: string): string[] {
  try {
    const raw = localStorage.getItem(`${SYNCED_SOURCES_KEY_PREFIX}${uid}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function markSourceKeySynced(uid: string, sourceKey: string): void {
  try {
    const prev = getSyncedSourceKeys(uid);
    if (!prev.includes(sourceKey)) {
      localStorage.setItem(
        `${SYNCED_SOURCES_KEY_PREFIX}${uid}`,
        JSON.stringify([...prev, sourceKey].slice(-20))
      );
    }
  } catch {
    // Ignore storage errors
  }
}

function resolveInitialConfig(): {
  config: FirebaseAppConfig;
  isCustom: boolean;
  justConsolidatedFrom: string | null;
} {
  if (typeof window !== 'undefined') {
    try {
      const url = new URL(window.location.href);
      const fbParam = url.searchParams.get('fb');
      const roomParam = url.searchParams.get('room');
      const savedEpoch = localStorage.getItem(DB_EPOCH_STORAGE_KEY);
      const savedRaw = localStorage.getItem(CUSTOM_CONFIG_STORAGE_KEY);
      let savedCustom: FirebaseAppConfig | null = null;
      if (savedRaw) {
        try {
          const parsedSaved = sanitizeFirebaseConfig(JSON.parse(savedRaw));
          if (parsedSaved && !isSameFirebaseTarget(parsedSaved, defaultFirebaseConfig)) {
            savedCustom = parsedSaved;
          }
        } catch {
          savedCustom = null;
        }
      }

      const decodedPayload = fbParam ? decodeCompactFirebasePayload(fbParam) : null;
      const isNewEpochLink = decodedPayload?.epoch === CURRENT_DB_EPOCH;
      const legacyUrlCustom =
        decodedPayload &&
        !isNewEpochLink &&
        !isSameFirebaseTarget(decodedPayload.config, defaultFirebaseConfig)
          ? decodedPayload.config
          : null;

      // Consolidate anyone still on a custom database under the old system back to the primary database
      if (savedEpoch !== CURRENT_DB_EPOCH || legacyUrlCustom) {
        localStorage.setItem(DB_EPOCH_STORAGE_KEY, CURRENT_DB_EPOCH);

        if (!isNewEpochLink && (savedCustom || legacyUrlCustom)) {
          const legacyList: FirebaseAppConfig[] = [];
          if (savedCustom) legacyList.push(savedCustom);
          if (legacyUrlCustom) legacyList.push(legacyUrlCustom);

          savePreviousFirebaseConfigs(
            [...legacyList, ...getPreviousFirebaseConfigs()],
            defaultFirebaseConfig
          );
          localStorage.removeItem(CUSTOM_CONFIG_STORAGE_KEY);
          clearStaleRoomAndSessionKeys();

          let urlChanged = false;
          if (url.searchParams.has('fb')) {
            url.searchParams.delete('fb');
            urlChanged = true;
          }
          if (url.searchParams.has('room')) {
            url.searchParams.delete('room');
            urlChanged = true;
          }
          if (urlChanged) {
            window.history.replaceState({}, '', url.toString());
          }

          const consolidatedProject =
            savedCustom?.projectId || legacyUrlCustom?.projectId || defaultFirebaseConfig.projectId;
          try {
            sessionStorage.setItem(CONSOLIDATED_FROM_SESSION_KEY, consolidatedProject);
          } catch {
            // Ignore sessionStorage restrictions
          }

          return {
            config: defaultFirebaseConfig,
            isCustom: false,
            justConsolidatedFrom: consolidatedProject,
          };
        }
      }

      if (roomParam && /^[A-Z0-9_-]{4,16}$/i.test(roomParam.trim())) {
        localStorage.setItem(
          PENDING_REJOIN_ROOM_KEY,
          roomParam.trim().toUpperCase()
        );
      }

      if (decodedPayload && (isNewEpochLink || isSameFirebaseTarget(decodedPayload.config, defaultFirebaseConfig))) {
        const decoded = decodedPayload.config;
        const prevList = getPreviousFirebaseConfigs();
        const outgoing = savedCustom ?? defaultFirebaseConfig;
        if (!isSameFirebaseTarget(outgoing, decoded)) {
          savePreviousFirebaseConfigs([outgoing, defaultFirebaseConfig, ...prevList], decoded);
        }

        if (isSameFirebaseTarget(decoded, defaultFirebaseConfig)) {
          localStorage.removeItem(CUSTOM_CONFIG_STORAGE_KEY);
        } else {
          localStorage.setItem(
            CUSTOM_CONFIG_STORAGE_KEY,
            JSON.stringify(decoded)
          );
        }
        localStorage.setItem(DB_EPOCH_STORAGE_KEY, CURRENT_DB_EPOCH);
        url.searchParams.delete('fb');
        window.history.replaceState({}, '', url.toString());
        const custom = !isSameFirebaseTarget(decoded, defaultFirebaseConfig);
        return { config: decoded, isCustom: custom, justConsolidatedFrom: null };
      }

      if (savedCustom) {
        return { config: savedCustom, isCustom: true, justConsolidatedFrom: null };
      }
    } catch {
      // Ignore URL/storage errors in restricted contexts
    }
  }

  return {
    config: defaultFirebaseConfig,
    isCustom: false,
    justConsolidatedFrom: null,
  };
}

export function getTargetFirebaseAppName(projectId: string, firestoreDatabaseId?: string): string {
  const dbSeg = (firestoreDatabaseId || 'default')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  return `duoboard_target_${projectId}_${dbSeg || 'default'}`;
}

export function createFirestoreInstance(
  firebaseApp: FirebaseApp,
  config: FirebaseAppConfig
): Firestore {
  const dbId = (config.firestoreDatabaseId || '').trim();
  if (!dbId || dbId === '(default)') {
    return getFirestore(firebaseApp);
  }
  return getFirestore(firebaseApp, dbId);
}

const resolved = resolveInitialConfig();
export const activeFirebaseConfig: FirebaseAppConfig = resolved.config;
export const isCustomFirebaseConfig: boolean = resolved.isCustom;
export const activeProjectId: string = activeFirebaseConfig.projectId;
export const justConsolidatedFrom: string | null = resolved.justConsolidatedFrom;

export function consumeConsolidatedProjectNotice(): string | null {
  try {
    const val = sessionStorage.getItem(CONSOLIDATED_FROM_SESSION_KEY);
    if (val) {
      sessionStorage.removeItem(CONSOLIDATED_FROM_SESSION_KEY);
      return val;
    }
    return null;
  } catch {
    return null;
  }
}

export function buildCleanPrimaryUrl(): string {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('fb');
    url.searchParams.delete('room');
    return url.toString();
  } catch {
    return typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : '/';
  }
}

const app = isCustomFirebaseConfig
  ? initializeApp(
      activeFirebaseConfig,
      getTargetFirebaseAppName(
        activeFirebaseConfig.projectId,
        activeFirebaseConfig.firestoreDatabaseId
      )
    )
  : initializeApp(activeFirebaseConfig);

export const db = createFirestoreInstance(app, activeFirebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

const upgradeDbSegment =
  (activeFirebaseConfig.firestoreDatabaseId || '').trim() || '(default)';
export const UPGRADE_FIRESTORE_URL = `https://console.firebase.google.com/project/${activeFirebaseConfig.projectId}/firestore/databases/${upgradeDbSegment}/data?openUpgradeDialog=true`;

export function activateCustomFirebaseConfig(
  config: FirebaseAppConfig,
  roomId?: string | null,
  extraPreviousConfigs: FirebaseAppConfig[] = []
): void {
  try {
    localStorage.setItem(DB_EPOCH_STORAGE_KEY, CURRENT_DB_EPOCH);
    const existingPrev = getPreviousFirebaseConfigs();
    savePreviousFirebaseConfigs(
      [activeFirebaseConfig, defaultFirebaseConfig, ...extraPreviousConfigs, ...existingPrev],
      config
    );
    if (isSameFirebaseTarget(config, defaultFirebaseConfig)) {
      localStorage.removeItem(CUSTOM_CONFIG_STORAGE_KEY);
    } else {
      localStorage.setItem(CUSTOM_CONFIG_STORAGE_KEY, JSON.stringify(config));
    }
    if (roomId && /^[A-Z0-9_-]{4,16}$/i.test(roomId.trim())) {
      localStorage.setItem(PENDING_REJOIN_ROOM_KEY, roomId.trim().toUpperCase());
    }
  } catch {
    // Ignore storage errors
  }
}

export function resetToDefaultFirebaseConfig(): void {
  try {
    localStorage.setItem(DB_EPOCH_STORAGE_KEY, CURRENT_DB_EPOCH);
    const existingPrev = getPreviousFirebaseConfigs();
    savePreviousFirebaseConfigs([activeFirebaseConfig, ...existingPrev], defaultFirebaseConfig);
    localStorage.removeItem(CUSTOM_CONFIG_STORAGE_KEY);
    clearStaleRoomAndSessionKeys();
  } catch {
    // Ignore storage errors
  }
}

export function getPendingRejoinRoom(): string | null {
  try {
    const raw = localStorage.getItem(PENDING_REJOIN_ROOM_KEY);
    if (raw && /^[A-Z0-9_-]{4,16}$/.test(raw.trim().toUpperCase())) {
      return raw.trim().toUpperCase();
    }
    return null;
  } catch {
    return null;
  }
}

export function clearPendingRejoinRoom(): void {
  try {
    localStorage.removeItem(PENDING_REJOIN_ROOM_KEY);
  } catch {
    // Ignore storage errors
  }
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function isQuotaError(err: unknown): boolean {
  const msg = (
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err)
  ).toLowerCase();
  return (
    msg.includes('quota exceeded') ||
    msg.includes('resource-exhausted') ||
    msg.includes('resource_exhausted')
  );
}

type QuotaErrorListener = (info: FirestoreErrorInfo) => void;
const quotaListeners = new Set<QuotaErrorListener>();

export function subscribeQuotaError(
  listener: QuotaErrorListener
): () => void {
  quotaListeners.add(listener);
  return () => {
    quotaListeners.delete(listener);
  };
}

export function emitQuotaError(info: FirestoreErrorInfo): void {
  quotaListeners.forEach((listener) => {
    try {
      listener(info);
    } catch {
      // Ignore subscriber errors
    }
  });
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  if (isQuotaError(error)) {
    emitQuotaError(errInfo);
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

export function isQuadNameValid(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 5 || trimmed.length > 120) return false;
  const parts = trimmed.split(/\s+/).filter((w) => w.length >= 2);
  return parts.length >= 4;
}

export function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export async function compressImageToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('تعذر قراءة ملف الصورة'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('تنسيق الصورة غير مدعوم'));
      img.onload = () => {
        const maxDim = 900;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('تعذر معالجة الصورة'));
          return;
        }
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        let quality = 0.72;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while (dataUrl.length > 260000 && quality > 0.3) {
          quality -= 0.1;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        if (dataUrl.length > 275000) {
          reject(new Error('حجم الصورة كبير جداً، يرجى اختيار صورة أصغر'));
          return;
        }
        resolve(dataUrl);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export function formatTimestamp(ts: unknown): string {
  if (!ts) return 'الآن';
  if (
    typeof ts === 'object' &&
    ts !== null &&
    'toDate' in ts &&
    typeof (ts as { toDate: () => Date }).toDate === 'function'
  ) {
    const d = (ts as { toDate: () => Date }).toDate();
    return d.toLocaleDateString('ar-SA', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return 'الآن';
}

export function getTimestampMillis(ts: unknown): number {
  if (!ts) return 0;
  if (
    typeof ts === 'object' &&
    ts !== null &&
    'toMillis' in ts &&
    typeof (ts as { toMillis: () => number }).toMillis === 'function'
  ) {
    return (ts as { toMillis: () => number }).toMillis();
  }
  return 0;
}
