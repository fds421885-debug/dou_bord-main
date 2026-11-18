import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, type Auth, type User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
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
  defaultFirebaseConfig,
  encodeCompactFirebaseConfig,
  firebaseTargetKey,
  getPreviousFirebaseConfigs,
  getSyncedSourceKeys,
  getTargetFirebaseAppName,
  getTimestampMillis,
  isMasterProgrammerIdentity,
  isSameFirebaseTarget,
  markSourceKeySynced,
  MASTER_PROGRAMMER_EMAIL,
  MASTER_PROGRAMMER_NAME,
  normalizeArabicName,
  resolveLatestFirestoreMigrationRest,
  sanitizeFirebaseConfig,
  type FirebaseAppConfig,
  type ServerPlatformPointer,
} from './firebase';
import {
  loadAllQuizDrafts,
  loadSessionSnapshot,
  saveQuizDraft,
  saveSessionSnapshot,
  type StoredExamSession,
  type StoredMyQuizDraft,
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
  PlatformProgrammerState,
  PoolDatabaseEntry,
  ProgrammerMember,
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
    | 'cleaning_old'
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
  mergedSourceDbsCount: number;
  deletedOldDocsCount: number;
  oldAuthSignedOut: boolean;
  platformPointerUpdated: boolean;
  serverPointerUpdated: boolean;
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

export async function publishServerPlatformPointer(params: {
  config: FirebaseAppConfig;
  idToken: string;
  tokenProjectId: string;
  tokenApiKey: string;
  resetToDefault?: boolean;
  migratedRoomId?: string | null;
  previousConfigs?: FirebaseAppConfig[];
}): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 3500);
    const resp = await fetch('/api/platform-db', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.idToken}`,
      },
      body: JSON.stringify({
        config: params.config,
        tokenProjectId: params.tokenProjectId,
        tokenApiKey: params.tokenApiKey,
        resetToDefault: Boolean(params.resetToDefault),
        migratedRoomId: params.migratedRoomId || null,
        migrationEpoch: CURRENT_DB_EPOCH,
        previousConfigs: params.previousConfigs ?? [],
      }),
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

export async function publishServerResetToDefault(currentUser: User | null): Promise<boolean> {
  try {
    sessionStorage.setItem(
      'duoboard_self_migrated_target',
      firebaseTargetKey(defaultFirebaseConfig)
    );
  } catch {
    // Ignore sessionStorage restrictions
  }

  const prevChain = [activeFirebaseConfig, ...getPreviousFirebaseConfigs()]
    .filter(
      (c, idx, arr) =>
        !isSameFirebaseTarget(c, defaultFirebaseConfig) &&
        arr.findIndex((x) => isSameFirebaseTarget(x, c)) === idx
    )
    .slice(0, 6);

  if (!currentUser) {
    return false;
  }

  // Update Firestore pointer on current custom DB if possible (for static-host fallback)
  try {
    await withTimeout(
      setDoc(doc(sourceDb, 'platform', 'migration'), {
        id: 'migration',
        projectId: defaultFirebaseConfig.projectId,
        apiKey: defaultFirebaseConfig.apiKey,
        authDomain: defaultFirebaseConfig.authDomain,
        appId: defaultFirebaseConfig.appId,
        ...(defaultFirebaseConfig.storageBucket
          ? { storageBucket: defaultFirebaseConfig.storageBucket }
          : {}),
        ...(defaultFirebaseConfig.messagingSenderId
          ? { messagingSenderId: defaultFirebaseConfig.messagingSenderId }
          : {}),
        ...(defaultFirebaseConfig.measurementId
          ? { measurementId: defaultFirebaseConfig.measurementId }
          : {}),
        ...(defaultFirebaseConfig.firestoreDatabaseId
          ? { firestoreDatabaseId: defaultFirebaseConfig.firestoreDatabaseId }
          : {}),
        migratedBy: currentUser.uid,
        migratedByName: 'مشرف المنصة',
        migrationEpoch: CURRENT_DB_EPOCH,
        previousConfigs: prevChain,
        updatedAt: serverTimestamp(),
      }),
      2500
    );
  } catch {
    // Ignore if rules/quota restrict
  }

  try {
    const idToken = await currentUser.getIdToken();
    const ok = await publishServerPlatformPointer({
      config: defaultFirebaseConfig,
      idToken,
      tokenProjectId: activeFirebaseConfig.projectId,
      tokenApiKey: activeFirebaseConfig.apiKey,
      resetToDefault: true,
      previousConfigs: prevChain,
    });
    return ok;
  } catch {
    return false;
  }
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
    const savedQuestions = savedQuestionsByTestId[test.id] ?? [];

    if (existingSaved.exists()) {
      const existingData = existingSaved.data() as SavedTest;
      if (savedQuestions.length > (existingData.totalQuestions || 0)) {
        for (const sq of savedQuestions) {
          const sqRef = doc(targetDb, 'users', targetUid, 'savedTests', test.id, 'questions', sq.id);
          const sqSnap = await getDoc(sqRef);
          if (!sqSnap.exists()) {
            await setDoc(sqRef, cleanSavedQuestionForFirestore(sq, targetUid));
          }
        }
        await updateDoc(testRef, {
          totalQuestions: Math.min(200, Math.max(0, savedQuestions.length)),
          updatedAt: serverTimestamp(),
        });
      }
      migratedSavedTestsCount++;
      onItemDone?.('saved', test.title);
      continue;
    }

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
    const questions = quiz.questions.slice(0, 100).map(cleanQuizQuestionForFirestore);
    if (existingQuiz.exists()) {
      const existingData = existingQuiz.data() as MyQuiz;
      if (questions.length > (existingData.questionCount || existingData.questions?.length || 0)) {
        await updateDoc(quizRef, {
          title: (quiz.title || 'اختبار').slice(0, 120),
          questions,
          questionCount: questions.length,
          updatedAt: serverTimestamp(),
        });
      }
      migratedMyQuizzesCount++;
      onItemDone?.('quiz', quiz.title);
      continue;
    }
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

interface SourceDatabaseCleanupHandle {
  config: FirebaseAppConfig;
  db: Firestore;
  auth: Auth;
  uid: string;
  collected: CollectedSourceData;
}

async function safeDeleteDoc(ref: ReturnType<typeof doc>): Promise<boolean> {
  try {
    await withTimeout(deleteDoc(ref), 3500);
    return true;
  } catch {
    return false;
  }
}

async function cleanupMigratedPersonalDocsOnDb(params: {
  srcDb: Firestore;
  oldUid: string;
  savedTests: SavedTest[];
  savedQuestionsByTestId: Record<string, SavedQuestion[]>;
  myQuizzes: MyQuiz[];
  quizAttempts: QuizAttempt[];
  deleteProfile?: boolean;
}): Promise<number> {
  const {
    srcDb,
    oldUid,
    savedTests,
    savedQuestionsByTestId,
    myQuizzes,
    quizAttempts,
    deleteProfile = true,
  } = params;
  let deleted = 0;

  for (const quiz of myQuizzes) {
    if (await safeDeleteDoc(doc(srcDb, 'users', oldUid, 'myQuizzes', quiz.id))) deleted++;
  }

  for (const test of savedTests) {
    const qs = savedQuestionsByTestId[test.id] ?? [];
    for (const sq of qs) {
      if (
        await safeDeleteDoc(
          doc(srcDb, 'users', oldUid, 'savedTests', test.id, 'questions', sq.id)
        )
      ) {
        deleted++;
      }
    }
    if (await safeDeleteDoc(doc(srcDb, 'users', oldUid, 'savedTests', test.id))) deleted++;
  }

  for (const at of quizAttempts) {
    if (await safeDeleteDoc(doc(srcDb, 'users', oldUid, 'quizAttempts', at.id))) deleted++;
  }

  if (deleteProfile) {
    if (await safeDeleteDoc(doc(srcDb, 'users', oldUid, 'private', 'profile'))) deleted++;
  }

  return deleted;
}

async function cleanupMigratedRoomsOnDb(params: {
  srcDb: Firestore;
  oldUid: string;
  rooms: CollectedRoomData[];
}): Promise<number> {
  const { srcDb, oldUid, rooms } = params;
  let deleted = 0;

  for (const bundle of rooms) {
    const roomId = bundle.room.id;
    if (bundle.myRole === 'supervisor' || bundle.room.supervisorId === oldUid) {
      for (const slide of bundle.slides) {
        for (const l of bundle.slideLayers.filter((x) => x.slideId === slide.id)) {
          if (await safeDeleteDoc(doc(srcDb, 'rooms', roomId, 'slides', slide.id, 'layers', l.id))) {
            deleted++;
          }
        }
        if (await safeDeleteDoc(doc(srcDb, 'rooms', roomId, 'slides', slide.id))) deleted++;
      }

      for (const q of bundle.questions) {
        for (const b of bundle.boardsByQuestionId[q.id] ?? []) {
          if (
            await safeDeleteDoc(
              doc(srcDb, 'rooms', roomId, 'questions', q.id, 'boards', b.studentId)
            )
          ) {
            deleted++;
          }
        }
        if (await safeDeleteDoc(doc(srcDb, 'rooms', roomId, 'questions', q.id))) deleted++;
      }

      for (const el of bundle.explainLayers) {
        if (await safeDeleteDoc(doc(srcDb, 'rooms', roomId, 'explainLayers', el.id))) deleted++;
      }
      if (bundle.sharedBoard) {
        if (await safeDeleteDoc(doc(srcDb, 'rooms', roomId, 'sharedBoard', 'live'))) deleted++;
      }
      for (const sq of bundle.sharedQuizzes) {
        if (await safeDeleteDoc(doc(srcDb, 'rooms', roomId, 'sharedQuizzes', sq.id))) deleted++;
      }
      for (const comp of bundle.competitions) {
        const compQs = bundle.competitionQuestionsByCompId[comp.id] ?? [];
        for (const cq of compQs) {
          for (const cb of bundle.competitionBoardsByKey[`${comp.id}::${cq.id}`] ?? []) {
            if (
              await safeDeleteDoc(
                doc(
                  srcDb,
                  'rooms',
                  roomId,
                  'competitions',
                  comp.id,
                  'questions',
                  cq.id,
                  'boards',
                  cb.studentId
                )
              )
            ) {
              deleted++;
            }
          }
          if (
            await safeDeleteDoc(
              doc(srcDb, 'rooms', roomId, 'competitions', comp.id, 'questions', cq.id)
            )
          ) {
            deleted++;
          }
        }
        if (await safeDeleteDoc(doc(srcDb, 'rooms', roomId, 'competitions', comp.id))) deleted++;
      }
      for (const p of bundle.participants) {
        if (await safeDeleteDoc(doc(srcDb, 'rooms', roomId, 'participants', p.uid))) deleted++;
      }
      if (await safeDeleteDoc(doc(srcDb, 'rooms', roomId))) deleted++;
    } else {
      // Student cleanly leaves old room participation
      await safeDeleteDoc(doc(srcDb, 'rooms', roomId, 'participants', oldUid));
    }
  }

  return deleted;
}

export async function runFirebaseMigration(params: {
  targetConfig: FirebaseAppConfig;
  currentProfile: UserProfile | null;
  currentRoom: Room | null;
  isSupervisorInCurrentRoom: boolean;
  cleanupOldDatabase?: boolean;
  onProgress: (p: MigrationProgress) => void;
}): Promise<MigrationResult> {
  const {
    targetConfig,
    currentProfile,
    currentRoom,
    isSupervisorInCurrentRoom,
    cleanupOldDatabase = true,
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
    message: 'جاري تسجيل الدخول وربط قاعدة البيانات الجديدة...',
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
    percent: 13,
    message: 'جاري فحص وتجميع بيانات جميع القواعد (القديمة والحالية) والمحفوظات المحلية...',
  });

  const cachedProfile = await loadSessionSnapshot<StoredUserProfileSnapshot>('user_profile');
  const oldUid =
    currentProfile?.uid ?? sourceAuth.currentUser?.uid ?? cachedProfile?.uid ?? null;

  const primaryCollected = await collectSourceData(
    sourceDb,
    oldUid,
    currentProfile,
    currentRoom,
    isSupervisorInCurrentRoom,
    onProgress
  );

  // Also collect from every previously linked database that still has an active session so OLD + NEW merge completely!
  const sourceHandles: SourceDatabaseCleanupHandle[] = [];
  if (oldUid) {
    sourceHandles.push({
      config: activeFirebaseConfig,
      db: sourceDb,
      auth: sourceAuth,
      uid: oldUid,
      collected: primaryCollected,
    });
  }

  const candidateExtraConfigs = [defaultFirebaseConfig, ...getPreviousFirebaseConfigs()].filter(
    (cfg, idx, arr) =>
      !isSameFirebaseTarget(cfg, activeFirebaseConfig) &&
      !isSameFirebaseTarget(cfg, targetConfig) &&
      arr.findIndex((x) => isSameFirebaseTarget(x, cfg)) === idx
  );

  const extraCollections: CollectedSourceData[] = [];
  for (const extraCfg of candidateExtraConfigs) {
    try {
      const extraApp = getOrInitFirebaseApp(extraCfg);
      const extraAuth = getAuth(extraApp);
      const extraUser = extraAuth.currentUser;
      if (!extraUser) continue;
      const extraDb = createFirestoreInstance(extraApp, extraCfg);
      onProgress({
        step: 'collecting',
        percent: 20,
        message: 'جاري دمج البيانات من القواعد السابقة لضمان نقل الجديد والقديم...',
        detail: extraCfg.projectId,
      });
      const extraData = await collectSourceData(
        extraDb,
        extraUser.uid,
        null,
        null,
        false,
        () => undefined
      );
      extraCollections.push(extraData);
      sourceHandles.push({
        config: extraCfg,
        db: extraDb,
        auth: extraAuth,
        uid: extraUser.uid,
        collected: extraData,
      });
    } catch {
      // Non-fatal if a prior DB is offline or quota-limited
    }
  }

  // Merge primary + extra database collections (deduplicated, keeping most complete items)
  const mergedRoomsMap = new Map<string, CollectedRoomData>();
  const mergedSavedTestsMap = new Map<string, SavedTest>();
  const mergedSavedQuestionsMap: Record<string, SavedQuestion[]> = {
    ...primaryCollected.savedQuestionsByTestId,
  };
  const mergedMyQuizzesMap = new Map<string, MyQuiz>();
  const mergedAttemptsMap = new Map<string, QuizAttempt>();

  for (const bundle of [primaryCollected, ...extraCollections]) {
    for (const r of bundle.rooms) {
      const existing = mergedRoomsMap.get(r.room.id);
      if (
        !existing ||
        r.questions.length + r.slides.length > existing.questions.length + existing.slides.length
      ) {
        mergedRoomsMap.set(r.room.id, r);
      }
    }
    for (const st of bundle.savedTests) {
      const existing = mergedSavedTestsMap.get(st.id);
      const qs = bundle.savedQuestionsByTestId[st.id] ?? [];
      const prevQs = mergedSavedQuestionsMap[st.id] ?? [];
      if (qs.length > prevQs.length) {
        mergedSavedQuestionsMap[st.id] = qs;
      }
      if (!existing || (st.totalQuestions || 0) >= (existing.totalQuestions || 0)) {
        mergedSavedTestsMap.set(st.id, st);
      }
    }
    for (const mq of bundle.myQuizzes) {
      const existing = mergedMyQuizzesMap.get(mq.id);
      if (!existing || (mq.questions?.length ?? 0) >= (existing.questions?.length ?? 0)) {
        mergedMyQuizzesMap.set(mq.id, mq);
      }
    }
    for (const at of bundle.quizAttempts) {
      if (!mergedAttemptsMap.has(at.id)) {
        mergedAttemptsMap.set(at.id, at);
      }
    }
  }

  const source: CollectedSourceData = {
    oldUid: primaryCollected.oldUid,
    profile:
      primaryCollected.profile ??
      extraCollections.find((c) => c.profile)?.profile ??
      null,
    primaryRoomId: primaryCollected.primaryRoomId,
    rooms: Array.from(mergedRoomsMap.values()),
    savedTests: Array.from(mergedSavedTestsMap.values()),
    savedQuestionsByTestId: mergedSavedQuestionsMap,
    myQuizzes: Array.from(mergedMyQuizzesMap.values()),
    quizAttempts: Array.from(mergedAttemptsMap.values()),
  };
  const mergedSourceDbsCount = Math.max(1, sourceHandles.length);
  const allOldUids = Array.from(
    new Set([oldUid, ...sourceHandles.map((h) => h.uid)].filter((x): x is string => Boolean(x)))
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
  const calcPercent = () => Math.min(93, 25 + Math.round((completedUnits / totalUnits) * 68));

  try {
    // 1. Migrate User Profile
    onProgress({
      step: 'migrating_profile',
      percent: 25,
      message: 'جاري نقل بيانات الحساب الشخصي وتثبيت تسجيل الدخول...',
    });

    const resolvedQuadName = await migrateUserProfileToDb({
      targetDb,
      targetUser,
      fallbackProfile: source.profile,
    });
    completedUnits++;

    // Re-key ALL local drafts & session snapshots to targetUid (PDFs, selected pages, exams, unsaved quizzes)
    const allDrafts = await loadAllQuizDrafts();
    for (const d of allDrafts) {
      const matchedOld = allOldUids.find((u) => u !== targetUid && d.key.endsWith(`_${u}`));
      if (matchedOld) {
        const newKey = d.key.slice(0, d.key.length - matchedOld.length) + targetUid;
        await saveQuizDraft({
          ...d,
          key: newKey,
          updatedAt: Date.now(),
        });
      }
    }
    try {
      const myQuizDraft = await loadSessionSnapshot<StoredMyQuizDraft>('my_quiz_draft');
      if (myQuizDraft && myQuizDraft.ownerId !== targetUid) {
        await saveSessionSnapshot({ ...myQuizDraft, ownerId: targetUid, updatedAt: Date.now() });
      }
      const examSession = await loadSessionSnapshot<StoredExamSession>('exam_session');
      if (examSession && examSession.ownerId !== targetUid) {
        await saveSessionSnapshot({ ...examSession, ownerId: targetUid, updatedAt: Date.now() });
      }
      if (source.savedTests.length > 0) {
        await saveSessionSnapshot({
          key: 'saved_tests',
          ownerId: targetUid,
          tests: source.savedTests.slice(0, 200),
          questionsByTestId: source.savedQuestionsByTestId,
          updatedAt: Date.now(),
        });
      }
      if (source.myQuizzes.length > 0) {
        await saveSessionSnapshot({
          key: 'my_quizzes',
          ownerId: targetUid,
          quizzes: source.myQuizzes,
          updatedAt: Date.now(),
        });
      }
      if (source.quizAttempts.length > 0) {
        await saveSessionSnapshot({
          key: 'quiz_attempts',
          ownerId: targetUid,
          attempts: source.quizAttempts,
          updatedAt: Date.now(),
        });
      }
    } catch {
      // Non-fatal IndexedDB re-key
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
                (allOldUids.includes(l.authorId) || l.authorId === targetUid)
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
            (l) => allOldUids.includes(l.authorId) || l.authorId === targetUid
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

                if (
                  cq.status === 'correct' ||
                  cq.status === 'unanswered' ||
                  (cq.wrongPlayerIds?.length ?? 0) > 0 ||
                  (cq.attempts?.length ?? 0) > 0
                ) {
                  try {
                    await updateDoc(cqRef, {
                      status: cq.status || 'solving',
                      winnerId: (cq.winnerId || '').slice(0, 128),
                      winnerName: (cq.winnerName || '').slice(0, 120),
                      winnerChoiceIndex: Number.isInteger(cq.winnerChoiceIndex)
                        ? Math.max(-1, Math.min(7, cq.winnerChoiceIndex))
                        : -1,
                      winnerTimeMs: Math.max(0, Math.min(172800000, Math.round(cq.winnerTimeMs || 0))),
                      wrongPlayerIds: (cq.wrongPlayerIds || []).slice(0, 100),
                      attempts: (cq.attempts || []).slice(0, 100),
                      updatedAt: serverTimestamp(),
                    });
                  } catch {
                    // Fallback gracefully if competitor check rejects historical owner mismatch
                  }
                }

                const cbList = roomBundle.competitionBoardsByKey[`${comp.id}::${cq.id}`] ?? [];
                const myCompBoard = cbList.find(
                  (b) => allOldUids.includes(b.studentId) || b.studentId === targetUid
                );
                if (myCompBoard && (myCompBoard.strokes?.length ?? 0) > 0) {
                  try {
                    await setDoc(
                      doc(
                        targetDb,
                        'rooms',
                        srcRoom.id,
                        'competitions',
                        comp.id,
                        'questions',
                        cq.id,
                        'boards',
                        targetUid
                      ),
                      {
                        studentId: targetUid,
                        studentName: supervisorDisplayName.slice(0, 120),
                        roomId: srcRoom.id,
                        questionId: cq.id,
                        strokes: myCompBoard.strokes.slice(-400),
                        submitted: Boolean(myCompBoard.submitted),
                        verdict: 'pending',
                        updatedAt: serverTimestamp(),
                      }
                    );
                    migratedBoardsCount++;
                  } catch {
                    // Ignore competition board lock
                  }
                }
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

          if (Array.isArray(srcRoom.explainBlockedIds) && srcRoom.explainBlockedIds.length > 0) {
            await updateDoc(targetRoomRef, {
              explainBlockedIds: srcRoom.explainBlockedIds.slice(0, 100),
              updatedAt: serverTimestamp(),
            });
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
                (b) => allOldUids.includes(b.studentId) || b.studentId === targetUid
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

    // 4. Write Global Platform Pointer across ALL connected source DBs so EVERY user on EVERY old DB jumps to targetConfig!
    onProgress({
      step: 'finalizing',
      percent: 94,
      message: 'جاري اعتماد القاعدة الجديدة لجميع المستخدمين على كل القواعد وتوحيد تسجيل الدخول...',
    });

    const priorChain = [activeFirebaseConfig, defaultFirebaseConfig, ...getPreviousFirebaseConfigs()]
      .filter(
        (c, idx, arr) =>
          !isSameFirebaseTarget(c, targetConfig) &&
          arr.findIndex((x) => isSameFirebaseTarget(x, c)) === idx
      )
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
      migratedByName: 'مشرف المنصة',
      ...(migratedRoomId ? { migratedRoomId: migratedRoomId.slice(0, 16) } : {}),
      migrationEpoch: CURRENT_DB_EPOCH,
      previousConfigs: priorChain,
      updatedAt: serverTimestamp(),
    });

    // Mark this tab as the initiator so it shows the 100% summary instead of mid-modal auto-reloading
    try {
      sessionStorage.setItem(
        'duoboard_self_migrated_target',
        firebaseTargetKey(targetConfig)
      );
    } catch {
      // Ignore sessionStorage restrictions
    }

    let serverPointerUpdated = false;
    try {
      const idToken = await targetUser.getIdToken();
      serverPointerUpdated = await publishServerPlatformPointer({
        config: targetConfig,
        idToken,
        tokenProjectId: targetConfig.projectId,
        tokenApiKey: targetConfig.apiKey,
        migratedRoomId,
        previousConfigs: priorChain as FirebaseAppConfig[],
      });
    } catch {
      // Fallback gracefully on static hosts without backend server
    }

    let platformPointerUpdated = false;
    try {
      await setDoc(doc(targetDb, 'platform', 'migration'), buildPointerPayload(targetUid));
      platformPointerUpdated = true;
    } catch {
      // Non-fatal if target project uses older rules
    }

    // Mirror pool metadata onto targetDb & current local cache if available
    try {
      const localPool = loadLocalServerlessPool();
      if (localPool) {
        const syncedPool = ensurePoolDefaults({
          ...localPool,
          revision: localPool.revision + 1,
          updatedAt: Date.now(),
        });
        const matchedTarget = syncedPool.databases.find((d) =>
          isSameFirebaseTarget(d.config, targetConfig)
        );
        if (matchedTarget) {
          syncedPool.activeDatabaseId = matchedTarget.id;
          syncedPool.allExhausted = false;
          matchedTarget.exhaustedAt = null;
          matchedTarget.exhaustedUntil = null;
        }
        saveLocalServerlessPool(syncedPool);
        await writeFirestorePoolDoc(targetDb, syncedPool, targetUid, resolvedQuadName || 'مبرمج المنصة').catch(
          () => undefined
        );
      }
    } catch {
      // Non-fatal pool mirror
    }

    for (const handle of sourceHandles) {
      if (isSameFirebaseTarget(handle.config, targetConfig)) continue;
      try {
        await withTimeout(
          setDoc(doc(handle.db, 'platform', 'migration'), buildPointerPayload(handle.uid)),
          3500
        );
        platformPointerUpdated = true;
      } catch {
        // Older project rules or quota limit on one DB — continue smoothly
      }
    }

    // 5. Verified Old Database Cleanup & Unbind Old Login Auth (ONLY after 100% target writes succeed!)
    let deletedOldDocsCount = 0;
    let oldAuthSignedOut = false;

    if (cleanupOldDatabase) {
      onProgress({
        step: 'cleaning_old',
        percent: 97,
        message: 'جاري حذف البيانات المنقولة من القواعد القديمة وفك ربط تسجيل الدخول بها...',
      });

      for (const handle of sourceHandles) {
        if (isSameFirebaseTarget(handle.config, targetConfig)) continue;
        deletedOldDocsCount += await cleanupMigratedRoomsOnDb({
          srcDb: handle.db,
          oldUid: handle.uid,
          rooms: handle.collected.rooms,
        });
        deletedOldDocsCount += await cleanupMigratedPersonalDocsOnDb({
          srcDb: handle.db,
          oldUid: handle.uid,
          savedTests: handle.collected.savedTests,
          savedQuestionsByTestId: handle.collected.savedQuestionsByTestId,
          myQuizzes: handle.collected.myQuizzes,
          quizAttempts: handle.collected.quizAttempts,
          deleteProfile: true,
        });
        try {
          await signOut(handle.auth);
          oldAuthSignedOut = true;
        } catch {
          // Ignore signOut errors on detached DB
        }
      }
    } else {
      for (const handle of sourceHandles) {
        if (isSameFirebaseTarget(handle.config, targetConfig)) continue;
        try {
          await signOut(handle.auth);
          oldAuthSignedOut = true;
        } catch {
          // Ignore
        }
      }
    }

    // Activate target database locally and mark all merged source DBs as synced for targetUid
    activateCustomFirebaseConfig(targetConfig, migratedRoomId, priorChain as FirebaseAppConfig[]);
    for (const handle of sourceHandles) {
      markSourceKeySynced(targetUid, firebaseTargetKey(handle.config));
      try {
        if (handle.uid !== targetUid) {
          localStorage.removeItem(`duoboard_active_room_${handle.uid}`);
        }
      } catch {
        // Ignore storage errors
      }
    }

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
      message: 'اكتمل النقل 100% وتم ربط القاعدة الجديدة بتسجيل الدخول وكافة البيانات!',
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
      mergedSourceDbsCount,
      deletedOldDocsCount,
      oldAuthSignedOut,
      platformPointerUpdated,
      serverPointerUpdated,
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

      // Also clean up migrated personal docs from the old DB and disconnect old Auth
      if (counts.migratedSavedTestsCount > 0 || counts.migratedMyQuizzesCount > 0 || counts.migratedAttemptsCount > 0 || srcData.profile) {
        await cleanupMigratedPersonalDocsOnDb({
          srcDb,
          oldUid: srcUser.uid,
          savedTests: srcData.savedTests,
          savedQuestionsByTestId: srcData.savedQuestionsByTestId,
          myQuizzes: srcData.myQuizzes,
          quizAttempts: srcData.quizAttempts,
          deleteProfile: true,
        });
      }
      try {
        await signOut(srcAuth);
      } catch {
        // Ignore signOut errors on detached old DB
      }

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

/**
 * Restores a supervisor's active room & cached questions/slides from IndexedDB
 * onto the newly rotated database when auto-failover happens mid-session.
 */
export async function restoreActiveSupervisorRoomFromSnapshot(params: {
  targetUser: User;
  resolvedQuadName: string;
  roomId: string;
}): Promise<boolean> {
  const { targetUser, resolvedQuadName, roomId } = params;
  try {
    const cachedRoom = await loadSessionSnapshot<StoredRoomSnapshot>('active_room');
    if (!cachedRoom || cachedRoom.room?.id !== roomId || cachedRoom.myRole !== 'supervisor') {
      return false;
    }
    const roomRef = doc(sourceDb, 'rooms', roomId);
    const existing = await getDoc(roomRef);
    if (existing.exists()) return true;

    const srcRoom = cachedRoom.room;
    const supervisorDisplay =
      resolvedQuadName && resolvedQuadName.length >= 5
        ? resolvedQuadName
        : srcRoom.supervisorName || 'مشرف المنصة';

    await setDoc(roomRef, {
      id: srcRoom.id,
      title: (srcRoom.title || 'جلسة مستعادة').slice(0, 120),
      supervisorId: targetUser.uid,
      supervisorName: supervisorDisplay.slice(0, 120),
      status: srcRoom.status === 'active' ? 'active' : 'waiting',
      sessionType: srcRoom.sessionType || 'quiz',
      mode: srcRoom.mode === 'competition' ? 'competition' : 'quiz',
      explainPresenterId: targetUser.uid,
      explainPresenterName: supervisorDisplay.slice(0, 120),
      interactiveEditor:
        srcRoom.sessionType === 'interactive' && srcRoom.interactiveEditor === 'all'
          ? 'all'
          : 'supervisor',
      interactiveEditorName:
        srcRoom.sessionType === 'interactive' && srcRoom.interactiveEditor === 'all'
          ? 'الجميع'
          : supervisorDisplay.slice(0, 120),
      currentSlideIndex: Math.min(100, Math.max(0, srcRoom.currentSlideIndex ?? 0)),
      slideCount: Math.min(100, Math.max(cachedRoom.slides.length, srcRoom.slideCount ?? 0)),
      currentQuestionId: srcRoom.currentQuestionId || '',
      questionCount: Math.min(200, Math.max(cachedRoom.questions.length, srcRoom.questionCount ?? 0)),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    for (const slide of cachedRoom.slides) {
      if (!slide.imageData || slide.imageData.length > 480000) continue;
      await setDoc(doc(sourceDb, 'rooms', srcRoom.id, 'slides', slide.id), {
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
    }

    for (const q of cachedRoom.questions) {
      const sanitizedChart = q.chart ? sanitizeChart(q.chart) : null;
      const sanitizedFigure = q.figure ? sanitizeFigure(q.figure) : null;
      const sanitizedChoices =
        Array.isArray(q.choices) && q.choices.length > 0
          ? q.choices.map((c) => String(c).slice(0, 500)).slice(0, 8)
          : null;
      await setDoc(doc(sourceDb, 'rooms', srcRoom.id, 'questions', q.id), {
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
    }

    return true;
  } catch {
    return false;
  }
}

const STATIC_POOL_STORAGE_KEY = 'duoboard_static_programmer_pool_v1';
const STATIC_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;

class ApiUnavailableError extends Error {
  constructor(message = 'Backend server unavailable') {
    super(message);
    this.name = 'ApiUnavailableError';
  }
}

type StoredProgrammerWithHash = ProgrammerMember & {
  emailHash?: string;
  emailMasked?: string;
};

async function sha256Hex(value: string): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoded = new TextEncoder().encode(value.trim().toLowerCase());
      const buf = await crypto.subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    // Fallback if subtle crypto unavailable
  }
  return '';
}

function maskEmailAddress(email: string): string {
  const clean = email.trim().toLowerCase();
  const [local, domain] = clean.split('@');
  if (!local || !domain) return '';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

function loadLocalServerlessPool(): PlatformProgrammerState | null {
  try {
    const raw = localStorage.getItem(STATIC_POOL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlatformProgrammerState>;
    if (!parsed || !Array.isArray(parsed.databases) || parsed.databases.length === 0) {
      return null;
    }
    return parsed as PlatformProgrammerState;
  } catch {
    return null;
  }
}

function saveLocalServerlessPool(state: PlatformProgrammerState): void {
  try {
    localStorage.setItem(STATIC_POOL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
}

function ensurePoolDefaults(raw: Partial<PlatformProgrammerState> | null): PlatformProgrammerState {
  const now = Date.now();
  const dbs: PoolDatabaseEntry[] = [];
  const rawDbs = Array.isArray(raw?.databases) ? raw!.databases : [];

  for (const item of rawDbs) {
    if (!item || typeof item !== 'object') continue;
    const cfg = sanitizeFirebaseConfig(item.config);
    if (!cfg) continue;
    if (dbs.some((x) => isSameFirebaseTarget(x.config, cfg))) continue;
    const exhaustedUntil =
      typeof item.exhaustedUntil === 'number' && item.exhaustedUntil > now
        ? item.exhaustedUntil
        : null;
    const exhaustedAt = exhaustedUntil ? item.exhaustedAt ?? now : null;
    dbs.push({
      id: typeof item.id === 'string' && item.id ? item.id : `db_${dbs.length + 1}`,
      order: dbs.length + 1,
      label:
        typeof item.label === 'string' && item.label.trim()
          ? item.label.trim().slice(0, 80)
          : isSameFirebaseTarget(cfg, defaultFirebaseConfig)
          ? 'القاعدة الأساسية (#1)'
          : cfg.projectId,
      config: cfg,
      exhaustedAt,
      exhaustedUntil,
      addedByEmail: typeof item.addedByEmail === 'string' ? item.addedByEmail : undefined,
      addedAt: typeof item.addedAt === 'number' ? item.addedAt : now,
    });
  }

  if (!dbs.some((d) => isSameFirebaseTarget(d.config, defaultFirebaseConfig))) {
    dbs.unshift({
      id: 'primary_default',
      order: 1,
      label: 'القاعدة الأساسية (#1)',
      config: defaultFirebaseConfig,
      exhaustedAt: null,
      exhaustedUntil: null,
      addedAt: now,
    });
  }

  // Ensure any previously visited / active configs are also present in the pool
  for (const extraCfg of [activeFirebaseConfig, ...getPreviousFirebaseConfigs()]) {
    if (extraCfg && !dbs.some((d) => isSameFirebaseTarget(d.config, extraCfg))) {
      dbs.push({
        id: `db_${dbs.length + 1}_${extraCfg.projectId}`,
        order: dbs.length + 1,
        label: extraCfg.projectId,
        config: extraCfg,
        exhaustedAt: null,
        exhaustedUntil: null,
        addedAt: now,
      });
    }
  }

  const renumbered = dbs.map((d, idx) => ({ ...d, order: idx + 1 }));
  const matchedActive =
    renumbered.find((d) => d.id === raw?.activeDatabaseId) ||
    renumbered.find((d) => isSameFirebaseTarget(d.config, activeFirebaseConfig)) ||
    renumbered[0];

  const rawProgs = Array.isArray(raw?.programmers) ? raw!.programmers : [];
  const programmers: StoredProgrammerWithHash[] = [];
  for (const p of rawProgs as StoredProgrammerWithHash[]) {
    if (!p || typeof p !== 'object') continue;
    programmers.push({
      id: typeof p.id === 'string' && p.id ? p.id : `prog_${programmers.length + 1}`,
      fullNameQuad: typeof p.fullNameQuad === 'string' ? p.fullNameQuad.trim() : '',
      ...(typeof p.email === 'string' && p.email.trim() ? { email: p.email.trim().toLowerCase() } : {}),
      ...(typeof p.emailHash === 'string' && p.emailHash ? { emailHash: p.emailHash } : {}),
      ...(typeof p.emailMasked === 'string' && p.emailMasked ? { emailMasked: p.emailMasked } : {}),
      isMaster: Boolean(p.isMaster),
      promotedBy: typeof p.promotedBy === 'string' ? p.promotedBy : undefined,
      promotedAt: typeof p.promotedAt === 'number' ? p.promotedAt : now,
    });
  }

  const hasMaster = programmers.some((p) =>
    isMasterProgrammerIdentity({ email: p.email, fullNameQuad: p.fullNameQuad })
  );
  if (!hasMaster) {
    programmers.unshift({
      id: 'master_programmer',
      fullNameQuad: MASTER_PROGRAMMER_NAME,
      email: MASTER_PROGRAMMER_EMAIL,
      isMaster: true,
      promotedAt: now,
    });
  }

  const allExhausted = renumbered.every((d) => d.exhaustedAt !== null);

  return {
    revision: typeof raw?.revision === 'number' && raw.revision >= 1 ? raw.revision : 1,
    databases: renumbered,
    activeDatabaseId: matchedActive.id,
    allExhausted: Boolean(raw?.allExhausted) && allExhausted,
    programmers,
    updatedByEmail: typeof raw?.updatedByEmail === 'string' ? raw.updatedByEmail : undefined,
    updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : now,
  };
}

async function writeFirestorePoolDoc(
  targetDb: Firestore,
  state: PlatformProgrammerState,
  uid: string,
  updaterName: string
): Promise<boolean> {
  try {
    const cleanDbs = state.databases.slice(0, 25).map((d) => ({
      id: d.id,
      order: d.order,
      label: (d.label || d.config.projectId).slice(0, 80),
      config: {
        apiKey: d.config.apiKey,
        authDomain: d.config.authDomain,
        projectId: d.config.projectId,
        appId: d.config.appId,
        ...(d.config.storageBucket ? { storageBucket: d.config.storageBucket } : {}),
        ...(d.config.messagingSenderId ? { messagingSenderId: d.config.messagingSenderId } : {}),
        ...(d.config.measurementId ? { measurementId: d.config.measurementId } : {}),
        ...(d.config.firestoreDatabaseId
          ? { firestoreDatabaseId: d.config.firestoreDatabaseId }
          : {}),
      },
      addedAt: d.addedAt || Date.now(),
    }));

    const cleanProgrammers = await Promise.all(
      (state.programmers as StoredProgrammerWithHash[]).slice(0, 25).map(async (p) => {
        const emailHash = p.emailHash || (p.email ? await sha256Hex(p.email) : '');
        const emailMasked = p.emailMasked || (p.email ? maskEmailAddress(p.email) : '');
        return {
          id: p.id,
          fullNameQuad: (p.fullNameQuad || '').slice(0, 120),
          ...(emailHash ? { emailHash } : {}),
          ...(emailMasked ? { emailMasked } : {}),
          isMaster: Boolean(p.isMaster),
          promotedAt: p.promotedAt || Date.now(),
        };
      })
    );

    const exhaustedDatabaseIds = state.databases
      .filter((d) => d.exhaustedAt !== null)
      .map((d) => d.id)
      .slice(0, 25);

    await setDoc(doc(targetDb, 'platform', 'pool'), {
      id: 'pool',
      revision: Math.min(1000000, Math.max(1, state.revision || 1)),
      activeDatabaseId: state.activeDatabaseId,
      allExhausted: Boolean(state.allExhausted),
      databases: cleanDbs,
      exhaustedDatabaseIds,
      programmers: cleanProgrammers,
      updatedBy: uid,
      updatedByName: (updaterName || 'مبرمج المنصة').slice(0, 120),
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch {
    return false;
  }
}

async function writeFirestoreMigrationPointerDoc(
  targetDb: Firestore,
  targetConfig: FirebaseAppConfig,
  poolDbs: PoolDatabaseEntry[],
  uid: string,
  updaterName: string,
  migratedRoomId?: string | null
): Promise<boolean> {
  try {
    const priorChain = [
      ...poolDbs.map((d) => d.config as FirebaseAppConfig),
      defaultFirebaseConfig,
      activeFirebaseConfig,
      ...getPreviousFirebaseConfigs(),
    ]
      .filter(
        (c, idx, arr) =>
          !isSameFirebaseTarget(c, targetConfig) &&
          arr.findIndex((x) => isSameFirebaseTarget(x, c)) === idx
      )
      .slice(0, 10)
      .map((c) => ({
        apiKey: c.apiKey,
        authDomain: c.authDomain,
        projectId: c.projectId,
        appId: c.appId,
        ...(c.storageBucket ? { storageBucket: c.storageBucket } : {}),
        ...(c.messagingSenderId ? { messagingSenderId: c.messagingSenderId } : {}),
        ...(c.firestoreDatabaseId ? { firestoreDatabaseId: c.firestoreDatabaseId } : {}),
      }));

    await setDoc(doc(targetDb, 'platform', 'migration'), {
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
      migratedBy: uid,
      migratedByName: (updaterName || 'مبرمج المنصة').slice(0, 120),
      ...(migratedRoomId ? { migratedRoomId: migratedRoomId.slice(0, 16) } : {}),
      migrationEpoch: CURRENT_DB_EPOCH,
      previousConfigs: priorChain,
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch {
    return false;
  }
}

async function readCloudPoolDoc(targetDb: Firestore): Promise<PlatformProgrammerState | null> {
  try {
    const snap = await getDoc(doc(targetDb, 'platform', 'pool'));
    if (!snap.exists()) return null;
    const raw = snap.data() as Record<string, unknown>;
    const exhaustedIds = Array.isArray(raw.exhaustedDatabaseIds)
      ? (raw.exhaustedDatabaseIds as string[])
      : [];
    const rawDbs = Array.isArray(raw.databases) ? (raw.databases as PoolDatabaseEntry[]) : [];
    const hydratedDbs = rawDbs.map((d) => ({
      ...d,
      exhaustedAt: exhaustedIds.includes(d.id) ? Date.now() : null,
      exhaustedUntil: exhaustedIds.includes(d.id)
        ? Date.now() + STATIC_QUOTA_COOLDOWN_MS
        : null,
    }));
    const rawProgs = Array.isArray(raw.programmers)
      ? (raw.programmers as StoredProgrammerWithHash[])
      : [];

    const hydratedProgs = rawProgs.map((p) => ({
      ...p,
      email:
        p.email ||
        (isMasterProgrammerIdentity({ fullNameQuad: p.fullNameQuad })
          ? MASTER_PROGRAMMER_EMAIL
          : p.emailMasked),
    }));

    return ensurePoolDefaults({
      revision: typeof raw.revision === 'number' ? raw.revision : 1,
      databases: hydratedDbs,
      activeDatabaseId: typeof raw.activeDatabaseId === 'string' ? raw.activeDatabaseId : undefined,
      allExhausted: Boolean(raw.allExhausted),
      programmers: hydratedProgs,
      updatedAt: getTimestampMillis(raw.updatedAt) || Date.now(),
    });
  } catch {
    return null;
  }
}

async function loadServerlessPoolState(): Promise<PlatformProgrammerState> {
  const local = loadLocalServerlessPool();
  const cloud = await readCloudPoolDoc(sourceDb);
  const rest = await resolveLatestFirestoreMigrationRest().catch(() => null);

  let base: PlatformProgrammerState;
  if (cloud && (!local || cloud.revision > local.revision || cloud.updatedAt > local.updatedAt)) {
    base = cloud;
  } else if (local) {
    base = local;
  } else {
    base = ensurePoolDefaults(null);
  }

  if (rest) {
    const extraCfgs = [rest.config, ...rest.previousConfigs];
    const dbs = [...base.databases];
    for (const c of extraCfgs) {
      if (!dbs.some((d) => isSameFirebaseTarget(d.config, c))) {
        dbs.push({
          id: `db_${dbs.length + 1}_${c.projectId}`,
          order: dbs.length + 1,
          label: isSameFirebaseTarget(c, defaultFirebaseConfig)
            ? 'القاعدة الأساسية (#1)'
            : c.projectId,
          config: c,
          exhaustedAt: null,
          exhaustedUntil: null,
          addedAt: Date.now(),
        });
      }
    }
    const activeEntry = dbs.find((d) => isSameFirebaseTarget(d.config, rest.config));
    base = ensurePoolDefaults({
      ...base,
      databases: dbs,
      activeDatabaseId: activeEntry ? activeEntry.id : base.activeDatabaseId,
    });
  } else {
    base = ensurePoolDefaults(base);
  }

  saveLocalServerlessPool(base);
  return base;
}

async function isIdentityProgrammerServerless(
  state: PlatformProgrammerState,
  identity: { email?: string | null; fullNameQuad?: string | null }
): Promise<{ isProgrammer: boolean; isMaster: boolean }> {
  if (isMasterProgrammerIdentity(identity)) {
    return { isProgrammer: true, isMaster: true };
  }
  const emailLower = (identity.email || '').trim().toLowerCase();
  const emailHash = emailLower ? await sha256Hex(emailLower) : '';
  const normName = normalizeArabicName(identity.fullNameQuad);

  const matched = (state.programmers as StoredProgrammerWithHash[]).some((m) => {
    if (emailLower && m.email && m.email.toLowerCase() === emailLower) return true;
    if (emailHash && m.emailHash && m.emailHash === emailHash) return true;
    if (normName && m.fullNameQuad && normalizeArabicName(m.fullNameQuad) === normName) return true;
    return false;
  });
  return { isProgrammer: matched, isMaster: false };
}

function buildPointerFromEntry(
  entry: PoolDatabaseEntry,
  state: PlatformProgrammerState,
  migratedRoomId?: string | null
): ServerPlatformPointer {
  return {
    id: 'migration',
    config: entry.config as FirebaseAppConfig,
    resetToDefault: isSameFirebaseTarget(entry.config, defaultFirebaseConfig),
    migratedRoomId: migratedRoomId || null,
    migrationEpoch: CURRENT_DB_EPOCH,
    previousConfigs: state.databases
      .filter((d) => d.id !== entry.id)
      .map((d) => d.config as FirebaseAppConfig)
      .slice(0, 10),
    activeDatabaseId: entry.id,
    activeOrder: entry.order,
    totalDatabases: state.databases.length,
    allExhausted: state.allExhausted,
    revision: state.revision,
    updatedAt: state.updatedAt,
  };
}

export async function triggerAutomaticQuotaFailover(params: {
  failedProjectId: string;
  failedFirestoreDatabaseId?: string;
}): Promise<{
  rotated: boolean;
  allExhausted: boolean;
  pointer?: ServerPlatformPointer | null;
} | null> {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 3500);
    const resp = await fetch('/api/platform-db/failover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        failedProjectId: params.failedProjectId,
        failedFirestoreDatabaseId: params.failedFirestoreDatabaseId || '',
      }),
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    const contentType = resp.headers.get('content-type') || '';
    if (resp.ok && contentType.includes('application/json')) {
      return (await resp.json()) as {
        rotated: boolean;
        allExhausted: boolean;
        pointer?: ServerPlatformPointer | null;
      };
    }
  } catch {
    // Static host (GitHub Pages / Netlify) — run serverless circular failover below
  }

  // Serverless circular failover across pool
  try {
    const state = await loadServerlessPoolState();
    const now = Date.now();
    const currentIdx = Math.max(
      0,
      state.databases.findIndex((d) => d.id === state.activeDatabaseId)
    );
    const currentEntry = state.databases[currentIdx];
    if (!currentEntry) return null;

    currentEntry.exhaustedAt = now;
    currentEntry.exhaustedUntil = now + STATIC_QUOTA_COOLDOWN_MS;

    const total = state.databases.length;
    let nextEntry: PoolDatabaseEntry | null = null;
    for (let offset = 1; offset < total; offset++) {
      const candidate = state.databases[(currentIdx + offset) % total];
      if (candidate.exhaustedAt === null) {
        nextEntry = candidate;
        break;
      }
    }

    if (nextEntry) {
      state.activeDatabaseId = nextEntry.id;
      state.allExhausted = false;
    } else {
      state.allExhausted = true;
    }
    state.revision += 1;
    state.updatedAt = now;
    saveLocalServerlessPool(state);

    const uid = sourceAuth.currentUser?.uid;
    if (uid) {
      await writeFirestorePoolDoc(
        sourceDb,
        state,
        uid,
        sourceAuth.currentUser?.displayName || 'تبديل تلقائي'
      ).catch(() => undefined);
      if (nextEntry) {
        await writeFirestoreMigrationPointerDoc(
          sourceDb,
          nextEntry.config as FirebaseAppConfig,
          state.databases,
          uid,
          sourceAuth.currentUser?.displayName || 'تبديل تلقائي'
        ).catch(() => undefined);
      }
    }

    const active =
      state.databases.find((d) => d.id === state.activeDatabaseId) || state.databases[0];
    return {
      rotated: Boolean(nextEntry),
      allExhausted: state.allExhausted,
      pointer: active ? buildPointerFromEntry(active, state) : null,
    };
  } catch {
    return null;
  }
}

async function callProgrammerEndpoint<T>(
  endpoint: string,
  user: User,
  fullNameQuad: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  const sendWithToken = async (forceRefresh: boolean) => {
    const idToken = await user.getIdToken(forceRefresh);
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
        'X-DuoBoard-Name': encodeURIComponent(fullNameQuad || ''),
      },
      body: JSON.stringify({
        ...payload,
        fullNameQuad,
        tokenProjectId: activeFirebaseConfig.projectId,
        tokenApiKey: activeFirebaseConfig.apiKey,
      }),
    });
  };

  let resp: Response;
  try {
    resp = await sendWithToken(false);
    if (resp.status === 401 || resp.status === 403) {
      resp = await sendWithToken(true);
    }
  } catch {
    throw new ApiUnavailableError('Network unreachable');
  }

  if (resp.status === 404 || resp.status === 405 || resp.status === 501 || resp.status === 502) {
    throw new ApiUnavailableError(`Static host or server unavailable (${resp.status})`);
  }

  const rawText = await resp.text();
  if (rawText.trim().startsWith('<')) {
    throw new ApiUnavailableError('HTML fallback returned for /api endpoint (static hosting)');
  }

  let data: (T & { error?: string }) | null = null;
  try {
    data = rawText ? (JSON.parse(rawText) as T & { error?: string }) : null;
  } catch {
    throw new ApiUnavailableError('Non-JSON response from /api endpoint');
  }

  if (!data || typeof data !== 'object') {
    throw new ApiUnavailableError('Empty response from /api endpoint');
  }

  if (!resp.ok) {
    throw new Error(data.error || `فشل تنفيذ طلب المبرمج (${resp.status})`);
  }
  return data;
}

export async function fetchProgrammerSession(
  user: User,
  fullNameQuad: string
): Promise<{
  isProgrammer: boolean;
  isMaster: boolean;
  state?: PlatformProgrammerState;
  mode?: 'server' | 'serverless';
}> {
  try {
    const serverRes = await callProgrammerEndpoint<{
      isProgrammer: boolean;
      isMaster: boolean;
      state?: PlatformProgrammerState;
    }>('/api/programmer/session', user, fullNameQuad);
    if (serverRes.state) {
      saveLocalServerlessPool(serverRes.state);
      if (serverRes.isMaster) {
        void writeFirestorePoolDoc(
          sourceDb,
          serverRes.state,
          user.uid,
          fullNameQuad || user.displayName || MASTER_PROGRAMMER_NAME
        );
      }
    }
    return { ...serverRes, mode: 'server' };
  } catch (err) {
    if (!(err instanceof ApiUnavailableError)) throw err;
  }

  const state = await loadServerlessPoolState();
  const role = await isIdentityProgrammerServerless(state, {
    email: user.email,
    fullNameQuad,
  });
  if (role.isMaster) {
    void writeFirestorePoolDoc(
      sourceDb,
      state,
      user.uid,
      fullNameQuad || user.displayName || MASTER_PROGRAMMER_NAME
    );
  }
  return {
    isProgrammer: role.isProgrammer,
    isMaster: role.isMaster,
    state: role.isProgrammer ? state : undefined,
    mode: 'serverless',
  };
}

export async function addDatabaseToPool(
  user: User,
  fullNameQuad: string,
  config: FirebaseAppConfig,
  label: string
): Promise<{ ok: boolean; added: PoolDatabaseEntry; state: PlatformProgrammerState }> {
  try {
    const res = await callProgrammerEndpoint<{
      ok: boolean;
      added: PoolDatabaseEntry;
      state: PlatformProgrammerState;
    }>('/api/programmer/databases/add', user, fullNameQuad, { config, label });
    saveLocalServerlessPool(res.state);
    void writeFirestorePoolDoc(sourceDb, res.state, user.uid, fullNameQuad);
    return res;
  } catch (err) {
    if (!(err instanceof ApiUnavailableError)) throw err;
  }

  const state = await loadServerlessPoolState();
  const cleanCfg = sanitizeFirebaseConfig(config);
  if (!cleanCfg) throw new Error('إعدادات Firebase غير صالحة');
  if (state.databases.some((d) => isSameFirebaseTarget(d.config, cleanCfg))) {
    throw new Error('قاعدة البيانات هذه مضافة بالفعل في القائمة.');
  }

  const now = Date.now();
  const added: PoolDatabaseEntry = {
    id: `db_${now}_${Math.random().toString(36).slice(2, 6)}`,
    order: state.databases.length + 1,
    label: label.trim() || `قاعدة #${state.databases.length + 1} — ${cleanCfg.projectId}`,
    config: cleanCfg,
    exhaustedAt: null,
    exhaustedUntil: null,
    addedByEmail: user.email || undefined,
    addedAt: now,
  };
  const next = ensurePoolDefaults({
    ...state,
    databases: [...state.databases, added],
    revision: state.revision + 1,
    updatedByEmail: user.email || undefined,
    updatedAt: now,
  });
  saveLocalServerlessPool(next);
  await writeFirestorePoolDoc(sourceDb, next, user.uid, fullNameQuad || MASTER_PROGRAMMER_NAME);
  return { ok: true, added, state: next };
}

