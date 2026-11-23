import type { QuizAttempt } from './types';
import { computeMistakeLedger, isMistakeReviewAttempt } from './mistakeLedger';

export type StatsTimeRange = 'all' | '30d' | '7d';

export interface TimeSlotStat {
  id: 'dawn' | 'morning' | 'afternoon' | 'evening' | 'night';
  label: string;
  rangeLabel: string;
  attempts: number;
  questions: number;
  correct: number;
  wrong: number;
  avgPct: number;
  avgSecPerQ: number;
  highScoreAttempts: number;
  isBest: boolean;
}

export interface WeekdayStat {
  dayIndex: number; // 0 = Sun .. 6 = Sat
  label: string;
  attempts: number;
  questions: number;
  correct: number;
  avgPct: number;
  isBest: boolean;
}

export interface AttemptPoint {
  attempt: QuizAttempt;
  index: number;
  title: string;
  finishedAt: number;
  dateLabel: string;
  timeLabel: string;
  pct: number;
  movingAvgPct: number;
  correct: number;
  wrong: number;
  total: number;
  durationSec: number;
  secPerQ: number;
}

export interface QuizBreakdownRow {
  key: string;
  title: string;
  attempts: number;
  questions: number;
  correct: number;
  wrong: number;
  avgPct: number;
  bestPct: number;
  latestPct: number;
  deltaPct: number;
  avgSecPerQ: number;
}

export interface QuestionTypeBreakdown {
  mcqTotal: number;
  mcqCorrect: number;
  tableTotal: number;
  tableCorrect: number;
  withLawsTotal: number;
  withLawsCorrect: number;
}

export interface ComputedQuizStats {
  attemptsCount: number;
  totalQuestions: number;
  correctAnswers: number;
  wrongAnswers: number;
  skippedAnswers: number;
  correctedMistakesCount: number;
  pendingMistakesCount: number;
  accuracyPct: number;
  totalDurationSec: number;
  avgSecPerQuestion: number;
  bestPct: number;
  worstPct: number;
  latestPct: number;
  /** الانحراف المعياري بين نسب المحاولات */
  volatilityStdDev: number;
  /** المدى بين أعلى وأقل نسبة */
  rangePct: number;
  stabilityLabel: 'مستقر جداً' | 'تذبذب متوسط' | 'تذبذب مرتفع' | 'غير كافٍ للقياس';
  trendDirection: 'up' | 'down' | 'flat';
  trendDeltaPct: number;
  currentHighStreak: number;
  bestHighStreak: number;
  points: AttemptPoint[];
  timeSlots: TimeSlotStat[];
  bestTimeSlot: TimeSlotStat | null;
  weekdays: WeekdayStat[];
  bestWeekday: WeekdayStat | null;
  quizRows: QuizBreakdownRow[];
  typeBreakdown: QuestionTypeBreakdown;
}

const TIME_SLOTS: Array<{
  id: TimeSlotStat['id'];
  label: string;
  rangeLabel: string;
  match: (h: number) => boolean;
}> = [
  { id: 'dawn', label: 'الفجر والصباح الباكر', rangeLabel: '5 ص – 10 ص', match: (h) => h >= 5 && h < 10 },
  { id: 'morning', label: 'الضحى والظهر', rangeLabel: '10 ص – 2 م', match: (h) => h >= 10 && h < 14 },
  { id: 'afternoon', label: 'العصر', rangeLabel: '2 م – 6 م', match: (h) => h >= 14 && h < 18 },
  { id: 'evening', label: 'المساء', rangeLabel: '6 م – 10 م', match: (h) => h >= 18 && h < 22 },
  { id: 'night', label: 'الليل المتأخر', rangeLabel: '10 م – 5 ص', match: (h) => h >= 22 || h < 5 },
];

// ترتيب الأسبوع العربي بدءاً من السبت
const ARABIC_WEEKDAYS: Array<{ dayIndex: number; label: string }> = [
  { dayIndex: 6, label: 'السبت' },
  { dayIndex: 0, label: 'الأحد' },
  { dayIndex: 1, label: 'الإثنين' },
  { dayIndex: 2, label: 'الثلاثاء' },
  { dayIndex: 3, label: 'الأربعاء' },
  { dayIndex: 4, label: 'الخميس' },
  { dayIndex: 5, label: 'الجمعة' },
];

