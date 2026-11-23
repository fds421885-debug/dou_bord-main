import type {
  CoachSectionProgress,
  CoachTopicStat,
  ExamQuestion,
  MyQuiz,
  QuizAttempt,
  StarredQuestion,
} from './types';

export interface LocalMistakeSample {
  sectionKey: string;
  sectionTitle: string;
  questionText: string;
  chosenAnswer: string;
  correctAnswer: string;
  laws?: string[];
  finishedAt: number;
}

export interface LocalAnalyticsSummary {
  totalAttempts: number;
  totalQuestions: number;
  correctCount: number;
  wrongCount: number;
  accuracyPct: number;
  avgSecPerQ: number;
  sectionStats: CoachTopicStat[];
  strongSections: CoachTopicStat[];
  weakSections: CoachTopicStat[];
  slowSections: CoachTopicStat[];
  prioritySection: CoachTopicStat | null;
  sectionNeedsFoundationalPlan: CoachTopicStat | null;
  recentMistakes: LocalMistakeSample[];
}

function classifyQuestionCorrect(q: ExamQuestion, ans: number): { answered: boolean; correct: boolean } {
  const isTable = q.questionType === 'table' || Boolean(q.table);
  if (isTable) {
    if (ans === 1) return { answered: true, correct: true };
    if (ans === 0) return { answered: true, correct: false };
    return { answered: false, correct: false };
  }
  if (typeof ans !== 'number' || ans < 0) return { answered: false, correct: false };
  return { answered: true, correct: ans === q.correctIndex };
}

function inferSkillBucket(q: ExamQuestion, fallbackTitle: string): string {
  const txt = `${q.text || ''} ${(q.laws || []).join(' ')} ${fallbackTitle}`.toLowerCase();
  if (/مثلث|دائرة|زاوية|مربع|مستطيل|محيط|مساحة|حجم|قطر|وتر|متوازي|معين/.test(txt) || q.figure) {
    return 'الهندسة والأشكال';
  }
  if (/نسبة|مئوي|%|تناسب|تخفيض|ربح|خسارة|خصم|زيادة/.test(txt)) {
    return 'النسب والتناسب';
  }
  if (/متوسط|وسيط|منوال|رسم|بياني|إحصاء|احتمال|جدول/.test(txt) || q.chart || q.table) {
    return 'الإحصاء والرسوم والجداول';
  }
  if (/قوة|أس|جذر|مقدار|تبسيط|كسر|كسور|بسط|مقام/.test(txt)) {
    return 'الجبر والأسس والكسور';
  }
  if (/سرعة|زمن|مسافة|عمر|ساعة|عامل|تدرج/.test(txt)) {
    return 'المسائل اللفظية والحركية';
  }
  if (/قارن|القيمة الأولى|القيمة الثانية|المعطيات غير كافية/.test(txt)) {
    return 'المقارنات الكميّة';
  }
  return fallbackTitle;
}

