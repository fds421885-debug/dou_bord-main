import type { ExamQuestion, MyQuiz, QuizAttempt, QuizQuestion } from './types';
import { unwrapRowArray } from './quizTable';

function asSafeText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return '';
}

function normalizeText(raw: unknown): string {
  return asSafeText(raw).replace(/\s+/g, ' ').trim().toLowerCase();
}

function fnv1aHex(input: string, seed = 0x811c9dc5): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * بصمة حتمية موحدة للسؤال تتجاهل اختلاف ترتيب الخيارات أو تغيّر معرف النموذج،
 * مما يتيح مطابقة السؤال نفسه في المحاولات اللاحقة واختبارات المساعد الذكي.
 */
export function computeQuestionFingerprint(
  q: Pick<ExamQuestion | QuizQuestion, 'text' | 'questionType' | 'choices' | 'table' | 'dataTable'> | null | undefined
): string {
  if (!q || typeof q !== 'object') {
    return 'err_invalid';
  }
  const normText = normalizeText((q as { text?: unknown }).text);
  const isTable = q.questionType === 'table' || Boolean(q.table);

  let detail = '';
  if (isTable && q.table && typeof q.table === 'object') {
    const headers = (Array.isArray(q.table.headers) ? q.table.headers : []).map(normalizeText).join('|');
    const rawRows = Array.isArray(q.table.rows) ? q.table.rows : [];
    const rows = rawRows
      .map((r) =>
        unwrapRowArray(r)
          .map((c) => {
            if (!c || typeof c !== 'object') return normalizeText(c);
            const cell = c as {
              isBlank?: unknown;
              expectedAnswer?: unknown;
              cue?: unknown;
              value?: unknown;
            };
            return cell.isBlank
              ? `_${normalizeText(cell.expectedAnswer || cell.cue || '')}`
              : normalizeText(cell.value);
          })
          .join(',')
      )
      .join(';');
    detail = `tbl::${headers}::${rows}`;
  } else {
    const choices = (Array.isArray(q.choices) ? q.choices : [])
      .map(normalizeText)
      .filter(Boolean)
      .sort()
      .join('|');
    detail = `mcq::${choices}`;
  }

  let dataSig = '';
  if (q.dataTable && typeof q.dataTable === 'object') {
    const dtHeaders = (Array.isArray(q.dataTable.headers) ? q.dataTable.headers : []).map(normalizeText).join('|');
    const dtRows = (Array.isArray(q.dataTable.rows) ? q.dataTable.rows : [])
      .map((r) => unwrapRowArray(r).map(normalizeText).join(','))
      .join(';');
    dataSig = `##dt::${dtHeaders}::${dtRows}`;
  }

  const base = `${normText}##${detail}${dataSig}`;
  return `err_${fnv1aHex(base, 0x811c9dc5)}${fnv1aHex(base.split('').reverse().join(''), 0x9e3779b9)}`;
}

export function isMistakeReviewAttempt(
  attempt: Pick<QuizAttempt, 'settings'>
): boolean {
  return (
    attempt.settings?.mistakeReviewMode === true ||
    Boolean(attempt.settings?.quizIds?.includes('coach_mistakes_review'))
  );
}

export interface UnresolvedMistakeItem {
  fp: string;
  question: QuizQuestion;
  sourceQuizId: string;
  sourceTitle: string;
  sectionKey: string;
  sectionTitle: string;
  chosenAnswerText: string;
  correctAnswerText: string;
  mistakeCount: number;
  firstMissedAt: number;
  lastMissedAt: number;
}

interface OpenMistakeSlot {
  fp: string;
  attemptId: string;
  finishedAt: number;
  sectionKey: string;
  sectionTitle: string;
  quizRowKey: string;
  typeKind: 'mcq' | 'table';
  hasLaws: boolean;
}

export interface MistakeLedgerSummary {
  totalQuestions: number;
  correctAnswers: number;
  wrongAnswers: number;
  skippedAnswers: number;
  rawTotalQuestions: number;
  rawCorrectAnswers: number;
  correctedMistakesCount: number;
  unresolvedMistakes: UnresolvedMistakeItem[];
  redeemedByQuizRowKey: Record<string, number>;
  redeemedBySectionKey: Record<string, number>;
  redeemedMcqCount: number;
  redeemedTableCount: number;
  redeemedWithLawsCount: number;
}

