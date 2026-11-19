import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from './firestoreTracked';
import {
  AlertCircle,
  Archive,
  ArrowRightLeft,
  BellRing,
  Code2,
  Database,
  Home,
  ListChecks,
  LogOut,
  Power,
  RefreshCw,
  X,
} from 'lucide-react';
import {
  activeFirebaseConfig,
  activeProjectId,
  activateCustomFirebaseConfig,
  auth,
  buildCleanPrimaryUrl,
  clearPendingRejoinRoom,
  clearSwitchRequiresLogin,
  consumeConsolidatedProjectNotice,
  CURRENT_DB_EPOCH,
  db,
  defaultFirebaseConfig,
  firebaseTargetKey,
  getInitialServerPlatformStatus,
  getLastAppliedBackupDocTs,
  getPendingRejoinRoom,
  getPreviousFirebaseConfigs,
  getTimestampMillis,
  googleProvider,
  handleFirestoreError,
  hasSwitchRequiresLogin,
  isCustomFirebaseConfig,
  isMasterProgrammerIdentity,
  isQuadNameValid,
  isSameFirebaseTarget,
  justConsolidatedFrom,
  markSwitchRequiresLogin,
  OperationType,
  resetToDefaultFirebaseConfig,
  resolveBackupAnnouncementsRest,
  resolveLatestFirestoreMigrationRest,
  sanitizeFirebaseConfig,
  saveBackupFirebaseConfigs,
  setLastAppliedBackupDocTs,
  subscribeQuotaError,
  type FirebaseAppConfig,
  type ServerPlatformPointer,
} from './firebase';
import {
  fetchProgrammerSession,
  restoreActiveSupervisorRoomFromSnapshot,
  syncPersonalAccountFromPreviousDbs,
  type MigrationProgress,
  type PlatformMigrationPointer,
} from './firebaseMigration';
import {
  deleteSessionSnapshot,
  loadSessionSnapshot,
  mergeActiveRoomSnapshot,
  saveSessionSnapshot,
  type StoredRoomSnapshot,
  type StoredUserProfileSnapshot,
} from './localDraftStore';
import { closeRoomInDatabase, handleRoomListenerError } from './roomLifecycle';
import type {
  Participant,
  PlatformProgrammerState,
  Room,
  UserProfile,
} from './types';
import {
  applyServerQuotaStatus,
  fetchServerQuotaStatus,
  formatQuotaMetricArabic,
  getCachedProjectQuotaStatus,
  reportFirestoreQuotaExhausted,
  subscribeQuotaStatus,
  type ProjectQuotaStatus,
} from './quotaTracker';
import { AuthGate } from './components/AuthGate';
import { RoleHub } from './components/RoleHub';
import { WaitingRoom } from './components/WaitingRoom';
import { QuizArena } from './components/QuizArena';
import { InteractiveArena } from './components/InteractiveArena';
import { TestResultsView } from './components/TestResultsView';
import { SavedTestsView } from './components/SavedTestsView';
import { MyQuizzesView } from './components/MyQuizzesView';
import { ProgrammerDashboard } from './components/ProgrammerDashboard';
import { QuickMigrateModal } from './components/QuickMigrateModal';
import { DuoOwlEmblem, playDuoSound } from './components/DuoIcons';
import { DuoLoading } from './components/DuoLoading';

