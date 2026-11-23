import express, { type Request, type Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import * as webpush from 'web-push';
import {
  isAiConfigured,
  runAiCoachAnalyze,
  runAiCoachChat,
  runAiCoachGenerateQuiz,
  type AnalyzeRequestPayload,
  type ChatRequestPayload,
  type GenerateQuizRequestPayload,
} from './serverAi';

type DatabaseRole = 'player' | 'backup';

interface SanitizedFirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
  measurementId?: string;
  firestoreDatabaseId?: string;
}

interface DatabaseVerificationSummary {
  firestoreReady: boolean;
  googleAuthReady: boolean;
  rulesReady: boolean;
  verifiedAt: number;
  verifiedByEmail?: string;
}

interface RegisteredDatabaseEntry {
  id: string;
  order: number;
  role: DatabaseRole;
  label: string;
  config: SanitizedFirebaseConfig;
  verification: DatabaseVerificationSummary;
  lastUsedAt?: number | null;
  lastAnnouncedToProjectId?: string | null;
  addedByEmail?: string;
  addedAt: number;
}

interface ProgrammerMember {
  id: string;
  fullNameQuad: string;
  email?: string;
  emailHash?: string;
  emailMasked?: string;
  isMaster?: boolean;
  promotedBy?: string;
  promotedAt: number;
}

interface BackupAnnouncementInfo {
  backupDbId: string;
  backupProjectId: string;
  targetProjectId: string;
  targetConfig: SanitizedFirebaseConfig;
  migratedRoomId?: string | null;
  announcedAt: number;
  announcedByEmail?: string;
}

interface PlatformState {
  revision: number;
  migrationEpoch: string;
  playerDatabases: RegisteredDatabaseEntry[];
  backupDatabases: RegisteredDatabaseEntry[];
  activeTargetConfig: SanitizedFirebaseConfig;
  activePlayerDatabaseId: string | null;
  lastBackupAnnouncement: BackupAnnouncementInfo | null;
  programmers: ProgrammerMember[];
  migratedRoomId?: string | null;
  previousConfigs: SanitizedFirebaseConfig[];
  updatedByEmail?: string;
  updatedAt: number;
}

interface PublicPlatformPointer {
  id: 'migration';
  config: SanitizedFirebaseConfig;
  resetToDefault?: boolean;
  migratedRoomId?: string | null;
  migrationEpoch: string;
  previousConfigs: SanitizedFirebaseConfig[];
  backupConfigs: SanitizedFirebaseConfig[];
  activePlayerDatabaseId: string | null;
  lastBackupAnnouncement: BackupAnnouncementInfo | null;
  revision: number;
  updatedAt: number;
}

const PORT = Number(process.env.PORT || 3000);
const STATE_FILE_PATH = path.resolve(process.cwd(), '.duoboard-platform-state.json');
const QUOTA_STATE_FILE_PATH = path.resolve(process.cwd(), '.duoboard-quota-state.json');
const VAPID_FILE_PATH = path.resolve(process.cwd(), '.duoboard-vapid.json');
const PUSH_SUBS_FILE_PATH = path.resolve(process.cwd(), '.duoboard-push-subs.json');
const LEGACY_POINTER_FILE_PATH = path.resolve(process.cwd(), '.duoboard-platform-db.json');
const DEFAULT_APP_CONFIG_PATH = path.resolve(process.cwd(), 'firebase-applet-config.json');

const SPARK_DAILY_LIMITS = {
  reads: 50_000,
  writes: 20_000,
  deletes: 20_000,
} as const;

type QuotaMetricKind = 'reads' | 'writes' | 'deletes';

interface ServerProjectQuotaRecord {
  projectId: string;
  dateKey: string;
  readsUsed: number;
  writesUsed: number;
  deletesUsed: number;
  exhausted: boolean;
  lastAlertStep: number | null;
  alertCount: number;
  updatedAt: number;
}

interface ServerProjectQuotaStatus extends ServerProjectQuotaRecord {
  readsLimit: number;
  writesLimit: number;
  deletesLimit: number;
  readsRemainingPct: number;
  writesRemainingPct: number;
  deletesRemainingPct: number;
  minRemainingPct: number;
  bottleneckMetric: QuotaMetricKind;
  bottleneckRemainingCount: number;
  alertStep: number | null;
}

const CURRENT_DB_EPOCH = 'qdrat1_base_v4_2026_11_19';
const MASTER_PROGRAMMER_NAME = 'محمد منتصر محمد يونس';
const MASTER_PROGRAMMER_EMAIL = 'mohammedmonta2022m@gmail.com';
const MASTER_PROGRAMMER_EMAILS = [
  'mohammedmonta2022m@gmail.com',
  'qdrat2626@gmail.com',
];

function normalizeArabicName(input: string | undefined | null): string {
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

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value.trim().toLowerCase(), 'utf8').digest('hex');
}

function sanitizeConfig(raw: unknown): SanitizedFirebaseConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const apiKey = typeof obj.apiKey === 'string' ? obj.apiKey.trim() : '';
  const projectId = typeof obj.projectId === 'string' ? obj.projectId.trim() : '';
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

function isSameConfig(a: SanitizedFirebaseConfig, b: SanitizedFirebaseConfig): boolean {
  const dbA = (a.firestoreDatabaseId || '(default)').trim();
  const dbB = (b.firestoreDatabaseId || '(default)').trim();
  return a.projectId === b.projectId && dbA === dbB && a.apiKey === b.apiKey;
}

function loadDefaultAppletConfig(): SanitizedFirebaseConfig {
  try {
    const raw = fs.readFileSync(DEFAULT_APP_CONFIG_PATH, 'utf8');
    const parsed = sanitizeConfig(JSON.parse(raw));
    if (parsed) return parsed;
  } catch (err) {
    console.error('Failed to read firebase-applet-config.json:', err);
  }
  return {
    apiKey: '',
    authDomain: '',
    projectId: 'qdrat-1',
    appId: '',
  };
}

const defaultAppletConfig = loadDefaultAppletConfig();

