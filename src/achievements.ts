import { computeMistakeLedger, isMistakeReviewAttempt } from './mistakeLedger';
import { gradeTableQuestion } from './quizTable';
import type {
  LeaderboardAchievementRecords,
  LeaderboardAchievementsSnapshot,
  LeaderboardUserEntry,
  QuizAttempt,
} from './types';

export type AchievementCategory =
  | 'daily'
  | 'speed'
  | 'volume'
  | 'perfection'
  | 'consistency'
  | 'mistakes'
  | 'mastery';

export type AchievementTier = 'bronze' | 'silver' | 'gold' | 'diamond' | 'legend';

export interface AchievementMetrics {
  attemptsCount: number;
  totalQuestions: number;
  totalCorrect: number;
  overallAccuracyPct: number;
  totalDurationSec: number;
  totalDurationMin: number;
  maxQuestionsInDay: number;
  maxCorrectInDay: number;
  fastest100Sec: number | null;
  fastest50Sec: number | null;
  fastest25Sec: number | null;
  bestAvgSecPerQ20: number | null;
  bestAccurateSpeedAvgSecPerQ: number | null;
  perfect100Count: number;
  bestPerfect100Streak: number;
  bestHigh80Streak: number;
  activeDaysCount: number;
  maxConsecutiveActiveDays: number;
  dawnAttempts: number;
  nightAttempts: number;
  mistakeReviewAttempts: number;
  correctedMistakesTotal: number;
  drillAttempts: number;
  tableQuestionsCorrect: number;
  withLawsCorrect: number;
}

export interface AchievementEvaluation {
  unlocked: boolean;
  progressPct: number;
  currentLabel: string;
  targetLabel: string;
  recordMetricKey?: keyof LeaderboardAchievementRecords;
  isLowerBetter?: boolean;
}

export interface AchievementDef {
  id: string;
  order: number;
  category: AchievementCategory;
  tier: AchievementTier;
  title: string;
  description: string;
  recordMetricKey?: keyof LeaderboardAchievementRecords;
  isLowerBetter?: boolean;
  evaluate: (m: AchievementMetrics) => AchievementEvaluation;
}

export interface EvaluatedAchievement {
  def: AchievementDef;
  unlocked: boolean;
  progressPct: number;
  currentLabel: string;
  targetLabel: string;
  unlockedAt?: number;
}

export interface BrokenRecordEntry {
  key: keyof LeaderboardAchievementRecords;
  label: string;
  previousValue: number | null;
  previousFormatted: string | null;
  newValue: number;
  newFormatted: string;
  isFirstTime: boolean;
}

export interface AchievementUnlockEventDetail {
  uid: string;
  epoch: number;
  newlyUnlocked: AchievementDef[];
  brokenRecords: BrokenRecordEntry[];
  totalUnlockedCount: number;
  happenedAt: number;
}

export const ACHIEVEMENTS_UNLOCKED_EVENT = 'duoboard:achievements-unlocked';

export const CATEGORY_LABELS: Record<AchievementCategory, string> = {
  daily: 'تحدي اليوم الواحد',
  speed: 'أرقام السرعة القياسية',
  volume: 'رصيد الأسئلة والاختبارات',
  perfection: 'الدقة والدرجة الكاملة',
  consistency: 'الاستمرارية والأيام',
  mistakes: 'قاهر الأخطاء والتقوية',
  mastery: 'المهارات المتقدمة والزمن',
};

export const TIER_LABELS: Record<AchievementTier, string> = {
  bronze: 'برونزي',
  silver: 'فضي',
  gold: 'ذهبي',
  diamond: 'ماسي',
  legend: 'أسطوري',
};

function toLocalDateKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateKeyToEpochDay(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86400000);
}

