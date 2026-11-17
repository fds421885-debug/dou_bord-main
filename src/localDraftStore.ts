import type { AiSolution } from './aiClient';
import type {
  ExplainLayer,
  MyQuiz,
  QuizChart,
  QuizFigure,
  QuizQuestion,
  QuizAttempt,
  ExamSettings,
  ExamQuestion,
  InteractiveSlide,
  Participant,
  Question,
  Room,
  SavedQuestion,
  SavedTest,
  SharedExplainBoard,
  SlideLayer,
  Stroke,
  StudentBoard,
} from './types';

export interface StoredPdfDoc {
  id: string;
  fileName: string;
  pages: string[];
  selectedPage: number;
}

export interface StoredQuizAnswerMeta {
  choices: string[];
  correctIndex: number;
  answer: string;
  explanation: string;
  chart?: QuizChart;
  figure?: QuizFigure;
  explanationChart?: QuizChart;
  explanationFigure?: QuizFigure;
  sourceQuizTitle?: string;
}

export interface StoredQuizDraft {
  key: string;
  composerTab: 'text' | 'board' | 'pdf' | 'quizzes';
  draftText: string;
  draftImage: string;
  draftBoardStrokes: Stroke[];
  pdfDocs: StoredPdfDoc[];
  activePdfId: string | null;
  draftTimerSeconds?: number;
  draftAiSolution?: AiSolution | null;
  activeAiCache?: Record<string, AiSolution>;
  quizAnswerCache?: Record<string, StoredQuizAnswerMeta>;
  updatedAt: number;
}

export interface StoredUserProfileSnapshot {
  key: 'user_profile';
  uid: string;
  fullNameQuad: string;
  email: string;
  updatedAt: number;
}

export interface StoredSavedTestsSnapshot {
  key: 'saved_tests';
  ownerId: string;
  tests: SavedTest[];
  questionsByTestId: Record<string, SavedQuestion[]>;
  updatedAt: number;
}

export interface StoredRoomSnapshot {
  key: 'active_room';
  room: Room;
  participants: Participant[];
  questions: Question[];
  slides: InteractiveSlide[];
  explainLayers: ExplainLayer[];
  slideLayers: SlideLayer[];
  sharedBoard: SharedExplainBoard | null;
  boards: StudentBoard[];
  myRole: 'supervisor' | 'student';
  updatedAt: number;
}

export interface StoredMyQuizzesSnapshot {
  key: 'my_quizzes';
  ownerId: string;
  quizzes: MyQuiz[];
  updatedAt: number;
}

export interface StoredMyQuizDraft {
  key: 'my_quiz_draft';
  ownerId: string;
  editingId: string | null;
  title: string;
  questions: QuizQuestion[];
  updatedAt: number;
}

export interface StoredQuizAttemptsSnapshot {
  key: 'quiz_attempts';
  ownerId: string;
  attempts: QuizAttempt[];
  updatedAt: number;
}

/** اختبار جارٍ (أو منتهٍ ولم تُحفظ نتيجته بعد) — يُستكمل من حيث توقف */
export interface StoredExamSession {
  key: 'exam_session';
  ownerId: string;
  settings: ExamSettings;
  questions: ExamQuestion[];
  answers: number[];
  index: number;
  /** الوقت المتبقي بالملي ثانية (للكلي: كل الاختبار، لكل سؤال: السؤال الحالي) */
  remainingMs: number;
  elapsedMs: number;
  finished: boolean;
  updatedAt: number;
}

export type SessionSnapshotRecord =
  | StoredUserProfileSnapshot
  | StoredSavedTestsSnapshot
  | StoredRoomSnapshot
  | StoredMyQuizzesSnapshot
  | StoredMyQuizDraft
  | StoredQuizAttemptsSnapshot
  | StoredExamSession;

const DB_NAME = 'duoboard_local_store';
const DB_VERSION = 2;
const DRAFT_STORE = 'quiz_drafts';
const SNAPSHOT_STORE = 'session_snapshots';

