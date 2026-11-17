import type {
  FigureColor,
  FigureElement,
  FigureLabelPos,
  FigurePoint,
  QuizFigure,
} from './types';
import { toNumber } from './quizChart';

export const FIGURE_LIMITS = {
  maxPoints: 40,
  maxElements: 40,
  title: 100,
  caption: 160,
  label: 40,
  id: 24,
  coordAbs: 10000,
} as const;

export const FIGURE_COLOR_MAP: Record<
  FigureColor,
  { stroke: string; fill: string; text: string; label: string }
> = {
  ink: { stroke: '#3C3C3C', fill: '#E5E5E5', text: '#3C3C3C', label: 'أسود داكن' },
  blue: { stroke: '#1CB0F6', fill: '#DDF4FF', text: '#1899D6', label: 'أزرق' },
  green: { stroke: '#58CC02', fill: '#D7FFB8', text: '#46A302', label: 'أخضر' },
  gold: { stroke: '#E5A400', fill: '#FFF4CC', text: '#9A6B00', label: 'ذهبي' },
  purple: { stroke: '#A560E8', fill: '#F3E8FF', text: '#7C3AED', label: 'بنفسجي' },
  red: { stroke: '#FF4B4B', fill: '#FFDFE0', text: '#EA2B2B', label: 'أحمر' },
  gray: { stroke: '#9CA3AF', fill: '#F3F4F6', text: '#6B7280', label: 'رمادي' },
  white: { stroke: '#FFFFFF', fill: '#FFFFFF', text: '#3C3C3C', label: 'أبيض (تفريغ)' },
};

const VALID_COLORS = new Set<FigureColor>([
  'ink',
  'blue',
  'green',
  'gold',
  'purple',
  'red',
  'gray',
  'white',
]);

const COLOR_ALIASES: Record<string, FigureColor> = {
  ink: 'ink',
  black: 'ink',
  dark: 'ink',
  '#3c3c3c': 'ink',
  blue: 'blue',
  cyan: 'blue',
  sky: 'blue',
  '#1cb0f6': 'blue',
  green: 'green',
  emerald: 'green',
  '#58cc02': 'green',
  gold: 'gold',
  yellow: 'gold',
  amber: 'gold',
  orange: 'gold',
  '#ffc800': 'gold',
  purple: 'purple',
  violet: 'purple',
  '#a560e8': 'purple',
  red: 'red',
  crimson: 'red',
  '#ff4b4b': 'red',
  gray: 'gray',
  grey: 'gray',
  muted: 'gray',
  white: 'white',
  '#ffffff': 'white',
};

const LABEL_POS_SET = new Set<FigureLabelPos>([
  'auto',
  'top',
  'bottom',
  'left',
  'right',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
]);

function normColor(v: unknown, fallback: FigureColor = 'ink'): FigureColor {
  if (typeof v !== 'string') return fallback;
  const k = v.trim().toLowerCase();
  if (VALID_COLORS.has(k as FigureColor)) return k as FigureColor;
  return COLOR_ALIASES[k] ?? fallback;
}

function normFill(v: unknown): FigureColor | 'none' | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string' && v.trim().toLowerCase() === 'none') return 'none';
  return normColor(v, 'blue');
}

function clampCoord(n: number): number {
  return Math.max(-FIGURE_LIMITS.coordAbs, Math.min(FIGURE_LIMITS.coordAbs, +n.toFixed(4)));
}

function cleanStr(v: unknown, max: number): string {
  if (typeof v === 'string') return v.trim().slice(0, max);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v).slice(0, max);
  return '';
}

function cleanId(v: unknown): string {
  return cleanStr(v, FIGURE_LIMITS.id);
}

