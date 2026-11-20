import React, { useCallback, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Database,
  Loader2,
  RefreshCw,
  ShieldAlert,
  X,
  XCircle,
} from 'lucide-react';
import {
  activeFirebaseConfig,
  activateCustomFirebaseConfig,
  db,
  defaultFirebaseConfig,
  firebaseTargetKey,
  getPreviousFirebaseConfigs,
  getPublicPlayerDatabases,
  isSameFirebaseTarget,
  markSwitchRequiresLogin,
  resetToDefaultFirebaseConfig,
  saveBackupFirebaseConfigs,
  savePreviousFirebaseConfigs,
  savePublicPlayerDatabases,
  setManualDbPin,
  type FirebaseAppConfig,
  type PublicDatabaseSummary,
} from '../firebase';
import { readCloudRegistryDoc, writePlatformMigrationPointer } from '../firebaseMigration';

interface CandidateDbHealth {
  key: string;
  label: string;
  config: FirebaseAppConfig;
  isCurrent: boolean;
  isDefault: boolean;
  status: 'checking' | 'available' | 'quota_full' | 'error';
  remainingPct?: number | null;
  detail: string;
}

interface QuotaFullDbSelectorModalProps {
  open: boolean;
  onClose: () => void;
  firebaseUser?: User | null;
  quotaExceededDetected?: boolean;
  onSwitched?: (target: FirebaseAppConfig) => void;
}

