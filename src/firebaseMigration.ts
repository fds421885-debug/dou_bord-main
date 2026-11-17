import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { sanitizeChart } from './quizChart';
import { sanitizeFigure } from './quizFigure';
import {
  activateCustomFirebaseConfig,
  activeFirebaseConfig,
  auth as sourceAuth,
  createFirestoreInstance,
  CURRENT_DB_EPOCH,
  db as sourceDb,
  decodeCompactFirebaseConfig,
  encodeCompactFirebaseConfig,
  firebaseTargetKey,
  getPreviousFirebaseConfigs,
  getSyncedSourceKeys,
  getTargetFirebaseAppName,
  isSameFirebaseTarget,
  markSourceKeySynced,
  sanitizeFirebaseConfig,
  type FirebaseAppConfig,
} from './firebase';
import {
  loadAllQuizDrafts,
  loadSessionSnapshot,
  saveQuizDraft,
  saveSessionSnapshot,
  type StoredMyQuizzesSnapshot,
  type StoredQuizAttemptsSnapshot,
  type StoredRoomSnapshot,
  type StoredSavedTestsSnapshot,
  type StoredUserProfileSnapshot,
} from './localDraftStore';
import type {
  Competition,
  CompetitionQuestion,
  ExplainLayer,
  InteractiveSlide,
  MyQuiz,
  Participant,
  Question,
  QuizAttempt,
  Room,
  SavedQuestion,
  SavedTest,
  SharedExplainBoard,
  SharedQuiz,
  SlideLayer,
  StudentBoard,
  UserProfile,
} from './types';

export interface MigrationProgress {
  step:
    | 'parsing'
    | 'signing_in'
    | 'collecting'
    | 'migrating_profile'
    | 'migrating_rooms'
    | 'migrating_saved'
    | 'migrating_quizzes'
    | 'migrating_attempts'
    | 'finalizing'
    | 'done';
  message: string;
  percent: number;
  detail?: string;
}

export interface MigrationResult {
  targetConfig: FirebaseAppConfig;
  targetUid: string;
  shareUrl: string;
  migratedRoomId: string | null;
  migratedRoomsCount: number;
  roomCreatedAsSupervisor: boolean;
  roomRejoinedAsStudent: boolean;
  roomPendingForStudent: boolean;
  migratedQuestionsCount: number;
  migratedSlidesCount: number;
  migratedLayersCount: number;
  migratedBoardsCount: number;
  migratedSharedQuizzesCount: number;
  migratedCompetitionsCount: number;
  migratedSavedTestsCount: number;
  migratedMyQuizzesCount: number;
  migratedAttemptsCount: number;
  platformPointerUpdated: boolean;
}

export interface PlatformMigrationPointer {
  id: string;
  projectId: string;
  apiKey: string;
  authDomain: string;
  appId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  measurementId?: string;
  firestoreDatabaseId?: string;
  migratedBy: string;
  migratedByName: string;
  migratedRoomId?: string;
  migrationEpoch?: string;
  previousConfigs?: FirebaseAppConfig[];
  updatedAt?: unknown;
}

export class MigrationNeedsSetupError extends Error {
  reason: 'firestore_rules' | 'auth_provider' | 'unauthorized_domain' | 'email_unverified';
  projectId: string;

  constructor(
    reason: 'firestore_rules' | 'auth_provider' | 'unauthorized_domain' | 'email_unverified',
    projectId: string,
    message: string
  ) {
    super(message);
    this.name = 'MigrationNeedsSetupError';
    this.reason = reason;
    this.projectId = projectId;
  }
}

const KNOWN_CONFIG_KEYS = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
  'measurementId',
  'firestoreDatabaseId',
  'databaseId',
] as const;

export function parseFirebaseConfigSnippet(
  rawInput: string,
  overrideDatabaseId?: string
): FirebaseAppConfig {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error('يرجى لصق كود إعدادات Firebase أو رابط النقل أولاً.');
  }

  let parsed: FirebaseAppConfig | null = null;

  if (/^https?:\/\//i.test(trimmed) || trimmed.includes('fb=')) {
    try {
      const normalizedUrl = /^https?:\/\//i.test(trimmed)
        ? trimmed
        : `https://example.com/?${trimmed.replace(/^\?/, '')}`;
      const url = new URL(normalizedUrl);
      const fbParam = url.searchParams.get('fb');
      if (fbParam) {
        parsed = decodeCompactFirebaseConfig(fbParam);
      }
    } catch {
      // Continue to JSON / JS snippet parsing
    }
  }

  if (!parsed && trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed) as unknown;
      parsed = sanitizeFirebaseConfig(obj);
    } catch {
      // Continue to JS snippet regex extraction
    }
  }

  if (!parsed) {
    const extracted: Record<string, string> = {};
    for (const key of KNOWN_CONFIG_KEYS) {
      const pattern = new RegExp(
        `(?:["']?${key}["']?)\\s*:\\s*["']([^"'\\n\\r]+)["']`,
        'i'
      );
      const match = trimmed.match(pattern);
      if (match && match[1]) {
        extracted[key] = match[1].trim();
      }
    }
    parsed = sanitizeFirebaseConfig(extracted);
  }

  if (!parsed) {
    throw new Error(
      'لم يتم التعرف على إعدادات Firebase صالحة. تأكد من نسخ كائن firebaseConfig كاملاً (يجب أن يحتوي على apiKey و projectId و appId).'
    );
  }

  const dbOverride = overrideDatabaseId?.trim();
  if (dbOverride !== undefined) {
    parsed = {
      ...parsed,
      firestoreDatabaseId: dbOverride === '(default)' ? '' : dbOverride,
    };
  }

  return parsed;
}

export function buildShareMigrationUrl(
  config: FirebaseAppConfig,
  roomId?: string | null
): string {
  const encoded = encodeCompactFirebaseConfig(config);
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('fb', encoded);
  if (roomId && /^[A-Z0-9_-]{4,16}$/i.test(roomId.trim())) {
    url.searchParams.set('room', roomId.trim().toUpperCase());
  }
  return url.toString();
}

export function getOrInitFirebaseApp(config: FirebaseAppConfig): FirebaseApp {
  if (isSameFirebaseTarget(config, activeFirebaseConfig)) {
    const primary = getApps().find((a) =>
      a.name === '[DEFAULT]' ||
      a.name === getTargetFirebaseAppName(activeFirebaseConfig.projectId, activeFirebaseConfig.firestoreDatabaseId)
    );
    if (primary) return primary;
  }
  const appName = getTargetFirebaseAppName(config.projectId, config.firestoreDatabaseId);
  const existing = getApps().find((a) => a.name === appName);
  if (existing) {
    return existing;
  }
  return initializeApp(config, appName);
}

async function withTimeout<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('timeout'));
    }, ms);
    promise
      .then((val) => {
        window.clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        window.clearTimeout(timer);
        reject(err);
      });
  });
}

function classifyMigrationError(err: unknown, projectId: string): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes('permission-denied') || lower.includes('permission_denied')) {
    return new MigrationNeedsSetupError(
      'firestore_rules',
      projectId,
      'قاعدة البيانات الجديدة ترفض الكتابة حالياً لأن قواعد الأمان (Firestore Rules) لم تُضف بعد.'
    );
  }
  if (lower.includes('auth/unauthorized-domain')) {
    return new MigrationNeedsSetupError(
      'unauthorized_domain',
      projectId,
      `هذا النطاق (${window.location.hostname}) غير مضاف في Authorized domains داخل Firebase Authentication للمشروع ${projectId}.`
    );
  }
  if (
    lower.includes('auth/operation-not-allowed') ||
    lower.includes('auth/configuration-not-found')
  ) {
    return new MigrationNeedsSetupError(
      'auth_provider',
      projectId,
      `يرجى تفعيل مزوّد تسجيل الدخول عبر Google داخل Authentication > Sign-in method في المشروع ${projectId}.`
    );
  }
  if (lower.includes('auth/popup-blocked')) {
    return new Error(
      'تم حظر نافذة تسجيل الدخول من المتصفح. يرجى السماح بالنوافذ المنبثقة ثم المحاولة مرة أخرى.'
    );
  }
  if (lower.includes('auth/popup-closed-by-user')) {
    return new Error('تم إغلاق نافذة تسجيل الدخول قبل إتمام العملية.');
  }
  if (lower.includes('quota exceeded') || lower.includes('resource-exhausted')) {
    return new Error(
      'قاعدة البيانات الهدف التي أدخلتها بلغت حد الحصة أيضاً. يرجى استخدام مشروع Firebase آخر.'
    );
  }
  return err instanceof Error ? err : new Error(raw);
}