/** يحوّل صيغ LaTeX الشائعة إلى رموز واضحة قابلة للرسم بدقة داخل SVG */
export function formatFigureLabel(raw: string): string {
  if (!raw) return '';
  let s = raw.trim();
  // إزالة محددات الدولار والأقواس الرياضية فقط دون كسر النص
  s = s.replace(/\$\$/g, '').replace(/\$/g, '').replace(/\\\(|\\\)/g, '');
  s = s.replace(/\^\{\\circ\}|\\circ|\\degree/g, '°');
  s = s.replace(/\\pi(?![a-zA-Z])/g, 'π');
  s = s.replace(/\\theta(?![a-zA-Z])/g, 'θ');
  s = s.replace(/\\alpha(?![a-zA-Z])/g, 'α');
  s = s.replace(/\\beta(?![a-zA-Z])/g, 'β');
  s = s.replace(/\\gamma(?![a-zA-Z])/g, 'γ');
  s = s.replace(/\\Delta(?![a-zA-Z])/g, 'Δ');
  s = s.replace(/\\times(?![a-zA-Z])/g, '×');
  s = s.replace(/\\div(?![a-zA-Z])/g, '÷');
  s = s.replace(/\\pm(?![a-zA-Z])/g, '±');
  s = s.replace(/\\leq(?![a-zA-Z])/g, '≤');
  s = s.replace(/\\geq(?![a-zA-Z])/g, '≥');
  s = s.replace(/\\neq(?![a-zA-Z])/g, '≠');
  s = s.replace(/\\approx(?![a-zA-Z])/g, '≈');
  s = s.replace(/\\angle(?![a-zA-Z])/g, '∠');
  s = s.replace(/\\triangle(?![a-zA-Z])/g, '△');
  s = s.replace(/\\perp(?![a-zA-Z])/g, '⊥');
  s = s.replace(/\\parallel(?![a-zA-Z])/g, '∥');
  s = s.replace(/\\cdot(?![a-zA-Z])/g, '·');
  // كسور \frac{a}{b} -> a/b
  s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2');
  // جذور \sqrt[3]{x} و \sqrt{x}
  s = s.replace(/\\sqrt\[3\]\{([^{}]+)\}/g, '∛($1)');
  s = s.replace(/\\sqrt\{([^{}]+)\}/g, '√$1');
  // \overline{AB} -> AB
  s = s.replace(/\\(?:overline|vec|text|textbf)\{([^{}]+)\}/g, '$1');
  // أسس بسيطة شائعة ^{2}, ^{3}, ^{n}
  s = s.replace(/\^\{2\}|\^2(?![0-9])/g, '²');
  s = s.replace(/\^\{3\}|\^3(?![0-9])/g, '³');
  s = s.replace(/\^\{([^{}]+)\}/g, '^$1');
  s = s.replace(/_\{([^{}]+)\}/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

/** قراءة متسامحة لشكل هندسي من JSON أو قاعدة البيانات */
export function parseFigure(input: unknown): { figure: QuizFigure | null; warnings: string[] } {
  const warnings: string[] = [];
  if (!input || typeof input !== 'object') return { figure: null, warnings };
  const o = input as Record<string, unknown>;

  const rawPoints = Array.isArray(o.points)
    ? o.points
    : Array.isArray(o.vertices)
    ? o.vertices
    : [];

  const points: FigurePoint[] = [];
  const usedIds = new Set<string>();

  const ensurePoint = (x: number, y: number, prefix = 'P'): string => {
    const rx = clampCoord(x);
    const ry = clampCoord(y);
    const existing = points.find(
      (p) => Math.abs(p.x - rx) < 1e-6 && Math.abs(p.y - ry) < 1e-6
    );
    if (existing) return existing.id;
    let idx = points.length + 1;
    let cand = `${prefix}${idx}`;
    while (usedIds.has(cand)) {
      idx++;
      cand = `${prefix}${idx}`;
    }
    usedIds.add(cand);
    points.push({ id: cand, x: rx, y: ry });
    return cand;
  };

  for (let i = 0; i < rawPoints.length && points.length < FIGURE_LIMITS.maxPoints; i++) {
    const item = rawPoints[i];
    if (!item || typeof item !== 'object') continue;
    const po = item as Record<string, unknown>;
    const x = toNumber(po.x);
    const y = toNumber(po.y);
    if (x === null || y === null) continue;
    let id = cleanId(po.id ?? po.name);
    if (!id) id = `P${i + 1}`;
    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(`${id}_${suffix}`)) suffix++;
      id = `${id}_${suffix}`;
    }
    usedIds.add(id);
    const label = cleanStr(po.label, FIGURE_LIMITS.label);
    const rawPos = typeof po.labelPos === 'string' ? (po.labelPos.trim() as FigureLabelPos) : 'auto';
    const labelPos: FigureLabelPos = LABEL_POS_SET.has(rawPos) ? rawPos : 'auto';
    const pt: FigurePoint = {
      id,
      x: clampCoord(x),
      y: clampCoord(y),
      ...(label ? { label } : {}),
      ...(labelPos !== 'auto' ? { labelPos } : {}),
      ...(po.dot === true ? { dot: true } : {}),
    };
    points.push(pt);
  }

  if (Array.isArray(o.points) && o.points.length > FIGURE_LIMITS.maxPoints) {
    warnings.push(`عدد نقاط الشكل يتجاوز ${FIGURE_LIMITS.maxPoints} نقطة، تم أخذ أولها فقط.`);
  }

  const resolvePointRef = (ref: unknown, fallbackCoords?: unknown): string => {
    const id = cleanId(ref);
    if (id && usedIds.has(id)) return id;
    if (Array.isArray(ref) && ref.length >= 2) {
      const x = toNumber(ref[0]);
      const y = toNumber(ref[1]);
      if (x !== null && y !== null) return ensurePoint(x, y);
    }
    if (Array.isArray(fallbackCoords) && fallbackCoords.length >= 2) {
      const x = toNumber(fallbackCoords[0]);
      const y = toNumber(fallbackCoords[1]);
      if (x !== null && y !== null) return ensurePoint(x, y);
    }
    return '';
  };

  const rawElements = Array.isArray(o.elements)
    ? o.elements
    : Array.isArray(o.shapes)
    ? o.shapes
    : [];

  const elements: FigureElement[] = [];

  for (let i = 0; i < rawElements.length && elements.length < FIGURE_LIMITS.maxElements; i++) {
    const elRaw = rawElements[i];
    if (!elRaw || typeof elRaw !== 'object') continue;
    const eo = elRaw as Record<string, unknown>;
    const rawType = String(eo.type ?? eo.kind ?? '').trim().toLowerCase();

    if (rawType === 'polygon' || rawType === 'poly' || rawType === 'triangle' || rawType === 'rect') {
      const rawPts = Array.isArray(eo.points) ? eo.points : Array.isArray(eo.vertices) ? eo.vertices : [];
      const ids = rawPts.map((p) => resolvePointRef(p)).filter(Boolean);
      if (ids.length < 3) continue;
      const fill = normFill(eo.fill);
      const fillOpacity = toNumber(eo.fillOpacity);
      const stroke = eo.stroke ? normColor(eo.stroke, 'ink') : undefined;
      const sideLabels = Array.isArray(eo.sideLabels)
        ? eo.sideLabels.slice(0, ids.length).map((s) => cleanStr(s, FIGURE_LIMITS.label))
        : undefined;
      const ticks = Array.isArray(eo.ticks)
        ? eo.ticks.slice(0, ids.length).map((t) => Math.max(0, Math.min(3, Math.round(toNumber(t) ?? 0))))
        : undefined;
      elements.push({
        type: 'polygon',
        points: ids,
        ...(fill ? { fill } : {}),
        ...(fillOpacity !== null ? { fillOpacity: Math.max(0.05, Math.min(1, fillOpacity)) } : {}),
        ...(stroke ? { stroke } : {}),
        ...(eo.dashed === true ? { dashed: true } : {}),
        ...(sideLabels && sideLabels.some(Boolean) ? { sideLabels } : {}),
        ...(ticks && ticks.some((t) => t > 0) ? { ticks } : {}),
      });
    } else if (rawType === 'segment' || rawType === 'line' || rawType === 'ray') {
      const from = resolvePointRef(eo.from ?? eo.a ?? eo.p1, eo.fromCoords);
      const to = resolvePointRef(eo.to ?? eo.b ?? eo.p2, eo.toCoords);
      if (!from || !to || from === to) continue;
      const extendFrom = eo.extendFrom === true || rawType === 'line';
      const extendTo = eo.extendTo === true || rawType === 'line' || rawType === 'ray';
      const stroke = eo.stroke ? normColor(eo.stroke, 'ink') : undefined;
      const label = cleanStr(eo.label, FIGURE_LIMITS.label);
      const ticks = toNumber(eo.ticks);
      const parallel = toNumber(eo.parallel);
      elements.push({
        type: 'segment',
        from,
        to,
        ...(extendFrom ? { extendFrom: true } : {}),
        ...(extendTo ? { extendTo: true } : {}),
        ...(stroke ? { stroke } : {}),
        ...(eo.dashed === true ? { dashed: true } : {}),
        ...(label ? { label } : {}),
        ...(ticks && ticks > 0 ? { ticks: Math.min(3, Math.round(ticks)) } : {}),
        ...(parallel && parallel > 0 ? { parallel: Math.min(2, Math.round(parallel)) } : {}),
      });
    } else if (rawType === 'circle') {
      let center = resolvePointRef(eo.center, [eo.cx, eo.cy]);
      if (!center) {
        const cx = toNumber(eo.cx);
        const cy = toNumber(eo.cy);
        if (cx !== null && cy !== null) center = ensurePoint(cx, cy, 'O');
      }
      const r = toNumber(eo.r ?? eo.radius);
      if (!center || r === null || r <= 0) continue;
      const fill = normFill(eo.fill);
      const fillOpacity = toNumber(eo.fillOpacity);
      const stroke = eo.stroke ? normColor(eo.stroke, 'ink') : undefined;
      const radiusAngleDeg = toNumber(eo.radiusAngleDeg);
      const radiusLabel = cleanStr(eo.radiusLabel, FIGURE_LIMITS.label);
      const diameterAngleDeg = toNumber(eo.diameterAngleDeg);
      const diameterLabel = cleanStr(eo.diameterLabel, FIGURE_LIMITS.label);
      elements.push({
        type: 'circle',
        center,
        r: clampCoord(r),
        ...(fill ? { fill } : {}),
        ...(fillOpacity !== null ? { fillOpacity: Math.max(0.05, Math.min(1, fillOpacity)) } : {}),
        ...(stroke ? { stroke } : {}),
        ...(eo.dashed === true ? { dashed: true } : {}),
        ...(eo.showCenter === true ? { showCenter: true } : {}),
        ...(radiusAngleDeg !== null ? { radiusAngleDeg } : {}),
        ...(radiusLabel ? { radiusLabel } : {}),
        ...(diameterAngleDeg !== null ? { diameterAngleDeg } : {}),
        ...(diameterLabel ? { diameterLabel } : {}),
      });
    } else if (rawType === 'arc' || rawType === 'sector') {
      const center = resolvePointRef(eo.center, [eo.cx, eo.cy]);
      const r = toNumber(eo.r ?? eo.radius);
      const startDeg = toNumber(eo.startDeg ?? eo.start);
      const endDeg = toNumber(eo.endDeg ?? eo.end);
      if (!center || r === null || r <= 0 || startDeg === null || endDeg === null) continue;
      const fill = normFill(eo.fill);
      const fillOpacity = toNumber(eo.fillOpacity);
      const stroke = eo.stroke ? normColor(eo.stroke, 'blue') : undefined;
      const label = cleanStr(eo.label, FIGURE_LIMITS.label);
      elements.push({
        type: 'arc',
        center,
        r: clampCoord(r),
        startDeg,
        endDeg,
        ...(eo.sector === true || rawType === 'sector' ? { sector: true } : {}),
        ...(fill ? { fill } : {}),
        ...(fillOpacity !== null ? { fillOpacity: Math.max(0.05, Math.min(1, fillOpacity)) } : {}),
        ...(stroke ? { stroke } : {}),
        ...(eo.dashed === true ? { dashed: true } : {}),
        ...(label ? { label } : {}),
      });
    } else if (rawType === 'angle') {
      const a = resolvePointRef(eo.a ?? eo.p1 ?? eo.from);
      const vertex = resolvePointRef(eo.vertex ?? eo.v ?? eo.center);
      const b = resolvePointRef(eo.b ?? eo.p2 ?? eo.to);
      if (!a || !vertex || !b || a === vertex || b === vertex || a === b) continue;
      const label = cleanStr(eo.label, FIGURE_LIMITS.label);
      const arcs = toNumber(eo.arcs);
      const color = eo.color ? normColor(eo.color, 'blue') : undefined;
      const r = toNumber(eo.r);
      elements.push({
        type: 'angle',
        a,
        vertex,
        b,
        ...(label ? { label } : {}),
        ...(eo.right === true ? { right: true } : {}),
        ...(arcs && arcs > 0 ? { arcs: Math.min(3, Math.round(arcs)) } : {}),
        ...(eo.reflex === true ? { reflex: true } : {}),
        ...(color ? { color } : {}),
        ...(r !== null && r > 0 ? { r: clampCoord(r) } : {}),
      });
    } else if (rawType === 'label' || rawType === 'text') {
      const x = toNumber(eo.x);
      const y = toNumber(eo.y);
      const text = cleanStr(eo.text ?? eo.label, FIGURE_LIMITS.label);
      if (x === null || y === null || !text) continue;
      const color = eo.color ? normColor(eo.color, 'ink') : undefined;
      elements.push({
        type: 'label',
        x: clampCoord(x),
        y: clampCoord(y),
        text,
        ...(color ? { color } : {}),
      });
    }
  }

  if (points.length === 0 && elements.length === 0) {
    warnings.push('بيانات الشكل الهندسي فارغة وتم تجاهله.');
    return { figure: null, warnings };
  }

  const title = cleanStr(o.title ?? o['عنوان'], FIGURE_LIMITS.title);
  const caption = cleanStr(o.caption ?? o.note, FIGURE_LIMITS.caption);

  return {
    figure: {
      ...(title ? { title } : {}),
      ...(caption ? { caption } : {}),
      ...(o.grid === true ? { grid: true } : {}),
      points,
      elements,
    },
    warnings,
  };
}

