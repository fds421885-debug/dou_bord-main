import React, { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Code2,
  Crosshair,
  Layers,
  Move,
  PlusCircle,
  RotateCcw,
  RotateCw,
  Shapes,
  Sliders,
  Sparkles,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  FigureColor,
  FigureElement,
  FigureLabelPos,
  FigurePoint,
  QuizFigure,
} from '../types';
import {
  addAllPolygonAngles,
  buildRegularPolygonPoints,
  centerElementInside,
  computeAngleDegrees,
  createFigureFromPreset,
  FIGURE_COLOR_MAP,
  FIGURE_LIMITS,
  FIGURE_PRESETS,
  type GeometryShapeKind,
  insertShapeIntoFigure,
  moveElementLayer,
  moveElementPoints,
  parseFigure,
  rotateElementAroundCentroid,
  scaleElementAroundCentroid,
  SHAPE_INSERT_CATALOG,
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

function describeElementShort(el: FigureElement, idx: number): string {
  switch (el.type) {
    case 'polygon':
      return `مضلع (${el.points.length} أضلاع) #${idx + 1}`;
    case 'circle':
      return `دائرة (نق=${el.r}) #${idx + 1}`;
    case 'arc':
      return `${el.sector ? 'قطاع' : 'قوس'} #${idx + 1}`;
    case 'segment':
      return `مستقيم ${el.from}→${el.to}`;
    case 'angle':
      return `زاوية ∠${el.vertex}`;
    case 'label':
      return `نص "${el.text}"`;
  }
}

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

  // Interactive Nested Studio state
  const [editMode, setEditMode] = useState<'shape' | 'point'>('shape');
  const [snapGrid, setSnapGrid] = useState(true);
  const [selectedElementIdx, setSelectedElementIdx] = useState<number | null>(0);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [insertFill, setInsertFill] = useState<FigureColor | 'none'>('blue');
  const [insertNgonSides, setInsertNgonSides] = useState(5);
  const [centerInsideSelected, setCenterInsideSelected] = useState(true);
  const [insertCat, setInsertCat] = useState<'all' | 'polygon' | 'circle' | 'construction'>('all');
  const [insertError, setInsertError] = useState('');

  useEffect(() => {
    if (figure && tab === 'json') {
      setJsonText(JSON.stringify(figure, null, 2));
      setJsonError('');
    }
  }, [figure, tab]);

  useEffect(() => {
    if (!figure) return;
    if (selectedElementIdx !== null && selectedElementIdx >= figure.elements.length) {
      setSelectedElementIdx(figure.elements.length > 0 ? 0 : null);
    }
    if (selectedPointId && !figure.points.some((p) => p.id === selectedPointId)) {
      setSelectedPointId(null);
    }
  }, [figure, selectedElementIdx, selectedPointId]);

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

  const movePointById = (pointId: string, x: number, y: number) => {
    const idx = figure.points.findIndex((p) => p.id === pointId);
    if (idx < 0) return;
    const prev = figure.points[idx];
    if (prev.x === x && prev.y === y) return;
    updatePoint(idx, { x, y });
  };

  const addPoint = () => {
    if (figure.points.length >= FIGURE_LIMITS.maxPoints) return;
    const used = new Set(figure.points.map((p) => p.id));
    let n = figure.points.length + 1;
    while (used.has(`P${n}`)) n++;
    const arabic = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح', 'ط', 'ي'];
    const id = `P${n}`;
    update({
      points: [
        ...figure.points,
        { id, x: 2, y: 2, label: arabic[figure.points.length] || id, dot: true },
      ],
    });
    setSelectedPointId(id);
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
    if (selectedPointId === id) setSelectedPointId(null);
  };

  const updateElement = (idx: number, nextEl: FigureElement) => {
    const elements = figure.elements.map((el, i) => (i === idx ? nextEl : el));
    update({ elements });
  };

  const removeElement = (idx: number) => {
    update({ elements: figure.elements.filter((_, i) => i !== idx) });
    if (selectedElementIdx === idx) setSelectedElementIdx(null);
    else if (selectedElementIdx !== null && selectedElementIdx > idx) {
      setSelectedElementIdx(selectedElementIdx - 1);
    }
  };

  const handleInsertShape = (kind: GeometryShapeKind, sides?: number) => {
    setInsertError('');
    const res = insertShapeIntoFigure(figure, kind, {
      fill: kind === 'cutout_circle' ? 'white' : insertFill,
      sides,
      targetElementIdx: centerInsideSelected ? selectedElementIdx : null,
    });
    if (res.error) {
      setInsertError(res.error);
      return;
    }
    onChange(res.figure);
    if (res.addedElementIdx !== null) {
      setSelectedElementIdx(res.addedElementIdx);
      setSelectedPointId(null);
    }
  };

  const addQuickSegment = () => {
    if (figure.points.length < 2 || figure.elements.length >= FIGURE_LIMITS.maxElements) return;
    const nextEls: FigureElement[] = [
      ...figure.elements,
      { type: 'segment', from: figure.points[0].id, to: figure.points[1].id, stroke: 'ink' },
    ];
    update({ elements: nextEls });
    setSelectedElementIdx(nextEls.length - 1);
  };

  const addQuickAngle = () => {
    if (figure.points.length < 3 || figure.elements.length >= FIGURE_LIMITS.maxElements) return;
    const nextEls: FigureElement[] = [
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
    ];
    update({ elements: nextEls });
    setSelectedElementIdx(nextEls.length - 1);
  };

  const addQuickCircle = () => {
    if (figure.points.length < 1 || figure.elements.length >= FIGURE_LIMITS.maxElements) return;
    const nextEls: FigureElement[] = [
      ...figure.elements,
      {
        type: 'circle',
        center: figure.points[0].id,
        r: 2.5,
        fill: insertFill === 'none' ? 'blue' : insertFill,
        fillOpacity: 0.14,
        stroke: 'ink',
        showCenter: true,
      },
    ];
    update({ elements: nextEls });
    setSelectedElementIdx(nextEls.length - 1);
  };

  const addQuickLabel = () => {
    if (figure.elements.length >= FIGURE_LIMITS.maxElements) return;
    const nextEls: FigureElement[] = [
      ...figure.elements,
      { type: 'label', x: 0, y: 0, text: 'س', color: 'red' },
    ];
    update({ elements: nextEls });
    setSelectedElementIdx(nextEls.length - 1);
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
    setSelectedElementIdx(0);
    setSelectedPointId(null);
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
      setSelectedElementIdx(0);
    } catch (e) {
      setJsonError(e instanceof Error ? `خطأ JSON: ${e.message}` : 'صيغة JSON غير صالحة.');
    }
  };

  const filteredCatalog =
    insertCat === 'all'
      ? SHAPE_INSERT_CATALOG
      : SHAPE_INSERT_CATALOG.filter((item) => item.category === insertCat);

  const selectedElement =
    selectedElementIdx !== null && selectedElementIdx >= 0 && selectedElementIdx < figure.elements.length
      ? figure.elements[selectedElementIdx]
      : null;

  const containerCandidates = figure.elements
    .map((el, idx) => ({ el, idx }))
    .filter(
      ({ el, idx }) =>
        idx !== selectedElementIdx &&
        (el.type === 'polygon' || el.type === 'circle' || el.type === 'arc')
    );

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
              <Sliders className="w-3 h-3" /> التعديل التفاعلي
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
            <span className="text-[11px] font-extrabold text-[#777777]">بدء بمضلع</span>
            <select
              value={polySides}
              onChange={(e) => setPolySides(Number(e.target.value))}
              className="text-xs font-black text-[#3C3C3C] bg-transparent outline-none cursor-pointer"
            >
              {[3, 4, 5, 6, 7, 8, 10, 12].map((n) => (
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

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5 max-h-[168px] overflow-y-auto pr-0.5">
          {FIGURE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                onChange(createFigureFromPreset(p.id));
                setSelectedElementIdx(0);
                setSelectedPointId(null);
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-white hover:bg-[#F3E8FF] border-2 border-b-3 border-[#E5E5E5] hover:border-[#A560E8] text-right cursor-pointer transition-all"
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

      {/* Add Shape Inside Current Figure Studio Bar */}
      {tab === 'visual' && (
        <div className="rounded-xl bg-white border-2 border-[#A560E8]/35 p-2.5 flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-[#A560E8]" />
              <span className="text-xs font-black text-[#3C3C3C]">
                إضافة شكل داخل الشكل الحالي (شكل داخل شكل)
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-[11px] font-extrabold text-[#7C3AED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={centerInsideSelected}
                  onChange={(e) => setCenterInsideSelected(e.target.checked)}
                  className="accent-[#A560E8]"
                />
                توسيط داخل الشكل المحدد
              </label>

              <div className="flex items-center gap-1 bg-[#F7F7F7] border border-[#E5E5E5] rounded-lg px-1.5 py-0.5">
                <span className="text-[10px] font-black text-[#777777]">لون:</span>
                {(['blue', 'green', 'gold', 'purple', 'red', 'white', 'none'] as const).map((c) => {
                  const active = insertFill === c;
                  const swatch =
                    c === 'none'
                      ? 'transparent'
                      : c === 'white'
                      ? '#FFFFFF'
                      : FIGURE_COLOR_MAP[c].fill;
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setInsertFill(c)}
                      title={c === 'none' ? 'شفاف' : FIGURE_COLOR_MAP[c].label}
                      className={`w-4 h-4 rounded-full border cursor-pointer ${
                        active ? 'ring-2 ring-[#A560E8] scale-110' : 'border-[#CBD5E1]'
                      }`}
                      style={{
                        backgroundColor: swatch,
                        backgroundImage:
                          c === 'none'
                            ? 'linear-gradient(45deg, transparent 42%, #EA2B2B 48%, transparent 54%)'
                            : undefined,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          {/* Category filter + Custom N-gon inside */}
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex items-center gap-1 flex-wrap">
              {(
                [
                  { id: 'all', label: 'الكل' },
                  { id: 'polygon', label: 'مضلعات ومثلثات' },
                  { id: 'circle', label: 'دوائر وأقواس' },
                  { id: 'construction', label: 'إنشاءات وأقطار' },
                ] as const
              ).map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setInsertCat(cat.id)}
                  className={`px-2 py-0.5 rounded-lg text-[10px] font-black cursor-pointer transition-colors ${
                    insertCat === cat.id
                      ? 'bg-[#A560E8] text-white'
                      : 'bg-[#F7F7F7] text-[#777777] hover:bg-[#EFEFEF]'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1 bg-[#FAF5FF] border border-[#A560E8]/30 rounded-lg px-2 py-0.5">
              <span className="text-[10px] font-extrabold text-[#7C3AED]">إدراج مضلع:</span>
              <select
                value={insertNgonSides}
                onChange={(e) => setInsertNgonSides(Number(e.target.value))}
                className="text-[11px] font-black text-[#3C3C3C] bg-transparent outline-none cursor-pointer"
              >
                {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>
                    {n} أضلاع
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => handleInsertShape('regular_ngon', insertNgonSides)}
                className="text-[10px] font-black bg-[#A560E8] text-white px-2 py-0.5 rounded-md cursor-pointer"
              >
                + بالداخل
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {filteredCatalog.map((item) => (
              <button
                key={item.kind}
                type="button"
                onClick={() => handleInsertShape(item.kind)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[#FAFAFA] hover:bg-[#F3E8FF] border border-[#E5E5E5] hover:border-[#A560E8] text-[11px] font-black text-[#3C3C3C] cursor-pointer transition-colors"
              >
                <span className="text-xs text-[#7C3AED]">{item.badge}</span>
                <span>+ {item.label}</span>
              </button>
            ))}
          </div>

          {insertError && (
            <p className="text-[11px] font-extrabold text-[#EA2B2B] bg-[#FFDFE0]/60 px-2.5 py-1 rounded-lg">
              {insertError}
            </p>
          )}
        </div>
      )}

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
            {/* Selected Shape Transform Panel */}
            {selectedElement !== null && selectedElementIdx !== null && (
              <div className="rounded-xl bg-white border-2 border-[#A560E8] p-2.5 flex flex-col gap-2 shadow-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-black text-[#7C3AED] flex items-center gap-1.5">
                    <Move className="w-3.5 h-3.5" />
                    تحكم بالشكل المحدد: {describeElementShort(selectedElement, selectedElementIdx)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedElementIdx(null)}
                    className="text-[10px] font-bold text-[#777777] hover:text-[#3C3C3C] cursor-pointer"
                  >
                    إلغاء التحديد
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {/* Nudge arrows */}
                  <div className="flex items-center gap-0.5 bg-[#F7F7F7] rounded-lg p-1 border border-[#E5E5E5]">
                    <button
                      type="button"
                      onClick={() => onChange(moveElementPoints(figure, selectedElementIdx, -0.25, 0))}
                      title="تحريك لليسار"
                      className="p-1 rounded hover:bg-white cursor-pointer text-[#3C3C3C]"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onChange(moveElementPoints(figure, selectedElementIdx, 0, 0.25))}
                      title="تحريك للأعلى"
                      className="p-1 rounded hover:bg-white cursor-pointer text-[#3C3C3C]"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onChange(moveElementPoints(figure, selectedElementIdx, 0, -0.25))}
                      title="تحريك للأسفل"
                      className="p-1 rounded hover:bg-white cursor-pointer text-[#3C3C3C]"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onChange(moveElementPoints(figure, selectedElementIdx, 0.25, 0))}
                      title="تحريك لليمين"
                      className="p-1 rounded hover:bg-white cursor-pointer text-[#3C3C3C]"
                    >
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Scale */}
                  <div className="flex items-center gap-0.5 bg-[#F7F7F7] rounded-lg p-1 border border-[#E5E5E5]">
                    <button
                      type="button"
                      onClick={() => onChange(scaleElementAroundCentroid(figure, selectedElementIdx, 0.9))}
                      title="تصغير 10%"
                      className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-white text-[11px] font-black text-[#3C3C3C] cursor-pointer"
                    >
                      <ZoomOut className="w-3 h-3" /> -10%
                    </button>
                    <button
                      type="button"
                      onClick={() => onChange(scaleElementAroundCentroid(figure, selectedElementIdx, 1.1))}
                      title="تكبير 10%"
                      className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-white text-[11px] font-black text-[#3C3C3C] cursor-pointer"
                    >
                      <ZoomIn className="w-3 h-3" /> +10%
                    </button>
                  </div>

                  {/* Rotate */}
                  <div className="flex items-center gap-0.5 bg-[#F7F7F7] rounded-lg p-1 border border-[#E5E5E5]">
                    <button
                      type="button"
                      onClick={() => onChange(rotateElementAroundCentroid(figure, selectedElementIdx, 15))}
                      title="تدوير عكس الساعة +15°"
                      className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-white text-[11px] font-black text-[#3C3C3C] cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" /> 15°
                    </button>
                    <button
                      type="button"
                      onClick={() => onChange(rotateElementAroundCentroid(figure, selectedElementIdx, -15))}
                      title="تدوير مع الساعة -15°"
                      className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-white text-[11px] font-black text-[#3C3C3C] cursor-pointer"
                    >
                      <RotateCw className="w-3 h-3" /> 15°
                    </button>
                  </div>

                  {/* Layer ordering */}
                  <div className="flex items-center gap-0.5 bg-[#F7F7F7] rounded-lg p-1 border border-[#E5E5E5]">
                    <Layers className="w-3 h-3 text-[#777777] mx-0.5" />
                    <button
                      type="button"
                      disabled={selectedElementIdx >= figure.elements.length - 1}
                      onClick={() => {
                        const res = moveElementLayer(figure, selectedElementIdx, 'up');
                        onChange(res.figure);
                        setSelectedElementIdx(res.newIdx);
                      }}
                      className="px-1.5 py-0.5 rounded hover:bg-white text-[10px] font-black text-[#3C3C3C] disabled:opacity-40 cursor-pointer"
                    >
                      أمام
                    </button>
                    <button
                      type="button"
                      disabled={selectedElementIdx <= 0}
                      onClick={() => {
                        const res = moveElementLayer(figure, selectedElementIdx, 'down');
                        onChange(res.figure);
                        setSelectedElementIdx(res.newIdx);
                      }}
                      className="px-1.5 py-0.5 rounded hover:bg-white text-[10px] font-black text-[#3C3C3C] disabled:opacity-40 cursor-pointer"
                    >
                      خلف
                    </button>
                  </div>
                </div>

                {/* Center inside another shape */}
                {containerCandidates.length > 0 && (
                  <div className="flex items-center gap-1.5 pt-1 border-t border-[#F0F0F0]">
                    <Crosshair className="w-3.5 h-3.5 text-[#1899D6] shrink-0" />
                    <span className="text-[11px] font-extrabold text-[#777777]">توسيط داخل:</span>
                    <select
                      className="flex-1 rounded-lg border border-[#E5E5E5] bg-[#FAFAFA] px-2 py-1 text-[11px] font-black text-[#3C3C3C] cursor-pointer"
                      value=""
                      onChange={(e) => {
                        if (e.target.value === '') return;
                        const tgt = Number(e.target.value);
                        onChange(centerElementInside(figure, selectedElementIdx, tgt));
                      }}
                    >
                      <option value="">اختر الشكل الحاضن للتوسيط بداخله...</option>
                      {containerCandidates.map(({ el, idx }) => (
                        <option key={idx} value={idx}>
                          {describeElementShort(el, idx)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

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
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-0.5">
                <label className="flex items-center gap-2 text-xs font-extrabold text-[#555] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!figure.grid}
                    onChange={(e) => {
                      const nextGrid = e.target.checked;
                      update({
                        grid: nextGrid || undefined,
                        ...(nextGrid && figure.axes === undefined ? { axes: true } : {}),
                        ...(!nextGrid && !figure.axes ? { gridStep: undefined } : {}),
                      });
                    }}
                    className="accent-[#A560E8]"
                  />
                  شبكة الإحداثيات المربعة (1×1)
                </label>

                <label className="flex items-center gap-2 text-xs font-extrabold text-[#555] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={figure.axes ?? !!figure.grid}
                    onChange={(e) => {
                      const nextAxes = e.target.checked;
                      update({
                        axes: nextAxes ? true : figure.grid ? false : undefined,
                      });
                    }}
                    className="accent-[#1CB0F6]"
                  />
                  محاور س و ص المرقّمة
                </label>

                {(figure.grid || figure.axes) && (
                  <div className="flex items-center gap-1.5 text-[11px] font-black text-[#555]">
                    <span>كل خط =</span>
                    {[1, 2, 5].map((st) => {
                      const current = figure.gridStep ?? 1;
                      const active = Math.abs(current - st) < 1e-6;
                      return (
                        <button
                          key={st}
                          type="button"
                          onClick={() => update({ gridStep: st })}
                          className={`px-2 py-0.5 rounded-md border font-latin cursor-pointer ${
                            active
                              ? 'bg-[#1CB0F6] border-[#1899D6] text-white'
                              : 'bg-[#FAFAFA] border-[#E5E5E5] text-[#3C3C3C]'
                          }`}
                        >
                          {st}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
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
                {figure.elements.map((el, idx) => {
                  const isCardSelected = selectedElementIdx === idx;
                  return (
                  <div
                    key={idx}
                    onClick={() => setSelectedElementIdx(idx)}
                    className={`rounded-xl border-2 p-2 flex flex-col gap-1.5 transition-colors cursor-pointer ${
                      isCardSelected
                        ? 'border-[#A560E8] bg-white shadow-xs'
                        : 'border-[#F0F0F0] bg-[#FAFAFA]'
                    }`}
                  >
                    {el.type === 'angle' && (
                      <>
                        <div className="flex items-center justify-between gap-1 flex-wrap">
                          <span className="text-[11px] font-black text-[#EA2B2B]">
                            زاوية ∠({el.a} {el.vertex} {el.b})
                          </span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                const pa = figure.points.find((p) => p.id === el.a);
                                const pv = figure.points.find((p) => p.id === el.vertex);
                                const pb = figure.points.find((p) => p.id === el.b);
                                if (pa && pv && pb) {
                                  const deg = computeAngleDegrees(pa, pv, pb, !!el.reflex);
                                  updateElement(idx, { ...el, label: `${deg}°` });
                                }
                              }}
                              className="px-1.5 py-0.5 rounded bg-[#DDF4FF] text-[#1899D6] text-[10px] font-black cursor-pointer"
                              title="حساب قياس الزاوية الفعلي من إحداثيات النقاط"
                            >
                              احسب الدرجة
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeElement(idx);
                              }}
                              className="text-[#EA2B2B] cursor-pointer"
                              title="حذف العنصر"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
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
                        <div className="flex flex-wrap items-center gap-2 text-[11px] font-extrabold text-[#3C3C3C]">
                          <label className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!!el.reflex}
                              disabled={!!el.right}
                              onChange={(e) =>
                                updateElement(idx, { ...el, reflex: e.target.checked || undefined })
                              }
                            />
                            منعكسة (&gt; 180°)
                          </label>
                          {!el.right && (
                            <label className="flex items-center gap-1.5 flex-1 min-w-[140px]">
                              <span className="text-[10px] text-[#777777]">القوس:</span>
                              <input
                                type="range"
                                min={0.4}
                                max={3.5}
                                step={0.1}
                                value={el.r ?? 1.2}
                                onChange={(e) =>
                                  updateElement(idx, { ...el, r: Number(e.target.value) })
                                }
                                className="flex-1 accent-[#A560E8] cursor-pointer"
                              />
                            </label>
                          )}
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
                        <div className="flex items-center justify-between gap-1 flex-wrap">
                          <span className="text-[11px] font-black text-[#1899D6]">
                            مضلع ({el.points.length} رؤوس)
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onChange(addAllPolygonAngles(figure, idx, { withMeasure: true }));
                              }}
                              className="px-1.5 py-0.5 rounded bg-[#FFDFE0] text-[#EA2B2B] text-[10px] font-black cursor-pointer"
                              title="إضافة جميع الزوايا الداخلية مع حساب قياسها"
                            >
                              + كل الزوايا
                            </button>
                            {el.points.length >= 4 && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const res = insertShapeIntoFigure(figure, 'diagonals', {
                                    targetElementIdx: idx,
                                  });
                                  onChange(res.figure);
                                }}
                                className="px-1.5 py-0.5 rounded bg-[#F3E8FF] text-[#7C3AED] text-[10px] font-black cursor-pointer"
                                title="رسم أقطار هذا المضلع"
                              >
                                + الأقطار
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeElement(idx);
                              }}
                              className="text-[#EA2B2B] cursor-pointer"
                              title="حذف المضلع"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
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
                            onClick={(e) => {
                              e.stopPropagation();
                              removeElement(idx);
                            }}
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
                            onClick={(e) => {
                              e.stopPropagation();
                              removeElement(idx);
                            }}
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
                                fillOpacity: e.target.value === 'white' ? 1 : el.fillOpacity ?? 0.16,
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
                        <div className="flex flex-wrap items-center gap-2 text-[11px] font-extrabold text-[#3C3C3C]">
                          <input
                            className={`${inp} flex-1 min-w-[110px]`}
                            placeholder="نص القطر الكامل (اختياري)"
                            maxLength={FIGURE_LIMITS.label}
                            value={el.diameterLabel || ''}
                            onChange={(e) =>
                              updateElement(idx, {
                                ...el,
                                diameterLabel: e.target.value || undefined,
                                diameterAngleDeg: e.target.value ? el.diameterAngleDeg ?? 0 : el.diameterAngleDeg,
                              })
                            }
                          />
                          <label className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!!el.dashed}
                              onChange={(e) =>
                                updateElement(idx, { ...el, dashed: e.target.checked || undefined })
                              }
                            />
                            متقطعة
                          </label>
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
                            onClick={(e) => {
                              e.stopPropagation();
                              removeElement(idx);
                            }}
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
                            onClick={(e) => {
                              e.stopPropagation();
                              removeElement(idx);
                            }}
                            className="text-[#EA2B2B] cursor-pointer shrink-0"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  );
                })}
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
                  <div
                    key={pt.id}
                    onClick={() => setSelectedPointId(pt.id)}
                    className={`grid grid-cols-12 gap-1 items-center rounded-lg px-1 py-0.5 cursor-pointer ${
                      selectedPointId === pt.id ? 'bg-[#F3E8FF]' : ''
                    }`}
                  >
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
                      onClick={(e) => {
                        e.stopPropagation();
                        removePoint(pt.id);
                      }}
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

          {/* Live Interactive Figure Preview */}
          <div className="lg:sticky lg:top-2 flex flex-col gap-2">
            <div className="rounded-xl bg-white border-2 border-[#E5E5E5] p-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center rounded-lg bg-[#F7F7F7] p-0.5 border border-[#E5E5E5]">
                <button
                  type="button"
                  onClick={() => setEditMode('shape')}
                  className={`px-2 py-1 rounded-md text-[11px] font-black cursor-pointer transition-colors ${
                    editMode === 'shape' ? 'bg-[#A560E8] text-white' : 'text-[#777777]'
                  }`}
                >
                  تحريك شكل كامل
                </button>
                <button
                  type="button"
                  onClick={() => setEditMode('point')}
                  className={`px-2 py-1 rounded-md text-[11px] font-black cursor-pointer transition-colors ${
                    editMode === 'point' ? 'bg-[#1CB0F6] text-white' : 'text-[#777777]'
                  }`}
                >
                  سحب النقاط والزوايا
                </button>
              </div>
              <label className="flex items-center gap-1.5 text-[11px] font-black text-[#3C3C3C] cursor-pointer">
                <input
                  type="checkbox"
                  checked={snapGrid}
                  onChange={(e) => setSnapGrid(e.target.checked)}
                  className="accent-[#A560E8]"
                />
                {figure.grid || figure.axes
                  ? `التقاط للشبكة (${figure.gridStep ?? 1})`
                  : 'التقاط للشبكة (0.25)'}
              </label>
            </div>

            <FigureView
              figure={figure}
              compact
              allowZoom
              interactive
              editMode={editMode}
              snapStep={snapGrid ? (figure.grid || figure.axes ? figure.gridStep ?? 1 : 0.25) : 0}
              selectedElementIdx={selectedElementIdx}
              selectedPointId={selectedPointId}
              onSelectElement={(idx) => {
                setSelectedElementIdx(idx);
                setSelectedPointId(null);
              }}
              onSelectPoint={(id) => setSelectedPointId(id)}
              onMovePoint={movePointById}
              onMoveElement={(elIdx, dx, dy) =>
                onChange(moveElementPoints(figure, elIdx, dx, dy))
              }
            />

            <p className="text-[11px] font-bold text-[#7C3AED] text-center bg-white/80 rounded-xl border border-[#A560E8]/25 px-2.5 py-1.5">
              اسحب أي شكل لتحريكه داخل الأشكال الأخرى، أو اسحب النقاط الدائرية لتعديل الزوايا والرؤوس مباشرة.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

