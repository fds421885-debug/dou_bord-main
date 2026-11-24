import React, { useState } from 'react';
import { doc, serverTimestamp, updateDoc } from '../firestoreTracked';
import { Copy, Check, Users, Play, Clock, Power } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { Participant, Room, UserProfile } from '../types';
import { DUO_IMAGES, DuoArtwork, playDuoSound } from './DuoIcons';
import { DuoLoading } from './DuoLoading';
import { RoomQuizSyncBanner } from './RoomQuizBank';
import { MathText } from '../mathText';

interface WaitingRoomProps {
  room: Room;
  profile: UserProfile;
  participants: Participant[];
  isSupervisor: boolean;
  onLeaveRoom: () => void;
  onCloseRoom?: () => Promise<void>;
  closingRoom?: boolean;
}

export const WaitingRoom: React.FC<WaitingRoomProps> = ({
  room,
  profile,
  participants,
  isSupervisor,
  onLeaveRoom,
  onCloseRoom,
  closingRoom = false,
}) => {
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(room.id);
      setCopied(true);
      playDuoSound('pop');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Fallback ignored if clipboard blocked
    }
  };

  const handleStartSession = async () => {
    if (!isSupervisor || starting) return;
    setStarting(true);
    const path = `rooms/${room.id}`;
    try {
      await updateDoc(doc(db, 'rooms', room.id), {
        status: 'active',
        updatedAt: serverTimestamp(),
      });
      playDuoSound('correct');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    } finally {
      setStarting(false);
    }
  };

  const sessionLabel =
    room.sessionType === 'interactive'
      ? room.mode === 'competition'
        ? 'وضع تفاعلي — منافسة مباشرة 🏆'
        : 'وضع تفاعلي — PDF وصور ومنافسة'
      : 'وضع اختبار';

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-6 py-5 sm:py-8 flex flex-col gap-5 sm:gap-6">
      {/* Header Card with Room Code */}
      <div className="duo-card p-4 sm:p-8 flex flex-col md:flex-row items-center justify-between gap-5 sm:gap-6">
        <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-5 text-center sm:text-right">
          <DuoArtwork
            src={isSupervisor ? DUO_IMAGES.supervisor : DUO_IMAGES.student}
            alt="أيقونة غرفة الانتظار"
            className="w-20 h-20 sm:w-24 sm:h-24 shrink-0"
          />
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
              <span className="text-xs font-extrabold text-[#58CC02]">
                {isSupervisor ? 'غرفة انتظار المشرف' : 'غرفة انتظار الطالب'}
              </span>
              <span
                className={`px-2.5 py-0.5 rounded-lg text-[11px] font-black border ${
                  room.sessionType === 'interactive'
                    ? room.mode === 'competition'
                      ? 'bg-[#FFF4CC] border-[#FFC800] text-[#9A6B00]'
                      : 'bg-[#DDF4FF] border-[#1CB0F6] text-[#1899D6]'
                    : 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                }`}
              >
                {sessionLabel}
              </span>
            </div>
            <h1 className="text-xl sm:text-3xl font-black text-[#3C3C3C] leading-relaxed">
              <MathText text={room.title} inline />
            </h1>
            <p className="text-sm font-bold text-[#777777]">
              المشرف: <span className="text-[#3C3C3C]">{room.supervisorName}</span>
            </p>
          </div>
        </div>

        {/* Room Code Box */}
        <div className="flex flex-col items-center gap-2 bg-[#F7F7F7] border-2 border-[#E5E5E5] rounded-2xl px-5 py-3.5 sm:px-6 sm:py-4 w-full sm:w-auto sm:min-w-[230px]">
          <span className="text-xs font-extrabold text-[#777777]">رمز الغرفة</span>
          <div className="flex items-center gap-3">
            <span
              dir="ltr"
              className="font-latin text-3xl font-black tracking-[0.18em] text-[#1CB0F6]"
            >
              {room.id}
            </span>
            <button
              type="button"
              onClick={handleCopyCode}
              title="نسخ الرمز"
              className="duo-btn p-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#3C3C3C] hover:bg-[#DDF4FF] hover:text-[#1899D6] cursor-pointer"
            >
              {copied ? <Check className="w-4 h-4 text-[#58CC02]" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
          {copied && (
            <span className="text-xs font-extrabold text-[#46A302]">تم نسخ الرمز</span>
          )}
        </div>
      </div>

      {/* Auto-sync & In-Room Quiz Bank */}
      <RoomQuizSyncBanner
        roomId={room.id}
        profile={profile}
        isSupervisor={isSupervisor}
        compact
      />

      {/* Joined Students List */}
      <div className="duo-card p-6 sm:p-8 flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b-2 border-[#F0F0F0]">
          <div className="flex items-center gap-2.5">
            <Users className="w-6 h-6 text-[#1CB0F6]" />
            <h2 className="text-xl font-black text-[#3C3C3C]">الطلاب المنضمون الآن</h2>
          </div>
          <span className="font-latin text-base font-black text-[#58CC02]">
            {participants.length} طالب
          </span>
        </div>

        {participants.length === 0 ? (
          <div className="py-12 flex flex-col items-center justify-center text-center gap-3">
            <Clock className="w-10 h-10 text-[#AFAFAF]" />
            <p className="text-base font-black text-[#3C3C3C]">
              بانتظار دخول الطلاب باستخدام رمز الغرفة
            </p>
            <p className="text-sm font-bold text-[#777777]">
              أعطِ الرمز <span className="font-latin text-[#1CB0F6] font-black">{room.id}</span> للطلاب ليظهروا هنا فوراً
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {participants.map((p, idx) => (
              <div
                key={p.uid}
                className="flex items-center gap-3 p-3.5 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5]"
              >
                <div className="w-10 h-10 rounded-xl bg-[#D7FFB8] border-2 border-[#58CC02] flex items-center justify-center font-latin font-black text-[#46A302] shrink-0">
                  {idx + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-black text-[#3C3C3C] truncate">
                    {p.fullNameQuad}
                  </p>
                  <p className="text-xs font-bold text-[#58CC02]">جاهز في الانتظار</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Action Footer */}
        <div className="pt-4 border-t-2 border-[#F0F0F0] flex flex-col sm:flex-row items-center justify-between gap-3 sm:gap-4">
          <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto">
            <button
              type="button"
              onClick={onLeaveRoom}
              className="duo-btn flex-1 sm:flex-initial px-5 py-3 rounded-2xl bg-white border-2 border-b-4 border-[#E5E5E5] text-sm font-extrabold text-[#777777] hover:text-[#3C3C3C] cursor-pointer whitespace-nowrap"
            >
              {isSupervisor ? 'خروج مؤقت من الغرفة' : 'الخروج من الغرفة'}
            </button>

            {isSupervisor && onCloseRoom && (
              <button
                type="button"
                disabled={closingRoom || starting}
                onClick={() => setShowCloseConfirm(true)}
                className="duo-btn flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-4 py-3 rounded-2xl bg-[#FFDFE0] hover:bg-[#FF4B4B] hover:text-white border-2 border-b-4 border-[#FF4B4B] text-sm font-black text-[#EA2B2B] cursor-pointer disabled:opacity-60 whitespace-nowrap transition-colors"
              >
                <Power className="w-4 h-4" />
                <span>إغلاق الغرفة نهائياً</span>
              </button>
            )}
          </div>

          {isSupervisor ? (
            <button
              type="button"
              disabled={starting || closingRoom}
              onClick={handleStartSession}
              className="duo-btn w-full sm:w-auto flex items-center justify-center gap-2.5 px-6 sm:px-8 py-4 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-[#46A302] border-b-[5px] text-white text-base sm:text-lg font-black cursor-pointer disabled:opacity-60 whitespace-nowrap"
            >
              <Play className="w-5 h-5 fill-current" />
              <span>
                {starting
                  ? 'جاري فتح الغرفة للجميع...'
                  : room.mode === 'competition'
                  ? 'تم — الانتقال لإعداد المنافسة'
                  : 'تم — فتح السبورة بالتزامن للجميع'}
              </span>
            </button>
          ) : (
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-2xl bg-[#DDF4FF] border-2 border-[#1CB0F6] text-[#1899D6] text-sm font-black">
              <Clock className="w-5 h-5 shrink-0" />
              <span>بانتظار ضغط المشرف على «تم» لبدء الجلسة للجميع</span>
            </div>
          )}
        </div>
      </div>

      {showCloseConfirm && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="duo-card max-w-md w-full p-6 flex flex-col gap-4 text-center">
            <h3 className="text-xl font-black text-[#3C3C3C]">
              إغلاق الغرفة نهائياً؟
            </h3>
            <p className="text-sm font-bold text-[#777777]">
              سيتم إخراج جميع الطلاب المتواجدين في غرفة الانتظار فوراً وإغلاق الغرفة وحذفها من قاعدة البيانات.
            </p>
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                disabled={closingRoom}
                onClick={() => setShowCloseConfirm(false)}
                className="duo-btn flex-1 py-3 rounded-2xl bg-white border-2 border-b-4 border-[#E5E5E5] text-sm font-black text-[#3C3C3C] cursor-pointer"
              >
                تراجع
              </button>
              <button
                type="button"
                disabled={closingRoom}
                onClick={async () => {
                  if (!onCloseRoom) return;
                  await onCloseRoom();
                  setShowCloseConfirm(false);
                }}
                className="duo-btn flex-1 py-3 rounded-2xl bg-[#FF4B4B] border-2 border-b-4 border-[#EA2B2B] text-sm font-black text-white cursor-pointer disabled:opacity-60"
              >
                {closingRoom ? 'جاري الإغلاق...' : 'تأكيد الإغلاق'}
              </button>
            </div>
          </div>
        </div>
      )}

      {starting && (
        <DuoLoading
          variant="overlay"
          title={
            room.mode === 'competition'
              ? 'جاري فتح ساحة المنافسة للجميع...'
              : 'جاري فتح السبورة وتشغيل الجلسة للجميع...'
          }
          subtitle="سيتم نقل جميع الطلاب المتصلين فوراً بالتزامن"
          accent="green"
        />
      )}
    </div>
  );
};