interface CollectedRoomData {
  room: Room;
  myRole: 'supervisor' | 'student';
  participants: Participant[];
  questions: Question[];
  boardsByQuestionId: Record<string, StudentBoard[]>;
  slides: InteractiveSlide[];
  slideLayers: SlideLayer[];
  explainLayers: ExplainLayer[];
  sharedBoard: SharedExplainBoard | null;
  sharedQuizzes: SharedQuiz[];
  competitions: Competition[];
  competitionQuestionsByCompId: Record<string, CompetitionQuestion[]>;
  competitionBoardsByKey: Record<string, StudentBoard[]>;
}

interface CollectedSourceData {
  oldUid: string | null;
  profile: UserProfile | null;
  primaryRoomId: string | null;
  rooms: CollectedRoomData[];
  savedTests: SavedTest[];
  savedQuestionsByTestId: Record<string, SavedQuestion[]>;
  myQuizzes: MyQuiz[];
  quizAttempts: QuizAttempt[];
}

function cleanQuizQuestionForFirestore(q: MyQuiz['questions'][number]): Record<string, unknown> {
  const chart = q.chart ? sanitizeChart(q.chart) : null;
  const figure = q.figure ? sanitizeFigure(q.figure) : null;
  const expChart = q.explanationChart ? sanitizeChart(q.explanationChart) : null;
  const expFigure = q.explanationFigure ? sanitizeFigure(q.explanationFigure) : null;
  return {
    ...(chart ? { chart } : {}),
    ...(figure ? { figure } : {}),
    ...(expChart ? { explanationChart: expChart } : {}),
    ...(expFigure ? { explanationFigure: expFigure } : {}),
    id: String(q.id || '').slice(0, 64) || `q_${Math.random().toString(36).slice(2, 10)}`,
    text: String(q.text || '').slice(0, 2000),
    choices: Array.isArray(q.choices)
      ? q.choices.map((c) => String(c).slice(0, 500)).slice(0, 8)
      : [],
    correctIndex: Number.isInteger(q.correctIndex) ? q.correctIndex : -1,
    answer: String(q.answer || '').slice(0, 1000),
    explanation: String(q.explanation || '').slice(0, 2000),
  };
}

function cleanSavedQuestionForFirestore(
  sq: SavedQuestion,
  ownerUid: string
): Record<string, unknown> {
  const chart = sq.chart ? sanitizeChart(sq.chart) : null;
  const figure = sq.figure ? sanitizeFigure(sq.figure) : null;
  const expChart = sq.explanationChart ? sanitizeChart(sq.explanationChart) : null;
  const expFigure = sq.explanationFigure ? sanitizeFigure(sq.explanationFigure) : null;

  return {
    id: sq.id,
    ownerId: ownerUid,
    orderIndex: Math.min(200, Math.max(1, sq.orderIndex)),
    text: (sq.text || '').slice(0, 2000),
    imageData: sq.imageData && sq.imageData.length <= 480000 ? sq.imageData : '',
    ...(Array.isArray(sq.choices) && sq.choices.length > 0
      ? { choices: sq.choices.map((c) => String(c).slice(0, 500)).slice(0, 8) }
      : {}),
    ...(typeof sq.correctIndex === 'number' && Number.isInteger(sq.correctIndex)
      ? { correctIndex: Math.max(-1, Math.min(7, sq.correctIndex)) }
      : {}),
    ...(sq.explanation ? { explanation: String(sq.explanation).slice(0, 2000) } : {}),
    ...(chart ? { chart } : {}),
    ...(figure ? { figure } : {}),
    ...(expChart ? { explanationChart: expChart } : {}),
    ...(expFigure ? { explanationFigure: expFigure } : {}),
    ...(typeof sq.winnerTimeMs === 'number' && Number.isFinite(sq.winnerTimeMs)
      ? { winnerTimeMs: Math.max(0, Math.min(172800000, Math.round(sq.winnerTimeMs))) }
      : {}),
    status: sq.status || 'solving',
    winnerName: (sq.winnerName || '').slice(0, 120),
    boards: (sq.boards || []).slice(0, 100),
    createdAt: serverTimestamp(),
  };
}

async function collectRoomDetails(
  fromDb: Firestore,
  baseRoom: Room,
  oldUid: string | null,
  cachedRoom: StoredRoomSnapshot | null,
  isSupervisorHint: boolean
): Promise<CollectedRoomData> {
  const useCached = cachedRoom && cachedRoom.room?.id === baseRoom.id ? cachedRoom : null;
  let room: Room = baseRoom;

  try {
    const rSnap = await withTimeout(getDoc(doc(fromDb, 'rooms', baseRoom.id)));
    if (rSnap.exists()) {
      room = rSnap.data() as Room;
    }
  } catch {
    // Fallback to baseRoom
  }

  const myRole: 'supervisor' | 'student' =
    isSupervisorHint || (oldUid && room.supervisorId === oldUid)
      ? 'supervisor'
      : useCached?.myRole ?? 'student';

  let participants: Participant[] = useCached?.participants ?? [];
  try {
    const pSnap = await withTimeout(
      getDocs(query(collection(fromDb, 'rooms', room.id, 'participants'), where('roomId', '==', room.id)))
    );
    const list: Participant[] = [];
    pSnap.forEach((d) => list.push(d.data() as Participant));
    if (list.length > 0) participants = list;
  } catch {
    // Keep cached
  }

  let questions: Question[] = useCached?.questions ?? [];
  try {
    const qSnap = await withTimeout(
      getDocs(query(collection(fromDb, 'rooms', room.id, 'questions'), where('roomId', '==', room.id)))
    );
    const list: Question[] = [];
    qSnap.forEach((d) => list.push(d.data() as Question));
    list.sort((a, b) => a.orderIndex - b.orderIndex);
    if (list.length > 0) questions = list;
  } catch {
    // Keep cached
  }

  // Collect student boards for ALL questions (not just currentQuestionId!)
  const boardsByQuestionId: Record<string, StudentBoard[]> = {};
  if (useCached?.boards?.length && room.currentQuestionId) {
    boardsByQuestionId[room.currentQuestionId] = useCached.boards;
  }
  for (const q of questions) {
    try {
      const bSnap = await withTimeout(
        getDocs(
          query(
            collection(fromDb, 'rooms', room.id, 'questions', q.id, 'boards'),
            where('roomId', '==', room.id),
            where('questionId', '==', q.id)
          )
        )
      );
      const list: StudentBoard[] = [];
      bSnap.forEach((d) => list.push(d.data() as StudentBoard));
      if (list.length > 0) {
        boardsByQuestionId[q.id] = list;
      }
    } catch {
      // Keep cached fallback if available
    }
  }

  let slides: InteractiveSlide[] = useCached?.slides ?? [];
  try {
    const sSnap = await withTimeout(
      getDocs(query(collection(fromDb, 'rooms', room.id, 'slides'), where('roomId', '==', room.id)))
    );
    const list: InteractiveSlide[] = [];
    sSnap.forEach((d) => list.push(d.data() as InteractiveSlide));
    list.sort((a, b) => a.pageIndex - b.pageIndex);
    if (list.length > 0) slides = list;
  } catch {
    // Keep cached
  }

  // Collect layers across ALL slides!
  const slideLayersMap = new Map<string, SlideLayer>();
  (useCached?.slideLayers ?? []).forEach((l) => {
    slideLayersMap.set(`${l.slideId}::${l.id}`, l);
  });
  for (const slide of slides) {
    try {
      const slSnap = await withTimeout(
        getDocs(
          query(
            collection(fromDb, 'rooms', room.id, 'slides', slide.id, 'layers'),
            where('roomId', '==', room.id),
            where('slideId', '==', slide.id)
          )
        )
      );
      slSnap.forEach((d) => {
        const l = d.data() as SlideLayer;
        slideLayersMap.set(`${l.slideId}::${l.id}`, l);
      });
    } catch {
      // Ignore individual slide layer fetch failures
    }
  }
  const slideLayers = Array.from(slideLayersMap.values());

  let explainLayers: ExplainLayer[] = useCached?.explainLayers ?? [];
  try {
    const elSnap = await withTimeout(
      getDocs(
        query(collection(fromDb, 'rooms', room.id, 'explainLayers'), where('roomId', '==', room.id))
      )
    );
    const list: ExplainLayer[] = [];
    elSnap.forEach((d) => list.push(d.data() as ExplainLayer));
    if (list.length > 0) explainLayers = list;
  } catch {
    // Keep cached
  }

  let sharedBoard: SharedExplainBoard | null = useCached?.sharedBoard ?? null;
  try {
    const sbSnap = await withTimeout(getDoc(doc(fromDb, 'rooms', room.id, 'sharedBoard', 'live')));
    if (sbSnap.exists()) {
      sharedBoard = sbSnap.data() as SharedExplainBoard;
    }
  } catch {
    // Keep cached
  }

  let sharedQuizzes: SharedQuiz[] = [];
  try {
    const sqSnap = await withTimeout(
      getDocs(
        query(collection(fromDb, 'rooms', room.id, 'sharedQuizzes'), where('roomId', '==', room.id))
      )
    );
    sqSnap.forEach((d) => sharedQuizzes.push(d.data() as SharedQuiz));
  } catch {
    // Ignore if unavailable
  }

  let competitions: Competition[] = [];
  const competitionQuestionsByCompId: Record<string, CompetitionQuestion[]> = {};
  const competitionBoardsByKey: Record<string, StudentBoard[]> = {};
  try {
    const cSnap = await withTimeout(
      getDocs(
        query(collection(fromDb, 'rooms', room.id, 'competitions'), where('roomId', '==', room.id))
      )
    );
    cSnap.forEach((d) => competitions.push(d.data() as Competition));
    for (const comp of competitions) {
      try {
        const cqSnap = await withTimeout(
          getDocs(
            query(
              collection(fromDb, 'rooms', room.id, 'competitions', comp.id, 'questions'),
              where('roomId', '==', room.id),
              where('competitionId', '==', comp.id)
            )
          )
        );
        const cqList: CompetitionQuestion[] = [];
        cqSnap.forEach((d) => cqList.push(d.data() as CompetitionQuestion));
        cqList.sort((a, b) => a.orderIndex - b.orderIndex);
        competitionQuestionsByCompId[comp.id] = cqList;

        for (const cq of cqList) {
          try {
            const cbSnap = await withTimeout(
              getDocs(
                query(
                  collection(
                    fromDb,
                    'rooms',
                    room.id,
                    'competitions',
                    comp.id,
                    'questions',
                    cq.id,
                    'boards'
                  ),
                  where('roomId', '==', room.id),
                  where('questionId', '==', cq.id)
                )
              )
            );
            const cbList: StudentBoard[] = [];
            cbSnap.forEach((d) => cbList.push(d.data() as StudentBoard));
            if (cbList.length > 0) {
              competitionBoardsByKey[`${comp.id}::${cq.id}`] = cbList;
            }
          } catch {
            // Ignore board read errors
          }
        }
      } catch {
        // Ignore competition questions read errors
      }
    }
  } catch {
    // Ignore competitions read errors
  }

  return {
    room,
    myRole,
    participants,
    questions,
    boardsByQuestionId,
    slides,
    slideLayers,
    explainLayers,
    sharedBoard,
    sharedQuizzes,
    competitions,
    competitionQuestionsByCompId,
    competitionBoardsByKey,
  };
}

