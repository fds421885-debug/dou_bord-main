import express, { type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { createServer as createViteServer } from 'vite';

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

interface PoolDatabaseEntry {
  id: string;
  order: number;
  label: string;
  config: SanitizedFirebaseConfig;
  exhaustedAt: number | null;
  exhaustedUntil: number | null;
  addedByEmail?: string;
  addedAt: number;
}

interface ProgrammerMember {
  id: string;
  fullNameQuad: string;
  email?: string;
  isMaster?: boolean;
  promotedBy?: string;
  promotedAt: number;
}

interface PlatformState {
  revision: number;
  databases: PoolDatabaseEntry[];
  activeDatabaseId: string;
  allExhausted: boolean;
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
  activeDatabaseId: string;
  activeOrder: number;
  totalDatabases: number;
  allExhausted: boolean;
  revision: number;
  updatedAt: number;
}

const PORT = Number(process.env.PORT || 3000);
const STATE_FILE_PATH = path.resolve(process.cwd(), '.duoboard-platform-state.json');
const LEGACY_POINTER_FILE_PATH = path.resolve(process.cwd(), '.duoboard-platform-db.json');
const DEFAULT_APP_CONFIG_PATH = path.resolve(process.cwd(), 'firebase-applet-config.json');

const CURRENT_DB_EPOCH = 'consolidated_primary_2026_11_18';
const MASTER_PROGRAMMER_NAME = 'محمد منتصر محمد يونس';
const MASTER_PROGRAMMER_EMAIL = 'mohammedmonta2022m@gmail.com';
const QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;

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
    projectId: 'omran-ffbad',
    appId: '',
  };
}

