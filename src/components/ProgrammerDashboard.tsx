import React, { useEffect, useMemo, useState } from 'react';
import { getAuth, GoogleAuthProvider, signInWithPopup, type User } from 'firebase/auth';
import {
  AlertCircle,
  ArrowRightLeft,
  BellRing,
  Check,
  CheckCircle2,
  Code2,
  Copy,
  Crown,
  Database,
  ExternalLink,
  Gauge,
  Loader2,
  Plus,
  Radio,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  XCircle,
} from 'lucide-react';
import firestoreRulesRaw from '../../firestore.rules?raw';
import {
  activeFirebaseConfig,
  activeProjectId,
  buildCleanPrimaryUrl,
  isSameFirebaseTarget,
  type FirebaseAppConfig,
} from '../firebase';
import {
  addBackupDatabase,
  addPlayerDatabase,
  announceViaBackupDatabase,
  checkActiveDatabaseRulesCompliance,
  getOrInitFirebaseApp,
  MigrationNeedsSetupError,
  parseFirebaseConfigSnippet,
  promoteProgrammerMember,
  publishMigrationCompleteSignal,
  removeBackupDatabase,
  removePlayerDatabase,
  removeProgrammerMember,
  RULES_UPDATE_CHANGES_AR,
  RULES_UPDATE_STEPS_AR,
  runFirebaseMigration,
  verifyDatabaseBeforeAdd,
  type DatabaseRulesCheckResult,
  type MigrationProgress,
  type MigrationResult,
  type VerifyStepItem,
} from '../firebaseMigration';
import type {
  DatabaseRole,
  PlatformProgrammerState,
  RegisteredDatabaseEntry,
  Room,
  UserProfile,
} from '../types';
import {
  calibrateProjectQuotaUsage,
  fetchAllServerQuotaStatuses,
  fetchServerQuotaStatus,
  formatQuotaMetricArabic,
  getCachedProjectQuotaStatus,
  SPARK_DAILY_LIMITS,
  subscribeQuotaStatus,
  type ProjectQuotaStatus,
} from '../quotaTracker';
import { playDuoSound } from './DuoIcons';
import { DuoLoading } from './DuoLoading';

interface ProgrammerDashboardProps {
  firebaseUser: User;
  profile: UserProfile | null;
  currentRoom: Room | null;
  isSupervisorInCurrentRoom: boolean;
  isMaster: boolean;
  backendMode?: 'server' | 'serverless';
  poolState: PlatformProgrammerState;
  onPoolStateUpdated: (next: PlatformProgrammerState) => void;
  onRefreshState: () => Promise<void>;
  rulesAuditResults?: DatabaseRulesCheckResult[];
  rulesAuditChecking?: boolean;
  onOpenRulesModal?: () => void;
  onRecheckAllRules?: () => void;
}