export function sanitizeFigure(input: unknown): QuizFigure | null {
  return parseFigure(input).figure;
}

export function figureProblem(fig: QuizFigure): string | null {
  if (!fig.elements || fig.elements.length === 0) {
    return 'أضف عنصراً هندسياً واحداً على الأقل (مثلث، دائرة، مستقيم، زاوية...).';
  }
  const ids = new Set(fig.points.map((p) => p.id));
  for (const el of fig.elements) {
    if (el.type === 'polygon') {
      if (el.points.length < 3 || el.points.some((id) => !ids.has(id))) {
        return 'أحد المضلعات يشير إلى نقطة غير موجودة.';
      }
    } else if (el.type === 'segment') {
      if (!ids.has(el.from) || !ids.has(el.to) || el.from === el.to) {
        return 'أحد المستقيمات يشير إلى نقطة غير موجودة.';
      }
    } else if (el.type === 'circle' || el.type === 'arc') {
      if (!ids.has(el.center) || el.r <= 0) {
        return 'أحد الدوائر أو الأقواس مركزه غير صالح أو نصف قطره ≤ 0.';
      }
    } else if (el.type === 'angle') {
      if (!ids.has(el.a) || !ids.has(el.vertex) || !ids.has(el.b)) {
        return 'إحدى الزوايا تشير إلى نقطة غير موجودة.';
      }
    }
  }
  return null;
}

