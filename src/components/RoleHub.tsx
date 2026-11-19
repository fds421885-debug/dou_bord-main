import React, { useEffect, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from '../firestoreTracked';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ClipboardCheck,
  Copy,
  Edit3,
  FileText,
  LogIn,
  PlusCircle,
  Power,
  Radio,
  Trophy,
  X,
} from 'lucide-react';
import {
  db,
  generateRoomCode,
  getTimestampMillis,
  handleFirestoreError,
  isQuadNameValid,
  OperationType,
} from '../firebase';
import type { Room, SessionType, UserProfile } from '../types';
import { closeRoomInDatabase } from '../roomLifecycle';
import { DUO_IMAGES, DuoArtwork, playDuoSound } from './DuoIcons';
import { DuoLoading } from './DuoLoading';

interface RoleHubProps {
  profile: UserProfile;
  onProfileUpdated: (next: UserProfile) => void;
  onEnterRoom: (roomId: string, role: 'supervisor' | 'student') => void;
}

export const RoleHub: React.FC<RoleHubProps> = ({
  profile,
  onProfileUpdated,
  onEnterRoom,
}) => {
  const [sessionTitle, setSessionTitle] = useState('جلسة السبورة التفاعلية');
  const [sessionType, setSessionType] = useState<SessionType>('quiz');
  const [interactiveSubMode, setInteractiveSubMode] = useState<'slides' | 'competition'>('slides');
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [studentNameConfirm, setStudentNameConfirm] = useState(profile.fullNameQuad);
  const [busyRole, setBusyRole] = useState<'supervisor' | 'student' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [editingName, setEditingName] = useState(false);
  const [editedName, setEditedName] = useState(profile.fullNameQuad);
  const [savingName, setSavingName] = useState(false);

  // Supervisor's open rooms (waiting or active) persisted in Firestore across exits/reloads
  const [openRooms, setOpenRooms] = useState<Room[]>([]);
  const [copiedRoomId, setCopiedRoomId] = useState<string | null>(null);
  const [confirmCloseRoomId, setConfirmCloseRoomId] = useState<string | null>(null);
  const [closingRoomId, setClosingRoomId] = useState<string | null>(null);
  const [closedRoomNotice, setClosedRoomNotice] = useState<string | null>(null);

  useEffect(() => {
    const rPath = 'rooms';
    const q = query(
      collection(db, 'rooms'),
      where('supervisorId', '==', profile.uid)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: Room[] = [];
        snap.forEach((d) => {
          const r = d.data() as Room;
          if (r.status === 'waiting' || r.status === 'active') {
            list.push(r);
          }
        });
        list.sort(
          (a, b) =>
            getTimestampMillis(b.updatedAt || b.createdAt) -
            getTimestampMillis(a.updatedAt || a.createdAt)
        );
        setOpenRooms(list);
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, rPath);
      }
    );
    return () => unsub();
  }, [profile.uid]);

  const handleCopyRoomCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedRoomId(code);
      playDuoSound('pop');
      setTimeout(() => {
        setCopiedRoomId((cur) => (cur === code ? null : cur));
      }, 1600);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleCloseOpenRoom = async (roomId: string) => {
    if (closingRoomId) return;
    setClosingRoomId(roomId);
    setErrorMsg(null);
    setClosedRoomNotice(null);
    try {
      await closeRoomInDatabase(roomId);
      setOpenRooms((prev) => prev.filter((r) => r.id !== roomId));
      setConfirmCloseRoomId(null);
      setClosedRoomNotice(`تم إغلاق الغرفة (${roomId}) وإخراج جميع المشاركين وإغلاقها في قاعدة البيانات.`);
      playDuoSound('pop');
    } catch (err) {
      setErrorMsg('تعذر إغلاق الغرفة بالكامل، يرجى المحاولة مرة أخرى.');
      handleFirestoreError(err, OperationType.DELETE, `rooms/${roomId}`);
    } finally {
      setClosingRoomId(null);
    }
  };

  const handleSaveName = async () => {
    const cleaned = editedName.trim().replace(/\s+/g, ' ');
    if (!isQuadNameValid(cleaned)) {
      setErrorMsg('يرجى كتابة الاسم الرباعي من 4 كلمات على الأقل');
      return;
    }
    setSavingName(true);
    setErrorMsg(null);
    const path = `users/${profile.uid}/private/profile`;
    try {
      await updateDoc(doc(db, 'users', profile.uid, 'private', 'profile'), {
        fullNameQuad: cleaned,
        updatedAt: serverTimestamp(),
      });
      onProfileUpdated({ ...profile, fullNameQuad: cleaned });
      setStudentNameConfirm(cleaned);
      setEditingName(false);
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    } finally {
      setSavingName(false);
    }
  };

  const handleCreateSupervisorRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setBusyRole('supervisor');
    const title = sessionTitle.trim() || 'جلسة السبورة التفاعلية';

    try {
      let code = generateRoomCode();
      // Ensure room code is unused
      for (let attempt = 0; attempt < 4; attempt++) {
        const snap = await getDoc(doc(db, 'rooms', code));
        if (!snap.exists()) break;
        code = generateRoomCode();
      }

      const path = `rooms/${code}`;
      try {
        await setDoc(doc(db, 'rooms', code), {
          id: code,
          title: title.slice(0, 120),
          supervisorId: profile.uid,
          supervisorName: profile.fullNameQuad,
          status: 'waiting',
          sessionType,
          mode: sessionType === 'interactive' && interactiveSubMode === 'competition' ? 'competition' : 'quiz',
          explainPresenterId: profile.uid,
          explainPresenterName: profile.fullNameQuad,
          interactiveEditor: 'supervisor',
          interactiveEditorName: profile.fullNameQuad,
          currentSlideIndex: 0,
          slideCount: 0,
          currentQuestionId: '',
          questionCount: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }

      playDuoSound('join');
      onEnterRoom(code, 'supervisor');
    } catch (err) {
      setErrorMsg('تعذر إنشاء الغرفة، يرجى المحاولة مرة أخرى');
      console.error(err);
    } finally {
      setBusyRole(null);
    }
  };

  const handleJoinAsStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const code = roomCodeInput.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (code.length < 4 || code.length > 16) {
      setErrorMsg('يرجى إدخال رمز الغرفة الصحيح (6 أحرف أو أرقام)');
      return;
    }

    const cleanedName = studentNameConfirm.trim().replace(/\s+/g, ' ');
    if (!isQuadNameValid(cleanedName)) {
      setErrorMsg('يرجى كتابة اسمك الرباعي كاملاً (4 كلمات على الأقل) قبل الدخول');
      return;
    }

    setBusyRole('student');
    try {
      const roomRef = doc(db, 'rooms', code);
      let roomSnap;
      try {
        roomSnap = await getDoc(roomRef);
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, `rooms/${code}`);
      }

      if (!roomSnap || !roomSnap.exists()) {
        setErrorMsg('لم يتم العثور على غرفة بهذا الرمز، تأكد من الرمز من المشرف');
        setBusyRole(null);
        return;
      }

      const roomData = roomSnap.data();
      if (roomData.status === 'finished') {
        setErrorMsg('تم إغلاق هذه الغرفة وانتهى الاختبار فيها بالفعل');
        setBusyRole(null);
        return;
      }

      if (roomData.supervisorId === profile.uid) {
        onEnterRoom(code, 'supervisor');
        return;
      }

      // Update saved profile name if user refined their quad name
      if (cleanedName !== profile.fullNameQuad) {
        await updateDoc(doc(db, 'users', profile.uid, 'private', 'profile'), {
          fullNameQuad: cleanedName,
          updatedAt: serverTimestamp(),
        });
        onProfileUpdated({ ...profile, fullNameQuad: cleanedName });
      }

      const participantRef = doc(db, 'rooms', code, 'participants', profile.uid);
      let existingPart;
      try {
        existingPart = await getDoc(participantRef);
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, `rooms/${code}/participants/${profile.uid}`);
      }

      if (!existingPart || !existingPart.exists()) {
        try {
          await setDoc(participantRef, {
            uid: profile.uid,
            roomId: code,
            fullNameQuad: cleanedName,
            score: 0,
            correctCount: 0,
            joinedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `rooms/${code}/participants/${profile.uid}`);
        }
      }

      playDuoSound('join');
      onEnterRoom(code, 'student');
    } catch (err) {
      setErrorMsg('حدث خطأ أثناء الانضمام للغرفة');
      console.error(err);
    } finally {
      setBusyRole(null);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-6 py-5 sm:py-8 flex flex-col gap-5 sm:gap-8">
      {/* Greeting & Quad Name Bar */}
      <div className="duo-card p-4 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 bg-[#F7F7F7]">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-extrabold text-[#777777]">مرحباً بك في منصة السبورة التفاعلية</span>
          {editingName ? (
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <input
                type="text"
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                className="px-3 py-1.5 rounded-xl bg-white border-2 border-[#1CB0F6] text-base font-extrabold text-[#3C3C3C] outline-none w-full sm:w-auto sm:min-w-[240px]"
              />
              <button
                type="button"
                disabled={savingName}
                onClick={handleSaveName}
                className="duo-btn p-2 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white cursor-pointer"
                title="حفظ"
              >
                <Check className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingName(false);
                  setEditedName(profile.fullNameQuad);
                }}
                className="duo-btn p-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#777777] cursor-pointer"
                title="إلغاء"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <h1 className="text-xl sm:text-2xl font-black text-[#3C3C3C]">
                {profile.fullNameQuad}
              </h1>
              <button
                type="button"
                onClick={() => setEditingName(true)}
                className="text-xs font-extrabold text-[#1CB0F6] hover:underline flex items-center gap-1 cursor-pointer whitespace-nowrap"
              >
                <Edit3 className="w-3.5 h-3.5" />
                <span>تعديل الاسم</span>
              </button>
            </div>
          )}
        </div>
        <div className="text-xs font-bold text-[#777777]">
          اختر دورك لإنشاء غرفة جديدة أو الانضمام برمز الغرفة
        </div>
      </div>

      {errorMsg && (
        <div className="flex items-center gap-3 p-4 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-[#EA2B2B] text-sm font-extrabold">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {closedRoomNotice && (
        <div className="flex items-center justify-between gap-3 p-4 rounded-2xl bg-[#D7FFB8] border-2 border-[#58CC02] text-[#46A302] text-sm font-extrabold">
          <div className="flex items-center gap-2">
            <Check className="w-5 h-5 shrink-0" />
            <span>{closedRoomNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => setClosedRoomNotice(null)}
            className="p-1 rounded-lg hover:bg-white/60 cursor-pointer"
            title="إخفاء"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Supervisor Open Rooms — Stay Open After Leaving or Refreshing */}
      {openRooms.length > 0 && (
        <div className="duo-card p-4 sm:p-6 border-[#58CC02] bg-[#D7FFB8]/30 flex flex-col gap-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-[#58CC02] text-white flex items-center justify-center shrink-0">
                <Radio className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-base sm:text-lg font-black text-[#3C3C3C]">
                  غرفك المفتوحة حالياً ({openRooms.length})
                </h2>
                <p className="text-xs font-bold text-[#777777]">
                  تبقى الغرفة مفتوحة حتى لو خرجت أو حدّثت الصفحة — اضغط دخول للعودة إليها فوراً
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            {openRooms.map((r) => {
              const isInteractive = r.sessionType === 'interactive';
              const isConfirmingClose = confirmCloseRoomId === r.id;
              return (
                <div
                  key={r.id}
                  className="rounded-2xl bg-white border-2 border-[#E5E5E5] p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="flex flex-col gap-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`px-2.5 py-0.5 rounded-lg text-[11px] font-black border ${
                          r.status === 'active'
                            ? 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                            : 'bg-[#FFF4CC] border-[#FFC800] text-[#9A6B00]'
                        }`}
                      >
                        {r.status === 'active' ? 'السبورة مفتوحة الآن' : 'في غرفة الانتظار'}
                      </span>
                      <span
                        className={`px-2.5 py-0.5 rounded-lg text-[11px] font-black border ${
                          isInteractive
                            ? 'bg-[#DDF4FF] border-[#1CB0F6] text-[#1899D6]'
                            : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#3C3C3C]'
                        }`}
                      >
                        {isInteractive ? 'وضع تفاعلي' : 'وضع اختبار'}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleCopyRoomCode(r.id)}
                        className="flex items-center gap-1 px-2.5 py-0.5 rounded-lg bg-[#F7F7F7] hover:bg-[#DDF4FF] border border-[#E5E5E5] text-xs font-black text-[#1899D6] cursor-pointer"
                        title="نسخ رمز الغرفة"
                      >
                        <span className="font-latin tracking-wider">{r.id}</span>
                        {copiedRoomId === r.id ? (
                          <Check className="w-3 h-3 text-[#58CC02]" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                    <h3 className="text-sm sm:text-base font-black text-[#3C3C3C] truncate">
                      {r.title}
                    </h3>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {isConfirmingClose ? (
                      <>
                        <button
                          type="button"
                          disabled={closingRoomId === r.id}
                          onClick={() => void handleCloseOpenRoom(r.id)}
                          className="duo-btn px-3 py-2 rounded-xl bg-[#FF4B4B] border-2 border-b-3 border-[#EA2B2B] text-white text-xs font-black cursor-pointer disabled:opacity-60"
                        >
                          {closingRoomId === r.id ? 'جاري الإغلاق...' : 'تأكيد إغلاق الغرفة'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmCloseRoomId(null)}
                          className="duo-btn px-3 py-2 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#777777] cursor-pointer"
                        >
                          إلغاء
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => setConfirmCloseRoomId(r.id)}
                          className="duo-btn flex items-center gap-1 px-3 py-2.5 rounded-xl bg-white hover:bg-[#FFDFE0] border-2 border-b-4 border-[#E5E5E5] text-xs font-black text-[#EA2B2B] cursor-pointer"
                          title="إغلاق الغرفة نهائياً"
                        >
                          <Power className="w-3.5 h-3.5" />
                          <span>إغلاق</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            playDuoSound('join');
                            onEnterRoom(r.id, 'supervisor');
                          }}
                          className="duo-btn flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-xs sm:text-sm font-black cursor-pointer"
                        >
                          <LogIn className="w-4 h-4" />
                          <span>دخول للغرفة</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Two Main Role Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
        {/* Supervisor Card */}
        <form
          onSubmit={handleCreateSupervisorRoom}
          className="duo-card p-6 sm:p-8 flex flex-col justify-between gap-6"
        >
          <div className="flex flex-col items-center text-center gap-3 sm:gap-4">
            <DuoArtwork
              src={DUO_IMAGES.supervisor}
              alt="شخصية المشرف"
              className="w-24 h-24 sm:w-32 sm:h-32"
            />
            <div>
              <h2 className="text-2xl font-black text-[#3C3C3C] mb-1">دخول كمشرف</h2>
              <p className="text-sm font-bold text-[#777777]">
                أنشئ غرفة اختبار، شارك رمز الغرفة مع الطلاب، وأدر الأسئلة والسبورات بالتزامن.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            {/* Session Type Picker: Quiz vs Interactive */}
            <div className="flex flex-col gap-2">
              <span className="text-xs font-extrabold text-[#3C3C3C]">
                اختر نوع الجلسة
              </span>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setSessionType('quiz');
                    playDuoSound('pop');
                  }}
                  className={`duo-btn flex flex-col items-center text-center gap-1.5 p-3 rounded-2xl border-2 border-b-4 transition-colors cursor-pointer ${
                    sessionType === 'quiz'
                      ? 'bg-[#D7FFB8] border-[#58CC02] text-[#3C3C3C]'
                      : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#777777] hover:bg-white'
                  }`}
                >
                  <ClipboardCheck
                    className={`w-6 h-6 ${
                      sessionType === 'quiz' ? 'text-[#46A302]' : 'text-[#AFAFAF]'
                    }`}
                  />
                  <span className="text-sm font-black">اختبار</span>
                  <span className="text-[11px] font-bold leading-snug">
                    أسئلة وسبورات وتقييم وإجابات
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setSessionType('interactive');
                    playDuoSound('pop');
                  }}
                  className={`duo-btn flex flex-col items-center text-center gap-1.5 p-3 rounded-2xl border-2 border-b-4 transition-colors cursor-pointer ${
                    sessionType === 'interactive'
                      ? 'bg-[#DDF4FF] border-[#1CB0F6] text-[#3C3C3C]'
                      : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#777777] hover:bg-white'
                  }`}
                >
                  <FileText
                    className={`w-6 h-6 ${
                      sessionType === 'interactive' ? 'text-[#1899D6]' : 'text-[#AFAFAF]'
                    }`}
                  />
                  <span className="text-sm font-black">تفاعلي</span>
                  <span className="text-[11px] font-bold leading-snug">
                    PDF وصور بالتزامن أو وضع المنافسة 🏆
                  </span>
                </button>
              </div>
            </div>

            {sessionType === 'interactive' && (
              <div className="flex flex-col gap-1.5 rounded-2xl bg-[#F0F9FF] border-2 border-[#BAE6FD] p-3">
                <span className="text-xs font-extrabold text-[#1899D6]">
                  الوضع الافتراضي داخل التفاعلي (يمكنك التبديل بينهما بالداخل):
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setInteractiveSubMode('slides');
                      playDuoSound('pop');
                    }}
                    className={`duo-btn flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border-2 text-xs font-black cursor-pointer ${
                      interactiveSubMode === 'slides'
                        ? 'bg-[#1CB0F6] border-[#1899D6] text-white'
                        : 'bg-white border-[#E5E5E5] text-[#3C3C3C]'
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>PDF / صور</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInteractiveSubMode('competition');
                      playDuoSound('pop');
                    }}
                    className={`duo-btn flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border-2 text-xs font-black cursor-pointer ${
                      interactiveSubMode === 'competition'
                        ? 'bg-[#FFC800] border-[#E5A400] text-[#3C3C3C]'
                        : 'bg-white border-[#E5E5E5] text-[#3C3C3C]'
                    }`}
                  >
                    <Trophy className="w-3.5 h-3.5" />
                    <span>وضع المنافسة 🏆</span>
                  </button>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="session-title-input"
                className="text-xs font-extrabold text-[#3C3C3C]"
              >
                {sessionType === 'interactive'
                  ? interactiveSubMode === 'competition'
                    ? 'عنوان غرفة المنافسة التفاعلية'
                    : 'عنوان الجلسة التفاعلية'
                  : 'عنوان الجلسة أو الاختبار'}
              </label>
              <input
                id="session-title-input"
                type="text"
                maxLength={100}
                value={sessionTitle}
                onChange={(e) => setSessionTitle(e.target.value)}
                placeholder={
                  sessionType === 'interactive'
                    ? interactiveSubMode === 'competition'
                      ? 'مثال: منافسة الرياضيات السريعة'
                      : 'مثال: شرح وحل ملزمة الرياضيات PDF'
                    : 'مثال: اختبار الرياضيات — المعادلات'
                }
                className="w-full px-4 py-3 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#58CC02] focus:bg-white outline-none text-sm font-bold text-[#3C3C3C]"
              />
            </div>

            <button
              type="submit"
              disabled={busyRole !== null}
              className={`duo-btn w-full flex items-center justify-center gap-2.5 px-6 py-4 rounded-2xl border-2 border-b-[5px] text-white text-base font-black cursor-pointer disabled:opacity-60 ${
                sessionType === 'interactive'
                  ? 'bg-[#1CB0F6] hover:bg-[#33BCFF] border-[#1899D6]'
                  : 'bg-[#58CC02] hover:bg-[#61E002] border-[#46A302]'
              }`}
            >
              <PlusCircle className="w-5 h-5" />
              <span>
                {busyRole === 'supervisor'
                  ? 'جاري فتح غرفة الانتظار...'
                  : sessionType === 'interactive'
                  ? 'فتح غرفة انتظار (وضع تفاعلي)'
                  : 'فتح غرفة انتظار (وضع اختبار)'}
              </span>
            </button>
          </div>
        </form>

        {/* Student Card */}
        <form
          onSubmit={handleJoinAsStudent}
          className="duo-card p-6 sm:p-8 flex flex-col justify-between gap-6"
        >
          <div className="flex flex-col items-center text-center gap-3 sm:gap-4">
            <DuoArtwork
              src={DUO_IMAGES.student}
              alt="شخصية الطالب"
              className="w-24 h-24 sm:w-32 sm:h-32"
            />
            <div>
              <h2 className="text-2xl font-black text-[#3C3C3C] mb-1">دخول كطالب</h2>
              <p className="text-sm font-bold text-[#777777]">
                أدخل اسمك الرباعي ورمز الغرفة الذي يعطيك إياه المشرف للدخول إلى غرفة الانتظار مباشرة.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="student-quad-confirm"
                className="text-xs font-extrabold text-[#3C3C3C]"
              >
                اسمك الرباعي داخل الغرفة
              </label>
              <input
                id="student-quad-confirm"
                type="text"
                required
                value={studentNameConfirm}
                onChange={(e) => setStudentNameConfirm(e.target.value)}
                placeholder="الاسم الرباعي"
                className="w-full px-4 py-3 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#1CB0F6] focus:bg-white outline-none text-sm font-bold text-[#3C3C3C]"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="room-code-input"
                className="text-xs font-extrabold text-[#3C3C3C]"
              >
                رمز الغرفة
              </label>
              <input
                id="room-code-input"
                type="text"
                required
                dir="ltr"
                value={roomCodeInput}
                onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                placeholder="مثال: K7M4P9"
                maxLength={12}
                className="font-latin w-full px-4 py-3 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#1CB0F6] focus:bg-white outline-none text-lg font-black tracking-[0.2em] text-center text-[#3C3C3C] uppercase"
              />
            </div>

            <button
              type="submit"
              disabled={busyRole !== null}
              className="duo-btn w-full flex items-center justify-center gap-2.5 px-6 py-4 rounded-2xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-[#1899D6] border-b-[5px] text-white text-base font-black cursor-pointer disabled:opacity-60"
            >
              <span>
                {busyRole === 'student' ? 'جاري الدخول...' : 'دخول إلى الغرفة'}
              </span>
              <ArrowLeft className="w-5 h-5" />
            </button>
          </div>
        </form>
      </div>

      {busyRole && (
        <DuoLoading
          variant="overlay"
          title={
            busyRole === 'supervisor'
              ? 'جاري إنشاء الغرفة وتجهيز السبورة...'
              : 'جاري الاتصال بالغرفة وتسجيل دخولك...'
          }
          subtitle={
            busyRole === 'supervisor'
              ? 'يتم إعداد رمز الغرفة وغرفة الانتظار في قاعدة البيانات'
              : 'يتم التحقق من الغرفة ومزامنة جلستك المباشرة'
          }
          accent={busyRole === 'supervisor' ? 'green' : 'blue'}
        />
      )}
    </div>
  );
};