export const ProgrammerDashboard: React.FC<ProgrammerDashboardProps> = ({
  firebaseUser,
  profile,
  currentRoom,
  isSupervisorInCurrentRoom,
  isMaster,
  backendMode = 'server',
  poolState,
  onPoolStateUpdated,
  onRefreshState,
  rulesAuditResults = [],
  rulesAuditChecking = false,
  onOpenRulesModal,
  onRecheckAllRules,
}) => {
  const fullNameQuad = profile?.fullNameQuad || firebaseUser.displayName || '';

  const [subTab, setSubTab] = useState<'databases' | 'programmers'>('databases');

  // Add & Verify Form State
  const [newDbRole, setNewDbRole] = useState<DatabaseRole>('player');
  const [newDbLabel, setNewDbLabel] = useState('');
  const [configInput, setConfigInput] = useState('');
  const [showAdvancedDb, setShowAdvancedDb] = useState(false);
  const [customDatabaseId, setCustomDatabaseId] = useState('');
  const [verifyingAndAdding, setVerifyingAndAdding] = useState(false);
  const [verifySteps, setVerifySteps] = useState<VerifyStepItem[] | null>(null);
  const [addSuccessNotice, setAddSuccessNotice] = useState<string | null>(null);

  // Migration State
  const [selectedBackupByTarget, setSelectedBackupByTarget] = useState<Record<string, string>>({});
  const [migratingEntryId, setMigratingEntryId] = useState<string | null>(null);
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(null);
  const [cleanupOldDatabase, setCleanupOldDatabase] = useState(true);
  const [setupError, setSetupError] = useState<MigrationNeedsSetupError | null>(null);
  const [pendingPopupBackup, setPendingPopupBackup] = useState<{
    result: MigrationResult;
    backupEntry: RegisteredDatabaseEntry;
  } | null>(null);

  const [copiedRules, setCopiedRules] = useState(false);
  const [copiedDomain, setCopiedDomain] = useState(false);
  const [showRulesPreview, setShowRulesPreview] = useState(false);
  const [rulesCompliance, setRulesCompliance] = useState<{
    checking: boolean;
    compliant: boolean | null;
    checkedProjectId: string;
    reason?: string;
  }>({
    checking: true,
    compliant: null,
    checkedProjectId: activeProjectId,
  });
  const [showRulesGuideDetails, setShowRulesGuideDetails] = useState(false);
  const [quotaStatus, setQuotaStatus] = useState<ProjectQuotaStatus>(() =>
    getCachedProjectQuotaStatus(activeProjectId)
  );
  const [quotaByProject, setQuotaByProject] = useState<Record<string, ProjectQuotaStatus>>(() => ({
    [activeProjectId]: getCachedProjectQuotaStatus(activeProjectId),
  }));
  const [justAddedDbId, setJustAddedDbId] = useState<string | null>(null);
  const [calibratingQuota, setCalibratingQuota] = useState(false);

  const recheckActiveRules = async (bypassCache = true) => {
    if (onRecheckAllRules && bypassCache) {
      onRecheckAllRules();
    }
    setRulesCompliance((prev) => ({ ...prev, checking: true }));
    try {
      const res = await checkActiveDatabaseRulesCompliance(
        firebaseUser,
        activeFirebaseConfig,
        bypassCache
      );
      setRulesCompliance({
        checking: false,
        compliant: res.compliant,
        checkedProjectId: res.checkedProjectId,
        reason: res.reason,
      });
      if (!res.compliant) {
        setShowRulesGuideDetails(true);
      } else if (bypassCache) {
        playDuoSound('correct');
      }
    } catch {
      setRulesCompliance((prev) => ({
        ...prev,
        checking: false,
      }));
    }
  };

  useEffect(() => {
    void recheckActiveRules(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firebaseUser.uid]);

  const registeredProjectIdsKey = useMemo(
    () =>
      [
        activeProjectId,
        ...poolState.playerDatabases.map((d) => d.config.projectId),
      ].join(','),
    [poolState.playerDatabases]
  );

  useEffect(() => {
    const unsub = subscribeQuotaStatus((status) => {
      setQuotaByProject((prev) => ({
        ...prev,
        [status.projectId]: status,
      }));
      if (status.projectId === activeProjectId) {
        setQuotaStatus(status);
      }
    });
    const projectIds = registeredProjectIdsKey.split(',').filter(Boolean);
    void fetchServerQuotaStatus(activeProjectId);
    void fetchAllServerQuotaStatuses(projectIds).then((map) => {
      setQuotaByProject((prev) => ({ ...prev, ...map }));
      if (map[activeProjectId]) {
        setQuotaStatus(map[activeProjectId]);
      }
    });
    return () => unsub();
  }, [registeredProjectIdsKey]);

  const handleCalibrateQuota = async (targetRemainingPct: number) => {
    setCalibratingQuota(true);
    try {
      const clampedPct = Math.max(0, Math.min(100, targetRemainingPct));
      const targetReadsUsed =
        clampedPct >= 100
          ? 0
          : Math.round(SPARK_DAILY_LIMITS.reads * (1 - clampedPct / 100));
      const next = await calibrateProjectQuotaUsage({
        user: firebaseUser,
        fullNameQuad,
        projectId: activeProjectId,
        readsUsed: targetReadsUsed,
        writesUsed: clampedPct >= 100 ? 0 : quotaStatus.writesUsed,
        deletesUsed: clampedPct >= 100 ? 0 : quotaStatus.deletesUsed,
        exhausted: clampedPct <= 0,
      });
      setQuotaStatus(next);
      playDuoSound(clampedPct <= 5 ? 'pop' : 'correct');
    } finally {
      setCalibratingQuota(false);
    }
  };
  const [confirmDeleteDbId, setConfirmDeleteDbId] = useState<string | null>(null);

  // Promote Programmer State
  const [promoName, setPromoName] = useState('');
  const [promoEmail, setPromoEmail] = useState('');
  const [promoting, setPromoting] = useState(false);

  // Banners & Action Busy
  const [actionBusy, setActionBusy] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  const detectedPreview = useMemo(() => {
    if (!configInput.trim()) return null;
    try {
      const cfg = parseFirebaseConfigSnippet(
        configInput,
        showAdvancedDb ? customDatabaseId : undefined
      );
      return { ok: true as const, config: cfg };
    } catch (err) {
      return {
        ok: false as const,
        message: err instanceof Error ? err.message : 'صيغة غير صالحة',
      };
    }
  }, [configInput, showAdvancedDb, customDatabaseId]);

  const activePlayerEntry = poolState.playerDatabases.find((d) =>
    isSameFirebaseTarget(d.config, activeFirebaseConfig)
  );

  const getChosenBackupForTarget = (targetId: string): RegisteredDatabaseEntry | null => {
    if (poolState.backupDatabases.length === 0) return null;
    const chosenId = selectedBackupByTarget[targetId];
    return (
      poolState.backupDatabases.find((b) => b.id === chosenId) ||
      poolState.backupDatabases[0] ||
      null
    );
  };

  const handleVerifyAndAddDatabase = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorNotice(null);
    setStatusNotice(null);
    setSetupError(null);
    setAddSuccessNotice(null);

    let parsedCfg: FirebaseAppConfig;
    try {
      parsedCfg = parseFirebaseConfigSnippet(
        configInput,
        showAdvancedDb ? customDatabaseId : undefined
      );
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'تعذر قراءة إعدادات Firebase.');
      return;
    }

    setVerifyingAndAdding(true);
    setVerifySteps(null);
    try {
      const verifyRes = await verifyDatabaseBeforeAdd({
        config: parsedCfg,
        role: newDbRole,
        existingPlayerDbs: poolState.playerDatabases,
        existingBackupDbs: poolState.backupDatabases,
        fallbackQuadName: fullNameQuad,
        onStepUpdate: (steps) => setVerifySteps(steps),
      });

      if (!verifyRes.ok || !verifyRes.summary) {
        playDuoSound('wrong');
        setErrorNotice(
          verifyRes.failureMessage ||
            'فشل الفحص الشامل للقاعدة — أصلح الخطوة المحددة بالأسفل ثم أعد الفحص.'
        );
        return;
      }

      if (newDbRole === 'player') {
        const res = await addPlayerDatabase(
          firebaseUser,
          fullNameQuad,
          verifyRes.config,
          newDbLabel.trim(),
          verifyRes.summary
        );
        onPoolStateUpdated(res.state);
        setJustAddedDbId(res.added.id);
        setVerifySteps((prev) =>
          prev
            ? prev.map((s) =>
                s.id === 'register'
                  ? {
                      ...s,
                      status: 'passed',
                      detail: `تم حفظ القاعدة (#${res.added.order} — ${res.added.config.projectId}) وربطها بالبرنامج بالكامل وتسجيل الدخول`,
                    }
                  : s
              )
            : prev
        );
        const okMsg = `تم فحص القاعدة 100% وحفظها وربطها بالبرنامج بالكامل في «قواعد البيانات» (#${res.added.order} — ${res.added.config.projectId})!`;
        setStatusNotice(okMsg);
        setAddSuccessNotice(okMsg);
      } else {
        const res = await addBackupDatabase(
          firebaseUser,
          fullNameQuad,
          verifyRes.config,
          newDbLabel.trim(),
          verifyRes.summary
        );
        onPoolStateUpdated(res.state);
        setJustAddedDbId(res.added.id);
        setVerifySteps((prev) =>
          prev
            ? prev.map((s) =>
                s.id === 'register'
                  ? {
                      ...s,
                      status: 'passed',
                      detail: `تم حفظ القاعدة الاحتياطية (#${res.added.order} — ${res.added.config.projectId}) وربطها بنظام الإعلان الصامت بدون لمسها`,
                    }
                  : s
              )
            : prev
        );
        const okMsg = `تم فحص القاعدة الاحتياطية 100% وحفظها وربطها بنظام الإعلان الصامت (#${res.added.order} — ${res.added.config.projectId})!`;
        setStatusNotice(okMsg);
        setAddSuccessNotice(okMsg);
      }

      void fetchAllServerQuotaStatuses([
        activeProjectId,
        verifyRes.config.projectId,
        ...poolState.playerDatabases.map((d) => d.config.projectId),
      ]).then((map) => setQuotaByProject((prev) => ({ ...prev, ...map })));

      playDuoSound('correct');
      setConfigInput('');
      setNewDbLabel('');
      setCustomDatabaseId('');
    } catch (err) {
      playDuoSound('wrong');
      const errMsg = err instanceof Error ? err.message : 'تعذر فحص وإضافة قاعدة البيانات.';
      setVerifySteps((prev) =>
        prev
          ? prev.map((s) =>
              s.id === 'register' && s.status === 'running'
                ? { ...s, status: 'failed', detail: errMsg }
                : s
            )
          : prev
      );
      setErrorNotice(errMsg);
    } finally {
      setVerifyingAndAdding(false);
    }
  };

  const reloadToMigratedTarget = (migratedRoomId: string | null) => {
    window.setTimeout(() => {
      try {
        sessionStorage.removeItem('duoboard_self_migrated_target');
      } catch {
        // Ignore
      }
      if (migratedRoomId) {
        const url = new URL(window.location.href);
        url.searchParams.delete('fb');
        url.searchParams.set('room', migratedRoomId);
        window.location.replace(url.toString());
      } else {
        window.location.replace(buildCleanPrimaryUrl());
      }
    }, 350);
  };

  const handleMigrateToPlayerDb = async (
    entry: RegisteredDatabaseEntry,
    allowSameTargetUpdate = false
  ) => {
    setErrorNotice(null);
    setStatusNotice(null);
    setSetupError(null);
    setPendingPopupBackup(null);

    const backupEntry = getChosenBackupForTarget(entry.id);

    setMigratingEntryId(entry.id);
    setMigrationProgress({
      step: 'signing_in',
      percent: 5,
      message: allowSameTargetUpdate
        ? `جاري تحديث ومزامنة البيانات إلى #${entry.order} (${entry.config.projectId})...`
        : `جاري نقل كل الغرف والسوابير والاختبارات إلى #${entry.order} (${entry.config.projectId})...`,
    });

    try {
      const res = await runFirebaseMigration({
        targetConfig: entry.config,
        backupEntry,
        currentProfile: profile,
        currentRoom,
        isSupervisorInCurrentRoom,
        cleanupOldDatabase: allowSameTargetUpdate ? false : cleanupOldDatabase,
        allowSameTargetUpdate,
        onProgress: (p) => setMigrationProgress(p),
      });

      playDuoSound('correct');

      if (res.backupAuthPopupBlocked && backupEntry) {
        void onRefreshState();
        setPendingPopupBackup({ result: res, backupEntry });
        setStatusNotice(
          `اكتمل نقل البيانات 100% إلى (${entry.config.projectId})! يرجى الضغط أدناه لتفعيل إعلان القاعدة الاحتياطية (${backupEntry.config.projectId}).`
        );
        return;
      }

      setStatusNotice(
        res.announcedBackupProjectId
          ? `تم نقل ${res.migratedRoomsCount} غرف و${res.migratedMyQuizzesCount} اختباراتي و${res.migratedSavedTestsCount} محفوظات، واستيقظت القاعدة الاحتياطية (${res.announcedBackupProjectId}) لإعلان وتجهيز (${entry.config.projectId}) للجميع!`
          : `تم نقل ${res.migratedRoomsCount} غرف و${res.migratedMyQuizzesCount} اختباراتي و${res.migratedSavedTestsCount} محفوظات، واعتماد (${entry.config.projectId}) للجميع!`
      );

      if (allowSameTargetUpdate) {
        void onRefreshState();
      } else {
        reloadToMigratedTarget(res.migratedRoomId);
      }
    } catch (err) {
      playDuoSound('wrong');
      if (err instanceof MigrationNeedsSetupError) {
        setSetupError(err);
        setErrorNotice(err.message);
      } else {
        setErrorNotice(
          err instanceof Error ? err.message : 'تعذر النقل إلى قاعدة البيانات المختارة.'
        );
      }
    } finally {
      setMigratingEntryId(null);
    }
  };

  const handleRetryPendingBackupAnnounce = async () => {
    if (!pendingPopupBackup) return;
    setActionBusy(true);
    setErrorNotice(null);
    try {
      const { result, backupEntry } = pendingPopupBackup;
      const announce = await announceViaBackupDatabase({
        backupConfig: backupEntry.config,
        targetConfig: result.targetConfig,
        migratedRoomId: result.migratedRoomId,
        updaterName: fullNameQuad,
      });
      await publishMigrationCompleteSignal({
        targetConfig: result.targetConfig,
        migratedRoomId: result.migratedRoomId,
        backupDbId: backupEntry.id,
        backupProjectId: backupEntry.config.projectId,
        fullNameQuad,
      });
      if (announce.ok) {
        playDuoSound('correct');
        setPendingPopupBackup(null);
        setStatusNotice(
          `استيقظت القاعدة الاحتياطية (${backupEntry.config.projectId}) وأعلنت القاعدة الجديدة للجميع!`
        );
        reloadToMigratedTarget(result.migratedRoomId);
      } else if (announce.popupBlocked) {
        setErrorNotice('ما زالت النافذة المنبثقة محظورة. اسمح بها في المتصفح ثم حاول مجدداً.');
      } else {
        reloadToMigratedTarget(result.migratedRoomId);
      }
    } finally {
      setActionBusy(false);
    }
  };

  const handleRefreshBackupAuth = async (backupEntry: RegisteredDatabaseEntry) => {
    setActionBusy(true);
    setErrorNotice(null);
    try {
      const bApp = getOrInitFirebaseApp(backupEntry.config);
      const bAuth = getAuth(bApp);
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const cred = await signInWithPopup(bAuth, provider);
      playDuoSound('correct');
      setStatusNotice(
        `تم تجديد تأكيد الدخول للقاعدة الاحتياطية (${backupEntry.config.projectId}) بالحساب ${cred.user.email || ''} — جاهزة للإعلان الفوري دون نوافذ إضافية!`
      );
    } catch (err) {
      playDuoSound('wrong');
      setErrorNotice(
        err instanceof Error
          ? err.message
          : `تعذر تجديد الدخول للقاعدة الاحتياطية (${backupEntry.config.projectId}).`
      );
    } finally {
      setActionBusy(false);
    }
  };

  const handleRemoveDb = async (entry: RegisteredDatabaseEntry) => {
    setActionBusy(true);
    setErrorNotice(null);
    try {
      const res =
        entry.role === 'player'
          ? await removePlayerDatabase(firebaseUser, fullNameQuad, entry.id)
          : await removeBackupDatabase(firebaseUser, fullNameQuad, entry.id);
      onPoolStateUpdated(res.state);
      setConfirmDeleteDbId(null);
      playDuoSound('pop');
      setStatusNotice(
        entry.role === 'player'
          ? `تمت إزالة القاعدة (${entry.config.projectId}) من قائمة قواعد البيانات.`
          : `تمت إزالة القاعدة الاحتياطية (${entry.config.projectId}).`
      );
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'تعذر حذف القاعدة.');
    } finally {
      setActionBusy(false);
    }
  };

  const handlePromoteMember = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorNotice(null);
    setStatusNotice(null);

    if (!promoName.trim() && !promoEmail.trim()) {
      setErrorNotice('أدخل الاسم الرباعي أو البريد الإلكتروني للعضو المراد ترقيته.');
      return;
    }

    setPromoting(true);
    try {
      const res = await promoteProgrammerMember(
        firebaseUser,
        fullNameQuad,
        promoName.trim(),
        promoEmail.trim()
      );
      onPoolStateUpdated(res.state);
      setPromoName('');
      setPromoEmail('');
      playDuoSound('correct');
      setStatusNotice(`تمت ترقية ${res.member.fullNameQuad || res.member.email} إلى مبرمج بنجاح!`);
    } catch (err) {
      playDuoSound('wrong');
      setErrorNotice(err instanceof Error ? err.message : 'تعذر ترقية العضو.');
    } finally {
      setPromoting(false);
    }
  };

  const handleDemoteMember = async (memberId: string) => {
    setActionBusy(true);
    setErrorNotice(null);
    try {
      const res = await removeProgrammerMember(firebaseUser, fullNameQuad, memberId);
      onPoolStateUpdated(res.state);
      playDuoSound('pop');
      setStatusNotice('تمت إزالة صلاحية المبرمج من العضو.');
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'تعذر إزالة الصلاحية.');
    } finally {
      setActionBusy(false);
    }
  };

  const copyTextSafely = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback below for restricted iframe contexts
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'true');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(ta);
      return copied;
    } catch {
      return false;
    }
  };

  const handleCopyRules = async () => {
    const ok = await copyTextSafely(firestoreRulesRaw);
    if (ok) {
      setCopiedRules(true);
      playDuoSound('pop');
      setTimeout(() => setCopiedRules(false), 2200);
    } else {
      setShowRulesPreview(true);
    }
  };

  const handleCopyDomain = async () => {
    const ok = await copyTextSafely(window.location.hostname);
    if (ok) {
      setCopiedDomain(true);
      playDuoSound('pop');
      setTimeout(() => setCopiedDomain(false), 2200);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-6 py-5 sm:py-8 flex flex-col gap-6">
      {/* Programmer Hero Card */}
      <div className="duo-card p-5 sm:p-7 bg-gradient-to-l from-[#F8F3FF] via-white to-[#F0F9FF] border-[#A560E8] flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-14 h-14 rounded-2xl bg-[#A560E8] border-b-4 border-[#8938D6] text-white flex items-center justify-center shrink-0">
              <Code2 className="w-7 h-7" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl sm:text-2xl font-black text-[#3C3C3C]">
                  لوحة المبرمج وإدارة القواعد
                </h1>
                <span
                  className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-black border ${
                    isMaster
                      ? 'bg-[#FFF4CC] border-[#FFC800] text-[#9A6B00]'
                      : 'bg-[#F3E8FF] border-[#A560E8] text-[#8938D6]'
                  }`}
                >
                  {isMaster ? <Crown className="w-3.5 h-3.5" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                  <span>{isMaster ? 'المبرمج الأساسي' : 'مبرمج معتمد'}</span>
                </span>
                <span
                  className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-black border ${
                    backendMode === 'serverless'
                      ? 'bg-[#E6F7FF] border-[#1CB0F6] text-[#1899D6]'
                      : 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                  }`}
                >
                  <span>
                    {backendMode === 'serverless'
                      ? 'وضع الاستضافة الثابتة'
                      : 'متصل بالخادم + السحابة'}
                  </span>
                </span>
              </div>
              <p className="text-xs sm:text-sm font-bold text-[#777777] mt-0.5">
                فحص 100% للفايربيس وOAuth والـ Rules قبل الإضافة • فصل قواعد اللاعبين عن القواعد الاحتياطية الصامتة
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void onRefreshState()}
            disabled={actionBusy || Boolean(migratingEntryId) || verifyingAndAdding}
            className="duo-btn self-start sm:self-center flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs sm:text-sm font-black text-[#3C3C3C] hover:border-[#1CB0F6] cursor-pointer"
          >
            <RefreshCw className="w-4 h-4 text-[#1899D6]" />
            <span>تحديث الحالة</span>
          </button>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
          <div className="p-3.5 rounded-2xl bg-white border-2 border-[#E5E5E5] flex flex-col gap-0.5">
            <span className="text-[11px] font-extrabold text-[#777777]">
              القاعدة النشطة للاعبين الآن
            </span>
            <span className="font-latin text-sm sm:text-base font-black text-[#1899D6] truncate">
              {activePlayerEntry ? `#${activePlayerEntry.order} — ` : ''}
              {activeProjectId}
            </span>
          </div>

          <div className="p-3.5 rounded-2xl bg-white border-2 border-[#E5E5E5] flex flex-col gap-0.5">
            <span className="text-[11px] font-extrabold text-[#777777]">
              قواعد البيانات (للاعبين والاختبارات)
            </span>
            <span className="text-sm sm:text-base font-black text-[#3C3C3C]">
              <span className="font-latin text-[#58CC02]">{poolState.playerDatabases.length}</span>{' '}
              قواعد مفحوصة 100%
            </span>
          </div>

          <div className="p-3.5 rounded-2xl bg-[#F8F3FF] border-2 border-[#A560E8]/50 flex flex-col gap-0.5">
            <span className="text-[11px] font-extrabold text-[#777777]">
              القواعد الاحتياطية الصامتة (لا تُمس بتاتاً)
            </span>
            <span className="text-sm sm:text-base font-black text-[#8938D6]">
              <span className="font-latin">{poolState.backupDatabases.length}</span> قواعد للتجهيز والإعلان فقط
            </span>
          </div>
        </div>

        {poolState.lastBackupAnnouncement && (
          <div className="p-3 rounded-2xl bg-[#D7FFB8]/45 border border-[#58CC02] flex flex-wrap items-center gap-2 text-xs font-black text-[#46A302]">
            <Radio className="w-4 h-4 shrink-0" />
            <span>
              آخر تفعيل احتياطي: أعلنت القاعدة الاحتياطية (
              <span className="font-latin">{poolState.lastBackupAnnouncement.backupProjectId}</span>)
              الانتقال إلى (
              <span className="font-latin">{poolState.lastBackupAnnouncement.targetProjectId}</span>)
            </span>
          </div>
        )}

        {/* Live Spark Free Quota Monitor + <= 5% (-0.5% Step) Supervisor Alert Control */}
        <div
          className={`p-4 rounded-2xl border-2 flex flex-col gap-3 ${
            quotaStatus.alertStep !== null
              ? quotaStatus.alertStep <= 2.0
                ? 'bg-[#FFDFE0]/70 border-[#FF4B4B]'
                : 'bg-[#FFF4CC]/80 border-[#FFC800]'
              : 'bg-white border-[#E5E5E5]'
          }`}
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {quotaStatus.alertStep !== null ? (
                <BellRing
                  className={`w-5 h-5 shrink-0 ${
                    quotaStatus.alertStep <= 2.0 ? 'text-[#EA2B2B]' : 'text-[#9A6B00]'
                  }`}
                />
              ) : (
                <Gauge className="w-5 h-5 text-[#1899D6] shrink-0" />
              )}
              <div>
                <h3 className="text-xs sm:text-sm font-black text-[#3C3C3C]">
                  مراقبة حدود الحصة المجانية اليومية (<span className="font-latin">{activeProjectId}</span>)
                </h3>
                <p className="text-[11px] font-bold text-[#777777]">
                  عند بقاء <span className="font-latin">5.0%</span> أو أقل يُرسل تنبيه تلقائي للمشرف عند كل نقص بمقدار{' '}
                  <span className="font-latin">0.5%</span> ({quotaStatus.dateKey})
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 self-start sm:self-center">
              <span
                className={`px-3 py-1 rounded-xl text-xs font-black border ${
                  quotaStatus.alertStep !== null
                    ? quotaStatus.alertStep <= 2.0
                      ? 'bg-[#FF4B4B] border-[#EA2B2B] text-white'
                      : 'bg-[#FFC800] border-[#E0A800] text-[#3C3C3C]'
                    : 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                }`}
              >
                {quotaStatus.alertStep !== null
                  ? `متبقي ${quotaStatus.minRemainingPct.toFixed(2)}% (عتبة ${quotaStatus.alertStep.toFixed(1)}%)`
                  : `متبقي ${quotaStatus.minRemainingPct.toFixed(1)}% • مستخدم ${(100 - quotaStatus.minRemainingPct).toFixed(1)}%`}
              </span>
            </div>
          </div>

          {/* Overall Visual Free-Quota Bar with 5% Alert Marker */}
          <div className="flex flex-col gap-1.5 bg-white/80 p-3 rounded-xl border border-[#E5E5E5]">
            <div className="flex items-center justify-between text-[11px] font-black">
              <span className="text-[#3C3C3C]">
                النسبة المتبقية حتى انتهاء الحد المجاني اليومي
              </span>
              <span dir="ltr" className="font-latin text-xs text-[#1899D6]">
                {quotaStatus.minRemainingPct.toFixed(2)}% متبقية ({quotaStatus.bottleneckRemainingCount.toLocaleString('en-US')} عملية)
              </span>
            </div>
            <div className="h-4 w-full rounded-full bg-[#EDEDED] border border-[#D4D4D4] overflow-hidden relative">
              <svg className="w-full h-full block" aria-hidden="true">
                <rect
                  x="0"
                  y="0"
                  height="100%"
                  width={`${Math.max(0, Math.min(100, quotaStatus.minRemainingPct)).toFixed(2)}%`}
                  className={
                    quotaStatus.minRemainingPct <= 2
                      ? 'fill-[#FF4B4B]'
                      : quotaStatus.minRemainingPct <= 5
                      ? 'fill-[#FFC800]'
                      : quotaStatus.minRemainingPct <= 20
                      ? 'fill-[#FF9600]'
                      : 'fill-[#58CC02]'
                  }
                />
                {/* 5% Warning Threshold Tick */}
                <rect x="5%" y="0" width="2" height="100%" className="fill-[#EA2B2B]" />
              </svg>
            </div>
            <div className="flex items-center justify-between text-[10px] font-bold text-[#777777]">
              <span>المتبقي: {quotaStatus.minRemainingPct.toFixed(2)}%</span>
              <span className="text-[#EA2B2B] font-extrabold">خط التنبيه الأول: 5.0% (وكل نقص 0.5%)</span>
              <span>المستخدم: {(100 - quotaStatus.minRemainingPct).toFixed(2)}%</span>
            </div>
          </div>

          {/* Individual Metric Progress Bars */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs font-black">
            {[
              {
                key: 'reads',
                title: 'القراءة (Reads)',
                pct: quotaStatus.readsRemainingPct,
                used: quotaStatus.readsUsed,
                limit: quotaStatus.readsLimit,
              },
              {
                key: 'writes',
                title: 'الكتابة (Writes)',
                pct: quotaStatus.writesRemainingPct,
                used: quotaStatus.writesUsed,
                limit: quotaStatus.writesLimit,
              },
              {
                key: 'deletes',
                title: 'الحذف (Deletes)',
                pct: quotaStatus.deletesRemainingPct,
                used: quotaStatus.deletesUsed,
                limit: quotaStatus.deletesLimit,
              },
            ].map((m) => (
              <div
                key={m.key}
                className="p-2.5 rounded-xl bg-white/90 border border-[#E5E5E5] flex flex-col gap-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[#777777]">{m.title}</span>
                  <span dir="ltr" className="font-latin text-[#3C3C3C]">
                    {m.pct.toFixed(1)}%
                  </span>
                </div>
                <div className="h-2.5 w-full rounded-full bg-[#EDEDED] overflow-hidden">
                  <svg className="w-full h-full block" aria-hidden="true">
                    <rect
                      x="0"
                      y="0"
                      height="100%"
                      width={`${Math.max(0, Math.min(100, m.pct)).toFixed(2)}%`}
                      className={
                        m.pct <= 2
                          ? 'fill-[#FF4B4B]'
                          : m.pct <= 5
                          ? 'fill-[#FFC800]'
                          : 'fill-[#1CB0F6]'
                      }
                    />
                  </svg>
                </div>
                <span dir="ltr" className="font-latin text-[10px] font-bold text-[#777777] text-left">
                  مستخدم {m.used.toLocaleString('en-US')} / {m.limit.toLocaleString('en-US')} • باقي{' '}
                  {Math.max(0, m.limit - m.used).toLocaleString('en-US')}
                </span>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-black/10">
            <span className="text-[11px] font-bold text-[#777777]">
              أقرب مورد للنفاد: {formatQuotaMetricArabic(quotaStatus.bottleneckMetric)} • عدد التنبيهات المرسلة اليوم:{' '}
              <span className="font-latin text-[#3C3C3C]">{quotaStatus.alertCount}</span>
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={calibratingQuota}
                onClick={() =>
                  void handleCalibrateQuota(
                    quotaStatus.alertStep === null
                      ? 5.0
                      : Math.max(0, Number((quotaStatus.minRemainingPct - 0.5).toFixed(2)))
                  )
                }
                className="duo-btn px-3 py-1.5 rounded-xl bg-[#FFF4CC] border-2 border-b-4 border-[#FFC800] text-[#9A6B00] text-[11px] font-black cursor-pointer disabled:opacity-60"
              >
                {quotaStatus.alertStep === null
                  ? 'محاكاة 5.0% متبقية (اختبار إشعار المشرف)'
                  : 'محاكاة نقص 0.5% إضافية'}
              </button>
              {quotaStatus.minRemainingPct < 99.9 && (
                <button
                  type="button"
                  disabled={calibratingQuota}
                  onClick={() => void handleCalibrateQuota(100)}
                  className="duo-btn px-3 py-1.5 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#3C3C3C] text-[11px] font-black cursor-pointer disabled:opacity-60"
                >
                  تصفير عداد اليوم (100%)
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Rules Compliance & Step-by-Step Update Guide Card */}
      {(() => {
        const auditOutdated = rulesAuditResults.filter((r) => r.status === 'outdated');
        const auditCheckedOk = rulesAuditResults.filter((r) => r.status === 'ok');
        const isCheckingNow = rulesCompliance.checking || rulesAuditChecking;
        const isOutdated = auditOutdated.length > 0 || rulesCompliance.compliant === false;
        const isUpToDate =
          !isOutdated && (rulesCompliance.compliant === true || auditCheckedOk.length > 0);
        const expanded = isOutdated || showRulesGuideDetails;
        const registeredProjects = Array.from(
          new Set([
            activeProjectId,
            ...poolState.playerDatabases.map((d) => d.config.projectId),
            ...poolState.backupDatabases.map((d) => d.config.projectId),
          ])
        );

        return (
          <div
            className={`duo-card p-4 sm:p-5 border-2 flex flex-col gap-3 ${
              isOutdated
                ? 'bg-[#FFF5F5] border-[#FF4B4B]'
                : isUpToDate
                ? 'bg-[#F4FFE8] border-[#58CC02]'
                : 'bg-[#F8FAFC] border-[#1CB0F6]'
            }`}
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-3">
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                    isOutdated
                      ? 'bg-[#FF4B4B] text-white'
                      : isUpToDate
                      ? 'bg-[#58CC02] text-white'
                      : 'bg-[#1CB0F6] text-white'
                  }`}
                >
                  {isCheckingNow ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : isOutdated ? (
                    <ShieldAlert className="w-5 h-5" />
                  ) : (
                    <ShieldCheck className="w-5 h-5" />
                  )}
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm sm:text-base font-black text-[#3C3C3C]">
                      الفحص الذكي لقواعد الأمان (firestore.rules)
                    </h2>
                    <span
                      className={`px-2.5 py-0.5 rounded-lg text-[11px] font-black border ${
                        isCheckingNow
                          ? 'bg-[#E6F7FF] border-[#1CB0F6] text-[#1899D6]'
                          : isOutdated
                          ? 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B]'
                          : isUpToDate
                          ? 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                          : 'bg-white border-[#E5E5E5] text-[#777777]'
                      }`}
                    >
                      {isCheckingNow
                        ? 'جاري الفحص الفعلي...'
                        : isOutdated
                        ? `⚠️ ${auditOutdated.length || 1} قاعدة تحتاج تحديثاً`
                        : isUpToDate
                        ? 'جميع القواعد المفحوصة سليمة 100% ✓'
                        : 'لم يكتمل الفحص'}
                    </span>
                  </div>
                  <p className="text-xs font-bold text-[#666666] mt-0.5">
                    {isOutdated
                      ? auditOutdated.length > 0
                        ? `القواعد المحتاجة إصلاح: ${auditOutdated.map((d) => `${d.label} (${d.projectId})`).join(' · ')}`
                        : rulesCompliance.reason ||
                          `القاعدة النشطة (${rulesCompliance.checkedProjectId}) تعمل على نسخة قديمة من firestore.rules؛ حدّثها الآن.`
                      : isUpToDate
                      ? `تم التحقق فعلياً من ${rulesCompliance.checkedProjectId}${
                          auditCheckedOk.length > 1
                            ? ` و${auditCheckedOk.length - 1} قاعدة أخرى`
                            : ''
                        }: محمية وتدعم الأسئلة المميزة ⭐ والجداول و+100 سؤال.`
                      : 'تحقق فعلياً من توافق قواعد الأمان على مشاريع Firebase المسجلة.'}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {onOpenRulesModal && (
                  <button
                    type="button"
                    onClick={() => {
                      onOpenRulesModal();
                      if (onRecheckAllRules) onRecheckAllRules();
                    }}
                    className={`duo-btn flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-b-4 text-xs font-black cursor-pointer ${
                      isOutdated
                        ? 'bg-[#FF4B4B] border-[#EA2B2B] text-white'
                        : 'bg-[#A560E8] border-[#8938D6] text-white'
                    }`}
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>{isOutdated ? 'فتح نافذة الإصلاح والتحقق' : 'فحص شامل لكل القواعد'}</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={isCheckingNow}
                  onClick={() => void recheckActiveRules(true)}
                  className="duo-btn flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] hover:border-[#1CB0F6] text-xs font-black text-[#3C3C3C] cursor-pointer disabled:opacity-60"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-[#1899D6] ${isCheckingNow ? 'animate-spin' : ''}`} />
                  <span>إعادة فحص القواعد الآن</span>
                </button>
                {!isOutdated && (
                  <button
                    type="button"
                    onClick={() => setShowRulesGuideDetails((v) => !v)}
                    className="duo-btn px-3 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs font-black text-[#1899D6] cursor-pointer"
                  >
                    {expanded ? 'إخفاء دليل التحديث' : 'عرض خطوات تحديث القواعد'}
                  </button>
                )}
              </div>
            </div>

            {expanded && (
              <div className="pt-3 border-t border-black/10 flex flex-col gap-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="p-3 rounded-xl bg-white border border-[#E5E5E5] flex flex-col gap-1.5">
                    <div className="text-xs font-black text-[#3C3C3C]">
                      ما الجديد الذي أُضيف في ملف القواعد؟
                    </div>
                    <ul className="list-disc pr-4 text-[11px] font-bold text-[#555555] flex flex-col gap-1 leading-relaxed">
                      {RULES_UPDATE_CHANGES_AR.map((item, idx) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="p-3 rounded-xl bg-white border border-[#E5E5E5] flex flex-col gap-1.5">
                    <div className="text-xs font-black text-[#3C3C3C]">
                      الخطوات التفصيلية للتطبيق والنشر في Firebase Console:
                    </div>
                    <ol className="text-[11px] font-bold text-[#555555] flex flex-col gap-1 leading-relaxed">
                      {RULES_UPDATE_STEPS_AR.map((stepText, idx) => (
                        <li key={idx}>{stepText}</li>
                      ))}
                    </ol>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopyRules()}
                    className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-b-4 border-[#1899D6] text-white text-xs font-black cursor-pointer"
                  >
                    {copiedRules ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    <span>{copiedRules ? 'تم نسخ firestore.rules المحدّثة ✓' : 'نسخ firestore.rules المحدّثة'}</span>
                  </button>

                  {registeredProjects.map((pid) => (
                    <a
                      key={pid}
                      href={`https://console.firebase.google.com/project/${encodeURIComponent(pid)}/firestore/rules`}
                      target="_blank"
                      rel="noreferrer"
                      className="duo-btn flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] hover:border-[#1CB0F6] text-xs font-black text-[#3C3C3C]"
                    >
                      <ExternalLink className="w-3.5 h-3.5 text-[#1899D6]" />
                      <span>فتح Rules في Firebase Console ({pid})</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Sub-tabs */}
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => {
            setSubTab('databases');
            playDuoSound('pop');
          }}
          className={`duo-btn flex items-center justify-center gap-2 py-3.5 px-4 rounded-2xl border-2 border-b-4 text-sm sm:text-base font-black cursor-pointer ${
            subTab === 'databases'
              ? 'bg-[#1CB0F6] border-[#1899D6] text-white'
              : 'bg-white border-[#E5E5E5] text-[#777777] hover:text-[#3C3C3C]'
          }`}
        >
          <Database className="w-5 h-5" />
          <span>
            القواعد والنقل ({poolState.playerDatabases.length} + {poolState.backupDatabases.length})
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            setSubTab('programmers');
            playDuoSound('pop');
          }}
          className={`duo-btn flex items-center justify-center gap-2 py-3.5 px-4 rounded-2xl border-2 border-b-4 text-sm sm:text-base font-black cursor-pointer ${
            subTab === 'programmers'
              ? 'bg-[#A560E8] border-[#8938D6] text-white'
              : 'bg-white border-[#E5E5E5] text-[#777777] hover:text-[#3C3C3C]'
          }`}
        >
          <Users className="w-5 h-5" />
          <span>المبرمجون والصلاحيات ({poolState.programmers.length})</span>
        </button>
      </div>

      {/* Status / Error Notifications */}
      {statusNotice && (
        <div className="p-4 rounded-2xl bg-[#D7FFB8] border-2 border-[#58CC02] text-[#46A302] text-xs sm:text-sm font-black flex items-center gap-2.5">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          <span>{statusNotice}</span>
        </div>
      )}

      {errorNotice && (
        <div className="p-4 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-[#EA2B2B] text-xs sm:text-sm font-black flex items-start gap-2.5">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <span>{errorNotice}</span>
        </div>
      )}

      {pendingPopupBackup && (
        <div className="p-4 rounded-2xl bg-[#FFF4CC] border-2 border-[#FFC800] flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs sm:text-sm font-black text-[#3C3C3C]">
            تم نقل كل البيانات 100%! بقي خطوة واحدة لإيقاظ القاعدة الاحتياطية ({pendingPopupBackup.backupEntry.config.projectId}) وإعلان القاعدة الجديدة للجميع:
          </div>
          <button
            type="button"
            disabled={actionBusy}
            onClick={() => void handleRetryPendingBackupAnnounce()}
            className="duo-btn flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer"
          >
            <Radio className="w-4 h-4" />
            <span>إعلان القاعدة الاحتياطية الآن</span>
          </button>
        </div>
      )}

      {subTab === 'databases' ? (
        <div className="flex flex-col gap-6">
          {/* Migration Progress */}
          {migratingEntryId && migrationProgress && (
            <DuoLoading
              variant="inline"
              title={migrationProgress.message}
              subtitle={
                migrationProgress.detail ||
                'جاري نقل وتحديث الغرف والسوابير والاختبارات ثم إيقاظ القاعدة الاحتياطية...'
              }
              percent={migrationProgress.percent}
              accent="blue"
            />
          )}

          {/* Setup Assistance during migration */}
          {setupError && (
            <div className="duo-card p-5 bg-[#FFDFE0]/70 border-[#FF4B4B] flex flex-col gap-3">
              <div className="flex items-start gap-2 text-[#EA2B2B] text-sm font-black">
                <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
                <span>{setupError.message}</span>
              </div>
              {setupError.reason === 'firestore_rules' && (
                <div className="bg-white rounded-xl p-3.5 border border-[#FF4B4B]/40 flex flex-wrap items-center gap-2 text-xs font-bold">
                  <button
                    type="button"
                    onClick={() => void handleCopyRules()}
                    className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#1CB0F6] border-2 border-[#1899D6] border-b-4 text-white text-xs font-black cursor-pointer"
                  >
                    {copiedRules ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedRules ? 'تم نسخ firestore.rules' : 'نسخ firestore.rules'}</span>
                  </button>
                  <a
                    href={`https://console.firebase.google.com/project/${setupError.projectId}/firestore/rules`}
                    target="_blank"
                    rel="noreferrer"
                    className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#3C3C3C] text-xs font-black"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>فتح صفحة Rules</span>
                  </a>
                </div>
              )}
              {setupError.reason === 'unauthorized_domain' && (
                <div className="bg-white rounded-xl p-3.5 border border-[#FF4B4B]/40 flex flex-wrap items-center gap-2 text-xs font-bold">
                  <span className="font-latin bg-[#F7F7F7] px-2 py-1 rounded-lg border border-[#E5E5E5]">
                    {window.location.hostname}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopyDomain()}
                    className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#1CB0F6] border-2 border-[#1899D6] border-b-4 text-white text-xs font-black cursor-pointer"
                  >
                    {copiedDomain ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedDomain ? 'تم النسخ' : 'نسخ النطاق'}</span>
                  </button>
                  <a
                    href={`https://console.firebase.google.com/project/${setupError.projectId}/authentication/settings`}
                    target="_blank"
                    rel="noreferrer"
                    className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#3C3C3C] text-xs font-black"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Authorized domains</span>
                  </a>
                </div>
              )}
              {setupError.reason === 'auth_provider' && (
                <div className="bg-white rounded-xl p-3.5 border border-[#FF4B4B]/40 flex flex-wrap items-center gap-2 text-xs font-bold">
                  <a
                    href={`https://console.firebase.google.com/project/${setupError.projectId}/authentication/providers`}
                    target="_blank"
                    rel="noreferrer"
                    className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#1CB0F6] border-2 border-[#1899D6] border-b-4 text-white text-xs font-black"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>تفعيل Google Sign-In</span>
                  </a>
                </div>
              )}
            </div>
          )}

          {/* 1. SECTION A: Player Databases */}
          <div className="duo-card p-5 sm:p-6 flex flex-col gap-4 border-[#1CB0F6]/60">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b-2 border-[#F0F0F0]">
              <div>
                <h2 className="text-lg font-black text-[#3C3C3C] flex items-center gap-2">
                  <Database className="w-5 h-5 text-[#1899D6]" />
                  <span>قواعد البيانات (التي يجلس عليها اللاعبون والاختبارات)</span>
                </h2>
                <p className="text-xs font-bold text-[#777777] mt-0.5">
                  كل قاعدة هنا تم فحصها 100% وإضافتها لتسجيل الدخول. عند النقل إليها تُحدَّث بياناتها القديمة وتنتقل كل الغرف والسوابير ثم تُعلنها القاعدة الاحتياطية للجميع.
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs font-bold text-[#3C3C3C] bg-[#F7F7F7] px-3 py-2 rounded-xl border border-[#E5E5E5] cursor-pointer">
                <input
                  type="checkbox"
                  checked={cleanupOldDatabase}
                  onChange={(e) => setCleanupOldDatabase(e.target.checked)}
                  className="accent-[#58CC02] w-4 h-4 cursor-pointer"
                />
                <span>تنظيف القاعدة السابقة بعد النقل 100%</span>
              </label>
            </div>

            {poolState.playerDatabases.length === 0 ? (
              <div className="p-6 rounded-2xl bg-[#F7F7F7] border-2 border-dashed border-[#D0D0D0] text-center flex flex-col items-center gap-2">
                <Database className="w-8 h-8 text-[#AFAFAF]" />
                <p className="text-sm font-black text-[#3C3C3C]">
                  قائمة «قواعد البيانات» فارغة حالياً
                </p>
                <p className="text-xs font-bold text-[#777777]">
                  أضف قاعدة بيانات جديدة بالأسفل ليتم فحص Firestore وOAuth وRules وإضافتها هنا لتسجيل الدخول.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {poolState.playerDatabases.map((entry) => {
                  const isActive = isSameFirebaseTarget(entry.config, activeFirebaseConfig);
                  const isMigratingThis = migratingEntryId === entry.id;
                  const isDeletingThis = confirmDeleteDbId === entry.id;
                  const isJustAdded = justAddedDbId === entry.id;
                  const chosenBackup = getChosenBackupForTarget(entry.id);
                  const entryQuota =
                    quotaByProject[entry.config.projectId] ||
                    getCachedProjectQuotaStatus(entry.config.projectId);

                  return (
                    <div
                      key={entry.id}
                      className={`rounded-2xl border-2 p-4 flex flex-col gap-3 transition-colors ${
                        isActive
                          ? 'bg-[#D7FFB8]/35 border-[#58CC02]'
                          : isJustAdded
                          ? 'bg-[#E6F7FF]/60 border-[#1CB0F6]'
                          : 'bg-white border-[#E5E5E5]'
                      }`}
                    >
                      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                        <div className="flex items-start gap-3.5 min-w-0">
                          <div
                            className={`w-11 h-11 rounded-2xl flex items-center justify-center font-latin font-black text-base shrink-0 border-b-4 ${
                              isActive
                                ? 'bg-[#58CC02] border-[#46A302] text-white'
                                : 'bg-[#1CB0F6] border-[#1899D6] text-white'
                            }`}
                          >
                            #{entry.order}
                          </div>
                          <div className="flex flex-col gap-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="text-sm sm:text-base font-black text-[#3C3C3C] truncate">
                                {entry.label}
                              </h3>
                              {isActive && (
                                <span className="px-2.5 py-0.5 rounded-lg bg-[#58CC02] text-white text-[11px] font-black">
                                  النشطة حالياً للجميع
                                </span>
                              )}
                              {isJustAdded && (
                                <span className="px-2.5 py-0.5 rounded-lg bg-[#1CB0F6] text-white text-[11px] font-black">
                                  تم الحفظ والربط للتو
                                </span>
                              )}
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-[#D7FFB8] text-[#46A302] text-[10px] font-black">
                                <ShieldCheck className="w-3 h-3" />
                                فحص 100% ومربوطة بالبرنامج
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-[#777777]">
                              <span className="font-latin bg-[#F7F7F7] px-2 py-0.5 rounded-lg border border-[#E5E5E5]">
                                {entry.config.projectId}
                              </span>
                              <span className="font-latin text-[11px]">
                                DB: {entry.config.firestoreDatabaseId || '(default)'}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          {poolState.backupDatabases.length > 0 && !isActive && (
                            <select
                              value={chosenBackup?.id || ''}
                              disabled={actionBusy || Boolean(migratingEntryId)}
                              onChange={(e) =>
                                setSelectedBackupByTarget((prev) => ({
                                  ...prev,
                                  [entry.id]: e.target.value,
                                }))
                              }
                              className="px-2.5 py-2 rounded-xl bg-[#F8F3FF] border-2 border-[#A560E8]/60 text-xs font-black text-[#8938D6] cursor-pointer outline-none"
                              title="اختر القاعدة الاحتياطية التي ستُعلن وتُجهّز القاعدة الجديدة للجميع"
                            >
                              {poolState.backupDatabases.map((b) => (
                                <option key={b.id} value={b.id}>
                                  إعلان عبر: {b.label} ({b.config.projectId})
                                </option>
                              ))}
                            </select>
                          )}

                          {!isActive ? (
                            <button
                              type="button"
                              disabled={actionBusy || Boolean(migratingEntryId)}
                              onClick={() => void handleMigrateToPlayerDb(entry, false)}
                              className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer disabled:opacity-50"
                            >
                              {isMigratingThis ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <ArrowRightLeft className="w-3.5 h-3.5" />
                              )}
                              <span>نقل وتفعيل للجميع</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={actionBusy || Boolean(migratingEntryId)}
                              onClick={() => void handleMigrateToPlayerDb(entry, true)}
                              className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-b-4 border-[#1899D6] text-white text-xs font-black cursor-pointer disabled:opacity-50"
                              title="تحديث كافة الغرف والاختبارات على القاعدة النشطة"
                            >
                              {isMigratingThis ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="w-3.5 h-3.5" />
                              )}
                              <span>تحديث ومزامنة البيانات</span>
                            </button>
                          )}

                          {isDeletingThis ? (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() => void handleRemoveDb(entry)}
                                className="duo-btn px-3 py-2 rounded-xl bg-[#FF4B4B] border-2 border-b-4 border-[#EA2B2B] text-white text-xs font-black cursor-pointer"
                              >
                                تأكيد الحذف
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteDbId(null)}
                                className="duo-btn px-2.5 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs font-black text-[#777777] cursor-pointer"
                              >
                                إلغاء
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={actionBusy || Boolean(migratingEntryId)}
                              onClick={() => setConfirmDeleteDbId(entry.id)}
                              className="duo-btn p-2 rounded-xl bg-white hover:bg-[#FFDFE0] border-2 border-b-4 border-[#E5E5E5] text-[#EA2B2B] cursor-pointer"
                              title="حذف القاعدة من القائمة"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Per-Database Free Quota Limit Bar & Percentage */}
                      <div className="pt-2.5 border-t border-black/10 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px]">
                        <div className="flex flex-wrap items-center gap-2 font-black text-[#3C3C3C]">
                          <Gauge className="w-3.5 h-3.5 text-[#1899D6] shrink-0" />
                          <span>المتبقي من الحد المجاني:</span>
                          <span
                            className={`px-2 py-0.5 rounded-lg border font-latin ${
                              entryQuota.minRemainingPct <= 2
                                ? 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B]'
                                : entryQuota.minRemainingPct <= 5
                                ? 'bg-[#FFF4CC] border-[#FFC800] text-[#9A6B00]'
                                : 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                            }`}
                          >
                            {entryQuota.minRemainingPct.toFixed(1)}%
                          </span>
                          <span className="font-bold text-[#777777]">
                            (باقي {entryQuota.bottleneckRemainingCount.toLocaleString('en-US')} •{' '}
                            {formatQuotaMetricArabic(entryQuota.bottleneckMetric)})
                          </span>
                        </div>
                        <div className="flex items-center gap-2 sm:w-56 shrink-0">
                          <div className="flex-1 h-2.5 rounded-full bg-[#EDEDED] overflow-hidden border border-[#D4D4D4]">
                            <svg className="w-full h-full block" aria-hidden="true">
                              <rect
                                x="0"
                                y="0"
                                height="100%"
                                width={`${Math.max(0, Math.min(100, entryQuota.minRemainingPct)).toFixed(2)}%`}
                                className={
                                  entryQuota.minRemainingPct <= 2
                                    ? 'fill-[#FF4B4B]'
                                    : entryQuota.minRemainingPct <= 5
                                    ? 'fill-[#FFC800]'
                                    : 'fill-[#58CC02]'
                                }
                              />
                            </svg>
                          </div>
                          <span dir="ltr" className="font-latin font-black text-[#3C3C3C] w-12 text-right">
                            {entryQuota.minRemainingPct.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 2. SECTION B: Untouched Backup Databases */}
          <div className="duo-card p-5 sm:p-6 flex flex-col gap-4 border-[#A560E8]/60 bg-gradient-to-b from-[#FAF7FF] to-white">
            <div className="pb-3 border-b-2 border-[#EFE6FF]">
              <h2 className="text-lg font-black text-[#3C3C3C] flex items-center gap-2">
                <Radio className="w-5 h-5 text-[#8938D6]" />
                <span>القواعد الاحتياطية الصامتة (لا تُمس بتاتاً)</span>
              </h2>
              <p className="text-xs font-bold text-[#777777] mt-0.5">
                لا يدخلها أي لاعب ولا يُنقل إليها أي اختبار أو سبورة. تبقى فارغة تماماً وتستيقظ فقط لحظة اكتمال النقل 100% لتُعلن وتُجهّز القاعدة الجديدة لجميع المتصلين.
              </p>
            </div>

            {poolState.backupDatabases.length === 0 ? (
              <div className="p-6 rounded-2xl bg-white border-2 border-dashed border-[#D8B4FE] text-center flex flex-col items-center gap-2">
                <Radio className="w-8 h-8 text-[#A560E8]" />
                <p className="text-sm font-black text-[#3C3C3C]">
                  لا توجد قواعد احتياطية صامتة مضافة حالياً
                </p>
                <p className="text-xs font-bold text-[#777777]">
                  من نموذج الإضافة بالأسفل اختر نوع «قاعدة احتياطية صامتة»، وافحصها 100% لإضافتها هنا.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {poolState.backupDatabases.map((entry) => {
                  const isDeletingThis = confirmDeleteDbId === entry.id;
                  return (
                    <div
                      key={entry.id}
                      className="rounded-2xl border-2 border-[#E2D4F8] bg-white p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="w-11 h-11 rounded-2xl bg-[#A560E8] border-b-4 border-[#8938D6] text-white flex items-center justify-center font-latin font-black text-base shrink-0">
                          #{entry.order}
                        </div>
                        <div className="flex flex-col gap-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm sm:text-base font-black text-[#3C3C3C] truncate">
                              {entry.label}
                            </h3>
                            <span className="px-2.5 py-0.5 rounded-lg bg-[#F3E8FF] border border-[#A560E8]/60 text-[#8938D6] text-[11px] font-black">
                              {entry.lastAnnouncedToProjectId
                                ? `أعلنت آخر انتقال ← ${entry.lastAnnouncedToProjectId}`
                                : 'ساكنة وجاهزة (لا تُمس)'}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-[#777777]">
                            <span className="font-latin bg-[#F7F7F7] px-2 py-0.5 rounded-lg border border-[#E5E5E5]">
                              {entry.config.projectId}
                            </span>
                            <span className="text-[11px] text-[#46A302] font-black">
                              ✓ تم التحقق من Rules + OAuth
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={actionBusy || Boolean(migratingEntryId)}
                          onClick={() => void handleRefreshBackupAuth(entry)}
                          className="duo-btn flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] hover:border-[#A560E8] text-xs font-black text-[#8938D6] cursor-pointer"
                          title="تأكيد جلسة المبرمج على هذه الاحتياطية لتعمل بدون نوافذ منبثقة أثناء النقل"
                        >
                          <ShieldCheck className="w-3.5 h-3.5" />
                          <span>تجديد تأكيد الدخول</span>
                        </button>

                        {isDeletingThis ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={actionBusy}
                              onClick={() => void handleRemoveDb(entry)}
                              className="duo-btn px-3 py-2 rounded-xl bg-[#FF4B4B] border-2 border-b-4 border-[#EA2B2B] text-white text-xs font-black cursor-pointer"
                            >
                              تأكيد الحذف
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteDbId(null)}
                              className="duo-btn px-2.5 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs font-black text-[#777777] cursor-pointer"
                            >
                              إلغاء
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={actionBusy || Boolean(migratingEntryId)}
                            onClick={() => setConfirmDeleteDbId(entry.id)}
                            className="duo-btn p-2 rounded-xl bg-white hover:bg-[#FFDFE0] border-2 border-b-4 border-[#E5E5E5] text-[#EA2B2B] cursor-pointer"
                            title="حذف القاعدة الاحتياطية"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 3. Pre-Add Live Verification Wizard & Form */}
          <form onSubmit={handleVerifyAndAddDatabase} className="duo-card p-5 sm:p-6 flex flex-col gap-4">
            <div className="flex items-center gap-2.5 pb-2 border-b-2 border-[#F0F0F0]">
              <div className="w-9 h-9 rounded-xl bg-[#1CB0F6]/15 text-[#1899D6] flex items-center justify-center">
                <Plus className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base sm:text-lg font-black text-[#3C3C3C]">
                  فحص 100% وإضافة قاعدة Firebase جديدة
                </h2>
                <p className="text-xs font-bold text-[#777777]">
                  لصق firebaseConfig فقط لا يكفي — سيختبر البرنامج وجود Firestore وGoogle OAuth وfirestore.rules الآمنة قبل الحفظ، ويخبرك بالخطوة الناقصة إن وُجدت.
                </p>
              </div>
            </div>

            {/* Role Toggle */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                disabled={verifyingAndAdding}
                onClick={() => {
                  setNewDbRole('player');
                  setVerifySteps(null);
                  setAddSuccessNotice(null);
                  setErrorNotice(null);
                }}
                className={`p-3.5 rounded-2xl border-2 text-right flex items-start gap-3 cursor-pointer transition-colors ${
                  newDbRole === 'player'
                    ? 'bg-[#E6F7FF] border-[#1CB0F6]'
                    : 'bg-[#F7F7F7] border-[#E5E5E5]'
                }`}
              >
                <Database
                  className={`w-5 h-5 shrink-0 mt-0.5 ${
                    newDbRole === 'player' ? 'text-[#1899D6]' : 'text-[#777777]'
                  }`}
                />
                <div>
                  <div className="text-xs sm:text-sm font-black text-[#3C3C3C]">
                    قاعدة بيانات (للاعبين والاختبارات)
                  </div>
                  <div className="text-[11px] font-bold text-[#777777]">
                    تُضاف لتسجيل الدخول وتستقبل الغرف والسوابير والاختبارات
                  </div>
                </div>
              </button>

              <button
                type="button"
                disabled={verifyingAndAdding}
                onClick={() => {
                  setNewDbRole('backup');
                  setVerifySteps(null);
                  setAddSuccessNotice(null);
                  setErrorNotice(null);
                }}
                className={`p-3.5 rounded-2xl border-2 text-right flex items-start gap-3 cursor-pointer transition-colors ${
                  newDbRole === 'backup'
                    ? 'bg-[#F3E8FF] border-[#A560E8]'
                    : 'bg-[#F7F7F7] border-[#E5E5E5]'
                }`}
              >
                <Radio
                  className={`w-5 h-5 shrink-0 mt-0.5 ${
                    newDbRole === 'backup' ? 'text-[#8938D6]' : 'text-[#777777]'
                  }`}
                />
                <div>
                  <div className="text-xs sm:text-sm font-black text-[#3C3C3C]">
                    قاعدة احتياطية صامتة (لا تُمس بتاتاً)
                  </div>
                  <div className="text-[11px] font-bold text-[#777777]">
                    لا يجلس عليها أي لاعب — فقط تُعلن القاعدة الجديدة بعد النقل 100%
                  </div>
                </div>
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="pool-db-label" className="text-xs font-extrabold text-[#3C3C3C]">
                اسم توضيحي للقاعدة (اختياري)
              </label>
              <input
                id="pool-db-label"
                type="text"
                maxLength={70}
                value={newDbLabel}
                onChange={(e) => setNewDbLabel(e.target.value)}
                disabled={verifyingAndAdding}
                placeholder={
                  newDbRole === 'player'
                    ? `مثال: قاعدة اللاعبين #${poolState.playerDatabases.length + 1}`
                    : `مثال: الاحتياطية الصامتة #${poolState.backupDatabases.length + 1}`
                }
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#1CB0F6] focus:bg-white outline-none text-sm font-bold text-[#3C3C3C]"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="pool-db-snippet" className="text-xs font-extrabold text-[#3C3C3C]">
                كود إعدادات Firebase (const firebaseConfig = ...)
              </label>
              <textarea
                id="pool-db-snippet"
                dir="ltr"
                rows={6}
                value={configInput}
                onChange={(e) => {
                  setConfigInput(e.target.value);
                  setVerifySteps(null);
                  setAddSuccessNotice(null);
                }}
                disabled={verifyingAndAdding}
                placeholder={`const firebaseConfig = {\n  apiKey: "...",\n  authDomain: "project-x.firebaseapp.com",\n  projectId: "project-x",\n  appId: "..."\n};`}
                className="w-full p-3.5 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#1CB0F6] focus:bg-white outline-none font-latin text-xs leading-relaxed text-[#3C3C3C]"
              />
            </div>

            {detectedPreview && (
              <div
                className={`p-3 rounded-xl border-2 text-xs font-bold flex items-center gap-2 ${
                  detectedPreview.ok
                    ? 'bg-[#D7FFB8]/50 border-[#58CC02] text-[#46A302]'
                    : 'bg-[#FFDFE0]/70 border-[#FF4B4B] text-[#EA2B2B]'
                }`}
              >
                {detectedPreview.ok ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>تم التعرف على المشروع:</span>
                    <span className="font-latin font-black bg-white px-2 py-0.5 rounded-lg border border-[#58CC02]/40">
                      {detectedPreview.config.projectId}
                    </span>
                    <span className="text-[#777777] font-latin">
                      ({detectedPreview.config.firestoreDatabaseId || '(default)'})
                    </span>
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{detectedPreview.message}</span>
                  </>
                )}
              </div>
            )}

            <div>
              <button
                type="button"
                onClick={() => setShowAdvancedDb((v) => !v)}
                className="text-xs font-extrabold text-[#1899D6] hover:underline cursor-pointer"
              >
                {showAdvancedDb
                  ? 'إخفاء معرّف قاعدة البيانات المخصّص'
                  : 'خيار متقدم: تحديد firestoreDatabaseId مخصّص (إن وجد)'}
              </button>
              {showAdvancedDb && (
                <input
                  type="text"
                  dir="ltr"
                  value={customDatabaseId}
                  onChange={(e) => setCustomDatabaseId(e.target.value)}
                  placeholder="(default)"
                  className="mt-2 w-full px-3.5 py-2.5 rounded-xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#1CB0F6] outline-none font-latin text-xs font-bold text-[#3C3C3C]"
                />
              )}
            </div>

            {/* Quick Setup Helper Toolbar (Copy Rules + Domain before or during verification) */}
            <div className="p-3.5 rounded-2xl bg-[#F8FAFC] border-2 border-[#E5E5E5] flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-black text-[#3C3C3C]">
                  تجهيز القاعدة في Firebase Console:
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopyRules()}
                    className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#1CB0F6] border-2 border-b-4 border-[#1899D6] text-white text-[11px] font-black cursor-pointer"
                  >
                    {copiedRules ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedRules ? 'تم نسخ firestore.rules' : 'نسخ firestore.rules الرسمية'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowRulesPreview((v) => !v)}
                    className="duo-btn px-3 py-1.5 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[11px] font-black text-[#3C3C3C] cursor-pointer"
                  >
                    {showRulesPreview ? 'إخفاء نص القواعد' : 'عرض القواعد للنسخ اليدوي'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopyDomain()}
                    className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[11px] font-black text-[#3C3C3C] cursor-pointer"
                  >
                    {copiedDomain ? (
                      <Check className="w-3.5 h-3.5 text-[#46A302]" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {copiedDomain ? 'تم نسخ النطاق' : `نسخ النطاق (${window.location.hostname})`}
                    </span>
                  </button>
                </div>
              </div>
              {showRulesPreview && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-bold text-[#777777]">
                    حدد النص كاملاً (Ctrl+A ثم Ctrl+C) وألصقه في Firebase Console -&gt; Firestore Database -&gt; Rules ثم اضغط Publish:
                  </span>
                  <textarea
                    readOnly
                    dir="ltr"
                    rows={7}
                    value={firestoreRulesRaw}
                    onFocus={(e) => e.currentTarget.select()}
                    className="w-full p-2.5 rounded-xl bg-white border border-[#D0D0D0] font-latin text-[11px] text-[#3C3C3C] outline-none"
                  />
                </div>
              )}
            </div>

            {/* Live 5-Step Checklist Panel */}
            {verifySteps && (
              <div className="p-4 rounded-2xl bg-[#F9FAFB] border-2 border-[#E5E5E5] flex flex-col gap-2.5">
                <div className="text-xs font-black text-[#3C3C3C] pb-1 border-b border-[#E5E5E5]">
                  تقرير الفحص الشامل للقاعدة:
                </div>
                {verifySteps.map((step) => (
                  <div
                    key={step.id}
                    className={`p-3 rounded-xl border flex flex-col gap-2 ${
                      step.status === 'passed'
                        ? 'bg-[#D7FFB8]/40 border-[#58CC02]'
                        : step.status === 'failed'
                        ? 'bg-[#FFDFE0]/70 border-[#FF4B4B]'
                        : step.status === 'running'
                        ? 'bg-[#E6F7FF] border-[#1CB0F6]'
                        : 'bg-white border-[#E5E5E5] opacity-70'
                    }`}
                  >
                    <div className="flex items-center gap-2 text-xs font-black">
                      {step.status === 'passed' && (
                        <CheckCircle2 className="w-4 h-4 text-[#46A302] shrink-0" />
                      )}
                      {step.status === 'failed' && (
                        <XCircle className="w-4 h-4 text-[#EA2B2B] shrink-0" />
                      )}
                      {step.status === 'running' && (
                        <Loader2 className="w-4 h-4 text-[#1899D6] animate-spin shrink-0" />
                      )}
                      {step.status === 'pending' && (
                        <span className="w-4 h-4 rounded-full border-2 border-[#CFCFCF] shrink-0" />
                      )}
                      <span
                        className={
                          step.status === 'failed'
                            ? 'text-[#EA2B2B]'
                            : step.status === 'passed'
                            ? 'text-[#46A302]'
                            : 'text-[#3C3C3C]'
                        }
                      >
                        {step.label}
                      </span>
                    </div>

                    {step.detail && (
                      <p className="text-[11px] font-bold text-[#3C3C3C] pr-6">{step.detail}</p>
                    )}
                    {step.fixHint && (
                      <p className="text-[11px] font-extrabold text-[#9A6B00] bg-[#FFF4CC] px-2.5 py-1.5 rounded-lg border border-[#FFC800] mr-6">
                        الحل المطلوب: {step.fixHint}
                      </p>
                    )}

                    {(step.status === 'failed' ||
                      step.consoleUrl ||
                      step.actionType === 'copy_rules' ||
                      step.actionType === 'copy_domain') && (
                      <div className="flex flex-wrap items-center gap-2 pr-6 pt-0.5">
                        {step.actionType === 'copy_rules' && (
                          <button
                            type="button"
                            onClick={() => void handleCopyRules()}
                            className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#1CB0F6] border-2 border-b-4 border-[#1899D6] text-white text-[11px] font-black cursor-pointer"
                          >
                            {copiedRules ? (
                              <Check className="w-3.5 h-3.5" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                            <span>{copiedRules ? 'تم نسخ firestore.rules' : 'نسخ firestore.rules'}</span>
                          </button>
                        )}
                        {step.actionType === 'copy_domain' && (
                          <button
                            type="button"
                            onClick={() => void handleCopyDomain()}
                            className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#1CB0F6] border-2 border-b-4 border-[#1899D6] text-white text-[11px] font-black cursor-pointer"
                          >
                            {copiedDomain ? (
                              <Check className="w-3.5 h-3.5" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                            <span>
                              {copiedDomain
                                ? 'تم نسخ النطاق'
                                : `نسخ النطاق (${window.location.hostname})`}
                            </span>
                          </button>
                        )}
                        {step.consoleUrl && (
                          <a
                            href={step.consoleUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#3C3C3C] text-[11px] font-black"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            <span>فتح الإعداد في Firebase Console</span>
                          </a>
                        )}
                        {step.status === 'failed' && (
                          <button
                            type="submit"
                            disabled={verifyingAndAdding || !detectedPreview?.ok}
                            className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-[11px] font-black cursor-pointer disabled:opacity-50"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            <span>إعادة الفحص الآن</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Inline Completion Banner next to Add Form */}
            {addSuccessNotice && (
              <div className="p-3.5 rounded-2xl bg-[#D7FFB8] border-2 border-[#58CC02] text-[#46A302] text-xs sm:text-sm font-black flex items-center gap-2.5">
                <CheckCircle2 className="w-5 h-5 shrink-0" />
                <span>{addSuccessNotice}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={verifyingAndAdding || !detectedPreview?.ok}
              className={`duo-btn flex items-center justify-center gap-2 px-6 py-3.5 rounded-2xl border-2 border-b-[5px] text-white text-sm sm:text-base font-black cursor-pointer disabled:opacity-50 ${
                newDbRole === 'player'
                  ? 'bg-[#1CB0F6] hover:bg-[#33BCFF] border-[#1899D6]'
                  : 'bg-[#A560E8] hover:bg-[#B477EE] border-[#8938D6]'
              }`}
            >
              {verifyingAndAdding ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <ShieldCheck className="w-5 h-5" />
              )}
              <span>
                {newDbRole === 'player'
                  ? 'فحص شامل 100% وإضافة لقواعد البيانات'
                  : 'فحص شامل 100% وإضافة كقاعدة احتياطية صامتة'}
              </span>
            </button>
          </form>
        </div>
      ) : (
        /* Programmers Promotion Tab */
        <div className="flex flex-col gap-6">
          <form onSubmit={handlePromoteMember} className="duo-card p-5 sm:p-6 flex flex-col gap-4">
            <div className="flex items-center gap-2.5 pb-2 border-b-2 border-[#F0F0F0]">
              <div className="w-9 h-9 rounded-xl bg-[#A560E8]/15 text-[#8938D6] flex items-center justify-center">
                <UserPlus className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base sm:text-lg font-black text-[#3C3C3C]">
                  ترقية عضو إلى مبرمج
                </h2>
                <p className="text-xs font-bold text-[#777777]">
                  سيظهر تبويب «مبرمج» وزر «نقل القاعدة» داخل الغرف فوراً لأي عضو تتم ترقيته
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="promo-name" className="text-xs font-extrabold text-[#3C3C3C]">
                  الاسم الرباعي الكامل
                </label>
                <input
                  id="promo-name"
                  type="text"
                  maxLength={120}
                  value={promoName}
                  onChange={(e) => setPromoName(e.target.value)}
                  placeholder="مثال: أحمد علي محمود حسن"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#A560E8] focus:bg-white outline-none text-sm font-bold text-[#3C3C3C]"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="promo-email" className="text-xs font-extrabold text-[#3C3C3C]">
                  البريد الإلكتروني (Gmail)
                </label>
                <input
                  id="promo-email"
                  type="email"
                  dir="ltr"
                  maxLength={120}
                  value={promoEmail}
                  onChange={(e) => setPromoEmail(e.target.value)}
                  placeholder="developer@gmail.com"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#A560E8] focus:bg-white outline-none font-latin text-sm font-bold text-[#3C3C3C]"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={promoting || (!promoName.trim() && !promoEmail.trim())}
              className="duo-btn flex items-center justify-center gap-2 px-6 py-3.5 rounded-2xl bg-[#A560E8] hover:bg-[#B477EE] border-2 border-b-[5px] border-[#8938D6] text-white text-sm sm:text-base font-black cursor-pointer disabled:opacity-50"
            >
              {promoting ? <Loader2 className="w-5 h-5 animate-spin" /> : <UserPlus className="w-5 h-5" />}
              <span>ترقية إلى مبرمج الآن</span>
            </button>
          </form>

          <div className="duo-card p-5 sm:p-6 flex flex-col gap-3.5">
            <h2 className="text-base sm:text-lg font-black text-[#3C3C3C]">
              فريق المبرمجين ({poolState.programmers.length})
            </h2>
            <div className="flex flex-col gap-2.5">
              {poolState.programmers.map((member) => (
                <div
                  key={member.id}
                  className={`rounded-2xl border-2 p-3.5 flex flex-wrap items-center justify-between gap-3 ${
                    member.isMaster
                      ? 'bg-[#FFF9E6] border-[#FFC800]'
                      : 'bg-white border-[#E5E5E5]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                        member.isMaster
                          ? 'bg-[#FFC800] text-[#3C3C3C]'
                          : 'bg-[#F3E8FF] text-[#8938D6]'
                      }`}
                    >
                      {member.isMaster ? <Crown className="w-5 h-5" /> : <ShieldCheck className="w-5 h-5" />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm sm:text-base font-black text-[#3C3C3C]">
                          {member.fullNameQuad || member.email}
                        </span>
                        {member.isMaster && (
                          <span className="px-2 py-0.5 rounded-lg bg-[#FFC800] text-[#3C3C3C] text-[11px] font-black">
                            المبرمج الأساسي
                          </span>
                        )}
                      </div>
                      {member.email && (
                        <span className="font-latin text-xs font-bold text-[#777777]">
                          {member.email}
                        </span>
                      )}
                    </div>
                  </div>

                  {!member.isMaster && (
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => void handleDemoteMember(member.id)}
                      className="duo-btn flex items-center gap-1 px-3 py-2 rounded-xl bg-white hover:bg-[#FFDFE0] border-2 border-b-4 border-[#E5E5E5] text-xs font-black text-[#EA2B2B] cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>إزالة الصلاحية</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
