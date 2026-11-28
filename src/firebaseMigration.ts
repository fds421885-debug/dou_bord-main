import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { limit as fsLimit } from 'firebase/firestore';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
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
} from './firestoreTracked';
import { isBackendServerDetected, resolveApiUrl } from './apiBase';
import {
  hasCompletedPersonalSyncForDb,
  markCompletedPersonalSyncForDb,
} from './dbNoticeState';
import { sanitizeChart } from './quizChart';
import { sanitizeFigure } from './quizFigure';
import {
  decodeExamAttemptFromFirestore,
  decodeMyQuizFromFirestore,
  decodeQuizQuestionFromFirestore,
  decodeSharedQuizFromFirestore,
  decodeStarredQuestionFromFirestore,
  encodeDataTableForFirestore,
  encodeExplanationTableForFirestore,
  encodeTableForFirestore,
  sanitizeExplanationComparison,
  sanitizeQuestionLaws,
} from './quizTable';
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
  getBackupFirebaseConfigs,
  getInitialServerPlatformStatus,
  getPreviousFirebaseConfigs,
  getSyncedSourceKeys,
  getTargetFirebaseAppName,
  getTimestampMillis,
  isFirestorePermissionError,
  isMasterProgrammerIdentity,
  isQuadNameValid,
  isSameFirebaseTarget,
  markSourceKeySynced,
  MASTER_PROGRAMMER_EMAIL,
  MASTER_PROGRAMMER_NAME,
  normalizeArabicName,
  resolveLatestFirestoreMigrationRest,
  sanitizeFirebaseConfig,
  saveBackupFirebaseConfigs,
  savePreviousFirebaseConfigs,
  type FirebaseAppConfig,
  type ServerPlatformPointer,
} from './firebase';
import { fetchServerQuotaStatus, recordFirestoreOperations } from './quotaTracker';
import {
  loadAllQuizDrafts,
  loadMyQuizMetaOverrides,
  loadSessionSnapshot,
  saveQuizDraft,
  saveSessionSnapshot,
  type MyQuizMetaOverride,
  type StoredExamSession,
  type StoredMyQuizDraft,
  type StoredMyQuizzesSnapshot,
  type StoredQuizAttemptsSnapshot,
  type StoredRoomSnapshot,
  type StoredSavedTestsSnapshot,
  type StoredStarredQuestionsSnapshot,
  type StoredUserProfileSnapshot,
} from './localDraftStore';
import type {
  BackupAnnouncementInfo,
  Competition,
  CompetitionQuestion,
  DatabaseRole,
  DatabaseVerificationSummary,
  ExplainLayer,
  InteractiveSlide,
  MyQuiz,
  Participant,
  PlatformProgrammerState,
  ProgrammerMember,
  Question,
  QuizAttempt,
  RegisteredDatabaseEntry,
  Room,
  SavedQuestion,
  SavedTest,
  SharedExplainBoard,
  SharedQuiz,
  SlideLayer,
  StarredQuestion,
  StudentBoard,
  UserProfile,
} from './types';

export const REQUIRED_RULES_VERSION = 'v9_direct_chat_fix_2026_11_23';

export const RULES_UPDATE_CHANGES_AR: string[] = [
  'رفع حد الأسئلة داخل الاختبار الواحد ونتائج المحاولات والنماذج المشتركة (myQuizzes, quizAttempts, sharedQuizzes) من 100 إلى 10,000 سؤال.',
  'دعم لوحة الشرف العالمية وتصفيرها من المبرمج (leaderboardUsers, platform/leaderboardMeta).',
  'دعم طلبات الصداقة وقائمة الأصدقاء والمحادثات الفورية وإرسال الاختبارات بين الأصدقاء (friendRequests, friendships, directChats, sharedFriendQuizzes) مع إصلاح فتح وإرسال المحادثات.',
  'دعم «الأسئلة المميزة ⭐» و«اختبارات التقوية» وحقول القوانين والجداول التفاعلية.',
];

export const RULES_UPDATE_STEPS_AR: string[] = [
  '1. اضغط على زر «نسخ firestore.rules المحدّثة» بالأسفل لنسخ ملف القواعد الجديد بالكامل.',
  '2. اضغط على رابط «فتح Rules في Firebase Console» للمشروع الحالي (ولكل قاعدة بيانات مسجلة لديك).',
  '3. احذف القواعد القديمة بالكامل داخل محرر Firebase Rules، ثم ألصق القواعد الجديدة واضغط على زر Publish.',
  '4. انتظر ثانيتين بعد النشر ثم عد هنا واضغط «إعادة فحص القواعد الآن» للتأكد من تفعيلها 100%.',
];

const RULES_COMPLIANCE_SESSION_PREFIX = 'duoboard_rules_v9_ok_';

export interface RulesProbeCheckItem {
  id: 'anti_test_mode' | 'starred' | 'my_quizzes_v7' | 'attempts_v7' | 'social_v8';
  label: string;
  passed: boolean;
  detail?: string;
}

export interface DatabaseRulesCheckResult {
  dbId: string;
  label: string;
  role: 'active' | 'player' | 'backup';
  projectId: string;
  firestoreDatabaseId: string;
  config: FirebaseAppConfig;
  status: 'ok' | 'outdated' | 'needs_auth' | 'offline_or_quota';
  compliant: boolean;
  reason?: string;
  checks: RulesProbeCheckItem[];
  consoleUrl: string;
}

function makeAllPassedChecks(): RulesProbeCheckItem[] {
  return [
    { id: 'anti_test_mode', label: 'حماية القاعدة ضد الكتابة المفتوحة (غير Test Mode)', passed: true },
    { id: 'starred', label: 'صلاحية «الأسئلة المميزة ⭐» (starredQuestions)', passed: true },
    { id: 'my_quizzes_v7', label: 'اختبارات التقوية وحد الـ 10,000 سؤال (myQuizzes)', passed: true },
    { id: 'attempts_v7', label: 'سجل المحاولات وإجابات الجداول (quizAttempts)', passed: true },
    { id: 'social_v8', label: 'لوحة الشرف والأصدقاء والمحادثات (leaderboardUsers, friendRequests)', passed: true },
  ];
}

