import React, { useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  Check,
  CheckCircle2,
  Code2,
  Copy,
  Database,
  ExternalLink,
  Loader2,
  Radio,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import firestoreRulesRaw from '../../firestore.rules?raw';
import {
  activeFirebaseConfig,
  activeProjectId,
  buildCleanPrimaryUrl,
  isSameFirebaseTarget,
} from '../firebase';
import {
  announceViaBackupDatabase,
  MigrationNeedsSetupError,
  publishMigrationCompleteSignal,
  runFirebaseMigration,
  type MigrationProgress,
  type MigrationResult,
} from '../firebaseMigration';
import type {
  PlatformProgrammerState,
  RegisteredDatabaseEntry,
  Room,
  UserProfile,
} from '../types';
import { playDuoSound } from './DuoIcons';
import { DuoLoading } from './DuoLoading';

interface QuickMigrateModalProps {
  open: boolean;
  onClose: () => void;
  firebaseUser: User;
  profile: UserProfile;
  currentRoom: Room;
  isSupervisorInCurrentRoom: boolean;
  poolState: PlatformProgrammerState | null;
  onOpenFullDashboard: () => void;
}

export const QuickMigrateModal: React.FC<QuickMigrateModalProps> = ({
  open,
  onClose,
  firebaseUser,
  profile,
  currentRoom,
  isSupervisorInCurrentRoom,
  poolState,
  onOpenFullDashboard,
}) => {
  const playerDbs = poolState?.playerDatabases ?? [];
  const backupDbs = poolState?.backupDatabases ?? [];

  const availableTargets = playerDbs.filter(
    (d) => !isSameFirebaseTarget(d.config, activeFirebaseConfig)
  );

  const [selectedTargetId, setSelectedTargetId] = useState<string>(
    availableTargets[0]?.id || ''
  );
  const [selectedBackupId, setSelectedBackupId] = useState<string>(
    backupDbs[0]?.id || ''
  );
  const [cleanupOldDatabase, setCleanupOldDatabase] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<MigrationNeedsSetupError | null>(null);
  const [completedResult, setCompletedResult] = useState<MigrationResult | null>(null);
  const [retryingBackup, setRetryingBackup] = useState(false);
  const [copiedRules, setCopiedRules] = useState(false);
  const [copiedDomain, setCopiedDomain] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrorMsg(null);
    setSetupError(null);
    setCompletedResult(null);
    if (!selectedTargetId && availableTargets[0]?.id) {
      setSelectedTargetId(availableTargets[0].id);
    }
    if (!selectedBackupId && backupDbs[0]?.id) {
      setSelectedBackupId(backupDbs[0].id);
    }
  }, [open, availableTargets.length, backupDbs.length]);

  if (!open) return null;

  const targetEntry: RegisteredDatabaseEntry | undefined =
    playerDbs.find((d) => d.id === selectedTargetId) || availableTargets[0];
  const backupEntry: RegisteredDatabaseEntry | undefined =
    backupDbs.find((b) => b.id === selectedBackupId);

  const reloadIntoMigratedRoom = (roomId: string | null) => {
    try {
      sessionStorage.removeItem('duoboard_self_migrated_target');
    } catch {
      // Ignore
    }
    if (roomId) {
      const url = new URL(window.location.href);
      url.searchParams.delete('fb');
      url.searchParams.set('room', roomId);
      window.location.replace(url.toString());
    } else {
      window.location.replace(buildCleanPrimaryUrl());
    }
  };

  const handleStartMidExamMigration = async () => {
    if (!targetEntry) return;
    setErrorMsg(null);
    setSetupError(null);
    setRunning(true);
    setProgress({
      step: 'signing_in',
      percent: 5,
      message: `جاري البدء بنقل الغرفة (${currentRoom.id}) وجميع السوابير والاختبارات...`,
      detail: targetEntry.config.projectId,
    });

    try {
      const res = await runFirebaseMigration({
        targetConfig: targetEntry.config,
        backupEntry: backupEntry || null,
        currentProfile: profile,
        currentRoom,
        isSupervisorInCurrentRoom,
        cleanupOldDatabase,
        onProgress: (p) => setProgress(p),
      });

      setCompletedResult(res);
      playDuoSound('correct');

      if (!res.backupAuthPopupBlocked) {
        window.setTimeout(() => {
          reloadIntoMigratedRoom(res.migratedRoomId || currentRoom.id);
        }, 400);
      }
    } catch (err) {
      playDuoSound('wrong');
      if (err instanceof MigrationNeedsSetupError) {
        setSetupError(err);
        setErrorMsg(err.message);
      } else {
        setErrorMsg(
          err instanceof Error ? err.message : 'تعذر إتمام النقل في منتصف الجلسة.'
        );
      }
    } finally {
      setRunning(false);
    }
  };

  const handleManualBackupAnnounce = async () => {
    if (!completedResult || !backupEntry) return;
    setRetryingBackup(true);
    setErrorMsg(null);
    try {
      const announce = await announceViaBackupDatabase({
        backupConfig: backupEntry.config,
        targetConfig: completedResult.targetConfig,
        migratedRoomId: completedResult.migratedRoomId || currentRoom.id,
        updaterName: profile.fullNameQuad,
      });
      await publishMigrationCompleteSignal({
        targetConfig: completedResult.targetConfig,
        migratedRoomId: completedResult.migratedRoomId || currentRoom.id,
        backupDbId: backupEntry.id,
        backupProjectId: backupEntry.config.projectId,
        fullNameQuad: profile.fullNameQuad,
      });
      if (announce.ok) {
        playDuoSound('correct');
        reloadIntoMigratedRoom(completedResult.migratedRoomId || currentRoom.id);
      } else if (announce.popupBlocked) {
        setErrorMsg('ما زالت النافذة المنبثقة محظورة — اسمح بالنوافذ المنبثقة ثم اضغط مرة أخرى.');
      } else {
        reloadIntoMigratedRoom(completedResult.migratedRoomId || currentRoom.id);
      }
    } finally {
      setRetryingBackup(false);
    }
  };

  const copyTextSafely = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback for sandboxed iframes
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
    if (await copyTextSafely(firestoreRulesRaw)) {
      setCopiedRules(true);
      setTimeout(() => setCopiedRules(false), 2000);
    }
  };

  const handleCopyDomain = async () => {
    if (await copyTextSafely(window.location.hostname)) {
      setCopiedDomain(true);
      setTimeout(() => setCopiedDomain(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#3C3C3C]/65 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="duo-card bg-white w-full max-w-xl p-5 sm:p-6 flex flex-col gap-4 my-auto border-[#A560E8]">
        {/* Modal Header */}
        <div className="flex items-start justify-between gap-3 pb-3 border-b-2 border-[#F0F0F0]">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-[#A560E8] border-b-4 border-[#8938D6] text-white flex items-center justify-center shrink-0">
              <ArrowRightLeft className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-black text-[#3C3C3C]">
                نقل القاعدة أثناء الاختبار
              </h2>
              <p className="text-xs font-bold text-[#777777]">
                الغرفة <span className="font-latin text-[#1899D6]">{currentRoom.id}</span> — الحالية:{' '}
                <span className="font-latin text-[#3C3C3C]">{activeProjectId}</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={running}
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-[#F7F7F7] text-[#777777] hover:text-[#3C3C3C] cursor-pointer disabled:opacity-40"
            title="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Running Progress */}
        {running && progress && (
          <DuoLoading
            variant="inline"
            title={progress.message}
            subtitle={progress.detail || 'جاري نقل الغرفة والسوابير والأسئلة والاختبارات...'}
            percent={progress.percent}
            accent="purple"
          />
        )}

        {/* Popup-Blocked Backup Retry View */}
        {completedResult && completedResult.backupAuthPopupBlocked && backupEntry && (
          <div className="p-4 rounded-2xl bg-[#FFF4CC] border-2 border-[#FFC800] flex flex-col gap-3">
            <div className="flex items-start gap-2.5 text-[#3C3C3C] text-xs sm:text-sm font-black">
              <CheckCircle2 className="w-5 h-5 text-[#58CC02] shrink-0 mt-0.5" />
              <div>
                <p>اكتمل نقل البيانات 100% إلى {completedResult.targetConfig.projectId}!</p>
                <p className="text-xs font-bold text-[#777777] mt-1">
                  حظر المتصفح نافذة تسجيل الدخول للقاعدة الاحتياطية ({backupEntry.config.projectId}). اضغط الآن لتنبيه الطلاب وتجهيز انتقالهم:
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={retryingBackup}
                onClick={() => void handleManualBackupAnnounce()}
                className="duo-btn flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer"
              >
                {retryingBackup ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Radio className="w-4 h-4" />
                )}
                <span>تفعيل إعلان القاعدة الاحتياطية الآن</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  reloadIntoMigratedRoom(completedResult.migratedRoomId || currentRoom.id)
                }
                className="duo-btn px-4 py-2.5 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#3C3C3C] text-xs font-black cursor-pointer"
              >
                الدخول للقاعدة الجديدة مباشرة
              </button>
            </div>
          </div>
        )}

        {/* Success Complete Banner */}
        {completedResult && !completedResult.backupAuthPopupBlocked && (
          <div className="p-4 rounded-2xl bg-[#D7FFB8] border-2 border-[#58CC02] text-[#46A302] text-xs sm:text-sm font-black flex items-center gap-2.5">
            <CheckCircle2 className="w-5 h-5 shrink-0" />
            <span>
              تم نقل الغرفة ({completedResult.migratedQuestionsCount} سؤال،{' '}
              {completedResult.migratedSlidesCount} شريحة) وفتحها على{' '}
              {completedResult.targetConfig.projectId}! جاري التحميل والدخول الآن...
            </span>
          </div>
        )}

        {/* Setup / Auth Error */}
        {errorMsg && (
          <div className="p-3.5 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-[#EA2B2B] text-xs font-black flex flex-col gap-2.5">
            <div className="flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
            {setupError?.reason === 'firestore_rules' && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopyRules()}
                  className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#1CB0F6] border-2 border-b-4 border-[#1899D6] text-white text-xs font-black cursor-pointer"
                >
                  {copiedRules ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedRules ? 'تم نسخ القواعد' : 'نسخ firestore.rules'}</span>
                </button>
                <a
                  href={`https://console.firebase.google.com/project/${setupError.projectId}/firestore/rules`}
                  target="_blank"
                  rel="noreferrer"
                  className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#3C3C3C] text-xs font-black"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>صفحة Rules</span>
                </a>
              </div>
            )}
            {setupError?.reason === 'unauthorized_domain' && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopyDomain()}
                  className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#1CB0F6] border-2 border-b-4 border-[#1899D6] text-white text-xs font-black cursor-pointer"
                >
                  {copiedDomain ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedDomain ? 'تم نسخ النطاق' : 'نسخ النطاق'}</span>
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
          </div>
        )}

        {/* Body Selection */}
        {!completedResult && (
          <>
            {availableTargets.length === 0 ? (
              <div className="p-5 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] text-center flex flex-col items-center gap-3">
                <Database className="w-9 h-9 text-[#1899D6]" />
                <div className="text-sm font-black text-[#3C3C3C]">
                  لا توجد قاعدة بيانات بديلة مضافة حالياً
                </div>
                <p className="text-xs font-bold text-[#777777] leading-relaxed">
                  افتح لوحة المبرمج لإضافة وفحص قاعدة بيانات جديدة (للاعبين) وقاعدة احتياطية صامتة، ثم يمكنك النقل في أي لحظة.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenFullDashboard();
                  }}
                  className="duo-btn flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#A560E8] border-2 border-b-4 border-[#8938D6] text-white text-xs font-black cursor-pointer"
                >
                  <Code2 className="w-4 h-4" />
                  <span>فتح لوحة المبرمج لإضافة قاعدة</span>
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {/* Step 1: Select Target Player DB */}
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-extrabold text-[#3C3C3C]">
                    1. اختر قاعدة البيانات الهدف (للاعبين والاختبار):
                  </span>
                  <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
                    {availableTargets.map((entry) => {
                      const chosen = entry.id === targetEntry?.id;
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          disabled={running}
                          onClick={() => setSelectedTargetId(entry.id)}
                          className={`text-right rounded-2xl border-2 p-3 flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                            chosen
                              ? 'bg-[#D7FFB8]/45 border-[#58CC02]'
                              : 'bg-white border-[#E5E5E5] hover:border-[#1CB0F6]'
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs sm:text-sm font-black text-[#3C3C3C] truncate">
                                #{entry.order} — {entry.label}
                              </span>
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-[#D7FFB8] text-[#46A302] text-[10px] font-black">
                                <ShieldCheck className="w-3 h-3" />
                                مفحوصة 100%
                              </span>
                            </div>
                            <span className="font-latin text-[11px] font-bold text-[#777777]">
                              {entry.config.projectId}
                            </span>
                          </div>
                          <div
                            className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                              chosen ? 'border-[#58CC02] bg-[#58CC02] text-white' : 'border-[#D0D0D0]'
                            }`}
                          >
                            {chosen && <Check className="w-3 h-3" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Step 2: Select Untouched Backup DB for Announcement */}
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-extrabold text-[#3C3C3C]">
                    2. القاعدة الاحتياطية الصامتة (تستيقظ بعد 100% لإعلان القاعدة الجديدة للجميع):
                  </span>
                  {backupDbs.length === 0 ? (
                    <div className="p-3 rounded-xl bg-[#FFF9E6] border border-[#FFC800] text-xs font-bold text-[#9A6B00]">
                      لم تُضف قاعدة احتياطية صامتة بعد — سيتم النقل عبر إشعار الخادم والقاعدة النشطة، ويمكنك إضافة قاعدة احتياطية من لوحة المبرمج.
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {backupDbs.map((b) => {
                        const chosen = b.id === selectedBackupId;
                        return (
                          <button
                            key={b.id}
                            type="button"
                            disabled={running}
                            onClick={() => setSelectedBackupId(b.id)}
                            className={`px-3 py-2 rounded-xl border-2 text-xs font-black flex items-center gap-1.5 cursor-pointer ${
                              chosen
                                ? 'bg-[#F3E8FF] border-[#A560E8] text-[#8938D6]'
                                : 'bg-white border-[#E5E5E5] text-[#777777]'
                            }`}
                          >
                            <Radio className="w-3.5 h-3.5" />
                            <span>{b.label}</span>
                            <span className="font-latin text-[10px]">({b.config.projectId})</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <label className="flex items-center gap-2 text-xs font-bold text-[#3C3C3C] bg-[#F7F7F7] px-3 py-2.5 rounded-xl border border-[#E5E5E5] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cleanupOldDatabase}
                    disabled={running}
                    onChange={(e) => setCleanupOldDatabase(e.target.checked)}
                    className="accent-[#58CC02] w-4 h-4 cursor-pointer"
                  />
                  <span>تنظيف الغرفة والبيانات المنقولة من القاعدة الحالية بعد اكتمال النقل 100%</span>
                </label>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t-2 border-[#F0F0F0]">
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => {
                      onClose();
                      onOpenFullDashboard();
                    }}
                    className="text-xs font-extrabold text-[#8938D6] hover:underline cursor-pointer"
                  >
                    إدارة القواعد الكاملة في لوحة المبرمج
                  </button>

                  <button
                    type="button"
                    disabled={running || !targetEntry}
                    onClick={() => void handleStartMidExamMigration()}
                    className="duo-btn flex items-center gap-2 px-5 py-3 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-[5px] border-[#46A302] text-white text-sm font-black cursor-pointer disabled:opacity-50"
                  >
                    {running ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <ArrowRightLeft className="w-4 h-4" />
                    )}
                    <span>بدء النقل وتحديث الجميع الآن</span>
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
