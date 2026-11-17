import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  FileJson,
  FolderUp,
  ListChecks,
  Loader2,
  Plus,
  RefreshCw,
  Share2,
  X,
} from 'lucide-react';
import {
  cleanQuestions,
  createMyQuiz,
  EXAMPLE_JSON,
  IMPORT_PROMPT,
  LIMITS,
  parseQuizJson,
  validateForSave,
} from '../myQuizzes';
import {
  publishQuizToRoom,
  syncUserQuizzesToRoom,
  useMyQuizzes,
  useRoomSharedQuizzes,
} from '../roomQuizzes';
import type { UserProfile } from '../types';
import { playDuoSound } from './DuoIcons';

interface RoomQuizSyncProps {
  roomId: string;
  profile: UserProfile;
  isSupervisor: boolean;
  /** في الوضع المختصر يظهر كبطاقة صغيرة لطالب/مشرف لمشاركة أو استيراد اختبارات داخل الغرفة */
  compact?: boolean;
  onImportedQuizPoolId?: (sharedDocId: string) => void;
}

export const RoomQuizSyncBanner: React.FC<RoomQuizSyncProps> = ({
  roomId,
  profile,
  isSupervisor,
  compact = false,
  onImportedQuizPoolId,
}) => {
  const { myQuizzes, loading: myLoading } = useMyQuizzes(profile.uid);
  const { sharedQuizzes } = useRoomSharedQuizzes(roomId);
  const [syncing, setSyncing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const syncedSignatureRef = useRef<string>('');

  // مزامنة تلقائية لاختبارات المستخدم داخل الغرفة حتى يتمكن المشرف أو المنافسة من استخدامها
  useEffect(() => {
    if (myLoading || !roomId || !profile.uid || myQuizzes.length === 0) return;

    const sig = myQuizzes
      .map((q) => `${q.id}:${q.title}:${q.questionCount}:${q.questions?.length ?? 0}`)
      .join('|');
    if (syncedSignatureRef.current === sig) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (cancelled) return;
      setSyncing(true);
      try {
        await syncUserQuizzesToRoom({
          roomId,
          authorId: profile.uid,
          authorName: profile.fullNameQuad,
          authorRole: isSupervisor ? 'supervisor' : 'student',
          myQuizzes,
          existingShared: sharedQuizzes,
        });
        syncedSignatureRef.current = sig;
      } catch {
        // Ignored; user can retry manually
      } finally {
        if (!cancelled) setSyncing(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [myLoading, roomId, profile.uid, profile.fullNameQuad, isSupervisor, myQuizzes, sharedQuizzes]);

  const handleManualSync = async () => {
    if (syncing || myQuizzes.length === 0) return;
    setSyncing(true);
    try {
      await syncUserQuizzesToRoom({
        roomId,
        authorId: profile.uid,
        authorName: profile.fullNameQuad,
        authorRole: isSupervisor ? 'supervisor' : 'student',
        myQuizzes,
        existingShared: sharedQuizzes,
      });
      playDuoSound('pop');
    } finally {
      setSyncing(false);
    }
  };

  const mySharedCount = sharedQuizzes.filter((s) => s.authorId === profile.uid).length;
  const othersSharedCount = sharedQuizzes.filter((s) => s.authorId !== profile.uid).length;

  return (
    <>
      <div
        className={`rounded-2xl border-2 border-[#E5E5E5] bg-[#F7F7F7] ${
          compact ? 'p-3' : 'p-4'
        } flex flex-wrap items-center justify-between gap-2.5`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-[#F3E8FF] border-2 border-[#CE82FF] text-[#8938D6] flex items-center justify-center shrink-0">
            <ListChecks className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <p className="text-xs sm:text-sm font-black text-[#3C3C3C]">
              بنك اختبارات الغرفة ({sharedQuizzes.length} نموذج متاح)
            </p>
            <p className="text-[11px] font-bold text-[#777777] truncate">
              {syncing
                ? 'جاري مشاركة اختباراتك تلقائياً مع الغرفة...'
                : myQuizzes.length > 0
                ? `تمت مشاركة ${mySharedCount} من اختباراتك · ومن الآخرين: ${othersSharedCount}`
                : 'يمكنك استيراد اختبار JSON مباشرة الآن لاستخدامه في هذه الجلسة'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {myQuizzes.length > 0 && (
            <button
              type="button"
              disabled={syncing}
              onClick={() => void handleManualSync()}
              className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] hover:border-[#1CB0F6] text-xs font-black text-[#1899D6] cursor-pointer disabled:opacity-60"
            >
              {syncing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              <span>مزامنة اختباراتي</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="duo-btn flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[#A560E8] hover:bg-[#B478EE] border-2 border-b-3 border-[#8938D6] text-white text-xs font-black cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>استيراد اختبار JSON للغرفة</span>
          </button>
        </div>
      </div>

      {importOpen && (
        <InRoomQuizImportModal
          roomId={roomId}
          profile={profile}
          isSupervisor={isSupervisor}
          onClose={() => setImportOpen(false)}
          onImported={(sharedDocId) => {
            setImportOpen(false);
            onImportedQuizPoolId?.(sharedDocId);
          }}
        />
      )}
    </>
  );
};

interface InRoomQuizImportModalProps {
  roomId: string;
  profile: UserProfile;
  isSupervisor: boolean;
  onClose: () => void;
  onImported: (sharedDocId: string) => void;
}

export const InRoomQuizImportModal: React.FC<InRoomQuizImportModalProps> = ({
  roomId,
  profile,
  isSupervisor,
  onClose,
  onImported,
}) => {
  const [rawJson, setRawJson] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(IMPORT_PROMPT);
      setCopiedPrompt(true);
      playDuoSound('pop');
      setTimeout(() => setCopiedPrompt(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      setRawJson(text);
      setErrorMsg(null);
    } catch {
      setErrorMsg('تعذر قراءة الملف المحدد');
    }
  };

  const handleImportNow = async () => {
    setErrorMsg(null);
    setWarnings([]);
    setBusy(true);
    try {
      const parsed = parseQuizJson(rawJson);
      const title = (parsed.title || 'اختبار مستورد').slice(0, LIMITS.title);
      const cleaned = cleanQuestions(parsed.questions);
      const validationError = validateForSave(title, cleaned);
      if (validationError) {
        setWarnings(parsed.warnings);
        setErrorMsg(validationError);
        setBusy(false);
        return;
      }

      const newId = await createMyQuiz(profile.uid, title, cleaned);
      const sharedDocId = await publishQuizToRoom({
        roomId,
        authorId: profile.uid,
        authorName: profile.fullNameQuad,
        authorRole: isSupervisor ? 'supervisor' : 'student',
        quiz: {
          id: newId,
          ownerId: profile.uid,
          title,
          questions: cleaned,
          questionCount: cleaned.length,
        },
      });
      playDuoSound('correct');
      onImported(sharedDocId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'تعذر استيراد ملف الاختبار');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-3 sm:p-5"
      onClick={onClose}
    >
      <div
        className="duo-card max-w-2xl w-full p-5 sm:p-6 bg-white flex flex-col gap-4 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 pb-3 border-b-2 border-[#F0F0F0]">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-[#F3E8FF] border-2 border-[#CE82FF] text-[#8938D6] flex items-center justify-center shrink-0">
              <FileJson className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-black text-[#3C3C3C]">
                استيراد اختبار JSON ومشاركته في الغرفة
              </h3>
              <p className="text-xs font-bold text-[#777777]">
                يُحفظ في «اختباراتي» بحسابك ويظهر فوراً للاستخدام داخل هذه الغرفة
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl bg-[#F7F7F7] hover:bg-[#FFDFE0] text-[#3C3C3C] cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json,text/plain"
          onChange={handleFilePick}
          className="hidden"
        />

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleCopyPrompt()}
            className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#F8EDFF] border-2 border-b-3 border-[#CE82FF] text-xs font-black text-[#6D23B6] cursor-pointer"
          >
            {copiedPrompt ? (
              <Check className="w-3.5 h-3.5 text-[#46A302]" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            <span>{copiedPrompt ? 'تم نسخ موجه الـ AI!' : 'نسخ سكريبت الـ AI لتحويل الأسئلة'}</span>
          </button>

          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#DDF4FF] border-2 border-b-3 border-[#1CB0F6] text-xs font-black text-[#1899D6] cursor-pointer"
          >
            <FolderUp className="w-3.5 h-3.5" />
            <span>اختيار ملف .json</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setRawJson(EXAMPLE_JSON);
              setErrorMsg(null);
            }}
            className="duo-btn px-3 py-2 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#777777] hover:text-[#3C3C3C] cursor-pointer"
          >
            ملء مثال جاهز
          </button>
        </div>

        <textarea
          dir="ltr"
          rows={8}
          value={rawJson}
          onChange={(e) => setRawJson(e.target.value)}
          placeholder='الصق كود JSON هنا: { "title": "...", "questions": [...] }'
          className="w-full p-3.5 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#A560E8] focus:bg-white outline-none font-mono text-xs text-[#3C3C3C]"
        />

        {warnings.length > 0 && (
          <div className="p-3 rounded-xl bg-[#FFF4CC] border-2 border-[#FFC800] text-xs font-bold text-[#9A6B00] flex flex-col gap-1">
            {warnings.map((w, i) => (
              <span key={i}>• {w}</span>
            ))}
          </div>
        )}

        {errorMsg && (
          <div className="p-3 rounded-xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-xs sm:text-sm font-extrabold text-[#EA2B2B]">
            {errorMsg}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2 border-t-2 border-[#F0F0F0]">
          <button
            type="button"
            onClick={onClose}
            className="duo-btn px-4 py-2.5 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs sm:text-sm font-black text-[#777777] cursor-pointer"
          >
            إلغاء
          </button>
          <button
            type="button"
            disabled={busy || !rawJson.trim()}
            onClick={() => void handleImportNow()}
            className="duo-btn flex items-center gap-2 px-6 py-2.5 rounded-xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-xs sm:text-sm font-black cursor-pointer disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Share2 className="w-4 h-4" />
            )}
            <span>{busy ? 'جاري الحفظ والمشاركة...' : 'استيراد وإضافة للغرفة'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
