import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRightLeft,
  Check,
  CheckCircle2,
  Copy,
  Database,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  Share2,
  ShieldAlert,
  X,
} from 'lucide-react';
import firestoreRulesRaw from '../../firestore.rules?raw';
import {
  activeProjectId,
  defaultFirebaseConfig,
  isCustomFirebaseConfig,
  resetToDefaultFirebaseConfig,
} from '../firebase';
import {
  MigrationNeedsSetupError,
  parseFirebaseConfigSnippet,
  runFirebaseMigration,
  type MigrationProgress,
  type MigrationResult,
} from '../firebaseMigration';
import type { Room, UserProfile } from '../types';
import { playDuoSound } from './DuoIcons';

interface DatabaseMigrationModalProps {
  open: boolean;
  quotaTriggered: boolean;
  currentProfile: UserProfile | null;
  currentRoom: Room | null;
  isSupervisorInCurrentRoom: boolean;
  onClose: () => void;
}

export const DatabaseMigrationModal: React.FC<DatabaseMigrationModalProps> = ({
  open,
  quotaTriggered,
  currentProfile,
  currentRoom,
  isSupervisorInCurrentRoom,
  onClose,
}) => {
  const [configInput, setConfigInput] = useState('');
  const [showAdvancedDb, setShowAdvancedDb] = useState(false);
  const [customDatabaseId, setCustomDatabaseId] = useState('');
  const [migrating, setMigrating] = useState(false);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<MigrationNeedsSetupError | null>(null);
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [copiedRules, setCopiedRules] = useState(false);
  const [copiedShareUrl, setCopiedShareUrl] = useState(false);
  const [copiedDomain, setCopiedDomain] = useState(false);

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

  if (!open) return null;

  const handleStartMigration = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setErrorMsg(null);
    setSetupError(null);

    let parsedConfig;
    try {
      parsedConfig = parseFirebaseConfigSnippet(
        configInput,
        showAdvancedDb ? customDatabaseId : undefined
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'تعذر قراءة إعدادات Firebase.'
      );
      return;
    }

    setMigrating(true);
    setProgress({
      step: 'parsing',
      message: 'جاري التحقق من إعدادات قاعدة البيانات الجديدة...',
    });

    try {
      const res = await runFirebaseMigration({
        targetConfig: parsedConfig,
        currentProfile,
        currentRoom,
        isSupervisorInCurrentRoom,
        onProgress: (p) => setProgress(p),
      });
      setResult(res);
      playDuoSound('correct');
    } catch (err) {
      if (err instanceof MigrationNeedsSetupError) {
        setSetupError(err);
        setErrorMsg(err.message);
      } else {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : 'حدث خطأ أثناء نقل البيانات إلى قاعدة البيانات الجديدة.'
        );
      }
      playDuoSound('wrong');
    } finally {
      setMigrating(false);
    }
  };

  const handleCopyRules = async () => {
    try {
      await navigator.clipboard.writeText(firestoreRulesRaw);
      setCopiedRules(true);
      playDuoSound('pop');
      setTimeout(() => setCopiedRules(false), 2000);
    } catch {
      // Ignore clipboard error
    }
  };

  const handleCopyDomain = async () => {
    try {
      await navigator.clipboard.writeText(window.location.hostname);
      setCopiedDomain(true);
      playDuoSound('pop');
      setTimeout(() => setCopiedDomain(false), 2000);
    } catch {
      // Ignore clipboard error
    }
  };

  const handleCopyShareUrl = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.shareUrl);
      setCopiedShareUrl(true);
      playDuoSound('pop');
      setTimeout(() => setCopiedShareUrl(false), 2000);
    } catch {
      // Ignore clipboard error
    }
  };

  const handleActivateAndReload = () => {
    if (result?.migratedRoomId) {
      const url = new URL(window.location.href);
      url.searchParams.delete('fb');
      url.searchParams.set('room', result.migratedRoomId);
      window.location.href = url.toString();
      return;
    }
    window.location.reload();
  };

  const handleResetToDefault = () => {
    resetToDefaultFirebaseConfig();
    window.location.reload();
  };

  return (
    <div
      className="fixed inset-0 z-[80] bg-black/70 flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
      onClick={() => {
        if (!migrating) onClose();
      }}
    >
      <div
        className="duo-card max-w-2xl w-full p-5 sm:p-7 flex flex-col gap-5 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 pb-4 border-b-2 border-[#F0F0F0]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-12 h-12 rounded-2xl bg-[#1CB0F6]/15 text-[#1899D6] flex items-center justify-center shrink-0">
              <Database className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg sm:text-xl font-black text-[#3C3C3C]">
                نقل واستكمال العمل على قاعدة بيانات أخرى
              </h2>
              <p className="text-xs font-bold text-[#777777] truncate">
                القاعدة الحالية:{' '}
                <span className="font-latin font-black text-[#1899D6]">
                  {activeProjectId}
                </span>
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={migrating}
            onClick={onClose}
            className="p-2 rounded-xl bg-[#F7F7F7] hover:bg-[#FFDFE0] text-[#777777] hover:text-[#EA2B2B] cursor-pointer disabled:opacity-40 shrink-0"
            title="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Quota Notice Banner */}
        {quotaTriggered && !result && (
          <div className="p-3.5 rounded-2xl bg-[#FFF4CC] border-2 border-[#FFC800] text-[#3C3C3C] text-xs sm:text-sm font-bold flex items-start gap-2.5">
            <AlertCircle className="w-5 h-5 text-[#E5A400] shrink-0 mt-0.5" />
            <span>
              وصلت قاعدة البيانات الحالية إلى الحد اليومي المجاني (Quota exceeded). الصق إعدادات مشروع Firebase آخر ليتم نقل بياناتك والغرفة النشطة تلقائياً وتكملوا جميعاً من حيث توقفتم!
            </span>
          </div>
        )}

        {result ? (
          /* Success Screen */
          <div className="flex flex-col gap-4">
            <div className="p-5 rounded-2xl bg-[#D7FFB8]/60 border-2 border-[#58CC02] flex flex-col gap-3">
              <div className="flex items-center gap-2.5 text-[#46A302]">
                <CheckCircle2 className="w-7 h-7 shrink-0" />
                <div>
                  <h3 className="text-lg font-black">
                    تم النقل وتفعيل القاعدة الجديدة بنجاح!
                  </h3>
                  <p className="text-xs font-bold">
                    المشروع الجديد:{' '}
                    <span className="font-latin font-black">
                      {result.targetConfig.projectId}
                    </span>
                  </p>
                </div>
              </div>

              <ul className="text-xs sm:text-sm font-bold text-[#3C3C3C] grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                <li className="px-3 py-2 rounded-xl bg-white/90 border border-[#58CC02]/40">
                  ✅ تم نقل بيانات حسابك واسمك الرباعي
                </li>
                <li className="px-3 py-2 rounded-xl bg-white/90 border border-[#58CC02]/40">
                  📚 الاختبارات المحفوظة المنقولة:{' '}
                  <span className="font-latin font-black">
                    {result.migratedSavedTestsCount}
                  </span>
                </li>
                {result.migratedRoomId && (
                  <li className="px-3 py-2 rounded-xl bg-white/90 border border-[#58CC02]/40 sm:col-span-2">
                    {result.roomCreatedAsSupervisor ? (
                      <>
                        🏫 تم نقل الغرفة{' '}
                        <span className="font-latin font-black text-[#1899D6]">
                          {result.migratedRoomId}
                        </span>{' '}
                        ({result.migratedQuestionsCount} سؤال ·{' '}
                        {result.migratedSlidesCount} شريحة)
                      </>
                    ) : result.roomRejoinedAsStudent ? (
                      <>
                        🎓 تم ربطك مجدداً بالغرفة{' '}
                        <span className="font-latin font-black text-[#1899D6]">
                          {result.migratedRoomId}
                        </span>{' '}
                        واسترجاع سبورتك
                      </>
                    ) : (
                      <>
                        ⏳ الغرفة{' '}
                        <span className="font-latin font-black text-[#1899D6]">
                          {result.migratedRoomId}
                        </span>{' '}
                        بانتظار دخول المشرف لإتمام نقلها
                      </>
                    )}
                  </li>
                )}
              </ul>
            </div>

            {/* Share URL so all students/participants switch instantly */}
            <div className="p-4 rounded-2xl bg-[#F0F9FF] border-2 border-[#1CB0F6] flex flex-col gap-3">
              <div className="flex items-center gap-2 text-[#1899D6]">
                <Share2 className="w-5 h-5 shrink-0" />
                <h4 className="text-sm sm:text-base font-black">
                  رابط التحويل الفوري للجميع (أرسله للطلاب)
                </h4>
              </div>
              <p className="text-xs font-bold text-[#3C3C3C] leading-relaxed">
                بمجرد أن يفتح أي طالب أو مشرف هذا الرابط، سيتعرف التطبيق تلقائياً على قاعدة البيانات الجديدة ويدخلهم مباشرة في نفس الغرفة ليكمل الجميع من حيث توقفوا بالضبط!
              </p>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <input
                  type="text"
                  readOnly
                  dir="ltr"
                  value={result.shareUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 px-3 py-2.5 rounded-xl bg-white border-2 border-[#BEE8FF] font-latin text-xs font-bold text-[#3C3C3C] outline-none"
                />
                <button
                  type="button"
                  onClick={handleCopyShareUrl}
                  className="duo-btn flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-[#1899D6] border-b-4 text-white text-xs sm:text-sm font-black cursor-pointer whitespace-nowrap"
                >
                  {copiedShareUrl ? (
                    <>
                      <Check className="w-4 h-4" />
                      <span>تم نسخ الرابط</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      <span>نسخ رابط الدخول للجميع</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={handleActivateAndReload}
              className="duo-btn w-full flex items-center justify-center gap-2.5 px-6 py-4 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-[#46A302] border-b-[5px] text-white text-base sm:text-lg font-black cursor-pointer"
            >
              <ArrowRightLeft className="w-5 h-5" />
              <span>فتح الموقع الآن والمتابعة من حيث توقفت</span>
            </button>
          </div>
        ) : (
          /* Input & Migration Form */
          <form onSubmit={handleStartMigration} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label
                htmlFor="firebase-snippet-input"
                className="text-sm font-black text-[#3C3C3C]"
              >
                الصق كود إعدادات Firebase الجديد (أو رابط التحويل)
              </label>
              <p className="text-xs font-bold text-[#777777]">
                انسخ الكود كاملاً من إعدادات مشروعك في Firebase (من{' '}
                <span className="font-latin">const firebaseConfig = &#123; ... &#125;</span>{' '}
                إلى نهاية الكود) والصقه هنا:
              </p>
              <textarea
                id="firebase-snippet-input"
                dir="ltr"
                rows={7}
                value={configInput}
                onChange={(e) => setConfigInput(e.target.value)}
                disabled={migrating}
                placeholder={`const firebaseConfig = {\n  apiKey: "...",\n  authDomain: "your-project.firebaseapp.com",\n  projectId: "your-project",\n  storageBucket: "your-project.firebasestorage.app",\n  messagingSenderId: "...",\n  appId: "..."\n};`}
                className="w-full p-3.5 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#1CB0F6] focus:bg-white outline-none font-latin text-xs leading-relaxed text-[#3C3C3C] transition-colors"
              />
            </div>

            {/* Live Config Recognition Preview */}
            {detectedPreview && (
              <div
                className={`p-3 rounded-xl border-2 text-xs font-bold flex items-center justify-between gap-2 ${
                  detectedPreview.ok
                    ? 'bg-[#D7FFB8]/50 border-[#58CC02] text-[#46A302]'
                    : 'bg-[#FFDFE0]/70 border-[#FF4B4B] text-[#EA2B2B]'
                }`}
              >
                {detectedPreview.ok ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>تم التعرف على المشروع:</span>
                    <span className="font-latin font-black bg-white px-2 py-0.5 rounded-lg border border-[#58CC02]/40">
                      {detectedPreview.config.projectId}
                    </span>
                    <span className="text-[#777777]">
                      · قاعدة البيانات:{' '}
                      <span className="font-latin">
                        {detectedPreview.config.firestoreDatabaseId || '(default)'}
                      </span>
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{detectedPreview.message}</span>
                  </div>
                )}
              </div>
            )}

            {/* Optional Custom Database ID */}
            <div>
              <button
                type="button"
                onClick={() => setShowAdvancedDb((v) => !v)}
                className="text-xs font-extrabold text-[#1899D6] hover:underline cursor-pointer"
              >
                {showAdvancedDb
                  ? 'إخفاء خيار اسم قاعدة البيانات المخصصة'
                  : 'خيار متقدم: تحديد معرّف قاعدة بيانات Firestore مخصّص (إن وجد)'}
              </button>
              {showAdvancedDb && (
                <div className="mt-2 flex flex-col gap-1">
                  <input
                    type="text"
                    dir="ltr"
                    value={customDatabaseId}
                    onChange={(e) => setCustomDatabaseId(e.target.value)}
                    placeholder="(default)"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#1CB0F6] outline-none font-latin text-xs font-bold text-[#3C3C3C]"
                  />
                  <span className="text-[11px] font-bold text-[#777777]">
                    اتركه فارغاً للمشاريع العادية في Firebase Console التي تستخدم (default).
                  </span>
                </div>
              )}
            </div>

            {/* Live Migration Progress */}
            {migrating && progress && (
              <div className="p-3.5 rounded-2xl bg-[#F0F9FF] border-2 border-[#1CB0F6] flex items-center gap-3 text-sm font-black text-[#1899D6]">
                <Loader2 className="w-5 h-5 animate-spin shrink-0" />
                <span>{progress.message}</span>
              </div>
            )}

            {/* Setup Assistance when Target Project needs Rules or Google Auth */}
            {setupError && (
              <div className="p-4 rounded-2xl bg-[#FFDFE0]/70 border-2 border-[#FF4B4B] flex flex-col gap-3">
                <div className="flex items-start gap-2 text-[#EA2B2B] text-xs sm:text-sm font-black">
                  <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
                  <span>{setupError.message}</span>
                </div>

                {setupError.reason === 'firestore_rules' && (
                  <div className="bg-white rounded-xl p-3 border border-[#FF4B4B]/40 flex flex-col gap-2.5 text-xs font-bold text-[#3C3C3C]">
                    <p>
                      خطوة سريعة (مرة واحدة فقط في المشروع الجديد{' '}
                      <span className="font-latin font-black">{setupError.projectId}</span>
                      ):
                    </p>
                    <ol className="list-decimal list-inside space-y-1 text-[#777777]">
                      <li>انسخ قواعد الحماية الخاصة بالتطبيق بالزر أدناه.</li>
                      <li>افتح صفحة Rules في Firebase والصقها ثم اضغط Publish.</li>
                      <li>عد هنا واضغط زر إعادة المحاولة لاستكمال النقل فوراً.</li>
                    </ol>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={handleCopyRules}
                        className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#1CB0F6] border-2 border-[#1899D6] border-b-4 text-white text-xs font-black cursor-pointer"
                      >
                        {copiedRules ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copiedRules ? 'تم نسخ قواعد الأمان' : 'نسخ قواعد الأمان (firestore.rules)'}</span>
                      </button>
                      <a
                        href={`https://console.firebase.google.com/project/${setupError.projectId}/firestore/rules`}
                        target="_blank"
                        rel="noreferrer"
                        className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#3C3C3C] text-xs font-black"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>فتح Rules في Firebase</span>
                      </a>
                    </div>
                  </div>
                )}

                {setupError.reason === 'unauthorized_domain' && (
                  <div className="bg-white rounded-xl p-3 border border-[#FF4B4B]/40 flex flex-wrap items-center gap-2 text-xs font-bold text-[#3C3C3C]">
                    <span className="font-latin bg-[#F7F7F7] px-2 py-1 rounded-lg border border-[#E5E5E5]">
                      {window.location.hostname}
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyDomain}
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
                  <div className="bg-white rounded-xl p-3 border border-[#FF4B4B]/40 flex flex-wrap items-center gap-2 text-xs font-bold text-[#3C3C3C]">
                    <a
                      href={`https://console.firebase.google.com/project/${setupError.projectId}/authentication/providers`}
                      target="_blank"
                      rel="noreferrer"
                      className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#1CB0F6] border-2 border-[#1899D6] border-b-4 text-white text-xs font-black"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>تفعيل Google Sign-In في المشروع الجديد</span>
                    </a>
                  </div>
                )}
              </div>
            )}

            {/* Generic Error */}
            {errorMsg && !setupError && (
              <div className="p-3.5 rounded-xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-[#EA2B2B] text-xs sm:text-sm font-bold flex items-start gap-2">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 pt-1">
              <button
                type="submit"
                disabled={migrating || !detectedPreview?.ok}
                className="duo-btn flex-1 flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-[#46A302] border-b-[5px] text-white text-base font-black cursor-pointer disabled:opacity-50"
              >
                {migrating ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>جاري النقل...</span>
                  </>
                ) : setupError ? (
                  <>
                    <RefreshCw className="w-5 h-5" />
                    <span>إعادة محاولة النقل الآن</span>
                  </>
                ) : (
                  <>
                    <ArrowRightLeft className="w-5 h-5" />
                    <span>تسجيل الدخول ونقل البيانات والغرفة</span>
                  </>
                )}
              </button>

              {isCustomFirebaseConfig && (
                <button
                  type="button"
                  disabled={migrating}
                  onClick={handleResetToDefault}
                  className="duo-btn flex items-center justify-center gap-1.5 px-4 py-3.5 rounded-2xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs sm:text-sm font-black text-[#777777] hover:text-[#3C3C3C] cursor-pointer"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>العودة للقاعدة الأساسية ({defaultFirebaseConfig.projectId})</span>
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