export async function checkActiveDatabaseRulesCompliance(
  user: User,
  config: FirebaseAppConfig = activeFirebaseConfig,
  bypassCache = false
): Promise<{
  compliant: boolean;
  status: 'ok' | 'outdated' | 'offline_or_quota';
  checkedProjectId: string;
  checkedDbId: string;
  reason?: string;
  checks: RulesProbeCheckItem[];
}> {
  const cleanCfg = sanitizeFirebaseConfig(config) || activeFirebaseConfig;
  const projectId = cleanCfg.projectId;
  const dbSegment = cleanCfg.firestoreDatabaseId?.trim() || '(default)';
  const cacheKey = `${RULES_COMPLIANCE_SESSION_PREFIX}${projectId}__${dbSegment}`;

  if (!bypassCache && typeof sessionStorage !== 'undefined') {
    try {
      if (sessionStorage.getItem(cacheKey) === REQUIRED_RULES_VERSION) {
        return {
          compliant: true,
          status: 'ok',
          checkedProjectId: projectId,
          checkedDbId: dbSegment,
          checks: makeAllPassedChecks(),
        };
      }
    } catch {
      // Ignore storage errors
    }
  }

  const encodedProject = encodeURIComponent(projectId);
  const encodedDb = encodeURIComponent(dbSegment);
  const encodedApiKey = encodeURIComponent(cleanCfg.apiKey);
  const encodedUid = encodeURIComponent(user.uid);
  const docsBase = `https://firestore.googleapis.com/v1/projects/${encodedProject}/databases/${encodedDb}/documents`;
  const docPrefix = `projects/${projectId}/databases/${dbSegment}/documents`;

  const runLiveProbes = async (
    idToken: string
  ): Promise<{
    compliant: boolean;
    status: 'ok' | 'outdated' | 'offline_or_quota';
    reason?: string;
    checks: RulesProbeCheckItem[];
    retryable?: boolean;
  }> => {
    const fetchProbe = async (pathOrSuffix: string, init: RequestInit = {}) => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 5000);
      try {
        const sep = pathOrSuffix.includes('?') ? '&' : '?';
        return await fetch(`${docsBase}${pathOrSuffix}${sep}key=${encodedApiKey}`, {
          ...init,
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${idToken}`,
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...(init.headers || {}),
          },
        });
      } finally {
        window.clearTimeout(timer);
      }
    };

    const probeSuffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const quizProbeId = `rules_v7_qz_${probeSuffix}`;
    const attemptProbeId = `rules_v7_at_${probeSuffix}`;
    const dummyQuestionValues = Array.from({ length: 101 }, () => ({
      mapValue: { fields: { id: { stringValue: 'p' } } },
    }));
    const dummyAnswerValues = Array.from({ length: 101 }, () => ({
      integerValue: '-1',
    }));

    const [rogueResp, starredResp, quizCommitResp, attemptCommitResp, socialResp, directChatResp] = await Promise.all([
      fetchProbe('/platform/rules_probe_check', {
        method: 'PATCH',
        body: JSON.stringify({ fields: { id: { stringValue: 'rules_probe_check' } } }),
      }),
      fetchProbe(`/users/${encodedUid}/starredQuestions/rules_v7_probe`, {
        method: 'GET',
      }),
      fetchProbe(':commit', {
        method: 'POST',
        body: JSON.stringify({
          writes: [
            {
              currentDocument: { exists: false },
              update: {
                name: `${docPrefix}/users/${user.uid}/myQuizzes/${quizProbeId}`,
                fields: {
                  id: { stringValue: quizProbeId },
                  ownerId: { stringValue: user.uid },
                  title: { stringValue: 'rules_v7_probe' },
                  questionCount: { integerValue: '101' },
                  parentQuizId: { stringValue: 'parent_probe' },
                  quizKind: { stringValue: 'drill' },
                  drillStyle: { stringValue: 'mixed' },
                  ruleTitle: { stringValue: 'probe' },
                  questions: { arrayValue: { values: dummyQuestionValues } },
                },
              },
              updateTransforms: [
                { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
                { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
              ],
            },
          ],
        }),
      }),
      fetchProbe(':commit', {
        method: 'POST',
        body: JSON.stringify({
          writes: [
            {
              currentDocument: { exists: false },
              update: {
                name: `${docPrefix}/users/${user.uid}/quizAttempts/${attemptProbeId}`,
                fields: {
                  id: { stringValue: attemptProbeId },
                  ownerId: { stringValue: user.uid },
                  title: { stringValue: 'rules_v7_probe' },
                  settings: { mapValue: { fields: {} } },
                  tableAnswers: { mapValue: { fields: {} } },
                  questions: { arrayValue: { values: dummyQuestionValues } },
                  answers: { arrayValue: { values: dummyAnswerValues } },
                  score: { integerValue: '0' },
                  total: { integerValue: '101' },
                  durationSec: { integerValue: '1' },
                  finishedAt: { integerValue: '1' },
                },
              },
              updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }],
            },
          ],
        }),
      }),
      fetchProbe(`/leaderboardUsers/${encodedUid}`, {
        method: 'GET',
      }),
      fetchProbe(`/directChats/${encodedUid}__probe_chat_check`, {
        method: 'GET',
      }),
    ]);

    // Immediate cleanup of any created probe documents (even if another probe failed)
    const cleanupPromises: Promise<unknown>[] = [];
    if (rogueResp.ok) {
      cleanupPromises.push(
        fetchProbe('/platform/rules_probe_check', { method: 'DELETE' }).catch(() => undefined)
      );
    }
    if (quizCommitResp.ok) {
      cleanupPromises.push(
        fetchProbe(`/users/${encodedUid}/myQuizzes/${quizProbeId}`, { method: 'DELETE' }).catch(
          () => undefined
        )
      );
    }
    if (attemptCommitResp.ok) {
      cleanupPromises.push(
        fetchProbe(`/users/${encodedUid}/quizAttempts/${attemptProbeId}`, {
          method: 'DELETE',
        }).catch(() => undefined)
      );
    }
    await Promise.all(cleanupPromises);

    // Check quota exhaustion (429) — not a rules failure
    if (
      rogueResp.status === 429 ||
      starredResp.status === 429 ||
      quizCommitResp.status === 429 ||
      attemptCommitResp.status === 429 ||
      socialResp.status === 429 ||
      directChatResp.status === 429
    ) {
      return {
        compliant: true,
        status: 'offline_or_quota',
        reason: 'تم استهلاك حصة القراءة/الكتابة اليومية مؤقتاً أثناء الفحص.',
        checks: makeAllPassedChecks(),
      };
    }

    const antiTestModeOk = rogueResp.status === 403;
    const starredOk = starredResp.ok || starredResp.status === 404;
    const myQuizzesOk = quizCommitResp.ok;
    const attemptsOk = attemptCommitResp.ok;
    const socialOk =
      (socialResp.ok || socialResp.status === 404) &&
      (directChatResp.ok || directChatResp.status === 404);

    const checks: RulesProbeCheckItem[] = [
      {
        id: 'anti_test_mode',
        label: 'حماية القاعدة ضد الكتابة المفتوحة (غير Test Mode)',
        passed: antiTestModeOk,
        detail: antiTestModeOk
          ? 'محمية ضد الكتابة العشوائية'
          : 'القاعدة مفتوحة بالكامل (Test Mode) بلا حماية!',
      },
      {
        id: 'starred',
        label: 'صلاحية «الأسئلة المميزة ⭐» (starredQuestions)',
        passed: starredOk,
        detail: starredOk
          ? 'مسموحة ومؤمّنة للمستخدم'
          : 'مرفوضة (403) — قواعد الأمان قديمة ولا تتضمن starredQuestions',
      },
      {
        id: 'my_quizzes_v7',
        label: 'اختبارات التقوية وحد الـ 10,000 سؤال (myQuizzes)',
        passed: myQuizzesOk,
        detail: myQuizzesOk
          ? 'تقبل حقول التقوية وأكثر من 100 سؤال'
          : `فشل الاختبار الفعلي (${quizCommitResp.status}) — القواعد ترفض +100 سؤال أو حقول اختبارات التقوية`,
      },
      {
        id: 'attempts_v7',
        label: 'سجل المحاولات وإجابات الجداول (quizAttempts)',
        passed: attemptsOk,
        detail: attemptsOk
          ? 'تقبل إجابات الجداول وأكثر من 100 سؤال'
          : `فشل الاختبار الفعلي (${attemptCommitResp.status}) — القواعد ترفض tableAnswers أو +100 سؤال`,
      },
      {
        id: 'social_v8',
        label: 'لوحة الشرف والأصدقاء والمحادثات (leaderboardUsers, directChats)',
        passed: socialOk,
        detail: socialOk
          ? 'صلاحيات لوحة الشرف والأصدقاء والمحادثات الفورية مفعّلة'
          : `مرفوضة (${directChatResp.status === 403 ? 'directChats 403' : socialResp.status}) — قواعد الأمان قديمة وتحتاج تحديثاً لفتح وإرسال المحادثات`,
      },
    ];

    recordFirestoreOperations(projectId, {
      reads: 3,
      writes:
        (rogueResp.ok ? 1 : 0) + (quizCommitResp.ok ? 1 : 0) + (attemptCommitResp.ok ? 1 : 0),
      deletes: cleanupPromises.length,
    });

    if (antiTestModeOk && starredOk && myQuizzesOk && attemptsOk && socialOk) {
      return { compliant: true, status: 'ok', checks };
    }

    const failedLabels: string[] = [];
    if (!antiTestModeOk) failedLabels.push('القاعدة مفتوحة (Test Mode)');
    if (!starredOk) failedLabels.push('الأسئلة المميزة ⭐');
    if (!myQuizzesOk) failedLabels.push('حفظ +100 سؤال واختبارات التقوية');
    if (!attemptsOk) failedLabels.push('محاولات الاختبار وإجابات الجداول');
    if (!socialOk) failedLabels.push('لوحة الشرف والأصدقاء');

    return {
      compliant: false,
      status: 'outdated',
      retryable: true,
      reason: `فشل الفحص الفعلي في: ${failedLabels.join(' · ')}. انسخ قواعد firestore.rules المحدّثة وانشرها في Firebase Console.`,
      checks,
    };
  };

  try {
    let idToken = await withTimeout(user.getIdToken(false), 3500);
    let result = await runLiveProbes(idToken);

    // Retry once if user just clicked Publish (Firebase Console edge propagation 1-3s)
    if (!result.compliant && result.retryable && bypassCache) {
      await new Promise((r) => window.setTimeout(r, 1500));
      idToken = await withTimeout(user.getIdToken(true), 4000).catch(() => idToken);
      result = await runLiveProbes(idToken);
    }

    if (typeof sessionStorage !== 'undefined') {
      try {
        if (result.compliant && result.status === 'ok') {
          sessionStorage.setItem(cacheKey, REQUIRED_RULES_VERSION);
        } else if (!result.compliant) {
          sessionStorage.removeItem(cacheKey);
        }
      } catch {
        // Ignore storage errors
      }
    }

    return {
      compliant: result.compliant,
      status: result.status,
      checkedProjectId: projectId,
      checkedDbId: dbSegment,
      reason: result.reason,
      checks: result.checks,
    };
  } catch {
    // Offline or transient network issue -> avoid false alarm
    return {
      compliant: true,
      status: 'offline_or_quota',
      checkedProjectId: projectId,
      checkedDbId: dbSegment,
      reason: 'تعذر الوصول إلى خادم Firestore أثناء الفحص.',
      checks: makeAllPassedChecks(),
    };
  }
}

export async function checkAllRegisteredDatabasesRules(params: {
  activeUser: User;
  activeConfig?: FirebaseAppConfig;
  poolState?: PlatformProgrammerState | null;
  bypassCache?: boolean;
  signInTargetKey?: string;
}): Promise<DatabaseRulesCheckResult[]> {
  const {
    activeUser,
    activeConfig = activeFirebaseConfig,
    poolState,
    bypassCache = false,
    signInTargetKey,
  } = params;

  const entries: Array<{
    dbId: string;
    label: string;
    role: 'active' | 'player' | 'backup';
    config: FirebaseAppConfig;
  }> = [];
  const seenKeys = new Set<string>();

  const cleanActive = sanitizeFirebaseConfig(activeConfig) || activeFirebaseConfig;
  const activeKey = firebaseTargetKey(cleanActive);
  const matchingActiveEntry = poolState?.playerDatabases?.find((d) =>
    isSameFirebaseTarget(d.config, cleanActive)
  );
  seenKeys.add(activeKey);
  entries.push({
    dbId: matchingActiveEntry?.id || 'active',
    label: matchingActiveEntry?.label || `القاعدة النشطة (${cleanActive.projectId})`,
    role: 'active',
    config: cleanActive,
  });

  for (const dbEntry of poolState?.playerDatabases || []) {
    const clean = sanitizeFirebaseConfig(dbEntry.config);
    if (!clean) continue;
    const key = firebaseTargetKey(clean);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    entries.push({
      dbId: dbEntry.id,
      label: dbEntry.label || clean.projectId,
      role: 'player',
      config: clean,
    });
  }

  for (const dbEntry of poolState?.backupDatabases || []) {
    const clean = sanitizeFirebaseConfig(dbEntry.config);
    if (!clean) continue;
    const key = firebaseTargetKey(clean);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    entries.push({
      dbId: dbEntry.id,
      label: dbEntry.label || clean.projectId,
      role: 'backup',
      config: clean,
    });
  }

  const results = await Promise.all(
    entries.map(async (entry): Promise<DatabaseRulesCheckResult> => {
      const dbSeg = entry.config.firestoreDatabaseId?.trim() || '(default)';
      const key = firebaseTargetKey(entry.config);
      const consoleUrl = `https://console.firebase.google.com/project/${encodeURIComponent(
        entry.config.projectId
      )}/firestore/rules`;

      let dbUser: User | null = null;
      if (entry.config.projectId === cleanActive.projectId) {
        dbUser = activeUser;
      } else {
        try {
          const app = getOrInitFirebaseApp(entry.config);
          const targetAuth = getAuth(app);
          if (typeof targetAuth.authStateReady === 'function') {
            await withTimeout(targetAuth.authStateReady(), 1200).catch(() => undefined);
          }
          dbUser = targetAuth.currentUser;
          if (!dbUser && signInTargetKey === key) {
            const provider = new GoogleAuthProvider();
            provider.setCustomParameters({ prompt: 'select_account' });
            const cred = await withTimeout(signInWithPopup(targetAuth, provider), 90000);
            dbUser = cred.user;
          }
        } catch {
          dbUser = null;
        }
      }

      if (!dbUser) {
        return {
          dbId: entry.dbId,
          label: entry.label,
          role: entry.role,
          projectId: entry.config.projectId,
          firestoreDatabaseId: dbSeg,
          config: entry.config,
          status: 'needs_auth',
          compliant: true,
          reason: 'تحتاج تسجيل دخول سريع بحساب Google لإجراء الفحص الفعلي لقواعد الأمان.',
          checks: [],
          consoleUrl,
        };
      }

      const res = await checkActiveDatabaseRulesCompliance(dbUser, entry.config, bypassCache);
      return {
        dbId: entry.dbId,
        label: entry.label,
        role: entry.role,
        projectId: entry.config.projectId,
        firestoreDatabaseId: dbSeg,
        config: entry.config,
        status: res.status,
        compliant: res.compliant,
        reason: res.reason,
        checks: res.checks,
        consoleUrl,
      };
    })
  );

  // Sort outdated databases first, then needs_auth, then active/player/backup
  const rank = (r: DatabaseRulesCheckResult) =>
    r.status === 'outdated' ? 0 : r.status === 'needs_auth' ? 1 : r.role === 'active' ? 2 : 3;
  return results.sort((a, b) => rank(a) - rank(b));
}

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
    | 'announcing_backup'
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
  announcedBackupProjectId: string | null;
  backupAnnouncementWritten: boolean;
  backupAuthPopupBlocked: boolean;
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

export type VerifyStepId = 'config' | 'firestore' | 'auth' | 'rules' | 'register';
export type VerifyStepStatus = 'pending' | 'running' | 'passed' | 'failed';

export interface VerifyStepItem {
  id: VerifyStepId;
  label: string;
  status: VerifyStepStatus;
  detail?: string;
  fixHint?: string;
  consoleUrl?: string;
  actionType?: 'copy_rules' | 'copy_domain' | 'none';
}

export interface DatabaseVerificationResult {
  ok: boolean;
  config: FirebaseAppConfig;
  role: DatabaseRole;
  steps: VerifyStepItem[];
  summary?: DatabaseVerificationSummary;
  failureMessage?: string;
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
    throw new Error('يرجى لصق كود إعدادات Firebase (firebaseConfig) أولاً.');
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
    const primary = getApps().find(
      (a) =>
        a.name === '[DEFAULT]' ||
        a.name ===
          getTargetFirebaseAppName(
            activeFirebaseConfig.projectId,
            activeFirebaseConfig.firestoreDatabaseId
          )
    );
    if (primary) return primary;
  }
  const appName = getTargetFirebaseAppName(
    config.projectId,
    config.firestoreDatabaseId
  );
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

  if (isFirestorePermissionError(err)) {
    return new MigrationNeedsSetupError(
      'firestore_rules',
      projectId,
      'قاعدة البيانات الهدف ترفض الكتابة لأن قواعد الأمان (Firestore Rules) غير منشورة أو غير مطابقة.'
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
      `قاعدة البيانات (${projectId}) وصلت للحد اليومي (Quota). يرجى اختيار قاعدة أخرى.`
    );
  }
  return err instanceof Error ? err : new Error(raw);
}

/**
 * Verifies a Firebase config 100% live BEFORE adding it to either:
 *  - Player Databases (`role === 'player'`): leaves user's verified login profile registered.
 *  - Backup Signaling Databases (`role === 'backup'`): removes temporary probe doc immediately so Backup DB stays untouched.
 */
export async function verifyDatabaseBeforeAdd(params: {
  config: FirebaseAppConfig;
  role: DatabaseRole;
  existingPlayerDbs: RegisteredDatabaseEntry[];
  existingBackupDbs: RegisteredDatabaseEntry[];
  fallbackQuadName?: string;
  onStepUpdate?: (steps: VerifyStepItem[]) => void;
}): Promise<DatabaseVerificationResult> {
  const {
    config,
    role,
    existingPlayerDbs,
    existingBackupDbs,
    fallbackQuadName,
    onStepUpdate,
  } = params;

  const projectId = config.projectId;
  const dbSegment = (config.firestoreDatabaseId || '(default)').trim() || '(default)';

  const steps: VerifyStepItem[] = [
    { id: 'config', label: '1. التحقق من صيغة الإعدادات وعدم التكرار', status: 'running' },
    { id: 'firestore', label: '2. فحص تفعيل Firestore API ووجود قاعدة البيانات', status: 'pending' },
    { id: 'auth', label: '3. فحص Google Sign-In OAuth وإضافة النطاق الحالي', status: 'pending' },
    {
      id: 'rules',
      label:
        role === 'player'
          ? '4. فحص قواعد الأمان (Firestore Rules) وتسجيل حساب الدخول'
          : '4. فحص قواعد الأمان للقاعدة الاحتياطية (مع بقائها فارغة تماماً)',
      status: 'pending',
    },
    {
      id: 'register',
      label:
        role === 'player'
          ? '5. حفظ القاعدة في قائمة قواعد البيانات للاعبين'
          : '5. حفظ القاعدة في قائمة القواعد الاحتياطية الصامتة',
      status: 'pending',
    },
  ];

  const emit = () => onStepUpdate?.(steps.map((s) => ({ ...s })));
  const setStep = (id: VerifyStepId, patch: Partial<VerifyStepItem>) => {
    const item = steps.find((s) => s.id === id);
    if (item) Object.assign(item, patch);
    emit();
  };

  emit();

  // Step 1: Config & Duplicate check
  const cleanCfg = sanitizeFirebaseConfig(config);
  if (!cleanCfg) {
    const msg = 'كود إعدادات Firebase غير مكتمل أو غير صالح.';
    setStep('config', { status: 'failed', detail: msg });
    return { ok: false, config, role, steps, failureMessage: msg };
  }
  if (existingPlayerDbs.some((d) => isSameFirebaseTarget(d.config, cleanCfg))) {
    const msg = `المشروع (${projectId}) مضاف بالفعل في قائمة قواعد البيانات.`;
    setStep('config', { status: 'failed', detail: msg });
    return { ok: false, config: cleanCfg, role, steps, failureMessage: msg };
  }
  if (existingBackupDbs.some((d) => isSameFirebaseTarget(d.config, cleanCfg))) {
    const msg = `المشروع (${projectId}) مضاف بالفعل في قائمة القواعد الاحتياطية.`;
    setStep('config', { status: 'failed', detail: msg });
    return { ok: false, config: cleanCfg, role, steps, failureMessage: msg };
  }
  if (
    role === 'backup' &&
    (isSameFirebaseTarget(cleanCfg, defaultFirebaseConfig) ||
      isSameFirebaseTarget(cleanCfg, activeFirebaseConfig))
  ) {
    const msg = 'القاعدة النشطة أو الأساسية لا يمكن إضافتها كقاعدة احتياطية صامتة لا تُمس.';
    setStep('config', { status: 'failed', detail: msg });
    return { ok: false, config: cleanCfg, role, steps, failureMessage: msg };
  }
  setStep('config', {
    status: 'passed',
    detail: `تم التحقق من ${projectId} (${dbSegment})`,
  });

  // Step 2: Live Firestore REST check
  const encodedProject = encodeURIComponent(projectId);
  const encodedDb = encodeURIComponent(dbSegment);
  const encodedApiKey = encodeURIComponent(cleanCfg.apiKey);
  const firestoreDocsBaseUrl = `https://firestore.googleapis.com/v1/projects/${encodedProject}/databases/${encodedDb}/documents`;
  const firestoreDbDocPrefix = `projects/${projectId}/databases/${dbSegment}/documents`;

  const parseFirestoreRestError = async (
    resp: Response
  ): Promise<{ message: string; status: string }> => {
    try {
      const body = (await withTimeout(resp.json(), 2500)) as {
        error?: { message?: string; status?: string };
      };
      return {
        message: body?.error?.message || '',
        status: body?.error?.status || '',
      };
    } catch {
      return { message: '', status: '' };
    }
  };

  setStep('firestore', { status: 'running', detail: 'جاري الاتصال بخدمة Cloud Firestore...' });
  try {
    const url = `${firestoreDocsBaseUrl}/platform/migration?key=${encodedApiKey}`;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 4500);
    const resp = await fetch(url, { cache: 'no-store', signal: controller.signal });
    window.clearTimeout(timer);

    if (!resp.ok) {
      const { message: errMsg } = await parseFirestoreRestError(resp);
      const lowerErr = errMsg.toLowerCase();

      if (
        resp.status === 400 &&
        (lowerErr.includes('api key not valid') || lowerErr.includes('api_key_invalid'))
      ) {
        const msg = `مفتاح apiKey غير صحيح للمشروع ${projectId}. تأكد من نسخ الإعدادات كاملة.`;
        setStep('firestore', {
          status: 'failed',
          detail: msg,
          fixHint: 'افتح Project Settings في Firebase Console وانسخ firebaseConfig بدقة.',
          consoleUrl: `https://console.firebase.google.com/project/${projectId}/settings/general`,
        });
        return { ok: false, config: cleanCfg, role, steps, failureMessage: msg };
      }

      if (
        lowerErr.includes('service_disabled') ||
        lowerErr.includes('cloud firestore api has not been used') ||
        lowerErr.includes('firestore.googleapis.com')
      ) {
        const msg = `خدمة Cloud Firestore API غير مفعّلة بعد في المشروع ${projectId}.`;
        setStep('firestore', {
          status: 'failed',
          detail: msg,
          fixHint: 'افتح رابط إنشاء قاعدة البيانات واضغط Create database في Firebase Console.',
          consoleUrl: `https://console.firebase.google.com/project/${projectId}/firestore`,
        });
        return { ok: false, config: cleanCfg, role, steps, failureMessage: msg };
      }

      const isMissingDatabase =
        resp.status === 404 &&
        ((lowerErr.includes('database') && lowerErr.includes('does not exist')) ||
          lowerErr.includes('not have a default cloud firestore') ||
          (lowerErr.includes('database') &&
            lowerErr.includes('not found') &&
            !lowerErr.includes('document')));

      if (isMissingDatabase) {
        const msg = `لم يتم إنشاء قاعدة Firestore Database (${dbSegment}) داخل المشروع ${projectId} حتى الآن.`;
        setStep('firestore', {
          status: 'failed',
          detail: msg,
          fixHint: 'اضغط "إنشاء قاعدة Firestore" ثم اختر Production Mode واختر الموقع واضغط Enable.',
          consoleUrl: `https://console.firebase.google.com/project/${projectId}/firestore`,
        });
        return { ok: false, config: cleanCfg, role, steps, failureMessage: msg };
      }
      // 404 Document not found OR 403 PERMISSION_DENIED (non-SERVICE_DISABLED) confirms Firestore DB exists!
    }
    setStep('firestore', {
      status: 'passed',
      detail: `Cloud Firestore مفعّلة وتستجيب (${dbSegment})`,
    });
  } catch {
    const msg = 'تعذر الوصول إلى خوادم Firestore — تحقق من اتصال الإنترنت أو إعدادات المشروع.';
    setStep('firestore', { status: 'failed', detail: msg });
    return { ok: false, config: cleanCfg, role, steps, failureMessage: msg };
  }

  // Step 3: Google OAuth & Domain Check + Authentication Sign-In
  setStep('auth', {
    status: 'running',
    detail: 'جاري التحقق من Google Sign-In OAuth والنطاق المصرّح به...',
  });

  const targetApp = getOrInitFirebaseApp(cleanCfg);
  const targetAuth = getAuth(targetApp);
  if (typeof targetAuth.authStateReady === 'function') {
    await withTimeout(targetAuth.authStateReady(), 1800).catch(() => undefined);
  }
  let verifiedUser: User | null = targetAuth.currentUser;
  let verifiedIdToken = '';

  try {
    if (verifiedUser) {
      try {
        verifiedIdToken = await withTimeout(verifiedUser.getIdToken(false), 4500);
      } catch {
        verifiedUser = null;
      }
    }

    if (!verifiedUser) {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const cred = await withTimeout(signInWithPopup(targetAuth, provider), 90000);
      verifiedUser = cred.user;
      verifiedIdToken = await withTimeout(verifiedUser.getIdToken(false), 4500);
    }

    if (!verifiedUser.emailVerified) {
      const msg = 'حساب Google المختار غير مُفعّل البريد الإلكتروني (email_verified).';
      setStep('auth', {
        status: 'failed',
        detail: msg,
        fixHint: 'استخدم حساب Google موثّق البريد الإلكتروني ثم أعد الفحص.',
      });
      return { ok: false, config: cleanCfg, role, steps, failureMessage: msg };
    }

    setStep('auth', {
      status: 'passed',
      detail: `تم التحقق من Google OAuth بنجاح (${verifiedUser.email || verifiedUser.uid})`,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const lower = raw.toLowerCase();
    if (
      lower.includes('auth/operation-not-allowed') ||
      lower.includes('auth/configuration-not-found')
    ) {
      const msg = `تسجيل الدخول عبر Google غير مفعّل في المشروع ${projectId}.`;
      setStep('auth', {
        status: 'failed',
        detail: msg,
        fixHint:
          'ادخل إلى Authentication -> Sign-in method -> Add new provider -> Google -> Enable ثم Save.',
        consoleUrl: `https://console.firebase.google.com/project/${projectId}/authentication/providers`,
      });
      return { ok: false, config: cleanCfg, role, steps, failureMessage: msg };
    }
    if (lower.includes('auth/unauthorized-domain')) {
      const msg = `النطاق الحالي (${window.location.hostname}) غير مضاف ضمن Authorized domains في ${projectId}.`;
      setStep('auth', {
        status: 'failed',
        detail: msg,
        fixHint:
          'انسخ النطاق أدناه وأضفه داخل Authentication -> Settings -> Authorized domains -> Add domain.',
        consoleUrl: `https://console.firebase.google.com/project/${projectId}/authentication/settings`,
        actionType: 'copy_domain',
      });
      return { ok: false, config: cleanCfg, role, steps, failureMessage: msg };
    }
    if (lower.includes('auth/popup-blocked')) {
      const msg = 'تم حظر نافذة تسجيل الدخول المنبثقة. اسمح بالنوافذ المنبثقة وأعد المحاولة.';
      setStep('auth', { status: 'failed', detail: msg });
      return { ok: false, config: cleanCfg, role, steps, failureMessage: msg };
    }
    if (lower === 'timeout') {
      const msg = 'انتهت مهلة نافذة تسجيل الدخول بـ Google. تأكد من عدم إغلاق النافذة ثم أعد المحاولة.';
      setStep('auth', { status: 'failed', detail: msg });
      return { ok: false, config: cleanCfg, role, steps, failureMessage: msg };
    }
    const msg =
      lower.includes('auth/popup-closed-by-user')
        ? 'تم إغلاق نافذة تسجيل الدخول قبل إتمام التحقق.'
        : `فشل التحقق من المصادقة: ${raw}`;
    setStep('auth', { status: 'failed', detail: msg });
    return { ok: false, config: cleanCfg, role, steps, failureMessage: msg };
  }

  // Step 4: Hardened Firestore Rules Probe via Direct REST API (zero SDK cache / WebChannel hangs)
  const firestoreRestRequest = async (
    pathOrSuffix: string,
    init: RequestInit = {},
    timeoutMs = 4500
  ): Promise<Response> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const sep = pathOrSuffix.includes('?') ? '&' : '?';
      return await fetch(`${firestoreDocsBaseUrl}${pathOrSuffix}${sep}key=${encodedApiKey}`, {
        ...init,
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${verifiedIdToken}`,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
    } finally {
      window.clearTimeout(timer);
    }
  };

  type RulesProbeOutcome =
    | { ok: true; wroteProfile: boolean }
    | {
        ok: false;
        retryablePropagation: boolean;
        detail: string;
        fixHint: string;
      };

  const runLiveRulesProbes = async (currentUser: User): Promise<RulesProbeOutcome> => {
    // Run 4A (negative security test), 4B (rooms + platform/migration read), 4C (profile write probe),
    // and optional existing profile GET IN PARALLEL for instant (~250ms) live verification.
    // NOTE: Do NOT use __*__ IDs as Firestore rejects them as reserved (400 INVALID_ARGUMENT).
    setStep('rules', {
      status: 'running',
      detail: '4. جاري اختبار الحماية ومسارات القواعد وتسجيل الدخول بالتوازي...',
    });

    const rawCandidate =
      fallbackQuadName && isQuadNameValid(fallbackQuadName)
        ? fallbackQuadName.trim()
        : currentUser.displayName && isQuadNameValid(currentUser.displayName)
        ? currentUser.displayName.trim()
        : MASTER_PROGRAMMER_NAME;
    const quadCandidate = (
      rawCandidate.length >= 5 ? rawCandidate : MASTER_PROGRAMMER_NAME
    ).slice(0, 120);
    const emailCandidate = (currentUser.email || 'programmer@example.com').slice(0, 200);

    const probeDocId = `verify_probe_${Date.now()}`;
    const probePath = `/users/${encodeURIComponent(currentUser.uid)}/private/${probeDocId}`;
    const profilePath = `/users/${encodeURIComponent(currentUser.uid)}/private/profile`;
    const starredCheckPath = `/users/${encodeURIComponent(
      currentUser.uid
    )}/starredQuestions/rules_v5_check`;

    const [
      rogueResp,
      roomReadResp,
      migrationReadResp,
      createProbeResp,
      starredReadResp,
      existingProfileResp,
    ] = await Promise.all([
      firestoreRestRequest(':commit', {
        method: 'POST',
        body: JSON.stringify({
          writes: [
            {
              update: {
                name: `${firestoreDbDocPrefix}/platform/rules_probe_check`,
                fields: {
                  probe: { booleanValue: true },
                  ts: { integerValue: String(Date.now()) },
                },
              },
            },
          ],
        }),
      }),
      firestoreRestRequest('/rooms/verify_probe_room_check', { method: 'GET' }),
      firestoreRestRequest('/platform/migration', { method: 'GET' }),
      firestoreRestRequest(':commit', {
        method: 'POST',
        body: JSON.stringify({
          writes: [
            {
              currentDocument: { exists: false },
              update: {
                name: `${firestoreDbDocPrefix}/users/${currentUser.uid}/private/${probeDocId}`,
                fields: {
                  uid: { stringValue: currentUser.uid },
                  fullNameQuad: { stringValue: quadCandidate },
                  email: { stringValue: emailCandidate },
                },
              },
              updateTransforms: [
                { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
                { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
              ],
            },
          ],
        }),
      }),
      firestoreRestRequest(starredCheckPath, { method: 'GET' }),
      role === 'player'
        ? firestoreRestRequest(profilePath, { method: 'GET' })
        : Promise.resolve(null),
    ]);

    // Check 4A negative probe
    if (rogueResp.ok) {
      void firestoreRestRequest('/platform/rules_probe_check', { method: 'DELETE' }).catch(
        () => undefined
      );
      return {
        ok: false,
        retryablePropagation: true,
        detail: `قاعدة ${projectId} (${dbSegment}) ما زالت على وضع الاختبار المفتوح (Test Mode) ولم تُنشر قواعد firestore.rules الآمنة بعد!`,
        fixHint:
          'انسخ قواعد firestore.rules الكاملة وألصقها في Firebase Console -> Firestore -> Rules (لنفس القاعدة) ثم اضغط Publish.',
      };
    }

    if (rogueResp.status === 429) {
      return {
        ok: false,
        retryablePropagation: false,
        detail: `تم استهلاك الحصة المجانية اليومية للقاعدة (${projectId}) في Firebase (429 Quota Exceeded).`,
        fixHint: 'انتظر التصفير اليومي لحصة Firebase أو أضف مشروعاً جديداً بحصة مجانية متاحة.',
      };
    }

    if (rogueResp.status !== 403) {
      const { message: rogueErr } = await parseFirestoreRestError(rogueResp);
      return {
        ok: false,
        retryablePropagation: false,
        detail: `استجابة غير متوقعة أثناء فحص الحماية (${rogueResp.status}): ${rogueErr || rogueResp.statusText}`,
        fixHint:
          'تأكد من تفعيل Cloud Firestore للقاعدة المختارة ومن صحة معرّف القاعدة (default) ثم أعد الفحص.',
      };
    }

    // Check 4B read probes
    if (roomReadResp.status === 403 || migrationReadResp.status === 403) {
      const deniedTargets = [
        roomReadResp.status === 403 ? 'rooms' : null,
        migrationReadResp.status === 403 ? 'platform/migration' : null,
      ]
        .filter(Boolean)
        .join(' و ');
      return {
        ok: false,
        retryablePropagation: true,
        detail: `تم رفض قراءة (${deniedTargets}) في ${projectId} (${dbSegment}) — إما أن القواعد ما زالت على الوضع المغلق (Production Mode) أو أُلصقت نسخة قديمة قبل تحديث المنصة.`,
        fixHint:
          'اضغط "نسخ firestore.rules" أدناه واستبدل محتوى Rules بالكامل في Firebase Console (بعد حذف القديم) ثم اضغط Publish.',
      };
    }

    if (roomReadResp.status === 429 || migrationReadResp.status === 429) {
      return {
        ok: false,
        retryablePropagation: false,
        detail: `تم استهلاك الحصة المجانية اليومية للقاعدة (${projectId}) في Firebase (429 Quota Exceeded).`,
        fixHint: 'انتظر التصفير اليومي لحصة Firebase أو استخدم مشروعاً آخر.',
      };
    }

    if (
      (roomReadResp.status !== 200 && roomReadResp.status !== 404) ||
      (migrationReadResp.status !== 200 && migrationReadResp.status !== 404)
    ) {
      const errBody =
        roomReadResp.status >= 400 && roomReadResp.status !== 404
          ? await parseFirestoreRestError(roomReadResp)
          : await parseFirestoreRestError(migrationReadResp);
      return {
        ok: false,
        retryablePropagation: false,
        detail: `تعذر قراءة مسارات القواعد (${errBody.message || 'خطأ غير معروف'}).`,
        fixHint: 'تحقق من إعدادات Firestore Database والقواعد المنشورة ثم أعد الفحص.',
      };
    }

    // Check 4C create probe
    if (!createProbeResp.ok) {
      const { message: createErr } = await parseFirestoreRestError(createProbeResp);
      const isDenied = createProbeResp.status === 403;
      return {
        ok: false,
        retryablePropagation: isDenied,
        detail: isDenied
          ? `فشلت صلاحية إنشاء ملف المستخدم (${dbSegment}) تحت firestore.rules — تأكد من نسخ القواعد الكاملة دون نقص في دوال التحقق.`
          : `فشل اختبار كتابة الملف الشخصي (${createProbeResp.status}): ${createErr || createProbeResp.statusText}`,
        fixHint:
          'اضغط "نسخ firestore.rules" وتأكد من استبدال النص كاملاً داخل Rules ثم اضغط Publish.',
      };
    }

    // Check 4D latest v5 rules compliance (starredQuestions + tableAnswers + table fields)
    if (role === 'player' && starredReadResp.status === 403) {
      return {
        ok: false,
        retryablePropagation: true,
        detail: `قاعدة ${projectId} (${dbSegment}) تستخدم نسخة قديمة من firestore.rules لا تدعم «الأسئلة المميزة ⭐» وجداول الاختبارات المحدّثة!`,
        fixHint:
          'اضغط «نسخ firestore.rules» بالأسفل لاستبدال القواعد القديمة في Firebase Console -> Firestore -> Rules ثم اضغط Publish وأعد الفحص.',
      };
    }

    // Second parallel step: cleanup temporary probe doc AND register user profile if needed
    const needsProfileCreate = role === 'player' && existingProfileResp?.status === 404;
    const [deleteProbeResp, writeProfileResp] = await Promise.all([
      firestoreRestRequest(probePath, { method: 'DELETE' }),
      needsProfileCreate
        ? firestoreRestRequest(':commit', {
            method: 'POST',
            body: JSON.stringify({
              writes: [
                {
                  currentDocument: { exists: false },
                  update: {
                    name: `${firestoreDbDocPrefix}/users/${currentUser.uid}/private/profile`,
                    fields: {
                      uid: { stringValue: currentUser.uid },
                      fullNameQuad: { stringValue: quadCandidate },
                      email: { stringValue: emailCandidate },
                    },
                  },
                  updateTransforms: [
                    { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
                    { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
                  ],
                },
              ],
            }),
          })
        : Promise.resolve(null),
    ]);

    if (!deleteProbeResp.ok && deleteProbeResp.status === 403) {
      return {
        ok: false,
        retryablePropagation: true,
        detail: 'تم السماح بالإنشاء لكن رُفضت صلاحية الحذف في users/private — القواعد غير مطابقة بالكامل.',
        fixHint: 'انسخ firestore.rules الكاملة وألصقها في Firebase Console ثم اضغط Publish.',
      };
    }

    if (writeProfileResp && !writeProfileResp.ok && writeProfileResp.status === 403) {
      return {
        ok: false,
        retryablePropagation: true,
        detail: 'تعذر تسجيل ملف الدخول الشخصي على قاعدة البيانات الجديدة بموجب القواعد الحالية.',
        fixHint: 'انسخ firestore.rules الكاملة وأعد نشرها (Publish) ثم أعد الفحص.',
      };
    }

    return { ok: true, wroteProfile: needsProfileCreate };
  };

  setStep('rules', {
    status: 'running',
    detail: 'جاري اختبار قواعد الأمان (Firestore Rules) عبر الاتصال المباشر...',
  });

  try {
    let probeOutcome = await runLiveRulesProbes(verifiedUser);

    // Firebase Console rule publishing can take 1-3 seconds to propagate to all edge nodes.
    // Auto-retry once if the failure looks like unpropagated rules (Test Mode or Locked Mode 403).
    if (!probeOutcome.ok && probeOutcome.retryablePropagation) {
      setStep('rules', {
        status: 'running',
        detail: 'جاري انتظار تفعيل القواعد المنشورة حديثاً على خوادم Google وإعادة الفحص تلقائياً...',
      });
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      verifiedIdToken = await withTimeout(verifiedUser.getIdToken(true), 4500);
      probeOutcome = await runLiveRulesProbes(verifiedUser);
    }

    if (!probeOutcome.ok) {
      setStep('rules', {
        status: 'failed',
        detail: probeOutcome.detail,
        fixHint: probeOutcome.fixHint,
        consoleUrl: `https://console.firebase.google.com/project/${projectId}/firestore/rules`,
        actionType: 'copy_rules',
      });
      return { ok: false, config: cleanCfg, role, steps, failureMessage: probeOutcome.detail };
    }

    // Track live REST operations toward Spark free-tier quota
    recordFirestoreOperations(projectId, {
      reads: role === 'player' ? 3 : 2,
      writes: probeOutcome.wroteProfile ? 2 : 1,
      deletes: 1,
    });

    setStep('rules', {
      status: 'passed',
      detail:
        role === 'player'
          ? 'قواعد الأمان مطبّقة 100% وتم تسجيل حساب الدخول على القاعدة'
          : 'قواعد الأمان مطبّقة 100% والقاعدة الاحتياطية فارغة وجاهزة للإعلان فقط',
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const lower = raw.toLowerCase();
    const isAbort = lower.includes('abort') || lower.includes('timeout');
    const isPerm = isFirestorePermissionError(err);
    const msg = isAbort
      ? `انتهت مهلة الاتصال بخادم Firestore أثناء فحص القواعد (${projectId}). تأكد من الشبكة وأعد المحاولة.`
      : isPerm
      ? `قواعد الأمان (Firestore Rules) في المشروع ${projectId} ناقصة أو مغلقة ولا تطابق نظام المنصة.`
      : `تعذر فحص قواعد الأمان في ${projectId}: ${raw}`;
    setStep('rules', {
      status: 'failed',
      detail: msg,
      fixHint: 'انسخ firestore.rules الرسمية للمنصة وألصقها في قسم Rules ثم اضغط Publish وأعد الفحص.',
      consoleUrl: `https://console.firebase.google.com/project/${projectId}/firestore/rules`,
      actionType: 'copy_rules',
    });
    return { ok: false, config: cleanCfg, role, steps, failureMessage: msg };
  }

  // Step 5: Keep as 'running' until addPlayerDatabase / addBackupDatabase confirms actual persistence!
  setStep('register', {
    status: 'running',
    detail:
      role === 'player'
        ? 'جاري الحفظ الفعلي في قواعد البيانات والربط مع البرنامج بالكامل...'
        : 'جاري الحفظ الفعلي في قائمة القواعد الاحتياطية الصامتة...',
  });
  const summary: DatabaseVerificationSummary = {
    firestoreReady: true,
    googleAuthReady: true,
    rulesReady: true,
    verifiedAt: Date.now(),
    verifiedByEmail: verifiedUser.email || undefined,
  };

  return {
    ok: true,
    config: cleanCfg,
    role,
    steps,
    summary,
  };
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
  starredQuestions: StarredQuestion[];
}

function cleanQuizQuestionForFirestore(q: MyQuiz['questions'][number]): Record<string, unknown> {
  const chart = q.chart ? sanitizeChart(q.chart) : null;
  const figure = q.figure ? sanitizeFigure(q.figure) : null;
  const table = q.table ? encodeTableForFirestore(q.table) : null;
  const dataTable = q.dataTable ? encodeDataTableForFirestore(q.dataTable) : null;
  const expChart = q.explanationChart ? sanitizeChart(q.explanationChart) : null;
  const expFigure = q.explanationFigure ? sanitizeFigure(q.explanationFigure) : null;
  const expTable = q.explanationTable ? encodeExplanationTableForFirestore(q.explanationTable) : null;
  const expComp = q.explanationComparison
    ? sanitizeExplanationComparison(q.explanationComparison)
    : null;
  const laws = sanitizeQuestionLaws(q.laws);
  return {
    ...(laws ? { laws } : {}),
    ...(chart ? { chart } : {}),
    ...(figure ? { figure } : {}),
    ...(table ? { questionType: 'table', table } : {}),
    ...(dataTable ? { dataTable } : {}),
    ...(expChart ? { explanationChart: expChart } : {}),
    ...(expFigure ? { explanationFigure: expFigure } : {}),
    ...(expTable ? { explanationTable: expTable } : {}),
    ...(expComp ? { explanationComparison: expComp } : {}),
    id: String(q.id || '').slice(0, 64) || `q_${Math.random().toString(36).slice(2, 10)}`,
    text: String(q.text || '').slice(0, 2000),
    choices: Array.isArray(q.choices)
      ? q.choices.map((c) => String(c).slice(0, 500)).slice(0, 8)
      : [],
    correctIndex: Number.isInteger(q.correctIndex) ? q.correctIndex : -1,
    answer: String(q.answer || '').slice(0, 1000),
    explanation: String(q.explanation || '').slice(0, 4000),
  };
}

function cleanStarredQuestionForFirestore(
  item: StarredQuestion,
  ownerUid: string
): Record<string, unknown> {
  const baseQ = cleanQuizQuestionForFirestore(item.question);
  return {
    id: String(item.id || '').slice(0, 128),
    ownerId: ownerUid,
    ...(item.sourceQuizId ? { sourceQuizId: String(item.sourceQuizId).slice(0, 120) } : {}),
    ...(item.sourceTitle ? { sourceTitle: String(item.sourceTitle).slice(0, 160) } : {}),
    question: baseQ,
    starredAt:
      Number.isFinite(Number(item.starredAt)) && Number(item.starredAt) > 0
        ? Math.round(Number(item.starredAt))
        : Date.now(),
  };
}

function cleanSavedQuestionForFirestore(
  sq: SavedQuestion,
  ownerUid: string
): Record<string, unknown> {
  const chart = sq.chart ? sanitizeChart(sq.chart) : null;
  const figure = sq.figure ? sanitizeFigure(sq.figure) : null;
  const table = sq.table ? encodeTableForFirestore(sq.table) : null;
  const dataTable = sq.dataTable ? encodeDataTableForFirestore(sq.dataTable) : null;
  const expChart = sq.explanationChart ? sanitizeChart(sq.explanationChart) : null;
  const expFigure = sq.explanationFigure ? sanitizeFigure(sq.explanationFigure) : null;
  const expTable = sq.explanationTable ? encodeExplanationTableForFirestore(sq.explanationTable) : null;
  const expComp = sq.explanationComparison
    ? sanitizeExplanationComparison(sq.explanationComparison)
    : null;
  const laws = 'laws' in sq ? sanitizeQuestionLaws((sq as { laws?: unknown }).laws) : null;

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
    ...(sq.explanation ? { explanation: String(sq.explanation).slice(0, 4000) } : {}),
    ...(laws ? { laws } : {}),
    ...(chart ? { chart } : {}),
    ...(figure ? { figure } : {}),
    ...(table ? { questionType: 'table', table } : {}),
    ...(dataTable ? { dataTable } : {}),
    ...(expChart ? { explanationChart: expChart } : {}),
    ...(expFigure ? { explanationFigure: expFigure } : {}),
    ...(expTable ? { explanationTable: expTable } : {}),
    ...(expComp ? { explanationComparison: expComp } : {}),
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
      getDocs(
        query(collection(fromDb, 'rooms', room.id, 'participants'), where('roomId', '==', room.id))
      )
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
      getDocs(
        query(collection(fromDb, 'rooms', room.id, 'questions'), where('roomId', '==', room.id))
      )
    );
    const list: Question[] = [];
    qSnap.forEach((d) =>
      list.push(decodeQuizQuestionFromFirestore(d.data() as Record<string, unknown>) as unknown as Question)
    );
    list.sort((a, b) => a.orderIndex - b.orderIndex);
    if (list.length > 0) questions = list;
  } catch {
    // Keep cached
  }

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
      // Keep cached
    }
  }

  let slides: InteractiveSlide[] = useCached?.slides ?? [];
  try {
    const sSnap = await withTimeout(
      getDocs(
        query(collection(fromDb, 'rooms', room.id, 'slides'), where('roomId', '==', room.id))
      )
    );
    const list: InteractiveSlide[] = [];
    sSnap.forEach((d) => list.push(d.data() as InteractiveSlide));
    list.sort((a, b) => a.pageIndex - b.pageIndex);
    if (list.length > 0) slides = list;
  } catch {
    // Keep cached
  }

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
      // Ignore
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

  const sharedQuizzes: SharedQuiz[] = [];
  try {
    const sqSnap = await withTimeout(
      getDocs(
        query(collection(fromDb, 'rooms', room.id, 'sharedQuizzes'), where('roomId', '==', room.id))
      )
    );
    sqSnap.forEach((d) => sharedQuizzes.push(decodeSharedQuizFromFirestore(d.data() as SharedQuiz)));
  } catch {
    // Ignore
  }

  const competitions: Competition[] = [];
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
            // Ignore
          }
        }
      } catch {
        // Ignore
      }
    }
  } catch {
    // Ignore
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
  const cachedStarred = await loadSessionSnapshot<StoredStarredQuestionsSnapshot>('starred_questions');

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
    message: 'جاري تجميع الغرف والشرائح والصبورات والأسئلة من القاعدة الحالية...',
  });

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
      // Keep active/cached rooms if list fails
    }
  }

  const candidateRooms = Array.from(candidateRoomsMap.values());
  const rooms: CollectedRoomData[] = [];
  for (const r of candidateRooms) {
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
            // Keep cached questions for this test
          }
        }
      }
    } catch {
      // Use cached snapshot
    }
  }

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
      qzSnap.forEach((d) => live.push(decodeMyQuizFromFirestore(d.data() as MyQuiz)));
      myQuizzes = live;
    } catch {
      // Keep local snapshot
    }
    try {
      const metaOverrides = await loadMyQuizMetaOverrides(oldUid);
      if (Object.keys(metaOverrides).length > 0) {
        myQuizzes = myQuizzes.map((q) => {
          const ov = metaOverrides[q.id];
          if (!ov) return q;
          return {
            ...q,
            parentQuizId: q.parentQuizId || ov.parentQuizId,
            quizKind: q.quizKind || ov.quizKind,
            drillStyle: q.drillStyle || ov.drillStyle,
            sourceStarredId: q.sourceStarredId || ov.sourceStarredId,
            ruleTitle: q.ruleTitle || ov.ruleTitle,
          };
        });
      }
    } catch {
      // Non-fatal
    }
  }

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
      atSnap.forEach((d) => live.push(decodeExamAttemptFromFirestore(d.data() as QuizAttempt)));
      quizAttempts = live;
    } catch {
      // Keep local snapshot
    }
  }

  let starredQuestions: StarredQuestion[] =
    cachedStarred && (!oldUid || cachedStarred.ownerId === oldUid) ? cachedStarred.items : [];
  if (oldUid) {
    try {
      const starSnap = await withTimeout(
        getDocs(
          query(
            collection(fromDb, 'users', oldUid, 'starredQuestions'),
            where('ownerId', '==', oldUid)
          )
        ),
        7000
      );
      const live: StarredQuestion[] = [];
      starSnap.forEach((d) => live.push(decodeStarredQuestionFromFirestore(d.data() as StarredQuestion)));
      if (live.length > 0) {
        starredQuestions = live;
      }
    } catch {
      // Keep local snapshot (also safe if source DB has older rules without starredQuestions)
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
    starredQuestions,
  };
}

