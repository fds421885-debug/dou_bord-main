import type { ChartSeries, ChartType, QuizChart } from './types';

export const CHART_LIMITS = {
  maxPoints: 20,
  maxSeries: 3,
  label: 40,
  title: 100,
  axis: 40,
  name: 40,
  absValue: 1e12,
} as const;

export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  bar: 'أعمدة',
  hbar: 'أعمدة أفقية',
  line: 'خطي',
  pie: 'دائري',
};

export const CHART_PALETTE = ['#1CB0F6', '#58CC02', '#FFC800', '#FF4B4B', '#CE82FF', '#FF9600', '#2B70C9', '#00CD9C'];

export function newChart(type: ChartType = 'bar'): QuizChart {
  return {
    type,
    title: '',
    xLabel: '',
    yLabel: '',
    labels: ['أ', 'ب', 'ج'],
    series: [{ name: '', values: [10, 20, 15] }],
  };
}

const TYPE_ALIASES: Record<string, ChartType> = {
  bar: 'bar', column: 'bar', columns: 'bar', histogram: 'bar', 'أعمدة': 'bar', 'اعمدة': 'bar', 'عمودي': 'bar',
  hbar: 'hbar', horizontal: 'hbar', horizontalbar: 'hbar', barh: 'hbar', 'أفقي': 'hbar', 'أعمدة أفقية': 'hbar',
  line: 'line', 'خطي': 'line', 'خط': 'line', 'خطوط': 'line',
  pie: 'pie', doughnut: 'pie', donut: 'pie', 'دائري': 'pie', 'دائرة': 'pie',
};

export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v
      .trim()
      .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
      .replace(/[٫،]/g, '.')
      .replace(/٬/g, '');
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown, max: number): string {
  if (typeof v === 'string') return v.trim().slice(0, max);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v).slice(0, max);
  return '';
}

function clampVal(n: number): number {
  return Math.max(-CHART_LIMITS.absValue, Math.min(CHART_LIMITS.absValue, n));
}