async function collectSourceData(
  fromDb: Firestore,
  oldUid: string | null,
  currentProfile: UserProfile | null,
  currentRoom: Room | null,
  isSupervisorInCurrentRoom: boolean,
  onProgress: (p: MigrationProgress) => void
): Promise<CollectedSourceData> {
  const cachedProfile = await loadSessionSnapshot<StoredUserProfileSnapshot>('user_profile');
  const cachedRoom = await loadSessionSnapshot<StoredRoomSnapshot>('active_room');
  const cachedSaved = await loadSessionSnapshot<StoredSavedTestsSnapshot>('saved_tests');
  const cachedQuizzes = await loadSessionSnapshot<StoredMyQuizzesSnapshot>('my_quizzes');
  const cachedAttempts = await loadSessionSnapshot<StoredQuizAttemptsSnapshot>('quiz_attempts');

  let fallbackQuad = '';
  try {
    if (oldUid) {
      fallbackQuad =
        localStorage.getItem(`duoboard_quad_${oldUid}`) ||
        localStorage.getItem('duoboard_last_quad_name') ||
        '';
    } else {
      fallbackQuad = localStorage.getItem('duoboard_last_quad_name') || '';
    }
  } catch {
    // Ignore storage errors
  }

  let profile: UserProfile | null =
    currentProfile ??
    (cachedProfile
      ? {
          uid: cachedProfile.uid,
          fullNameQuad: cachedProfile.fullNameQuad,
          email: cachedProfile.email,
        }
      : fallbackQuad
      ? {
          uid: oldUid || 'local_user',
          fullNameQuad: fallbackQuad,
          email: sourceAuth.currentUser?.email || 'user@example.com',
        }
      : null);

  if (!profile && oldUid) {
    try {
      const pSnap = await withTimeout(
        getDoc(doc(fromDb, 'users', oldUid, 'private', 'profile'))
      );
      if (pSnap.exists()) {
        profile = pSnap.data() as UserProfile;
      }
    } catch {
      // Fallback gracefully
    }
  }

  onProgress({
    step: 'collecting',
    percent: 16,
    message: 'جاري فحص الغرف والملفات والشرائح على القاعدة الحالية...',
  });

  // Collect ALL rooms accessible to the user: currentRoom, cachedRoom, plus ALL supervisor-owned rooms
  const candidateRoomsMap = new Map<string, Room>();
  if (currentRoom) candidateRoomsMap.set(currentRoom.id, currentRoom);
  if (cachedRoom?.room && !candidateRoomsMap.has(cachedRoom.room.id)) {
    candidateRoomsMap.set(cachedRoom.room.id, cachedRoom.room);
  }
  if (oldUid) {
    try {
      const ownedRoomsSnap = await withTimeout(
        getDocs(query(collection(fromDb, 'rooms'), where('supervisorId', '==', oldUid))),
        8000
      );
      ownedRoomsSnap.forEach((d) => {
        const r = d.data() as Room;
        candidateRoomsMap.set(r.id, r);
      });
    } catch {
      // Keep active/cached rooms if list fails (e.g. quota exceeded)
    }
  }

  const candidateRooms = Array.from(candidateRoomsMap.values());
  const rooms: CollectedRoomData[] = [];
  for (let i = 0; i < candidateRooms.length; i++) {
    const r = candidateRooms[i];
    const isSupHint =
      (currentRoom && r.id === currentRoom.id && isSupervisorInCurrentRoom) ||
      Boolean(oldUid && r.supervisorId === oldUid);
    const details = await collectRoomDetails(fromDb, r, oldUid, cachedRoom, isSupHint);
    rooms.push(details);
  }

  onProgress({
    step: 'collecting',
    percent: 24,
    message: 'جاري تجميع الاختبارات المحفوظة واختباراتي والمحاولات...',
  });

  // ALL Saved Tests + questions (no 15-test truncation!)
  let savedTests: SavedTest[] = cachedSaved?.tests ?? [];
  const savedQuestionsByTestId: Record<string, SavedQuestion[]> = {
    ...(cachedSaved?.questionsByTestId ?? {}),
  };

  if (oldUid) {
    try {
      const stSnap = await withTimeout(
        getDocs(
          query(collection(fromDb, 'users', oldUid, 'savedTests'), where('ownerId', '==', oldUid))
        ),
        9000
      );
      const liveTests: SavedTest[] = [];
      stSnap.forEach((d) => liveTests.push(d.data() as SavedTest));
      if (liveTests.length > 0) {
        savedTests = liveTests;
        for (const t of liveTests) {
          try {
            const tqSnap = await withTimeout(
              getDocs(
                query(
                  collection(fromDb, 'users', oldUid, 'savedTests', t.id, 'questions'),
                  where('ownerId', '==', oldUid)
                )
              ),
              8000
            );
            const tqList: SavedQuestion[] = [];
            tqSnap.forEach((d) => tqList.push(d.data() as SavedQuestion));
            tqList.sort((a, b) => a.orderIndex - b.orderIndex);
            savedQuestionsByTestId[t.id] = tqList;
          } catch {
            // Keep cached questions for this test if quota hits mid-way
          }
        }
      }
    } catch {
      // Use cached snapshot
    }
  }

  // ALL My Quizzes
  let myQuizzes: MyQuiz[] =
    cachedQuizzes && (!oldUid || cachedQuizzes.ownerId === oldUid) ? cachedQuizzes.quizzes : [];
  if (oldUid) {
    try {
      const qzSnap = await withTimeout(
        getDocs(
          query(collection(fromDb, 'users', oldUid, 'myQuizzes'), where('ownerId', '==', oldUid))
        ),
        9000
      );
      const live: MyQuiz[] = [];
      qzSnap.forEach((d) => live.push(d.data() as MyQuiz));
      myQuizzes = live;
    } catch {
      // Keep local snapshot
    }
  }

  // ALL Quiz Attempts
  let quizAttempts: QuizAttempt[] =
    cachedAttempts && (!oldUid || cachedAttempts.ownerId === oldUid)
      ? cachedAttempts.attempts
      : [];
  if (oldUid) {
    try {
      const atSnap = await withTimeout(
        getDocs(
          query(collection(fromDb, 'users', oldUid, 'quizAttempts'), where('ownerId', '==', oldUid))
        ),
        9000
      );
      const live: QuizAttempt[] = [];
      atSnap.forEach((d) => live.push(d.data() as QuizAttempt));
      quizAttempts = live;
    } catch {
      // Keep local snapshot
    }
  }

  return {
    oldUid,
    profile,
    primaryRoomId: currentRoom?.id ?? cachedRoom?.room?.id ?? rooms[0]?.room.id ?? null,
    rooms,
    savedTests,
    savedQuestionsByTestId,
    myQuizzes,
    quizAttempts,
  };
}