async function signInOnTarget(
  targetConfig: FirebaseAppConfig
): Promise<{ targetApp: FirebaseApp; targetDb: Firestore; targetUser: User }> {
  const targetApp = getOrInitFirebaseApp(targetConfig);
  const targetAuth = getAuth(targetApp);
  if (typeof targetAuth.authStateReady === 'function') {
    await withTimeout(targetAuth.authStateReady(), 1800).catch(() => undefined);
  }
  const targetDb = createFirestoreInstance(targetApp, targetConfig);

  let targetUser = targetAuth.currentUser;
  if (targetUser) {
    try {
      await withTimeout(targetUser.getIdToken(false), 4500);
    } catch {
      targetUser = null;
    }
  }
  if (!targetUser) {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const cred = await withTimeout(signInWithPopup(targetAuth, provider), 90000);
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
    (targetUser.displayName && targetUser.displayName.trim().split(/\s+/).length >= 4
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
  starredQuestions?: StarredQuestion[];
  skipExisting?: boolean;
  onItemDone?: (kind: 'saved' | 'quiz' | 'attempt' | 'starred', label: string) => void;
}): Promise<{
  migratedSavedTestsCount: number;
  migratedMyQuizzesCount: number;
  migratedAttemptsCount: number;
  migratedStarredCount: number;
}> {
  const {
    targetDb,
    targetUid,
    savedTests,
    savedQuestionsByTestId,
    myQuizzes,
    quizAttempts,
    starredQuestions = [],
    skipExisting = false,
    onItemDone,
  } = params;

  let migratedSavedTestsCount = 0;
  for (const test of savedTests) {
    const testRef = doc(targetDb, 'users', targetUid, 'savedTests', test.id);
    const existingSaved = await getDoc(testRef);
    const savedQuestions = savedQuestionsByTestId[test.id] ?? [];

    if (existingSaved.exists()) {
      if (skipExisting) {
        continue;
      }
      // Explicitly update existing savedTest metadata + sync any missing or updated savedQuestions
      for (const sq of savedQuestions) {
        const sqRef = doc(targetDb, 'users', targetUid, 'savedTests', test.id, 'questions', sq.id);
        const sqSnap = await getDoc(sqRef);
        if (!sqSnap.exists()) {
          await setDoc(sqRef, cleanSavedQuestionForFirestore(sq, targetUid));
        } else {
          const oldSq = sqSnap.data() as SavedQuestion;
          const needsReplace =
            oldSq.status !== sq.status ||
            (sq.boards?.length ?? 0) > (oldSq.boards?.length ?? 0);
          if (needsReplace) {
            await deleteDoc(sqRef).catch(() => undefined);
            await setDoc(sqRef, cleanSavedQuestionForFirestore(sq, targetUid));
          }
        }
      }
      await updateDoc(testRef, {
        title: (test.title || 'اختبار محفوظ').slice(0, 120),
        totalQuestions: Math.min(
          200,
          Math.max(0, savedQuestions.length || test.totalQuestions || 0)
        ),
        participantsSummary: (test.participantsSummary || []).slice(0, 100),
        updatedAt: serverTimestamp(),
      });
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
      totalQuestions: Math.min(
        200,
        Math.max(0, savedQuestions.length || test.totalQuestions || 0)
      ),
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
    const questions = quiz.questions.slice(0, 10000).map(cleanQuizQuestionForFirestore);
    const metaFields: Record<string, unknown> = {
      ...(quiz.parentQuizId ? { parentQuizId: String(quiz.parentQuizId).slice(0, 128) } : {}),
      ...(quiz.quizKind === 'main' || quiz.quizKind === 'drill'
        ? { quizKind: quiz.quizKind }
        : {}),
      ...(quiz.drillStyle === 'same_values' ||
      quiz.drillStyle === 'same_law_ideas' ||
      quiz.drillStyle === 'mixed'
        ? { drillStyle: quiz.drillStyle }
        : {}),
      ...(quiz.sourceStarredId
        ? { sourceStarredId: String(quiz.sourceStarredId).slice(0, 128) }
        : {}),
      ...(quiz.ruleTitle ? { ruleTitle: String(quiz.ruleTitle).slice(0, 120) } : {}),
    };
    const coreUpdatePayload = {
      title: (quiz.title || 'اختبار').slice(0, 120),
      questions,
      questionCount: questions.length,
      updatedAt: serverTimestamp(),
    };
    const coreCreatePayload = {
      id: quiz.id,
      ownerId: targetUid,
      ...coreUpdatePayload,
      createdAt: serverTimestamp(),
    };

    if (existingQuiz.exists()) {
      if (skipExisting) {
        continue;
      }
      // Always update existing quiz on target DB so edits/additions sync completely
      try {
        await updateDoc(quizRef, { ...coreUpdatePayload, ...metaFields });
      } catch (err) {
        if (isFirestorePermissionError(err) && Object.keys(metaFields).length > 0) {
          await updateDoc(quizRef, coreUpdatePayload);
        } else {
          throw err;
        }
      }
      migratedMyQuizzesCount++;
      onItemDone?.('quiz', quiz.title);
      continue;
    }
    try {
      await setDoc(quizRef, { ...coreCreatePayload, ...metaFields });
    } catch (err) {
      if (isFirestorePermissionError(err) && Object.keys(metaFields).length > 0) {
        await setDoc(quizRef, coreCreatePayload);
      } else {
        throw err;
      }
    }
    migratedMyQuizzesCount++;
    onItemDone?.('quiz', quiz.title);
  }

  let migratedAttemptsCount = 0;
  for (const at of quizAttempts) {
    if (!at?.id || !Array.isArray(at.questions) || at.questions.length === 0) continue;
    const atRef = doc(targetDb, 'users', targetUid, 'quizAttempts', at.id);
    const existingAt = await getDoc(atRef);
    if (existingAt.exists()) {
      if (skipExisting) {
        continue;
      }
      migratedAttemptsCount++;
      onItemDone?.('attempt', at.title);
      continue;
    }
    const qs: Record<string, unknown>[] = at.questions.slice(0, 10000).map((q) => {
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
    const tableAnswers =
      at.tableAnswers && typeof at.tableAnswers === 'object' ? at.tableAnswers : undefined;
    const score = Math.min(
      qs.length,
      Math.max(
        0,
        Number.isFinite(Number(at.score))
          ? Math.round(Number(at.score))
          : qs.reduce((n, q, i) => n + (answers[i] === Number(q.correctIndex) ? 1 : 0), 0)
      )
    );
    const attemptPayload: Record<string, unknown> = {
      id: at.id,
      ownerId: targetUid,
      title: String(at.title || 'اختبار').slice(0, 200),
      settings: at.settings && typeof at.settings === 'object' ? at.settings : {},
      questions: qs,
      answers,
      ...(tableAnswers && Object.keys(tableAnswers).length > 0 ? { tableAnswers } : {}),
      score,
      total: qs.length,
      durationSec: Math.max(0, Math.min(172800, Math.round(Number(at.durationSec) || 0))),
      finishedAt:
        Number.isFinite(Number(at.finishedAt)) && Number(at.finishedAt) > 0
          ? Math.round(Number(at.finishedAt))
          : Date.now(),
      createdAt: serverTimestamp(),
    };
    try {
      await setDoc(atRef, attemptPayload);
    } catch (err) {
      if (attemptPayload.tableAnswers) {
        const retryPayload = { ...attemptPayload };
        delete retryPayload.tableAnswers;
        await setDoc(atRef, retryPayload);
      } else {
        throw err;
      }
    }
    migratedAttemptsCount++;
    onItemDone?.('attempt', at.title);
  }

  let migratedStarredCount = 0;
  for (const st of starredQuestions) {
    if (!st?.id || !st?.question) continue;
    try {
      const stRef = doc(targetDb, 'users', targetUid, 'starredQuestions', st.id);
      const existingSt = await getDoc(stRef);
      if (!existingSt.exists()) {
        await setDoc(stRef, cleanStarredQuestionForFirestore(st, targetUid));
        migratedStarredCount++;
        onItemDone?.('starred', st.sourceTitle || 'سؤال مميز');
      } else if (!skipExisting) {
        migratedStarredCount++;
        onItemDone?.('starred', st.sourceTitle || 'سؤال مميز');
      }
    } catch {
      // Isolated fallback in case target DB hasn't updated rules yet
    }
  }

  return {
    migratedSavedTestsCount,
    migratedMyQuizzesCount,
    migratedAttemptsCount,
    migratedStarredCount,
  };
}

interface SourceDatabaseCleanupHandle {
  config: FirebaseAppConfig;
  db: Firestore;
  auth: Auth;
  uid: string;
  collected: CollectedSourceData;
}

async function safeDeleteDoc(ref: ReturnType<typeof doc>, timeoutMs = 1500): Promise<boolean> {
  try {
    await withTimeout(deleteDoc(ref), timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function deleteDocRefsInBatches(refs: ReturnType<typeof doc>[]): Promise<number> {
  if (refs.length === 0) return 0;
  let deleted = 0;
  const CHUNK = 10;
  for (let i = 0; i < refs.length; i += CHUNK) {
    const batch = refs.slice(i, i + CHUNK);
    const results = await Promise.allSettled(batch.map((ref) => safeDeleteDoc(ref, 1500)));
    for (const res of results) {
      if (res.status === 'fulfilled' && res.value) deleted++;
    }
  }
  return deleted;
}

async function cleanupMigratedPersonalDocsOnDb(params: {
  srcDb: Firestore;
  oldUid: string;
  savedTests: SavedTest[];
  savedQuestionsByTestId: Record<string, SavedQuestion[]>;
  myQuizzes: MyQuiz[];
  quizAttempts: QuizAttempt[];
  starredQuestions?: StarredQuestion[];
  deleteProfile?: boolean;
}): Promise<number> {
  const {
    srcDb,
    oldUid,
    savedTests,
    savedQuestionsByTestId,
    myQuizzes,
    quizAttempts,
    starredQuestions = [],
    deleteProfile = true,
  } = params;

  const refs: ReturnType<typeof doc>[] = [];
  for (const quiz of myQuizzes) {
    refs.push(doc(srcDb, 'users', oldUid, 'myQuizzes', quiz.id));
  }
  for (const test of savedTests) {
    const qs = savedQuestionsByTestId[test.id] ?? [];
    for (const sq of qs) {
      refs.push(doc(srcDb, 'users', oldUid, 'savedTests', test.id, 'questions', sq.id));
    }
    refs.push(doc(srcDb, 'users', oldUid, 'savedTests', test.id));
  }
  for (const at of quizAttempts) {
    refs.push(doc(srcDb, 'users', oldUid, 'quizAttempts', at.id));
  }
  for (const st of starredQuestions) {
    refs.push(doc(srcDb, 'users', oldUid, 'starredQuestions', st.id));
  }
  if (deleteProfile) {
    refs.push(doc(srcDb, 'users', oldUid, 'private', 'profile'));
  }

  return await deleteDocRefsInBatches(refs);
}

async function cleanupMigratedRoomsOnDb(params: {
  srcDb: Firestore;
  oldUid: string;
  rooms: CollectedRoomData[];
}): Promise<number> {
  const { srcDb, oldUid, rooms } = params;
  const childRefs: ReturnType<typeof doc>[] = [];
  const parentRoomRefs: ReturnType<typeof doc>[] = [];

  for (const bundle of rooms) {
    const roomId = bundle.room.id;
    if (bundle.myRole === 'supervisor' || bundle.room.supervisorId === oldUid) {
      for (const slide of bundle.slides) {
        for (const l of bundle.slideLayers.filter((x) => x.slideId === slide.id)) {
          childRefs.push(doc(srcDb, 'rooms', roomId, 'slides', slide.id, 'layers', l.id));
        }
        childRefs.push(doc(srcDb, 'rooms', roomId, 'slides', slide.id));
      }

      for (const q of bundle.questions) {
        for (const b of bundle.boardsByQuestionId[q.id] ?? []) {
          childRefs.push(doc(srcDb, 'rooms', roomId, 'questions', q.id, 'boards', b.studentId));
        }
        childRefs.push(doc(srcDb, 'rooms', roomId, 'questions', q.id));
      }

      for (const el of bundle.explainLayers) {
        childRefs.push(doc(srcDb, 'rooms', roomId, 'explainLayers', el.id));
      }
      if (bundle.sharedBoard) {
        childRefs.push(doc(srcDb, 'rooms', roomId, 'sharedBoard', 'live'));
      }
      for (const sq of bundle.sharedQuizzes) {
        childRefs.push(doc(srcDb, 'rooms', roomId, 'sharedQuizzes', sq.id));
      }
      for (const comp of bundle.competitions) {
        const compQs = bundle.competitionQuestionsByCompId[comp.id] ?? [];
        for (const cq of compQs) {
          for (const cb of bundle.competitionBoardsByKey[`${comp.id}::${cq.id}`] ?? []) {
            childRefs.push(
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
            );
          }
          childRefs.push(
            doc(srcDb, 'rooms', roomId, 'competitions', comp.id, 'questions', cq.id)
          );
        }
        childRefs.push(doc(srcDb, 'rooms', roomId, 'competitions', comp.id));
      }
      for (const p of bundle.participants) {
        childRefs.push(doc(srcDb, 'rooms', roomId, 'participants', p.uid));
      }
      parentRoomRefs.push(doc(srcDb, 'rooms', roomId));
    } else {
      childRefs.push(doc(srcDb, 'rooms', roomId, 'participants', oldUid));
    }
  }

  const deletedChildren = await deleteDocRefsInBatches(childRefs);
  const deletedParents = await deleteDocRefsInBatches(parentRoomRefs);
  return deletedChildren + deletedParents;
}

/**
 * Announces a completed migration onto an untouched Backup DB (`platform/migration` doc ONLY)
 * via fast Firestore REST :commit so all waiting clients discover & switch to the new Player DB cleanly.
 */
export async function announceViaBackupDatabase(params: {
  backupConfig: FirebaseAppConfig;
  targetConfig: FirebaseAppConfig;
  migratedRoomId?: string | null;
  updaterName?: string;
  previousConfigs?: FirebaseAppConfig[];
}): Promise<{ ok: boolean; popupBlocked: boolean }> {
  const { backupConfig, targetConfig, migratedRoomId, updaterName, previousConfigs = [] } = params;
  try {
    const bApp = getOrInitFirebaseApp(backupConfig);
    const bAuth = getAuth(bApp);
    if (typeof bAuth.authStateReady === 'function') {
      await withTimeout(bAuth.authStateReady(), 1800).catch(() => undefined);
    }

    let bUser = bAuth.currentUser;
    let idToken = '';
    if (bUser) {
      try {
        idToken = await withTimeout(bUser.getIdToken(false), 4500);
      } catch {
        bUser = null;
      }
    }
    if (!bUser) {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const cred = await withTimeout(signInWithPopup(bAuth, provider), 90000);
      bUser = cred.user;
      idToken = await withTimeout(bUser.getIdToken(false), 4500);
    }

    const dbSegment = backupConfig.firestoreDatabaseId?.trim() || '(default)';
    const docPrefix = `projects/${backupConfig.projectId}/databases/${dbSegment}/documents`;
    const commitUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      backupConfig.projectId
    )}/databases/${encodeURIComponent(dbSegment)}/documents:commit?key=${encodeURIComponent(
      backupConfig.apiKey
    )}`;

    const priorChain = previousConfigs
      .filter(
        (c, idx, arr) =>
          !isSameFirebaseTarget(c, targetConfig) &&
          !isSameFirebaseTarget(c, backupConfig) &&
          arr.findIndex((x) => isSameFirebaseTarget(x, c)) === idx
      )
      .slice(0, 8)
      .map((c) => ({
        mapValue: {
          fields: {
            apiKey: { stringValue: c.apiKey },
            authDomain: { stringValue: c.authDomain },
            projectId: { stringValue: c.projectId },
            appId: { stringValue: c.appId },
            ...(c.storageBucket ? { storageBucket: { stringValue: c.storageBucket } } : {}),
            ...(c.messagingSenderId
              ? { messagingSenderId: { stringValue: c.messagingSenderId } }
              : {}),
            ...(c.firestoreDatabaseId
              ? { firestoreDatabaseId: { stringValue: c.firestoreDatabaseId } }
              : {}),
          },
        },
      }));

    const fields: Record<string, unknown> = {
      id: { stringValue: 'migration' },
      projectId: { stringValue: targetConfig.projectId },
      apiKey: { stringValue: targetConfig.apiKey },
      authDomain: { stringValue: targetConfig.authDomain },
      appId: { stringValue: targetConfig.appId },
      ...(targetConfig.storageBucket
        ? { storageBucket: { stringValue: targetConfig.storageBucket } }
        : {}),
      ...(targetConfig.messagingSenderId
        ? { messagingSenderId: { stringValue: targetConfig.messagingSenderId } }
        : {}),
      ...(targetConfig.measurementId
        ? { measurementId: { stringValue: targetConfig.measurementId } }
        : {}),
      ...(targetConfig.firestoreDatabaseId
        ? { firestoreDatabaseId: { stringValue: targetConfig.firestoreDatabaseId } }
        : {}),
      migratedBy: { stringValue: bUser.uid },
      migratedByName: {
        stringValue: (updaterName || bUser.displayName || 'مشرف المنصة').slice(0, 120),
      },
      ...(migratedRoomId ? { migratedRoomId: { stringValue: migratedRoomId.slice(0, 16) } } : {}),
      migrationEpoch: { stringValue: CURRENT_DB_EPOCH },
      previousConfigs: { arrayValue: { values: priorChain } },
    };

    const sendCommit = async (token: string) => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 4500);
      try {
        return await fetch(commitUrl, {
          method: 'POST',
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            writes: [
              {
                update: {
                  name: `${docPrefix}/platform/migration`,
                  fields,
                },
                updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
              },
            ],
          }),
        });
      } finally {
        window.clearTimeout(timer);
      }
    };

    let resp = await sendCommit(idToken);
    if (resp.status === 401 || resp.status === 403) {
      idToken = await withTimeout(bUser.getIdToken(true), 4500);
      resp = await sendCommit(idToken);
    }
    if (!resp.ok) {
      return { ok: false, popupBlocked: false };
    }

    return { ok: true, popupBlocked: false };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const lower = raw.toLowerCase();
    return {
      ok: false,
      popupBlocked: lower.includes('auth/popup-blocked'),
    };
  }
}

export async function runFirebaseMigration(params: {
  targetConfig: FirebaseAppConfig;
  backupEntry?: RegisteredDatabaseEntry | null;
  currentProfile: UserProfile | null;
  currentRoom: Room | null;
  isSupervisorInCurrentRoom: boolean;
  cleanupOldDatabase?: boolean;
  allowSameTargetUpdate?: boolean;
  onProgress: (p: MigrationProgress) => void;
}): Promise<MigrationResult> {
  const {
    targetConfig,
    backupEntry = null,
    currentProfile,
    currentRoom,
    isSupervisorInCurrentRoom,
    cleanupOldDatabase = true,
    allowSameTargetUpdate = false,
    onProgress,
  } = params;

  if (!allowSameTargetUpdate && isSameFirebaseTarget(targetConfig, activeFirebaseConfig)) {
    throw new Error(
      'أنت متصل بالفعل بهذه القاعدة. اختر قاعدة بيانات أخرى من القائمة لنقل وتحديث البيانات إليها.'
    );
  }

  onProgress({
    step: 'signing_in',
    percent: 8,
    message: 'جاري تسجيل الدخول وربط قاعدة البيانات الهدف...',
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
    message: 'جاري فحص وتجميع بيانات الغرف، السوابير، الاختبارات، والملفات...',
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
        message: 'جاري دمج البيانات القديمة لضمان نقل وتحديث كل السجلات...',
        detail: extraCfg.projectId,
      });
      const extraData = await withTimeout(
        collectSourceData(extraDb, extraUser.uid, null, null, false, () => undefined),
        4500
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
      // Non-fatal or timed-out historical DB
    }
  }

  const mergedRoomsMap = new Map<string, CollectedRoomData>();
  const mergedSavedTestsMap = new Map<string, SavedTest>();
  const mergedSavedQuestionsMap: Record<string, SavedQuestion[]> = {
    ...primaryCollected.savedQuestionsByTestId,
  };
  const mergedMyQuizzesMap = new Map<string, MyQuiz>();
  const mergedAttemptsMap = new Map<string, QuizAttempt>();
  const mergedStarredMap = new Map<string, StarredQuestion>();

  for (const bundle of [primaryCollected, ...extraCollections]) {
    for (const r of bundle.rooms) {
      const existing = mergedRoomsMap.get(r.room.id);
      if (
        !existing ||
        r.questions.length + r.slides.length >= existing.questions.length + existing.slides.length
      ) {
        mergedRoomsMap.set(r.room.id, r);
      }
    }
    for (const st of bundle.savedTests) {
      const existing = mergedSavedTestsMap.get(st.id);
      const qs = bundle.savedQuestionsByTestId[st.id] ?? [];
      const prevQs = mergedSavedQuestionsMap[st.id] ?? [];
      if (qs.length >= prevQs.length) {
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
    for (const sq of bundle.starredQuestions ?? []) {
      if (!mergedStarredMap.has(sq.id)) {
        mergedStarredMap.set(sq.id, sq);
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
    starredQuestions: Array.from(mergedStarredMap.values()),
  };
  const mergedSourceDbsCount = Math.max(1, sourceHandles.length);
  const allOldUids = Array.from(
    new Set([oldUid, ...sourceHandles.map((h) => h.uid)].filter((x): x is string => Boolean(x)))
  );

  const targetUid = targetUser.uid;
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
  const calcPercent = () => Math.min(91, 25 + Math.round((completedUnits / totalUnits) * 66));

  try {
    // 1. User Profile
    onProgress({
      step: 'migrating_profile',
      percent: 25,
      message: 'جاري نقل وتحديث بيانات الحساب الشخصي على القاعدة الجديدة...',
    });

    const resolvedQuadName = await migrateUserProfileToDb({
      targetDb,
      targetUser,
      fallbackProfile: source.profile,
    });
    completedUnits++;

    // Re-key ALL local drafts & session snapshots to targetUid
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
        const metaById: Record<string, MyQuizMetaOverride> = {};
        for (const mq of source.myQuizzes) {
          if (mq.parentQuizId || mq.quizKind || mq.drillStyle || mq.sourceStarredId || mq.ruleTitle) {
            metaById[mq.id] = {
              ...(mq.parentQuizId ? { parentQuizId: mq.parentQuizId } : {}),
              ...(mq.quizKind ? { quizKind: mq.quizKind } : {}),
              ...(mq.drillStyle ? { drillStyle: mq.drillStyle } : {}),
              ...(mq.sourceStarredId ? { sourceStarredId: mq.sourceStarredId } : {}),
              ...(mq.ruleTitle ? { ruleTitle: mq.ruleTitle } : {}),
            };
          }
        }
        if (Object.keys(metaById).length > 0) {
          await saveSessionSnapshot({
            key: 'my_quizzes_meta',
            ownerId: targetUid,
            byQuizId: metaById,
            updatedAt: Date.now(),
          });
        }
      }
      if (source.quizAttempts.length > 0) {
        await saveSessionSnapshot({
          key: 'quiz_attempts',
          ownerId: targetUid,
          attempts: source.quizAttempts,
          updatedAt: Date.now(),
        });
      }
      if (source.starredQuestions.length > 0) {
        await saveSessionSnapshot({
          key: 'starred_questions',
          ownerId: targetUid,
          items: source.starredQuestions,
          updatedAt: Date.now(),
        });
      }
    } catch {
      // Non-fatal IndexedDB re-key
    }

    // 2. Migrate & Update Rooms (Questions, Boards, Slides, Layers, SharedQuizzes, Competitions)
    const migratedRoomId: string | null = source.primaryRoomId;
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
        message: `جاري نقل وتحديث الغرفة (${srcRoom.id}) وكل سوابيرها وأسئلتها...`,
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

          // Slides + Layers (updates strokes if layer already exists!)
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
              const existingLayerSnap = await getDoc(layerRef);
              if (existingLayerSnap.exists()) {
                await updateDoc(layerRef, {
                  strokes: mySlideLayer.strokes.slice(-400),
                  updatedAt: serverTimestamp(),
                });
              } else {
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
              migratedLayersCount++;
            }

            completedUnits++;
            onProgress({
              step: 'migrating_rooms',
              percent: calcPercent(),
              message: `جاري نقل وتحديث الشرائح والسوابير (${srcRoom.id})...`,
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

          // Blank-board explain layer & sharedBoard (updates strokes if already exists!)
          const myExplainLayer = roomBundle.explainLayers.find(
            (l) => allOldUids.includes(l.authorId) || l.authorId === targetUid
          );
          if (myExplainLayer && (myExplainLayer.strokes?.length ?? 0) > 0) {
            const explainLayerRef = doc(
              targetDb,
              'rooms',
              srcRoom.id,
              'explainLayers',
              targetUid
            );
            const existingExplainSnap = await getDoc(explainLayerRef);
            if (existingExplainSnap.exists()) {
              await updateDoc(explainLayerRef, {
                strokes: myExplainLayer.strokes.slice(-400),
                updatedAt: serverTimestamp(),
              });
            } else {
              await setDoc(explainLayerRef, {
                id: targetUid,
                roomId: srcRoom.id,
                authorId: targetUid,
                authorName: supervisorDisplayName.slice(0, 120),
                strokes: myExplainLayer.strokes.slice(-400),
                updatedAt: serverTimestamp(),
              });
            }
            migratedLayersCount++;
          }

          if (roomBundle.sharedBoard && (roomBundle.sharedBoard.strokes?.length ?? 0) > 0) {
            const sbRef = doc(targetDb, 'rooms', srcRoom.id, 'sharedBoard', 'live');
            const sbSnap = await getDoc(sbRef);
            if (sbSnap.exists()) {
              await updateDoc(sbRef, {
                strokes: roomBundle.sharedBoard.strokes.slice(-400),
                updatedBy: targetUid,
                updatedByName: supervisorDisplayName.slice(0, 120),
                updatedAt: serverTimestamp(),
              });
            } else {
              await setDoc(sbRef, {
                roomId: srcRoom.id,
                strokes: roomBundle.sharedBoard.strokes.slice(-400),
                updatedBy: targetUid,
                updatedByName: supervisorDisplayName.slice(0, 120),
                updatedAt: serverTimestamp(),
              });
            }
          }

          if (needsExplainForSlides && (srcRoom.mode || 'quiz') === 'quiz') {
            await updateDoc(targetRoomRef, {
              mode: 'quiz',
              explainPresenterId: '',
              explainPresenterName: '',
              updatedAt: serverTimestamp(),
            });
          }

          // Migrate & update Room Questions
          for (const q of roomBundle.questions) {
            const qRef = doc(targetDb, 'rooms', srcRoom.id, 'questions', q.id);
            const qSnap = await getDoc(qRef);
            if (!qSnap.exists()) {
              const sanitizedChart = q.chart ? sanitizeChart(q.chart) : null;
              const sanitizedFigure = q.figure ? sanitizeFigure(q.figure) : null;
              const sanitizedTable = q.table ? encodeTableForFirestore(q.table) : null;
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
                ...(sanitizedTable ? { questionType: 'table', table: sanitizedTable } : {}),
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
            } else {
              // Update older existing question state on target if source progressed further
              const existingQ = qSnap.data() as Question;
              if (existingQ.status === 'solving') {
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
                } else if (q.status === 'solving' && q.attemptsUsed === 1 && existingQ.attemptsUsed === 0) {
                  await updateDoc(qRef, {
                    attemptsUsed: 1,
                    wrongStudentIds: (q.wrongStudentIds || []).slice(0, 1),
                    updatedAt: serverTimestamp(),
                  });
                }
              }
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

          // Migrate & update Room Shared Quizzes
          for (const sq of roomBundle.sharedQuizzes) {
            if (!sq?.id || !Array.isArray(sq.questions) || sq.questions.length === 0) {
              completedUnits++;
              continue;
            }
            const sqRef = doc(targetDb, 'rooms', srcRoom.id, 'sharedQuizzes', sq.id);
            const sqSnap = await getDoc(sqRef);
            const cleanedQs = sq.questions.slice(0, 10000).map(cleanQuizQuestionForFirestore);
            if (!sqSnap.exists()) {
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
            } else if ((sqSnap.data() as SharedQuiz).authorId === targetUid) {
              await updateDoc(sqRef, {
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

          // Migrate Competitions
          for (const comp of roomBundle.competitions) {
            const compRef = doc(targetDb, 'rooms', srcRoom.id, 'competitions', comp.id);
            const cSnap = await getDoc(compRef);
            if (!cSnap.exists()) {
              const competitorsList =
                Array.isArray(comp.competitors) && comp.competitors.length > 0
                  ? comp.competitors.slice(0, 100)
                  : [{ uid: targetUid, name: supervisorDisplayName.slice(0, 120), role: 'supervisor' }];
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
                    // Ignore historical owner mismatch
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
                    // Ignore board lock
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
        // Student path
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
                // Skip if locked
              }
            }

            for (const sq of roomBundle.sharedQuizzes) {
              if (sq.authorId !== source.oldUid && sq.authorId !== targetUid) continue;
              try {
                const sqRef = doc(targetDb, 'rooms', srcRoom.id, 'sharedQuizzes', sq.id);
                const sqSnap = await getDoc(sqRef);
                if (Array.isArray(sq.questions) && sq.questions.length > 0) {
                  const cleanedQs = sq.questions.slice(0, 10000).map(cleanQuizQuestionForFirestore);
                  if (!sqSnap.exists()) {
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
                  } else if ((sqSnap.data() as SharedQuiz).authorId === targetUid) {
                    await updateDoc(sqRef, {
                      authorName: studentName.slice(0, 120),
                      authorRole: 'student',
                      title: (sq.title || 'نموذج').slice(0, 120),
                      questions: cleanedQs,
                      questionCount: cleanedQs.length,
                      updatedAt: serverTimestamp(),
                    });
                    migratedSharedQuizzesCount++;
                  }
                }
              } catch {
                // Skip
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

    // 3. Personal Collections (creates + updates older target docs!)
    onProgress({
      step: 'migrating_saved',
      percent: calcPercent(),
      message: `جاري نقل وتحديث المحفوظات (${source.savedTests.length}) واختباراتي (${source.myQuizzes.length}) والمحاولات (${source.quizAttempts.length})...`,
    });

    const { migratedSavedTestsCount, migratedMyQuizzesCount, migratedAttemptsCount } =
      await writePersonalCollectionsToDb({
        targetDb,
        targetUid,
        savedTests: source.savedTests,
        savedQuestionsByTestId: source.savedQuestionsByTestId,
        myQuizzes: source.myQuizzes,
        quizAttempts: source.quizAttempts,
        starredQuestions: source.starredQuestions,
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
              ? 'جاري نقل وتحديث أرشيف الاختبارات المحفوظة...'
              : kind === 'quiz'
              ? 'جاري نقل وتحديث نماذج «اختباراتي»...'
              : kind === 'starred'
              ? 'جاري نقل الأسئلة المميزة ⭐...'
              : 'جاري نقل سجل المحاولات والتقارير...';
          onProgress({
            step,
            percent: calcPercent(),
            message: msg,
            detail: label,
          });
        },
      });

    // 4. Write platform/migration on target DB + old source DBs, then WAKE UP chosen untouched Backup DB!
    onProgress({
      step: 'announcing_backup',
      percent: 93,
      message: backupEntry
        ? `اكتمل نقل البيانات 100%! جاري تشغيل القاعدة الاحتياطية (${backupEntry.config.projectId}) لتجهيز وإعلان القاعدة الجديدة للجميع...`
        : 'اكتمل نقل البيانات 100%! جاري اعتماد القاعدة الجديدة وتجهيز انتقال الجميع...',
      detail: targetConfig.projectId,
    });

    const priorChain = [
      activeFirebaseConfig,
      defaultFirebaseConfig,
      ...getPreviousFirebaseConfigs(),
    ]
      .filter(
        (c, idx, arr) =>
          !isSameFirebaseTarget(c, targetConfig) &&
          arr.findIndex((x) => isSameFirebaseTarget(x, c)) === idx
      )
      .slice(0, 8)
      .map((c) => ({
        apiKey: c.apiKey,
        authDomain: c.authDomain,
        projectId: c.projectId,
        appId: c.appId,
        ...(c.storageBucket ? { storageBucket: c.storageBucket } : {}),
        ...(c.messagingSenderId ? { messagingSenderId: c.messagingSenderId } : {}),
        ...(c.firestoreDatabaseId ? { firestoreDatabaseId: c.firestoreDatabaseId } : {}),
      }));

    try {
      sessionStorage.setItem(
        'duoboard_self_migrated_target',
        firebaseTargetKey(targetConfig)
      );
    } catch {
      // Ignore sessionStorage
    }

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
      migratedByName: (resolvedQuadName || targetUser.displayName || 'مشرف المنصة').slice(0, 120),
      ...(migratedRoomId ? { migratedRoomId: migratedRoomId.slice(0, 16) } : {}),
      migrationEpoch: CURRENT_DB_EPOCH,
      previousConfigs: priorChain,
      updatedAt: serverTimestamp(),
    });

    let platformPointerUpdated = false;
    try {
      await withTimeout(
        setDoc(doc(targetDb, 'platform', 'migration'), buildPointerPayload(targetUid)),
        3000
      );
      platformPointerUpdated = true;
    } catch {
      // Non-fatal
    }

    for (const handle of sourceHandles) {
      if (isSameFirebaseTarget(handle.config, targetConfig)) continue;
      try {
        await withTimeout(
          setDoc(doc(handle.db, 'platform', 'migration'), buildPointerPayload(handle.uid)),
          2500
        );
        platformPointerUpdated = true;
      } catch {
        // Continue
      }
    }

    // Wake up the selected untouched Backup DB AFTER 100% of target writes succeed!
    let announcedBackupProjectId: string | null = null;
    let backupAnnouncementWritten = false;
    let backupAuthPopupBlocked = false;

    if (backupEntry) {
      const announceRes = await announceViaBackupDatabase({
        backupConfig: backupEntry.config,
        targetConfig,
        migratedRoomId,
        updaterName: resolvedQuadName || targetUser.displayName || 'مشرف المنصة',
        previousConfigs: priorChain as FirebaseAppConfig[],
      });
      backupAnnouncementWritten = announceRes.ok;
      backupAuthPopupBlocked = announceRes.popupBlocked;
      if (announceRes.ok) {
        announcedBackupProjectId = backupEntry.config.projectId;
      }
    }

    onProgress({
      step: 'finalizing',
      percent: 96,
      message: 'جاري إرسال إشارة التحميل والانتقال لجميع اللاعبين والمشرفين...',
      detail: announcedBackupProjectId
        ? `عبر الاحتياطية: ${announcedBackupProjectId}`
        : targetConfig.projectId,
    });

    // Notify backend server + SSE stream of 100% migration completion
    let serverPointerUpdated = false;
    const isMasterActor = isMasterProgrammerIdentity({
      email: targetUser.email,
      fullNameQuad: resolvedQuadName,
    });
    const buildLocalMigratedState = (baseInput?: PlatformProgrammerState | null): PlatformProgrammerState => {
      const base = ensureRegistryDefaults(baseInput || getFallbackProgrammerState(null));
      const existingPlayer = base.playerDatabases.find((d) =>
        isSameFirebaseTarget(d.config, targetConfig)
      );
      const nextPlayers = existingPlayer
        ? base.playerDatabases.map((d) =>
            isSameFirebaseTarget(d.config, targetConfig)
              ? { ...d, lastUsedAt: Date.now() }
              : d
          )
        : [
            ...base.playerDatabases,
            {
              id: `player_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              order: base.playerDatabases.length + 1,
              role: 'player' as const,
              label: `قاعدة بيانات #${base.playerDatabases.length + 1} — ${targetConfig.projectId}`,
              config: targetConfig,
              verification: {
                firestoreReady: true,
                googleAuthReady: true,
                rulesReady: true,
                verifiedAt: Date.now(),
                verifiedByEmail: targetUser.email || undefined,
              },
              lastUsedAt: Date.now(),
              addedByEmail: targetUser.email || undefined,
              addedAt: Date.now(),
            },
          ];
      const finalPlayer = nextPlayers.find((d) =>
        isSameFirebaseTarget(d.config, targetConfig)
      );
      return ensureRegistryDefaults({
        ...base,
        revision: base.revision + 1,
        playerDatabases: renumberEntries(nextPlayers),
        activeTargetConfig: targetConfig,
        activePlayerDatabaseId: finalPlayer?.id || base.activePlayerDatabaseId,
        migratedRoomId: migratedRoomId || null,
        lastBackupAnnouncement: backupEntry
          ? {
              backupDbId: backupEntry.id,
              backupProjectId: backupEntry.config.projectId,
              targetProjectId: targetConfig.projectId,
              targetConfig,
              migratedRoomId,
              announcedAt: Date.now(),
              announcedByEmail: targetUser.email || undefined,
            }
          : base.lastBackupAnnouncement,
        updatedByEmail: targetUser.email || undefined,
        updatedAt: Date.now(),
      });
    };

    try {
      const serverRes = await callProgrammerEndpoint<{
        ok: boolean;
        state?: PlatformProgrammerState;
        backupConfigs?: FirebaseAppConfig[];
      }>('/api/programmer/migrate-complete', targetUser, resolvedQuadName || targetUser.displayName || '', {
        targetConfig,
        migratedRoomId,
        backupDbId: backupEntry?.id || '',
        backupProjectId: announcedBackupProjectId || backupEntry?.config.projectId || '',
        previousConfigs: priorChain,
        tokenProjectId: targetConfig.projectId,
        tokenApiKey: targetConfig.apiKey,
        tokenFirestoreDatabaseId: targetConfig.firestoreDatabaseId || '',
      });
      serverPointerUpdated = Boolean(serverRes?.ok);
      const nextState = serverRes?.state
        ? ensureRegistryDefaults(serverRes.state)
        : buildLocalMigratedState(loadLocalRegistryState());
      saveLocalRegistryState(nextState);
      saveBackupFirebaseConfigs(nextState.backupDatabases.map((b) => b.config));
      if (isMasterActor) {
        await withTimeout(
          writeFirestoreRegistryDoc(
            targetDb,
            nextState,
            targetUid,
            resolvedQuadName || targetUser.displayName || MASTER_PROGRAMMER_NAME
          ),
          2000
        ).catch(() => undefined);
      }
    } catch {
      // Static host or secondary container fallback: mirror local registry onto targetDb
      try {
        const updatedReg = buildLocalMigratedState(loadLocalRegistryState());
        saveLocalRegistryState(updatedReg);
        if (isMasterActor) {
          await withTimeout(
            writeFirestoreRegistryDoc(
              targetDb,
              updatedReg,
              targetUid,
              resolvedQuadName || targetUser.displayName || MASTER_PROGRAMMER_NAME
            ),
            2000
          ).catch(() => undefined);
        }
      } catch {
        // Non-fatal
      }
    }

    // 5. Optional cleanup & old auth signout (bounded with strict timeout, NEVER touches Backup DBs!)
    let deletedOldDocsCount = 0;
    let oldAuthSignedOut = false;

    const cleanupHandles = sourceHandles.filter(
      (h) => !isSameFirebaseTarget(h.config, targetConfig)
    );

    if (cleanupOldDatabase && cleanupHandles.length > 0) {
      onProgress({
        step: 'cleaning_old',
        percent: 98,
        message: 'جاري تنظيف السجلات المنقولة من القاعدة السابقة وفصل الجلسة القديمة...',
      });

      await withTimeout(
        Promise.allSettled(
          cleanupHandles.map(async (handle) => {
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
              starredQuestions: handle.collected.starredQuestions,
              deleteProfile: true,
            });
          })
        ),
        3500
      ).catch(() => undefined);
    }

    if (cleanupHandles.length > 0) {
      await Promise.allSettled(
        cleanupHandles.map(async (handle) => {
          await withTimeout(signOut(handle.auth), 1000);
          oldAuthSignedOut = true;
        })
      ).catch(() => undefined);
    }

    activateCustomFirebaseConfig(targetConfig, migratedRoomId, priorChain as FirebaseAppConfig[]);
    for (const handle of sourceHandles) {
      markSourceKeySynced(targetUid, firebaseTargetKey(handle.config));
      try {
        if (handle.uid !== targetUid) {
          localStorage.removeItem(`duoboard_active_room_${handle.uid}`);
        }
      } catch {
        // Ignore storage
      }
    }

    if (migratedRoomId) {
      try {
        localStorage.setItem(`duoboard_active_room_${targetUid}`, migratedRoomId);
      } catch {
        // Ignore storage
      }
    }

    const shareUrl = buildShareMigrationUrl(targetConfig, migratedRoomId);

    onProgress({
      step: 'done',
      percent: 100,
      message: announcedBackupProjectId
        ? `اكتمل النقل 100% وأعلنت القاعدة الاحتياطية (${announcedBackupProjectId}) للجميع للانتقال وتسجيل الدخول!`
        : 'اكتمل النقل 100% وتحديث كافة البيانات وتجهيز تسجيل الدخول على القاعدة الجديدة!',
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
      announcedBackupProjectId,
      backupAnnouncementWritten,
      backupAuthPopupBlocked,
    };
  } catch (err) {
    throw classifyMigrationError(err, targetConfig.projectId);
  }
}

export async function syncPersonalAccountFromPreviousDbs(params: {
  targetUser: User;
  interactiveAuthIfNeeded?: boolean;
  onProgress?: (p: MigrationProgress) => void;
}): Promise<{ synced: boolean; count: number; needsInteractiveSignIn: boolean }> {
  const { targetUser, interactiveAuthIfNeeded = false, onProgress } = params;
  const targetUid = targetUser.uid;
  const activeTargetKey = firebaseTargetKey(activeFirebaseConfig);

  if (!interactiveAuthIfNeeded && hasCompletedPersonalSyncForDb(targetUid, activeTargetKey)) {
    return { synced: false, count: 0, needsInteractiveSignIn: false };
  }

  const previousConfigs = getPreviousFirebaseConfigs().filter(
    (c) => !isSameFirebaseTarget(c, activeFirebaseConfig)
  );
  if (previousConfigs.length === 0) {
    markCompletedPersonalSyncForDb(targetUid, activeTargetKey);
    return { synced: false, count: 0, needsInteractiveSignIn: false };
  }

  const alreadySynced = getSyncedSourceKeys(targetUid);
  const pendingConfigs = previousConfigs.filter(
    (cfg) => !alreadySynced.includes(firebaseTargetKey(cfg))
  );
  const localCacheDoneKey = `local_cache::${activeTargetKey}`;
  const localCacheAlreadyDone = alreadySynced.includes(localCacheDoneKey);

  if (pendingConfigs.length === 0 && localCacheAlreadyDone) {
    markCompletedPersonalSyncForDb(targetUid, activeTargetKey);
    return { synced: false, count: 0, needsInteractiveSignIn: false };
  }

  // Detect whether the active database already holds personal quizzes/tests/attempts
  // so we never falsely report or prompt to re-import data that is already present.
  let activeDbHasExistingData = false;
  try {
    const [qSnap, sSnap, aSnap] = await withTimeout(
      Promise.all([
        getDocs(query(collection(sourceDb, 'users', targetUid, 'myQuizzes'), fsLimit(1))),
        getDocs(query(collection(sourceDb, 'users', targetUid, 'savedTests'), fsLimit(1))),
        getDocs(query(collection(sourceDb, 'users', targetUid, 'quizAttempts'), fsLimit(1))),
      ]),
      1800
    );
    activeDbHasExistingData = !qSnap.empty || !sSnap.empty || !aSnap.empty;
  } catch {
    activeDbHasExistingData = false;
  }

  if (!interactiveAuthIfNeeded && activeDbHasExistingData && localCacheAlreadyDone) {
    markCompletedPersonalSyncForDb(targetUid, activeTargetKey);
    return { synced: false, count: 0, needsInteractiveSignIn: false };
  }

  let totalSyncedItems = 0;
  let needsInteractiveSignIn = false;

  for (const srcCfg of pendingConfigs) {
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
        message: 'جاري استيراد بياناتك واختباراتك إلى القاعدة الجديدة...',
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
        starredQuestions: srcData.starredQuestions,
        skipExisting: true,
      });

      const importedNow =
        counts.migratedSavedTestsCount +
        counts.migratedMyQuizzesCount +
        counts.migratedAttemptsCount +
        counts.migratedStarredCount;
      totalSyncedItems += importedNow;

      if (importedNow > 0 || srcData.profile) {
        await cleanupMigratedPersonalDocsOnDb({
          srcDb,
          oldUid: srcUser.uid,
          savedTests: srcData.savedTests,
          savedQuestionsByTestId: srcData.savedQuestionsByTestId,
          myQuizzes: srcData.myQuizzes,
          quizAttempts: srcData.quizAttempts,
          starredQuestions: srcData.starredQuestions,
          deleteProfile: true,
        });
      }
      try {
        await signOut(srcAuth);
      } catch {
        // Ignore
      }

      markSourceKeySynced(targetUid, srcKey);
    } catch {
      // Fallback below
    }
  }

  if (totalSyncedItems === 0 && !localCacheAlreadyDone) {
    try {
      const cachedSaved = await loadSessionSnapshot<StoredSavedTestsSnapshot>('saved_tests');
      const cachedQuizzes = await loadSessionSnapshot<StoredMyQuizzesSnapshot>('my_quizzes');
      const cachedAttempts =
        await loadSessionSnapshot<StoredQuizAttemptsSnapshot>('quiz_attempts');
      const cachedStarred =
        await loadSessionSnapshot<StoredStarredQuestionsSnapshot>('starred_questions');

      const counts = await writePersonalCollectionsToDb({
        targetDb: sourceDb,
        targetUid,
        savedTests: cachedSaved?.tests ?? [],
        savedQuestionsByTestId: cachedSaved?.questionsByTestId ?? {},
        myQuizzes: cachedQuizzes?.quizzes ?? [],
        quizAttempts: cachedAttempts?.attempts ?? [],
        starredQuestions: cachedStarred?.items ?? [],
        skipExisting: true,
      });
      totalSyncedItems +=
        counts.migratedSavedTestsCount +
        counts.migratedMyQuizzesCount +
        counts.migratedAttemptsCount +
        counts.migratedStarredCount;
    } catch {
      // Non-fatal
    } finally {
      markSourceKeySynced(targetUid, localCacheDoneKey);
    }
  }

  const effectiveNeedsInteractiveSignIn =
    !interactiveAuthIfNeeded && activeDbHasExistingData ? false : needsInteractiveSignIn;

  if (totalSyncedItems > 0 || !effectiveNeedsInteractiveSignIn || interactiveAuthIfNeeded) {
    markCompletedPersonalSyncForDb(targetUid, activeTargetKey);
  }

  return {
    synced: totalSyncedItems > 0,
    count: totalSyncedItems,
    needsInteractiveSignIn: effectiveNeedsInteractiveSignIn,
  };
}

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
      const sanitizedTable = q.table ? encodeTableForFirestore(q.table) : null;
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
        ...(sanitizedTable ? { questionType: 'table', table: sanitizedTable } : {}),
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

