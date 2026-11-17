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
/*  قوالب هندسية ذكية (بسيطة ومركّبة) جاهزة للتخصيص الفوري            */
/* ================================================================== */

export type FigurePresetId =
  | 'triangle_angles'
  | 'right_triangle'
  | 'intersecting_angles'
  | 'parallel_transversal'
  | 'circle_in_square'
  | 'square_in_circle'
  | 'triangle_in_circle'
  | 'concentric_circles'
  | 'exterior_angle'
  | 'circle_sector'
  | 'rectangle'
  | 'parallelogram_angles'
  | 'rhombus_diagonals'
  | 'trapezoid_area'
  | 'kite_angles'
  | 'tangent_chord'
  | 'similar_triangles'
  | 'intersecting_circles'
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
  { id: 'square_in_circle', label: 'مربع داخل دائرة', desc: 'مربع مرسوم داخل دائرة وأقطار', badge: '◈' },
  { id: 'triangle_in_circle', label: 'مثلث داخل دائرة', desc: 'زاوية محيطية ومركزية داخل دائرة', badge: '◬' },
  { id: 'concentric_circles', label: 'دائرتان متحدتا المركز', desc: 'حلقة دائرية وحساب المساحة المظللة', badge: '◎' },
  { id: 'exterior_angle', label: 'زاوية خارجية لمثلث', desc: 'امتداد ضلع لحساب الزاوية الخارجية', badge: '∠' },
  { id: 'circle_sector', label: 'دائرة وقطاع', desc: 'زاوية مركزية ونصف قطر وقطاع مظلل', badge: '◔' },
  { id: 'rectangle', label: 'مستطيل / مربع', desc: 'أضلاع وقطر وزوايا قائمة', badge: '▭' },
  { id: 'parallelogram_angles', label: 'متوازي أضلاع', desc: 'زوايا متجاورة ومتقابلة ومتوازية', badge: '▱' },
  { id: 'rhombus_diagonals', label: 'معين وأقطار متعامدة', desc: 'معين بأقطاره المتعامدة وزواياه', badge: '◇' },
  { id: 'trapezoid_area', label: 'شبه منحرف وارتفاع', desc: 'قاعدتان متوازيتان وارتفاع عمودي', badge: '⏢' },
  { id: 'kite_angles', label: 'طائرة ورقية', desc: 'شكل رباعي بضلعين متجاورين متطابقين', badge: '🪁' },
  { id: 'tangent_chord', label: 'مماس ووتر للدائرة', desc: 'مماس عمودي على نصف القطر وزواياه', badge: '⍉' },
  { id: 'similar_triangles', label: 'مثلثان متشابهان', desc: 'مثلث صغير داخل مثلث كبير بتوازي', badge: '⟁' },
  { id: 'intersecting_circles', label: 'دائرتان متقاطعتان', desc: 'تقاطع دائرتين ووتر مشترك', badge: '⚯' },
  { id: 'regular_hexagon', label: 'سداسي منتظم', desc: 'سداسي منتظم بالرؤوس والزوايا', badge: '⬡' },
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

    case 'square_in_circle': {
      const r = 4;
      const d = +(r / Math.SQRT2).toFixed(3);
      return {
        title: 'مربع مرسوم داخل دائرة مركزها م',
        caption: 'رؤوس المربع تقع على محيط الدائرة',
        points: [
          { id: 'O', x: 0, y: 0, label: 'م', dot: true, labelPos: 'bottom' },
          { id: 'A', x: -d, y: d, label: 'أ', labelPos: 'top-left' },
          { id: 'B', x: d, y: d, label: 'ب', labelPos: 'top-right' },
          { id: 'C', x: d, y: -d, label: 'ج', labelPos: 'bottom-right' },
          { id: 'D', x: -d, y: -d, label: 'د', labelPos: 'bottom-left' },
        ],
        elements: [
          { type: 'circle', center: 'O', r, fill: 'blue', fillOpacity: 0.18, stroke: 'ink', showCenter: true },
          {
            type: 'polygon',
            points: ['A', 'B', 'C', 'D'],
            fill: 'white',
            fillOpacity: 0.92,
            stroke: 'ink',
            ticks: [1, 1, 1, 1],
          },
          { type: 'segment', from: 'A', to: 'C', stroke: 'red', dashed: true, label: 'القطر = 8 سم' },
        ],
      };
    }

    case 'triangle_in_circle':
      return {
        title: 'مثلث مرسوم داخل دائرة',
        points: [
          { id: 'O', x: 0, y: 0, label: 'م', dot: true, labelPos: 'bottom-left' },
          { id: 'A', x: -4, y: 0, label: 'أ', labelPos: 'left' },
          { id: 'B', x: 4, y: 0, label: 'ب', labelPos: 'right' },
          { id: 'C', x: 1.6, y: 3.666, label: 'ج', labelPos: 'top' },
        ],
        elements: [
          { type: 'circle', center: 'O', r: 4, fill: 'blue', fillOpacity: 0.1, stroke: 'ink', showCenter: true },
          { type: 'polygon', points: ['A', 'C', 'B'], fill: 'green', fillOpacity: 0.2, stroke: 'ink' },
          { type: 'angle', a: 'A', vertex: 'C', b: 'B', right: true, color: 'ink' },
          { type: 'angle', a: 'C', vertex: 'A', b: 'B', label: '35°', color: 'blue', arcs: 1 },
          { type: 'angle', a: 'A', vertex: 'B', b: 'C', label: 'س°', color: 'red', arcs: 2 },
        ],
      };

    case 'concentric_circles':
      return {
        title: 'دائرتان متحدتا المركز (حلقة دائرية)',
        caption: 'أوجد مساحة الجزء المظلل بين الدائرتين',
        points: [
          { id: 'O', x: 0, y: 0, label: 'م', dot: true, labelPos: 'bottom-left' },
        ],
        elements: [
          {
            type: 'circle',
            center: 'O',
            r: 4.5,
            fill: 'gold',
            fillOpacity: 0.35,
            stroke: 'ink',
            showCenter: true,
            radiusAngleDeg: 30,
            radiusLabel: '7 سم',
          },
          {
            type: 'circle',
            center: 'O',
            r: 2.5,
            fill: 'white',
            fillOpacity: 1,
            stroke: 'ink',
            showCenter: true,
            radiusAngleDeg: -30,
            radiusLabel: '4 سم',
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

    case 'parallelogram_angles':
      return {
        title: 'متوازي أضلاع أ ب ج د',
        points: [
          { id: 'A', x: 1.8, y: 4, label: 'أ', labelPos: 'top-left' },
          { id: 'B', x: 8.2, y: 4, label: 'ب', labelPos: 'top-right' },
          { id: 'C', x: 6.4, y: 0, label: 'ج', labelPos: 'bottom-right' },
          { id: 'D', x: 0, y: 0, label: 'د', labelPos: 'bottom-left' },
        ],
        elements: [
          {
            type: 'polygon',
            points: ['A', 'B', 'C', 'D'],
            fill: 'green',
            fillOpacity: 0.14,
            stroke: 'ink',
            sideLabels: ['7 سم', '4.5 سم', '', ''],
          },
          { type: 'segment', from: 'A', to: 'B', stroke: 'ink', parallel: 1 },
          { type: 'segment', from: 'D', to: 'C', stroke: 'ink', parallel: 1 },
          { type: 'angle', a: 'A', vertex: 'D', b: 'C', label: '68°', color: 'blue', arcs: 1 },
          { type: 'angle', a: 'D', vertex: 'C', b: 'B', label: 'س°', color: 'red', arcs: 2 },
        ],
      };

    case 'rhombus_diagonals':
      return {
        title: 'معين وأقطار متعامدة',
        points: [
          { id: 'A', x: 0, y: 4, label: 'أ', labelPos: 'top' },
          { id: 'B', x: 3, y: 0, label: 'ب', labelPos: 'right' },
          { id: 'C', x: 0, y: -4, label: 'ج', labelPos: 'bottom' },
          { id: 'D', x: -3, y: 0, label: 'د', labelPos: 'left' },
          { id: 'M', x: 0, y: 0, label: 'م', dot: true, labelPos: 'bottom-left' },
        ],
        elements: [
          {
            type: 'polygon',
            points: ['A', 'B', 'C', 'D'],
            fill: 'purple',
            fillOpacity: 0.14,
            stroke: 'ink',
            ticks: [1, 1, 1, 1],
            sideLabels: ['5 سم', '', '', ''],
          },
          { type: 'segment', from: 'A', to: 'C', stroke: 'blue', dashed: true },
          { type: 'segment', from: 'D', to: 'B', stroke: 'blue', dashed: true },
          { type: 'angle', a: 'A', vertex: 'M', b: 'B', right: true, color: 'ink', r: 0.8 },
          { type: 'angle', a: 'D', vertex: 'A', b: 'M', label: 'س°', color: 'red', arcs: 1 },
        ],
      };

    case 'trapezoid_area':
      return {
        title: 'شبه منحرف أ ب ج د',
        points: [
          { id: 'A', x: 1.5, y: 4, label: 'أ', labelPos: 'top-left' },
          { id: 'B', x: 6, y: 4, label: 'ب', labelPos: 'top-right' },
          { id: 'C', x: 8, y: 0, label: 'ج', labelPos: 'bottom-right' },
          { id: 'D', x: 0, y: 0, label: 'د', labelPos: 'bottom-left' },
          { id: 'H', x: 1.5, y: 0, label: 'هـ', dot: true, labelPos: 'bottom' },
        ],
        elements: [
          {
            type: 'polygon',
            points: ['A', 'B', 'C', 'D'],
            fill: 'gold',
            fillOpacity: 0.18,
            stroke: 'ink',
            sideLabels: ['6 سم', '', '10 سم', ''],
          },
          { type: 'segment', from: 'A', to: 'B', stroke: 'ink', parallel: 1 },
          { type: 'segment', from: 'D', to: 'C', stroke: 'ink', parallel: 1 },
          { type: 'segment', from: 'A', to: 'H', stroke: 'red', dashed: true, label: 'ع = 4 سم' },
          { type: 'angle', a: 'A', vertex: 'H', b: 'C', right: true, color: 'red', r: 0.7 },
        ],
      };

    case 'kite_angles':
      return {
        title: 'شكل طائرة ورقية أ ب ج د',
        points: [
          { id: 'A', x: 0, y: 4.5, label: 'أ', labelPos: 'top' },
          { id: 'B', x: 2.8, y: 1.5, label: 'ب', labelPos: 'right' },
          { id: 'C', x: 0, y: -3.5, label: 'ج', labelPos: 'bottom' },
          { id: 'D', x: -2.8, y: 1.5, label: 'د', labelPos: 'left' },
        ],
        elements: [
          {
            type: 'polygon',
            points: ['A', 'B', 'C', 'D'],
            fill: 'blue',
            fillOpacity: 0.14,
            stroke: 'ink',
            ticks: [1, 2, 2, 1],
          },
          { type: 'segment', from: 'A', to: 'C', stroke: 'gray', dashed: true },
          { type: 'segment', from: 'D', to: 'B', stroke: 'gray', dashed: true },
          { type: 'angle', a: 'D', vertex: 'A', b: 'B', label: '80°', color: 'blue', arcs: 1 },
          { type: 'angle', a: 'A', vertex: 'D', b: 'C', label: 'س°', color: 'red', arcs: 2 },
        ],
      };

    case 'tangent_chord':
      return {
        title: 'مماس للدائرة عند النقطة أ',
        points: [
          { id: 'O', x: 0, y: 0, label: 'م', dot: true, labelPos: 'top-left' },
          { id: 'A', x: 0, y: -3.5, label: 'أ', dot: true, labelPos: 'bottom' },
          { id: 'T1', x: -5, y: -3.5, label: 'ج', labelPos: 'bottom-left' },
          { id: 'T2', x: 5.5, y: -3.5, label: 'د', labelPos: 'bottom-right' },
          { id: 'B', x: 3.1, y: 1.62, label: 'ب', dot: true, labelPos: 'top-right' },
        ],
        elements: [
          { type: 'circle', center: 'O', r: 3.5, fill: 'blue', fillOpacity: 0.1, stroke: 'ink', showCenter: true },
          { type: 'segment', from: 'T1', to: 'T2', extendFrom: true, extendTo: true, stroke: 'ink', label: 'مماس' },
          { type: 'segment', from: 'O', to: 'A', stroke: 'blue', dashed: true, label: 'نق' },
          { type: 'segment', from: 'A', to: 'B', stroke: 'green', label: 'وتر' },
          { type: 'angle', a: 'O', vertex: 'A', b: 'T2', right: true, color: 'blue', r: 0.75 },
          { type: 'angle', a: 'B', vertex: 'A', b: 'T2', label: 'س°', color: 'red', arcs: 1, r: 1.2 },
        ],
      };

    case 'similar_triangles':
      return {
        title: 'مثلثان متشابهان (مثلث داخل مثلث)',
        points: [
          { id: 'A', x: 3.5, y: 6, label: 'أ', labelPos: 'top' },
          { id: 'B', x: 0, y: 0, label: 'ب', labelPos: 'bottom-left' },
          { id: 'C', x: 7, y: 0, label: 'ج', labelPos: 'bottom-right' },
          { id: 'D', x: 1.75, y: 3, label: 'د', dot: true, labelPos: 'left' },
          { id: 'E', x: 5.25, y: 3, label: 'هـ', dot: true, labelPos: 'right' },
        ],
        elements: [
          {
            type: 'polygon',
            points: ['A', 'B', 'C'],
            fill: 'blue',
            fillOpacity: 0.12,
            stroke: 'ink',
            sideLabels: ['', '12 سم', ''],
          },
          {
            type: 'polygon',
            points: ['A', 'D', 'E'],
            fill: 'gold',
            fillOpacity: 0.28,
            stroke: 'blue',
            sideLabels: ['', 'س', ''],
          },
          { type: 'segment', from: 'D', to: 'E', stroke: 'blue', parallel: 1 },
          { type: 'segment', from: 'B', to: 'C', stroke: 'ink', parallel: 1 },
        ],
      };

    case 'intersecting_circles':
      return {
        title: 'دائرتان متقاطعتان ووتر مشترك',
        points: [
          { id: 'O1', x: -2, y: 0, label: 'م', dot: true, labelPos: 'left' },
          { id: 'O2', x: 2, y: 0, label: 'ن', dot: true, labelPos: 'right' },
          { id: 'P', x: 0, y: 2.236, label: 'أ', dot: true, labelPos: 'top' },
          { id: 'Q', x: 0, y: -2.236, label: 'ب', dot: true, labelPos: 'bottom' },
        ],
        elements: [
          { type: 'circle', center: 'O1', r: 3, fill: 'blue', fillOpacity: 0.14, stroke: 'blue', showCenter: true },
          { type: 'circle', center: 'O2', r: 3, fill: 'green', fillOpacity: 0.14, stroke: 'green', showCenter: true },
          { type: 'segment', from: 'P', to: 'Q', stroke: 'red', dashed: true, label: 'أ ب' },
          { type: 'segment', from: 'O1', to: 'O2', stroke: 'ink' },
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

/* ================================================================== */
/*  أدوات الرسم المركّب (شكل داخل شكل) والتحريك والزوايا الهندسية    */
/* ================================================================== */

export type GeometryShapeKind =
  | 'equilateral_triangle'
  | 'isosceles_triangle'
  | 'right_triangle'
  | 'square'
  | 'rectangle'
  | 'rhombus'
  | 'parallelogram'
  | 'trapezoid'
  | 'kite'
  | 'pentagon'
  | 'hexagon'
  | 'octagon'
  | 'regular_ngon'
  | 'circle'
  | 'cutout_circle'
  | 'semicircle'
  | 'sector'
  | 'diagonals'
  | 'altitude'
  | 'median'
  | 'chord'
  | 'tangent';

export interface GeometryShapeInsertMeta {
  kind: GeometryShapeKind;
  label: string;
  badge: string;
  category: 'polygon' | 'circle' | 'construction';
}

export const SHAPE_INSERT_CATALOG: GeometryShapeInsertMeta[] = [
  { kind: 'equilateral_triangle', label: 'مثلث متطابق', badge: '△', category: 'polygon' },
  { kind: 'isosceles_triangle', label: 'مثلث متطابق الضلعين', badge: '▲', category: 'polygon' },
  { kind: 'right_triangle', label: 'مثلث قائم', badge: '⊿', category: 'polygon' },
  { kind: 'square', label: 'مربع', badge: '□', category: 'polygon' },
  { kind: 'rectangle', label: 'مستطيل', badge: '▭', category: 'polygon' },
  { kind: 'rhombus', label: 'معين', badge: '◇', category: 'polygon' },
  { kind: 'parallelogram', label: 'متوازي أضلاع', badge: '▱', category: 'polygon' },
  { kind: 'trapezoid', label: 'شبه منحرف', badge: '⏢', category: 'polygon' },
  { kind: 'kite', label: 'طائرة ورقية', badge: '✦', category: 'polygon' },
  { kind: 'pentagon', label: 'خماسي', badge: '⬠', category: 'polygon' },
  { kind: 'hexagon', label: 'سداسي', badge: '⬡', category: 'polygon' },
  { kind: 'octagon', label: 'ثماني', badge: '🛑', category: 'polygon' },
  { kind: 'circle', label: 'دائرة', badge: '◯', category: 'circle' },
  { kind: 'cutout_circle', label: 'دائرة مفرغة (بيضاء)', badge: '⊙', category: 'circle' },
  { kind: 'semicircle', label: 'نصف دائرة', badge: '◐', category: 'circle' },
  { kind: 'sector', label: 'قطاع دائري', badge: '◔', category: 'circle' },
  { kind: 'diagonals', label: 'أقطار المضلع', badge: '✕', category: 'construction' },
  { kind: 'altitude', label: 'ارتفاع عمودي', badge: '⊥', category: 'construction' },
  { kind: 'median', label: 'متوسط مثلث', badge: '⫠', category: 'construction' },
  { kind: 'chord', label: 'وتر دائرة', badge: '⊘', category: 'construction' },
  { kind: 'tangent', label: 'مماس دائرة', badge: '⍉', category: 'construction' },
];

export function getFigureBounds(fig: QuizFigure): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  cx: number;
  cy: number;
  span: number;
} {
  const ptsMap = new Map<string, FigurePoint>();
  fig.points.forEach((p) => ptsMap.set(p.id, p));

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const expand = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  fig.points.forEach((p) => expand(p.x, p.y));
  fig.elements.forEach((el) => {
    if (el.type === 'circle' || el.type === 'arc') {
      const c = ptsMap.get(el.center);
      if (c) {
        expand(c.x - el.r, c.y - el.r);
        expand(c.x + el.r, c.y + el.r);
      }
    } else if (el.type === 'label') {
      expand(el.x, el.y);
    }
  });
  if (!Number.isFinite(minX)) {
    return { minX: -4, maxX: 4, minY: -3, maxY: 3, cx: 0, cy: 0, span: 8 };
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  return {
    minX,
    maxX,
    minY,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    span: Math.max(spanX, spanY),
  };
}

export function getElementPointIds(fig: QuizFigure, elIdx: number): string[] {
  const el = fig.elements[elIdx];
  if (!el) return [];
  if (el.type === 'polygon') return Array.from(new Set(el.points));
  if (el.type === 'segment') return el.from === el.to ? [el.from] : [el.from, el.to];
  if (el.type === 'circle' || el.type === 'arc') return [el.center];
  if (el.type === 'angle') return Array.from(new Set([el.a, el.vertex, el.b]));
  return [];
}

export function getElementAnchorCoords(
  fig: QuizFigure,
  elIdx: number
): { cx: number; cy: number; radiusApprox: number } | null {
  const el = fig.elements[elIdx];
  if (!el) return null;
  const ptsMap = new Map(fig.points.map((p) => [p.id, p]));

  if (el.type === 'circle' || el.type === 'arc') {
    const c = ptsMap.get(el.center);
    if (!c) return null;
    return { cx: c.x, cy: c.y, radiusApprox: el.r };
  }
  if (el.type === 'label') {
    return { cx: el.x, cy: el.y, radiusApprox: 1 };
  }
  if (el.type === 'polygon') {
    const pts = el.points.map((id) => ptsMap.get(id)).filter((p): p is FigurePoint => !!p);
    if (pts.length === 0) return null;
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const maxD = pts.reduce((m, p) => Math.max(m, Math.hypot(p.x - cx, p.y - cy)), 1);
    return { cx, cy, radiusApprox: maxD };
  }
  if (el.type === 'segment') {
    const a = ptsMap.get(el.from);
    const b = ptsMap.get(el.to);
    if (!a || !b) return null;
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      radiusApprox: Math.max(0.5, Math.hypot(b.x - a.x, b.y - a.y) / 2),
    };
  }
  if (el.type === 'angle') {
    const v = ptsMap.get(el.vertex);
    return v ? { cx: v.x, cy: v.y, radiusApprox: el.r ?? 1 } : null;
  }
  return null;
}

export function moveElementPoints(
  fig: QuizFigure,
  elIdx: number,
  dx: number,
  dy: number
): QuizFigure {
  const el = fig.elements[elIdx];
  if (!el || (!dx && !dy)) return fig;
  if (el.type === 'label') {
    return {
      ...fig,
      elements: fig.elements.map((item, i) =>
        i === elIdx && item.type === 'label'
          ? { ...item, x: clampCoord(item.x + dx), y: clampCoord(item.y + dy) }
          : item
      ),
    };
  }
  const ids = new Set(getElementPointIds(fig, elIdx));
  if (ids.size === 0) return fig;
  return {
    ...fig,
    points: fig.points.map((p) =>
      ids.has(p.id) ? { ...p, x: clampCoord(p.x + dx), y: clampCoord(p.y + dy) } : p
    ),
  };
}

export function scaleElementAroundCentroid(
  fig: QuizFigure,
  elIdx: number,
  factor: number
): QuizFigure {
  const el = fig.elements[elIdx];
  if (!el || factor <= 0.1 || factor > 5) return fig;
  if (el.type === 'circle' || el.type === 'arc') {
    return {
      ...fig,
      elements: fig.elements.map((item, i) =>
        i === elIdx && (item.type === 'circle' || item.type === 'arc')
          ? { ...item, r: clampCoord(Math.max(0.25, item.r * factor)) }
          : item
      ),
    };
  }
  if (el.type === 'polygon' || el.type === 'segment') {
    const anchor = getElementAnchorCoords(fig, elIdx);
    if (!anchor) return fig;
    const ids = new Set(getElementPointIds(fig, elIdx));
    return {
      ...fig,
      points: fig.points.map((p) =>
        ids.has(p.id)
          ? {
              ...p,
              x: clampCoord(anchor.cx + (p.x - anchor.cx) * factor),
              y: clampCoord(anchor.cy + (p.y - anchor.cy) * factor),
            }
          : p
      ),
    };
  }
  return fig;
}

export function rotateElementAroundCentroid(
  fig: QuizFigure,
  elIdx: number,
  deg: number
): QuizFigure {
  const el = fig.elements[elIdx];
  if (!el) return fig;
  if (el.type === 'arc') {
    return {
      ...fig,
      elements: fig.elements.map((item, i) =>
        i === elIdx && item.type === 'arc'
          ? { ...item, startDeg: item.startDeg + deg, endDeg: item.endDeg + deg }
          : item
      ),
    };
  }
  if (el.type === 'circle') {
    return {
      ...fig,
      elements: fig.elements.map((item, i) =>
        i === elIdx && item.type === 'circle'
          ? {
              ...item,
              ...(item.radiusAngleDeg !== undefined || item.radiusLabel
                ? { radiusAngleDeg: (item.radiusAngleDeg ?? 0) + deg }
                : {}),
              ...(item.diameterAngleDeg !== undefined || item.diameterLabel
                ? { diameterAngleDeg: (item.diameterAngleDeg ?? 0) + deg }
                : {}),
            }
          : item
      ),
    };
  }
  if (el.type === 'polygon' || el.type === 'segment') {
    const anchor = getElementAnchorCoords(fig, elIdx);
    if (!anchor) return fig;
    const r = (deg * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const ids = new Set(getElementPointIds(fig, elIdx));
    return {
      ...fig,
      points: fig.points.map((p) => {
        if (!ids.has(p.id)) return p;
        const dx = p.x - anchor.cx;
        const dy = p.y - anchor.cy;
        return {
          ...p,
          x: clampCoord(anchor.cx + dx * cos - dy * sin),
          y: clampCoord(anchor.cy + dx * sin + dy * cos),
        };
      }),
    };
  }
  return fig;
}

export function centerElementInside(
  fig: QuizFigure,
  sourceElIdx: number,
  targetElIdx: number
): QuizFigure {
  if (sourceElIdx === targetElIdx) return fig;
  const srcAnchor = getElementAnchorCoords(fig, sourceElIdx);
  const tgtAnchor = getElementAnchorCoords(fig, targetElIdx);
  if (!srcAnchor || !tgtAnchor) return fig;
  return moveElementPoints(
    fig,
    sourceElIdx,
    tgtAnchor.cx - srcAnchor.cx,
    tgtAnchor.cy - srcAnchor.cy
  );
}

export function moveElementLayer(
  fig: QuizFigure,
  idx: number,
  direction: 'up' | 'down'
): { figure: QuizFigure; newIdx: number } {
  const target = direction === 'up' ? idx + 1 : idx - 1;
  if (target < 0 || target >= fig.elements.length) return { figure: fig, newIdx: idx };
  const next = fig.elements.slice();
  [next[idx], next[target]] = [next[target], next[idx]];
  return { figure: { ...fig, elements: next }, newIdx: target };
}

export function computeAngleDegrees(
  a: Pick<FigurePoint, 'x' | 'y'>,
  vertex: Pick<FigurePoint, 'x' | 'y'>,
  b: Pick<FigurePoint, 'x' | 'y'>,
  reflex = false
): number {
  const a1 = Math.atan2(a.y - vertex.y, a.x - vertex.x);
  const a2 = Math.atan2(b.y - vertex.y, b.x - vertex.x);
  let diff = ((a2 - a1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  const deg = (diff * 180) / Math.PI;
  const finalDeg = reflex ? 360 - deg : deg;
  return Math.round(finalDeg * 10) / 10;
}

export function addAllPolygonAngles(
  fig: QuizFigure,
  polyIdx: number,
  options: { withMeasure?: boolean } = {}
): QuizFigure {
  const el = fig.elements[polyIdx];
  if (!el || el.type !== 'polygon' || el.points.length < 3) return fig;
  const ptsMap = new Map(fig.points.map((p) => [p.id, p]));
  const existingKey = new Set(
    fig.elements
      .filter((e): e is Extract<FigureElement, { type: 'angle' }> => e.type === 'angle')
      .map((e) => `${e.vertex}:${[e.a, e.b].sort().join('|')}`)
  );

  const additions: FigureElement[] = [];
  const palette: FigureColor[] = ['blue', 'green', 'purple', 'gold', 'red'];
  for (let i = 0; i < el.points.length; i++) {
    if (fig.elements.length + additions.length >= FIGURE_LIMITS.maxElements) break;
    const prevId = el.points[(i - 1 + el.points.length) % el.points.length];
    const vId = el.points[i];
    const nextId = el.points[(i + 1) % el.points.length];
    const k = `${vId}:${[prevId, nextId].sort().join('|')}`;
    if (existingKey.has(k)) continue;
    const pa = ptsMap.get(prevId);
    const pv = ptsMap.get(vId);
    const pb = ptsMap.get(nextId);
    if (!pa || !pv || !pb) continue;
    const deg = computeAngleDegrees(pa, pv, pb, false);
    const isRight = Math.abs(deg - 90) < 0.7;
    additions.push({
      type: 'angle',
      a: prevId,
      vertex: vId,
      b: nextId,
      ...(isRight
        ? { right: true, color: 'ink' as FigureColor }
        : {
            arcs: 1,
            color: palette[i % palette.length],
            label: options.withMeasure ? `${Number.isInteger(deg) ? deg : deg}°` : i === 0 ? 'س°' : `${Math.round(deg)}°`,
          }),
    });
  }
  return additions.length > 0 ? { ...fig, elements: [...fig.elements, ...additions] } : fig;
}

export function insertShapeIntoFigure(
  fig: QuizFigure,
  kind: GeometryShapeKind,
  opts: {
    cx?: number;
    cy?: number;
    size?: number;
    sides?: number;
    rotationDeg?: number;
    fill?: FigureColor | 'none';
    stroke?: FigureColor;
    targetElementIdx?: number | null;
  } = {}
): { figure: QuizFigure; addedElementIdx: number | null; error?: string } {
  const bounds = getFigureBounds(fig);
  const targetAnchor =
    opts.targetElementIdx !== null && opts.targetElementIdx !== undefined
      ? getElementAnchorCoords(fig, opts.targetElementIdx)
      : null;

  const cx = opts.cx ?? targetAnchor?.cx ?? bounds.cx;
  const cy = opts.cy ?? targetAnchor?.cy ?? bounds.cy;
  const defaultSize = targetAnchor
    ? Math.max(1.2, Math.min(4.5, targetAnchor.radiusApprox * 0.6))
    : Math.max(1.6, Math.min(3.5, bounds.span * 0.28));
  const r = opts.size ?? defaultSize;
  const fillColor: FigureColor | 'none' =
    opts.fill ?? (kind === 'cutout_circle' ? 'white' : 'blue');
  const strokeColor: FigureColor = opts.stroke ?? 'ink';
  const rotRad = ((opts.rotationDeg ?? 0) * Math.PI) / 180;

  const nextPoints = fig.points.slice();
  const nextElements = fig.elements.slice();
  const usedIds = new Set(nextPoints.map((p) => p.id));

  let seq = 1;
  const allocId = (prefix = 'N') => {
    while (usedIds.has(`${prefix}${seq}`)) seq++;
    const id = `${prefix}${seq}`;
    usedIds.add(id);
    return id;
  };

  const pushPt = (x: number, y: number, extra: Partial<FigurePoint> = {}): string | null => {
    if (nextPoints.length >= FIGURE_LIMITS.maxPoints) return null;
    const dx = x * Math.cos(rotRad) - y * Math.sin(rotRad);
    const dy = x * Math.sin(rotRad) + y * Math.cos(rotRad);
    const id = allocId();
    nextPoints.push({
      id,
      x: clampCoord(cx + dx),
      y: clampCoord(cy + dy),
      ...extra,
    });
    return id;
  };

  if (nextElements.length >= FIGURE_LIMITS.maxElements) {
    return {
      figure: fig,
      addedElementIdx: null,
      error: `تم بلوغ الحد الأقصى للعناصر (${FIGURE_LIMITS.maxElements}).`,
    };
  }

  // Geometric constructions tied to an existing selected shape
  if (kind === 'diagonals' || kind === 'altitude' || kind === 'median') {
    const polyIdx =
      opts.targetElementIdx !== null &&
      opts.targetElementIdx !== undefined &&
      fig.elements[opts.targetElementIdx]?.type === 'polygon'
        ? opts.targetElementIdx
        : fig.elements.findIndex((e) => e.type === 'polygon');

    if (polyIdx < 0) {
      return { figure: fig, addedElementIdx: null, error: 'أضف مضلعاً أو مثلثاً أولاً لإضافة الأقطار أو الارتفاع.' };
    }
    const poly = fig.elements[polyIdx];
    if (poly.type !== 'polygon') return { figure: fig, addedElementIdx: null };
    const ptsMap = new Map(nextPoints.map((p) => [p.id, p]));

    if (kind === 'diagonals') {
      if (poly.points.length < 4) {
        return { figure: fig, addedElementIdx: null, error: 'الأقطار تحتاج مضلعاً بأربعة أضلاع على الأقل.' };
      }
      const addedStart = nextElements.length;
      for (let i = 0; i < poly.points.length; i++) {
        for (let j = i + 2; j < poly.points.length; j++) {
          if (i === 0 && j === poly.points.length - 1) continue;
          if (nextElements.length >= FIGURE_LIMITS.maxElements) break;
          nextElements.push({
            type: 'segment',
            from: poly.points[i],
            to: poly.points[j],
            stroke: 'purple',
            dashed: true,
          });
        }
      }
      return {
        figure: { ...fig, points: nextPoints, elements: nextElements },
        addedElementIdx: addedStart < nextElements.length ? addedStart : null,
      };
    }

    const pTop = ptsMap.get(poly.points[0]);
    const pBaseA = ptsMap.get(poly.points[1]);
    const pBaseB = ptsMap.get(poly.points[poly.points.length - 1]);
    if (!pTop || !pBaseA || !pBaseB) return { figure: fig, addedElementIdx: null };

    if (kind === 'median') {
      if (nextPoints.length >= FIGURE_LIMITS.maxPoints) {
        return { figure: fig, addedElementIdx: null, error: 'تم بلوغ الحد الأقصى للنقاط.' };
      }
      const midId = allocId('M');
      nextPoints.push({
        id: midId,
        x: clampCoord((pBaseA.x + pBaseB.x) / 2),
        y: clampCoord((pBaseA.y + pBaseB.y) / 2),
        dot: true,
      });
      nextElements.push({
        type: 'segment',
        from: pTop.id,
        to: midId,
        stroke: 'green',
        dashed: true,
        label: 'متوسط',
      });
      return {
        figure: { ...fig, points: nextPoints, elements: nextElements },
        addedElementIdx: nextElements.length - 1,
      };
    }

    // Altitude from vertex 0 onto segment (pBaseA -> pBaseB)
    const abx = pBaseB.x - pBaseA.x;
    const aby = pBaseB.y - pBaseA.y;
    const lenSq = abx * abx + aby * aby || 1;
    const t = ((pTop.x - pBaseA.x) * abx + (pTop.y - pBaseA.y) * aby) / lenSq;
    const footX = clampCoord(pBaseA.x + t * abx);
    const footY = clampCoord(pBaseA.y + t * aby);
    if (nextPoints.length >= FIGURE_LIMITS.maxPoints) {
      return { figure: fig, addedElementIdx: null, error: 'تم بلوغ الحد الأقصى للنقاط.' };
    }
    const footId = allocId('H');
    nextPoints.push({ id: footId, x: footX, y: footY, dot: true });
    nextElements.push({
      type: 'segment',
      from: pTop.id,
      to: footId,
      stroke: 'red',
      dashed: true,
      label: 'ع',
    });
    if (nextElements.length < FIGURE_LIMITS.maxElements) {
      nextElements.push({
        type: 'angle',
        a: pTop.id,
        vertex: footId,
        b: pBaseB.id,
        right: true,
        color: 'red',
        r: Math.max(0.4, r * 0.25),
      });
    }
    return {
      figure: { ...fig, points: nextPoints, elements: nextElements },
      addedElementIdx: nextElements.length - 2,
    };
  }

  if (kind === 'chord' || kind === 'tangent') {
    const circIdx =
      opts.targetElementIdx !== null &&
      opts.targetElementIdx !== undefined &&
      fig.elements[opts.targetElementIdx]?.type === 'circle'
        ? opts.targetElementIdx
        : fig.elements.findIndex((e) => e.type === 'circle');
    const ptsMap = new Map(nextPoints.map((p) => [p.id, p]));
    const circEl = circIdx >= 0 ? fig.elements[circIdx] : null;
    const cPt = circEl && circEl.type === 'circle' ? ptsMap.get(circEl.center) : null;
    const useCx = cPt ? cPt.x : cx;
    const useCy = cPt ? cPt.y : cy;
    const useR = circEl && circEl.type === 'circle' ? circEl.r : r;

    if (nextPoints.length + 2 > FIGURE_LIMITS.maxPoints) {
      return { figure: fig, addedElementIdx: null, error: 'تم بلوغ الحد الأقصى للنقاط.' };
    }

    if (kind === 'chord') {
      const a1 = ((210 + (opts.rotationDeg ?? 0)) * Math.PI) / 180;
      const a2 = ((330 + (opts.rotationDeg ?? 0)) * Math.PI) / 180;
      const p1 = allocId('C');
      nextPoints.push({ id: p1, x: clampCoord(useCx + useR * Math.cos(a1)), y: clampCoord(useCy + useR * Math.sin(a1)), dot: true });
      const p2 = allocId('C');
      nextPoints.push({ id: p2, x: clampCoord(useCx + useR * Math.cos(a2)), y: clampCoord(useCy + useR * Math.sin(a2)), dot: true });
      nextElements.push({ type: 'segment', from: p1, to: p2, stroke: 'green', label: 'وتر' });
      return {
        figure: { ...fig, points: nextPoints, elements: nextElements },
        addedElementIdx: nextElements.length - 1,
      };
    }

    // Tangent at bottom or rotated angle
    const ang = ((-90 + (opts.rotationDeg ?? 0)) * Math.PI) / 180;
    const tx = useCx + useR * Math.cos(ang);
    const ty = useCy + useR * Math.sin(ang);
    const ux = -Math.sin(ang);
    const uy = Math.cos(ang);
    const tanLen = useR * 1.15;
    const t1 = allocId('T');
    nextPoints.push({ id: t1, x: clampCoord(tx - ux * tanLen), y: clampCoord(ty - uy * tanLen) });
    const t2 = allocId('T');
    nextPoints.push({ id: t2, x: clampCoord(tx + ux * tanLen), y: clampCoord(ty + uy * tanLen) });
    nextElements.push({
      type: 'segment',
      from: t1,
      to: t2,
      extendFrom: true,
      extendTo: true,
      stroke: 'ink',
      label: 'مماس',
    });
    return {
      figure: { ...fig, points: nextPoints, elements: nextElements },
      addedElementIdx: nextElements.length - 1,
    };
  }

  // Circle / Cutout / Arc shapes
  if (kind === 'circle' || kind === 'cutout_circle' || kind === 'semicircle' || kind === 'sector') {
    const centerId = pushPt(0, 0, { dot: true });
    if (!centerId) {
      return { figure: fig, addedElementIdx: null, error: 'تم بلوغ الحد الأقصى للنقاط.' };
    }
    if (kind === 'circle' || kind === 'cutout_circle') {
      nextElements.push({
        type: 'circle',
        center: centerId,
        r: clampCoord(Math.max(0.3, r)),
        fill: fillColor,
        fillOpacity: kind === 'cutout_circle' ? 1 : 0.18,
        stroke: strokeColor,
        showCenter: true,
      });
    } else {
      const startDeg = opts.rotationDeg ?? 0;
      const endDeg = startDeg + (kind === 'semicircle' ? 180 : 60);
      nextElements.push({
        type: 'arc',
        center: centerId,
        r: clampCoord(Math.max(0.3, r)),
        startDeg,
        endDeg,
        sector: true,
        fill: kind === 'semicircle' ? fillColor : 'gold',
        fillOpacity: 0.35,
        stroke: strokeColor,
      });
    }
    return {
      figure: { ...fig, points: nextPoints, elements: nextElements },
      addedElementIdx: nextElements.length - 1,
    };
  }

  // Polygon shapes (local coords relative to center (0, 0))
  let localCoords: [number, number][] = [];
  if (kind === 'equilateral_triangle') {
    localCoords = [0, 1, 2].map((i) => {
      const a = ((90 + i * 120) * Math.PI) / 180;
      return [r * Math.cos(a), r * Math.sin(a)];
    });
  } else if (kind === 'isosceles_triangle') {
    localCoords = [
      [0, r * 1.15],
      [-r * 0.85, -r * 0.75],
      [r * 0.85, -r * 0.75],
    ];
  } else if (kind === 'right_triangle') {
    localCoords = [
      [-r * 0.8, r * 0.9],
      [-r * 0.8, -r * 0.7],
      [r * 1.0, -r * 0.7],
    ];
  } else if (kind === 'square') {
    const h = r / Math.SQRT2;
    localCoords = [
      [-h, h],
      [h, h],
      [h, -h],
      [-h, -h],
    ];
  } else if (kind === 'rectangle') {
    localCoords = [
      [-r * 1.1, r * 0.65],
      [r * 1.1, r * 0.65],
      [r * 1.1, -r * 0.65],
      [-r * 1.1, -r * 0.65],
    ];
  } else if (kind === 'rhombus') {
    localCoords = [
      [0, r * 1.1],
      [r * 0.8, 0],
      [0, -r * 1.1],
      [-r * 0.8, 0],
    ];
  } else if (kind === 'parallelogram') {
    localCoords = [
      [-r * 0.65, r * 0.65],
      [r * 1.05, r * 0.65],
      [r * 0.65, -r * 0.65],
      [-r * 1.05, -r * 0.65],
    ];
  } else if (kind === 'trapezoid') {
    localCoords = [
      [-r * 0.55, r * 0.68],
      [r * 0.55, r * 0.68],
      [r * 1.05, -r * 0.68],
      [-r * 1.05, -r * 0.68],
    ];
  } else if (kind === 'kite') {
    localCoords = [
      [0, r * 1.1],
      [r * 0.72, r * 0.25],
      [0, -r * 1.0],
      [-r * 0.72, r * 0.25],
    ];
  } else {
    const n =
      kind === 'pentagon'
        ? 5
        : kind === 'hexagon'
        ? 6
        : kind === 'octagon'
        ? 8
        : Math.max(3, Math.min(12, Math.round(opts.sides ?? 5)));
    localCoords = Array.from({ length: n }, (_, i) => {
      const a = ((90 + (360 * i) / n) * Math.PI) / 180;
      return [r * Math.cos(a), r * Math.sin(a)] as [number, number];
    });
  }

  if (nextPoints.length + localCoords.length > FIGURE_LIMITS.maxPoints) {
    return {
      figure: fig,
      addedElementIdx: null,
      error: `لا توجد نقاط متاحة كافية (المتبقي ${FIGURE_LIMITS.maxPoints - nextPoints.length} نقطة من ${FIGURE_LIMITS.maxPoints}).`,
    };
  }

  const ids: string[] = [];
  for (const [lx, ly] of localCoords) {
    const id = pushPt(lx, ly);
    if (id) ids.push(id);
  }
  if (ids.length < 3) {
    return { figure: fig, addedElementIdx: null, error: 'تعذر إضافة المضلع.' };
  }

  nextElements.push({
    type: 'polygon',
    points: ids,
    fill: fillColor,
    fillOpacity: fillColor === 'white' ? 1 : 0.18,
    stroke: strokeColor,
  });

  if (kind === 'right_triangle' && nextElements.length < FIGURE_LIMITS.maxElements) {
    nextElements.push({
      type: 'angle',
      a: ids[0],
      vertex: ids[1],
      b: ids[2],
      right: true,
      color: strokeColor,
    });
  }

  return {
    figure: { ...fig, points: nextPoints, elements: nextElements },
    addedElementIdx: nextElements.length - 1,
  };
}