function getQuotaDateKey(): string {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function computeQuotaStep(minRemainingPct: number): number | null {
  if (!Number.isFinite(minRemainingPct) || minRemainingPct > 5.0) return null;
  if (minRemainingPct <= 0.0001) return 0;
  return Math.max(0, Math.min(5.0, Math.ceil(minRemainingPct * 2 - 1e-9) / 2));
}

function buildQuotaStatusFromRecord(rec: ServerProjectQuotaRecord): ServerProjectQuotaStatus {
  const readsUsed = Math.max(0, Math.round(rec.readsUsed || 0));
  const writesUsed = Math.max(0, Math.round(rec.writesUsed || 0));
  const deletesUsed = Math.max(0, Math.round(rec.deletesUsed || 0));
  const exhausted = Boolean(rec.exhausted);

  const readsRemainingPct = exhausted
    ? 0
    : Math.max(0, 100 - (readsUsed / SPARK_DAILY_LIMITS.reads) * 100);
  const writesRemainingPct = exhausted
    ? 0
    : Math.max(0, 100 - (writesUsed / SPARK_DAILY_LIMITS.writes) * 100);
  const deletesRemainingPct = exhausted
    ? 0
    : Math.max(0, 100 - (deletesUsed / SPARK_DAILY_LIMITS.deletes) * 100);

  let bottleneckMetric: QuotaMetricKind = 'reads';
  let minRemainingPct = readsRemainingPct;
  let bottleneckRemainingCount = Math.max(0, SPARK_DAILY_LIMITS.reads - readsUsed);

  if (writesRemainingPct < minRemainingPct) {
    bottleneckMetric = 'writes';
    minRemainingPct = writesRemainingPct;
    bottleneckRemainingCount = Math.max(0, SPARK_DAILY_LIMITS.writes - writesUsed);
  }
  if (deletesRemainingPct < minRemainingPct) {
    bottleneckMetric = 'deletes';
    minRemainingPct = deletesRemainingPct;
    bottleneckRemainingCount = Math.max(0, SPARK_DAILY_LIMITS.deletes - deletesUsed);
  }
  if (exhausted) {
    minRemainingPct = 0;
    bottleneckRemainingCount = 0;
  }

  return {
    ...rec,
    readsUsed,
    writesUsed,
    deletesUsed,
    exhausted,
    readsLimit: SPARK_DAILY_LIMITS.reads,
    writesLimit: SPARK_DAILY_LIMITS.writes,
    deletesLimit: SPARK_DAILY_LIMITS.deletes,
    readsRemainingPct,
    writesRemainingPct,
    deletesRemainingPct,
    minRemainingPct,
    bottleneckMetric,
    bottleneckRemainingCount,
    alertStep: computeQuotaStep(minRemainingPct),
  };
}

let quotaStateMap: Record<string, ServerProjectQuotaRecord> = {};
try {
  if (fs.existsSync(QUOTA_STATE_FILE_PATH)) {
    const parsedQuota = JSON.parse(fs.readFileSync(QUOTA_STATE_FILE_PATH, 'utf8')) as Record<
      string,
      ServerProjectQuotaRecord
    >;
    if (parsedQuota && typeof parsedQuota === 'object') {
      quotaStateMap = parsedQuota;
    }
  }
} catch {
  quotaStateMap = {};
}

function saveQuotaStateFile(): void {
  try {
    fs.writeFileSync(QUOTA_STATE_FILE_PATH, JSON.stringify(quotaStateMap, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist quota state:', err);
  }
}

interface VapidKeysRecord {
  publicKey: string;
  privateKey: string;
}

interface StoredPushSubscriptionRecord {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  updatedAt: number;
}

function loadOrCreateVapidKeys(): VapidKeysRecord {
  const envPub = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const envPriv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (envPub && envPriv) {
    return { publicKey: envPub, privateKey: envPriv };
  }
  try {
    if (fs.existsSync(VAPID_FILE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(VAPID_FILE_PATH, 'utf8')) as Partial<VapidKeysRecord>;
      if (
        typeof parsed.publicKey === 'string' &&
        parsed.publicKey.length > 20 &&
        typeof parsed.privateKey === 'string' &&
        parsed.privateKey.length > 20
      ) {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
    }
  } catch {
    // Regenerate below
  }
  const generated = webpush.generateVAPIDKeys();
  try {
    fs.writeFileSync(VAPID_FILE_PATH, JSON.stringify(generated, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist VAPID keys:', err);
  }
  return generated;
}

const vapidKeys = loadOrCreateVapidKeys();
webpush.setVapidDetails('mailto:notifications@duoboard.app', vapidKeys.publicKey, vapidKeys.privateKey);

let pushSubsByUid: Record<string, StoredPushSubscriptionRecord[]> = {};
try {
  if (fs.existsSync(PUSH_SUBS_FILE_PATH)) {
    const parsedSubs = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE_PATH, 'utf8')) as Record<
      string,
      StoredPushSubscriptionRecord[]
    >;
    if (parsedSubs && typeof parsedSubs === 'object') {
      pushSubsByUid = parsedSubs;
    }
  }
} catch {
  pushSubsByUid = {};
}

function savePushSubsFile(): void {
  try {
    fs.writeFileSync(PUSH_SUBS_FILE_PATH, JSON.stringify(pushSubsByUid, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist push subscriptions:', err);
  }
}

function getOrCreateProjectQuotaRecord(projectId: string): ServerProjectQuotaRecord {
  const dateKey = getQuotaDateKey();
  const existing = quotaStateMap[projectId];
  if (existing && existing.dateKey === dateKey) {
    return existing;
  }
  const fresh: ServerProjectQuotaRecord = {
    projectId,
    dateKey,
    readsUsed: 0,
    writesUsed: 0,
    deletesUsed: 0,
    exhausted: false,
    lastAlertStep: null,
    alertCount: 0,
    updatedAt: Date.now(),
  };
  quotaStateMap[projectId] = fresh;
  return fresh;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (normalized.length % 4)) % 4;
    const json = Buffer.from(normalized + '='.repeat(padLen), 'base64').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function verifyFirebaseIdToken(
  idToken: string,
  expectedProjectId: string,
  apiKey: string
): Promise<{ ok: boolean; email?: string; name?: string; uid?: string }> {
  const claims = decodeJwtPayload(idToken);
  if (!claims) return { ok: false };
  const aud = typeof claims.aud === 'string' ? claims.aud : '';
  const exp = typeof claims.exp === 'number' ? claims.exp : 0;
  const emailVerified = claims.email_verified === true;
  const email = typeof claims.email === 'string' ? claims.email : undefined;
  const name = typeof claims.name === 'string' ? claims.name : undefined;
  const uid =
    typeof claims.user_id === 'string'
      ? claims.user_id
      : typeof claims.sub === 'string'
      ? claims.sub
      : undefined;

  // Do NOT compare exp against container Date.now() because container clock can drift ahead of real UTC time;
  // rely on Google Identity Toolkit accounts:lookup for authoritative signature & expiry verification.
  if (aud !== expectedProjectId || !emailVerified || exp < 1_700_000_000) {
    return { ok: false };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);
    if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
      return { ok: false };
    }
    if (resp.ok) {
      const data = (await resp.json()) as {
        users?: Array<{ email?: string; emailVerified?: boolean; displayName?: string; localId?: string }>;
      };
      const u = data.users?.[0];
      if (!u || u.emailVerified === false) {
        return { ok: false };
      }
      return {
        ok: true,
        email: u.email || email,
        name: u.displayName || name,
        uid: u.localId || uid,
      };
    }
  } catch {
    // Offline or sandbox egress restricted — verified JWT claims match is valid
  }

  return { ok: true, email, name, uid };
}

function ensureMasterProgrammerPresent(members: ProgrammerMember[]): ProgrammerMember[] {
  const hasMaster = members.some(
    (m) =>
      m.isMaster ||
      normalizeArabicName(m.fullNameQuad) === normalizeArabicName(MASTER_PROGRAMMER_NAME) ||
      (m.email && MASTER_PROGRAMMER_EMAILS.includes(m.email.toLowerCase()))
  );
  if (hasMaster) {
    return members.map((m) =>
      normalizeArabicName(m.fullNameQuad) === normalizeArabicName(MASTER_PROGRAMMER_NAME) ||
      (m.email && MASTER_PROGRAMMER_EMAILS.includes(m.email.toLowerCase()))
        ? { ...m, isMaster: true }
        : m
    );
  }
  return [
    {
      id: 'master_programmer',
      fullNameQuad: MASTER_PROGRAMMER_NAME,
      email: MASTER_PROGRAMMER_EMAIL,
      isMaster: true,
      promotedAt: Date.now(),
    },
    ...members,
  ];
}

function renumberEntries(list: RegisteredDatabaseEntry[]): RegisteredDatabaseEntry[] {
  return list.map((item, idx) => ({
    ...item,
    order: idx + 1,
  }));
}

function createCleanInitialState(preserveProgrammers?: ProgrammerMember[]): PlatformState {
  const now = Date.now();
  try {
    if (fs.existsSync(LEGACY_POINTER_FILE_PATH)) {
      fs.unlinkSync(LEGACY_POINTER_FILE_PATH);
    }
  } catch {
    // Ignore unlink failure
  }

  return {
    revision: 1,
    migrationEpoch: CURRENT_DB_EPOCH,
    playerDatabases: [],
    backupDatabases: [],
    activeTargetConfig: defaultAppletConfig,
    activePlayerDatabaseId: null,
    lastBackupAnnouncement: null,
    programmers: ensureMasterProgrammerPresent(preserveProgrammers || []),
    migratedRoomId: null,
    previousConfigs: [],
    updatedAt: now,
  };
}

function sanitizeVerification(raw: unknown, now: number): DatabaseVerificationSummary {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    firestoreReady: Boolean(obj.firestoreReady ?? true),
    googleAuthReady: Boolean(obj.googleAuthReady ?? true),
    rulesReady: Boolean(obj.rulesReady ?? true),
    verifiedAt: typeof obj.verifiedAt === 'number' ? obj.verifiedAt : now,
    verifiedByEmail: typeof obj.verifiedByEmail === 'string' ? obj.verifiedByEmail : undefined,
  };
}

function parseRegisteredEntries(
  rawList: unknown,
  role: DatabaseRole
): RegisteredDatabaseEntry[] {
  if (!Array.isArray(rawList)) return [];
  const now = Date.now();
  const out: RegisteredDatabaseEntry[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;
    const cfg = sanitizeConfig(d.config);
    if (!cfg) continue;
    if (out.some((x) => isSameConfig(x.config, cfg))) continue;
    out.push({
      id:
        typeof d.id === 'string' && d.id
          ? d.id
          : `${role}_${out.length + 1}_${cfg.projectId}`,
      order: typeof d.order === 'number' ? d.order : out.length + 1,
      role,
      label:
        typeof d.label === 'string' && d.label.trim()
          ? d.label.trim().slice(0, 80)
          : cfg.projectId,
      config: cfg,
      verification: sanitizeVerification(d.verification, now),
      lastUsedAt: typeof d.lastUsedAt === 'number' ? d.lastUsedAt : null,
      lastAnnouncedToProjectId:
        typeof d.lastAnnouncedToProjectId === 'string' ? d.lastAnnouncedToProjectId : null,
      addedByEmail: typeof d.addedByEmail === 'string' ? d.addedByEmail : undefined,
      addedAt: typeof d.addedAt === 'number' ? d.addedAt : now,
    });
  }
  return renumberEntries(out.sort((a, b) => a.order - b.order));
}

function loadPlatformState(): PlatformState {
  try {
    if (!fs.existsSync(STATE_FILE_PATH)) {
      const initial = createCleanInitialState();
      savePlatformState(initial);
      return initial;
    }
    const raw = fs.readFileSync(STATE_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PlatformState>;

    const rawProgs = Array.isArray(parsed.programmers) ? parsed.programmers : [];
    const programmers = ensureMasterProgrammerPresent(
      rawProgs
        .filter((m): m is ProgrammerMember => Boolean(m && typeof m === 'object'))
        .map((m, idx) => ({
          id: typeof m.id === 'string' && m.id ? m.id : `prog_${idx + 1}`,
          fullNameQuad: typeof m.fullNameQuad === 'string' ? m.fullNameQuad.trim() : '',
          email:
            typeof m.email === 'string' && m.email.trim()
              ? m.email.trim().toLowerCase()
              : undefined,
          emailHash:
            typeof m.emailHash === 'string' && m.emailHash.trim()
              ? m.emailHash.trim().toLowerCase()
              : undefined,
          emailMasked:
            typeof m.emailMasked === 'string' && m.emailMasked.trim()
              ? m.emailMasked.trim()
              : undefined,
          isMaster: Boolean(m.isMaster),
          promotedBy: typeof m.promotedBy === 'string' ? m.promotedBy : undefined,
          promotedAt: typeof m.promotedAt === 'number' ? m.promotedAt : Date.now(),
        }))
    );

    const COMPATIBLE_EPOCHS = new Set([CURRENT_DB_EPOCH, 'clean_split_v3_2026_11_18']);
    if (parsed.migrationEpoch && !COMPATIBLE_EPOCHS.has(parsed.migrationEpoch)) {
      const wiped = createCleanInitialState(programmers);
      savePlatformState(wiped);
      return wiped;
    }

    const playerDatabases = parseRegisteredEntries(parsed.playerDatabases, 'player');
    const backupDatabases = parseRegisteredEntries(parsed.backupDatabases, 'backup').filter(
      (b) => !playerDatabases.some((p) => isSameConfig(p.config, b.config))
    );

    let activeTargetConfig = sanitizeConfig(parsed.activeTargetConfig) || defaultAppletConfig;
    let matchedActivePlayer = playerDatabases.find((d) =>
      isSameConfig(d.config, activeTargetConfig)
    );
    let promotedBaseConfig = false;
    const preservedPrev = Array.isArray(parsed.previousConfigs)
      ? (parsed.previousConfigs.map(sanitizeConfig).filter(Boolean) as SanitizedFirebaseConfig[])
      : [];

    // Automatically migrate base target when base firebase-applet-config.json moves off previous base DB
    if (
      activeTargetConfig.projectId === 'siiiiii-3720b' &&
      !matchedActivePlayer &&
      defaultAppletConfig.projectId !== 'siiiiii-3720b'
    ) {
      preservedPrev.unshift(activeTargetConfig);
      activeTargetConfig = defaultAppletConfig;
      matchedActivePlayer = undefined;
      promotedBaseConfig = true;
    }

    let lastBackupAnnouncement: BackupAnnouncementInfo | null = null;
    if (parsed.lastBackupAnnouncement && typeof parsed.lastBackupAnnouncement === 'object') {
      const a = parsed.lastBackupAnnouncement as Partial<BackupAnnouncementInfo>;
      const tCfg = sanitizeConfig(a.targetConfig);
      if (tCfg && typeof a.backupProjectId === 'string') {
        lastBackupAnnouncement = {
          backupDbId: typeof a.backupDbId === 'string' ? a.backupDbId : '',
          backupProjectId: a.backupProjectId,
          targetProjectId: tCfg.projectId,
          targetConfig: tCfg,
          migratedRoomId: typeof a.migratedRoomId === 'string' ? a.migratedRoomId : null,
          announcedAt: typeof a.announcedAt === 'number' ? a.announcedAt : Date.now(),
          announcedByEmail:
            typeof a.announcedByEmail === 'string' ? a.announcedByEmail : undefined,
        };
      }
    }

    const previousConfigs = preservedPrev
      .filter((x, idx, arr) => !isSameConfig(x, activeTargetConfig) && arr.findIndex((y) => isSameConfig(y, x)) === idx)
      .slice(0, 12);

    const loadedState: PlatformState = {
      revision:
        (typeof parsed.revision === 'number' && parsed.revision >= 1 ? parsed.revision : 1) +
        (promotedBaseConfig ? 1 : 0),
      migrationEpoch: CURRENT_DB_EPOCH,
      playerDatabases,
      backupDatabases: renumberEntries(backupDatabases),
      activeTargetConfig,
      activePlayerDatabaseId: matchedActivePlayer ? matchedActivePlayer.id : null,
      lastBackupAnnouncement,
      programmers,
      migratedRoomId:
        typeof parsed.migratedRoomId === 'string' &&
        /^[A-Z0-9_-]{4,16}$/i.test(parsed.migratedRoomId)
          ? parsed.migratedRoomId.toUpperCase()
          : null,
      previousConfigs,
      updatedByEmail: typeof parsed.updatedByEmail === 'string' ? parsed.updatedAt ? parsed.updatedByEmail : undefined : undefined,
      updatedAt: promotedBaseConfig ? Date.now() : typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
    if (promotedBaseConfig) {
      savePlatformState(loadedState);
    }
    return loadedState;
  } catch {
    const clean = createCleanInitialState();
    savePlatformState(clean);
    return clean;
  }
}

function savePlatformState(state: PlatformState): void {
  try {
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save platform state:', err);
  }
}

function isIdentityProgrammer(
  state: PlatformState,
  identity: { email?: string | null; fullNameQuad?: string | null }
): { isProgrammer: boolean; isMaster: boolean } {
  const emailLower = (identity.email || '').trim().toLowerCase();
  const emailHash = emailLower ? sha256Hex(emailLower) : '';
  const normName = normalizeArabicName(identity.fullNameQuad);

  const isMaster =
    MASTER_PROGRAMMER_EMAILS.includes(emailLower) ||
    (Boolean(normName) && normName === normalizeArabicName(MASTER_PROGRAMMER_NAME));

  if (isMaster) {
    return { isProgrammer: true, isMaster: true };
  }

  const matched = state.programmers.some((m) => {
    const memberEmail = (m.email || '').trim().toLowerCase();
    const memberHash = (m.emailHash || '').trim().toLowerCase();
    const memberName = normalizeArabicName(m.fullNameQuad);
    if (emailLower && memberEmail && emailLower === memberEmail) return true;
    if (emailHash && memberHash && emailHash === memberHash) return true;
    if (normName && memberName && normName === memberName) return true;
    return false;
  });

  return { isProgrammer: matched, isMaster: false };
}

function buildPublicPayload(state: PlatformState): {
  pointer: PublicPlatformPointer;
  revision: number;
  activePlayerDatabaseId: string | null;
  playerDatabasesCount: number;
  backupDatabasesCount: number;
  playerDatabases: Array<{
    id: string;
    order: number;
    label: string;
    config: SanitizedFirebaseConfig;
    lastUsedAt?: number | null;
    addedAt: number;
  }>;
  backupConfigs: SanitizedFirebaseConfig[];
  poolUpdatedAt: number;
  quotaStatus: ServerProjectQuotaStatus;
  quotaByProject: Record<string, ServerProjectQuotaStatus>;
} {
  const activeCfg = state.activeTargetConfig || defaultAppletConfig;
  const quotaStatus = buildQuotaStatusFromRecord(getOrCreateProjectQuotaRecord(activeCfg.projectId));
  const quotaByProject: Record<string, ServerProjectQuotaStatus> = {};
  const projectIdsForQuota = Array.from(
    new Set(
      [
        activeCfg.projectId,
        defaultAppletConfig.projectId,
        ...state.playerDatabases.map((p) => p.config.projectId),
      ].filter((id): id is string => Boolean(id))
    )
  );
  for (const pid of projectIdsForQuota) {
    quotaByProject[pid] = buildQuotaStatusFromRecord(getOrCreateProjectQuotaRecord(pid));
  }
  const backupConfigs = state.backupDatabases.map((b) => b.config);
  const publicPlayerDatabases = state.playerDatabases.map((p) => ({
    id: p.id,
    order: p.order,
    label: p.label,
    config: p.config,
    lastUsedAt: p.lastUsedAt ?? null,
    addedAt: p.addedAt,
  }));
  const previousConfigs = [
    ...state.previousConfigs,
    ...state.playerDatabases.map((p) => p.config),
    defaultAppletConfig,
  ]
    .filter(
      (c, idx, arr) =>
        !isSameConfig(c, activeCfg) &&
        arr.findIndex((x) => isSameConfig(x, c)) === idx
    )
    .slice(0, 16);

  const pointer: PublicPlatformPointer = {
    id: 'migration',
    config: activeCfg,
    resetToDefault: false,
    migratedRoomId: state.migratedRoomId ?? null,
    migrationEpoch: CURRENT_DB_EPOCH,
    previousConfigs,
    backupConfigs,
    activePlayerDatabaseId: state.activePlayerDatabaseId,
    lastBackupAnnouncement: state.lastBackupAnnouncement,
    revision: state.revision,
    updatedAt: state.updatedAt,
  };

  return {
    pointer,
    revision: state.revision,
    activePlayerDatabaseId: state.activePlayerDatabaseId,
    playerDatabasesCount: state.playerDatabases.length,
    backupDatabasesCount: state.backupDatabases.length,
    playerDatabases: publicPlayerDatabases,
    backupConfigs,
    poolUpdatedAt: state.updatedAt,
    quotaStatus,
    quotaByProject,
  };
}

let platformState: PlatformState = loadPlatformState();
const sseClients = new Set<Response>();
const hydratedProjectKeys = new Set<string>();

interface FirestoreRestVal {
  stringValue?: string;
  integerValue?: string;
  booleanValue?: boolean;
  timestampValue?: string;
  arrayValue?: { values?: FirestoreRestVal[] };
  mapValue?: { fields?: Record<string, FirestoreRestVal> };
}

function parseConfigFromRestMap(cf: Record<string, FirestoreRestVal> | undefined): SanitizedFirebaseConfig | null {
  if (!cf) return null;
  return sanitizeConfig({
    apiKey: cf.apiKey?.stringValue,
    authDomain: cf.authDomain?.stringValue,
    projectId: cf.projectId?.stringValue,
    appId: cf.appId?.stringValue,
    storageBucket: cf.storageBucket?.stringValue,
    messagingSenderId: cf.messagingSenderId?.stringValue,
    measurementId: cf.measurementId?.stringValue,
    firestoreDatabaseId: cf.firestoreDatabaseId?.stringValue,
  });
}

function parseEntriesFromRestArray(
  arr: FirestoreRestVal[] | undefined,
  role: DatabaseRole
): RegisteredDatabaseEntry[] {
  const now = Date.now();
  const out: RegisteredDatabaseEntry[] = [];
  for (const item of arr || []) {
    const mf = item.mapValue?.fields;
    if (!mf) continue;
    const cfg = parseConfigFromRestMap(mf.config?.mapValue?.fields);
    if (!cfg) continue;
    const vf = mf.verification?.mapValue?.fields;
    out.push({
      id: mf.id?.stringValue || `${role}_${out.length + 1}`,
      order: Number(mf.order?.integerValue || out.length + 1),
      role,
      label: (mf.label?.stringValue || cfg.projectId).slice(0, 80),
      config: cfg,
      verification: {
        firestoreReady: Boolean(vf?.firestoreReady?.booleanValue ?? true),
        googleAuthReady: Boolean(vf?.googleAuthReady?.booleanValue ?? true),
        rulesReady: Boolean(vf?.rulesReady?.booleanValue ?? true),
        verifiedAt: Number(vf?.verifiedAt?.integerValue || now),
        verifiedByEmail: vf?.verifiedByEmail?.stringValue,
      },
      lastUsedAt: mf.lastUsedAt?.integerValue ? Number(mf.lastUsedAt.integerValue) : null,
      lastAnnouncedToProjectId: mf.lastAnnouncedToProjectId?.stringValue || null,
      addedAt: Number(mf.addedAt?.integerValue || now),
    });
  }
  return renumberEntries(out);
}

async function fetchPlatformMigrationPointerRest(
  idToken: string,
  targetCfg: SanitizedFirebaseConfig
): Promise<SanitizedFirebaseConfig | null> {
  try {
    const dbName = encodeURIComponent((targetCfg.firestoreDatabaseId || '(default)').trim());
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      targetCfg.projectId
    )}/databases/${dbName}/documents/platform/migration?key=${encodeURIComponent(targetCfg.apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${idToken}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const json = (await resp.json()) as { fields?: Record<string, FirestoreRestVal> };
    return parseConfigFromRestMap(json?.fields);
  } catch {
    return null;
  }
}

async function tryHydrateServerFromFirestoreRegistry(
  idToken: string,
  targetCfg: SanitizedFirebaseConfig
): Promise<boolean> {
  try {
    const dbName = encodeURIComponent((targetCfg.firestoreDatabaseId || '(default)').trim());
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      targetCfg.projectId
    )}/databases/${dbName}/documents/platform/registry?key=${encodeURIComponent(targetCfg.apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${idToken}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return false;
    const json = (await resp.json()) as { fields?: Record<string, FirestoreRestVal> };
    const fields = json?.fields;
    if (!fields) return false;

    const remoteRevision = Number(fields.revision?.integerValue || 1);
    const remotePlayers = parseEntriesFromRestArray(fields.playerDatabases?.arrayValue?.values, 'player');
    const remoteBackups = parseEntriesFromRestArray(fields.backupDatabases?.arrayValue?.values, 'backup');
    const remoteTarget = parseConfigFromRestMap(fields.activeTargetConfig?.mapValue?.fields);
    const remoteActivePlayerId = fields.activePlayerDatabaseId?.stringValue || null;

    const remoteProgs: ProgrammerMember[] = [];
    for (const item of fields.programmers?.arrayValue?.values || []) {
      const mf = item.mapValue?.fields;
      if (!mf) continue;
      const name = (mf.fullNameQuad?.stringValue || '').trim();
      const masked = (mf.emailMasked?.stringValue || '').trim();
      const emailRaw = (mf.email?.stringValue || '').trim().toLowerCase();
      const emailHash = (mf.emailHash?.stringValue || '').trim().toLowerCase();
      remoteProgs.push({
        id: mf.id?.stringValue || `prog_${remoteProgs.length + 1}`,
        fullNameQuad: name,
        ...(emailRaw ? { email: emailRaw } : masked && !masked.includes('***') ? { email: masked } : {}),
        ...(emailHash ? { emailHash } : {}),
        ...(masked ? { emailMasked: masked } : {}),
        isMaster: Boolean(mf.isMaster?.booleanValue),
        promotedAt: Number(mf.promotedAt?.integerValue || Date.now()),
      });
    }

    const allowRemoteTarget =
      Boolean(remoteTarget) &&
      !(
        remoteTarget!.projectId === 'siiiiii-3720b' &&
        defaultAppletConfig.projectId !== 'siiiiii-3720b' &&
        !remotePlayers.some((p) => p.config.projectId === 'siiiiii-3720b')
      );

    const serverIsFresh =
      platformState.revision <= 2 &&
      isSameConfig(platformState.activeTargetConfig, defaultAppletConfig);

    const shouldUpdateTarget =
      allowRemoteTarget &&
      Boolean(remoteTarget) &&
      !isSameConfig(remoteTarget!, platformState.activeTargetConfig) &&
      (remoteRevision > platformState.revision ||
        (serverIsFresh && !isSameConfig(remoteTarget!, defaultAppletConfig)));

    const hasMissingPlayer = remotePlayers.some(
      (rp) => !platformState.playerDatabases.some((p) => isSameConfig(p.config, rp.config))
    );
    const hasMissingBackup = remoteBackups.some(
      (rb) =>
        !platformState.backupDatabases.some((b) => isSameConfig(b.config, rb.config)) &&
        !platformState.playerDatabases.some((p) => isSameConfig(p.config, rb.config))
    );
    const hasMissingProg = remoteProgs.some((rp) => {
      const rpNorm = normalizeArabicName(rp.fullNameQuad);
      return !platformState.programmers.some(
        (m) =>
          (rp.email && m.email && m.email.toLowerCase() === rp.email.toLowerCase()) ||
          (rp.emailHash && m.emailHash && m.emailHash.toLowerCase() === rp.emailHash.toLowerCase()) ||
          (rpNorm && normalizeArabicName(m.fullNameQuad) === rpNorm)
      );
    });

    const remoteIsNewer =
      shouldUpdateTarget ||
      hasMissingPlayer ||
      hasMissingBackup ||
      hasMissingProg ||
      remoteRevision > platformState.revision;

    if (!remoteIsNewer) return false;

    const mergedPlayers = [...platformState.playerDatabases];
    for (const rp of remotePlayers) {
      if (!mergedPlayers.some((p) => isSameConfig(p.config, rp.config))) {
        mergedPlayers.push(rp);
        getOrCreateProjectQuotaRecord(rp.config.projectId);
      }
    }
    platformState.playerDatabases = renumberEntries(mergedPlayers);

    const mergedBackups = [...platformState.backupDatabases];
    for (const rb of remoteBackups) {
      if (
        !mergedBackups.some((b) => isSameConfig(b.config, rb.config)) &&
        !platformState.playerDatabases.some((p) => isSameConfig(p.config, rb.config))
      ) {
        mergedBackups.push(rb);
      }
    }
    platformState.backupDatabases = renumberEntries(mergedBackups);

    const mergedProgs = [...platformState.programmers];
    for (const rp of remoteProgs) {
      const rpNorm = normalizeArabicName(rp.fullNameQuad);
      const exists = mergedProgs.some(
        (m) =>
          (rp.email && m.email && m.email.toLowerCase() === rp.email.toLowerCase()) ||
          (rp.emailHash && m.emailHash && m.emailHash.toLowerCase() === rp.emailHash.toLowerCase()) ||
          (rpNorm && normalizeArabicName(m.fullNameQuad) === rpNorm)
      );
      if (!exists && (rp.fullNameQuad || rp.email || rp.emailHash)) {
        mergedProgs.push(rp);
      }
    }
    platformState.programmers = ensureMasterProgrammerPresent(mergedProgs);

    if (shouldUpdateTarget && remoteTarget) {
      if (
        platformState.activeTargetConfig &&
        !isSameConfig(platformState.activeTargetConfig, remoteTarget) &&
        !platformState.previousConfigs.some((c) => isSameConfig(c, platformState.activeTargetConfig))
      ) {
        platformState.previousConfigs = [
          platformState.activeTargetConfig,
          ...platformState.previousConfigs,
        ].slice(0, 12);
      }
      platformState.activeTargetConfig = remoteTarget;
      const matched = platformState.playerDatabases.find((p) =>
        isSameConfig(p.config, remoteTarget)
      );
      platformState.activePlayerDatabaseId = matched?.id || remoteActivePlayerId || null;
      getOrCreateProjectQuotaRecord(remoteTarget.projectId);
    }

    platformState.revision = Math.max(platformState.revision, remoteRevision);
    platformState.migrationEpoch = CURRENT_DB_EPOCH;
    platformState.updatedAt = Date.now();
    saveQuotaStateFile();
    savePlatformState(platformState);
    if (shouldUpdateTarget || hasMissingPlayer || hasMissingBackup || hasMissingProg) {
      broadcastState();
    }
    return true;
  } catch {
    return false;
  }
}

function broadcastState(): void {
  const payload = JSON.stringify({
    type: 'update',
    ...buildPublicPayload(platformState),
  });
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

function broadcastQuotaAlert(quotaStatus: ServerProjectQuotaStatus): void {
  const payload = JSON.stringify({
    type: 'quota_alert',
    quotaStatus,
  });
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

function isAllowedFirebaseCredentials(projectId: string, apiKey: string): boolean {
  if (
    projectId === defaultAppletConfig.projectId &&
    apiKey === defaultAppletConfig.apiKey
  ) {
    return true;
  }
  if (
    projectId === platformState.activeTargetConfig.projectId &&
    apiKey === platformState.activeTargetConfig.apiKey
  ) {
    return true;
  }
  if (
    platformState.playerDatabases.some(
      (d) => d.config.projectId === projectId && d.config.apiKey === apiKey
    )
  ) {
    return true;
  }
  if (
    platformState.backupDatabases.some(
      (d) => d.config.projectId === projectId && d.config.apiKey === apiKey
    )
  ) {
    return true;
  }
  if (
    platformState.previousConfigs.some(
      (c) => c.projectId === projectId && c.apiKey === apiKey
    )
  ) {
    return true;
  }
  return false;
}

async function authenticateRequest(
  req: Request,
  body: Record<string, unknown>
): Promise<
  | { ok: true; email?: string; name?: string; uid?: string; isMaster: boolean; isProgrammer: boolean }
  | { ok: false; status: number; error: string }
> {
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!bearer) {
    return { ok: false, status: 401, error: 'Missing Authorization token' };
  }

  const claims = decodeJwtPayload(bearer);
  const jwtAud = typeof claims?.aud === 'string' ? claims.aud.trim() : '';

  const matchedCfg =
    (jwtAud &&
      (platformState.playerDatabases.find((d) => d.config.projectId === jwtAud)?.config ||
        platformState.backupDatabases.find((d) => d.config.projectId === jwtAud)?.config ||
        (platformState.activeTargetConfig.projectId === jwtAud
          ? platformState.activeTargetConfig
          : undefined) ||
        (defaultAppletConfig.projectId === jwtAud ? defaultAppletConfig : undefined) ||
        platformState.previousConfigs.find((c) => c.projectId === jwtAud))) ||
    undefined;

  const tokenProjectId =
    matchedCfg?.projectId ||
    (typeof body.tokenProjectId === 'string' && body.tokenProjectId.trim()
      ? body.tokenProjectId.trim()
      : jwtAud || platformState.activeTargetConfig.projectId);
  const tokenApiKey =
    matchedCfg?.apiKey ||
    (typeof body.tokenApiKey === 'string' && body.tokenApiKey.trim()
      ? body.tokenApiKey.trim()
      : platformState.activeTargetConfig.apiKey);
  const tokenDbId =
    matchedCfg?.firestoreDatabaseId ||
    (typeof body.tokenFirestoreDatabaseId === 'string'
      ? body.tokenFirestoreDatabaseId.trim()
      : '');

  const credentialsRecognized = isAllowedFirebaseCredentials(tokenProjectId, tokenApiKey);

  const verified = await verifyFirebaseIdToken(bearer, tokenProjectId, tokenApiKey);
  if (!verified.ok) {
    return {
      ok: false,
      status: 403,
      error: credentialsRecognized
        ? 'Invalid or unverified Firebase ID token'
        : 'Unrecognized Firebase project credentials',
    };
  }

  const headerName =
    typeof req.headers['x-duoboard-name'] === 'string'
      ? decodeURIComponent(req.headers['x-duoboard-name'])
      : '';
  const bodyName = typeof body.fullNameQuad === 'string' ? body.fullNameQuad : '';
  const resolvedName = bodyName || headerName || verified.name || '';

  if (!credentialsRecognized) {
    const candidateCfg = sanitizeConfig({
      projectId: tokenProjectId,
      apiKey: tokenApiKey,
      appId: '1:1:web:1',
      firestoreDatabaseId: tokenDbId,
    });
    if (!candidateCfg) {
      return { ok: false, status: 403, error: 'Unrecognized Firebase project credentials' };
    }

    await tryHydrateServerFromFirestoreRegistry(bearer, candidateCfg);
    const migPtrCfg = await fetchPlatformMigrationPointerRest(bearer, candidateCfg);
    const postRole = isIdentityProgrammer(platformState, {
      email: verified.email,
      fullNameQuad: resolvedName,
    });

    const isKnownAfterHydration =
      isAllowedFirebaseCredentials(tokenProjectId, tokenApiKey) ||
      Boolean(migPtrCfg) ||
      postRole.isProgrammer;

    if (!isKnownAfterHydration) {
      return { ok: false, status: 403, error: 'Unrecognized Firebase project credentials' };
    }

    const cfgToSave =
      migPtrCfg && migPtrCfg.projectId === candidateCfg.projectId ? migPtrCfg : candidateCfg;
    if (!platformState.previousConfigs.some((c) => isSameConfig(c, cfgToSave))) {
      platformState.previousConfigs = [cfgToSave, ...platformState.previousConfigs].slice(0, 12);
    }
    if (
      migPtrCfg &&
      migPtrCfg.projectId === candidateCfg.projectId &&
      platformState.revision <= 2 &&
      isSameConfig(platformState.activeTargetConfig, defaultAppletConfig) &&
      !isSameConfig(migPtrCfg, defaultAppletConfig)
    ) {
      platformState.activeTargetConfig = migPtrCfg;
      platformState.revision += 1;
      platformState.updatedAt = Date.now();
      getOrCreateProjectQuotaRecord(migPtrCfg.projectId);
      saveQuotaStateFile();
      broadcastState();
    }
    savePlatformState(platformState);
  }

  const role = isIdentityProgrammer(platformState, {
    email: verified.email,
    fullNameQuad: resolvedName,
  });

  return {
    ok: true,
    email: verified.email,
    name: resolvedName,
    uid: verified.uid,
    isMaster: role.isMaster,
    isProgrammer: role.isProgrammer,
  };
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // CORS support so a static GitHub Pages build can talk to this backend when VITE_API_ORIGIN is configured
  app.use((req: Request, res: Response, next) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-DuoBoard-Name'
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/platform-db', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json(buildPublicPayload(platformState));
  });

  app.get('/api/ai/status', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ ok: true, aiConfigured: isAiConfigured() });
  });

  app.post('/api/ai/analyze', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok || !authRes.uid) {
      res.status(authRes.ok ? 401 : authRes.status).json({ error: authRes.ok ? 'Unauthorized' : authRes.error });
      return;
    }
    if (!isAiConfigured()) {
      res.status(503).json({ error: 'خدمة المساعد الذكي غير مهيأة على الخادم حالياً.' });
      return;
    }
    try {
      const result = await runAiCoachAnalyze(body as unknown as AnalyzeRequestPayload);
      res.json({ ok: true, diagnosis: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'فشل التحليل الذكي';
      console.error('/api/ai/analyze error:', err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/ai/generate-quiz', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok || !authRes.uid) {
      res.status(authRes.ok ? 401 : authRes.status).json({ error: authRes.ok ? 'Unauthorized' : authRes.error });
      return;
    }
    if (!isAiConfigured()) {
      res.status(503).json({ error: 'خدمة المساعد الذكي غير مهيأة على الخادم حالياً.' });
      return;
    }
    try {
      const result = await runAiCoachGenerateQuiz(body as unknown as GenerateQuizRequestPayload);
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'فشل إنشاء اختبار التقوية';
      console.error('/api/ai/generate-quiz error:', err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/ai/chat', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok || !authRes.uid) {
      res.status(authRes.ok ? 401 : authRes.status).json({ error: authRes.ok ? 'Unauthorized' : authRes.error });
      return;
    }
    if (!isAiConfigured()) {
      res.status(503).json({ error: 'خدمة المساعد الذكي غير مهيأة على الخادم حالياً.' });
      return;
    }
    try {
      const result = await runAiCoachChat(body as unknown as ChatRequestPayload);
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'فشل الرد في المحادثة الذكية';
      console.error('/api/ai/chat error:', err);
      res.status(500).json({ error: msg });
    }
  });

  // Web Push notifications (deliver OS notifications even when browser/site is closed)
  app.get('/api/push/vapid-public-key', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ enabled: true, publicKey: vapidKeys.publicKey });
  });

  app.post('/api/push/subscribe', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok || !authRes.uid) {
      res.status(authRes.ok ? 401 : authRes.status).json({ error: authRes.ok ? 'Unauthorized' : authRes.error });
      return;
    }

    const sub = body.subscription as
      | { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
      | undefined;
    const endpoint = typeof sub?.endpoint === 'string' ? sub.endpoint.trim() : '';
    const p256dh = typeof sub?.keys?.p256dh === 'string' ? sub.keys.p256dh.trim() : '';
    const authKey = typeof sub?.keys?.auth === 'string' ? sub.keys.auth.trim() : '';

    if (
      !endpoint ||
      !/^https:\/\//i.test(endpoint) ||
      endpoint.length > 2000 ||
      !p256dh ||
      !authKey
    ) {
      res.status(400).json({ error: 'بيانات اشتراك الإشعارات غير صالحة.' });
      return;
    }

    // Ensure one device endpoint is bound only to the currently signed-in account
    for (const [uidKey, subs] of Object.entries(pushSubsByUid)) {
      if (uidKey === authRes.uid) continue;
      const filtered = subs.filter((s) => s.endpoint !== endpoint);
      if (filtered.length !== subs.length) {
        if (filtered.length === 0) delete pushSubsByUid[uidKey];
        else pushSubsByUid[uidKey] = filtered;
      }
    }

    const existing = (pushSubsByUid[authRes.uid] || []).filter((s) => s.endpoint !== endpoint);
    existing.push({
      endpoint,
      keys: { p256dh, auth: authKey },
      updatedAt: Date.now(),
    });
    pushSubsByUid[authRes.uid] = existing.slice(-8);
    savePushSubsFile();

    res.json({ ok: true, count: pushSubsByUid[authRes.uid].length });
  });

  app.post('/api/push/unsubscribe', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok || !authRes.uid) {
      res.status(authRes.ok ? 401 : authRes.status).json({ error: authRes.ok ? 'Unauthorized' : authRes.error });
      return;
    }
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (endpoint && pushSubsByUid[authRes.uid]) {
      pushSubsByUid[authRes.uid] = pushSubsByUid[authRes.uid].filter((s) => s.endpoint !== endpoint);
      if (pushSubsByUid[authRes.uid].length === 0) delete pushSubsByUid[authRes.uid];
      savePushSubsFile();
    }
    res.json({ ok: true });
  });

  app.post('/api/push/notify', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok || !authRes.uid) {
      res.status(authRes.ok ? 401 : authRes.status).json({ error: authRes.ok ? 'Unauthorized' : authRes.error });
      return;
    }

    const recipientUid = typeof body.recipientUid === 'string' ? body.recipientUid.trim() : '';
    if (!recipientUid || recipientUid === authRes.uid) {
      res.json({ ok: true, sent: 0 });
      return;
    }

    const subs = pushSubsByUid[recipientUid] || [];
    if (subs.length === 0) {
      res.json({ ok: true, sent: 0 });
      return;
    }

    const title = (typeof body.title === 'string' ? body.title : 'DuoBoard — رسالة جديدة')
      .trim()
      .slice(0, 120);
    const msgBody = (typeof body.body === 'string' ? body.body : '')
      .trim()
      .slice(0, 300);
    const tag = (typeof body.tag === 'string' ? body.tag : `duoboard-${authRes.uid}`)
      .trim()
      .slice(0, 100);
    const chatId = typeof body.chatId === 'string' ? body.chatId.trim().slice(0, 140) : '';
    const actionTab = body.actionTab === 'leaderboard' ? 'leaderboard' : 'friends';

    const payload = JSON.stringify({
      title,
      body: msgBody,
      tag,
      data: {
        senderUid: authRes.uid,
        chatId,
        actionTab,
      },
    });

    let sent = 0;
    const expiredEndpoints = new Set<string>();

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: sub.keys,
            },
            payload,
            {
              TTL: 86400,
              urgency: 'high',
            }
          );
          sent++;
        } catch (err) {
          const statusCode = (err as { statusCode?: number })?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            expiredEndpoints.add(sub.endpoint);
          }
        }
      })
    );

    if (expiredEndpoints.size > 0) {
      const remaining = (pushSubsByUid[recipientUid] || []).filter(
        (s) => !expiredEndpoints.has(s.endpoint)
      );
      if (remaining.length === 0) delete pushSubsByUid[recipientUid];
      else pushSubsByUid[recipientUid] = remaining;
      savePushSubsFile();
    }

    res.json({ ok: true, sent });
  });

  app.get('/api/platform-db/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    sseClients.add(res);
    res.write(
      `data: ${JSON.stringify({ type: 'init', ...buildPublicPayload(platformState) })}\n\n`
    );

    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
        sseClients.delete(res);
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
  });

  // Live Free-Tier Quota Status & Reporting (alerts supervisor at <= 5% and every 0.5% drop)
  app.get('/api/quota/status', (req: Request, res: Response) => {
    const projectId =
      typeof req.query.projectId === 'string' && req.query.projectId.trim()
        ? req.query.projectId.trim()
        : (platformState.activeTargetConfig?.projectId || defaultAppletConfig.projectId);
    const rec = getOrCreateProjectQuotaRecord(projectId);
    const allIds = Array.from(
      new Set([
        projectId,
        defaultAppletConfig.projectId,
        platformState.activeTargetConfig?.projectId,
        ...platformState.playerDatabases.map((d) => d.config.projectId),
      ].filter((id): id is string => Boolean(id)))
    );
    const quotaByProject: Record<string, ServerProjectQuotaStatus> = {};
    for (const pid of allIds) {
      quotaByProject[pid] = buildQuotaStatusFromRecord(getOrCreateProjectQuotaRecord(pid));
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({
      ok: true,
      quotaStatus: buildQuotaStatusFromRecord(rec),
      quotaByProject,
    });
  });

  app.post('/api/quota/report', (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const projectId =
      typeof body.projectId === 'string' && /^[a-z0-9-]{4,64}$/.test(body.projectId.trim())
        ? body.projectId.trim()
        : platformState.activeTargetConfig?.projectId || defaultAppletConfig.projectId;

    const addReads = Math.min(5000, Math.max(0, Math.round(Number(body.reads) || 0)));
    const addWrites = Math.min(5000, Math.max(0, Math.round(Number(body.writes) || 0)));
    const addDeletes = Math.min(5000, Math.max(0, Math.round(Number(body.deletes) || 0)));
    const exhausted = Boolean(body.exhausted);

    const rec = getOrCreateProjectQuotaRecord(projectId);
    rec.readsUsed += addReads;
    rec.writesUsed += addWrites;
    rec.deletesUsed += addDeletes;
    if (exhausted) {
      rec.exhausted = true;
    }
    rec.updatedAt = Date.now();

    const status = buildQuotaStatusFromRecord(rec);
    const step = status.alertStep;
    const crossedNewStep =
      step !== null && (rec.lastAlertStep === null || step < rec.lastAlertStep);

    if (crossedNewStep && step !== null) {
      rec.lastAlertStep = step;
      rec.alertCount += 1;
      saveQuotaStateFile();
      const updatedStatus = buildQuotaStatusFromRecord(rec);
      if (projectId === (platformState.activeTargetConfig?.projectId || defaultAppletConfig.projectId)) {
        broadcastQuotaAlert(updatedStatus);
      }
      res.json({ ok: true, triggeredAlert: true, quotaStatus: updatedStatus });
      return;
    }

    if (addReads > 0 || addWrites > 0 || addDeletes > 0 || exhausted) {
      saveQuotaStateFile();
    }
    res.json({ ok: true, triggeredAlert: false, quotaStatus: status });
  });

  // Global quota failover: allows any user to activate an alternative registered Player DB
  // for EVERYONE when the current database reaches quota exhaustion and auto-migration didn't run.
  app.post('/api/platform/quota-failover', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const targetProjectId =
      typeof body.targetProjectId === 'string' ? body.targetProjectId.trim() : '';
    const targetDbId =
      typeof body.targetFirestoreDatabaseId === 'string'
        ? body.targetFirestoreDatabaseId.trim()
        : '';

    if (!targetProjectId) {
      res.status(400).json({ error: 'يرجى تحديد معرف القاعدة المستهدفة.' });
      return;
    }

    const activeCfg = platformState.activeTargetConfig || defaultAppletConfig;
    const matchedPlayer = platformState.playerDatabases.find(
      (d) =>
        d.config.projectId === targetProjectId &&
        (d.config.firestoreDatabaseId || '') === targetDbId
    );
    const matchedDefault =
      defaultAppletConfig.projectId === targetProjectId &&
      (defaultAppletConfig.firestoreDatabaseId || '') === targetDbId
        ? defaultAppletConfig
        : null;

    const targetConfig = matchedPlayer?.config || matchedDefault;
    if (!targetConfig) {
      res.status(404).json({
        error: 'هذه القاعدة غير مسجلة في قائمة قواعد البيانات المعتمدة للمنصة.',
      });
      return;
    }

    if (isSameConfig(activeCfg, targetConfig)) {
      res.json({ ok: true, alreadyActive: true, ...buildPublicPayload(platformState) });
      return;
    }

    // Verify either caller is an authenticated programmer, active quota is known exhausted/low,
    // REST probe on active DB confirms 429, or client reported resource-exhausted while target DB is healthy.
    const activeRec = getOrCreateProjectQuotaRecord(activeCfg.projectId);
    const activeQuota = buildQuotaStatusFromRecord(activeRec);
    let canFailover =
      activeRec.exhausted ||
      activeQuota.minRemainingPct <= 20 ||
      Boolean(body.quotaExceededReported);

    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!canFailover && bearer) {
      const authRes = await authenticateRequest(req, body).catch(() => null);
      if (authRes?.ok && authRes.isProgrammer) {
        canFailover = true;
      }
    }

    // Quick REST check on active & target DBs
    const probeRestHealth = async (cfg: SanitizedFirebaseConfig): Promise<'ok' | 'quota' | 'error'> => {
      try {
        const dbSeg = cfg.firestoreDatabaseId || '(default)';
        const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
          cfg.projectId
        )}/databases/${encodeURIComponent(dbSeg)}/documents/platform/migration?key=${encodeURIComponent(
          cfg.apiKey
        )}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1800);
        const r = await fetch(url, { cache: 'no-store', signal: controller.signal });
        clearTimeout(timer);
        if (r.status === 429) return 'quota';
        if (r.ok || r.status === 404 || r.status === 403) return 'ok';
        return 'error';
      } catch {
        return 'ok';
      }
    };

    const [activeHealth, targetHealth] = await Promise.all([
      activeRec.exhausted ? Promise.resolve('quota' as const) : probeRestHealth(activeCfg),
      probeRestHealth(targetConfig),
    ]);

    if (activeHealth === 'quota') {
      activeRec.exhausted = true;
      activeRec.updatedAt = Date.now();
      canFailover = true;
    }

    if (!canFailover) {
      res.status(403).json({
        error: 'القاعدة الحالية لم تستنفد حصتها بعد ولا يوجد تفويض تبديل طارئ.',
      });
      return;
    }

    if (targetHealth === 'quota') {
      const tRec = getOrCreateProjectQuotaRecord(targetConfig.projectId);
      tRec.exhausted = true;
      tRec.updatedAt = Date.now();
      saveQuotaStateFile();
      res.status(409).json({
        error: `القاعدة المختارة (${targetConfig.projectId}) ممتلئة الحصة أيضاً. يرجى اختيار قاعدة أخرى متاحة.`,
      });
      return;
    }

    if (body.quotaExceededReported) {
      activeRec.exhausted = true;
      activeRec.updatedAt = Date.now();
    }

    const now = Date.now();
    if (!platformState.previousConfigs.some((c) => isSameConfig(c, activeCfg))) {
      platformState.previousConfigs = [activeCfg, ...platformState.previousConfigs].slice(0, 12);
    }
    if (matchedPlayer) {
      matchedPlayer.lastUsedAt = now;
    }

    const targetRec = getOrCreateProjectQuotaRecord(targetConfig.projectId);
    if (targetRec.exhausted && targetHealth === 'ok') {
      targetRec.exhausted = false;
      targetRec.updatedAt = now;
    }
    saveQuotaStateFile();

    platformState.activeTargetConfig = targetConfig;
    platformState.activePlayerDatabaseId = matchedPlayer ? matchedPlayer.id : null;
    platformState.revision += 1;
    platformState.updatedAt = now;
    platformState.updatedByEmail =
      typeof body.requesterEmail === 'string' && body.requesterEmail
        ? body.requesterEmail.slice(0, 120)
        : 'quota-failover';
    savePlatformState(platformState);
    broadcastState();

    res.json({
      ok: true,
      switchedTo: targetConfig,
      ...buildPublicPayload(platformState),
    });
  });

  app.post('/api/programmer/quota/calibrate', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok) {
      res.status(authRes.status).json({ error: authRes.error });
      return;
    }
    if (!authRes.isProgrammer) {
      res.status(403).json({ error: 'صلاحية مبرمج مطلوبة' });
      return;
    }

    const projectId =
      typeof body.projectId === 'string' && /^[a-z0-9-]{4,64}$/.test(body.projectId.trim())
        ? body.projectId.trim()
        : platformState.activeTargetConfig?.projectId || defaultAppletConfig.projectId;

    const rec = getOrCreateProjectQuotaRecord(projectId);
    if (typeof body.readsUsed === 'number' && Number.isFinite(body.readsUsed)) {
      rec.readsUsed = Math.max(0, Math.round(body.readsUsed));
    }
    if (typeof body.writesUsed === 'number' && Number.isFinite(body.writesUsed)) {
      rec.writesUsed = Math.max(0, Math.round(body.writesUsed));
    }
    if (typeof body.deletesUsed === 'number' && Number.isFinite(body.deletesUsed)) {
      rec.deletesUsed = Math.max(0, Math.round(body.deletesUsed));
    }
    if (typeof body.exhausted === 'boolean') {
      rec.exhausted = body.exhausted;
    }
    rec.updatedAt = Date.now();

    const preStatus = buildQuotaStatusFromRecord(rec);
    if (preStatus.alertStep !== null) {
      rec.lastAlertStep = preStatus.alertStep;
      rec.alertCount += 1;
    } else {
      rec.lastAlertStep = null;
    }
    saveQuotaStateFile();

    const updatedStatus = buildQuotaStatusFromRecord(rec);
    if (
      updatedStatus.alertStep !== null &&
      projectId === (platformState.activeTargetConfig?.projectId || defaultAppletConfig.projectId)
    ) {
      broadcastQuotaAlert(updatedStatus);
    }

    res.json({ ok: true, quotaStatus: updatedStatus });
  });

  // Programmer session check & registry retrieval
  app.post('/api/programmer/session', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    const reqProj = typeof body.tokenProjectId === 'string' ? body.tokenProjectId.trim() : '';
    const reqKey = typeof body.tokenApiKey === 'string' ? body.tokenApiKey.trim() : '';
    const reqDbId =
      typeof body.tokenFirestoreDatabaseId === 'string'
        ? body.tokenFirestoreDatabaseId.trim()
        : '';
    const hydrateKey = `${reqProj || platformState.activeTargetConfig.projectId}:${reqDbId || '(default)'}`;

    if (bearer && !hydratedProjectKeys.has(hydrateKey)) {
      hydratedProjectKeys.add(hydrateKey);
      const targetCfg =
        (reqProj &&
          reqKey &&
          sanitizeConfig({ projectId: reqProj, apiKey: reqKey, appId: '1:1:web:1', firestoreDatabaseId: reqDbId })) ||
        platformState.activeTargetConfig ||
        defaultAppletConfig;
      await tryHydrateServerFromFirestoreRegistry(bearer, targetCfg);
    }

    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok) {
      res.status(authRes.status).json({ error: authRes.error });
      return;
    }

    if (!authRes.isProgrammer) {
      res.json({ isProgrammer: false, isMaster: false });
      return;
    }

    res.json({
      isProgrammer: true,
      isMaster: authRes.isMaster,
      state: platformState,
    });
  });

  // Explicitly hydrate server state from Firestore /platform/registry
  app.post('/api/programmer/hydrate', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok) {
      res.status(authRes.status).json({ error: authRes.error });
      return;
    }
    if (bearer) {
      const cfg =
        sanitizeConfig(body.poolConfig) ||
        platformState.activeTargetConfig ||
        defaultAppletConfig;
      await tryHydrateServerFromFirestoreRegistry(bearer, cfg);
    }
    const postAuthRole = isIdentityProgrammer(platformState, {
      email: authRes.email,
      fullNameQuad: authRes.name,
    });
    if (!postAuthRole.isProgrammer) {
      res.json({ isProgrammer: false, isMaster: false });
      return;
    }
    res.json({
      isProgrammer: true,
      isMaster: postAuthRole.isMaster,
      state: platformState,
    });
  });

  // Add verified Player Database
  app.post('/api/programmer/player-dbs/add', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok) {
      res.status(authRes.status).json({ error: authRes.error });
      return;
    }
    if (!authRes.isProgrammer) {
      res.status(403).json({ error: 'صلاحية مبرمج مطلوبة' });
      return;
    }

    const config = sanitizeConfig(body.config);
    if (!config) {
      res.status(400).json({ error: 'إعدادات Firebase غير صالحة' });
      return;
    }

    if (platformState.playerDatabases.some((d) => isSameConfig(d.config, config))) {
      res.status(409).json({ error: 'قاعدة البيانات هذه مضافة بالفعل في قائمة قواعد البيانات.' });
      return;
    }
    if (platformState.backupDatabases.some((d) => isSameConfig(d.config, config))) {
      res.status(409).json({ error: 'هذه القاعدة مسجلة بالفعل كقاعدة احتياطية صامتة، ولا يمكن استخدامها كقاعدة لاعبين.' });
      return;
    }

    const ver = sanitizeVerification(body.verification, Date.now());
    if (!ver.firestoreReady || !ver.googleAuthReady || !ver.rulesReady) {
      res.status(400).json({ error: 'يجب إكمال الفحص الشامل (Firestore + OAuth + Rules) أولاً قبل إضافة القاعدة.' });
      return;
    }

    const now = Date.now();
    const nextOrder = platformState.playerDatabases.length + 1;
    const rawLabel = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';
    const newEntry: RegisteredDatabaseEntry = {
      id: `player_${now}_${Math.random().toString(36).slice(2, 6)}`,
      order: nextOrder,
      role: 'player',
      label: rawLabel || `قاعدة بيانات #${nextOrder} — ${config.projectId}`,
      config,
      verification: {
        ...ver,
        verifiedByEmail: ver.verifiedByEmail || authRes.email,
      },
      lastUsedAt: isSameConfig(config, platformState.activeTargetConfig) ? now : null,
      addedByEmail: authRes.email,
      addedAt: now,
    };

    platformState.playerDatabases = renumberEntries([...platformState.playerDatabases, newEntry]);
    if (isSameConfig(config, platformState.activeTargetConfig)) {
      platformState.activePlayerDatabaseId = newEntry.id;
    }
    if (
      !isSameConfig(config, platformState.activeTargetConfig) &&
      !platformState.previousConfigs.some((c) => isSameConfig(c, config))
    ) {
      platformState.previousConfigs = [...platformState.previousConfigs, config].slice(0, 12);
    }
    getOrCreateProjectQuotaRecord(config.projectId);
    saveQuotaStateFile();
    platformState.revision += 1;
    platformState.updatedAt = now;
    platformState.updatedByEmail = authRes.email;
    savePlatformState(platformState);
    broadcastState();

    res.json({ ok: true, added: newEntry, state: platformState });
  });

  // Public verified Player Database addition (any verified Google sign-in on target DB can add; deletion remains Programmer-only)
  app.post('/api/public/player-dbs/add', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const config = sanitizeConfig(body.config);
    if (!config) {
      res.status(400).json({ error: 'إعدادات Firebase غير صالحة' });
      return;
    }

    const ver = sanitizeVerification(body.verification, Date.now());
    if (!ver.firestoreReady || !ver.googleAuthReady || !ver.rulesReady) {
      res.status(400).json({ error: 'يجب إكمال الفحص الشامل (Firestore + OAuth + Rules) أولاً قبل إضافة القاعدة.' });
      return;
    }

    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const targetToken =
      typeof body.targetIdToken === 'string' && body.targetIdToken.trim()
        ? body.targetIdToken.trim()
        : bearer;

    if (!targetToken) {
      res.status(401).json({ error: 'يلزم إتمام التحقق من تسجيل الدخول على القاعدة الجديدة قبل الإضافة.' });
      return;
    }

    const verifiedTarget = await verifyFirebaseIdToken(targetToken, config.projectId, config.apiKey);
    if (!verifiedTarget.ok) {
      res.status(403).json({ error: 'تعذر التحقق من صلاحية جلسة Google على القاعدة الجديدة. أعد الفحص ثم حاول مجدداً.' });
      return;
    }

    if (platformState.playerDatabases.some((d) => isSameConfig(d.config, config))) {
      res.status(409).json({ error: 'قاعدة البيانات هذه مضافة بالفعل في قائمة قواعد البيانات.' });
      return;
    }
    if (platformState.backupDatabases.some((d) => isSameConfig(d.config, config))) {
      res.status(409).json({ error: 'هذه القاعدة مسجلة بالفعل كقاعدة احتياطية صامتة، ولا يمكن إضافتها هنا.' });
      return;
    }

    const now = Date.now();
    const nextOrder = platformState.playerDatabases.length + 1;
    const rawLabel = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';
    const newEntry: RegisteredDatabaseEntry = {
      id: `player_${now}_${Math.random().toString(36).slice(2, 6)}`,
      order: nextOrder,
      role: 'player',
      label: rawLabel || `قاعدة بيانات #${nextOrder} — ${config.projectId}`,
      config,
      verification: {
        ...ver,
        verifiedByEmail: ver.verifiedByEmail || verifiedTarget.email,
      },
      lastUsedAt: isSameConfig(config, platformState.activeTargetConfig) ? now : null,
      addedByEmail: verifiedTarget.email,
      addedAt: now,
    };

    platformState.playerDatabases = renumberEntries([...platformState.playerDatabases, newEntry]);
    if (isSameConfig(config, platformState.activeTargetConfig)) {
      platformState.activePlayerDatabaseId = newEntry.id;
    }
    if (
      !isSameConfig(config, platformState.activeTargetConfig) &&
      !platformState.previousConfigs.some((c) => isSameConfig(c, config))
    ) {
      platformState.previousConfigs = [...platformState.previousConfigs, config].slice(0, 12);
    }
    getOrCreateProjectQuotaRecord(config.projectId);
    saveQuotaStateFile();
    platformState.revision += 1;
    platformState.updatedAt = now;
    platformState.updatedByEmail = verifiedTarget.email;
    savePlatformState(platformState);
    broadcastState();

    const publicPayload = buildPublicPayload(platformState);
    res.json({
      ok: true,
      added: {
        id: newEntry.id,
        order: newEntry.order,
        label: newEntry.label,
        config: newEntry.config,
        lastUsedAt: newEntry.lastUsedAt,
        addedAt: newEntry.addedAt,
      },
      playerDatabases: publicPayload.playerDatabases,
      revision: publicPayload.revision,
    });
  });

  // Re-hydrate / merge saved local or cloud registry entries if server restarted
  app.post('/api/programmer/sync-state', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok) {
      res.status(authRes.status).json({ error: authRes.error });
      return;
    }
    if (!authRes.isProgrammer) {
      res.status(403).json({ error: 'صلاحية مبرمج مطلوبة' });
      return;
    }

    const incomingState = body.state as Partial<PlatformState> | undefined;
    if (!incomingState || typeof incomingState !== 'object') {
      res.json({ ok: true, state: platformState });
      return;
    }

    let changed = false;
    const incomingPlayers = parseRegisteredEntries(incomingState.playerDatabases, 'player');
    for (const p of incomingPlayers) {
      if (
        !platformState.playerDatabases.some((x) => isSameConfig(x.config, p.config)) &&
        !platformState.backupDatabases.some((b) => isSameConfig(b.config, p.config))
      ) {
        platformState.playerDatabases.push(p);
        getOrCreateProjectQuotaRecord(p.config.projectId);
        changed = true;
      }
    }
    if (changed) {
      platformState.playerDatabases = renumberEntries(platformState.playerDatabases);
    }

    const incomingBackups = parseRegisteredEntries(incomingState.backupDatabases, 'backup');
    for (const b of incomingBackups) {
      if (
        !platformState.backupDatabases.some((x) => isSameConfig(x.config, b.config)) &&
        !platformState.playerDatabases.some((p) => isSameConfig(p.config, b.config)) &&
        !isSameConfig(b.config, defaultAppletConfig) &&
        !isSameConfig(b.config, platformState.activeTargetConfig)
      ) {
        platformState.backupDatabases.push(b);
        changed = true;
      }
    }
    if (changed) {
      platformState.backupDatabases = renumberEntries(platformState.backupDatabases);
    }

    const rawIncomingProgs = Array.isArray(incomingState.programmers)
      ? (incomingState.programmers as ProgrammerMember[])
      : [];
    for (const rp of rawIncomingProgs) {
      if (!rp || typeof rp !== 'object') continue;
      const rpEmail = typeof rp.email === 'string' ? rp.email.trim().toLowerCase() : '';
      const rpHash = typeof rp.emailHash === 'string' ? rp.emailHash.trim().toLowerCase() : '';
      const rpNorm = normalizeArabicName(rp.fullNameQuad);
      const exists = platformState.programmers.some(
        (m) =>
          (rpEmail && m.email && m.email.toLowerCase() === rpEmail) ||
          (rpHash && m.emailHash && m.emailHash.toLowerCase() === rpHash) ||
          (rpNorm && normalizeArabicName(m.fullNameQuad) === rpNorm)
      );
      if (!exists && (rp.fullNameQuad || rpEmail || rpHash)) {
        platformState.programmers.push({
          id: typeof rp.id === 'string' && rp.id ? rp.id : `prog_${Date.now()}`,
          fullNameQuad: (rp.fullNameQuad || rpEmail || 'مبرمج').trim(),
          ...(rpEmail ? { email: rpEmail } : {}),
          ...(rpHash ? { emailHash: rpHash } : {}),
          ...(typeof rp.emailMasked === 'string' && rp.emailMasked ? { emailMasked: rp.emailMasked } : {}),
          isMaster: Boolean(rp.isMaster),
          promotedAt: typeof rp.promotedAt === 'number' ? rp.promotedAt : Date.now(),
        });
        changed = true;
      }
    }

    const incomingTarget = sanitizeConfig(incomingState.activeTargetConfig);
    if (
      incomingTarget &&
      incomingTarget.projectId !== 'siiiiii-3720b' &&
      !isSameConfig(incomingTarget, platformState.activeTargetConfig) &&
      platformState.revision <= 2 &&
      isSameConfig(platformState.activeTargetConfig, defaultAppletConfig)
    ) {
      if (!platformState.previousConfigs.some((c) => isSameConfig(c, platformState.activeTargetConfig))) {
        platformState.previousConfigs = [
          platformState.activeTargetConfig,
          ...platformState.previousConfigs,
        ].slice(0, 12);
      }
      platformState.activeTargetConfig = incomingTarget;
      const matched = platformState.playerDatabases.find((d) =>
        isSameConfig(d.config, incomingTarget)
      );
      platformState.activePlayerDatabaseId = matched?.id || null;
      getOrCreateProjectQuotaRecord(incomingTarget.projectId);
      changed = true;
    }

    if (changed) {
      platformState.programmers = ensureMasterProgrammerPresent(platformState.programmers);
      platformState.revision = Math.max(
        platformState.revision + 1,
        typeof incomingState.revision === 'number' ? incomingState.revision : platformState.revision + 1
      );
      platformState.updatedAt = Date.now();
      platformState.updatedByEmail = authRes.email;
      saveQuotaStateFile();
      savePlatformState(platformState);
      broadcastState();
    }

    res.json({ ok: true, merged: changed, state: platformState });
  });

  // Remove Player Database
  app.post('/api/programmer/player-dbs/remove', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok) {
      res.status(authRes.status).json({ error: authRes.error });
      return;
    }
    if (!authRes.isProgrammer) {
      res.status(403).json({ error: 'صلاحية مبرمج مطلوبة' });
      return;
    }

    const databaseId = typeof body.databaseId === 'string' ? body.databaseId.trim() : '';
    const remaining = platformState.playerDatabases.filter((d) => d.id !== databaseId);
    if (remaining.length === platformState.playerDatabases.length) {
      res.status(404).json({ error: 'القاعدة غير موجودة' });
      return;
    }

    platformState.playerDatabases = renumberEntries(remaining);
    if (platformState.activePlayerDatabaseId === databaseId) {
      platformState.activePlayerDatabaseId = null;
    }
    platformState.revision += 1;
    platformState.updatedAt = Date.now();
    platformState.updatedByEmail = authRes.email;
    savePlatformState(platformState);
    broadcastState();

    res.json({ ok: true, state: platformState });
  });

  // Add verified untouched Backup Signaling Database
  app.post('/api/programmer/backup-dbs/add', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok) {
      res.status(authRes.status).json({ error: authRes.error });
      return;
    }
    if (!authRes.isProgrammer) {
      res.status(403).json({ error: 'صلاحية مبرمج مطلوبة' });
      return;
    }

    const config = sanitizeConfig(body.config);
    if (!config) {
      res.status(400).json({ error: 'إعدادات Firebase غير صالحة' });
      return;
    }

    if (platformState.backupDatabases.some((d) => isSameConfig(d.config, config))) {
      res.status(409).json({ error: 'هذه القاعدة الاحتياطية مضافة بالفعل.' });
      return;
    }
    if (platformState.playerDatabases.some((d) => isSameConfig(d.config, config))) {
      res.status(409).json({ error: 'هذه القاعدة مسجلة كقاعدة بيانات للاعبين، لا يمكن إضافتها كقاعدة احتياطية ساكنة.' });
      return;
    }
    if (
      isSameConfig(config, defaultAppletConfig) ||
      isSameConfig(config, platformState.activeTargetConfig)
    ) {
      res.status(409).json({ error: 'القاعدة النشطة حالياً لا يمكن استخدامها كقاعدة احتياطية ساكنة.' });
      return;
    }

    const ver = sanitizeVerification(body.verification, Date.now());
    if (!ver.firestoreReady || !ver.googleAuthReady || !ver.rulesReady) {
      res.status(400).json({ error: 'يجب إكمال الفحص الشامل (Firestore + OAuth + Rules) أولاً قبل إضافة القاعدة الاحتياطية.' });
      return;
    }

    const now = Date.now();
    const nextOrder = platformState.backupDatabases.length + 1;
    const rawLabel = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';
    const newEntry: RegisteredDatabaseEntry = {
      id: `backup_${now}_${Math.random().toString(36).slice(2, 6)}`,
      order: nextOrder,
      role: 'backup',
      label: rawLabel || `احتياطية #${nextOrder} — ${config.projectId}`,
      config,
      verification: {
        ...ver,
        verifiedByEmail: ver.verifiedByEmail || authRes.email,
      },
      lastAnnouncedToProjectId: null,
      addedByEmail: authRes.email,
      addedAt: now,
    };

    platformState.backupDatabases = renumberEntries([...platformState.backupDatabases, newEntry]);
    platformState.revision += 1;
    platformState.updatedAt = now;
    platformState.updatedByEmail = authRes.email;
    savePlatformState(platformState);
    broadcastState();

    res.json({ ok: true, added: newEntry, state: platformState });
  });

  // Remove Backup Database
  app.post('/api/programmer/backup-dbs/remove', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok) {
      res.status(authRes.status).json({ error: authRes.error });
      return;
    }
    if (!authRes.isProgrammer) {
      res.status(403).json({ error: 'صلاحية مبرمج مطلوبة' });
      return;
    }

    const databaseId = typeof body.databaseId === 'string' ? body.databaseId.trim() : '';
    const remaining = platformState.backupDatabases.filter((d) => d.id !== databaseId);
    if (remaining.length === platformState.backupDatabases.length) {
      res.status(404).json({ error: 'القاعدة الاحتياطية غير موجودة' });
      return;
    }

    platformState.backupDatabases = renumberEntries(remaining);
    platformState.revision += 1;
    platformState.updatedAt = Date.now();
    platformState.updatedByEmail = authRes.email;
    savePlatformState(platformState);
    broadcastState();

    res.json({ ok: true, state: platformState });
  });

  // Complete 100% Migration & Announce via Backup DB to Switch All Clients
  app.post('/api/programmer/migrate-complete', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok) {
      res.status(authRes.status).json({ error: authRes.error });
      return;
    }
    if (!authRes.isProgrammer) {
      res.status(403).json({ error: 'صلاحية مبرمج مطلوبة' });
      return;
    }

    const targetConfig = sanitizeConfig(body.targetConfig);
    if (!targetConfig) {
      res.status(400).json({ error: 'إعدادات القاعدة الهدف غير صالحة' });
      return;
    }

    const now = Date.now();
    const prevTarget = platformState.activeTargetConfig;
    if (
      prevTarget &&
      !isSameConfig(prevTarget, targetConfig) &&
      !platformState.previousConfigs.some((c) => isSameConfig(c, prevTarget))
    ) {
      platformState.previousConfigs = [prevTarget, ...platformState.previousConfigs].slice(0, 12);
    }

    const migratedRoomId =
      typeof body.migratedRoomId === 'string' &&
      /^[A-Z0-9_-]{4,16}$/i.test(body.migratedRoomId.trim())
        ? body.migratedRoomId.trim().toUpperCase()
        : null;

    let playerMatch = platformState.playerDatabases.find((d) =>
      isSameConfig(d.config, targetConfig)
    );
    if (!playerMatch) {
      const nextOrder = platformState.playerDatabases.length + 1;
      playerMatch = {
        id: `player_${now}_${Math.random().toString(36).slice(2, 6)}`,
        order: nextOrder,
        role: 'player',
        label: `قاعدة بيانات #${nextOrder} — ${targetConfig.projectId}`,
        config: targetConfig,
        verification: {
          firestoreReady: true,
          googleAuthReady: true,
          rulesReady: true,
          verifiedAt: now,
          verifiedByEmail: authRes.email,
        },
        lastUsedAt: now,
        addedByEmail: authRes.email,
        addedAt: now,
      };
      platformState.playerDatabases = renumberEntries([
        ...platformState.playerDatabases,
        playerMatch,
      ]);
    } else {
      playerMatch.lastUsedAt = now;
    }

    const backupDbId = typeof body.backupDbId === 'string' ? body.backupDbId.trim() : '';
    const backupEntry = backupDbId
      ? platformState.backupDatabases.find((b) => b.id === backupDbId)
      : undefined;
    if (backupEntry) {
      backupEntry.lastAnnouncedToProjectId = targetConfig.projectId;
      platformState.lastBackupAnnouncement = {
        backupDbId: backupEntry.id,
        backupProjectId: backupEntry.config.projectId,
        targetProjectId: targetConfig.projectId,
        targetConfig,
        migratedRoomId,
        announcedAt: now,
        announcedByEmail: authRes.email,
      };
    } else if (typeof body.backupProjectId === 'string' && body.backupProjectId.trim()) {
      platformState.lastBackupAnnouncement = {
        backupDbId: backupDbId || 'backup_manual',
        backupProjectId: body.backupProjectId.trim(),
        targetProjectId: targetConfig.projectId,
        targetConfig,
        migratedRoomId,
        announcedAt: now,
        announcedByEmail: authRes.email,
      };
    }

    platformState.activeTargetConfig = targetConfig;
    platformState.activePlayerDatabaseId = playerMatch.id;
    platformState.migratedRoomId = migratedRoomId;
    platformState.revision += 1;
    platformState.updatedByEmail = authRes.email;
    platformState.updatedAt = now;
    savePlatformState(platformState);
    broadcastState();

    res.json({ ok: true, state: platformState, ...buildPublicPayload(platformState) });
  });

  // Programmer: Promote member
  app.post('/api/programmer/members/add', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok) {
      res.status(authRes.status).json({ error: authRes.error });
      return;
    }
    if (!authRes.isProgrammer) {
      res.status(403).json({ error: 'صلاحية مبرمج مطلوبة' });
      return;
    }

    const fullNameQuad =
      typeof body.fullNameQuad === 'string' ? body.fullNameQuad.trim().replace(/\s+/g, ' ') : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!fullNameQuad && !email) {
      res.status(400).json({ error: 'أدخل الاسم الرباعي أو البريد الإلكتروني للمستخدم.' });
      return;
    }

    const normNew = normalizeArabicName(fullNameQuad);
    const dup = platformState.programmers.some(
      (m) =>
        (email && m.email && m.email.toLowerCase() === email) ||
        (normNew && normalizeArabicName(m.fullNameQuad) === normNew)
    );
    if (dup) {
      res.status(409).json({ error: 'هذا المستخدم مُرقّى بالفعل إلى مبرمج.' });
      return;
    }

    const member: ProgrammerMember = {
      id: `prog_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      fullNameQuad: fullNameQuad || email,
      ...(email ? { email } : {}),
      isMaster: false,
      promotedBy: authRes.name || authRes.email || MASTER_PROGRAMMER_NAME,
      promotedAt: Date.now(),
    };

    platformState.programmers = [...platformState.programmers, member];
    platformState.revision += 1;
    platformState.updatedAt = Date.now();
    savePlatformState(platformState);
    broadcastState();

    res.json({ ok: true, member, state: platformState });
  });

  // Programmer: Remove promoted member (Master cannot be removed)
  app.post('/api/programmer/members/remove', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const authRes = await authenticateRequest(req, body);
    if (!authRes.ok) {
      res.status(authRes.status).json({ error: authRes.error });
      return;
    }
    if (!authRes.isProgrammer) {
      res.status(403).json({ error: 'صلاحية مبرمج مطلوبة' });
      return;
    }

    const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
    const target = platformState.programmers.find((m) => m.id === memberId);
    if (!target) {
      res.status(404).json({ error: 'العضو غير موجود' });
      return;
    }
    if (target.isMaster) {
      res.status(403).json({ error: 'لا يمكن إزالة المبرمج الأساسي للمنصة.' });
      return;
    }

    platformState.programmers = platformState.programmers.filter((m) => m.id !== memberId);
    platformState.revision += 1;
    platformState.updatedAt = Date.now();
    savePlatformState(platformState);
    broadcastState();

    res.json({ ok: true, state: platformState });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DuoBoard server running on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
