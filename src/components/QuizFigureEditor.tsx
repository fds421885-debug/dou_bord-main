import React, { useEffect, useState } from 'react';
import { Code2, PlusCircle, Shapes, Sliders, Trash2, X } from 'lucide-react';
import type {
  FigureColor,
  FigureElement,
  FigureLabelPos,
  FigurePoint,
  QuizFigure,
} from '../types';
import {
  buildRegularPolygonPoints,
  createFigureFromPreset,
  FIGURE_COLOR_MAP,
  FIGURE_LIMITS,
  FIGURE_PRESETS,
  parseFigure,
} from '../quizFigure';
import { toNumber } from '../quizChart';
import { FigureView } from './FigureView';

const COLORS: FigureColor[] = ['ink', 'blue', 'green', 'gold', 'purple', 'red', 'gray', 'white'];
const LABEL_POSITIONS: { value: FigureLabelPos; label: string }[] = [
  { value: 'auto', label: 'تلقائي' },
  { value: 'top', label: 'أعلى' },
  { value: 'bottom', label: 'أسفل' },
  { value: 'left', label: 'يسار' },
  { value: 'right', label: 'يمين' },
  { value: 'top-left', label: 'أعلى يسار' },
  { value: 'top-right', label: 'أعلى يمين' },
  { value: 'bottom-left', label: 'أسفل يسار' },
  { value: 'bottom-right', label: 'أسفل يمين' },
];

const inp =
  'w-full rounded-xl border-2 border-[#E5E5E5] focus:border-[#A560E8] outline-none px-2.5 py-1.5 text-xs font-bold text-[#3C3C3C] bg-white';

const NumField: React.FC<{
  value: number;
  onCommit: (n: number) => void;
  className?: string;
  placeholder?: string;
}> = ({ value, onCommit, className = '', placeholder }) => {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (toNumber(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      dir="ltr"
      inputMode="decimal"
      className={`${inp} font-latin ${className}`}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = toNumber(e.target.value);
        if (n !== null) onCommit(n);
      }}
      onBlur={() => setText(String(value))}
    />
  );
};

interface Props {
  figure: QuizFigure | undefined;
  onChange: (f: QuizFigure | undefined) => void;
  buttonLabel?: string;
  headerTitle?: string;
}

