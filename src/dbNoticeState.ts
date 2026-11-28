import { firebaseTargetKey, type FirebaseAppConfig } from './firebaseConfigBootstrap';

export type DbNoticeId =
  | 'consolidated_notice'
  | 'sync_success'
  | 'needs_interactive_sync'
  | 'quota_alert'
  | 'quota_capacity_strip'
  | 'quota_selector_auto'
  | 'rules_outdated_banner'
  | 'rules_outdated_modal';

const DISMISSED_DB_NOTICES_STORAGE_KEY = 'duoboard_dismissed_db_notices_v1';
const PERSONAL_SYNC_DONE_STORAGE_KEY = 'duoboard_personal_sync_done_v1';

type DismissedMap = Record<string, Record<string, number>>;
type PersonalSyncDoneMap = Record<string, number>;

function readDismissedMap(): DismissedMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(DISMISSED_DB_NOTICES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as DismissedMap;
  } catch {
    return {};
  }
}

function writeDismissedMap(map: DismissedMap): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const keys = Object.keys(map);
    const trimmed: DismissedMap = {};
    for (const k of keys.slice(-24)) {
      if (map[k] && typeof map[k] === 'object') {
        trimmed[k] = map[k];
      }
    }
    localStorage.setItem(DISMISSED_DB_NOTICES_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore storage errors
  }
}

export function isDbNoticeDismissed(
  noticeId: DbNoticeId,
  dbTargetKey: string
): boolean {
  if (!dbTargetKey) return false;
  const map = readDismissedMap();
  const bucket = map[dbTargetKey];
  if (!bucket || typeof bucket !== 'object') return false;
  return Boolean(bucket[noticeId]);
}

export function dismissDbNotice(
  noticeId: DbNoticeId,
  dbTargetKey: string
): void {
  if (!dbTargetKey) return;
  const map = readDismissedMap();
  const prevBucket =
    map[dbTargetKey] && typeof map[dbTargetKey] === 'object'
      ? map[dbTargetKey]
      : {};
  map[dbTargetKey] = {
    ...prevBucket,
    [noticeId]: Date.now(),
  };
  writeDismissedMap(map);
}

export function clearDismissedDbNoticesForTarget(
  target: string | FirebaseAppConfig
): void {
  const dbTargetKey =
    typeof target === 'string' ? target : firebaseTargetKey(target);
  if (!dbTargetKey) return;
  const map = readDismissedMap();
  if (dbTargetKey in map) {
    delete map[dbTargetKey];
    writeDismissedMap(map);
  }
}

function readPersonalSyncDoneMap(): PersonalSyncDoneMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(PERSONAL_SYNC_DONE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as PersonalSyncDoneMap;
  } catch {
    return {};
  }
}

function writePersonalSyncDoneMap(map: PersonalSyncDoneMap): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const entries = Object.entries(map).slice(-32);
    localStorage.setItem(
      PERSONAL_SYNC_DONE_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries))
    );
  } catch {
    // Ignore storage errors
  }
}

export function hasCompletedPersonalSyncForDb(
  uid: string,
  dbTargetKey: string
): boolean {
  if (!uid || !dbTargetKey) return false;
  const map = readPersonalSyncDoneMap();
  return Boolean(map[`${uid}::${dbTargetKey}`]);
}

export function markCompletedPersonalSyncForDb(
  uid: string,
  dbTargetKey: string
): void {
  if (!uid || !dbTargetKey) return;
  const map = readPersonalSyncDoneMap();
  map[`${uid}::${dbTargetKey}`] = Date.now();
  writePersonalSyncDoneMap(map);
}

export function clearPersonalSyncForTarget(
  target: string | FirebaseAppConfig
): void {
  const dbTargetKey =
    typeof target === 'string' ? target : firebaseTargetKey(target);
  if (!dbTargetKey) return;
  const map = readPersonalSyncDoneMap();
  let changed = false;
  for (const key of Object.keys(map)) {
    if (key.endsWith(`::${dbTargetKey}`)) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) {
    writePersonalSyncDoneMap(map);
  }
}