function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE)) {
        db.createObjectStore(DRAFT_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

export async function loadQuizDraft(key: string): Promise<StoredQuizDraft | null> {
  try {
    const db = await openDraftDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readonly');
      const store = tx.objectStore(DRAFT_STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        resolve((req.result as StoredQuizDraft | undefined) ?? null);
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

export async function saveQuizDraft(draft: StoredQuizDraft): Promise<void> {
  try {
    const db = await openDraftDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readwrite');
      const store = tx.objectStore(DRAFT_STORE);
      store.put(draft);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Ignore storage quota or private-mode errors gracefully
  }
}

export async function loadAllQuizDrafts(): Promise<StoredQuizDraft[]> {
  try {
    const db = await openDraftDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readonly');
      const store = tx.objectStore(DRAFT_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        resolve((req.result as StoredQuizDraft[] | undefined) ?? []);
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return [];
  }
}

export async function loadSessionSnapshot<T extends SessionSnapshotRecord>(
  key: T['key']
): Promise<T | null> {
  try {
    const db = await openDraftDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SNAPSHOT_STORE, 'readonly');
      const store = tx.objectStore(SNAPSHOT_STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        resolve((req.result as T | undefined) ?? null);
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

export async function saveSessionSnapshot(record: SessionSnapshotRecord): Promise<void> {
  try {
    const db = await openDraftDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SNAPSHOT_STORE, 'readwrite');
      const store = tx.objectStore(SNAPSHOT_STORE);
      store.put(record);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Ignore storage quota or private-mode errors gracefully
  }
}

export async function mergeActiveRoomSnapshot(
  roomId: string,
  patch: Partial<Omit<StoredRoomSnapshot, 'key' | 'updatedAt'>> & { room?: Room }
): Promise<void> {
  try {
    const existing = await loadSessionSnapshot<StoredRoomSnapshot>('active_room');
    const sameRoom = existing && existing.room?.id === roomId;
    const baseRoom = patch.room ?? (sameRoom ? existing.room : null);
    if (!baseRoom) return;

    const merged: StoredRoomSnapshot = {
      key: 'active_room',
      room: baseRoom,
      participants: patch.participants ?? (sameRoom ? existing.participants : []),
      questions: patch.questions ?? (sameRoom ? existing.questions : []),
      slides: patch.slides ?? (sameRoom ? existing.slides : []),
      explainLayers: patch.explainLayers ?? (sameRoom ? existing.explainLayers : []),
      slideLayers: patch.slideLayers ?? (sameRoom ? existing.slideLayers : []),
      sharedBoard:
        patch.sharedBoard !== undefined
          ? patch.sharedBoard
          : sameRoom
          ? existing.sharedBoard
          : null,
      boards: patch.boards ?? (sameRoom ? existing.boards : []),
      myRole: patch.myRole ?? (sameRoom ? existing.myRole : 'student'),
      updatedAt: Date.now(),
    };
    await saveSessionSnapshot(merged);
  } catch {
    // Ignore errors gracefully
  }
}

export async function saveSavedTestsListSnapshot(
  ownerId: string,
  tests: SavedTest[],
  extraQuestionsByTestId?: Record<string, SavedQuestion[]>
): Promise<void> {
  try {
    const existing = await loadSessionSnapshot<StoredSavedTestsSnapshot>('saved_tests');
    const prevMap =
      existing && existing.ownerId === ownerId ? existing.questionsByTestId : {};
    await saveSessionSnapshot({
      key: 'saved_tests',
      ownerId,
      tests: tests.slice(0, 30),
      questionsByTestId: {
        ...prevMap,
        ...(extraQuestionsByTestId ?? {}),
      },
      updatedAt: Date.now(),
    });
  } catch {
    // Ignore errors gracefully
  }
}

export async function deleteSessionSnapshot(key: SessionSnapshotRecord['key']): Promise<void> {
  try {
    const db = await openDraftDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SNAPSHOT_STORE, 'readwrite');
      tx.objectStore(SNAPSHOT_STORE).delete(key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Ignore errors gracefully
  }
}

export async function saveMyQuizzesSnapshot(ownerId: string, quizzes: MyQuiz[]): Promise<void> {
  await saveSessionSnapshot({ key: 'my_quizzes', ownerId, quizzes, updatedAt: Date.now() });
}
