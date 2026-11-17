import React, { Component, useEffect, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
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
  Database,
  Home,
  ListChecks,
  LogOut,
  RefreshCw,
  X,
} from 'lucide-react';
import {
  activeProjectId,
  auth,
  clearPendingRejoinRoom,
  db,
  getPendingRejoinRoom,
  getTimestampMillis,
  handleFirestoreError,
  isCustomFirebaseConfig,
  isQuadNameValid,
  OperationType,
  subscribeQuotaError,
  UPGRADE_FIRESTORE_URL,
} from './firebase';
import {
  loadSessionSnapshot,
  mergeActiveRoomSnapshot,
  saveSessionSnapshot,
  type StoredUserProfileSnapshot,
} from './localDraftStore';
import type { Participant, Room, UserProfile } from './types';
import { AuthGate } from './components/AuthGate';
import { RoleHub } from './components/RoleHub';
import { WaitingRoom } from './components/WaitingRoom';
import { QuizArena } from './components/QuizArena';
import { InteractiveArena } from './components/InteractiveArena';
import { TestResultsView } from './components/TestResultsView';
import { SavedTestsView } from './components/SavedTestsView';
import { MyQuizzesView } from './components/MyQuizzesView';
import { DatabaseMigrationModal } from './components/DatabaseMigrationModal';
import { DuoOwlEmblem } from './components/DuoIcons';

interface ErrorBoundaryState {
  hasError: boolean;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  onOpenMigration?: () => void;
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
              يرجى تحديث الصفحة لإعادة الاتصال بقاعدة البيانات، أو نقل العمل لقاعدة بيانات أخرى إذا وصلت القاعدة الحالية للحد اليومي.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3 w-full">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="duo-btn px-5 py-3 rounded-2xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white font-black cursor-pointer"
              >
                تحديث الصفحة
              </button>
              {this.props.onOpenMigration && (
                <button
                  type="button"
                  onClick={() => {
                    this.setState({ hasError: false });
                    this.props.onOpenMigration?.();
                  }}
                  className="duo-btn flex items-center gap-2 px-5 py-3 rounded-2xl bg-[#1CB0F6] border-2 border-b-4 border-[#1899D6] text-white font-black cursor-pointer"
                >
                  <Database className="w-4 h-4" />
                  <span>انقل لقاعدة بيانات أخرى</span>
                </button>
              )}
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

  const [tab, setTab] = useState<'home' | 'saved' | 'quizzes'>('home');
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [quotaAlert, setQuotaAlert] = useState<boolean>(false);
  const [migrationModalOpen, setMigrationModalOpen] = useState<boolean>(false);
  const [pendingRoomNotice, setPendingRoomNotice] = useState<string | null>(null);