export async function reorderDatabasePool(
  user: User,
  fullNameQuad: string,
  orderedIds: string[]
): Promise<{ ok: boolean; state: PlatformProgrammerState }> {
  try {
    const res = await callProgrammerEndpoint<{ ok: boolean; state: PlatformProgrammerState }>(
      '/api/programmer/databases/reorder',
      user,
      fullNameQuad,
      { orderedIds }
    );
    saveLocalServerlessPool(res.state);
    void writeFirestorePoolDoc(sourceDb, res.state, user.uid, fullNameQuad);
    return res;
  } catch (err) {
    if (!(err instanceof ApiUnavailableError)) throw err;
  }

  const state = await loadServerlessPoolState();
  const byId = new Map(state.databases.map((d) => [d.id, d]));
  const reordered: PoolDatabaseEntry[] = [];
  for (const id of orderedIds) {
    const found = byId.get(id);
    if (found) {
      reordered.push(found);
      byId.delete(id);
    }
  }
  for (const rest of byId.values()) reordered.push(rest);

  const next = ensurePoolDefaults({
    ...state,
    databases: reordered,
    revision: state.revision + 1,
    updatedByEmail: user.email || undefined,
    updatedAt: Date.now(),
  });
  saveLocalServerlessPool(next);
  await writeFirestorePoolDoc(sourceDb, next, user.uid, fullNameQuad || MASTER_PROGRAMMER_NAME);
  return { ok: true, state: next };
}