export function filterAttemptsByCriteria(
  attempts: QuizAttempt[],
  range: StatsTimeRange,
  quizFilterId: string,
  nowMs = Date.now()
): QuizAttempt[] {
  const cutoff =
    range === '7d'
      ? nowMs - 7 * 24 * 60 * 60 * 1000
      : range === '30d'
      ? nowMs - 30 * 24 * 60 * 60 * 1000
      : 0;

  return attempts.filter((a) => {
    if (cutoff > 0 && (a.finishedAt || 0) < cutoff) return false;
    if (quizFilterId !== 'all') {
      const ids = a.settings?.quizIds ?? [];
      if (!ids.includes(quizFilterId)) return false;
    }
    return true;
  });
}

export function computeQuizStats(attempts: QuizAttempt[]): ComputedQuizStats {
  const sortedAsc = attempts
    .slice()
    .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
  const ledger = computeMistakeLedger(sortedAsc);

  let totalDurationSec = 0;

  const typeBreakdown: QuestionTypeBreakdown = {
    mcqTotal: 0,
    mcqCorrect: 0,
    tableTotal: 0,
    tableCorrect: 0,
    withLawsTotal: 0,
    withLawsCorrect: 0,
  };

  const slotAccum = new Map<
    TimeSlotStat['id'],
    { attempts: number; questions: number; correct: number; durationSec: number; high: number }
  >();
  for (const s of TIME_SLOTS) {
    slotAccum.set(s.id, { attempts: 0, questions: 0, correct: 0, durationSec: 0, high: 0 });
  }

  const dayAccum = new Map<number, { attempts: number; questions: number; correct: number }>();
  for (const d of ARABIC_WEEKDAYS) {
    dayAccum.set(d.dayIndex, { attempts: 0, questions: 0, correct: 0 });
  }

  const quizAccum = new Map<
    string,
    {
      title: string;
      attempts: number;
      questions: number;
      correct: number;
      durationSec: number;
      pcts: number[];
    }
  >();

  const rawPoints: Array<Omit<AttemptPoint, 'movingAvgPct'>> = [];

  for (let i = 0; i < sortedAsc.length; i++) {
    const a = sortedAsc[i];
    const total = Math.max(0, a.total || a.questions?.length || 0);
    const correct = Math.max(0, Math.min(total, a.score || 0));
    const wrong = Math.max(0, total - correct);
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    const durationSec = Math.max(0, a.durationSec || 0);

    totalDurationSec += Math.max(0, durationSec);

    const isReview = isMistakeReviewAttempt(a);

    // تحليل نوع الأسئلة (من الاختبارات الأصلية، ثم تضاف الأخطاء المصححة من السجل)
    if (!isReview && Array.isArray(a.questions) && Array.isArray(a.answers)) {
      for (let qi = 0; qi < a.questions.length; qi++) {
        const q = a.questions[qi];
        const ans = a.answers[qi];
        const isTable = q.questionType === 'table' || Boolean(q.table);
        const isCorrectQ = isTable ? ans === 1 : ans === q.correctIndex;
        if (isTable) {
          typeBreakdown.tableTotal++;
          if (isCorrectQ) typeBreakdown.tableCorrect++;
        } else {
          typeBreakdown.mcqTotal++;
          if (isCorrectQ) typeBreakdown.mcqCorrect++;
        }
        if (Array.isArray(q.laws) && q.laws.length > 0) {
          typeBreakdown.withLawsTotal++;
          if (isCorrectQ) typeBreakdown.withLawsCorrect++;
        }
      }
    }

    const dt = new Date(a.finishedAt || Date.now());
    const hour = dt.getHours();
    const slotMeta = TIME_SLOTS.find((s) => s.match(hour)) ?? TIME_SLOTS[TIME_SLOTS.length - 1];
    const sa = slotAccum.get(slotMeta.id)!;
    sa.attempts++;
    sa.questions += total;
    sa.correct += correct;
    sa.durationSec += durationSec;
    if (pct >= 85) sa.high++;

    const wd = dt.getDay();
    const da = dayAccum.get(wd);
    if (da) {
      da.attempts++;
      da.questions += total;
      da.correct += correct;
    }

    if (!isReview) {
      const qKey =
        a.settings?.quizIds?.length === 1
          ? `q:${a.settings.quizIds[0]}`
          : `t:${(a.title || 'اختبار').trim()}`;
      const qa = quizAccum.get(qKey) ?? {
        title: a.title || 'اختبار',
        attempts: 0,
        questions: 0,
        correct: 0,
        durationSec: 0,
        pcts: [],
      };
      qa.attempts++;
      qa.questions += total;
      qa.correct += correct;
      qa.durationSec += durationSec;
      qa.pcts.push(pct);
      quizAccum.set(qKey, qa);
    }

    rawPoints.push({
      attempt: a,
      index: i + 1,
      title: a.title || 'اختبار',
      finishedAt: a.finishedAt || 0,
      dateLabel: dt.toLocaleDateString('ar-EG', { month: 'short', day: 'numeric' }),
      timeLabel: dt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
      pct,
      correct,
      wrong,
      total,
      durationSec,
      secPerQ: total > 0 ? Math.round(durationSec / total) : 0,
    });
  }

  // متوسط متحرك لآخر 3 محاولات عند كل نقطة
  const points: AttemptPoint[] = rawPoints.map((pt, idx) => {
    const start = Math.max(0, idx - 2);
    const slice = rawPoints.slice(start, idx + 1);
    const movingAvgPct = Math.round(
      slice.reduce((sum, p) => sum + p.pct, 0) / slice.length
    );
    return { ...pt, movingAvgPct };
  });

  typeBreakdown.mcqCorrect = Math.min(
    typeBreakdown.mcqTotal,
    typeBreakdown.mcqCorrect + ledger.redeemedMcqCount
  );
  typeBreakdown.tableCorrect = Math.min(
    typeBreakdown.tableTotal,
    typeBreakdown.tableCorrect + ledger.redeemedTableCount
  );
  typeBreakdown.withLawsCorrect = Math.min(
    typeBreakdown.withLawsTotal,
    typeBreakdown.withLawsCorrect + ledger.redeemedWithLawsCount
  );

  const totalQuestions = ledger.totalQuestions;
  const correctAnswers = ledger.correctAnswers;
  const wrongAnswers = ledger.wrongAnswers;
  const skippedAnswers = ledger.skippedAnswers;
  const accuracyPct = totalQuestions > 0 ? Math.round((correctAnswers / totalQuestions) * 100) : 0;
  const avgSecPerQuestion =
    totalQuestions > 0 ? Math.round(totalDurationSec / totalQuestions) : 0;

  const pcts = points.map((p) => p.pct);
  const bestPct = pcts.length > 0 ? Math.max(...pcts) : 0;
  const worstPct = pcts.length > 0 ? Math.min(...pcts) : 0;
  const latestPct = pcts.length > 0 ? pcts[pcts.length - 1] : 0;
  const rangePct = pcts.length > 1 ? bestPct - worstPct : 0;

  let volatilityStdDev = 0;
  if (pcts.length >= 2) {
    const mean = pcts.reduce((s, v) => s + v, 0) / pcts.length;
    const variance = pcts.reduce((s, v) => s + (v - mean) ** 2, 0) / pcts.length;
    volatilityStdDev = Math.round(Math.sqrt(variance) * 10) / 10;
  }

  const stabilityLabel: ComputedQuizStats['stabilityLabel'] =
    pcts.length < 2
      ? 'غير كافٍ للقياس'
      : volatilityStdDev <= 8
      ? 'مستقر جداً'
      : volatilityStdDev <= 16
      ? 'تذبذب متوسط'
      : 'تذبذب مرتفع';

  let trendDeltaPct = 0;
  let trendDirection: 'up' | 'down' | 'flat' = 'flat';
  if (pcts.length >= 2) {
    const windowSize = Math.min(3, Math.floor(pcts.length / 2)) || 1;
    const earlier = pcts.slice(0, windowSize);
    const recent = pcts.slice(-windowSize);
    const avgEarlier = earlier.reduce((s, v) => s + v, 0) / earlier.length;
    const avgRecent = recent.reduce((s, v) => s + v, 0) / recent.length;
    trendDeltaPct = Math.round(avgRecent - avgEarlier);
    trendDirection = trendDeltaPct >= 3 ? 'up' : trendDeltaPct <= -3 ? 'down' : 'flat';
  }

  let bestHighStreak = 0;
  let running = 0;
  for (const p of pcts) {
    if (p >= 80) {
      running++;
      if (running > bestHighStreak) bestHighStreak = running;
    } else {
      running = 0;
    }
  }
  const currentHighStreak = running;

  const rawSlots: TimeSlotStat[] = TIME_SLOTS.map((meta) => {
    const acc = slotAccum.get(meta.id)!;
    const avgPct = acc.questions > 0 ? Math.round((acc.correct / acc.questions) * 100) : 0;
    const avgSecPerQ = acc.questions > 0 ? Math.round(acc.durationSec / acc.questions) : 0;
    return {
      id: meta.id,
      label: meta.label,
      rangeLabel: meta.rangeLabel,
      attempts: acc.attempts,
      questions: acc.questions,
      correct: acc.correct,
      wrong: Math.max(0, acc.questions - acc.correct),
      avgPct,
      avgSecPerQ,
      highScoreAttempts: acc.high,
      isBest: false,
    };
  });

  const activeSlots = rawSlots.filter((s) => s.attempts > 0);
  let bestSlotId: TimeSlotStat['id'] | null = null;
  if (activeSlots.length > 0) {
    const sorted = activeSlots
      .slice()
      .sort((a, b) => b.avgPct - a.avgPct || b.questions - a.questions);
    bestSlotId = sorted[0].id;
  }
  const timeSlots = rawSlots.map((s) => ({ ...s, isBest: s.id === bestSlotId }));
  const bestTimeSlot = timeSlots.find((s) => s.isBest) ?? null;

  const rawWeekdays: WeekdayStat[] = ARABIC_WEEKDAYS.map((d) => {
    const acc = dayAccum.get(d.dayIndex)!;
    const avgPct = acc.questions > 0 ? Math.round((acc.correct / acc.questions) * 100) : 0;
    return {
      dayIndex: d.dayIndex,
      label: d.label,
      attempts: acc.attempts,
      questions: acc.questions,
      correct: acc.correct,
      avgPct,
      isBest: false,
    };
  });
  const activeDays = rawWeekdays.filter((d) => d.attempts > 0);
  let bestDayIdx: number | null = null;
  if (activeDays.length > 0) {
    const sorted = activeDays
      .slice()
      .sort((a, b) => b.avgPct - a.avgPct || b.questions - a.questions);
    bestDayIdx = sorted[0].dayIndex;
  }
  const weekdays = rawWeekdays.map((d) => ({ ...d, isBest: d.dayIndex === bestDayIdx }));
  const bestWeekday = weekdays.find((d) => d.isBest) ?? null;

  const quizRows: QuizBreakdownRow[] = Array.from(quizAccum.entries())
    .map(([key, q]) => {
      const redeemed =
        key === 'q:coach_mistakes_review' ? 0 : ledger.redeemedByQuizRowKey[key] || 0;
      const effectiveCorrect = Math.min(q.questions, q.correct + redeemed);
      const effectiveWrong = Math.max(0, q.questions - effectiveCorrect);
      const avgPct = q.questions > 0 ? Math.round((effectiveCorrect / q.questions) * 100) : 0;
      const bestQ = q.pcts.length > 0 ? Math.max(...q.pcts) : 0;
      const latestQ = q.pcts.length > 0 ? q.pcts[q.pcts.length - 1] : 0;
      const firstQ = q.pcts.length > 0 ? q.pcts[0] : 0;
      return {
        key,
        title: q.title,
        attempts: q.attempts,
        questions: q.questions,
        correct: effectiveCorrect,
        wrong: effectiveWrong,
        avgPct,
        bestPct: bestQ,
        latestPct: latestQ,
        deltaPct: q.pcts.length >= 2 ? latestQ - firstQ : 0,
        avgSecPerQ: q.questions > 0 ? Math.round(q.durationSec / q.questions) : 0,
      };
    })
    .sort((a, b) => b.attempts - a.attempts || b.questions - a.questions);

  return {
    attemptsCount: sortedAsc.length,
    totalQuestions,
    correctAnswers,
    wrongAnswers,
    skippedAnswers,
    correctedMistakesCount: ledger.correctedMistakesCount,
    pendingMistakesCount: ledger.unresolvedMistakes.length,
    accuracyPct,
    totalDurationSec,
    avgSecPerQuestion,
    bestPct,
    worstPct,
    latestPct,
    volatilityStdDev,
    rangePct,
    stabilityLabel,
    trendDirection,
    trendDeltaPct,
    currentHighStreak,
    bestHighStreak,
    points,
    timeSlots,
    bestTimeSlot,
    weekdays,
    bestWeekday,
    quizRows,
    typeBreakdown,
  };
}

/** رسالة مختصرة لنسخ ملخص الإنجاز بالصيغة المطلوبة. */
export function formatAchievementSummaryText(
  stats: Pick<
    ComputedQuizStats,
    'totalQuestions' | 'correctAnswers' | 'wrongAnswers' | 'attemptsCount'
  >
): string {
  return [
    'إحصائيات إنجازك',
    'إجمالي الأسئلة',
    String(stats.totalQuestions),
    'سؤالًا',
    'الإجابات الصحيحة',
    String(stats.correctAnswers),
    'إجابة صحيحة',
    'الإجابات الخاطئة',
    String(stats.wrongAnswers),
    'إجابة خاطئة',
    'عدد المحاولات',
    String(stats.attemptsCount),
    'اختبارًا ومحاولة',
  ].join('\n');
}
