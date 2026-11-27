import { deleteDoc, doc, serverTimestamp, setDoc } from './firestoreTracked';
import { db, handleFirestoreError, isFirestorePermissionError, OperationType } from './firebase';
import type { ExamQuestion, ExamSettings, MyQuiz, QuizAttempt, QuizQuestion, StarredQuestion } from './types';
import { sanitizeChart } from './quizChart';
import { sanitizeFigure } from './quizFigure';
import {
  encodeQuestionFieldsForFirestore,
  gradeTableQuestion,
  sanitizeDataTable,
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

function asExamText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return '';
}

/** السؤال صالح للاختبار: خيارات صالحة أو جدول به فراغات متوقعة. */
export function isExamReady(q: QuizQuestion | null | undefined): boolean {
  if (!q || typeof q !== 'object') return false;
  if (!asExamText((q as { text?: unknown }).text).trim()) return false;
  const choices = Array.isArray(q.choices) ? q.choices : [];
  if (q.questionType === 'table' || (q.table && choices.length === 0)) {
    try {
      return tableQuestionProblem(q.table) === null;
    } catch {
      return false;
    }
  }
  return (
    choices.length >= 2 &&
    Number.isInteger(q.correctIndex) &&
    q.correctIndex >= 0 &&
    q.correctIndex < choices.length &&
    choices.every((c) => asExamText(c).trim().length > 0)
  );
}

export function validPool(quiz: MyQuiz | null | undefined): QuizQuestion[] {
  return (quiz && Array.isArray(quiz.questions) ? quiz.questions : []).filter(isExamReady);
}

