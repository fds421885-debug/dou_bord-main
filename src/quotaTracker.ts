import { type User } from 'firebase/auth';
import { isBackendServerDetected, resolveApiUrl } from './apiBase';
import { activeFirebaseConfig, activeProjectId } from './firebase';

export const SPARK_DAILY_LIMITS = {
  reads: 50_000,
  writes: 20_000,
  deletes: 20_000,
} as const;

export type QuotaMetricKind = 'reads' | 'writes' | 'deletes';

export interface ProjectQuotaStatus {
  projectId: string;
  dateKey: string;
  readsUsed: number;
  writesUsed: number;
  deletesUsed: number;
  readsLimit: number;
  writesLimit: number;
  deletesLimit: number;
  readsRemainingPct: number;
  writesRemainingPct: number;
  deletesRemainingPct: number;
  minRemainingPct: number;
  bottleneckMetric: QuotaMetricKind;
  bottleneckRemainingCount: number;
  alertStep: number | null; // 5.0, 4.5, 4.0, ... 0.0 when <= 5% remaining
  lastAlertStep: number | null;
  alertCount: number;
  exhausted: boolean;
  updatedAt: number;
}

const LOCAL_QUOTA_KEY_PREFIX = 'duoboard_quota_usage_v1_';

export function getFirebaseQuotaDateKey(): string {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Computes the quantized 0.5% warning step whenever remaining Spark quota hits <= 5.0%.
 * - > 5.00% => null (healthy)
 * - 5.00% .. 4.51% => 5.0
 * - 4.50% .. 4.01% => 4.5
 * - ...
 * - 0.50% .. 0.01% => 0.5
 * - <= 0.00% => 0.0
 */
export function computeQuotaAlertStep(minRemainingPct: number): number | null {
  if (!Number.isFinite(minRemainingPct) || minRemainingPct > 5.0) return null;
  if (minRemainingPct <= 0.0001) return 0;
  return Math.max(0, Math.min(5.0, Math.ceil(minRemainingPct * 2 - 1e-9) / 2));
}

export function buildProjectQuotaStatus(params: {
  projectId: string;
  dateKey?: string;
  readsUsed: number;
  writesUsed: number;
  deletesUsed: number;
  exhausted?: boolean;
  lastAlertStep?: number | null;
  alertCount?: number;
  updatedAt?: number;
}): ProjectQuotaStatus {
  const dateKey = params.dateKey || getFirebaseQuotaDateKey();
  const readsUsed = Math.max(0, Math.round(params.readsUsed || 0));
  const writesUsed = Math.max(0, Math.round(params.writesUsed || 0));
  const deletesUsed = Math.max(0, Math.round(params.deletesUsed || 0));
  const exhausted = Boolean(params.exhausted);

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

  const alertStep = computeQuotaAlertStep(minRemainingPct);

  return {
    projectId: params.projectId,
    dateKey,
    readsUsed,
    writesUsed,
    deletesUsed,
    readsLimit: SPARK_DAILY_LIMITS.reads,
    writesLimit: SPARK_DAILY_LIMITS.writes,
    deletesLimit: SPARK_DAILY_LIMITS.deletes,
    readsRemainingPct,
    writesRemainingPct,
    deletesRemainingPct,
    minRemainingPct,
    bottleneckMetric,
    bottleneckRemainingCount,
    alertStep,
    lastAlertStep:
      params.lastAlertStep !== undefined ? params.lastAlertStep : alertStep,
    alertCount: Math.max(0, Math.round(params.alertCount || 0)),
    exhausted,
    updatedAt: params.updatedAt || Date.now(),
  };
}

export function formatQuotaMetricArabic(metric: QuotaMetricKind): string {
  switch (metric) {
    case 'reads':
      return 'عمليات القراءة (Reads)';
    case 'writes':
      return 'عمليات الكتابة والتحديث (Writes)';
    case 'deletes':
      return 'عمليات الحذف (Deletes)';
  }
}

interface PendingOps {
  reads: number;
  writes: number;
  deletes: number;
  exhausted: boolean;
}

const localStatusByProject = new Map<string, ProjectQuotaStatus>();
const pendingOpsByProject = new Map<string, PendingOps>();
const listeners = new Set<(status: ProjectQuotaStatus) => void>();
let flushTimer: number | null = null;

function readLocalStoredQuota(projectId: string, dateKey: string): ProjectQuotaStatus {
  try {
    const raw = localStorage.getItem(`${LOCAL_QUOTA_KEY_PREFIX}${projectId}_${dateKey}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ProjectQuotaStatus>;
      return buildProjectQuotaStatus({
        projectId,
        dateKey,
        readsUsed: Number(parsed.readsUsed || 0),
        writesUsed: Number(parsed.writesUsed || 0),
        deletesUsed: Number(parsed.deletesUsed || 0),
        exhausted: Boolean(parsed.exhausted),
        lastAlertStep:
          typeof parsed.lastAlertStep === 'number' ? parsed.lastAlertStep : null,
        alertCount: Number(parsed.alertCount || 0),
        updatedAt: Number(parsed.updatedAt || Date.now()),
      });
    }
  } catch {
    // Ignore storage errors
  }
  return buildProjectQuotaStatus({
    projectId,
    dateKey,
    readsUsed: 0,
    writesUsed: 0,
    deletesUsed: 0,
  });
}

function saveLocalStoredQuota(status: ProjectQuotaStatus): void {
  try {
    localStorage.setItem(
      `${LOCAL_QUOTA_KEY_PREFIX}${status.projectId}_${status.dateKey}`,
      JSON.stringify(status)
    );
  } catch {
    // Ignore storage errors
  }
}

function notifyListeners(status: ProjectQuotaStatus): void {
  for (const fn of listeners) {
    try {
      fn(status);
    } catch {
      // Ignore subscriber errors
    }
  }
}

export function getCachedProjectQuotaStatus(projectId = activeProjectId): ProjectQuotaStatus {
  const dateKey = getFirebaseQuotaDateKey();
  const existing = localStatusByProject.get(projectId);
  if (existing && existing.dateKey === dateKey) {
    return existing;
  }
  const loaded = readLocalStoredQuota(projectId, dateKey);
  localStatusByProject.set(projectId, loaded);
  return loaded;
}

export function subscribeQuotaStatus(
  listener: (status: ProjectQuotaStatus) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function applyServerQuotaStatus(incoming: ProjectQuotaStatus | null | undefined): void {
  if (!incoming || !incoming.projectId) return;
  const dateKey = getFirebaseQuotaDateKey();
  const normalized = buildProjectQuotaStatus({
    projectId: incoming.projectId,
    dateKey: incoming.dateKey || dateKey,
    readsUsed: incoming.readsUsed,
    writesUsed: incoming.writesUsed,
    deletesUsed: incoming.deletesUsed,
    exhausted: incoming.exhausted,
    lastAlertStep: incoming.lastAlertStep,
    alertCount: incoming.alertCount,
    updatedAt: incoming.updatedAt || Date.now(),
  });

  const current = localStatusByProject.get(incoming.projectId);
  const currentMatchesDay = current && current.dateKey === normalized.dateKey;
  if (
    currentMatchesDay &&
    current.readsUsed > normalized.readsUsed &&
    current.writesUsed > normalized.writesUsed &&
    current.deletesUsed > normalized.deletesUsed &&
    normalized.updatedAt < current.updatedAt
  ) {
    return;
  }

  localStatusByProject.set(normalized.projectId, normalized);
  saveLocalStoredQuota(normalized);
  notifyListeners(normalized);
}

async function flushPendingQuotaReports(): Promise<void> {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!isBackendServerDetected()) {
    pendingOpsByProject.clear();
    return;
  }
  const entries = Array.from(pendingOpsByProject.entries());
  if (entries.length === 0) return;

  for (const [projectId, ops] of entries) {
    if (ops.reads === 0 && ops.writes === 0 && ops.deletes === 0 && !ops.exhausted) {
      pendingOpsByProject.delete(projectId);
      continue;
    }
    pendingOpsByProject.delete(projectId);
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 3500);
      const resp = await fetch(resolveApiUrl('/api/quota/report'), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          reads: ops.reads,
          writes: ops.writes,
          deletes: ops.deletes,
          exhausted: ops.exhausted,
        }),
      });
      window.clearTimeout(timer);
      const contentType = resp.headers.get('content-type') || '';
      if (resp.ok && contentType.includes('application/json')) {
        const data = (await resp.json()) as { ok?: boolean; quotaStatus?: ProjectQuotaStatus };
        if (data?.quotaStatus) {
          applyServerQuotaStatus(data.quotaStatus);
        }
      }
    } catch {
      // Static host or transient error — local counters remain active
    }
  }
}

function scheduleQuotaFlush(immediate = false): void {
  if (immediate) {
    void flushPendingQuotaReports();
    return;
  }
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushPendingQuotaReports();
  }, 2200);
}

export function recordFirestoreOperations(
  projectId: string | undefined | null,
  ops: { reads?: number; writes?: number; deletes?: number; exhausted?: boolean }
): void {
  const resolvedProject = (projectId || activeProjectId || '').trim();
  if (!resolvedProject) return;

  const reads = Math.max(0, Math.round(ops.reads || 0));
  const writes = Math.max(0, Math.round(ops.writes || 0));
  const deletes = Math.max(0, Math.round(ops.deletes || 0));
  const exhausted = Boolean(ops.exhausted);

  if (reads === 0 && writes === 0 && deletes === 0 && !exhausted) return;

  const prev = getCachedProjectQuotaStatus(resolvedProject);
  const nextRaw = buildProjectQuotaStatus({
    projectId: resolvedProject,
    dateKey: prev.dateKey,
    readsUsed: prev.readsUsed + reads,
    writesUsed: prev.writesUsed + writes,
    deletesUsed: prev.deletesUsed + deletes,
    exhausted: prev.exhausted || exhausted,
    lastAlertStep: prev.lastAlertStep,
    alertCount: prev.alertCount,
    updatedAt: Date.now(),
  });

  const crossedNewStep =
    nextRaw.alertStep !== null &&
    (prev.lastAlertStep === null || nextRaw.alertStep < prev.lastAlertStep);

  const finalStatus: ProjectQuotaStatus = crossedNewStep
    ? {
        ...nextRaw,
        lastAlertStep: nextRaw.alertStep,
        alertCount: prev.alertCount + 1,
      }
    : nextRaw;

  localStatusByProject.set(resolvedProject, finalStatus);
  saveLocalStoredQuota(finalStatus);
  notifyListeners(finalStatus);

  const pending = pendingOpsByProject.get(resolvedProject) || {
    reads: 0,
    writes: 0,
    deletes: 0,
    exhausted: false,
  };
  pending.reads += reads;
  pending.writes += writes;
  pending.deletes += deletes;
  pending.exhausted = pending.exhausted || exhausted;
  pendingOpsByProject.set(resolvedProject, pending);

  scheduleQuotaFlush(crossedNewStep || exhausted);
}

export function reportFirestoreQuotaExhausted(projectId?: string | null): void {
  recordFirestoreOperations(projectId || activeProjectId, { exhausted: true });
}

export async function fetchServerQuotaStatus(
  projectId = activeProjectId
): Promise<ProjectQuotaStatus | null> {
  if (!isBackendServerDetected()) return getCachedProjectQuotaStatus(projectId);
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(
      resolveApiUrl(`/api/quota/status?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`),
      { cache: 'no-store', signal: controller.signal }
    );
    window.clearTimeout(timer);
    const contentType = resp.headers.get('content-type') || '';
    if (!resp.ok || !contentType.includes('application/json')) return null;
    const data = (await resp.json()) as {
      ok?: boolean;
      quotaStatus?: ProjectQuotaStatus;
      quotaByProject?: Record<string, ProjectQuotaStatus>;
    };
    if (data?.quotaByProject) {
      for (const st of Object.values(data.quotaByProject)) {
        applyServerQuotaStatus(st);
      }
    }
    if (data?.quotaStatus) {
      applyServerQuotaStatus(data.quotaStatus);
      return data.quotaStatus;
    }
  } catch {
    // Fallback to local cache
  }
  return getCachedProjectQuotaStatus(projectId);
}

export async function fetchAllServerQuotaStatuses(
  projectIds: string[] = []
): Promise<Record<string, ProjectQuotaStatus>> {
  const result: Record<string, ProjectQuotaStatus> = {};
  for (const pid of projectIds) {
    if (pid) result[pid] = getCachedProjectQuotaStatus(pid);
  }
  result[activeProjectId] = getCachedProjectQuotaStatus(activeProjectId);

  if (isBackendServerDetected()) {
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 3000);
      const resp = await fetch(
        resolveApiUrl(`/api/quota/status?projectId=${encodeURIComponent(activeProjectId)}&t=${Date.now()}`),
        { cache: 'no-store', signal: controller.signal }
      );
      window.clearTimeout(timer);
      const contentType = resp.headers.get('content-type') || '';
      if (resp.ok && contentType.includes('application/json')) {
        const data = (await resp.json()) as {
          quotaStatus?: ProjectQuotaStatus;
          quotaByProject?: Record<string, ProjectQuotaStatus>;
        };
        if (data?.quotaByProject) {
          for (const [pid, st] of Object.entries(data.quotaByProject)) {
            applyServerQuotaStatus(st);
            result[pid] = st;
          }
        }
        if (data?.quotaStatus) {
          applyServerQuotaStatus(data.quotaStatus);
          result[data.quotaStatus.projectId] = data.quotaStatus;
        }
      }
    } catch {
      // Fallback to local cache map
    }
  }
  return result;
}

export async function calibrateProjectQuotaUsage(params: {
  user: User;
  fullNameQuad: string;
  projectId?: string;
  readsUsed?: number;
  writesUsed?: number;
  deletesUsed?: number;
  exhausted?: boolean;
}): Promise<ProjectQuotaStatus> {
  const projectId = params.projectId || activeProjectId;
  const dateKey = getFirebaseQuotaDateKey();
  pendingOpsByProject.delete(projectId);

  if (!isBackendServerDetected()) {
    return getCachedProjectQuotaStatus(projectId);
  }
  try {
    const idToken = await params.user.getIdToken(false);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(resolveApiUrl('/api/programmer/quota/calibrate'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
        'X-DuoBoard-Name': encodeURIComponent(params.fullNameQuad || ''),
      },
      body: JSON.stringify({
        tokenProjectId: activeFirebaseConfig.projectId,
        tokenApiKey: activeFirebaseConfig.apiKey,
        tokenFirestoreDatabaseId: activeFirebaseConfig.firestoreDatabaseId || '',
        fullNameQuad: params.fullNameQuad,
        projectId,
        readsUsed: params.readsUsed,
        writesUsed: params.writesUsed,
        deletesUsed: params.deletesUsed,
        exhausted: params.exhausted,
      }),
    });
    window.clearTimeout(timer);
    const contentType = resp.headers.get('content-type') || '';
    if (resp.ok && contentType.includes('application/json')) {
      const data = (await resp.json()) as { quotaStatus?: ProjectQuotaStatus };
      if (data?.quotaStatus) {
        applyServerQuotaStatus(data.quotaStatus);
        return data.quotaStatus;
      }
    }
  } catch {
    // Fallback to local update
  }

  const prev = getCachedProjectQuotaStatus(projectId);
  const next = buildProjectQuotaStatus({
    projectId,
    dateKey,
    readsUsed: params.readsUsed ?? prev.readsUsed,
    writesUsed: params.writesUsed ?? prev.writesUsed,
    deletesUsed: params.deletesUsed ?? prev.deletesUsed,
    exhausted: params.exhausted ?? false,
    lastAlertStep: null,
    alertCount: prev.alertCount,
    updatedAt: Date.now(),
  });
  const finalStatus: ProjectQuotaStatus =
    next.alertStep !== null
      ? { ...next, lastAlertStep: next.alertStep, alertCount: prev.alertCount + 1 }
      : { ...next, lastAlertStep: null };

  localStatusByProject.set(projectId, finalStatus);
  saveLocalStoredQuota(finalStatus);
  notifyListeners(finalStatus);
  return finalStatus;
}
