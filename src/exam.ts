import { deleteDoc, doc, serverTimestamp, setDoc } from './firestoreTracked';
import { db, handleFirestoreError, isFirestorePermissionError, OperationType } from './firebase';
import type { ExamQuestion, ExamSettings, MyQuiz, QuizAttempt, QuizQuestion } from './types';
import { sanitizeChart } from './quizChart';
import { sanitizeFigure } from './quizFigure';
import {
  encodeQuestionFieldsForFirestore,
  gradeTableQuestion,
  sanitizeExplanationComparison,
  sanitizeExplanationTable,
  sanitizeQuestionLaws,
  sanitizeTableQuestion,
  tableQuestionProblem,
} from './quizTable';

import { notifyRulesUpdateNeeded } from './starredQuestions';

export const EXAM_MAX_QUESTIONS = 10000;

export function newAttemptId(): string {
  return `attempt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** السؤال صالح للاختبار: خيارات صالحة أو جدول به فراغات متوقعة. */
export function isExamReady(q: QuizQuestion): boolean {
  if (!q.text.trim()) return false;
  if (q.questionType === 'table' || (q.table && q.choices.length === 0)) {
    return tableQuestionProblem(q.table) === null;
  }
  return (
    q.choices.length >= 2 &&
    q.correctIndex >= 0 &&
    q.correctIndex < q.choices.length &&
    q.choices.every((c) => c.trim().length > 0)
  );
}

export function validPool(quiz: MyQuiz): QuizQuestion[] {
  return (quiz.questions || []).filter(isExamReady);
}

/** أقصى عدد أسئلة متاح حسب الإعدادات الحالية. */
export function availableCount(quizzes: MyQuiz[], settings: Pick<ExamSettings, 'sourceMode' | 'mixMode' | 'quizIds'>): number {
  const chosen = quizzes.filter((q) => settings.quizIds.includes(q.id));
  if (settings.sourceMode === 'mix' && settings.mixMode === 'onePerQuiz') {
    return Math.min(EXAM_MAX_QUESTIONS, chosen.filter((q) => validPool(q).length > 0).length);
  }
  return Math.min(EXAM_MAX_QUESTIONS, chosen.reduce((n, q) => n + validPool(q).length, 0));
}

function toExamQuestion(q: QuizQuestion, quiz: MyQuiz, shuffleChoices: boolean): ExamQuestion {
  const isTable = q.questionType === 'table' || Boolean(q.table && q.choices.length === 0);
  let choices = isTable ? [] : q.choices.slice();
  let correctIndex = isTable ? -1 : q.correctIndex;
  if (!isTable && shuffleChoices) {
    const order = shuffle(choices.map((_, i) => i));
    choices = order.map((i) => q.choices[i]);
    correctIndex = order.indexOf(q.correctIndex);
  }
  const table = isTable && q.table ? sanitizeTableQuestion(q.table) : null;
  const chart = q.chart ? sanitizeChart(q.chart) : null;
  const figure = q.figure ? sanitizeFigure(q.figure) : null;
  const explanationChart = q.explanationChart ? sanitizeChart(q.explanationChart) : null;
  const explanationFigure = q.explanationFigure ? sanitizeFigure(q.explanationFigure) : null;
  const explanationTable = q.explanationTable ? sanitizeExplanationTable(q.explanationTable) : null;
  const explanationComparison = q.explanationComparison
    ? sanitizeExplanationComparison(q.explanationComparison)
    : null;
  const laws = sanitizeQuestionLaws(q.laws);
  return {
    id: `${quiz.id}:${q.id}`.slice(0, 120),
    sourceQuizId: quiz.id,
    sourceTitle: quiz.title,
    ...(isTable ? { questionType: 'table' as const } : {}),
    ...(laws ? { laws } : {}),
    ...(table ? { table } : {}),
    text: q.text,
    choices,
    correctIndex,
    explanation: q.explanation || '',
    ...(chart ? { chart } : {}),
    ...(figure ? { figure } : {}),
    ...(explanationChart ? { explanationChart } : {}),
    ...(explanationFigure ? { explanationFigure } : {}),
    ...(explanationTable ? { explanationTable } : {}),
    ...(explanationComparison ? { explanationComparison } : {}),
  };
}

export interface ExamRotationBuildResult {
  questions: ExamQuestion[];
  /** خريطة المعرفات المحدَّثة لكل نموذج بعد هذا الاختبار */
  nextSeenByQuizId: Record<string, string[]>;
  /** معرفات النماذج التي اكتملت دورتها في المحاولة السابقة وبدأت دورة جديدة الآن */
  restartedQuizIds: string[];
  /** معرفات النماذج التي اكتملت دورتها بنسبة 100% بعد إضافة أسئلة هذه المحاولة */
  completedAfterRunQuizIds: string[];
}

export interface ExamRotationStats {
  totalQuestions: number;
  seenQuestions: number;
  remainingUnseen: number;
}

export interface DerivedExamRotation {
  seenByQuizId: Record<string, string[]>;
  completedCyclesByQuizId: Record<string, number>;
}

function normalizeQuestionText(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * يتحقق هل أجاب الطالب فعلاً على السؤال داخل محاولة محفوظة أم تركه فارغاً/تخطاه.
 * يعمل مع أسئلة الاختيار من متعدد وأسئلة الجداول (حتى لو أُزيل tableAnswers عند الحفظ الاحتياطي).
 */
export function isAttemptQuestionAnswered(
  q: ExamQuestion,
  idx: number,
  attempt: Pick<QuizAttempt, 'answers' | 'tableAnswers'>
): boolean {
  const ans = Array.isArray(attempt.answers) ? attempt.answers[idx] : undefined;
  if (q.questionType === 'table' || q.table) {
    const rawTableAns = attempt.tableAnswers?.[String(idx)];
    if (rawTableAns && Object.keys(rawTableAns).length > 0) {
      return gradeTableQuestion(q.table, rawTableAns).answeredBlanks > 0;
    }
    return typeof ans === 'number' && ans >= 0;
  }
  return typeof ans === 'number' && ans >= 0;
}

/**
 * يراجع المحاولات السابقة المحفوظة للمستخدم ترتيباً زمنياً ويستخرج منها الأسئلة التي
 * أجاب عنها فعلاً في الدورة الحالية لكل نموذج، بينما تبقى الأسئلة التي لم يُجب عنها
 * (سواء لم تظهر أو ظهرت وتخطّاها/تركها بدون إجابة) ضمن المتبقي.
 */
export function deriveRotationFromAttempts(
  quizzes: MyQuiz[],
  attempts: QuizAttempt[],
  resetAtByQuizId: Record<string, number> = {}
): DerivedExamRotation {
  type QuizLookup = {
    quiz: MyQuiz;
    poolIds: Set<string>;
    byExactQId: Map<string, string>;
    byCompositeId: Map<string, string>;
    byText: Map<string, string>;
    resetAt: number;
  };

  const lookupsByQuizId = new Map<string, QuizLookup>();
  const allLookups: QuizLookup[] = [];

  for (const qz of quizzes) {
    const pool = validPool(qz);
    if (pool.length === 0) continue;
    const poolIds = new Set<string>();
    const byExactQId = new Map<string, string>();
    const byCompositeId = new Map<string, string>();
    const byText = new Map<string, string>();
    for (const q of pool) {
      poolIds.add(q.id);
      byExactQId.set(q.id, q.id);
      byCompositeId.set(`${qz.id}:${q.id}`.slice(0, 120), q.id);
      const norm = normalizeQuestionText(q.text);
      if (norm && !byText.has(norm)) {
        byText.set(norm, q.id);
      }
    }
    const lookup: QuizLookup = {
      quiz: qz,
      poolIds,
      byExactQId,
      byCompositeId,
      byText,
      resetAt: Number(resetAtByQuizId[qz.id]) || 0,
    };
    lookupsByQuizId.set(qz.id, lookup);
    allLookups.push(lookup);
  }

  const resolveMatch = (
    eq: ExamQuestion,
    attemptQuizIds?: string[]
  ): { quizId: string; questionId: string } | null => {
    const eqId = String(eq.id || '');
    const norm = normalizeQuestionText(eq.text);

    const tryLookup = (lk: QuizLookup): { quizId: string; questionId: string } | null => {
      const fromComposite = lk.byCompositeId.get(eqId);
      if (fromComposite) return { quizId: lk.quiz.id, questionId: fromComposite };
      const prefix = `${lk.quiz.id}:`;
      if (eqId.startsWith(prefix)) {
        const stripped = eqId.slice(prefix.length);
        const fromStripped = lk.byExactQId.get(stripped);
        if (fromStripped) return { quizId: lk.quiz.id, questionId: fromStripped };
      }
      const fromExact = lk.byExactQId.get(eqId);
      if (fromExact) return { quizId: lk.quiz.id, questionId: fromExact };
      if (norm) {
        const fromText = lk.byText.get(norm);
        if (fromText) return { quizId: lk.quiz.id, questionId: fromText };
      }
      return null;
    };

    if (eq.sourceQuizId) {
      const lk = lookupsByQuizId.get(eq.sourceQuizId);
      if (lk) {
        const hit = tryLookup(lk);
        if (hit) return hit;
      }
    }

    for (const lk of allLookups) {
      if (eqId.startsWith(`${lk.quiz.id}:`) || lk.byCompositeId.has(eqId)) {
        const hit = tryLookup(lk);
        if (hit) return hit;
      }
    }

    if (attemptQuizIds && attemptQuizIds.length > 0) {
      for (const qid of attemptQuizIds) {
        const lk = lookupsByQuizId.get(qid);
        if (!lk) continue;
        const hit = tryLookup(lk);
        if (hit) return hit;
      }
    }

    return null;
  };

  const stateByQuizId = new Map<string, { seen: Set<string>; completedCycles: number }>();
  for (const lk of allLookups) {
    stateByQuizId.set(lk.quiz.id, { seen: new Set<string>(), completedCycles: 0 });
  }

  const sortedAttempts = attempts
    .slice()
    .sort((a, b) => (Number(a.finishedAt) || 0) - (Number(b.finishedAt) || 0));

  for (const attempt of sortedAttempts) {
    const finishedAt = Number(attempt.finishedAt) || 0;
    const qs = Array.isArray(attempt.questions) ? attempt.questions : [];
    const attemptQuizIds = attempt.settings?.quizIds;
    const answeredByQuizInAttempt = new Map<string, string[]>();

    for (let i = 0; i < qs.length; i++) {
      const eq = qs[i];
      if (!isAttemptQuestionAnswered(eq, i, attempt)) continue;
      const match = resolveMatch(eq, attemptQuizIds);
      if (!match) continue;
      const lk = lookupsByQuizId.get(match.quizId);
      if (!lk || finishedAt <= lk.resetAt) continue;

      let list = answeredByQuizInAttempt.get(match.quizId);
      if (!list) {
        list = [];
        answeredByQuizInAttempt.set(match.quizId, list);
      }
      if (!list.includes(match.questionId)) {
        list.push(match.questionId);
      }
    }

    for (const [quizId, answeredIds] of answeredByQuizInAttempt.entries()) {
      const lk = lookupsByQuizId.get(quizId);
      const st = stateByQuizId.get(quizId);
      if (!lk || !st || answeredIds.length === 0) continue;
      const poolSize = lk.poolIds.size;

      // إذا كانت الدورة السابقة مكتملة بالكامل قبل هذه المحاولة، فهذه المحاولة تفتح دورة جديدة
      if (st.seen.size >= poolSize) {
        st.seen = new Set<string>();
      }

      const finishingOld: string[] = [];
      const alreadySeen: string[] = [];
      for (const qId of answeredIds) {
        if (st.seen.has(qId)) {
          alreadySeen.push(qId);
        } else {
          finishingOld.push(qId);
        }
      }

      for (const qId of finishingOld) {
        st.seen.add(qId);
      }

      if (st.seen.size >= poolSize) {
        st.completedCycles += 1;
        // إذا كان نفس الاختبار قد أكمل المتبقي من الدورة القديمة وسحب أيضاً أسئلة من دورة جديدة
        if (alreadySeen.length > 0) {
          st.seen = new Set<string>(alreadySeen);
          if (st.seen.size >= poolSize) {
            st.completedCycles += 1;
          }
        }
      } else {
        for (const qId of alreadySeen) {
          st.seen.add(qId);
        }
      }
    }
  }

  const seenByQuizId: Record<string, string[]> = {};
  const completedCyclesByQuizId: Record<string, number> = {};
  for (const [quizId, st] of stateByQuizId.entries()) {
    if (st.seen.size > 0) {
      seenByQuizId[quizId] = Array.from(st.seen);
    }
    if (st.completedCycles > 0) {
      completedCyclesByQuizId[quizId] = st.completedCycles;
    }
  }

  return { seenByQuizId, completedCyclesByQuizId };
}

/** يحسب إحصائيات التغطية الحالية في الدورة للنماذج المختارة. */
export function getExamRotationStats(
  quizzes: MyQuiz[],
  quizIds: string[],
  seenByQuizId: Record<string, string[]>
): ExamRotationStats {
  const idSet = new Set(quizIds);
  let totalQuestions = 0;
  let seenQuestions = 0;

  for (const qz of quizzes) {
    if (!idSet.has(qz.id)) continue;
    const pool = validPool(qz);
    if (pool.length === 0) continue;
    totalQuestions += pool.length;
    const seenSet = new Set(seenByQuizId[qz.id] ?? []);
    let qzSeen = 0;
    for (const q of pool) {
      if (seenSet.has(q.id)) qzSeen++;
    }
    seenQuestions += qzSeen;
  }

  return {
    totalQuestions,
    seenQuestions,
    remainingUnseen: Math.max(0, totalQuestions - seenQuestions),
  };
}

/**
 * يبني قائمة أسئلة الاختبار مع تجنب تكرار الأسئلة التي ظهرت في المحاولات السابقة
 * حتى تنتهي جميع أسئلة كل نموذج، ثم يعيد دورة النموذج من البداية تلقائياً.
 */
export function buildExamWithRotation(
  quizzes: MyQuiz[],
  settings: ExamSettings,
  seenByQuizId: Record<string, string[]>
): ExamRotationBuildResult {
  const chosen = settings.quizIds
    .map((id) => quizzes.find((q) => q.id === id))
    .filter((q): q is MyQuiz => !!q && validPool(q).length > 0);
  if (chosen.length === 0) {
    return {
      questions: [],
      nextSeenByQuizId: { ...seenByQuizId },
      restartedQuizIds: [],
      completedAfterRunQuizIds: [],
    };
  }

  type Item = { q: QuizQuestion; quiz: MyQuiz; order: number; fromRefill: boolean };

  const prepareQuizBuckets = (qz: MyQuiz) => {
    const pool = validPool(qz).map((q, order) => ({ q, quiz: qz, order }));
    const seenSet = new Set(seenByQuizId[qz.id] ?? []);
    const unseenBase = pool.filter((it) => !seenSet.has(it.q.id));
    const seenBase = pool.filter((it) => seenSet.has(it.q.id));
    const unseen = (settings.shuffleQuestions ? shuffle(unseenBase) : unseenBase).map((it) => ({
      ...it,
      fromRefill: false,
    }));
    const refill = (settings.shuffleQuestions ? shuffle(seenBase) : seenBase).map((it) => ({
      ...it,
      fromRefill: true,
    }));
    return { qz, pool, seenSet, unseen, refill };
  };

  let picked: Item[] = [];
  const restartedSet = new Set<string>();

  if (settings.sourceMode === 'single' || chosen.length === 1) {
    const bucket = prepareQuizBuckets(chosen[0]);
    const n = Math.max(1, Math.min(settings.questionCount, bucket.pool.length, EXAM_MAX_QUESTIONS));

    if (bucket.unseen.length === 0) {
      // الدورة السابقة اكتملت بالكامل -> نبدأ دورة جديدة على كل الأسئلة
      restartedSet.add(bucket.qz.id);
      const fresh = settings.shuffleQuestions
        ? shuffle(bucket.pool)
        : bucket.pool.slice();
      picked = fresh.slice(0, n).map((it) => ({ ...it, fromRefill: true }));
    } else if (bucket.unseen.length >= n) {
      picked = bucket.unseen.slice(0, n);
    } else {
      // لم يبقَ في الدورة الحالية سوى جزء أقل من المطلوب -> نأخذ المتبقي غير المجاب ثم نكمل من دورة جديدة دون تكرار في نفس الاختبار
      restartedSet.add(bucket.qz.id);
      const needMore = n - bucket.unseen.length;
      picked = [...bucket.unseen, ...bucket.refill.slice(0, needMore)];
    }

    if (!settings.shuffleQuestions && !restartedSet.has(bucket.qz.id)) {
      picked = picked.slice().sort((a, b) => a.order - b.order);
    }
  } else if (settings.mixMode === 'onePerQuiz') {
    picked = chosen.map((qz) => {
      const bucket = prepareQuizBuckets(qz);
      if (bucket.unseen.length > 0) {
        const idx = Math.floor(Math.random() * bucket.unseen.length);
        return bucket.unseen[idx];
      }
      restartedSet.add(qz.id);
      const idx = Math.floor(Math.random() * bucket.pool.length);
      return { ...bucket.pool[idx], fromRefill: true };
    });
  } else {
    // عدد محدد موزّع بالتساوي على النماذج (دوران): أولوية الأسئلة غير المختبرة من كل نموذج أولاً
    const buckets = chosen.map((qz) => {
      const b = prepareQuizBuckets(qz);
      return {
        ...b,
        // للعرض بالترتيب نستخدم shift من المقدمة، أو pop من المخلط
        unseenQueue: b.unseen.slice(),
        refillQueue: b.refill.slice(),
      };
    });
    const n = Math.max(1, Math.min(settings.questionCount, EXAM_MAX_QUESTIONS));
    let guard = 0;

    // المرحلة 1: السحب بالتناوب من الأسئلة غير المختبرة فقط عبر جميع النماذج المختارة
    while (picked.length < n && guard < 10000) {
      guard++;
      let took = false;
      for (const b of buckets) {
        if (picked.length >= n) break;
        const next = b.unseenQueue.shift();
        if (next) {
          picked.push(next);
          took = true;
        }
      }
      if (!took) break;
    }

    // المرحلة 2: إذا احتاج المستخدم عدداً أكبر من المتبقي غير المختبر، نُكمل من دورة جديدة لكل نموذج نفد رصيده
    while (picked.length < n && guard < 20000) {
      guard++;
      let took = false;
      for (const b of buckets) {
        if (picked.length >= n) break;
        const next = b.refillQueue.shift();
        if (next) {
          restartedSet.add(b.qz.id);
          picked.push(next);
          took = true;
        }
      }
      if (!took) break;
    }
  }

  // تحديث سجل الأسئلة المختبرة لكل نموذج بناءً على الأسئلة المختارة فعلياً
  const nextSeenByQuizId: Record<string, string[]> = { ...seenByQuizId };
  const completedAfterRunQuizIds: string[] = [];

  for (const qz of chosen) {
    const pool = validPool(qz);
    const poolIds = new Set(pool.map((q) => q.id));
    const prevSeenValid = (seenByQuizId[qz.id] ?? []).filter((id) => poolIds.has(id));
    const pickedForQuiz = picked.filter((it) => it.quiz.id === qz.id);

    if (pickedForQuiz.length === 0) {
      if (prevSeenValid.length > 0) {
        nextSeenByQuizId[qz.id] = prevSeenValid;
      } else {
        delete nextSeenByQuizId[qz.id];
      }
      continue;
    }

    const refillPicked = pickedForQuiz.filter((it) => it.fromRefill);
    let updated: string[];
    if (refillPicked.length === 0) {
      const merged = new Set([...prevSeenValid, ...pickedForQuiz.map((it) => it.q.id)]);
      updated = Array.from(merged);
    } else if (pickedForQuiz.length >= pool.length) {
      // إذا غطى الاختبار جميع أسئلة النموذج دفعة واحدة، نعلّم الدورة 100% مكتملة
      updated = pool.map((q) => q.id);
    } else {
      // تم استهلاك باقي الدورة السابقة وبدأت دورة جديدة بأسئلة refillPicked
      updated = Array.from(new Set(refillPicked.map((it) => it.q.id)));
    }

    if (updated.length > 0) {
      nextSeenByQuizId[qz.id] = updated;
    } else {
      delete nextSeenByQuizId[qz.id];
    }

    if (updated.length >= pool.length) {
      completedAfterRunQuizIds.push(qz.id);
    }
  }

  const ordered = settings.shuffleQuestions ? shuffle(picked) : picked;
  return {
    questions: ordered
      .slice(0, EXAM_MAX_QUESTIONS)
      .map((it) => toExamQuestion(it.q, it.quiz, settings.shuffleChoices)),
    nextSeenByQuizId,
    restartedQuizIds: Array.from(restartedSet),
    completedAfterRunQuizIds,
  };
}

/** يبني قائمة أسئلة الاختبار حسب الإعدادات (مزج وتنويع وعدد). */
export function buildExam(quizzes: MyQuiz[], settings: ExamSettings): ExamQuestion[] {
  return buildExamWithRotation(quizzes, settings, {}).questions;
}

export function isQuestionAnswered(
  q: ExamQuestion,
  idx: number,
  answers: number[],
  tableAnswers?: Record<string, Record<string, string>>
): boolean {
  if (q.questionType === 'table' || q.table) {
    return gradeTableQuestion(q.table, tableAnswers?.[String(idx)]).answeredBlanks > 0;
  }
  return (answers[idx] ?? -1) >= 0;
}

export function isQuestionCorrect(
  q: ExamQuestion,
  idx: number,
  answers: number[],
  tableAnswers?: Record<string, Record<string, string>>
): boolean {
  if (q.questionType === 'table' || q.table) {
    return gradeTableQuestion(q.table, tableAnswers?.[String(idx)]).isAllCorrect;
  }
  return answers[idx] === q.correctIndex;
}

export function scoreExam(
  questions: ExamQuestion[],
  answers: number[],
  tableAnswers?: Record<string, Record<string, string>>
): number {
  return questions.reduce((n, q, i) => n + (isQuestionCorrect(q, i, answers, tableAnswers) ? 1 : 0), 0);
}

export function defaultExamTitle(settings: ExamSettings): string {
  if (settings.sourceMode === 'single' || settings.quizTitles.length === 1) return settings.quizTitles[0] || 'اختبار';
  return `مزيج من ${settings.quizTitles.length} نماذج`;
}

export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function describeTiming(s: Pick<ExamSettings, 'timing' | 'seconds'>): string {
  if (s.timing === 'none') return 'بدون وقت';
  if (s.timing === 'perQuestion') return `${s.seconds} ثانية لكل سؤال`;
  return `${Math.round(s.seconds / 60)} دقيقة للاختبار كاملاً`;
}

/* ------------------------- Firestore ------------------------- */

export function buildAttempt(
  ownerId: string,
  id: string,
  settings: ExamSettings,
  questions: ExamQuestion[],
  answers: number[],
  durationSec: number,
  finishedAt: number,
  tableAnswers?: Record<string, Record<string, string>>
): Omit<QuizAttempt, 'createdAt'> {
  const hasTableAnswers = Boolean(tableAnswers && Object.keys(tableAnswers).length > 0);
  return {
    id,
    ownerId,
    title: defaultExamTitle(settings).slice(0, 200),
    settings,
    questions,
    answers: questions.map((q, i) => {
      if (q.questionType === 'table' || q.table) {
        const g = gradeTableQuestion(q.table, tableAnswers?.[String(i)]);
        if (g.answeredBlanks === 0) return -1;
        return g.isAllCorrect ? 1 : 0;
      }
      return Number.isInteger(answers[i]) ? answers[i] : -1;
    }),
    ...(hasTableAnswers ? { tableAnswers } : {}),
    score: scoreExam(questions, answers, tableAnswers),
    total: questions.length,
    durationSec: Math.max(0, Math.round(durationSec)),
    finishedAt,
  };
}

function compactAttemptIfOversized(
  attempt: Omit<QuizAttempt, 'createdAt'>,
  maxBytes = 880_000
): Omit<QuizAttempt, 'createdAt'> {
  const enc = new TextEncoder();
  if (enc.encode(JSON.stringify(attempt)).length <= maxBytes) return attempt;
  // Strip verbose explanation payloads from attempt snapshot if total size exceeds 1MB Firestore cap
  const trimmedQuestions = attempt.questions.map((q) => ({
    ...q,
    explanation: q.explanation ? q.explanation.slice(0, 300) : '',
    explanationChart: undefined,
    explanationFigure: undefined,
    explanationTable: undefined,
    explanationComparison: undefined,
  }));
  const cleanedQuestions = trimmedQuestions.map((q) => {
    const out = { ...q };
    if (out.explanationChart === undefined) delete out.explanationChart;
    if (out.explanationFigure === undefined) delete out.explanationFigure;
    if (out.explanationTable === undefined) delete out.explanationTable;
    if (out.explanationComparison === undefined) delete out.explanationComparison;
    return out;
  });
  return { ...attempt, questions: cleanedQuestions };
}

export async function saveAttempt(attempt: Omit<QuizAttempt, 'createdAt'>): Promise<void> {
  const path = `users/${attempt.ownerId}/quizAttempts/${attempt.id}`;
  const safeAttempt = compactAttemptIfOversized(attempt);
  const firestoreAttempt = {
    ...safeAttempt,
    questions: safeAttempt.questions.map((q) =>
      encodeQuestionFieldsForFirestore(q as unknown as Record<string, unknown>)
    ),
  };
  try {
    await setDoc(doc(db, 'users', safeAttempt.ownerId, 'quizAttempts', safeAttempt.id), {
      ...firestoreAttempt,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    // Fallback if older firestore.rules are still active on the database and reject top-level tableAnswers
    if (isFirestorePermissionError(err)) {
      if (safeAttempt.questions.length > 100) {
        notifyRulesUpdateNeeded();
      }
      if (firestoreAttempt.tableAnswers) {
        const stripped = { ...firestoreAttempt };
        delete stripped.tableAnswers;
        try {
          await setDoc(doc(db, 'users', stripped.ownerId, 'quizAttempts', stripped.id), {
            ...stripped,
            createdAt: serverTimestamp(),
          });
          return;
        } catch {
          // Fall through to handleFirestoreError
        }
      }
    }
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function deleteAttempt(uid: string, id: string): Promise<void> {
  const path = `users/${uid}/quizAttempts/${id}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'quizAttempts', id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}
