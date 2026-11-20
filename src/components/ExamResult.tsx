import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, RotateCcw, CheckCircle2, RefreshCw } from 'lucide-react';
import type { ExamQuestion, ExamSettings } from '../types';
import { buildAttempt, saveAttempt, scoreExam } from '../exam';
import { deleteSessionSnapshot } from '../localDraftStore';
import { ExamReview } from './ExamReview';
import { DuoLoading } from './DuoLoading';

interface Props {
  ownerId: string;
  attemptId: string;
  settings: ExamSettings;
  questions: ExamQuestion[];
  answers: number[];
  tableAnswers?: Record<string, Record<string, string>>;
  durationSec: number;
  finishedAt: number;
  onBack: () => void;
  onRetake: () => void;
  onCreateDrill?: (question: ExamQuestion) => void;
}

export const ExamResult: React.FC<Props> = ({
  ownerId,
  attemptId,
  settings,
  questions,
  answers,
  tableAnswers,
  durationSec,
  finishedAt,
  onBack,
  onRetake,
  onCreateDrill,
}) => {
  const [state, setState] = useState<'saving' | 'saved' | 'failed'>('saving');
  const [err, setErr] = useState<string | null>(null);
  const started = useRef(false);

  const score = scoreExam(questions, answers, tableAnswers);

  const save = async () => {
    setState('saving');
    setErr(null);
    try {
      await saveAttempt(
        buildAttempt(ownerId, attemptId, settings, questions, answers, durationSec, finishedAt, tableAnswers)
      );
      await deleteSessionSnapshot('exam_session');
      setState('saved');
    } catch (e) {
      const raw = e instanceof Error ? e.message : '';
      setErr(
        /permission/i.test(raw)
          ? 'قاعدة البيانات رفضت الحفظ لأن قواعد الأمان (firestore.rules) لم تُحدَّث بعد. انشرها ثم اضغط إعادة الحفظ — نتيجتك محفوظة على جهازك.'
          : /quota|exhausted/i.test(raw)
          ? 'حصة قاعدة البيانات منتهية مؤقتاً. نتيجتك محفوظة على جهازك، أعد الحفظ لاحقاً.'
          : 'تعذر الحفظ الآن. نتيجتك محفوظة على جهازك، أعد المحاولة.'
      );
      setState('failed');
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void save();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="max-w-3xl mx-auto w-full flex flex-col gap-4" dir="rtl">
      <button type="button" onClick={onBack} className="self-start flex items-center gap-1 text-xs font-black text-[#777777] cursor-pointer">
        <ArrowRight className="w-4 h-4" /> العودة إلى اختباراتي
      </button>
      <h2 className="text-lg font-black text-[#3C3C3C]">نتيجة الاختبار</h2>

      {state === 'saving' && (
        <DuoLoading
          variant="inline"
          title="جاري حفظ نتيجتك ومراجعة الأسئلة في حسابك..."
          subtitle="تُحفظ الإجابات والزمن والإحصائيات بأمان في قاعدة البيانات"
          accent="green"
        />
      )}
      {state === 'saved' && (
        <div className="flex items-center gap-2 p-3 rounded-2xl bg-[#D7FFB8] border-2 border-[#58CC02] text-xs font-extrabold text-[#46A302]">
          <CheckCircle2 className="w-4 h-4" /> تم حفظ المحاولة، تجدها دائماً في «محاولاتي السابقة» لتراجعها.
        </div>
      )}
      {state === 'failed' && (
        <div className="p-3 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-xs font-extrabold text-[#EA2B2B] flex flex-col gap-2">
          <span>{err}</span>
          <button type="button" onClick={() => void save()} className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#FF4B4B] text-white text-xs font-black cursor-pointer">
            <RefreshCw className="w-3.5 h-3.5" /> إعادة الحفظ
          </button>
        </div>
      )}

      <ExamReview
        ownerId={ownerId}
        questions={questions}
        answers={answers}
        tableAnswers={tableAnswers}
        score={score}
        total={questions.length}
        durationSec={durationSec}
        onCreateDrill={onCreateDrill}
      />

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onRetake} className="duo-btn flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#A560E8] border-2 border-[#8938D6] border-b-4 text-white text-sm font-black cursor-pointer">
          <RotateCcw className="w-4 h-4" /> اختبار جديد
        </button>
        <button type="button" onClick={onBack} className="px-5 py-2.5 rounded-2xl bg-white border-2 border-[#E5E5E5] border-b-4 text-sm font-black text-[#3C3C3C] cursor-pointer">
          اختباراتي
        </button>
      </div>
    </div>
  );
};
