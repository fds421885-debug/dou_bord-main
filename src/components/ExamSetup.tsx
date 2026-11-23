import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Lock,
  Play,
  RotateCcw,
  Shuffle,
  Sparkles,
} from 'lucide-react';
import type { ExamSettings, ExamQuestion, MyQuiz, QuizAttempt } from '../types';
import {
  availableCount,
  buildExam,
  buildExamWithRotation,
  deriveRotationFromAttempts,
  describeTiming,
  EXAM_MAX_QUESTIONS,
  getExamRotationStats,
  isExamReady,
  validPool,
} from '../exam';
import {
  loadExamRotationResetMap,
  loadExamRotationResetMapSync,
  resetExamRotationQuizzesAt,
} from '../localDraftStore';
import {
  computeMistakeLedger,
  groupUnresolvedMistakesByQuiz,
  OTHER_MISTAKES_QUIZ_ID,
  type UnresolvedMistakeItem,
} from '../mistakeLedger';
import { DuoLoading } from './DuoLoading';

interface Props {
  ownerId: string;
  quizzes: MyQuiz[];
  attempts: QuizAttempt[];
  initialExamMode?: 'normal' | 'mistakes';
  initialQuizId?: string;
  onBack: () => void;
  onStart: (settings: ExamSettings, questions: ExamQuestion[]) => void;
}

const seg = (on: boolean, accent: 'purple' | 'orange' = 'purple') =>
  `flex-1 px-3 py-2 rounded-2xl border-2 text-xs sm:text-sm font-black cursor-pointer text-center ${
    on
      ? accent === 'orange'
        ? 'bg-[#FF9600] border-[#E08000] text-white'
        : 'bg-[#A560E8] border-[#8938D6] text-white'
      : 'bg-white border-[#E5E5E5] text-[#3C3C3C]'
  }`;
const card = 'rounded-3xl border-2 border-[#E5E5E5] border-b-4 bg-white p-4 flex flex-col gap-3';
const numInp =
  'w-24 rounded-2xl border-2 border-[#E5E5E5] focus:border-[#A560E8] outline-none px-3 py-2 text-sm font-black font-latin text-center';

