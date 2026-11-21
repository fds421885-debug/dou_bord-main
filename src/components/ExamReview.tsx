import React, { useEffect, useState } from 'react';
import { CheckCircle2, Dumbbell, MinusCircle, Star, XCircle } from 'lucide-react';
import type { ExamQuestion } from '../types';
import { MathText } from '../mathText';
import { ChartView } from './ChartView';
import { FigureView } from './FigureView';
import { QuestionLawsBox } from './QuestionLawsBox';
import { QuestionTableView } from './QuestionTableView';
import { RichExplanationView } from './RichExplanationView';
import { formatDuration, isQuestionAnswered, isQuestionCorrect } from '../exam';
import {
  computeStarredQuestionId,
  subscribeStarredQuestions,
  toggleStarredQuestion,
} from '../starredQuestions';

const LETTERS = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح'];

interface Props {
  ownerId?: string;
  questions: ExamQuestion[];
  answers: number[];
  tableAnswers?: Record<string, Record<string, string>>;
  score: number;
  total: number;
  durationSec: number;
  onCreateDrill?: (question: ExamQuestion) => void;
}

export const ExamScoreCard: React.FC<Pick<Props, 'score' | 'total' | 'durationSec'>> = ({
  score,
  total,
  durationSec,
}) => {
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const tone =
    pct >= 85
      ? 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
      : pct >= 50
      ? 'bg-[#FFF4CC] border-[#FFC800] text-[#8A6500]'
      : 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B]';
  return (
    <div className={`rounded-3xl border-2 border-b-4 p-5 flex items-center justify-between gap-3 ${tone}`}>
      <div>
        <div dir="ltr" className="text-3xl font-black font-latin text-right">
          {score} / {total}
        </div>
        <div className="text-xs font-extrabold">الدرجة {pct}%</div>
      </div>
      <div className="text-left text-xs font-extrabold">
        <div>⏱ المدة</div>
        <div className="text-lg font-black font-latin">{formatDuration(durationSec)}</div>
      </div>
    </div>
  );
};

export const ExamReview: React.FC<Props> = ({
  ownerId,
  questions,
  answers,
  tableAnswers,
  score,
  total,
  durationSec,
  onCreateDrill,
}) => {
  const [onlyWrong, setOnlyWrong] = useState(false);
  const [starredIds, setStarredIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!ownerId) return;
    return subscribeStarredQuestions(ownerId, (items) => {
      setStarredIds(new Set(items.map((x) => x.id)));
    });
  }, [ownerId]);

  const wrongCount = questions.filter(
    (q, i) => !isQuestionCorrect(q, i, answers, tableAnswers)
  ).length;

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
            onlyWrong
              ? 'bg-[#FF4B4B] border-[#EA2B2B] text-white'
              : 'bg-white border-[#E5E5E5] text-[#3C3C3C]'
          }`}
        >
          {onlyWrong ? 'عرض الكل' : `الأخطاء وغير المجاب فقط (${wrongCount})`}
        </button>
      </div>

      {questions.map((q, i) => {
        const chosen = answers[i] ?? -1;
        const answered = isQuestionAnswered(q, i, answers, tableAnswers);
        const right = isQuestionCorrect(q, i, answers, tableAnswers);
        if (onlyWrong && right) return null;
        const Icon = right ? CheckCircle2 : !answered ? MinusCircle : XCircle;
        const tone = right ? 'text-[#46A302]' : !answered ? 'text-[#777777]' : 'text-[#EA2B2B]';
        const isTable = q.questionType === 'table' || Boolean(q.table);
        const qStarId = computeStarredQuestionId(q);
        const isStarred = starredIds.has(qStarId);

        return (
          <div
            key={q.id + i}
            className="rounded-3xl border-2 border-[#E5E5E5] border-b-4 bg-white p-4 flex flex-col gap-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="px-3 py-1 rounded-full bg-[#DDF4FF] text-[#1899D6] text-xs font-black">
                  السؤال {i + 1}
                </span>
                <span className={`flex items-center gap-1 text-xs font-black ${tone}`}>
                  <Icon className="w-4 h-4" />
                  {right ? 'صحيحة' : !answered ? 'بلا إجابة' : 'خاطئة'}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {onCreateDrill && (
                  <button
                    type="button"
                    onClick={() => onCreateDrill(q)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-xl border-2 border-[#A560E8]/60 bg-[#F5ECFF] text-[11px] font-black text-[#8938D6] hover:border-[#8938D6] cursor-pointer"
                    title="إنشاء اختبار تقوية مخصص على هذه المسألة"
                  >
                    <Dumbbell className="w-3.5 h-3.5" />
                    <span>اختبار تقوية</span>
                  </button>
                )}
                {ownerId && (
                  <button
                    type="button"
                    onClick={async () => {
                      const res = await toggleStarredQuestion({
                        ownerId,
                        question: q,
                        currentlyStarred: isStarred,
                        sourceQuizId: q.sourceQuizId,
                        sourceTitle: q.sourceTitle,
                      });
                      setStarredIds((prev) => {
                        const next = new Set(prev);
                        if (res.starred) next.add(res.id);
                        else next.delete(res.id);
                        return next;
                      });
                    }}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-xl border-2 text-[11px] font-black cursor-pointer ${
                      isStarred
                        ? 'bg-[#FFF4CC] border-[#FFC800] text-[#9A6B00]'
                        : 'bg-white border-[#E5E5E5] text-[#777777] hover:border-[#FFC800]'
                    }`}
                  >
                    <Star
                      className={`w-3.5 h-3.5 ${isStarred ? 'fill-[#FFC800] text-[#E5A400]' : ''}`}
                    />
                    <span>{isStarred ? 'مميز ★' : 'تمييز'}</span>
                  </button>
                )}
              </div>
            </div>

            {q.sourceTitle && (
              <div className="text-[10px] font-extrabold text-[#777777]">من: {q.sourceTitle}</div>
            )}
            {q.laws && q.laws.length > 0 && (
              <QuestionLawsBox laws={q.laws} variant="review" compact />
            )}
            <MathText text={q.text} className="text-sm font-black text-[#3C3C3C]" />
            {q.chart && <ChartView chart={q.chart} />}
            {q.figure && <FigureView figure={q.figure} />}

            {isTable && q.table ? (
              <QuestionTableView
                table={q.table}
                mode="review"
                answers={tableAnswers?.[String(i)] ?? {}}
              />
            ) : (
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
            )}

            {(q.explanation ||
              q.explanationTable ||
              q.explanationComparison ||
              q.explanationChart ||
              q.explanationFigure) && (
              <RichExplanationView
                explanation={q.explanation}
                explanationTable={q.explanationTable}
                explanationComparison={q.explanationComparison}
                explanationChart={q.explanationChart}
                explanationFigure={q.explanationFigure}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};