/** أقصى عدد أسئلة متاح حسب الإعدادات الحالية. */
export function availableCount(
  quizzes: MyQuiz[],
  settings: Pick<ExamSettings, 'sourceMode' | 'mixMode' | 'quizIds'>
): number {
  const safeQuizzes = Array.isArray(quizzes) ? quizzes : [];
  const quizIds = Array.isArray(settings?.quizIds) ? settings.quizIds : [];
  const chosen = safeQuizzes.filter((q) => q && quizIds.includes(q.id));
  if (settings?.sourceMode === 'mix' && settings?.mixMode === 'onePerQuiz') {
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
  const dataTable = q.dataTable ? sanitizeDataTable(q.dataTable) : null;
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
    ...(dataTable ? { dataTable } : {}),
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
    ...(q.redeemsFingerprint ? { redeemsFingerprint: q.redeemsFingerprint } : {}),
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
  q: ExamQuestion | null | undefined,
  idx: number,
  attempt: Pick<QuizAttempt, 'answers' | 'tableAnswers'> | null | undefined
): boolean {
  if (!q || typeof q !== 'object' || !attempt || typeof attempt !== 'object') return false;
  const ans = Array.isArray(attempt.answers) ? attempt.answers[idx] : undefined;
  if (q.questionType === 'table' || q.table) {
    const rawTableAns = attempt.tableAnswers?.[String(idx)];
    if (rawTableAns && typeof rawTableAns === 'object' && Object.keys(rawTableAns).length > 0) {
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
  q: ExamQuestion | null | undefined,
  idx: number,
  answers: number[],
  tableAnswers?: Record<string, Record<string, string>>
): boolean {
  if (!q || typeof q !== 'object') return false;
  if (q.questionType === 'table' || q.table) {
    return gradeTableQuestion(q.table, tableAnswers?.[String(idx)]).answeredBlanks > 0;
  }
  return Array.isArray(answers) && (answers[idx] ?? -1) >= 0;
}

export function isQuestionCorrect(
  q: ExamQuestion | null | undefined,
  idx: number,
  answers: number[],
  tableAnswers?: Record<string, Record<string, string>>
): boolean {
  if (!q || typeof q !== 'object') return false;
  if (q.questionType === 'table' || q.table) {
    return gradeTableQuestion(q.table, tableAnswers?.[String(idx)]).isAllCorrect;
  }
  return Array.isArray(answers) && answers[idx] === q.correctIndex;
}

export function scoreExam(
  questions: ExamQuestion[],
  answers: number[],
  tableAnswers?: Record<string, Record<string, string>>
): number {
  const qs = Array.isArray(questions) ? questions : [];
  return qs.reduce((n, q, i) => n + (isQuestionCorrect(q, i, answers, tableAnswers) ? 1 : 0), 0);
}

function normReconcileKey(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function looseReconcileKey(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/\$/g, '')
    .replace(/\\(?:left|right)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function similarityScore(a: string, b: string): number {
  const la = looseReconcileKey(a);
  const lb = looseReconcileKey(b);
  if (!la || !lb) return 0;
  if (la === lb) return 1000;
  let score = 0;
  if (la.includes(lb) || lb.includes(la)) score += 40;
  const numsA = la.match(/\d+(?:[.,]\d+)?/g) ?? [];
  const numsB = lb.match(/\d+(?:[.,]\d+)?/g) ?? [];
  if (numsA.length > 0 && numsB.length > 0) {
    const setB = new Set(numsB);
    for (const n of numsA) {
      if (setB.has(n)) score += 30;
    }
  }
  const tokensA = new Set(la.split(/\s+/).filter(Boolean));
  const tokensB = new Set(lb.split(/\s+/).filter(Boolean));
  for (const t of tokensA) {
    if (tokensB.has(t)) score += 10;
  }
  return score;
}

function buildUpdatedExamQuestion(
  eq: ExamQuestion,
  latestQ: QuizQuestion,
  choices: string[],
  correctIndex: number,
  latestQuizTitle?: string
): ExamQuestion {
  const isTable = latestQ.questionType === 'table' || Boolean(latestQ.table && latestQ.choices.length === 0);
  const out: ExamQuestion = {
    id: eq.id,
    sourceQuizId: eq.sourceQuizId,
    sourceTitle: latestQuizTitle || eq.sourceTitle,
    ...(isTable ? { questionType: 'table' as const } : { questionType: 'mcq' as const }),
    ...(latestQ.laws && latestQ.laws.length > 0 ? { laws: latestQ.laws } : {}),
    ...(isTable && latestQ.table ? { table: latestQ.table } : {}),
    ...(latestQ.dataTable ? { dataTable: latestQ.dataTable } : {}),
    ...(latestQ.chart ? { chart: latestQ.chart } : {}),
    ...(latestQ.figure ? { figure: latestQ.figure } : {}),
    ...(latestQ.explanationChart ? { explanationChart: latestQ.explanationChart } : {}),
    ...(latestQ.explanationFigure ? { explanationFigure: latestQ.explanationFigure } : {}),
    ...(latestQ.explanationTable ? { explanationTable: latestQ.explanationTable } : {}),
    ...(latestQ.explanationComparison ? { explanationComparison: latestQ.explanationComparison } : {}),
    ...(eq.redeemsFingerprint ? { redeemsFingerprint: eq.redeemsFingerprint } : {}),
    text: latestQ.text,
    choices: isTable ? [] : choices,
    correctIndex: isTable ? -1 : correctIndex,
    explanation: latestQ.explanation || '',
  };
  return out;
}

function reconcileMcqChoicesAndAnswer(
  eq: ExamQuestion,
  latestQ: QuizQuestion,
  oldAns: number,
  shuffleChoices: boolean
): { choices: string[]; correctIndex: number; nextAnswer: number } {
  const oldChoices = Array.isArray(eq.choices) ? eq.choices : [];
  const newChoices = Array.isArray(latestQ.choices) ? latestQ.choices : [];
  const targetIdx =
    Number.isInteger(latestQ.correctIndex) && latestQ.correctIndex >= 0 && latestQ.correctIndex < newChoices.length
      ? latestQ.correctIndex
      : -1;

  if (oldChoices.length === 0 || oldAns < 0 || oldAns >= oldChoices.length) {
    return {
      choices: newChoices.slice(),
      correctIndex: targetIdx,
      nextAnswer: oldAns >= 0 && oldChoices.length === 0 && oldAns < newChoices.length ? oldAns : -1,
    };
  }

  const chosenText = oldChoices[oldAns];
  const normChosen = normReconcileKey(chosenText);
  const looseChosen = looseReconcileKey(chosenText);

  if (!shuffleChoices) {
    if (oldChoices.length === newChoices.length) {
      if (normReconcileKey(newChoices[oldAns]) === normChosen || looseReconcileKey(newChoices[oldAns]) === looseChosen) {
        return { choices: newChoices.slice(), correctIndex: targetIdx, nextAnswer: oldAns };
      }
      const movedIdxNorm = newChoices.findIndex((c) => normReconcileKey(c) === normChosen);
      const movedIdxLoose =
        movedIdxNorm >= 0 ? movedIdxNorm : newChoices.findIndex((c) => looseReconcileKey(c) === looseChosen);
      if (
        movedIdxLoose >= 0 &&
        normReconcileKey(oldChoices[movedIdxLoose]) !== normReconcileKey(newChoices[movedIdxLoose])
      ) {
        return { choices: newChoices.slice(), correctIndex: targetIdx, nextAnswer: movedIdxLoose };
      }
      return { choices: newChoices.slice(), correctIndex: targetIdx, nextAnswer: oldAns };
    }
    const movedNorm = newChoices.findIndex((c) => normReconcileKey(c) === normChosen);
    const movedLoose = movedNorm >= 0 ? movedNorm : newChoices.findIndex((c) => looseReconcileKey(c) === looseChosen);
    return {
      choices: newChoices.slice(),
      correctIndex: targetIdx,
      nextAnswer: movedLoose >= 0 ? movedLoose : oldAns < newChoices.length ? oldAns : -1,
    };
  }

  // Shuffled choices: build 1-to-1 correspondence for unchanged options first
  const oldToNew = new Map<number, number>();
  const usedNew = new Set<number>();

  // Pass 1: strict norm match
  for (let oi = 0; oi < oldChoices.length; oi++) {
    const key = normReconcileKey(oldChoices[oi]);
    if (!key) continue;
    const hit = newChoices.findIndex((nc, ni) => !usedNew.has(ni) && normReconcileKey(nc) === key);
    if (hit >= 0) {
      oldToNew.set(oi, hit);
      usedNew.add(hit);
    }
  }
  // Pass 2: loose match
  for (let oi = 0; oi < oldChoices.length; oi++) {
    if (oldToNew.has(oi)) continue;
    const key = looseReconcileKey(oldChoices[oi]);
    if (!key) continue;
    const hit = newChoices.findIndex((nc, ni) => !usedNew.has(ni) && looseReconcileKey(nc) === key);
    if (hit >= 0) {
      oldToNew.set(oi, hit);
      usedNew.add(hit);
    }
  }

  if (oldToNew.has(oldAns)) {
    return {
      choices: newChoices.slice(),
      correctIndex: targetIdx,
      nextAnswer: oldToNew.get(oldAns)!,
    };
  }

  const unmatchedOld = oldChoices.map((_, i) => i).filter((i) => !oldToNew.has(i));
  const unmatchedNew = newChoices.map((_, i) => i).filter((i) => !usedNew.has(i));

  if (unmatchedOld.length === 1 && unmatchedNew.length === 1) {
    return {
      choices: newChoices.slice(),
      correctIndex: targetIdx,
      nextAnswer: unmatchedNew[0],
    };
  }

  if (unmatchedNew.length > 0) {
    let bestNi = unmatchedNew[0];
    let bestScore = -1;
    for (const ni of unmatchedNew) {
      const s = similarityScore(chosenText, newChoices[ni]);
      if (s > bestScore) {
        bestScore = s;
        bestNi = ni;
      }
    }
    if (bestScore > 0) {
      return { choices: newChoices.slice(), correctIndex: targetIdx, nextAnswer: bestNi };
    }
    const ord = unmatchedOld.indexOf(oldAns);
    const mapped = ord >= 0 && ord < unmatchedNew.length ? unmatchedNew[ord] : unmatchedNew[0];
    return { choices: newChoices.slice(), correctIndex: targetIdx, nextAnswer: mapped };
  }

  return {
    choices: newChoices.slice(),
    correctIndex: targetIdx,
    nextAnswer: oldAns < newChoices.length ? oldAns : -1,
  };
}

interface QuizQuestionLookup {
  quiz: MyQuiz;
  questions: QuizQuestion[];
  byId: Map<string, QuizQuestion>;
  byNormText: Map<string, QuizQuestion>;
  byLooseText: Map<string, QuizQuestion>;
}

interface QuizLookupIndex {
  byQuizId: Map<string, QuizQuestionLookup>;
  byNormTitle: Map<string, QuizQuestionLookup[]>;
  globalById: Map<string, { quiz: MyQuiz; qq: QuizQuestion }>;
  globalByNormText: Map<string, { quiz: MyQuiz; qq: QuizQuestion }>;
  globalByLooseText: Map<string, { quiz: MyQuiz; qq: QuizQuestion }>;
}

function buildQuizLookupIndex(quizzes: MyQuiz[]): QuizLookupIndex {
  const byQuizId = new Map<string, QuizQuestionLookup>();
  const byNormTitle = new Map<string, QuizQuestionLookup[]>();
  const globalById = new Map<string, { quiz: MyQuiz; qq: QuizQuestion }>();
  const globalByNormText = new Map<string, { quiz: MyQuiz; qq: QuizQuestion }>();
  const globalByLooseText = new Map<string, { quiz: MyQuiz; qq: QuizQuestion }>();

  for (const quiz of quizzes) {
    if (!quiz?.id || !Array.isArray(quiz.questions)) continue;
    const byId = new Map<string, QuizQuestion>();
    const byNormText = new Map<string, QuizQuestion>();
    const byLooseText = new Map<string, QuizQuestion>();
    for (const qq of quiz.questions) {
      if (!qq || typeof qq !== 'object') continue;
      if (qq.id) {
        const composite = `${quiz.id}:${qq.id}`.slice(0, 120);
        byId.set(qq.id, qq);
        byId.set(composite, qq);
        if (!globalById.has(qq.id)) globalById.set(qq.id, { quiz, qq });
        if (!globalById.has(composite)) globalById.set(composite, { quiz, qq });
      }
      const normKey = normReconcileKey(qq.text);
      if (normKey) {
        if (!byNormText.has(normKey)) byNormText.set(normKey, qq);
        if (!globalByNormText.has(normKey)) globalByNormText.set(normKey, { quiz, qq });
      }
      const looseKey = looseReconcileKey(qq.text);
      if (looseKey) {
        if (!byLooseText.has(looseKey)) byLooseText.set(looseKey, qq);
        if (!globalByLooseText.has(looseKey)) globalByLooseText.set(looseKey, { quiz, qq });
      }
    }
    const entry: QuizQuestionLookup = {
      quiz,
      questions: quiz.questions,
      byId,
      byNormText,
      byLooseText,
    };
    byQuizId.set(quiz.id, entry);
    const titleKey = normReconcileKey(quiz.title);
    if (titleKey) {
      const arr = byNormTitle.get(titleKey) ?? [];
      arr.push(entry);
      byNormTitle.set(titleKey, arr);
    }
  }

  return { byQuizId, byNormTitle, globalById, globalByNormText, globalByLooseText };
}

function lookupIdInMap(
  map: Map<string, QuizQuestion>,
  eqId: string | undefined,
  sourceQuizId: string | undefined
): QuizQuestion | undefined {
  if (!eqId) return undefined;
  const direct = map.get(eqId);
  if (direct) return direct;
  if (sourceQuizId && eqId.startsWith(`${sourceQuizId}:`)) {
    const stripped = eqId.slice(sourceQuizId.length + 1);
    const hit = map.get(stripped);
    if (hit) return hit;
  }
  const colonIdx = eqId.indexOf(':');
  if (colonIdx > 0 && colonIdx < eqId.length - 1) {
    return map.get(eqId.slice(colonIdx + 1));
  }
  return undefined;
}

function findLatestMatchForExamQuestion(
  eq: ExamQuestion,
  idx: number,
  index: QuizLookupIndex,
  options?: { allowSingleQuizPositionalFallback?: boolean; totalQuestions?: number }
): { quiz?: MyQuiz; qq: QuizQuestion } | null {
  const sourceMap = eq.sourceQuizId ? index.byQuizId.get(eq.sourceQuizId) : undefined;
  const normText = normReconcileKey(eq.text);
  const looseText = looseReconcileKey(eq.text);

  if (sourceMap) {
    const direct =
      lookupIdInMap(sourceMap.byId, eq.id, eq.sourceQuizId) ||
      (normText ? sourceMap.byNormText.get(normText) : undefined) ||
      (looseText ? sourceMap.byLooseText.get(looseText) : undefined);
    if (direct) return { quiz: sourceMap.quiz, qq: direct };

    if (
      options?.allowSingleQuizPositionalFallback &&
      options.totalQuestions === sourceMap.questions.length &&
      idx >= 0 &&
      idx < sourceMap.questions.length
    ) {
      const positional = sourceMap.questions[idx];
      if (positional && isExamReady(positional)) {
        return { quiz: sourceMap.quiz, qq: positional };
      }
    }
  }

  // Same-title quiz lookup (e.g. if quiz was re-imported with same title)
  const titleKey = normReconcileKey(eq.sourceTitle);
  if (titleKey) {
    const candidates = index.byNormTitle.get(titleKey);
    if (candidates) {
      for (const lk of candidates) {
        const hit =
          lookupIdInMap(lk.byId, eq.id, lk.quiz.id) ||
          (normText ? lk.byNormText.get(normText) : undefined) ||
          (looseText ? lk.byLooseText.get(looseText) : undefined);
        if (hit) return { quiz: lk.quiz, qq: hit };
      }
    }
  }

  // Global fallback (covers starred, coach_mistakes_review, mix, or re-imported quizzes)
  if (eq.id) {
    const directGlobal = index.globalById.get(eq.id);
    if (directGlobal) return directGlobal;
    const colonIdx = eq.id.indexOf(':');
    if (colonIdx > 0 && colonIdx < eq.id.length - 1) {
      const strippedGlobal = index.globalById.get(eq.id.slice(colonIdx + 1));
      if (strippedGlobal) return strippedGlobal;
    }
  }
  if (normText) {
    const hit = index.globalByNormText.get(normText);
    if (hit) return hit;
  }
  if (looseText) {
    const hit = index.globalByLooseText.get(looseText);
    if (hit) return hit;
  }
  return null;
}

function examQuestionsDiffer(a: ExamQuestion, b: ExamQuestion): boolean {
  return (
    a.text !== b.text ||
    a.sourceTitle !== b.sourceTitle ||
    a.correctIndex !== b.correctIndex ||
    a.explanation !== b.explanation ||
    a.questionType !== b.questionType ||
    JSON.stringify(a.choices) !== JSON.stringify(b.choices) ||
    JSON.stringify(a.table ?? null) !== JSON.stringify(b.table ?? null) ||
    JSON.stringify(a.dataTable ?? null) !== JSON.stringify(b.dataTable ?? null) ||
    JSON.stringify(a.laws ?? null) !== JSON.stringify(b.laws ?? null) ||
    JSON.stringify(a.figure ?? null) !== JSON.stringify(b.figure ?? null) ||
    JSON.stringify(a.chart ?? null) !== JSON.stringify(b.chart ?? null) ||
    JSON.stringify(a.explanationTable ?? null) !== JSON.stringify(b.explanationTable ?? null) ||
    JSON.stringify(a.explanationComparison ?? null) !== JSON.stringify(b.explanationComparison ?? null) ||
    JSON.stringify(a.explanationChart ?? null) !== JSON.stringify(b.explanationChart ?? null) ||
    JSON.stringify(a.explanationFigure ?? null) !== JSON.stringify(b.explanationFigure ?? null)
  );
}

export function reconcileExamQuestionsWithQuizzes(
  questions: ExamQuestion[],
  quizzes: MyQuiz[],
  shuffleChoices = false
): ExamQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0 || !Array.isArray(quizzes) || quizzes.length === 0) {
    return questions;
  }
  const index = buildQuizLookupIndex(quizzes);
  let changed = false;
  const next = questions.map((eq, idx) => {
    if (!eq || typeof eq !== 'object') return eq;
    const hit = findLatestMatchForExamQuestion(eq, idx, index);
    if (!hit || !isExamReady(hit.qq)) return eq;
    const latestQ = hit.qq;
    const isTable = latestQ.questionType === 'table' || Boolean(latestQ.table && latestQ.choices.length === 0);
    const updated = isTable
      ? buildUpdatedExamQuestion(eq, latestQ, [], -1, hit.quiz?.title)
      : (() => {
          const r = reconcileMcqChoicesAndAnswer(eq, latestQ, -1, shuffleChoices);
          return buildUpdatedExamQuestion(eq, latestQ, r.choices, r.correctIndex, hit.quiz?.title);
        })();
    if (examQuestionsDiffer(updated, eq)) {
      changed = true;
      return updated;
    }
    return eq;
  });
  return changed ? next : questions;
}

export function reconcileStarredItemsWithQuizzes(
  items: StarredQuestion[],
  quizzes: MyQuiz[]
): StarredQuestion[] {
  if (!Array.isArray(items) || items.length === 0 || !Array.isArray(quizzes) || quizzes.length === 0) {
    return items;
  }
  const index = buildQuizLookupIndex(quizzes);
  let changed = false;
  const next = items.map((item) => {
    if (!item?.question) return item;
    const qq = item.question;
    const pseudoEq: ExamQuestion = {
      id: qq.id || item.id,
      sourceQuizId: item.sourceQuizId || '',
      sourceTitle: item.sourceTitle || '',
      questionType: qq.questionType,
      laws: qq.laws,
      table: qq.table,
      dataTable: qq.dataTable,
      chart: qq.chart,
      figure: qq.figure,
      explanationChart: qq.explanationChart,
      explanationFigure: qq.explanationFigure,
      explanationTable: qq.explanationTable,
      explanationComparison: qq.explanationComparison,
      text: qq.text,
      choices: Array.isArray(qq.choices) ? qq.choices : [],
      correctIndex: Number.isInteger(qq.correctIndex) ? qq.correctIndex : -1,
      explanation: qq.explanation || '',
    };
    const hit = findLatestMatchForExamQuestion(pseudoEq, -1, index);
    if (!hit || !isExamReady(hit.qq)) return item;
    const latestQ = hit.qq;
    const nextQuestion: QuizQuestion = {
      ...latestQ,
      id: qq.id || latestQ.id,
    };
    const nextSourceTitle = hit.quiz?.title || item.sourceTitle;
    if (
      JSON.stringify(nextQuestion) !== JSON.stringify(item.question) ||
      nextSourceTitle !== item.sourceTitle
    ) {
      changed = true;
      return {
        ...item,
        ...(nextSourceTitle ? { sourceTitle: nextSourceTitle } : {}),
        question: nextQuestion,
      };
    }
    return item;
  });
  return changed ? next : items;
}

/**
 * يُحدّث محاولات الاختبارات السابقة ونتائجها تلقائياً عند تعديل أي سؤال أو تصحيح إجابته
 * (سواء في المحرر المرئي أو بصيغة JSON، للاختبارات الأساسية أو اختبارات التقوية).
 */
export function reconcileAttemptsWithQuizzes(
  attempts: QuizAttempt[],
  quizzes: MyQuiz[]
): QuizAttempt[] {
  if (!Array.isArray(attempts) || attempts.length === 0) return attempts;
  if (!Array.isArray(quizzes) || quizzes.length === 0) return attempts;

  const index = buildQuizLookupIndex(quizzes);
  let anyAttemptChanged = false;

  const reconciled = attempts.map((attempt) => {
    if (!attempt || typeof attempt !== 'object') return attempt;
    const prevQuestions = Array.isArray(attempt.questions) ? attempt.questions : [];
    const prevAnswers = Array.isArray(attempt.answers) ? attempt.answers : [];
    if (prevQuestions.length === 0) return attempt;

    let modified = false;
    const shuffleChoices = Boolean(attempt.settings?.shuffleChoices);
    const allowSingleQuizPositionalFallback =
      attempt.settings?.sourceMode === 'single' &&
      !attempt.settings?.shuffleQuestions &&
      !attempt.settings?.mistakeReviewMode;
    const nextAnswers = prevAnswers.slice();

    const nextQuestions = prevQuestions.map((eq, idx) => {
      if (!eq || typeof eq !== 'object') return eq;

      const hit = findLatestMatchForExamQuestion(eq, idx, index, {
        allowSingleQuizPositionalFallback,
        totalQuestions: prevQuestions.length,
      });
      const latestQ = hit?.qq;
      if (!latestQ || !isExamReady(latestQ)) return eq;

      const isTable = latestQ.questionType === 'table' || Boolean(latestQ.table && latestQ.choices.length === 0);
      let nextQ: ExamQuestion;

      if (isTable) {
        nextQ = buildUpdatedExamQuestion(eq, latestQ, [], -1, hit?.quiz?.title);
        const rawTableAns = attempt.tableAnswers?.[eq.id] || attempt.tableAnswers?.[String(idx)];
        if (latestQ.table && rawTableAns && Object.keys(rawTableAns).length > 0) {
          const g = gradeTableQuestion(latestQ.table, rawTableAns);
          const regraded = g.answeredBlanks === 0 ? -1 : g.isAllCorrect ? 1 : 0;
          if (nextAnswers[idx] !== regraded) {
            nextAnswers[idx] = regraded;
            modified = true;
          }
        }
      } else {
        const oldAns = Number.isInteger(prevAnswers[idx]) ? prevAnswers[idx] : -1;
        const mcq = reconcileMcqChoicesAndAnswer(eq, latestQ, oldAns, shuffleChoices);
        nextQ = buildUpdatedExamQuestion(eq, latestQ, mcq.choices, mcq.correctIndex, hit?.quiz?.title);
        if (nextAnswers[idx] !== mcq.nextAnswer) {
          nextAnswers[idx] = mcq.nextAnswer;
          modified = true;
        }
      }

      if (examQuestionsDiffer(nextQ, eq)) {
        modified = true;
        return nextQ;
      }
      return eq;
    });

    let nextTitle = attempt.title;
    if (
      attempt.settings?.sourceMode === 'single' &&
      !attempt.settings?.mistakeReviewMode &&
      Array.isArray(attempt.settings.quizIds) &&
      attempt.settings.quizIds.length === 1
    ) {
      const matchedQuiz = index.byQuizId.get(attempt.settings.quizIds[0])?.quiz;
      if (matchedQuiz?.title && matchedQuiz.title !== attempt.title) {
        nextTitle = matchedQuiz.title;
        modified = true;
      }
    }

    const nextScore = scoreExam(nextQuestions, nextAnswers, attempt.tableAnswers);
    if (!modified && nextScore === attempt.score) {
      return attempt;
    }

    anyAttemptChanged = true;
    return {
      ...attempt,
      title: nextTitle,
      questions: nextQuestions,
      answers: nextAnswers,
      score: nextScore,
    };
  });

  return anyAttemptChanged ? reconciled : attempts;
}

export function defaultExamTitle(settings: ExamSettings): string {
  const titles = Array.isArray(settings?.quizTitles) ? settings.quizTitles : [];
  const base =
    settings?.sourceMode === 'single' || titles.length === 1
      ? titles[0] || 'اختبار'
      : `مزيج من ${titles.length} نماذج`;
  if (settings?.mistakeReviewMode && !base.startsWith('تصحيح أخطاء')) {
    return `تصحيح أخطاء: ${base}`;
  }
  return base;
}

export function formatDuration(totalSec: number): string {
  const raw = Number(totalSec);
  const s = Math.max(0, Math.round(Number.isFinite(raw) ? raw : 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function describeTiming(
  s: Partial<Pick<ExamSettings, 'timing' | 'seconds'>> | null | undefined
): string {
  if (!s || typeof s !== 'object' || !s.timing || s.timing === 'none') return 'بدون وقت';
  const secs = Math.max(0, Number(s.seconds) || 0);
  if (s.timing === 'perQuestion') return `${secs} ثانية لكل سؤال`;
  return `${Math.max(1, Math.round(secs / 60))} دقيقة للاختبار كاملاً`;
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