export const ExamSetup: React.FC<Props> = ({
  ownerId,
  quizzes,
  attempts,
  initialExamMode = 'normal',
  initialQuizId,
  onBack,
  onStart,
}) => {
  const orderedQuizzes = useMemo(() => {
    const idSet = new Set(quizzes.map((q) => q.id));
    const mains = quizzes.filter((q) => !q.parentQuizId || !idSet.has(q.parentQuizId));
    const childrenByParent = new Map<string, MyQuiz[]>();
    for (const q of quizzes) {
      if (q.parentQuizId && idSet.has(q.parentQuizId)) {
        const list = childrenByParent.get(q.parentQuizId) ?? [];
        list.push(q);
        childrenByParent.set(q.parentQuizId, list);
      }
    }
    const out: Array<{ quiz: MyQuiz; isNested: boolean }> = [];
    for (const m of mains) {
      out.push({ quiz: m, isNested: false });
      for (const c of childrenByParent.get(m.id) ?? []) {
        out.push({ quiz: c, isNested: true });
      }
    }
    return out;
  }, [quizzes]);

  const ready = useMemo(() => quizzes.filter((q) => validPool(q).length > 0), [quizzes]);

  const mistakeLedger = useMemo(
    () => computeMistakeLedger(attempts, quizzes),
    [attempts, quizzes]
  );

  const groupedMistakes = useMemo(
    () => groupUnresolvedMistakesByQuiz(quizzes, mistakeLedger.unresolvedMistakes),
    [quizzes, mistakeLedger.unresolvedMistakes]
  );

  const readyMistakesByQuizId = useMemo(() => {
    const map = new Map<string, UnresolvedMistakeItem[]>();
    for (const q of quizzes) {
      const list = (groupedMistakes.byQuizId[q.id] || []).filter((m) => isExamReady(m.question));
      map.set(q.id, list);
    }
    const otherReady = groupedMistakes.otherMistakes.filter((m) => isExamReady(m.question));
    if (otherReady.length > 0) {
      map.set(OTHER_MISTAKES_QUIZ_ID, otherReady);
    }
    return map;
  }, [quizzes, groupedMistakes]);

  const mistakeCapableQuizzes = useMemo(() => {
    const list: Array<{ id: string; title: string; items: UnresolvedMistakeItem[]; isNested: boolean }> = [];
    for (const { quiz, isNested } of orderedQuizzes) {
      const items = readyMistakesByQuizId.get(quiz.id) || [];
      list.push({ id: quiz.id, title: quiz.title, items, isNested });
    }
    const other = readyMistakesByQuizId.get(OTHER_MISTAKES_QUIZ_ID) || [];
    if (other.length > 0) {
      list.push({
        id: OTHER_MISTAKES_QUIZ_ID,
        title: 'أخطاء من اختبارات أخرى / المساعد الذكي',
        items: other,
        isNested: false,
      });
    }
    return list;
  }, [orderedQuizzes, readyMistakesByQuizId]);

  const quizzesWithMistakes = useMemo(
    () => mistakeCapableQuizzes.filter((x) => x.items.length > 0),
    [mistakeCapableQuizzes]
  );

  const totalUniqueMistakes = useMemo(() => {
    const seen = new Set<string>();
    for (const item of mistakeLedger.unresolvedMistakes) {
      if (isExamReady(item.question)) seen.add(item.fp);
    }
    return seen.size;
  }, [mistakeLedger.unresolvedMistakes]);

  const isMistakeBankEmpty = totalUniqueMistakes === 0;

  const [examMode, setExamMode] = useState<'normal' | 'mistakes'>(initialExamMode);
  const [sourceMode, setSourceMode] = useState<'single' | 'mix'>(() => {
    if (initialQuizId) return 'single';
    if (initialExamMode === 'mistakes') {
      return quizzesWithMistakes.length > 1 ? 'mix' : 'single';
    }
    return ready.length > 1 ? 'mix' : 'single';
  });
  const [singleId, setSingleId] = useState<string>(() => {
    if (initialQuizId) return initialQuizId;
    if (initialExamMode === 'mistakes') return quizzesWithMistakes[0]?.id ?? '';
    return ready[0]?.id ?? '';
  });
  const [mixIds, setMixIds] = useState<string[]>(() => {
    if (initialExamMode === 'mistakes') return quizzesWithMistakes.map((q) => q.id);
    return ready.map((q) => q.id);
  });
  const [mixMode, setMixMode] = useState<'onePerQuiz' | 'total'>('total');
  const [countText, setCountText] = useState('');
  const [shuffleQuestions, setShuffleQuestions] = useState(true);
  const [shuffleChoices, setShuffleChoices] = useState(false);
  const [avoidRepeats, setAvoidRepeats] = useState(true);
  const [resetAtByQuizId, setResetAtByQuizId] = useState<Record<string, number>>(() =>
    loadExamRotationResetMapSync(ownerId)
  );
  const [showLaws, setShowLaws] = useState(false);
  const [timing, setTiming] = useState<'none' | 'perQuestion' | 'total'>('none');
  const [perQ, setPerQ] = useState('60');
  const [totalMin, setTotalMin] = useState('10');
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadExamRotationResetMap(ownerId).then((loaded) => {
      if (active) setResetAtByQuizId(loaded);
    });
    return () => {
      active = false;
    };
  }, [ownerId]);

  const switchExamMode = (nextMode: 'normal' | 'mistakes') => {
    setError(null);
    setCountText('');
    setExamMode(nextMode);
    if (nextMode === 'mistakes') {
      if (quizzesWithMistakes.length === 0) {
        setSingleId('');
        setMixIds([]);
        return;
      }
      const validIds = new Set(quizzesWithMistakes.map((q) => q.id));
      if (!validIds.has(singleId)) {
        setSingleId(quizzesWithMistakes[0].id);
      }
      const keptMix = mixIds.filter((id) => validIds.has(id));
      setMixIds(keptMix.length > 0 ? keptMix : quizzesWithMistakes.map((q) => q.id));
      if (quizzesWithMistakes.length < 2) {
        setSourceMode('single');
      }
    } else {
      const validReady = new Set(ready.map((q) => q.id));
      if (!validReady.has(singleId)) {
        setSingleId(ready[0]?.id ?? '');
      }
      const keptMix = mixIds.filter((id) => validReady.has(id));
      setMixIds(keptMix.length > 0 ? keptMix : ready.map((q) => q.id));
    }
  };

  const derivedRotation = useMemo(
    () => deriveRotationFromAttempts(quizzes, attempts, resetAtByQuizId),
    [quizzes, attempts, resetAtByQuizId]
  );

  const quizIds = sourceMode === 'single' ? (singleId ? [singleId] : []) : mixIds;

  // في وضع الأخطاء: تجهيز قائمة أسئلة الأخطاء الفريدة دون تكرار
  const mistakeSelection = useMemo(() => {
    if (examMode !== 'mistakes') {
      return { virtualQuizzes: [] as MyQuiz[], uniqueItems: [] as UnresolvedMistakeItem[], nonEmptyCount: 0 };
    }
    const usedFps = new Set<string>();
    const virtualQuizzes: MyQuiz[] = [];
    const uniqueItems: UnresolvedMistakeItem[] = [];
    let nonEmptyCount = 0;

    for (const qid of quizIds) {
      const rawItems = readyMistakesByQuizId.get(qid) || [];
      const deduped = rawItems.filter((m) => {
        if (usedFps.has(m.fp)) return false;
        usedFps.add(m.fp);
        return true;
      });
      if (deduped.length > 0) {
        nonEmptyCount += 1;
        uniqueItems.push(...deduped);
        const origQuiz = quizzes.find((q) => q.id === qid);
        virtualQuizzes.push({
          id: qid,
          ownerId,
          title:
            origQuiz?.title ||
            (qid === OTHER_MISTAKES_QUIZ_ID
              ? 'أخطاء من اختبارات أخرى / المساعد الذكي'
              : 'أخطائي'),
          questions: deduped.map((m) => m.question),
          questionCount: deduped.length,
        });
      }
    }

    return { virtualQuizzes, uniqueItems, nonEmptyCount };
  }, [examMode, quizIds, readyMistakesByQuizId, quizzes, ownerId]);

  const avail =
    examMode === 'mistakes'
      ? sourceMode === 'mix' && mixMode === 'onePerQuiz'
        ? Math.min(EXAM_MAX_QUESTIONS, mistakeSelection.nonEmptyCount)
        : Math.min(EXAM_MAX_QUESTIONS, mistakeSelection.uniqueItems.length)
      : availableCount(quizzes, { sourceMode, mixMode, quizIds });

  const rotationStats = useMemo(
    () => getExamRotationStats(quizzes, quizIds, derivedRotation.seenByQuizId),
    [quizzes, quizIds, derivedRotation.seenByQuizId]
  );

  const lawsAvailCount = useMemo(() => {
    if (examMode === 'mistakes') {
      return mistakeSelection.uniqueItems.filter(
        (m) => Array.isArray(m.question.laws) && m.question.laws.length > 0
      ).length;
    }
    return quizzes
      .filter((qz) => quizIds.includes(qz.id))
      .reduce(
        (sum, qz) =>
          sum + validPool(qz).filter((qq) => Array.isArray(qq.laws) && qq.laws.length > 0).length,
        0
      );
  }, [examMode, mistakeSelection.uniqueItems, quizzes, quizIds]);

  const countFixed = sourceMode === 'mix' && mixMode === 'onePerQuiz';
  const parsed = parseInt(countText, 10);
  const count =
    avail === 0
      ? 0
      : countFixed
      ? avail
      : Math.max(1, Math.min(avail, Number.isFinite(parsed) && parsed > 0 ? parsed : avail));

  const perQSec = Math.max(5, Math.min(3600, parseInt(perQ, 10) || 60));
  const totalSec = Math.max(30, Math.min(8 * 3600, Math.round((parseFloat(totalMin) || 10) * 60)));
  const seconds = timing === 'perQuestion' ? perQSec : timing === 'total' ? totalSec : 0;

  const toggleMix = (id: string) =>
    setMixIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const handleResetRotation = async () => {
    if (quizIds.length === 0) return;
    const next = await resetExamRotationQuizzesAt(ownerId, quizIds);
    setResetAtByQuizId(next);
  };

  const start = async () => {
    setError(null);
    if (examMode === 'mistakes' && isMistakeBankEmpty) {
      setError('بنك الأسئلة الخاطئة فارغ! صححت جميع أخطائك السابقة ولا يمكنك الدخول حتى تقع أخطاء جديدة.');
      return;
    }
    if (quizIds.length === 0 || avail === 0) {
      setError(
        examMode === 'mistakes'
          ? 'اختر نموذجاً واحداً على الأقل يحتوي أخطاءً معلقة للتصحيح.'
          : 'اختر نموذجاً واحداً على الأقل يحتوي أسئلة جاهزة.'
      );
      return;
    }

    const resolveTitle = (id: string) =>
      quizzes.find((q) => q.id === id)?.title ??
      (id === OTHER_MISTAKES_QUIZ_ID ? 'أخطاء من اختبارات أخرى' : '');

    const settings: ExamSettings = {
      sourceMode: quizIds.length === 1 ? 'single' : sourceMode,
      mixMode,
      quizIds,
      quizTitles: quizIds.map(resolveTitle),
      questionCount: count,
      shuffleQuestions,
      shuffleChoices,
      showLaws,
      avoidRepeats: examMode === 'normal' ? avoidRepeats : false,
      ...(examMode === 'mistakes' ? { mistakeReviewMode: true } : {}),
      timing,
      seconds,
    };

    const questions =
      examMode === 'mistakes'
        ? buildExam(mistakeSelection.virtualQuizzes, settings)
        : avoidRepeats
        ? buildExamWithRotation(quizzes, settings, derivedRotation.seenByQuizId).questions
        : buildExam(quizzes, settings);

    if (questions.length === 0) {
      setError('تعذر بناء الاختبار، تأكد أن النماذج المختارة فيها أسئلة جاهزة.');
      return;
    }
    setLaunching(true);
    window.setTimeout(() => {
      onStart(settings, questions);
    }, 320);
  };

  const accent = examMode === 'mistakes' ? 'orange' : 'purple';

  return (
    <div className="max-w-3xl mx-auto w-full flex flex-col gap-4" dir="rtl">
      <button
        type="button"
        onClick={onBack}
        className="self-start flex items-center gap-1 text-xs font-black text-[#777777] cursor-pointer"
      >
        <ArrowRight className="w-4 h-4" /> العودة إلى اختباراتي
      </button>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-black text-[#3C3C3C]">وضع الاختبار</h2>
        {mistakeLedger.correctedMistakesCount > 0 && (
          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-xl bg-[#D7FFB8] border border-[#58CC02] text-[11px] font-black text-[#46A302]">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>تم تصحيح {mistakeLedger.correctedMistakesCount} خطأ سابقاً</span>
          </span>
        )}
      </div>

      {/* اختيار نوع الاختبار: اختبار طبيعي vs اختبار أخطائي */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => switchExamMode('normal')}
          className={`flex items-start gap-3 p-4 rounded-3xl border-2 border-b-4 text-right cursor-pointer transition-colors ${
            examMode === 'normal'
              ? 'bg-[#F5ECFF] border-[#A560E8]'
              : 'bg-white border-[#E5E5E5] hover:border-[#D0D0D0]'
          }`}
        >
          <div
            className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${
              examMode === 'normal'
                ? 'bg-[#A560E8] text-white'
                : 'bg-[#F3E8FF] text-[#8938D6]'
            }`}
          >
            <Play className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm sm:text-base font-black text-[#3C3C3C]">اختبار طبيعي</span>
              {examMode === 'normal' && (
                <span className="px-2 py-0.5 rounded-lg bg-[#A560E8] text-white text-[10px] font-black">
                  مُفعّل
                </span>
              )}
            </div>
            <p className="text-[11px] font-bold text-[#777777] mt-0.5">
              اختر نموذجاً أو امزج عدة نماذج وحدد العدد والوقت كالمعتاد.
            </p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => switchExamMode('mistakes')}
          className={`flex items-start gap-3 p-4 rounded-3xl border-2 border-b-4 text-right cursor-pointer transition-colors ${
            examMode === 'mistakes'
              ? isMistakeBankEmpty
                ? 'bg-[#F0FDF4] border-[#58CC02]'
                : 'bg-[#FFF7ED] border-[#FF9600]'
              : 'bg-white border-[#E5E5E5] hover:border-[#D0D0D0]'
          }`}
        >
          <div
            className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${
              isMistakeBankEmpty
                ? 'bg-[#58CC02] text-white'
                : examMode === 'mistakes'
                ? 'bg-[#FF9600] text-white'
                : 'bg-[#FFEDD5] text-[#C2410C]'
            }`}
          >
            {isMistakeBankEmpty ? <Lock className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm sm:text-base font-black text-[#3C3C3C]">اختبار أخطائي</span>
              {isMistakeBankEmpty ? (
                <span className="px-2 py-0.5 rounded-lg bg-[#D7FFB8] border border-[#58CC02] text-[#46A302] text-[10px] font-black">
                  مُغلق (0 أخطاء)
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-lg bg-[#FF4B4B] text-white text-[10px] font-black font-latin">
                  {totalUniqueMistakes} خطأ
                </span>
              )}
            </div>
            <p className="text-[11px] font-bold text-[#777777] mt-0.5">
              {isMistakeBankEmpty
                ? 'أنهيت جميع الأخطاء بنجاح ✓ لا توجد أسئلة خاطئة للدخول.'
                : 'أعد حل أخطائك فقط — والصح ينتقل للأجوبة الصحيحة ولوحة الشرف.'}
            </p>
          </div>
        </button>
      </div>

      {examMode === 'mistakes' && isMistakeBankEmpty ? (
        <div className="rounded-3xl border-2 border-b-4 border-[#58CC02] bg-[#F2FFE8] p-6 text-center flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-[#58CC02] border-b-4 border-[#46A302] text-white flex items-center justify-center">
            <Lock className="w-7 h-7" />
          </div>
          <h3 className="text-base sm:text-lg font-black text-[#2F6F00]">
            بنك الأسئلة الخاطئة فارغ — لا يمكن الدخول حالياً
          </h3>
          <p className="text-xs sm:text-sm font-bold text-[#46A302] max-w-lg leading-relaxed">
            {mistakeLedger.correctedMistakesCount > 0
              ? `أحسنت! تم تصحيح جميع أخطائك السابقة (${mistakeLedger.correctedMistakesCount} سؤالاً) وانتقلت بالكامل إلى قسم الإجابات الصحيحة ولوحة الشرف.`
              : 'لم تُسجّل أي أخطاء غير مصححة في محاولاتك حتى الآن.'}{' '}
            يُفتح هذا الاختبار تلقائياً فور وقوع أي خطأ جديد في اختبار طبيعي.
          </p>
          <button
            type="button"
            onClick={() => switchExamMode('normal')}
            className="duo-btn inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#A560E8] hover:bg-[#B477EE] border-2 border-b-4 border-[#8938D6] text-white text-xs sm:text-sm font-black cursor-pointer"
          >
            <Play className="w-4 h-4" />
            <span>الانتقال إلى الاختبار الطبيعي</span>
          </button>
        </div>
      ) : (
        <>
          {examMode === 'mistakes' && (
            <div className="rounded-2xl border-2 border-[#FFD28A] bg-[#FFF8EB] px-4 py-3 flex items-start gap-2.5 text-xs font-extrabold text-[#9A5B00]">
              <Sparkles className="w-4 h-4 text-[#FF9600] shrink-0 mt-0.5" />
              <span>
                كل سؤال تحلّه بشكل صحيح داخل «اختبار أخطائي» يُزال فوراً من بنك الأخطاء، وينتقل إلى رصيد{' '}
                <strong>الإجابات الصحيحة</strong> في إحصائياتك ويُحدّث درجتك في <strong>لوحة الشرف</strong> تلقائياً!
              </span>
            </div>
          )}

          {/* 1. المصدر */}
          <div className={card}>
            <h3 className="text-sm font-black text-[#3C3C3C]">
              {examMode === 'mistakes' ? '1) اختر النماذج التي تريد تصحيح أخطائها:' : '1) من أين تأتي الأسئلة؟'}
            </h3>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSourceMode('single')}
                className={seg(sourceMode === 'single', accent)}
              >
                نموذج محدد
              </button>
              <button
                type="button"
                onClick={() => setSourceMode('mix',)}
                disabled={
                  examMode === 'mistakes' ? quizzesWithMistakes.length < 2 : ready.length < 2
                }
                className={`${seg(sourceMode === 'mix', accent)} disabled:opacity-40`}
              >
                <Shuffle className="inline w-3.5 h-3.5 ml-1" /> مزيج من عدة نماذج
              </button>
            </div>

            {examMode === 'mistakes' ? (
              sourceMode === 'single' ? (
                <div className="flex flex-col gap-1.5">
                  {mistakeCapableQuizzes.map((item) => {
                    const n = item.items.length;
                    return (
                      <label
                        key={item.id}
                        className={`flex items-center gap-2 px-3 py-2 rounded-2xl border-2 text-sm font-bold ${
                          item.isNested ? 'mr-5 bg-[#FAF7FF]' : ''
                        } ${n === 0 ? 'opacity-55 cursor-not-allowed bg-[#FAFAFA]' : 'cursor-pointer'} ${
                          singleId === item.id && n > 0
                            ? 'border-[#FF9600] bg-[#FFF7ED]'
                            : 'border-[#E5E5E5]'
                        }`}
                      >
                        <input
                          type="radio"
                          name="single"
                          disabled={n === 0}
                          checked={singleId === item.id}
                          onChange={() => setSingleId(item.id)}
                        />
                        <span className="flex-1 truncate">{item.title}</span>
                        <span
                          className={`text-[11px] font-black ${
                            n > 0 ? 'text-[#C2410C]' : 'text-[#46A302]'
                          }`}
                        >
                          {n > 0 ? `${n} خطأ بانتظار التصحيح` : 'بلا أخطاء ✓'}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-3 text-xs font-black">
                      <button
                        type="button"
                        onClick={() => setMixIds(quizzesWithMistakes.map((q) => q.id))}
                        className="text-[#1899D6] cursor-pointer"
                      >
                        تحديد الكل ({quizzesWithMistakes.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setMixIds([])}
                        className="text-[#777777] cursor-pointer"
                      >
                        إلغاء التحديد
                      </button>
                    </div>
                    {mistakeCapableQuizzes.map((item) => {
                      const n = item.items.length;
                      return (
                        <label
                          key={item.id}
                          className={`flex items-center gap-2 px-3 py-2 rounded-2xl border-2 text-sm font-bold ${
                            item.isNested ? 'mr-5 bg-[#FAF7FF]' : ''
                          } ${n === 0 ? 'opacity-55 cursor-not-allowed bg-[#FAFAFA]' : 'cursor-pointer'} ${
                            mixIds.includes(item.id) && n > 0
                              ? 'border-[#FF9600] bg-[#FFF7ED]'
                              : 'border-[#E5E5E5]'
                          }`}
                        >
                          <input
                            type="checkbox"
                            disabled={n === 0}
                            checked={mixIds.includes(item.id)}
                            onChange={() => toggleMix(item.id)}
                          />
                          <span className="flex-1 truncate">{item.title}</span>
                          <span
                            className={`text-[11px] font-black ${
                              n > 0 ? 'text-[#C2410C]' : 'text-[#46A302]'
                            }`}
                          >
                            {n > 0 ? `${n} خطأ` : 'بلا أخطاء ✓'}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setMixMode('onePerQuiz')}
                      className={seg(mixMode === 'onePerQuiz', accent)}
                    >
                      خطأ واحد من كل نموذج
                    </button>
                    <button
                      type="button"
                      onClick={() => setMixMode('total')}
                      className={seg(mixMode === 'total', accent)}
                    >
                      عدد محدد موزّع على النماذج
                    </button>
                  </div>
                </>
              )
            ) : sourceMode === 'single' ? (
              <div className="flex flex-col gap-1.5">
                {orderedQuizzes.map(({ quiz: q, isNested }) => {
                  const n = validPool(q).length;
                  return (
                    <label
                      key={q.id}
                      className={`flex items-center gap-2 px-3 py-2 rounded-2xl border-2 text-sm font-bold cursor-pointer ${
                        isNested ? 'mr-5 bg-[#FAF7FF]' : ''
                      } ${n === 0 ? 'opacity-50 cursor-not-allowed' : ''} ${
                        singleId === q.id ? 'border-[#A560E8] bg-[#F5ECFF]' : 'border-[#E5E5E5]'
                      }`}
                    >
                      <input
                        type="radio"
                        name="single"
                        disabled={n === 0}
                        checked={singleId === q.id}
                        onChange={() => setSingleId(q.id)}
                      />
                      {(isNested || q.quizKind === 'drill') && (
                        <span className="px-1.5 py-0.5 rounded-lg bg-[#A560E8]/15 text-[#8938D6] text-[10px] font-black shrink-0">
                          تقوية
                        </span>
                      )}
                      <span className="flex-1 truncate">{q.title}</span>
                      <span className="text-[11px] font-extrabold text-[#777777]">
                        {n > 0 ? `${n} سؤال جاهز` : 'لا أسئلة جاهزة'}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-3 text-xs font-black">
                    <button
                      type="button"
                      onClick={() => setMixIds(ready.map((q) => q.id))}
                      className="text-[#1899D6] cursor-pointer"
                    >
                      تحديد الكل
                    </button>
                    <button
                      type="button"
                      onClick={() => setMixIds([])}
                      className="text-[#777777] cursor-pointer"
                    >
                      إلغاء التحديد
                    </button>
                  </div>
                  {orderedQuizzes.map(({ quiz: q, isNested }) => {
                    const n = validPool(q).length;
                    return (
                      <label
                        key={q.id}
                        className={`flex items-center gap-2 px-3 py-2 rounded-2xl border-2 text-sm font-bold ${
                          isNested ? 'mr-5 bg-[#FAF7FF]' : ''
                        } ${n === 0 ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${
                          mixIds.includes(q.id) ? 'border-[#A560E8] bg-[#F5ECFF]' : 'border-[#E5E5E5]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          disabled={n === 0}
                          checked={mixIds.includes(q.id)}
                          onChange={() => toggleMix(q.id)}
                        />
                        {(isNested || q.quizKind === 'drill') && (
                          <span className="px-1.5 py-0.5 rounded-lg bg-[#A560E8]/15 text-[#8938D6] text-[10px] font-black shrink-0">
                            تقوية
                          </span>
                        )}
                        <span className="flex-1 truncate">{q.title}</span>
                        <span className="text-[11px] font-extrabold text-[#777777]">
                          {n > 0 ? `${n} سؤال جاهز` : 'لا أسئلة جاهزة'}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setMixMode('onePerQuiz')}
                    className={seg(mixMode === 'onePerQuiz')}
                  >
                    سؤال واحد من كل نموذج
                  </button>
                  <button
                    type="button"
                    onClick={() => setMixMode('total')}
                    className={seg(mixMode === 'total')}
                  >
                    عدد محدد موزّع على النماذج
                  </button>
                </div>
              </>
            )}
          </div>

          {/* 2. العدد والترتيب */}
          <div className={card}>
            <h3 className="text-sm font-black text-[#3C3C3C]">
              {examMode === 'mistakes' ? '2) عدد أسئلة الأخطاء والتنويع' : '2) عدد الأسئلة والتنويع'}
            </h3>
            {countFixed ? (
              <p className="text-xs font-extrabold text-[#555]">
                سيُسأل <span className="font-latin">{avail}</span> سؤالاً: واحد عشوائي من كل نموذج مختار.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-black text-[#3C3C3C]">
                  {examMode === 'mistakes' ? 'عدد أسئلة الأخطاء' : 'عدد الأسئلة'}
                </span>
                <input
                  inputMode="numeric"
                  dir="ltr"
                  className={numInp}
                  value={countText}
                  placeholder={String(avail)}
                  onChange={(e) => setCountText(e.target.value.replace(/[^\d]/g, ''))}
                />
                <button
                  type="button"
                  onClick={() => setCountText('')}
                  className="text-xs font-black text-[#1899D6] cursor-pointer"
                >
                  الكل ({avail})
                </button>
                <span className="text-[11px] font-bold text-[#777777]">
                  الحد الأقصى {Math.min(avail, EXAM_MAX_QUESTIONS)}
                </span>
              </div>
            )}
            {sourceMode === 'mix' && mixMode === 'total' && (
              <p className="text-[11px] font-bold text-[#777777]">
                يُسحب من كل نموذج بالتناوب لتتنوع الأسئلة قدر الإمكان.
              </p>
            )}
            <label className="flex items-center gap-2 text-sm font-bold cursor-pointer">
              <input
                type="checkbox"
                checked={shuffleQuestions}
                onChange={(e) => setShuffleQuestions(e.target.checked)}
              />{' '}
              ترتيب الأسئلة عشوائي
            </label>
            <label className="flex items-center gap-2 text-sm font-bold cursor-pointer">
              <input
                type="checkbox"
                checked={shuffleChoices}
                onChange={(e) => setShuffleChoices(e.target.checked)}
              />{' '}
              خلط ترتيب الخيارات
            </label>
            {shuffleChoices && (
              <p className="text-[11px] font-bold text-[#8A6500]">
                انتبه: لا تفعّله إذا كانت خياراتك مثل «كل ما سبق» أو «لا يمكن التحديد».
              </p>
            )}
            {examMode === 'normal' && (
              <>
                <label className="flex items-center gap-2 text-sm font-bold cursor-pointer pt-1 border-t border-[#F0F0F0]">
                  <input
                    type="checkbox"
                    checked={avoidRepeats}
                    onChange={(e) => setAvoidRepeats(e.target.checked)}
                  />
                  <span>عدم تكرار الأسئلة المختبرة سابقاً حتى ينتهي الاختبار ثم يعيد تلقائياً</span>
                </label>
                {avoidRepeats && rotationStats.totalQuestions > 0 && (
                  <div className="rounded-2xl bg-[#FAF7FF] border-2 border-[#E9D8FD] p-3 flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-extrabold text-[#5B21B6]">
                      <span>
                        {rotationStats.seenQuestions === 0
                          ? `بداية دورة جديدة من محاولاتك السابقة: ${rotationStats.totalQuestions} سؤالاً لم تُجب عليها بعد.`
                          : rotationStats.remainingUnseen > 0
                          ? `حسب محاولاتك السابقة: أجبت على ${rotationStats.seenQuestions} من ${rotationStats.totalQuestions} · متبقي ${rotationStats.remainingUnseen} سؤالاً لم تجب عليه بعد`
                          : `أنهيت الإجابة على كل أسئلة الدورة (${rotationStats.totalQuestions} من ${rotationStats.totalQuestions}) — البدء الآن يفتح دورة جديدة`}
                      </span>
                      {rotationStats.seenQuestions > 0 && (
                        <button
                          type="button"
                          onClick={() => void handleResetRotation()}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-white border border-[#D8B4FE] text-[11px] font-black text-[#7C3AED] hover:bg-[#F3E8FF] cursor-pointer"
                        >
                          <RotateCcw className="w-3 h-3" /> البدء من الأول
                        </button>
                      )}
                    </div>
                    <progress
                      value={rotationStats.seenQuestions}
                      max={rotationStats.totalQuestions}
                      className="w-full h-2 rounded-full overflow-hidden accent-[#A560E8] [&::-webkit-progress-bar]:bg-[#E9D8FD] [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-value]:bg-[#A560E8] [&::-webkit-progress-value]:rounded-full [&::-moz-progress-bar]:bg-[#A560E8]"
                    />
                    {rotationStats.remainingUnseen > 0 && count > rotationStats.remainingUnseen && (
                      <p className="text-[11px] font-bold text-[#6B21A8]">
                        سيُعرض لك المتبقي من الدورة الحالية أولاً ({rotationStats.remainingUnseen} سؤالاً) ثم تُفتح دورة جديدة لبقية العدد ({count - rotationStats.remainingUnseen}).
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* 3. الوقت */}
          <div className={card}>
            <h3 className="text-sm font-black text-[#3C3C3C]">3) الوقت</h3>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setTiming('none')}
                className={seg(timing === 'none', accent)}
              >
                بدون وقت
              </button>
              <button
                type="button"
                onClick={() => setTiming('perQuestion')}
                className={seg(timing === 'perQuestion', accent)}
              >
                وقت لكل سؤال
              </button>
              <button
                type="button"
                onClick={() => setTiming('total')}
                className={seg(timing === 'total', accent)}
              >
                وقت كلي
              </button>
            </div>
            {timing === 'perQuestion' && (
              <div className="flex flex-wrap items-center gap-2">
                {[30, 45, 60, 90, 120].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setPerQ(String(s))}
                    className={`px-3 py-1.5 rounded-xl border-2 text-xs font-black cursor-pointer ${
                      perQSec === s
                        ? examMode === 'mistakes'
                          ? 'bg-[#FFF7ED] border-[#FF9600]'
                          : 'bg-[#F5ECFF] border-[#A560E8]'
                        : 'border-[#E5E5E5] bg-white'
                    }`}
                  >
                    {s} ث
                  </button>
                ))}
                <input
                  inputMode="numeric"
                  dir="ltr"
                  className={numInp}
                  value={perQ}
                  onChange={(e) => setPerQ(e.target.value.replace(/[^\d]/g, ''))}
                />
                <span className="text-xs font-bold text-[#777777]">
                  ثانية لكل سؤال، وينتقل تلقائياً عند انتهائها ولا يمكن الرجوع.
                </span>
              </div>
            )}
            {timing === 'total' && (
              <div className="flex flex-wrap items-center gap-2">
                {[5, 10, 20, 30, 60].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setTotalMin(String(m))}
                    className={`px-3 py-1.5 rounded-xl border-2 text-xs font-black cursor-pointer ${
                      parseFloat(totalMin) === m
                        ? examMode === 'mistakes'
                          ? 'bg-[#FFF7ED] border-[#FF9600]'
                          : 'bg-[#F5ECFF] border-[#A560E8]'
                        : 'border-[#E5E5E5] bg-white'
                    }`}
                  >
                    {m} د
                  </button>
                ))}
                <input
                  inputMode="decimal"
                  dir="ltr"
                  className={numInp}
                  value={totalMin}
                  onChange={(e) => setTotalMin(e.target.value.replace(/[^\d.]/g, ''))}
                />
                <span className="text-xs font-bold text-[#777777]">
                  دقيقة للاختبار كاملاً، وينتهي تلقائياً عند انتهائها.
                </span>
              </div>
            )}
          </div>

          {/* 4. القوانين فوق السؤال */}
          <div className={card}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-black text-[#3C3C3C] flex items-center gap-1.5">
                <BookOpen className="w-4 h-4 text-[#1899D6]" />
                <span>4) إظهار قوانين كل سؤال أثناء الاختبار</span>
              </h3>
              {lawsAvailCount > 0 && (
                <span className="px-2.5 py-0.5 rounded-xl bg-[#F0FAFF] border border-[#BCE8FF] text-[11px] font-black text-[#1479AD]">
                  {lawsAvailCount} سؤال يحتوي قوانين
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowLaws(false)}
                className={seg(!showLaws, accent)}
              >
                بدون قوانين (اختبار قياسي)
              </button>
              <button
                type="button"
                onClick={() => setShowLaws(true)}
                className={seg(showLaws, accent)}
              >
                إظهار القوانين فوق السؤال
              </button>
            </div>
            <p className="text-[11px] font-bold text-[#777777]">
              {showLaws
                ? lawsAvailCount > 0
                  ? 'ستظهر قوانين المسألة فقط أعلى كل سؤال (دون خطوات الحل) لمساعدتك في التذكر أثناء التدريب.'
                  : 'تم تفعيل الإظهار، لكن النماذج المختارة لا تحتوي قوانين مكتوبة بعد — يمكنك إضافتها من التعديل أو الاستيراد.'
                : 'تُخفى القوانين أثناء الحل وتبقى متاحة للمراجعة بعد انتهاء الاختبار.'}
            </p>
          </div>

          {error && (
            <div className="p-3 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-xs font-extrabold text-[#EA2B2B]">
              {error}
            </div>
          )}

          <div className="sticky bottom-2 z-20 flex flex-col gap-1">
            <button
              type="button"
              onClick={() => void start()}
              disabled={avail === 0 || launching || (examMode === 'mistakes' && isMistakeBankEmpty)}
              className={`duo-btn flex items-center justify-center gap-2 px-5 py-3 rounded-2xl border-2 border-b-4 text-white text-base font-black cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                examMode === 'mistakes'
                  ? 'bg-[#FF9600] hover:bg-[#FFA624] border-[#E08000]'
                  : 'bg-[#A560E8] hover:bg-[#B57BEE] border-[#8938D6]'
              }`}
            >
              <Play className="w-5 h-5" />{' '}
              {examMode === 'mistakes'
                ? avail > 0
                  ? `ابدأ اختبار الأخطاء (${count} سؤال · ${describeTiming({ timing, seconds })})`
                  : 'لا توجد أخطاء محددة للدخول'
                : `ابدأ الاختبار (${count} سؤال · ${describeTiming({ timing, seconds })})`}
            </button>
          </div>
        </>
      )}

      {launching && (
        <DuoLoading
          variant="overlay"
          title={
            examMode === 'mistakes'
              ? 'جاري تجهيز أسئلة أخطائك للتصحيح...'
              : 'جاري تجهيز أسئلة الاختبار والمؤقت...'
          }
          subtitle={`سيتم تحميل ${count} سؤال بالرسومات والأشكال الهندسية`}
          accent={examMode === 'mistakes' ? 'gold' : 'purple'}
        />
      )}
    </div>
  );
};

