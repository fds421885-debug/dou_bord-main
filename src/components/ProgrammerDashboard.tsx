import React, { useMemo, useState } from 'react';
import { signOut, type User } from 'firebase/auth';
import {
  AlertCircle,
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Check,
  CheckCircle2,
  Code2,
  Copy,
  Crown,
  Database,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  Zap,
} from 'lucide-react';
import firestoreRulesRaw from '../../firestore.rules?raw';
import {
  activateCustomFirebaseConfig,
  activeFirebaseConfig,
  activeProjectId,
  auth,
  buildCleanPrimaryUrl,
  defaultFirebaseConfig,
  isSameFirebaseTarget,
  resetToDefaultFirebaseConfig,
  type FirebaseAppConfig,
} from '../firebase';
import {
  activateDatabaseFromPool,
  addDatabaseToPool,
  MigrationNeedsSetupError,
  parseFirebaseConfigSnippet,
  promoteProgrammerMember,
  reactivatePoolDatabase,
  removeDatabaseFromPool,
  removeProgrammerMember,
  reorderDatabasePool,
  runFirebaseMigration,
  type MigrationProgress,
} from '../firebaseMigration';
import type {
  PlatformProgrammerState,
  PoolDatabaseEntry,
  Room,
  UserProfile,
} from '../types';
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
}) => {
  const fullNameQuad = profile?.fullNameQuad || firebaseUser.displayName || '';

  const [subTab, setSubTab] = useState<'databases' | 'programmers'>('databases');

  // Add Database Form State
  const [newDbLabel, setNewDbLabel] = useState('');
  const [configInput, setConfigInput] = useState('');
  const [showAdvancedDb, setShowAdvancedDb] = useState(false);
  const [customDatabaseId, setCustomDatabaseId] = useState('');
  const [addingDb, setAddingDb] = useState(false);

  // Migration / Switching State
  const [migratingEntryId, setMigratingEntryId] = useState<string | null>(null);
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(null);
  const [cleanupOldDatabase, setCleanupOldDatabase] = useState(true);
  const [setupError, setSetupError] = useState<MigrationNeedsSetupError | null>(null);
  const [copiedRules, setCopiedRules] = useState(false);
  const [copiedDomain, setCopiedDomain] = useState(false);

  // Confirm delete DB
  const [confirmDeleteDbId, setConfirmDeleteDbId] = useState<string | null>(null);

  // Promote Programmer State
  const [promoName, setPromoName] = useState('');
  const [promoEmail, setPromoEmail] = useState('');
  const [promoting, setPromoting] = useState(false);

  // Banners
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

  const activeEntry =
    poolState.databases.find((d) => d.id === poolState.activeDatabaseId) ||
    poolState.databases[0];

  const handleAddDatabase = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorNotice(null);
    setStatusNotice(null);
    setSetupError(null);

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

    setAddingDb(true);
    try {
      const res = await addDatabaseToPool(
        firebaseUser,
        fullNameQuad,
        parsedCfg,
        newDbLabel.trim()
      );
      onPoolStateUpdated(res.state);
      setConfigInput('');
      setNewDbLabel('');
      setCustomDatabaseId('');
      playDuoSound('correct');
      setStatusNotice(
        `تمت إضافة القاعدة #${res.added.order} (${res.added.config.projectId}) إلى القائمة بنجاح!`
      );
    } catch (err) {
      playDuoSound('wrong');
      setErrorNotice(err instanceof Error ? err.message : 'تعذر إضافة قاعدة البيانات.');
    } finally {
      setAddingDb(false);
    }
  };

  const handleMoveOrder = async (index: number, direction: 'up' | 'down') => {
    const targetIdx = direction === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= poolState.databases.length) return;
    setActionBusy(true);
    setErrorNotice(null);
    try {
      const nextList = [...poolState.databases];
      const [moved] = nextList.splice(index, 1);
      nextList.splice(targetIdx, 0, moved);
      const res = await reorderDatabasePool(
        firebaseUser,
        fullNameQuad,
        nextList.map((d) => d.id)
      );
      onPoolStateUpdated(res.state);
      playDuoSound('pop');
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'تعذر تعديل ترتيب القواعد.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleMigrateAndActivate = async (entry: PoolDatabaseEntry) => {
    setErrorNotice(null);
    setStatusNotice(null);
    setSetupError(null);

    if (isSameFirebaseTarget(entry.config, activeFirebaseConfig)) {
      // Same DB currently running locally — just make sure server points to it and clear exhausted
      setActionBusy(true);
      try {
        const res = await activateDatabaseFromPool(
          firebaseUser,
          fullNameQuad,
          entry.id,
          currentRoom?.id || null
        );
        onPoolStateUpdated(res.state);
        playDuoSound('correct');
        setStatusNotice(`تم اعتماد القاعدة #${entry.order} (${entry.config.projectId}) للجميع!`);
      } catch (err) {
        setErrorNotice(err instanceof Error ? err.message : 'تعذر تفعيل القاعدة.');
      } finally {
        setActionBusy(false);
      }
      return;
    }

    setMigratingEntryId(entry.id);
    setMigrationProgress({
      step: 'signing_in',
      percent: 5,
      message: `جاري البدء بنقل المنصة كاملة إلى القاعدة #${entry.order} (${entry.config.projectId})...`,
    });

    try {
      const res = await runFirebaseMigration({
        targetConfig: entry.config,
        currentProfile: profile,
        currentRoom,
        isSupervisorInCurrentRoom,
        cleanupOldDatabase,
        onProgress: (p) => setMigrationProgress(p),
      });

      await onRefreshState();
      playDuoSound('correct');
      setStatusNotice(
        `تم نقل ${res.migratedRoomsCount} غرف و${res.migratedMyQuizzesCount} اختباراتي و${res.migratedSavedTestsCount} محفوظات، واعتماد القاعدة #${entry.order} (${entry.config.projectId}) تلقائياً لجميع المستخدمين!`
      );

      // Reload programmer tab smoothly onto the newly activated DB after a moment
      window.setTimeout(() => {
        try {
          sessionStorage.removeItem('duoboard_self_migrated_target');
        } catch {
          // Ignore storage errors
        }
        if (res.migratedRoomId) {
          const url = new URL(window.location.href);
          url.searchParams.delete('fb');
          url.searchParams.set('room', res.migratedRoomId);
          window.location.replace(url.toString());
        } else {
          window.location.replace(buildCleanPrimaryUrl());
        }
      }, 950);
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

  const handleDirectActivateWithoutCopy = async (entry: PoolDatabaseEntry) => {
    setErrorNotice(null);
    setStatusNotice(null);
    setActionBusy(true);
    try {
      try {
        sessionStorage.setItem(
          'duoboard_self_migrated_target',
          `${entry.config.projectId}::${(entry.config.firestoreDatabaseId || '(default)').trim()}`
        );
      } catch {
        // Ignore storage restrictions
      }
      const res = await activateDatabaseFromPool(
        firebaseUser,
        fullNameQuad,
        entry.id,
        currentRoom?.id || null
      );
      onPoolStateUpdated(res.state);
      playDuoSound('correct');

      await signOut(auth).catch(() => {});
      if (isSameFirebaseTarget(entry.config, defaultFirebaseConfig)) {
        resetToDefaultFirebaseConfig();
      } else {
        activateCustomFirebaseConfig(
          entry.config,
          currentRoom?.id || null,
          poolState.databases.map((d) => d.config as FirebaseAppConfig)
        );
      }
      window.setTimeout(() => {
        try {
          sessionStorage.removeItem('duoboard_self_migrated_target');
        } catch {
          // Ignore
        }
        window.location.replace(buildCleanPrimaryUrl());
      }, 450);
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'تعذر التبديل الفوري للقاعدة.');
      setActionBusy(false);
    }
  };

  const handleReactivateDb = async (databaseId: string | 'ALL') => {
    setActionBusy(true);
    setErrorNotice(null);
    try {
      const res = await reactivatePoolDatabase(firebaseUser, fullNameQuad, databaseId);
      onPoolStateUpdated(res.state);
      playDuoSound('correct');
      setStatusNotice(
        databaseId === 'ALL'
          ? 'تم تصفير حالة الامتلاء لجميع القواعد وإعادة تشغيل المنصة!'
          : 'تمت إعادة تفعيل القاعدة وهي جاهزة للعمل والتبديل التلقائي.'
      );
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'تعذر إعادة تفعيل القاعدة.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleRemoveDb = async (databaseId: string) => {
    setActionBusy(true);
    setErrorNotice(null);
    try {
      const res = await removeDatabaseFromPool(firebaseUser, fullNameQuad, databaseId);
      onPoolStateUpdated(res.state);
      setConfirmDeleteDbId(null);
      playDuoSound('pop');
      setStatusNotice('تمت إزالة القاعدة من القائمة وإعادة ترقيم الباقي.');
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

  const handleCopyRules = async () => {
    try {
      await navigator.clipboard.writeText(firestoreRulesRaw);
      setCopiedRules(true);
      playDuoSound('pop');
      setTimeout(() => setCopiedRules(false), 2000);
    } catch {
      // Ignore
    }
  };

  const handleCopyDomain = async () => {
    try {
      await navigator.clipboard.writeText(window.location.hostname);
      setCopiedDomain(true);
      playDuoSound('pop');
      setTimeout(() => setCopiedDomain(false), 2000);
    } catch {
      // Ignore
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
                  لوحة المبرمج وإدارة المنصة
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
                      ? 'وضع الاستضافة الثابتة (GitHub / Netlify)'
                      : 'متصل بالخادم + السحابة'}
                  </span>
                </span>
              </div>
              <p className="text-xs sm:text-sm font-bold text-[#777777] mt-0.5">
                إدارة قائمة قواعد البيانات بالترتيب، التناوب التلقائي عند امتلاء الحصة، وترقية المبرمجين
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void onRefreshState()}
            disabled={actionBusy || Boolean(migratingEntryId)}
            className="duo-btn self-start sm:self-center flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs sm:text-sm font-black text-[#3C3C3C] hover:border-[#1CB0F6] cursor-pointer"
          >
            <RefreshCw className="w-4 h-4 text-[#1899D6]" />
            <span>تحديث الحالة</span>
          </button>
        </div>

        {/* Live Pool Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
          <div className="p-3.5 rounded-2xl bg-white border-2 border-[#E5E5E5] flex flex-col gap-0.5">
            <span className="text-[11px] font-extrabold text-[#777777]">
              القاعدة المعتمدة حالياً للجميع
            </span>
            <span className="font-latin text-sm sm:text-base font-black text-[#1899D6] truncate">
              #{activeEntry?.order || 1} — {activeEntry?.config.projectId || activeProjectId}
            </span>
          </div>

          <div className="p-3.5 rounded-2xl bg-white border-2 border-[#E5E5E5] flex flex-col gap-0.5">
            <span className="text-[11px] font-extrabold text-[#777777]">
              إجمالي القواعد المسجلة
            </span>
            <span className="text-sm sm:text-base font-black text-[#3C3C3C]">
              <span className="font-latin text-[#58CC02]">{poolState.databases.length}</span> قواعد مرتبة للتناوب التلقائي
            </span>
          </div>

          <div
            className={`p-3.5 rounded-2xl border-2 flex flex-col gap-0.5 ${
              poolState.allExhausted
                ? 'bg-[#FFDFE0] border-[#FF4B4B]'
                : 'bg-[#D7FFB8]/60 border-[#58CC02]'
            }`}
          >
            <span className="text-[11px] font-extrabold text-[#777777]">حالة التشغيل العام</span>
            <span
              className={`text-sm sm:text-base font-black ${
                poolState.allExhausted ? 'text-[#EA2B2B]' : 'text-[#46A302]'
              }`}
            >
              {poolState.allExhausted
                ? 'وضع الصيانة (جميع القواعد ممتلئة)'
                : 'تعمل بكفاءة والتنقل التلقائي مفعّل'}
            </span>
          </div>
        </div>

        {poolState.allExhausted && (
          <div className="p-4 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[#EA2B2B] text-xs sm:text-sm font-black">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <span>
                جميع القواعد وصلت للحد اليومي والمنصة تعرض للمستخدمين «جاري إصلاح مشاكل البرنامج». أضف قاعدة جديدة أدناه أو أعد تفعيل القواعد لعودة المنصة فوراً!
              </span>
            </div>
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => void handleReactivateDb('ALL')}
              className="duo-btn flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              <span>تصفير الكل وإعادة التشغيل</span>
            </button>
          </div>
        )}
      </div>

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
          <span>قواعد البيانات والنقل ({poolState.databases.length})</span>
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

      {subTab === 'databases' ? (
        <div className="flex flex-col gap-6">
          {/* Migration Progress Banner */}
          {migratingEntryId && migrationProgress && (
            <DuoLoading
              variant="inline"
              title={migrationProgress.message}
              subtitle={
                migrationProgress.detail ||
                'جاري نقل كافة الغرف والاختبارات والملفات وتحديث جميع المستخدمين تلقائياً...'
              }
              percent={migrationProgress.percent}
              accent="blue"
            />
          )}

          {/* Target Project Setup Assistance (Rules / Domain / Auth) */}
          {setupError && (
            <div className="duo-card p-5 bg-[#FFDFE0]/70 border-[#FF4B4B] flex flex-col gap-3">
              <div className="flex items-start gap-2 text-[#EA2B2B] text-sm font-black">
                <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
                <span>{setupError.message}</span>
              </div>
              {setupError.reason === 'firestore_rules' && (
                <div className="bg-white rounded-xl p-3.5 border border-[#FF4B4B]/40 flex flex-col gap-2 text-xs font-bold text-[#3C3C3C]">
                  <p>
                    انسخ قواعد الأمان والصقها في Firebase Console للمشروع{' '}
                    <span className="font-latin font-black">{setupError.projectId}</span> ثم اضغط Publish:
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleCopyRules()}
                      className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#1CB0F6] border-2 border-[#1899D6] border-b-4 text-white text-xs font-black cursor-pointer"
                    >
                      {copiedRules ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedRules ? 'تم نسخ قواعد الأمان' : 'نسخ firestore.rules'}</span>
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
                </div>
              )}
              {setupError.reason === 'unauthorized_domain' && (
                <div className="bg-white rounded-xl p-3.5 border border-[#FF4B4B]/40 flex flex-wrap items-center gap-2 text-xs font-bold text-[#3C3C3C]">
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
                    <span>فتح Authorized domains</span>
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
                    <span>تفعيل Google Sign-In في المشروع</span>
                  </a>
                </div>
              )}
            </div>
          )}

          {/* Ordered Pool Cards */}
          <div className="duo-card p-5 sm:p-6 flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b-2 border-[#F0F0F0]">
              <div>
                <h2 className="text-lg font-black text-[#3C3C3C]">
                  القواعد المرتبة والتنقل التلقائي
                </h2>
                <p className="text-xs font-bold text-[#777777]">
                  عند امتلاء حصة القاعدة الحالية ينتقل الجميع تلقائياً إلى القاعدة التالية في الترتيب، وعند نهاية القائمة يعود من #1، وإذا امتلأت جميعاً تظهر شاشة «جاري إصلاح مشاكل البرنامج».
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs font-bold text-[#3C3C3C] bg-[#F7F7F7] px-3 py-2 rounded-xl border border-[#E5E5E5] cursor-pointer">
                <input
                  type="checkbox"
                  checked={cleanupOldDatabase}
                  onChange={(e) => setCleanupOldDatabase(e.target.checked)}
                  className="accent-[#58CC02] w-4 h-4 cursor-pointer"
                />
                <span>تنظيف السجلات المنقولة من القاعدة السابقة بعد النقل</span>
              </label>
            </div>

            <div className="flex flex-col gap-3">
              {poolState.databases.map((entry, idx) => {
                const isActive = entry.id === poolState.activeDatabaseId && !poolState.allExhausted;
                const isExhausted = entry.exhaustedAt !== null;
                const isMigratingThis = migratingEntryId === entry.id;
                const isDeletingThis = confirmDeleteDbId === entry.id;

                return (
                  <div
                    key={entry.id}
                    className={`rounded-2xl border-2 p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 transition-colors ${
                      isActive
                        ? 'bg-[#D7FFB8]/35 border-[#58CC02]'
                        : isExhausted
                        ? 'bg-[#FFDFE0]/35 border-[#FF4B4B]'
                        : 'bg-white border-[#E5E5E5]'
                    }`}
                  >
                    <div className="flex items-start gap-3.5 min-w-0">
                      <div
                        className={`w-11 h-11 rounded-2xl flex items-center justify-center font-latin font-black text-base shrink-0 border-b-4 ${
                          isActive
                            ? 'bg-[#58CC02] border-[#46A302] text-white'
                            : isExhausted
                            ? 'bg-[#FF4B4B] border-[#EA2B2B] text-white'
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
                              النشطة حالياً
                            </span>
                          )}
                          {isExhausted && (
                            <span className="px-2.5 py-0.5 rounded-lg bg-[#FFDFE0] border border-[#FF4B4B] text-[#EA2B2B] text-[11px] font-black">
                              ممتلئة الحصة (Quota)
                            </span>
                          )}
                          {!isActive && !isExhausted && (
                            <span className="px-2.5 py-0.5 rounded-lg bg-[#F0F9FF] border border-[#BEE8FF] text-[#1899D6] text-[11px] font-black">
                              جاهزة في الترتيب
                            </span>
                          )}
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

                    {/* Actions */}
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {/* Reorder Up/Down */}
                      <button
                        type="button"
                        disabled={idx === 0 || actionBusy || Boolean(migratingEntryId)}
                        onClick={() => void handleMoveOrder(idx, 'up')}
                        className="duo-btn p-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#3C3C3C] disabled:opacity-40 cursor-pointer"
                        title="تحريك للأعلى في الترتيب"
                      >
                        <ArrowUp className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        disabled={
                          idx === poolState.databases.length - 1 ||
                          actionBusy ||
                          Boolean(migratingEntryId)
                        }
                        onClick={() => void handleMoveOrder(idx, 'down')}
                        className="duo-btn p-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#3C3C3C] disabled:opacity-40 cursor-pointer"
                        title="تحريك للأسفل في الترتيب"
                      >
                        <ArrowDown className="w-4 h-4" />
                      </button>

                      {isExhausted && (
                        <button
                          type="button"
                          disabled={actionBusy || Boolean(migratingEntryId)}
                          onClick={() => void handleReactivateDb(entry.id)}
                          className="duo-btn flex items-center gap-1 px-3 py-2 rounded-xl bg-[#FFF4CC] border-2 border-b-4 border-[#FFC800] text-[#9A6B00] text-xs font-black cursor-pointer"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>إعادة تفعيل</span>
                        </button>
                      )}

                      {!isActive && (
                        <>
                          <button
                            type="button"
                            disabled={actionBusy || Boolean(migratingEntryId)}
                            onClick={() => void handleMigrateAndActivate(entry)}
                            className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer disabled:opacity-50"
                          >
                            {isMigratingThis ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <ArrowRightLeft className="w-3.5 h-3.5" />
                            )}
                            <span>نقل وتفعيل للجميع</span>
                          </button>
                          <button
                            type="button"
                            disabled={actionBusy || Boolean(migratingEntryId)}
                            onClick={() => void handleDirectActivateWithoutCopy(entry)}
                            className="duo-btn flex items-center gap-1 px-3 py-2 rounded-xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-b-4 border-[#1899D6] text-white text-xs font-black cursor-pointer disabled:opacity-50"
                            title="تبديل فوري للجميع مع مزامنة الحساب عند الدخول"
                          >
                            <Zap className="w-3.5 h-3.5" />
                            <span>تبديل مباشر</span>
                          </button>
                        </>
                      )}

                      {poolState.databases.length > 1 && (
                        isDeletingThis ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={actionBusy}
                              onClick={() => void handleRemoveDb(entry.id)}
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
                            title="حذف من القائمة"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Add New Database Form */}
          <form onSubmit={handleAddDatabase} className="duo-card p-5 sm:p-6 flex flex-col gap-4">
            <div className="flex items-center gap-2.5 pb-2 border-b-2 border-[#F0F0F0]">
              <div className="w-9 h-9 rounded-xl bg-[#1CB0F6]/15 text-[#1899D6] flex items-center justify-center">
                <Plus className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base sm:text-lg font-black text-[#3C3C3C]">
                  إضافة قاعدة بيانات جديدة للقائمة
                </h2>
                <p className="text-xs font-bold text-[#777777]">
                  أضف أي عدد تريده من مشاريع Firebase بالترتيب لتعمل كاحتياطي وتناوب تلقائي
                </p>
              </div>
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
                placeholder={`مثال: قاعدة #${poolState.databases.length + 1} - حساب الاحتياط`}
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
                onChange={(e) => setConfigInput(e.target.value)}
                disabled={addingDb}
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

            <button
              type="submit"
              disabled={addingDb || !detectedPreview?.ok}
              className="duo-btn flex items-center justify-center gap-2 px-6 py-3.5 rounded-2xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-b-[5px] border-[#1899D6] text-white text-sm sm:text-base font-black cursor-pointer disabled:opacity-50"
            >
              {addingDb ? <Loader2 className="w-5 h-5 animate-spin" /> : <Plus className="w-5 h-5" />}
              <span>إضافة قاعدة البيانات إلى الترتيب</span>
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
                  سيظهر تبويب «مبرمج» فوراً لأي عضو تتم ترقيته عبر اسمه الرباعي أو بريده الإلكتروني في جميع القواعد
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