  useEffect(() => {
    return subscribeQuotaError(() => {
      setQuotaAlert(true);
    });
  }, []);

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
      } else if (isCustomFirebaseConfig || getPendingRejoinRoom()) {
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
              setPendingRoomNotice(pendingRoom);
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
        setProfileLoadError(
          'تم تجاوز الحصة اليومية المجانية لقاعدة البيانات (Firestore Quota exceeded). تتجدد الحصة تلقائياً في اليوم التالي، أو يمكنك نقل العمل والبيانات فوراً إلى قاعدة بيانات أخرى.'
        );
      } else if (lower.includes('permission-denied') || lower.includes('permission_denied')) {
        setProfileLoadError(
          'تعذر تحميل بيانات الحساب بسبب صلاحيات قاعدة البيانات. تأكد من تفعيل بريد الحساب أو أعد تسجيل الدخول.'
        );
      } else {
        setProfileLoadError(
          `تعذر الاتصال بقاعدة البيانات لتحميل بيانات حسابك (${raw}).`
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

  if (!authReady || profileLoading) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center gap-4">
        <DuoOwlEmblem className="w-16 h-16 animate-bounce" />
        <p className="text-base font-black text-[#777777]">جاري تجهيز السبورة التفاعلية...</p>
      </div>
    );
  }

  const isSupervisor = Boolean(room && room.supervisorId === profile?.uid);

  const migrationModal = (
    <DatabaseMigrationModal
      open={migrationModalOpen}
      quotaTriggered={quotaAlert}
      currentProfile={profile}
      currentRoom={room}
      isSupervisorInCurrentRoom={isSupervisor}
      onClose={() => setMigrationModalOpen(false)}
    />
  );

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
            {profileLoadError.includes('Firestore Quota') && (
              <a
                href={UPGRADE_FIRESTORE_URL}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-black text-[#1899D6] underline"
              >
                فتح إعدادات قاعدة البيانات والترقية في Firebase Console
              </a>
            )}
            <div className="flex flex-wrap items-center justify-center gap-3 w-full pt-2">
              <button
                type="button"
                onClick={() => setMigrationModalOpen(true)}
                className="duo-btn flex items-center gap-2 px-6 py-3 rounded-2xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-b-4 border-[#1899D6] text-white text-sm font-black cursor-pointer"
              >
                <Database className="w-4 h-4" />
                <span>انقل لقاعدة بيانات أخرى</span>
              </button>
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
        {migrationModal}
      </>
    );
  }

  if (!firebaseUser || !profile) {
    return (
      <AppErrorBoundary onOpenMigration={() => setMigrationModalOpen(true)}>
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
          onOpenMigration={() => setMigrationModalOpen(true)}
        />
        {migrationModal}
      </AppErrorBoundary>
    );
  }

  return (
    <AppErrorBoundary onOpenMigration={() => setMigrationModalOpen(true)}>
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
              <nav className="flex items-center gap-3 sm:gap-6 text-xs sm:text-sm font-black">
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
              </nav>
            ) : (
              <div className="flex items-center gap-2 text-xs sm:text-sm font-black text-[#3C3C3C] truncate max-w-[140px] sm:max-w-md">
                <span className="truncate">{room?.title ?? 'غرفة الاختبار'}</span>
              </div>
            )}

            {/* Zone 3: Primary Action + Database Switcher */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setMigrationModalOpen(true)}
                title={`قاعدة البيانات الحالية: ${activeProjectId}`}
                className={`duo-btn flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-xl border-2 border-b-4 text-[11px] sm:text-xs font-black whitespace-nowrap shrink-0 cursor-pointer ${
                  quotaAlert
                    ? 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B] animate-pulse'
                    : isCustomFirebaseConfig
                    ? 'bg-[#F0F9FF] border-[#1CB0F6] text-[#1899D6]'
                    : 'bg-white border-[#E5E5E5] text-[#777777] hover:text-[#1899D6]'
                }`}
              >
                <Database className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                <span className="hidden md:inline font-latin">{activeProjectId}</span>
                <span className="md:hidden">القاعدة</span>
              </button>

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

        {/* Global Quota Failover Banner whenever any Firestore read/write hits Quota Exceeded */}
        {quotaAlert && (
          <div className="bg-[#FFDFE0] border-b-2 border-[#FF4B4B] px-3 sm:px-6 py-3">
            <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-[#EA2B2B] text-xs sm:text-sm font-black">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <span>
                  وصلت قاعدة البيانات الحالية إلى الحد اليومي المجاني (Quota exceeded). يمكنك نقل الغرفة وبياناتك لقاعدة بيانات أخرى فوراً لاستكمال العمل!
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setMigrationModalOpen(true)}
                  className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-xs sm:text-sm font-black cursor-pointer"
                >
                  <Database className="w-4 h-4" />
                  <span>انقل لقاعدة بيانات أخرى</span>
                </button>
                <button
                  type="button"
                  onClick={() => setQuotaAlert(false)}
                  className="p-1.5 rounded-lg text-[#EA2B2B] hover:bg-white/60 cursor-pointer"
                  title="إخفاء التنبيه"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Pending Student Rejoin Banner if student opened migration link before supervisor completed room transfer */}
        {pendingRoomNotice && !activeRoomId && (
          <div className="bg-[#FFF4CC] border-b-2 border-[#FFC800] px-3 sm:px-6 py-3">
            <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs sm:text-sm font-black text-[#3C3C3C]">
                بانتظار إكمال المشرف لنقل الغرفة{' '}
                <span className="font-latin text-[#1899D6]">{pendingRoomNotice}</span>{' '}
                على قاعدة البيانات الجديدة...
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
              <div className="max-w-3xl mx-auto px-4 py-16 text-center">
                <p className="text-base font-black text-[#777777]">جاري الاتصال بالغرفة...</p>
              </div>
            ) : room.status === 'waiting' ? (
              <WaitingRoom
                room={room}
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
      {migrationModal}
    </AppErrorBoundary>
  );
}