interface ErrorBoundaryState {
  hasError: boolean;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

class AppErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-white">
          <div className="duo-card max-w-md w-full p-8 text-center flex flex-col items-center gap-4">
            <DuoOwlEmblem className="w-16 h-16" />
            <h1 className="text-xl font-black text-[#3C3C3C]">
              حدث خطأ غير متوقع
            </h1>
            <p className="text-sm font-bold text-[#777777]">
              يرجى تحديث الصفحة لإعادة الاتصال واستكمال العمل.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3 w-full">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="duo-btn px-5 py-3 rounded-2xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white font-black cursor-pointer"
              >
                تحديث الصفحة
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const ROOM_STORAGE_PREFIX = 'duoboard_active_room_';

function persistActiveRoom(uid: string, roomId: string | null) {
  try {
    const key = `${ROOM_STORAGE_PREFIX}${uid}`;
    if (roomId) {
      localStorage.setItem(key, roomId);
      const url = new URL(window.location.href);
      url.searchParams.set('room', roomId);
      window.history.replaceState({}, '', url.toString());
    } else {
      localStorage.removeItem(key);
      const url = new URL(window.location.href);
      if (url.searchParams.has('room')) {
        url.searchParams.delete('room');
        window.history.replaceState({}, '', url.toString());
      }
    }
  } catch {
    // Ignore storage/history errors in restricted contexts
  }
}

function getCandidateSavedRoom(uid: string): string | null {
  try {
    const fromStorage = localStorage.getItem(`${ROOM_STORAGE_PREFIX}${uid}`);
    const fromUrl = new URLSearchParams(window.location.search).get('room');
    const raw = (fromStorage || fromUrl || '').trim().toUpperCase();
    if (/^[A-Z0-9_-]{4,16}$/.test(raw)) return raw;
    return null;
  } catch {
    return null;
  }
}

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null);

  const [tab, setTab] = useState<'home' | 'saved' | 'quizzes' | 'programmer'>('home');
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [quotaAlert, setQuotaAlert] = useState<boolean>(false);
  const [liveQuotaStatus, setLiveQuotaStatus] = useState<ProjectQuotaStatus>(() =>
    getCachedProjectQuotaStatus(activeProjectId)
  );
  const [dismissedQuotaStep, setDismissedQuotaStep] = useState<number | null>(null);
  const [quotaToastNotification, setQuotaToastNotification] = useState<{
    step: number;
    minRemainingPct: number;
    metricLabel: string;
    remainingCount: number;
    alertCount: number;
  } | null>(null);
  const lastAlertedStepRef = useRef<{ key: string; step: number | null }>({
    key: '',
    step: null,
  });
  const [quickMigrateOpen, setQuickMigrateOpen] = useState<boolean>(false);
  const [isProgrammer, setIsProgrammer] = useState<boolean>(false);
  const [isMasterProgrammer, setIsMasterProgrammer] = useState<boolean>(false);
  const [programmerState, setProgrammerState] =
    useState<PlatformProgrammerState | null>(null);
  const [programmerMode, setProgrammerMode] = useState<'server' | 'serverless'>(() =>
    getInitialServerPlatformStatus().backendAvailable ? 'server' : 'serverless'
  );
  const [programmerLoading, setProgrammerLoading] = useState<boolean>(false);
  const [programmerError, setProgrammerError] = useState<string | null>(null);
  const programmerReqSeqRef = useRef(0);
  const [pendingRoomNotice, setPendingRoomNotice] = useState<string | null>(null);
  const [autoSwitchNotice, setAutoSwitchNotice] = useState<{
    targetProjectId: string;
    backupProjectId?: string;
    percent: number;
    title: string;
    subtitle: string;
    detail?: string;
  } | null>(null);
  const [personalSyncProgress, setPersonalSyncProgress] =
    useState<MigrationProgress | null>(null);
  const [needsInteractiveSync, setNeedsInteractiveSync] = useState<boolean>(false);
  const [syncSuccessNotice, setSyncSuccessNotice] = useState<string | null>(null);
  const [roomClosedNotice, setRoomClosedNotice] = useState<string | null>(null);
  const [closingRoomBusy, setClosingRoomBusy] = useState<boolean>(false);
  const [showCloseRoomModal, setShowCloseRoomModal] = useState<boolean>(false);
  const [consolidatedNoticeProject, setConsolidatedNoticeProject] = useState<
    string | null
  >(() => (justConsolidatedFrom ? null : consumeConsolidatedProjectNotice()));

  useEffect(() => {
    if (!justConsolidatedFrom) return;
    let cancelled = false;
    markSwitchRequiresLogin(defaultFirebaseConfig);
    const timer = window.setTimeout(async () => {
      if (cancelled) return;
      try {
        await signOut(auth).catch(() => {});
        if ('caches' in window) {
          const keys = await window.caches.keys();
          await Promise.all(keys.map((k) => window.caches.delete(k)));
        }
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.update().catch(() => undefined)));
        }
      } catch {
        // Ignore cache or SW errors in restricted browsers
      }
      window.location.replace(buildCleanPrimaryUrl());
    }, 950);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const activeRoomIdRef = useRef(activeRoomId);
  activeRoomIdRef.current = activeRoomId;
  const roomRef = useRef(room);
  roomRef.current = room;
  const firebaseUserRef = useRef(firebaseUser);
  firebaseUserRef.current = firebaseUser;
  const wasParticipantInRoomRef = useRef(false);
  const previousRoomStatusRef = useRef<Room['status'] | null>(null);
  const switchingInProgressRef = useRef(false);
  const backupCheckInProgressRef = useRef(false);
  const lastSeenRegistryTagRef = useRef<string>('');

  const applyRemotePlatformPointer = useCallback(
    (incoming: {
      config: FirebaseAppConfig;
      resetToDefault?: boolean;
      migratedRoomId?: string | null;
      previousConfigs?: FirebaseAppConfig[];
      revision?: string | number;
      backupProjectId?: string;
      backupDocTs?: number;
    }) => {
      if (justConsolidatedFrom || switchingInProgressRef.current) return;
      const ptrCfg = sanitizeFirebaseConfig(incoming.config);
      if (!ptrCfg) return;

      const targetKey = firebaseTargetKey(ptrCfg);
      const wantsDefault = isSameFirebaseTarget(ptrCfg, defaultFirebaseConfig);

      // Already on requested DB
      if (isSameFirebaseTarget(ptrCfg, activeFirebaseConfig)) return;

      // Do not interrupt the initiating programmer tab while migration is finishing
      try {
        if (sessionStorage.getItem('duoboard_self_migrated_target') === targetKey) {
          return;
        }
      } catch {
        // Ignore sessionStorage restrictions
      }

      const switchRevision = String(incoming.revision || CURRENT_DB_EPOCH);
      const switchToken = `${targetKey}::${wantsDefault ? 'default' : 'custom'}::${switchRevision}`;
      try {
        if (sessionStorage.getItem('duoboard_auto_switched_to') === switchToken) {
          return;
        }
        sessionStorage.setItem('duoboard_auto_switched_to', switchToken);
      } catch {
        // Ignore storage restrictions
      }

      switchingInProgressRef.current = true;
      if (incoming.backupDocTs) {
        setLastAppliedBackupDocTs(incoming.backupDocTs);
      }

      const destCfg = wantsDefault ? defaultFirebaseConfig : ptrCfg;
      const destProject = destCfg.projectId;
      const backupProj = incoming.backupProjectId;

      setAutoSwitchNotice({
        targetProjectId: destProject,
        backupProjectId: backupProj,
        percent: 26,
        title: backupProj
          ? 'جاري تجهيز القاعدة الجديدة عبر القاعدة الاحتياطية...'
          : 'جاري التحميل، الرجاء الانتظار قليلاً...',
        subtitle: backupProj
          ? `استيقظت القاعدة الاحتياطية (${backupProj}) وتقوم الآن بتهيئة القاعدة الجديدة (${destProject}) لتسجيل الدخول واستكمال الجلسة`
          : 'قام المبرمج بتحديث قاعدة البيانات المعتمدة — جاري نقلك تلقائياً لتسجيل الدخول واستكمال العمل',
        detail: `القاعدة الجديدة: ${destProject}`,
      });

      const currentUserPresent = Boolean(firebaseUserRef.current);
      const currentRoomPresent = activeRoomIdRef.current;
      const roomToKeep = wantsDefault
        ? null
        : currentRoomPresent ||
          (currentUserPresent && incoming.migratedRoomId ? incoming.migratedRoomId : null);

      window.setTimeout(async () => {
        setAutoSwitchNotice((prev) =>
          prev
            ? {
                ...prev,
                percent: 66,
                subtitle: 'يتم الآن إغلاق الجلسة السابقة وتحديث إعدادات الاتصال بالقاعدة الجديدة...',
              }
            : null
        );

        markSwitchRequiresLogin(destCfg);
        try {
          await signOut(auth);
        } catch {
          // Ignore signOut errors on detached DB
        }

        if (wantsDefault) {
          resetToDefaultFirebaseConfig();
        } else {
          activateCustomFirebaseConfig(
            ptrCfg,
            roomToKeep,
            Array.isArray(incoming.previousConfigs) ? incoming.previousConfigs : []
          );
        }

        setAutoSwitchNotice((prev) =>
          prev
            ? {
                ...prev,
                percent: 100,
                title: 'تمت تهيئة القاعدة الجديدة بنجاح!',
                subtitle: 'جاري نقلك الآن لتسجيل الدخول على القاعدة الجديدة...',
              }
            : null
        );

        window.setTimeout(() => {
          if (wantsDefault) {
            window.location.replace(buildCleanPrimaryUrl());
            return;
          }
          const url = new URL(window.location.href);
          url.searchParams.delete('fb');
          if (roomToKeep) {
            url.searchParams.set('room', roomToKeep);
          } else {
            url.searchParams.delete('room');
          }
          window.location.replace(url.toString());
        }, 320);
      }, 340);
    },
    []
  );

  const checkBackupAnnouncementSignal = useCallback(async () => {
    if (backupCheckInProgressRef.current || switchingInProgressRef.current) return;
    backupCheckInProgressRef.current = true;
    try {
      const backupPtr = await resolveBackupAnnouncementsRest();
      if (!backupPtr) return;
      if (
        backupPtr.updatedAtMs > getLastAppliedBackupDocTs() ||
        !isSameFirebaseTarget(backupPtr.config, activeFirebaseConfig)
      ) {
        applyRemotePlatformPointer({
          config: backupPtr.config,
          resetToDefault: backupPtr.resetToDefault,
          migratedRoomId: backupPtr.migratedRoomId,
          previousConfigs: backupPtr.previousConfigs,
          revision: backupPtr.updatedAtMs,
          backupProjectId: backupPtr.announcedFromBackupProjectId,
          backupDocTs: backupPtr.updatedAtMs,
        });
      }
    } finally {
      window.setTimeout(() => {
        backupCheckInProgressRef.current = false;
      }, 3000);
    }
  }, [applyRemotePlatformPointer]);

  useEffect(() => {
    const unsubErr = subscribeQuotaError(() => {
      setQuotaAlert(true);
      reportFirestoreQuotaExhausted(activeProjectId);
      void checkBackupAnnouncementSignal();
    });
    const unsubQuota = subscribeQuotaStatus((status) => {
      if (status.projectId === activeProjectId) {
        setLiveQuotaStatus(status);
      }
    });
    void fetchServerQuotaStatus(activeProjectId);
    const quotaPoll = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchServerQuotaStatus(activeProjectId);
      }
    }, 15_000);
    return () => {
      unsubErr();
      unsubQuota();
      window.clearInterval(quotaPoll);
    };
  }, [checkBackupAnnouncementSignal]);

  // Fire supervisor/programmer notification at <= 5.0% remaining AND on every 0.5% decrement (4.5%, 4.0%, ... 0.0%)
  const canReceiveQuotaAlerts = Boolean(
    (room && profile && room.supervisorId === profile.uid) || isProgrammer
  );

  useEffect(() => {
    if (!canReceiveQuotaAlerts) return;
    if (liveQuotaStatus.projectId !== activeProjectId) return;
    const step = liveQuotaStatus.alertStep;
    if (step === null) return;

    const bucketKey = `${liveQuotaStatus.projectId}_${liveQuotaStatus.dateKey}`;
    if (lastAlertedStepRef.current.key !== bucketKey) {
      lastAlertedStepRef.current = { key: bucketKey, step: null };
    }

    const prevStep = lastAlertedStepRef.current.step;
    if (prevStep === null || step < prevStep) {
      lastAlertedStepRef.current.step = step;
      // Re-open banner on every new -0.5% drop even if user dismissed previous step
      setDismissedQuotaStep((prevDismissed) =>
        prevDismissed !== null && step >= prevDismissed ? prevDismissed : null
      );
      const metricLabel = formatQuotaMetricArabic(liveQuotaStatus.bottleneckMetric);
      setQuotaToastNotification({
        step,
        minRemainingPct: liveQuotaStatus.minRemainingPct,
        metricLabel,
        remainingCount: liveQuotaStatus.bottleneckRemainingCount,
        alertCount: Math.max(1, liveQuotaStatus.alertCount),
      });
      playDuoSound(step <= 2.0 ? 'wrong' : 'pop');

      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification(`تنبيه سعة القاعدة (${step.toFixed(1)}% متبقية)`, {
            body: `${metricLabel} — متبقي ${liveQuotaStatus.bottleneckRemainingCount.toLocaleString(
              'en-US'
            )} عملية اليوم في ${liveQuotaStatus.projectId}`,
          });
        } catch {
          // Ignore browser notification restrictions
        }
      }
    }
  }, [
    canReceiveQuotaAlerts,
    liveQuotaStatus.projectId,
    liveQuotaStatus.dateKey,
    liveQuotaStatus.alertStep,
    liveQuotaStatus.minRemainingPct,
    liveQuotaStatus.bottleneckMetric,
    liveQuotaStatus.bottleneckRemainingCount,
    liveQuotaStatus.alertCount,
  ]);

  const refreshProgrammerState = useCallback(
    async (userOverride?: User | null, nameOverride?: string | null) => {
      const targetUser = userOverride ?? firebaseUserRef.current;
      if (!targetUser) {
        setIsProgrammer(false);
        setIsMasterProgrammer(false);
        setProgrammerState(null);
        return;
      }

      let candidateName = nameOverride || profile?.fullNameQuad || targetUser.displayName || '';
      if (!candidateName) {
        try {
          candidateName =
            localStorage.getItem(`duoboard_quad_${targetUser.uid}`) ||
            localStorage.getItem('duoboard_last_quad_name') ||
            '';
        } catch {
          // Ignore storage errors
        }
      }

      const quickMaster = isMasterProgrammerIdentity({
        email: targetUser.email,
        fullNameQuad: candidateName,
      });
      if (quickMaster) {
        setIsProgrammer(true);
        setIsMasterProgrammer(true);
      }

      const reqSeq = ++programmerReqSeqRef.current;
      setProgrammerLoading(true);
      setProgrammerError(null);
      try {
        const res = await fetchProgrammerSession(targetUser, candidateName);
        if (reqSeq !== programmerReqSeqRef.current) return;
        setIsProgrammer(res.isProgrammer || quickMaster);
        setIsMasterProgrammer(res.isMaster || quickMaster);
        if (res.mode) setProgrammerMode(res.mode);
        if (res.state) {
          setProgrammerState((prev) => {
            if (!prev) return res.state!;
            if (
              res.state!.revision < prev.revision &&
              (res.state!.playerDatabases.length < prev.playerDatabases.length ||
                res.state!.backupDatabases.length < prev.backupDatabases.length)
            ) {
              return prev;
            }
            return res.state!;
          });
        }
      } catch (err) {
        if (reqSeq !== programmerReqSeqRef.current) return;
        const msg =
          err instanceof Error && err.message
            ? err.message
            : 'تعذر الاتصال بخادم إدارة القواعد حالياً.';
        setProgrammerError(msg);
      } finally {
        if (reqSeq === programmerReqSeqRef.current) {
          setProgrammerLoading(false);
        }
      }
    },
    [profile?.fullNameQuad]
  );

  useEffect(() => {
    if (!firebaseUser) {
      setIsProgrammer(false);
      setIsMasterProgrammer(false);
      setProgrammerState(null);
      return;
    }
    void refreshProgrammerState(firebaseUser, profile?.fullNameQuad);
  }, [firebaseUser?.uid, firebaseUser?.email, profile?.fullNameQuad, refreshProgrammerState]);

  // Clear self-migration marker once reloaded onto the migrated DB
  useEffect(() => {
    try {
      const marker = sessionStorage.getItem('duoboard_self_migrated_target');
      if (marker && marker === firebaseTargetKey(activeFirebaseConfig)) {
        sessionStorage.removeItem('duoboard_self_migrated_target');
      }
    } catch {
      // Ignore sessionStorage errors
    }
  }, []);

  // Watch real-time server SSE stream + static Backup DB fallback so ALL connected devices switch immediately when a migration completes
  useEffect(() => {
    if (justConsolidatedFrom) return;
    let disposed = false;
    let es: EventSource | null = null;

    const handleServerPayload = (
      ptr: ServerPlatformPointer | null | undefined,
      counts?: {
        playerDatabasesCount?: number;
        backupDatabasesCount?: number;
        backupConfigs?: FirebaseAppConfig[];
        poolUpdatedAt?: number;
      },
      payloadType?: string
    ) => {
      if (disposed) return;

      if (Array.isArray(counts?.backupConfigs)) {
        saveBackupFirebaseConfigs(counts.backupConfigs);
      } else if (Array.isArray(ptr?.backupConfigs)) {
        saveBackupFirebaseConfigs(ptr.backupConfigs);
      }

      const regTag = `${ptr?.revision || 0}::${counts?.poolUpdatedAt || ptr?.updatedAt || 0}::${
        counts?.playerDatabasesCount ?? 0
      }::${counts?.backupDatabasesCount ?? 0}`;
      if (regTag !== lastSeenRegistryTagRef.current) {
        const hadPrevTag = Boolean(lastSeenRegistryTagRef.current);
        lastSeenRegistryTagRef.current = regTag;
        if ((hadPrevTag || payloadType === 'update') && firebaseUserRef.current) {
          void refreshProgrammerState(firebaseUserRef.current);
        }
      }

      if (!ptr || !ptr.config) return;
      applyRemotePlatformPointer({
        config: ptr.config,
        resetToDefault: ptr.resetToDefault,
        migratedRoomId: ptr.migratedRoomId,
        previousConfigs: ptr.previousConfigs,
        revision: ptr.revision || ptr.updatedAt || ptr.migrationEpoch || CURRENT_DB_EPOCH,
        backupProjectId: ptr.lastBackupAnnouncement?.backupProjectId,
      });
    };

    let lastStaticRestCheckAt = 0;
    const checkStaticBackupAndChain = async (force = false) => {
      if (disposed) return;
      const now = Date.now();
      if (!force && now - lastStaticRestCheckAt < 14_000) return;
      lastStaticRestCheckAt = now;
      try {
        const restPtr = await resolveLatestFirestoreMigrationRest();
        if (!restPtr || disposed) return;
        applyRemotePlatformPointer({
          config: restPtr.config,
          resetToDefault: restPtr.resetToDefault,
          migratedRoomId: restPtr.migratedRoomId,
          previousConfigs: restPtr.previousConfigs,
          revision: restPtr.updatedAtMs || restPtr.migrationEpoch || CURRENT_DB_EPOCH,
          backupProjectId: restPtr.announcedFromBackupProjectId,
          backupDocTs: restPtr.announcedFromBackupProjectId ? restPtr.updatedAtMs : undefined,
        });
      } catch {
        // Ignore transient network errors
      }
    };

    const checkServerPointer = async (forceRestFallback = false) => {
      if (disposed) return;
      try {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 2500);
        const resp = await fetch(`/api/platform-db?t=${Date.now()}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        window.clearTimeout(timer);
        const contentType = resp.headers.get('content-type') || '';
        if (resp.ok && contentType.includes('application/json')) {
          const data = (await resp.json()) as {
            pointer?: ServerPlatformPointer | null;
            playerDatabasesCount?: number;
            backupDatabasesCount?: number;
            backupConfigs?: FirebaseAppConfig[];
            poolUpdatedAt?: number;
            quotaStatus?: ProjectQuotaStatus;
          };
          if (data?.quotaStatus) {
            applyServerQuotaStatus(data.quotaStatus);
          }
          handleServerPayload(data?.pointer, data);
          return;
        }
      } catch {
        // Static host or server offline — fall back to REST check
      }
      await checkStaticBackupAndChain(forceRestFallback);
    };

    try {
      es = new EventSource('/api/platform-db/stream');
      es.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as {
            type?: string;
            pointer?: ServerPlatformPointer | null;
            playerDatabasesCount?: number;
            backupDatabasesCount?: number;
            backupConfigs?: FirebaseAppConfig[];
            poolUpdatedAt?: number;
            quotaStatus?: ProjectQuotaStatus;
          };
          if (msg?.quotaStatus) {
            applyServerQuotaStatus(msg.quotaStatus);
          }
          if (msg?.type === 'quota_alert') return;
          handleServerPayload(msg?.pointer, msg, msg?.type);
        } catch {
          // Ignore malformed SSE payload
        }
      };
      es.onerror = () => {
        // Browser auto-reconnects or polling checks static fallback
      };
    } catch {
      // EventSource unsupported or static host
    }

    const onVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        void checkServerPointer(true);
      }
    };
    window.addEventListener('focus', onVisibilityOrFocus);
    document.addEventListener('visibilitychange', onVisibilityOrFocus);
    const pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void checkServerPointer(false);
      }
    }, 4_500);

    return () => {
      disposed = true;
      es?.close();
      window.removeEventListener('focus', onVisibilityOrFocus);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
      window.clearInterval(pollTimer);
    };
  }, [applyRemotePlatformPointer, refreshProgrammerState]);

  // Watch Firestore platform/migration AND platform/registry live so ALL users switch & ALL programmers stay synced
  useEffect(() => {
    if (justConsolidatedFrom) return;
    const unsubMigration = onSnapshot(
      doc(db, 'platform', 'migration'),
      (snap) => {
        if (!snap.exists()) return;
        const ptr = snap.data() as PlatformMigrationPointer;
        if (ptr.migrationEpoch !== CURRENT_DB_EPOCH) return;
        const ptrCfg = sanitizeFirebaseConfig(ptr);
        if (!ptrCfg) return;
        applyRemotePlatformPointer({
          config: ptrCfg,
          resetToDefault: isSameFirebaseTarget(ptrCfg, defaultFirebaseConfig),
          migratedRoomId: ptr.migratedRoomId,
          previousConfigs: Array.isArray(ptr.previousConfigs) ? ptr.previousConfigs : [],
          revision: getTimestampMillis(ptr.updatedAt) || CURRENT_DB_EPOCH,
        });
      },
      () => {
        // Silent fallback when unauthenticated or offline
      }
    );

    let unsubRegistry: (() => void) | null = null;
    if (firebaseUser?.emailVerified) {
      unsubRegistry = onSnapshot(
        doc(db, 'platform', 'registry'),
        (snap) => {
          if (!snap.exists()) return;
          void refreshProgrammerState(firebaseUser);
        },
        () => {
          // Silent fallback if registry doc absent
        }
      );
    }

    return () => {
      unsubMigration();
      unsubRegistry?.();
    };
  }, [
    applyRemotePlatformPointer,
    firebaseUser?.uid,
    firebaseUser?.emailVerified,
    refreshProgrammerState,
  ]);

  const handleInteractivePersonalSync = async () => {
    if (!firebaseUser) return;
    setPersonalSyncProgress({
      step: 'signing_in',
      percent: 12,
      message: 'جاري تسجيل الدخول السريع لاستيراد بياناتك واختباراتك من القاعدة السابقة...',
    });
    try {
      const res = await syncPersonalAccountFromPreviousDbs({
        targetUser: firebaseUser,
        interactiveAuthIfNeeded: true,
        onProgress: (p) => setPersonalSyncProgress(p),
      });
      setNeedsInteractiveSync(res.needsInteractiveSignIn);
      if (res.synced || res.count > 0) {
        setSyncSuccessNotice(
          `تم استيراد ${res.count} عنصر (اختبارات ومحاولات وبيانات الحساب) من القاعدة السابقة بنجاح!`
        );
        await loadUserProfile(firebaseUser);
      } else {
        setSyncSuccessNotice('حسابك محدّث بالفعل مع القاعدة السابقة.');
      }
    } catch {
      // User closed popup or source DB unavailable
    } finally {
      setPersonalSyncProgress(null);
    }
  };

  const exitRoomLocally = useCallback(
    (nextTab: 'home' | 'saved' | 'quizzes' = 'home', closedMessage?: string) => {
      setActiveRoomId(null);
      setRoom(null);
      setParticipants([]);
      setShowCloseRoomModal(false);
      setQuickMigrateOpen(false);
      setTab(nextTab);
      wasParticipantInRoomRef.current = false;
      previousRoomStatusRef.current = null;
      clearPendingRejoinRoom();
      void deleteSessionSnapshot('active_room');
      if (firebaseUserRef.current) {
        persistActiveRoom(firebaseUserRef.current.uid, null);
      }
      if (closedMessage) {
        setRoomClosedNotice(closedMessage);
      }
    },
    []
  );

  const handleEnterRoom = (roomId: string) => {
    setRoomClosedNotice(null);
    setActiveRoomId(roomId);
    setPendingRoomNotice(null);
    clearPendingRejoinRoom();
    if (firebaseUser) {
      persistActiveRoom(firebaseUser.uid, roomId);
    }
  };

  const handleLeaveRoom = (nextTab: 'home' | 'saved' | 'quizzes' = 'home') => {
    const currentRoom = roomRef.current;
    const currentUser = firebaseUserRef.current;
    if (
      currentRoom &&
      currentUser &&
      currentRoom.supervisorId !== currentUser.uid &&
      currentRoom.status === 'waiting'
    ) {
      void deleteDoc(doc(db, 'rooms', currentRoom.id, 'participants', currentUser.uid)).catch(
        () => {}
      );
    }
    exitRoomLocally(nextTab);
  };

  const handleCloseActiveRoom = async () => {
    const targetRoomId = activeRoomIdRef.current || roomRef.current?.id;
    const currentRoom = roomRef.current;
    const currentUser = firebaseUserRef.current;
    if (
      !targetRoomId ||
      !currentRoom ||
      !currentUser ||
      currentRoom.supervisorId !== currentUser.uid ||
      closingRoomBusy
    ) {
      return;
    }
    setClosingRoomBusy(true);
    try {
      await closeRoomInDatabase(targetRoomId);
      exitRoomLocally(
        'home',
        `تم إغلاق الغرفة (${targetRoomId}) نهائياً وإخراج جميع المشاركين وإغلاقها في قاعدة البيانات.`
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `rooms/${targetRoomId}`);
    } finally {
      setClosingRoomBusy(false);
    }
  };

  const loadUserProfile = async (user: User) => {
    setProfileLoading(true);
    setProfileLoadError(null);
    setPendingRoomNotice(null);
    const path = `users/${user.uid}/private/profile`;
    try {
      const profileRef = doc(db, 'users', user.uid, 'private', 'profile');
      const snap = await getDoc(profileRef);
      let resolvedProfile: UserProfile | null = null;

      if (snap.exists()) {
        resolvedProfile = snap.data() as UserProfile;
      }

      // If arriving on a switched DB with previous DB configs in history, automatically import
      // personal profile + myQuizzes + savedTests + quizAttempts onto the current DB.
      if (user.emailVerified && getPreviousFirebaseConfigs().length > 0) {
        const runSyncTask = async () => {
          try {
            const syncRes = await syncPersonalAccountFromPreviousDbs({
              targetUser: user,
              interactiveAuthIfNeeded: false,
              onProgress: resolvedProfile ? undefined : (p) => setPersonalSyncProgress(p),
            });
            setNeedsInteractiveSync(syncRes.needsInteractiveSignIn);
            if (syncRes.synced && syncRes.count > 0) {
              setSyncSuccessNotice(
                `تم استيراد ${syncRes.count} عنصر من بياناتك واختباراتك تلقائياً إلى القاعدة الجديدة!`
              );
            }
          } catch {
            // Non-fatal
          } finally {
            setPersonalSyncProgress(null);
          }
        };

        if (resolvedProfile) {
          // Profile is already present on current DB -> enter immediately and sync history in background!
          void runSyncTask();
        } else {
          // Missing profile -> bound sync at 4.5s so fullscreen login verification never stalls.
          try {
            await Promise.race([
              runSyncTask(),
              new Promise<void>((resolve) => window.setTimeout(resolve, 4500)),
            ]);
            const refreshedSnap = await getDoc(profileRef);
            if (refreshedSnap.exists()) {
              resolvedProfile = refreshedSnap.data() as UserProfile;
            }
          } catch {
            // Non-fatal; fallback below
          } finally {
            setPersonalSyncProgress(null);
          }
        }
      }

      if (
        !resolvedProfile &&
        (isCustomFirebaseConfig || getPendingRejoinRoom() || getPreviousFirebaseConfigs().length > 0)
      ) {
        // When arriving on a newly switched Firebase project via migration/share link,
        // automatically restore the user's 4-part name from local IndexedDB snapshot if present.
        const cachedProfile =
          await loadSessionSnapshot<StoredUserProfileSnapshot>('user_profile');
        let cachedQuad = cachedProfile?.fullNameQuad ?? '';
        if (!cachedQuad) {
          try {
            cachedQuad = localStorage.getItem('duoboard_last_quad_name') || '';
          } catch {
            // Ignore storage errors
          }
        }
        const cleanedQuad = cachedQuad.trim().replace(/\s+/g, ' ');
        if (isQuadNameValid(cleanedQuad) && user.emailVerified) {
          await setDoc(profileRef, {
            uid: user.uid,
            fullNameQuad: cleanedQuad,
            email: user.email || cachedProfile?.email || 'user@example.com',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          resolvedProfile = {
            uid: user.uid,
            fullNameQuad: cleanedQuad,
            email: user.email || cachedProfile?.email || 'user@example.com',
          };
        }
      }

      if (resolvedProfile) {
        setProfile(resolvedProfile);
        try {
          localStorage.setItem(`duoboard_quad_${user.uid}`, resolvedProfile.fullNameQuad);
          localStorage.setItem('duoboard_last_quad_name', resolvedProfile.fullNameQuad);
        } catch {
          // Ignore storage errors
        }
        void saveSessionSnapshot({
          key: 'user_profile',
          uid: user.uid,
          fullNameQuad: resolvedProfile.fullNameQuad,
          email: resolvedProfile.email || user.email || 'user@example.com',
          updatedAt: Date.now(),
        });

        // Restore active room if user refreshed or followed a migration link
        const pendingRoom = getPendingRejoinRoom();
        const candidateRoom = getCandidateSavedRoom(user.uid) || pendingRoom;
        if (candidateRoom) {
          try {
            const rSnap = await getDoc(doc(db, 'rooms', candidateRoom));
            if (rSnap.exists()) {
              const rData = rSnap.data() as Room;
              if (rData.status === 'finished') {
                persistActiveRoom(user.uid, null);
                clearPendingRejoinRoom();
                void deleteSessionSnapshot('active_room');
              } else if (rData.supervisorId === user.uid) {
                setActiveRoomId(candidateRoom);
                persistActiveRoom(user.uid, candidateRoom);
                clearPendingRejoinRoom();
              } else {
                const pRef = doc(db, 'rooms', candidateRoom, 'participants', user.uid);
                const pSnap = await getDoc(pRef);
                if (pSnap.exists()) {
                  setActiveRoomId(candidateRoom);
                  persistActiveRoom(user.uid, candidateRoom);
                  clearPendingRejoinRoom();
                } else if (pendingRoom) {
                  // Auto-join student onto the newly migrated room
                  await setDoc(pRef, {
                    uid: user.uid,
                    roomId: candidateRoom,
                    fullNameQuad: resolvedProfile.fullNameQuad.slice(0, 120),
                    score: 0,
                    correctCount: 0,
                    joinedAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                  });
                  setActiveRoomId(candidateRoom);
                  persistActiveRoom(user.uid, candidateRoom);
                  clearPendingRejoinRoom();
                } else {
                  persistActiveRoom(user.uid, null);
                  void deleteSessionSnapshot('active_room');
                }
              }
            } else if (pendingRoom) {
              const cachedRoomSnap = await loadSessionSnapshot<StoredRoomSnapshot>('active_room');
              if (
                cachedRoomSnap &&
                cachedRoomSnap.room?.id === pendingRoom &&
                cachedRoomSnap.myRole === 'supervisor'
              ) {
                const restored = await restoreActiveSupervisorRoomFromSnapshot({
                  targetUser: user,
                  resolvedQuadName: resolvedProfile.fullNameQuad,
                  roomId: pendingRoom,
                });
                if (restored) {
                  setActiveRoomId(pendingRoom);
                  persistActiveRoom(user.uid, pendingRoom);
                  clearPendingRejoinRoom();
                } else {
                  setPendingRoomNotice(pendingRoom);
                }
              } else {
                setPendingRoomNotice(pendingRoom);
              }
            } else {
              persistActiveRoom(user.uid, null);
              void deleteSessionSnapshot('active_room');
            }
          } catch {
            if (!pendingRoom) {
              persistActiveRoom(user.uid, null);
            }
          }
        }
      } else {
        setProfile(null);
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const lower = raw.toLowerCase();
      try {
        handleFirestoreError(err, OperationType.GET, path);
      } catch (wrapped) {
        console.error(wrapped);
      }
      if (lower.includes('quota exceeded') || lower.includes('resource-exhausted')) {
        setQuotaAlert(true);
        void checkBackupAnnouncementSignal();
        setProfileLoadError(
          'تم الوصول للحد اليومي للقاعدة الحالية — يرجى تحديث الصفحة بعد قيام المبرمج بتفعيل قاعدة بديلة.'
        );
      } else if (lower.includes('permission-denied') || lower.includes('permission_denied')) {
        setProfileLoadError(
          'تعذر تحميل بيانات الحساب بسبب صلاحيات قاعدة البيانات. تأكد من تفعيل بريد الحساب أو أعد تسجيل الدخول.'
        );
      } else {
        setProfileLoadError(
          `تعذر الاتصال بالمنصة لتحميل بيانات حسابك (${raw}).`
        );
      }
    } finally {
      setProfileLoading(false);
      setAuthReady(true);
    }
  };

  // Auth listener & room session restore on refresh (enforces fresh sign-in right after DB switch)
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        clearSwitchRequiresLogin();
        setFirebaseUser(null);
        setProfile(null);
        setProfileLoadError(null);
        setActiveRoomId(null);
        setRoom(null);
        setParticipants([]);
        setAuthReady(true);
        return;
      }

      if (hasSwitchRequiresLogin(activeFirebaseConfig)) {
        clearSwitchRequiresLogin();
        setAuthReady(false);
        setProfile(null);
        setActiveRoomId(null);
        await signOut(auth).catch(() => {});
        return;
      }

      setFirebaseUser(user);
      await loadUserProfile(user);
    });
    return () => unsub();
  }, []);

  // Room & Participants real-time listeners
  useEffect(() => {
    if (!activeRoomId || !firebaseUser) {
      setRoom(null);
      setParticipants([]);
      wasParticipantInRoomRef.current = false;
      previousRoomStatusRef.current = null;
      return;
    }

    wasParticipantInRoomRef.current = false;
    previousRoomStatusRef.current = null;

    const rPath = `rooms/${activeRoomId}`;
    const unsubRoom = onSnapshot(
      doc(db, 'rooms', activeRoomId),
      (snap) => {
        if (snap.exists()) {
          const nextRoom = snap.data() as Room;
          const prevStatus = previousRoomStatusRef.current;
          previousRoomStatusRef.current = nextRoom.status;

          if (nextRoom.status === 'finished') {
            persistActiveRoom(firebaseUser.uid, null);
            clearPendingRejoinRoom();
            void deleteSessionSnapshot('active_room');

            // If room closed directly from waiting room (no activity), exit everyone immediately
            const closedWithoutActivity =
              prevStatus === 'waiting' ||
              (nextRoom.questionCount === 0 &&
                (nextRoom.slideCount ?? 0) === 0 &&
                nextRoom.mode !== 'competition');
            if (closedWithoutActivity) {
              exitRoomLocally('home', 'تم إغلاق الغرفة من قِبل المشرف وإخراج الجميع.');
              return;
            }
          }

          setRoom(nextRoom);
        } else {
          exitRoomLocally('home', 'تم إغلاق الغرفة نهائياً من قِبل المشرف وإخراج الجميع.');
        }
      },
      (err) => {
        void handleRoomListenerError(activeRoomId, err, OperationType.GET, rPath);
      }
    );

    const pPath = `rooms/${activeRoomId}/participants`;
    const pQuery = query(
      collection(db, 'rooms', activeRoomId, 'participants'),
      where('roomId', '==', activeRoomId)
    );
    const unsubParts = onSnapshot(
      pQuery,
      (snap) => {
        const list: Participant[] = [];
        snap.forEach((d) => list.push(d.data() as Participant));
        list.sort((a, b) => getTimestampMillis(a.joinedAt) - getTimestampMillis(b.joinedAt));
        setParticipants(list);

        const currentRoom = roomRef.current;
        const inList = list.some((p) => p.uid === firebaseUser.uid);
        if (inList) {
          wasParticipantInRoomRef.current = true;
        } else if (
          currentRoom &&
          currentRoom.supervisorId !== firebaseUser.uid &&
          (wasParticipantInRoomRef.current || !snap.metadata.fromCache)
        ) {
          exitRoomLocally('home', 'تم إغلاق الغرفة أو إخراجك منها من قِبل المشرف.');
        }
      },
      (err) => {
        void handleRoomListenerError(activeRoomId, err, OperationType.LIST, pPath);
      }
    );

    return () => {
      unsubRoom();
      unsubParts();
    };
  }, [activeRoomId, firebaseUser, exitRoomLocally]);

  // Mirror current room & participants into IndexedDB snapshot only while room is open
  useEffect(() => {
    if (!room || !profile || room.status === 'finished') return;
    void mergeActiveRoomSnapshot(room.id, {
      room,
      participants,
      myRole: room.supervisorId === profile.uid ? 'supervisor' : 'student',
    });
  }, [room, participants, profile?.uid]);

  if (justConsolidatedFrom) {
    return (
      <DuoLoading
        variant="fullscreen"
        title="تم تحديث المنصة وتوحيد قاعدة البيانات!"
        subtitle={`جاري إرجاعك تلقائياً من القاعدة السابقة (${justConsolidatedFrom}) وإعادة فتح البرنامج على القاعدة الأساسية (${activeProjectId})...`}
        percent={100}
        accent="green"
      />
    );
  }

  if (!authReady || profileLoading) {
    return (
      <DuoLoading
        variant="fullscreen"
        title={
          personalSyncProgress
            ? personalSyncProgress.message
            : 'جاري تجهيز السبورة التفاعلية...'
        }
        subtitle={
          personalSyncProgress?.detail ||
          'يتم التحقق من جلستك والاتصال بقاعدة البيانات المعتمدة'
        }
        percent={personalSyncProgress?.percent}
        accent="green"
      />
    );
  }

  const isSupervisor = Boolean(room && room.supervisorId === profile?.uid);

  // Direct view into Programmer Console if profile Firestore load failed on current DB
  if (isProgrammer && tab === 'programmer' && firebaseUser && !profile) {
    return (
      <AppErrorBoundary>
        <div className="min-h-screen bg-[#FFFFFF] flex flex-col">
          <header className="border-b-2 border-[#E5E5E5] bg-white sticky top-0 z-30">
            <div className="max-w-7xl mx-auto px-3 sm:px-6 h-14 sm:h-16 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <DuoOwlEmblem className="w-8 h-8" />
                <span className="font-latin text-xl font-black text-[#58CC02]">DuoBoard</span>
                <span className="px-2.5 py-0.5 rounded-lg bg-[#F3E8FF] border border-[#A560E8] text-[#8938D6] text-xs font-black">
                  وضع المبرمج
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setTab('home')}
                  className="duo-btn px-3.5 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer"
                >
                  العودة
                </button>
                <button
                  type="button"
                  onClick={() => void signOut(auth)}
                  className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs font-black text-[#777777] hover:text-[#EA2B2B] cursor-pointer"
                >
                  <LogOut className="w-4 h-4" />
                  <span>خروج</span>
                </button>
              </div>
            </div>
          </header>
          <main className="flex-1">
            {programmerState ? (
              <ProgrammerDashboard
                firebaseUser={firebaseUser}
                profile={profile}
                currentRoom={room}
                isSupervisorInCurrentRoom={isSupervisor}
                isMaster={isMasterProgrammer}
                backendMode={programmerMode}
                poolState={programmerState}
                onPoolStateUpdated={(next) => setProgrammerState(next)}
                onRefreshState={() =>
                  refreshProgrammerState(firebaseUser, firebaseUser.displayName)
                }
              />
            ) : programmerLoading || !programmerError ? (
              <div className="max-w-3xl mx-auto px-4 py-12">
                <DuoLoading
                  variant="card"
                  title="جاري تحميل لوحة المبرمج..."
                  subtitle="يتم جلب قائمة قواعد البيانات والصلاحيات"
                  accent="purple"
                />
              </div>
            ) : (
              <div className="max-w-xl mx-auto px-4 py-12 text-center">
                <div className="duo-card p-6 flex flex-col items-center gap-4">
                  <AlertCircle className="w-10 h-10 text-[#EA2B2B]" />
                  <p className="text-sm font-black text-[#3C3C3C]">
                    تعذر الاتصال بخادم إدارة القواعد حالياً.
                  </p>
                  {programmerError && (
                    <p className="text-xs font-bold text-[#777777] dir-ltr break-words max-w-full">
                      {programmerError}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      void refreshProgrammerState(
                        firebaseUser,
                        firebaseUser.displayName
                      )
                    }
                    className="duo-btn px-5 py-2.5 rounded-xl bg-[#A560E8] border-2 border-b-4 border-[#8938D6] text-white text-sm font-black cursor-pointer"
                  >
                    إعادة المحاولة
                  </button>
                </div>
              </div>
            )}
          </main>
        </div>
      </AppErrorBoundary>
    );
  }

  if (firebaseUser && !profile && profileLoadError) {
    return (
      <>
        <div className="min-h-screen bg-white flex items-center justify-center p-4 sm:p-6">
          <div className="duo-card max-w-lg w-full p-6 sm:p-8 text-center flex flex-col items-center gap-4 border-[#FF4B4B]">
            <div className="w-14 h-14 rounded-2xl bg-[#FFDFE0] text-[#EA2B2B] flex items-center justify-center">
              <AlertCircle className="w-8 h-8" />
            </div>
            <h1 className="text-xl font-black text-[#3C3C3C]">
              تعذر تحميل بيانات الحساب مؤقتاً
            </h1>
            <p className="text-sm font-bold text-[#777777] leading-relaxed">
              {profileLoadError}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3 w-full pt-2">
              {isProgrammer && (
                <button
                  type="button"
                  onClick={() => setTab('programmer')}
                  className="duo-btn flex items-center gap-2 px-6 py-3 rounded-2xl bg-[#A560E8] hover:bg-[#B477EE] border-2 border-b-4 border-[#8938D6] text-white text-sm font-black cursor-pointer"
                >
                  <Code2 className="w-4 h-4" />
                  <span>فتح لوحة المبرمج</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => void loadUserProfile(firebaseUser)}
                className="duo-btn flex items-center gap-2 px-6 py-3 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-sm font-black cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
                <span>إعادة المحاولة</span>
              </button>
              <button
                type="button"
                onClick={() => void signOut(auth)}
                className="duo-btn flex items-center gap-2 px-5 py-3 rounded-2xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#3C3C3C] text-sm font-black cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
                <span>تبديل الحساب</span>
              </button>
            </div>
          </div>
        </div>
        {autoSwitchNotice && (
          <DuoLoading
            variant="overlay"
            title={autoSwitchNotice.title}
            subtitle={autoSwitchNotice.subtitle}
            detail={autoSwitchNotice.detail}
            percent={autoSwitchNotice.percent}
            accent={autoSwitchNotice.backupProjectId ? 'purple' : 'blue'}
          />
        )}
      </>
    );
  }

  if (!firebaseUser || !profile) {
    return (
      <AppErrorBoundary>
        {consolidatedNoticeProject && (
          <div className="bg-[#D7FFB8] border-b-2 border-[#58CC02] px-4 py-3">
            <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-between gap-3 text-[#46A302] text-xs sm:text-sm font-black">
              <div className="flex items-center gap-2">
                <Database className="w-5 h-5 shrink-0" />
                <span>
                  تم تحديث المنصة وتوحيد جلستك تلقائياً لتعمل مع الجميع بسلاسة!
                </span>
              </div>
              <button
                type="button"
                onClick={() => setConsolidatedNoticeProject(null)}
                className="p-1 rounded-lg hover:bg-white/60 cursor-pointer"
                title="إخفاء"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
        {firebaseUser && needsInteractiveSync && (
          <div className="bg-[#F0F9FF] border-b-2 border-[#1CB0F6] px-4 py-3">
            <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[#1899D6] text-xs sm:text-sm font-black">
                <Database className="w-5 h-5 shrink-0" />
                <span>
                  أهلاً بك! يمكنك استيراد حسابك واختباراتك السابقة بضغطة واحدة.
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleInteractivePersonalSync()}
                className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-b-4 border-[#1899D6] text-white text-xs font-black cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
                <span>استيراد حسابي واختباراتي الآن</span>
              </button>
            </div>
          </div>
        )}
        <AuthGate
          firebaseUser={firebaseUser}
          profile={profile}
          onProfileSaved={(saved) => {
            setProfileLoadError(null);
            setProfile(saved);
            if (firebaseUser) {
              void loadUserProfile(firebaseUser);
            }
          }}
          onQuotaDetected={() => {
            void checkBackupAnnouncementSignal();
          }}
        />
        {personalSyncProgress && (
          <DuoLoading
            variant="overlay"
            title={personalSyncProgress.message}
            subtitle={personalSyncProgress.detail || 'يرجى الانتظار لحين اكتمال المزامنة...'}
            percent={personalSyncProgress.percent}
            accent="purple"
          />
        )}
        {autoSwitchNotice && (
          <DuoLoading
            variant="overlay"
            title={autoSwitchNotice.title}
            subtitle={autoSwitchNotice.subtitle}
            detail={autoSwitchNotice.detail}
            percent={autoSwitchNotice.percent}
            accent={autoSwitchNotice.backupProjectId ? 'purple' : 'blue'}
          />
        )}
      </AppErrorBoundary>
    );
  }

  return (
    <AppErrorBoundary>
      <div className="min-h-screen bg-[#FFFFFF] flex flex-col overflow-x-hidden">
        {/* Clean 3-Zone Duolingo Top Navigation Bar */}
        <header className="border-b-2 border-[#E5E5E5] bg-white sticky top-0 z-30">
          <div className="max-w-7xl mx-auto px-3 sm:px-6 h-14 sm:h-16 flex items-center justify-between gap-2 sm:gap-6 md:gap-8">
            {/* Zone 1: Brand Wordmark */}
            <button
              type="button"
              onClick={() => {
                if (!activeRoomId) setTab('home');
              }}
              className="flex items-center gap-1.5 sm:gap-2.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <DuoOwlEmblem className="w-7 h-7 sm:w-8 sm:h-8" />
              <span className="font-latin text-lg sm:text-2xl font-black tracking-tight text-[#58CC02]">
                DuoBoard
              </span>
            </button>

            {/* Zone 2: Navigation Links */}
            {!activeRoomId ? (
              <nav className="flex items-center gap-3 sm:gap-6 text-xs sm:text-sm font-black overflow-x-auto no-scrollbar">
                <button
                  type="button"
                  onClick={() => setTab('home')}
                  className={`flex items-center gap-1 sm:gap-1.5 py-2 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    tab === 'home'
                      ? 'border-[#58CC02] text-[#58CC02]'
                      : 'border-transparent text-[#777777] hover:text-[#3C3C3C]'
                  }`}
                >
                  <Home className="w-4 h-4" />
                  <span>الرئيسية</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTab('saved')}
                  className={`flex items-center gap-1 sm:gap-1.5 py-2 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    tab === 'saved'
                      ? 'border-[#1CB0F6] text-[#1899D6]'
                      : 'border-transparent text-[#777777] hover:text-[#3C3C3C]'
                  }`}
                >
                  <Archive className="w-4 h-4" />
                  <span className="sm:hidden">الأرشيف</span>
                  <span className="hidden sm:inline">أرشيف الجلسات</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTab('quizzes')}
                  className={`flex items-center gap-1 sm:gap-1.5 py-2 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    tab === 'quizzes'
                      ? 'border-[#A560E8] text-[#8938D6]'
                      : 'border-transparent text-[#777777] hover:text-[#3C3C3C]'
                  }`}
                >
                  <ListChecks className="w-4 h-4" />
                  <span>اختباراتي</span>
                </button>

                {isProgrammer && (
                  <button
                    type="button"
                    onClick={() => {
                      setTab('programmer');
                      void refreshProgrammerState();
                    }}
                    className={`flex items-center gap-1 sm:gap-1.5 py-2 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      tab === 'programmer'
                        ? 'border-[#FFC800] text-[#9A6B00]'
                        : 'border-transparent text-[#8938D6] hover:text-[#3C3C3C]'
                    }`}
                  >
                    <Code2 className="w-4 h-4" />
                    <span>مبرمج</span>
                  </button>
                )}
              </nav>
            ) : (
              <div className="flex items-center gap-2 text-xs sm:text-sm font-black text-[#3C3C3C] truncate max-w-[140px] sm:max-w-md">
                <span className="truncate">{room?.title ?? 'غرفة الاختبار'}</span>
              </div>
            )}

            {/* Zone 3: Room / Auth Action (Programmer gets mid-exam transfer button inside rooms!) */}
            <div className="flex items-center gap-2 shrink-0">
              {activeRoomId ? (
                <>
                  {isProgrammer && room && (
                    <button
                      type="button"
                      onClick={() => {
                        void refreshProgrammerState();
                        setQuickMigrateOpen(true);
                      }}
                      className="duo-btn flex items-center gap-1.5 px-2.5 sm:px-3.5 py-1.5 sm:py-2 rounded-xl bg-[#A560E8] hover:bg-[#B477EE] border-2 border-b-4 border-[#8938D6] text-white text-[11px] sm:text-xs font-black whitespace-nowrap shrink-0 cursor-pointer"
                      title="نقل الغرفة والاختبار إلى قاعدة أخرى من قواعد البيانات الآن"
                    >
                      <ArrowRightLeft className="w-3.5 h-3.5" />
                      <span>نقل القاعدة</span>
                    </button>
                  )}
                  {isSupervisor && room && (
                    <button
                      type="button"
                      disabled={closingRoomBusy}
                      onClick={() => setShowCloseRoomModal(true)}
                      className="duo-btn flex items-center gap-1.5 px-2.5 sm:px-3.5 py-1.5 sm:py-2 rounded-xl bg-[#FFDFE0] hover:bg-[#FF4B4B] hover:text-white border-2 border-b-4 border-[#FF4B4B] text-[#EA2B2B] text-[11px] sm:text-xs font-black whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60 transition-colors"
                      title="إغلاق الغرفة نهائياً وإخراج الجميع من قاعدة البيانات"
                    >
                      <Power className="w-3.5 h-3.5" />
                      <span className="sm:hidden">إغلاق</span>
                      <span className="hidden sm:inline">إغلاق الغرفة</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleLeaveRoom('home')}
                    className="duo-btn px-2.5 sm:px-4 py-1.5 sm:py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[11px] sm:text-xs font-black text-[#777777] hover:text-[#3C3C3C] whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <span className="sm:hidden">مغادرة</span>
                    <span className="hidden sm:inline">مغادرة الغرفة</span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => void signOut(auth)}
                  className="duo-btn flex items-center gap-1.5 px-2.5 sm:px-4 py-1.5 sm:py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[11px] sm:text-xs font-black text-[#777777] hover:text-[#EA2B2B] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                  <span className="sm:hidden">خروج</span>
                  <span className="hidden sm:inline">تسجيل الخروج</span>
                </button>
              )}
            </div>
          </div>
        </header>

        {/* Live <= 5% Free Quota & -0.5% Step Supervisor Alert Banner */}
        {(quotaAlert ||
          (canReceiveQuotaAlerts &&
            liveQuotaStatus.alertStep !== null &&
            dismissedQuotaStep !== liveQuotaStatus.alertStep)) && (
          <div
            className={`border-b-2 px-3 sm:px-6 py-3 ${
              quotaAlert || (liveQuotaStatus.alertStep !== null && liveQuotaStatus.alertStep <= 2.0)
                ? 'bg-[#FFDFE0] border-[#FF4B4B]'
                : 'bg-[#FFF4CC] border-[#FFC800]'
            }`}
          >
            <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
              <div
                className={`flex items-start gap-2.5 text-xs sm:text-sm font-black ${
                  quotaAlert || (liveQuotaStatus.alertStep !== null && liveQuotaStatus.alertStep <= 2.0)
                    ? 'text-[#EA2B2B]'
                    : 'text-[#9A6B00]'
                }`}
              >
                <BellRing className="w-5 h-5 shrink-0 mt-0.5 animate-bounce" />
                <div className="flex flex-col gap-0.5">
                  <span>
                    {quotaAlert || liveQuotaStatus.exhausted || liveQuotaStatus.alertStep === 0
                      ? 'تنبيه عاجل للمشرف: نفدت الحصة المجانية اليومية للقاعدة (0% متبقي)!'
                      : `تنبيه حرج للمشرف (${liveQuotaStatus.alertStep?.toFixed(1)}% متبقية): لم يبقَ سوى ${liveQuotaStatus.minRemainingPct.toFixed(
                          2
                        )}% من الحصة المجانية في (${activeProjectId})!`}
                  </span>
                  {liveQuotaStatus.alertStep !== null && (
                    <span className="text-[11px] sm:text-xs font-extrabold opacity-90">
                      أقرب مورد للنفاد: {formatQuotaMetricArabic(liveQuotaStatus.bottleneckMetric)} — متبقي{' '}
                      <span className="font-latin">
                        {liveQuotaStatus.bottleneckRemainingCount.toLocaleString('en-US')}
                      </span>{' '}
                      عملية اليوم • إشعار #{Math.max(1, liveQuotaStatus.alertCount)} (يرسل تنبيهاً جديداً تلقائياً عند كل نقص بمقدار 0.5%)
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {typeof Notification !== 'undefined' && Notification.permission === 'default' && (
                  <button
                    type="button"
                    onClick={() => void Notification.requestPermission()}
                    className="duo-btn px-3 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#3C3C3C] text-xs font-black cursor-pointer"
                  >
                    تفعيل إشعارات المتصفح
                  </button>
                )}
                {isProgrammer && room && (
                  <button
                    type="button"
                    onClick={() => setQuickMigrateOpen(true)}
                    className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#A560E8] hover:bg-[#B477EE] border-2 border-b-4 border-[#8938D6] text-white text-xs sm:text-sm font-black cursor-pointer"
                  >
                    <ArrowRightLeft className="w-4 h-4" />
                    <span>نقل سريع لقاعدة أخرى</span>
                  </button>
                )}
                {isProgrammer && !room && (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveRoomId(null);
                      setTab('programmer');
                    }}
                    className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#A560E8] hover:bg-[#B477EE] border-2 border-b-4 border-[#8938D6] text-white text-xs sm:text-sm font-black cursor-pointer"
                  >
                    <Code2 className="w-4 h-4" />
                    <span>إدارة القواعد (مبرمج)</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setQuotaAlert(false);
                    setQuotaToastNotification(null);
                    if (liveQuotaStatus.alertStep !== null) {
                      setDismissedQuotaStep(liveQuotaStatus.alertStep);
                    }
                  }}
                  className="p-1.5 rounded-lg text-[#3C3C3C] hover:bg-white/60 cursor-pointer"
                  title="تم الاستلام (سيتكرر التنبيه عند النقص 0.5% القادم)"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Live Capacity Bar & Percentage Strip (Supervisors & Programmers Only) */}
        {canReceiveQuotaAlerts && tab !== 'programmer' && (
          <div className="bg-[#F8FAFC] border-b border-[#E5E5E5] px-3 sm:px-6 py-2">
            <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-2 font-black text-[#3C3C3C]">
                <Database className="w-4 h-4 text-[#1899D6] shrink-0" />
                <span>سعة القاعدة المجانية:</span>
                <span className="font-latin text-[#1899D6] bg-white px-2 py-0.5 rounded-lg border border-[#E5E5E5]">
                  {liveQuotaStatus.projectId}
                </span>
                <span
                  className={`px-2 py-0.5 rounded-lg border text-[11px] font-black ${
                    liveQuotaStatus.minRemainingPct <= 2
                      ? 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B]'
                      : liveQuotaStatus.minRemainingPct <= 5
                      ? 'bg-[#FFF4CC] border-[#FFC800] text-[#9A6B00]'
                      : 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                  }`}
                >
                  متبقي {liveQuotaStatus.minRemainingPct.toFixed(1)}%
                </span>
                <span className="text-[11px] font-bold text-[#777777]">
                  ({formatQuotaMetricArabic(liveQuotaStatus.bottleneckMetric)} • متبقي{' '}
                  <span className="font-latin text-[#3C3C3C]">
                    {liveQuotaStatus.bottleneckRemainingCount.toLocaleString('en-US')}
                  </span>{' '}
                  اليوم)
                </span>
              </div>

              <div className="flex items-center gap-2.5 sm:w-72 shrink-0">
                <div className="flex-1 h-3 rounded-full bg-[#E5E5E5] overflow-hidden relative border border-[#D0D0D0]">
                  <svg className="w-full h-full block" aria-hidden="true">
                    <rect
                      x="0"
                      y="0"
                      height="100%"
                      width={`${Math.max(0, Math.min(100, liveQuotaStatus.minRemainingPct)).toFixed(2)}%`}
                      className={
                        liveQuotaStatus.minRemainingPct <= 2
                          ? 'fill-[#FF4B4B]'
                          : liveQuotaStatus.minRemainingPct <= 5
                          ? 'fill-[#FFC800]'
                          : 'fill-[#58CC02]'
                      }
                    />
                    <rect x="4.5%" y="0" width="1%" height="100%" className="fill-[#EA2B2B]/80" />
                  </svg>
                </div>
                <span dir="ltr" className="font-latin text-[11px] font-black text-[#3C3C3C] w-14 text-right">
                  {liveQuotaStatus.minRemainingPct.toFixed(1)}%
                </span>
              </div>
            </div>
          </div>
        )}

        {consolidatedNoticeProject && !activeRoomId && (
          <div className="bg-[#D7FFB8] border-b-2 border-[#58CC02] px-3 sm:px-6 py-3">
            <div className="max-w-7xl mx-auto flex items-center justify-between gap-3 text-xs sm:text-sm font-black text-[#46A302]">
              <div className="flex items-center gap-2">
                <Database className="w-5 h-5 shrink-0" />
                <span>
                  تم تحديث المنصة وتوحيد جلستك تلقائياً لتعمل مع الجميع في مكان واحد!
                </span>
              </div>
              <button
                type="button"
                onClick={() => setConsolidatedNoticeProject(null)}
                className="p-1.5 rounded-lg hover:bg-white/60 cursor-pointer"
                title="إخفاء"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Auto-import Personal Data Banner when user arrives on a switched DB with unsynced source DBs */}
        {needsInteractiveSync && !activeRoomId && (
          <div className="bg-[#F0F9FF] border-b-2 border-[#1CB0F6] px-3 sm:px-6 py-3">
            <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[#1899D6] text-xs sm:text-sm font-black">
                <Database className="w-5 h-5 shrink-0" />
                <span>
                  يمكنك استيراد اختباراتك المحفوظة ونماذج «اختباراتي» من جلستك السابقة بضغطة واحدة.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleInteractivePersonalSync()}
                  className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-b-4 border-[#1899D6] text-white text-xs sm:text-sm font-black cursor-pointer"
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>استيراد بياناتي واختباراتي الآن</span>
                </button>
                <button
                  type="button"
                  onClick={() => setNeedsInteractiveSync(false)}
                  className="p-1.5 rounded-lg text-[#1899D6] hover:bg-white/70 cursor-pointer"
                  title="إخفاء"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {syncSuccessNotice && !activeRoomId && (
          <div className="bg-[#D7FFB8] border-b-2 border-[#58CC02] px-3 sm:px-6 py-2.5">
            <div className="max-w-7xl mx-auto flex items-center justify-between gap-3 text-xs sm:text-sm font-black text-[#46A302]">
              <span>✅ {syncSuccessNotice}</span>
              <button
                type="button"
                onClick={() => setSyncSuccessNotice(null)}
                className="p-1 rounded-lg hover:bg-white/50 cursor-pointer"
                title="إغلاق"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Pending Student Rejoin Banner if student opened switched DB before supervisor arrived */}
        {pendingRoomNotice && !activeRoomId && (
          <div className="bg-[#FFF4CC] border-b-2 border-[#FFC800] px-3 sm:px-6 py-3">
            <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs sm:text-sm font-black text-[#3C3C3C]">
                بانتظار دخول المشرف لاستكمال الغرفة{' '}
                <span className="font-latin text-[#1899D6]">{pendingRoomNotice}</span>...
              </p>
              <button
                type="button"
                onClick={() => void loadUserProfile(firebaseUser)}
                className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#1CB0F6] border-2 border-b-4 border-[#1899D6] text-white text-xs font-black cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>تحقق وادخل الغرفة الآن</span>
              </button>
            </div>
          </div>
        )}

        {roomClosedNotice && !activeRoomId && (
          <div className="bg-[#FFF4CC] border-b-2 border-[#FFC800] px-3 sm:px-6 py-2.5">
            <div className="max-w-7xl mx-auto flex items-center justify-between gap-3 text-xs sm:text-sm font-black text-[#9A6B00]">
              <div className="flex items-center gap-2">
                <Power className="w-4 h-4 shrink-0" />
                <span>{roomClosedNotice}</span>
              </div>
              <button
                type="button"
                onClick={() => setRoomClosedNotice(null)}
                className="p-1 rounded-lg hover:bg-white/50 cursor-pointer"
                title="إخفاء"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Main Content */}
        <main className="flex-1">
          {activeRoomId ? (
            !room ? (
              <div className="max-w-3xl mx-auto px-4 py-12">
                <DuoLoading
                  variant="card"
                  title="جاري الاتصال بالغرفة..."
                  subtitle="يتم الآن مزامنة الأسئلة والشرائح والصبورات مباشرة"
                  accent="blue"
                />
              </div>
            ) : room.status === 'waiting' ? (
              <WaitingRoom
                room={room}
                profile={profile}
                participants={participants}
                isSupervisor={isSupervisor}
                onLeaveRoom={() => handleLeaveRoom('home')}
                onCloseRoom={handleCloseActiveRoom}
                closingRoom={closingRoomBusy}
              />
            ) : room.status === 'active' ? (
              room.sessionType === 'interactive' ? (
                <InteractiveArena
                  room={room}
                  profile={profile}
                  participants={participants}
                  isSupervisor={isSupervisor}
                />
              ) : (
                <QuizArena
                  room={room}
                  profile={profile}
                  participants={participants}
                  isSupervisor={isSupervisor}
                />
              )
            ) : (
              <TestResultsView
                profile={profile}
                liveRoom={room}
                liveParticipants={participants}
                isSupervisor={isSupervisor}
                onBack={() => handleLeaveRoom('saved')}
                onCloseRoom={() => setShowCloseRoomModal(true)}
                closingRoom={closingRoomBusy}
              />
            )
          ) : tab === 'programmer' && isProgrammer ? (
            programmerLoading && !programmerState ? (
              <div className="max-w-3xl mx-auto px-4 py-12">
                <DuoLoading
                  variant="card"
                  title="جاري تحميل لوحة المبرمج..."
                  subtitle="يتم جلب قائمة قواعد البيانات المرتبة وصلاحيات المبرمجين"
                  accent="purple"
                />
              </div>
            ) : programmerState ? (
              <ProgrammerDashboard
                firebaseUser={firebaseUser}
                profile={profile}
                currentRoom={room}
                isSupervisorInCurrentRoom={isSupervisor}
                isMaster={isMasterProgrammer}
                backendMode={programmerMode}
                poolState={programmerState}
                onPoolStateUpdated={(next) => {
                  programmerReqSeqRef.current += 1;
                  setProgrammerState(next);
                }}
                onRefreshState={() =>
                  refreshProgrammerState(firebaseUser, profile.fullNameQuad)
                }
              />
            ) : (
              <div className="max-w-xl mx-auto px-4 py-12 text-center">
                <div className="duo-card p-6 flex flex-col items-center gap-4">
                  <AlertCircle className="w-10 h-10 text-[#EA2B2B]" />
                  <p className="text-sm font-black text-[#3C3C3C]">
                    تعذر الاتصال بخادم إدارة القواعد حالياً. تأكد من تشغيل الخادم ثم أعد المحاولة.
                  </p>
                  {programmerError && (
                    <p className="text-xs font-bold text-[#777777] dir-ltr break-words max-w-full">
                      {programmerError}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => void refreshProgrammerState(firebaseUser, profile.fullNameQuad)}
                    className="duo-btn px-5 py-2.5 rounded-xl bg-[#A560E8] border-2 border-b-4 border-[#8938D6] text-white text-sm font-black cursor-pointer"
                  >
                    إعادة المحاولة
                  </button>
                </div>
              </div>
            )
          ) : tab === 'home' ? (
            <RoleHub
              profile={profile}
              onProfileUpdated={(next) => setProfile(next)}
              onEnterRoom={(roomId) => handleEnterRoom(roomId)}
            />
          ) : tab === 'quizzes' ? (
            <MyQuizzesView profile={profile} />
          ) : (
            <SavedTestsView profile={profile} />
          )}
        </main>
      </div>
      {isProgrammer && room && (
        <QuickMigrateModal
          open={quickMigrateOpen}
          onClose={() => setQuickMigrateOpen(false)}
          firebaseUser={firebaseUser}
          profile={profile}
          currentRoom={room}
          isSupervisorInCurrentRoom={isSupervisor}
          poolState={programmerState}
          onOpenFullDashboard={() => {
            setQuickMigrateOpen(false);
            setActiveRoomId(null);
            setTab('programmer');
          }}
        />
      )}
      {autoSwitchNotice && (
        <DuoLoading
          variant="overlay"
          title={autoSwitchNotice.title}
          subtitle={autoSwitchNotice.subtitle}
          detail={autoSwitchNotice.detail}
          percent={autoSwitchNotice.percent}
          accent={autoSwitchNotice.backupProjectId ? 'purple' : 'blue'}
        />
      )}
      {showCloseRoomModal && isSupervisor && room && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="duo-card max-w-md w-full p-6 flex flex-col gap-4 text-center">
            <div className="w-12 h-12 rounded-2xl bg-[#FFDFE0] text-[#EA2B2B] flex items-center justify-center mx-auto">
              <Power className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-black text-[#3C3C3C]">
              إغلاق الغرفة نهائياً وإخراج الجميع؟
            </h3>
            <p className="text-sm font-bold text-[#777777] leading-relaxed">
              سيتم إخراج جميع الطلاب والمشاركين من الغرفة <span className="font-latin text-[#3C3C3C]">({room.id})</span> فوراً، وإغلاق الغرفة وحذفها نهائياً من قاعدة البيانات.
            </p>
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                disabled={closingRoomBusy}
                onClick={() => setShowCloseRoomModal(false)}
                className="duo-btn flex-1 py-3 rounded-2xl bg-white border-2 border-b-4 border-[#E5E5E5] text-sm font-black text-[#3C3C3C] cursor-pointer"
              >
                تراجع
              </button>
              <button
                type="button"
                disabled={closingRoomBusy}
                onClick={() => void handleCloseActiveRoom()}
                className="duo-btn flex-1 py-3 rounded-2xl bg-[#FF4B4B] border-2 border-b-4 border-[#EA2B2B] text-sm font-black text-white cursor-pointer disabled:opacity-60"
              >
                {closingRoomBusy ? 'جاري الإغلاق...' : 'تأكيد إغلاق الغرفة'}
              </button>
            </div>
          </div>
        </div>
      )}
      {canReceiveQuotaAlerts && quotaToastNotification && (
        <div
          className="fixed bottom-4 left-4 z-50 max-w-sm w-[calc(100vw-2rem)]"
          role="alert"
          aria-live="assertive"
        >
          <div
            className={`duo-card p-4 border-2 shadow-xl flex flex-col gap-2.5 ${
              quotaToastNotification.step <= 2.0
                ? 'bg-[#FFDFE0] border-[#FF4B4B]'
                : 'bg-[#FFF4CC] border-[#FFC800]'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div
                className={`flex items-start gap-2 ${
                  quotaToastNotification.step <= 2.0 ? 'text-[#EA2B2B]' : 'text-[#9A6B00]'
                }`}
              >
                <BellRing className="w-5 h-5 shrink-0 mt-0.5 animate-bounce" />
                <div>
                  <p className="text-xs sm:text-sm font-black leading-snug">
                    {quotaToastNotification.step <= 0
                      ? 'تنبيه للمشرف: نفدت الحصة المجانية للقاعدة (0% متبقية)!'
                      : `إشعار للمشرف #${quotaToastNotification.alertCount}: بقي ${quotaToastNotification.minRemainingPct.toFixed(
                          2
                        )}% فقط (عتبة ${quotaToastNotification.step.toFixed(1)}%)`}
                  </p>
                  <p className="text-[11px] font-extrabold opacity-90 mt-0.5">
                    {quotaToastNotification.metricLabel} — متبقي{' '}
                    <span className="font-latin">
                      {quotaToastNotification.remainingCount.toLocaleString('en-US')}
                    </span>{' '}
                    عملية اليوم في <span className="font-latin">{activeProjectId}</span>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setQuotaToastNotification(null)}
                className="p-1 rounded-lg text-[#3C3C3C] hover:bg-white/60 cursor-pointer shrink-0"
                title="إغلاق هذا الإشعار (سيصلك تنبيه جديد عند النقص 0.5% القادم)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1 border-t border-black/10">
              <span className="text-[10px] font-extrabold text-[#3C3C3C]/80">
                ينبّه تلقائياً كل نقص بمقدار 0.5%
              </span>
              {isProgrammer && (
                <button
                  type="button"
                  onClick={() => {
                    setQuotaToastNotification(null);
                    if (room) {
                      setQuickMigrateOpen(true);
                    } else {
                      setTab('programmer');
                    }
                  }}
                  className="duo-btn px-3 py-1.5 rounded-xl bg-[#A560E8] border-2 border-b-4 border-[#8938D6] text-white text-[11px] font-black cursor-pointer"
                >
                  {room ? 'نقل القاعدة الآن' : 'فتح إدارة القواعد'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {personalSyncProgress && (
        <DuoLoading
          variant="overlay"
          title={personalSyncProgress.message}
          subtitle={personalSyncProgress.detail || 'يرجى الانتظار لحين اكتمال المزامنة...'}
          percent={personalSyncProgress.percent}
          accent="purple"
        />
      )}
    </AppErrorBoundary>
  );
}