async function signInOnTarget(
  targetConfig: FirebaseAppConfig
): Promise<{ targetApp: FirebaseApp; targetDb: Firestore; targetUser: User }> {
  const targetApp = getOrInitFirebaseApp(targetConfig);
  const targetAuth = getAuth(targetApp);
  const targetDb = createFirestoreInstance(targetApp, targetConfig);

  let targetUser = targetAuth.currentUser;
  if (!targetUser) {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const cred = await signInWithPopup(targetAuth, provider);
    targetUser = cred.user;
  }

  if (!targetUser.emailVerified) {
    throw new MigrationNeedsSetupError(
      'email_unverified',
      targetConfig.projectId,
      'حساب Google المختار غير مُفعّل البريد الإلكتروني (email_verified).'
    );
  }

  return { targetApp, targetDb, targetUser };
}

async function migrateUserProfileToDb(params: {
  targetDb: Firestore;
  targetUser: User;
  fallbackProfile: UserProfile | null;
}): Promise<string> {
  const { targetDb, targetUser, fallbackProfile } = params;
  const targetUid = targetUser.uid;
  const resolvedQuadName =
    fallbackProfile?.fullNameQuad ||
    (targetUser.displayName &&
    targetUser.displayName.trim().split(/\s+/).length >= 4
      ? targetUser.displayName.trim()
      : '');

  const targetProfileRef = doc(targetDb, 'users', targetUid, 'private', 'profile');
  const existingProfileSnap = await getDoc(targetProfileRef);

  if (resolvedQuadName && resolvedQuadName.length >= 5) {
    if (existingProfileSnap.exists()) {
      await updateDoc(targetProfileRef, {
        fullNameQuad: resolvedQuadName.slice(0, 120),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(targetProfileRef, {
        uid: targetUid,
        fullNameQuad: resolvedQuadName.slice(0, 120),
        email: targetUser.email || fallbackProfile?.email || 'user@example.com',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    try {
      localStorage.setItem(`duoboard_quad_${targetUid}`, resolvedQuadName);
      localStorage.setItem('duoboard_last_quad_name', resolvedQuadName);
    } catch {
      // Ignore storage errors
    }

    await saveSessionSnapshot({
      key: 'user_profile',
      uid: targetUid,
      fullNameQuad: resolvedQuadName,
      email: targetUser.email || fallbackProfile?.email || 'user@example.com',
      updatedAt: Date.now(),
    });
    return resolvedQuadName;
  }

  if (existingProfileSnap.exists()) {
    const existingData = existingProfileSnap.data() as UserProfile;
    try {
      localStorage.setItem(`duoboard_quad_${targetUid}`, existingData.fullNameQuad);
      localStorage.setItem('duoboard_last_quad_name', existingData.fullNameQuad);
    } catch {
      // Ignore storage errors
    }
    return existingData.fullNameQuad;
  }

  return '';
}

async function writePersonalCollectionsToDb(params: {
  targetDb: Firestore;
  targetUid: string;
  savedTests: SavedTest[];
  savedQuestionsByTestId: Record<string, SavedQuestion[]>;
  myQuizzes: MyQuiz[];
  quizAttempts: QuizAttempt[];
  onItemDone?: (kind: 'saved' | 'quiz' | 'attempt', label: string) => void;
}): Promise<{
  migratedSavedTestsCount: number;
  migratedMyQuizzesCount: number;
  migratedAttemptsCount: number;
}> {
  const {
    targetDb,
    targetUid,
    savedTests,
    savedQuestionsByTestId,
    myQuizzes,
    quizAttempts,
    onItemDone,
  } = params;

  let migratedSavedTestsCount = 0;
  for (const test of savedTests) {
    const testRef = doc(targetDb, 'users', targetUid, 'savedTests', test.id);
    const existingSaved = await getDoc(testRef);
    if (existingSaved.exists()) {
      migratedSavedTestsCount++;
      onItemDone?.('saved', test.title);
      continue;
    }

    const savedQuestions = savedQuestionsByTestId[test.id] ?? [];
    const CHUNK = 5;
    const firstChunk = savedQuestions.slice(0, CHUNK);
    const firstBatch = writeBatch(targetDb);

    const safeSupervisorName =
      test.supervisorName && test.supervisorName.length >= 5
        ? test.supervisorName.slice(0, 120)
        : 'مشرف الجلسة التعليمية';

    firstBatch.set(testRef, {
      id: test.id,
      ownerId: targetUid,
      roomCode: (test.roomCode || test.id).slice(0, 16),
      title: (test.title || 'اختبار محفوظ').slice(0, 120),
      userRole: test.userRole || 'student',
      supervisorName: safeSupervisorName,
      totalQuestions: Math.min(200, Math.max(0, savedQuestions.length || test.totalQuestions || 0)),
      participantsSummary: (test.participantsSummary || []).slice(0, 100),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    for (const sq of firstChunk) {
      const sqRef = doc(targetDb, 'users', targetUid, 'savedTests', test.id, 'questions', sq.id);
      firstBatch.set(sqRef, cleanSavedQuestionForFirestore(sq, targetUid));
    }
    await firstBatch.commit();

    for (let i = CHUNK; i < savedQuestions.length; i += CHUNK) {
      const batch = writeBatch(targetDb);
      for (const sq of savedQuestions.slice(i, i + CHUNK)) {
        const sqRef = doc(targetDb, 'users', targetUid, 'savedTests', test.id, 'questions', sq.id);
        batch.set(sqRef, cleanSavedQuestionForFirestore(sq, targetUid));
      }
      await batch.commit();
    }

    migratedSavedTestsCount++;
    onItemDone?.('saved', test.title);
  }

  let migratedMyQuizzesCount = 0;
  for (const quiz of myQuizzes) {
    if (!quiz?.id || !Array.isArray(quiz.questions) || quiz.questions.length === 0) continue;
    const quizRef = doc(targetDb, 'users', targetUid, 'myQuizzes', quiz.id);
    const existingQuiz = await getDoc(quizRef);
    if (existingQuiz.exists()) {
      migratedMyQuizzesCount++;
      onItemDone?.('quiz', quiz.title);
      continue;
    }
    const questions = quiz.questions.slice(0, 100).map(cleanQuizQuestionForFirestore);
    await setDoc(quizRef, {
      id: quiz.id,
      ownerId: targetUid,
      title: (quiz.title || 'اختبار').slice(0, 120),
      questions,
      questionCount: questions.length,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    migratedMyQuizzesCount++;
    onItemDone?.('quiz', quiz.title);
  }

  let migratedAttemptsCount = 0;
  for (const at of quizAttempts) {
    if (!at?.id || !Array.isArray(at.questions) || at.questions.length === 0) continue;
    const atRef = doc(targetDb, 'users', targetUid, 'quizAttempts', at.id);
    const existingAt = await getDoc(atRef);
    if (existingAt.exists()) {
      migratedAttemptsCount++;
      onItemDone?.('attempt', at.title);
      continue;
    }
    const qs: Record<string, unknown>[] = at.questions.slice(0, 100).map((q) => {
      const base = cleanQuizQuestionForFirestore({
        ...q,
        answer: '',
      });
      delete base.answer;
      return {
        ...base,
        id: String(q.id || '').slice(0, 120) || `q_${Math.random().toString(36).slice(2, 10)}`,
        sourceQuizId: String(q.sourceQuizId || '').slice(0, 120),
        sourceTitle: String(q.sourceTitle || '').slice(0, 120),
      };
    });
    const answers = qs.map((_, i) => (Number.isInteger(at.answers?.[i]) ? at.answers[i] : -1));
    const score = Math.min(
      qs.length,
      Math.max(
        0,
        qs.reduce((n, q, i) => n + (answers[i] === Number(q.correctIndex) ? 1 : 0), 0)
      )
    );
    await setDoc(atRef, {
      id: at.id,
      ownerId: targetUid,
      title: String(at.title || 'اختبار').slice(0, 200),
      settings: at.settings && typeof at.settings === 'object' ? at.settings : {},
      questions: qs,
      answers,
      score,
      total: qs.length,
      durationSec: Math.max(0, Math.min(172800, Math.round(Number(at.durationSec) || 0))),
      finishedAt:
        Number.isFinite(Number(at.finishedAt)) && Number(at.finishedAt) > 0
          ? Math.round(Number(at.finishedAt))
          : Date.now(),
      createdAt: serverTimestamp(),
    });
    migratedAttemptsCount++;
    onItemDone?.('attempt', at.title);
  }

  return {
    migratedSavedTestsCount,
    migratedMyQuizzesCount,
    migratedAttemptsCount,
  };
}

export async function runFirebaseMigration(params: {
  targetConfig: FirebaseAppConfig;
  currentProfile: UserProfile | null;
  currentRoom: Room | null;
  isSupervisorInCurrentRoom: boolean;
  onProgress: (p: MigrationProgress) => void;
}): Promise<MigrationResult> {
  const {
    targetConfig,
    currentProfile,
    currentRoom,
    isSupervisorInCurrentRoom,
    onProgress,
  } = params;

  if (isSameFirebaseTarget(targetConfig, activeFirebaseConfig)) {
    throw new Error(
      'أنت متصل بالفعل بقاعدة البيانات هذه. الصق إعدادات مشروع أو قاعدة بيانات أخرى.'
    );
  }

  onProgress({
    step: 'signing_in',
    percent: 8,
    message: 'جاري تسجيل الدخول على قاعدة البيانات الجديدة...',
  });

  let targetDb: Firestore;
  let targetUser: User;
  try {
    const signed = await signInOnTarget(targetConfig);
    targetDb = signed.targetDb;
    targetUser = signed.targetUser;
  } catch (err) {
    throw classifyMigrationError(err, targetConfig.projectId);
  }

  onProgress({
    step: 'collecting',
    percent: 14,
    message: 'جاري تجميع كافة بيانات المنصة (الغرف، الاختبارات، الملفات، الصبورات)...',
  });

  const cachedProfile = await loadSessionSnapshot<StoredUserProfileSnapshot>('user_profile');
  const oldUid =
    currentProfile?.uid ?? sourceAuth.currentUser?.uid ?? cachedProfile?.uid ?? null;

  const source = await collectSourceData(
    sourceDb,
    oldUid,
    currentProfile,
    currentRoom,
    isSupervisorInCurrentRoom,
    onProgress
  );

  const targetUid = targetUser.uid;

  // Compute total units for smooth real percentage reporting (25% -> 95%)
  const totalRoomUnits = source.rooms.reduce(
    (sum, r) =>
      sum +
      1 +
      r.slides.length +
      r.questions.length +
      r.sharedQuizzes.length +
      r.competitions.length,
    0
  );
  const totalUnits = Math.max(
    1,
    1 +
      totalRoomUnits +
      source.savedTests.length +
      source.myQuizzes.length +
      source.quizAttempts.length
  );
  let completedUnits = 0;
  const calcPercent = () => Math.min(94, 25 + Math.round((completedUnits / totalUnits) * 69));

  try {
    // 1. Migrate User Profile
    onProgress({
      step: 'migrating_profile',
      percent: 25,
      message: 'جاري نقل بيانات الحساب الشخصي...',
    });

    const resolvedQuadName = await migrateUserProfileToDb({
      targetDb,
      targetUser,
      fallbackProfile: source.profile,
    });
    completedUnits++;

    // Re-key local quiz drafts (uploaded PDFs, selected pages, AI cache, draft strokes)
    if (source.oldUid && source.oldUid !== targetUid) {
      const allDrafts = await loadAllQuizDrafts();
      for (const d of allDrafts) {
        if (d.key.endsWith(`_${source.oldUid}`)) {
          const newKey = d.key.slice(0, d.key.length - source.oldUid.length) + targetUid;
          await saveQuizDraft({
            ...d,
            key: newKey,
            updatedAt: Date.now(),
          });
        }
      }
    }

    // 2. Migrate ALL Collected Rooms (Questions, ALL Boards, ALL Slides, ALL Layers, SharedQuizzes, Competitions)
    let migratedRoomId: string | null = source.primaryRoomId;
    let migratedRoomsCount = 0;
    let roomCreatedAsSupervisor = false;
    let roomRejoinedAsStudent = false;
    let roomPendingForStudent = false;
    let migratedQuestionsCount = 0;
    let migratedSlidesCount = 0;
    let migratedLayersCount = 0;
    let migratedBoardsCount = 0;
    let migratedSharedQuizzesCount = 0;
    let migratedCompetitionsCount = 0;

    for (const roomBundle of source.rooms) {
      const srcRoom = roomBundle.room;
      const isPrimary = srcRoom.id === source.primaryRoomId;

      onProgress({
        step: 'migrating_rooms',
        percent: calcPercent(),
        message: `جاري نقل الغرفة (${srcRoom.id}) وكل ملفاتها وأسئلتها...`,
        detail: `${srcRoom.title}`,
      });

      const targetRoomRef = doc(targetDb, 'rooms', srcRoom.id);
      const existingRoomSnap = await getDoc(targetRoomRef);

      if (roomBundle.myRole === 'supervisor') {
        const supervisorDisplayName =
          resolvedQuadName && resolvedQuadName.length >= 5
            ? resolvedQuadName
            : srcRoom.supervisorName && srcRoom.supervisorName.length >= 5
            ? srcRoom.supervisorName
            : 'المشرف العام للجلسة';

        if (!existingRoomSnap.exists()) {
          await setDoc(targetRoomRef, {
            id: srcRoom.id,
            title: (srcRoom.title || 'جلسة السبورة التفاعلية').slice(0, 120),
            supervisorId: targetUid,
            supervisorName: supervisorDisplayName.slice(0, 120),
            status: 'waiting',
            sessionType: srcRoom.sessionType || 'quiz',
            mode: 'quiz',
            explainPresenterId: '',
            explainPresenterName: '',
            interactiveEditor: targetUid,
            interactiveEditorName: supervisorDisplayName.slice(0, 120),
            currentSlideIndex: 0,
            slideCount: 0,
            currentQuestionId: '',
            questionCount: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }

        const freshRoomData = existingRoomSnap.exists()
          ? (existingRoomSnap.data() as Room)
          : null;
        const canEditRoom =
          !freshRoomData ||
          (freshRoomData.supervisorId === targetUid && freshRoomData.status !== 'finished');

        if (canEditRoom) {
          if (srcRoom.status !== 'waiting' && (!freshRoomData || freshRoomData.status === 'waiting')) {
            await updateDoc(targetRoomRef, {
              status: 'active',
              updatedAt: serverTimestamp(),
            });
          }

          const needsExplainForSlides =
            (srcRoom.sessionType || 'quiz') !== 'interactive' &&
            (roomBundle.slides.length > 0 ||
              srcRoom.mode === 'explain' ||
              roomBundle.explainLayers.length > 0);

          if (needsExplainForSlides) {
            await updateDoc(targetRoomRef, {
              mode: 'explain',
              explainPresenterId: srcRoom.explainPresenterId === 'all' ? 'all' : targetUid,
              explainPresenterName:
                srcRoom.explainPresenterId === 'all'
                  ? 'الجميع'
                  : supervisorDisplayName.slice(0, 120),
              updatedAt: serverTimestamp(),
            });
          } else if (srcRoom.mode === 'competition') {
            await updateDoc(targetRoomRef, {
              mode: 'competition',
              updatedAt: serverTimestamp(),
            });
          }

          // Migrate ALL Slides & Current User's Layers on every slide
          for (const slide of roomBundle.slides) {
            if (!slide.imageData || slide.imageData.length > 480000) {
              completedUnits++;
              continue;
            }
            const slideRef = doc(targetDb, 'rooms', srcRoom.id, 'slides', slide.id);
            const sSnap = await getDoc(slideRef);
            if (!sSnap.exists()) {
              await setDoc(slideRef, {
                id: slide.id,
                roomId: srcRoom.id,
                pageIndex: Math.min(100, Math.max(1, slide.pageIndex)),
                imageData: slide.imageData,
                ...(slide.fileId ? { fileId: slide.fileId } : {}),
                ...(slide.fileName ? { fileName: slide.fileName.slice(0, 160) } : {}),
                ...(typeof slide.filePageIndex === 'number'
                  ? { filePageIndex: Math.min(100, Math.max(1, slide.filePageIndex)) }
                  : {}),
                createdAt: serverTimestamp(),
              });
              migratedSlidesCount++;
            }

            const mySlideLayer = roomBundle.slideLayers.find(
              (l) =>
                l.slideId === slide.id &&
                (l.authorId === source.oldUid || l.authorId === targetUid)
            );
            if (mySlideLayer && (mySlideLayer.strokes?.length ?? 0) > 0) {
              const layerRef = doc(
                targetDb,
                'rooms',
                srcRoom.id,
                'slides',
                slide.id,
                'layers',
                targetUid
              );
              await setDoc(layerRef, {
                id: targetUid,
                roomId: srcRoom.id,
                slideId: slide.id,
                authorId: targetUid,
                authorName: supervisorDisplayName.slice(0, 120),
                strokes: mySlideLayer.strokes.slice(-400),
                updatedAt: serverTimestamp(),
              });
              migratedLayersCount++;
            }

            completedUnits++;
            onProgress({
              step: 'migrating_rooms',
              percent: calcPercent(),
              message: `جاري نقل الشرائح والملفات (${srcRoom.id})...`,
              detail: slide.fileName || `شريحة ${slide.pageIndex}`,
            });
          }

          if (roomBundle.slides.length > 0 || (srcRoom.currentSlideIndex ?? 0) > 0) {
            await updateDoc(targetRoomRef, {
              currentSlideIndex: Math.min(100, Math.max(0, srcRoom.currentSlideIndex ?? 0)),
              slideCount: Math.min(
                100,
                Math.max(roomBundle.slides.length, srcRoom.slideCount ?? 0)
              ),
              updatedAt: serverTimestamp(),
            });
          }

          // Migrate blank-board explain layer & sharedBoard
          const myExplainLayer = roomBundle.explainLayers.find(
            (l) => l.authorId === source.oldUid || l.authorId === targetUid
          );
          if (myExplainLayer && (myExplainLayer.strokes?.length ?? 0) > 0) {
            await setDoc(doc(targetDb, 'rooms', srcRoom.id, 'explainLayers', targetUid), {
              id: targetUid,
              roomId: srcRoom.id,
              authorId: targetUid,
              authorName: supervisorDisplayName.slice(0, 120),
              strokes: myExplainLayer.strokes.slice(-400),
              updatedAt: serverTimestamp(),
            });
            migratedLayersCount++;
          }

          if (roomBundle.sharedBoard && (roomBundle.sharedBoard.strokes?.length ?? 0) > 0) {
            await setDoc(doc(targetDb, 'rooms', srcRoom.id, 'sharedBoard', 'live'), {
              roomId: srcRoom.id,
              strokes: roomBundle.sharedBoard.strokes.slice(-400),
              updatedBy: targetUid,
              updatedByName: supervisorDisplayName.slice(0, 120),
              updatedAt: serverTimestamp(),
            });
          }

          if (needsExplainForSlides && (srcRoom.mode || 'quiz') === 'quiz') {
            await updateDoc(targetRoomRef, {
              mode: 'quiz',
              explainPresenterId: '',
              explainPresenterName: '',
              updatedAt: serverTimestamp(),
            });
          }

          // Migrate ALL Room Questions (preserving choices, chart, figure, sourceQuizTitle!)
          for (const q of roomBundle.questions) {
            const qRef = doc(targetDb, 'rooms', srcRoom.id, 'questions', q.id);
            const qSnap = await getDoc(qRef);
            if (!qSnap.exists()) {
              const sanitizedChart = q.chart ? sanitizeChart(q.chart) : null;
              const sanitizedFigure = q.figure ? sanitizeFigure(q.figure) : null;
              const sanitizedChoices =
                Array.isArray(q.choices) && q.choices.length > 0
                  ? q.choices.map((c) => String(c).slice(0, 500)).slice(0, 8)
                  : null;
              await setDoc(qRef, {
                id: q.id,
                roomId: srcRoom.id,
                orderIndex: Math.min(200, Math.max(1, q.orderIndex)),
                text: (q.text || '').slice(0, 2000),
                imageData: q.imageData && q.imageData.length <= 480000 ? q.imageData : '',
                ...(sanitizedChoices ? { choices: sanitizedChoices } : {}),
                ...(sanitizedChart ? { chart: sanitizedChart } : {}),
                ...(sanitizedFigure ? { figure: sanitizedFigure } : {}),
                ...(q.sourceQuizTitle
                  ? { sourceQuizTitle: String(q.sourceQuizTitle).slice(0, 120) }
                  : {}),
                status: 'solving',
                attemptsUsed: 0,
                wrongStudentIds: [],
                winnerId: '',
                winnerName: '',
                timerSeconds: Math.min(3600, Math.max(0, q.timerSeconds ?? 0)),
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });

              if (q.status === 'correct') {
                await updateDoc(qRef, {
                  status: 'correct',
                  winnerId: q.winnerId || targetUid,
                  winnerName: (q.winnerName || 'طالب').slice(0, 120),
                  updatedAt: serverTimestamp(),
                });
              } else if (q.status === 'unanswered') {
                await updateDoc(qRef, {
                  status: 'unanswered',
                  attemptsUsed: Math.min(2, Math.max(0, q.attemptsUsed || 0)),
                  wrongStudentIds: (q.wrongStudentIds || []).slice(0, 2),
                  updatedAt: serverTimestamp(),
                });
              } else if (q.status === 'solving' && q.attemptsUsed === 1) {
                await updateDoc(qRef, {
                  attemptsUsed: 1,
                  wrongStudentIds: (q.wrongStudentIds || []).slice(0, 1),
                  updatedAt: serverTimestamp(),
                });
              }
              migratedQuestionsCount++;
            }
            completedUnits++;
          }

          if (srcRoom.currentQuestionId || roomBundle.questions.length > 0) {
            await updateDoc(targetRoomRef, {
              currentQuestionId: srcRoom.currentQuestionId || '',
              questionCount: Math.min(
                200,
                Math.max(roomBundle.questions.length, srcRoom.questionCount ?? 0)
              ),
              updatedAt: serverTimestamp(),
            });
          }

          // Migrate Room Shared Quizzes (supervisor preserves room quiz bank)
          for (const sq of roomBundle.sharedQuizzes) {
            if (!sq?.id || !Array.isArray(sq.questions) || sq.questions.length === 0) {
              completedUnits++;
              continue;
            }
            const sqRef = doc(targetDb, 'rooms', srcRoom.id, 'sharedQuizzes', sq.id);
            const sqSnap = await getDoc(sqRef);
            if (!sqSnap.exists()) {
              const cleanedQs = sq.questions.slice(0, 100).map(cleanQuizQuestionForFirestore);
              await setDoc(sqRef, {
                id: sq.id,
                roomId: srcRoom.id,
                authorId: targetUid,
                authorName: (sq.authorName || supervisorDisplayName).slice(0, 120),
                authorRole: 'supervisor',
                title: (sq.title || 'نموذج مشترك').slice(0, 120),
                questions: cleanedQs,
                questionCount: cleanedQs.length,
                updatedAt: serverTimestamp(),
              });
              migratedSharedQuizzesCount++;
            }
            completedUnits++;
          }

          // Migrate Competitions + Competition Questions
          for (const comp of roomBundle.competitions) {
            const compRef = doc(targetDb, 'rooms', srcRoom.id, 'competitions', comp.id);
            const cSnap = await getDoc(compRef);
            if (!cSnap.exists()) {
              const competitorsList =
                Array.isArray(comp.competitors) && comp.competitors.length > 0
                  ? comp.competitors.slice(0, 100)
                  : [{ uid: targetUid, name: supervisorDisplayName.slice(0, 120) }];
              const competitorIdsList =
                Array.isArray(comp.competitorIds) && comp.competitorIds.length > 0
                  ? Array.from(new Set([targetUid, ...comp.competitorIds])).slice(0, 100)
                  : [targetUid];

              await setDoc(compRef, {
                id: comp.id,
                roomId: srcRoom.id,
                createdBy: targetUid,
                createdByName: supervisorDisplayName.slice(0, 120),
                title: (comp.title || 'منافسة مباشرة').slice(0, 200),
                settings: comp.settings || {},
                includeSupervisor: Boolean(comp.includeSupervisor),
                competitorIds: competitorIdsList,
                competitors: competitorsList,
                status: 'active',
                phase: 'countdown',
                currentIndex: 0,
                totalQuestions: Math.min(100, Math.max(1, comp.totalQuestions || 1)),
                countdownSec: Math.min(10, Math.max(1, comp.countdownSec || 3)),
                phaseStartedAt: serverTimestamp(),
                totalElapsedMs: 0,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });

              const compQs = roomBundle.competitionQuestionsByCompId[comp.id] ?? [];
              for (const cq of compQs) {
                const cqRef = doc(
                  targetDb,
                  'rooms',
                  srcRoom.id,
                  'competitions',
                  comp.id,
                  'questions',
                  cq.id
                );
                await setDoc(cqRef, {
                  id: cq.id,
                  roomId: srcRoom.id,
                  competitionId: comp.id,
                  orderIndex: Math.min(100, Math.max(1, cq.orderIndex)),
                  question: cq.question,
                  status: 'solving',
                  winnerId: '',
                  winnerName: '',
                  winnerChoiceIndex: -1,
                  winnerTimeMs: 0,
                  wrongPlayerIds: [],
                  attempts: [],
                  updatedAt: serverTimestamp(),
                });
              }

              if (comp.status === 'finished') {
                await updateDoc(compRef, {
                  status: 'finished',
                  totalElapsedMs: Math.min(172800000, Math.max(0, comp.totalElapsedMs || 0)),
                  updatedAt: serverTimestamp(),
                });
              }
              migratedCompetitionsCount++;
            }
            completedUnits++;
          }

          if (srcRoom.sessionType === 'interactive' && srcRoom.interactiveEditor === 'all') {
            await updateDoc(targetRoomRef, {
              interactiveEditor: 'all',
              interactiveEditorName: 'الجميع',
              updatedAt: serverTimestamp(),
            });
          }

          if (srcRoom.status === 'finished') {
            await updateDoc(targetRoomRef, {
              status: 'finished',
              updatedAt: serverTimestamp(),
            });
          }
        }
        migratedRoomsCount++;
        if (isPrimary) roomCreatedAsSupervisor = true;
      } else {
        // Student path: rejoin room if created by supervisor on targetDb + restore student's boards & layers
        if (existingRoomSnap.exists()) {
          const targetRoomData = existingRoomSnap.data() as Room;
          if (targetRoomData.status !== 'finished') {
            const pRef = doc(targetDb, 'rooms', srcRoom.id, 'participants', targetUid);
            const pSnap = await getDoc(pRef);
            const studentName =
              resolvedQuadName && resolvedQuadName.length >= 5
                ? resolvedQuadName
                : 'طالب مشارك بالجلسة';
            if (!pSnap.exists()) {
              await setDoc(pRef, {
                uid: targetUid,
                roomId: srcRoom.id,
                fullNameQuad: studentName.slice(0, 120),
                score: 0,
                correctCount: 0,
                joinedAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
            }

            // Restore student's boards across ALL solving questions
            for (const q of roomBundle.questions) {
              if (q.status !== 'solving') continue;
              const qBoards = roomBundle.boardsByQuestionId[q.id] ?? [];
              const myOldBoard = qBoards.find(
                (b) => b.studentId === source.oldUid || b.studentId === targetUid
              );
              if (!myOldBoard || (myOldBoard.strokes?.length ?? 0) === 0) continue;

              try {
                const targetQSnap = await getDoc(
                  doc(targetDb, 'rooms', srcRoom.id, 'questions', q.id)
                );
                if (targetQSnap.exists() && (targetQSnap.data() as Question).status === 'solving') {
                  const bRef = doc(
                    targetDb,
                    'rooms',
                    srcRoom.id,
                    'questions',
                    q.id,
                    'boards',
                    targetUid
                  );
                  const bSnap = await getDoc(bRef);
                  if (!bSnap.exists()) {
                    await setDoc(bRef, {
                      studentId: targetUid,
                      studentName: studentName.slice(0, 120),
                      roomId: srcRoom.id,
                      questionId: q.id,
                      strokes: myOldBoard.strokes.slice(-400),
                      submitted: Boolean(myOldBoard.submitted),
                      verdict: 'pending',
                      updatedAt: serverTimestamp(),
                    });
                    migratedBoardsCount++;
                  }
                }
              } catch {
                // Skip if board locked on target
              }
            }

            // Restore student's sharedQuizzes authored by them
            for (const sq of roomBundle.sharedQuizzes) {
              if (sq.authorId !== source.oldUid && sq.authorId !== targetUid) continue;
              try {
                const sqRef = doc(targetDb, 'rooms', srcRoom.id, 'sharedQuizzes', sq.id);
                const sqSnap = await getDoc(sqRef);
                if (!sqSnap.exists() && Array.isArray(sq.questions) && sq.questions.length > 0) {
                  const cleanedQs = sq.questions.slice(0, 100).map(cleanQuizQuestionForFirestore);
                  await setDoc(sqRef, {
                    id: sq.id,
                    roomId: srcRoom.id,
                    authorId: targetUid,
                    authorName: studentName.slice(0, 120),
                    authorRole: 'student',
                    title: (sq.title || 'نموذج').slice(0, 120),
                    questions: cleanedQs,
                    questionCount: cleanedQs.length,
                    updatedAt: serverTimestamp(),
                  });
                  migratedSharedQuizzesCount++;
                }
              } catch {
                // Skip if unavailable
              }
            }
          }
          if (isPrimary) roomRejoinedAsStudent = true;
        } else if (isPrimary) {
          roomPendingForStudent = true;
        }
      }
      completedUnits++;
    }

    // 3. Migrate ALL Saved Tests, MyQuizzes, QuizAttempts
    onProgress({
      step: 'migrating_saved',
      percent: calcPercent(),
      message: `جاري نقل الاختبارات المحفوظة (${source.savedTests.length}) واختباراتي (${source.myQuizzes.length}) والمحاولات (${source.quizAttempts.length})...`,
    });

    const { migratedSavedTestsCount, migratedMyQuizzesCount, migratedAttemptsCount } =
      await writePersonalCollectionsToDb({
        targetDb,
        targetUid,
        savedTests: source.savedTests,
        savedQuestionsByTestId: source.savedQuestionsByTestId,
        myQuizzes: source.myQuizzes,
        quizAttempts: source.quizAttempts,
        onItemDone: (kind, label) => {
          completedUnits++;
          const step =
            kind === 'saved'
              ? 'migrating_saved'
              : kind === 'quiz'
              ? 'migrating_quizzes'
              : 'migrating_attempts';
          const msg =
            kind === 'saved'
              ? 'جاري نقل أرشيف الاختبارات المحفوظة...'
              : kind === 'quiz'
              ? 'جاري نقل نماذج «اختباراتي» مع الأشكال والرسوم...'
              : 'جاري نقل سجل المحاولات والتقارير...';
          onProgress({
            step,
            percent: calcPercent(),
            message: msg,
            detail: label,
          });
        },
      });

    // 4. Write Global Platform Pointer so ALL users on the source DB switch automatically to targetConfig!
    onProgress({
      step: 'finalizing',
      percent: 96,
      message: 'جاري اعتماد القاعدة الجديدة كقاعدة رسمية للمنصة ومزامنة التحويل...',
    });

    const priorChain = [activeFirebaseConfig, ...getPreviousFirebaseConfigs()]
      .filter((c) => !isSameFirebaseTarget(c, targetConfig))
      .slice(0, 6)
      .map((c) => ({
        apiKey: c.apiKey,
        authDomain: c.authDomain,
        projectId: c.projectId,
        appId: c.appId,
        ...(c.storageBucket ? { storageBucket: c.storageBucket } : {}),
        ...(c.messagingSenderId ? { messagingSenderId: c.messagingSenderId } : {}),
        ...(c.firestoreDatabaseId ? { firestoreDatabaseId: c.firestoreDatabaseId } : {}),
      }));

    const buildPointerPayload = (uidValue: string) => ({
      id: 'migration',
      projectId: targetConfig.projectId,
      apiKey: targetConfig.apiKey,
      authDomain: targetConfig.authDomain,
      appId: targetConfig.appId,
      ...(targetConfig.storageBucket ? { storageBucket: targetConfig.storageBucket } : {}),
      ...(targetConfig.messagingSenderId
        ? { messagingSenderId: targetConfig.messagingSenderId }
        : {}),
      ...(targetConfig.measurementId ? { measurementId: targetConfig.measurementId } : {}),
      ...(targetConfig.firestoreDatabaseId
        ? { firestoreDatabaseId: targetConfig.firestoreDatabaseId }
        : {}),
      migratedBy: uidValue,
      migratedByName: (resolvedQuadName || source.profile?.fullNameQuad || 'مشرف المنصة').slice(
        0,
        120
      ),
      ...(migratedRoomId ? { migratedRoomId: migratedRoomId.slice(0, 16) } : {}),
      migrationEpoch: CURRENT_DB_EPOCH,
      previousConfigs: priorChain,
      updatedAt: serverTimestamp(),
    });

    let platformPointerUpdated = false;
    try {
      await setDoc(doc(targetDb, 'platform', 'migration'), buildPointerPayload(targetUid));
    } catch {
      // Non-fatal if target project uses older rules
    }
    try {
      const srcUid = sourceAuth.currentUser?.uid;
      if (srcUid) {
        await withTimeout(
          setDoc(doc(sourceDb, 'platform', 'migration'), buildPointerPayload(srcUid)),
          3500
        );
        platformPointerUpdated = true;
      }
    } catch {
      // Source DB may have exceeded quota or have older rules — link & localStorage still work 100%
    }

    // Activate target database locally and mark previous DBs as already synced for this user
    const priorTargetKey = firebaseTargetKey(activeFirebaseConfig);
    activateCustomFirebaseConfig(targetConfig, migratedRoomId, priorChain as FirebaseAppConfig[]);
    markSourceKeySynced(targetUid, priorTargetKey);

    if (migratedRoomId) {
      try {
        localStorage.setItem(`duoboard_active_room_${targetUid}`, migratedRoomId);
      } catch {
        // Ignore storage errors
      }
    }

    const shareUrl = buildShareMigrationUrl(targetConfig, migratedRoomId);

    onProgress({
      step: 'done',
      percent: 100,
      message: 'اكتمل نقل المنصة بالكامل وتفعيل قاعدة البيانات الجديدة بنسبة 100%!',
    });

    return {
      targetConfig,
      targetUid,
      shareUrl,
      migratedRoomId,
      migratedRoomsCount,
      roomCreatedAsSupervisor,
      roomRejoinedAsStudent,
      roomPendingForStudent,
      migratedQuestionsCount,
      migratedSlidesCount,
      migratedLayersCount,
      migratedBoardsCount,
      migratedSharedQuizzesCount,
      migratedCompetitionsCount,
      migratedSavedTestsCount,
      migratedMyQuizzesCount,
      migratedAttemptsCount,
      platformPointerUpdated,
    };
  } catch (err) {
    throw classifyMigrationError(err, targetConfig.projectId);
  }
}

/**
 * Automatically syncs a user's personal account data (profile, myQuizzes, savedTests, quizAttempts)
 * from any previous Firebase databases in the migration chain (or IndexedDB snapshots) onto the
 * newly activated database when that user arrives via auto-switch or migration link.
 */
export async function syncPersonalAccountFromPreviousDbs(params: {
  targetUser: User;
  interactiveAuthIfNeeded?: boolean;
  onProgress?: (p: MigrationProgress) => void;
}): Promise<{ synced: boolean; count: number; needsInteractiveSignIn: boolean }> {
  const { targetUser, interactiveAuthIfNeeded = false, onProgress } = params;
  const targetUid = targetUser.uid;
  const previousConfigs = getPreviousFirebaseConfigs().filter(
    (c) => !isSameFirebaseTarget(c, activeFirebaseConfig)
  );
  if (previousConfigs.length === 0) {
    return { synced: false, count: 0, needsInteractiveSignIn: false };
  }

  const alreadySynced = getSyncedSourceKeys(targetUid);
  const pendingConfigs = previousConfigs.filter(
    (cfg) => !alreadySynced.includes(firebaseTargetKey(cfg))
  );
  if (pendingConfigs.length === 0) {
    return { synced: false, count: 0, needsInteractiveSignIn: false };
  }

  let totalSyncedItems = 0;
  let needsInteractiveSignIn = false;

  for (let i = 0; i < pendingConfigs.length; i++) {
    const srcCfg = pendingConfigs[i];
    const srcKey = firebaseTargetKey(srcCfg);
    try {
      const srcApp = getOrInitFirebaseApp(srcCfg);
      const srcAuth = getAuth(srcApp);
      const srcDb = createFirestoreInstance(srcApp, srcCfg);

      let srcUser = srcAuth.currentUser;
      if (!srcUser && interactiveAuthIfNeeded) {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        const cred = await signInWithPopup(srcAuth, provider);
        srcUser = cred.user;
      }

      if (!srcUser) {
        needsInteractiveSignIn = true;
        continue;
      }

      onProgress?.({
        step: 'collecting',
        percent: 25,
        message: 'جاري استيراد بياناتك واختباراتك تلقائياً إلى القاعدة الجديدة...',
        detail: srcCfg.projectId,
      });

      const srcData = await collectSourceData(
        srcDb,
        srcUser.uid,
        null,
        null,
        false,
        (p) => onProgress?.(p)
      );

      await migrateUserProfileToDb({
        targetDb: sourceDb,
        targetUser,
        fallbackProfile: srcData.profile,
      });

      const counts = await writePersonalCollectionsToDb({
        targetDb: sourceDb,
        targetUid,
        savedTests: srcData.savedTests,
        savedQuestionsByTestId: srcData.savedQuestionsByTestId,
        myQuizzes: srcData.myQuizzes,
        quizAttempts: srcData.quizAttempts,
      });

      totalSyncedItems +=
        counts.migratedSavedTestsCount +
        counts.migratedMyQuizzesCount +
        counts.migratedAttemptsCount;

      markSourceKeySynced(targetUid, srcKey);
    } catch {
      // Could be quota exceeded on old DB; try fallback from local IndexedDB below
    }
  }

  // Fallback: always push any local IndexedDB personal snapshots belonging to user onto the active DB
  if (totalSyncedItems === 0) {
    try {
      const cachedSaved = await loadSessionSnapshot<StoredSavedTestsSnapshot>('saved_tests');
      const cachedQuizzes = await loadSessionSnapshot<StoredMyQuizzesSnapshot>('my_quizzes');
      const cachedAttempts =
        await loadSessionSnapshot<StoredQuizAttemptsSnapshot>('quiz_attempts');

      const counts = await writePersonalCollectionsToDb({
        targetDb: sourceDb,
        targetUid,
        savedTests: cachedSaved?.tests ?? [],
        savedQuestionsByTestId: cachedSaved?.questionsByTestId ?? {},
        myQuizzes: cachedQuizzes?.quizzes ?? [],
        quizAttempts: cachedAttempts?.attempts ?? [],
      });
      totalSyncedItems +=
        counts.migratedSavedTestsCount +
        counts.migratedMyQuizzesCount +
        counts.migratedAttemptsCount;
    } catch {
      // Non-fatal
    }
  }

  return {
    synced: totalSyncedItems > 0,
    count: totalSyncedItems,
    needsInteractiveSignIn,
  };
}
