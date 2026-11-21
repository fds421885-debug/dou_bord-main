import React, { useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Code2,
  Copy,
  Database,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react';
import firestoreRulesRaw from '../../firestore.rules?raw';
import { firebaseTargetKey } from '../firebase';
import {
  RULES_UPDATE_CHANGES_AR,
  type DatabaseRulesCheckResult,
} from '../firebaseMigration';
import { playDuoSound } from './DuoIcons';

interface RulesCheckModalProps {
  open: boolean;
  checking: boolean;
  signingInKey: string | null;
  results: DatabaseRulesCheckResult[];
  onClose: () => void;
  onRecheckAll: () => void;
  onVerifyWithSignIn: (targetKey: string) => void;
}

const ROLE_LABELS: Record<DatabaseRulesCheckResult['role'], string> = {
  active: 'النشطة حالياً',
  player: 'قاعدة لاعبين',
  backup: 'احتياطية',
};

export const RulesCheckModal: React.FC<RulesCheckModalProps> = ({
  open,
  checking,
  signingInKey,
  results,
  onClose,
  onRecheckAll,
  onVerifyWithSignIn,
}) => {
  const [copiedRules, setCopiedRules] = useState(false);
  const [showRawRules, setShowRawRules] = useState(false);

  if (!open) return null;

  const outdatedList = results.filter((r) => r.status === 'outdated');
  const needsAuthList = results.filter((r) => r.status === 'needs_auth');
  const okList = results.filter((r) => r.status === 'ok');
  const allVerifiedHealthy =
    results.length > 0 && outdatedList.length === 0 && !checking;

  const handleCopyRules = async () => {
    try {
      await navigator.clipboard.writeText(firestoreRulesRaw);
      setCopiedRules(true);
      playDuoSound('pop');
      window.setTimeout(() => setCopiedRules(false), 2400);
    } catch {
      setShowRawRules(true);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/65 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5"
      dir="rtl"
    >
      <div className="duo-card max-w-3xl w-full bg-white border-2 border-[#E5E5E5] rounded-3xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden">
        {/* Header */}
        <div
          className={`p-4 sm:p-5 border-b-2 flex items-start justify-between gap-3 ${
            outdatedList.length > 0
              ? 'bg-[#FFF5F5] border-[#FF4B4B]/40'
              : 'bg-[#F4FFE8] border-[#58CC02]/40'
          }`}
        >
          <div className="flex items-start gap-3">
            <div
              className={`w-11 h-11 rounded-2xl border-b-4 flex items-center justify-center shrink-0 text-white ${
                outdatedList.length > 0
                  ? 'bg-[#FF4B4B] border-[#EA2B2B]'
                  : 'bg-[#58CC02] border-[#46A302]'
              }`}
            >
              {checking ? (
                <Loader2 className="w-6 h-6 animate-spin" />
              ) : outdatedList.length > 0 ? (
                <ShieldAlert className="w-6 h-6" />
              ) : (
                <ShieldCheck className="w-6 h-6" />
              )}
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-black text-[#3C3C3C]">
                {checking
                  ? 'جاري الفحص الفعلي الشامل لقواعد الأمان (firestore.rules)...'
                  : outdatedList.length > 0
                  ? `تنبيه للمبرمج: ${outdatedList.length} ${
                      outdatedList.length === 1 ? 'قاعدة بيانات تحتاج' : 'قواعد بيانات تحتاج'
                    } إلى تحديث الرولز`
                  : 'جميع قواعد البيانات المختبرة سليمة 100% ✓'}
              </h2>
              <p className="text-xs font-bold text-[#666666] mt-0.5">
                {outdatedList.length > 0
                  ? 'أجرينا فحصاً عملياً فعلياً ضد Firebase؛ القواعد التالية ترفض بعض المزايا الجديدة أو لم تُحدَّث بعد. انسخ الرولز وألصقها ثم اضغط «تحقق فعلياً الآن».'
                  : 'تم اجتياز جميع اختبارات الأمان والصلاحيات الفعلية (الحماية من Test Mode، الأسئلة المميزة ⭐، اختبارات التقوية، و+100 سؤال).'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-black/5 text-[#777777] cursor-pointer shrink-0"
            title="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-4 sm:p-5 overflow-y-auto flex flex-col gap-4">
          {/* Summary Pills */}
          <div className="flex flex-wrap items-center gap-2 text-xs font-black">
            <span className="px-3 py-1.5 rounded-xl bg-[#F7F7F7] border border-[#E5E5E5] text-[#3C3C3C]">
              إجمالي القواعد: {results.length}
            </span>
            {outdatedList.length > 0 && (
              <span className="px-3 py-1.5 rounded-xl bg-[#FFDFE0] border border-[#FF4B4B] text-[#EA2B2B]">
                تحتاج إصلاح: {outdatedList.length}
              </span>
            )}
            <span className="px-3 py-1.5 rounded-xl bg-[#D7FFB8] border border-[#58CC02] text-[#46A302]">
              سليمة 100%: {okList.length}
            </span>
            {needsAuthList.length > 0 && (
              <span className="px-3 py-1.5 rounded-xl bg-[#FFF4CC] border border-[#FFC800] text-[#8A6500]">
                بانتظار دخول للفحص: {needsAuthList.length}
              </span>
            )}
          </div>

          {/* List of Checked Databases */}
          <div className="flex flex-col gap-3">
            {results.map((dbItem) => {
              const targetKey = firebaseTargetKey(dbItem.config);
              const isOutdated = dbItem.status === 'outdated';
              const isOk = dbItem.status === 'ok';
              const isNeedsAuth = dbItem.status === 'needs_auth';
              const isSigning = signingInKey === targetKey;

              return (
                <div
                  key={targetKey}
                  className={`rounded-2xl border-2 p-3.5 sm:p-4 flex flex-col gap-2.5 ${
                    isOutdated
                      ? 'bg-[#FFF5F5] border-[#FF4B4B]'
                      : isOk
                      ? 'bg-[#F6FFF0] border-[#58CC02]/60'
                      : isNeedsAuth
                      ? 'bg-[#FFFBF0] border-[#FFC800]'
                      : 'bg-[#F8FAFC] border-[#E5E5E5]'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <Database
                        className={`w-5 h-5 shrink-0 mt-0.5 ${
                          isOutdated
                            ? 'text-[#EA2B2B]'
                            : isOk
                            ? 'text-[#46A302]'
                            : 'text-[#8A6500]'
                        }`}
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-black text-[#3C3C3C]">
                            {dbItem.label}
                          </span>
                          <span className="px-2 py-0.5 rounded-lg bg-white border border-[#E5E5E5] text-[10px] font-black text-[#555555]">
                            {ROLE_LABELS[dbItem.role]}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-lg text-[10px] font-black border ${
                              isOutdated
                                ? 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B]'
                                : isOk
                                ? 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                                : 'bg-[#FFF4CC] border-[#FFC800] text-[#8A6500]'
                            }`}
                          >
                            {isOutdated
                              ? '⚠️ تحتاج إصلاح القواعد'
                              : isOk
                              ? 'سليمة 100% ✓'
                              : isNeedsAuth
                              ? 'تحتاج تسجيل دخول للفحص'
                              : 'تعذر الوصول مؤقتاً'}
                          </span>
                        </div>
                        <div className="text-[11px] font-bold text-[#666666] font-latin mt-0.5 break-all">
                          {dbItem.projectId} · DB: {dbItem.firestoreDatabaseId}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {isNeedsAuth ? (
                        <button
                          type="button"
                          disabled={checking || isSigning}
                          onClick={() => onVerifyWithSignIn(targetKey)}
                          className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#FFC800] border-2 border-b-4 border-[#E5A900] text-[#3C3C3C] text-xs font-black cursor-pointer disabled:opacity-60"
                        >
                          {isSigning ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                          <span>تسجيل دخول وفحص فعلي</span>
                        </button>
                      ) : (
                        <a
                          href={dbItem.consoleUrl}
                          target="_blank"
                          rel="noreferrer"
                          className={`duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl border-2 border-b-4 text-xs font-black ${
                            isOutdated
                              ? 'bg-[#FF4B4B] border-[#EA2B2B] text-white'
                              : 'bg-white border-[#E5E5E5] hover:border-[#1CB0F6] text-[#3C3C3C]'
                          }`}
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>فتح Rules في Firebase Console</span>
                        </a>
                      )}
                    </div>
                  </div>

                  {dbItem.reason && !isOk && (
                    <div className="text-xs font-extrabold text-[#B91C1C] bg-white/80 rounded-xl px-3 py-2 border border-[#FF4B4B]/30">
                      {dbItem.reason}
                    </div>
                  )}

                  {dbItem.checks.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 pt-1">
                      {dbItem.checks.map((chk) => (
                        <div
                          key={chk.id}
                          className={`flex items-start gap-2 px-2.5 py-1.5 rounded-xl border text-[11px] font-bold ${
                            chk.passed
                              ? 'bg-white/90 border-[#58CC02]/40 text-[#2E7D00]'
                              : 'bg-[#FFDFE0]/70 border-[#FF4B4B]/60 text-[#B91C1C]'
                          }`}
                        >
                          {chk.passed ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-[#58CC02] shrink-0 mt-0.5" />
                          ) : (
                            <XCircle className="w-3.5 h-3.5 text-[#EA2B2B] shrink-0 mt-0.5" />
                          )}
                          <div>
                            <div className="font-black">{chk.label}</div>
                            {chk.detail && (
                              <div className="text-[10px] opacity-85">{chk.detail}</div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Copy Rules & Fix Instructions */}
          <div className="rounded-2xl border-2 border-[#1CB0F6]/50 bg-[#F0FAFF] p-3.5 sm:p-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-black text-[#0C6899]">
                <Code2 className="w-4 h-4" />
                <span>قواعد الأمان الرسمية المحدّثة (firestore.rules)</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopyRules()}
                  className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-b-4 border-[#1899D6] text-white text-xs font-black cursor-pointer"
                >
                  {copiedRules ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  <span>
                    {copiedRules ? 'تم نسخ القواعد بالكامل ✓' : 'نسخ firestore.rules المحدّثة'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowRawRules((v) => !v)}
                  className="px-3 py-2 rounded-xl bg-white border border-[#E5E5E5] text-[11px] font-black text-[#3C3C3C] cursor-pointer"
                >
                  {showRawRules ? 'إخفاء نص القواعد' : 'عرض نص القواعد'}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-[11px] font-bold text-[#444]">
              <div className="p-2.5 rounded-xl bg-white border border-[#E5E5E5]">
                <div className="font-black text-[#3C3C3C] mb-1">خطوات الإصلاح السريعة:</div>
                <ol className="list-decimal pr-4 flex flex-col gap-1 leading-relaxed">
                  <li>اضغط «نسخ firestore.rules المحدّثة» بالأعلى.</li>
                  <li>افتح رابط «فتح Rules في Firebase Console» للقاعدة الحمراء أعلاه.</li>
                  <li>احذف كل النص القديم في المحرر، ثم ألصق القواعد الجديدة واضغط <strong>Publish</strong>.</li>
                  <li>عد هنا واضغط <strong>«تحقق فعلياً الآن»</strong> بالأسفل لتأكيد عمل النظام 100%.</li>
                </ol>
              </div>
              <div className="p-2.5 rounded-xl bg-white border border-[#E5E5E5]">
                <div className="font-black text-[#3C3C3C] mb-1">ما الذي يتحقق منه النظام فعلياً؟</div>
                <ul className="list-disc pr-4 flex flex-col gap-1 leading-relaxed">
                  {RULES_UPDATE_CHANGES_AR.slice(0, 4).map((txt, idx) => (
                    <li key={idx}>{txt}</li>
                  ))}
                </ul>
              </div>
            </div>

            {showRawRules && (
              <pre
                dir="ltr"
                className="max-h-56 overflow-auto rounded-xl bg-[#1E293B] text-[#E2E8F0] p-3 text-[10px] font-latin leading-relaxed select-all"
              >
                {firestoreRulesRaw}
              </pre>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t-2 border-[#F0F0F0] bg-[#FAFAFA] flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-bold text-[#777777] flex items-center gap-1.5">
            {allVerifiedHealthy ? (
              <>
                <CheckCircle2 className="w-4 h-4 text-[#58CC02]" />
                <span className="text-[#46A302] font-black">
                  النظام يعمل الآن 100% على جميع القواعد المختبرة!
                </span>
              </>
            ) : (
              <>
                <AlertTriangle className="w-4 h-4 text-[#FFC800]" />
                <span>يتم اختبار القواعد فعلياً بعمليات حقيقية ضد Firestore ثم تنظيفها فوراً.</span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={checking}
              onClick={onRecheckAll}
              className="duo-btn flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-xs sm:text-sm font-black cursor-pointer disabled:opacity-60"
            >
              {checking ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              <span>
                {checking ? 'جاري التحقق الفعلي...' : 'تحقق فعلياً الآن (فحص 100%)'}
              </span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-2xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#555555] hover:bg-[#F7F7F7] cursor-pointer"
            >
              {allVerifiedHealthy ? 'إغلاق والمتابعة ✓' : 'لاحقاً'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