export async function activateDatabaseFromPool(
  user: User,
  fullNameQuad: string,
  databaseId: string,
  migratedRoomId?: string | null
): Promise<{ ok: boolean; state: PlatformProgrammerState; pointer: ServerPlatformPointer }> {
  try {
    const res = await callProgrammerEndpoint<{
      ok: boolean;
      state: PlatformProgrammerState;
      pointer: ServerPlatformPointer;
    }>('/api/programmer/databases/activate', user, fullNameQuad, {
      databaseId,
      migratedRoomId: migratedRoomId || null,
    });
    saveLocalServerlessPool(res.state);
    const chosen =
      res.state.databases.find((d) => d.id === res.state.activeDatabaseId) ||
      res.state.databases[0];
    if (chosen) {
      await Promise.all([
        writeFirestorePoolDoc(sourceDb, res.state, user.uid, fullNameQuad || MASTER_PROGRAMMER_NAME),
        writeFirestoreMigrationPointerDoc(
          sourceDb,
          chosen.config as FirebaseAppConfig,
          res.state.databases,
          user.uid,
          fullNameQuad || MASTER_PROGRAMMER_NAME,
          migratedRoomId
        ),
      ]);
    }
    return res;
  } catch (err) {
    if (!(err instanceof ApiUnavailableError)) throw err;
  }

  const state = await loadServerlessPoolState();
  const target = state.databases.find((d) => d.id === databaseId);
  if (!target) throw new Error('القاعدة المطلوبة غير موجودة');

  const now = Date.now();
  target.exhaustedAt = null;
  target.exhaustedUntil = null;
  const next = ensurePoolDefaults({
    ...state,
    activeDatabaseId: target.id,
    allExhausted: false,
    revision: state.revision + 1,
    updatedByEmail: user.email || undefined,
    updatedAt: now,
  });
  saveLocalServerlessPool(next);

  await Promise.all([
    writeFirestorePoolDoc(sourceDb, next, user.uid, fullNameQuad || MASTER_PROGRAMMER_NAME),
    writeFirestoreMigrationPointerDoc(
      sourceDb,
      target.config as FirebaseAppConfig,
      next.databases,
      user.uid,
      fullNameQuad || MASTER_PROGRAMMER_NAME,
      migratedRoomId
    ),
  ]);

  return {
    ok: true,
    state: next,
    pointer: buildPointerFromEntry(target, next, migratedRoomId),
  };
}

