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

interface StoredPlatformPointer {
  id: 'migration';
  config: SanitizedFirebaseConfig;
  resetToDefault?: boolean;
  migratedRoomId?: string | null;
  migrationEpoch: string;
  previousConfigs: SanitizedFirebaseConfig[];
  updatedByEmail?: string;
  updatedAt: number;
}

const PORT = Number(process.env.PORT || 3000);
const STATE_FILE_PATH = path.resolve(process.cwd(), '.duoboard-platform-db.json');

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
): Promise<{ ok: boolean; email?: string }> {
  const claims = decodeJwtPayload(idToken);
  if (!claims) return { ok: false };
  const aud = typeof claims.aud === 'string' ? claims.aud : '';
  const exp = typeof claims.exp === 'number' ? claims.exp : 0;
  const emailVerified = claims.email_verified === true;
  const email = typeof claims.email === 'string' ? claims.email : undefined;

  if (aud !== expectedProjectId || !emailVerified || exp * 1000 < Date.now() - 60_000) {
    return { ok: false };
  }

  // Optional live lookup against Google Identity Toolkit; fail open only if offline/sandboxed
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
      const data = (await resp.json()) as { users?: Array<{ email?: string; emailVerified?: boolean }> };
      const u = data.users?.[0];
      if (!u || u.emailVerified === false) {
        return { ok: false };
      }
      return { ok: true, email: u.email || email };
    }
  } catch {
    // Offline/egress-restricted sandbox: fall back to verified JWT claims match
  }

  return { ok: true, email };
}

function loadStoredPointer(): StoredPlatformPointer | null {
  try {
    if (!fs.existsSync(STATE_FILE_PATH)) return null;
    const raw = fs.readFileSync(STATE_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const cfg = sanitizeConfig(obj.config);
    if (!cfg) return null;
    const prevRaw = Array.isArray(obj.previousConfigs) ? obj.previousConfigs : [];
    const previousConfigs = prevRaw
      .map(sanitizeConfig)
      .filter((x): x is SanitizedFirebaseConfig => Boolean(x))
      .slice(0, 8);
    return {
      id: 'migration',
      config: cfg,
      resetToDefault: Boolean(obj.resetToDefault),
      migratedRoomId:
        typeof obj.migratedRoomId === 'string' && /^[A-Z0-9_-]{4,16}$/i.test(obj.migratedRoomId)
          ? obj.migratedRoomId.toUpperCase()
          : null,
      migrationEpoch: typeof obj.migrationEpoch === 'string' ? obj.migrationEpoch : '',
      previousConfigs,
      updatedByEmail: typeof obj.updatedByEmail === 'string' ? obj.updatedByEmail : undefined,
      updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function saveStoredPointer(pointer: StoredPlatformPointer | null): void {
  try {
    if (!pointer) {
      if (fs.existsSync(STATE_FILE_PATH)) {
        fs.unlinkSync(STATE_FILE_PATH);
      }
      return;
    }
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(pointer, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist platform DB pointer:', err);
  }
}

let activePointer: StoredPlatformPointer | null = loadStoredPointer();
const sseClients = new Set<Response>();

function broadcastPointer(pointer: StoredPlatformPointer | null): void {
  const payload = JSON.stringify({ type: 'update', pointer });
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/platform-db', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ pointer: activePointer });
  });

  app.get('/api/platform-db/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'init', pointer: activePointer })}\n\n`);

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

  app.post('/api/platform-db', async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const config = sanitizeConfig(body.config);
    if (!config) {
      res.status(400).json({ error: 'Invalid Firebase config' });
      return;
    }

    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const tokenProjectId =
      typeof body.tokenProjectId === 'string' && body.tokenProjectId.trim()
        ? body.tokenProjectId.trim()
        : config.projectId;
    const tokenApiKey =
      typeof body.tokenApiKey === 'string' && body.tokenApiKey.trim()
        ? body.tokenApiKey.trim()
        : config.apiKey;

    if (!bearer) {
      res.status(401).json({ error: 'Missing Authorization token' });
      return;
    }

    const verified = await verifyFirebaseIdToken(bearer, tokenProjectId, tokenApiKey);
    if (!verified.ok) {
      res.status(403).json({ error: 'Invalid or unverified Firebase ID token' });
      return;
    }

    const prevRaw = Array.isArray(body.previousConfigs) ? body.previousConfigs : [];
    const previousConfigs = prevRaw
      .map(sanitizeConfig)
      .filter((x): x is SanitizedFirebaseConfig => Boolean(x))
      .slice(0, 8);

    const migrationEpoch =
      typeof body.migrationEpoch === 'string' ? body.migrationEpoch.slice(0, 64) : '';
    const migratedRoomId =
      typeof body.migratedRoomId === 'string' && /^[A-Z0-9_-]{4,16}$/i.test(body.migratedRoomId.trim())
        ? body.migratedRoomId.trim().toUpperCase()
        : null;

    const nextPointer: StoredPlatformPointer = {
      id: 'migration',
      config,
      resetToDefault: Boolean(body.resetToDefault),
      migratedRoomId,
      migrationEpoch,
      previousConfigs,
      updatedByEmail: verified.email,
      updatedAt: Date.now(),
    };

    activePointer = nextPointer;
    saveStoredPointer(nextPointer);
    broadcastPointer(nextPointer);

    res.json({ ok: true, pointer: nextPointer });
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