/** قراءة متسامحة لبيانات الرسم (من JSON أو من قاعدة البيانات). */
export function parseChart(input: unknown): { chart: QuizChart | null; warnings: string[] } {
  const warnings: string[] = [];
  if (!input || typeof input !== 'object') return { chart: null, warnings };
  const o = input as Record<string, unknown>;

  const rawType = String(o.type ?? o.kind ?? o['نوع'] ?? 'bar').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const type: ChartType = TYPE_ALIASES[rawType] ?? TYPE_ALIASES[String(o.type ?? '').trim()] ?? 'bar';
  if (!(rawType in TYPE_ALIASES) && !(String(o.type ?? '').trim() in TYPE_ALIASES)) {
    warnings.push(`نوع الرسم "${String(o.type)}" غير معروف فتم استخدام الأعمدة.`);
  }

  let labels: string[] = [];
  let series: ChartSeries[] = [];

  // الشكل 1: data = [{label, value}]
  const dataArr = o.data ?? o.points;
  if (Array.isArray(dataArr) && !o.labels && !o.series) {
    const pts = dataArr.filter((d) => d && typeof d === 'object') as Record<string, unknown>[];
    labels = pts.map((d) => str(d.label ?? d.name ?? d.x ?? '', CHART_LIMITS.label));
    series = [
      {
        name: '',
        values: pts.map((d) => toNumber(d.value ?? d.y) ?? 0),
      },
    ];
  } else {
    const rawLabels = o.labels ?? o.categories ?? o.x ?? [];
    if (Array.isArray(rawLabels)) labels = rawLabels.map((l) => str(l, CHART_LIMITS.label));
    const rawSeries = o.series ?? o.datasets;
    if (Array.isArray(rawSeries)) {
      series = rawSeries
        .filter((s) => s && typeof s === 'object')
        .map((s) => {
          const so = s as Record<string, unknown>;
          const vals = Array.isArray(so.values ?? so.data) ? ((so.values ?? so.data) as unknown[]) : [];
          return {
            name: str(so.name ?? so.label ?? '', CHART_LIMITS.name),
            values: vals.map((v) => toNumber(v) ?? 0),
          };
        });
    } else if (Array.isArray(o.values)) {
      series = [{ name: '', values: (o.values as unknown[]).map((v) => toNumber(v) ?? 0) }];
    }
  }

  if (labels.length === 0 || series.length === 0 || series.every((s) => s.values.length === 0)) {
    warnings.push('بيانات الرسم ناقصة (التسميات أو القيم) وتم تجاهل الرسم.');
    return { chart: null, warnings };
  }

  if (labels.length > CHART_LIMITS.maxPoints) {
    warnings.push(`الرسم فيه أكثر من ${CHART_LIMITS.maxPoints} نقطة وتم الاكتفاء بأول ${CHART_LIMITS.maxPoints}.`);
    labels = labels.slice(0, CHART_LIMITS.maxPoints);
  }
  if (series.length > CHART_LIMITS.maxSeries) {
    warnings.push(`الرسم فيه أكثر من ${CHART_LIMITS.maxSeries} سلاسل وتم الاكتفاء بأول ${CHART_LIMITS.maxSeries}.`);
    series = series.slice(0, CHART_LIMITS.maxSeries);
  }
  if (type === 'pie' && series.length > 1) {
    warnings.push('الرسم الدائري يدعم سلسلة واحدة فقط، تم استخدام الأولى.');
    series = series.slice(0, 1);
  }

  // مطابقة طول القيم مع التسميات
  const n = labels.length;
  series = series.map((s) => {
    if (s.values.length !== n) {
      warnings.push(`عدد قيم السلسلة "${s.name || 'بدون اسم'}" لا يساوي عدد التسميات، تمت المطابقة.`);
    }
    const values = Array.from({ length: n }, (_, i) => clampVal(s.values[i] ?? 0));
    return { name: s.name, values };
  });

  return {
    chart: {
      type,
      title: str(o.title ?? o['عنوان'] ?? '', CHART_LIMITS.title),
      xLabel: str(o.xLabel ?? o.xAxis ?? '', CHART_LIMITS.axis),
      yLabel: str(o.yLabel ?? o.yAxis ?? '', CHART_LIMITS.axis),
      labels,
      series,
    },
    warnings,
  };
}

export function sanitizeChart(input: unknown): QuizChart | null {
  return parseChart(input).chart;
}

/** رسالة خطأ إن كانت بيانات الرسم غير صالحة للحفظ، وإلا null. */
export function chartProblem(chart: QuizChart): string | null {
  if (chart.labels.length === 0 || chart.series.length === 0) return 'أضف نقطة بيانات واحدة على الأقل.';
  if (chart.labels.some((l) => !l.trim())) return 'اكتب تسمية لكل نقطة في الرسم.';
  if (chart.type === 'pie' && !chart.series[0].values.some((v) => v > 0)) {
    return 'الرسم الدائري يحتاج قيمة موجبة واحدة على الأقل.';
  }
  return null;
}

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range));
  const f = range / Math.pow(10, exp);
  let nf: number;
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

export function niceScale(min: number, max: number, count = 5): { min: number; max: number; ticks: number[] } {
  if (min === max) {
    if (max === 0) max = 1;
    else if (max > 0) min = 0;
    else max = 0;
  }
  const range = niceNum(max - min, false);
  const step = niceNum(range / (count - 1), true);
  const nMin = Math.floor(min / step) * step;
  const nMax = Math.ceil(max / step) * step;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const ticks: number[] = [];
  for (let v = nMin; v <= nMax + step / 2; v += step) ticks.push(+v.toFixed(decimals));
  return { min: ticks[0], max: ticks[ticks.length - 1], ticks };
}