function examQuestionToQuizQuestion(eq: ExamQuestion, fp: string): QuizQuestion {
  const safeChoices = Array.isArray(eq.choices) ? eq.choices.map((c) => asSafeText(c)) : [];
  const safeCorrectIdx = Number.isInteger(eq.correctIndex) ? eq.correctIndex : -1;
  const isTable = eq.questionType === 'table' || Boolean(eq.table && safeChoices.length === 0);
  const answer = isTable
    ? 'إكمال الجدول الصحيح'
    : safeCorrectIdx >= 0 && safeChoices[safeCorrectIdx]
    ? safeChoices[safeCorrectIdx]
    : '';
  return {
    id: `m_${fp}_${Math.random().toString(36).slice(2, 6)}`.slice(0, 64),
    ...(isTable ? { questionType: 'table' as const } : { questionType: 'mcq' as const }),
    text: asSafeText((eq as { text?: unknown }).text),
    choices: isTable ? [] : safeChoices,
    correctIndex: isTable ? -1 : safeCorrectIdx,
    answer,
    explanation: asSafeText((eq as { explanation?: unknown }).explanation),
    ...(Array.isArray(eq.laws) && eq.laws.length > 0 ? { laws: eq.laws.slice() } : {}),
    ...(eq.table ? { table: eq.table } : {}),
    ...(eq.dataTable ? { dataTable: eq.dataTable } : {}),
    ...(eq.chart ? { chart: eq.chart } : {}),
    ...(eq.figure ? { figure: eq.figure } : {}),
    ...(eq.explanationChart ? { explanationChart: eq.explanationChart } : {}),
    ...(eq.explanationFigure ? { explanationFigure: eq.explanationFigure } : {}),
    ...(eq.explanationTable ? { explanationTable: eq.explanationTable } : {}),
    ...(eq.explanationComparison ? { explanationComparison: eq.explanationComparison } : {}),
    redeemsFingerprint: fp,
  };
}

/**
 * سجل الأخطاء الزمني: يتتبع كل سؤال أخطأت فيه في اختباراتك الذاتية،
 * وعند حله بشكل صحيح لاحقاً (سواء في مراجعة الأخطاء أو عبر المساعد الذكي أو محاولة عادية)
 * يُزال من الأخطاء المعلقة ويُنقص من عدد الأخطاء ويُحتسب إجابةً صحيحة.
 */