export async function reactivatePoolDatabase(
  user: User,
  fullNameQuad: string,
  databaseId: string | 'ALL'
): Promise<{ ok: boolean; state: PlatformProgrammerState }> {
  try {
    const res = await callProgrammerEndpoint<{ ok: boolean; state: PlatformProgrammerState }>(
      '/api/programmer/databases/reactivate',
      user,
      fullNameQuad,
      { databaseId }
    );
    saveLocalServerlessPool(res.state);
    void writeFirestorePoolDoc(sourceDb, res.state, user.uid, fullNameQuad);
    return res;
  } catch (err) {
    if (!(err instanceof ApiUnavailableError)) throw err;
  }

  const state = await loadServerlessPoolState();
  const now = Date.now();
  const updatedDbs = state.databases.map((d) =>
    databaseId === 'ALL' || d.id === databaseId
      ? { ...d, exhaustedAt: null, exhaustedUntil: null }
      : d
  );
  const firstHealthy = updatedDbs.find((d) => d.exhaustedAt === null) || updatedDbs[0];
  const next = ensurePoolDefaults({
    ...state,
    databases: updatedDbs,
    activeDatabaseId: state.allExhausted ? firstHealthy.id : state.activeDatabaseId,
    allExhausted: updatedDbs.every((d) => d.exhaustedAt !== null),
    revision: state.revision + 1,
    updatedByEmail: user.email || undefined,
    updatedAt: now,
  });
  saveLocalServerlessPool(next);
  await writeFirestorePoolDoc(sourceDb, next, user.uid, fullNameQuad || MASTER_PROGRAMMER_NAME);
  return { ok: true, state: next };
}

