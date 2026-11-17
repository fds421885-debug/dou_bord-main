import React, { useState } from 'react';
import { CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import type { ExamQuestion } from '../types';
import { MathText } from '../mathText';
import { ChartView } from './ChartView';
import { FigureView } from './FigureView';
import { formatDuration } from '../exam';

const LETTERS = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح'];

interface Props {
  questions: ExamQuestion[];
  answers: number[];
  score: number;
  total: number;
  durationSec: number;
}

export const ExamScoreCard: React.FC<Pick<Props, 'score' | 'total' | 'durationSec'>> = ({ score, total, durationSec }) => {
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const tone =
    pct >= 85 ? 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]' : pct >= 50 ? 'bg-[#FFF4CC] border-[#FFC800] text-[#8A6500]' : 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B]';
  return (
    <div className={`rounded-3xl border-2 border-b-4 p-5 flex items-center justify-between gap-3 ${tone}`}>
      <div>
        <div dir="ltr" className="text-3xl font-black font-latin text-right">{score} / {total}</div>
        <div className="text-xs font-extrabold">الدرجة {pct}%</div>
      </div>
      <div className="text-left text-xs font-extrabold">
        <div>⏱ المدة</div>
        <div className="text-lg font-black font-latin">{formatDuration(durationSec)}</div>
      </div>
    </div>
  );
};

export const ExamReview: React.FC<Props> = ({ questions, answers, score, total, durationSec }) => {
  const [onlyWrong, setOnlyWrong] = useState(false);
  const wrongCount = questions.filter((q, i) => answers[i] !== q.correctIndex).length;

  return (
    <div className="flex flex-col gap-4" dir="rtl">
      <ExamScoreCard score={score} total={total} durationSec={durationSec} />

      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-black text-[#3C3C3C]">مراجعة الأسئلة</h3>
        <button
          type="button"
          onClick={() => setOnlyWrong((v) => !v)}
          disabled={wrongCount === 0}
          className={`px-3 py-1.5 rounded-xl border-2 text-xs font-black cursor-pointer disabled:opacity-40 ${
            onlyWrong ? 'bg-[#FF4B4B] border-[#EA2B2B] text-white' : 'bg-white border-[#E5E5E5] text-[#3C3C3C]'
          }`}
        >
          {onlyWrong ? 'عرض الكل' : `الأخطاء وغير المجاب فقط (${wrongCount})`}
        </button>
      </div>

      {questions.map((q, i) => {
        const chosen = answers[i] ?? -1;
        const right = chosen === q.correctIndex;
        if (onlyWrong && right) return null;
        const Icon = right ? CheckCircle2 : chosen === -1 ? MinusCircle : XCircle;
        const tone = right ? 'text-[#46A302]' : chosen === -1 ? 'text-[#777777]' : 'text-[#EA2B2B]';
        return (
          <div key={q.id + i} className="rounded-3xl border-2 border-[#E5E5E5] border-b-4 bg-white p-4 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="px-3 py-1 rounded-full bg-[#DDF4FF] text-[#1899D6] text-xs font-black">السؤال {i + 1}</span>
              <span className={`flex items-center gap-1 text-xs font-black ${tone}`}>
                <Icon className="w-4 h-4" />
                {right ? 'صحيحة' : chosen === -1 ? 'بلا إجابة' : 'خاطئة'}
              </span>
            </div>
            {q.sourceTitle && <div className="text-[10px] font-extrabold text-[#777777]">من: {q.sourceTitle}</div>}
            <MathText text={q.text} className="text-sm font-black text-[#3C3C3C]" />
            {q.chart && <ChartView chart={q.chart} />}
            {q.figure && <FigureView figure={q.figure} />}
            <div className="flex flex-col gap-1.5">
              {q.choices.map((c, ci) => {
                const isCorrect = ci === q.correctIndex;
                const isWrongPick = ci === chosen && !isCorrect;
                return (
                  <div
                    key={ci}
                    className={`flex items-center gap-2 px-3 py-2 rounded-2xl border-2 text-sm font-bold ${
                      isCorrect
                        ? 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                        : isWrongPick
                        ? 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B]'
                        : 'bg-white border-[#E5E5E5] text-[#3C3C3C]'
                    }`}
                  >
                    <span className="w-6 h-6 shrink-0 rounded-full bg-white/70 border border-current text-[11px] font-black flex items-center justify-center">
                      {LETTERS[ci] ?? ci + 1}
                    </span>
                    <MathText text={c} className="flex-1" />
                    {isCorrect && <span className="text-[10px] font-black">الصحيحة</span>}
                    {isWrongPick && <span className="text-[10px] font-black">إجابتك</span>}
                  </div>
                );
              })}
            </div>
            {(q.explanation || q.explanationChart || q.explanationFigure) && (
              <div className="px-3.5 py-2.5 rounded-2xl bg-[#F7F7F7] border border-[#E5E5E5] text-xs sm:text-sm font-bold text-[#3C3C3C] flex flex-col gap-2">
                <span className="font-black text-[#777777] text-[11px]">شرح الإجابة:</span>
                {q.explanation && <MathText text={q.explanation} />}
                {q.explanationChart && <ChartView chart={q.explanationChart} />}
                {q.explanationFigure && <FigureView figure={q.explanationFigure} />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
