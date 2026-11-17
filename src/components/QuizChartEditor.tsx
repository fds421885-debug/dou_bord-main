import React, { useEffect, useState } from 'react';
import { PlusCircle, Trash2, X } from 'lucide-react';
import type { ChartType, QuizChart } from '../types';
import { CHART_LIMITS, CHART_TYPE_LABELS, newChart, toNumber } from '../quizChart';
import { ChartView } from './ChartView';

const TYPE_ICON: Record<ChartType, string> = { bar: '📊', hbar: '📶', line: '📈', pie: '🥧' };
const TYPES: ChartType[] = ['bar', 'hbar', 'line', 'pie'];

const inp =
  'w-full rounded-xl border-2 border-[#E5E5E5] focus:border-[#1CB0F6] outline-none px-2 py-1.5 text-xs font-bold text-[#3C3C3C] bg-white';

/** حقل رقمي يقبل الكتابة الحرة (1. أو - أثناء الكتابة) والأرقام العربية. */
const NumInput: React.FC<{ value: number; onCommit: (n: number) => void }> = ({ value, onCommit }) => {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (toNumber(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      dir="ltr"
      inputMode="decimal"
      className={`${inp} font-latin`}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = toNumber(e.target.value);
        if (n !== null) onCommit(n);
        else if (e.target.value.trim() === '') onCommit(0);
      }}
      onBlur={() => setText(String(value))}
    />
  );
};

interface Props {
  chart: QuizChart | undefined;
  onChange: (c: QuizChart | undefined) => void;
  buttonLabel?: string;
  headerTitle?: string;
}

export const QuizChartEditor: React.FC<Props> = ({
  chart,
  onChange,
  buttonLabel = 'إضافة رسم بياني / أعمدة',
  headerTitle = 'الرسم البياني للسؤال',
}) => {
  if (!chart) {
    return (
      <button
        type="button"
        onClick={() => onChange(newChart('bar'))}
        className="self-start flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#F0F9FF] hover:bg-[#E0F4FF] border-2 border-b-4 border-[#1CB0F6] text-xs font-black text-[#1899D6] cursor-pointer active:translate-y-0.5 active:border-b-2 transition-all"
      >
        <PlusCircle className="w-3.5 h-3.5" /> {buttonLabel}
      </button>
    );
  }

  const isPie = chart.type === 'pie';
  const shownSeries = isPie ? chart.series.slice(0, 1) : chart.series;
  const set = (p: Partial<QuizChart>) => onChange({ ...chart, ...p });

  const setLabel = (i: number, v: string) => {
    const labels = chart.labels.slice();
    labels[i] = v;
    set({ labels });
  };
  const setValue = (si: number, i: number, v: number) => {
    const series = chart.series.map((s, k) =>
      k === si ? { ...s, values: s.values.map((x, j) => (j === i ? v : x)) } : s
    );
    set({ series });
  };
  const addRow = () => {
    if (chart.labels.length >= CHART_LIMITS.maxPoints) return;
    set({
      labels: [...chart.labels, ''],
      series: chart.series.map((s) => ({ ...s, values: [...s.values, 0] })),
    });
  };
  const removeRow = (i: number) => {
    if (chart.labels.length <= 1) return;
    set({
      labels: chart.labels.filter((_, k) => k !== i),
      series: chart.series.map((s) => ({ ...s, values: s.values.filter((_, k) => k !== i) })),
    });
  };
  const addSeries = () => {
    if (chart.series.length >= CHART_LIMITS.maxSeries) return;
    set({
      series: [...chart.series, { name: '', values: chart.labels.map(() => 0) }],
    });
  };
  const removeSeries = (si: number) => {
    if (chart.series.length <= 1) return;
    set({ series: chart.series.filter((_, k) => k !== si) });
  };

  const previewReady = chart.labels.length > 0 && chart.series.length > 0;

  return (
    <div className="rounded-2xl border-2 border-[#1CB0F6]/40 bg-[#F0F9FF] p-3 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-black text-[#1899D6]">{headerTitle}</span>
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="flex items-center gap-1 text-[11px] font-black text-[#EA2B2B] cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5" /> إزالة الرسم
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => set({ type: t })}
            className={`px-2 py-2 rounded-xl border-2 text-xs font-black cursor-pointer ${
              chart.type === t
                ? 'bg-[#1CB0F6] border-[#1899D6] text-white'
                : 'bg-white border-[#E5E5E5] text-[#3C3C3C]'
            }`}
          >
            <span className="ml-1">{TYPE_ICON[t]}</span>
            {CHART_TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input className={inp} placeholder="عنوان الرسم (اختياري)" maxLength={CHART_LIMITS.title} value={chart.title} onChange={(e) => set({ title: e.target.value })} />
        {!isPie && (
          <>
            <input className={inp} placeholder="اسم المحور الأفقي" maxLength={CHART_LIMITS.axis} value={chart.xLabel} onChange={(e) => set({ xLabel: e.target.value })} />
            <input className={inp} placeholder="اسم المحور الرأسي (الوحدة)" maxLength={CHART_LIMITS.axis} value={chart.yLabel} onChange={(e) => set({ yLabel: e.target.value })} />
          </>
        )}
      </div>

      {/* جدول القيم */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[340px] border-separate border-spacing-1">
          <thead>
            <tr>
              <th className="text-[11px] font-black text-[#777777] text-right w-[38%]">التسمية</th>
              {shownSeries.map((s, si) => (
                <th key={si} className="text-right">
                  <div className="flex items-center gap-1">
                    <input
                      className={inp}
                      placeholder={isPie ? 'القيمة' : `اسم السلسلة ${si + 1}`}
                      maxLength={CHART_LIMITS.name}
                      value={s.name}
                      onChange={(e) =>
                        set({ series: chart.series.map((x, k) => (k === si ? { ...x, name: e.target.value } : x)) })
                      }
                    />
                    {!isPie && chart.series.length > 1 && (
                      <button type="button" onClick={() => removeSeries(si)} className="text-[#EA2B2B] cursor-pointer" title="حذف السلسلة">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </th>
              ))}
              <th className="w-6" />
            </tr>
          </thead>
          <tbody>
            {chart.labels.map((l, i) => (
              <tr key={i}>
                <td>
                  <input className={inp} placeholder={`تسمية ${i + 1}`} maxLength={CHART_LIMITS.label} value={l} onChange={(e) => setLabel(i, e.target.value)} />
                </td>
                {shownSeries.map((s, si) => (
                  <td key={si}>
                    <NumInput value={s.values[i] ?? 0} onCommit={(n) => setValue(si, i, n)} />
                  </td>
                ))}
                <td>
                  <button type="button" onClick={() => removeRow(i)} disabled={chart.labels.length <= 1} className="text-[#EA2B2B] disabled:opacity-30 cursor-pointer" title="حذف الصف">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3">
        <button type="button" onClick={addRow} disabled={chart.labels.length >= CHART_LIMITS.maxPoints} className="text-xs font-black text-[#1899D6] cursor-pointer disabled:opacity-40">
          + إضافة صف
        </button>
        {!isPie && chart.series.length < CHART_LIMITS.maxSeries && (
          <button type="button" onClick={addSeries} className="text-xs font-black text-[#1899D6] cursor-pointer">
            + إضافة سلسلة قيم
          </button>
        )}
      </div>

      {previewReady && <ChartView chart={chart} />}
    </div>
  );
};
