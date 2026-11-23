import React, { useState } from 'react';
import {
  Activity,
  Award,
  BarChart3,
  Check,
  Clock,
  MessageCircle,
  Sparkles,
  TrendingDown,
  TrendingUp,
  UserCheck,
  UserPlus,
  X,
} from 'lucide-react';
import type { LeaderboardUserEntry } from '../types';

export type UserFriendRelation =
  | 'self'
  | 'friend'
  | 'incoming_pending'
  | 'outgoing_pending'
  | 'none';

interface Props {
  user: LeaderboardUserEntry | null;
  rank?: number | null;
  relation: UserFriendRelation;
  busyAction?: boolean;
  onClose: () => void;
  onSendFriendRequest?: (user: LeaderboardUserEntry) => void;
  onAcceptRequest?: (user: LeaderboardUserEntry) => void;
  onOpenChat?: (user: LeaderboardUserEntry) => void;
}

function pctToneText(pct: number): string {
  if (pct >= 85) return 'text-[#16A34A]';
  if (pct >= 60) return 'text-[#D97706]';
  return 'text-[#DC2626]';
}

function pctToneHex(pct: number): string {
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

export const LeaderboardUserStatsModal: React.FC<Props> = ({
  user,
  rank,
  relation,
  busyAction = false,
  onClose,
  onSendFriendRequest,
  onAcceptRequest,
  onOpenChat,
}) => {
  const [selectedPointIdx, setSelectedPointIdx] = useState<number | null>(null);

  if (!user) return null;

  const snap = user.statsSnapshot;
  const points = snap?.recentPoints || [];
  const timeSlots = snap?.timeSlots || [];
  const weekdays = snap?.weekdays || [];
  const quizRows = snap?.quizRows || [];
  const hasAttempts = user.attemptsCount > 0 && user.totalQuestions > 0;

  // Accuracy donut math
  const r = 42;
  const c = 2 * Math.PI * r;
  const totalAns = Math.max(1, user.correctCount + user.wrongCount);
  const correctRatio = hasAttempts ? user.correctCount / totalAns : 0;
  const correctDash = c * correctRatio;
  const wrongDash = c * (1 - correctRatio);

  // Fluctuation SVG chart
  const chartW = 640;
  const chartH = 210;
  const padL = 36;
  const padR = 20;
  const padT = 18;
  const padB = 34;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;
  const coords = points.map((p, i) => {
    const x = points.length <= 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW;
    const y = padT + (1 - Math.max(0, Math.min(100, p.pct)) / 100) * plotH;
    const yAvg = padT + (1 - Math.max(0, Math.min(100, p.movingAvgPct)) / 100) * plotH;
    return { x, y, yAvg, point: p };
  });
  const linePath = coords
    .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`)
    .join(' ');
  const avgPath = coords
    .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.yAvg.toFixed(1)}`)
    .join(' ');
  const areaPath =
    coords.length > 0
      ? `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`
      : '';

  const activePoint =
    selectedPointIdx !== null && coords[selectedPointIdx]
      ? coords[selectedPointIdx].point
      : points[points.length - 1] || null;

  const initials = user.fullNameQuad
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('');

  return (
    <div
      className="fixed inset-0 z-50 bg-black/65 backdrop-blur-xs flex items-center justify-center p-2 sm:p-5"
      dir="rtl"
    >
      <div className="duo-card max-w-4xl w-full bg-[#FAFAFA] border-2 border-[#E5E5E5] rounded-3xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden">
        {/* Modal Header */}
        <div className="p-4 sm:p-5 bg-white border-b-2 border-[#E5E5E5] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-12 h-12 rounded-2xl bg-[#1CB0F6] border-2 border-b-4 border-[#1899D6] text-white font-black text-base flex items-center justify-center shrink-0">
              {initials || '؟'}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base sm:text-lg font-black text-[#3C3C3C] truncate">
                  {user.fullNameQuad}
                </h2>
                {rank && rank > 0 && (
                  <span className="px-2 py-0.5 rounded-lg bg-[#FFF4CC] border border-[#FFC800] text-[#9A6B00] text-xs font-black">
                    المركز #{rank}
                  </span>
                )}
                {relation === 'self' && (
                  <span className="px-2 py-0.5 rounded-lg bg-[#D7FFB8] border border-[#58CC02] text-[#46A302] text-xs font-black">
                    أنت
                  </span>
                )}
              </div>
              <p className="text-xs font-bold text-[#777777] mt-0.5">
                إحصائيات الأداء الكاملة في الدورة الحالية
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {relation === 'friend' && onOpenChat && (
              <button
                type="button"
                onClick={() => onOpenChat(user)}
                className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer"
              >
                <MessageCircle className="w-4 h-4" />
                <span>مراسلة الصديق</span>
              </button>
            )}
            {relation === 'none' && onSendFriendRequest && (
              <button
                type="button"
                disabled={busyAction}
                onClick={() => onSendFriendRequest(user)}
                className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#1CB0F6] border-2 border-b-4 border-[#1899D6] text-white text-xs font-black cursor-pointer disabled:opacity-60"
              >
                <UserPlus className="w-4 h-4" />
                <span>أضف كصديق</span>
              </button>
            )}
            {relation === 'outgoing_pending' && (
              <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#F3F4F6] border border-[#E5E5E5] text-xs font-black text-[#777777]">
                <Check className="w-4 h-4 text-[#1CB0F6]" />
                <span>تم إرسال طلب الصداقة</span>
              </span>
            )}
            {relation === 'incoming_pending' && onAcceptRequest && (
              <button
                type="button"
                disabled={busyAction}
                onClick={() => onAcceptRequest(user)}
                className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer disabled:opacity-60"
              >
                <UserCheck className="w-4 h-4" />
                <span>قبول طلب الصداقة</span>
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-xl bg-[#F7F7F7] hover:bg-[#EAEAEA] text-[#3C3C3C] cursor-pointer"
              aria-label="إغلاق"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-4 sm:p-5 overflow-y-auto flex flex-col gap-4">
          {/* 4 Main KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-2xl border border-[#E5E5E5] bg-white p-3.5">
              <span className="text-[11px] font-bold text-[#777777]">إجمالي الأسئلة المحلولة</span>
              <p className="text-2xl font-black text-[#3C3C3C] font-latin mt-1">
                {user.totalQuestions}
              </p>
              <span className="text-[11px] font-bold text-[#777777]">
                {user.attemptsCount} اختبار ومحاولة
              </span>
            </div>

            <div className="rounded-2xl border border-[#58CC02]/40 bg-[#F4FFE8] p-3.5">
              <span className="text-[11px] font-bold text-[#46A302]">الإجابات الصحيحة</span>
              <p className="text-2xl font-black text-[#46A302] font-latin mt-1">
                {user.correctCount}
              </p>
              <span className="text-[11px] font-bold text-[#46A302]">
                دقة {snap?.accuracyPct || 0}%
              </span>
            </div>

            <div className="rounded-2xl border border-[#FF4B4B]/40 bg-[#FFF5F5] p-3.5">
              <span className="text-[11px] font-bold text-[#EA2B2B]">الإجابات الخاطئة</span>
              <p className="text-2xl font-black text-[#EA2B2B] font-latin mt-1">
                {user.wrongCount}
              </p>
              <span className="text-[11px] font-bold text-[#EA2B2B]">
                غير مجاب: {snap?.skippedAnswers || 0}
              </span>
            </div>

            <div className="rounded-2xl border border-[#A560E8]/40 bg-[#F8F3FF] p-3.5">
              <span className="text-[11px] font-bold text-[#7E22CE]">أفضل وقت واستقرار الأداء</span>
              <p className="text-sm font-black text-[#7E22CE] mt-1">
                {snap?.bestTimeSlotLabel || 'لم يحدد بعد'}
              </p>
              <span className="text-[11px] font-bold text-[#7E22CE]">
                {snap?.stabilityLabel || 'غير كافٍ للقياس'}
              </span>
            </div>
          </div>

          {!hasAttempts ? (
            <div className="rounded-2xl border border-[#E5E5E5] bg-white p-8 text-center flex flex-col items-center gap-2">
              <Sparkles className="w-10 h-10 text-[#1CB0F6]" />
              <p className="text-sm font-black text-[#3C3C3C]">
                لم يبدأ {user.fullNameQuad} حل أي اختبارات في الدورة الحالية بعد
              </p>
              <p className="text-xs font-bold text-[#777777]">
                بمجرد إكمال أول اختبار ستظهر هنا رسومه البيانية الكاملة وتذبذب درجاته وأفضل أوقاته.
              </p>
            </div>
          ) : (
            <>
              {/* Overview Highlights */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-2xl border border-[#E5E5E5] bg-white p-3">
                  <span className="text-[11px] font-bold text-[#777777]">أعلى درجة</span>
                  <p className="text-lg font-black text-[#16A34A] font-latin">{snap.bestPct}%</p>
                </div>
                <div className="rounded-2xl border border-[#E5E5E5] bg-white p-3">
                  <span className="text-[11px] font-bold text-[#777777]">أقل درجة</span>
                  <p className="text-lg font-black text-[#EA2B2B] font-latin">{snap.worstPct}%</p>
                </div>
                <div className="rounded-2xl border border-[#E5E5E5] bg-white p-3">
                  <span className="text-[11px] font-bold text-[#777777]">سلسلة التفوق (+80%)</span>
                  <p className="text-lg font-black text-[#D97706] font-latin">
                    {snap.bestHighStreak} محاولات
                  </p>
                </div>
                <div className="rounded-2xl border border-[#E5E5E5] bg-white p-3">
                  <span className="text-[11px] font-bold text-[#777777]">إجمالي وقت التدريب</span>
                  <p className="text-sm font-black text-[#1899D6] mt-0.5">
                    {formatTotalHoursMinutes(snap.totalDurationSec)} ({snap.avgSecPerQuestion} ث/س)
                  </p>
                </div>
              </div>

              {/* Fluctuation Line Chart + Accuracy Donut */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2 rounded-2xl border border-[#E5E5E5] bg-white p-4 flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Activity className="w-4 h-4 text-[#1CB0F6]" />
                      <h3 className="text-sm font-black text-[#3C3C3C]">
                        تذبذب الدرجات عبر آخر {points.length} محاولة
                      </h3>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs font-black">
                      {snap.trendDirection === 'up' ? (
                        <span className="inline-flex items-center gap-1 text-[#16A34A]">
                          <TrendingUp className="w-4 h-4" /> +{snap.trendDeltaPct}%
                        </span>
                      ) : snap.trendDirection === 'down' ? (
                        <span className="inline-flex items-center gap-1 text-[#DC2626]">
                          <TrendingDown className="w-4 h-4" /> {snap.trendDeltaPct}%
                        </span>
                      ) : (
                        <span className="text-[#777777]">اتجاه مستقر</span>
                      )}
                      <span className="text-[#777777] font-bold">
                        (انحراف {snap.volatilityStdDev}%)
                      </span>
                    </div>
                  </div>

                  {points.length > 0 && (
                    <>
                      <svg
                        viewBox={`0 0 ${chartW} ${chartH}`}
                        className="w-full h-44 sm:h-52 overflow-visible"
                      >
                        <defs>
                          <linearGradient id="lbAreaGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#1CB0F6" stopOpacity="0.28" />
                            <stop offset="100%" stopColor="#1CB0F6" stopOpacity="0.02" />
                          </linearGradient>
                        </defs>
                        {[0, 25, 50, 75, 100].map((v) => {
                          const y = padT + (1 - v / 100) * plotH;
                          return (
                            <g key={v}>
                              <line
                                x1={padL}
                                y1={y}
                                x2={chartW - padR}
                                y2={y}
                                stroke="#EAEAEA"
                                strokeDasharray={v === 0 ? undefined : '4 4'}
                              />
                              <text
                                x={padL - 6}
                                y={y + 4}
                                textAnchor="end"
                                className="fill-[#777777] text-[10px] font-bold"
                              >
                                {v}%
                              </text>
                            </g>
                          );
                        })}
                        {areaPath && <path d={areaPath} fill="url(#lbAreaGrad)" />}
                        {avgPath && (
                          <path
                            d={avgPath}
                            fill="none"
                            stroke="#A560E8"
                            strokeWidth="2"
                            strokeDasharray="5 4"
                          />
                        )}
                        {linePath && (
                          <path
                            d={linePath}
                            fill="none"
                            stroke="#1CB0F6"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        )}
                        {coords.map((pt, i) => (
                          <g
                            key={pt.point.finishedAt + '_' + i}
                            onClick={() => setSelectedPointIdx(i)}
                            className="cursor-pointer"
                          >
                            <circle
                              cx={pt.x}
                              cy={pt.y}
                              r={selectedPointIdx === i ? 6 : 4.5}
                              fill={pctToneHex(pt.point.pct)}
                              stroke="#FFFFFF"
                              strokeWidth="2"
                            />
                          </g>
                        ))}
                      </svg>
                      {activePoint && (
                        <div className="p-2.5 rounded-xl bg-[#F8FAFC] border border-[#E5E5E5] flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="font-black text-[#3C3C3C] truncate max-w-xs">
                            {activePoint.title}
                          </span>
                          <div className="flex items-center gap-3 font-bold text-[#777777]">
                            <span>{activePoint.dateLabel}</span>
                            <span className={`font-black font-latin ${pctToneText(activePoint.pct)}`}>
                              {activePoint.pct}% ({activePoint.correct}/{activePoint.total})
                            </span>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Accuracy Donut & Type Breakdown */}
                <div className="rounded-2xl border border-[#E5E5E5] bg-white p-4 flex flex-col items-center justify-between gap-3">
                  <div className="flex items-center gap-2 self-start">
                    <Award className="w-4 h-4 text-[#58CC02]" />
                    <h3 className="text-sm font-black text-[#3C3C3C]">توزيع الإجابات</h3>
                  </div>

                  <div className="relative w-32 h-32 flex items-center justify-center">
                    <svg viewBox="0 0 110 110" className="w-full h-full -rotate-90">
                      <circle cx="55" cy="55" r={r} fill="none" stroke="#EAEAEA" strokeWidth="13" />
                      {user.wrongCount > 0 && (
                        <circle
                          cx="55"
                          cy="55"
                          r={r}
                          fill="none"
                          stroke="#FF4B4B"
                          strokeWidth="13"
                          strokeDasharray={`${wrongDash.toFixed(1)} ${c.toFixed(1)}`}
                          strokeDashoffset={(-correctDash).toFixed(1)}
                        />
                      )}
                      {user.correctCount > 0 && (
                        <circle
                          cx="55"
                          cy="55"
                          r={r}
                          fill="none"
                          stroke="#58CC02"
                          strokeWidth="13"
                          strokeDasharray={`${correctDash.toFixed(1)} ${c.toFixed(1)}`}
                          strokeLinecap="round"
                        />
                      )}
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-xl font-black text-[#3C3C3C] font-latin">
                        {snap.accuracyPct}%
                      </span>
                      <span className="text-[10px] font-bold text-[#777777]">الدقة الكلية</span>
                    </div>
                  </div>

                  <div className="w-full grid grid-cols-2 gap-2 text-xs">
                    <div className="p-2 rounded-xl bg-[#F4FFE8] border border-[#58CC02]/30 text-center">
                      <span className="block text-[10px] font-bold text-[#46A302]">صح</span>
                      <span className="font-black text-[#46A302] font-latin">{user.correctCount}</span>
                    </div>
                    <div className="p-2 rounded-xl bg-[#FFF5F5] border border-[#FF4B4B]/30 text-center">
                      <span className="block text-[10px] font-bold text-[#EA2B2B]">خطأ</span>
                      <span className="font-black text-[#EA2B2B] font-latin">{user.wrongCount}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Best Times & Weekdays */}
              {timeSlots.length > 0 && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className="rounded-2xl border border-[#E5E5E5] bg-white p-4 flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-[#FFC800]" />
                      <h3 className="text-sm font-black text-[#3C3C3C]">الأداء حسب وقت الحل</h3>
                    </div>
                    <div className="flex flex-col gap-2">
                      {timeSlots.map((slot) => (
                        <div key={slot.id} className="flex flex-col gap-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-black text-[#3C3C3C]">
                              {slot.label}{' '}
                              <span className="text-[10px] font-bold text-[#777777]">
                                ({slot.rangeLabel})
                              </span>
                              {slot.isBest && (
                                <span className="mr-1.5 px-1.5 py-0.5 rounded bg-[#FFF4CC] text-[#9A6B00] text-[10px] font-black">
                                  الأفضل ★
                                </span>
                              )}
                            </span>
                            <span className={`font-black font-latin ${pctToneText(slot.avgPct)}`}>
                              {slot.attempts > 0 ? `${slot.avgPct}% (${slot.attempts})` : '—'}
                            </span>
                          </div>
                          <svg className="w-full h-2.5 rounded-full bg-[#F1F5F9] block">
                            <rect
                              x="0"
                              y="0"
                              height="100%"
                              rx="4"
                              width={`${slot.attempts > 0 ? Math.max(4, slot.avgPct) : 0}%`}
                              fill={slot.isBest ? '#58CC02' : '#1CB0F6'}
                            />
                          </svg>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-[#E5E5E5] bg-white p-4 flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      <BarChart3 className="w-4 h-4 text-[#A560E8]" />
                      <h3 className="text-sm font-black text-[#3C3C3C]">الأداء حسب أيام الأسبوع</h3>
                    </div>
                    <div className="grid grid-cols-7 gap-1.5">
                      {weekdays.map((d) => (
                        <div
                          key={d.dayIndex}
                          className={`p-2 rounded-xl border text-center flex flex-col items-center gap-1 ${
                            d.isBest
                              ? 'bg-[#D7FFB8]/60 border-[#58CC02]'
                              : 'bg-[#FAFAFA] border-[#E5E5E5]'
                          }`}
                        >
                          <span className="text-[10px] font-black text-[#3C3C3C]">{d.label}</span>
                          <span
                            className={`text-xs font-black font-latin ${
                              d.attempts > 0 ? pctToneText(d.avgPct) : 'text-[#AAAAAA]'
                            }`}
                          >
                            {d.attempts > 0 ? `${d.avgPct}%` : '—'}
                          </span>
                          <span className="text-[10px] font-bold text-[#777777]">
                            {d.attempts}م
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Quiz Breakdown Table */}
              {quizRows.length > 0 && (
                <div className="rounded-2xl border border-[#E5E5E5] bg-white p-4 flex flex-col gap-3">
                  <h3 className="text-sm font-black text-[#3C3C3C]">
                    تفصيل الأداء في النماذج والاختبارات ({quizRows.length})
                  </h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-right border-collapse">
                      <thead>
                        <tr className="border-b-2 border-[#E5E5E5] text-[#777777] font-black">
                          <th className="py-2 px-2">الاختبار</th>
                          <th className="py-2 px-2 text-center">المحاولات</th>
                          <th className="py-2 px-2 text-center">الأسئلة</th>
                          <th className="py-2 px-2 text-center">صح / خطأ</th>
                          <th className="py-2 px-2 text-center">المتوسط</th>
                          <th className="py-2 px-2 text-center">الأعلى</th>
                        </tr>
                      </thead>
                      <tbody>
                        {quizRows.map((row) => (
                          <tr key={row.key} className="border-b border-[#F0F0F0] font-bold">
                            <td className="py-2 px-2 font-black text-[#3C3C3C] max-w-[200px] truncate">
                              {row.title}
                            </td>
                            <td className="py-2 px-2 text-center font-latin">{row.attempts}</td>
                            <td className="py-2 px-2 text-center font-latin">{row.questions}</td>
                            <td className="py-2 px-2 text-center font-latin">
                              <span className="text-[#16A34A]">{row.correct}</span> /{' '}
                              <span className="text-[#DC2626]">{row.wrong}</span>
                            </td>
                            <td className={`py-2 px-2 text-center font-black font-latin ${pctToneText(row.avgPct)}`}>
                              {row.avgPct}%
                            </td>
                            <td className="py-2 px-2 text-center font-black font-latin text-[#16A34A]">
                              {row.bestPct}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
