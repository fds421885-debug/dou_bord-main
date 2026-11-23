import React, { useMemo, useState } from 'react';
import {
  BarChart3,
  Check,
  Clock,
  Crown,
  Loader2,
  Medal,
  MessageCircle,
  RotateCcw,
  Search,
  Sparkles,
  Trophy,
  UserCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import {
  cancelOutgoingFriendRequest,
  makePairId,
  resetLeaderboardEpoch,
  resolveEffectiveLeaderboardUser,
  respondToFriendRequest,
  sendFriendRequest,
  sortLeaderboardUsers,
  type LeaderboardSortKey,
} from '../social';
import type {
  FriendRequestDoc,
  FriendshipDoc,
  LeaderboardUserEntry,
  UserProfile,
} from '../types';
import { playDuoSound } from './DuoIcons';
import {
  LeaderboardUserStatsModal,
  type UserFriendRelation,
} from './LeaderboardUserStatsModal';

interface Props {
  profile: UserProfile;
  isProgrammer: boolean;
  resetEpoch: number;
  rawUsers: LeaderboardUserEntry[];
  loading: boolean;
  friendships: FriendshipDoc[];
  incomingRequests: FriendRequestDoc[];
  outgoingRequests: FriendRequestDoc[];
  onOpenFriendChat: (friendUid: string) => void;
}

function formatArabicDateTime(ms: number): string {
  try {
    return new Intl.DateTimeFormat('ar-SA', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(ms));
  } catch {
    return '';
  }
}

export const LeaderboardView: React.FC<Props> = ({
  profile,
  isProgrammer,
  resetEpoch,
  rawUsers,
  loading,
  friendships,
  incomingRequests,
  outgoingRequests,
  onOpenFriendChat,
}) => {
  const [searchText, setSearchText] = useState('');
  const [sortBy, setSortBy] = useState<LeaderboardSortKey>('correct');
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedUserForStats, setSelectedUserForStats] = useState<{
    entry: LeaderboardUserEntry;
    rank: number;
  } | null>(null);

  const friendPairIds = useMemo(
    () => new Set(friendships.map((f) => f.id)),
    [friendships]
  );

  const pendingIncomingByFromUid = useMemo(() => {
    const map = new Map<string, FriendRequestDoc>();
    for (const r of incomingRequests) {
      if (r.status === 'pending') map.set(r.fromUid, r);
    }
    return map;
  }, [incomingRequests]);

  const pendingOutgoingByToUid = useMemo(() => {
    const map = new Map<string, FriendRequestDoc>();
    for (const r of outgoingRequests) {
      if (r.status === 'pending') map.set(r.toUid, r);
    }
    return map;
  }, [outgoingRequests]);

  const effectiveUsers = useMemo(() => {
    const resolved = rawUsers.map((u) => resolveEffectiveLeaderboardUser(u, resetEpoch));
    return sortLeaderboardUsers(resolved, sortBy);
  }, [rawUsers, resetEpoch, sortBy]);

  const rankByUid = useMemo(() => {
    const map = new Map<string, number>();
    effectiveUsers.forEach((u, i) => map.set(u.uid, i + 1));
    return map;
  }, [effectiveUsers]);

  const filteredUsers = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) return effectiveUsers;
    return effectiveUsers.filter((u) => u.fullNameQuad.toLowerCase().includes(q));
  }, [effectiveUsers, searchText]);

  const myEntry = useMemo(
    () => effectiveUsers.find((u) => u.uid === profile.uid) || null,
    [effectiveUsers, profile.uid]
  );
  const myRank = myEntry ? rankByUid.get(myEntry.uid) || null : null;

  const getRelation = (targetUid: string): UserFriendRelation => {
    if (targetUid === profile.uid) return 'self';
    if (friendPairIds.has(makePairId(profile.uid, targetUid))) return 'friend';
    if (pendingIncomingByFromUid.has(targetUid)) return 'incoming_pending';
    if (pendingOutgoingByToUid.has(targetUid)) return 'outgoing_pending';
    return 'none';
  };

  const showTempNotice = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3500);
  };

  const handleSendFriendRequest = async (target: LeaderboardUserEntry) => {
    if (busyUid) return;
    setBusyUid(target.uid);
    try {
      await sendFriendRequest({
        fromUid: profile.uid,
        fromName: profile.fullNameQuad,
        toUid: target.uid,
        toName: target.fullNameQuad,
      });
      playDuoSound('pop');
      showTempNotice(`تم إرسال طلب صداقة إلى ${target.fullNameQuad}`);
    } catch {
      showTempNotice('تعذر إرسال طلب الصداقة الآن، حاول مرة أخرى.');
    } finally {
      setBusyUid(null);
    }
  };

  const handleCancelRequest = async (target: LeaderboardUserEntry) => {
    if (busyUid) return;
    setBusyUid(target.uid);
    try {
      await cancelOutgoingFriendRequest(profile.uid, target.uid);
      showTempNotice(`تم إلغاء الطلب المرسل إلى ${target.fullNameQuad}`);
    } catch {
      showTempNotice('تعذر إلغاء الطلب الآن.');
    } finally {
      setBusyUid(null);
    }
  };

  const handleRespondIncoming = async (req: FriendRequestDoc, accept: boolean) => {
    if (busyUid) return;
    setBusyUid(req.fromUid);
    try {
      await respondToFriendRequest({
        request: req,
        accept,
        myUid: profile.uid,
        myName: profile.fullNameQuad,
      });
      playDuoSound(accept ? 'correct' : 'pop');
      showTempNotice(
        accept
          ? `أصبح ${req.fromName} صديقاً لك الآن! يمكنك مراسلته من قائمة الأصدقاء.`
          : `تم رفض طلب ${req.fromName}`
      );
    } catch {
      showTempNotice('تعذر تنفيذ الرد على طلب الصداقة.');
    } finally {
      setBusyUid(null);
    }
  };

  const handleConfirmReset = async () => {
    setResetting(true);
    try {
      await resetLeaderboardEpoch(profile.uid, profile.fullNameQuad);
      setConfirmResetOpen(false);
      playDuoSound('correct');
      showTempNotice('تم تصفير لوحة الشرف للجميع بنجاح وبدء احتساب الدورة الجديدة من الصفر!');
    } catch {
      showTempNotice('تعذر تصفير لوحة الشرف — تأكد من تحديث قواعد الأمان.');
    } finally {
      setResetting(false);
    }
  };

  const pendingIncomingList = useMemo(
    () => incomingRequests.filter((r) => r.status === 'pending'),
    [incomingRequests]
  );

  const topThree = searchText.trim() === '' ? filteredUsers.slice(0, 3) : [];

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-6 py-5 sm:py-7 flex flex-col gap-5" dir="rtl">
      {/* Header Banner */}
      <div className="duo-card p-5 sm:p-6 bg-white border-2 border-[#E5E5E5] flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-[#FFC800] border-2 border-b-4 border-[#E5A400] text-white flex items-center justify-center shrink-0">
              <Trophy className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-[#3C3C3C]">
                لوحة الشرف والمنافسة
              </h1>
              <p className="text-xs sm:text-sm font-bold text-[#777777] flex flex-wrap items-center gap-2 mt-0.5">
                <span className="inline-flex items-center gap-1">
                  <Users className="w-3.5 h-3.5 text-[#1CB0F6]" />
                  <span>{effectiveUsers.length} مستخدم مسجل</span>
                </span>
                <span>•</span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5 text-[#58CC02]" />
                  <span>بداية الحساب الحالي: {formatArabicDateTime(resetEpoch)}</span>
                </span>
              </p>
            </div>
          </div>

          {isProgrammer && (
            <button
              type="button"
              onClick={() => setConfirmResetOpen((v) => !v)}
              className="duo-btn flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-[#FFDFE0] hover:bg-[#FFD0D2] border-2 border-b-4 border-[#FF4B4B] text-[#EA2B2B] text-xs sm:text-sm font-black cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              <span>تصفير لوحة الشرف (مبرمج)</span>
            </button>
          )}
        </div>

        {/* Inline Programmer Reset Confirmation */}
        {isProgrammer && confirmResetOpen && (
          <div className="p-4 rounded-2xl bg-[#FFF5F5] border-2 border-[#FF4B4B] flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs sm:text-sm font-black text-[#EA2B2B]">
              هل أنت متأكد من تصفير لوحة الشرف للجميع؟ ستُصفَّر الأرقام الظاهرة حالياً وتبدأ المنافسة من الصفر من هذه اللحظة (مع بقاء سجل المحاولات الشخصي لكل طالب).
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={resetting}
                onClick={() => void handleConfirmReset()}
                className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#FF4B4B] border-2 border-b-4 border-[#EA2B2B] text-white text-xs font-black cursor-pointer disabled:opacity-60"
              >
                {resetting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                <span>تأكيد التصفير للجميع</span>
              </button>
              <button
                type="button"
                disabled={resetting}
                onClick={() => setConfirmResetOpen(false)}
                className="px-3.5 py-2 rounded-xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer"
              >
                إلغاء
              </button>
            </div>
          </div>
        )}

        {notice && (
          <div className="p-3 rounded-2xl bg-[#D7FFB8] border-2 border-[#58CC02] text-xs sm:text-sm font-black text-[#46A302]">
            {notice}
          </div>
        )}
      </div>

      {/* Live Pending Incoming Friend Requests Banner */}
      {pendingIncomingList.length > 0 && (
        <div className="duo-card p-4 bg-[#F0F9FF] border-2 border-[#1CB0F6] flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm font-black text-[#1899D6]">
            <UserPlus className="w-5 h-5" />
            <span>طلبات صداقة بانتظار ردك ({pendingIncomingList.length})</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {pendingIncomingList.map((req) => (
              <div
                key={req.id}
                className="p-3 rounded-2xl bg-white border-2 border-[#BCE8FF] flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <p className="text-xs sm:text-sm font-black text-[#3C3C3C] truncate">
                    {req.fromName}
                  </p>
                  <p className="text-[11px] font-bold text-[#777777]">
                    أرسل لك طلب صداقة
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    disabled={busyUid === req.fromUid}
                    onClick={() => void handleRespondIncoming(req, true)}
                    className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer disabled:opacity-60"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>قبول</span>
                  </button>
                  <button
                    type="button"
                    disabled={busyUid === req.fromUid}
                    onClick={() => void handleRespondIncoming(req, false)}
                    className="duo-btn flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#EA2B2B] text-xs font-black cursor-pointer disabled:opacity-60"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>رفض</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* My Position Card */}
      {myEntry && myRank && (
        <div className="rounded-3xl border-2 border-[#58CC02] bg-[#F4FFE8] p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white font-black text-base flex items-center justify-center shrink-0">
              #{myRank}
            </div>
            <div>
              <p className="text-sm font-black text-[#3C3C3C]">
                ترتيبك الحالي: المركز #{myRank} ({myEntry.fullNameQuad})
              </p>
              <p className="text-xs font-bold text-[#46A302] mt-0.5">
                صحيح: <span className="font-latin">{myEntry.correctCount}</span> • خطأ:{' '}
                <span className="font-latin">{myEntry.wrongCount}</span> • الإجمالي:{' '}
                <span className="font-latin">{myEntry.totalQuestions}</span> • الدقة:{' '}
                <span className="font-latin">{myEntry.statsSnapshot?.accuracyPct || 0}%</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSelectedUserForStats({ entry: myEntry, rank: myRank })}
            className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border-2 border-b-4 border-[#58CC02] text-[#46A302] text-xs font-black cursor-pointer"
          >
            <BarChart3 className="w-4 h-4" />
            <span>عرض بطاقة إحصائياتي</span>
          </button>
        </div>
      )}

      {/* Search & Sort Controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-[#777777] absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="ابحث عن طالب أو زميل بالاسم..."
            className="w-full pr-10 pl-4 py-2.5 rounded-2xl bg-white border-2 border-[#E5E5E5] focus:border-[#1CB0F6] outline-none text-sm font-bold text-[#3C3C3C]"
          />
        </div>
        <div className="flex items-center gap-1.5 bg-[#F7F7F7] p-1 rounded-2xl border border-[#E5E5E5]">
          {(
            [
              { id: 'correct', label: 'الأكثر صحة' },
              { id: 'accuracy', label: 'الأعلى دقة' },
              { id: 'total', label: 'الأكثر حلاً' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSortBy(item.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-black cursor-pointer transition-colors ${
                sortBy === item.id
                  ? 'bg-[#1CB0F6] text-white shadow-xs'
                  : 'text-[#777777] hover:text-[#3C3C3C]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Top 3 Podium Cards */}
      {topThree.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {topThree.map((u, idx) => {
            const podiumStyles =
              idx === 0
                ? 'border-[#FFC800] bg-[#FFFDF2]'
                : idx === 1
                ? 'border-[#CBD5E1] bg-[#F8FAFC]'
                : 'border-[#F59E0B]/60 bg-[#FFFBF5]';
            const badgeStyles =
              idx === 0
                ? 'bg-[#FFC800] text-[#3C3C3C]'
                : idx === 1
                ? 'bg-[#94A3B8] text-white'
                : 'bg-[#D97706] text-white';

            return (
              <div
                key={u.uid}
                className={`rounded-3xl border-2 border-b-4 p-4 flex flex-col gap-3 ${podiumStyles}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-xl text-xs font-black ${badgeStyles}`}
                  >
                    {idx === 0 ? <Crown className="w-3.5 h-3.5" /> : <Medal className="w-3.5 h-3.5" />}
                    <span>المركز {idx + 1}</span>
                  </span>
                  <span className="text-xs font-black text-[#16A34A] font-latin">
                    دقة {u.statsSnapshot?.accuracyPct || 0}%
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setSelectedUserForStats({ entry: u, rank: idx + 1 })}
                  className="text-right cursor-pointer group"
                >
                  <p className="text-sm sm:text-base font-black text-[#3C3C3C] group-hover:text-[#1899D6] truncate">
                    {u.fullNameQuad}
                  </p>
                  <p className="text-[11px] font-bold text-[#777777] mt-0.5">
                    اضغط لعرض إحصائياته بالكامل ←
                  </p>
                </button>

                <div className="grid grid-cols-3 gap-1.5 text-center text-xs">
                  <div className="p-2 rounded-xl bg-white border border-[#E5E5E5]">
                    <span className="block text-[10px] font-bold text-[#46A302]">صح</span>
                    <span className="font-black text-[#46A302] font-latin">{u.correctCount}</span>
                  </div>
                  <div className="p-2 rounded-xl bg-white border border-[#E5E5E5]">
                    <span className="block text-[10px] font-bold text-[#EA2B2B]">خطأ</span>
                    <span className="font-black text-[#EA2B2B] font-latin">{u.wrongCount}</span>
                  </div>
                  <div className="p-2 rounded-xl bg-white border border-[#E5E5E5]">
                    <span className="block text-[10px] font-bold text-[#3C3C3C]">الكل</span>
                    <span className="font-black text-[#3C3C3C] font-latin">{u.totalQuestions}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Full Leaderboard List */}
      {loading && effectiveUsers.length === 0 ? (
        <div className="duo-card p-10 text-center flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-[#1CB0F6]" />
          <p className="text-sm font-black text-[#777777]">جاري تحميل لوحة الشرف...</p>
        </div>
      ) : filteredUsers.length === 0 ? (
        <div className="duo-card p-8 text-center flex flex-col items-center gap-2">
          <Sparkles className="w-9 h-9 text-[#FFC800]" />
          <p className="text-sm font-black text-[#3C3C3C]">
            لا توجد نتائج مطابقة للبحث
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {filteredUsers.map((u) => {
            const rank = rankByUid.get(u.uid) || 1;
            const rel = getRelation(u.uid);
            const incomingReq = pendingIncomingByFromUid.get(u.uid);
            const isBusy = busyUid === u.uid;

            return (
              <div
                key={u.uid}
                className={`rounded-2xl border-2 border-b-4 p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors ${
                  u.uid === profile.uid
                    ? 'bg-[#F4FFE8] border-[#58CC02]'
                    : 'bg-white border-[#E5E5E5] hover:border-[#1CB0F6]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedUserForStats({ entry: u, rank })}
                  className="flex items-center gap-3 flex-1 min-w-0 text-right cursor-pointer"
                >
                  <div
                    className={`w-10 h-10 rounded-xl font-black text-sm flex items-center justify-center shrink-0 ${
                      rank === 1
                        ? 'bg-[#FFC800] text-[#3C3C3C]'
                        : rank === 2
                        ? 'bg-[#E2E8F0] text-[#334155]'
                        : rank === 3
                        ? 'bg-[#FED7AA] text-[#9A3412]'
                        : 'bg-[#F3F4F6] text-[#555555]'
                    }`}
                  >
                    {rank}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm sm:text-base font-black text-[#3C3C3C] truncate">
                        {u.fullNameQuad}
                      </span>
                      {u.uid === profile.uid && (
                        <span className="px-2 py-0.5 rounded-lg bg-[#58CC02] text-white text-[10px] font-black">
                          أنت
                        </span>
                      )}
                      {rel === 'friend' && (
                        <span className="px-2 py-0.5 rounded-lg bg-[#E6F7FF] text-[#1899D6] text-[10px] font-black">
                          صديق
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold mt-1">
                      <span className="text-[#46A302]">
                        صحيح: <span className="font-latin font-black">{u.correctCount}</span>
                      </span>
                      <span className="text-[#EA2B2B]">
                        خطأ: <span className="font-latin font-black">{u.wrongCount}</span>
                      </span>
                      <span className="text-[#3C3C3C]">
                        الإجمالي: <span className="font-latin font-black">{u.totalQuestions}</span>
                      </span>
                      <span className="text-[#1899D6]">
                        الدقة: <span className="font-latin font-black">{u.statsSnapshot?.accuracyPct || 0}%</span>
                      </span>
                    </div>
                  </div>
                </button>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setSelectedUserForStats({ entry: u, rank })}
                    className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] hover:border-[#1CB0F6] text-xs font-black text-[#3C3C3C] cursor-pointer"
                  >
                    <BarChart3 className="w-3.5 h-3.5 text-[#1CB0F6]" />
                    <span>إحصائياته</span>
                  </button>

                  {rel === 'friend' && (
                    <button
                      type="button"
                      onClick={() => onOpenFriendChat(u.uid)}
                      className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer"
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                      <span>مراسلة</span>
                    </button>
                  )}

                  {rel === 'none' && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleSendFriendRequest(u)}
                      className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#1CB0F6] border-2 border-b-4 border-[#1899D6] text-white text-xs font-black cursor-pointer disabled:opacity-60"
                    >
                      {isBusy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <UserPlus className="w-3.5 h-3.5" />
                      )}
                      <span>أضف كصديق</span>
                    </button>
                  )}

                  {rel === 'outgoing_pending' && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleCancelRequest(u)}
                      className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#FFF4CC] border-2 border-b-4 border-[#FFC800] text-[#9A6B00] text-xs font-black cursor-pointer disabled:opacity-60"
                      title="اضغط لإلغاء الطلب"
                    >
                      <Clock className="w-3.5 h-3.5" />
                      <span>طلب معلق</span>
                    </button>
                  )}

                  {rel === 'incoming_pending' && incomingReq && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleRespondIncoming(incomingReq, true)}
                      className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer disabled:opacity-60"
                    >
                      <UserCheck className="w-3.5 h-3.5" />
                      <span>قبول الطلب</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Full Stats Modal */}
      {selectedUserForStats && (
        <LeaderboardUserStatsModal
          user={selectedUserForStats.entry}
          rank={selectedUserForStats.rank}
          relation={getRelation(selectedUserForStats.entry.uid)}
          busyAction={busyUid === selectedUserForStats.entry.uid}
          onClose={() => setSelectedUserForStats(null)}
          onSendFriendRequest={(u) => void handleSendFriendRequest(u)}
          onAcceptRequest={(u) => {
            const req = pendingIncomingByFromUid.get(u.uid);
            if (req) void handleRespondIncoming(req, true);
          }}
          onOpenChat={(u) => {
            setSelectedUserForStats(null);
            onOpenFriendChat(u.uid);
          }}
        />
      )}
    </div>
  );
};
