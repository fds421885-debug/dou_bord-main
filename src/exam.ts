import { deleteDoc, doc, serverTimestamp, setDoc } from './firestoreTracked';
import { db, handleFirestoreError, OperationType } from './firebase';
import type { ExamQuestion, ExamSettings, MyQuiz, QuizAttempt, QuizQuestion } from './types';
import { sanitizeChart } from './quizChart';
import { sanitizeFigure } from './quizFigure';

export const EXAM_MAX_QUESTIONS = 100;

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

/** السؤال صالح للاختبار: خياران على الأقل وإجابة صحيحة محددة. */
export function isExamReady(q: QuizQuestion): boolean {
  return (
    q.choices.length >= 2 &&
    q.correctIndex >= 0 &&
    q.correctIndex < q.choices.length &&
    q.choices.every((c) => c.trim().length > 0) &&
    q.text.trim().length > 0
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
  let choices = q.choices.slice();
  let correctIndex = q.correctIndex;
  if (shuffleChoices) {
    const order = shuffle(choices.map((_, i) => i));
    choices = order.map((i) => q.choices[i]);
    correctIndex = order.indexOf(q.correctIndex);
  }
  const chart = q.chart ? sanitizeChart(q.chart) : null;
  const figure = q.figure ? sanitizeFigure(q.figure) : null;
  const explanationChart = q.explanationChart ? sanitizeChart(q.explanationChart) : null;
  const explanationFigure = q.explanationFigure ? sanitizeFigure(q.explanationFigure) : null;
  return {
    id: `${quiz.id}:${q.id}`.slice(0, 120),
    sourceQuizId: quiz.id,
    sourceTitle: quiz.title,
    text: q.text,
    choices,
    correctIndex,
    explanation: q.explanation || '',
    ...(chart ? { chart } : {}),
    ...(figure ? { figure } : {}),
    ...(explanationChart ? { explanationChart } : {}),
    ...(explanationFigure ? { explanationFigure } : {}),
  };
}

/** يبني قائمة أسئلة الاختبار حسب الإعدادات (مزج وتنويع وعدد). */
export function buildExam(quizzes: MyQuiz[], settings: ExamSettings): ExamQuestion[] {
  const chosen = settings.quizIds
    .map((id) => quizzes.find((q) => q.id === id))
    .filter((q): q is MyQuiz => !!q && validPool(q).length > 0);
  if (chosen.length === 0) return [];

  type Item = { q: QuizQuestion; quiz: MyQuiz; order: number };
  let picked: Item[] = [];

  if (settings.sourceMode === 'single' || chosen.length === 1) {
    const quiz = chosen[0];
    const pool = validPool(quiz).map((q, order) => ({ q, quiz, order }));
    const n = Math.max(1, Math.min(settings.questionCount, pool.length, EXAM_MAX_QUESTIONS));
    picked = n < pool.length ? shuffle(pool).slice(0, n).sort((a, b) => a.order - b.order) : pool;
  } else if (settings.mixMode === 'onePerQuiz') {
    picked = chosen.map((quiz) => {
      const pool = validPool(quiz);
      const idx = Math.floor(Math.random() * pool.length);
      return { q: pool[idx], quiz, order: 0 };
    });
  } else {
    // عدد محدد موزّع بالتساوي على النماذج (دوران): تنوع قدر الإمكان
    const pools = chosen.map((quiz) => ({
      quiz,
      items: shuffle(validPool(quiz).map((q, order) => ({ q, quiz, order }))),
    }));
    const n = Math.max(1, Math.min(settings.questionCount, EXAM_MAX_QUESTIONS));
    let guard = 0;
    while (picked.length < n && guard < 10000) {
      guard++;
      let took = false;
      for (const p of pools) {
        if (picked.length >= n) break;
        const next = p.items.pop();
        if (next) {
          picked.push(next);
          took = true;
        }
      }
      if (!took) break;
    }
  }

  const ordered = settings.shuffleQuestions ? shuffle(picked) : picked;
  return ordered.slice(0, EXAM_MAX_QUESTIONS).map((it) => toExamQuestion(it.q, it.quiz, settings.shuffleChoices));
}

export function scoreExam(questions: ExamQuestion[], answers: number[]): number {
  return questions.reduce((n, q, i) => n + (answers[i] === q.correctIndex ? 1 : 0), 0);
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
  finishedAt: number
): Omit<QuizAttempt, 'createdAt'> {
  return {
    id,
    ownerId,
    title: defaultExamTitle(settings).slice(0, 200),
    settings,
    questions,
    answers: questions.map((_, i) => (Number.isInteger(answers[i]) ? answers[i] : -1)),
    score: scoreExam(questions, answers),
    total: questions.length,
    durationSec: Math.max(0, Math.round(durationSec)),
    finishedAt,
  };
}

export async function saveAttempt(attempt: Omit<QuizAttempt, 'createdAt'>): Promise<void> {
  const path = `users/${attempt.ownerId}/quizAttempts/${attempt.id}`;
  try {
    await setDoc(doc(db, 'users', attempt.ownerId, 'quizAttempts', attempt.id), {
      ...attempt,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
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