export function computeMistakeLedger(
  attempts: QuizAttempt[],
  quizzes: MyQuiz[] = []
): MistakeLedgerSummary {
  const safeQuizzes = (Array.isArray(quizzes) ? quizzes : []).filter(
    (qz): qz is MyQuiz => Boolean(qz && typeof qz === 'object' && qz.id)
  );
  const safeAttempts = (Array.isArray(attempts) ? attempts : []).filter(
    (a): a is QuizAttempt => Boolean(a && typeof a === 'object')
  );

  const quizById = new Map<string, MyQuiz>();
  for (const qz of safeQuizzes) {
    quizById.set(qz.id, qz);
  }

  const resolveSection = (
    sourceQuizId: string,
    fallbackTitle: unknown
  ): { key: string; title: string } => {
    const qz = quizById.get(sourceQuizId);
    if (qz) {
      if (qz.parentQuizId && quizById.has(qz.parentQuizId)) {
        const parent = quizById.get(qz.parentQuizId)!;
        return { key: parent.id, title: asSafeText(parent.title) || 'قسم عام' };
      }
      if (!qz.parentQuizId && qz.quizKind !== 'drill') {
        return { key: qz.id, title: asSafeText(qz.title) || 'قسم عام' };
      }
    }
    const clean = asSafeText(fallbackTitle).trim() || 'قسم عام';
    return { key: sourceQuizId || `title:${clean}`, title: clean };
  };

  const sortedAsc = safeAttempts
    .slice()
    .sort((a, b) => (Number(a.finishedAt) || 0) - (Number(b.finishedAt) || 0));

  const openByFp = new Map<
    string,
    { item: UnresolvedMistakeItem; slots: OpenMistakeSlot[] }
  >();
  const redeemedOnceFps = new Set<string>();

  let totalQuestions = 0;
  let correctAnswers = 0;
  let wrongAnswers = 0;
  let skippedAnswers = 0;
  let rawTotalQuestions = 0;
  let rawCorrectAnswers = 0;
  let correctedMistakesCount = 0;

  const redeemedByQuizRowKey: Record<string, number> = {};
  const redeemedBySectionKey: Record<string, number> = {};
  let redeemedMcqCount = 0;
  let redeemedTableCount = 0;
  let redeemedWithLawsCount = 0;

  const redeemFp = (fp: string): number => {
    const entry = openByFp.get(fp);
    if (!entry) return 0;
    const count = entry.slots.length;
    correctedMistakesCount += count;
    redeemedOnceFps.add(fp);
    for (const slot of entry.slots) {
      redeemedByQuizRowKey[slot.quizRowKey] = (redeemedByQuizRowKey[slot.quizRowKey] || 0) + 1;
      redeemedBySectionKey[slot.sectionKey] = (redeemedBySectionKey[slot.sectionKey] || 0) + 1;
      if (slot.typeKind === 'table') redeemedTableCount += 1;
      else redeemedMcqCount += 1;
      if (slot.hasLaws) redeemedWithLawsCount += 1;
    }
    openByFp.delete(fp);
    return count;
  };

  for (const att of sortedAsc) {
    const attQuestions = Array.isArray(att.questions) ? att.questions : [];
    const isReview = isMistakeReviewAttempt(att);
    const quizIds = Array.isArray(att.settings?.quizIds) ? att.settings.quizIds : [];
    const quizRowKey =
      quizIds.length === 1
        ? `q:${quizIds[0]}`
        : `t:${(asSafeText(att.title) || 'اختبار').trim()}`;

    if (attQuestions.length === 0) {
      const t = Math.max(0, Number(att.total) || 0);
      const c = Math.max(0, Math.min(t, Number(att.score) || 0));
      rawTotalQuestions += t;
      rawCorrectAnswers += c;
      totalQuestions += t;
      correctAnswers += c;
      wrongAnswers += Math.max(0, t - c);
      continue;
    }

    for (let qi = 0; qi < attQuestions.length; qi++) {
      const eq = attQuestions[qi];
      if (!eq || typeof eq !== 'object') continue;
      const ans = Array.isArray(att.answers) ? att.answers[qi] : -1;
      const safeChoices = Array.isArray(eq.choices) ? eq.choices : [];
      const isTable = eq.questionType === 'table' || Boolean(eq.table && safeChoices.length === 0);
      const isSkipped = ans === -1 || ans === undefined || ans === null;
      const isCorrect = isTable
        ? ans === 1
        : typeof ans === 'number' && Number.isInteger(ans) && ans >= 0 && ans === eq.correctIndex;

      const naturalFp = computeQuestionFingerprint(eq);
      const taggedFp = typeof eq.redeemsFingerprint === 'string' ? eq.redeemsFingerprint.trim() : '';
      const matchedOpenFp =
        taggedFp && openByFp.has(taggedFp)
          ? taggedFp
          : openByFp.has(naturalFp)
          ? naturalFp
          : '';

      const sec = resolveSection(asSafeText(eq.sourceQuizId), asSafeText(eq.sourceTitle) || asSafeText(att.title));
      const hasLaws = Array.isArray(eq.laws) && eq.laws.length > 0;
      const finishedAt = Number(att.finishedAt) || Date.now();

      const rawChosen =
        typeof ans === 'number' && Number.isInteger(ans) && ans >= 0 && ans < safeChoices.length
          ? asSafeText(safeChoices[ans])
          : '';
      const chosenAnswerText = isTable
        ? ans === -1
          ? 'لم يُكمل الجدول'
          : 'إجابة جدول غير صحيحة'
        : rawChosen || 'تم تخطي السؤال';

      const rawCorrect =
        Number.isInteger(eq.correctIndex) && eq.correctIndex >= 0 && eq.correctIndex < safeChoices.length
          ? asSafeText(safeChoices[eq.correctIndex])
          : '';
      const correctAnswerText = isTable
        ? 'إكمال الجدول الصحيح'
        : rawCorrect || asSafeText((eq as { explanation?: unknown }).explanation).slice(0, 100);

      if (isReview) {
        if (matchedOpenFp) {
          if (isCorrect) {
            const count = redeemFp(matchedOpenFp);
            correctAnswers += count;
            wrongAnswers = Math.max(0, wrongAnswers - count);
          } else {
            const existing = openByFp.get(matchedOpenFp)!;
            existing.item.mistakeCount += 1;
            existing.item.lastMissedAt = finishedAt;
            existing.item.chosenAnswerText = chosenAnswerText.slice(0, 120);
          }
        } else {
          const alreadyRedeemed =
            (taggedFp && redeemedOnceFps.has(taggedFp)) || redeemedOnceFps.has(naturalFp);
          if (!alreadyRedeemed) {
            // يحدث مثلاً عند تطبيق فلتر زمني (آخر 7 أيام) بينما الخطأ الأصلي أقدم من 7 أيام
            totalQuestions += 1;
            if (isSkipped) skippedAnswers += 1;
            if (isCorrect) {
              correctAnswers += 1;
            } else {
              wrongAnswers += 1;
            }
          }
        }
        continue;
      }

      // محاولة عادية أو اختبار تقوية/دردشة
      rawTotalQuestions += 1;
      totalQuestions += 1;
      if (isSkipped) skippedAnswers += 1;

      if (isCorrect) {
        rawCorrectAnswers += 1;
        correctAnswers += 1;
        if (matchedOpenFp) {
          const count = redeemFp(matchedOpenFp);
          correctAnswers += count;
          wrongAnswers = Math.max(0, wrongAnswers - count);
        }
      } else {
        wrongAnswers += 1;
        const storeFp = naturalFp;
        const slot: OpenMistakeSlot = {
          fp: storeFp,
          attemptId: att.id,
          finishedAt,
          sectionKey: sec.key,
          sectionTitle: sec.title,
          quizRowKey,
          typeKind: isTable ? 'table' : 'mcq',
          hasLaws,
        };
        const existing = openByFp.get(storeFp);
        if (existing) {
          existing.slots.push(slot);
          existing.item.mistakeCount += 1;
          existing.item.lastMissedAt = finishedAt;
          existing.item.chosenAnswerText = chosenAnswerText.slice(0, 120);
        } else {
          openByFp.set(storeFp, {
            item: {
              fp: storeFp,
              question: examQuestionToQuizQuestion(eq, storeFp),
              sourceQuizId: eq.sourceQuizId || '',
              sourceTitle: eq.sourceTitle || att.title || 'اختبار سابق',
              sectionKey: sec.key,
              sectionTitle: sec.title,
              chosenAnswerText: chosenAnswerText.slice(0, 120),
              correctAnswerText: correctAnswerText.slice(0, 120),
              mistakeCount: 1,
              firstMissedAt: finishedAt,
              lastMissedAt: finishedAt,
            },
            slots: [slot],
          });
        }
      }
    }
  }

  // ضمان الاتساق التام: الصحيحة + الخاطئة = الإجمالي
  wrongAnswers = Math.max(0, Math.min(totalQuestions, wrongAnswers));
  correctAnswers = Math.max(0, totalQuestions - wrongAnswers);

  const unresolvedMistakes = Array.from(openByFp.values())
    .map((e) => e.item)
    .sort((a, b) => b.mistakeCount - a.mistakeCount || b.lastMissedAt - a.lastMissedAt);

  return {
    totalQuestions,
    correctAnswers,
    wrongAnswers,
    skippedAnswers,
    rawTotalQuestions,
    rawCorrectAnswers,
    correctedMistakesCount,
    unresolvedMistakes,
    redeemedByQuizRowKey,
    redeemedBySectionKey,
    redeemedMcqCount,
    redeemedTableCount,
    redeemedWithLawsCount,
  };
}