export async function removeDatabaseFromPool(
  user: User,
  fullNameQuad: string,
  databaseId: string
): Promise<{ ok: boolean; state: PlatformProgrammerState }> {
  try {
    const res = await callProgrammerEndpoint<{ ok: boolean; state: PlatformProgrammerState }>(
      '/api/programmer/databases/remove',
      user,
      fullNameQuad,
      { databaseId }
    );
    saveLocalServerlessPool(res.state);
    void writeFirestorePoolDoc(sourceDb, res.state, user.uid, fullNameQuad);
    return res;
  } catch (err) {
    if (!(err instanceof ApiUnavailableError)) throw err;
  }

  const state = await loadServerlessPoolState();
  if (state.databases.length <= 1) {
    throw new Error('يجب الإبقاء على قاعدة بيانات واحدة على الأقل.');
  }
  const remaining = state.databases.filter((d) => d.id !== databaseId);
  if (remaining.length === state.databases.length) {
    throw new Error('القاعدة غير موجودة');
  }
  const nextActive =
    state.activeDatabaseId === databaseId
      ? (remaining.find((d) => d.exhaustedAt === null) || remaining[0]).id
      : state.activeDatabaseId;

  const next = ensurePoolDefaults({
    ...state,
    databases: remaining,
    activeDatabaseId: nextActive,
    revision: state.revision + 1,
    updatedByEmail: user.email || undefined,
    updatedAt: Date.now(),
  });
  saveLocalServerlessPool(next);
  await writeFirestorePoolDoc(sourceDb, next, user.uid, fullNameQuad || MASTER_PROGRAMMER_NAME);
  return { ok: true, state: next };
}