/* ================================================================== */
/*  قوالب هندسية ذكية (بسيطة ومعقدة) جاهزة للتخصيص الفوري            */
/* ================================================================== */

export type FigurePresetId =
  | 'triangle_angles'
  | 'right_triangle'
  | 'intersecting_angles'
  | 'parallel_transversal'
  | 'circle_in_square'
  | 'exterior_angle'
  | 'circle_sector'
  | 'rectangle'
  | 'regular_hexagon';

export interface FigurePresetMeta {
  id: FigurePresetId;
  label: string;
  desc: string;
  badge: string;
}

export const FIGURE_PRESETS: FigurePresetMeta[] = [
  { id: 'triangle_angles', label: 'مثلث وزوايا (س)', desc: 'مثلث بزاويتين معلومتين ومجهول س', badge: '△' },
  { id: 'right_triangle', label: 'مثلث قائم 90°', desc: 'قائم الزاوية بأطوال أضلاع أو وتر', badge: '⊿' },
  { id: 'intersecting_angles', label: 'زوايا متقابلة بالرأس', desc: 'تقاطع مستقيمين وزوايا جبرية', badge: '✕' },
  { id: 'parallel_transversal', label: 'متوازيان وقاطع', desc: 'زوايا متبادلة ومتناظرة وخارجية', badge: '∥' },
  { id: 'circle_in_square', label: 'دائرة داخل مربع', desc: 'منطقة مظللة وشكل هندسي مركب', badge: '▣' },
  { id: 'exterior_angle', label: 'زاوية خارجية لمثلث', desc: 'امتداد ضلع لحساب الزاوية الخارجية', badge: '∠' },
  { id: 'circle_sector', label: 'دائرة وقطاع', desc: 'زاوية مركزية ونصف قطر وقطاع مظلل', badge: '◔' },
  { id: 'rectangle', label: 'مستطيل / مربع', desc: 'أضلاع وقطر وزوايا قائمة', badge: '▭' },
  { id: 'regular_hexagon', label: 'مضلع منتظم', desc: 'سداسي منتظم بالرؤوس والزوايا', badge: '⬡' },
];

