import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Clock, Flag, LogOut } from 'lucide-react';
import type { ExamQuestion, ExamSettings } from '../types';
import { MathText } from '../mathText';
import { ChartView } from './ChartView';
import { formatDuration } from '../exam';
import { saveSessionSnapshot } from '../localDraftStore';

const LETTERS = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح'];

export interface ExamInitialState {
  answers: number[];
  index: number;
  remainingMs: number;
  elapsedMs: number;
}

interface Props {
  ownerId: string;
  settings: ExamSettings;
  questions: ExamQuestion[];
  initial?: ExamInitialState;
  onFinish: (answers: number[], durationSec: number) => void;
  onExit: () => void;
}

export const ExamRunner: React.FC<Props> = ({ ownerId, settings, questions, initial, onFinish, onExit }) => {
  const n = questions.length;
  const timing = settings.timing;
  const allowBack = timing !== 'perQuestion';

  const [index, setIndex] = useState(() => Math.min(initial?.index ?? 0, n - 1));
  const [answers, setAnswers] = useState<number[]>(() =>
    questions.map((_, i) => (Number.isInteger(initial?.answers?.[i]) ? (initial!.answers[i] as number) : -1))
  );
  const [now, setNow] = useState(() => Date.now());
  const [confirm, setConfirm] = useState<null | 'finish' | 'exit'>(null);

  const startRef = useRef(Date.now() - (initial?.elapsedMs ?? 0));
  const deadlineRef = useRef<number>(
    timing === 'none'
      ? 0
      : Date.now() + (initial?.remainingMs ?? settings.seconds * 1000)
  );
  const stateRef = useRef({ index, answers });
  stateRef.current = { index, answers };
  const doneRef = useRef(false);

  const remainingMsNow = () => (timing === 'none' ? 0 : Math.max(0, deadlineRef.current - Date.now()));

  const persist = useCallback(
    (finished: boolean) => {
      void saveSessionSnapshot({
        key: 'exam_session',
        ownerId,
        settings,
        questions,
        answers: stateRef.current.answers,
        index: stateRef.current.index,
        remainingMs: remainingMsNow(),
        elapsedMs: Date.now() - startRef.current,
        finished,
        updatedAt: Date.now(),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ownerId, settings, questions]
  );

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    persist(true);
    onFinish(stateRef.current.answers, (Date.now() - startRef.current) / 1000);
  }, [onFinish, persist]);

  const goNext = useCallback(() => {
    const i = stateRef.current.index;
    if (i >= n - 1) {
      finish();
      return;
    }
    if (timing === 'perQuestion') deadlineRef.current = Date.now() + settings.seconds * 1000;
    setIndex(i + 1);
  }, [finish, n, settings.seconds, timing]);

  // المؤقت
  useEffect(() => {
    const t = window.setInterval(() => {
      setNow(Date.now());
      if (doneRef.current || timing === 'none') return;
      if (Date.now() >= deadlineRef.current) {
        if (timing === 'total') finish();
        else goNext();
      }
    }, 250);
    return () => window.clearInterval(t);
  }, [timing, finish, goNext]);

  // حفظ دوري + عند أي تغيير
  useEffect(() => {
    persist(false);
  }, [index, answers, persist]);
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!doneRef.current) persist(false);
    }, 3000);
    const onHide = () => {
      if (!doneRef.current) persist(false);
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [persist]);

  const q = questions[index];
  const chosen = answers[index];
  const answeredCount = answers.filter((a) => a >= 0).length;
  const remainingSec = timing === 'none' ? 0 : Math.ceil(Math.max(0, deadlineRef.current - now) / 1000);
  const urgent = timing !== 'none' && remainingSec <= (timing === 'perQuestion' ? 10 : 60);
  const pctLeft = timing === 'perQuestion' ? Math.max(0, Math.min(100, (remainingSec / settings.seconds) * 100)) : 0;

  const pick = (ci: number) =>
    setAnswers((a) => a.map((x, i) => (i === index ? (x === ci ? -1 : ci) : x)));

  return (
    <div className="max-w-3xl mx-auto w-full flex flex-col gap-4" dir="rtl">
      {/* الشريط العلوي */}
      <div className="rounded-3xl border-2 border-[#E5E5E5] border-b-4 bg-white p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={() => setConfirm('exit')} className="flex items-center gap-1 text-xs font-black text-[#777777] cursor-pointer">
            <LogOut className="w-4 h-4" /> خروج
          </button>
          <span className="text-xs font-black text-[#3C3C3C]">
            السؤال <span className="font-latin">{index + 1}</span> من <span className="font-latin">{n}</span> · أجبت <span className="font-latin">{answeredCount}</span>
          </span>
          {timing !== 'none' ? (
            <span className={`flex items-center gap-1 px-3 py-1 rounded-full text-sm font-black font-latin border-2 ${urgent ? 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B]' : 'bg-[#F5ECFF] border-[#A560E8] text-[#8938D6]'}`}>
              <Clock className="w-4 h-4" /> {formatDuration(remainingSec)}
            </span>
          ) : (
            <span className="text-[11px] font-extrabold text-[#777777]">بدون وقت</span>
          )}
        </div>
        <div className="h-2 rounded-full bg-[#E5E5E5] overflow-hidden">
          <div className="h-full bg-[#A560E8] transition-all" style={{ width: `${((index + 1) / n) * 100}%` }} />
        </div>
        {timing === 'perQuestion' && (
          <div className="h-1.5 rounded-full bg-[#E5E5E5] overflow-hidden">
            <div className={`h-full ${urgent ? 'bg-[#FF4B4B]' : 'bg-[#1CB0F6]'}`} style={{ width: `${pctLeft}%`, transition: 'width 0.25s linear' }} />
          </div>
        )}
      </div>

      {confirm && (
        <div className="rounded-2xl border-2 border-[#FFC800] bg-[#FFF4CC] p-3 flex flex-col gap-2">
          <p className="text-xs font-extrabold text-[#8A6500]">
            {confirm === 'finish'
              ? answeredCount < n
                ? `باقي ${n - answeredCount} سؤال بلا إجابة. هل تريد إنهاء الاختبار وعرض النتيجة؟`
                : 'هل تريد إنهاء الاختبار وعرض النتيجة؟'
              : 'سيُحفظ تقدمك على جهازك وتستطيع المتابعة لاحقاً من اختباراتي. الخروج الآن؟'}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                if (confirm === 'finish') finish();
                else {
                  persist(false);
                  doneRef.current = true;
                  onExit();
                }
              }}
              className="px-4 py-1.5 rounded-xl bg-[#FFC800] border-2 border-[#E5A400] border-b-4 text-xs font-black text-white cursor-pointer"
            >
              نعم
            </button>
            <button type="button" onClick={() => setConfirm(null)} className="px-4 py-1.5 rounded-xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer">
              لا، أكمل
            </button>
          </div>
        </div>
      )}

      {/* السؤال */}
      <div className="rounded-3xl border-2 border-[#E5E5E5] border-b-4 bg-white p-4 flex flex-col gap-3">
        <MathText text={q.text} className="text-base font-black text-[#3C3C3C] leading-relaxed" />
        {q.chart && <ChartView chart={q.chart} />}
        <div className="flex flex-col gap-2">
          {q.choices.map((c, ci) => (
            <button
              key={ci}
              type="button"
              onClick={() => pick(ci)}
              className={`flex items-center gap-3 px-3 py-3 rounded-2xl border-2 border-b-4 text-right text-sm font-bold cursor-pointer ${
                chosen === ci ? 'bg-[#F5ECFF] border-[#A560E8] text-[#5C1A99]' : 'bg-white border-[#E5E5E5] text-[#3C3C3C] hover:border-[#CE82FF]'
              }`}
            >
              <span className={`w-7 h-7 shrink-0 rounded-full border-2 text-xs font-black flex items-center justify-center ${chosen === ci ? 'bg-[#A560E8] border-[#8938D6] text-white' : 'border-[#E5E5E5] text-[#777777]'}`}>
                {LETTERS[ci] ?? ci + 1}
              </span>
              <MathText text={c} className="flex-1" />
            </button>
          ))}
        </div>
      </div>

      {/* التنقل */}
      <div className="flex items-center gap-2">
        {allowBack && (
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-white border-2 border-[#E5E5E5] border-b-4 text-sm font-black text-[#3C3C3C] cursor-pointer disabled:opacity-40"
          >
            <ArrowRight className="w-4 h-4" /> السابق
          </button>
        )}
        <div className="flex-1" />
        <button type="button" onClick={() => setConfirm('finish')} className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-white border-2 border-[#E5E5E5] border-b-4 text-sm font-black text-[#EA2B2B] cursor-pointer">
          <Flag className="w-4 h-4" /> إنهاء
        </button>
        <button
          type="button"
          onClick={() => (index >= n - 1 ? setConfirm('finish') : goNext())}
          className="flex items-center gap-1.5 px-5 py-2.5 rounded-2xl bg-[#A560E8] border-2 border-[#8938D6] border-b-4 text-sm font-black text-white cursor-pointer"
        >
          {index >= n - 1 ? 'إنهاء الاختبار' : chosen === -1 && timing === 'perQuestion' ? 'تخطي' : 'التالي'} <ArrowLeft className="w-4 h-4" />
        </button>
      </div>

      {/* خريطة الأسئلة */}
      {allowBack && (
        <div className="flex flex-wrap gap-1.5">
          {questions.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIndex(i)}
              className={`w-8 h-8 rounded-lg border-2 text-[11px] font-black font-latin cursor-pointer ${
                i === index ? 'border-[#A560E8] bg-[#A560E8] text-white' : answers[i] >= 0 ? 'border-[#58CC02] bg-[#D7FFB8] text-[#46A302]' : 'border-[#E5E5E5] bg-white text-[#777777]'
              }`}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