export async function promoteProgrammerMember(
  user: User,
  fullNameQuad: string,
  targetFullNameQuad: string,
  targetEmail: string
): Promise<{ ok: boolean; member: ProgrammerMember; state: PlatformProgrammerState }> {
  try {
    const res = await callProgrammerEndpoint<{
      ok: boolean;
      member: ProgrammerMember;
      state: PlatformProgrammerState;
    }>('/api/programmer/members/add', user, fullNameQuad, {
      fullNameQuad: targetFullNameQuad,
      email: targetEmail,
    });
    saveLocalServerlessPool(res.state);
    void writeFirestorePoolDoc(sourceDb, res.state, user.uid, fullNameQuad);
    return res;
  } catch (err) {
    if (!(err instanceof ApiUnavailableError)) throw err;
  }

  const cleanName = targetFullNameQuad.trim().replace(/\s+/g, ' ');
  const cleanEmail = targetEmail.trim().toLowerCase();
  if (!cleanName && !cleanEmail) {
    throw new Error('أدخل الاسم الرباعي أو البريد الإلكتروني للمستخدم.');
  }

  const state = await loadServerlessPoolState();
  const normNew = normalizeArabicName(cleanName);
  const newHash = cleanEmail ? await sha256Hex(cleanEmail) : '';
  const dup = (state.programmers as StoredProgrammerWithHash[]).some(
    (m) =>
      (cleanEmail && m.email && m.email.toLowerCase() === cleanEmail) ||
      (newHash && m.emailHash && m.emailHash === newHash) ||
      (normNew && m.fullNameQuad && normalizeArabicName(m.fullNameQuad) === normNew)
  );
  if (dup) {
    throw new Error('هذا المستخدم مُرقّى بالفعل إلى مبرمج.');
  }

  const member: StoredProgrammerWithHash = {
    id: `prog_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    fullNameQuad: cleanName || cleanEmail,
    ...(cleanEmail ? { email: cleanEmail, emailHash: newHash, emailMasked: maskEmailAddress(cleanEmail) } : {}),
    isMaster: false,
    promotedBy: fullNameQuad || user.displayName || MASTER_PROGRAMMER_NAME,
    promotedAt: Date.now(),
  };

  const next = ensurePoolDefaults({
    ...state,
    programmers: [...state.programmers, member],
    revision: state.revision + 1,
    updatedAt: Date.now(),
  });
  saveLocalServerlessPool(next);
  await writeFirestorePoolDoc(sourceDb, next, user.uid, fullNameQuad || MASTER_PROGRAMMER_NAME);
  return { ok: true, member, state: next };
}

export async function removeProgrammerMember(
  user: User,
  fullNameQuad: string,
  memberId: string
): Promise<{ ok: boolean; state: PlatformProgrammerState }> {
  try {
    const res = await callProgrammerEndpoint<{ ok: boolean; state: PlatformProgrammerState }>(
      '/api/programmer/members/remove',
      user,
      fullNameQuad,
      { memberId }
    );
    saveLocalServerlessPool(res.state);
    void writeFirestorePoolDoc(sourceDb, res.state, user.uid, fullNameQuad);
    return res;
  } catch (err) {
    if (!(err instanceof ApiUnavailableError)) throw err;
  }

  const state = await loadServerlessPoolState();
  const target = state.programmers.find((m) => m.id === memberId);
  if (!target) throw new Error('العضو غير موجود');
  if (target.isMaster) throw new Error('لا يمكن إزالة المبرمج الأساسي للمنصة.');

  const next = ensurePoolDefaults({
    ...state,
    programmers: state.programmers.filter((m) => m.id !== memberId),
    revision: state.revision + 1,
    updatedAt: Date.now(),
  });
  saveLocalServerlessPool(next);
  await writeFirestorePoolDoc(sourceDb, next, user.uid, fullNameQuad || MASTER_PROGRAMMER_NAME);
  return { ok: true, state: next };
}