export function createFigureFromPreset(preset: FigurePresetId): QuizFigure {
  switch (preset) {
    case 'triangle_angles':
      return {
        title: 'أوجد قيمة س في المثلث',
        points: [
          { id: 'A', x: 3.2, y: 4.8, label: 'أ', labelPos: 'top' },
          { id: 'B', x: 0, y: 0, label: 'ب', labelPos: 'bottom-left' },
          { id: 'C', x: 7, y: 0, label: 'ج', labelPos: 'bottom-right' },
        ],
        elements: [
          { type: 'polygon', points: ['A', 'B', 'C'], fill: 'blue', fillOpacity: 0.14, stroke: 'ink' },
          { type: 'angle', a: 'B', vertex: 'A', b: 'C', label: 'س°', color: 'red', arcs: 1 },
          { type: 'angle', a: 'C', vertex: 'B', b: 'A', label: '55°', color: 'blue', arcs: 1 },
          { type: 'angle', a: 'A', vertex: 'C', b: 'B', label: '65°', color: 'green', arcs: 1 },
        ],
      };

    case 'right_triangle':
      return {
        title: 'مثلث قائم الزاوية',
        points: [
          { id: 'A', x: 0, y: 4, label: 'أ', labelPos: 'top-left' },
          { id: 'B', x: 0, y: 0, label: 'ب', labelPos: 'bottom-left' },
          { id: 'C', x: 6, y: 0, label: 'ج', labelPos: 'bottom-right' },
        ],
        elements: [
          {
            type: 'polygon',
            points: ['A', 'B', 'C'],
            fill: 'green',
            fillOpacity: 0.14,
            stroke: 'ink',
            sideLabels: ['3 سم', '4 سم', 'س'],
          },
          { type: 'angle', a: 'A', vertex: 'B', b: 'C', right: true, color: 'ink' },
        ],
      };

    case 'intersecting_angles':
      return {
        title: 'مستقيمان متقاطعان — زوايا متقابلة بالرأس',
        points: [
          { id: 'M', x: 0, y: 0, label: 'م', dot: true, labelPos: 'bottom' },
          { id: 'A', x: -5, y: -2.2, label: 'أ' },
          { id: 'B', x: 5, y: 2.2, label: 'ب' },
          { id: 'C', x: -3.6, y: 3.4, label: 'ج' },
          { id: 'D', x: 3.6, y: -3.4, label: 'د' },
        ],
        elements: [
          { type: 'segment', from: 'A', to: 'B', extendFrom: true, extendTo: true, stroke: 'ink' },
          { type: 'segment', from: 'C', to: 'D', extendFrom: true, extendTo: true, stroke: 'ink' },
          { type: 'angle', a: 'C', vertex: 'M', b: 'B', label: '115°', color: 'blue', arcs: 1, r: 1.5 },
          { type: 'angle', a: 'A', vertex: 'M', b: 'D', label: '2س + 15°', color: 'red', arcs: 1, r: 1.5 },
          { type: 'angle', a: 'A', vertex: 'M', b: 'C', label: 'ص°', color: 'gold', arcs: 2, r: 1.2 },
        ],
      };

    case 'parallel_transversal':
      return {
        title: 'مستقيمان متوازيان يقطعهما قاطع',
        points: [
          { id: 'L1', x: -5, y: 3 },
          { id: 'R1', x: 6, y: 3 },
          { id: 'L2', x: -5, y: 0 },
          { id: 'R2', x: 6, y: 0 },
          { id: 'P', x: 0.2, y: 3, dot: true },
          { id: 'Q', x: 2.2, y: 0, dot: true },
          { id: 'T1', x: -1.1, y: 5 },
          { id: 'T2', x: 3.5, y: -2 },
        ],
        elements: [
          { type: 'segment', from: 'L1', to: 'R1', extendFrom: true, extendTo: true, stroke: 'ink', parallel: 1 },
          { type: 'segment', from: 'L2', to: 'R2', extendFrom: true, extendTo: true, stroke: 'ink', parallel: 1 },
          { type: 'segment', from: 'T1', to: 'T2', extendFrom: true, extendTo: true, stroke: 'blue' },
          { type: 'angle', a: 'R1', vertex: 'P', b: 'T1', label: '70°', color: 'green', arcs: 1, r: 1.15 },
          { type: 'angle', a: 'L2', vertex: 'Q', b: 'T2', label: 'س°', color: 'red', arcs: 1, r: 1.15 },
          { type: 'angle', a: 'R2', vertex: 'Q', b: 'P', label: 'ص°', color: 'gold', arcs: 2, r: 1.0 },
        ],
      };

    case 'circle_in_square':
      return {
        title: 'دائرة تمس أضلاع مربع من الداخل',
        caption: 'المطلوب: مساحة الجزء المظلل',
        points: [
          { id: 'A', x: 0, y: 6, label: 'أ', labelPos: 'top-left' },
          { id: 'B', x: 6, y: 6, label: 'ب', labelPos: 'top-right' },
          { id: 'C', x: 6, y: 0, label: 'ج', labelPos: 'bottom-right' },
          { id: 'D', x: 0, y: 0, label: 'د', labelPos: 'bottom-left' },
          { id: 'O', x: 3, y: 3, dot: true },
        ],
        elements: [
          {
            type: 'polygon',
            points: ['A', 'B', 'C', 'D'],
            fill: 'blue',
            fillOpacity: 0.35,
            stroke: 'ink',
            sideLabels: ['', '10 سم', '', ''],
          },
          {
            type: 'circle',
            center: 'O',
            r: 3,
            fill: 'white',
            fillOpacity: 1,
            stroke: 'ink',
            showCenter: true,
            radiusAngleDeg: 0,
            radiusLabel: 'نق = 5',
          },
        ],
      };

    case 'exterior_angle':
      return {
        title: 'الزاوية الخارجية للمثلث',
        points: [
          { id: 'A', x: 2.5, y: 4.2, label: 'أ', labelPos: 'top' },
          { id: 'B', x: 0, y: 0, label: 'ب', labelPos: 'bottom-left' },
          { id: 'C', x: 5.5, y: 0, label: 'ج', labelPos: 'bottom' },
          { id: 'D', x: 9, y: 0, label: 'د', labelPos: 'bottom-right' },
        ],
        elements: [
          { type: 'polygon', points: ['A', 'B', 'C'], fill: 'purple', fillOpacity: 0.14, stroke: 'ink' },
          { type: 'segment', from: 'C', to: 'D', extendTo: true, stroke: 'ink' },
          { type: 'angle', a: 'B', vertex: 'A', b: 'C', label: '48°', color: 'blue', arcs: 1 },
          { type: 'angle', a: 'C', vertex: 'B', b: 'A', label: '62°', color: 'green', arcs: 1 },
          { type: 'angle', a: 'A', vertex: 'C', b: 'D', label: 'س°', color: 'red', arcs: 2, r: 1.35 },
        ],
      };

    case 'circle_sector':
      return {
        title: 'قطاع دائري في دائرة مركزها م',
        points: [
          { id: 'O', x: 0, y: 0, label: 'م', dot: true, labelPos: 'bottom-left' },
          { id: 'A', x: 4, y: 0, label: 'أ', labelPos: 'right' },
          { id: 'B', x: 2, y: 3.464, label: 'ب', labelPos: 'top-right' },
        ],
        elements: [
          { type: 'circle', center: 'O', r: 4, fill: 'none', stroke: 'ink', showCenter: true },
          {
            type: 'arc',
            center: 'O',
            r: 4,
            startDeg: 0,
            endDeg: 60,
            sector: true,
            fill: 'gold',
            fillOpacity: 0.45,
            stroke: 'gold',
          },
          { type: 'segment', from: 'O', to: 'A', stroke: 'ink', label: '6 سم' },
          { type: 'segment', from: 'O', to: 'B', stroke: 'ink' },
          { type: 'angle', a: 'A', vertex: 'O', b: 'B', label: '60°', color: 'red', arcs: 1, r: 1.2 },
        ],
      };

    case 'rectangle':
      return {
        title: 'مستطيل أ ب ج د',
        points: [
          { id: 'A', x: 0, y: 4, label: 'أ', labelPos: 'top-left' },
          { id: 'B', x: 7, y: 4, label: 'ب', labelPos: 'top-right' },
          { id: 'C', x: 7, y: 0, label: 'ج', labelPos: 'bottom-right' },
          { id: 'D', x: 0, y: 0, label: 'د', labelPos: 'bottom-left' },
        ],
        elements: [
          {
            type: 'polygon',
            points: ['A', 'B', 'C', 'D'],
            fill: 'blue',
            fillOpacity: 0.14,
            stroke: 'ink',
            sideLabels: ['8 سم', '5 سم', '', ''],
          },
          { type: 'segment', from: 'A', to: 'C', stroke: 'purple', dashed: true, label: 'القطر' },
          { type: 'angle', a: 'A', vertex: 'D', b: 'C', right: true, color: 'ink' },
        ],
      };

    case 'regular_hexagon': {
      const r = 4;
      const labels = ['أ', 'ب', 'ج', 'د', 'هـ', 'و'];
      const pts: FigurePoint[] = Array.from({ length: 6 }, (_, i) => {
        const deg = 90 + i * 60;
        const rad = (deg * Math.PI) / 180;
        return {
          id: `P${i + 1}`,
          x: +(r * Math.cos(rad)).toFixed(3),
          y: +(r * Math.sin(rad)).toFixed(3),
          label: labels[i],
        };
      });
      return {
        title: 'مضلع سداسي منتظم',
        points: pts,
        elements: [
          {
            type: 'polygon',
            points: pts.map((p) => p.id),
            fill: 'purple',
            fillOpacity: 0.15,
            stroke: 'ink',
            ticks: [1, 1, 1, 1, 1, 1],
            sideLabels: ['4 سم', '', '', '', '', ''],
          },
          { type: 'angle', a: 'P6', vertex: 'P1', b: 'P2', label: 'س°', color: 'red', arcs: 1 },
        ],
      };
    }
  }
}

export function buildRegularPolygonPoints(sides: number, radius = 4): FigurePoint[] {
  const n = Math.max(3, Math.min(12, Math.round(sides)));
  const arabicNames = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح', 'ط', 'ي', 'ك', 'ل'];
  return Array.from({ length: n }, (_, i) => {
    const rad = ((90 + (360 * i) / n) * Math.PI) / 180;
    return {
      id: `P${i + 1}`,
      x: +(radius * Math.cos(rad)).toFixed(3),
      y: +(radius * Math.sin(rad)).toFixed(3),
      label: arabicNames[i] || `P${i + 1}`,
    };
  });
}
