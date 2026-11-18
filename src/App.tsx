import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import {
  AlertCircle,
  Archive,
  Code2,
  Database,
  Home,
  ListChecks,
  LogOut,
  RefreshCw,
  Wrench,
  X,
} from 'lucide-react';
import {
  activateCustomFirebaseConfig,
  activeFirebaseConfig,
  activeProjectId,
  auth,
  buildCleanPrimaryUrl,
  clearPendingRejoinRoom,
  consumeConsolidatedProjectNotice,
  CURRENT_DB_EPOCH,
  db,
  defaultFirebaseConfig,
  firebaseTargetKey,
  getInitialServerPlatformStatus,
  getPendingRejoinRoom,
  getPreviousFirebaseConfigs,
  getTimestampMillis,
  googleProvider,
  handleFirestoreError,
  isCustomFirebaseConfig,
  isMasterProgrammerIdentity,
  isQuadNameValid,
  isSameFirebaseTarget,
  justConsolidatedFrom,
  OperationType,
  resetToDefaultFirebaseConfig,
  sanitizeFirebaseConfig,
  subscribeQuotaError,
  type FirebaseAppConfig,
  type ServerPlatformPointer,
} from './firebase';
import {
  fetchProgrammerSession,
  restoreActiveSupervisorRoomFromSnapshot,
  syncPersonalAccountFromPreviousDbs,
  triggerAutomaticQuotaFailover,
  type MigrationProgress,
  type PlatformMigrationPointer,
} from './firebaseMigration';
import {
  loadSessionSnapshot,
  mergeActiveRoomSnapshot,
  saveSessionSnapshot,
  type StoredRoomSnapshot,
  type StoredUserProfileSnapshot,
} from './localDraftStore';
import type {
  Participant,
  PlatformProgrammerState,
  Room,
  UserProfile,
} from './types';
import { AuthGate } from './components/AuthGate';
import { RoleHub } from './components/RoleHub';
import { WaitingRoom } from './components/WaitingRoom';
import { QuizArena } from './components/QuizArena';
import { InteractiveArena } from './components/InteractiveArena';
import { TestResultsView } from './components/TestResultsView';
import { SavedTestsView } from './components/SavedTestsView';
import { MyQuizzesView } from './components/MyQuizzesView';
import { ProgrammerDashboard } from './components/ProgrammerDashboard';
import { DuoOwlEmblem } from './components/DuoIcons';
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
  const [allExhausted, setAllExhausted] = useState<boolean>(
    () => getInitialServerPlatformStatus().allExhausted
  );
  const [isProgrammer, setIsProgrammer] = useState<boolean>(false);
  const [isMasterProgrammer, setIsMasterProgrammer] = useState<boolean>(false);
  const [programmerState, setProgrammerState] =
    useState<PlatformProgrammerState | null>(null);
  const [programmerLoading, setProgrammerLoading] = useState<boolean>(false);
  const [programmerError, setProgrammerError] = useState<string | null>(null);
  const [pendingRoomNotice, setPendingRoomNotice] = useState<string | null>(null);
  const [autoSwitchNotice, setAutoSwitchNotice] = useState<string | null>(null);
  const [personalSyncProgress, setPersonalSyncProgress] =
    useState<MigrationProgress | null>(null);
  const [needsInteractiveSync, setNeedsInteractiveSync] = useState<boolean>(false);
  const [syncSuccessNotice, setSyncSuccessNotice] = useState<string | null>(null);
  const [consolidatedNoticeProject, setConsolidatedNoticeProject] = useState<
    string | null
  >(() => (justConsolidatedFrom ? null : consumeConsolidatedProjectNotice()));

  useEffect(() => {
    if (!justConsolidatedFrom) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (cancelled) return;
      try {
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
  const firebaseUserRef = useRef(firebaseUser);
  firebaseUserRef.current = firebaseUser;
  const switchingInProgressRef = useRef(false);
  const failoverInProgressRef = useRef(false);

  const applyRemotePlatformPointer = useCallback(
    (incoming: {
      config: FirebaseAppConfig;
      resetToDefault?: boolean;
      migratedRoomId?: string | null;
      previousConfigs?: FirebaseAppConfig[];
      revision?: string | number;
    }) => {
      if (justConsolidatedFrom || switchingInProgressRef.current) return;
      const ptrCfg = sanitizeFirebaseConfig(incoming.config);
      if (!ptrCfg) return;

      const targetKey = firebaseTargetKey(ptrCfg);
      const wantsDefault =
        Boolean(incoming.resetToDefault) || isSameFirebaseTarget(ptrCfg, defaultFirebaseConfig);

      // Already on requested DB
      if (wantsDefault && !isCustomFirebaseConfig) return;
      if (!wantsDefault && isSameFirebaseTarget(ptrCfg, activeFirebaseConfig)) return;

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
      setAutoSwitchNotice(wantsDefault ? defaultFirebaseConfig.projectId : ptrCfg.projectId);

      const currentUserPresent = Boolean(firebaseUserRef.current);
      const currentRoomPresent = activeRoomIdRef.current;
      const roomToKeep = wantsDefault
        ? null
        : currentRoomPresent ||
          (currentUserPresent && incoming.migratedRoomId ? incoming.migratedRoomId : null);

      window.setTimeout(async () => {
        try {
          await signOut(auth);
        } catch {
          // Ignore signOut errors on detached DB
        }

        if (wantsDefault) {
          resetToDefaultFirebaseConfig();
          window.location.replace(buildCleanPrimaryUrl());
          return;
        }

        activateCustomFirebaseConfig(
          ptrCfg,
          roomToKeep,
          Array.isArray(incoming.previousConfigs) ? incoming.previousConfigs : []
        );
        const url = new URL(window.location.href);
        url.searchParams.delete('fb');
        if (roomToKeep) {
          url.searchParams.set('room', roomToKeep);
        } else {
          url.searchParams.delete('room');
        }
        window.location.replace(url.toString());
      }, 450);
    },
    []
  );

  const triggerAutoFailover = useCallback(async () => {
    if (failoverInProgressRef.current || switchingInProgressRef.current) return;
    failoverInProgressRef.current = true;
    try {
      const res = await triggerAutomaticQuotaFailover({
        failedProjectId: activeFirebaseConfig.projectId,
        failedFirestoreDatabaseId: activeFirebaseConfig.firestoreDatabaseId,
      });
      if (!res) return;
      if (res.allExhausted) {
        setAllExhausted(true);
        return;
      }
      setAllExhausted(false);
      if (res.pointer?.config) {
        applyRemotePlatformPointer({
          config: res.pointer.config,
          resetToDefault: res.pointer.resetToDefault,
          migratedRoomId: res.pointer.migratedRoomId,
          previousConfigs: res.pointer.previousConfigs,
          revision: res.pointer.revision || res.pointer.updatedAt || Date.now(),
        });
      }
    } finally {
      window.setTimeout(() => {
        failoverInProgressRef.current = false;
      }, 4000);
    }
  }, [applyRemotePlatformPointer]);

  useEffect(() => {
    return subscribeQuotaError(() => {
      setQuotaAlert(true);
      void triggerAutoFailover();
    });
  }, [triggerAutoFailover]);

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

      setProgrammerLoading(true);
      setProgrammerError(null);
      try {
        const res = await fetchProgrammerSession(targetUser, candidateName);
        setIsProgrammer(res.isProgrammer || quickMaster);
        setIsMasterProgrammer(res.isMaster || quickMaster);
        if (res.state) {
          setProgrammerState(res.state);
          setAllExhausted(Boolean(res.state.allExhausted));
        }
      } catch (err) {
        const msg =
          err instanceof Error && err.message
            ? err.message
            : 'تعذر الاتصال بخادم إدارة القواعد حالياً.';
        setProgrammerError(msg);
      } finally {
        setProgrammerLoading(false);
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

  // Watch real-time server SSE stream + focus/poll so ALL open devices switch immediately (pre-login or active)
  useEffect(() => {
    if (justConsolidatedFrom) return;
    let disposed = false;
    let es: EventSource | null = null;

    const handleServerPayload = (
      ptr: ServerPlatformPointer | null | undefined,
      payloadAllExhausted?: boolean
    ) => {
      if (disposed) return;
      const exhaustedNow = Boolean(payloadAllExhausted ?? ptr?.allExhausted);
      setAllExhausted(exhaustedNow);
      if (exhaustedNow) return;
      if (!ptr || !ptr.config) return;
      applyRemotePlatformPointer({
        config: ptr.config,
        resetToDefault: ptr.resetToDefault,
        migratedRoomId: ptr.migratedRoomId,
        previousConfigs: ptr.previousConfigs,
        revision: ptr.revision || ptr.updatedAt || ptr.migrationEpoch || CURRENT_DB_EPOCH,
      });
    };

    const checkServerPointer = async () => {
      if (disposed) return;
      try {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 2500);
        const resp = await fetch(`/api/platform-db?t=${Date.now()}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        window.clearTimeout(timer);
        if (!resp.ok) return;
        const data = (await resp.json()) as {
          pointer?: ServerPlatformPointer | null;
          allExhausted?: boolean;
        };
        handleServerPayload(data?.pointer, data?.allExhausted);
      } catch {
        // Static hosting or temporary offline — handled gracefully
      }
    };

    try {
      es = new EventSource('/api/platform-db/stream');
      es.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as {
            type?: string;
            pointer?: ServerPlatformPointer | null;
            allExhausted?: boolean;
          };
          handleServerPayload(msg?.pointer, msg?.allExhausted);
        } catch {
          // Ignore malformed SSE payload
        }
      };
      es.onerror = () => {
        // Browser auto-reconnects; fallback poll also active
      };
    } catch {
      // EventSource unsupported or static host
    }

    const onVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        void checkServerPointer();
      }
    };
    window.addEventListener('focus', onVisibilityOrFocus);
    document.addEventListener('visibilitychange', onVisibilityOrFocus);
    const pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void checkServerPointer();
      }
    }, 4_500);

    return () => {
      disposed = true;
      es?.close();
      window.removeEventListener('focus', onVisibilityOrFocus);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
      window.clearInterval(pollTimer);
    };
  }, [applyRemotePlatformPointer]);

  // Also watch Firestore platform/migration pointer as static-host fallback (both pre-login and post-login)
  useEffect(() => {
    if (justConsolidatedFrom) return;
    const unsub = onSnapshot(
      doc(db, 'platform', 'migration'),
      (snap) => {
        if (!snap.exists()) return;
        const ptr = snap.data() as PlatformMigrationPointer;
        if (ptr.migrationEpoch && ptr.migrationEpoch !== CURRENT_DB_EPOCH) return;
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
        // Silent fallback when unauthenticated on older rules or quota-limited DB
      }
    );
    return () => unsub();
  }, [applyRemotePlatformPointer, firebaseUser?.uid, firebaseUser?.emailVerified]);

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

  const handleEnterRoom = (roomId: string) => {
    setActiveRoomId(roomId);
    setPendingRoomNotice(null);
    clearPendingRejoinRoom();
    if (firebaseUser) {
      persistActiveRoom(firebaseUser.uid, roomId);
    }
  };

  const handleLeaveRoom = (nextTab: 'home' | 'saved' | 'quizzes' = 'home') => {
    setActiveRoomId(null);
    setTab(nextTab);
    if (firebaseUser) {
      persistActiveRoom(firebaseUser.uid, null);
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
        try {
          const syncRes = await syncPersonalAccountFromPreviousDbs({
            targetUser: user,
            interactiveAuthIfNeeded: false,
            onProgress: (p) => setPersonalSyncProgress(p),
          });
          setNeedsInteractiveSync(syncRes.needsInteractiveSignIn);
          if (syncRes.synced && syncRes.count > 0) {
            setSyncSuccessNotice(
              `تم استيراد ${syncRes.count} عنصر من بياناتك واختباراتك تلقائياً إلى القاعدة الجديدة!`
            );
          }
          if (!resolvedProfile) {
            const refreshedSnap = await getDoc(profileRef);
            if (refreshedSnap.exists()) {
              resolvedProfile = refreshedSnap.data() as UserProfile;
            }
          }
        } catch {
          // Non-fatal; fallback below
        } finally {
          setPersonalSyncProgress(null);
        }
      }

      if (!resolvedProfile && (isCustomFirebaseConfig || getPendingRejoinRoom())) {
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
              if (rData.supervisorId === user.uid) {
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
                } else if (pendingRoom && rData.status !== 'finished') {
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
        void triggerAutoFailover();
        setProfileLoadError(
          'تم الوصول للحد اليومي للقاعدة الحالية — جاري التبديل تلقائياً لقاعدة بديلة...'
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

  // Auth listener & room session restore on refresh
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (!user) {
        setProfile(null);
        setProfileLoadError(null);
        setActiveRoomId(null);
        setRoom(null);
        setParticipants([]);
        setAuthReady(true);
        return;
      }

      await loadUserProfile(user);
    });
    return () => unsub();
  }, []);

  // Room & Participants real-time listeners
  useEffect(() => {
    if (!activeRoomId || !firebaseUser) {
      setRoom(null);
      setParticipants([]);
      return;
    }

    const rPath = `rooms/${activeRoomId}`;
    const unsubRoom = onSnapshot(
      doc(db, 'rooms', activeRoomId),
      (snap) => {
        if (snap.exists()) {
          setRoom(snap.data() as Room);
        } else {
          setRoom(null);
          setActiveRoomId(null);
          persistActiveRoom(firebaseUser.uid, null);
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, rPath);
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
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, pPath);
      }
    );

    return () => {
      unsubRoom();
      unsubParts();
    };
  }, [activeRoomId, firebaseUser]);

  // Mirror current room & participants into IndexedDB snapshot (covers WaitingRoom as well)
  useEffect(() => {
    if (!room || !profile) return;
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

  const handleMaintenanceProgrammerEntry = async () => {
    if (firebaseUser) {
      await refreshProgrammerState(firebaseUser, profile?.fullNameQuad || firebaseUser.displayName);
      setTab('programmer');
      return;
    }
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      await refreshProgrammerState(cred.user, cred.user.displayName);
      setTab('programmer');
    } catch {
      // User dismissed popup
    }
  };

  // Show maintenance screen when ALL databases in the programmer pool hit Quota,
  // unless a verified programmer enters the Programmer Console to add/reactivate DBs
  if (allExhausted && !(isProgrammer && tab === 'programmer')) {
    return (
      <AppErrorBoundary>
        <div className="min-h-screen bg-[#FFFFFF] flex flex-col items-center justify-center p-4 sm:p-6">
          <div className="duo-card max-w-lg w-full p-7 sm:p-9 text-center flex flex-col items-center gap-5 border-[#FFC800] bg-gradient-to-b from-[#FFFDF5] to-white">
            <div className="w-16 h-16 rounded-2xl bg-[#FFF4CC] border-2 border-[#FFC800] text-[#E5A400] flex items-center justify-center">
              <Wrench className="w-9 h-9 animate-pulse" />
            </div>
            <DuoOwlEmblem className="w-14 h-14 -mt-2" />
            <div className="flex flex-col gap-2">
              <h1 className="text-2xl sm:text-3xl font-black text-[#3C3C3C]">
                جاري إصلاح مشاكل البرنامج
              </h1>
              <p className="text-sm font-bold text-[#777777] leading-relaxed">
                يعمل الفريق التقني حالياً على صيانة الخوادم وقواعد البيانات لضمان أفضل تجربة للجميع. سيعود البرنامج للعمل تلقائياً فور الانتهاء.
              </p>
            </div>

            <div className="w-full h-3 rounded-full bg-[#F0F0F0] overflow-hidden border border-[#E5E5E5]">
              <div className="h-full w-2/3 bg-gradient-to-l from-[#FFC800] to-[#58CC02] rounded-full animate-pulse" />
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3 w-full">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="duo-btn flex items-center gap-2 px-6 py-3 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-sm font-black cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
                <span>تحديث والتحقق الآن</span>
              </button>
              {isProgrammer && (
                <button
                  type="button"
                  onClick={() => setTab('programmer')}
                  className="duo-btn flex items-center gap-2 px-5 py-3 rounded-2xl bg-[#A560E8] hover:bg-[#B477EE] border-2 border-b-4 border-[#8938D6] text-white text-sm font-black cursor-pointer"
                >
                  <Code2 className="w-4 h-4" />
                  <span>فتح لوحة المبرمج</span>
                </button>
              )}
            </div>

            {!isProgrammer && (
              <button
                type="button"
                onClick={() => void handleMaintenanceProgrammerEntry()}
                className="text-xs font-extrabold text-[#AFAFAF] hover:text-[#8938D6] transition-colors cursor-pointer pt-1"
              >
                دخول المبرمج للصيانة
              </button>
            )}
          </div>
        </div>
        {autoSwitchNotice && (
          <DuoLoading
            variant="overlay"
            title="عادت المنصة للعمل!"
            subtitle="جاري تجهيز الاتصال الجديد وإدخالك تلقائياً..."
            percent={100}
            accent="green"
          />
        )}
      </AppErrorBoundary>
    );
  }

  // Emergency direct view into Programmer Console if all DBs were exhausted OR profile Firestore failed
  if (isProgrammer && tab === 'programmer' && firebaseUser && (!profile || allExhausted)) {
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
                {!allExhausted && (
                  <button
                    type="button"
                    onClick={() => setTab('home')}
                    className="duo-btn px-3.5 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer"
                  >
                    العودة
                  </button>
                )}
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
                poolState={programmerState}
                onPoolStateUpdated={(next) => {
                  setProgrammerState(next);
                  setAllExhausted(Boolean(next.allExhausted));
                }}
                onRefreshState={() =>
                  refreshProgrammerState(firebaseUser, profile?.fullNameQuad || firebaseUser.displayName)
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
                        profile?.fullNameQuad || firebaseUser.displayName
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
            title="جاري التحديث والتبديل التلقائي..."
            subtitle="تم نقل الجلسة إلى قاعدة بيانات جديدة لاستكمال العمل بدون انقطاع"
            percent={100}
            accent="blue"
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
            void triggerAutoFailover();
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
            title="جاري التحديث والتبديل التلقائي..."
            subtitle="تم تحويل الجلسة للقاعدة المعتمدة لتسجيل الدخول ومتابعة العمل"
            percent={100}
            accent="blue"
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

            {/* Zone 3: Room / Auth Action (No database badges visible to regular users!) */}
            <div className="flex items-center gap-2 shrink-0">
              {activeRoomId ? (
                <button
                  type="button"
                  onClick={() => handleLeaveRoom('home')}
                  className="duo-btn px-2.5 sm:px-4 py-1.5 sm:py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[11px] sm:text-xs font-black text-[#777777] hover:text-[#3C3C3C] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <span className="sm:hidden">مغادرة</span>
                  <span className="hidden sm:inline">مغادرة الغرفة</span>
                </button>
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

        {/* Global Quota Auto-Failover Banner */}
        {quotaAlert && (
          <div className="bg-[#FFF4CC] border-b-2 border-[#FFC800] px-3 sm:px-6 py-3">
            <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-[#9A6B00] text-xs sm:text-sm font-black">
                <RefreshCw className="w-5 h-5 shrink-0 animate-spin" />
                <span>
                  وصل الضغط الحالي للحد اليومي — جاري التبديل تلقائياً لقاعدة بيانات احتياطية لاستكمال العمل دون توقف...
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {isProgrammer && (
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
                  onClick={() => setQuotaAlert(false)}
                  className="p-1.5 rounded-lg text-[#9A6B00] hover:bg-white/60 cursor-pointer"
                  title="إخفاء التنبيه"
                >
                  <X className="w-4 h-4" />
                </button>
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
                poolState={programmerState}
                onPoolStateUpdated={(next) => {
                  setProgrammerState(next);
                  setAllExhausted(Boolean(next.allExhausted));
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
      {autoSwitchNotice && (
        <DuoLoading
          variant="overlay"
          title="جاري التحديث والتبديل التلقائي..."
          subtitle="تم اعتماد قاعدة بيانات جديدة لتسجيل الدخول واستكمال العمل بدون انقطاع"
          percent={100}
          accent="blue"
        />
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