export function buildLocalCoachAnalytics(params: {
  attempts: QuizAttempt[];
  quizzes: MyQuiz[];
  starredItems?: StarredQuestion[];
  sectionProgress?: Record<string, CoachSectionProgress>;
}): LocalAnalyticsSummary {
  const { attempts, quizzes, sectionProgress = {} } = params;

  const quizById = new Map<string, MyQuiz>();
  for (const q of quizzes) {
    quizById.set(q.id, q);
  }

  // خريطة ترجع أي نموذج (أساسي أو تقوية تابعة) إلى قسمه الرئيسي
  const resolveSectionForQuizId = (quizId: string, fallbackTitle: string): { key: string; title: string } => {
    const qz = quizById.get(quizId);
    if (qz) {
      if (qz.parentQuizId && quizById.has(qz.parentQuizId)) {
        const parent = quizById.get(qz.parentQuizId)!;
        return { key: parent.id, title: parent.title };
      }
      if (!qz.parentQuizId && qz.quizKind !== 'drill') {
        return { key: qz.id, title: qz.title };
      }
    }
    const clean = (fallbackTitle || 'قسم عام').trim();
    return { key: quizId || `title:${clean}`, title: clean };
  };

  interface BucketAgg {
    key: string;
    title: string;
    sectionKey: string;
    sectionTitle: string;
    totalQuestions: number;
    correctCount: number;
    wrongCount: number;
    totalSecWeighted: number;
    attemptScores: Array<{ pct: number; secPerQ: number; isRemedial: boolean; finishedAt: number }>;
    remedialAttempts: number;
    lastRemedialPct?: number;
    lowRemedialStreak: number;
  }

  const buckets = new Map<string, BucketAgg>();
  const recentMistakes: LocalMistakeSample[] = [];

  let totalQuestions = 0;
  let correctCount = 0;
  let wrongCount = 0;
  let totalDurationSec = 0;

  const sortedAttempts = [...attempts].sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));

  for (const att of sortedAttempts) {
    const attQuestions = Array.isArray(att.questions) ? att.questions : [];
    if (attQuestions.length === 0) continue;

    const perQSec =
      att.durationSec > 0 && attQuestions.length > 0
        ? Math.min(300, Math.max(2, att.durationSec / attQuestions.length))
        : 35;
    totalDurationSec += Math.max(0, Number(att.durationSec) || 0);

    const perAttemptBuckets = new Map<string, { right: number; total: number; secKey: string; secTitle: string; isRemedial: boolean }>();

    attQuestions.forEach((eq, idx) => {
      const verdict = classifyQuestionCorrect(eq, att.answers?.[idx] ?? -1);
      const sec = resolveSectionForQuizId(eq.sourceQuizId, eq.sourceTitle || att.title);
      const sourceQuiz = quizById.get(eq.sourceQuizId);
      const isRemedial = sourceQuiz?.quizKind === 'drill' || /تقوية|علاجي|أساسيات|بنائي/.test(att.title || '');
      const bucketTitle = sec.title || inferSkillBucket(eq, att.title || 'عام');

      let b = buckets.get(sec.key);
      if (!b) {
        b = {
          key: sec.key,
          title: bucketTitle,
          sectionKey: sec.key,
          sectionTitle: sec.title,
          totalQuestions: 0,
          correctCount: 0,
          wrongCount: 0,
          totalSecWeighted: 0,
          attemptScores: [],
          remedialAttempts: 0,
          lowRemedialStreak: 0,
        };
        buckets.set(sec.key, b);
      }

      if (verdict.answered) {
        totalQuestions += 1;
        b.totalQuestions += 1;
        b.totalSecWeighted += perQSec;
        if (verdict.correct) {
          correctCount += 1;
          b.correctCount += 1;
        } else {
          wrongCount += 1;
          b.wrongCount += 1;

          const chosenIdx = att.answers?.[idx] ?? -1;
          const chosenText =
            eq.questionType === 'table' || eq.table
              ? 'إجابة جدول غير صحيحة'
              : chosenIdx >= 0 && eq.choices?.[chosenIdx]
              ? eq.choices[chosenIdx]
              : 'لم يتم الاختيار';
          const correctText =
            eq.questionType === 'table' || eq.table
              ? 'إكمال الجدول الصحيح'
              : eq.correctIndex >= 0 && eq.choices?.[eq.correctIndex]
              ? eq.choices[eq.correctIndex]
              : eq.explanation?.slice(0, 80) || '';

          recentMistakes.push({
            sectionKey: sec.key,
            sectionTitle: sec.title,
            questionText: (eq.text || '').slice(0, 220),
            chosenAnswer: chosenText.slice(0, 100),
            correctAnswer: correctText.slice(0, 100),
            laws: (eq.laws || []).slice(0, 2),
            finishedAt: att.finishedAt || 0,
          });
        }

        const pb = perAttemptBuckets.get(sec.key) || {
          right: 0,
          total: 0,
          secKey: sec.key,
          secTitle: sec.title,
          isRemedial,
        };
        pb.total += 1;
        if (verdict.correct) pb.right += 1;
        perAttemptBuckets.set(sec.key, pb);
      }
    });

    for (const [secKey, pb] of perAttemptBuckets.entries()) {
      const b = buckets.get(secKey);
      if (!b || pb.total === 0) continue;
      const pct = Math.round((pb.right / pb.total) * 100);
      b.attemptScores.push({
        pct,
        secPerQ: perQSec,
        isRemedial: pb.isRemedial,
        finishedAt: att.finishedAt || 0,
      });
      if (pb.isRemedial) {
        b.remedialAttempts += 1;
        b.lastRemedialPct = pct;
        if (pct < 85) {
          b.lowRemedialStreak += 1;
        } else {
          b.lowRemedialStreak = 0;
        }
      }
    }
  }

  // تأكد أيضاً من وجود الأقسام الرئيسية التي لم يُحل بها اختبارات بعد في اللوحة
  for (const qz of quizzes) {
    if (qz.quizKind === 'drill' || qz.parentQuizId) continue;
    if (!buckets.has(qz.id)) {
      buckets.set(qz.id, {
        key: qz.id,
        title: qz.title,
        sectionKey: qz.id,
        sectionTitle: qz.title,
        totalQuestions: 0,
        correctCount: 0,
        wrongCount: 0,
        totalSecWeighted: 0,
        attemptScores: [],
        remedialAttempts: 0,
        lowRemedialStreak: 0,
      });
    }
  }

  const globalAvgSecPerQ =
    totalQuestions > 0 ? Math.round((totalDurationSec / totalQuestions) * 10) / 10 : 0;

  const sectionStats: CoachTopicStat[] = Array.from(buckets.values())
    .filter((b) => b.totalQuestions > 0)
    .map((b) => {
      const accuracyPct = b.totalQuestions > 0 ? Math.round((b.correctCount / b.totalQuestions) * 100) : 0;
      const avgSecPerQ = b.totalQuestions > 0 ? Math.round((b.totalSecWeighted / b.totalQuestions) * 10) / 10 : 0;
      const speedStatus: CoachTopicStat['speedStatus'] =
        avgSecPerQ >= 55 ? 'slow' : avgSecPerQ <= 28 ? 'fast' : 'balanced';

      const prog = sectionProgress[b.sectionKey];
      const combinedRemedialLow =
        Math.max(b.lowRemedialStreak, prog?.repeatedLowCount || 0) >= 2 ||
        (b.remedialAttempts >= 1 && (b.lastRemedialPct ?? 100) < 60);

      let recentTrend: CoachTopicStat['recentTrend'] = 'flat';
      if (b.attemptScores.length >= 2) {
        const firstHalf = b.attemptScores.slice(0, Math.ceil(b.attemptScores.length / 2));
        const secondHalf = b.attemptScores.slice(Math.ceil(b.attemptScores.length / 2));
        const a1 = firstHalf.reduce((s, x) => s + x.pct, 0) / firstHalf.length;
        const a2 = secondHalf.reduce((s, x) => s + x.pct, 0) / secondHalf.length;
        if (a2 - a1 >= 6) recentTrend = 'up';
        else if (a1 - a2 >= 6) recentTrend = 'down';
      }

      const masteredByProgress = Boolean(prog?.mastered) || (b.lastRemedialPct !== undefined && b.lastRemedialPct >= 95 && avgSecPerQ < 60);
      const strengthStatus: CoachTopicStat['strengthStatus'] =
        masteredByProgress || (accuracyPct >= 85 && speedStatus !== 'slow')
          ? 'strong'
          : accuracyPct >= 65
          ? 'developing'
          : 'weak';

      return {
        key: b.key,
        title: b.title,
        sectionKey: b.sectionKey,
        sectionTitle: b.sectionTitle,
        totalQuestions: b.totalQuestions,
        correctCount: b.correctCount,
        wrongCount: b.wrongCount,
        accuracyPct,
        avgSecPerQ,
        speedStatus,
        strengthStatus,
        recentTrend,
        remedialAttempts: Math.max(b.remedialAttempts, prog?.drillsCompleted || 0),
        lastRemedialPct: b.lastRemedialPct ?? prog?.lastScorePct,
        needsFoundationalPlan: combinedRemedialLow || (accuracyPct < 55 && b.wrongCount >= 4),
      };
    })
    .sort((a, b) => {
      // الأقسام الأضعف أو الأبطأ أولاً لتوجيه التقوية قسم قسم
      if (a.accuracyPct !== b.accuracyPct) return a.accuracyPct - b.accuracyPct;
      return b.wrongCount - a.wrongCount;
    });

  const strongSections = [...sectionStats]
    .filter((s) => s.accuracyPct >= 80)
    .sort((a, b) => b.accuracyPct - a.accuracyPct);

  const weakSections = [...sectionStats]
    .filter((s) => s.accuracyPct < 85 || s.wrongCount >= 2)
    .sort((a, b) => a.accuracyPct - b.accuracyPct || b.wrongCount - a.wrongCount);

  const slowSections = [...sectionStats]
    .filter((s) => s.avgSecPerQ >= 48)
    .sort((a, b) => b.avgSecPerQ - a.avgSecPerQ);

  // اختيار القسم الأهم للتقوية الآن (قسم واحد غير متقن بوضوح، وإلا الأبطأ)
  const prioritySection =
    weakSections.find((s) => s.strengthStatus !== 'strong') ||
    slowSections[0] ||
    sectionStats[0] ||
    null;

  const sectionNeedsFoundationalPlan =
    sectionStats.find((s) => s.needsFoundationalPlan) || null;

  return {
    totalAttempts: attempts.length,
    totalQuestions,
    correctCount,
    wrongCount,
    accuracyPct: totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0,
    avgSecPerQ: globalAvgSecPerQ,
    sectionStats,
    strongSections,
    weakSections,
    slowSections,
    prioritySection,
    sectionNeedsFoundationalPlan,
    recentMistakes: recentMistakes
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .slice(0, 12),
  };
}