export const QuizFigureEditor: React.FC<Props> = ({
  figure,
  onChange,
  buttonLabel = 'إضافة شكل هندسي',
  headerTitle = 'الشكل الهندسي للسؤال',
}) => {
  const [tab, setTab] = useState<'visual' | 'json'>('visual');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [polySides, setPolySides] = useState(5);

  useEffect(() => {
    if (figure && tab === 'json') {
      setJsonText(JSON.stringify(figure, null, 2));
      setJsonError('');
    }
  }, [figure, tab]);

  if (!figure) {
    return (
      <button
        type="button"
        onClick={() => onChange(createFigureFromPreset('triangle_angles'))}
        className="self-start flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#F3E8FF] hover:bg-[#EDE9FE] border-2 border-b-4 border-[#A560E8] text-xs font-black text-[#7C3AED] cursor-pointer active:translate-y-0.5 active:border-b-2 transition-all"
      >
        <Shapes className="w-3.5 h-3.5" /> {buttonLabel}
      </button>
    );
  }

  const update = (patch: Partial<QuizFigure>) => onChange({ ...figure, ...patch });

  const updatePoint = (idx: number, patch: Partial<FigurePoint>) => {
    const next = figure.points.map((p, i) => (i === idx ? { ...p, ...patch } : p));
    update({ points: next });
  };

  const addPoint = () => {
    if (figure.points.length >= FIGURE_LIMITS.maxPoints) return;
    const used = new Set(figure.points.map((p) => p.id));
    let n = figure.points.length + 1;
    while (used.has(`P${n}`)) n++;
    const arabic = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح', 'ط', 'ي'];
    update({
      points: [
        ...figure.points,
        { id: `P${n}`, x: 2, y: 2, label: arabic[figure.points.length] || `P${n}`, dot: true },
      ],
    });
  };

  const removePoint = (id: string) => {
    update({
      points: figure.points.filter((p) => p.id !== id),
      elements: figure.elements.filter((el) => {
        if (el.type === 'polygon') return !el.points.includes(id);
        if (el.type === 'segment') return el.from !== id && el.to !== id;
        if (el.type === 'circle' || el.type === 'arc') return el.center !== id;
        if (el.type === 'angle') return el.a !== id && el.vertex !== id && el.b !== id;
        return true;
      }),
    });
  };

  const updateElement = (idx: number, nextEl: FigureElement) => {
    const elements = figure.elements.map((el, i) => (i === idx ? nextEl : el));
    update({ elements });
  };

  const removeElement = (idx: number) => {
    update({ elements: figure.elements.filter((_, i) => i !== idx) });
  };

  const addQuickSegment = () => {
    if (figure.points.length < 2 || figure.elements.length >= FIGURE_LIMITS.maxElements) return;
    update({
      elements: [
        ...figure.elements,
        { type: 'segment', from: figure.points[0].id, to: figure.points[1].id, stroke: 'ink' },
      ],
    });
  };

  const addQuickAngle = () => {
    if (figure.points.length < 3 || figure.elements.length >= FIGURE_LIMITS.maxElements) return;
    update({
      elements: [
        ...figure.elements,
        {
          type: 'angle',
          a: figure.points[0].id,
          vertex: figure.points[1].id,
          b: figure.points[2].id,
          label: 'س°',
          color: 'red',
          arcs: 1,
        },
      ],
    });
  };

  const addQuickCircle = () => {
    if (figure.points.length < 1 || figure.elements.length >= FIGURE_LIMITS.maxElements) return;
    update({
      elements: [
        ...figure.elements,
        {
          type: 'circle',
          center: figure.points[0].id,
          r: 2.5,
          fill: 'blue',
          fillOpacity: 0.14,
          stroke: 'ink',
          showCenter: true,
        },
      ],
    });
  };

  const addQuickLabel = () => {
    if (figure.elements.length >= FIGURE_LIMITS.maxElements) return;
    update({
      elements: [...figure.elements, { type: 'label', x: 0, y: 0, text: 'س', color: 'red' }],
    });
  };

  const createCustomPolygon = (sides: number) => {
    const pts = buildRegularPolygonPoints(sides, 4);
    onChange({
      title: `مضلع منتظم (${sides} أضلاع)`,
      points: pts,
      elements: [
        {
          type: 'polygon',
          points: pts.map((p) => p.id),
          fill: 'purple',
          fillOpacity: 0.15,
          stroke: 'ink',
          ticks: Array(sides).fill(1),
          sideLabels: ['5 سم', ...Array(sides - 1).fill('')],
        },
        {
          type: 'angle',
          a: pts[pts.length - 1].id,
          vertex: pts[0].id,
          b: pts[1].id,
          label: 'س°',
          color: 'red',
          arcs: 1,
        },
      ],
    });
  };

  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      const res = parseFigure(parsed);
      if (!res.figure) {
        setJsonError('تعذر قراءة الشكل الهندسي من الـ JSON.');
        return;
      }
      setJsonError('');
      onChange(res.figure);
      setTab('visual');
    } catch (e) {
      setJsonError(e instanceof Error ? `خطأ JSON: ${e.message}` : 'صيغة JSON غير صالحة.');
    }
  };

  return (
    <div className="rounded-2xl border-2 border-[#A560E8]/45 bg-[#FAF5FF] p-3.5 flex flex-col gap-3 w-full">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-xl bg-[#A560E8] text-white flex items-center justify-center">
            <Shapes className="w-4 h-4" />
          </span>
          <span className="text-xs sm:text-sm font-black text-[#7C3AED]">{headerTitle}</span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-xl bg-white border-2 border-[#E5E5E5] p-0.5">
            <button
              type="button"
              onClick={() => setTab('visual')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-black cursor-pointer ${
                tab === 'visual' ? 'bg-[#A560E8] text-white' : 'text-[#777777]'
              }`}
            >
              <Sliders className="w-3 h-3" /> التعديل السريع
            </button>
            <button
              type="button"
              onClick={() => {
                setJsonText(JSON.stringify(figure, null, 2));
                setTab('json');
              }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-black cursor-pointer ${
                tab === 'json' ? 'bg-[#A560E8] text-white' : 'text-[#777777]'
              }`}
            >
              <Code2 className="w-3 h-3" /> JSON متقدم
            </button>
          </div>

          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="flex items-center gap-1 text-[11px] font-black text-[#EA2B2B] hover:bg-[#FFDFE0] px-2 py-1 rounded-xl cursor-pointer transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" /> إزالة الشكل
          </button>
        </div>
      </div>

      {/* Presets strip */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-[11px] font-black text-[#7C3AED]">
            قوالب هندسية جاهزة (بسيطة ومركّبة):
          </span>
          <div className="flex items-center gap-1.5 bg-white border-2 border-[#E5E5E5] rounded-xl px-2 py-1">
            <span className="text-[11px] font-extrabold text-[#777777]">مضلع بـ</span>
            <select
              value={polySides}
              onChange={(e) => setPolySides(Number(e.target.value))}
              className="text-xs font-black text-[#3C3C3C] bg-transparent outline-none cursor-pointer"
            >
              {[3, 4, 5, 6, 7, 8, 10].map((n) => (
                <option key={n} value={n}>
                  {n} أضلاع
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => createCustomPolygon(polySides)}
              className="text-[11px] font-black text-[#7C3AED] hover:underline cursor-pointer"
            >
              أنشئ
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5">
          {FIGURE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onChange(createFigureFromPreset(p.id))}
              className="flex items-center gap-1.5 px-2.5 py-2 rounded-xl bg-white hover:bg-[#F3E8FF] border-2 border-b-3 border-[#E5E5E5] hover:border-[#A560E8] text-right cursor-pointer transition-all"
              title={p.desc}
            >
              <span className="w-6 h-6 rounded-lg bg-[#F3E8FF] text-[#7C3AED] flex items-center justify-center text-sm font-black shrink-0">
                {p.badge}
              </span>
              <span className="text-[11px] font-black text-[#3C3C3C] leading-tight truncate">
                {p.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {tab === 'json' ? (
        <div className="flex flex-col gap-2">
          <textarea
            dir="ltr"
            rows={10}
            className={`${inp} font-mono text-[11px] leading-relaxed`}
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
          />
          {jsonError && (
            <p className="text-xs font-extrabold text-[#EA2B2B]">{jsonError}</p>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={applyJson}
              className="duo-btn duo-btn-purple text-xs py-2 px-4"
            >
              تطبيق التعديلات على الشكل
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
          {/* Controls Column */}
          <div className="flex flex-col gap-2.5">
            {/* Title, Caption & Grid */}
            <div className="rounded-xl bg-white border-2 border-[#E5E5E5] p-2.5 flex flex-col gap-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  className={inp}
                  placeholder="عنوان الشكل (اختياري)"
                  maxLength={FIGURE_LIMITS.title}
                  value={figure.title || ''}
                  onChange={(e) => update({ title: e.target.value || undefined })}
                />
                <input
                  className={inp}
                  placeholder="ملاحظة أسفل الشكل (اختياري)"
                  maxLength={FIGURE_LIMITS.caption}
                  value={figure.caption || ''}
                  onChange={(e) => update({ caption: e.target.value || undefined })}
                />
              </div>
              <label className="flex items-center gap-2 text-xs font-extrabold text-[#777777] cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!figure.grid}
                  onChange={(e) => update({ grid: e.target.checked || undefined })}
                  className="accent-[#A560E8]"
                />
                إظهار شبكة الإحداثيات الخلفية
              </label>
            </div>

            {/* Elements quick editor */}
            <div className="rounded-xl bg-white border-2 border-[#E5E5E5] p-2.5 flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <span className="text-xs font-black text-[#3C3C3C]">
                  الأشكال والزوايا ({figure.elements.length})
                </span>
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    onClick={addQuickAngle}
                    className="px-2 py-1 rounded-lg bg-[#FFDFE0] text-[#EA2B2B] text-[11px] font-black cursor-pointer"
                  >
                    + زاوية
                  </button>
                  <button
                    type="button"
                    onClick={addQuickSegment}
                    className="px-2 py-1 rounded-lg bg-[#DDF4FF] text-[#1899D6] text-[11px] font-black cursor-pointer"
                  >
                    + مستقيم
                  </button>
                  <button
                    type="button"
                    onClick={addQuickCircle}
                    className="px-2 py-1 rounded-lg bg-[#D7FFB8] text-[#46A302] text-[11px] font-black cursor-pointer"
                  >
                    + دائرة
                  </button>
                  <button
                    type="button"
                    onClick={addQuickLabel}
                    className="px-2 py-1 rounded-lg bg-[#FFF4CC] text-[#9A6B00] text-[11px] font-black cursor-pointer"
                  >
                    + نص
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-2 max-h-[300px] overflow-y-auto pr-0.5">
                {figure.elements.map((el, idx) => (
                  <div
                    key={idx}
                    className="rounded-xl border-2 border-[#F0F0F0] bg-[#FAFAFA] p-2 flex flex-col gap-1.5"
                  >
                    {el.type === 'angle' && (
                      <>
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[11px] font-black text-[#EA2B2B]">
                            زاوية ∠({el.a} {el.vertex} {el.b})
                          </span>
                          <button
                            type="button"
                            onClick={() => removeElement(idx)}
                            className="text-[#EA2B2B] cursor-pointer"
                            title="حذف العنصر"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                          <input
                            className={inp}
                            placeholder="قياس/مجهول (س°)"
                            maxLength={FIGURE_LIMITS.label}
                            value={el.label || ''}
                            onChange={(e) =>
                              updateElement(idx, { ...el, label: e.target.value || undefined })
                            }
                          />
                          <select
                            className={inp}
                            value={el.color || 'blue'}
                            onChange={(e) =>
                              updateElement(idx, { ...el, color: e.target.value as FigureColor })
                            }
                          >
                            {COLORS.filter((c) => c !== 'white').map((c) => (
                              <option key={c} value={c}>
                                {FIGURE_COLOR_MAP[c].label}
                              </option>
                            ))}
                          </select>
                          <label className="flex items-center gap-1 text-[11px] font-extrabold text-[#3C3C3C] bg-white border-2 border-[#E5E5E5] rounded-xl px-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!!el.right}
                              onChange={(e) =>
                                updateElement(idx, {
                                  ...el,
                                  right: e.target.checked || undefined,
                                })
                              }
                            />
                            قائمة 90°
                          </label>
                          <select
                            className={inp}
                            value={el.arcs ?? 1}
                            disabled={!!el.right}
                            onChange={(e) =>
                              updateElement(idx, { ...el, arcs: Number(e.target.value) })
                            }
                          >
                            <option value={1}>قوس 1</option>
                            <option value={2}>قوسان 2</option>
                            <option value={3}>3 أقواس</option>
                          </select>
                        </div>
                        <div className="grid grid-cols-3 gap-1.5">
                          {(['a', 'vertex', 'b'] as const).map((field) => (
                            <select
                              key={field}
                              className={inp}
                              value={el[field]}
                              onChange={(e) =>
                                updateElement(idx, { ...el, [field]: e.target.value })
                              }
                            >
                              {figure.points.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {field === 'vertex' ? `الرأس: ${p.label || p.id}` : p.label || p.id}
                                </option>
                              ))}
                            </select>
                          ))}
                        </div>
                      </>
                    )}

                    {el.type === 'polygon' && (
                      <>
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[11px] font-black text-[#1899D6]">
                            مضلع ({el.points.length} رؤوس)
                          </span>
                          <button
                            type="button"
                            onClick={() => removeElement(idx)}
                            className="text-[#EA2B2B] cursor-pointer"
                            title="حذف المضلع"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                          <select
                            className={inp}
                            value={el.fill || 'none'}
                            onChange={(e) =>
                              updateElement(idx, {
                                ...el,
                                fill: e.target.value as FigureColor | 'none',
                              })
                            }
                          >
                            <option value="none">تعبئة: بدون</option>
                            {COLORS.map((c) => (
                              <option key={c} value={c}>
                                تعبئة: {FIGURE_COLOR_MAP[c].label}
                              </option>
                            ))}
                          </select>
                          <select
                            className={inp}
                            value={el.stroke || 'ink'}
                            onChange={(e) =>
                              updateElement(idx, { ...el, stroke: e.target.value as FigureColor })
                            }
                          >
                            {COLORS.map((c) => (
                              <option key={c} value={c}>
                                خط: {FIGURE_COLOR_MAP[c].label}
                              </option>
                            ))}
                          </select>
                          <label className="flex items-center gap-1 text-[11px] font-extrabold text-[#3C3C3C] bg-white border-2 border-[#E5E5E5] rounded-xl px-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!!el.dashed}
                              onChange={(e) =>
                                updateElement(idx, {
                                  ...el,
                                  dashed: e.target.checked || undefined,
                                })
                              }
                            />
                            خط متقطع
                          </label>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                          {el.points.map((ptId, edgeIdx) => {
                            const nextId = el.points[(edgeIdx + 1) % el.points.length];
                            const sideVal = el.sideLabels?.[edgeIdx] ?? '';
                            return (
                              <input
                                key={edgeIdx}
                                className={inp}
                                placeholder={`طول ${ptId}${nextId}`}
                                maxLength={FIGURE_LIMITS.label}
                                value={sideVal}
                                onChange={(e) => {
                                  const nextSides = el.points.map(
                                    (_, k) => el.sideLabels?.[k] ?? ''
                                  );
                                  nextSides[edgeIdx] = e.target.value;
                                  updateElement(idx, {
                                    ...el,
                                    sideLabels: nextSides.some(Boolean) ? nextSides : undefined,
                                  });
                                }}
                              />
                            );
                          })}
                        </div>
                      </>
                    )}

                    {el.type === 'segment' && (
                      <>
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[11px] font-black text-[#3C3C3C]">
                            مستقيم / ضلع ({el.from} → {el.to})
                          </span>
                          <button
                            type="button"
                            onClick={() => removeElement(idx)}
                            className="text-[#EA2B2B] cursor-pointer"
                            title="حذف المستقيم"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                          <select
                            className={inp}
                            value={el.from}
                            onChange={(e) => updateElement(idx, { ...el, from: e.target.value })}
                          >
                            {figure.points.map((p) => (
                              <option key={p.id} value={p.id}>
                                من: {p.label || p.id}
                              </option>
                            ))}
                          </select>
                          <select
                            className={inp}
                            value={el.to}
                            onChange={(e) => updateElement(idx, { ...el, to: e.target.value })}
                          >
                            {figure.points.map((p) => (
                              <option key={p.id} value={p.id}>
                                إلى: {p.label || p.id}
                              </option>
                            ))}
                          </select>
                          <input
                            className={inp}
                            placeholder="طول / اسم الضلع"
                            maxLength={FIGURE_LIMITS.label}
                            value={el.label || ''}
                            onChange={(e) =>
                              updateElement(idx, { ...el, label: e.target.value || undefined })
                            }
                          />
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-[11px] font-extrabold text-[#3C3C3C]">
                          <label className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!!el.extendFrom && !!el.extendTo}
                              onChange={(e) =>
                                updateElement(idx, {
                                  ...el,
                                  extendFrom: e.target.checked || undefined,
                                  extendTo: e.target.checked || undefined,
                                })
                              }
                            />
                            مستقيم ممتد بسهمين
                          </label>
                          <label className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!!el.dashed}
                              onChange={(e) =>
                                updateElement(idx, {
                                  ...el,
                                  dashed: e.target.checked || undefined,
                                })
                              }
                            />
                            متقطع
                          </label>
                          <select
                            className="rounded-lg border border-[#E5E5E5] bg-white px-1.5 py-0.5 text-[11px] font-bold"
                            value={el.parallel ?? 0}
                            onChange={(e) =>
                              updateElement(idx, {
                                ...el,
                                parallel: Number(e.target.value) || undefined,
                              })
                            }
                          >
                            <option value={0}>توازي: بلا</option>
                            <option value={1}>توازي ›</option>
                            <option value={2}>توازي ››</option>
                          </select>
                        </div>
                      </>
                    )}

                    {el.type === 'circle' && (
                      <>
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[11px] font-black text-[#46A302]">
                            دائرة (مركز {el.center})
                          </span>
                          <button
                            type="button"
                            onClick={() => removeElement(idx)}
                            className="text-[#EA2B2B] cursor-pointer"
                            title="حذف الدائرة"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                          <select
                            className={inp}
                            value={el.center}
                            onChange={(e) => updateElement(idx, { ...el, center: e.target.value })}
                          >
                            {figure.points.map((p) => (
                              <option key={p.id} value={p.id}>
                                مركز: {p.label || p.id}
                              </option>
                            ))}
                          </select>
                          <NumField
                            value={el.r}
                            placeholder="نق"
                            onCommit={(n) => n > 0 && updateElement(idx, { ...el, r: n })}
                          />
                          <input
                            className={inp}
                            placeholder="نص نصف القطر"
                            maxLength={FIGURE_LIMITS.label}
                            value={el.radiusLabel || ''}
                            onChange={(e) =>
                              updateElement(idx, {
                                ...el,
                                radiusLabel: e.target.value || undefined,
                                radiusAngleDeg: e.target.value ? el.radiusAngleDeg ?? 0 : el.radiusAngleDeg,
                              })
                            }
                          />
                          <select
                            className={inp}
                            value={el.fill || 'none'}
                            onChange={(e) =>
                              updateElement(idx, {
                                ...el,
                                fill: e.target.value as FigureColor | 'none',
                              })
                            }
                          >
                            <option value="none">شفافة</option>
                            {COLORS.map((c) => (
                              <option key={c} value={c}>
                                {FIGURE_COLOR_MAP[c].label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </>
                    )}

                    {el.type === 'arc' && (
                      <>
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[11px] font-black text-[#9A6B00]">
                            قوس / قطاع دائري
                          </span>
                          <button
                            type="button"
                            onClick={() => removeElement(idx)}
                            className="text-[#EA2B2B] cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                          <NumField
                            value={el.startDeg}
                            placeholder="بداية °"
                            onCommit={(n) => updateElement(idx, { ...el, startDeg: n })}
                          />
                          <NumField
                            value={el.endDeg}
                            placeholder="نهاية °"
                            onCommit={(n) => updateElement(idx, { ...el, endDeg: n })}
                          />
                          <input
                            className={inp}
                            placeholder="نص القوس"
                            value={el.label || ''}
                            onChange={(e) =>
                              updateElement(idx, { ...el, label: e.target.value || undefined })
                            }
                          />
                          <label className="flex items-center gap-1 text-[11px] font-extrabold text-[#3C3C3C] bg-white border-2 border-[#E5E5E5] rounded-xl px-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!!el.sector}
                              onChange={(e) =>
                                updateElement(idx, {
                                  ...el,
                                  sector: e.target.checked || undefined,
                                })
                              }
                            />
                            قطاع مظلل
                          </label>
                        </div>
                      </>
                    )}

                    {el.type === 'label' && (
                      <div className="grid grid-cols-4 gap-1.5 items-center">
                        <input
                          className={`${inp} col-span-2`}
                          placeholder="النص (مثل س + 5)"
                          maxLength={FIGURE_LIMITS.label}
                          value={el.text}
                          onChange={(e) => updateElement(idx, { ...el, text: e.target.value })}
                        />
                        <NumField
                          value={el.x}
                          placeholder="x"
                          onCommit={(n) => updateElement(idx, { ...el, x: n })}
                        />
                        <div className="flex items-center gap-1">
                          <NumField
                            value={el.y}
                            placeholder="y"
                            onCommit={(n) => updateElement(idx, { ...el, y: n })}
                          />
                          <button
                            type="button"
                            onClick={() => removeElement(idx)}
                            className="text-[#EA2B2B] cursor-pointer shrink-0"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Points table */}
            <div className="rounded-xl bg-white border-2 border-[#E5E5E5] p-2.5 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-black text-[#3C3C3C]">
                  النقاط والإحداثيات ({figure.points.length})
                </span>
                <button
                  type="button"
                  onClick={addPoint}
                  disabled={figure.points.length >= FIGURE_LIMITS.maxPoints}
                  className="flex items-center gap-1 text-[11px] font-black text-[#7C3AED] hover:underline disabled:opacity-40 cursor-pointer"
                >
                  <PlusCircle className="w-3.5 h-3.5" /> نقطة جديدة
                </button>
              </div>
              <div className="flex flex-col gap-1.5 max-h-[190px] overflow-y-auto pr-0.5">
                {figure.points.map((pt, i) => (
                  <div key={pt.id} className="grid grid-cols-12 gap-1 items-center">
                    <span className="col-span-2 text-[11px] font-black font-latin text-[#777777] text-center truncate">
                      {pt.id}
                    </span>
                    <input
                      className={`${inp} col-span-2 text-center`}
                      placeholder="رمز"
                      maxLength={FIGURE_LIMITS.label}
                      value={pt.label || ''}
                      onChange={(e) => updatePoint(i, { label: e.target.value || undefined })}
                    />
                    <div className="col-span-2">
                      <NumField value={pt.x} onCommit={(n) => updatePoint(i, { x: n })} />
                    </div>
                    <div className="col-span-2">
                      <NumField value={pt.y} onCommit={(n) => updatePoint(i, { y: n })} />
                    </div>
                    <select
                      className={`${inp} col-span-3 text-[10px] px-1`}
                      value={pt.labelPos || 'auto'}
                      onChange={(e) =>
                        updatePoint(i, {
                          labelPos:
                            e.target.value === 'auto'
                              ? undefined
                              : (e.target.value as FigureLabelPos),
                        })
                      }
                    >
                      {LABEL_POSITIONS.map((lp) => (
                        <option key={lp.value} value={lp.value}>
                          {lp.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => removePoint(pt.id)}
                      className="col-span-1 text-[#EA2B2B] flex items-center justify-center cursor-pointer"
                      title="حذف النقطة"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Live Figure Preview */}
          <div className="lg:sticky lg:top-2 flex flex-col gap-2">
            <FigureView figure={figure} compact allowZoom />
          </div>
        </div>
      )}
    </div>
  );
};