/* ===================== Split Registry State (Player DBs + Untouched Backup DBs) ===================== */

const DUOBOARD_LOCAL_REGISTRY_KEY = 'duoboard_clean_registry_v3';

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
    // Fallback
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

function renumberEntries(list: RegisteredDatabaseEntry[]): RegisteredDatabaseEntry[] {
  return list.map((d, idx) => ({ ...d, order: idx + 1 }));
}

function ensureRegistryDefaults(
  raw: Partial<PlatformProgrammerState> | null
): PlatformProgrammerState {
  const now = Date.now();

  const normalizeEntries = (
    items: unknown,
    role: DatabaseRole
  ): RegisteredDatabaseEntry[] => {
    if (!Array.isArray(items)) return [];
    const out: RegisteredDatabaseEntry[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const d = item as Record<string, unknown>;
      const cfg = sanitizeFirebaseConfig(d.config);
      if (!cfg) continue;
      if (out.some((x) => isSameFirebaseTarget(x.config, cfg))) continue;
      const vf =
        d.verification && typeof d.verification === 'object'
          ? (d.verification as Record<string, unknown>)
          : {};
      out.push({
        id:
          typeof d.id === 'string' && d.id
            ? d.id
            : `${role}_${out.length + 1}_${cfg.projectId}`,
        order: typeof d.order === 'number' ? d.order : out.length + 1,
        role,
        label:
          typeof d.label === 'string' && d.label.trim()
            ? d.label.trim().slice(0, 80)
            : cfg.projectId,
        config: cfg,
        verification: {
          firestoreReady: Boolean(vf.firestoreReady ?? true),
          googleAuthReady: Boolean(vf.googleAuthReady ?? true),
          rulesReady: Boolean(vf.rulesReady ?? true),
          verifiedAt: typeof vf.verifiedAt === 'number' ? vf.verifiedAt : now,
          verifiedByEmail:
            typeof vf.verifiedByEmail === 'string' ? vf.verifiedByEmail : undefined,
        },
        lastUsedAt: typeof d.lastUsedAt === 'number' ? d.lastUsedAt : null,
        lastAnnouncedToProjectId:
          typeof d.lastAnnouncedToProjectId === 'string'
            ? d.lastAnnouncedToProjectId
            : null,
        addedByEmail: typeof d.addedByEmail === 'string' ? d.addedByEmail : undefined,
        addedAt: typeof d.addedAt === 'number' ? d.addedAt : now,
      });
    }
    return renumberEntries(out);
  };

  const playerDatabases = normalizeEntries(raw?.playerDatabases, 'player');
  const backupDatabases = renumberEntries(
    normalizeEntries(raw?.backupDatabases, 'backup').filter(
      (b) => !playerDatabases.some((p) => isSameFirebaseTarget(p.config, b.config))
    )
  );

  const activeTargetConfig =
    sanitizeFirebaseConfig(raw?.activeTargetConfig) || activeFirebaseConfig;
  const activePlayerMatch = playerDatabases.find((p) =>
    isSameFirebaseTarget(p.config, activeTargetConfig)
  );

  let lastBackupAnnouncement: BackupAnnouncementInfo | null = null;
  if (raw?.lastBackupAnnouncement && typeof raw.lastBackupAnnouncement === 'object') {
    const a = raw.lastBackupAnnouncement;
    const tCfg = sanitizeFirebaseConfig(a.targetConfig);
    if (tCfg && typeof a.backupProjectId === 'string') {
      lastBackupAnnouncement = {
        backupDbId: typeof a.backupDbId === 'string' ? a.backupDbId : '',
        backupProjectId: a.backupProjectId,
        targetProjectId: tCfg.projectId,
        targetConfig: tCfg,
        migratedRoomId: typeof a.migratedRoomId === 'string' ? a.migratedRoomId : null,
        announcedAt: typeof a.announcedAt === 'number' ? a.announcedAt : now,
        announcedByEmail:
          typeof a.announcedByEmail === 'string' ? a.announcedByEmail : undefined,
      };
    }
  }

  const rawProgs = Array.isArray(raw?.programmers) ? raw!.programmers : [];
  const programmers: StoredProgrammerWithHash[] = [];
  for (const p of rawProgs as StoredProgrammerWithHash[]) {
    if (!p || typeof p !== 'object') continue;
    programmers.push({
      id: typeof p.id === 'string' && p.id ? p.id : `prog_${programmers.length + 1}`,
      fullNameQuad: typeof p.fullNameQuad === 'string' ? p.fullNameQuad.trim() : '',
      ...(typeof p.email === 'string' && p.email.trim()
        ? { email: p.email.trim().toLowerCase() }
        : {}),
      ...(typeof p.emailHash === 'string' && p.emailHash ? { emailHash: p.emailHash } : {}),
      ...(typeof p.emailMasked === 'string' && p.emailMasked
        ? { emailMasked: p.emailMasked }
        : {}),
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

  return {
    revision: typeof raw?.revision === 'number' && raw.revision >= 1 ? raw.revision : 1,
    playerDatabases,
    backupDatabases,
    activeTargetConfig,
    activePlayerDatabaseId: activePlayerMatch ? activePlayerMatch.id : null,
    lastBackupAnnouncement,
    programmers,
    migratedRoomId: typeof raw?.migratedRoomId === 'string' ? raw.migratedRoomId : null,
    updatedByEmail: typeof raw?.updatedByEmail === 'string' ? raw.updatedByEmail : undefined,
    updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : now,
  };
}

function loadLocalRegistryState(): PlatformProgrammerState | null {
  try {
    const raw = localStorage.getItem(DUOBOARD_LOCAL_REGISTRY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlatformProgrammerState>;
    if (!parsed || typeof parsed !== 'object') return null;
    return ensureRegistryDefaults(parsed);
  } catch {
    return null;
  }
}

function saveLocalRegistryState(state: PlatformProgrammerState): void {
  try {
    localStorage.setItem(DUOBOARD_LOCAL_REGISTRY_KEY, JSON.stringify(state));
    saveBackupFirebaseConfigs(state.backupDatabases.map((b) => b.config));
  } catch {
    // Ignore storage errors
  }
}

function cleanConfigObject(cfg: FirebaseAppConfig): Record<string, unknown> {
  return {
    apiKey: cfg.apiKey,
    authDomain: cfg.authDomain,
    projectId: cfg.projectId,
    appId: cfg.appId,
    ...(cfg.storageBucket ? { storageBucket: cfg.storageBucket } : {}),
    ...(cfg.messagingSenderId ? { messagingSenderId: cfg.messagingSenderId } : {}),
    ...(cfg.measurementId ? { measurementId: cfg.measurementId } : {}),
    ...(cfg.firestoreDatabaseId ? { firestoreDatabaseId: cfg.firestoreDatabaseId } : {}),
  };
}

function cleanEntryObject(d: RegisteredDatabaseEntry): Record<string, unknown> {
  return {
    id: d.id,
    order: d.order,
    role: d.role,
    label: (d.label || d.config.projectId).slice(0, 80),
    config: cleanConfigObject(d.config as FirebaseAppConfig),
    verification: {
      firestoreReady: Boolean(d.verification?.firestoreReady ?? true),
      googleAuthReady: Boolean(d.verification?.googleAuthReady ?? true),
      rulesReady: Boolean(d.verification?.rulesReady ?? true),
      verifiedAt: d.verification?.verifiedAt || Date.now(),
      ...(d.verification?.verifiedByEmail
        ? { verifiedByEmail: d.verification.verifiedByEmail }
        : {}),
    },
    ...(typeof d.lastUsedAt === 'number' ? { lastUsedAt: d.lastUsedAt } : {}),
    ...(d.lastAnnouncedToProjectId
      ? { lastAnnouncedToProjectId: d.lastAnnouncedToProjectId }
      : {}),
    addedAt: d.addedAt || Date.now(),
  };
}

const mirroredRegistrySigByTarget = new Map<string, string>();
const cloudKnownRevisionByTarget = new Map<string, number>();
const MIRROR_SIG_STORAGE_PREFIX = 'duoboard_mirrored_reg_sig_v1_';

function computeRegistrySignature(
  state: Pick<
    PlatformProgrammerState,
    'revision' | 'activeTargetConfig' | 'playerDatabases' | 'backupDatabases' | 'programmers'
  >
): string {
  const players = (state.playerDatabases || [])
    .map((d) => d.config?.projectId || '')
    .join(',');
  const backups = (state.backupDatabases || [])
    .map((d) => d.config?.projectId || '')
    .join(',');
  return `${state.revision || 1}::${state.activeTargetConfig?.projectId || ''}::${players}::${backups}::${
    state.programmers?.length || 0
  }`;
}

function getLastMirroredSignature(projectId: string): string {
  const mem = mirroredRegistrySigByTarget.get(projectId);
  if (mem) return mem;
  try {
    return sessionStorage.getItem(`${MIRROR_SIG_STORAGE_PREFIX}${projectId}`) || '';
  } catch {
    return '';
  }
}

function markMirroredSignature(projectId: string, sig: string, revision: number): void {
  mirroredRegistrySigByTarget.set(projectId, sig);
  cloudKnownRevisionByTarget.set(projectId, Math.max(cloudKnownRevisionByTarget.get(projectId) || 0, revision));
  try {
    sessionStorage.setItem(`${MIRROR_SIG_STORAGE_PREFIX}${projectId}`, sig);
  } catch {
    // Ignore sessionStorage restrictions
  }
}

export function noteCloudRegistrySnapshot(
  projectId: string,
  raw: Record<string, unknown>
): { revision: number; playerCount: number; backupCount: number; programmerCount: number; signature: string } {
  const revision = typeof raw.revision === 'number' ? raw.revision : 1;
  const players = Array.isArray(raw.playerDatabases)
    ? (raw.playerDatabases as RegisteredDatabaseEntry[])
    : [];
  const backups = Array.isArray(raw.backupDatabases)
    ? (raw.backupDatabases as RegisteredDatabaseEntry[])
    : [];
  const progs = Array.isArray(raw.programmers) ? raw.programmers : [];
  const activeCfg = (raw.activeTargetConfig || {}) as FirebaseAppConfig;
  const signature = `${revision}::${activeCfg.projectId || ''}::${players
    .map((d) => d?.config?.projectId || '')
    .join(',')}::${backups.map((d) => d?.config?.projectId || '').join(',')}::${progs.length}`;
  markMirroredSignature(projectId, signature, revision);
  return {
    revision,
    playerCount: players.length,
    backupCount: backups.length,
    programmerCount: progs.length,
    signature,
  };
}

async function writeFirestoreRegistryDoc(
  targetDb: Firestore,
  state: PlatformProgrammerState,
  uid: string,
  updaterName: string,
  forceWrite = false
): Promise<boolean> {
  const targetProjectId =
    (targetDb as { app?: { options?: { projectId?: string } } })?.app?.options?.projectId ||
    activeFirebaseConfig.projectId;
  const sig = computeRegistrySignature(state);
  if (!forceWrite && getLastMirroredSignature(targetProjectId) === sig) {
    return true;
  }

  try {
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

    const payload: Record<string, unknown> = {
      id: 'registry',
      revision: Math.min(1000000, Math.max(1, state.revision || 1)),
      activePlayerDatabaseId: (state.activePlayerDatabaseId || '').slice(0, 128),
      activeTargetConfig: cleanConfigObject(state.activeTargetConfig as FirebaseAppConfig),
      playerDatabases: state.playerDatabases.slice(0, 25).map(cleanEntryObject),
      backupDatabases: state.backupDatabases.slice(0, 25).map(cleanEntryObject),
      programmers: cleanProgrammers,
      updatedBy: uid,
      updatedByName: (updaterName || 'مبرمج المنصة').slice(0, 120),
      updatedAt: serverTimestamp(),
    };

    if (state.lastBackupAnnouncement) {
      payload.lastBackupAnnouncement = {
        backupDbId: state.lastBackupAnnouncement.backupDbId,
        backupProjectId: state.lastBackupAnnouncement.backupProjectId,
        targetProjectId: state.lastBackupAnnouncement.targetProjectId,
        targetConfig: cleanConfigObject(
          state.lastBackupAnnouncement.targetConfig as FirebaseAppConfig
        ),
        ...(state.lastBackupAnnouncement.migratedRoomId
          ? { migratedRoomId: state.lastBackupAnnouncement.migratedRoomId }
          : {}),
        announcedAt: state.lastBackupAnnouncement.announcedAt,
      };
    }

    // Mark before write as well so a failing/quota write never loops endlessly on retries
    markMirroredSignature(targetProjectId, sig, state.revision || 1);
    await withTimeout(setDoc(doc(targetDb, 'platform', 'registry'), payload), 2500);
    return true;
  } catch {
    return false;
  }
}

export async function readCloudRegistryDoc(
  targetDb: Firestore = sourceDb
): Promise<PlatformProgrammerState | null> {
  try {
    const snap = await withTimeout(getDoc(doc(targetDb, 'platform', 'registry')), 2500);
    if (!snap.exists()) return null;
    const raw = snap.data() as Record<string, unknown>;
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

    return ensureRegistryDefaults({
      revision: typeof raw.revision === 'number' ? raw.revision : 1,
      playerDatabases: Array.isArray(raw.playerDatabases)
        ? (raw.playerDatabases as RegisteredDatabaseEntry[])
        : [],
      backupDatabases: Array.isArray(raw.backupDatabases)
        ? (raw.backupDatabases as RegisteredDatabaseEntry[])
        : [],
      activeTargetConfig: raw.activeTargetConfig as FirebaseAppConfig,
      activePlayerDatabaseId:
        typeof raw.activePlayerDatabaseId === 'string' && raw.activePlayerDatabaseId
          ? raw.activePlayerDatabaseId
          : null,
      lastBackupAnnouncement: raw.lastBackupAnnouncement as BackupAnnouncementInfo | null,
      programmers: hydratedProgs,
      updatedAt: getTimestampMillis(raw.updatedAt) || Date.now(),
    });
  } catch {
    return null;
  }
}

export function getFallbackProgrammerState(
  existing?: Partial<PlatformProgrammerState> | null
): PlatformProgrammerState {
  return ensureRegistryDefaults(existing ?? loadLocalRegistryState());
}

async function loadServerlessRegistryState(): Promise<PlatformProgrammerState> {
  const local = loadLocalRegistryState();
  const cloud = await withTimeout(readCloudRegistryDoc(sourceDb), 1500).catch(() => null);
  const rest = !local
    ? await withTimeout(resolveLatestFirestoreMigrationRest(), 1500).catch(() => null)
    : null;

  let base: PlatformProgrammerState;
  if (cloud && (!local || cloud.revision > local.revision || cloud.updatedAt > local.updatedAt)) {
    base = cloud;
  } else if (local) {
    base = local;
  } else {
    base = ensureRegistryDefaults(null);
  }

  if (
    rest &&
    rest.migrationEpoch === CURRENT_DB_EPOCH &&
    !isSameFirebaseTarget(rest.config, base.activeTargetConfig)
  ) {
    base = ensureRegistryDefaults({
      ...base,
      activeTargetConfig: rest.config,
    });
  } else {
    base = ensureRegistryDefaults(base);
  }

  saveLocalRegistryState(base);
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

async function callProgrammerEndpoint<T>(
  endpoint: string,
  user: User,
  fullNameQuad: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  const bootBackendKnown = getInitialServerPlatformStatus().backendAvailable;
  if (!isBackendServerDetected() && !bootBackendKnown) {
    throw new ApiUnavailableError('Static host without configured backend API uses serverless mode');
  }

  const sendWithToken = async (forceRefresh: boolean) => {
    const idToken = await withTimeout(user.getIdToken(forceRefresh), 4000);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), bootBackendKnown ? 6000 : 1800);
    try {
      return await fetch(resolveApiUrl(endpoint), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
          'X-DuoBoard-Name': encodeURIComponent(fullNameQuad || ''),
        },
        body: JSON.stringify({
          tokenProjectId: activeFirebaseConfig.projectId,
          tokenApiKey: activeFirebaseConfig.apiKey,
          tokenFirestoreDatabaseId: activeFirebaseConfig.firestoreDatabaseId || '',
          ...payload,
          fullNameQuad,
        }),
      });
    } finally {
      window.clearTimeout(timer);
    }
  };

  let resp: Response;
  try {
    resp = await sendWithToken(false);
    if (bootBackendKnown && (resp.status === 401 || resp.status === 403)) {
      resp = await sendWithToken(true);
    }
  } catch {
    throw new ApiUnavailableError('Network unreachable');
  }

  if (
    resp.status === 404 ||
    resp.status === 405 ||
    resp.status === 501 ||
    resp.status === 502 ||
    resp.status === 503 ||
    resp.status === 504 ||
    (!bootBackendKnown && !resp.ok)
  ) {
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
  const localBeforeFetch = loadLocalRegistryState();

  try {
    let serverRes = await callProgrammerEndpoint<{
      isProgrammer: boolean;
      isMaster: boolean;
      state?: PlatformProgrammerState;
    }>('/api/programmer/session', user, fullNameQuad);

    const serverLooksFresh =
      !serverRes.state ||
      (serverRes.state.revision <= 2 &&
        serverRes.state.playerDatabases.length === 0 &&
        serverRes.state.backupDatabases.length === 0);

    const didReadCloud = serverLooksFresh || !serverRes.isProgrammer;
    const cloudReg = didReadCloud
      ? await withTimeout(readCloudRegistryDoc(sourceDb), 1800).catch(() => null)
      : null;

    if (cloudReg) {
      markMirroredSignature(
        activeFirebaseConfig.projectId,
        computeRegistrySignature(cloudReg),
        cloudReg.revision
      );
    }

    if (cloudReg && serverRes.state) {
      const cloudHasMissingDbs =
        cloudReg.playerDatabases.some(
          (cp) => !serverRes.state!.playerDatabases.some((sp) => isSameFirebaseTarget(sp.config, cp.config))
        ) ||
        cloudReg.backupDatabases.some(
          (cb) => !serverRes.state!.backupDatabases.some((sb) => isSameFirebaseTarget(sb.config, cb.config))
        );

      const cloudRicher =
        cloudHasMissingDbs ||
        cloudReg.revision > serverRes.state.revision ||
        cloudReg.playerDatabases.length > serverRes.state.playerDatabases.length ||
        cloudReg.backupDatabases.length > serverRes.state.backupDatabases.length ||
        cloudReg.programmers.length > serverRes.state.programmers.length;

      if (cloudRicher) {
        try {
          const hydrated = await callProgrammerEndpoint<{
            isProgrammer: boolean;
            isMaster: boolean;
            state?: PlatformProgrammerState;
          }>('/api/programmer/hydrate', user, fullNameQuad, {
            poolConfig: activeFirebaseConfig,
          });
          if (hydrated.state) {
            serverRes = hydrated;
          }
        } catch {
          // Keep serverRes
        }
      }
    }

    // Never drop already-saved local databases or active target if server container restarted cleanly!
    if (serverRes.isProgrammer && serverRes.state) {
      const localSeed = localBeforeFetch || getFallbackProgrammerState(null);
      const missingPlayers = localSeed.playerDatabases.filter(
        (lp) =>
          !serverRes.state!.playerDatabases.some((sp) => isSameFirebaseTarget(sp.config, lp.config)) &&
          !serverRes.state!.backupDatabases.some((sb) => isSameFirebaseTarget(sb.config, lp.config))
      );
      const missingBackups = localSeed.backupDatabases.filter(
        (lb) =>
          !serverRes.state!.backupDatabases.some((sb) => isSameFirebaseTarget(sb.config, lb.config)) &&
          !serverRes.state!.playerDatabases.some((sp) => isSameFirebaseTarget(sp.config, lb.config))
      );
      const serverNeedsTargetSync =
        serverLooksFresh &&
        !isSameFirebaseTarget(serverRes.state.activeTargetConfig, activeFirebaseConfig) &&
        !isSameFirebaseTarget(activeFirebaseConfig, defaultFirebaseConfig);

      if (
        serverNeedsTargetSync ||
        ((missingPlayers.length > 0 || missingBackups.length > 0) &&
          (serverLooksFresh || localSeed.revision >= serverRes.state.revision))
      ) {
        try {
          const synced = await callProgrammerEndpoint<{
            ok: boolean;
            state?: PlatformProgrammerState;
          }>('/api/programmer/sync-state', user, fullNameQuad, {
            state: serverNeedsTargetSync
              ? { ...localSeed, activeTargetConfig: activeFirebaseConfig }
              : localSeed,
          });
          if (synced?.state) {
            serverRes.state = synced.state;
          }
        } catch {
          // Ignore sync failure
        }
      }
    }

    if (serverRes.state) {
      const normalized = ensureRegistryDefaults({
        ...serverRes.state,
        activeTargetConfig:
          !isSameFirebaseTarget(activeFirebaseConfig, defaultFirebaseConfig) &&
          isSameFirebaseTarget(serverRes.state.activeTargetConfig, defaultFirebaseConfig) &&
          serverRes.state.revision <= 1
            ? activeFirebaseConfig
            : serverRes.state.activeTargetConfig,
      });
      serverRes.state = normalized;
      saveLocalRegistryState(normalized);
      if (normalized.playerDatabases.length > 0) {
        savePreviousFirebaseConfigs(
          [
            ...normalized.playerDatabases.map((d) => d.config),
            ...getPreviousFirebaseConfigs(),
          ],
          activeFirebaseConfig
        );
      }

      // Only mirror to Firestore when signature actually changed AND (we verified cloud was missing/older or local revision exceeded known cloud revision).
      const knownCloudRev = cloudReg?.revision ?? cloudKnownRevisionByTarget.get(activeFirebaseConfig.projectId) ?? 0;
      const shouldMirror =
        serverRes.isMaster &&
        getLastMirroredSignature(activeFirebaseConfig.projectId) !== computeRegistrySignature(normalized) &&
        ((didReadCloud && cloudReg === null) || normalized.revision > knownCloudRev);
      if (shouldMirror) {
        void writeFirestoreRegistryDoc(
          sourceDb,
          normalized,
          user.uid,
          fullNameQuad || user.displayName || MASTER_PROGRAMMER_NAME
        );
      }
    } else if (!serverRes.isProgrammer && cloudReg) {
      const cloudRole = await isIdentityProgrammerServerless(cloudReg, {
        email: user.email,
        fullNameQuad,
      });
      if (cloudRole.isProgrammer) {
        return {
          isProgrammer: true,
          isMaster: cloudRole.isMaster,
          state: cloudReg,
          mode: 'serverless',
        };
      }
    }

    if (
      !serverRes.state &&
      (serverRes.isProgrammer || isMasterProgrammerIdentity({ email: user.email, fullNameQuad }))
    ) {
      const fallbackState = await loadServerlessRegistryState().catch(() =>
        getFallbackProgrammerState(localBeforeFetch)
      );
      return {
        isProgrammer: true,
        isMaster:
          serverRes.isMaster ||
          isMasterProgrammerIdentity({ email: user.email, fullNameQuad }),
        state: fallbackState,
        mode: 'serverless',
      };
    }

    return { ...serverRes, mode: 'server' };
  } catch (err) {
    const state = await loadServerlessRegistryState().catch(() =>
      getFallbackProgrammerState(localBeforeFetch)
    );
    const role = await isIdentityProgrammerServerless(state, {
      email: user.email,
      fullNameQuad,
    });
    if (
      role.isMaster &&
      getLastMirroredSignature(activeFirebaseConfig.projectId) !== computeRegistrySignature(state)
    ) {
      void writeFirestoreRegistryDoc(
        sourceDb,
        state,
        user.uid,
        fullNameQuad || user.displayName || MASTER_PROGRAMMER_NAME
      );
    }
    if (role.isProgrammer) {
      return {
        isProgrammer: true,
        isMaster: role.isMaster,
        state,
        mode: 'serverless',
      };
    }
    if (!(err instanceof ApiUnavailableError)) {
      throw err;
    }
    return {
      isProgrammer: false,
      isMaster: false,
      state: undefined,
      mode: 'serverless',
    };
  }
}

export async function addPlayerDatabase(
  user: User,
  fullNameQuad: string,
  config: FirebaseAppConfig,
  label: string,
  verification: DatabaseVerificationSummary
): Promise<{ ok: boolean; added: RegisteredDatabaseEntry; state: PlatformProgrammerState }> {
  if (!verification.firestoreReady || !verification.googleAuthReady || !verification.rulesReady) {
    throw new Error('يجب إتمام الفحص الشامل (100%) أولاً قبل إضافة القاعدة.');
  }

  const cleanCfg = sanitizeFirebaseConfig(config);
  if (!cleanCfg) throw new Error('إعدادات Firebase غير صالحة');

  const linkAddedPlayerDatabaseEverywhere = async (
    normalized: PlatformProgrammerState
  ): Promise<void> => {
    saveLocalRegistryState(normalized);
    savePreviousFirebaseConfigs(
      [
        cleanCfg,
        ...normalized.playerDatabases.map((d) => d.config),
        ...getPreviousFirebaseConfigs(),
      ],
      activeFirebaseConfig
    );
    // Sync registry onto active DB + newly added DB in parallel (bounded, non-blocking error)
    const writes: Promise<unknown>[] = [
      withTimeout(
        writeFirestoreRegistryDoc(
          sourceDb,
          normalized,
          user.uid,
          fullNameQuad || user.displayName || MASTER_PROGRAMMER_NAME
        ),
        2200
      ).catch(() => false),
      fetchServerQuotaStatus(cleanCfg.projectId).catch(() => null),
    ];
    try {
      const targetApp = getOrInitFirebaseApp(cleanCfg);
      const targetAuth = getAuth(targetApp);
      if (targetAuth.currentUser) {
        const targetDb = createFirestoreInstance(targetApp, cleanCfg);
        writes.push(
          withTimeout(
            writeFirestoreRegistryDoc(
              targetDb,
              normalized,
              targetAuth.currentUser.uid,
              fullNameQuad || targetAuth.currentUser.displayName || MASTER_PROGRAMMER_NAME
            ),
            2200
          ).catch(() => false)
        );
      }
    } catch {
      // Optional target registry mirror
    }
    await Promise.allSettled(writes);
  };

  try {
    const res = await callProgrammerEndpoint<{
      ok: boolean;
      added: RegisteredDatabaseEntry;
      state: PlatformProgrammerState;
    }>('/api/programmer/player-dbs/add', user, fullNameQuad, {
      config: cleanCfg,
      label,
      verification,
    });
    const normalized = ensureRegistryDefaults(res.state);
    const persisted = normalized.playerDatabases.find((d) =>
      isSameFirebaseTarget(d.config, cleanCfg)
    );
    if (!persisted) {
      throw new Error('لم يؤكد الخادم حفظ القاعدة في القائمة. أعد المحاولة.');
    }
    await linkAddedPlayerDatabaseEverywhere(normalized);
    return { ok: true, added: res.added || persisted, state: normalized };
  } catch (err) {
    if (!(err instanceof ApiUnavailableError)) throw err;
  }

  const state = await loadServerlessRegistryState();
  if (state.playerDatabases.some((d) => isSameFirebaseTarget(d.config, cleanCfg))) {
    throw new Error('قاعدة البيانات هذه مضافة بالفعل في قائمة قواعد البيانات.');
  }
  if (state.backupDatabases.some((d) => isSameFirebaseTarget(d.config, cleanCfg))) {
    throw new Error('هذه القاعدة مسجلة بالفعل كقاعدة احتياطية صامتة.');
  }

  const now = Date.now();
  const nextOrder = state.playerDatabases.length + 1;
  const added: RegisteredDatabaseEntry = {
    id: `player_${now}_${Math.random().toString(36).slice(2, 6)}`,
    order: nextOrder,
    role: 'player',
    label: label.trim() || `قاعدة بيانات #${nextOrder} — ${cleanCfg.projectId}`,
    config: cleanCfg,
    verification,
    lastUsedAt: isSameFirebaseTarget(cleanCfg, activeFirebaseConfig) ? now : null,
    addedByEmail: user.email || undefined,
    addedAt: now,
  };
  const next = ensureRegistryDefaults({
    ...state,
    playerDatabases: [...state.playerDatabases, added],
    revision: state.revision + 1,
    updatedByEmail: user.email || undefined,
    updatedAt: now,
  });
  await linkAddedPlayerDatabaseEverywhere(next);
  return { ok: true, added, state: next };
}

export async function removePlayerDatabase(
  user: User,
  fullNameQuad: string,
  databaseId: string
): Promise<{ ok: boolean; state: PlatformProgrammerState }> {
  try {
    const res = await callProgrammerEndpoint<{ ok: boolean; state: PlatformProgrammerState }>(
      '/api/programmer/player-dbs/remove',
      user,
      fullNameQuad,
      { databaseId }
    );
    const normalized = ensureRegistryDefaults(res.state);
    saveLocalRegistryState(normalized);
    await withTimeout(
      writeFirestoreRegistryDoc(sourceDb, normalized, user.uid, fullNameQuad),
      2200
    ).catch(() => false);
    return { ok: true, state: normalized };
  } catch (err) {
    if (!(err instanceof ApiUnavailableError)) throw err;
  }

  const state = await loadServerlessRegistryState();
  const remaining = state.playerDatabases.filter((d) => d.id !== databaseId);
  if (remaining.length === state.playerDatabases.length) {
    throw new Error('القاعدة غير موجودة');
  }

  const next = ensureRegistryDefaults({
    ...state,
    playerDatabases: remaining,
    activePlayerDatabaseId:
      state.activePlayerDatabaseId === databaseId ? null : state.activePlayerDatabaseId,
    revision: state.revision + 1,
    updatedByEmail: user.email || undefined,
    updatedAt: Date.now(),
  });
  saveLocalRegistryState(next);
  await writeFirestoreRegistryDoc(sourceDb, next, user.uid, fullNameQuad || MASTER_PROGRAMMER_NAME);
  return { ok: true, state: next };
}

export async function addBackupDatabase(
  user: User,
  fullNameQuad: string,
  config: FirebaseAppConfig,
  label: string,
  verification: DatabaseVerificationSummary
): Promise<{ ok: boolean; added: RegisteredDatabaseEntry; state: PlatformProgrammerState }> {
  if (!verification.firestoreReady || !verification.googleAuthReady || !verification.rulesReady) {
    throw new Error('يجب إتمام الفحص الشامل (100%) أولاً قبل إضافة القاعدة الاحتياطية.');
  }

  const cleanCfg = sanitizeFirebaseConfig(config);
  if (!cleanCfg) throw new Error('إعدادات Firebase غير صالحة');

  try {
    const res = await callProgrammerEndpoint<{
      ok: boolean;
      added: RegisteredDatabaseEntry;
      state: PlatformProgrammerState;
    }>('/api/programmer/backup-dbs/add', user, fullNameQuad, {
      config: cleanCfg,
      label,
      verification,
    });
    const normalized = ensureRegistryDefaults(res.state);
    const persisted = normalized.backupDatabases.find((d) =>
      isSameFirebaseTarget(d.config, cleanCfg)
    );
    if (!persisted) {
      throw new Error('لم يؤكد الخادم حفظ القاعدة الاحتياطية في القائمة.');
    }
    saveLocalRegistryState(normalized);
    void withTimeout(
      writeFirestoreRegistryDoc(sourceDb, normalized, user.uid, fullNameQuad),
      2000
    ).catch(() => false);
    return { ok: true, added: res.added || persisted, state: normalized };
  } catch (err) {
    if (!(err instanceof ApiUnavailableError)) throw err;
  }

  const state = await loadServerlessRegistryState();
  if (state.backupDatabases.some((d) => isSameFirebaseTarget(d.config, cleanCfg))) {
    throw new Error('هذه القاعدة الاحتياطية مضافة بالفعل.');
  }
  if (state.playerDatabases.some((d) => isSameFirebaseTarget(d.config, cleanCfg))) {
    throw new Error('هذه القاعدة مسجلة كقاعدة للاعبين، لا يمكن إضافتها كاحتياطية صامتة.');
  }
  if (
    isSameFirebaseTarget(cleanCfg, defaultFirebaseConfig) ||
    isSameFirebaseTarget(cleanCfg, activeFirebaseConfig)
  ) {
    throw new Error('القاعدة النشطة حالياً لا يمكن استخدامها كقاعدة احتياطية صامتة.');
  }

  const now = Date.now();
  const nextOrder = state.backupDatabases.length + 1;
  const added: RegisteredDatabaseEntry = {
    id: `backup_${now}_${Math.random().toString(36).slice(2, 6)}`,
    order: nextOrder,
    role: 'backup',
    label: label.trim() || `احتياطية #${nextOrder} — ${cleanCfg.projectId}`,
    config: cleanCfg,
    verification,
    lastAnnouncedToProjectId: null,
    addedByEmail: user.email || undefined,
    addedAt: now,
  };
  const next = ensureRegistryDefaults({
    ...state,
    backupDatabases: [...state.backupDatabases, added],
    revision: state.revision + 1,
    updatedByEmail: user.email || undefined,
    updatedAt: now,
  });
  saveLocalRegistryState(next);
  await writeFirestoreRegistryDoc(sourceDb, next, user.uid, fullNameQuad || MASTER_PROGRAMMER_NAME);
  return { ok: true, added, state: next };
}

export async function removeBackupDatabase(
  user: User,
  fullNameQuad: string,
  databaseId: string
): Promise<{ ok: boolean; state: PlatformProgrammerState }> {
  try {
    const res = await callProgrammerEndpoint<{ ok: boolean; state: PlatformProgrammerState }>(
      '/api/programmer/backup-dbs/remove',
      user,
      fullNameQuad,
      { databaseId }
    );
    const normalized = ensureRegistryDefaults(res.state);
    saveLocalRegistryState(normalized);
    void writeFirestoreRegistryDoc(sourceDb, normalized, user.uid, fullNameQuad);
    return { ok: true, state: normalized };
  } catch (err) {
    if (!(err instanceof ApiUnavailableError)) throw err;
  }

  const state = await loadServerlessRegistryState();
  const remaining = state.backupDatabases.filter((d) => d.id !== databaseId);
  if (remaining.length === state.backupDatabases.length) {
    throw new Error('القاعدة الاحتياطية غير موجودة');
  }

  const next = ensureRegistryDefaults({
    ...state,
    backupDatabases: remaining,
    revision: state.revision + 1,
    updatedByEmail: user.email || undefined,
    updatedAt: Date.now(),
  });
  saveLocalRegistryState(next);
  await writeFirestoreRegistryDoc(sourceDb, next, user.uid, fullNameQuad || MASTER_PROGRAMMER_NAME);
  return { ok: true, state: next };
}

export async function publishMigrationCompleteSignal(params: {
  targetConfig: FirebaseAppConfig;
  migratedRoomId?: string | null;
  backupDbId?: string;
  backupProjectId?: string;
  fullNameQuad: string;
}): Promise<{ ok: boolean; state?: PlatformProgrammerState }> {
  const tApp = getOrInitFirebaseApp(params.targetConfig);
  const tAuth = getAuth(tApp);
  const tUser = tAuth.currentUser || sourceAuth.currentUser;
  if (!tUser) return { ok: false };

  try {
    const res = await callProgrammerEndpoint<{
      ok: boolean;
      state?: PlatformProgrammerState;
    }>('/api/programmer/migrate-complete', tUser, params.fullNameQuad, {
      targetConfig: params.targetConfig,
      migratedRoomId: params.migratedRoomId || null,
      backupDbId: params.backupDbId || '',
      backupProjectId: params.backupProjectId || '',
      tokenProjectId: tAuth.currentUser ? params.targetConfig.projectId : activeFirebaseConfig.projectId,
      tokenApiKey: tAuth.currentUser ? params.targetConfig.apiKey : activeFirebaseConfig.apiKey,
      tokenFirestoreDatabaseId: tAuth.currentUser
        ? params.targetConfig.firestoreDatabaseId || ''
        : activeFirebaseConfig.firestoreDatabaseId || '',
    });
    if (res.state) {
      const normalized = ensureRegistryDefaults(res.state);
      saveLocalRegistryState(normalized);
      return { ok: true, state: normalized };
    }
    return { ok: Boolean(res.ok) };
  } catch {
    return { ok: false };
  }
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
    const normalized = ensureRegistryDefaults(res.state);
    saveLocalRegistryState(normalized);
    void writeFirestoreRegistryDoc(sourceDb, normalized, user.uid, fullNameQuad);
    return { ok: true, member: res.member, state: normalized };
  } catch (err) {
    if (!(err instanceof ApiUnavailableError)) throw err;
  }

  const cleanName = targetFullNameQuad.trim().replace(/\s+/g, ' ');
  const cleanEmail = targetEmail.trim().toLowerCase();
  if (!cleanName && !cleanEmail) {
    throw new Error('أدخل الاسم الرباعي أو البريد الإلكتروني للمستخدم.');
  }

  const state = await loadServerlessRegistryState();
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
    ...(cleanEmail
      ? { email: cleanEmail, emailHash: newHash, emailMasked: maskEmailAddress(cleanEmail) }
      : {}),
    isMaster: false,
    promotedBy: fullNameQuad || user.displayName || MASTER_PROGRAMMER_NAME,
    promotedAt: Date.now(),
  };

  const next = ensureRegistryDefaults({
    ...state,
    programmers: [...state.programmers, member],
    revision: state.revision + 1,
    updatedAt: Date.now(),
  });
  saveLocalRegistryState(next);
  await writeFirestoreRegistryDoc(sourceDb, next, user.uid, fullNameQuad || MASTER_PROGRAMMER_NAME);
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
    const normalized = ensureRegistryDefaults(res.state);
    saveLocalRegistryState(normalized);
    void writeFirestoreRegistryDoc(sourceDb, normalized, user.uid, fullNameQuad);
    return { ok: true, state: normalized };
  } catch (err) {
    if (!(err instanceof ApiUnavailableError)) throw err;
  }

  const state = await loadServerlessRegistryState();
  const target = state.programmers.find((m) => m.id === memberId);
  if (!target) throw new Error('العضو غير موجود');
  if (target.isMaster) throw new Error('لا يمكن إزالة المبرمج الأساسي للمنصة.');

  const next = ensureRegistryDefaults({
    ...state,
    programmers: state.programmers.filter((m) => m.id !== memberId),
    revision: state.revision + 1,
    updatedAt: Date.now(),
  });
  saveLocalRegistryState(next);
  await writeFirestoreRegistryDoc(sourceDb, next, user.uid, fullNameQuad || MASTER_PROGRAMMER_NAME);
  return { ok: true, state: next };
}