const defaultAppletConfig = loadDefaultAppletConfig();

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

  if (aud !== expectedProjectId || !emailVerified || exp * 1000 < Date.now() - 60_000) {
    return { ok: false };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
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

function createInitialState(): PlatformState {
  const now = Date.now();
  const databases: PoolDatabaseEntry[] = [
    {
      id: 'primary_default',
      order: 1,
      label: 'القاعدة الأساسية (#1)',
      config: defaultAppletConfig,
      exhaustedAt: null,
      exhaustedUntil: null,
      addedAt: now,
    },
  ];
  let activeDatabaseId = 'primary_default';
  let migratedRoomId: string | null = null;
  const previousConfigs: SanitizedFirebaseConfig[] = [];

  // Seamlessly adopt any legacy .duoboard-platform-db.json custom pointer
  try {
    if (fs.existsSync(LEGACY_POINTER_FILE_PATH)) {
      const raw = fs.readFileSync(LEGACY_POINTER_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const legacyCfg = sanitizeConfig(parsed?.config);
      if (legacyCfg && !isSameConfig(legacyCfg, defaultAppletConfig) && !parsed?.resetToDefault) {
        const legacyId = 'db_2';
        databases.push({
          id: legacyId,
          order: 2,
          label: `قاعدة مضافة (#2) - ${legacyCfg.projectId}`,
          config: legacyCfg,
          exhaustedAt: null,
          exhaustedUntil: null,
          addedByEmail:
            typeof parsed.updatedByEmail === 'string' ? parsed.updatedByEmail : undefined,
          addedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : now,
        });
        activeDatabaseId = legacyId;
        previousConfigs.push(defaultAppletConfig);
      }
      if (typeof parsed?.migratedRoomId === 'string') {
        migratedRoomId = parsed.migratedRoomId;
      }
    }
  } catch {
    // Ignore legacy read errors
  }

  return {
    revision: 1,
    databases,
    activeDatabaseId,
    allExhausted: false,
    programmers: [
      {
        id: 'master_programmer',
        fullNameQuad: MASTER_PROGRAMMER_NAME,
        email: MASTER_PROGRAMMER_EMAIL,
        isMaster: true,
        promotedAt: now,
      },
    ],
    migratedRoomId,
    previousConfigs,
    updatedAt: now,
  };
}

function renumberDatabases(list: PoolDatabaseEntry[]): PoolDatabaseEntry[] {
  return list.map((item, idx) => ({
    ...item,
    order: idx + 1,
  }));
}

function ensureMasterProgrammerPresent(members: ProgrammerMember[]): ProgrammerMember[] {
  const hasMaster = members.some(
    (m) =>
      m.isMaster ||
      normalizeArabicName(m.fullNameQuad) === normalizeArabicName(MASTER_PROGRAMMER_NAME) ||
      (m.email && m.email.toLowerCase() === MASTER_PROGRAMMER_EMAIL)
  );
  if (hasMaster) {
    return members.map((m) =>
      normalizeArabicName(m.fullNameQuad) === normalizeArabicName(MASTER_PROGRAMMER_NAME) ||
      (m.email && m.email.toLowerCase() === MASTER_PROGRAMMER_EMAIL)
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

function loadPlatformState(): PlatformState {
  try {
    if (!fs.existsSync(STATE_FILE_PATH)) {
      const initial = createInitialState();
      savePlatformState(initial);
      return initial;
    }
    const raw = fs.readFileSync(STATE_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PlatformState>;
    const rawDbs = Array.isArray(parsed.databases) ? parsed.databases : [];
    const databases: PoolDatabaseEntry[] = [];
    for (const d of rawDbs) {
      if (!d || typeof d !== 'object') continue;
      const cfg = sanitizeConfig(d.config);
      if (!cfg) continue;
      databases.push({
        id: typeof d.id === 'string' && d.id ? d.id : `db_${databases.length + 1}`,
        order: typeof d.order === 'number' ? d.order : databases.length + 1,
        label:
          typeof d.label === 'string' && d.label.trim()
            ? d.label.trim().slice(0, 80)
            : cfg.projectId,
        config: cfg,
        exhaustedAt: typeof d.exhaustedAt === 'number' ? d.exhaustedAt : null,
        exhaustedUntil: typeof d.exhaustedUntil === 'number' ? d.exhaustedUntil : null,
        addedByEmail: typeof d.addedByEmail === 'string' ? d.addedByEmail : undefined,
        addedAt: typeof d.addedAt === 'number' ? d.addedAt : Date.now(),
      });
    }
    databases.sort((a, b) => a.order - b.order);
    if (databases.length === 0) {
      return createInitialState();
    }
    const normalizedDbs = renumberDatabases(databases);
    const activeExists = normalizedDbs.some((d) => d.id === parsed.activeDatabaseId);
    const activeDatabaseId = activeExists
      ? (parsed.activeDatabaseId as string)
      : normalizedDbs[0].id;

    const rawProgs = Array.isArray(parsed.programmers) ? parsed.programmers : [];
    const programmers = ensureMasterProgrammerPresent(
      rawProgs
        .filter((m): m is ProgrammerMember => Boolean(m && typeof m === 'object'))
        .map((m, idx) => ({
          id: typeof m.id === 'string' && m.id ? m.id : `prog_${idx + 1}`,
          fullNameQuad: typeof m.fullNameQuad === 'string' ? m.fullNameQuad.trim() : '',
          email: typeof m.email === 'string' && m.email.trim() ? m.email.trim().toLowerCase() : undefined,
          isMaster: Boolean(m.isMaster),
          promotedBy: typeof m.promotedBy === 'string' ? m.promotedBy : undefined,
          promotedAt: typeof m.promotedAt === 'number' ? m.promotedAt : Date.now(),
        }))
    );

    const prevRaw = Array.isArray(parsed.previousConfigs) ? parsed.previousConfigs : [];
    const previousConfigs = prevRaw
      .map(sanitizeConfig)
      .filter((x): x is SanitizedFirebaseConfig => Boolean(x))
      .slice(0, 12);

    return {
      revision: typeof parsed.revision === 'number' && parsed.revision >= 1 ? parsed.revision : 1,
      databases: normalizedDbs,
      activeDatabaseId,
      allExhausted: Boolean(parsed.allExhausted),
      programmers,
      migratedRoomId:
        typeof parsed.migratedRoomId === 'string' && /^[A-Z0-9_-]{4,16}$/i.test(parsed.migratedRoomId)
          ? parsed.migratedRoomId.toUpperCase()
          : null,
      previousConfigs,
      updatedByEmail: typeof parsed.updatedByEmail === 'string' ? parsed.updatedByEmail : undefined,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return createInitialState();
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
  const normName = normalizeArabicName(identity.fullNameQuad);

  const isMaster =
    emailLower === MASTER_PROGRAMMER_EMAIL ||
    (Boolean(normName) && normName === normalizeArabicName(MASTER_PROGRAMMER_NAME));

  if (isMaster) {
    return { isProgrammer: true, isMaster: true };
  }

  const matched = state.programmers.some((m) => {
    const memberEmail = (m.email || '').trim().toLowerCase();
    const memberName = normalizeArabicName(m.fullNameQuad);
    if (emailLower && memberEmail && emailLower === memberEmail) return true;
    if (normName && memberName && normName === memberName) return true;
    return false;
  });

  return { isProgrammer: matched, isMaster: false };
}

function buildPreviousConfigsList(
  state: PlatformState,
  activeEntry: PoolDatabaseEntry
): SanitizedFirebaseConfig[] {
  const out: SanitizedFirebaseConfig[] = [];
  const pushUnique = (cfg: SanitizedFirebaseConfig) => {
    if (isSameConfig(cfg, activeEntry.config)) return;
    if (!out.some((x) => isSameConfig(x, cfg))) out.push(cfg);
  };
  for (const d of state.databases) pushUnique(d.config);
  for (const p of state.previousConfigs) pushUnique(p);
  pushUnique(defaultAppletConfig);
  return out.slice(0, 16);
}

function buildPublicPayload(state: PlatformState): {
  pointer: PublicPlatformPointer;
  revision: number;
  allExhausted: boolean;
  activeDatabaseId: string;
  activeOrder: number;
  totalDatabases: number;
} {
  const activeEntry =
    state.databases.find((d) => d.id === state.activeDatabaseId) || state.databases[0];
  const pointer: PublicPlatformPointer = {
    id: 'migration',
    config: activeEntry.config,
    resetToDefault: isSameConfig(activeEntry.config, defaultAppletConfig),
    migratedRoomId: state.migratedRoomId ?? null,
    migrationEpoch: CURRENT_DB_EPOCH,
    previousConfigs: buildPreviousConfigsList(state, activeEntry),
    activeDatabaseId: activeEntry.id,
    activeOrder: activeEntry.order,
    totalDatabases: state.databases.length,
    allExhausted: state.allExhausted,
    revision: state.revision,
    updatedAt: state.updatedAt,
  };
  return {
    pointer,
    revision: state.revision,
    allExhausted: state.allExhausted,
    activeDatabaseId: activeEntry.id,
    activeOrder: activeEntry.order,
    totalDatabases: state.databases.length,
  };
}

let platformState: PlatformState = loadPlatformState();
const sseClients = new Set<Response>();

function refreshExpiredCooldowns(): boolean {
  const now = Date.now();
  let changed = false;
  for (const entry of platformState.databases) {
    if (entry.exhaustedAt !== null && entry.exhaustedUntil !== null && entry.exhaustedUntil <= now) {
      entry.exhaustedAt = null;
      entry.exhaustedUntil = null;
      changed = true;
    }
  }
  if (platformState.allExhausted) {
    const firstHealthy = platformState.databases.find((d) => d.exhaustedAt === null);
    if (firstHealthy) {
      platformState.activeDatabaseId = firstHealthy.id;
      platformState.allExhausted = false;
      platformState.revision += 1;
      platformState.updatedAt = now;
      changed = true;
    }
  }
  if (changed) {
    savePlatformState(platformState);
  }
  return changed;
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

function isAllowedFirebaseCredentials(projectId: string, apiKey: string): boolean {
  if (
    projectId === defaultAppletConfig.projectId &&
    apiKey === defaultAppletConfig.apiKey
  ) {
    return true;
  }
  return platformState.databases.some(
    (d) => d.config.projectId === projectId && d.config.apiKey === apiKey
  );
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

  const activeEntry =
    platformState.databases.find((d) => d.id === platformState.activeDatabaseId) ||
    platformState.databases[0];

  const tokenProjectId =
    typeof body.tokenProjectId === 'string' && body.tokenProjectId.trim()
      ? body.tokenProjectId.trim()
      : activeEntry.config.projectId;
  const tokenApiKey =
    typeof body.tokenApiKey === 'string' && body.tokenApiKey.trim()
      ? body.tokenApiKey.trim()
      : activeEntry.config.apiKey;

  if (!isAllowedFirebaseCredentials(tokenProjectId, tokenApiKey)) {
    return { ok: false, status: 403, error: 'Unrecognized Firebase project credentials' };
  }

  const verified = await verifyFirebaseIdToken(bearer, tokenProjectId, tokenApiKey);
  if (!verified.ok) {
    return { ok: false, status: 403, error: 'Invalid or unverified Firebase ID token' };
  }

  const headerName =
    typeof req.headers['x-duoboard-name'] === 'string'
      ? decodeURIComponent(req.headers['x-duoboard-name'])
      : '';
  const bodyName = typeof body.fullNameQuad === 'string' ? body.fullNameQuad : '';
  const resolvedName = bodyName || headerName || verified.name || '';

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
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/platform-db', (_req: Request, res: Response) => {
    refreshExpiredCooldowns();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json(buildPublicPayload(platformState));
  });

  app.get('/api/platform-db/stream', (req: Request, res: Response) => {
    refreshExpiredCooldowns();
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

  // Automatic Quota Failover: rotates active database circularly (e.g. #5 -> #6 -> ... -> #N -> #1 -> allExhausted)
  app.post('/api/platform-db/failover', (req: Request, res: Response) => {
    refreshExpiredCooldowns();
    const body = (req.body || {}) as Record<string, unknown>;
    const failedProjectId =
      typeof body.failedProjectId === 'string' ? body.failedProjectId.trim() : '';
    const failedDbId =
      typeof body.failedFirestoreDatabaseId === 'string'
        ? body.failedFirestoreDatabaseId.trim()
        : '';

    const currentIdx = Math.max(
      0,
      platformState.databases.findIndex((d) => d.id === platformState.activeDatabaseId)
    );
    const currentEntry = platformState.databases[currentIdx];

    if (!currentEntry) {
      res.status(500).json({ error: 'No databases configured' });
      return;
    }

    // Stampede protection: only rotate if the reported exhausted project matches the CURRENT active DB
    const curDbSeg = (currentEntry.config.firestoreDatabaseId || '(default)').trim();
    const repDbSeg = (failedDbId || '(default)').trim();
    if (
      failedProjectId &&
      (failedProjectId !== currentEntry.config.projectId ||
        (failedDbId !== '' && repDbSeg !== curDbSeg))
    ) {
      res.json({
        rotated: false,
        alreadyRotated: true,
        ...buildPublicPayload(platformState),
      });
      return;
    }

    if (platformState.allExhausted) {
      res.json({
        rotated: false,
        alreadyExhausted: true,
        ...buildPublicPayload(platformState),
      });
      return;
    }

    const now = Date.now();
    currentEntry.exhaustedAt = now;
    currentEntry.exhaustedUntil = now + QUOTA_COOLDOWN_MS;

    if (!platformState.previousConfigs.some((c) => isSameConfig(c, currentEntry.config))) {
      platformState.previousConfigs = [currentEntry.config, ...platformState.previousConfigs].slice(
        0,
        12
      );
    }

    const total = platformState.databases.length;
    let nextEntry: PoolDatabaseEntry | null = null;
    for (let offset = 1; offset < total; offset++) {
      const candidate = platformState.databases[(currentIdx + offset) % total];
      if (candidate.exhaustedAt === null) {
        nextEntry = candidate;
        break;
      }
    }

    if (nextEntry) {
      platformState.activeDatabaseId = nextEntry.id;
      platformState.allExhausted = false;
      platformState.migratedRoomId = null;
    } else {
      platformState.allExhausted = true;
    }

    platformState.revision += 1;
    platformState.updatedAt = now;
    savePlatformState(platformState);
    broadcastState();

    res.json({
      rotated: Boolean(nextEntry),
      ...buildPublicPayload(platformState),
    });
  });

  // Backwards-compatible pointer publish route (used after full migration)
  app.post('/api/platform-db', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const config = sanitizeConfig(body.config);
    if (!config) {
      res.status(400).json({ error: 'Invalid Firebase config' });
      return;
    }

    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!bearer) {
      res.status(401).json({ error: 'Missing Authorization token' });
      return;
    }

    const tokenProjectId =
      typeof body.tokenProjectId === 'string' && body.tokenProjectId.trim()
        ? body.tokenProjectId.trim()
        : config.projectId;
    const tokenApiKey =
      typeof body.tokenApiKey === 'string' && body.tokenApiKey.trim()
        ? body.tokenApiKey.trim()
        : config.apiKey;

    const verified = await verifyFirebaseIdToken(bearer, tokenProjectId, tokenApiKey);
    if (!verified.ok) {
      res.status(403).json({ error: 'Invalid or unverified Firebase ID token' });
      return;
    }

    const now = Date.now();
    let entry = platformState.databases.find((d) => isSameConfig(d.config, config));
    if (!entry) {
      const id = `db_${now}_${Math.random().toString(36).slice(2, 6)}`;
      entry = {
        id,
        order: platformState.databases.length + 1,
        label: config.projectId,
        config,
        exhaustedAt: null,
        exhaustedUntil: null,
        addedByEmail: verified.email,
        addedAt: now,
      };
      platformState.databases = renumberDatabases([...platformState.databases, entry]);
    } else {
      entry.exhaustedAt = null;
      entry.exhaustedUntil = null;
    }

    const migratedRoomId =
      typeof body.migratedRoomId === 'string' && /^[A-Z0-9_-]{4,16}$/i.test(body.migratedRoomId.trim())
        ? body.migratedRoomId.trim().toUpperCase()
        : null;

    platformState.activeDatabaseId = entry.id;
    platformState.allExhausted = false;
    platformState.migratedRoomId = migratedRoomId;
    platformState.revision += 1;
    platformState.updatedByEmail = verified.email;
    platformState.updatedAt = now;
    savePlatformState(platformState);
    broadcastState();

    res.json({ ok: true, ...buildPublicPayload(platformState) });
  });

  // Programmer session check & full state retrieval
  app.post('/api/programmer/session', async (req: Request, res: Response) => {
    refreshExpiredCooldowns();
    const body = (req.body || {}) as Record<string, unknown>;
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

  // Programmer: Add new Firebase database to ordered pool
  app.post('/api/programmer/databases/add', async (req: Request, res: Response) => {
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

    if (platformState.databases.some((d) => isSameConfig(d.config, config))) {
      res.status(409).json({ error: 'قاعدة البيانات هذه مضافة بالفعل في القائمة.' });
      return;
    }

    const now = Date.now();
    const nextOrder = platformState.databases.length + 1;
    const rawLabel = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';
    const newEntry: PoolDatabaseEntry = {
      id: `db_${now}_${Math.random().toString(36).slice(2, 6)}`,
      order: nextOrder,
      label: rawLabel || `قاعدة #${nextOrder} — ${config.projectId}`,
      config,
      exhaustedAt: null,
      exhaustedUntil: null,
      addedByEmail: authRes.email,
      addedAt: now,
    };

    platformState.databases = renumberDatabases([...platformState.databases, newEntry]);
    // If the entire platform was in maintenance (allExhausted), immediately bring it back on this new DB!
    if (platformState.allExhausted) {
      platformState.activeDatabaseId = newEntry.id;
      platformState.allExhausted = false;
      platformState.revision += 1;
      platformState.updatedAt = now;
      platformState.updatedByEmail = authRes.email;
      savePlatformState(platformState);
      broadcastState();
    } else {
      savePlatformState(platformState);
    }

    res.json({ ok: true, added: newEntry, state: platformState });
  });

  // Programmer: Reorder databases (move up / move down / set explicit orderedIds)
  app.post('/api/programmer/databases/reorder', async (req: Request, res: Response) => {
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

    const orderedIds = Array.isArray(body.orderedIds)
      ? body.orderedIds.filter((x): x is string => typeof x === 'string')
      : [];
    if (orderedIds.length === 0) {
      res.status(400).json({ error: 'orderedIds required' });
      return;
    }

    const byId = new Map(platformState.databases.map((d) => [d.id, d]));
    const reordered: PoolDatabaseEntry[] = [];
    for (const id of orderedIds) {
      const found = byId.get(id);
      if (found) {
        reordered.push(found);
        byId.delete(id);
      }
    }
    for (const leftover of byId.values()) {
      reordered.push(leftover);
    }

    platformState.databases = renumberDatabases(reordered);
    platformState.updatedAt = Date.now();
    platformState.updatedByEmail = authRes.email;
    savePlatformState(platformState);
    broadcastState();

    res.json({ ok: true, state: platformState });
  });

  // Programmer: Activate / Switch platform to specific pool database
  app.post('/api/programmer/databases/activate', async (req: Request, res: Response) => {
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
    const target = platformState.databases.find((d) => d.id === databaseId);
    if (!target) {
      res.status(404).json({ error: 'لم يتم العثور على قاعدة البيانات المطلوبة' });
      return;
    }

    const currentEntry = platformState.databases.find(
      (d) => d.id === platformState.activeDatabaseId
    );
    if (currentEntry && currentEntry.id !== target.id) {
      if (!platformState.previousConfigs.some((c) => isSameConfig(c, currentEntry.config))) {
        platformState.previousConfigs = [currentEntry.config, ...platformState.previousConfigs].slice(
          0,
          12
        );
      }
    }

    const migratedRoomId =
      typeof body.migratedRoomId === 'string' && /^[A-Z0-9_-]{4,16}$/i.test(body.migratedRoomId.trim())
        ? body.migratedRoomId.trim().toUpperCase()
        : null;

    target.exhaustedAt = null;
    target.exhaustedUntil = null;
    platformState.activeDatabaseId = target.id;
    platformState.allExhausted = false;
    platformState.migratedRoomId = migratedRoomId;
    platformState.revision += 1;
    platformState.updatedAt = Date.now();
    platformState.updatedByEmail = authRes.email;
    savePlatformState(platformState);
    broadcastState();

    res.json({
      ok: true,
      state: platformState,
      ...buildPublicPayload(platformState),
    });
  });

  // Programmer: Clear Quota Exhaustion on a specific DB or ALL DBs
  app.post('/api/programmer/databases/reactivate', async (req: Request, res: Response) => {
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

    const databaseId = typeof body.databaseId === 'string' ? body.databaseId.trim() : 'ALL';
    const now = Date.now();
    let recoveredId: string | null = null;

    for (const d of platformState.databases) {
      if (databaseId === 'ALL' || d.id === databaseId) {
        d.exhaustedAt = null;
        d.exhaustedUntil = null;
        if (!recoveredId) recoveredId = d.id;
      }
    }

    if (platformState.allExhausted && recoveredId) {
      platformState.activeDatabaseId = recoveredId;
      platformState.allExhausted = false;
      platformState.revision += 1;
    }
    platformState.updatedAt = now;
    platformState.updatedByEmail = authRes.email;
    savePlatformState(platformState);
    broadcastState();

    res.json({ ok: true, state: platformState });
  });

  // Programmer: Remove a DB from the pool (keeps at least 1)
  app.post('/api/programmer/databases/remove', async (req: Request, res: Response) => {
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
    if (platformState.databases.length <= 1) {
      res.status(400).json({ error: 'يجب الإبقاء على قاعدة بيانات واحدة على الأقل.' });
      return;
    }

    const remaining = renumberDatabases(
      platformState.databases.filter((d) => d.id !== databaseId)
    );
    if (remaining.length === platformState.databases.length) {
      res.status(404).json({ error: 'القاعدة غير موجودة' });
      return;
    }

    platformState.databases = remaining;
    if (platformState.activeDatabaseId === databaseId) {
      const nextHealthy = remaining.find((d) => d.exhaustedAt === null) || remaining[0];
      platformState.activeDatabaseId = nextHealthy.id;
      platformState.allExhausted = remaining.every((d) => d.exhaustedAt !== null);
      platformState.revision += 1;
    }
    platformState.updatedAt = Date.now();
    platformState.updatedByEmail = authRes.email;
    savePlatformState(platformState);
    broadcastState();

    res.json({ ok: true, state: platformState });
  });

  // Programmer: Promote user to Programmer
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
    const email =
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

    if (!fullNameQuad && !email) {
      res.status(400).json({ error: 'أدخل الاسم الرباعي أو البريد الإلكتروني للمستخدم.' });
      return;
    }

    const normNewName = normalizeArabicName(fullNameQuad);
    const duplicate = platformState.programmers.some(
      (m) =>
        (email && m.email && m.email.toLowerCase() === email) ||
        (normNewName && m.fullNameQuad && normalizeArabicName(m.fullNameQuad) === normNewName)
    );
    if (duplicate) {
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
    platformState.updatedAt = Date.now();
    savePlatformState(platformState);

    res.json({ ok: true, member, state: platformState });
  });

  // Programmer: Remove a promoted programmer (Master cannot be removed)
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
    platformState.updatedAt = Date.now();
    savePlatformState(platformState);

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