export function formatDurationCompactAr(totalSec: number | null | undefined): string {
  if (totalSec === null || totalSec === undefined || !Number.isFinite(totalSec) || totalSec <= 0) {
    return '—';
  }
  const s = Math.round(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h} س ${m} د`;
  if (m > 0) return rem > 0 ? `${m} د ${rem} ث` : `${m} د`;
  return `${rem} ث`;
}

function computeFastestWindowSec(
  chronological: QuizAttempt[],
  targetQuestions: number
): number | null {
  // Sliding window across contiguous chronological attempts totaling >= targetQuestions
  // Requires valid non-zero durations (>= 1 sec/question) to avoid instant-zero anomalies.
  const valid = chronological.filter((a) => {
    const q = Math.max(0, Number(a.total) || a.questions?.length || 0);
    const dur = Math.max(0, Number(a.durationSec) || 0);
    return q > 0 && dur >= q;
  });

  if (valid.length === 0) return null;

  let left = 0;
  let sumQ = 0;
  let sumDur = 0;
  let bestSec: number | null = null;

  for (let right = 0; right < valid.length; right++) {
    const rq = Math.max(0, Number(valid[right].total) || valid[right].questions?.length || 0);
    const rdur = Math.max(0, Number(valid[right].durationSec) || 0);
    sumQ += rq;
    sumDur += rdur;

    while (left <= right && sumQ >= targetQuestions) {
      const scaledSec = Math.round((sumDur / sumQ) * targetQuestions);
      if (bestSec === null || scaledSec < bestSec) {
        bestSec = scaledSec;
      }
      const lq = Math.max(0, Number(valid[left].total) || valid[left].questions?.length || 0);
      const ldur = Math.max(0, Number(valid[left].durationSec) || 0);
      if (sumQ - lq >= targetQuestions) {
        sumQ -= lq;
        sumDur -= ldur;
        left += 1;
      } else {
        break;
      }
    }
  }

  return bestSec;
}

export function computeAchievementMetrics(attempts: QuizAttempt[]): AchievementMetrics {
  const chrono = [...attempts]
    .filter((a) => a && typeof a === 'object')
    .sort((a, b) => (Number(a.finishedAt) || 0) - (Number(b.finishedAt) || 0));

  let totalQuestions = 0;
  let totalCorrect = 0;
  let totalDurationSec = 0;

  let perfect100Count = 0;
  let cur100Streak = 0;
  let bestPerfect100Streak = 0;
  let cur80Streak = 0;
  let bestHigh80Streak = 0;

  let dawnAttempts = 0;
  let nightAttempts = 0;
  let mistakeReviewAttempts = 0;
  let drillAttempts = 0;
  let tableQuestionsCorrect = 0;
  let withLawsCorrect = 0;

  let bestAvgSecPerQ20: number | null = null;
  let bestAccurateSpeedAvgSecPerQ: number | null = null;

  const dayTotals = new Map<string, { q: number; c: number }>();

  for (const a of chrono) {
    const q = Math.max(0, Number(a.total) || a.questions?.length || 0);
    const c = Math.max(0, Math.min(q, Number(a.score) || 0));
    const dur = Math.max(0, Number(a.durationSec) || 0);
    const ts = Number(a.finishedAt) || 0;

    totalQuestions += q;
    totalCorrect += c;
    totalDurationSec += dur;

    const pct = q > 0 ? Math.round((c / q) * 100) : 0;

    if (q >= 3 && pct === 100) {
      perfect100Count += 1;
      cur100Streak += 1;
      if (cur100Streak > bestPerfect100Streak) bestPerfect100Streak = cur100Streak;
    } else if (q >= 3) {
      cur100Streak = 0;
    }

    if (q >= 3 && pct >= 80) {
      cur80Streak += 1;
      if (cur80Streak > bestHigh80Streak) bestHigh80Streak = cur80Streak;
    } else if (q >= 3) {
      cur80Streak = 0;
    }

    if (q >= 20 && dur >= q) {
      const avg = Number((dur / q).toFixed(1));
      if (bestAvgSecPerQ20 === null || avg < bestAvgSecPerQ20) {
        bestAvgSecPerQ20 = avg;
      }
      if (pct >= 80 && (bestAccurateSpeedAvgSecPerQ === null || avg < bestAccurateSpeedAvgSecPerQ)) {
        bestAccurateSpeedAvgSecPerQ = avg;
      }
    }

    if (ts > 0) {
      const dateKey = toLocalDateKey(ts);
      const prevDay = dayTotals.get(dateKey) || { q: 0, c: 0 };
      prevDay.q += q;
      prevDay.c += c;
      dayTotals.set(dateKey, prevDay);

      const hour = new Date(ts).getHours();
      if (hour >= 4 && hour < 8) dawnAttempts += 1;
      if (hour >= 21 || hour < 4) nightAttempts += 1;
    }

    if (isMistakeReviewAttempt(a)) {
      mistakeReviewAttempts += 1;
    }

    const title = String(a.title || a.settings?.quizTitles?.[0] || '');
    if (title.includes('تقوية') || title.includes('تدريب')) {
      drillAttempts += 1;
    }

    const questions = Array.isArray(a.questions) ? a.questions : [];
    const answers = Array.isArray(a.answers) ? a.answers : [];
    const tableAnswers = a.tableAnswers || {};
    questions.forEach((question, idx) => {
      if (!question || typeof question !== 'object') return;
      let isRight = false;
      if (question.questionType === 'table' && question.table) {
        const graded = gradeTableQuestion(question.table, tableAnswers[question.id] || tableAnswers[String(idx)]);
        isRight = graded.isAllCorrect;
        if (isRight) tableQuestionsCorrect += 1;
      } else {
        isRight = Number(answers[idx]) === Number(question.correctIndex);
      }

      if (isRight && Array.isArray(question.laws) && question.laws.length > 0) {
        withLawsCorrect += 1;
      }
    });
  }

  let maxQuestionsInDay = 0;
  let maxCorrectInDay = 0;
  dayTotals.forEach((v) => {
    if (v.q > maxQuestionsInDay) maxQuestionsInDay = v.q;
    if (v.c > maxCorrectInDay) maxCorrectInDay = v.c;
  });

  const sortedEpochDays = Array.from(dayTotals.keys())
    .map(dateKeyToEpochDay)
    .sort((a, b) => a - b);

  let maxConsecutiveActiveDays = sortedEpochDays.length > 0 ? 1 : 0;
  let curDaysStreak = sortedEpochDays.length > 0 ? 1 : 0;
  for (let i = 1; i < sortedEpochDays.length; i++) {
    if (sortedEpochDays[i] === sortedEpochDays[i - 1] + 1) {
      curDaysStreak += 1;
      if (curDaysStreak > maxConsecutiveActiveDays) {
        maxConsecutiveActiveDays = curDaysStreak;
      }
    } else if (sortedEpochDays[i] > sortedEpochDays[i - 1] + 1) {
      curDaysStreak = 1;
    }
  }

  const ledger = computeMistakeLedger(chrono);

  return {
    attemptsCount: chrono.length,
    totalQuestions,
    totalCorrect,
    overallAccuracyPct: totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0,
    totalDurationSec,
    totalDurationMin: Math.floor(totalDurationSec / 60),
    maxQuestionsInDay,
    maxCorrectInDay,
    fastest100Sec: computeFastestWindowSec(chrono, 100),
    fastest50Sec: computeFastestWindowSec(chrono, 50),
    fastest25Sec: computeFastestWindowSec(chrono, 25),
    bestAvgSecPerQ20,
    bestAccurateSpeedAvgSecPerQ,
    perfect100Count,
    bestPerfect100Streak,
    bestHigh80Streak,
    activeDaysCount: dayTotals.size,
    maxConsecutiveActiveDays,
    dawnAttempts,
    nightAttempts,
    mistakeReviewAttempts,
    correctedMistakesTotal: ledger.correctedMistakesCount,
    drillAttempts,
    tableQuestionsCorrect,
    withLawsCorrect,
  };
}

function minTargetEval(
  current: number,
  target: number,
  unit: string,
  recordMetricKey?: keyof LeaderboardAchievementRecords
): AchievementEvaluation {
  const safeCur = Math.max(0, Math.round(current));
  return {
    unlocked: safeCur >= target,
    progressPct: target > 0 ? Math.min(100, Math.round((safeCur / target) * 100)) : 0,
    currentLabel: `${safeCur.toLocaleString('en-US')} ${unit}`,
    targetLabel: `${target.toLocaleString('en-US')} ${unit}`,
    recordMetricKey,
  };
}

function speedWindowEval(
  currentSec: number | null,
  targetMaxSec: number,
  minQ: number,
  totalQuestions: number,
  recordMetricKey?: keyof LeaderboardAchievementRecords
): AchievementEvaluation {
  const targetStr = formatDurationCompactAr(targetMaxSec);
  if (currentSec === null || totalQuestions < minQ) {
    return {
      unlocked: false,
      progressPct: Math.min(85, Math.round((totalQuestions / minQ) * 80)),
      currentLabel:
        totalQuestions < minQ
          ? `أكمل ${minQ} سؤالاً أولاً (${totalQuestions}/${minQ})`
          : 'لا توجد محاولة بمؤقت كافٍ',
      targetLabel: `أقل من ${targetStr}`,
      recordMetricKey,
      isLowerBetter: true,
    };
  }
  const unlocked = currentSec <= targetMaxSec;
  const pct = unlocked ? 100 : Math.max(8, Math.min(99, Math.round((targetMaxSec / currentSec) * 100)));
  return {
    unlocked,
    progressPct: pct,
    currentLabel: formatDurationCompactAr(currentSec),
    targetLabel: `أقل من ${targetStr}`,
    recordMetricKey,
    isLowerBetter: true,
  };
}

function build100Achievements(): AchievementDef[] {
  const list: AchievementDef[] = [];
  const push = (item: Omit<AchievementDef, 'order'>) => {
    list.push({ ...item, order: list.length + 1 });
  };

  // 1. تحديات اليوم الواحد (15 إنجازاً)
  const dailyQTargets: Array<[number, AchievementTier, string, string]> = [
    [10, 'bronze', 'بداية اليوم النشط', 'حل 10 أسئلة في يوم واحد فقط'],
    [20, 'bronze', 'إحماء يومي ممتاز', 'حل 20 سؤالاً في يوم واحد'],
    [35, 'bronze', 'نشاط يومي متصاعد', 'حل 35 سؤالاً في يوم واحد'],
    [50, 'silver', 'نصف مئوية في يوم', 'حل 50 سؤالاً في يوم واحد'],
    [75, 'silver', 'ثلاثة أرباع المئة اليومية', 'حل 75 سؤالاً في يوم واحد'],
    [100, 'gold', 'مئة سؤال في يوم واحد', 'اكسر حاجز 100 سؤال في يوم واحد'],
    [125, 'gold', 'عزيمة لا تهدأ', 'حل 125 سؤالاً في يوم واحد'],
    [150, 'gold', 'ماراثون اليوم الواحد', 'حل 150 سؤالاً في يوم واحد'],
    [200, 'diamond', 'ثنائية اليوم الخارق', 'حل 200 سؤال في يوم واحد'],
    [250, 'diamond', 'محارب الأسئلة اليومي', 'حل 250 سؤالاً في يوم واحد'],
    [300, 'diamond', 'ثلاثمئة سؤال في يوم', 'حل 300 سؤال في يوم واحد'],
    [400, 'legend', 'إعصار التحصيل اليومي', 'حل 400 سؤال في يوم واحد'],
    [500, 'legend', 'الرقم القياسي: 500 في يوم', 'حل 500 سؤال في يوم واحد'],
  ];
  dailyQTargets.forEach(([target, tier, title, desc]) => {
    push({
      id: `daily_q_${target}`,
      category: 'daily',
      tier,
      title,
      description: desc,
      recordMetricKey: 'maxQuestionsInDay',
      evaluate: (m) => minTargetEval(m.maxQuestionsInDay, target, 'سؤال/يوم', 'maxQuestionsInDay'),
    });
  });

  push({
    id: 'daily_correct_50',
    category: 'daily',
    tier: 'gold',
    title: '50 إجابة صحيحة في يوم',
    description: 'حقق 50 إجابة صحيحة خلال يوم واحد فقط',
    recordMetricKey: 'maxCorrectInDay',
    evaluate: (m) => minTargetEval(m.maxCorrectInDay, 50, 'صحيح/يوم', 'maxCorrectInDay'),
  });
  push({
    id: 'daily_correct_100',
    category: 'daily',
    tier: 'legend',
    title: '100 إجابة صحيحة في يوم',
    description: 'حقق 100 إجابة صحيحة في يوم واحد فقط',
    recordMetricKey: 'maxCorrectInDay',
    evaluate: (m) => minTargetEval(m.maxCorrectInDay, 100, 'صحيح/يوم', 'maxCorrectInDay'),
  });

  // 2. أرقام السرعة القياسية (15 إنجازاً — منها أسرع 100 سؤال وأسرع 50 و 25)
  const fast100Tiers: Array<[number, AchievementTier, string]> = [
    [120 * 60, 'bronze', 'أسرع 100 سؤال — دون ساعتين'],
    [90 * 60, 'bronze', 'أسرع 100 سؤال — دون 90 دقيقة'],
    [75 * 60, 'silver', 'أسرع 100 سؤال — دون 75 دقيقة'],
    [60 * 60, 'silver', 'أسرع 100 سؤال — دون ساعة'],
    [45 * 60, 'gold', 'أسرع 100 سؤال — دون 45 دقيقة'],
    [35 * 60, 'gold', 'أسرع 100 سؤال — دون 35 دقيقة'],
    [25 * 60, 'diamond', 'أسرع 100 سؤال — دون 25 دقيقة'],
    [18 * 60, 'legend', 'الرقم القياسي الخارق: 100 سؤال < 18 دقيقة'],
  ];
  fast100Tiers.forEach(([maxSec, tier, title]) => {
    const mins = Math.round(maxSec / 60);
    push({
      id: `speed_100_${mins}m`,
      category: 'speed',
      tier,
      title,
      description: `أكمل 100 سؤال متتالية في زمن قياسي أقل من ${mins} دقيقة`,
      recordMetricKey: 'fastest100Sec',
      isLowerBetter: true,
      evaluate: (m) => speedWindowEval(m.fastest100Sec, maxSec, 100, m.totalQuestions, 'fastest100Sec'),
    });
  });

  const fast50Tiers: Array<[number, AchievementTier, string]> = [
    [45 * 60, 'bronze', 'أسرع 50 سؤالاً — دون 45 دقيقة'],
    [30 * 60, 'silver', 'أسرع 50 سؤالاً — دون 30 دقيقة'],
    [20 * 60, 'gold', 'أسرع 50 سؤالاً — دون 20 دقيقة'],
    [12 * 60, 'diamond', 'أسرع 50 سؤالاً — دون 12 دقيقة'],
  ];
  fast50Tiers.forEach(([maxSec, tier, title]) => {
    const mins = Math.round(maxSec / 60);
    push({
      id: `speed_50_${mins}m`,
      category: 'speed',
      tier,
      title,
      description: `أنهِ 50 سؤالاً متتالية في زمن أقل من ${mins} دقيقة`,
      recordMetricKey: 'fastest50Sec',
      isLowerBetter: true,
      evaluate: (m) => speedWindowEval(m.fastest50Sec, maxSec, 50, m.totalQuestions, 'fastest50Sec'),
    });
  });

  push({
    id: 'speed_25_10m',
    category: 'speed',
    tier: 'gold',
    title: 'أسرع 25 سؤالاً — دون 10 دقائق',
    description: 'أنهِ 25 سؤالاً متتالية في زمن أقل من 10 دقائق',
    recordMetricKey: 'fastest25Sec',
    isLowerBetter: true,
    evaluate: (m) => speedWindowEval(m.fastest25Sec, 10 * 60, 25, m.totalQuestions, 'fastest25Sec'),
  });

  push({
    id: 'speed_avg_25s',
    category: 'speed',
    tier: 'silver',
    title: 'سرعة استجابة خاطفة (≤25 ث/س)',
    description: 'حقق متوسط سرعة 25 ثانية فأقل للسؤال في اختبار من 20+ سؤال',
    recordMetricKey: 'bestAvgSecPerQ',
    isLowerBetter: true,
    evaluate: (m) => ({
      unlocked: m.bestAvgSecPerQ20 !== null && m.bestAvgSecPerQ20 <= 25,
      progressPct:
        m.bestAvgSecPerQ20 === null
          ? 0
          : m.bestAvgSecPerQ20 <= 25
          ? 100
          : Math.max(10, Math.round((25 / m.bestAvgSecPerQ20) * 100)),
      currentLabel: m.bestAvgSecPerQ20 !== null ? `${m.bestAvgSecPerQ20} ث/س` : 'جرّب 20+ سؤالاً',
      targetLabel: '≤ 25 ث/س',
      recordMetricKey: 'bestAvgSecPerQ',
      isLowerBetter: true,
    }),
  });

  push({
    id: 'speed_avg_15s_acc80',
    category: 'speed',
    tier: 'legend',
    title: 'برق مع دقة (≤15 ث/س بدقة 80%+)',
    description: 'أنهِ اختباراً من 20+ سؤال بمعدل ≤15 ث/سؤال مع دقة 80% فأعلى',
    recordMetricKey: 'bestAvgSecPerQ',
    isLowerBetter: true,
    evaluate: (m) => ({
      unlocked: m.bestAccurateSpeedAvgSecPerQ !== null && m.bestAccurateSpeedAvgSecPerQ <= 15,
      progressPct:
        m.bestAccurateSpeedAvgSecPerQ === null
          ? 0
          : m.bestAccurateSpeedAvgSecPerQ <= 15
          ? 100
          : Math.max(10, Math.round((15 / m.bestAccurateSpeedAvgSecPerQ) * 100)),
      currentLabel:
        m.bestAccurateSpeedAvgSecPerQ !== null
          ? `${m.bestAccurateSpeedAvgSecPerQ} ث/س`
          : '20+ سؤال بدقة 80%+',
      targetLabel: '≤ 15 ث/س',
      recordMetricKey: 'bestAvgSecPerQ',
      isLowerBetter: true,
    }),
  });

  // 3. رصيد الأسئلة والاختبارات (20 إنجازاً)
  const correctMilestones: Array<[number, AchievementTier, string]> = [
    [10, 'bronze', 'أول 10 إجابات صحيحة'],
    [25, 'bronze', 'ربع مئة من الصواب'],
    [50, 'bronze', 'نادي الخمسين صحيح'],
    [100, 'silver', 'أول مئة إجابة صحيحة'],
    [250, 'silver', 'رصيد 250 إجابة صحيحة'],
    [500, 'gold', 'نصف ألف إجابة صحيحة'],
    [1000, 'gold', 'الألفية الذهبية للصواب'],
    [2000, 'diamond', 'ألفا إجابة صحيحة'],
    [3500, 'diamond', 'قمة 3,500 إجابة صحيحة'],
    [5000, 'legend', 'أسطورة الـ 5,000 إجابة صحيحة'],
  ];
  correctMilestones.forEach(([target, tier, title]) => {
    push({
      id: `vol_correct_${target}`,
      category: 'volume',
      tier,
      title,
      description: `اجمع ${target.toLocaleString('en-US')} إجابة صحيحة في رصيد لوحة الشرف`,
      evaluate: (m) => minTargetEval(m.totalCorrect, target, 'صحيح'),
    });
  });

  const totalQMilestones: Array<[number, AchievementTier, string]> = [
    [50, 'bronze', 'تجاوزت 50 سؤالاً'],
    [150, 'bronze', 'تجاوزت 150 سؤالاً'],
    [300, 'silver', 'رصيد 300 سؤال محلول'],
    [750, 'gold', 'رصيد 750 سؤالاً محلولاً'],
    [1500, 'diamond', '1,500 سؤال في السجل'],
    [3000, 'legend', 'موسوعة 3,000 سؤال'],
  ];
  totalQMilestones.forEach(([target, tier, title]) => {
    push({
      id: `vol_total_${target}`,
      category: 'volume',
      tier,
      title,
      description: `حل ما مجموعه ${target.toLocaleString('en-US')} سؤالاً في الدورة الحالية`,
      evaluate: (m) => minTargetEval(m.totalQuestions, target, 'سؤال'),
    });
  });

  const attemptMilestones: Array<[number, AchievementTier, string]> = [
    [1, 'bronze', 'الخطوة الأولى في لوحة الشرف'],
    [10, 'silver', 'أتممت 10 اختبارات'],
    [50, 'gold', 'خمسون اختباراً مكتملًا'],
    [100, 'diamond', 'مئوية الاختبارات المكتملة'],
  ];
  attemptMilestones.forEach(([target, tier, title]) => {
    push({
      id: `vol_attempts_${target}`,
      category: 'volume',
      tier,
      title,
      description: `أكمل ${target} اختبار ومحاولة بنجاح`,
      evaluate: (m) => minTargetEval(m.attemptsCount, target, 'اختبار'),
    });
  });

  // 4. الدقة والدرجة الكاملة (16 إنجازاً)
  const perfectCounts: Array<[number, AchievementTier, string]> = [
    [1, 'bronze', 'أول درجة كاملة 100%'],
    [3, 'silver', '3 درجات كاملة 100%'],
    [5, 'silver', '5 درجات كاملة 100%'],
    [10, 'gold', 'عشرة كاملة (10×100%)'],
    [15, 'diamond', 'متقن القمة (15×100%)'],
    [25, 'legend', 'ملك الدرجة الكاملة (25×100%)'],
  ];
  perfectCounts.forEach(([target, tier, title]) => {
    push({
      id: `perf_100_${target}`,
      category: 'perfection',
      tier,
      title,
      description: `احصل على درجة 100% في ${target} اختبارات (3+ أسئلة لكل اختبار)`,
      recordMetricKey: 'perfect100Count',
      evaluate: (m) => minTargetEval(m.perfect100Count, target, 'اختبار 100%', 'perfect100Count'),
    });
  });

  const perfectStreaks: Array<[number, AchievementTier, string]> = [
    [2, 'silver', 'ثنائية 100% متتالية'],
    [3, 'gold', 'ثلاثية 100% متتالية'],
    [5, 'legend', 'خماسية 100% متتالية بدون خطأ'],
  ];
  perfectStreaks.forEach(([target, tier, title]) => {
    push({
      id: `perf_100_streak_${target}`,
      category: 'perfection',
      tier,
      title,
      description: `حقق 100% في ${target} اختبارات متتالية (3+ أسئلة)`,
      evaluate: (m) => minTargetEval(m.bestPerfect100Streak, target, 'متتالية'),
    });
  });

  const high80Streaks: Array<[number, AchievementTier, string]> = [
    [3, 'bronze', 'سلسلة تفوق: 3 اختبارات ≥80%'],
    [5, 'silver', 'سلسلة تفوق: 5 اختبارات ≥80%'],
    [10, 'gold', 'سلسلة تفوق: 10 اختبارات ≥80%'],
    [20, 'legend', 'ثبات أسطوري: 20 اختباراً ≥80%'],
  ];
  high80Streaks.forEach(([target, tier, title]) => {
    push({
      id: `perf_80_streak_${target}`,
      category: 'perfection',
      tier,
      title,
      description: `حافظ على نتيجة 80%+ في ${target} اختبارات متتالية`,
      evaluate: (m) => minTargetEval(m.bestHigh80Streak, target, 'متتالية'),
    });
  });

  const accGates: Array<[number, number, AchievementTier, string]> = [
    [80, 50, 'silver', 'دقة إجمالية 80%+ (50+ سؤال)'],
    [85, 100, 'gold', 'دقة إجمالية 85%+ (100+ سؤال)'],
    [90, 200, 'legend', 'نخبة الدقة 90%+ (200+ سؤال)'],
  ];
  accGates.forEach(([targetAcc, minQ, tier, title]) => {
    push({
      id: `perf_acc_${targetAcc}_${minQ}`,
      category: 'perfection',
      tier,
      title,
      description: `حقق دقة كلية ${targetAcc}% فأعلى مع حل ${minQ} سؤالاً على الأقل`,
      evaluate: (m) => {
        const enough = m.totalQuestions >= minQ;
        const unlocked = enough && m.overallAccuracyPct >= targetAcc;
        const pct = unlocked
          ? 100
          : enough
          ? Math.min(99, Math.round((m.overallAccuracyPct / targetAcc) * 100))
          : Math.min(75, Math.round((m.totalQuestions / minQ) * 75));
        return {
          unlocked,
          progressPct: pct,
          currentLabel: enough
            ? `${m.overallAccuracyPct}%`
            : `${m.totalQuestions}/${minQ} سؤال`,
          targetLabel: `${targetAcc}%`,
        };
      },
    });
  });

  // 5. الاستمرارية والأيام (14 إنجازاً)
  const activeDayMilestones: Array<[number, AchievementTier, string]> = [
    [2, 'bronze', 'عودة مشرقة (يومان نشطان)'],
    [3, 'bronze', 'ثلاثة أيام من التعلم'],
    [7, 'silver', 'أسبوع نشاط كامل (7 أيام)'],
    [14, 'gold', 'أسبوعان من العطاء (14 يوماً)'],
    [30, 'diamond', 'شهر كامل من التدريب (30 يوماً)'],
    [60, 'legend', '60 يوماً من الشغف والعلم'],
  ];
  activeDayMilestones.forEach(([target, tier, title]) => {
    push({
      id: `cons_days_${target}`,
      category: 'consistency',
      tier,
      title,
      description: `حل اختبارات في ${target} أيام مختلفة خلال الدورة`,
      evaluate: (m) => minTargetEval(m.activeDaysCount, target, 'يوم'),
    });
  });

  const streakDayMilestones: Array<[number, AchievementTier, string]> = [
    [2, 'bronze', 'يومان متتاليان بلا انقطاع'],
    [3, 'silver', 'سلسلة 3 أيام متواصلة'],
    [5, 'silver', 'سلسلة 5 أيام متواصلة'],
    [7, 'gold', 'سلسلة أسبوع كامل متواصل'],
    [14, 'diamond', 'سلسلة 14 يوماً متواصلاً'],
    [30, 'legend', 'سلسلة 30 يوماً أسطورية'],
  ];
  streakDayMilestones.forEach(([target, tier, title]) => {
    push({
      id: `cons_streak_${target}`,
      category: 'consistency',
      tier,
      title,
      description: `حافظ على المذاكرة ${target} أيام متتالية دون انقطاع`,
      recordMetricKey: 'maxConsecutiveActiveDays',
      evaluate: (m) =>
        minTargetEval(m.maxConsecutiveActiveDays, target, 'يوم متتالي', 'maxConsecutiveActiveDays'),
    });
  });

  push({
    id: 'cons_dawn_5',
    category: 'consistency',
    tier: 'silver',
    title: 'طالب الفجر والصباح الباكر',
    description: 'أكمل 5 اختبارات بين الساعة 4 و8 صباحاً',
    evaluate: (m) => minTargetEval(m.dawnAttempts, 5, 'اختبار فجراً'),
  });
  push({
    id: 'cons_night_5',
    category: 'consistency',
    tier: 'silver',
    title: 'عاشق المذاكرة المسائية',
    description: 'أكمل 5 اختبارات في الساعات المتأخرة (بعد 9 مساءً)',
    evaluate: (m) => minTargetEval(m.nightAttempts, 5, 'اختبار ليلاً'),
  });

  // 6. قاهر الأخطاء والتقوية (10 إنجازات)
  const fixMilestones: Array<[number, AchievementTier, string]> = [
    [1, 'bronze', 'بداية تصحيح المسار'],
    [5, 'bronze', 'مصلح 5 أخطاء سابقة'],
    [15, 'silver', 'تجاوزت 15 خطأً قديماً'],
    [30, 'silver', 'تحويل 30 خطأ إلى صواب'],
    [60, 'gold', 'قاهر 60 خطأً سابقاً'],
    [120, 'diamond', 'مصفّي بنك الأخطاء (120+)'],
    [250, 'legend', 'سيد التعلم من الأخطاء (250+)'],
  ];
  fixMilestones.forEach(([target, tier, title]) => {
    push({
      id: `mistake_fix_${target}`,
      category: 'mistakes',
      tier,
      title,
      description: `أعد حل ${target} سؤالاً من أخطائك وأجبها بشكل صحيح عبر اختبار الأخطاء`,
      recordMetricKey: 'correctedMistakesTotal',
      evaluate: (m) =>
        minTargetEval(m.correctedMistakesTotal, target, 'خطأ مصحح', 'correctedMistakesTotal'),
    });
  });

  push({
    id: 'mistake_review_3',
    category: 'mistakes',
    tier: 'silver',
    title: 'مواجهة الأخطاء 3 مرات',
    description: 'أكمل 3 جولات في قسم اختبر أخطائي',
    evaluate: (m) => minTargetEval(m.mistakeReviewAttempts, 3, 'مراجعة'),
  });
  push({
    id: 'mistake_review_10',
    category: 'mistakes',
    tier: 'gold',
    title: 'بطل المراجعة المستمرة (10 جولات)',
    description: 'أكمل 10 جولات في قسم اختبر أخطائي',
    evaluate: (m) => minTargetEval(m.mistakeReviewAttempts, 10, 'مراجعة'),
  });
  push({
    id: 'mistake_drills_5',
    category: 'mistakes',
    tier: 'silver',
    title: 'منجز اختبارات التقوية (5)',
    description: 'أنهِ 5 اختبارات تقوية وتدريب مركّزة',
    evaluate: (m) => minTargetEval(m.drillAttempts, 5, 'تقوية'),
  });

  // 7. المهارات المتقدمة والزمن التراكمي (10 إنجازات)
  const tableMilestones: Array<[number, AchievementTier, string]> = [
    [5, 'bronze', 'متقن الجداول التفاعلية (5)'],
    [20, 'silver', 'خبير الجداول (20 سؤالاً)'],
    [50, 'gold', 'صانع الجداول الذكي (50 سؤالاً)'],
    [100, 'diamond', 'مئوية الجداول التفاعلية (100)'],
  ];
  tableMilestones.forEach(([target, tier, title]) => {
    push({
      id: `master_table_${target}`,
      category: 'mastery',
      tier,
      title,
      description: `أجب عن ${target} سؤالاً من نوع الجدول التفاعلي إجابة صحيحة`,
      evaluate: (m) => minTargetEval(m.tableQuestionsCorrect, target, 'جدول صحيح'),
    });
  });

  const lawMilestones: Array<[number, AchievementTier, string]> = [
    [20, 'bronze', 'تطبيق القوانين بذكاء (20)'],
    [75, 'silver', 'فهم عميق للقواعد (75)'],
    [200, 'gold', 'مرجع القوانين والمهارات (200)'],
  ];
  lawMilestones.forEach(([target, tier, title]) => {
    push({
      id: `master_laws_${target}`,
      category: 'mastery',
      tier,
      title,
      description: `أجب عن ${target} سؤالاً مزوداً بقوانين وإرشادات إجابة صحيحة`,
      evaluate: (m) => minTargetEval(m.withLawsCorrect, target, 'سؤال'),
    });
  });

  const durMilestones: Array<[number, AchievementTier, string]> = [
    [60, 'bronze', 'ساعة كاملة من التدريب المركز'],
    [300, 'gold', '5 ساعات من المذاكرة الحقيقية'],
    [600, 'legend', '10 ساعات من الجد والاجتهاد'],
  ];
  durMilestones.forEach(([targetMin, tier, title]) => {
    push({
      id: `master_time_${targetMin}m`,
      category: 'mastery',
      tier,
      title,
      description: `امضِ ما مجموعه ${Math.round(targetMin / 60)} ساعة (${targetMin} دقيقة) في حل الاختبارات`,
      recordMetricKey: 'totalDurationMin',
      evaluate: (m) => minTargetEval(m.totalDurationMin, targetMin, 'دقيقة', 'totalDurationMin'),
    });
  });

  return list;
}

export const ACHIEVEMENTS: AchievementDef[] = build100Achievements();
export const ACHIEVEMENTS_BY_ID: Record<string, AchievementDef> = Object.fromEntries(
  ACHIEVEMENTS.map((a) => [a.id, a])
);

export function evaluateAllAchievements(
  attempts: QuizAttempt[],
  unlockedAtById?: Record<string, number>
): {
  metrics: AchievementMetrics;
  evaluated: EvaluatedAchievement[];
  unlockedIds: string[];
} {
  const metrics = computeAchievementMetrics(attempts);
  const unlockedIds: string[] = [];
  const evaluated = ACHIEVEMENTS.map((def) => {
    const res = def.evaluate(metrics);
    if (res.unlocked) unlockedIds.push(def.id);
    return {
      def,
      unlocked: res.unlocked,
      progressPct: res.progressPct,
      currentLabel: res.currentLabel,
      targetLabel: res.targetLabel,
      unlockedAt: unlockedAtById?.[def.id],
    };
  });
  return { metrics, evaluated, unlockedIds };
}

export function buildAchievementsSnapshot(
  attempts: QuizAttempt[],
  existingUnlockedAtById?: Record<string, number>
): LeaderboardAchievementsSnapshot {
  const now = Date.now();
  const { metrics, unlockedIds } = evaluateAllAchievements(attempts, existingUnlockedAtById);
  const nextUnlockedAt: Record<string, number> = {};
  for (const id of unlockedIds) {
    nextUnlockedAt[id] = existingUnlockedAtById?.[id] || now;
  }

  return {
    unlockedIds,
    unlockedCount: unlockedIds.length,
    unlockedAtById: nextUnlockedAt,
    records: {
      maxQuestionsInDay: metrics.maxQuestionsInDay,
      maxCorrectInDay: metrics.maxCorrectInDay,
      fastest100Sec: metrics.fastest100Sec,
      fastest50Sec: metrics.fastest50Sec,
      fastest25Sec: metrics.fastest25Sec,
      bestAvgSecPerQ: metrics.bestAvgSecPerQ20,
      perfect100Count: metrics.perfect100Count,
      maxConsecutiveActiveDays: metrics.maxConsecutiveActiveDays,
      correctedMistakesTotal: metrics.correctedMistakesTotal,
      totalDurationMin: metrics.totalDurationMin,
    },
  };
}

interface StoredAchievementTracking {
  seenUnlockedIds: string[];
  unlockedAtById: Record<string, number>;
  bestRecords: Partial<LeaderboardAchievementRecords>;
  recentUnlockedIds: string[];
  celebratedAttemptIds?: string[];
  updatedAt: number;
}

const reservedCelebrationAttemptIds = new Set<string>();

export function reserveAttemptForCelebration(attemptId: string): void {
  if (attemptId) reservedCelebrationAttemptIds.add(attemptId);
}

export function releaseAttemptReservation(attemptId: string): void {
  if (attemptId) reservedCelebrationAttemptIds.delete(attemptId);
}

export function hasReservedAttemptCelebration(attempts: QuizAttempt[]): boolean {
  if (reservedCelebrationAttemptIds.size === 0) return false;
  return attempts.some((a) => Boolean(a?.id && reservedCelebrationAttemptIds.has(a.id)));
}

function trackingStorageKey(uid: string, epoch: number): string {
  return `duoboard_ach_track_v1_${uid}_${epoch}`;
}

export function loadAchievementTracking(uid: string, epoch: number): StoredAchievementTracking | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(trackingStorageKey(uid, epoch));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAchievementTracking>;
    return {
      seenUnlockedIds: Array.isArray(parsed.seenUnlockedIds) ? parsed.seenUnlockedIds : [],
      unlockedAtById:
        parsed.unlockedAtById && typeof parsed.unlockedAtById === 'object' ? parsed.unlockedAtById : {},
      bestRecords:
        parsed.bestRecords && typeof parsed.bestRecords === 'object' ? parsed.bestRecords : {},
      recentUnlockedIds: Array.isArray(parsed.recentUnlockedIds) ? parsed.recentUnlockedIds : [],
      celebratedAttemptIds: Array.isArray(parsed.celebratedAttemptIds) ? parsed.celebratedAttemptIds : [],
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return null;
  }
}

function saveAchievementTracking(uid: string, epoch: number, data: StoredAchievementTracking): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(trackingStorageKey(uid, epoch), JSON.stringify(data));
  } catch {
    // Ignore storage quota errors
  }
}

function collectBrokenRecords(
  prev: Partial<LeaderboardAchievementRecords>,
  curr: LeaderboardAchievementRecords,
  options?: { isVeryFirstExam?: boolean }
): BrokenRecordEntry[] {
  const out: BrokenRecordEntry[] = [];

  const checkMin = (
    key: keyof LeaderboardAchievementRecords,
    label: string,
    format: (v: number) => string
  ) => {
    const newVal = curr[key];
    if (typeof newVal !== 'number' || !Number.isFinite(newVal) || newVal <= 0) return;
    const oldVal = prev[key];
    const hasOld = typeof oldVal === 'number' && Number.isFinite(oldVal) && oldVal > 0;
    if (!hasOld) {
      out.push({
        key,
        label,
        previousValue: null,
        previousFormatted: null,
        newValue: newVal,
        newFormatted: format(newVal),
        isFirstTime: true,
      });
    } else if (newVal < oldVal) {
      out.push({
        key,
        label,
        previousValue: oldVal,
        previousFormatted: format(oldVal),
        newValue: newVal,
        newFormatted: format(newVal),
        isFirstTime: false,
      });
    }
  };

  const checkMax = (
    key: keyof LeaderboardAchievementRecords,
    label: string,
    format: (v: number) => string,
    minFirstValue = 1
  ) => {
    const newVal = Number(curr[key] || 0);
    if (!Number.isFinite(newVal) || newVal <= 0) return;
    const oldVal = Number(prev[key] || 0);
    if (oldVal <= 0) {
      if (newVal >= minFirstValue) {
        out.push({
          key,
          label,
          previousValue: null,
          previousFormatted: null,
          newValue: newVal,
          newFormatted: format(newVal),
          isFirstTime: true,
        });
      }
    } else if (newVal > oldVal) {
      out.push({
        key,
        label,
        previousValue: oldVal,
        previousFormatted: format(oldVal),
        newValue: newVal,
        newFormatted: format(newVal),
        isFirstTime: false,
      });
    }
  };

  checkMin('fastest100Sec', 'أسرع 100 سؤال', (v) => formatDurationCompactAr(v));
  checkMax('maxQuestionsInDay', 'أكثر أسئلة في يوم واحد', (v) => `${v} سؤال`, 1);
  checkMin('fastest50Sec', 'أسرع 50 سؤالاً', (v) => formatDurationCompactAr(v));
  checkMin('fastest25Sec', 'أسرع 25 سؤالاً', (v) => formatDurationCompactAr(v));
  checkMin('bestAvgSecPerQ', 'أسرع معدل حل (20+ سؤال)', (v) => `${v} ث/س`);
  // On the very first exam avoid repeating maxQuestionsInDay + maxCorrectInDay together if redundant; show when broken or distinct
  if (!options?.isVeryFirstExam || curr.maxCorrectInDay !== curr.maxQuestionsInDay) {
    checkMax('maxCorrectInDay', 'أكثر إجابات صحيحة في يوم', (v) => `${v} صحيح`, 1);
  }
  checkMax('perfect100Count', 'الدرجات الكاملة 100%', (v) => `${v} اختبار`, 1);
  checkMax('maxConsecutiveActiveDays', 'أطول سلسلة أيام متتالية', (v) => `${v} يوم`, 2);
  checkMax('correctedMistakesTotal', 'تصحيح الأخطاء السابقة', (v) => `${v} خطأ`, 1);

  return out;
}

export function detectAndRecordAchievementUnlocks(params: {
  uid: string;
  epoch: number;
  scopedAttempts: QuizAttempt[];
  highlightNewAttempt?: QuizAttempt;
  skipTrackingWrite?: boolean;
}): {
  snapshot: LeaderboardAchievementsSnapshot;
  newlyUnlocked: AchievementDef[];
} {
  const { uid, epoch, scopedAttempts, highlightNewAttempt, skipTrackingWrite } = params;
  const now = Date.now();
  const prevTrack = loadAchievementTracking(uid, epoch);

  if (skipTrackingWrite) {
    const snap = buildAchievementsSnapshot(scopedAttempts, prevTrack?.unlockedAtById);
    return { snapshot: snap, newlyUnlocked: [] };
  }

  // Prevent re-firing for the same finished attempt ID if retried
  if (
    highlightNewAttempt?.id &&
    prevTrack?.celebratedAttemptIds?.includes(highlightNewAttempt.id)
  ) {
    const snap = buildAchievementsSnapshot(scopedAttempts, prevTrack.unlockedAtById);
    return { snapshot: snap, newlyUnlocked: [] };
  }

  let baselineUnlockedSet: Set<string>;
  let baselineRecords: Partial<LeaderboardAchievementRecords>;
  let isVeryFirstExam = false;
  const existingTimestamps: Record<string, number> = { ...(prevTrack?.unlockedAtById || {}) };

  if (prevTrack) {
    baselineUnlockedSet = new Set(prevTrack.seenUnlockedIds);
    baselineRecords = prevTrack.bestRecords;
  } else if (highlightNewAttempt && scopedAttempts.length > 1) {
    // First time tracking when submitting a new exam with existing history:
    // compute prior baseline cleanly so ONLY records/badges broken by THIS exam celebrate!
    const prior = scopedAttempts.filter((a) => a.id !== highlightNewAttempt.id);
    const priorSnap = buildAchievementsSnapshot(prior);
    baselineUnlockedSet = new Set(priorSnap.unlockedIds);
    baselineRecords = priorSnap.records;
    for (const id of priorSnap.unlockedIds) {
      existingTimestamps[id] = now - 1000;
    }
  } else if (highlightNewAttempt && scopedAttempts.length <= 1) {
    // User's very first exam in this epoch: every record earned is celebrated as First-Time!
    isVeryFirstExam = true;
    baselineUnlockedSet = new Set();
    baselineRecords = {};
  } else {
    // Silent initial backfill on background sync (e.g., opening MyQuizzes/Leaderboard)
    const snap = buildAchievementsSnapshot(scopedAttempts, existingTimestamps);
    saveAchievementTracking(uid, epoch, {
      seenUnlockedIds: snap.unlockedIds,
      unlockedAtById: snap.unlockedAtById || {},
      bestRecords: snap.records,
      recentUnlockedIds: [],
      celebratedAttemptIds: scopedAttempts.map((a) => a.id).slice(-40),
      updatedAt: now,
    });
    return { snapshot: snap, newlyUnlocked: [] };
  }

  const snap = buildAchievementsSnapshot(scopedAttempts, existingTimestamps);
  const newlyUnlocked = snap.unlockedIds
    .filter((id) => !baselineUnlockedSet.has(id))
    .map((id) => ACHIEVEMENTS_BY_ID[id])
    .filter(Boolean);

  const brokenRecords = highlightNewAttempt
    ? collectBrokenRecords(baselineRecords, snap.records, { isVeryFirstExam })
    : [];

  const nextRecent =
    newlyUnlocked.length > 0
      ? newlyUnlocked.map((a) => a.id).slice(0, 30)
      : prevTrack?.recentUnlockedIds || [];

  const nextCelebratedIds = highlightNewAttempt?.id
    ? [...(prevTrack?.celebratedAttemptIds || []), highlightNewAttempt.id].slice(-40)
    : prevTrack?.celebratedAttemptIds || [];

  saveAchievementTracking(uid, epoch, {
    seenUnlockedIds: snap.unlockedIds,
    unlockedAtById: snap.unlockedAtById || {},
    bestRecords: snap.records,
    recentUnlockedIds: nextRecent,
    celebratedAttemptIds: nextCelebratedIds,
    updatedAt: now,
  });

  if (highlightNewAttempt) {
    releaseAttemptReservation(highlightNewAttempt.id);
  }

  if ((newlyUnlocked.length > 0 || brokenRecords.length > 0) && typeof window !== 'undefined') {
    const detail: AchievementUnlockEventDetail = {
      uid,
      epoch,
      newlyUnlocked,
      brokenRecords,
      totalUnlockedCount: snap.unlockedCount,
      happenedAt: now,
    };
    window.dispatchEvent(new CustomEvent(ACHIEVEMENTS_UNLOCKED_EVENT, { detail }));
  }

  return { snapshot: snap, newlyUnlocked };
}

export interface RecordHolderInfo {
  holderName: string;
  holderUid: string;
  formattedValue: string;
  rawValue: number;
}

export function computeLeaderboardRecordHolders(
  users: LeaderboardUserEntry[]
): Partial<Record<keyof LeaderboardAchievementRecords, RecordHolderInfo>> {
  const holders: Partial<Record<keyof LeaderboardAchievementRecords, RecordHolderInfo>> = {};

  const pickMax = (
    key: keyof LeaderboardAchievementRecords,
    extract: (r: LeaderboardAchievementRecords) => number,
    format: (v: number) => string
  ) => {
    let best: RecordHolderInfo | null = null;
    for (const u of users) {
      const rec = u.statsSnapshot?.achievements?.records;
      if (!rec) continue;
      const val = Number(extract(rec) || 0);
      if (val <= 0) continue;
      if (!best || val > best.rawValue) {
        best = {
          holderName: u.fullNameQuad,
          holderUid: u.uid,
          rawValue: val,
          formattedValue: format(val),
        };
      }
    }
    if (best) holders[key] = best;
  };

  const pickMin = (
    key: keyof LeaderboardAchievementRecords,
    extract: (r: LeaderboardAchievementRecords) => number | null | undefined,
    format: (v: number) => string
  ) => {
    let best: RecordHolderInfo | null = null;
    for (const u of users) {
      const rec = u.statsSnapshot?.achievements?.records;
      if (!rec) continue;
      const val = extract(rec);
      if (val === null || val === undefined || !Number.isFinite(val) || val <= 0) continue;
      if (!best || val < best.rawValue) {
        best = {
          holderName: u.fullNameQuad,
          holderUid: u.uid,
          rawValue: val,
          formattedValue: format(val),
        };
      }
    }
    if (best) holders[key] = best;
  };

  pickMax('maxQuestionsInDay', (r) => r.maxQuestionsInDay, (v) => `${v} سؤال/يوم`);
  pickMax('maxCorrectInDay', (r) => r.maxCorrectInDay, (v) => `${v} صحيح/يوم`);
  pickMin('fastest100Sec', (r) => r.fastest100Sec, (v) => formatDurationCompactAr(v));
  pickMin('fastest50Sec', (r) => r.fastest50Sec, (v) => formatDurationCompactAr(v));
  pickMin('fastest25Sec', (r) => r.fastest25Sec, (v) => formatDurationCompactAr(v));
  pickMin('bestAvgSecPerQ', (r) => r.bestAvgSecPerQ, (v) => `${v} ث/س`);
  pickMax('perfect100Count', (r) => r.perfect100Count, (v) => `${v} مرة`);
  pickMax('maxConsecutiveActiveDays', (r) => r.maxConsecutiveActiveDays, (v) => `${v} يوم`);
  pickMax('correctedMistakesTotal', (r) => r.correctedMistakesTotal, (v) => `${v} خطأ`);
  pickMax('totalDurationMin', (r) => r.totalDurationMin, (v) => `${v} دقيقة`);

  return holders;
}
