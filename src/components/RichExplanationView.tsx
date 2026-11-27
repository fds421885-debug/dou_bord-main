import React from 'react';
import { Lightbulb, Scale, Table2 } from 'lucide-react';
import type { ExplanationComparison, ExplanationTable, QuizChart, QuizFigure } from '../types';
import { MathText } from '../mathText';
import { parseMarkdownTextBlocks } from '../markdownTable';
import { unwrapRowArray } from '../quizTable';
import { ChartView } from './ChartView';
import { DataTableView } from './DataTableView';
import { FigureView } from './FigureView';

interface Props {
  explanation?: string;
  explanationTable?: ExplanationTable;
  explanationComparison?: ExplanationComparison;
  explanationChart?: QuizChart;
  explanationFigure?: QuizFigure;
}

export const RichExplanationView: React.FC<Props> = ({
  explanation,
  explanationTable,
  explanationComparison,
  explanationChart,
  explanationFigure,
}) => {
  const hasAny = Boolean(
    explanation?.trim() ||
      explanationTable ||
      explanationComparison ||
      explanationChart ||
      explanationFigure
  );
  if (!hasAny) return null;

  const blocks = explanation?.trim() ? parseMarkdownTextBlocks(explanation) : [];

  return (
    <div
      className="px-3.5 py-3 rounded-2xl bg-[#F7F9FC] border-2 border-[#E5E5E5] text-xs sm:text-sm font-bold text-[#3C3C3C] flex flex-col gap-3"
      dir="rtl"
    >
      <div className="flex items-center gap-1.5 font-black text-[#1899D6] text-xs">
        <Lightbulb className="w-4 h-4 shrink-0" />
        <span>شرح الحل التفصيلي:</span>
      </div>

      {blocks.map((b, idx) =>
        b.kind === 'text' ? (
          <MathText key={idx} text={b.text} className="leading-relaxed" />
        ) : (
          <DataTableView key={idx} table={b.table} compact />
        )
      )}

      {explanationComparison && (
        <div className="rounded-2xl border-2 border-[#CE82FF]/60 bg-[#FAF5FF] p-3 flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-xs font-black text-[#8938D6]">
            <Scale className="w-4 h-4 shrink-0" />
            <span>{explanationComparison.title || 'مقارنة القيمتين'}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="rounded-xl bg-white border border-[#E2D4F8] p-2.5 flex flex-col gap-1">
              <span className="text-[11px] font-black text-[#777777]">
                <MathText text={explanationComparison.firstLabel} />
              </span>
              <span className="text-sm font-black text-[#3C3C3C]">
                <MathText text={explanationComparison.firstValue} />
              </span>
            </div>
            <div className="rounded-xl bg-white border border-[#E2D4F8] p-2.5 flex flex-col gap-1">
              <span className="text-[11px] font-black text-[#777777]">
                <MathText text={explanationComparison.secondLabel} />
              </span>
              <span className="text-sm font-black text-[#3C3C3C]">
                <MathText text={explanationComparison.secondValue} />
              </span>
            </div>
          </div>
          {explanationComparison.verdict && (
            <div className="rounded-xl bg-[#D7FFB8]/65 border border-[#58CC02] px-3 py-1.5 text-xs font-black text-[#46A302]">
              <MathText text={explanationComparison.verdict} />
            </div>
          )}
        </div>
      )}

      {explanationTable && (
        <div className="flex flex-col gap-1.5">
          {explanationTable.title && (
            <div className="flex items-center gap-1.5 text-xs font-black text-[#0E6BA8]">
              <Table2 className="w-4 h-4 shrink-0" />
              <MathText text={explanationTable.title} />
            </div>
          )}
          <div className="w-full overflow-x-auto rounded-2xl border border-[#D0E7F9] bg-white">
            <table className="w-full border-collapse text-xs">
              {explanationTable.headers.some((h) => h.trim().length > 0) && (
                <thead>
                  <tr className="bg-[#DDF4FF] border-b border-[#BCE3FA]">
                    {explanationTable.headers.map((h, hi) => (
                      <th
                        key={hi}
                        className="px-3 py-2 text-right font-black text-[#0E6BA8] border-l last:border-l-0 border-[#BCE3FA]"
                      >
                        <MathText text={h} />
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {explanationTable.rows.map((rawRow, ri) => {
                  const cells = unwrapRowArray(rawRow) as string[];
                  return (
                    <tr key={ri} className="border-b last:border-b-0 border-[#E5E5E5] even:bg-[#FAFAFA]">
                      {cells.map((cell, ci) => (
                        <td
                          key={ci}
                          className="px-3 py-2 text-right font-bold text-[#3C3C3C] border-l last:border-l-0 border-[#E5E5E5]"
                        >
                          <MathText text={String(cell ?? '')} />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {explanationChart && <ChartView chart={explanationChart} />}
      {explanationFigure && <FigureView figure={explanationFigure} />}
    </div>
  );
};
