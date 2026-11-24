import React, { useMemo, useState } from 'react';
import {
  Activity,
  Award,
  BarChart3,
  Calendar,
  Check,
  Clock,
  ClipboardCopy,
  Eye,
  FolderOpen,
  Play,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import type { MyQuiz, QuizAttempt } from '../types';
import { formatDuration } from '../exam';
import {
  computeQuizStats,
  filterAttemptsByCriteria,
  formatAchievementSummaryText,
  type StatsTimeRange,
} from '../quizStats';
import { MathText } from '../mathText';

interface Props {
  attempts: QuizAttempt[];
  quizzes: MyQuiz[];
  onStartExamSetup: () => void;
  onOpenAttempt: (attempt: QuizAttempt) => void;
}

const surface = 'rounded-2xl border border-[#E5E5E5] bg-white p-4 sm:p-5';

function pctToneText(pct: number): string {
  if (pct >= 85) return 'text-[#16A34A]';
  if (pct >= 60) return 'text-[#D97706]';
  return 'text-[#DC2626]';
}

function pctToneColor(pct: number): string {
  if (pct >= 85) return '#16A34A';
  if (pct >= 60) return '#D97706';
  return '#DC2626';
}

function formatTotalHoursMinutes(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} س ${m} د`;
  if (m > 0) return `${m} دقيقة`;
  return `${s} ثانية`;
}

export const MyQuizStatsView: React.FC<Props> = ({
  attempts,
  quizzes,
  onStartExamSetup,
  onOpenAttempt,
}) => {
  const [range, setRange] = useState<StatsTimeRange>('all');
  const [quizFilterId, setQuizFilterId] = useState<string>('all');
  const [copied, setCopied] = useState(false);
  const [showCopyFallback, setShowCopyFallback] = useState(false);
  const [selectedPointIdx, setSelectedPointIdx] = useState<number | null>(null);

  const quizFilterOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const q of quizzes) {
      map.set(q.id, q.title);
    }
    for (const a of attempts) {
      const ids = a.settings?.quizIds ?? [];
      const titles = a.settings?.quizTitles ?? [];
      ids.forEach((id, i) => {
        if (id && !map.has(id)) {
          map.set(id, titles[i] || a.title || 'اختبار');
        }
      });
    }
    return Array.from(map.entries()).map(([id, title]) => ({ id, title }));
  }, [quizzes, attempts]);

  const filteredAttempts = useMemo(
    () => filterAttemptsByCriteria(attempts, range, quizFilterId),
    [attempts, range, quizFilterId]
  );

  const stats = useMemo(() => computeQuizStats(filteredAttempts), [filteredAttempts]);
  const copySummaryText = useMemo(() => formatAchievementSummaryText(stats), [stats]);

  const handleCopySummary = async () => {
    try {
      await navigator.clipboard.writeText(copySummaryText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setShowCopyFallback(true);
    }
  };

  if (attempts.length === 0) {
    return (
      <div className={`${surface} p-8 text-center flex flex-col items-center gap-3`} dir="rtl">
        <div className="w-12 h-12 rounded-2xl bg-[#F3E8FF] border border-[#E2D4F8] text-[#7C3AED] flex items-center justify-center">
          <BarChart3 className="w-6 h-6" />
        </div>
        <h3 className="text-base font-black text-[#3C3C3C]">لا توجد إحصائيات بعد</h3>
        <p className="text-xs font-bold text-[#777777] max-w-md leading-relaxed">
          أكمل أول اختبار لك ليبدأ النظام تلقائياً برصد مجموع الأسئلة الصحيحة والخاطئة، وتذبذب مستواك، وأفضل أوقات التركيز لديك.
        </p>
        <button
          type="button"
          onClick={onStartExamSetup}
          className="duo-btn inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#A560E8] hover:bg-[#B477EE] border-2 border-b-4 border-[#8938D6] text-white text-xs font-black cursor-pointer"
        >
          <Play className="w-4 h-4" />
          <span>ابدأ اختبارك الأول</span>
        </button>
      </div>
    );
  }

  const activePoint =
    selectedPointIdx !== null && stats.points[selectedPointIdx]
      ? stats.points[selectedPointIdx]
      : stats.points[stats.points.length - 1] ?? null;

  // إعداد إحداثيات منحنى تذبذب الأداء
  const lineW = 680;
  const lineH = 230;
  const pad = { top: 20, right: 20, bottom: 34, left: 42 };
  const plotW = lineW - pad.left - pad.right;
  const plotH = lineH - pad.top - pad.bottom;

  const pointCoords = stats.points.map((pt, i) => {
    const x =
      stats.points.length === 1
        ? pad.left + plotW / 2
        : pad.left + (i / (stats.points.length - 1)) * plotW;
    const y = pad.top + ((100 - pt.pct) / 100) * plotH;
    const my = pad.top + ((100 - pt.movingAvgPct) / 100) * plotH;
    return { x, y, my, pt, i };
  });

  const scorePolyline = pointCoords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const movingPolyline = pointCoords.map((c) => `${c.x.toFixed(1)},${c.my.toFixed(1)}`).join(' ');
  const areaPath =
    pointCoords.length >= 2
      ? `M ${pointCoords[0].x.toFixed(1)} ${(pad.top + plotH).toFixed(1)} ` +
        pointCoords.map((c) => `L ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ') +
        ` L ${pointCoords[pointCoords.length - 1].x.toFixed(1)} ${(pad.top + plotH).toFixed(1)} Z`
      : '';

  // رسم دائري (Donut) للدقة الإجمالية
  const rDonut = 54;
  const circDonut = 2 * Math.PI * rDonut;
  const correctFrac = stats.totalQuestions > 0 ? stats.correctAnswers / stats.totalQuestions : 0;
  const correctDash = circDonut * correctFrac;
  const wrongDash = Math.max(0, circDonut - correctDash);

  // أعمدة آخر المحاولات (بحد أقصى 14 محاولة للوضوح)
  const barPoints = stats.points.slice(-14);
  const maxBarTotal = Math.max(1, ...barPoints.map((p) => p.total));

  return (
    <div className="flex flex-col gap-4" dir="rtl">
      {/* شريط التحكم العلوي ونسخ المعلومات */}
      <div className={`${surface} flex flex-col gap-3`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-black text-[#3C3C3C]">لوحة إحصائيات الإنجاز والأداء</h3>
            <p className="text-xs font-bold text-[#777777]">
              متابعة دقيقة لإجاباتك الصحيحة والخاطئة، استقرار مستواك، وأكثر الأوقات التي تحقق فيها أعلى الدرجات.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowCopyFallback((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#E5E5E5] bg-[#FAFAFA] hover:bg-[#F3F4F6] text-xs font-black text-[#3C3C3C] cursor-pointer whitespace-nowrap shrink-0"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>{showCopyFallback ? 'إخفاء الملخص' : 'معاينة الملخص'}</span>
            </button>
            <button
              type="button"
              onClick={() => void handleCopySummary()}
              className="duo-btn inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#7C3AED] hover:bg-[#8B5CF6] border border-b-2 border-[#6D28D9] text-white text-xs font-black cursor-pointer whitespace-nowrap shrink-0"
            >
              {copied ? <Check className="w-4 h-4" /> : <ClipboardCopy className="w-4 h-4" />}
              <span>{copied ? 'تم نسخ معلوماتك ✓' : 'نسخ معلوماتي'}</span>
            </button>
          </div>
        </div>

        {/* فلاتر الفترة والاختبار */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#F0F0F0]">
          <div className="inline-flex rounded-xl border border-[#E5E5E5] bg-[#F7F7F7] p-1 text-xs font-black">
            {(
              [
                { id: 'all', label: 'كل المحاولات' },
                { id: '30d', label: 'آخر 30 يوماً' },
                { id: '7d', label: 'آخر 7 أيام' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  setRange(opt.id);
                  setSelectedPointIdx(null);
                }}
                className={`px-3 py-1.5 rounded-lg cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
                  range === opt.id
                    ? 'bg-white text-[#7C3AED] shadow-xs'
                    : 'text-[#666666] hover:text-[#3C3C3C]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="stats-quiz-filter" className="text-xs font-black text-[#666666] whitespace-nowrap">
              تصفية حسب الاختبار:
            </label>
            <select
              id="stats-quiz-filter"
              value={quizFilterId}
              onChange={(e) => {
                setQuizFilterId(e.target.value);
                setSelectedPointIdx(null);
              }}
              className="max-w-xs rounded-xl border border-[#E5E5E5] bg-white px-3 py-1.5 text-xs font-black text-[#3C3C3C] outline-none focus:border-[#7C3AED]"
            >
              <option value="all">جميع الاختبارات ({attempts.length})</option>
              {quizFilterOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.title}
                </option>
              ))}
            </select>
          </div>
        </div>

        {showCopyFallback && (
          <div className="rounded-xl border border-[#E2D4F8] bg-[#FAF7FF] p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-black text-[#5B21B6]">نص رسالة «نسخ معلوماتي» الجاهز:</span>
              <button
                type="button"
                onClick={() => void handleCopySummary()}
                className="text-xs font-black text-[#7C3AED] hover:underline cursor-pointer"
              >
                {copied ? 'تم النسخ ✓' : 'نسخ النص'}
              </button>
            </div>
            <pre
              dir="rtl"
              className="whitespace-pre-wrap rounded-lg bg-white border border-[#E9D8FD] p-3 text-xs font-bold text-[#3C3C3C] leading-relaxed select-all"
            >
              {copySummaryText}
            </pre>
          </div>
        )}
      </div>

      {filteredAttempts.length === 0 ? (
        <div className={`${surface} p-8 text-center flex flex-col items-center gap-2`}>
          <p className="text-sm font-black text-[#3C3C3C]">لا توجد محاولات مطابقة لهذا الفلتر</p>
          <p className="text-xs font-bold text-[#777777]">جرّب اختيار «كل المحاولات» أو اختبار آخر.</p>
          <button
            type="button"
            onClick={() => {
              setRange('all');
              setQuizFilterId('all');
            }}
            className="mt-1 px-4 py-2 rounded-xl bg-[#F3E8FF] text-[#7C3AED] text-xs font-black cursor-pointer"
          >
            إظهار جميع المحاولات
          </button>
        </div>
      ) : (
        <>
          {/* 4 بطاقات KPI رئيسية */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className={surface}>
              <p className="text-xs font-extrabold text-[#6B7280]">إجمالي الأسئلة</p>
              <p className="text-2xl sm:text-3xl font-black font-latin tabular-nums text-[#1F2937] mt-1">
                {stats.totalQuestions}
              </p>
              <p className="text-[11px] font-bold text-[#777777] mt-1">
                سؤالًا · بمعدل {stats.avgSecPerQuestion} ث/سؤال
              </p>
            </div>

            <div className={surface}>
              <p className="text-xs font-extrabold text-[#15803D]">الإجابات الصحيحة</p>
              <p className="text-2xl sm:text-3xl font-black font-latin tabular-nums text-[#16A34A] mt-1">
                {stats.correctAnswers}
              </p>
              <p className="text-[11px] font-bold text-[#15803D] mt-1">
                إجابة صحيحة · دقة {stats.accuracyPct}%
                {stats.correctedMistakesCount > 0
                  ? ` · منها ${stats.correctedMistakesCount} خطأ مصحّح ✓`
                  : ''}
              </p>
            </div>

            <div className={surface}>
              <p className="text-xs font-extrabold text-[#B91C1C]">الإجابات الخاطئة</p>
              <p className="text-2xl sm:text-3xl font-black font-latin tabular-nums text-[#DC2626] mt-1">
                {stats.wrongAnswers}
              </p>
              <p className="text-[11px] font-bold text-[#991B1B] mt-1">
                إجابة خاطئة
                {stats.pendingMistakesCount > 0
                  ? ` · ${stats.pendingMistakesCount} سؤال بانتظار التصحيح`
                  : stats.correctedMistakesCount > 0
                  ? ' · تم تصحيح كل الأخطاء المعلقة'
                  : ''}
                {stats.skippedAnswers > 0 ? ` · منها ${stats.skippedAnswers} متروك` : ''}
              </p>
            </div>

            <div className={surface}>
              <p className="text-xs font-extrabold text-[#6D28D9]">عدد المحاولات</p>
              <p className="text-2xl sm:text-3xl font-black font-latin tabular-nums text-[#7C3AED] mt-1">
                {stats.attemptsCount}
              </p>
              <p className="text-[11px] font-bold text-[#6B7280] mt-1">
                اختبارًا ومحاولة · {formatTotalHoursMinutes(stats.totalDurationSec)}
              </p>
            </div>
          </div>

          {/* الصف الرئيسي: منحنى التذبذب (2/3) + الرسم الدائري للإتقان (1/3) */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
            {/* منحنى تذبذب الأداء */}
            <div className={`${surface} lg:col-span-2 flex flex-col justify-between gap-3`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-sm font-black text-[#3C3C3C] flex items-center gap-1.5">
                    <Activity className="w-4 h-4 text-[#7C3AED]" />
                    <span>تذبذب الأداء وتطور المستوى عبر المحاولات</span>
                  </h4>
                  <p className="text-[11px] font-bold text-[#777777]">
                    اضغط على أي نقطة لعرض تفاصيل المحاولة · الخط المتقطع يوضح متوسط الاتجاه العام
                  </p>
                </div>
                <div className="flex items-center gap-3 text-[11px] font-extrabold text-[#555]">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-3 h-0.5 bg-[#7C3AED] inline-block" /> النتيجة
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-3 h-0.5 border-t-2 border-dashed border-[#D97706] inline-block" /> الاتجاه
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-3 h-0.5 border-t border-dashed border-[#16A34A] inline-block" /> هدف 80%
                  </span>
                </div>
              </div>

              <div className="w-full overflow-x-auto">
                <svg
                  viewBox={`0 0 ${lineW} ${lineH}`}
                  className="w-full min-w-[460px] h-auto select-none"
                  role="img"
                  aria-label="منحنى تذبذب الأداء عبر المحاولات"
                >
                  <defs>
                    <linearGradient id="statsAreaGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#7C3AED" stopOpacity="0.18" />
                      <stop offset="100%" stopColor="#7C3AED" stopOpacity="0.01" />
                    </linearGradient>
                  </defs>

                  {/* خطوط الشبكة الأفقية */}
                  {[0, 25, 50, 75, 100].map((v) => {
                    const y = pad.top + ((100 - v) / 100) * plotH;
                    return (
                      <g key={v}>
                        <line
                          x1={pad.left}
                          x2={pad.left + plotW}
                          y1={y}
                          y2={y}
                          stroke="#EFEFEF"
                          strokeWidth={1}
                        />
                        <text
                          x={pad.left - 8}
                          y={y + 4}
                          textAnchor="end"
                          fontSize={10}
                          fontWeight={700}
                          fill="#888888"
                        >
                          {v}%
                        </text>
                      </g>
                    );
                  })}

                  {/* خط الهدف 80% */}
                  <line
                    x1={pad.left}
                    x2={pad.left + plotW}
                    y1={pad.top + ((100 - 80) / 100) * plotH}
                    y2={pad.top + ((100 - 80) / 100) * plotH}
                    stroke="#16A34A"
                    strokeOpacity={0.45}
                    strokeDasharray="4 4"
                    strokeWidth={1.25}
                  />

                  {areaPath && <path d={areaPath} fill="url(#statsAreaGrad)" />}

                  {pointCoords.length >= 2 && (
                    <>
                      <polyline
                        fill="none"
                        stroke="#D97706"
                        strokeWidth={2}
                        strokeDasharray="5 4"
                        strokeOpacity={0.85}
                        points={movingPolyline}
                      />
                      <polyline
                        fill="none"
                        stroke="#7C3AED"
                        strokeWidth={2.5}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        points={scorePolyline}
                      />
                    </>
                  )}

                  {pointCoords.map(({ x, y, pt, i }) => {
                    const isActive = activePoint?.index === pt.index;
                    const c = pctToneColor(pt.pct);
                    const showLabel =
                      pointCoords.length <= 12 ||
                      i === 0 ||
                      i === pointCoords.length - 1 ||
                      i % Math.ceil(pointCoords.length / 8) === 0;
                    return (
                      <g
                        key={pt.attempt.id || i}
                        className="cursor-pointer"
                        onClick={() => setSelectedPointIdx(i)}
                      >
                        <circle cx={x} cy={y} r={12} fill="transparent" />
                        {isActive && (
                          <circle cx={x} cy={y} r={8} fill={c} fillOpacity={0.2} />
                        )}
                        <circle
                          cx={x}
                          cy={y}
                          r={isActive ? 5.5 : 4}
                          fill={c}
                          stroke="#FFFFFF"
                          strokeWidth={2}
                        />
                        {showLabel && (
                          <text
                            x={x}
                            y={lineH - 10}
                            textAnchor="middle"
                            fontSize={10}
                            fontWeight={700}
                            fill="#777777"
                          >
                            #{pt.index}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>
              </div>

              {activePoint && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#F9FAFB] border border-[#EFEFEF] px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="font-black text-[#7C3AED] font-latin">#{activePoint.index}</span>
                    <span className="font-black text-[#3C3C3C] min-w-0 break-words leading-relaxed">
                      <MathText text={activePoint.title} inline />
                    </span>
                    <span aria-hidden="true" className="text-[#CBD5E1]">·</span>
                    <span className={`font-black font-latin tabular-nums ${pctToneText(activePoint.pct)}`}>
                      {activePoint.pct}% ({activePoint.correct}/{activePoint.total})
                    </span>
                    <span aria-hidden="true" className="text-[#CBD5E1]">·</span>
                    <span className="font-bold text-[#666666]">
                      {activePoint.dateLabel} ({activePoint.timeLabel}) · {formatDuration(activePoint.durationSec)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenAttempt(activePoint.attempt)}
                    className="inline-flex items-center gap-1 text-[11px] font-black text-[#7C3AED] hover:underline cursor-pointer shrink-0"
                  >
                    <FolderOpen className="w-3.5 h-3.5" /> مراجعة
                  </button>
                </div>
              )}

              {/* مؤشرات التذبذب والثبات */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-[#F0F0F0] text-xs">
                <div>
                  <span className="block text-[11px] font-bold text-[#777777]">مؤشر التذبذب والثبات</span>
                  <span className="font-black text-[#3C3C3C]">
                    {stats.stabilityLabel}
                    {stats.attemptsCount >= 2 && (
                      <span className="font-latin tabular-nums text-[#7C3AED] mr-1">
                        (±{stats.volatilityStdDev}%)
                      </span>
                    )}
                  </span>
                  <span className="block text-[11px] font-bold text-[#888888] font-latin tabular-nums">
                    المدى: {stats.worstPct}% – {stats.bestPct}%
                  </span>
                </div>

                <div>
                  <span className="block text-[11px] font-bold text-[#777777]">اتجاه المستوى العام</span>
                  <span className="inline-flex items-center gap-1 font-black text-[#3C3C3C]">
                    {stats.trendDirection === 'up' && (
                      <>
                        <TrendingUp className="w-4 h-4 text-[#16A34A]" />
                        <span className="text-[#16A34A]">
                          متصاعد (+{stats.trendDeltaPct}%)
                        </span>
                      </>
                    )}
                    {stats.trendDirection === 'down' && (
                      <>
                        <TrendingDown className="w-4 h-4 text-[#DC2626]" />
                        <span className="text-[#DC2626]">
                          متراجع ({stats.trendDeltaPct}%)
                        </span>
                      </>
                    )}
                    {stats.trendDirection === 'flat' && (
                      <span>متوازن ومستقر ({stats.trendDeltaPct >= 0 ? `+${stats.trendDeltaPct}` : stats.trendDeltaPct}%)</span>
                    )}
                  </span>
                  <span className="block text-[11px] font-bold text-[#888888]">
                    مقارنة أحدث المحاولات بالأقدم
                  </span>
                </div>

                <div>
                  <span className="block text-[11px] font-bold text-[#777777]">سلاسل الإتقان (80% فأعلى)</span>
                  <span className="font-black text-[#3C3C3C] font-latin tabular-nums">
                    الحالية: {stats.currentHighStreak} · الأطول: {stats.bestHighStreak}
                  </span>
                  <span className="block text-[11px] font-bold text-[#888888] font-latin tabular-nums">
                    آخر نتيجة: {stats.latestPct}% · الأعلى: {stats.bestPct}%
                  </span>
                </div>
              </div>
            </div>

            {/* الرسم الدائري لنسبة الدقة */}
            <div className={`${surface} flex flex-col justify-between gap-4`}>
              <div>
                <h4 className="text-sm font-black text-[#3C3C3C] flex items-center gap-1.5">
                  <Award className="w-4 h-4 text-[#16A34A]" />
                  <span>نسبة الدقة وتوزيع الإجابات</span>
                </h4>
                <p className="text-[11px] font-bold text-[#777777]">
                  توزيع مجموع الإجابات الصحيحة مقابل الخاطئة
                </p>
              </div>

              <div className="flex items-center justify-center py-1">
                <svg viewBox="0 0 150 150" className="w-40 h-40" role="img" aria-label="رسم دائري لنسبة الدقة">
                  <circle
                    cx="75"
                    cy="75"
                    r={rDonut}
                    fill="none"
                    stroke="#FEE2E2"
                    strokeWidth="18"
                  />
                  {wrongDash > 0 && (
                    <circle
                      cx="75"
                      cy="75"
                      r={rDonut}
                      fill="none"
                      stroke="#EF4444"
                      strokeWidth="18"
                      strokeDasharray={`${circDonut}`}
                      transform="rotate(-90 75 75)"
                    />
                  )}
                  {correctDash > 0 && (
                    <circle
                      cx="75"
                      cy="75"
                      r={rDonut}
                      fill="none"
                      stroke="#16A34A"
                      strokeWidth="18"
                      strokeLinecap={correctFrac < 0.99 ? 'round' : 'butt'}
                      strokeDasharray={`${correctDash} ${circDonut}`}
                      transform="rotate(-90 75 75)"
                    />
                  )}
                  <text
                    x="75"
                    y="72"
                    textAnchor="middle"
                    fontSize="24"
                    fontWeight="900"
                    fill="#1F2937"
                  >
                    {stats.accuracyPct}%
                  </text>
                  <text
                    x="75"
                    y="92"
                    textAnchor="middle"
                    fontSize="11"
                    fontWeight="700"
                    fill="#6B7280"
                  >
                    الدقة الإجمالية
                  </text>
                </svg>
              </div>

              <div className="flex flex-col gap-2 text-xs border-t border-[#F0F0F0] pt-3">
                <div className="flex items-center justify-between font-bold">
                  <span className="inline-flex items-center gap-1.5 text-[#15803D]">
                    <span className="w-2.5 h-2.5 rounded-sm bg-[#16A34A] inline-block" />
                    إجابات صحيحة
                  </span>
                  <span className="font-black font-latin tabular-nums text-[#1F2937]">
                    {stats.correctAnswers} ({stats.accuracyPct}%)
                  </span>
                </div>
                <div className="flex items-center justify-between font-bold">
                  <span className="inline-flex items-center gap-1.5 text-[#B91C1C]">
                    <span className="w-2.5 h-2.5 rounded-sm bg-[#EF4444] inline-block" />
                    إجابات خاطئة
                  </span>
                  <span className="font-black font-latin tabular-nums text-[#1F2937]">
                    {stats.wrongAnswers} ({100 - stats.accuracyPct}%)
                  </span>
                </div>

                {(stats.typeBreakdown.tableTotal > 0 || stats.typeBreakdown.withLawsTotal > 0) && (
                  <div className="pt-2 mt-1 border-t border-[#F5F5F5] flex flex-col gap-1.5 text-[11px]">
                    {stats.typeBreakdown.mcqTotal > 0 && (
                      <div className="flex items-center justify-between font-bold text-[#555]">
                        <span>الاختيار من متعدد</span>
                        <span className="font-latin tabular-nums font-black">
                          {stats.typeBreakdown.mcqCorrect}/{stats.typeBreakdown.mcqTotal} (
                          {Math.round(
                            (stats.typeBreakdown.mcqCorrect / stats.typeBreakdown.mcqTotal) * 100
                          )}
                          %)
                        </span>
                      </div>
                    )}
                    {stats.typeBreakdown.tableTotal > 0 && (
                      <div className="flex items-center justify-between font-bold text-[#555]">
                        <span>الجداول التفاعلية</span>
                        <span className="font-latin tabular-nums font-black">
                          {stats.typeBreakdown.tableCorrect}/{stats.typeBreakdown.tableTotal} (
                          {Math.round(
                            (stats.typeBreakdown.tableCorrect / stats.typeBreakdown.tableTotal) * 100
                          )}
                          %)
                        </span>
                      </div>
                    )}
                    {stats.typeBreakdown.withLawsTotal > 0 && (
                      <div className="flex items-center justify-between font-bold text-[#555]">
                        <span>مسائل لها قوانين</span>
                        <span className="font-latin tabular-nums font-black">
                          {stats.typeBreakdown.withLawsCorrect}/{stats.typeBreakdown.withLawsTotal} (
                          {Math.round(
                            (stats.typeBreakdown.withLawsCorrect /
                              stats.typeBreakdown.withLawsTotal) *
                              100
                          )}
                          %)
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* الصف الثاني: أعمدة أفضل الأوقات + أعمدة الصحيح والخاطئ لكل محاولة */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
            {/* أعمدة أفضل الأوقات */}
            <div className={`${surface} flex flex-col justify-between gap-3`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h4 className="text-sm font-black text-[#3C3C3C] flex items-center gap-1.5">
                    <Clock className="w-4 h-4 text-[#0284C7]" />
                    <span>أفضل الأوقات التي تحل فيها وتجيب درجة عالية</span>
                  </h4>
                  <p className="text-[11px] font-bold text-[#777777]">
                    متوسط درجاتك بحسب وقت إنهاء الاختبار على مدار اليوم
                  </p>
                </div>
              </div>

              {stats.bestTimeSlot && (
                <div className="rounded-xl bg-[#F0FDF4] border border-[#BBF7D0] px-3 py-2 text-xs font-extrabold text-[#166534]">
                  وقتك الذهبي الأعلى دقة: <span className="font-black">{stats.bestTimeSlot.label}</span>{' '}
                  ({stats.bestTimeSlot.rangeLabel}) بمتوسط{' '}
                  <span className="font-latin tabular-nums font-black">{stats.bestTimeSlot.avgPct}%</span>{' '}
                  عبر <span className="font-latin tabular-nums">{stats.bestTimeSlot.attempts}</span>{' '}
                  {stats.bestTimeSlot.attempts === 1 ? 'محاولة' : 'محاولات'} (متوسط{' '}
                  <span className="font-latin tabular-nums">{stats.bestTimeSlot.avgSecPerQ}</span> ث/سؤال).
                </div>
              )}

              {/* مخطط أعمدة الفترات الزمنية */}
              <svg viewBox="0 0 500 205" className="w-full h-auto select-none" role="img" aria-label="أعمدة مقارنة أوقات اليوم">
                {[0, 25, 50, 75, 100].map((v) => {
                  const y = 20 + ((100 - v) / 100) * 130;
                  return (
                    <g key={v}>
                      <line x1={38} x2={486} y1={y} y2={y} stroke="#F1F5F9" strokeWidth={1} />
                      <text x={32} y={y + 4} textAnchor="end" fontSize={10} fontWeight={700} fill="#94A3B8">
                        {v}%
                      </text>
                    </g>
                  );
                })}

                {stats.timeSlots.map((slot, idx) => {
                  const colW = (486 - 44) / stats.timeSlots.length;
                  const barW = 44;
                  const x = 44 + idx * colW + (colW - barW) / 2;
                  const barH = slot.attempts > 0 ? Math.max(6, (slot.avgPct / 100) * 130) : 4;
                  const y = 150 - barH;
                  const fill =
                    slot.attempts === 0
                      ? '#E2E8F0'
                      : slot.isBest
                      ? '#16A34A'
                      : '#0284C7';
                  return (
                    <g key={slot.id}>
                      <rect x={x} y={y} width={barW} height={barH} rx={6} fill={fill} />
                      {slot.attempts > 0 && (
                        <text
                          x={x + barW / 2}
                          y={y - 6}
                          textAnchor="middle"
                          fontSize={11}
                          fontWeight={800}
                          fill={slot.isBest ? '#15803D' : '#1E293B'}
                        >
                          {slot.avgPct}%
                        </text>
                      )}
                      <text
                        x={x + barW / 2}
                        y={170}
                        textAnchor="middle"
                        fontSize={10}
                        fontWeight={800}
                        fill={slot.isBest ? '#15803D' : '#3C3C3C'}
                      >
                        {slot.label.split(' ')[0]}
                      </text>
                      <text
                        x={x + barW / 2}
                        y={186}
                        textAnchor="middle"
                        fontSize={9.5}
                        fontWeight={700}
                        fill="#777777"
                      >
                        {slot.attempts > 0 ? `${slot.attempts} محاولة` : '—'}
                      </text>
                    </g>
                  );
                })}
              </svg>

              {/* أفضل أيام الأسبوع */}
              <div className="pt-2 border-t border-[#F0F0F0] flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-black text-[#3C3C3C] inline-flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-[#7C3AED]" />
                    <span>الأداء حسب أيام الأسبوع</span>
                  </span>
                  {stats.bestWeekday && (
                    <span className="font-bold text-[#15803D]">
                      أقوى يوم: <strong className="font-black">{stats.bestWeekday.label}</strong> (
                      <span className="font-latin tabular-nums">{stats.bestWeekday.avgPct}%</span>)
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-7 gap-1.5 text-center">
                  {stats.weekdays.map((d) => (
                    <div
                      key={d.dayIndex}
                      className={`rounded-xl border px-1 py-1.5 flex flex-col items-center gap-0.5 ${
                        d.isBest
                          ? 'border-[#86EFAC] bg-[#F0FDF4]'
                          : d.attempts > 0
                          ? 'border-[#E5E5E5] bg-[#FAFAFA]'
                          : 'border-[#F3F4F6] bg-white opacity-60'
                      }`}
                    >
                      <span className="text-[10px] font-black text-[#3C3C3C] truncate max-w-full">
                        {d.label}
                      </span>
                      <span
                        className={`text-xs font-black font-latin tabular-nums ${
                          d.attempts === 0 ? 'text-[#9CA3AF]' : pctToneText(d.avgPct)
                        }`}
                      >
                        {d.attempts > 0 ? `${d.avgPct}%` : '—'}
                      </span>
                      <span className="text-[9.5px] font-bold text-[#777777] font-latin tabular-nums">
                        {d.attempts > 0 ? `${d.attempts}م` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* أعمدة الصحيح مقابل الخاطئ في المحاولات الأخيرة */}
            <div className={`${surface} flex flex-col justify-between gap-3`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-sm font-black text-[#3C3C3C] flex items-center gap-1.5">
                    <BarChart3 className="w-4 h-4 text-[#16A34A]" />
                    <span>أعمدة الإجابات الصحيحة والخاطئة لكل محاولة</span>
                  </h4>
                  <p className="text-[11px] font-bold text-[#777777]">
                    عرض آخر {barPoints.length} {barPoints.length === 1 ? 'محاولة' : 'محاولات'} (الأخضر = صحيح، الأحمر = خطأ)
                  </p>
                </div>
                <div className="flex items-center gap-3 text-[11px] font-extrabold text-[#555]">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-xs bg-[#16A34A] inline-block" /> صحيح
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-xs bg-[#EF4444] inline-block" /> خاطئ
                  </span>
                </div>
              </div>

              <div className="w-full overflow-x-auto">
                <svg
                  viewBox="0 0 520 220"
                  className="w-full min-w-[380px] h-auto select-none"
                  role="img"
                  aria-label="أعمدة الإجابات الصحيحة والخاطئة لكل محاولة"
                >
                  {[0, 0.5, 1].map((frac, gi) => {
                    const y = 165 - frac * 135;
                    const val = Math.round(maxBarTotal * frac);
                    return (
                      <g key={gi}>
                        <line x1={34} x2={508} y1={y} y2={y} stroke="#F1F5F9" strokeWidth={1} />
                        <text x={28} y={y + 4} textAnchor="end" fontSize={10} fontWeight={700} fill="#94A3B8">
                          {val}
                        </text>
                      </g>
                    );
                  })}

                  {barPoints.map((pt, idx) => {
                    const count = barPoints.length;
                    const slotW = (508 - 38) / count;
                    const bw = Math.max(12, Math.min(34, slotW * 0.65));
                    const x = 38 + idx * slotW + (slotW - bw) / 2;
                    const totalH = Math.max(4, (pt.total / maxBarTotal) * 135);
                    const correctH = pt.total > 0 ? (pt.correct / pt.total) * totalH : 0;
                    const wrongH = Math.max(0, totalH - correctH);
                    const yWrong = 165 - totalH;
                    const yCorrect = 165 - correctH;
                    const globalIdx = stats.points.length - barPoints.length + idx;
                    return (
                      <g
                        key={pt.attempt.id || idx}
                        className="cursor-pointer"
                        onClick={() => setSelectedPointIdx(globalIdx)}
                      >
                        {wrongH > 0 && (
                          <rect x={x} y={yWrong} width={bw} height={wrongH} rx={3} fill="#EF4444" />
                        )}
                        {correctH > 0 && (
                          <rect x={x} y={yCorrect} width={bw} height={correctH} rx={3} fill="#16A34A" />
                        )}
                        <text
                          x={x + bw / 2}
                          y={yWrong - 5}
                          textAnchor="middle"
                          fontSize={9.5}
                          fontWeight={800}
                          fill="#3C3C3C"
                        >
                          {pt.correct}/{pt.total}
                        </text>
                        <text
                          x={x + bw / 2}
                          y={184}
                          textAnchor="middle"
                          fontSize={9.5}
                          fontWeight={700}
                          fill="#64748B"
                        >
                          #{pt.index}
                        </text>
                        <text
                          x={x + bw / 2}
                          y={199}
                          textAnchor="middle"
                          fontSize={9}
                          fontWeight={700}
                          fill={pctToneColor(pt.pct)}
                        >
                          {pt.pct}%
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            </div>
          </div>

          {/* جدول تحليل أوقات الدراسة بالتفصيل */}
          <div className={surface}>
            <div className="mb-3">
              <h4 className="text-sm font-black text-[#3C3C3C]">جدول تفصيل الأداء حسب أوقات اليوم</h4>
              <p className="text-[11px] font-bold text-[#777777]">
                يساعدك على اكتشاف الفترة الزمنية التي يكون فيها تركيزك وسرعتك ودقتك في أعلى مستوى
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-[#E5E5E5] text-[#6B7280] font-black">
                    <th className="py-2.5 px-2 text-right">الفترة</th>
                    <th className="py-2.5 px-2 text-right">النطاق الزمني</th>
                    <th className="py-2.5 px-2 text-left">المحاولات</th>
                    <th className="py-2.5 px-2 text-left">الأسئلة</th>
                    <th className="py-2.5 px-2 text-left">صحيح</th>
                    <th className="py-2.5 px-2 text-left">خطأ</th>
                    <th className="py-2.5 px-2 text-left">المتوسط</th>
                    <th className="py-2.5 px-2 text-left">السرعة</th>
                    <th className="py-2.5 px-2 text-right">النتيجة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F3F4F6] font-bold text-[#3C3C3C]">
                  {stats.timeSlots.map((slot) => (
                    <tr
                      key={slot.id}
                      className={slot.isBest ? 'bg-[#F0FDF4]/70' : 'hover:bg-[#FAFAFA]'}
                    >
                      <td className="py-2.5 px-2 font-black whitespace-nowrap">{slot.label}</td>
                      <td className="py-2.5 px-2 text-[#6B7280] whitespace-nowrap">{slot.rangeLabel}</td>
                      <td className="py-2.5 px-2 text-left font-latin tabular-nums">{slot.attempts}</td>
                      <td className="py-2.5 px-2 text-left font-latin tabular-nums">{slot.questions}</td>
                      <td className="py-2.5 px-2 text-left font-latin tabular-nums text-[#16A34A]">
                        {slot.correct}
                      </td>
                      <td className="py-2.5 px-2 text-left font-latin tabular-nums text-[#DC2626]">
                        {slot.wrong}
                      </td>
                      <td
                        className={`py-2.5 px-2 text-left font-black font-latin tabular-nums ${
                          slot.attempts > 0 ? pctToneText(slot.avgPct) : 'text-[#9CA3AF]'
                        }`}
                      >
                        {slot.attempts > 0 ? `${slot.avgPct}%` : '—'}
                      </td>
                      <td className="py-2.5 px-2 text-left font-latin tabular-nums text-[#6B7280]">
                        {slot.attempts > 0 ? `${slot.avgSecPerQ} ث` : '—'}
                      </td>
                      <td className="py-2.5 px-2 whitespace-nowrap">
                        {slot.attempts === 0 ? (
                          <span className="text-[#9CA3AF]">بلا محاولات</span>
                        ) : slot.isBest ? (
                          <span className="font-black text-[#15803D]">أفضل وقت ★</span>
                        ) : slot.avgPct >= 80 ? (
                          <span className="text-[#16A34A]">أداء ممتاز</span>
                        ) : slot.avgPct >= 60 ? (
                          <span className="text-[#D97706]">أداء جيد</span>
                        ) : (
                          <span className="text-[#DC2626]">تركيز أقل</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* جدول الأداء حسب الاختبارات والنماذج */}
          <div className={surface}>
            <div className="mb-3">
              <h4 className="text-sm font-black text-[#3C3C3C]">جدول ملخص الأداء حسب النماذج والاختبارات</h4>
              <p className="text-[11px] font-bold text-[#777777]">
                مقارنة دقتك وتطورك عبر كل اختبار أو نموذج خضته
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-[#E5E5E5] text-[#6B7280] font-black">
                    <th className="py-2.5 px-2 text-right">الاختبار / النموذج</th>
                    <th className="py-2.5 px-2 text-left">المحاولات</th>
                    <th className="py-2.5 px-2 text-left">الأسئلة</th>
                    <th className="py-2.5 px-2 text-left">صحيح</th>
                    <th className="py-2.5 px-2 text-left">خطأ</th>
                    <th className="py-2.5 px-2 text-left">المتوسط</th>
                    <th className="py-2.5 px-2 text-left">الأعلى</th>
                    <th className="py-2.5 px-2 text-left">السرعة</th>
                    <th className="py-2.5 px-2 text-left">التطور</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F3F4F6] font-bold text-[#3C3C3C]">
                  {stats.quizRows.map((row) => (
                    <tr key={row.key} className="hover:bg-[#FAFAFA]">
                      <td className="py-2.5 px-2 font-black max-w-[240px] break-words leading-relaxed" title={row.title}>
                        <MathText text={row.title} inline />
                      </td>
                      <td className="py-2.5 px-2 text-left font-latin tabular-nums">{row.attempts}</td>
                      <td className="py-2.5 px-2 text-left font-latin tabular-nums">{row.questions}</td>
                      <td className="py-2.5 px-2 text-left font-latin tabular-nums text-[#16A34A]">
                        {row.correct}
                      </td>
                      <td className="py-2.5 px-2 text-left font-latin tabular-nums text-[#DC2626]">
                        {row.wrong}
                      </td>
                      <td className={`py-2.5 px-2 text-left font-black font-latin tabular-nums ${pctToneText(row.avgPct)}`}>
                        {row.avgPct}%
                      </td>
                      <td className="py-2.5 px-2 text-left font-latin tabular-nums text-[#3C3C3C]">
                        {row.bestPct}%
                      </td>
                      <td className="py-2.5 px-2 text-left font-latin tabular-nums text-[#6B7280]">
                        {row.avgSecPerQ} ث
                      </td>
                      <td className="py-2.5 px-2 text-left font-latin tabular-nums">
                        {row.attempts < 2 ? (
                          <span className="text-[#9CA3AF]">—</span>
                        ) : row.deltaPct > 0 ? (
                          <span className="text-[#16A34A]">+{row.deltaPct}%</span>
                        ) : row.deltaPct < 0 ? (
                          <span className="text-[#DC2626]">{row.deltaPct}%</span>
                        ) : (
                          <span className="text-[#6B7280]">0%</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
