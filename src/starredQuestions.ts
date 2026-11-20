import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from './firestoreTracked';
import { activeProjectId, db } from './firebase';
import { loadSessionSnapshot, saveSessionSnapshot, type StoredStarredQuestionsSnapshot } from './localDraftStore';
import { sanitizeChart } from './quizChart';
import { sanitizeFigure } from './quizFigure';
import { sanitizeExplanationComparison, sanitizeExplanationTable, sanitizeTableQuestion } from './quizTable';
import type { ExamQuestion, QuizQuestion, StarredQuestion } from './types';

export interface RulesUpdateNotice {
  projectId: string;
}

const rulesUpdateListeners = new Set<(info: RulesUpdateNotice) => void>();

function notifyRulesUpdateNeeded(projectId: string = activeProjectId): void {
  const payload: RulesUpdateNotice = { projectId };
  rulesUpdateListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch {
      // Ignore subscriber error
    }
  });
}

export function subscribeRulesUpdateNeeded(
  cb: (info: RulesUpdateNotice) => void
): () => void {
  rulesUpdateListeners.add(cb);
  return () => {
    rulesUpdateListeners.delete(cb);
  };
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9df5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function computeStarredQuestionId(q: Pick<QuizQuestion | ExamQuestion, 'text' | 'choices' | 'table'>): string {
  const signature = JSON.stringify({
    t: (q.text || '').trim().slice(0, 300),
    c: Array.isArray(q.choices) ? q.choices.slice(0, 4).map((x) => x.trim().slice(0, 80)) : [],
    tb: q.table?.rows ? q.table.rows.length : 0,
  });
  return `star_${fnv1aHex(signature)}`;
}

export function cleanQuizQuestionForStar(raw: QuizQuestion | ExamQuestion): QuizQuestion {
  const questionType = raw.questionType === 'table' || raw.table ? 'table' : 'mcq';
  const table = raw.table ? sanitizeTableQuestion(raw.table) : null;
  const chart = raw.chart ? sanitizeChart(raw.chart) : null;
  const figure = raw.figure ? sanitizeFigure(raw.figure) : null;
  const explanationChart = raw.explanationChart ? sanitizeChart(raw.explanationChart) : null;
  const explanationFigure = raw.explanationFigure ? sanitizeFigure(raw.explanationFigure) : null;
  const explanationTable = raw.explanationTable ? sanitizeExplanationTable(raw.explanationTable) : null;
  const explanationComparison = raw.explanationComparison
    ? sanitizeExplanationComparison(raw.explanationComparison)
    : null;

  return {
    id: String(raw.id || computeStarredQuestionId(raw)).slice(0, 120),
    ...(questionType === 'table' ? { questionType: 'table' as const } : {}),
    text: String(raw.text || '').slice(0, 2000),
    choices: Array.isArray(raw.choices) ? raw.choices.map((c) => String(c).slice(0, 500)).slice(0, 8) : [],
    correctIndex: Number.isInteger(raw.correctIndex) ? raw.correctIndex : -1,
    answer:
      'answer' in raw && typeof raw.answer === 'string'
        ? raw.answer.slice(0, 1000)
        : Array.isArray(raw.choices) && raw.correctIndex >= 0 && raw.choices[raw.correctIndex]
        ? String(raw.choices[raw.correctIndex]).slice(0, 1000)
        : '',
    explanation: String(raw.explanation || '').slice(0, 2000),
    ...(table ? { table } : {}),
    ...(chart ? { chart } : {}),
    ...(figure ? { figure } : {}),
    ...(explanationChart ? { explanationChart } : {}),
    ...(explanationFigure ? { explanationFigure } : {}),
    ...(explanationTable ? { explanationTable } : {}),
    ...(explanationComparison ? { explanationComparison } : {}),
  };
}

export async function loadLocalStarredQuestions(ownerId: string): Promise<StarredQuestion[]> {
  const snap = await loadSessionSnapshot<StoredStarredQuestionsSnapshot>('starred_questions');
  if (!snap || snap.ownerId !== ownerId || !Array.isArray(snap.items)) return [];
  return snap.items;
}

export async function saveLocalStarredQuestions(ownerId: string, items: StarredQuestion[]): Promise<void> {
  await saveSessionSnapshot({
    key: 'starred_questions',
    ownerId,
    items: items.slice(0, 300),
    updatedAt: Date.now(),
  });
}

export async function toggleStarredQuestion(params: {
  ownerId: string;
  question: QuizQuestion | ExamQuestion;
  currentlyStarred: boolean;
  sourceQuizId?: string;
  sourceTitle?: string;
}): Promise<{ starred: boolean; id: string; rulesNeedsUpdate: boolean }> {
  const { ownerId, question, currentlyStarred, sourceQuizId, sourceTitle } = params;
  const id = computeStarredQuestionId(question);
  const existingLocal = await loadLocalStarredQuestions(ownerId);

  if (currentlyStarred) {
    const nextLocal = existingLocal.filter((x) => x.id !== id);
    await saveLocalStarredQuestions(ownerId, nextLocal);
    try {
      await deleteDoc(doc(db, 'users', ownerId, 'starredQuestions', id));
      return { starred: false, id, rulesNeedsUpdate: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const rulesNeedsUpdate = /permission-denied|permission_denied/i.test(msg);
      if (rulesNeedsUpdate) notifyRulesUpdateNeeded();
      return {
        starred: false,
        id,
        rulesNeedsUpdate,
      };
    }
  }

  const cleanedQuestion = cleanQuizQuestionForStar(question);
  const resolvedSourceQuizId =
    (sourceQuizId ?? ('sourceQuizId' in question ? question.sourceQuizId : '') ?? '').slice(0, 120);
  const resolvedSourceTitle =
    (sourceTitle ?? ('sourceTitle' in question ? question.sourceTitle : '') ?? '').slice(0, 160);
  const starredAt = Date.now();

  const item: StarredQuestion = {
    id,
    ownerId,
    ...(resolvedSourceQuizId ? { sourceQuizId: resolvedSourceQuizId } : {}),
    ...(resolvedSourceTitle ? { sourceTitle: resolvedSourceTitle } : {}),
    question: cleanedQuestion,
    starredAt,
  };

  const deduped = [item, ...existingLocal.filter((x) => x.id !== id)];
  await saveLocalStarredQuestions(ownerId, deduped);

  try {
    await setDoc(doc(db, 'users', ownerId, 'starredQuestions', id), {
      ...item,
      createdAt: serverTimestamp(),
    });
    return { starred: true, id, rulesNeedsUpdate: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const rulesNeedsUpdate = /permission-denied|permission_denied/i.test(msg);
    if (rulesNeedsUpdate) notifyRulesUpdateNeeded();
    return {
      starred: true,
      id,
      rulesNeedsUpdate,
    };
  }
}

export async function removeStarredQuestion(
  ownerId: string,
  starredId: string
): Promise<{ rulesNeedsUpdate: boolean }> {
  const existingLocal = await loadLocalStarredQuestions(ownerId);
  await saveLocalStarredQuestions(
    ownerId,
    existingLocal.filter((x) => x.id !== starredId)
  );
  try {
    await deleteDoc(doc(db, 'users', ownerId, 'starredQuestions', starredId));
    return { rulesNeedsUpdate: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const rulesNeedsUpdate = /permission-denied|permission_denied/i.test(msg);
    if (rulesNeedsUpdate) notifyRulesUpdateNeeded();
    return { rulesNeedsUpdate };
  }
}

export function subscribeStarredQuestions(
  ownerId: string,
  onItems: (items: StarredQuestion[]) => void,
  onRulesDenied?: () => void
): () => void {
  let alive = true;
  let localCache: StarredQuestion[] = [];

  void loadLocalStarredQuestions(ownerId).then((items) => {
    if (!alive) return;
    localCache = items;
    if (items.length > 0) onItems(items);
  });

  const q = query(collection(db, 'users', ownerId, 'starredQuestions'), where('ownerId', '==', ownerId));
  const unsub = onSnapshot(
    q,
    (snap) => {
      if (!alive) return;
      const remote: StarredQuestion[] = [];
      snap.forEach((d) => remote.push(d.data() as StarredQuestion));
      remote.sort((a, b) => (b.starredAt || 0) - (a.starredAt || 0));

      // Keep any local items if Firestore returned empty only when offline cache had unsynced entries?
      // Normally remote is authoritative when rules permit.
      onItems(remote);
      void saveLocalStarredQuestions(ownerId, remote);
    },
    (err) => {
      if (!alive) return;
      const msg = String(err?.message || '');
      if (/permission/i.test(msg)) {
        notifyRulesUpdateNeeded();
        onRulesDenied?.();
      }
      if (localCache.length > 0) onItems(localCache);
    }
  );

  return () => {
    alive = false;
    unsub();
  };
}
