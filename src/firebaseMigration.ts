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
import {
  activateCustomFirebaseConfig,
  auth as sourceAuth,
  createFirestoreInstance,
  db as sourceDb,
  decodeCompactFirebaseConfig,
  encodeCompactFirebaseConfig,
  getTargetFirebaseAppName,
  isSameFirebaseTarget,
  activeFirebaseConfig,
  sanitizeFirebaseConfig,
  type FirebaseAppConfig,
} from './firebase';
import {
  loadAllQuizDrafts,
  loadSessionSnapshot,
  saveQuizDraft,
  saveSessionSnapshot,
  type StoredRoomSnapshot,
  type StoredSavedTestsSnapshot,
  type StoredMyQuizzesSnapshot,
  type StoredQuizAttemptsSnapshot,
  type StoredUserProfileSnapshot,
} from './localDraftStore';
import type {
  ExplainLayer,
  InteractiveSlide,
  Participant,
  Question,
  Room,
  SavedQuestion,
  SavedTest,
  MyQuiz,
  QuizAttempt,
  SharedExplainBoard,
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
    | 'migrating_room'
    | 'migrating_saved'
    | 'migrating_quizzes'
    | 'migrating_attempts'
    | 'done';
  message: string;
}

export interface MigrationResult {
  targetConfig: FirebaseAppConfig;
  targetUid: string;
  shareUrl: string;
  migratedRoomId: string | null;
  roomCreatedAsSupervisor: boolean;
  roomRejoinedAsStudent: boolean;
  roomPendingForStudent: boolean;
  migratedQuestionsCount: number;
  migratedSlidesCount: number;
  migratedSavedTestsCount: number;
  migratedMyQuizzesCount: number;
  migratedAttemptsCount: number;
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

  // 1. Check if the user pasted a shareable ?fb=... URL directly
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

  // 2. Try direct JSON parse
  if (!parsed && trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed) as unknown;
      parsed = sanitizeFirebaseConfig(obj);
    } catch {
      // Continue to JS snippet regex extraction
    }
  }

  // 3. Extract keys safely from Firebase Console JS snippet (no eval)
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
      firestoreDatabaseId:
        dbOverride === '(default)' ? '' : dbOverride,
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

function getOrInitTargetApp(config: FirebaseAppConfig): FirebaseApp {
  const appName = getTargetFirebaseAppName(config.projectId);
  const existing = getApps().find((a) => a.name === appName);
  if (existing) {
    return existing;
  }
  return initializeApp(config, appName);
}