export const OTHER_MISTAKES_QUIZ_ID = '__other_mistakes__';

export function matchUnresolvedMistakesForQuiz(
  quiz: MyQuiz | null | undefined,
  unresolvedMistakes: UnresolvedMistakeItem[]
): UnresolvedMistakeItem[] {
  if (!quiz || typeof quiz !== 'object' || !Array.isArray(unresolvedMistakes) || unresolvedMistakes.length === 0) {
    return [];
  }
  const fpSet = new Set<string>();
  const qs = Array.isArray(quiz.questions) ? quiz.questions : [];
  for (const qq of qs) {
    if (qq && typeof qq === 'object' && asSafeText((qq as { text?: unknown }).text).trim()) {
      fpSet.add(computeQuestionFingerprint(qq));
    }
  }
  return unresolvedMistakes.filter(
    (m) => m && (m.sourceQuizId === quiz.id || fpSet.has(m.fp))
  );
}

export function groupUnresolvedMistakesByQuiz(
  quizzes: MyQuiz[],
  unresolvedMistakes: UnresolvedMistakeItem[]
): {
  byQuizId: Record<string, UnresolvedMistakeItem[]>;
  otherMistakes: UnresolvedMistakeItem[];
} {
  const byQuizId: Record<string, UnresolvedMistakeItem[]> = {};
  const claimedFps = new Set<string>();
  const safeQuizzes = Array.isArray(quizzes) ? quizzes : [];
  const safeMistakes = Array.isArray(unresolvedMistakes) ? unresolvedMistakes : [];

  for (const qz of safeQuizzes) {
    if (!qz || typeof qz !== 'object' || !qz.id) continue;
    const matched = matchUnresolvedMistakesForQuiz(qz, safeMistakes);
    byQuizId[qz.id] = matched;
    for (const m of matched) {
      claimedFps.add(m.fp);
    }
  }

  const otherMistakes = safeMistakes.filter((m) => m && !claimedFps.has(m.fp));
  return { byQuizId, otherMistakes };
}
