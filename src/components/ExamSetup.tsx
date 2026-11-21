import React, { useMemo, useState } from 'react';
import { ArrowRight, BookOpen, Play, Shuffle } from 'lucide-react';
import type { ExamSettings, ExamQuestion, MyQuiz } from '../types';
import { availableCount, buildExam, describeTiming, EXAM_MAX_QUESTIONS, validPool } from '../exam';
import { DuoLoading } from './DuoLoading';

interface Props {
  quizzes: MyQuiz[];
  onBack: () => void;
  onStart: (settings: ExamSettings, questions: ExamQuestion[]) => void;
}

const seg = (on: boolean) =>
  `flex-1 px-3 py-2 rounded-2xl border-2 text-xs sm:text-sm font-black cursor-pointer text-center ${
    on ? 'bg-[#A560E8] border-[#8938D6] text-white' : 'bg-white border-[#E5E5E5] text-[#3C3C3C]'
  }`;
const card = 'rounded-3xl border-2 border-[#E5E5E5] border-b-4 bg-white p-4 flex flex-col gap-3';
const numInp =
  'w-24 rounded-2xl border-2 border-[#E5E5E5] focus:border-[#A560E8] outline-none px-3 py-2 text-sm font-black font-latin text-center';

export const ExamSetup: React.FC<Props> = ({ quizzes, onBack, onStart }) => {
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
  const [sourceMode, setSourceMode] = useState<'single' | 'mix'>(ready.length > 1 ? 'mix' : 'single');
  const [singleId, setSingleId] = useState(ready[0]?.id ?? '');
  const [mixIds, setMixIds] = useState<string[]>(ready.map((q) => q.id));
  const [mixMode, setMixMode] = useState<'onePerQuiz' | 'total'>('total');
  const [countText, setCountText] = useState('');
  const [shuffleQuestions, setShuffleQuestions] = useState(true);
  const [shuffleChoices, setShuffleChoices] = useState(false);
  const [showLaws, setShowLaws] = useState(false);
  const [timing, setTiming] = useState<'none' | 'perQuestion' | 'total'>('none');
  const [perQ, setPerQ] = useState('60');
  const [totalMin, setTotalMin] = useState('10');
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quizIds = sourceMode === 'single' ? (singleId ? [singleId] : []) : mixIds;
  const avail = availableCount(quizzes, { sourceMode, mixMode, quizIds });
  const lawsAvailCount = useMemo(
    () =>
      quizzes
        .filter((qz) => quizIds.includes(qz.id))
        .reduce(
          (sum, qz) =>
            sum + validPool(qz).filter((qq) => Array.isArray(qq.laws) && qq.laws.length > 0).length,
          0
        ),
    [quizzes, quizIds]
  );
  const countFixed = sourceMode === 'mix' && mixMode === 'onePerQuiz';
  const parsed = parseInt(countText, 10);
  const count = countFixed
    ? avail
    : Math.max(1, Math.min(avail, Number.isFinite(parsed) && parsed > 0 ? parsed : avail));

  const perQSec = Math.max(5, Math.min(3600, parseInt(perQ, 10) || 60));
  const totalSec = Math.max(30, Math.min(8 * 3600, Math.round((parseFloat(totalMin) || 10) * 60)));
  const seconds = timing === 'perQuestion' ? perQSec : timing === 'total' ? totalSec : 0;

  const toggleMix = (id: string) =>
    setMixIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const start = () => {
    setError(null);
    if (quizIds.length === 0 || avail === 0) {
      setError('اختر نموذجاً واحداً على الأقل يحتوي أسئلة جاهزة.');
      return;
    }
    const settings: ExamSettings = {
      sourceMode: quizIds.length === 1 ? 'single' : sourceMode,
      mixMode,
      quizIds,
      quizTitles: quizIds.map((id) => quizzes.find((q) => q.id === id)?.title ?? ''),
      questionCount: count,
      shuffleQuestions,
      shuffleChoices,
      showLaws,
      timing,
      seconds,
    };
    const questions = buildExam(quizzes, settings);
    if (questions.length === 0) {
      setError('تعذر بناء الاختبار، تأكد أن النماذج المختارة فيها أسئلة جاهزة.');
      return;
    }
    setLaunching(true);
    window.setTimeout(() => {
      onStart(settings, questions);
    }, 320);
  };

  return (
    <div className="max-w-3xl mx-auto w-full flex flex-col gap-4" dir="rtl">
      <button type="button" onClick={onBack} className="self-start flex items-center gap-1 text-xs font-black text-[#777777] cursor-pointer">
        <ArrowRight className="w-4 h-4" /> العودة إلى اختباراتي
      </button>
      <h2 className="text-lg font-black text-[#3C3C3C]">وضع الاختبار</h2>

      {/* 1. المصدر */}
      <div className={card}>
        <h3 className="text-sm font-black text-[#3C3C3C]">1) من أين تأتي الأسئلة؟</h3>
        <div className="flex gap-2">
          <button type="button" onClick={() => setSourceMode('single')} className={seg(sourceMode === 'single')}>نموذج محدد</button>
          <button type="button" onClick={() => setSourceMode('mix')} disabled={ready.length < 2} className={`${seg(sourceMode === 'mix')} disabled:opacity-40`}>
            <Shuffle className="inline w-3.5 h-3.5 ml-1" /> مزيج من عدة نماذج
          </button>
        </div>

        {sourceMode === 'single' ? (
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
                  <input type="radio" name="single" disabled={n === 0} checked={singleId === q.id} onChange={() => setSingleId(q.id)} />
                  {(isNested || q.quizKind === 'drill') && (
                    <span className="px-1.5 py-0.5 rounded-lg bg-[#A560E8]/15 text-[#8938D6] text-[10px] font-black shrink-0">
                      تقوية
                    </span>
                  )}
                  <span className="flex-1 truncate">{q.title}</span>
                  <span className="text-[11px] font-extrabold text-[#777777]">{n > 0 ? `${n} سؤال جاهز` : 'لا أسئلة جاهزة'}</span>
                </label>
              );
            })}
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-3 text-xs font-black">
                <button type="button" onClick={() => setMixIds(ready.map((q) => q.id))} className="text-[#1899D6] cursor-pointer">تحديد الكل</button>
                <button type="button" onClick={() => setMixIds([])} className="text-[#777777] cursor-pointer">إلغاء التحديد</button>
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
                    <input type="checkbox" disabled={n === 0} checked={mixIds.includes(q.id)} onChange={() => toggleMix(q.id)} />
                    {(isNested || q.quizKind === 'drill') && (
                      <span className="px-1.5 py-0.5 rounded-lg bg-[#A560E8]/15 text-[#8938D6] text-[10px] font-black shrink-0">
                        تقوية
                      </span>
                    )}
                    <span className="flex-1 truncate">{q.title}</span>
                    <span className="text-[11px] font-extrabold text-[#777777]">{n > 0 ? `${n} سؤال جاهز` : 'لا أسئلة جاهزة'}</span>
                  </label>
                );
              })}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setMixMode('onePerQuiz')} className={seg(mixMode === 'onePerQuiz')}>سؤال واحد من كل نموذج</button>
              <button type="button" onClick={() => setMixMode('total')} className={seg(mixMode === 'total')}>عدد محدد موزّع على النماذج</button>
            </div>
          </>
        )}
      </div>

      {/* 2. العدد والترتيب */}
      <div className={card}>
        <h3 className="text-sm font-black text-[#3C3C3C]">2) عدد الأسئلة والتنويع</h3>
        {countFixed ? (
          <p className="text-xs font-extrabold text-[#555]">
            سيُسأل <span className="font-latin">{avail}</span> سؤالاً: واحد عشوائي من كل نموذج مختار.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-black text-[#3C3C3C]">عدد الأسئلة</span>
            <input
              inputMode="numeric"
              dir="ltr"
              className={numInp}
              value={countText}
              placeholder={String(avail)}
              onChange={(e) => setCountText(e.target.value.replace(/[^\d]/g, ''))}
            />
            <button type="button" onClick={() => setCountText('')} className="text-xs font-black text-[#1899D6] cursor-pointer">الكل ({avail})</button>
            <span className="text-[11px] font-bold text-[#777777]">الحد الأقصى {Math.min(avail, EXAM_MAX_QUESTIONS)}</span>
          </div>
        )}
        {sourceMode === 'mix' && mixMode === 'total' && (
          <p className="text-[11px] font-bold text-[#777777]">يُسحب من كل نموذج بالتناوب لتتنوع الأسئلة قدر الإمكان.</p>
        )}
        <label className="flex items-center gap-2 text-sm font-bold cursor-pointer">
          <input type="checkbox" checked={shuffleQuestions} onChange={(e) => setShuffleQuestions(e.target.checked)} /> ترتيب الأسئلة عشوائي
        </label>
        <label className="flex items-center gap-2 text-sm font-bold cursor-pointer">
          <input type="checkbox" checked={shuffleChoices} onChange={(e) => setShuffleChoices(e.target.checked)} /> خلط ترتيب الخيارات
        </label>
        {shuffleChoices && (
          <p className="text-[11px] font-bold text-[#8A6500]">انتبه: لا تفعّله إذا كانت خياراتك مثل «كل ما سبق» أو «لا يمكن التحديد».</p>
        )}
      </div>

      {/* 3. الوقت */}
      <div className={card}>
        <h3 className="text-sm font-black text-[#3C3C3C]">3) الوقت</h3>
        <div className="flex gap-2">
          <button type="button" onClick={() => setTiming('none')} className={seg(timing === 'none')}>بدون وقت</button>
          <button type="button" onClick={() => setTiming('perQuestion')} className={seg(timing === 'perQuestion')}>وقت لكل سؤال</button>
          <button type="button" onClick={() => setTiming('total')} className={seg(timing === 'total')}>وقت كلي</button>
        </div>
        {timing === 'perQuestion' && (
          <div className="flex flex-wrap items-center gap-2">
            {[30, 45, 60, 90, 120].map((s) => (
              <button key={s} type="button" onClick={() => setPerQ(String(s))} className={`px-3 py-1.5 rounded-xl border-2 text-xs font-black cursor-pointer ${perQSec === s ? 'bg-[#F5ECFF] border-[#A560E8]' : 'border-[#E5E5E5] bg-white'}`}>{s} ث</button>
            ))}
            <input inputMode="numeric" dir="ltr" className={numInp} value={perQ} onChange={(e) => setPerQ(e.target.value.replace(/[^\d]/g, ''))} />
            <span className="text-xs font-bold text-[#777777]">ثانية لكل سؤال، وينتقل تلقائياً عند انتهائها ولا يمكن الرجوع.</span>
          </div>
        )}
        {timing === 'total' && (
          <div className="flex flex-wrap items-center gap-2">
            {[5, 10, 20, 30, 60].map((m) => (
              <button key={m} type="button" onClick={() => setTotalMin(String(m))} className={`px-3 py-1.5 rounded-xl border-2 text-xs font-black cursor-pointer ${parseFloat(totalMin) === m ? 'bg-[#F5ECFF] border-[#A560E8]' : 'border-[#E5E5E5] bg-white'}`}>{m} د</button>
            ))}
            <input inputMode="decimal" dir="ltr" className={numInp} value={totalMin} onChange={(e) => setTotalMin(e.target.value.replace(/[^\d.]/g, ''))} />
            <span className="text-xs font-bold text-[#777777]">دقيقة للاختبار كاملاً، وينتهي تلقائياً عند انتهائها.</span>
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
          <button type="button" onClick={() => setShowLaws(false)} className={seg(!showLaws)}>
            بدون قوانين (اختبار قياسي)
          </button>
          <button type="button" onClick={() => setShowLaws(true)} className={seg(showLaws)}>
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

      {error && <div className="p-3 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-xs font-extrabold text-[#EA2B2B]">{error}</div>}

      <div className="sticky bottom-2 z-20 flex flex-col gap-1">
        <button
          type="button"
          onClick={start}
          disabled={avail === 0 || launching}
          className="duo-btn flex items-center justify-center gap-2 px-5 py-3 rounded-2xl bg-[#A560E8] hover:bg-[#B57BEE] border-2 border-[#8938D6] border-b-4 text-white text-base font-black cursor-pointer disabled:opacity-50"
        >
          <Play className="w-5 h-5" /> ابدأ الاختبار ({count} سؤال · {describeTiming({ timing, seconds })})
        </button>
      </div>

      {launching && (
        <DuoLoading
          variant="overlay"
          title="جاري تجهيز أسئلة الاختبار والمؤقت..."
          subtitle={`سيتم تحميل ${count} سؤال بالرسومات والأشكال الهندسية`}
          accent="purple"
        />
      )}
    </div>
  );
};