async function withTimeout<T>(promise: Promise<T>, ms = 3500): Promise<T> {
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

interface CollectedSourceData {
  oldUid: string | null;
  profile: UserProfile | null;
  room: Room | null;
  myRole: 'supervisor' | 'student';
  participants: Participant[];
  questions: Question[];
  slides: InteractiveSlide[];
  explainLayers: ExplainLayer[];
  slideLayers: SlideLayer[];
  sharedBoard: SharedExplainBoard | null;
  boards: StudentBoard[];
  savedTests: SavedTest[];
  savedQuestionsByTestId: Record<string, SavedQuestion[]>;
  myQuizzes: MyQuiz[];
  quizAttempts: QuizAttempt[];
}

async function collectSourceData(
  currentProfile: UserProfile | null,
  currentRoom: Room | null,
  isSupervisorInCurrentRoom: boolean
): Promise<CollectedSourceData> {
  const cachedProfile =
    await loadSessionSnapshot<StoredUserProfileSnapshot>('user_profile');
  const cachedRoom =
    await loadSessionSnapshot<StoredRoomSnapshot>('active_room');
  const cachedSaved =
    await loadSessionSnapshot<StoredSavedTestsSnapshot>('saved_tests');
  const cachedQuizzes =
    await loadSessionSnapshot<StoredMyQuizzesSnapshot>('my_quizzes');
  const cachedAttempts =
    await loadSessionSnapshot<StoredQuizAttemptsSnapshot>('quiz_attempts');

  const oldUid =
    currentProfile?.uid ??
    sourceAuth.currentUser?.uid ??
    cachedProfile?.uid ??
    null;

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

  // Try live profile fetch from sourceDb if missing
  if (!profile && oldUid) {
    try {
      const pSnap = await withTimeout(
        getDoc(doc(sourceDb, 'users', oldUid, 'private', 'profile'))
      );
      if (pSnap.exists()) {
        profile = pSnap.data() as UserProfile;
      }
    } catch {
      // Fallback gracefully
    }
  }

  let room: Room | null = currentRoom ?? cachedRoom?.room ?? null;
  const myRole: 'supervisor' | 'student' = currentRoom
    ? isSupervisorInCurrentRoom
      ? 'supervisor'
      : 'student'
    : cachedRoom?.myRole ??
      (room && oldUid && room.supervisorId === oldUid ? 'supervisor' : 'student');

  let participants: Participant[] = cachedRoom?.participants ?? [];
  let questions: Question[] = cachedRoom?.questions ?? [];
  let slides: InteractiveSlide[] = cachedRoom?.slides ?? [];
  let explainLayers: ExplainLayer[] = cachedRoom?.explainLayers ?? [];
  let slideLayers: SlideLayer[] = cachedRoom?.slideLayers ?? [];
  let sharedBoard: SharedExplainBoard | null = cachedRoom?.sharedBoard ?? null;
  let boards: StudentBoard[] = cachedRoom?.boards ?? [];

  // Best-effort live fetch of active room data (falls back immediately to snapshot if quota exceeded)
  if (room) {
    try {
      const rSnap = await withTimeout(getDoc(doc(sourceDb, 'rooms', room.id)));
      if (rSnap.exists()) {
        room = rSnap.data() as Room;
      }
    } catch {
      // Use cached snapshot
    }

    try {
      const qSnap = await withTimeout(
        getDocs(
          query(
            collection(sourceDb, 'rooms', room.id, 'questions'),
            where('roomId', '==', room.id)
          )
        )
      );
      const list: Question[] = [];
      qSnap.forEach((d) => list.push(d.data() as Question));
      list.sort((a, b) => a.orderIndex - b.orderIndex);
      if (list.length > 0) questions = list;
    } catch {
      // Use cached snapshot
    }

    try {
      const sSnap = await withTimeout(
        getDocs(
          query(
            collection(sourceDb, 'rooms', room.id, 'slides'),
            where('roomId', '==', room.id)
          )
        )
      );
      const list: InteractiveSlide[] = [];
      sSnap.forEach((d) => list.push(d.data() as InteractiveSlide));
      list.sort((a, b) => a.pageIndex - b.pageIndex);
      if (list.length > 0) slides = list;
    } catch {
      // Use cached snapshot
    }

    try {
      const elSnap = await withTimeout(
        getDocs(
          query(
            collection(sourceDb, 'rooms', room.id, 'explainLayers'),
            where('roomId', '==', room.id)
          )
        )
      );
      const list: ExplainLayer[] = [];
      elSnap.forEach((d) => list.push(d.data() as ExplainLayer));
      if (list.length > 0) explainLayers = list;
    } catch {
      // Use cached snapshot
    }

    try {
      const sbSnap = await withTimeout(
        getDoc(doc(sourceDb, 'rooms', room.id, 'sharedBoard', 'live'))
      );
      if (sbSnap.exists()) {
        sharedBoard = sbSnap.data() as SharedExplainBoard;
      }
    } catch {
      // Use cached snapshot
    }

    if (room.currentQuestionId) {
      try {
        const bSnap = await withTimeout(
          getDocs(
            query(
              collection(
                sourceDb,
                'rooms',
                room.id,
                'questions',
                room.currentQuestionId,
                'boards'
              ),
              where('roomId', '==', room.id),
              where('questionId', '==', room.currentQuestionId)
            )
          )
        );
        const list: StudentBoard[] = [];
        bSnap.forEach((d) => list.push(d.data() as StudentBoard));
        if (list.length > 0) boards = list;
      } catch {
        // Use cached snapshot
      }
    }
  }

  // Saved tests collection (best-effort live read -> fallback to IndexedDB snapshot)
  let savedTests: SavedTest[] = cachedSaved?.tests ?? [];
  const savedQuestionsByTestId: Record<string, SavedQuestion[]> = {
    ...(cachedSaved?.questionsByTestId ?? {}),
  };

  if (oldUid) {
    try {
      const stSnap = await withTimeout(
        getDocs(
          query(
            collection(sourceDb, 'users', oldUid, 'savedTests'),
            where('ownerId', '==', oldUid)
          )
        )
      );
      const liveTests: SavedTest[] = [];
      stSnap.forEach((d) => liveTests.push(d.data() as SavedTest));
      if (liveTests.length > 0) {
        savedTests = liveTests;
        for (const t of liveTests.slice(0, 15)) {
          try {
            const tqSnap = await withTimeout(
              getDocs(
                query(
                  collection(sourceDb, 'users', oldUid, 'savedTests', t.id, 'questions'),
                  where('ownerId', '==', oldUid)
                )
              )
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

  // "اختباراتي": قراءة حية من قاعدة المصدر، وإن تعذرت (حصة/شبكة) نستخدم النسخة المحلية المخزنة
  let myQuizzes: MyQuiz[] =
    cachedQuizzes && (!oldUid || cachedQuizzes.ownerId === oldUid) ? cachedQuizzes.quizzes : [];
  if (oldUid) {
    try {
      const qzSnap = await withTimeout(
        getDocs(
          query(collection(sourceDb, 'users', oldUid, 'myQuizzes'), where('ownerId', '==', oldUid))
        ),
        8000
      );
      const live: MyQuiz[] = [];
      qzSnap.forEach((d) => live.push(d.data() as MyQuiz));
      // نجحت القراءة الحية: هي المرجع (بما فيها حالة عدم وجود اختبارات)
      myQuizzes = live;
    } catch {
      // نبقى على النسخة المحلية
    }
  }

  // محاولات الاختبار المحفوظة: قراءة حية ثم النسخة المحلية عند التعذر
  let quizAttempts: QuizAttempt[] =
    cachedAttempts && (!oldUid || cachedAttempts.ownerId === oldUid) ? cachedAttempts.attempts : [];
  if (oldUid) {
    try {
      const atSnap = await withTimeout(
        getDocs(
          query(collection(sourceDb, 'users', oldUid, 'quizAttempts'), where('ownerId', '==', oldUid))
        ),
        8000
      );
      const live: QuizAttempt[] = [];
      atSnap.forEach((d) => live.push(d.data() as QuizAttempt));
      quizAttempts = live;
    } catch {
      // نبقى على النسخة المحلية
    }
  }

  return {
    oldUid,
    profile,
    room,
    myRole,
    participants,
    questions,
    slides,
    explainLayers,
    slideLayers,
    sharedBoard,
    boards,
    savedTests,
    savedQuestionsByTestId,
    myQuizzes,
    quizAttempts,
  };
}

async function signInOnTarget(
  targetConfig: FirebaseAppConfig
): Promise<{ targetApp: FirebaseApp; targetDb: Firestore; targetUser: User }> {
  const targetApp = getOrInitTargetApp(targetConfig);
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
    message: 'جاري تجميع بيانات الحساب والغرفة والصبورات...',
  });

  const source = await collectSourceData(
    currentProfile,
    currentRoom,
    isSupervisorInCurrentRoom
  );

  const targetUid = targetUser.uid;
  const resolvedQuadName =
    source.profile?.fullNameQuad ||
    (targetUser.displayName &&
    targetUser.displayName.trim().split(/\s+/).length >= 4
      ? targetUser.displayName.trim()
      : '');

  try {
    // 1. Migrate User Profile
    onProgress({
      step: 'migrating_profile',
      message: 'جاري نقل بيانات الحساب...',
    });

    const targetProfileRef = doc(targetDb, 'users', targetUid, 'private', 'profile');
    const existingProfileSnap = await getDoc(targetProfileRef);

    if (resolvedQuadName && resolvedQuadName.length >= 5) {
      if (existingProfileSnap.exists()) {
        await updateDoc(targetProfileRef, {
          fullNameQuad: resolvedQuadName,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(targetProfileRef, {
          uid: targetUid,
          fullNameQuad: resolvedQuadName,
          email: targetUser.email || source.profile?.email || 'user@example.com',
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
        email: targetUser.email || source.profile?.email || 'user@example.com',
        updatedAt: Date.now(),
      });
    } else if (existingProfileSnap.exists()) {
      const existingData = existingProfileSnap.data() as UserProfile;
      try {
        localStorage.setItem(
          `duoboard_quad_${targetUid}`,
          existingData.fullNameQuad
        );
        localStorage.setItem('duoboard_last_quad_name', existingData.fullNameQuad);
      } catch {
        // Ignore storage errors
      }
    }

    // Re-key local quiz drafts (uploaded PDFs, selected pages, AI cache, draft strokes)
    if (source.oldUid && source.oldUid !== targetUid) {
      const allDrafts = await loadAllQuizDrafts();
      for (const d of allDrafts) {
        if (d.key.endsWith(`_${source.oldUid}`)) {
          const newKey =
            d.key.slice(0, d.key.length - source.oldUid.length) + targetUid;
          await saveQuizDraft({
            ...d,
            key: newKey,
            updatedAt: Date.now(),
          });
        }
      }
    }

    // 2. Migrate Active Room state
    let migratedRoomId: string | null = null;
    let roomCreatedAsSupervisor = false;
    let roomRejoinedAsStudent = false;
    let roomPendingForStudent = false;
    let migratedQuestionsCount = 0;
    let migratedSlidesCount = 0;

    if (source.room) {
      const srcRoom = source.room;
      migratedRoomId = srcRoom.id;

      onProgress({
        step: 'migrating_room',
        message: `جاري نقل الغرفة (${srcRoom.id}) والأسئلة والصبورات...`,
      });

      const targetRoomRef = doc(targetDb, 'rooms', srcRoom.id);
      const existingRoomSnap = await getDoc(targetRoomRef);

      if (source.myRole === 'supervisor') {
        const supervisorDisplayName =
          resolvedQuadName && resolvedQuadName.length >= 5
            ? resolvedQuadName
            : srcRoom.supervisorName || 'المشرف العام للجلسة';

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

        const targetRoomData = existingRoomSnap.exists()
          ? (existingRoomSnap.data() as Room)
          : null;
        const canEditRoom =
          !targetRoomData ||
          (targetRoomData.supervisorId === targetUid &&
            targetRoomData.status !== 'finished');

        if (canEditRoom) {
          // Transition waiting -> active if needed
          if (srcRoom.status !== 'waiting' && (!targetRoomData || targetRoomData.status === 'waiting')) {
            await updateDoc(targetRoomRef, {
              status: 'active',
              updatedAt: serverTimestamp(),
            });
          }

          // Slides require status === 'active' AND (sessionType === 'interactive' OR mode === 'explain')
          const needsExplainForSlides =
            (srcRoom.sessionType || 'quiz') !== 'interactive' &&
            (source.slides.length > 0 ||
              srcRoom.mode === 'explain' ||
              source.explainLayers.length > 0);

          if (needsExplainForSlides) {
            await updateDoc(targetRoomRef, {
              mode: 'explain',
              explainPresenterId:
                srcRoom.explainPresenterId === 'all' ? 'all' : targetUid,
              explainPresenterName:
                srcRoom.explainPresenterId === 'all'
                  ? 'الجميع'
                  : supervisorDisplayName.slice(0, 120),
              updatedAt: serverTimestamp(),
            });
          }

          // Migrate slides
          for (const slide of source.slides) {
            if (!slide.imageData || slide.imageData.length > 480000) continue;
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

            // Supervisor's own layer on this slide
            const mySlideLayer = source.slideLayers.find(
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
            }
          }

          if (source.slides.length > 0 || (srcRoom.currentSlideIndex ?? 0) > 0) {
            await updateDoc(targetRoomRef, {
              currentSlideIndex: Math.min(
                100,
                Math.max(0, srcRoom.currentSlideIndex ?? 0)
              ),
              slideCount: Math.min(
                100,
                Math.max(source.slides.length, srcRoom.slideCount ?? 0)
              ),
              updatedAt: serverTimestamp(),
            });
          }

          // Migrate Supervisor's blank-board explain layer & sharedBoard
          const myExplainLayer = source.explainLayers.find(
            (l) => l.authorId === source.oldUid || l.authorId === targetUid
          );
          if (myExplainLayer && (myExplainLayer.strokes?.length ?? 0) > 0) {
            await setDoc(
              doc(targetDb, 'rooms', srcRoom.id, 'explainLayers', targetUid),
              {
                id: targetUid,
                roomId: srcRoom.id,
                authorId: targetUid,
                authorName: supervisorDisplayName.slice(0, 120),
                strokes: myExplainLayer.strokes.slice(-400),
                updatedAt: serverTimestamp(),
              }
            );
          }

          if (source.sharedBoard && (source.sharedBoard.strokes?.length ?? 0) > 0) {
            await setDoc(doc(targetDb, 'rooms', srcRoom.id, 'sharedBoard', 'live'), {
              roomId: srcRoom.id,
              strokes: source.sharedBoard.strokes.slice(-400),
              updatedBy: targetUid,
              updatedByName: supervisorDisplayName.slice(0, 120),
              updatedAt: serverTimestamp(),
            });
          }

          // Restore target room mode if it wasn't explain
          if (needsExplainForSlides && (srcRoom.mode || 'quiz') === 'quiz') {
            await updateDoc(targetRoomRef, {
              mode: 'quiz',
              explainPresenterId: '',
              explainPresenterName: '',
              updatedAt: serverTimestamp(),
            });
          }

          // Migrate Questions
          for (const q of source.questions) {
            const qRef = doc(targetDb, 'rooms', srcRoom.id, 'questions', q.id);
            const qSnap = await getDoc(qRef);
            if (!qSnap.exists()) {
              await setDoc(qRef, {
                id: q.id,
                roomId: srcRoom.id,
                orderIndex: Math.min(200, Math.max(1, q.orderIndex)),
                text: (q.text || '').slice(0, 1000),
                imageData:
                  q.imageData && q.imageData.length <= 480000 ? q.imageData : '',
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
          }

          if (srcRoom.currentQuestionId || source.questions.length > 0) {
            await updateDoc(targetRoomRef, {
              currentQuestionId: srcRoom.currentQuestionId || '',
              questionCount: Math.min(
                200,
                Math.max(source.questions.length, srcRoom.questionCount ?? 0)
              ),
              updatedAt: serverTimestamp(),
            });
          }

          if (
            srcRoom.sessionType === 'interactive' &&
            srcRoom.interactiveEditor === 'all'
          ) {
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
        roomCreatedAsSupervisor = true;
      } else {
        // Student path: rejoin if supervisor already created the room on targetDb
        if (existingRoomSnap.exists()) {
          const targetRoomData = existingRoomSnap.data() as Room;
          if (targetRoomData.status !== 'finished') {
            const pRef = doc(
              targetDb,
              'rooms',
              srcRoom.id,
              'participants',
              targetUid
            );
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

            // Restore student's own strokes on current question if still solving
            if (targetRoomData.currentQuestionId) {
              const myOldBoard = source.boards.find(
                (b) => b.studentId === source.oldUid || b.studentId === targetUid
              );
              if (myOldBoard && (myOldBoard.strokes?.length ?? 0) > 0) {
                const qRef = doc(
                  targetDb,
                  'rooms',
                  srcRoom.id,
                  'questions',
                  targetRoomData.currentQuestionId
                );
                const qSnap = await getDoc(qRef);
                if (qSnap.exists() && (qSnap.data() as Question).status === 'solving') {
                  const bRef = doc(
                    targetDb,
                    'rooms',
                    srcRoom.id,
                    'questions',
                    targetRoomData.currentQuestionId,
                    'boards',
                    targetUid
                  );
                  const bSnap = await getDoc(bRef);
                  if (!bSnap.exists()) {
                    await setDoc(bRef, {
                      studentId: targetUid,
                      studentName: studentName.slice(0, 120),
                      roomId: srcRoom.id,
                      questionId: targetRoomData.currentQuestionId,
                      strokes: myOldBoard.strokes.slice(-400),
                      submitted: Boolean(myOldBoard.submitted),
                      verdict: 'pending',
                      updatedAt: serverTimestamp(),
                    });
                  }
                }
              }
            }
          }
          roomRejoinedAsStudent = true;
        } else {
          roomPendingForStudent = true;
        }
      }
    }

    // 3. Migrate Saved Tests archive
    let migratedSavedTestsCount = 0;
    if (source.savedTests.length > 0) {
      onProgress({
        step: 'migrating_saved',
        message: `جاري نقل الاختبارات المحفوظة (${source.savedTests.length})...`,
      });

      for (const test of source.savedTests) {
        const testRef = doc(targetDb, 'users', targetUid, 'savedTests', test.id);
        const existingSaved = await getDoc(testRef);
        if (existingSaved.exists()) continue;

        const savedQuestions = source.savedQuestionsByTestId[test.id] ?? [];
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
          const sqRef = doc(
            targetDb,
            'users',
            targetUid,
            'savedTests',
            test.id,
            'questions',
            sq.id
          );
          firstBatch.set(sqRef, {
            id: sq.id,
            ownerId: targetUid,
            orderIndex: Math.min(200, Math.max(1, sq.orderIndex)),
            text: (sq.text || '').slice(0, 1000),
            imageData:
              sq.imageData && sq.imageData.length <= 480000 ? sq.imageData : '',
            status: sq.status || 'solving',
            winnerName: (sq.winnerName || '').slice(0, 120),
            boards: (sq.boards || []).slice(0, 100),
            createdAt: serverTimestamp(),
          });
        }

        await firstBatch.commit();

        for (let i = CHUNK; i < savedQuestions.length; i += CHUNK) {
          const batch = writeBatch(targetDb);
          for (const sq of savedQuestions.slice(i, i + CHUNK)) {
            const sqRef = doc(
              targetDb,
              'users',
              targetUid,
              'savedTests',
              test.id,
              'questions',
              sq.id
            );
            batch.set(sqRef, {
              id: sq.id,
              ownerId: targetUid,
              orderIndex: Math.min(200, Math.max(1, sq.orderIndex)),
              text: (sq.text || '').slice(0, 1000),
              imageData:
                sq.imageData && sq.imageData.length <= 480000 ? sq.imageData : '',
              status: sq.status || 'solving',
              winnerName: (sq.winnerName || '').slice(0, 120),
              boards: (sq.boards || []).slice(0, 100),
              createdAt: serverTimestamp(),
            });
          }
          await batch.commit();
        }

        migratedSavedTestsCount++;
      }
    }


    // 4. Migrate "اختباراتي" (my quizzes) — كل اختبار مستند واحد، فالعملية ذرية وقابلة للاستكمال:
    //    ما نُقل سابقاً يُتخطى، وما لم يُنقل بعد يُكمل عند إعادة المحاولة.
    let migratedMyQuizzesCount = 0;
    if (source.myQuizzes.length > 0) {
      onProgress({
        step: 'migrating_quizzes',
        message: `جاري نقل اختباراتي (${source.myQuizzes.length})...`,
      });

      for (const quiz of source.myQuizzes) {
        if (!quiz?.id || !Array.isArray(quiz.questions) || quiz.questions.length === 0) continue;
        const quizRef = doc(targetDb, 'users', targetUid, 'myQuizzes', quiz.id);
        const existingQuiz = await getDoc(quizRef);
        if (existingQuiz.exists()) {
          migratedMyQuizzesCount++;
          continue;
        }
        const questions = quiz.questions.slice(0, 100).map((q) => ({
          ...(q.chart && sanitizeChart(q.chart) ? { chart: sanitizeChart(q.chart) } : {}),
          id: String(q.id || '').slice(0, 64) || `q_${Math.random().toString(36).slice(2, 10)}`,
          text: String(q.text || '').slice(0, 2000),
          choices: Array.isArray(q.choices) ? q.choices.map((c) => String(c).slice(0, 500)).slice(0, 8) : [],
          correctIndex: Number.isInteger(q.correctIndex) ? q.correctIndex : -1,
          answer: String(q.answer || '').slice(0, 1000),
          explanation: String(q.explanation || '').slice(0, 2000),
        }));
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
      }
    }


    // 5. Migrate saved exam attempts (محاولات الاختبار) — مستند واحد لكل محاولة، قابلة للاستكمال
    let migratedAttemptsCount = 0;
    if (source.quizAttempts.length > 0) {
      onProgress({
        step: 'migrating_attempts',
        message: `جاري نقل محاولات الاختبار (${source.quizAttempts.length})...`,
      });

      for (const at of source.quizAttempts) {
        if (!at?.id || !Array.isArray(at.questions) || at.questions.length === 0) continue;
        const atRef = doc(targetDb, 'users', targetUid, 'quizAttempts', at.id);
        const existingAt = await getDoc(atRef);
        if (existingAt.exists()) {
          migratedAttemptsCount++;
          continue;
        }
        const qs = at.questions.slice(0, 100).map((q) => ({
          ...(q.chart && sanitizeChart(q.chart) ? { chart: sanitizeChart(q.chart) } : {}),
          id: String(q.id || '').slice(0, 120) || `q_${Math.random().toString(36).slice(2, 10)}`,
          sourceQuizId: String(q.sourceQuizId || '').slice(0, 120),
          sourceTitle: String(q.sourceTitle || '').slice(0, 120),
          text: String(q.text || '').slice(0, 2000),
          choices: Array.isArray(q.choices) ? q.choices.map((c) => String(c).slice(0, 500)).slice(0, 8) : [],
          correctIndex: Number.isInteger(q.correctIndex) ? q.correctIndex : -1,
          explanation: String(q.explanation || '').slice(0, 2000),
        }));
        const answers = qs.map((_, i) => (Number.isInteger(at.answers?.[i]) ? at.answers[i] : -1));
        const score = Math.min(
          qs.length,
          Math.max(0, qs.reduce((n, q, i) => n + (answers[i] === q.correctIndex ? 1 : 0), 0))
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
          finishedAt: Number.isFinite(Number(at.finishedAt)) && Number(at.finishedAt) > 0 ? Math.round(Number(at.finishedAt)) : Date.now(),
          createdAt: serverTimestamp(),
        });
        migratedAttemptsCount++;
      }
    }

    // Activate target database locally and persist active room so reload resumes seamlessly
    activateCustomFirebaseConfig(targetConfig, migratedRoomId);
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
      message: 'تم نقل البيانات وتجهيز قاعدة البيانات الجديدة بنجاح!',
    });

    return {
      targetConfig,
      targetUid,
      shareUrl,
      migratedRoomId,
      roomCreatedAsSupervisor,
      roomRejoinedAsStudent,
      roomPendingForStudent,
      migratedQuestionsCount,
      migratedSlidesCount,
      migratedSavedTestsCount,
      migratedMyQuizzesCount,
      migratedAttemptsCount,
    };
  } catch (err) {
    throw classifyMigrationError(err, targetConfig.projectId);
  }
}