async function probeDbQuotaViaRest(
  cfg: FirebaseAppConfig
): Promise<{ status: 'available' | 'quota_full' | 'error'; detail: string }> {
  try {
    const dbSeg = cfg.firestoreDatabaseId?.trim() || '(default)';
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      cfg.projectId
    )}/databases/${encodeURIComponent(dbSeg)}/documents/platform/migration?key=${encodeURIComponent(
      cfg.apiKey
    )}`;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 2400);
    const resp = await fetch(url, { cache: 'no-store', signal: controller.signal });
    window.clearTimeout(timer);

    if (resp.status === 429) {
      return { status: 'quota_full', detail: 'ممتلئة الحصة اليومية (429)' };
    }
    if (resp.ok || resp.status === 404 || resp.status === 403) {
      return { status: 'available', detail: 'متاحة وتستجيب للطلبات' };
    }
    return { status: 'error', detail: `حالة غير متوقعة (${resp.status})` };
  } catch {
    return { status: 'error', detail: 'انتهت مهلة الفحص أو تعذر الاتصال' };
  }
}

export const QuotaFullDbSelectorModal: React.FC<QuotaFullDbSelectorModalProps> = ({
  open,
  onClose,
  firebaseUser,
  quotaExceededDetected = false,
  onSwitched,
}) => {
  const [candidates, setCandidates] = useState<CandidateDbHealth[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [switchingKey, setSwitchingKey] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [serverRevision, setServerRevision] = useState(1);

  const loadAndProbeDatabases = useCallback(async () => {
    setLoadingList(true);
    setErrorMsg(null);

    let publicList: PublicDatabaseSummary[] = getPublicPlayerDatabases();
    let quotaByProject: Record<string, { minRemainingPct?: number; exhausted?: boolean }> = {};
    let rev = 1;

    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 2200);
      const resp = await fetch(`/api/platform-db?t=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      window.clearTimeout(timer);
      if (resp.ok && (resp.headers.get('content-type') || '').includes('application/json')) {
        const data = (await resp.json()) as {
          revision?: number;
          playerDatabases?: PublicDatabaseSummary[];
          backupConfigs?: FirebaseAppConfig[];
          quotaByProject?: Record<string, { minRemainingPct?: number; exhausted?: boolean }>;
        };
        rev = Number(data.revision || 1);
        setServerRevision(rev);
        if (Array.isArray(data.playerDatabases)) {
          savePublicPlayerDatabases(data.playerDatabases);
          publicList = data.playerDatabases;
        }
        if (Array.isArray(data.backupConfigs)) {
          saveBackupFirebaseConfigs(data.backupConfigs);
        }
        if (data.quotaByProject && typeof data.quotaByProject === 'object') {
          quotaByProject = data.quotaByProject;
        }
      }
    } catch {
      // Fall back to local cache / Firestore registry if backend offline
    }

    if (publicList.length === 0) {
      const cloudReg = await readCloudRegistryDoc(db).catch(() => null);
      if (cloudReg?.playerDatabases?.length) {
        publicList = cloudReg.playerDatabases.map((p) => ({
          id: p.id,
          order: p.order,
          label: p.label,
          config: p.config,
          lastUsedAt: p.lastUsedAt ?? null,
          addedAt: p.addedAt,
        }));
      }
    }

    const rawConfigs: Array<{ label: string; config: FirebaseAppConfig; isDefault: boolean }> = [];
    const seen = new Set<string>();

    for (const entry of publicList) {
      const key = firebaseTargetKey(entry.config);
      if (seen.has(key)) continue;
      seen.add(key);
      rawConfigs.push({
        label: entry.label || `قاعدة #${entry.order} — ${entry.config.projectId}`,
        config: entry.config,
        isDefault: isSameFirebaseTarget(entry.config, defaultFirebaseConfig),
      });
    }

    // Always include default base config as a fallback option
    const defKey = firebaseTargetKey(defaultFirebaseConfig);
    if (!seen.has(defKey)) {
      seen.add(defKey);
      rawConfigs.push({
        label: `القاعدة الأساسية — ${defaultFirebaseConfig.projectId}`,
        config: defaultFirebaseConfig,
        isDefault: true,
      });
    }

    // Include previously used configs from local history if not already listed
    for (const prevCfg of getPreviousFirebaseConfigs()) {
      const pKey = firebaseTargetKey(prevCfg);
      if (seen.has(pKey)) continue;
      seen.add(pKey);
      rawConfigs.push({
        label: `قاعدة مسجلة — ${prevCfg.projectId}`,
        config: prevCfg,
        isDefault: isSameFirebaseTarget(prevCfg, defaultFirebaseConfig),
      });
    }

    const initialList: CandidateDbHealth[] = rawConfigs.map((item) => {
      const key = firebaseTargetKey(item.config);
      const q = quotaByProject[item.config.projectId];
      return {
        key,
        label: item.label,
        config: item.config,
        isCurrent: isSameFirebaseTarget(item.config, activeFirebaseConfig),
        isDefault: item.isDefault,
        status: q?.exhausted ? 'quota_full' : 'checking',
        remainingPct: typeof q?.minRemainingPct === 'number' ? q.minRemainingPct : null,
        detail: q?.exhausted ? 'ممتلئة الحصة اليومية' : 'جاري فحص حالة القاعدة...',
      };
    });

    setCandidates(initialList);
    setLoadingList(false);

    // Probe each candidate DB in parallel via lightweight REST GET
    await Promise.all(
      initialList.map(async (item) => {
        const res = await probeDbQuotaViaRest(item.config);
        const q = quotaByProject[item.config.projectId];
        const isCurrentQuotaTriggered = item.isCurrent && quotaExceededDetected;
        const effectiveStatus: CandidateDbHealth['status'] =
          res.status === 'quota_full' || q?.exhausted || isCurrentQuotaTriggered
            ? 'quota_full'
            : res.status;
        const effectiveDetail =
          effectiveStatus === 'quota_full'
            ? 'ممتلئة الحصة اليومية — يلزم التبديل لقاعدة أخرى'
            : res.detail;

        setCandidates((prev) =>
          prev.map((c) =>
            c.key === item.key
              ? { ...c, status: effectiveStatus, detail: effectiveDetail }
              : c
          )
        );
      })
    );
  }, [quotaExceededDetected]);

  useEffect(() => {
    if (open) {
      void loadAndProbeDatabases();
    }
  }, [open, loadAndProbeDatabases]);

  const handleActivateGlobally = async (candidate: CandidateDbHealth) => {
    setSwitchingKey(candidate.key);
    setErrorMsg(null);

    try {
      let headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (firebaseUser) {
        try {
          const token = await firebaseUser.getIdToken(false);
          if (token) headers = { ...headers, Authorization: `Bearer ${token}` };
        } catch {
          // Proceed without token (endpoint validates quota-failover safely)
        }
      }

      const resp = await fetch('/api/platform/quota-failover', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          targetProjectId: candidate.config.projectId,
          targetFirestoreDatabaseId: candidate.config.firestoreDatabaseId || '',
          quotaExceededReported: true,
          requesterEmail: firebaseUser?.email || '',
        }),
      });

      if (!resp.ok) {
        const errData = (await resp.json().catch(() => null)) as { error?: string } | null;
        if (resp.status !== 404 && resp.status !== 503 && errData?.error) {
          throw new Error(errData.error);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg && !msg.toLowerCase().includes('fetch') && !msg.toLowerCase().includes('network')) {
        setErrorMsg(msg);
        setSwitchingKey(null);
        return;
      }
    }

    // Best-effort Firestore migration pointer update on active DB so serverless clients also follow
    if (firebaseUser) {
      void writePlatformMigrationPointer({
        targetDb: db,
        uid: firebaseUser.uid,
        displayName: firebaseUser.displayName || 'مستخدم المنصة',
        targetConfig: candidate.config,
        previousConfigs: [activeFirebaseConfig, ...getPreviousFirebaseConfigs()],
      }).catch(() => false);
    }

    savePreviousFirebaseConfigs(
      [activeFirebaseConfig, ...getPreviousFirebaseConfigs()],
      candidate.config
    );
    setManualDbPin(candidate.config, serverRevision + 1);
    markSwitchRequiresLogin(candidate.config);

    if (isSameFirebaseTarget(candidate.config, defaultFirebaseConfig)) {
      resetToDefaultFirebaseConfig();
    } else {
      activateCustomFirebaseConfig(candidate.config);
    }

    onSwitched?.(candidate.config);
    window.location.reload();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
      dir="rtl"
    >
      <div className="duo-card max-w-2xl w-full p-5 sm:p-6 bg-white border-2 border-[#FF4B4B] flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-12 h-12 rounded-2xl bg-[#FFDFE0] text-[#EA2B2B] flex items-center justify-center shrink-0">
              <ShieldAlert className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-lg sm:text-xl font-black text-[#3C3C3C]">
                امتلاء حصة قاعدة البيانات الحالية ({activeFirebaseConfig.projectId})
              </h2>
              <p className="text-xs sm:text-sm font-bold text-[#777777] mt-1 leading-relaxed">
                لم يتم النقل التلقائي لهذه القاعدة بعد. اختر إحدى قواعد البيانات المتاحة أدناه ليتم{' '}
                <strong className="text-[#46A302]">تفعيلها عند جميع المستخدمين فوراً</strong>:
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-[#F7F7F7] text-[#777777] cursor-pointer shrink-0"
            title="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-[#F7F7F7] border border-[#E5E5E5] text-xs font-bold text-[#777777]">
          <span>
            القاعدة النشطة الآن:{' '}
            <span className="font-latin font-black text-[#EA2B2B]">
              {activeFirebaseConfig.projectId}
            </span>
          </span>
          <button
            type="button"
            disabled={loadingList}
            onClick={() => void loadAndProbeDatabases()}
            className="flex items-center gap-1 text-[#1899D6] font-black hover:underline cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingList ? 'animate-spin' : ''}`} />
            <span>إعادة فحص الحصص</span>
          </button>
        </div>

        {errorMsg && (
          <div className="p-3 rounded-xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-[#EA2B2B] text-xs sm:text-sm font-black flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div className="flex flex-col gap-2.5">
          {candidates.length === 0 ? (
            <div className="p-6 text-center text-sm font-bold text-[#777777]">
              جاري جلب قائمة قواعد البيانات المسجلة...
            </div>
          ) : (
            candidates.map((item) => {
              const isBusy = switchingKey === item.key;
              const disabled = item.isCurrent || switchingKey !== null || item.status === 'quota_full';
              return (
                <div
                  key={item.key}
                  className={`p-3.5 sm:p-4 rounded-2xl border-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors ${
                    item.isCurrent
                      ? 'bg-[#FFF5F5] border-[#FF4B4B]/50'
                      : item.status === 'quota_full'
                      ? 'bg-[#F7F7F7] border-[#E5E5E5] opacity-75'
                      : 'bg-white border-[#E5E5E5] hover:border-[#58CC02]'
                  }`}
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div
                      className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                        item.status === 'available'
                          ? 'bg-[#D7FFB8] text-[#46A302]'
                          : item.status === 'quota_full'
                          ? 'bg-[#FFDFE0] text-[#EA2B2B]'
                          : 'bg-[#E8F7FF] text-[#1899D6]'
                      }`}
                    >
                      <Database className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-black text-[#3C3C3C] truncate">
                          {item.label}
                        </span>
                        {item.isCurrent && (
                          <span className="px-2 py-0.5 rounded-lg bg-[#FFDFE0] text-[#EA2B2B] text-[10px] font-black">
                            الحالية (ممتلئة)
                          </span>
                        )}
                        {item.isDefault && !item.isCurrent && (
                          <span className="px-2 py-0.5 rounded-lg bg-[#E8F7FF] text-[#1899D6] text-[10px] font-black">
                            القاعدة الأساسية
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-bold text-[#777777] font-latin truncate mt-0.5">
                        {item.config.projectId}
                        {item.config.firestoreDatabaseId
                          ? ` / ${item.config.firestoreDatabaseId}`
                          : ''}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs font-extrabold">
                        {item.status === 'checking' && (
                          <span className="text-[#1899D6] flex items-center gap-1">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            {item.detail}
                          </span>
                        )}
                        {item.status === 'available' && (
                          <span className="text-[#46A302] flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            {item.detail}
                            {typeof item.remainingPct === 'number'
                              ? ` • السعة المتبقية ~${item.remainingPct.toFixed(0)}%`
                              : ''}
                          </span>
                        )}
                        {item.status === 'quota_full' && (
                          <span className="text-[#EA2B2B] flex items-center gap-1">
                            <XCircle className="w-3.5 h-3.5" />
                            {item.detail}
                          </span>
                        )}
                        {item.status === 'error' && (
                          <span className="text-[#9A6B00] flex items-center gap-1">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            {item.detail}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {!item.isCurrent && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => void handleActivateGlobally(item)}
                      className="duo-btn flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-xs sm:text-sm font-black cursor-pointer shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
                    >
                      {isBusy ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <ArrowLeftRight className="w-4 h-4" />
                      )}
                      <span>
                        {isBusy ? 'جاري التفعيل للجميع...' : 'تفعيل هذه القاعدة للجميع'}
                      </span>
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