export async function writePlatformMigrationPointer(params: {
  targetDb: Firestore;
  uid: string;
  displayName?: string;
  targetConfig: FirebaseAppConfig;
  previousConfigs?: FirebaseAppConfig[];
  migratedRoomId?: string | null;
}): Promise<boolean> {
  const { targetDb, uid, displayName, targetConfig, previousConfigs = [], migratedRoomId } = params;
  const dedupedPrev = previousConfigs
    .filter((cfg) => !isSameFirebaseTarget(cfg, targetConfig))
    .slice(0, 12)
    .map((cfg) => ({
      apiKey: cfg.apiKey,
      authDomain: cfg.authDomain,
      projectId: cfg.projectId,
      appId: cfg.appId,
      ...(cfg.storageBucket ? { storageBucket: cfg.storageBucket } : {}),
      ...(cfg.messagingSenderId ? { messagingSenderId: cfg.messagingSenderId } : {}),
      ...(cfg.measurementId ? { measurementId: cfg.measurementId } : {}),
      ...(cfg.firestoreDatabaseId ? { firestoreDatabaseId: cfg.firestoreDatabaseId } : {}),
    }));

  try {
    await withTimeout(
      setDoc(doc(targetDb, 'platform', 'migration'), {
        id: 'migration',
        projectId: targetConfig.projectId,
        apiKey: targetConfig.apiKey,
        authDomain: targetConfig.authDomain,
        appId: targetConfig.appId,
        ...(targetConfig.storageBucket ? { storageBucket: targetConfig.storageBucket } : {}),
        ...(targetConfig.messagingSenderId ? { messagingSenderId: targetConfig.messagingSenderId } : {}),
        ...(targetConfig.measurementId ? { measurementId: targetConfig.measurementId } : {}),
        ...(targetConfig.firestoreDatabaseId
          ? { firestoreDatabaseId: targetConfig.firestoreDatabaseId }
          : {}),
        migratedBy: uid,
        migratedByName: (displayName || 'مستخدم المنصة').slice(0, 120),
        ...(migratedRoomId ? { migratedRoomId: migratedRoomId.slice(0, 16) } : {}),
        migrationEpoch: CURRENT_DB_EPOCH,
        previousConfigs: dedupedPrev,
        updatedAt: serverTimestamp(),
      }),
      3500
    );
    return true;
  } catch {
    return false;
  }
}

export { getBackupFirebaseConfigs };
